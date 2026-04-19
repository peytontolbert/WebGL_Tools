#!/usr/bin/env python3
"""
Background removal using TRELLIS.2's BiRefNet wrapper.

This outputs an RGBA PNG (alpha mask applied).

Usage (trellis env):
  conda activate trellis
  python3 tools/remove_bg_birefnet.py --in assets/in.png --out assets/out.png --device cuda
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def _eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="tools/remove_bg_birefnet.py")
    ap.add_argument("--in", dest="in_path", required=True, help="Input image path.")
    ap.add_argument("--out", dest="out_path", required=True, help="Output PNG path (RGBA).")
    ap.add_argument("--device", default="cuda", help="cuda | cuda:0 | cpu")
    ap.add_argument("--model", default="ZhengPeng7/BiRefNet", help="HF model id for BiRefNet remote code.")
    return ap.parse_args()


def main() -> int:
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

    args = _parse_args()
    in_path = Path(args.in_path).resolve()
    out_path = Path(args.out_path).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if not in_path.exists():
        _eprint(f"Input image not found: {in_path}")
        return 2

    # Make trellis2 importable from local checkout if present.
    repo_root = Path(__file__).resolve().parents[1]
    trellis_src = repo_root / "repos" / "TRELLIS.2"
    if trellis_src.exists() and (trellis_src / "trellis2").exists():
        sys.path.insert(0, str(trellis_src))

    try:
        from PIL import Image  # type: ignore
        import torch  # type: ignore
        from trellis2.pipelines import rembg as trellis_rembg  # type: ignore
    except Exception as e:
        _eprint(f"Missing dependencies for background removal: {e}")
        return 2

    device = str(args.device)
    img = Image.open(str(in_path))
    # Ensure we have RGB input; BiRefNet will add alpha.
    if img.mode != "RGB":
        img = img.convert("RGB")

    # BiRefNet wrapper applies alpha in __call__.
    model = trellis_rembg.BiRefNet(model_name=str(args.model))
    try:
        if device.startswith("cuda"):
            model.cuda()
        else:
            model.cpu()
    except Exception:
        # Best-effort; wrapper already picks device in __call__.
        pass

    out = model(img)
    out.save(str(out_path))
    print(f"Wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

