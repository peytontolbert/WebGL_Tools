#!/usr/bin/env python3
"""
Z-Image-Turbo (text -> image) script pinned to:
  https://huggingface.co/Tongyi-MAI/Z-Image-Turbo

Notes:
- Turbo models expect guidance_scale=0.0
- The official quickstart often uses num_inference_steps=9 (8 DiT forwards)

Example:
  conda activate trellis
  python3 tools/zimage_turbo_text_to_image.py \
    --prompt "Young Chinese woman in red Hanfu..." \
    --out outputs/zimage_turbo.png \
    --height 1024 --width 1024 \
    --steps 9 \
    --seed 42
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

MODEL_ID = "Tongyi-MAI/Z-Image-Turbo"


def _eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="tools/zimage_turbo_text_to_image.py")
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--out", required=True, help="Output image path (png recommended).")

    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--height", type=int, default=1024)
    ap.add_argument("--width", type=int, default=1024)
    ap.add_argument(
        "--steps",
        type=int,
        default=9,
        help="num_inference_steps (Turbo expects guidance_scale=0).",
    )
    ap.add_argument("--guidance-scale", type=float, default=0.0)

    ap.add_argument("--dtype", default="bf16", choices=["bf16", "fp16", "fp32"])
    ap.add_argument("--device", default="cuda", help='e.g. "cuda", "cuda:0", or "cpu"')
    ap.add_argument("--low-cpu-mem-usage", type=int, default=0, choices=[0, 1])

    # Optional toggles (best-effort; availability depends on your diffusers build)
    ap.add_argument(
        "--attention-backend",
        default="",
        choices=["", "flash", "_flash_3"],
        help="Best-effort transformer attention backend.",
    )
    ap.add_argument(
        "--compile-transformer",
        type=int,
        default=0,
        choices=[0, 1],
        help="Best-effort compile() on transformer.",
    )
    ap.add_argument(
        "--cpu-offload",
        type=int,
        default=0,
        choices=[0, 1],
        help="Enable diffusers CPU offload (requires accelerate).",
    )

    return ap.parse_args()


def main() -> int:
    args = _parse_args()
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if float(args.guidance_scale) != 0.0:
        _eprint(
            "Warning: Z-Image-Turbo is distilled for guidance_scale=0.0. "
            "Non-zero guidance may reduce quality or behave unexpectedly."
        )

    try:
        import torch  # type: ignore

        # Compatibility shim:
        # Some diffusers attention backends pass `enable_gqa=` into
        # `torch.nn.functional.scaled_dot_product_attention`, but older torch
        # builds don't accept that kwarg. If present, ignore it.
        try:
            import torch.nn.functional as F  # type: ignore

            sdp = getattr(F, "scaled_dot_product_attention", None)
            if callable(sdp):
                # Avoid double-wrapping if the script is imported multiple times.
                if getattr(sdp, "__name__", "") != "_sdp_compat":
                    _orig_sdp = sdp

                    def _sdp_compat(*a, **kw):  # type: ignore
                        # Newer diffusers may pass `enable_gqa` (torch>=2.5).
                        kw.pop("enable_gqa", None)
                        return _orig_sdp(*a, **kw)

                    F.scaled_dot_product_attention = _sdp_compat  # type: ignore
        except Exception:
            pass

        from diffusers import ZImagePipeline  # type: ignore
    except Exception as e:
        _eprint(
            "Missing dependencies.\n"
            "You need torch + a diffusers build that includes `ZImagePipeline`.\n"
            "Install tip (from the model card):\n"
            "  pip install git+https://github.com/huggingface/diffusers\n"
            f"\nImport error: {e}"
        )
        return 2

    dtype_s = str(args.dtype).lower().strip()
    if dtype_s == "bf16":
        torch_dtype = torch.bfloat16
    elif dtype_s == "fp16":
        torch_dtype = torch.float16
    else:
        torch_dtype = torch.float32

    pipe = ZImagePipeline.from_pretrained(
        MODEL_ID,
        torch_dtype=torch_dtype,
        low_cpu_mem_usage=bool(int(args.low_cpu_mem_usage)),
    )

    if int(args.cpu_offload) == 1:
        try:
            pipe.enable_model_cpu_offload()
        except Exception as e:
            _eprint(
                "CPU offload requested but failed. If you want offload, install accelerate:\n"
                "  pip install accelerate\n"
                f"\nOffload error: {e}"
            )
            return 2
    else:
        pipe.to(str(args.device))

    if str(args.attention_backend).strip():
        try:
            # ZImagePipeline exposes `transformer` in the docs, but keep this best-effort.
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

    gen_dev = "cuda" if str(args.device).startswith("cuda") else "cpu"
    generator = torch.Generator(gen_dev).manual_seed(int(args.seed))

    image = pipe(
        prompt=str(args.prompt),
        height=int(args.height),
        width=int(args.width),
        num_inference_steps=int(args.steps),
        guidance_scale=float(args.guidance_scale),
        generator=generator,
    ).images[0]

    image.save(str(out_path))
    print(f"Wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

