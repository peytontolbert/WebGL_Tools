#!/usr/bin/env python3
"""
Report texture sampler hashes that appear in exported manifests but are not referenced by the viewer's
`texturesByHash` → material-slot mapping logic.

This does NOT mean "broken rendering" (some samplers are for pipelines we don't implement yet),
but it is a concrete checklist of missing sampler semantics.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path
from typing import Dict, Iterable, Tuple


def _read_text(p: Path) -> str:
    return p.read_text(encoding="utf-8", errors="ignore")


def _extract_viewer_referenced_hashes(model_manager_js: str) -> Tuple[set[str], set[str]]:
    """
    Best-effort parse:
    - SLOTS hashes: const SLOTS = [ ... { hashes: ['123', ...] } ... ];
    - terrain adapter hashes: getTexRel('123')
    """
    slots_hashes: set[str] = set()
    terrain_hashes: set[str] = set()

    m = re.search(r"const\s+SLOTS\s*=\s*\[(.*?)\n\s*\];", model_manager_js, re.S)
    if m:
        blob = m.group(1)
        slots_hashes.update(re.findall(r"'([0-9]{6,10})'", blob))

    terrain_hashes.update(re.findall(r"getTexRel\('([0-9]{6,10})'\)", model_manager_js))
    return slots_hashes, terrain_hashes


def _iter_manifest_materials(payload: dict) -> Iterable[dict]:
    meshes = payload.get("meshes") or {}
    if not isinstance(meshes, dict):
        return
    for entry in meshes.values():
        if not isinstance(entry, dict):
            continue
        if isinstance(entry.get("material"), dict):
            yield entry["material"]
        lods = entry.get("lods")
        if isinstance(lods, dict):
            for lm in lods.values():
                if not isinstance(lm, dict):
                    continue
                subs = lm.get("submeshes")
                if not isinstance(subs, list):
                    continue
                for sm in subs:
                    if isinstance(sm, dict) and isinstance(sm.get("material"), dict):
                        yield sm["material"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--root",
        required=True,
        help="Repo root containing webgl_viewer/ (or webgl_viewer itself).",
    )
    ap.add_argument(
        "--out",
        required=False,
        default="",
        help="Optional output JSON path.",
    )
    args = ap.parse_args()

    root = Path(args.root).resolve()
    viewer = root / "webgl_viewer" if (root / "webgl_viewer").exists() else root

    mm_path = viewer / "js" / "model_manager.js"
    shards = viewer / "assets" / "models" / "manifest_shards"
    name_map_path = viewer / "assets" / "shader_param_names.json"

    if not mm_path.exists():
        raise SystemExit(f"missing: {mm_path}")
    if not shards.exists():
        raise SystemExit(f"missing: {shards}")
    if not name_map_path.exists():
        raise SystemExit(f"missing: {name_map_path}")

    by_hash: Dict[str, str] = json.loads(_read_text(name_map_path)).get("byHash", {})  # type: ignore[assignment]

    mm = _read_text(mm_path)
    slots_hashes, terrain_hashes = _extract_viewer_referenced_hashes(mm)
    referenced = set(slots_hashes) | set(terrain_hashes)

    seen = Counter()
    files = sorted(shards.glob("*.json"))
    for sf in files:
        payload = json.loads(_read_text(sf))
        if not isinstance(payload, dict):
            continue
        for mat in _iter_manifest_materials(payload):
            sp = mat.get("shaderParams")
            if not isinstance(sp, dict):
                continue
            tb = sp.get("texturesByHash")
            if not isinstance(tb, dict):
                continue
            for hk in tb.keys():
                seen[str(hk)] += 1

    missing = []
    for h, c in seen.most_common():
        if h in referenced:
            continue
        missing.append(
            {
                "hash": h,
                "name": by_hash.get(h),
                "refs": int(c),
            }
        )

    report = {
        "manifest": {
            "shardCount": len(files),
            "uniqueSamplerHashes": len(seen),
        },
        "viewer": {
            "referencedSlotHashes": len(slots_hashes),
            "referencedTerrainAdapterHashes": len(terrain_hashes),
            "referencedTotal": len(referenced),
        },
        "unmappedSamplers": missing,
        "unmappedCount": len(missing),
    }

    if args.out:
        outp = Path(args.out).resolve()
        outp.parent.mkdir(parents=True, exist_ok=True)
        outp.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"Wrote {outp}")
    else:
        print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


