#!/usr/bin/env python3
"""
Build an Omniverse ingestion manifest from per-pack tags reports.

Inputs:
  outputs/omniverse/omniverse_audit.json
  outputs/omniverse/<pack>_tags.json

Output:
  outputs/omniverse/omniverse_ingest_manifest.json

This manifest is intended to drive safe pipelines:
- identify "scene" entrypoint USDs (large composed stages) vs individual models
- identify motion-only USDs (SkelAnimation but no Mesh) that should never be converted to GLB
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]

SKIP_MODEL_DIRS = {
    "materials",
    "textures",
    "texture",
    "meshes",
    "mesh",
    "bones",
    "stage",
    "motion",
    "motions",
    "animations",
    "animation",
    "anim",
    "anims",
    "mdl",
    "shaders",
    "shader",
    "geometry",
    "layers",
}


def _read_json(p: Path) -> dict[str, Any]:
    return json.loads(p.read_text(encoding="utf-8") or "{}")


def _safe_int(x: Any) -> int:
    try:
        return int(x)
    except Exception:
        return 0


def _to_rel_posix(p: Path) -> str:
    try:
        return p.resolve().relative_to(REPO_ROOT.resolve()).as_posix()
    except Exception:
        return p.as_posix()


def _looks_like_subcomponent(path_posix: str) -> bool:
    parts = [p for p in str(path_posix or "").lower().split("/") if p]
    return any(p in SKIP_MODEL_DIRS for p in parts)


def _looks_like_scene(path_posix: str, stats: dict[str, Any]) -> bool:
    low = str(path_posix or "").lower()
    xform = _safe_int(stats.get("xformCount"))
    # Big composed stages tend to have huge Xform counts.
    if xform >= 5000:
        return True
    # Naming/location heuristics.
    if "/assemblies/" in low:
        return True
    if "assembly_" in low:
        return True
    if "/demos/" in low and ("/scene" in low or "scene" in low):
        return True
    return False


def _motion_only(stats: dict[str, Any]) -> bool:
    mesh = _safe_int(stats.get("meshCount"))
    skel_anim = _safe_int(stats.get("skelAnimationCount"))
    return mesh <= 0 and skel_anim > 0


def main() -> int:
    ap = argparse.ArgumentParser(prog="omniverse_build_ingest_manifest.py")
    ap.add_argument("--audit", default="outputs/omniverse/omniverse_audit.json")
    ap.add_argument("--tags-dir", default="outputs/omniverse")
    ap.add_argument("--out", default="outputs/omniverse/omniverse_ingest_manifest.json")
    ap.add_argument("--top-scenes", type=int, default=25, help="Top N scene candidates per pack.")
    ap.add_argument("--top-models", type=int, default=200, help="Top N model conversion candidates per pack.")
    args = ap.parse_args()

    audit_abs = (REPO_ROOT / str(args.audit)).resolve()
    if not audit_abs.exists():
        raise FileNotFoundError(str(audit_abs))
    tags_dir = (REPO_ROOT / str(args.tags_dir)).resolve()
    if not tags_dir.exists():
        raise FileNotFoundError(str(tags_dir))

    audit = _read_json(audit_abs)
    packs = audit.get("packs") or []
    if not isinstance(packs, list):
        raise ValueError("audit.packs must be a list")

    out_abs = (REPO_ROOT / str(args.out)).resolve()
    out_abs.parent.mkdir(parents=True, exist_ok=True)

    packs_out: list[dict[str, Any]] = []

    for p in packs:
        pack = str((p or {}).get("pack") or "").strip()
        if not pack:
            continue
        tags_abs = tags_dir / f"{pack}_tags.json"
        if not tags_abs.exists():
            packs_out.append({"pack": pack, "ok": False, "error": f"missing tags: {str(_to_rel_posix(tags_abs))}"})
            continue

        tags = _read_json(tags_abs)
        by_path = tags.get("byPath") or {}
        if not isinstance(by_path, dict):
            by_path = {}

        scene_candidates = []
        model_candidates = []
        motion_only = []

        for path_posix, rec in by_path.items():
            if not path_posix:
                continue
            rec = rec or {}
            stats = (rec.get("stats") or {}) if isinstance(rec, dict) else {}
            if not isinstance(stats, dict):
                stats = {}

            mesh = _safe_int(stats.get("meshCount"))
            skel_root = _safe_int(stats.get("skelRootCount"))
            skel_anim = _safe_int(stats.get("skelAnimationCount"))
            xform = _safe_int(stats.get("xformCount"))
            bytes_ = _safe_int(rec.get("bytes"))
            kind_hint = str(rec.get("kindHint") or "")
            asset_type_hint = str(rec.get("assetTypeHint") or "")

            if _motion_only(stats) or kind_hint == "motion":
                motion_only.append(
                    {
                        "path": path_posix,
                        "stats": {"meshCount": mesh, "skelRootCount": skel_root, "skelAnimationCount": skel_anim, "xformCount": xform},
                        "reason": "motion-only (anim but no mesh)",
                    }
                )
                continue

            if _looks_like_scene(path_posix, stats):
                scene_candidates.append(
                    {
                        "path": path_posix,
                        "stats": {"meshCount": mesh, "materialCount": _safe_int(stats.get("materialCount")), "xformCount": xform},
                        "bytes": bytes_,
                        "hint": asset_type_hint or "scene",
                    }
                )
                continue

            # Convertable models: mesh present, and not obviously a subcomponent.
            if mesh > 0 and not _looks_like_subcomponent(path_posix):
                model_candidates.append(
                    {
                        "path": path_posix,
                        "stats": {"meshCount": mesh, "materialCount": _safe_int(stats.get("materialCount")), "skelRootCount": skel_root, "skelAnimationCount": skel_anim},
                        "bytes": bytes_,
                        "hint": asset_type_hint or "",
                    }
                )

        scene_candidates.sort(key=lambda r: (_safe_int(r.get("stats", {}).get("xformCount")), _safe_int(r.get("bytes"))), reverse=True)
        model_candidates.sort(key=lambda r: (_safe_int(r.get("bytes")), _safe_int(r.get("stats", {}).get("meshCount"))), reverse=True)
        motion_only.sort(key=lambda r: str(r.get("path") or ""))

        top_scenes = scene_candidates[: max(0, int(args.top_scenes))]
        top_models = model_candidates[: max(0, int(args.top_models))]

        packs_out.append(
            {
                "pack": pack,
                "ok": True,
                "tagsPath": _to_rel_posix(tags_abs),
                "counts": {
                    "pathsTagged": len(by_path),
                    "sceneCandidates": len(scene_candidates),
                    "convertableModels": len(model_candidates),
                    "motionOnlyUsd": len(motion_only),
                },
                "scenes": top_scenes,
                "convertToGlb": top_models,
                "motionOnly": motion_only[:2000],  # safety cap
            }
        )

    out_obj = {
        "ok": True,
        "auditPath": _to_rel_posix(audit_abs),
        "packsRoot": str(audit.get("packsRoot") or ""),
        "packCount": len(packs_out),
        "packs": packs_out,
    }
    out_abs.write_text(json.dumps(out_obj, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote: {out_abs}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

