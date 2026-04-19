#!/usr/bin/env python3
"""
Z-Image-Turbo (text->image) + Trellis2 (image->mesh->GLB) connector.
  prompt -> Z-Image-Turbo image -> Trellis2 mesh -> GLB

This tool is intentionally "optional" and lives under tools/ because it
requires a heavy external environment (GPU, PyTorch, diffusers, trellis2, o_voxel, etc).

Typical usage (in your trellis conda env):
  conda activate trellis
  python3 tools/zimage_text_to_glb.py \
    --prompt "Young Chinese woman in red Hanfu..." \
    --out-image outputs/zimage.png \
    --out-glb outputs/zimage.glb
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


def _eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


def _auto_pick_envmap(repo_root: Path) -> Path | None:
    """
    Pick a reasonable default HDRI envmap, if one exists in the repo.

    Preference order:
    - $WEBGL_GAME_DEFAULT_ENVMAP (if set + exists)
    - assets/hdri/studio.exr (if present)
    - repos/TRELLIS.2/assets/hdri/studio.exr (if present)
    - assets/hdri/forest.exr (if present)
    - repos/TRELLIS.2/assets/hdri/forest.exr (if present)
    - otherwise: first *.exr or *.hdr found in assets/hdri or repos/TRELLIS.2/assets/hdri
    """
    try:
        override = str(os.environ.get("WEBGL_GAME_DEFAULT_ENVMAP", "")).strip()
        if override:
            p = Path(override).expanduser()
            if p.exists():
                return p.resolve()
    except Exception:
        pass

    candidates = [
        repo_root / "assets" / "hdri" / "studio.exr",
        repo_root / "repos" / "TRELLIS.2" / "assets" / "hdri" / "studio.exr",
        repo_root / "assets" / "hdri" / "forest.exr",
        repo_root / "repos" / "TRELLIS.2" / "assets" / "hdri" / "forest.exr",
    ]
    for p in candidates:
        if p.exists():
            return p.resolve()

    for d in [repo_root / "assets" / "hdri", repo_root / "repos" / "TRELLIS.2" / "assets" / "hdri"]:
        try:
            if not d.exists():
                continue
            hits = sorted([*d.glob("*.exr"), *d.glob("*.hdr")])
            if hits:
                return hits[0].resolve()
        except Exception:
            continue
    return None


def _resolve_envmap_arg(args_envmap: str, repo_root: Path) -> Path | None:
    raw = str(args_envmap or "").strip()
    if raw:
        p = Path(raw).expanduser()
        if p.exists():
            return p.resolve()
        # If user provided a path but it doesn't exist, fall back to auto-pick.
        _eprint(f"Warning: --envmap not found: {p}. Falling back to default envmap (if available).")
    return _auto_pick_envmap(repo_root)


def _run(cmd: list[str]) -> None:
    p = subprocess.run(cmd, stdout=sys.stdout, stderr=sys.stderr)
    if p.returncode != 0:
        raise SystemExit(p.returncode)


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="tools/zimage_text_to_glb.py")

    # Z-Image-Turbo (text->image)
    ap.add_argument("--prompt", required=True, help="Text prompt for Z-Image-Turbo.")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--height", type=int, default=1024)
    ap.add_argument("--width", type=int, default=1024)
    ap.add_argument("--steps", type=int, default=9, help="num_inference_steps (Turbo expects guidance_scale=0).")
    ap.add_argument("--guidance-scale", type=float, default=0.0)
    ap.add_argument("--zimage-model", default="Tongyi-MAI/Z-Image-Turbo", help="HF model id.")
    ap.add_argument("--dtype", default="bf16", choices=["bf16", "fp16", "fp32"])
    ap.add_argument("--device", default="cuda", help='Device: "cuda", "cuda:0", or "cpu" (used for Z-Image + Trellis).')
    ap.add_argument("--low-cpu-mem-usage", type=int, default=0, choices=[0, 1])

    # Optional Z-Image toggles (best-effort; availability depends on diffusers build)
    ap.add_argument("--attention-backend", default="", choices=["", "flash", "_flash_3"], help="Best-effort transformer attention backend.")
    ap.add_argument("--compile-transformer", type=int, default=0, choices=[0, 1], help="Best-effort compile() on transformer.")
    ap.add_argument("--cpu-offload", type=int, default=0, choices=[0, 1], help="Enable diffusers CPU offload (requires accelerate).")

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
    import torch  # type: ignore

    ss = str(s).lower().strip()
    if ss == "bf16":
        return torch.bfloat16
    if ss == "fp16":
        return torch.float16
    return torch.float32


def _ensure_local_repos_on_path(repo_root: Path) -> None:
    # TRELLIS.2 is a source repo (no top-level pip package metadata).
    trellis_src = repo_root / "repos" / "TRELLIS.2"
    if trellis_src.exists() and (trellis_src / "trellis2").exists():
        sys.path.insert(0, str(trellis_src))


def _zimage_generate_image(args: argparse.Namespace):
    """
    Returns a PIL.Image.Image
    """
    import torch  # type: ignore
    from PIL import Image  # type: ignore

    # Compatibility shim:
    # diffusers may pass `enable_gqa=` into scaled_dot_product_attention (torch>=2.5).
    # Some torch builds in the wild don't accept that kwarg even if version checks pass.
    try:
        import torch.nn.functional as F  # type: ignore

        sdp = getattr(F, "scaled_dot_product_attention", None)
        if callable(sdp) and getattr(sdp, "__name__", "") != "_sdp_compat":
            _orig_sdp = sdp

            def _sdp_compat(*a, **kw):  # type: ignore
                kw.pop("enable_gqa", None)
                return _orig_sdp(*a, **kw)

            F.scaled_dot_product_attention = _sdp_compat  # type: ignore
    except Exception:
        pass

    try:
        from diffusers import ZImagePipeline  # type: ignore
    except Exception as e:
        raise RuntimeError(
            "Missing diffusers Z-Image pipeline in the current environment.\n"
            f"\nImport error: {e}"
        ) from e

    device = str(args.device)
    torch_dtype = _dtype_from_str(args.dtype)

    pipe = ZImagePipeline.from_pretrained(
        str(args.zimage_model),
        torch_dtype=torch_dtype,
        low_cpu_mem_usage=bool(int(args.low_cpu_mem_usage)),
    )

    if int(args.cpu_offload) == 1:
        try:
            pipe.enable_model_cpu_offload()
        except Exception as e:
            raise RuntimeError(
                "CPU offload requested but failed. If you want offload, install accelerate:\n"
                "  pip install accelerate\n"
                f"\nOffload error: {e}"
            ) from e
    else:
        pipe.to(device)

    if str(args.attention_backend).strip():
        try:
            tr = getattr(pipe, "transformer", None)
            if tr is not None and hasattr(tr, "set_attention_backend"):
                tr.set_attention_backend(str(args.attention_backend))
        except Exception as e:
            _eprint(f"Warning: failed to set attention backend ({e}). Continuing.")

    if int(args.compile_transformer) == 1:
        try:
            tr = getattr(pipe, "transformer", None)
            if tr is not None and hasattr(tr, "compile"):
                tr.compile()
        except Exception as e:
            _eprint(f"Warning: failed to compile transformer ({e}). Continuing.")

    gen_dev = "cuda" if device.startswith("cuda") else "cpu"
    generator = torch.Generator(gen_dev).manual_seed(int(args.seed))

    out = pipe(
        prompt=str(args.prompt),
        height=int(args.height),
        width=int(args.width),
        num_inference_steps=int(args.steps),
        guidance_scale=float(args.guidance_scale),
        generator=generator,
    )

    img = None
    if hasattr(out, "images"):
        imgs = getattr(out, "images")
        if isinstance(imgs, list) and imgs:
            img = imgs[0]

    if not isinstance(img, Image.Image):
        raise RuntimeError(f"Unexpected Z-Image output type: {type(out)}")
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

    # 1) Generate image from text via Z-Image.
    try:
        img = _zimage_generate_image(args)
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
            "  python3 tools/zimage_text_to_glb.py ...\n"
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
        envmap_path = _resolve_envmap_arg(str(args.envmap), repo_root)
        if not envmap_path or not envmap_path.exists():
            _eprint("--out-mp4 was set but no envmap was provided/found; skipping MP4 render.")
        else:
            _eprint(f"MP4 render envmap: {envmap_path}")
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

