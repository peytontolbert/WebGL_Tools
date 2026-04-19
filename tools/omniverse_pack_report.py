#!/usr/bin/env python3
"""
Omniverse pack inventory + "coverage" report.

This repo expects extracted Omniverse packs at:
  assets/external/omniverse/packs/<pack_name>/

This tool scans pack folders and produces a per-pack summary:
- file counts + bytes
- extension histogram
- heuristic "coverage" flags for: models/meshes, motions, materials, textures, docs

It intentionally does *not* parse USD deeply (fast, stdlib-only).
"""

from __future__ import annotations

import argparse
import json
import os
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path


TEXTURE_EXTS = {".png", ".jpg", ".jpeg", ".tga", ".exr", ".hdr", ".dds", ".ktx2", ".tif", ".tiff", ".bmp", ".webp"}
MODEL_EXTS = {".usd", ".usda", ".usdc", ".usdz", ".fbx", ".obj", ".gltf", ".glb"}
# NOTE: Many Omniverse packs store skeletal animation in USD (binary .usd/.usdc),
# but extension alone is not a useful signal (almost everything is USD).
# We keep this set for future improvements, but the current report uses
# path-based heuristics for "motions" instead.
MOTION_EXTS = {".bvh", ".fbx", ".gltf", ".glb"}
DOC_EXTS = {".md", ".txt", ".pdf", ".rtf", ".html"}
MATERIAL_EXTS = {".mdl", ".mtl", ".sbsar", ".json"}  # json included because packs often ship material graphs as json blobs


def _to_posix(p: Path) -> str:
    return str(p).replace(os.sep, "/")


def _walk_files(root: Path) -> list[Path]:
    out: list[Path] = []
    # pathlib.rglob can be slow on giant trees, but it’s simple and works.
    for p in root.rglob("*"):
        try:
            if p.is_file():
                out.append(p)
        except OSError:
            # Broken symlink / permission / transient IO.
            continue
    return out


def _guess_categories(rel_posix: str, ext: str) -> set[str]:
    low = rel_posix.lower()
    cats: set[str] = set()

    if ext in TEXTURE_EXTS or "/textures/" in low or "/texture/" in low:
        cats.add("textures")
    if ext == ".mdl" or "/materials/" in low or "/material/" in low or "/mdl/" in low:
        cats.add("materials")
    if "/characters/" in low or "/character/" in low or "/humans/" in low or "/reallusion/" in low:
        cats.add("characters")
    if "/props/" in low or "/prop/" in low:
        cats.add("props")
    if "/environments/" in low or "/environment/" in low or "/scenes/" in low or "/scene/" in low:
        cats.add("scenes")
    if "/animations/" in low or "/animation/" in low or "/motions/" in low or "/motion/" in low or "/anim/" in low:
        cats.add("motions")
    if ext in DOC_EXTS or "/readme" in low or "/license" in low or "/package-licenses/" in low:
        cats.add("docs")

    # "models" as a broad bucket: any 3D container or path signals.
    if ext in MODEL_EXTS or "/assets/" in low or "/models/" in low or "/meshes/" in low:
        cats.add("models")

    return cats


@dataclass
class PackReport:
    name: str
    path: str
    files: int
    bytes: int
    layout: str
    root_dirs: list[str]
    assets_dirs: list[str]
    entry_points: list[str]
    ext_counts: dict[str, int]
    category_counts: dict[str, int]
    coverage: dict[str, bool]
    notes: list[str]


