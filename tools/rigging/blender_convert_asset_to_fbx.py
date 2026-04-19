from __future__ import annotations

import argparse
import sys
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

import bpy  # type: ignore

from blender_common import blender_argv_after_double_dash, import_asset, reset_scene, select_only_objects


def _parse(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="blender_convert_asset_to_fbx.py")
    ap.add_argument("--in", dest="input", required=True, help="Input asset path (glb/gltf/fbx/usd/... supported by import_asset).")
    ap.add_argument("--out", dest="output", required=True, help="Output FBX path.")
    ap.add_argument("--use-selection", default="1", help="Export only imported objects (1/0).")
    ap.add_argument("--deform-only", default="0", help="Export only deform bones (1/0).")
    return ap.parse_args(argv)


def _safe_bool01(v: str) -> bool:
    return str(v or "").strip() not in ("", "0", "false", "False", "no", "No")


def main() -> None:
    args = _parse(blender_argv_after_double_dash())
    inp = Path(args.input).resolve()
    out = Path(args.output).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    reset_scene()
    imported = import_asset(inp)

    use_selection = _safe_bool01(args.use_selection)
    deform_only = _safe_bool01(args.deform_only)

    if use_selection:
        try:
            select_only_objects(imported)
        except Exception:
            pass

    # Reasonable defaults for game-ready FBX export.
    bpy.ops.export_scene.fbx(
        filepath=str(out),
        use_selection=bool(use_selection),
        object_types={"ARMATURE", "MESH", "EMPTY"},
        add_leaf_bones=False,
        apply_unit_scale=True,
        bake_space_transform=False,
        use_armature_deform_only=bool(deform_only),
        # Animation export (if actions exist)
        bake_anim=True,
        bake_anim_use_all_actions=True,
        bake_anim_use_nla_strips=True,
        bake_anim_simplify_factor=0.0,
    )

    print(f"[convert_asset] wrote fbx: {out}")


if __name__ == "__main__":
    main()

