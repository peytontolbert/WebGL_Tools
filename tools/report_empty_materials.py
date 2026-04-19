#!/usr/bin/env python3
"""
Report meshes/submeshes in the exported sharded models manifest that have empty materials.

This is an *offline* audit (no GTA install needed). It helps identify which archetypes
will render untextured because their manifest materials are `{}`.

Usage:
  python3 webgl_viewer/tools/report_empty_materials.py \
    --root /data/webglgta/webgl-gta/webgl_viewer \
    --out  /data/webglgta/webgl-gta/webgl_viewer/tools/out/empty_materials_report.json
"""

from __future__ import annotations

import argparse
import json
import time
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional


def _u32_str(k: Any) -> Optional[str]:
    if k is None:
        return None
    if isinstance(k, int):
        return str(int(k) & 0xFFFFFFFF)
    s = str(k).strip()
    if not s:
        return None
    if s.lstrip("-").isdigit():
        try:
            return str(int(s, 10) & 0xFFFFFFFF)
        except Exception:
            return None
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
    ap.add_argument("--out", required=True, help="Path to write report JSON")
    args = ap.parse_args(list(argv) if argv is not None else None)

    viewer_root = Path(str(args.root)).resolve()
    models_dir = viewer_root / "assets" / "models"
    shards_dir = models_dir / "manifest_shards"
    if not shards_dir.exists():
        raise SystemExit(f"Missing manifest shards dir: {shards_dir}")

    shards = sorted([p for p in shards_dir.glob("*.json") if p.is_file()])
    if args.max_shards and int(args.max_shards) > 0:
        shards = shards[: int(args.max_shards)]

    t0 = time.time()
    meshes_scanned = 0

    empty_entry_material = 0
    empty_submesh_material = 0

    by_mesh: Dict[str, dict] = {}  # meshHash -> agg
    by_shard: Dict[str, int] = defaultdict(int)

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

            entry_mat = entry.get("material")
            entry_mat_empty = isinstance(entry_mat, dict) and (len(entry_mat) == 0)

            sub_empty = 0
            lods = entry.get("lods")
            if isinstance(lods, dict):
                for lod_key, lod_meta in lods.items():
                    if not isinstance(lod_meta, dict):
                        continue
                    subs = lod_meta.get("submeshes")
                    if not isinstance(subs, list):
                        continue
                    for sm in subs:
                        if not isinstance(sm, dict):
                            continue
                        m = sm.get("material")
                        if isinstance(m, dict) and (len(m) == 0):
                            sub_empty += 1

            if entry_mat_empty or sub_empty:
                agg = by_mesh.get(mh)
                if agg is None:
                    agg = {
                        "meshHash": mh,
                        "shard": sf.name,
                        "entryMaterialEmpty": 0,
                        "emptySubmeshMaterialCount": 0,
                        "lodsPresent": sorted(list((entry.get("lods") or {}).keys())) if isinstance(entry.get("lods"), dict) else [],
                    }
                    by_mesh[mh] = agg
                if entry_mat_empty:
                    agg["entryMaterialEmpty"] = 1
                agg["emptySubmeshMaterialCount"] = int(agg.get("emptySubmeshMaterialCount") or 0) + int(sub_empty)
                by_shard[sf.name] += 1

            if entry_mat_empty:
                empty_entry_material += 1
            if sub_empty:
                empty_submesh_material += int(sub_empty)

    items = list(by_mesh.values())
    items.sort(key=lambda e: (-(int(e.get("emptySubmeshMaterialCount") or 0)), e.get("meshHash")))

    out = {
        "schema": "webglgta-empty-materials-report-v1",
        "viewerRoot": str(viewer_root),
        "modelsDir": str(models_dir),
        "shardsScanned": len(shards),
        "meshesScanned": int(meshes_scanned),
        "empty": {
            "entriesWithEmptyEntryMaterial": int(empty_entry_material),
            "totalEmptySubmeshMaterials": int(empty_submesh_material),
            "uniqueMeshesWithAnyEmpty": int(len(items)),
        },
        "byShardTop": sorted(
            [{"shard": k, "meshesWithAnyEmpty": int(v)} for k, v in by_shard.items()],
            key=lambda x: (-x["meshesWithAnyEmpty"], x["shard"]),
        )[:50],
        "meshes": items,
        "elapsedSec": round(time.time() - t0, 3),
    }

    out_path = Path(str(args.out)).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"Wrote: {out_path} (uniqueMeshesWithAnyEmpty={out['empty']['uniqueMeshesWithAnyEmpty']}, elapsedSec={out['elapsedSec']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