def analyze_pack(pack_dir: Path) -> PackReport:
    def list_dirs(p: Path) -> list[str]:
        try:
            return sorted([x.name for x in p.iterdir() if x.is_dir() and not x.name.startswith(".")], key=str.lower)
        except OSError:
            return []

    root_dirs = list_dirs(pack_dir)
    assets_dirs: list[str] = []
    if (pack_dir / "Assets").exists():
        assets_dirs = list_dirs(pack_dir / "Assets")

    # Layout classification (heuristic).
    layout = "unknown"
    if "AEC_XR_Source" in root_dirs:
        layout = "aec_xr_source"
    elif "Usd_Explorer" in root_dirs:
        layout = "usd_explorer"
    elif "Demos" in root_dirs:
        layout = "demo_pack"
    elif "Assets" in root_dirs:
        if "simready_content" in assets_dirs:
            layout = "simready"
        elif "Particles" in assets_dirs:
            layout = "particles"
        elif "Extensions" in assets_dirs:
            layout = "extensions_samples"
        elif "Characters" in assets_dirs:
            layout = "characters"
        elif "ArchVis" in assets_dirs:
            layout = "archvis"
        elif "Configurator" in assets_dirs:
            layout = "configurator"
        else:
            layout = "assets_pack"

    entry_points: list[str] = []
    # Provide a few good starting folders for browsing.
    if "Assets" in root_dirs:
        entry_points.append("Assets/")
        if layout == "simready":
            entry_points += [
                "Assets/simready_content/common_assets/",
                "Assets/simready_content/materials/",
            ]
        if layout == "particles":
            entry_points += [
                "Assets/Particles/meshes/",
                "Assets/Particles/materials/",
                "Assets/Particles/textures/",
                "Assets/Particles/tutorials/",
            ]
        if layout == "characters":
            entry_points += [
                "Assets/Characters/",
                "Assets/Characters/Reallusion/",
            ]
        if layout == "archvis":
            entry_points += ["Assets/ArchVis/"]
        if layout == "configurator":
            entry_points += ["Assets/Configurator/"]
        if layout == "extensions_samples":
            entry_points += ["Assets/Extensions/"]
    if "Demos" in root_dirs:
        entry_points.append("Demos/")
    if "Usd_Explorer" in root_dirs:
        entry_points.append("Usd_Explorer/")
    if "AEC_XR_Source" in root_dirs:
        entry_points.append("AEC_XR_Source/")

    files = _walk_files(pack_dir)

    total_bytes = 0
    ext_counts: Counter[str] = Counter()
    cat_counts: Counter[str] = Counter()

    for f in files:
        try:
            st = f.stat()
            size = int(st.st_size)
        except OSError:
            size = 0
        total_bytes += size

        ext = f.suffix.lower()
        ext_counts[ext or "(noext)"] += 1

        rel = _to_posix(f.relative_to(pack_dir))
        cats = _guess_categories(rel, ext)
        for c in cats:
            cat_counts[c] += 1

    def has_ext(exts: set[str]) -> bool:
        return any(ext_counts.get(e, 0) > 0 for e in exts)

    # Heuristic "enough" flags for common workflows in this repo.
    has_models = has_ext(MODEL_EXTS) or cat_counts.get("models", 0) > 0
    has_textures = has_ext(TEXTURE_EXTS) or cat_counts.get("textures", 0) > 0
    has_materials = has_ext({".mdl"}) or cat_counts.get("materials", 0) > 0
    # Motions are determined by *path layout* (Animations/Motions folders, etc),
    # plus explicit motion container extensions like BVH.
    has_motions = (cat_counts.get("motions", 0) > 0) or has_ext({".bvh"})
    has_docs = any(ext_counts.get(e, 0) > 0 for e in DOC_EXTS) or cat_counts.get("docs", 0) > 0

    # Conservative grading for “character pack” usefulness:
    # - models + (materials or textures) is usually the minimum to convert to GLB.
    ok_for_viewer = has_models and (has_textures or has_materials)
    ok_for_retarget = has_motions and has_models  # you generally need a source armature in *some* asset

    notes: list[str] = []
    if not files:
        notes.append("pack directory is empty")
    if not has_models:
        notes.append("no obvious model files found (usd/fbx/obj/glb/gltf)")
    if has_models and not (has_textures or has_materials):
        notes.append("has models but no obvious textures/materials (may appear untextured after conversion)")
    if has_motions and not has_models:
        notes.append("has motion-ish paths but no model containers detected (check naming/layout)")

    return PackReport(
        name=pack_dir.name,
        path=_to_posix(pack_dir),
        files=len(files),
        bytes=total_bytes,
        layout=layout,
        root_dirs=root_dirs,
        assets_dirs=assets_dirs,
        entry_points=entry_points,
        ext_counts=dict(sorted(ext_counts.items(), key=lambda kv: (-kv[1], kv[0]))),
        category_counts=dict(sorted(cat_counts.items(), key=lambda kv: (-kv[1], kv[0]))),
        coverage={
            "has_models": bool(has_models),
            "has_motions": bool(has_motions),
            "has_materials": bool(has_materials),
            "has_textures": bool(has_textures),
            "has_docs": bool(has_docs),
            "ok_for_viewer": bool(ok_for_viewer),
            "ok_for_retarget": bool(ok_for_retarget),
        },
        notes=notes,
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, default=Path("assets/external/omniverse/packs"))
    ap.add_argument("--json", action="store_true", help="Emit JSON instead of pretty text.")
    args = ap.parse_args()

    root: Path = args.root
    if not root.exists():
        msg = f"Missing packs root: {root} (expected extracted Omniverse packs here)"
        if args.json:
            print(json.dumps({"ok": False, "error": msg, "root": str(root)}, indent=2))
        else:
            print(msg)
            print("Tip: run `python3 omniverse_assets.py` to download/extract packs into assets/external/omniverse/")
        return 2

    pack_dirs = [p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")]
    pack_dirs.sort(key=lambda p: p.name.lower())

    reports = [analyze_pack(p) for p in pack_dirs]
    total_files = sum(r.files for r in reports)
    total_bytes = sum(r.bytes for r in reports)

    if args.json:
        print(
            json.dumps(
                {
                    "ok": True,
                    "root": _to_posix(root),
                    "packs": [r.__dict__ for r in reports],
                    "totals": {"packs": len(reports), "files": total_files, "bytes": total_bytes},
                },
                indent=2,
            )
        )
        return 0

    # Pretty text
    print(f"Omniverse packs root: {root}")
    print(f"Packs: {len(reports)}   Files: {total_files}   Bytes: {total_bytes}")
    print("")
    for r in reports:
        cov = r.coverage
        print(f"- {r.name}")
        print(f"  path: {r.path}")
        print(f"  layout: {r.layout}")
        if r.root_dirs:
            print(f"  root_dirs: {', '.join(r.root_dirs[:10])}{' ...' if len(r.root_dirs) > 10 else ''}")
        if r.assets_dirs:
            print(f"  assets_dirs: {', '.join(r.assets_dirs[:10])}{' ...' if len(r.assets_dirs) > 10 else ''}")
        if r.entry_points:
            ep = ", ".join(r.entry_points[:6])
            print(f"  entry_points: {ep}{' ...' if len(r.entry_points) > 6 else ''}")
        print(f"  files: {r.files}   bytes: {r.bytes}")
        print(
            "  coverage:"
            f" models={int(cov['has_models'])}"
            f" motions={int(cov['has_motions'])}"
            f" materials={int(cov['has_materials'])}"
            f" textures={int(cov['has_textures'])}"
            f" docs={int(cov['has_docs'])}"
            f"  ok_for_viewer={int(cov['ok_for_viewer'])}"
            f"  ok_for_retarget={int(cov['ok_for_retarget'])}"
        )
        if r.notes:
            for n in r.notes:
                print(f"  note: {n}")
        # show top extensions (max 10)
        top_exts = list(r.ext_counts.items())[:10]
        if top_exts:
            top_str = ", ".join([f"{k}:{v}" for (k, v) in top_exts])
            print(f"  top_exts: {top_str}")
        print("")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

