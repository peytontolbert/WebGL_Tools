#!/usr/bin/env python3
"""
Sana (text->image) + Trellis2 (image->mesh->GLB) connector.
  prompt -> Sana image -> Trellis2 mesh -> GLB

This tool is intentionally "optional" and lives under tools/ because it
requires a heavy external environment (GPU, PyTorch, diffusers, trellis2, o_voxel, etc).

Typical usage (in your trellis conda env):
  conda activate trellis
  python3 tools/sana_text_to_glb.py \
    --prompt "a tiny astronaut hatching from an egg on the moon" \
    --out-image outputs/sana.png \
    --out-glb outputs/sana.glb
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


def _eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


def _run(cmd: list[str]) -> None:
    p = subprocess.run(cmd, stdout=sys.stdout, stderr=sys.stderr)
    if p.returncode != 0:
        raise SystemExit(p.returncode)


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="tools/sana_text_to_glb.py")

    # Sana (text->image)
    ap.add_argument("--prompt", required=True, help="Text prompt for Sana.")
    ap.add_argument("--negative-prompt", default="", help="Optional negative prompt.")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--steps", type=int, default=20, help="Sana diffusion steps (Sprint typically uses 2).")
    ap.add_argument("--guidance-scale", type=float, default=4.5)
    ap.add_argument("--height", type=int, default=1024)
    ap.add_argument("--width", type=int, default=1024)
    ap.add_argument("--sana-kind", default="sana", choices=["sana", "sana_sprint"], help="Which Sana pipeline to use (diffusers).")
    ap.add_argument(
        "--sana-model",
        default="Efficient-Large-Model/SANA1.5_1.6B_1024px_diffusers",
        help="HF model id for Sana (diffusers format).",
    )
    ap.add_argument("--dtype", default="bf16", choices=["bf16", "fp16", "fp32"])
    ap.add_argument("--device", default="cuda", help="Device: cuda, cuda:0, or cpu (used for Sana + Trellis).")

    ap.add_argument("--out-image", required=True, help="Output image path (PNG recommended).")

    # Trellis2 (image->glb) export options (mirrors tools/trellis2_image_to_glb.py)
    ap.add_argument("--trellis-model", default="microsoft/TRELLIS.2-4B", help="HF model id.")
    ap.add_argument("--out-glb", required=True, help="Output GLB path.")
    ap.add_argument("--simplify", type=int, default=16777216, help="Mesh simplify budget (passed to mesh.simplify).")
    ap.add_argument("--aabb", default="-0.5,-0.5,-0.5,0.5,0.5,0.5", help="AABB as minx,miny,minz,maxx,maxy,maxz.")
    ap.add_argument("--decimation-target", type=int, default=1_000_000)
    ap.add_argument("--texture-size", type=int, default=4096)
    ap.add_argument("--remesh", type=int, default=1, choices=[0, 1])
    ap.add_argument("--remesh-band", type=int, default=1)
    ap.add_argument("--remesh-project", type=int, default=0)
    ap.add_argument("--extension-webp", type=int, default=1, choices=[0, 1], help="Use WEBP texture extension in GLB.")

    # Preview render
    ap.add_argument("--envmap", default="", help="Optional HDRI envmap path (EXR recommended).")
    ap.add_argument("--out-mp4", default="", help="Optional MP4 output path.")
    ap.add_argument("--fps", type=int, default=15)

    # Optional chaining into rigging
    ap.add_argument("--rig-backend", default="", choices=["", "rigify", "blenrig", "rigacar", "unirig", "riganything", "rignet"])
    ap.add_argument("--rig-out", default="", help="Output path for rigged GLB (required if --rig-backend is set).")
    ap.add_argument("--rig-args", default="", help="Extra args string passed to tools/rig_asset.py after the backend name.")

    return ap.parse_args()


def _dtype_from_str(s: str):
    # Local helper so this file can import even if torch isn't installed.
    import torch  # type: ignore

    ss = str(s).lower().strip()
    if ss == "bf16":
        return torch.bfloat16
    if ss == "fp16":
        return torch.float16
    return torch.float32


def _ensure_local_repos_on_path(repo_root: Path) -> None:
    # Sana is optional; this adds the local clone so importing any of its helpers is possible.
    sana_src = repo_root / "repos" / "Sana"
    if sana_src.exists():
        sys.path.insert(0, str(sana_src))

    # TRELLIS.2 is a source repo (no top-level pip package metadata).
    trellis_src = repo_root / "repos" / "TRELLIS.2"
    if trellis_src.exists() and (trellis_src / "trellis2").exists():
        sys.path.insert(0, str(trellis_src))


def _sana_generate_image(args: argparse.Namespace):
    """
    Returns a PIL.Image.Image
    """
    import torch  # type: ignore
    from PIL import Image  # type: ignore

    device = str(args.device)
    torch_dtype = _dtype_from_str(args.dtype)

    try:
        if args.sana_kind == "sana_sprint":
            from diffusers import SanaSprintPipeline as _Pipe  # type: ignore
        else:
            from diffusers import SanaPipeline as _Pipe  # type: ignore
    except Exception as e:
        raise RuntimeError(
            "Missing diffusers Sana pipeline. Install/upgrade diffusers in your env.\n"
            "Recommended:\n"
            "  pip install git+https://github.com/huggingface/diffusers\n"
            f"\nImport error: {e}"
        ) from e

    pipe = _Pipe.from_pretrained(str(args.sana_model), torch_dtype=torch_dtype)
    # For Sana, bfloat16 weights are common; keep submodules consistent.
    to = getattr(pipe, "to", None)
    if callable(to):
        pipe.to(device)

    gen_dev = device if device.startswith("cuda") else "cpu"
    generator = torch.Generator(device=gen_dev).manual_seed(int(args.seed))

    out = pipe(
        prompt=str(args.prompt),
        negative_prompt=str(args.negative_prompt) if str(args.negative_prompt).strip() else None,
        height=int(args.height),
        width=int(args.width),
        guidance_scale=float(args.guidance_scale),
        num_inference_steps=int(args.steps),
        generator=generator,
    )

    # diffusers pipelines return either `.images` or indexable output.
    img = None
    if hasattr(out, "images"):
        imgs = getattr(out, "images")
        if isinstance(imgs, list) and imgs:
            img = imgs[0]
    if img is None:
        try:
            maybe = out[0]
            if isinstance(maybe, list) and maybe:
                img = maybe[0]
            else:
                img = maybe
        except Exception:
            img = None

    if not isinstance(img, Image.Image):
        raise RuntimeError(f"Unexpected Sana output type: {type(out)}")
    return img


def main() -> int:
    # Enable OpenEXR in OpenCV if the environment uses cv2.
    os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
    # Can reduce fragmentation on large models.
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

    args = _parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    _ensure_local_repos_on_path(repo_root)

    out_image = Path(args.out_image).resolve()
    out_image.parent.mkdir(parents=True, exist_ok=True)
    out_glb = Path(args.out_glb).resolve()
    out_glb.parent.mkdir(parents=True, exist_ok=True)

    # 1) Generate image from text via Sana.
    try:
        img = _sana_generate_image(args)
    except Exception as e:
        _eprint(str(e))
        return 2

    img.save(str(out_image))

    # 2) Run Trellis2 image->mesh.
    try:
        import torch  # type: ignore
        from trellis2.pipelines import Trellis2ImageTo3DPipeline  # type: ignore
    except Exception as e:
        _eprint(
            "Missing dependencies for Trellis2.\n"
            "Activate your Trellis environment first, then re-run:\n"
            "  conda activate trellis\n"
            "  python3 tools/sana_text_to_glb.py ...\n"
            f"\nImport error: {e}"
        )
        return 2

    device = str(args.device)
    pipeline = Trellis2ImageTo3DPipeline.from_pretrained(str(args.trellis_model))
    if device.startswith("cuda"):
        pipeline.cuda()
    else:
        to = getattr(pipeline, "to", None)
        if callable(to):
            pipeline.to(device)

    mesh = pipeline.run(img)[0]

    if int(args.simplify) > 0 and hasattr(mesh, "simplify"):
        mesh.simplify(int(args.simplify))

    # Optional preview render.
    if str(args.out_mp4).strip():
        out_mp4 = Path(args.out_mp4).resolve()
        out_mp4.parent.mkdir(parents=True, exist_ok=True)
        envmap_path = Path(args.envmap).resolve() if str(args.envmap).strip() else None
        if not envmap_path or not envmap_path.exists():
            _eprint("--out-mp4 was set but --envmap was missing or not found; skipping MP4 render.")
        else:
            try:
                import cv2  # type: ignore
                import imageio  # type: ignore
                from trellis2.utils import render_utils  # type: ignore
                from trellis2.renderers import EnvMap  # type: ignore
            except Exception as e:
                _eprint(f"MP4 render requested but render deps missing: {e}")
            else:
                img_exr = cv2.imread(str(envmap_path), cv2.IMREAD_UNCHANGED)
                if img_exr is None:
                    _eprint(f"Failed to read envmap: {envmap_path} (OpenCV returned None)")
                else:
                    env = EnvMap(
                        torch.tensor(
                            cv2.cvtColor(img_exr, cv2.COLOR_BGR2RGB),
                            dtype=torch.float32,
                            device="cuda" if device.startswith("cuda") else "cpu",
                        )
                    )
                    video = render_utils.make_pbr_vis_frames(render_utils.render_video(mesh, envmap=env))
                    imageio.mimsave(str(out_mp4), video, fps=int(args.fps))

    # 3) Export to GLB via o_voxel postprocess.
    try:
        import o_voxel  # type: ignore
    except Exception as e:
        _eprint(
            "o_voxel is required to export GLB from Trellis2 mesh.\n"
            "Install it in your trellis env (or adjust this script to your exporter).\n"
            f"\nImport error: {e}"
        )
        return 2

    try:
        a = [float(x) for x in str(args.aabb).split(",")]
        if len(a) != 6:
            raise ValueError("expected 6 floats")
        aabb = [[a[0], a[1], a[2]], [a[3], a[4], a[5]]]
    except Exception as e:
        _eprint(f"Invalid --aabb: {args.aabb} ({e})")
        return 2

    glb = o_voxel.postprocess.to_glb(
        vertices=mesh.vertices,
        faces=mesh.faces,
        attr_volume=mesh.attrs,
        coords=mesh.coords,
        attr_layout=mesh.layout,
        voxel_size=mesh.voxel_size,
        aabb=aabb,
        decimation_target=int(args.decimation_target),
        texture_size=int(args.texture_size),
        remesh=bool(int(args.remesh)),
        remesh_band=int(args.remesh_band),
        remesh_project=int(args.remesh_project),
        verbose=True,
    )
    glb.export(str(out_glb), extension_webp=bool(int(args.extension_webp)))

    # Optional chaining into auto-rigging.
    if str(args.rig_backend).strip():
        if not str(args.rig_out).strip():
            _eprint("--rig-out is required when --rig-backend is set.")
            return 2
        rig_out = Path(args.rig_out).resolve()
        rig_out.parent.mkdir(parents=True, exist_ok=True)

        rig_cmd = [
            sys.executable,
            str(repo_root / "tools" / "rig_asset.py"),
            str(args.rig_backend),
            "--in",
            str(out_glb),
            "--out",
            str(rig_out),
        ]
        if str(args.rig_args).strip():
            rig_cmd += str(args.rig_args).split()
        _run(rig_cmd)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

