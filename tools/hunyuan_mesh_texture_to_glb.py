#!/usr/bin/env python3
"""
Pure Hunyuan pipeline: image -> mesh -> textured GLB.

This script uses only Hunyuan3D-2:
1) Hunyuan3DDiTFlowMatchingPipeline for mesh generation
2) Hunyuan3DPaintPipeline for texture generation

No TRELLIS components are used.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def _eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        prog="tools/hunyuan_mesh_texture_to_glb.py",
        description="Hunyuan-only image -> textured GLB",
    )
    ap.add_argument("--image", required=True, help="Input image path.")
    ap.add_argument("--out-glb", required=True, help="Output GLB path.")
    ap.add_argument("--device", default="cuda", help='Device: "cuda", "cuda:0", or "cpu".')

    # Shape generation
    ap.add_argument("--shape-model", default="tencent/Hunyuan3D-2")
    ap.add_argument("--shape-subfolder", default="hunyuan3d-dit-v2-0-turbo")
    ap.add_argument("--shape-variant", default="fp16")
    ap.add_argument("--shape-steps", type=int, default=5)
    ap.add_argument("--shape-octree", type=int, default=380)
    ap.add_argument("--shape-num-chunks", type=int, default=200000)
    ap.add_argument("--shape-seed", type=int, default=42)
    ap.add_argument("--enable-flashvdm", type=int, default=1, choices=[0, 1])

    # Texture generation
    ap.add_argument("--tex-model", default="tencent/Hunyuan3D-2")
    ap.add_argument("--tex-subfolder", default="hunyuan3d-paint-v2-0-turbo")

    # Preprocess
    ap.add_argument(
        "--rembg",
        type=int,
        default=0,
        choices=[0, 1],
        help="Run Hunyuan rembg on RGB input. Use 0 to bypass NumPy/Numba rembg issues.",
    )

    return ap.parse_args()


def main() -> int:
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

    repo_root = Path(__file__).resolve().parents[1]
    hunyuan_src = repo_root / "repos" / "Hunyuan3D-2"
    if hunyuan_src.exists():
        sys.path.insert(0, str(hunyuan_src))

    args = _parse_args()
    image_path = Path(args.image).expanduser().resolve()
    out_glb = Path(args.out_glb).expanduser().resolve()
    out_glb.parent.mkdir(parents=True, exist_ok=True)

    if not image_path.exists():
        _eprint(f"Input image not found: {image_path}")
        return 2

    try:
        import torch
        from PIL import Image
        from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline
        from hy3dgen.texgen import Hunyuan3DPaintPipeline
    except Exception as e:
        _eprint(
            "Missing Hunyuan3D-2 dependencies.\n"
            "Install in your active env:\n"
            "  . /data/webgl-game/repos/Hunyuan3D-2/setup_hunyuan.sh\n"
            f"\nImport error: {e}"
        )
        return 2

    image = Image.open(str(image_path))
    if image.mode == "RGB" and int(args.rembg):
        try:
            from hy3dgen.rembg import BackgroundRemover
        except Exception as e:
            _eprint(
                "Hunyuan rembg failed to import. Re-run with --rembg 0.\n"
                f"Import error: {e}"
            )
            return 2
        _eprint("[prep] Removing background with Hunyuan rembg...")
        image = BackgroundRemover()(image)
    image = image.convert("RGBA")

    _eprint("[1/2] Hunyuan mesh generation...")
    shape_pipeline = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
        args.shape_model,
        device=str(args.device),
        subfolder=args.shape_subfolder,
        variant=args.shape_variant,
        use_safetensors=True,
    )
    if int(args.enable_flashvdm):
        try:
            shape_pipeline.enable_flashvdm()
        except Exception:
            pass

    mesh = shape_pipeline(
        image=image,
        num_inference_steps=int(args.shape_steps),
        octree_resolution=int(args.shape_octree),
        num_chunks=int(args.shape_num_chunks),
        generator=torch.manual_seed(int(args.shape_seed)),
        output_type="trimesh",
    )[0]
    if mesh is None:
        _eprint("Hunyuan shape generation returned no mesh.")
        return 2

    _eprint("[2/2] Hunyuan texture generation...")
    if str(args.device).startswith("cpu"):
        _eprint("Warning: Hunyuan texture stage is CUDA-centric and may fail/slow on CPU.")
    tex_pipeline = Hunyuan3DPaintPipeline.from_pretrained(
        args.tex_model,
        subfolder=args.tex_subfolder,
    )
    mesh = tex_pipeline(mesh, image=image)
    mesh.export(str(out_glb))
    _eprint(f"Wrote {out_glb}")

    try:
        if str(args.device).startswith("cuda"):
            torch.cuda.empty_cache()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
