from __future__ import annotations

import argparse
import sys
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

import bpy

from blender_common import blender_argv_after_double_dash, import_asset, reset_scene


def _parse(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="blender_print_armature_bones.py")
    ap.add_argument("--in", dest="input", required=True)
    return ap.parse_args(argv)


def _find_first_armature(imported: list[bpy.types.Object]) -> bpy.types.Object | None:
    for o in imported:
        if o and o.type == "ARMATURE":
            return o
    for o in bpy.context.scene.objects:
        if o.type == "ARMATURE":
            return o
    return None


def main() -> None:
    args = _parse(blender_argv_after_double_dash())
    inp = Path(args.input).resolve()

    reset_scene()
    imported = import_asset(inp)
    arm_obj = _find_first_armature(imported)
    if arm_obj is None or arm_obj.type != "ARMATURE":
        raise RuntimeError("No armature found in input.")

    arm = arm_obj.data
    names = [b.name for b in arm.bones]
    print(f"Armature: {arm_obj.name} ({len(names)} bones)")
    for n in names:
        print(n)


if __name__ == "__main__":
    main()

