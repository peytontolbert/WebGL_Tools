#!/usr/bin/env python3
"""
Wan2.2-Animate-14B helper runner.

This script is a thin, reproducible wrapper around the official Wan-Animate
CLI flow you pasted:
  - download model weights (HF or ModelScope)
  - preprocess a (video, character image) pair into process_results/
  - run generate.py in either animation or replacement mode

Important:
  - This repo does NOT vendor the Wan-Animate inference repo (with `generate.py`
    and `wan/modules/...`). You must clone it separately and pass --wan-repo.
  - The 14B model is large; expect significant VRAM/RAM requirements.

Examples
--------
Download weights to ./Wan2.2-Animate-14B (Hugging Face):
  python3 tools/wan22_animate.py download --backend hf --out ./Wan2.2-Animate-14B

Preprocess + generate (animation mode, single GPU):
  python3 tools/wan22_animate.py run \
    --wan-repo /abs/path/to/Wan2.2-Animate \
    --mode animate \
    --video ./examples/wan_animate/animate/video.mp4 \
    --refer ./examples/wan_animate/animate/image.jpeg \
    --process-out ./examples/wan_animate/animate/process_results \
    --ckpt-dir ./Wan2.2-Animate-14B \
    --retarget --use-flux

Preprocess + generate (replacement mode, single GPU):
  python3 tools/wan22_animate.py run \
    --wan-repo /abs/path/to/Wan2.2-Animate \
    --mode replace \
    --video ./examples/wan_animate/replace/video.mp4 \
    --refer ./examples/wan_animate/replace/image.jpeg \
    --process-out ./examples/wan_animate/replace/process_results \
    --ckpt-dir ./Wan2.2-Animate-14B \
    --replace-iterations 3 --replace-k 7 --replace-w-len 1 --replace-h-len 1 \
    --use-relighting-lora

Multi-GPU (torchrun) example:
  python3 tools/wan22_animate.py generate \
    --wan-repo /abs/path/to/Wan2.2-Animate \
    --ckpt-dir ./Wan2.2-Animate-14B \
    --src-root ./examples/wan_animate/animate/process_results \
    --distributed --nproc-per-node 8 --ulysses-size 8 --dit-fsdp --t5-fsdp
"""

from __future__ import annotations

import argparse
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODELS_DIR = REPO_ROOT / "Wan2.2-Animate-14B"
DATA_CHECKPOINTS_DIR = Path("/data/checkpoints")
DEFAULT_SHARED_MODELS_DIR = DATA_CHECKPOINTS_DIR / "Wan2.2-Animate-14B"
DEFAULT_HF_CACHE_DIR = DATA_CHECKPOINTS_DIR / "huggingface"


class CmdError(RuntimeError):
    pass


