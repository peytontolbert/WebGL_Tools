#!/usr/bin/env python3
"""
Audit extracted Omniverse packs and write a tags/index report for ingestion.

This script is designed to run inside the repo's `conda trellis` env (needs `pxr`):
  conda run -n trellis python3 tools/omniverse_audit_packs.py --out outputs/omniverse/omniverse_audit.json

Outputs:
- a top-level JSON with per-pack summaries
- optionally, per-pack tag files: outputs/omniverse/<pack>_tags.json
  (schema includes a `byPath` map so devtools can load it instantly)
"""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


REPO_ROOT = Path(__file__).resolve().parents[1]

USD_EXTS = {".usd", ".usda", ".usdc", ".usdz"}
MODEL_EXTS = USD_EXTS | {".fbx", ".glb", ".gltf"}
IMAGE_EXTS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".tga",
    ".exr",
    ".hdr",
    ".dds",
    ".ktx2",
    ".tif",
    ".tiff",
    ".bmp",
    ".webp",
    ".gif",
}

SKIP_TRAVERSAL_DIRS = {
    ".thumbs",
    "__pycache__",
    "package-licenses",
    "licenses",
    "license",
}

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
}

MOTION_DIR_HINTS = {"motion", "motions", "animation", "animations", "anim", "anims", "bvh"}


def _tokenize(s: str) -> list[str]:
    import re

    return [t for t in re.split(r"[^a-z0-9]+", str(s or "").lower()) if t]


def _infer_kind(rel: str, ext: str) -> str:
    low = rel.lower()
    parts = low.split("/")
    is_motion_ctx = any(p in MOTION_DIR_HINTS for p in parts)
    if ext == ".bvh":
        return "motion"
    if ext in USD_EXTS and is_motion_ctx:
        return "motion"
    return "model"


def _infer_asset_type(rel: str, kind: str) -> str:
    toks = set(_tokenize(rel))
    if kind == "motion":
        return "animation"
    if toks & {"character", "characters", "people", "person", "human", "humans", "avatar"}:
        return "character"
    if toks & {"anim", "anims", "animation", "animations", "motion", "motions", "walk", "run", "idle"}:
        return "animation"
    if toks & {"city", "cities", "town", "street", "streets", "urban", "block", "road", "roads"}:
        return "city"
    if toks & {
        "building",
        "buildings",
        "house",
        "apartment",
        "tower",
        "skyscraper",
        "office",
        "warehouse",
        "datacenter",
        "restaurant",
        "residential",
        "commercial",
    }:
        return "building"
    if toks & {"vehicle", "vehicles", "car", "truck", "bus", "van", "bike", "bicycle"}:
        return "vehicle"
    if toks & {"prop", "props", "furniture", "chair", "table", "sofa", "lamp", "shelf", "cabinet", "misc"}:
        return "prop"
    if toks & {"environment", "env", "terrain", "landscape", "park", "nature", "outdoor"}:
        return "environment"
    return "other"


def _to_rel_posix(p: Path) -> str:
    try:
        return p.resolve().relative_to(REPO_ROOT.resolve()).as_posix()
    except Exception:
        return p.as_posix()


def _safe_size(p: Path) -> int:
    try:
        return int(p.stat().st_size)
    except Exception:
        return 0


def _is_entrypoint_dir(rel_parent: str) -> bool:
    parts = [p for p in rel_parent.lower().split("/") if p]
    return not any(p in SKIP_MODEL_DIRS for p in parts)


def _inspect_usd_counts(abs_path: Path) -> dict[str, Any]:
    """
    In-process USD inspection (counts only + Xform count), no dependency scan.
    """
    try:
        from pxr import Usd  # type: ignore
    except Exception as e:
        return {"ok": False, "error": f"missing pxr bindings: {e}"}

    if not abs_path.exists():
        return {"ok": False, "error": f"missing file: {abs_path}"}

    stage = Usd.Stage.Open(str(abs_path))
    if not stage:
        return {"ok": False, "error": "Usd.Stage.Open returned None"}

    mesh = mat = shd = skel_root = skel_anim = xform = 0
    try:
        for prim in stage.TraverseAll():
            t = prim.GetTypeName() or ""
            if t == "Mesh":
                mesh += 1
            elif t == "Material":
                mat += 1
            elif t == "Shader":
                shd += 1
            elif t == "SkelRoot":
                skel_root += 1
            elif t == "SkelAnimation":
                skel_anim += 1
            elif t == "Xform":
                xform += 1
    except Exception as e:
        return {"ok": False, "error": f"traverse failed: {e}"}

    return {
        "ok": True,
        "stats": {
            "meshCount": int(mesh),
            "materialCount": int(mat),
            "shaderCount": int(shd),
            "skelRootCount": int(skel_root),
            "skelAnimationCount": int(skel_anim),
            "xformCount": int(xform),
        },
    }


