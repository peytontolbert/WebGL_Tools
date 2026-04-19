#!/usr/bin/env python3
"""
Convenience wrapper to test BiRefNet background removal on:
  outputs/zimage_turbo.png

This uses TRELLIS.2's `trellis2.pipelines.rembg.BiRefNet` wrapper (remote code).

Example:
  conda activate trellis
  python3 tools/remove_bg_zimage_turbo.py --device cuda
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def _eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


def _parse_args(repo_root: Path) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="tools/remove_bg_zimage_turbo.py")
    ap.add_argument(
        "--in",
        dest="in_path",
        default=str((repo_root / "outputs" / "zimage_turbo.png").resolve()),
        help="Input image path.",
    )
    ap.add_argument(
        "--out",
        dest="out_path",
        default=str((repo_root / "outputs" / "zimage_turbo_cutout.png").resolve()),
        help="Output PNG path (RGBA).",
    )
    ap.add_argument("--device", default="cuda", help="cuda | cuda:0 | cpu")
    ap.add_argument("--model", default="ZhengPeng7/BiRefNet", help="HF model id for BiRefNet remote code.")
    return ap.parse_args()


def main() -> int:
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

    repo_root = Path(__file__).resolve().parents[1]
    args = _parse_args(repo_root)

    in_path = Path(args.in_path).expanduser().resolve()
    out_path = Path(args.out_path).expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if not in_path.exists():
        _eprint(f"Input image not found: {in_path}")
        return 2

    # Make trellis2 importable from local checkout if present.
    trellis_src = repo_root / "repos" / "TRELLIS.2"
    if trellis_src.exists() and (trellis_src / "trellis2").exists():
        sys.path.insert(0, str(trellis_src))

    try:
        from PIL import Image  # type: ignore
        from trellis2.pipelines import rembg as trellis_rembg  # type: ignore
    except Exception as e:
        _eprint(f"Missing dependencies for background removal: {e}")
        return 2

    img = Image.open(str(in_path))
    # Ensure we have RGB input; BiRefNet will add alpha.
    if img.mode != "RGB":
        img = img.convert("RGB")

    model = trellis_rembg.BiRefNet(model_name=str(args.model))
    device = str(args.device)
    try:
        if device.startswith("cuda"):
            model.cuda()
        else:
            model.cpu()
    except Exception:
        pass

    out = model(img)
    out.save(str(out_path))
    print(f"Wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

