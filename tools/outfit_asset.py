#!/usr/bin/env python3
"""
Outfit connector: attach clothing meshes to a rigged base character.

This is intended to be used after generating a mesh (e.g. Trellis) and producing
a rigged GLB via `tools/rig_asset.py`.

Typical usage:

  python3 tools/outfit_asset.py \
    --base /abs/path/character_rig.glb \
    --clothes /abs/path/shirt.glb \
    --clothes /abs/path/pants.glb \
    --out /abs/path/character_outfit.glb

Notes:
- Clothing meshes must be roughly aligned to the base body (same scale / rest pose).
- Default weighting uses Blender Data Transfer (body -> clothes). You can fall back
  to automatic weights with `--weight-method auto`.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
RIGGING_DIR = REPO_ROOT / "tools" / "rigging"
BLENDER_SCRIPT = RIGGING_DIR / "blender_outfit_asset.py"
BLENDER5_PORTABLE = REPO_ROOT / "tools" / "third_party" / "blender-5.0" / "blender-5.0.0-linux-x64" / "blender"


class CmdError(RuntimeError):
    pass


def _run(cmd: list[str]) -> None:
    p = subprocess.run(cmd)
    if p.returncode != 0:
        raise CmdError(f"Command failed ({p.returncode}): {' '.join(cmd)}")


def _pick_default_blender() -> str:
    try:
        if BLENDER5_PORTABLE.exists():
            return str(BLENDER5_PORTABLE.resolve())
    except Exception:
        pass
    blender = shutil.which("blender") or ""
    if not blender:
        raise CmdError("Blender executable not found. Install Blender or pass --blender /path/to/blender.")
    return blender


def _parse(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="outfit_asset.py")
    ap.add_argument("--base", required=True, help="Rigged base asset (GLB/GLTF/FBX/BLEND).")
    ap.add_argument("--clothes", action="append", default=[], help="Clothing mesh to attach (repeatable).")
    ap.add_argument("--out", required=True, help="Output GLB/GLTF.")
    ap.add_argument("--export-format", default="GLB", choices=["GLB", "GLTF_SEPARATE"])
    ap.add_argument("--blender", default="", help="Optional blender executable path.")

    ap.add_argument("--weight-method", default="transfer", choices=["transfer", "auto"])
    ap.add_argument("--apply-xform", default="1", help="Apply rotation+scale on imported clothing meshes (1/0).")
    ap.add_argument("--shrinkwrap", default="0", help="Shrinkwrap clothes to body (1/0).")
    ap.add_argument("--shrinkwrap-offset", default="0.003")
    return ap.parse_args(argv)


def main(argv: list[str]) -> int:
    args = _parse(argv)
    base = Path(args.base).resolve()
    out = Path(args.out).resolve()
    clothes = [Path(p).resolve() for p in (args.clothes or []) if str(p).strip()]

    if not base.exists():
        raise FileNotFoundError(str(base))
    if not clothes:
        raise ValueError("Missing --clothes (provide one or more clothing assets).")
    for p in clothes:
        if not p.exists():
            raise FileNotFoundError(str(p))

    blender = str(args.blender or "").strip()
    if blender:
        blender_path = Path(blender)
        if blender_path.exists():
            blender = str(blender_path)
    if not blender:
        blender = _pick_default_blender()

    if not BLENDER_SCRIPT.exists():
        raise FileNotFoundError(str(BLENDER_SCRIPT))

    cmd = [
        blender,
        "--background",
        "--factory-startup",
        "--python",
        str(BLENDER_SCRIPT),
        "--",
        "--base",
        str(base),
        "--out",
        str(out),
        "--export-format",
        str(args.export_format),
        "--weight-method",
        str(args.weight_method),
        "--apply-xform",
        str(args.apply_xform),
        "--shrinkwrap",
        str(args.shrinkwrap),
        "--shrinkwrap-offset",
        str(args.shrinkwrap_offset),
    ]
    for p in clothes:
        cmd += ["--clothes", str(p)]

    out.parent.mkdir(parents=True, exist_ok=True)
    _run(cmd)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        raise
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        raise SystemExit(2)

