from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

import bpy

from blender_common import (
    blender_argv_after_double_dash,
    ensure_addon_enabled,
    export_gltf,
    find_first_mesh,
    import_asset,
    install_addon_from_path,
    reset_scene,
    select_only_objects,
)


def _parse(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="blender_rigacar.py")
    ap.add_argument("--in", dest="input", required=True)
    ap.add_argument("--out", dest="output", required=True)
    ap.add_argument("--export-format", default="GLB", choices=["GLB", "GLTF_SEPARATE"])
    ap.add_argument("--addon-path", default="", help="Path to rigacar addon dir/zip (optional).")
    ap.add_argument("--join-meshes", default="1", help="Join imported meshes into one skinned mesh (1/0).")
    return ap.parse_args(argv)


def _select_none() -> None:
    for o in bpy.context.view_layer.objects:
        o.select_set(False)


def _infer_rigacar_part_name(obj_name: str) -> str | None:
    """
    Try to map an object name to a Rigacar target suffix like:
      Body, Wheel.Ft.L, Wheel.Bk.R, WheelBrake.Ft.L, ...
    Rigacar itself matches these as suffixes, allowing separators.
    """
    candidates = [
        "Body",
        "Wheel.Ft.L",
        "Wheel.Ft.R",
        "Wheel.Bk.L",
        "Wheel.Bk.R",
        "WheelBrake.Ft.L",
        "WheelBrake.Ft.R",
        "WheelBrake.Bk.L",
        "WheelBrake.Bk.R",
    ]
    for c in candidates:
        escaped = re.escape(c).replace(r"\.", r"[\.-_ ]")
        pat = re.compile(rf"^.*{escaped}$", re.IGNORECASE)
        if pat.match(obj_name):
            return c
    return None


def _make_rigid_vertex_groups(mesh_obj: bpy.types.Object, *, bone_name: str) -> None:
    """
    Assign all verts weight=1.0 to `bone_name` (rigid binding).
    """
    if mesh_obj.type != "MESH":
        return
    vg = mesh_obj.vertex_groups.get(bone_name) or mesh_obj.vertex_groups.new(name=bone_name)
    idxs = [v.index for v in mesh_obj.data.vertices]
    if idxs:
        vg.add(idxs, 1.0, "REPLACE")


def _find_armature_by_data_flag() -> bpy.types.Object | None:
    for o in bpy.context.scene.objects:
        if o.type == "ARMATURE" and o.data is not None and ("Car Rig" in o.data):
            return o
    return None


def _ensure_armature_modifier(mesh_obj: bpy.types.Object, arm_obj: bpy.types.Object) -> None:
    for m in mesh_obj.modifiers:
        if m.type == "ARMATURE" and getattr(m, "object", None) == arm_obj:
            return
    mod = mesh_obj.modifiers.new(name="Armature", type="ARMATURE")
    mod.object = arm_obj


def main() -> None:
    args = _parse(blender_argv_after_double_dash())
    inp = Path(args.input).resolve()
    out = Path(args.output).resolve()
    join_meshes = str(args.join_meshes).strip() not in ("0", "false", "False", "")

    reset_scene()
    if bpy.context.mode != "OBJECT":
        try:
            bpy.ops.object.mode_set(mode="OBJECT")
        except Exception:
            pass

    # Install + enable addon if provided; otherwise assume already installed.
    module = "rigacar"
    if str(args.addon_path or "").strip():
        module = install_addon_from_path(Path(args.addon_path))
    ensure_addon_enabled(module)

    imported = import_asset(inp)
    mesh_objs = [o for o in imported if o and o.type == "MESH"]
    if not mesh_objs:
        mesh_objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not mesh_objs:
        raise RuntimeError("No mesh objects found to rig.")

    # Select imported objects so Rigacar can infer wheel/body target positions.
    _select_none()
    for o in imported:
        if o and o.type in ("MESH", "EMPTY"):
            o.select_set(True)

    # Create base deformation rig (meta rig).
    bpy.ops.object.armature_car_deformation_rig()

    arm_obj = _find_armature_by_data_flag()
    if arm_obj is None:
        # Fallback: Rigacar default object name.
        arm_obj = bpy.data.objects.get("Car Rig")
    if arm_obj is None or arm_obj.type != "ARMATURE":
        raise RuntimeError("Rigacar did not create an armature.")

    # Generate full animation rig.
    bpy.context.view_layer.objects.active = arm_obj
    _select_none()
    arm_obj.select_set(True)
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.car_animation_rig_generate(adjust_origin=True)
    bpy.ops.object.mode_set(mode="OBJECT")

    # Create rigid vertex groups per part, then optionally join meshes into one skinned mesh.
    # This produces glTF skinning that works in WebGL runtimes.
    for mo in mesh_objs:
        part = _infer_rigacar_part_name(mo.name) or "Body"
        bone = f"DEF-{part}"
        _make_rigid_vertex_groups(mo, bone_name=bone)

    if join_meshes and len(mesh_objs) > 1:
        _select_none()
        for mo in mesh_objs:
            mo.select_set(True)
        bpy.context.view_layer.objects.active = mesh_objs[0]
        bpy.ops.object.join()
        mesh = bpy.context.view_layer.objects.active
    else:
        mesh = find_first_mesh(mesh_objs)

    _ensure_armature_modifier(mesh, arm_obj)

    # If nothing matched, at least rigidly bind to body.
    if not mesh.vertex_groups:
        _make_rigid_vertex_groups(mesh, bone_name="DEF-Body")

    try:
        select_only_objects([arm_obj, mesh])
    except Exception:
        pass
    export_gltf(out, fmt=args.export_format, deform_bones_only=True, use_selection=True)


if __name__ == "__main__":
    main()

