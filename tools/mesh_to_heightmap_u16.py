#!/usr/bin/env python3
"""
Convert a terrain mesh into the repo's heightmap-u16 format.

This is the glue that lets Trellis (or any mesh generator) produce terrain that
the runtime can stream efficiently:
  meta.json + heights.u16.bin

Example:
  python3 tools/mesh_to_heightmap_u16.py \
    --in assets/generated/trellis/my_terrain.glb \
    --out assets/generated/heightmap/my_terrain_hm \
    --grid 256
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
BLENDER_SCRIPT = REPO_ROOT / "tools" / "rigging" / "blender_mesh_to_heightmap_u16.py"
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
    ap = argparse.ArgumentParser(prog="mesh_to_heightmap_u16.py")
    ap.add_argument("--in", dest="input", required=True, help="Input mesh (glb/gltf/obj/fbx/blend).")
    ap.add_argument("--out", dest="out_dir", required=True, help="Output directory (writes meta.json + heights.u16.bin).")
    ap.add_argument("--grid", default="256", help="Heightmap resolution (N).")
    ap.add_argument("--endian", default="little", choices=["little", "big"])

    ap.add_argument("--bounds", default="", help="Optional bounds: minX,maxX,minY,maxY in meters (Blender X/Y).")
    ap.add_argument("--min-z", default="", help="Optional minZ (vertical meters).")
    ap.add_argument("--max-z", default="", help="Optional maxZ (vertical meters).")
    ap.add_argument("--ray-height", default="2000", help="Ray start height above maxZ (meters).")

    ap.add_argument("--blender", default="", help="Optional blender executable path.")
    return ap.parse_args(argv)


def main(argv: list[str]) -> int:
    args = _parse(argv)
    inp = Path(args.input).resolve()
    out_dir = Path(args.out_dir).resolve()

    if not inp.exists():
        raise FileNotFoundError(str(inp))
    if not BLENDER_SCRIPT.exists():
        raise FileNotFoundError(str(BLENDER_SCRIPT))

    blender = str(args.blender or "").strip()
    if blender:
        bp = Path(blender)
        if bp.exists():
            blender = str(bp)
    if not blender:
        blender = _pick_default_blender()

    out_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        blender,
        "--background",
        "--factory-startup",
        "--python",
        str(BLENDER_SCRIPT),
        "--",
        "--in",
        str(inp),
        "--out-dir",
        str(out_dir),
        "--grid",
        str(args.grid),
        "--endian",
        str(args.endian),
        "--ray-height",
        str(args.ray_height),
    ]
    if str(args.bounds or "").strip():
        cmd += ["--bounds", str(args.bounds)]
    if str(args.min_z or "").strip():
        cmd += ["--min-z", str(args.min_z)]
    if str(args.max_z or "").strip():
        cmd += ["--max-z", str(args.max_z)]

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

