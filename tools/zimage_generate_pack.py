#!/usr/bin/env python3
"""
Batch-generate PNG assets using the existing Z-Image text→image script.

This reads a JSON pack (see: tools/zimage_asset_pack_webgl_game.json) and runs:
  tools/zimage_text_to_image.py --prompt ... --out ...

Examples:
  # Recommended if you have a conda env named "trellis"
  python3 tools/zimage_generate_pack.py --runner conda_trellis --out-dir assets/generated/zimage_pack

  # Generate only a subset
  python3 tools/zimage_generate_pack.py --ids tex_asphalt_01,ui_icon_compass_01
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def _eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


def _read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="tools/zimage_generate_pack.py")
    ap.add_argument(
        "--pack",
        default="tools/zimage_asset_pack_webgl_game.json",
        help="Path to a pack JSON file.",
    )
    ap.add_argument(
        "--out-dir",
        default="assets/generated/zimage_pack",
        help="Output directory for PNGs.",
    )
    ap.add_argument(
        "--runner",
        default="conda_trellis",
        choices=["conda_trellis", "python3"],
        help='How to invoke python (conda_trellis uses: conda run -n trellis python3).',
    )
    ap.add_argument("--device", default="", help='Override device (e.g. "cuda", "cuda:0", "cpu").')
    ap.add_argument("--dtype", default="", choices=["", "bf16", "fp16", "fp32"], help="Override dtype.")
    ap.add_argument("--model", default="", help="Override HF model id.")
    ap.add_argument("--steps", type=int, default=-1, help="Override num_inference_steps.")
    ap.add_argument("--guidance-scale", type=float, default=float("nan"), help="Override guidance scale.")
    ap.add_argument("--width", type=int, default=0, help="Override width.")
    ap.add_argument("--height", type=int, default=0, help="Override height.")
    ap.add_argument("--seed-base", type=int, default=-1, help="Override pack defaults.seedBase.")
    ap.add_argument("--skip-existing", action="store_true", help="Skip outputs that already exist.")
    ap.add_argument("--kinds", default="", help='Comma-separated kinds to include (e.g. "texture,ui_icon").')
    ap.add_argument("--ids", default="", help="Comma-separated asset ids to include (overrides --kinds).")
    return ap.parse_args()


def _runner_prefix(runner: str) -> list[str]:
    if runner == "python3":
        return ["python3"]
    # conda_trellis
    return ["conda", "run", "-n", "trellis", "python3"]


def _coerce_int(v, default: int) -> int:
    try:
        return int(v)
    except Exception:
        return default


def _main() -> int:
    args = _parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    pack_path = (repo_root / str(args.pack)).resolve() if not Path(args.pack).is_absolute() else Path(args.pack).resolve()
    out_dir = (repo_root / str(args.out_dir)).resolve() if not Path(args.out_dir).is_absolute() else Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    if not pack_path.exists():
        _eprint(f"Pack not found: {pack_path}")
        return 2

    pack = _read_json(pack_path)
    defaults = pack.get("defaults") if isinstance(pack, dict) else {}
    if not isinstance(defaults, dict):
        defaults = {}

    assets = pack.get("assets") if isinstance(pack, dict) else None
    if not isinstance(assets, list) or not assets:
        _eprint("Pack JSON missing: { assets: [...] }")
        return 2

    # Selection
    want_ids = {s.strip() for s in str(args.ids or "").split(",") if s.strip()}
    want_kinds = {s.strip() for s in str(args.kinds or "").split(",") if s.strip()}

    selected = []
    for a in assets:
        if not isinstance(a, dict):
            continue
        aid = str(a.get("id") or "").strip()
        if not aid:
            continue
        if want_ids and aid not in want_ids:
            continue
        if (not want_ids) and want_kinds:
            if str(a.get("kind") or "").strip() not in want_kinds:
                continue
        selected.append(a)

    if not selected:
        _eprint("No assets selected (check --ids/--kinds).")
        return 2

    script_abs = str((repo_root / "tools" / "zimage_text_to_image.py").resolve())
    prefix = _runner_prefix(str(args.runner))

    # Overrides + defaults
    model = str(args.model).strip() or str(defaults.get("model") or "Tongyi-MAI/Z-Image-Turbo")
    width = int(args.width) if int(args.width) > 0 else _coerce_int(defaults.get("width"), 1024)
    height = int(args.height) if int(args.height) > 0 else _coerce_int(defaults.get("height"), 1024)
    steps = int(args.steps) if int(args.steps) > 0 else _coerce_int(defaults.get("steps"), 9)
    guidance = float(args.guidance_scale) if args.guidance_scale == args.guidance_scale else float(defaults.get("guidanceScale") or 0.0)
    seed_base = int(args.seed_base) if int(args.seed_base) >= 0 else _coerce_int(defaults.get("seedBase"), 1337)
    dtype = str(args.dtype).strip() or str(defaults.get("dtype") or "").strip()
    device = str(args.device).strip() or str(defaults.get("device") or "").strip()

    ok = 0
    skipped = 0
    failed = 0

    for i, a in enumerate(selected):
        aid = str(a.get("id") or "").strip()
        label = str(a.get("label") or aid)
        out_name = str(a.get("outName") or aid).strip() or aid
        prompt = str(a.get("prompt") or "").strip()
        if not prompt:
            _eprint(f"Skipping {aid}: missing prompt")
            failed += 1
            continue

        seed_offset = _coerce_int(a.get("seedOffset"), 0)
        seed = seed_base + seed_offset
        out_png = out_dir / f"{out_name}.png"

        if args.skip_existing and out_png.exists():
            print(f"[{i+1}/{len(selected)}] (skip) {aid} → {out_png}")
            skipped += 1
            continue

        cmd = [
            *prefix,
            script_abs,
            "--prompt",
            prompt,
            "--out",
            str(out_png),
            "--model",
            model,
            "--seed",
            str(seed),
            "--width",
            str(width),
            "--height",
            str(height),
            "--steps",
            str(steps),
            "--guidance-scale",
            str(guidance),
        ]
        if dtype:
            cmd += ["--dtype", dtype]
        if device:
            cmd += ["--device", device]

        print(f"[{i+1}/{len(selected)}] {label} ({aid})")
        p = subprocess.run(cmd, cwd=str(repo_root))
        if p.returncode == 0:
            ok += 1
        else:
            failed += 1
            _eprint(f"FAILED ({p.returncode}): {aid}")

    print(f"\nDone. ok={ok} skipped={skipped} failed={failed} outDir={out_dir}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(_main())

