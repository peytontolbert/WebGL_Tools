#!/usr/bin/env python3
"""
Animation connectors for this repo's asset pipeline.

Goal: take motion generated elsewhere (BVH/FBX/GLB) and produce viewer/game-ready
glTF/GLB animation clips on top of *our* canonical rig.

This script intentionally uses only stdlib and shells out to Blender in headless
mode, similar to `tools/rig_asset.py`.

Typical usage (retarget BVH -> target rig -> animation-only GLB):
  python3 tools/anim_asset.py retarget \
    --rig assets/characters/hero/hero_rig.glb \
    --motion /abs/path/walk.bvh \
    --map tools/rigging/mappings/example_map.json \
    --out assets/characters/hero/anims/walk.glb \
    --clip-name walk

Notes
-----
- Retarget quality depends on bone-name mapping. Start by exporting/printing bone
  names of both rigs using `tools/anim_asset.py print-bones`.
- For diffusion/transformer models (MDM / MotionCLIP / ACTOR): expect offline
  generation (Python), export BVH/FBX, then retarget here.
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
RIGGING_DIR = REPO_ROOT / "tools" / "rigging"
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
    _ensure_exists(script, "Blender script")
    cmd = [blender_exe, "--background", "--factory-startup", "--python", str(script), "--"] + script_args
    _run(cmd, cwd=cwd)


def _cmd_print_bones(args: argparse.Namespace) -> None:
    blender = str(args.blender or "").strip() or _pick_default_blender()
    script = RIGGING_DIR / "blender_print_armature_bones.py"
    _blender_run(
        blender,
        script,
        script_args=[
            "--in",
            str(Path(args.input)),
        ],
    )


def _cmd_list_clips(args: argparse.Namespace) -> None:
    blender = str(args.blender or "").strip() or _pick_default_blender()
    script = RIGGING_DIR / "blender_list_actions.py"
    _blender_run(
        blender,
        script,
        script_args=[
            "--in",
            str(Path(args.input)),
        ],
    )

def _cmd_validate_map(args: argparse.Namespace) -> None:
    blender = str(args.blender or "").strip() or _pick_default_blender()
    script = RIGGING_DIR / "blender_validate_retarget_map.py"

    rig = Path(args.rig).resolve()
    motion = Path(args.motion).resolve()
    mapping = Path(args.map).resolve()

    _ensure_exists(rig, "target rig")
    _ensure_exists(motion, "source motion")
    _ensure_exists(mapping, "retarget mapping json")

    _blender_run(
        blender,
        script,
        script_args=[
            "--rig",
            str(rig),
            "--motion",
            str(motion),
            "--map",
            str(mapping),
        ],
    )


def _cmd_retarget(args: argparse.Namespace) -> None:
    blender = str(args.blender or "").strip() or _pick_default_blender()
    script = RIGGING_DIR / "blender_retarget_motion.py"

    rig = Path(args.rig).resolve()
    motion = Path(args.motion).resolve()
    mapping = Path(args.map).resolve()
    out = Path(args.output).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    _ensure_exists(rig, "target rig")
    _ensure_exists(motion, "source motion")
    _ensure_exists(mapping, "retarget mapping json")

    script_args: list[str] = [
        "--rig",
        str(rig),
        "--motion",
        str(motion),
        "--map",
        str(mapping),
        "--out",
        str(out),
        "--export-format",
        args.export_format,
        "--root-motion",
        "1" if args.root_motion else "0",
        "--include-mesh",
        "1" if args.include_mesh else "0",
    ]
    if getattr(args, "motion_clip", ""):
        script_args += ["--motion-clip", str(args.motion_clip)]
    if args.clip_name:
        script_args += ["--clip-name", str(args.clip_name)]
    if args.fps and int(args.fps) > 0:
        script_args += ["--fps", str(int(args.fps))]
    if args.start is not None:
        script_args += ["--start", str(int(args.start))]
    if args.end is not None:
        script_args += ["--end", str(int(args.end))]

    _blender_run(
        blender,
        script,
        script_args=script_args,
    )

    # Blender does not always propagate Python exceptions to a non-zero exit code.
    # Make success criteria explicit: the expected output file must exist.
    if not out.exists():
        raise CmdError(
            "Retarget did not produce an output file. "
            "Check stderr above (common cause: target rig has no armature). "
            f"Expected: {out}"
        )
    try:
        if out.stat().st_size < 256:
            raise CmdError(f"Retarget output looks too small: {out} ({out.stat().st_size} bytes)")
    except OSError:
        # If stat fails, treat as missing/corrupt.
        raise CmdError(f"Retarget output could not be read: {out}")


def _cmd_locomotion_pack(args: argparse.Namespace) -> None:
    blender = str(args.blender or "").strip() or _pick_default_blender()
    script = RIGGING_DIR / "blender_retarget_locomotion_pack.py"

    rig = Path(args.rig).resolve()
    mapping = Path(args.map).resolve()
    clips_json = Path(args.clips_json).resolve()
    out = Path(args.output).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    _ensure_exists(rig, "target rig")
    _ensure_exists(mapping, "retarget mapping json")
    _ensure_exists(clips_json, "clips-json file")

    include_mesh = bool(args.include_mesh)

    script_args: list[str] = [
        "--rig",
        str(rig),
        "--map",
        str(mapping),
        "--clips-json",
        str(clips_json),
        "--out",
        str(out),
        "--export-format",
        args.export_format,
        "--include-mesh",
        "1" if include_mesh else "0",
    ]

    _blender_run(
        blender,
        script,
        script_args=script_args,
    )

    # Same explicit success criteria as single retarget.
    if not out.exists():
        raise CmdError(f"Locomotion pack did not produce an output file: {out}")
    try:
        if out.stat().st_size < 256:
            raise CmdError(f"Locomotion pack output looks too small: {out} ({out.stat().st_size} bytes)")
    except OSError:
        raise CmdError(f"Locomotion pack output could not be read: {out}")


def _build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="tools/anim_asset.py")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("print-bones", help="Print armature bone names from an asset (glb/gltf/fbx/bvh/blend).")
    p.add_argument("--in", dest="input", required=True, help="Input asset path to inspect.")
    p.add_argument("--blender", default=os.environ.get("BLENDER", ""), help="Blender executable path (or set BLENDER env var).")
    p.set_defaults(func=_cmd_print_bones)

    p = sub.add_parser("list-clips", help="List animation clip/action names in an asset (glb/gltf/fbx/bvh/blend).")
    p.add_argument("--in", dest="input", required=True, help="Input asset path to inspect.")
    p.add_argument("--blender", default=os.environ.get("BLENDER", ""), help="Blender executable path (or set BLENDER env var).")
    p.set_defaults(func=_cmd_list_clips)

    p = sub.add_parser("validate-map", help="Validate that a retarget mapping references bones that exist in source + target.")
    p.add_argument("--rig", required=True, help="Target rig (GLB/GLTF/FBX/BLEND) containing an armature.")
    p.add_argument("--motion", required=True, help="Source motion (BVH/FBX/GLB/GLTF/USD) containing an armature + animation.")
    p.add_argument("--map", required=True, help="JSON mapping describing source->target bone correspondences.")
    p.add_argument("--blender", default=os.environ.get("BLENDER", ""), help="Blender executable path (or set BLENDER env var).")
    p.set_defaults(func=_cmd_validate_map)

    p = sub.add_parser("retarget", help="Retarget a motion file (BVH/FBX/GLB) onto a target rig and export GLB.")
    p.add_argument("--rig", required=True, help="Target rig (GLB/GLTF/FBX/BLEND) containing an armature.")
    p.add_argument("--motion", required=True, help="Source motion (BVH/FBX/GLB/GLTF/USD) containing an armature + animation.")
    p.add_argument("--map", required=True, help="JSON mapping describing source->target bone correspondences.")
    p.add_argument("--out", dest="output", required=True, help="Output path (typically .glb).")
    p.add_argument("--motion-clip", default="", help="Optional source action name to retarget (for multi-clip GLB/FBX).")
    p.add_argument("--clip-name", default="", help="Optional clip name (action name) for the exported animation.")
    p.add_argument("--fps", type=int, default=0, help="Override scene FPS if non-zero.")
    p.add_argument("--start", type=int, default=None, help="Start frame (inclusive). Default: motion start.")
    p.add_argument("--end", type=int, default=None, help="End frame (inclusive). Default: motion end.")
    p.add_argument("--root-motion", action="store_true", help="Copy root translation from source to target root bone.")
    p.add_argument("--include-mesh", action="store_true", help="Include the target mesh in the exported GLB (debug/preview).")
    p.add_argument("--export-format", default="GLB", choices=["GLB", "GLTF_SEPARATE"], help="Blender glTF export format.")
    p.add_argument("--blender", default=os.environ.get("BLENDER", ""), help="Blender executable path (or set BLENDER env var).")
    p.set_defaults(func=_cmd_retarget)

    p = sub.add_parser("locomotion-pack", help="Retarget multiple motions and export one GLB containing all actions (idle/walk/run/jump pack).")
    p.add_argument("--rig", required=True, help="Target rig (GLB/GLTF/FBX/BLEND) containing an armature.")
    p.add_argument("--map", required=True, help="JSON mapping describing source->target bone correspondences.")
    p.add_argument("--clips-json", required=True, help="Path to a JSON file describing clips to retarget (array or {clips:[...]}).")
    p.add_argument("--out", dest="output", required=True, help="Output path (typically .glb).")
    p.add_argument("--include-mesh", action="store_true", help="Include the target mesh in the exported GLB (recommended for gameplay).")
    p.add_argument("--export-format", default="GLB", choices=["GLB", "GLTF_SEPARATE"], help="Blender glTF export format.")
    p.add_argument("--blender", default=os.environ.get("BLENDER", ""), help="Blender executable path (or set BLENDER env var).")
    p.set_defaults(func=_cmd_locomotion_pack)

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