def _run(cmd: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
    p = subprocess.run(cmd, cwd=str(cwd) if cwd else None, env=env, stdout=sys.stdout, stderr=sys.stderr)
    if p.returncode != 0:
        raise CmdError(f"Command failed ({p.returncode}): {shlex.join(cmd)}")


def _which_or_hint(exe: str, hint: str) -> str:
    p = shutil.which(exe)
    if p:
        return p
    raise CmdError(f"Missing executable `{exe}`. {hint}")


def _ensure_exists(path: Path, what: str) -> None:
    if not path.exists():
        raise CmdError(f"Missing {what}: {path}")


def _auto_detect_wan_repo() -> Path | None:
    """
    Best-effort: look for a sibling clone under ./repos/* that contains both:
      - generate.py
      - wan/modules/animate/preprocess/preprocess_data.py
    """
    # Check repo root itself (if user happens to be in the Wan repo).
    root_pp = REPO_ROOT / "wan" / "modules" / "animate" / "preprocess" / "preprocess_data.py"
    if (REPO_ROOT / "generate.py").exists() and root_pp.exists():
        return REPO_ROOT

    repos_dir = REPO_ROOT / "repos"
    if not repos_dir.exists():
        return None

    try:
        for child in repos_dir.iterdir():
            if not child.is_dir():
                continue
            if (child / "generate.py").exists() and (child / "wan" / "modules" / "animate" / "preprocess" / "preprocess_data.py").exists():
                return child
    except Exception:
        return None

    return None


def _resolve_wan_repo(args: argparse.Namespace) -> Path:
    wan_repo_raw = str(getattr(args, "wan_repo", "") or "").strip()
    if not wan_repo_raw:
        detected = _auto_detect_wan_repo()
        if detected is not None:
            return detected
        raise CmdError(
            "Missing --wan-repo.\n"
            "Clone the Wan-Animate inference repo (the one that contains `generate.py` and `wan/modules/...`) "
            "and pass its path, e.g.:\n"
            "  python3 tools/wan22_animate.py ... --wan-repo /abs/path/to/Wan2.2-Animate\n"
        )

    p = Path(wan_repo_raw).expanduser().resolve()
    _ensure_exists(p, "Wan repo directory")
    _ensure_exists(p / "generate.py", "Wan repo generate.py")
    _ensure_exists(p / "wan" / "modules" / "animate" / "preprocess" / "preprocess_data.py", "Wan preprocess_data.py")
    return p


def _resolve_ckpt_dir(args: argparse.Namespace) -> Path:
    """
    Resolve the Wan weights directory.

    Wan preprocess expects `<ckpt-dir>/process_checkpoint/` to exist.

    We support a couple convenience cases:
      - `--ckpt-dir /data/checkpoints` (we'll look for a child dir that contains process_checkpoint/)
      - `--ckpt-dir` omitted (auto-detect repo-local and /data/checkpoints locations)
    """

    def looks_like_wan_ckpt_dir(p: Path) -> bool:
        return (p / "process_checkpoint").exists()

    def try_resolve(p: Path) -> Path | None:
        if not p.exists():
            return None
        if looks_like_wan_ckpt_dir(p):
            return p

        # Common "root" layouts.
        common_child = p / "Wan2.2-Animate-14B"
        if looks_like_wan_ckpt_dir(common_child):
            return common_child

        # Shallow scan: first matching child directory with process_checkpoint/.
        try:
            for child in p.iterdir():
                if child.is_dir() and looks_like_wan_ckpt_dir(child):
                    return child
        except Exception:
            pass
        return None

    raw = str(getattr(args, "ckpt_dir", "") or "").strip()
    candidates: list[Path] = []

    if raw:
        raw_path = Path(raw).expanduser()
        # Interpret relative paths both from CWD and from the repo root.
        candidates.append(raw_path.resolve())
        if not raw_path.is_absolute():
            candidates.append((REPO_ROOT / raw_path).resolve())
    else:
        candidates.append(DEFAULT_MODELS_DIR)

    # Fallback to shared checkpoints root if present.
    if DATA_CHECKPOINTS_DIR.exists():
        candidates.append(DATA_CHECKPOINTS_DIR / "Wan2.2-Animate-14B")
        candidates.append(DATA_CHECKPOINTS_DIR)

    # Always try repo-local default last.
    candidates.append(DEFAULT_MODELS_DIR)

    tried: list[Path] = []
    for c in candidates:
        if c in tried:
            continue
        tried.append(c)
        resolved = try_resolve(c)
        if resolved is not None:
            return resolved

    hint_lines = "\n".join(f"  - {p}" for p in tried[:12])
    more = "" if len(tried) <= 12 else f"\n  - ... ({len(tried) - 12} more)"
    raise CmdError(
        "Missing checkpoint directory (--ckpt-dir).\n"
        "Expected a directory that contains `process_checkpoint/`.\n\n"
        f"Tried:\n{hint_lines}{more}\n\n"
        "If your models live under /data/checkpoints, download them like:\n"
        "  python3 tools/wan22_animate.py download --backend hf --out /data/checkpoints/Wan2.2-Animate-14B\n"
        "Then re-run with either:\n"
        "  --ckpt-dir /data/checkpoints/Wan2.2-Animate-14B\n"
        "or:\n"
        "  --ckpt-dir /data/checkpoints\n"
    )


def _preprocess(
    *,
    wan_repo: Path,
    python_exe: str,
    mode: str,
    ckpt_dir: Path,
    video_path: Path,
    refer_path: Path,
    save_path: Path,
    resolution_area: tuple[int, int],
    # animation flags
    retarget: bool,
    use_flux: bool,
    # replacement flags
    replace_iterations: int,
    replace_k: int,
    replace_w_len: int,
    replace_h_len: int,
) -> None:
    _ensure_exists(video_path, "input video")
    _ensure_exists(refer_path, "reference image")
    save_path.mkdir(parents=True, exist_ok=True)

    process_ckpt = ckpt_dir / "process_checkpoint"
    _ensure_exists(process_ckpt, "process checkpoint dir (expected at <ckpt-dir>/process_checkpoint)")

    preprocess_py = wan_repo / "wan" / "modules" / "animate" / "preprocess" / "preprocess_data.py"
    _ensure_exists(preprocess_py, "preprocess script")

    w, h = resolution_area
    cmd = [
        python_exe,
        str(preprocess_py),
        "--ckpt_path",
        str(process_ckpt),
        "--video_path",
        str(video_path),
        "--refer_path",
        str(refer_path),
        "--save_path",
        str(save_path),
        "--resolution_area",
        str(int(w)),
        str(int(h)),
    ]

    mode = str(mode).strip().lower()
    if mode == "animate":
        if retarget:
            cmd.append("--retarget_flag")
        if use_flux:
            cmd.append("--use_flux")
    elif mode == "replace":
        cmd += [
            "--iterations",
            str(int(replace_iterations)),
            "--k",
            str(int(replace_k)),
            "--w_len",
            str(int(replace_w_len)),
            "--h_len",
            str(int(replace_h_len)),
            "--replace_flag",
        ]
    else:
        raise CmdError(f"Unknown --mode {mode!r}. Expected: animate|replace")

    _run(cmd, cwd=wan_repo)


def _generate(
    *,
    wan_repo: Path,
    python_exe: str,
    ckpt_dir: Path,
    src_root_path: Path,
    refert_num: int,
    replace_flag: bool,
    use_relighting_lora: bool,
    distributed: bool,
    nnodes: int,
    nproc_per_node: int,
    dit_fsdp: bool,
    t5_fsdp: bool,
    ulysses_size: int,
) -> None:
    _ensure_exists(wan_repo / "generate.py", "Wan repo generate.py")
    _ensure_exists(src_root_path, "preprocess output (--src-root)")

    base = [
        str(wan_repo / "generate.py"),
        "--task",
        "animate-14B",
        "--ckpt_dir",
        str(ckpt_dir),
        "--src_root_path",
        str(src_root_path),
        "--refert_num",
        str(int(refert_num)),
    ]
    if replace_flag:
        base.append("--replace_flag")
    if use_relighting_lora:
        base.append("--use_relighting_lora")
    if dit_fsdp:
        base.append("--dit_fsdp")
    if t5_fsdp:
        base.append("--t5_fsdp")
    if int(ulysses_size) > 0:
        base += ["--ulysses_size", str(int(ulysses_size))]

    if distributed:
        # Use torch.distributed.run (torchrun) exactly like the official example.
        cmd = [
            python_exe,
            "-m",
            "torch.distributed.run",
            "--nnodes",
            str(int(nnodes)),
            "--nproc_per_node",
            str(int(nproc_per_node)),
        ] + base
    else:
        cmd = [python_exe] + base

    _run(cmd, cwd=wan_repo)


def _cmd_download(args: argparse.Namespace) -> None:
    backend = str(args.backend).strip().lower()
    repo_id = str(args.repo_id).strip()
    out_dir = Path(args.out).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    if backend == "hf":
        hf = _which_or_hint(
            "huggingface-cli",
            'Install it with: pip install "huggingface_hub[cli]"',
        )
        cache_dir_raw = str(getattr(args, "cache_dir", "") or "").strip()
        cmd = [hf, "download", repo_id, "--local-dir", str(out_dir)]
        if cache_dir_raw:
            cache_dir = Path(cache_dir_raw).expanduser().resolve()
            cache_dir.mkdir(parents=True, exist_ok=True)
            cmd += ["--cache-dir", str(cache_dir)]
        _run(cmd)
        return

    if backend == "modelscope":
        ms = _which_or_hint(
            "modelscope",
            "Install it with: pip install modelscope",
        )
        cmd = [ms, "download", repo_id, "--local_dir", str(out_dir)]
        _run(cmd)
        return

    raise CmdError(f"Unknown --backend {backend!r}. Expected: hf|modelscope")


def _cmd_preprocess(args: argparse.Namespace) -> None:
    wan_repo = _resolve_wan_repo(args)
    ckpt_dir = _resolve_ckpt_dir(args)
    py = str(args.python).strip() or sys.executable

    video = Path(args.video).expanduser().resolve()
    refer = Path(args.refer).expanduser().resolve()
    out_dir = Path(args.process_out).expanduser().resolve()

    _preprocess(
        wan_repo=wan_repo,
        python_exe=py,
        mode=str(args.mode),
        ckpt_dir=ckpt_dir,
        video_path=video,
        refer_path=refer,
        save_path=out_dir,
        resolution_area=(int(args.res_w), int(args.res_h)),
        retarget=bool(args.retarget),
        use_flux=bool(args.use_flux),
        replace_iterations=int(args.replace_iterations),
        replace_k=int(args.replace_k),
        replace_w_len=int(args.replace_w_len),
        replace_h_len=int(args.replace_h_len),
    )


def _cmd_generate(args: argparse.Namespace) -> None:
    wan_repo = _resolve_wan_repo(args)
    ckpt_dir = _resolve_ckpt_dir(args)
    py = str(args.python).strip() or sys.executable

    src_root = Path(args.src_root).expanduser().resolve()

    replace_flag = str(args.mode).strip().lower() == "replace"
    _generate(
        wan_repo=wan_repo,
        python_exe=py,
        ckpt_dir=ckpt_dir,
        src_root_path=src_root,
        refert_num=int(args.refert_num),
        replace_flag=replace_flag,
        use_relighting_lora=bool(args.use_relighting_lora),
        distributed=bool(args.distributed),
        nnodes=int(args.nnodes),
        nproc_per_node=int(args.nproc_per_node),
        dit_fsdp=bool(args.dit_fsdp),
        t5_fsdp=bool(args.t5_fsdp),
        ulysses_size=int(args.ulysses_size),
    )


def _cmd_run(args: argparse.Namespace) -> None:
    wan_repo = _resolve_wan_repo(args)
    ckpt_dir = _resolve_ckpt_dir(args)
    py = str(args.python).strip() or sys.executable

    mode = str(args.mode).strip().lower()
    video = Path(args.video).expanduser().resolve()
    refer = Path(args.refer).expanduser().resolve()
    process_out = Path(args.process_out).expanduser().resolve()

    if not bool(args.skip_preprocess):
        _preprocess(
            wan_repo=wan_repo,
            python_exe=py,
            mode=mode,
            ckpt_dir=ckpt_dir,
            video_path=video,
            refer_path=refer,
            save_path=process_out,
            resolution_area=(int(args.res_w), int(args.res_h)),
            retarget=bool(args.retarget),
            use_flux=bool(args.use_flux),
            replace_iterations=int(args.replace_iterations),
            replace_k=int(args.replace_k),
            replace_w_len=int(args.replace_w_len),
            replace_h_len=int(args.replace_h_len),
        )

    if not bool(args.skip_generate):
        _generate(
            wan_repo=wan_repo,
            python_exe=py,
            ckpt_dir=ckpt_dir,
            src_root_path=process_out,
            refert_num=int(args.refert_num),
            replace_flag=(mode == "replace"),
            use_relighting_lora=bool(args.use_relighting_lora),
            distributed=bool(args.distributed),
            nnodes=int(args.nnodes),
            nproc_per_node=int(args.nproc_per_node),
            dit_fsdp=bool(args.dit_fsdp),
            t5_fsdp=bool(args.t5_fsdp),
            ulysses_size=int(args.ulysses_size),
        )


def _build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="tools/wan22_animate.py")
    sub = ap.add_subparsers(dest="cmd", required=True)

    # download
    p = sub.add_parser("download", help="Download Wan2.2-Animate-14B weights (HF or ModelScope).")
    p.add_argument("--backend", required=True, choices=["hf", "modelscope"])
    p.add_argument("--repo-id", default="Wan-AI/Wan2.2-Animate-14B")
    p.add_argument(
        "--out",
        default=str(DEFAULT_SHARED_MODELS_DIR if DATA_CHECKPOINTS_DIR.exists() else DEFAULT_MODELS_DIR),
        help="Output directory for model weights (should contain process_checkpoint/ after download).",
    )
    p.add_argument(
        "--cache-dir",
        dest="cache_dir",
        default=str(DEFAULT_HF_CACHE_DIR) if DATA_CHECKPOINTS_DIR.exists() else "",
        help="(HF backend) Hugging Face cache directory. Defaults to /data/checkpoints/huggingface when available.",
    )
    p.set_defaults(func=_cmd_download)

    def add_common(p2: argparse.ArgumentParser) -> None:
        p2.add_argument(
            "--wan-repo",
            default="",
            help=(
                "Path to the Wan-Animate inference repo (must contain generate.py and wan/modules/...). "
                "If omitted, we try auto-detect under ./repos/*."
            ),
        )
        p2.add_argument("--python", default="", help="Python interpreter to run Wan scripts (defaults to this interpreter).")
        p2.add_argument(
            "--ckpt-dir",
            default="",
            help=(
                "Local directory for Wan2.2-Animate-14B weights. "
                "Should contain `process_checkpoint/`. "
                "If omitted, we try auto-detect (repo-local and /data/checkpoints)."
            ),
        )
        p2.add_argument("--mode", default="animate", choices=["animate", "replace"])

    # preprocess
    p = sub.add_parser("preprocess", help="Run Wan preprocess step to produce process_results/.")
    add_common(p)
    p.add_argument("--video", required=True, help="Input video path (mp4 recommended).")
    p.add_argument("--refer", required=True, help="Reference character image path (jpeg/png).")
    p.add_argument("--process-out", required=True, help="Directory to write preprocess results into.")
    p.add_argument("--res-w", type=int, default=1280)
    p.add_argument("--res-h", type=int, default=720)
    # animation toggles
    p.add_argument("--retarget", action="store_true", help="Pass --retarget_flag (animation mode).")
    p.add_argument("--use-flux", action="store_true", help="Pass --use_flux (animation mode).")
    # replacement knobs
    p.add_argument("--replace-iterations", type=int, default=3)
    p.add_argument("--replace-k", type=int, default=7)
    p.add_argument("--replace-w-len", type=int, default=1)
    p.add_argument("--replace-h-len", type=int, default=1)
    p.set_defaults(func=_cmd_preprocess)

    # generate
    p = sub.add_parser("generate", help="Run Wan generate.py inference from preprocess results.")
    add_common(p)
    p.add_argument("--src-root", required=True, help="Preprocess output path (directory or file, per Wan generate.py).")
    p.add_argument("--refert-num", type=int, default=1, help="Passed as --refert_num to generate.py.")
    p.add_argument("--use-relighting-lora", action="store_true", help="Pass --use_relighting_lora (replacement mode).")
    # distributed knobs (optional)
    p.add_argument("--distributed", action="store_true", help="Use torch.distributed.run (multi-GPU).")
    p.add_argument("--nnodes", type=int, default=1)
    p.add_argument("--nproc-per-node", type=int, default=8)
    p.add_argument("--dit-fsdp", action="store_true", help="Pass --dit_fsdp to generate.py.")
    p.add_argument("--t5-fsdp", action="store_true", help="Pass --t5_fsdp to generate.py.")
    p.add_argument("--ulysses-size", type=int, default=0, help="Pass --ulysses_size N (0 disables).")
    p.set_defaults(func=_cmd_generate)

    # run (preprocess + generate)
    p = sub.add_parser("run", help="Convenience: preprocess then generate in one command.")
    add_common(p)
    p.add_argument("--video", required=True)
    p.add_argument("--refer", required=True)
    p.add_argument("--process-out", required=True)
    p.add_argument("--res-w", type=int, default=1280)
    p.add_argument("--res-h", type=int, default=720)
    p.add_argument("--refert-num", type=int, default=1)
    p.add_argument("--skip-preprocess", action="store_true")
    p.add_argument("--skip-generate", action="store_true")
    # animation toggles
    p.add_argument("--retarget", action="store_true")
    p.add_argument("--use-flux", action="store_true")
    # replacement knobs
    p.add_argument("--replace-iterations", type=int, default=3)
    p.add_argument("--replace-k", type=int, default=7)
    p.add_argument("--replace-w-len", type=int, default=1)
    p.add_argument("--replace-h-len", type=int, default=1)
    p.add_argument("--use-relighting-lora", action="store_true")
    # distributed knobs (optional)
    p.add_argument("--distributed", action="store_true")
    p.add_argument("--nnodes", type=int, default=1)
    p.add_argument("--nproc-per-node", type=int, default=8)
    p.add_argument("--dit-fsdp", action="store_true")
    p.add_argument("--t5-fsdp", action="store_true")
    p.add_argument("--ulysses-size", type=int, default=0)
    p.set_defaults(func=_cmd_run)

    return ap


def main() -> int:
    ap = _build_parser()
    args = ap.parse_args()
    try:
        args.func(args)
        return 0
    except CmdError as e:
        print(str(e), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

