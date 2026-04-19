#!/usr/bin/env python3
"""
Rigging connectors for this repo's asset pipeline.

Goal: make multiple open-source riggers runnable in a consistent way:
  - Blender-native: Rigify (built-in), BlenRig (addon), Rigacar (addon)
  - ML / external repos: UniRig, RigAnything, RigNet

This script intentionally uses only stdlib and shells out to:
  - Blender in headless mode for Blender-based workflows
  - External repo scripts for ML workflows

Examples
--------
Rigify (Blender builtin, produces GLB):
  python3 tools/rig_asset.py rigify --in character.glb --out character_rig.glb

Rigacar (requires Rigacar addon installed in Blender):
  python3 tools/rig_asset.py rigacar --in car.glb --out car_rig.glb

UniRig (requires UniRig repo + env set up):
  python3 tools/rig_asset.py unirig \
    --unirig-repo /abs/path/UniRig \
    --in creature.glb --out creature_rig.glb \
    --seed 42

RigAnything (requires RigAnything repo + env + checkpoint):
  python3 tools/rig_asset.py riganything \
    --riganything-repo /abs/path/RigAnything \
    --in creature.glb --out creature_rig.glb --simplify 1 --target-faces 8192
"""

from __future__ import annotations

import argparse
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
RIGGING_DIR = REPO_ROOT / "tools" / "rigging"
DEFAULT_REPOS_DIR = REPO_ROOT / "repos"
BLENDER5_PORTABLE = REPO_ROOT / "tools" / "third_party" / "blender-5.0" / "blender-5.0.0-linux-x64" / "blender"


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


def _pick_default_blender() -> str:
    """
    Prefer the repo's vendored portable Blender 5 build when available.

    Motivation: distro Blender builds are sometimes compiled without OpenUSD support.
    Using the portable build keeps USD import/export working consistently across machines.
    """
    try:
        if BLENDER5_PORTABLE.exists():
            return str(BLENDER5_PORTABLE.resolve())
    except Exception:
        pass
    return _which_or_hint("blender", "Install Blender or pass --blender /path/to/blender")


def _ensure_exists(path: Path, what: str) -> None:
    if not path.exists():
        raise CmdError(f"Missing {what}: {path}")


def _blender_run(
    blender_exe: str,
    script: Path,
    *,
    script_args: list[str],
    cwd: Path | None = None,
) -> None:
    _ensure_exists(script, "Blender rig script")
    cmd = [blender_exe, "--background", "--factory-startup", "--python", str(script), "--"] + script_args
    _run(cmd, cwd=cwd)


def _cmd_rigify(args: argparse.Namespace) -> None:
    blender = str(args.blender or "").strip() or _pick_default_blender()
    script = RIGGING_DIR / "blender_rigify.py"
    _blender_run(
        blender,
        script,
        script_args=[
            "--in",
            str(Path(args.input)),
            "--out",
            str(Path(args.output)),
            "--export-format",
            args.export_format,
            "--deform-only",
            "1" if args.deform_only else "0",
        ],
    )


def _cmd_blenrig(args: argparse.Namespace) -> None:
    blender = str(args.blender or "").strip() or _pick_default_blender()
    script = RIGGING_DIR / "blender_blenrig.py"
    addon_path = args.addon_path or ""
    _blender_run(
        blender,
        script,
        script_args=[
            "--in",
            str(Path(args.input)),
            "--out",
            str(Path(args.output)),
            "--export-format",
            args.export_format,
            "--addon-path",
            str(addon_path),
        ],
    )


def _cmd_rigacar(args: argparse.Namespace) -> None:
    blender = str(args.blender or "").strip() or _pick_default_blender()
    script = RIGGING_DIR / "blender_rigacar.py"
    addon_path = args.addon_path or ""
    _blender_run(
        blender,
        script,
        script_args=[
            "--in",
            str(Path(args.input)),
            "--out",
            str(Path(args.output)),
            "--export-format",
            args.export_format,
            "--addon-path",
            str(addon_path),
            "--join-meshes",
            "1" if args.join_meshes else "0",
        ],
    )


def _cmd_unirig(args: argparse.Namespace) -> None:
    repo = Path(args.unirig_repo).resolve()
    _ensure_exists(repo / "launch" / "inference" / "generate_skeleton.sh", "UniRig repo (generate_skeleton.sh)")
    _ensure_exists(repo / "launch" / "inference" / "generate_skin.sh", "UniRig repo (generate_skin.sh)")
    _ensure_exists(repo / "launch" / "inference" / "merge.sh", "UniRig repo (merge.sh)")

    inp = Path(args.input).resolve()
    out = Path(args.output).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="unirig_") as td:
        td = Path(td)
        skel_fbx = td / "skeleton.fbx"
        skin_fbx = td / "skin.fbx"

        seed = int(args.seed) if str(args.seed or "").strip() else 0
        seed_args = ["--seed", str(seed)] if seed else []

        _run(
            [
                "bash",
                str(repo / "launch" / "inference" / "generate_skeleton.sh"),
                "--input",
                str(inp),
                "--output",
                str(skel_fbx),
            ]
            + seed_args,
            cwd=repo,
        )
        _run(
            [
                "bash",
                str(repo / "launch" / "inference" / "generate_skin.sh"),
                "--input",
                str(skel_fbx),
                "--output",
                str(skin_fbx),
            ],
            cwd=repo,
        )
        _run(
            [
                "bash",
                str(repo / "launch" / "inference" / "merge.sh"),
                "--source",
                str(skin_fbx),
                "--target",
                str(inp),
                "--output",
                str(out),
            ],
            cwd=repo,
        )


