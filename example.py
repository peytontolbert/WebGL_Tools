#!/usr/bin/env python3
"""
Example: Image -> 3D (GLB) using TRELLIS.2, executed inside the `trellis` conda env.

This repo already contains the actual exporter script:
  tools/trellis2_image_to_glb.py

This wrapper exists so you can run from the repo root without manually activating
the conda environment:
  python3 example.py --image outputs/T.png --out-glb outputs/trellis_sample.glb
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


def _abs(p: str) -> str:
    s = str(p or "").strip()
    if not s:
        return ""
    return str(Path(s).expanduser().resolve())


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="example.py", description="Run TRELLIS.2 image→3D under conda env `trellis`.")
    ap.add_argument("--conda-env", default="trellis", help="Conda env name (default: trellis).")

    # Main inputs/outputs
    ap.add_argument("--image", default="", help="Input image path (png/jpg/webp).")
    ap.add_argument("--out-glb", default="", help="Output GLB path.")

    # Model/device
    ap.add_argument("--model", default="microsoft/TRELLIS.2-4B", help="HF model id.")
    ap.add_argument("--device", default="cuda", help="Device: cuda, cuda:0, or cpu.")

    # Mesh/export options (forwarded)
    ap.add_argument("--simplify", type=int, default=16777216)
    ap.add_argument("--aabb", default="-0.5,-0.5,-0.5,0.5,0.5,0.5")
    ap.add_argument("--decimation-target", type=int, default=1_000_000)
    ap.add_argument("--texture-size", type=int, default=4096)
    ap.add_argument("--remesh", type=int, default=1, choices=[0, 1])
    ap.add_argument("--remesh-band", type=int, default=1)
    ap.add_argument("--remesh-project", type=int, default=0)
    ap.add_argument("--extension-webp", type=int, default=1, choices=[0, 1])

    # Optional MP4 preview render
    ap.add_argument("--envmap", default="", help="Optional HDRI envmap path (EXR recommended).")
    ap.add_argument("--out-mp4", default="", help="Optional MP4 output path.")
    ap.add_argument("--fps", type=int, default=15)

    # Optional auto-rigging chain
    ap.add_argument("--rig-backend", default="", choices=["", "rigify", "blenrig", "rigacar", "unirig", "riganything", "rignet"])
    ap.add_argument("--rig-out", default="", help="Output rigged GLB path (required if --rig-backend set).")
    ap.add_argument("--rig-args", default="", help="Extra args string forwarded to tools/rig_asset.py.")

    return ap.parse_args()


def main() -> int:
    repo_root = Path(__file__).resolve().parent
    tool = repo_root / "tools" / "trellis2_image_to_glb.py"
    if not tool.exists():
        print(f"Missing tool script: {tool}", file=sys.stderr)
        return 2

    args = _parse_args()
    env = str(args.conda_env or "trellis").strip()

    # Pick reasonable defaults if user omitted args.
    image = _abs(args.image)
    if not image:
        candidate = repo_root / "outputs" / "T.png"
        if candidate.exists():
            image = str(candidate.resolve())

    out_glb = _abs(args.out_glb)
    if not out_glb:
        out_glb = str((repo_root / "outputs" / "trellis_sample.glb").resolve())

    if not image:
        print("Missing --image (no default found).", file=sys.stderr)
        return 2

    if not Path(image).exists():
        print(f"Input image not found: {image}", file=sys.stderr)
        return 2

    if not shutil.which("conda"):
        print(
            "Could not find `conda` on PATH.\n"
            "Run this from a shell where conda is available, or call the underlying tool directly after activation:\n"
            f"  conda activate {env}\n"
            f"  python3 {tool} --image {image} --out-glb {out_glb}\n",
            file=sys.stderr,
        )
        return 2

    cmd: list[str] = [
        "conda",
        "run",
        "-n",
        env,
        "python3",
        str(tool),
        "--model",
        str(args.model),
        "--device",
        str(args.device),
        "--image",
        image,
        "--out-glb",
        out_glb,
        "--simplify",
        str(int(args.simplify)),
        "--aabb",
        str(args.aabb),
        "--decimation-target",
        str(int(args.decimation_target)),
        "--texture-size",
        str(int(args.texture_size)),
        "--remesh",
        str(int(args.remesh)),
        "--remesh-band",
        str(int(args.remesh_band)),
        "--remesh-project",
        str(int(args.remesh_project)),
        "--extension-webp",
        str(int(args.extension_webp)),
    ]

    envmap = _abs(args.envmap)
    out_mp4 = _abs(args.out_mp4)
    if out_mp4:
        cmd += ["--out-mp4", out_mp4]
        if envmap:
            cmd += ["--envmap", envmap]
        cmd += ["--fps", str(int(args.fps))]

    if str(args.rig_backend).strip():
        if not str(args.rig_out).strip():
            print("--rig-out is required when --rig-backend is set.", file=sys.stderr)
            return 2
        cmd += ["--rig-backend", str(args.rig_backend), "--rig-out", _abs(args.rig_out)]
        if str(args.rig_args).strip():
            cmd += ["--rig-args", str(args.rig_args)]

    print("Running:", " ".join(cmd))
    p = subprocess.run(cmd)
    return int(p.returncode or 0)


if __name__ == "__main__":
    raise SystemExit(main())

