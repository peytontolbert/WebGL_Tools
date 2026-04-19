#!/usr/bin/env python3
"""
Build a local catalog for HumanDataset Rigged meshes.

This catalog is used by:
- DevTools batch rigging workflows
- TRELLIS fine-tune preprocessing handoff (mesh list export)
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Iterable


MESH_EXTS = {".fbx", ".glb", ".gltf", ".obj"}
TRAILING_VARIANTS = ("_u3d", "_ue4", "_yup_a", "_zup_a")


def iter_meshes(root: Path) -> Iterable[Path]:
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        if p.suffix.lower() in MESH_EXTS:
            yield p


def model_id_from_path(path: Path) -> str:
    name = path.stem
    low = name.lower()
    for suf in TRAILING_VARIANTS:
        if low.endswith(suf):
            return name[: -len(suf)]
    return name


def main() -> int:
    ap = argparse.ArgumentParser(description="Build HumanDataset rigged catalog JSON and mesh list")
    ap.add_argument("--root", required=True, help="Dataset root (e.g. repos/TRELLIS.2/datasets/humandataset/rigged)")
    ap.add_argument("--workspace-root", default=".", help="Workspace root to generate project-relative paths")
    ap.add_argument("--out-json", required=True, help="Output catalog JSON path")
    ap.add_argument("--out-list", required=True, help="Output newline-delimited mesh path list")
    args = ap.parse_args()

    workspace_root = Path(args.workspace_root).resolve()
    root = Path(args.root).resolve()
    out_json = Path(args.out_json).resolve()
    out_list = Path(args.out_list).resolve()

    if not root.exists():
        raise SystemExit(f"Root does not exist: {root}")

    items = []
    for mesh in iter_meshes(root):
        rel = mesh.resolve().relative_to(workspace_root).as_posix()
        items.append(
            {
                "path": rel,
                "modelId": model_id_from_path(mesh),
                "ext": mesh.suffix.lower(),
                "bytes": mesh.stat().st_size,
            }
        )

    items.sort(key=lambda x: (x["modelId"].lower(), x["path"].lower()))

    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_list.parent.mkdir(parents=True, exist_ok=True)

    out_json.write_text(json.dumps({"count": len(items), "items": items}, indent=2), encoding="utf-8")
    out_list.write_text("\n".join([it["path"] for it in items]) + ("\n" if items else ""), encoding="utf-8")

    print(f"Wrote {len(items)} items")
    print(f"catalog: {out_json}")
    print(f"mesh list: {out_list}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

