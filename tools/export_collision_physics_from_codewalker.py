"""
Export collision/physics bounds from CodeWalker into WebGL-viewer-friendly assets.

This tool uses CodeWalker (via pythonnet) to:
  - build `CodeWalker.World.Space` (BoundsStore)
  - collect exterior YBN bounds store items (AABBs + layer)
  - load the referenced YBN files and extract collision geometry triangles

Outputs (under webgl-gta/output/collision/ by default):
  - index.json: chunked lookup + per-YBN metadata
  - ybns/<hash>.bin: simple triangle mesh (COL0 binary)

Notes / scope:
  - This is intended as a *physics data export* for the viewer. The viewer runtime
    does not yet consume these assets by default (see webgl_viewer/index.html note).
  - Interiors (MLO) are not handled here; we focus on exterior layer 0 bounds store.
  - Only triangle polygons are exported (procedural primitives are skipped for now).

Usage:
  python3 webgl-gta/webgl_viewer/tools/export_collision_physics_from_codewalker.py \\
    --gta-path /data/webglgta/gta5 \\
    --selected-dlc all \\
    --layers 0 \\
    --chunk-size 512
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

# Import repo modules without installation (match other tools/* pattern)
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from gta5_modules.cw_loaders import ensure_loaded as _ensure_loaded
from gta5_modules.dll_manager import DllManager


def _load_bounds_from_terrain_info(output_dir: Path) -> Optional[Tuple[float, float, float, float, float, float]]:
    """
    Best-effort read global bounds from output/terrain_info.json.
    """
    info_path = output_dir / "terrain_info.json"
    if not info_path.exists():
        return None
    try:
        info = json.loads(info_path.read_text(encoding="utf-8", errors="ignore"))
        gb = info.get("global_bounds") or {}
        return (
            float(gb["min_x"]),
            float(gb["min_y"]),
            float(gb["min_z"]),
            float(gb["max_x"]),
            float(gb["max_y"]),
            float(gb["max_z"]),
        )
    except Exception:
        return None


def _meta_hash_to_u32(v: Any) -> int:
    """
    Convert CodeWalker.MetaHash (or similar) into a python int u32.
    """
    if v is None:
        return 0
    # Common pythonnet path: MetaHash can often cast to int directly.
    try:
        return int(v) & 0xFFFFFFFF
    except Exception:
        pass
    # Common C# shape: `MetaHash.Hash`
    try:
        return int(getattr(v, "Hash")) & 0xFFFFFFFF
    except Exception:
        pass
    # Fallback: parse string (may be decimal)
    try:
        s = str(v).strip()
        if s.isdigit():
            return int(s) & 0xFFFFFFFF
    except Exception:
        pass
    return 0


def _v3_to_tuple(v) -> Tuple[float, float, float]:
    return (float(getattr(v, "X", 0.0)), float(getattr(v, "Y", 0.0)), float(getattr(v, "Z", 0.0)))


def _aabb_intersects(item_min, item_max, qmin: Tuple[float, float, float], qmax: Tuple[float, float, float]) -> bool:
    x0, y0, z0 = _v3_to_tuple(item_min)
    x1, y1, z1 = _v3_to_tuple(item_max)
    # normalize
    ix0, ix1 = (min(x0, x1), max(x0, x1))
    iy0, iy1 = (min(y0, y1), max(y0, y1))
    iz0, iz1 = (min(z0, z1), max(z0, z1))
    qx0, qx1 = (min(qmin[0], qmax[0]), max(qmin[0], qmax[0]))
    qy0, qy1 = (min(qmin[1], qmax[1]), max(qmin[1], qmax[1]))
    qz0, qz1 = (min(qmin[2], qmax[2]), max(qmin[2], qmax[2]))
    return (ix1 >= qx0) and (ix0 <= qx1) and (iy1 >= qy0) and (iy0 <= qy1) and (iz1 >= qz0) and (iz0 <= qz1)


def _walk_bounds_store_items(root_node) -> List[Any]:
    """
    Collect all BoundsStoreItem from a SpaceBoundsStoreNode tree.
    """
    out: List[Any] = []
    if root_node is None:
        return out
    stack = [root_node]
    while stack:
        node = stack.pop()
        try:
            items = getattr(node, "Items", None)
        except Exception:
            items = None
        if items is not None:
            try:
                for it in items:
                    out.append(it)
            except Exception:
                # some pythonnet lists need Count+indexer
                try:
                    n = int(getattr(items, "Count", 0))
                except Exception:
                    n = 0
                for i in range(n):
                    try:
                        out.append(items[i])
                    except Exception:
                        pass
        try:
            children = getattr(node, "Children", None)
        except Exception:
            children = None
        if children is not None:
            try:
                for c in children:
                    if c is not None:
                        stack.append(c)
            except Exception:
                pass
    return out


def _iter_composite_children(bound_obj) -> Iterable[Any]:
    ch = getattr(bound_obj, "Children", None)
    if ch is None:
        return []
    # ResourcePointerArray64<Bounds> exposes `data_items`
    data_items = getattr(ch, "data_items", None)
    if data_items is not None:
        return [c for c in data_items if c is not None]
    try:
        return [c for c in ch if c is not None]
    except Exception:
        return []


def _bounds_type_name(bound_obj) -> str:
    try:
        t = getattr(bound_obj, "Type", None)
        if t is None:
            return ""
        return str(t)
    except Exception:
        return ""


def _poly_type_name(poly_obj) -> str:
    try:
        t = getattr(poly_obj, "Type", None)
        return str(t) if t is not None else ""
    except Exception:
        return ""


def _apply_chain_to_v3(v3, chain: List[Any], SharpDX) -> Any:
    """
    Apply a list of SharpDX.Matrix transforms to a SharpDX.Vector3, in order.

    We intentionally avoid composing matrices (order is easy to get wrong across libs).
    """
    v = v3
    for m in chain:
        if m is None:
            continue
        try:
            # Matches CodeWalker usage: Vector3.Transform(v, m).XYZ()
            r = SharpDX.Vector3.Transform(v, m)
            # r might be Vector4 or Vector3; in either case it exposes X/Y/Z.
            v = SharpDX.Vector3(float(r.X), float(r.Y), float(r.Z))
        except Exception:
            # fall back: ignore transform
            pass
    return v


def _extract_ybn_tri_mesh(ybn_file, *, SharpDX, max_tris: int = 0) -> Tuple[List[Tuple[float, float, float]], List[Tuple[int, int, int]], List[Tuple[int, int]]]:
    """
    Extract a triangle mesh from a CodeWalker YbnFile.

    Returns:
      verts: list of (x,y,z)
      tris: list of (i0,i1,i2) (u32 indices into verts)
      tri_meta: list of (matIndex_u16, polyFlags_u8) per tri (packed as 2 ints)

    Limitations:
      - Only triangle polygons are exported.
      - Procedural primitives (sphere/capsule/box/cylinder polygons) are skipped.
    """
    root = getattr(ybn_file, "Bounds", None)
    if root is None:
        return [], [], []

    verts_out: List[Tuple[float, float, float]] = []
    tris_out: List[Tuple[int, int, int]] = []
    tri_meta: List[Tuple[int, int]] = []

    # DFS over bounds tree. Keep a transform chain.
    stack: List[Tuple[Any, List[Any]]] = [(root, [])]
    while stack:
        b, parent_chain = stack.pop()
        if b is None:
            continue

        # Include this bound's composite transform (identity for most roots).
        try:
            t = getattr(b, "Transform", None)
        except Exception:
            t = None
        chain = parent_chain + ([t] if t is not None else [])

        btype = _bounds_type_name(b)
        if "Geometry" in btype:  # matches Geometry and GeometryBVH
            geom = b
            verts = getattr(geom, "Vertices", None)
            polys = getattr(geom, "Polygons", None)
            if verts is None or polys is None:
                continue

            off = len(verts_out)
            # Transform vertices into parent/world space.
            try:
                for vv in verts:
                    vwt = _apply_chain_to_v3(vv, chain, SharpDX)
                    verts_out.append(_v3_to_tuple(vwt))
            except Exception:
                # If iteration fails, treat as empty.
                continue

            # Per-geometry polyFlags (base Bounds field)
            try:
                poly_flags = int(getattr(geom, "PolyFlags", 0)) & 0xFF
            except Exception:
                poly_flags = 0

            # PolygonMaterialIndices is a byte array (often present).
            pmi = getattr(geom, "PolygonMaterialIndices", None)

            # Walk polygons and export triangles
            try:
                for pi, p in enumerate(polys):
                    if max_tris and len(tris_out) >= max_tris:
                        return verts_out, tris_out, tri_meta
                    if p is None:
                        continue
                    if "Triangle" not in _poly_type_name(p):
                        continue
                    try:
                        i0 = int(getattr(p, "vertIndex1")) & 0x7FFF
                        i1 = int(getattr(p, "vertIndex2")) & 0x7FFF
                        i2 = int(getattr(p, "vertIndex3")) & 0x7FFF
                    except Exception:
                        # fallback: VertexIndices property
                        try:
                            inds = list(getattr(p, "VertexIndices"))
                            if len(inds) < 3:
                                continue
                            i0, i1, i2 = int(inds[0]), int(inds[1]), int(inds[2])
                        except Exception:
                            continue

                    tris_out.append((off + i0, off + i1, off + i2))

                    # material index: prefer polygon's computed MaterialIndex, then PolygonMaterialIndices[pi]
                    mat_i = 0
                    try:
                        mi = int(getattr(p, "MaterialIndex"))
                        if mi >= 0:
                            mat_i = mi
                    except Exception:
                        mat_i = 0
                    if mat_i == 0 and pmi is not None:
                        try:
                            mat_i = int(pmi[pi]) & 0xFFFF
                        except Exception:
                            pass
                    tri_meta.append((mat_i & 0xFFFF, poly_flags))
            except Exception:
                pass

        # Recurse composites
        if "Composite" in btype:
            try:
                for child in _iter_composite_children(b):
                    stack.append((child, chain))
            except Exception:
                pass

    return verts_out, tris_out, tri_meta


def _write_col0_mesh(path: Path, verts: List[Tuple[float, float, float]], tris: List[Tuple[int, int, int]], tri_meta: List[Tuple[int, int]]) -> None:
    """
    Write COL0 binary:
      u8[4] magic = "COL0"
      u32 version = 1
      u32 vertCount
      u32 triCount
      u32 flags (reserved, 0)
      float32 verts[vertCount*3]
      u32 tris[triCount*3]
      u16 matIndex[triCount]
      u8  polyFlags[triCount]
      u8  pad[triCount]
    """
    vc = len(verts)
    tc = len(tris)
    if tc != len(tri_meta):
        # best-effort: clamp to shortest
        n = min(tc, len(tri_meta))
        tris = tris[:n]
        tri_meta = tri_meta[:n]
        tc = n

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as f:
        f.write(struct.pack("<4sIIII", b"COL0", 1, vc, tc, 0))
        # vertices
        for (x, y, z) in verts:
            f.write(struct.pack("<fff", float(x), float(y), float(z)))
        # triangles
        for (i0, i1, i2) in tris:
            f.write(struct.pack("<III", int(i0) & 0xFFFFFFFF, int(i1) & 0xFFFFFFFF, int(i2) & 0xFFFFFFFF))
        # metadata
        for (mat_i, poly_flags) in tri_meta:
            f.write(struct.pack("<HBB", int(mat_i) & 0xFFFF, int(poly_flags) & 0xFF, 0))


def _chunk_range_for_aabb(aabb_min: Tuple[float, float, float], aabb_max: Tuple[float, float, float], chunk_size: float) -> Tuple[int, int, int, int]:
    minx, miny, _ = aabb_min
    maxx, maxy, _ = aabb_max
    cs = float(chunk_size)
    if cs <= 0:
        cs = 512.0
    sx0 = int(math.floor(minx / cs))
    sy0 = int(math.floor(miny / cs))
    sx1 = int(math.floor(maxx / cs))
    sy1 = int(math.floor(maxy / cs))
    if sx1 < sx0:
        sx0, sx1 = sx1, sx0
    if sy1 < sy0:
        sy0, sy1 = sy1, sy0
    return sx0, sy0, sx1, sy1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gta-path", required=True, help="Path to GTA5 installation (same as other tools)")
    ap.add_argument("--output-dir", default="", help="defaults to webgl-gta/output next to this repo")
    ap.add_argument("--selected-dlc", default="all", help="DLC selection (default: all)")
    ap.add_argument("--layers", default="0", help="comma-separated BoundsStore layers to export (default: 0)")
    ap.add_argument("--chunk-size", type=float, default=512.0, help="chunk size for collision index (default: 512)")
    ap.add_argument("--max-ybn", type=int, default=0, help="limit number of YBNs exported (0=all)")
    ap.add_argument("--max-tris-per-ybn", type=int, default=0, help="limit triangles per YBN (0=all)")
    ap.add_argument("--no-mesh", action="store_true", help="only write index.json (skip per-YBN mesh bins)")
    args = ap.parse_args()

    viewer_root = Path(__file__).resolve().parents[1]
    repo_root = viewer_root.parent
    output_dir = Path(args.output_dir).resolve() if args.output_dir else (repo_root / "output")
    output_dir.mkdir(parents=True, exist_ok=True)

    # Determine query bounds for selecting BoundsStore items
    bounds = _load_bounds_from_terrain_info(output_dir)
    if bounds:
        min_x, min_y, min_z, max_x, max_y, max_z = bounds
    else:
        # GTA V world-ish defaults (fail-open)
        min_x, min_y, min_z = -8192.0, -8192.0, -2048.0
        max_x, max_y, max_z = 8192.0, 8192.0, 4096.0

    # Parse layers
    allowed_layers: Set[int] = set()
    for tok in str(args.layers or "").split(","):
        t = tok.strip()
        if not t:
            continue
        try:
            allowed_layers.add(int(t))
        except Exception:
            pass
    if not allowed_layers:
        allowed_layers = {0}

    out_collision_dir = output_dir / "collision"
    out_ybns_dir = out_collision_dir / "ybns"
    out_index_path = out_collision_dir / "index.json"
    out_collision_dir.mkdir(parents=True, exist_ok=True)
    out_ybns_dir.mkdir(parents=True, exist_ok=True)

    dm = DllManager(str(args.gta_path))
    if not getattr(dm, "initialized", False):
        raise SystemExit("DllManager failed to init.")

    ok = dm.init_game_file_cache(selected_dlc=str(args.selected_dlc or "all"), load_vehicles=False, load_peds=False, load_audio=False)
    if not ok:
        raise SystemExit("Failed to init GameFileCache.")
    ok = dm.init_world_space()
    if not ok or dm.world_space is None:
        raise SystemExit("Failed to init CodeWalker World.Space.")

    gfc = dm.get_game_cache()
    sp = dm.world_space
    bs = getattr(sp, "BoundsStore", None)
    root_node = getattr(bs, "RootNode", None) if bs is not None else None
    items = _walk_bounds_store_items(root_node)
    print(f"[collision_export] BoundsStore items (raw): {len(items)}")

    # Filter + de-dupe by YBN hash.
    qmin = (float(min_x), float(min_y), float(min_z))
    qmax = (float(max_x), float(max_y), float(max_z))
    by_hash: Dict[int, dict] = {}
    for it in items:
        if it is None:
            continue
        try:
            layer = int(getattr(it, "Layer", 0))
        except Exception:
            layer = 0
        if layer not in allowed_layers:
            continue
        imin = getattr(it, "Min", None)
        imax = getattr(it, "Max", None)
        if imin is None or imax is None:
            continue
        if not _aabb_intersects(imin, imax, qmin, qmax):
            continue
        h = _meta_hash_to_u32(getattr(it, "Name", None))
        if not h:
            continue
        ent = by_hash.get(h)
        if ent is None:
            by_hash[h] = {
                "hash": h,
                "layer": layer,
                "min": _v3_to_tuple(imin),
                "max": _v3_to_tuple(imax),
            }
        else:
            # union AABB across duplicates
            ex_min = ent["min"]
            ex_max = ent["max"]
            mn = (min(ex_min[0], _v3_to_tuple(imin)[0]), min(ex_min[1], _v3_to_tuple(imin)[1]), min(ex_min[2], _v3_to_tuple(imin)[2]))
            mx = (max(ex_max[0], _v3_to_tuple(imax)[0]), max(ex_max[1], _v3_to_tuple(imax)[1]), max(ex_max[2], _v3_to_tuple(imax)[2]))
            ent["min"] = mn
            ent["max"] = mx
            # keep smallest layer if inconsistent
            try:
                ent["layer"] = min(int(ent.get("layer", layer)), layer)
            except Exception:
                ent["layer"] = layer

    ybn_hashes = sorted(by_hash.keys())
    if args.max_ybn and args.max_ybn > 0:
        ybn_hashes = ybn_hashes[: int(args.max_ybn)]

    print(f"[collision_export] YBNs selected: {len(ybn_hashes)} (layers={sorted(list(allowed_layers))})")

    # Chunk mapping: chunk_key -> set(ybnHashStr)
    chunk_size = float(args.chunk_size or 512.0)
    chunks: Dict[str, Set[str]] = {}

    # Extract meshes
    # Import SharpDX after DllManager has loaded it (pythonnet binding)
    import SharpDX  # type: ignore

    ybn_meta_out: Dict[str, dict] = {}
    t0 = time.time()
    for i, h in enumerate(ybn_hashes):
        ent = by_hash[h]
        hstr = str(int(h) & 0xFFFFFFFF)

        aabb_min = tuple(ent["min"])
        aabb_max = tuple(ent["max"])
        sx0, sy0, sx1, sy1 = _chunk_range_for_aabb(aabb_min, aabb_max, chunk_size)
        for sy in range(sy0, sy1 + 1):
            for sx in range(sx0, sx1 + 1):
                k = f"{sx}_{sy}"
                s = chunks.get(k)
                if s is None:
                    s = set()
                    chunks[k] = s
                s.add(hstr)

        mesh_rel = f"ybns/{hstr}.bin"
        meta = {
            "hash": hstr,
            "layer": int(ent["layer"]),
            "aabb": {"min": list(aabb_min), "max": list(aabb_max)},
            "meshFile": mesh_rel,
            "vertCount": 0,
            "triCount": 0,
        }

        if not args.no_mesh:
            ybn = None
            try:
                ybn = gfc.GetYbn(int(h) & 0xFFFFFFFF)
            except Exception:
                ybn = None
            if ybn is None:
                ybn_meta_out[hstr] = meta
                continue
            _ensure_loaded(gfc, ybn, max_loops=1200)
            if not getattr(ybn, "Loaded", False):
                ybn_meta_out[hstr] = meta
                continue

            verts, tris, tri_meta = _extract_ybn_tri_mesh(ybn, SharpDX=SharpDX, max_tris=int(args.max_tris_per_ybn or 0))
            meta["vertCount"] = int(len(verts))
            meta["triCount"] = int(len(tris))
            try:
                _write_col0_mesh(out_collision_dir / mesh_rel, verts, tris, tri_meta)
            except Exception as e:
                print(f"[collision_export] WARN: failed to write mesh for {hstr}: {e}")

        ybn_meta_out[hstr] = meta

        if (i + 1) % max(1, len(ybn_hashes) // 20) == 0:
            dt = time.time() - t0
            print(f"[collision_export] {i+1}/{len(ybn_hashes)} YBNs (dt={dt:.1f}s)")

    # Serialize chunks (sorted arrays for determinism)
    chunks_out: Dict[str, dict] = {}
    for k, s in chunks.items():
        arr = sorted(list(s), key=lambda x: int(x))
        chunks_out[k] = {"ybns": arr}

    out = {
        "schema": "webglgta-collision-index-v1",
        "generatedAtUnix": int(time.time()),
        "chunkSize": chunk_size,
        "bounds": {
            "min_x": float(min_x),
            "min_y": float(min_y),
            "min_z": float(min_z),
            "max_x": float(max_x),
            "max_y": float(max_y),
            "max_z": float(max_z),
        },
        "ybnsDir": "ybns",
        "chunks": chunks_out,
        "ybns": ybn_meta_out,
    }

    tmp = out_index_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(out_index_path)

    print(f"[collision_export] Wrote: {out_index_path}")
    print(f"[collision_export] YBN mesh dir: {out_ybns_dir}")
    print(f"[collision_export] Chunks: {len(chunks_out)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


