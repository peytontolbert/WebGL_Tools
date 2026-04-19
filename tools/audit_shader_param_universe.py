"""
Audit that our local CodeWalker-derived param universe covers *all* shaderParams.*ByHash keys
present in the exported models manifest shards.

Why:
  - We rely on CodeWalker's ShaderParamNames enum as the "param universe" (hash -> name).
  - If the map is incomplete, we silently lose debugability and may miss param-driven material behavior.

This tool answers:
  - Which shader param hashes appear in manifests?
  - Which are missing from assets/shader_param_names.json?
  - How many occurrences, and sample archetypes/lods/submeshes reference them?

Note:
  This tool is about the *param universe* (hash coverage), not "shader pipeline parity".
  For pipeline parity audits (shaderFamily/shaderName support), see `tools/shader_usage_report.json`.

Usage:
  python3 webgl_viewer/tools/audit_shader_param_universe.py \
    --root /data/webglgta/webgl-gta/webgl_viewer \
    --out /data/webglgta/webgl-gta/webgl_viewer/tools/out/shader_param_universe_audit.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


def _iter_manifest_shards(models_dir: Path) -> List[Path]:
    shards_dir = models_dir / "manifest_shards"
    if not shards_dir.exists():
        return []
    # shards are hex filenames; sorting makes output stable
    return sorted([p for p in shards_dir.glob("*.json") if p.is_file()])


def _iter_material_dicts(mesh_entry: dict) -> Iterable[Tuple[str, Optional[int], dict]]:
    """
    Yields tuples:
      (scopeKey, submeshIndex, materialDict)
    where scopeKey is either 'entry' or lod key (e.g. 'high').
    """
    if not isinstance(mesh_entry, dict):
        return []
    out: List[Tuple[str, Optional[int], dict]] = []
    m0 = mesh_entry.get("material")
    if isinstance(m0, dict):
        out.append(("entry", None, m0))
    lods = mesh_entry.get("lods")
    if isinstance(lods, dict):
        for lod_key, lod_meta in lods.items():
            if not isinstance(lod_meta, dict):
                continue
            subs = lod_meta.get("submeshes")
            if not isinstance(subs, list):
                continue
            for si, sm in enumerate(subs):
                if isinstance(sm, dict) and isinstance(sm.get("material"), dict):
                    out.append((str(lod_key), int(si), sm.get("material")))
    return out


def _load_shader_param_names(assets_dir: Path) -> Dict[str, str]:
    p = assets_dir / "shader_param_names.json"
    if not p.exists():
        return {}
    try:
        obj = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return {}
    by_hash = obj.get("byHash") if isinstance(obj, dict) else None
    if isinstance(by_hash, dict):
        return {str(k): str(v) for k, v in by_hash.items()}
    return {}


def _u32_str(k: Any) -> Optional[str]:
    """
    Normalize hash keys to unsigned u32 decimal strings.
    Manifests should already be decimal strings, but we tolerate ints / signed values.
    """
    if k is None:
        return None
    if isinstance(k, int):
        return str(int(k) & 0xFFFFFFFF)
    s = str(k).strip()
    if not s:
        return None
    # signed or unsigned decimal?
    if s.lstrip("-").isdigit():
        try:
            return str(int(s, 10) & 0xFFFFFFFF)
        except Exception:
            return None
    # hex?
    if s.lower().startswith("0x"):
        try:
            return str(int(s, 16) & 0xFFFFFFFF)
        except Exception:
            return None
    return s


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, help="Viewer root containing assets/ (e.g. .../webgl_viewer)")
    ap.add_argument("--max-shards", type=int, default=0, help="Limit shard files scanned (0=all)")
    ap.add_argument("--max-meshes", type=int, default=0, help="Limit mesh entries scanned (0=all)")
    ap.add_argument("--max-samples", type=int, default=20, help="Max sample refs stored per missing hash")
    ap.add_argument("--out", required=True, help="Path to write report JSON")
    args = ap.parse_args(list(argv) if argv is not None else None)

    viewer_root = Path(str(args.root)).resolve()
    assets_dir = viewer_root / "assets"
    models_dir = assets_dir / "models"
    if not assets_dir.exists():
        raise SystemExit(f"Missing assets dir: {assets_dir}")

    name_map = _load_shader_param_names(assets_dir)
    if not name_map:
        raise SystemExit(f"Missing or empty shader param name map: {assets_dir / 'shader_param_names.json'}")

    shards = _iter_manifest_shards(models_dir)
    if not shards:
        raise SystemExit(f"No manifest shards found under {models_dir}")
    if args.max_shards and int(args.max_shards) > 0:
        shards = shards[: int(args.max_shards)]

    # Stats
    seen_tex: Dict[str, int] = defaultdict(int)
    seen_vec: Dict[str, int] = defaultdict(int)
    missing: Dict[str, dict] = {}  # hash -> {countTex, countVec, samples: [...]}

    def add_missing(h: str, kind: str, sample: dict) -> None:
        ent = missing.get(h)
        if ent is None:
            ent = {"hash": h, "name": "", "countTextures": 0, "countVectors": 0, "samples": []}
            missing[h] = ent
        if kind == "texture":
            ent["countTextures"] = int(ent.get("countTextures") or 0) + 1
        else:
            ent["countVectors"] = int(ent.get("countVectors") or 0) + 1
        if not ent.get("name"):
            ent["name"] = name_map.get(h, "")
        samples = ent.get("samples")
        if isinstance(samples, list) and len(samples) < int(args.max_samples or 20):
            samples.append(sample)

    t0 = time.time()
    meshes_scanned = 0
    for sf in shards:
        payload = json.loads(sf.read_text(encoding="utf-8", errors="ignore"))
        meshes = (payload.get("meshes") or {}) if isinstance(payload, dict) else {}
        if not isinstance(meshes, dict):
            continue
        for mesh_hash, entry in meshes.items():
            if args.max_meshes and int(args.max_meshes) > 0 and meshes_scanned >= int(args.max_meshes):
                break
            if not isinstance(entry, dict):
                continue
            mh = _u32_str(mesh_hash)
            if not mh:
                continue
            meshes_scanned += 1

            for scope, sub_i, mat in _iter_material_dicts(entry):
                sp = mat.get("shaderParams") if isinstance(mat, dict) else None
                if not isinstance(sp, dict):
                    continue
                tb = sp.get("texturesByHash")
                vb = sp.get("vectorsByHash")

                if isinstance(tb, dict):
                    for k in tb.keys():
                        hk = _u32_str(k)
                        if not hk:
                            continue
                        seen_tex[hk] += 1
                        if hk not in name_map:
                            add_missing(
                                hk,
                                "texture",
                                {"meshHash": mh, "scope": scope, "submeshIndex": sub_i, "shard": sf.name},
                            )
                if isinstance(vb, dict):
                    for k in vb.keys():
                        hk = _u32_str(k)
                        if not hk:
                            continue
                        seen_vec[hk] += 1
                        if hk not in name_map:
                            add_missing(
                                hk,
                                "vector",
                                {"meshHash": mh, "scope": scope, "submeshIndex": sub_i, "shard": sf.name},
                            )

    # Build report
    seen_tex_unique = len(seen_tex)
    seen_vec_unique = len(seen_vec)
    missing_list = list(missing.values())
    missing_list.sort(key=lambda e: (-(int(e.get("countTextures") or 0) + int(e.get("countVectors") or 0)), e.get("hash")))

    out = {
        "schema": "webglgta-shader-param-universe-audit-v1",
        "viewerRoot": str(viewer_root),
        "assetsDir": str(assets_dir),
        "modelsDir": str(models_dir),
        "shardsScanned": len(shards),
        "meshesScanned": int(meshes_scanned),
        "shaderParamNameMapCount": int(len(name_map)),
        "seen": {
            "texturesByHash": {"uniqueKeys": int(seen_tex_unique), "totalRefs": int(sum(seen_tex.values()))},
            "vectorsByHash": {"uniqueKeys": int(seen_vec_unique), "totalRefs": int(sum(seen_vec.values()))},
        },
        "missingCount": int(len(missing_list)),
        "missing": missing_list,
        "elapsedSec": round(time.time() - t0, 3),
    }

    out_path = Path(str(args.out)).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"Wrote: {out_path} (missing={out['missingCount']}, elapsedSec={out['elapsedSec']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


