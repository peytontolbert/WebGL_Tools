from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

import bpy
from mathutils import Vector

from blender_common import blender_argv_after_double_dash, import_asset, reset_scene


def _parse(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="blender_mesh_to_heightmap_u16.py")
    ap.add_argument("--in", dest="input", required=True, help="Input terrain mesh asset (glb/gltf/obj/fbx/blend).")
    ap.add_argument("--out-dir", required=True, help="Output directory for meta.json + heights.u16.bin")
    ap.add_argument("--grid", default="256", help="Heightmap resolution (N).")
    ap.add_argument("--endian", default="little", choices=["little", "big"])

    # Horizontal sampling bounds (Blender X/Y plane). If omitted, uses mesh world-space bounds.
    ap.add_argument("--bounds", default="", help="Optional bounds: minX,maxX,minY,maxY in meters (Blender X/Y).")
    ap.add_argument("--ray-height", default="2000", help="Ray start height above maxZ (meters).")

    # Vertical range mapping to u16. If omitted, uses mesh world-space Z bounds.
    ap.add_argument("--min-z", default="", help="Optional minZ (vertical, Blender Z) in meters.")
    ap.add_argument("--max-z", default="", help="Optional maxZ (vertical, Blender Z) in meters.")

    # When no ray hit, fill with minZ (0..1 => minZ).
    ap.add_argument("--miss-fill", default="min", choices=["min", "nan"], help="What to write when ray misses.")
    return ap.parse_args(argv)


def _safe_float(s: str) -> float | None:
    ss = str(s or "").strip()
    if not ss:
        return None
    try:
        v = float(ss)
        return v if math.isfinite(v) else None
    except Exception:
        return None


def _parse_bounds(s: str) -> tuple[float, float, float, float] | None:
    raw = str(s or "").strip()
    if not raw:
        return None
    parts = [p.strip() for p in raw.replace(";", ",").split(",") if p.strip()]
    if len(parts) != 4:
        raise ValueError("--bounds must be minX,maxX,minY,maxY")
    vals = [float(p) for p in parts]
    if not all(math.isfinite(v) for v in vals):
        raise ValueError("--bounds must be finite")
    min_x, max_x, min_y, max_y = vals
    if max_x <= min_x or max_y <= min_y:
        raise ValueError("--bounds must have max > min")
    return min_x, max_x, min_y, max_y


def _world_bounds_xy_and_z(mesh_objs: list[bpy.types.Object]) -> tuple[float, float, float, float, float, float]:
    """
    Returns (minX,maxX,minY,maxY,minZ,maxZ) in world space (Blender axes).
    """
    min_x = min_y = min_z = float("inf")
    max_x = max_y = max_z = float("-inf")
    for o in mesh_objs:
        if not o or o.type != "MESH":
            continue
        try:
            # bound_box is 8 points in local space; transform to world.
            for c in o.bound_box:
                p = o.matrix_world @ Vector((c[0], c[1], c[2]))
                min_x = min(min_x, p.x)
                max_x = max(max_x, p.x)
                min_y = min(min_y, p.y)
                max_y = max(max_y, p.y)
                min_z = min(min_z, p.z)
                max_z = max(max_z, p.z)
        except Exception:
            continue
    if not (math.isfinite(min_x) and math.isfinite(max_x) and math.isfinite(min_y) and math.isfinite(max_y) and math.isfinite(min_z) and math.isfinite(max_z)):
        raise RuntimeError("Failed to compute mesh bounds (no mesh objects?)")
    return min_x, max_x, min_y, max_y, min_z, max_z


def _write_u16_bin(path: Path, u16: list[int], *, endian: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    b = bytearray()
    for v in u16:
        x = int(v) & 0xFFFF
        if endian == "little":
            b.append(x & 0xFF)
            b.append((x >> 8) & 0xFF)
        else:
            b.append((x >> 8) & 0xFF)
            b.append(x & 0xFF)
    path.write_bytes(bytes(b))


def main() -> None:
    args = _parse(blender_argv_after_double_dash())
    inp = Path(args.input).resolve()
    out_dir = Path(args.out_dir).resolve()
    n = max(2, int(float(str(args.grid or "256"))))
    endian = str(args.endian or "little").lower()
    ray_height = float(args.ray_height or 2000.0)
    miss_fill = str(args.miss_fill or "min").lower()

    reset_scene()
    imported = import_asset(inp)
    meshes = [o for o in imported if o and o.type == "MESH"]
    if not meshes:
        meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError("No mesh objects found in input.")

    # Evaluate bounds.
    b_override = _parse_bounds(args.bounds)
    min_x, max_x, min_y, max_y, bmin_z, bmax_z = _world_bounds_xy_and_z(meshes)
    if b_override:
        min_x, max_x, min_y, max_y = b_override

    min_z = _safe_float(args.min_z)
    max_z = _safe_float(args.max_z)
    if min_z is None:
        min_z = float(bmin_z)
    if max_z is None:
        max_z = float(bmax_z)
    if not (math.isfinite(min_z) and math.isfinite(max_z) and max_z > min_z):
        raise ValueError("Invalid vertical bounds (min_z/max_z).")

    # Ray cast against the scene to sample the first hit height.
    scene = bpy.context.scene
    depsgraph = bpy.context.evaluated_depsgraph_get()
    z_start = max_z + max(1.0, ray_height)
    dist = (z_start - (min_z - 10.0)) + max(10.0, ray_height)

    heights_u16: list[int] = [0] * (n * n)
    dz = max(1e-9, (max_z - min_z))

    misses = 0
    hits = 0

    for iy in range(n):
        v = 0.0 if n <= 1 else (iy / (n - 1))
        # Row 0 should correspond to maxY (north edge), matching runtime convention.
        y = max_y - v * (max_y - min_y)
        for ix in range(n):
            u = 0.0 if n <= 1 else (ix / (n - 1))
            x = min_x + u * (max_x - min_x)

            origin = Vector((x, y, z_start))
            direction = Vector((0.0, 0.0, -1.0))
            ok, loc, _nrm, _face, _obj, _mat = scene.ray_cast(depsgraph, origin, direction, distance=dist)
            if ok:
                z = float(loc.z)
                h01 = (z - min_z) / dz
                h01 = 0.0 if h01 < 0.0 else 1.0 if h01 > 1.0 else h01
                heights_u16[iy * n + ix] = int(round(h01 * 65535.0))
                hits += 1
            else:
                misses += 1
                if miss_fill == "nan":
                    heights_u16[iy * n + ix] = 0
                else:
                    heights_u16[iy * n + ix] = 0

    # Output files (viewer format).
    out_dir.mkdir(parents=True, exist_ok=True)
    bin_path = out_dir / "heights.u16.bin"
    meta_path = out_dir / "meta.json"
    _write_u16_bin(bin_path, heights_u16, endian=endian)

    meta = {
        "width": n,
        "height": n,
        "file": bin_path.name,
        "endian": endian,
        "minZ": float(min_z),
        "maxZ": float(max_z),
        # Horizontal bounds (matches TerrainRenderer setBounds convention).
        # minY/maxY here refer to world Z extents in the runtime (ground plane).
        "bbox": {
            "minX": float(min_x),
            "maxX": float(max_x),
            "minY": float(min_y),
            "maxY": float(max_y),
        },
        "stats": {
            "rayHits": int(hits),
            "rayMisses": int(misses),
        },
    }
    meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

