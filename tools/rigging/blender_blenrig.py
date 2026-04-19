from __future__ import annotations

import argparse
import sys
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

import bpy
import mathutils

from blender_common import (
    blender_argv_after_double_dash,
    ensure_addon_enabled,
    ensure_minimal_skin,
    export_gltf,
    find_first_mesh,
    import_asset,
    install_addon_from_path,
    pick_first_deform_bone_name,
    parent_mesh_to_armature_auto_weights,
    reset_scene,
    select_only_objects,
)


def _parse(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="blender_blenrig.py")
    ap.add_argument("--in", dest="input", required=True)
    ap.add_argument("--out", dest="output", required=True)
    ap.add_argument("--export-format", default="GLB", choices=["GLB", "GLTF_SEPARATE"])
    ap.add_argument("--addon-path", default="", help="Path to BlenRig addon dir/zip (optional).")
    return ap.parse_args(argv)


def _find_first_armature() -> bpy.types.Object | None:
    for o in bpy.context.scene.objects:
        if o.type == "ARMATURE":
            return o
    return None


def _bbox_z_size(obj: bpy.types.Object) -> float:
    coords = [obj.matrix_world @ mathutils.Vector(c) for c in obj.bound_box]
    zs = [c.z for c in coords]
    return max(zs) - min(zs)


def main() -> None:
    args = _parse(blender_argv_after_double_dash())
    inp = Path(args.input).resolve()
    out = Path(args.output).resolve()

    reset_scene()
    if bpy.context.mode != "OBJECT":
        try:
            bpy.ops.object.mode_set(mode="OBJECT")
        except Exception:
            pass

    # Install + enable addon if provided; otherwise assume already installed.
    module = "BlenRig"
    if str(args.addon_path or "").strip():
        module = install_addon_from_path(Path(args.addon_path))
    ensure_addon_enabled(module)

    imported = import_asset(inp)
    mesh = find_first_mesh(imported)

    # Add the BlenRig biped rig from the addon operator (imports a collection).
    bpy.ops.blenrig.add_biped_rig()
    rig = _find_first_armature()
    if rig is None:
        raise RuntimeError("BlenRig did not add an armature.")

    # Best-effort scale the rig to match mesh height.
    mh = max(_bbox_z_size(mesh), 1e-6)
    rh = 2.0
    s = mh / rh
    rig.scale = (s, s, s)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    # Bind mesh to rig with Blender automatic weights (heat weights).
    try:
        parent_mesh_to_armature_auto_weights(mesh, rig)
    except Exception:
        pass
    bn = pick_first_deform_bone_name(rig) or ""
    ensure_minimal_skin(mesh, rig, prefer_bone=bn)

    try:
        select_only_objects([rig, mesh])
    except Exception:
        pass
    export_gltf(out, fmt=args.export_format, deform_bones_only=True, use_selection=True)


if __name__ == "__main__":
    main()

