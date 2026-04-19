#!/usr/bin/env python3
"""
One-off test runner for Z-Image img2img editing.

Goal: take an existing generated image and try to edit it into a T-pose.

Usage:
  conda run -n trellis python3 tools/test_zimage_tpose.py \
    --image assets/generated/zimage/zimage_asset_2026-02-05T02-05-15-877.png \
    --out outputs/zimage_tpose.png
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="tools/test_zimage_tpose.py")
    ap.add_argument(
        "--image",
        default="assets/generated/zimage/zimage_asset_2026-02-05T02-05-15-877.png",
        help="Input image (relative to repo root or absolute).",
    )
    ap.add_argument("--out", default="outputs/zimage_tpose.png", help="Output image path.")
    ap.add_argument("--prompt", default="same woman in a T-pose, full body, front view, studio background", help="Edit prompt.")
    ap.add_argument("--negative-prompt", default="male, man, boy, different person, different face, beard, mustache", help="Negative prompt.")
    ap.add_argument("--strength", type=float, default=0.6, help="0..1 (higher = bigger change).")
    ap.add_argument("--steps", type=int, default=12)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--model", default="Tongyi-MAI/Z-Image-Turbo")
    return ap.parse_args()


def main() -> int:
    args = _parse_args()
    repo_root = Path(__file__).resolve().parents[1]

    in_path = Path(args.image)
    if not in_path.is_absolute():
        in_path = (repo_root / in_path).resolve()

    out_path = Path(args.out)
    if not out_path.is_absolute():
        out_path = (repo_root / out_path).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    prompt = str(args.prompt)
    negative = str(args.negative_prompt)

    cmd = [
        sys.executable,
        str(repo_root / "tools" / "zimage_img2img.py"),
        "--image",
        str(in_path),
        "--prompt",
        prompt,
        "--out",
        str(out_path),
        "--model",
        str(args.model),
        "--device",
        str(args.device),
        "--strength",
        str(args.strength),
        "--steps",
        str(args.steps),
        "--seed",
        str(args.seed),
        "--guidance-scale",
        "2.0",
        "--negative-prompt",
        negative,
    ]

    print("Running:", " ".join(cmd))
    p = subprocess.run(cmd, stdout=sys.stdout, stderr=sys.stderr)
    return int(p.returncode or 0)


if __name__ == "__main__":
    raise SystemExit(main())

