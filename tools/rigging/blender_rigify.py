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
    pick_first_deform_bone_name,
    parent_mesh_to_armature_auto_weights,
    reset_scene,
    select_only_objects,
)


def _parse(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="blender_rigify.py")
    ap.add_argument("--in", dest="input", required=True)
    ap.add_argument("--out", dest="output", required=True)
    ap.add_argument("--export-format", default="GLB", choices=["GLB", "GLTF_SEPARATE"])
    ap.add_argument("--deform-only", default="1")
    return ap.parse_args(argv)


def _bbox_z_size(obj: bpy.types.Object) -> float:
    # World-space bbox
    coords = [obj.matrix_world @ mathutils.Vector(c) for c in obj.bound_box]
    zs = [c.z for c in coords]
    return max(zs) - min(zs)


def _try_add_human_metarig() -> bpy.types.Object:
    # Requires Rigify addon enabled.
    # This operator exists in typical Blender installs with Rigify.
    bpy.ops.object.armature_human_metarig_add()
    return bpy.context.active_object


def main() -> None:
    args = _parse(blender_argv_after_double_dash())
    inp = Path(args.input).resolve()
    out = Path(args.output).resolve()
    deform_only = str(args.deform_only).strip() not in ("0", "false", "False", "")

    reset_scene()
    ensure_addon_enabled("rigify")

    imported = import_asset(inp)
    mesh = find_first_mesh(imported)

    # Add a default human metarig and best-effort scale it to mesh height.
    metarig = _try_add_human_metarig()
    metarig.location = mesh.location

    # Simple scale heuristic: match approximate height.
    mh = max(_bbox_z_size(mesh), 1e-6)
    rh = 2.0  # Rigify human metarig is roughly ~2 blender units tall
    s = mh / rh
    metarig.scale = (s, s, s)
    bpy.context.view_layer.objects.active = metarig
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    # Generate final rig from metarig.
    bpy.ops.object.mode_set(mode="OBJECT")
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    metarig.select_set(True)
    bpy.context.view_layer.objects.active = metarig
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.rigify_generate()
    bpy.ops.object.mode_set(mode="OBJECT")

    # Find generated rig armature (Rigify typically creates an armature named "rig").
    rig = bpy.data.objects.get("rig")
    if rig is None or rig.type != "ARMATURE":
        # Fallback: pick the newest armature that's not the metarig.
        armatures = [o for o in bpy.context.scene.objects if o.type == "ARMATURE" and o != metarig]
        if not armatures:
            raise RuntimeError("Rigify generation did not produce a rig armature.")
        rig = armatures[-1]

    # Bind mesh to rig with automatic weights.
    bpy.ops.object.mode_set(mode="OBJECT")
    try:
        parent_mesh_to_armature_auto_weights(mesh, rig)
    except Exception:
        # Fall back to a rigid bind so export produces a valid skin.
        pass
    bn = pick_first_deform_bone_name(rig) or ""
    ensure_minimal_skin(mesh, rig, prefer_bone=bn)

    # Remove metarig (keeps generated rig + mesh).
    try:
        bpy.data.objects.remove(metarig, do_unlink=True)
    except Exception:
        pass

    # Export only the rig + mesh to avoid exporting Rigify widget objects (WGT-*)
    # which can trigger edge-cases in Blender's glTF exporter.
    try:
        select_only_objects([rig, mesh])
    except Exception:
        pass
    export_gltf(out, fmt=args.export_format, deform_bones_only=deform_only, use_selection=True)


if __name__ == "__main__":
    main()

