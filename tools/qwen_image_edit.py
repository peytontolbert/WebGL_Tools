#!/usr/bin/env python3
"""
Qwen Image Edit (image -> image) quick test script.

This is an optional helper that requires a heavy GPU environment with:
  - torch
  - diffusers (new enough to include QwenImageEditPipeline)
  - PIL

Examples:

  # Basic (defaults to ./input.png)
  conda run -n trellis python3 tools/qwen_image_edit.py \
    --prompt "Change the rabbit's color to purple, with a flash light background."

  # Use an existing generated image
  conda run -n trellis python3 tools/qwen_image_edit.py \
    --image assets/generated/zimage/zimage_asset_2026-02-05T02-05-15-877.png \
    --prompt "same woman in a T-pose, full body, front view, studio background" \
    --out outputs/qwen_edit_tpose.png
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def _eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="tools/qwen_image_edit.py")
    ap.add_argument("--model", default="Qwen/Qwen-Image-Edit", help="HF model id.")
    ap.add_argument("--image", default="./input.png", help="Input image path.")
    ap.add_argument("--prompt", required=True, help="Edit instruction.")
    ap.add_argument("--negative-prompt", default=" ", help="Negative prompt (optional).")
    ap.add_argument("--out", default="output_image_edit.png", help="Output image path.")

    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--true-cfg-scale", type=float, default=4.0)
    ap.add_argument("--steps", type=int, default=50, help="num_inference_steps")

    ap.add_argument("--device", default="cuda")
    ap.add_argument("--dtype", default="bf16", choices=["bf16", "fp16", "fp32"])
    ap.add_argument(
        "--device-map",
        default="",
        help=(
            "Optional accelerate device_map for sharded loading (requires accelerate). "
            'Examples: "auto", "balanced", "balanced_low_0". '
            "If set, we will try passing device_map/max_memory to from_pretrained and "
            "avoid calling pipeline.to(--device)."
        ),
    )
    ap.add_argument(
        "--max-memory",
        default="",
        help=(
            "Optional per-device max_memory, used with --device-map if supported. "
            'Format: "cuda:0=20GiB,cuda:1=20GiB,cpu=64GiB".'
        ),
    )
    ap.add_argument(
        "--component-devices",
        default="",
        help=(
            "Optional manual component placement across devices to reduce peak VRAM. "
            'Format: "transformer=cuda:0,text_encoder=cuda:1,vae=cuda:1". '
            "This is coarser than --device-map (no intra-module sharding)."
        ),
    )
    ap.add_argument(
        "--hf-home",
        default=os.environ.get("HF_HOME", ""),
        help="Optional Hugging Face home dir (sets HF_HOME and caches under it).",
    )
    ap.add_argument(
        "--low-cpu-mem-usage",
        type=int,
        default=1,
        choices=[0, 1],
        help="Try to reduce CPU peak RAM during load (if supported).",
    )
    ap.add_argument(
        "--cpu-offload",
        type=int,
        default=0,
        choices=[0, 1],
        help="Enable diffusers model CPU offload (requires accelerate).",
    )
    ap.add_argument(
        "--sequential-cpu-offload",
        type=int,
        default=0,
        choices=[0, 1],
        help="Enable sequential CPU offload (more aggressive; requires accelerate).",
    )
    ap.add_argument(
        "--attention-slicing",
        type=int,
        default=1,
        choices=[0, 1],
        help="Enable attention slicing to reduce VRAM.",
    )
    ap.add_argument(
        "--vae-slicing",
        type=int,
        default=1,
        choices=[0, 1],
        help="Enable VAE slicing to reduce VRAM.",
    )
    ap.add_argument("--disable-progress", type=int, default=0, choices=[0, 1])
    return ap.parse_args()

def _maybe_set_hf_home(args: argparse.Namespace) -> None:
    hf_home = str(getattr(args, "hf_home", "")).strip()
    if not hf_home:
        return
    hf_home_p = Path(hf_home).expanduser().resolve()
    os.environ["HF_HOME"] = str(hf_home_p)
    hub_cache = str(hf_home_p / "hub")
    # Be explicit: different libs look at different env var names.
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", hub_cache)
    os.environ.setdefault("HF_HUB_CACHE", hub_cache)
    os.environ.setdefault("TRANSFORMERS_CACHE", hub_cache)
    os.environ.setdefault("DIFFUSERS_CACHE", hub_cache)


def _from_pretrained_compat(QwenImageEditPipeline, model_id: str, **kwargs):  # type: ignore[no-untyped-def]
    # Diffusers / huggingface_hub kwargs vary by version; try best-effort.
    try:
        return QwenImageEditPipeline.from_pretrained(model_id, **kwargs)
    except TypeError:
        # Retry without optional memory kwargs.
        stripped = dict(kwargs)
        stripped.pop("low_cpu_mem_usage", None)
        stripped.pop("device_map", None)
        stripped.pop("max_memory", None)
        return QwenImageEditPipeline.from_pretrained(model_id, **stripped)

def _patch_sdpa_enable_gqa() -> None:
    """
    Compatibility shim:
    Some diffusers attention backends pass `enable_gqa=` into
    `torch.nn.functional.scaled_dot_product_attention`, but older torch builds
    don't accept that kwarg. If present, ignore it.
    """
    try:
        import torch.nn.functional as F  # type: ignore

        sdp = getattr(F, "scaled_dot_product_attention", None)
        if callable(sdp):
            # Avoid double-wrapping if the script is imported multiple times.
            if getattr(sdp, "__name__", "") != "_sdp_compat":
                _orig_sdp = sdp

                def _sdp_compat(*a, **kw):  # type: ignore
                    kw.pop("enable_gqa", None)
                    return _orig_sdp(*a, **kw)

                F.scaled_dot_product_attention = _sdp_compat  # type: ignore
    except Exception:
        pass

def _parse_max_memory(s: str) -> dict[str, str] | None:
    raw = str(s or "").strip()
    if not raw:
        return None
    # Accelerate expects GPU keys as integers: {0: "20GiB", 1: "20GiB", ...}
    # plus optional "cpu"/"disk"/"mps".
    out: dict[object, str] = {}
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        if "=" not in part:
            raise ValueError(f"Invalid --max-memory entry (expected k=v): {part!r}")
        k, v = part.split("=", 1)
        k = k.strip()
        v = v.strip()
        if not k or not v:
            raise ValueError(f"Invalid --max-memory entry (empty k/v): {part!r}")
        # Accelerate expects GPU keys as integers: {0: "20GiB", 1: "20GiB", ...}
        # but users commonly provide CUDA device strings like "cuda:0".
        lk = k.lower()
        if lk.startswith("cuda:"):
            k = lk.split(":", 1)[1].strip()
        elif lk.startswith("gpu:"):
            k = lk.split(":", 1)[1].strip()

        lk2 = str(k).strip().lower()
        if lk2.isdigit():
            out[int(lk2)] = v
        else:
            out[lk2] = v
    return out or None  # type: ignore[return-value]

def _parse_component_devices(s: str) -> dict[str, str] | None:
    raw = str(s or "").strip()
    if not raw:
        return None
    out: dict[str, str] = {}
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        if "=" not in part:
            raise ValueError(f"Invalid --component-devices entry (expected k=v): {part!r}")
        k, v = part.split("=", 1)
        k = k.strip()
        v = v.strip()
        if not k or not v:
            raise ValueError(f"Invalid --component-devices entry (empty k/v): {part!r}")
        out[k] = v
    return out or None

def _maybe_move_components(pipeline, component_devices: dict[str, str]) -> None:  # type: ignore[no-untyped-def]
    # Best-effort: component names vary across pipelines; we only move known attrs.
    for comp, dev in component_devices.items():
        if not hasattr(pipeline, comp):
            _eprint(f"Warning: pipeline has no component {comp!r}; skipping move to {dev}.")
            continue
        obj = getattr(pipeline, comp)
        if obj is None:
            _eprint(f"Warning: pipeline component {comp!r} is None; skipping move to {dev}.")
            continue
        try:
            obj.to(str(dev))
        except Exception as e:
            _eprint(f"Warning: failed moving {comp!r} to {dev}: {e}")


def main() -> int:
    args = _parse_args()
    _maybe_set_hf_home(args)
    in_path = Path(args.image).expanduser().resolve()
    out_path = Path(args.out).expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if not in_path.exists():
        _eprint(f"Input image not found: {in_path}")
        return 2

    try:
        from PIL import Image  # type: ignore
        import torch  # type: ignore
        _patch_sdpa_enable_gqa()
        from diffusers import QwenImageEditPipeline  # type: ignore
    except Exception as e:
        _eprint(
            "Missing dependencies for Qwen image edit.\n"
            "You need a diffusers build that includes `QwenImageEditPipeline`.\n"
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

    device_map = str(getattr(args, "device_map", "") or "").strip() or None
    try:
        max_memory = _parse_max_memory(str(getattr(args, "max_memory", "") or ""))
    except Exception as e:
        _eprint(f"Invalid --max-memory: {e}")
        return 2
    try:
        component_devices = _parse_component_devices(str(getattr(args, "component_devices", "") or ""))
    except Exception as e:
        _eprint(f"Invalid --component-devices: {e}")
        return 2

    pipeline = _from_pretrained_compat(
        QwenImageEditPipeline,
        str(args.model),
        torch_dtype=torch_dtype,
        low_cpu_mem_usage=bool(int(args.low_cpu_mem_usage)),
        device_map=device_map,
        max_memory=max_memory,
    )
    print("pipeline loaded")

    if int(args.attention_slicing) == 1:
        try:
            pipeline.enable_attention_slicing()
        except Exception:
            pass
    if int(args.vae_slicing) == 1:
        try:
            pipeline.enable_vae_slicing()
        except Exception:
            pass

    if int(args.sequential_cpu_offload) == 1:
        try:
            pipeline.enable_sequential_cpu_offload()
        except Exception as e:
            _eprint(f"Failed to enable sequential CPU offload: {e}")
            return 2
    elif int(args.cpu_offload) == 1:
        try:
            pipeline.enable_model_cpu_offload()
        except Exception as e:
            _eprint(f"Failed to enable model CPU offload: {e}")
            return 2
    else:
        # If we're sharding or manually placing components, do NOT move the entire
        # pipeline to a single device.
        if device_map is None and not component_devices:
            pipeline.to(str(args.device))
        elif component_devices:
            _maybe_move_components(pipeline, component_devices)

    if int(args.disable_progress) == 1:
        pipeline.set_progress_bar_config(disable=True)
    else:
        pipeline.set_progress_bar_config(disable=None)

    image = Image.open(str(in_path)).convert("RGB")
    # Generator can safely live on CPU; avoids mismatches when sharding across GPUs.
    generator = torch.Generator("cpu").manual_seed(int(args.seed))

    inputs = {
        "image": image,
        "prompt": str(args.prompt),
        "generator": generator,
        "true_cfg_scale": float(args.true_cfg_scale),
        "negative_prompt": str(args.negative_prompt),
        "num_inference_steps": int(args.steps),
    }

    with torch.inference_mode():
        output = pipeline(**inputs)
        output_image = output.images[0]
        output_image.save(str(out_path))
        print("image saved at", os.path.abspath(str(out_path)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

