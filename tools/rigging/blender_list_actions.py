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
    ap = argparse.ArgumentParser(prog="blender_list_actions.py")
    ap.add_argument("--in", dest="input", required=True, help="Asset to import (glb/gltf/fbx/bvh/blend).")
    return ap.parse_args(argv)


def main() -> None:
    args = _parse(blender_argv_after_double_dash())
    inp = Path(args.input).resolve()

    reset_scene()
    import_asset(inp)

    acts = list(bpy.data.actions)
    print(f"Actions: {len(acts)}")
    for a in acts:
        fr = getattr(a, "frame_range", None)
        if fr:
            s, e = int(round(fr[0])), int(round(fr[1]))
            print(f"- {a.name}  [{s}..{e}]")
        else:
            print(f"- {a.name}")


if __name__ == "__main__":
    main()