def _walk_files(pack_abs: Path) -> Iterable[Path]:
    for root, dirs, files in os.walk(pack_abs):
        # Prune traversal dirs.
        base = Path(root).name.lower()
        if base in SKIP_TRAVERSAL_DIRS:
            dirs[:] = []
            continue
        dirs[:] = [d for d in dirs if d and not d.startswith(".") and d.lower() not in SKIP_TRAVERSAL_DIRS]
        for fn in files:
            if not fn or fn.startswith("."):
                continue
            yield Path(root) / fn


def main() -> int:
    ap = argparse.ArgumentParser(prog="omniverse_audit_packs.py")
    ap.add_argument("--packs-root", default="assets/external/omniverse/packs")
    ap.add_argument("--out", default="outputs/omniverse/omniverse_audit.json")
    ap.add_argument("--write-pack-tags", action="store_true", help="Also write outputs/omniverse/<pack>_tags.json with byPath map.")
    ap.add_argument("--max-usd-per-pack", type=int, default=0, help="Optional cap for USD inspections per pack (0 = no cap).")
    ap.add_argument("--pack", action="append", default=[], help="Only audit these packs (repeatable).")
    args = ap.parse_args()

    packs_root = (REPO_ROOT / str(args.packs_root)).resolve()
    if not packs_root.exists():
        raise FileNotFoundError(str(packs_root))

    only = [s.strip() for s in (args.pack or []) if s.strip()]
    packs = [p for p in packs_root.iterdir() if p.is_dir() and not p.name.startswith(".")]
    if only:
        want = set(only)
        packs = [p for p in packs if p.name in want]
    packs.sort(key=lambda p: p.name.lower())

    out_abs = (REPO_ROOT / str(args.out)).resolve()
    out_abs.parent.mkdir(parents=True, exist_ok=True)

    pack_reports = []

    for pack_abs in packs:
        pack_name = pack_abs.name
        # Candidate model files: entrypoint-ish.
        candidates = []
        for fp in _walk_files(pack_abs):
            ext = fp.suffix.lower()
            if ext not in MODEL_EXTS and ext != ".bvh":
                continue
            rel = _to_rel_posix(fp)
            parent_rel = "/".join(rel.split("/")[:-1])
            if ext in USD_EXTS and not _is_entrypoint_dir(parent_rel):
                # still include scenes/assemblies sometimes; allow if it looks like an assembly/context
                low = rel.lower()
                if ("/assemblies/" not in low) and ("/demos/" not in low) and ("assembly_" not in low) and ("scene" not in low):
                    continue
            kind = _infer_kind(rel, ext)
            asset_type = _infer_asset_type(rel, kind)
            candidates.append({"path": rel, "abs": fp, "ext": ext, "kind": kind, "assetType": asset_type, "bytes": _safe_size(fp)})

        # Sort largest-first so we inspect the most "important" stages first if capped.
        candidates.sort(key=lambda it: int(it.get("bytes") or 0), reverse=True)

        by_path: dict[str, Any] = {}
        inspected = 0

        for it in candidates:
            p = str(it["path"])
            ext = str(it["ext"])
            if ext not in USD_EXTS:
                continue
            if args.max_usd_per_pack and inspected >= int(args.max_usd_per_pack):
                break
            abs_path = Path(it["abs"])
            ir = _inspect_usd_counts(abs_path)
            if ir.get("ok"):
                stats = ir.get("stats") or {}
                # Derive kind hint: motion-only USDs are those with anim but no mesh.
                mesh = int(stats.get("meshCount") or 0)
                skel_anim = int(stats.get("skelAnimationCount") or 0)
                kind_hint = "motion" if (mesh <= 0 and skel_anim > 0) else "model"
                by_path[p] = {
                    "stats": stats,
                    "kindHint": kind_hint,
                    "assetTypeHint": str(it.get("assetType") or ""),
                    "bytes": int(it.get("bytes") or 0),
                }
            inspected += 1

        # Summaries.
        total_models = sum(1 for it in candidates if it["kind"] == "model")
        total_motions = sum(1 for it in candidates if it["kind"] == "motion")
        usd_candidates = sum(1 for it in candidates if it["ext"] in USD_EXTS)
        scene_like = 0
        for p, v in by_path.items():
            st = (v or {}).get("stats") or {}
            xf = int(st.get("xformCount") or 0)
            if xf >= 5000:
                scene_like += 1

        pack_reports.append(
            {
                "pack": pack_name,
                "candidates": {"total": len(candidates), "usd": usd_candidates, "model": total_models, "motion": total_motions},
                "inspectedUsd": len(by_path),
                "sceneLikeUsd": scene_like,
                "byPathCount": len(by_path),
            }
        )

        if args.write_pack_tags:
            tags_abs = (REPO_ROOT / "outputs" / "omniverse" / f"{pack_name}_tags.json").resolve()
            tags_abs.parent.mkdir(parents=True, exist_ok=True)
            tags_abs.write_text(
                json.dumps(
                    {
                        "ok": True,
                        "pack": pack_name,
                        "packsRoot": _to_rel_posix(packs_root),
                        "byPath": by_path,
                    },
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )

    out_abs.write_text(json.dumps({"ok": True, "packsRoot": _to_rel_posix(packs_root), "packs": pack_reports}, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote: {out_abs}")
    print(f"Packs: {len(pack_reports)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

