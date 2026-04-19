#!/usr/bin/env python3
"""
Trellis2 (microsoft/TRELLIS.2-4B) connector: image -> mesh -> GLB.

This tool is intentionally "optional" and lives under tools/ because it
requires a heavy external environment (GPU, PyTorch, trellis2, o_voxel, etc).

Typical usage:
  conda activate trellis
  python3 tools/trellis2_image_to_glb.py \
    --image /abs/path/T.png \
    --out-glb /abs/path/sample.glb

Optional: render a preview MP4 (requires an HDRI envmap; EXR supported).
  python3 tools/trellis2_image_to_glb.py \
    --image /abs/path/T.png \
    --envmap /abs/path/forest.exr \
    --out-glb /abs/path/sample.glb \
    --out-mp4 /abs/path/sample.mp4

Optional: chain directly into the rigging connector:
  python3 tools/trellis2_image_to_glb.py \
    --image /abs/path/T.png \
    --out-glb /abs/path/sample.glb \
    --rig-backend rigify \
    --rig-out /abs/path/sample_rig.glb
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
        _eprint(f"Warning: --envmap not found: {p}. Falling back to default envmap (if available).")
    return _auto_pick_envmap(repo_root)


def _run(cmd: list[str]) -> None:
    p = subprocess.run(cmd, stdout=sys.stdout, stderr=sys.stderr)
    if p.returncode != 0:
        raise SystemExit(p.returncode)


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="tools/trellis2_image_to_glb.py")
    ap.add_argument("--model", default="microsoft/TRELLIS.2-4B", help="HF model id.")
    ap.add_argument("--image", required=True, help="Input image path.")
    ap.add_argument("--device", default="cuda", help="Device: cuda, cuda:0, or cpu.")
    ap.add_argument("--out-glb", required=True, help="Output GLB path.")
    ap.add_argument(
        "--pipeline-type",
        default="",
        choices=["", "512", "1024", "1024_cascade", "1536_cascade"],
        help="Optional Trellis pipeline variant (default uses model config).",
    )
    ap.add_argument("--seed", type=int, default=42, help="Random seed for reproducibility.")
    ap.add_argument("--preprocess-image", type=int, default=1, choices=[0, 1], help="Run Trellis image preprocessing.")
    ap.add_argument("--steps", type=int, default=50, help="Sampling steps for flow samplers.")
    ap.add_argument("--guidance-strength", type=float, default=3.0, help="Classifier-free guidance strength.")
    ap.add_argument("--ss-steps", type=int, default=None, help="Sparse-structure stage sampling steps.")
    ap.add_argument("--ss-guidance-strength", type=float, default=None, help="Sparse-structure stage guidance strength.")
    ap.add_argument("--ss-guidance-rescale", type=float, default=None, help="Sparse-structure stage guidance rescale.")
    ap.add_argument("--ss-rescale-t", type=float, default=None, help="Sparse-structure stage rescale_t.")
    ap.add_argument("--shape-steps", type=int, default=None, help="Shape latent stage sampling steps.")
    ap.add_argument("--shape-guidance-strength", type=float, default=None, help="Shape latent stage guidance strength.")
    ap.add_argument("--shape-guidance-rescale", type=float, default=None, help="Shape latent stage guidance rescale.")
    ap.add_argument("--shape-rescale-t", type=float, default=None, help="Shape latent stage rescale_t.")
    ap.add_argument("--tex-steps", type=int, default=None, help="Texture latent stage sampling steps.")
    ap.add_argument("--tex-guidance-strength", type=float, default=None, help="Texture latent stage guidance strength.")
    ap.add_argument("--tex-guidance-rescale", type=float, default=None, help="Texture latent stage guidance rescale.")
    ap.add_argument("--tex-rescale-t", type=float, default=None, help="Texture latent stage rescale_t.")

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


def main() -> int:
    # Enable OpenEXR in OpenCV if the environment uses cv2.
    os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
    # Can reduce fragmentation on large models.
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

    # TRELLIS.2 is a source repo (no top-level pip package metadata).
    # Make imports work by adding the local checkout to sys.path if present.
    repo_root = Path(__file__).resolve().parents[1]
    trellis_src = repo_root / "repos" / "TRELLIS.2"
    if trellis_src.exists() and (trellis_src / "trellis2").exists():
        sys.path.insert(0, str(trellis_src))

    args = _parse_args()
    image_path = Path(args.image).resolve()
    out_glb = Path(args.out_glb).resolve()
    out_glb.parent.mkdir(parents=True, exist_ok=True)

    try:
        import torch  # type: ignore
        from PIL import Image  # type: ignore
        from trellis2.pipelines import Trellis2ImageTo3DPipeline  # type: ignore
    except Exception as e:
        _eprint(
            "Missing dependencies for Trellis2.\n"
            "Activate your Trellis environment first, then re-run:\n"
            "  conda activate trellis\n"
            "  python3 tools/trellis2_image_to_glb.py ...\n"
            f"\nImport error: {e}"
        )
        return 2

    if not image_path.exists():
        _eprint(f"Input image not found: {image_path}")
        return 2

    device = str(args.device)
    pipeline = Trellis2ImageTo3DPipeline.from_pretrained(str(args.model))
    if device.startswith("cuda"):
        pipeline.cuda()
    else:
        # Some builds expose .to(); keep this best-effort.
        to = getattr(pipeline, "to", None)
        if callable(to):
            pipeline.to(device)

    image = Image.open(str(image_path))

    # Trellis2 signatures may vary by checkout/version. Build a richer kwargs set
    # and gracefully fall back when older signatures reject a field.
    run_kwargs = {
        "seed": int(args.seed),
        "preprocess_image": bool(int(args.preprocess_image)),
    }
    if str(args.pipeline_type).strip():
        run_kwargs["pipeline_type"] = str(args.pipeline_type).strip()
    def _sampler_kwargs(prefix: str) -> dict:
        steps = getattr(args, f"{prefix}_steps", None)
        g = getattr(args, f"{prefix}_guidance_strength", None)
        gr = getattr(args, f"{prefix}_guidance_rescale", None)
        rt = getattr(args, f"{prefix}_rescale_t", None)
        out = {
            "steps": int(steps) if steps is not None else int(args.steps),
            "guidance_strength": float(g) if g is not None else float(args.guidance_strength),
        }
        if gr is not None:
            out["guidance_rescale"] = float(gr)
        if rt is not None:
            out["rescale_t"] = float(rt)
        return out

    run_kwargs["sparse_structure_sampler_params"] = _sampler_kwargs("ss")
    run_kwargs["shape_slat_sampler_params"] = _sampler_kwargs("shape")
    run_kwargs["tex_slat_sampler_params"] = _sampler_kwargs("tex")

    while True:
        try:
            mesh = pipeline.run(image, **run_kwargs)[0]
            break
        except TypeError as e:
            msg = str(e)
            dropped = False
            for key in [
                "sparse_structure_sampler_params",
                "shape_slat_sampler_params",
                "tex_slat_sampler_params",
                "pipeline_type",
                "preprocess_image",
                "seed",
            ]:
                if key in run_kwargs and key in msg:
                    run_kwargs.pop(key, None)
                    dropped = True
                    break
            if dropped:
                continue
            raise

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
                img = cv2.imread(str(envmap_path), cv2.IMREAD_UNCHANGED)
                if img is None:
                    _eprint(f"Failed to read envmap: {envmap_path} (OpenCV returned None)")
                else:
                    env = EnvMap(
                        torch.tensor(cv2.cvtColor(img, cv2.COLOR_BGR2RGB), dtype=torch.float32, device="cuda" if device.startswith("cuda") else "cpu")
                    )
                    video = render_utils.make_pbr_vis_frames(render_utils.render_video(mesh, envmap=env))
                    imageio.mimsave(str(out_mp4), video, fps=int(args.fps))

    # Export to GLB via o_voxel postprocess.
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

        rig_cmd = [sys.executable, str(Path(__file__).resolve().parents[1] / "tools" / "rig_asset.py"), str(args.rig_backend), "--in", str(out_glb), "--out", str(rig_out)]
        if str(args.rig_args).strip():
            rig_cmd += str(args.rig_args).split()
        _run(rig_cmd)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

