#!/usr/bin/env python3
"""
HunyuanImage-3 Instruct Distil image editing helper.

This script mirrors the official-ish usage pattern:
  - load with transformers AutoModelForCausalLM (trust_remote_code=True)
  - call `model.load_tokenizer(...)` (custom remote-code API)
  - call `model.generate_image(...)` for multi-image instruction editing

Why a local folder?
Some environments have trouble loading the HF repo id
`tencent/HunyuanImage-3.0-Instruct-Distil` directly (the dot in the repo name).
Use `--download` to snapshot it into a dot-free local directory and load from there.

Examples:

  # Use an already-downloaded local folder
  python3 tools/hunyuan3_image_edit.py \
    --model ./HunyuanImage-3-Instruct-Distil \
    --prompt "基于图一的logo，参考图二中冰箱贴的材质，制作一个新的冰箱贴" \
    --image ./assets/demo_instruct_imgs/input_1_0.png \
    --image ./assets/demo_instruct_imgs/input_1_1.png \
    --out outputs/hunyuan3_edit.png

  # Download from HF into ./.hf_models/... and run
  python3 tools/hunyuan3_image_edit.py \
    --model tencent/HunyuanImage-3.0-Instruct-Distil \
    --download \
    --prompt "Turn this into a glossy enamel fridge magnet." \
    --image ./assets/demo_instruct_imgs/input_1_0.png \
    --image ./assets/demo_instruct_imgs/input_1_1.png \
    --out outputs/hunyuan3_edit.png
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path


def _eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="tools/hunyuan3_image_edit.py")
    ap.add_argument(
        "--model",
        default="./HunyuanImage-3-Instruct-Distil",
        help=(
            "Local model directory or HF repo id. "
            "If passing HF repo id with dots (e.g. tencent/HunyuanImage-3.0-Instruct-Distil), "
            "use --download to snapshot to a dot-free local dir."
        ),
    )
    ap.add_argument(
        "--download",
        action="store_true",
        help="If --model looks like an HF repo id, snapshot_download it to a local dot-free folder.",
    )
    ap.add_argument(
        "--local-dir",
        default="",
        help=(
            "Where to place the downloaded snapshot when using --download. "
            "If omitted, defaults to <cache_dir>/<sanitized_repo_id> if --cache-dir is set, "
            "otherwise ./.hf_models/<sanitized_repo_id>."
        ),
    )
    ap.add_argument("--revision", default="", help="Optional HF revision (branch/tag/commit).")
    ap.add_argument("--hf-token", default=os.environ.get("HF_TOKEN", ""), help="Optional HF token.")
    ap.add_argument(
        "--cache-dir",
        default="",
        help=(
            "Optional HF cache dir. We set HF_HOME/HF_HUB_CACHE/TRANSFORMERS_CACHE to point here, "
            "and we also pass cache_dir into from_pretrained/snapshot_download when supported."
        ),
    )

    ap.add_argument("--prompt", required=True, help="Edit instruction.")
    ap.add_argument(
        "--image",
        action="append",
        default=[],
        help="Input image path(s). Pass multiple --image flags (order matters).",
    )
    ap.add_argument("--out", default="image_edit.png", help="Output image path.")

    # Model loading kwargs (match your snippet defaults)
    ap.add_argument("--attn-implementation", default="sdpa", help='e.g. "sdpa"')
    ap.add_argument("--torch-dtype", default="auto", help='e.g. "auto", "bf16", "fp16", "fp32"')
    ap.add_argument("--device-map", default="auto", help='e.g. "auto" or empty for default')
    ap.add_argument(
        "--moe-impl",
        default="eager",
        choices=["eager", "flashinfer"],
        help='MoE implementation. Use "flashinfer" if installed.',
    )
    ap.add_argument("--moe-drop-tokens", type=int, default=1, choices=[0, 1])

    # Generation args
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--image-size", default="auto")
    ap.add_argument("--use-system-prompt", default="en_unified")
    ap.add_argument("--bot-task", default="think_recaption")
    ap.add_argument("--infer-align-image-size", type=int, default=1, choices=[0, 1])
    ap.add_argument("--diff-infer-steps", type=int, default=8)
    ap.add_argument("--verbose", type=int, default=2)
    ap.add_argument("--print-cot", type=int, default=0, choices=[0, 1], help="Print cot_text to stdout.")
    return ap.parse_args()


def _is_probably_hf_repo_id(s: str) -> bool:
    # crude but effective: "org/name"
    raw = str(s).strip()
    return bool(raw) and "/" in raw and not Path(raw).expanduser().exists()


def _sanitize_repo_id(repo_id: str) -> str:
    # Make it a safe local folder name; importantly: remove dots to avoid the reported issue.
    s = repo_id.strip()
    s = s.replace("/", "__")
    s = s.replace(".", "_")
    s = re.sub(r"[^A-Za-z0-9_\-]+", "_", s)
    return s


def _maybe_set_cache_env(cache_dir: str) -> None:
    """
    Best-effort: ensure HF/Transformers cache actually goes to --cache-dir.
    Different libs look at different env var names.
    """
    raw = str(cache_dir or "").strip()
    if not raw:
        return
    p = Path(raw).expanduser().resolve()
    os.environ["HF_HOME"] = str(p)
    hub_cache = str(p / "hub")
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", hub_cache)
    os.environ.setdefault("HF_HUB_CACHE", hub_cache)
    os.environ.setdefault("TRANSFORMERS_CACHE", hub_cache)


def _maybe_snapshot_download(args: argparse.Namespace) -> str:
    model = str(args.model).strip()
    if not args.download:
        return model
    if not _is_probably_hf_repo_id(model):
        # already a local path (or odd string); just return.
        return model

    try:
        from huggingface_hub import snapshot_download  # type: ignore
    except Exception as e:
        _eprint(
            "You requested --download but huggingface_hub is not available.\n"
            "Install it (e.g. `pip install huggingface_hub`) and retry.\n"
            f"\nImport error: {e}"
        )
        raise SystemExit(2)

    # Decide where to put the snapshot (a normal folder with files, not a hashed cache).
    local_dir_raw = str(getattr(args, "local_dir", "") or "").strip()
    if local_dir_raw:
        out_dir = Path(local_dir_raw).expanduser()
    else:
        cache_dir = str(getattr(args, "cache_dir", "") or "").strip()
        if cache_dir:
            out_dir = Path(cache_dir).expanduser() / _sanitize_repo_id(model)
        else:
            out_dir = Path(".hf_models") / _sanitize_repo_id(model)
    out_dir.mkdir(parents=True, exist_ok=True)

    kwargs: dict[str, object] = {
        "repo_id": model,
        "local_dir": str(out_dir.resolve()),
        "local_dir_use_symlinks": False,
    }
    rev = str(getattr(args, "revision", "") or "").strip()
    if rev:
        kwargs["revision"] = rev
    token = str(getattr(args, "hf_token", "") or "").strip()
    if token:
        kwargs["token"] = token
    cache_dir = str(getattr(args, "cache_dir", "") or "").strip()
    if cache_dir:
        kwargs["cache_dir"] = cache_dir

    print(f"Downloading {model!r} to {str(out_dir)!r} ...")
    local_path = snapshot_download(**kwargs)  # type: ignore[arg-type]
    print(f"Download complete: {local_path}")
    return str(out_dir)

def _resolve_local_model_path_if_present(model_id: str) -> str | None:
    """
    If model_id looks like a filesystem path and exists, return an absolute path.
    If it looks like a filesystem path but DOES NOT exist, return None.
    Otherwise return None (meaning: treat as an HF repo id).
    """
    raw = str(model_id).strip()
    if not raw:
        return None

    # Heuristics: treat ".", "..", "~", absolute paths, or anything containing a path separator as "path-like".
    is_path_like = (
        raw.startswith(".")
        or raw.startswith("~")
        or raw.startswith(os.sep)
        or (os.altsep is not None and raw.startswith(os.altsep))
        or (os.sep in raw)
        or (os.altsep is not None and os.altsep in raw)
    )
    if not is_path_like:
        return None

    p = Path(raw).expanduser()
    if not p.exists():
        return None
    return str(p.resolve())


def main() -> int:
    args = _parse_args()

    cache_dir = str(getattr(args, "cache_dir", "") or "").strip()
    if cache_dir:
        _maybe_set_cache_env(cache_dir)

    if not args.image:
        _eprint("You must pass at least one --image path.")
        return 2

    imgs_input: list[str] = []
    for p in args.image:
        ip = Path(p).expanduser().resolve()
        if not ip.exists():
            _eprint(f"Input image not found: {ip}")
            return 2
        imgs_input.append(str(ip))

    out_path = Path(args.out).expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    model_id = _maybe_snapshot_download(args)
    local_abs = _resolve_local_model_path_if_present(model_id)
    if local_abs is not None:
        model_id = local_abs
    else:
        # If the user passed something path-like (e.g. "./foo") but it doesn't exist,
        # fail fast with a clearer error than the HF repo-id validator.
        raw_model = str(model_id).strip()
        if raw_model.startswith(".") or raw_model.startswith("~") or raw_model.startswith(os.sep):
            _eprint(
                "Model directory not found.\n"
                f"  --model {raw_model!r}\n\n"
                "If you intended to load from Hugging Face, pass the repo id and add --download, e.g.\n"
                "  --model tencent/HunyuanImage-3.0-Instruct-Distil --download\n"
            )
            return 2

    try:
        from transformers import AutoModelForCausalLM  # type: ignore
    except Exception as e:
        _eprint(
            "Missing dependency: transformers.\n"
            "Install it (e.g. `pip install transformers`) and retry.\n"
            f"\nImport error: {e}"
        )
        return 2

    kwargs = dict(
        attn_implementation=str(args.attn_implementation),
        trust_remote_code=True,
        torch_dtype=str(args.torch_dtype),
        device_map=str(args.device_map) if str(args.device_map).strip() else None,
        moe_impl=str(args.moe_impl),
        moe_drop_tokens=bool(int(args.moe_drop_tokens)),
    )
    # Remove None values that can upset older transformers versions.
    kwargs = {k: v for k, v in kwargs.items() if v is not None}

    # Best-effort pass-through of cache_dir if supported by your installed versions.
    if cache_dir:
        kwargs["cache_dir"] = cache_dir

    print("Loading model...", flush=True)
    model = AutoModelForCausalLM.from_pretrained(model_id, **kwargs)

    # Hunyuan custom API: model.load_tokenizer(model_id)
    if hasattr(model, "load_tokenizer"):
        model.load_tokenizer(model_id)  # type: ignore[attr-defined]
    else:
        # Fallback (may or may not work with the remote code implementation)
        try:
            from transformers import AutoTokenizer  # type: ignore

            tok = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
            setattr(model, "tokenizer", tok)
        except Exception as e:
            _eprint(
                "Model does not expose `load_tokenizer(...)`, and tokenizer fallback failed.\n"
                f"Error: {e}"
            )
            return 2

    if not hasattr(model, "generate_image"):
        _eprint(
            "Loaded model does not expose `generate_image(...)`. "
            "This usually means `trust_remote_code=True` did not load the correct implementation."
        )
        return 2

    print("Generating image...", flush=True)
    cot_text, samples = model.generate_image(  # type: ignore[attr-defined]
        prompt=str(args.prompt),
        image=imgs_input,
        seed=int(args.seed),
        image_size=str(args.image_size),
        use_system_prompt=str(args.use_system_prompt),
        bot_task=str(args.bot_task),
        infer_align_image_size=bool(int(args.infer_align_image_size)),
        diff_infer_steps=int(args.diff_infer_steps),
        verbose=int(args.verbose),
    )

    if int(args.print_cot) == 1:
        print(cot_text)

    if not samples:
        _eprint("No samples returned from generate_image().")
        return 2

    samples[0].save(str(out_path))
    print("Saved:", str(out_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

