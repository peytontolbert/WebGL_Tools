#!/usr/bin/env python3
"""
Z-Image-Turbo image editing (img2img).

This is intentionally "optional" and lives under tools/ because it requires a
heavy external environment (GPU, PyTorch, diffusers).

Example:
  conda activate trellis
  python3 tools/zimage_img2img.py \
    --image assets/generated/zimage/foo.png \
    --prompt "make it more cyberpunk" \
    --out outputs/zimage_edit.png \
    --strength 0.65 \
    --steps 9
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def _eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="tools/zimage_img2img.py")
    ap.add_argument("--model", default="Tongyi-MAI/Z-Image", help="HF model id.")
    ap.add_argument("--image", required=True, help="Input image path.")
    ap.add_argument("--prompt", required=True, help="Edit prompt.")
    ap.add_argument("--negative-prompt", default="", help="Optional negative prompt.")
    ap.add_argument("--out", required=True, help="Output image path (png recommended).")

    ap.add_argument("--strength", type=float, default=0.65, help="0..1 (higher = bigger change).")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--steps", type=int, default=9, help="num_inference_steps (Turbo guidance should be 0).")
    ap.add_argument("--guidance-scale", type=float, default=0.0)

    ap.add_argument("--dtype", default="bf16", choices=["bf16", "fp16", "fp32"])
    ap.add_argument("--device", default="cuda", help='e.g. "cuda", "cuda:0", or "cpu"')
    ap.add_argument("--low-cpu-mem-usage", type=int, default=0, choices=[0, 1])

    # Optional toggles (best-effort; availability depends on your diffusers build)
    ap.add_argument("--attention-backend", default="", choices=["", "flash", "_flash_3"], help="Best-effort transformer attention backend.")
    ap.add_argument("--compile-transformer", type=int, default=0, choices=[0, 1], help="Best-effort compile() on transformer.")
    ap.add_argument("--cpu-offload", type=int, default=0, choices=[0, 1], help="Enable diffusers CPU offload (requires accelerate).")

    return ap.parse_args()


def main() -> int:
    args = _parse_args()
    in_path = Path(args.image).resolve()
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if not in_path.exists():
        _eprint(f"Input image not found: {in_path}")
        return 2

    try:
        import torch  # type: ignore

        # Compatibility shim: ignore `enable_gqa=` if diffusers passes it.
        try:
            import torch.nn.functional as F  # type: ignore

            sdp = getattr(F, "scaled_dot_product_attention", None)
            if callable(sdp):
                if getattr(sdp, "__name__", "") != "_sdp_compat":
                    _orig_sdp = sdp

                    def _sdp_compat(*a, **kw):  # type: ignore
                        kw.pop("enable_gqa", None)
                        return _orig_sdp(*a, **kw)

                    F.scaled_dot_product_attention = _sdp_compat  # type: ignore
        except Exception:
            pass

        from PIL import Image  # type: ignore

        # Prefer the dedicated Z-Image img2img pipeline if available.
        try:
            from diffusers import ZImageImg2ImgPipeline as Img2ImgPipe  # type: ignore
        except Exception:
            Img2ImgPipe = None  # type: ignore
    except Exception as e:
        _eprint(
            "Missing dependencies.\n"
            "You need torch + a diffusers build that includes Z-Image pipelines.\n"
            f"\nImport error: {e}"
        )
        return 2

    if Img2ImgPipe is None:
        _eprint(
            "Your diffusers build does not include `ZImageImg2ImgPipeline`.\n"
            "Install/upgrade diffusers in your trellis env, then re-run.\n"
            "Recommended:\n"
            "  pip install -U git+https://github.com/huggingface/diffusers\n"
        )
        return 2

    dtype_s = str(args.dtype).lower().strip()
    if dtype_s == "bf16":
        torch_dtype = torch.bfloat16
    elif dtype_s == "fp16":
        torch_dtype = torch.float16
    else:
        torch_dtype = torch.float32

    pipe = Img2ImgPipe.from_pretrained(
        str(args.model),
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

    strength = float(args.strength)
    if strength < 0.0 or strength > 1.0:
        _eprint(f"Invalid --strength: {strength} (expected 0..1)")
        return 2

    gen_dev = "cuda" if str(args.device).startswith("cuda") else "cpu"
    generator = torch.Generator(gen_dev).manual_seed(int(args.seed))

    image = Image.open(str(in_path)).convert("RGB")
    kwargs = dict(
        prompt=str(args.prompt),
        image=image,
        strength=strength,
        num_inference_steps=int(args.steps),
        guidance_scale=float(args.guidance_scale),
        generator=generator,
    )
    if str(args.negative_prompt).strip():
        kwargs["negative_prompt"] = str(args.negative_prompt)

    # Some pipeline versions may not accept negative_prompt; retry without it.
    try:
        out = pipe(**kwargs)
    except TypeError:
        kwargs.pop("negative_prompt", None)
        out = pipe(**kwargs)

    img = getattr(out, "images", None)
    if isinstance(img, list) and img:
        img0 = img[0]
        img0.save(str(out_path))
        print(f"Wrote {out_path}")
        return 0

    _eprint("Unexpected pipeline output (missing images)")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