def _cmd_riganything(args: argparse.Namespace) -> None:
    repo = Path(args.riganything_repo).resolve()
    _ensure_exists(repo / "inference.py", "RigAnything repo (inference.py)")
    _ensure_exists(repo / "inference_utils" / "mesh_simplify.py", "RigAnything repo (mesh_simplify.py)")
    _ensure_exists(repo / "inference_utils" / "vis_skel.py", "RigAnything repo (vis_skel.py)")

    py = args.python or sys.executable
    inp = Path(args.input).resolve()
    out = Path(args.output).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    # We mimic the documented three-step flow, but we control the output directory
    # and then copy the final *_rig.glb to --out.
    with tempfile.TemporaryDirectory(prefix="riganything_") as td:
        td = Path(td)
        stem = inp.stem
        work_dir = td / "work"
        work_dir.mkdir(parents=True, exist_ok=True)

        # Step 1: simplify (optional)
        _run(
            [
                py,
                str(repo / "inference_utils" / "mesh_simplify.py"),
                "--data_path",
                str(inp),
                "--mesh_simplify",
                str(int(args.simplify)),
                "--simplify_count",
                str(int(args.target_faces)),
                "--output_path",
                str(work_dir / stem),
            ],
            cwd=repo,
        )

        simplified_glb = work_dir / stem / f"{stem}_simplified.glb"
        simplified_npz = work_dir / stem / f"{stem}_simplified.npz"
        _ensure_exists(simplified_glb, "RigAnything simplified GLB")
        _ensure_exists(simplified_npz, "RigAnything simplified NPZ")

        # Step 2: inference
        _run(
            [
                py,
                str(repo / "inference.py"),
                "--config",
                str(Path(args.config) if args.config else (repo / "config.yaml")),
                "--load",
                str(Path(args.checkpoint) if args.checkpoint else (repo / "ckpt" / "riganything_ckpt.pt")),
                "-s",
                "inference",
                "true",
                "-s",
                "inference_out_dir",
                str(work_dir / stem),
                "--mesh_path",
                str(simplified_glb),
            ],
            cwd=repo,
        )

        # Step 3: export rigged GLB
        _run(
            [
                py,
                str(repo / "inference_utils" / "vis_skel.py"),
                "--data_path",
                str(simplified_npz),
                "--save_path",
                str(work_dir / stem),
                "--mesh_path",
                str(simplified_glb),
            ],
            cwd=repo,
        )

        produced = work_dir / stem / f"{stem}_simplified_rig.glb"
        _ensure_exists(produced, "RigAnything rigged GLB output")
        shutil.copyfile(produced, out)


def _cmd_rignet(args: argparse.Namespace) -> None:
    """
    RigNet integration notes:
      - The original RigNet repo is research code and typically outputs a custom rig text file.
      - For Blender workflows, use a Blender addon wrapper (bRigNet / brignet) instead.

    This subcommand is a connector that *either*:
      - runs a user-specified command (recommended), or
      - errors with instructions if not provided.
    """
    inp = Path(args.input).resolve()
    out = Path(args.output).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    if not args.command:
        raise CmdError(
            "RigNet is not a single stable CLI in the upstream repo.\n"
            "Use one of these approaches:\n"
            "  - Preferred: use a Blender addon wrapper (e.g. pKrime/brignet) and export GLB from Blender.\n"
            "  - Or pass --command to run your own RigNet invocation that produces a rigged asset.\n"
            "\n"
            "Devtools compatibility:\n"
            "  This connector accepts --in/--out like the other backends, but it does not automatically\n"
            "  produce output. Your --command must write the rigged asset to --out.\n"
            "\n"
            "The command is run with these environment variables set:\n"
            f"  - RIG_ASSET_IN={inp}\n"
            f"  - RIG_ASSET_OUT={out}\n"
            f"  - RIG_ASSET_EXPORT_FORMAT={args.export_format}\n"
            f"  - RIG_ASSET_DEFORM_ONLY={'1' if getattr(args, 'deform_only', False) else '0'}\n"
            "\n"
            "Example:\n"
            "  python3 tools/rig_asset.py rignet --in character.glb --out character_rignet.glb \\\n"
            "    --command \"bash -lc 'python /path/to/RigNet/run.py \\\"$RIG_ASSET_IN\\\" \\\"$RIG_ASSET_OUT\\\"'\"\n"
        )
    cmd = shlex.split(args.command)
    env = dict(os.environ)
    env["RIG_ASSET_IN"] = str(inp)
    env["RIG_ASSET_OUT"] = str(out)
    env["RIG_ASSET_EXPORT_FORMAT"] = str(args.export_format)
    env["RIG_ASSET_DEFORM_ONLY"] = "1" if getattr(args, "deform_only", False) else "0"
    _run(cmd, cwd=Path(args.cwd).resolve() if args.cwd else None, env=env)


