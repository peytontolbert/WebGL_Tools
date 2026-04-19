#!/usr/bin/env python3
"""
Hunyuan3D-Part integration: holistic mesh -> decomposed parts (P3-SAM + X-Part).

Takes a complete mesh (e.g. from Hunyuan3D or TRELLIS) and decomposes it into
semantic parts. P3-SAM performs 3D part segmentation; X-Part generates
high-fidelity individual parts.

Typical usage:
  conda activate trellis  # or env with Hunyuan3D-Part deps
  python3 tools/hunyuan3d_part_mesh_to_parts.py \
    --mesh assets/generated/sample.glb \
    --out-dir assets/generated/sample_parts

Requirements:
  - repos/Hunyuan3D-Part (P3-SAM + XPart)
  - tencent/Hunyuan3D-Part on HuggingFace (weights)

Recommended input: AI-generated or scanned meshes (Hunyuan3D V2.5/V3.0, TRELLIS).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def _eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        prog="tools/hunyuan3d_part_mesh_to_parts.py",
        description="Hunyuan3D-Part: mesh -> decomposed parts (P3-SAM + X-Part)",
    )
    ap.add_argument("--mesh", required=True, help="Input mesh path (GLB/OBJ).")
    ap.add_argument("--out-dir", required=True, help="Output directory for part meshes.")
    ap.add_argument(
        "--model",
        default="tencent/Hunyuan3D-Part",
        help="HuggingFace model id.",
    )
    ap.add_argument("--octree-resolution", type=int, default=512)
    ap.add_argument("--device", default="cuda")
    return ap.parse_args()


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    part_src = repo_root / "repos" / "Hunyuan3D-Part" / "XPart"

    if not part_src.exists():
        _eprint(
            "Hunyuan3D-Part XPart not found. Ensure repos/Hunyuan3D-Part is cloned.\n"
            "  git clone https://github.com/Tencent-Hunyuan/Hunyuan3D-Part repos/Hunyuan3D-Part"
        )
        return 2

    sys.path.insert(0, str(part_src))

    args = _parse_args()
    mesh_path = Path(args.mesh).resolve()
    out_dir = Path(args.out_dir).resolve()

    if not mesh_path.exists():
        _eprint(f"Input mesh not found: {mesh_path}")
        return 2

    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        import torch
        from partgen.partformer_pipeline import PartFormerPipeline
    except ImportError as e:
        _eprint(
            "Hunyuan3D-Part dependencies missing. Install:\n"
            "  cd repos/Hunyuan3D-Part/XPart && pip install -r requirements.txt\n"
            "  pip install pytorch-lightning\n"
            f"Import error: {e}"
        )
        return 2

    _eprint("Loading Hunyuan3D-Part pipeline...")
    pipeline = PartFormerPipeline.from_pretrained(
        model_path=args.model,
        verbose=True,
    )
    pipeline.to(device=args.device, dtype=torch.float32)

    _eprint(f"Processing {mesh_path}...")
    obj_mesh, (out_bbox, mesh_gt_bbox, explode_object) = pipeline(
        mesh_path=str(mesh_path),
        octree_resolution=int(args.octree_resolution),
        output_type="trimesh",
    )

    uid = mesh_path.stem
    obj_mesh.export(out_dir / f"{uid}_parts.glb")
    out_bbox.export(out_dir / f"{uid}_bbox.glb")
    mesh_gt_bbox.export(out_dir / f"{uid}_input_bbox.glb")
    explode_object.export(out_dir / f"{uid}_explode.glb")

    _eprint(f"Wrote parts to {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
