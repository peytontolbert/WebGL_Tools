#!/usr/bin/env python3
"""
FLUX (text -> image) quick test script.

Example (in your ML env):
  conda activate trellis
  python3 tools/flux_text_to_image.py \
    --prompt "A cat holding a sign that says hello world" \
    --out outputs/flux-schnell.png \
    --seed 0 \
    --steps 4 \
    --cpu-offload 1
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def _eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="tools/flux_text_to_image.py")
    ap.add_argument("--model", default="black-forest-labs/FLUX.2-dev")
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--out", required=True, help="Output image path (png recommended).")

    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--steps", type=int, default=4)
    ap.add_argument("--guidance-scale", type=float, default=0.0)
    ap.add_argument("--max-sequence-length", type=int, default=256)

    ap.add_argument("--dtype", default="bf16", choices=["bf16", "fp16", "fp32"])
    ap.add_argument("--device", default="cuda", help='e.g. "cuda", "cuda:0", or "cpu" (only used when cpu-offload=0)')
    ap.add_argument("--cpu-offload", type=int, default=1, choices=[0, 1], help="Use diffusers CPU offload to save VRAM.")

    return ap.parse_args()


def main() -> int:
    args = _parse_args()
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        import torch  # type: ignore
        # Compatibility shim:
        # Some diffusers pipelines still import `FLAX_WEIGHTS_NAME` from transformers,
        # but Transformers 5 removed it. Define it at runtime so imports succeed
        # without changing installed package versions.
        try:
            import transformers.utils as _tutils  # type: ignore
            if not hasattr(_tutils, "FLAX_WEIGHTS_NAME"):
                setattr(_tutils, "FLAX_WEIGHTS_NAME", "flax_model.msgpack")
        except Exception:
            pass

        from diffusers import FluxPipeline  # type: ignore
    except Exception as e:
        _eprint(
            "Missing dependencies.\n"
            "You need torch + diffusers installed in the current environment.\n"
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

    pipe = FluxPipeline.from_pretrained(str(args.model), torch_dtype=torch_dtype)

    if int(args.cpu_offload) == 1:
        # Requires `accelerate`. If it isn't installed, diffusers will throw here.
        try:
            pipe.enable_model_cpu_offload()
        except Exception as e:
            _eprint(
                "CPU offload requested but failed. If you want offload, install accelerate:\n"
                "  pip install accelerate\n"
                f"\nOffload error: {e}"
            )
            return 2
        gen = torch.Generator("cpu").manual_seed(int(args.seed))
    else:
        device = str(args.device)
        pipe.to(device)
        gen_dev = "cuda" if device.startswith("cuda") else "cpu"
        gen = torch.Generator(gen_dev).manual_seed(int(args.seed))

    image = pipe(
        str(args.prompt),
        guidance_scale=float(args.guidance_scale),
        num_inference_steps=int(args.steps),
        max_sequence_length=int(args.max_sequence_length),
        generator=gen,
    ).images[0]

    image.save(str(out_path))
    print(f"Wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