def _build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="tools/rig_asset.py")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add_io(p: argparse.ArgumentParser) -> None:
        p.add_argument("--in", dest="input", required=True, help="Input mesh path (glb/gltf/fbx/obj supported depending on backend).")
        p.add_argument("--out", dest="output", required=True, help="Output path (typically .glb).")
        p.add_argument("--export-format", default="GLB", choices=["GLB", "GLTF_SEPARATE"], help="Blender glTF export format.")

    # Blender backends
    p = sub.add_parser("rigify", help="Rigify auto-rig inside Blender; auto-weights; export glTF.")
    add_io(p)
    p.add_argument("--blender", default=os.environ.get("BLENDER", ""), help="Blender executable path (or set BLENDER env var).")
    p.add_argument("--deform-only", action="store_true", help="Export deform bones only (recommended for glTF runtime).")
    p.set_defaults(func=_cmd_rigify)

    p = sub.add_parser("blenrig", help="BlenRig inside Blender (requires BlenRig addon installed); export glTF.")
    add_io(p)
    p.add_argument("--blender", default=os.environ.get("BLENDER", ""), help="Blender executable path (or set BLENDER env var).")
    p.add_argument(
        "--addon-path",
        default=str(DEFAULT_REPOS_DIR / "BlenRig") if (DEFAULT_REPOS_DIR / "BlenRig").exists() else "",
        help="Path to BlenRig addon directory/zip (optional; defaults to ./repos/BlenRig if present).",
    )
    p.set_defaults(func=_cmd_blenrig)

    p = sub.add_parser("rigacar", help="Rigacar inside Blender (requires Rigacar addon installed); export glTF.")
    add_io(p)
    p.add_argument("--blender", default=os.environ.get("BLENDER", ""), help="Blender executable path (or set BLENDER env var).")
    p.add_argument(
        "--addon-path",
        default=str(DEFAULT_REPOS_DIR / "rigacar") if (DEFAULT_REPOS_DIR / "rigacar").exists() else "",
        help="Path to Rigacar addon directory/zip (optional; defaults to ./repos/rigacar if present).",
    )
    p.add_argument(
        "--no-join-meshes",
        dest="join_meshes",
        action="store_false",
        default=True,
        help="Do not join meshes (export separate objects). Default is to join into one skinned mesh.",
    )
    p.set_defaults(func=_cmd_rigacar)

    # ML / external repos
    p = sub.add_parser("unirig", help="Run UniRig inference scripts to output a rigged GLB.")
    add_io(p)
    default_unirig = str(DEFAULT_REPOS_DIR / "UniRig") if (DEFAULT_REPOS_DIR / "UniRig").exists() else ""
    p.add_argument("--unirig-repo", required=not bool(default_unirig), default=default_unirig, help="Path to cloned UniRig repo (defaults to ./repos/UniRig if present).")
    p.add_argument("--seed", type=int, default=0, help="Optional random seed for UniRig skeleton prediction (0 = default).")
    p.set_defaults(func=_cmd_unirig)

    p = sub.add_parser("riganything", help="Run RigAnything end-to-end inference to output a rigged GLB.")
    add_io(p)
    default_ra = str(DEFAULT_REPOS_DIR / "RigAnything") if (DEFAULT_REPOS_DIR / "RigAnything").exists() else ""
    p.add_argument("--riganything-repo", required=not bool(default_ra), default=default_ra, help="Path to cloned RigAnything repo (defaults to ./repos/RigAnything if present).")
    p.add_argument("--python", default="", help="Python interpreter for RigAnything env (defaults to this interpreter).")
    p.add_argument("--simplify", type=int, default=1, choices=[0, 1], help="Whether to simplify mesh before rigging.")
    p.add_argument("--target-faces", type=int, default=8192, help="Simplification target faces if simplify=1.")
    p.add_argument("--checkpoint", default="", help="Path to RigAnything checkpoint (defaults to <repo>/ckpt/riganything_ckpt.pt).")
    p.add_argument("--config", default="", help="Path to RigAnything config (defaults to <repo>/config.yaml).")
    p.set_defaults(func=_cmd_riganything)

    p = sub.add_parser("rignet", help="RigNet connector (research code); run a custom command.")
    add_io(p)
    p.add_argument("--deform-only", action="store_true", help="Accepted for devtools compatibility; exported output is controlled by your --command.")
    p.add_argument("--command", default="", help="Command to run (quoted).")
    p.add_argument("--cwd", default="", help="Working directory for --command.")
    p.set_defaults(func=_cmd_rignet)

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
