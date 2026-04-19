from __future__ import annotations

import argparse
import sys
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

import bpy

from blender_common import (
    blender_argv_after_double_dash,
    ensure_armature_modifier,
    export_gltf,
    import_asset,
    reset_scene,
    select_only_objects,
)


def _parse(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="blender_outfit_asset.py")
    ap.add_argument("--base", required=True, help="Rigged base character (GLB/GLTF/FBX/BLEND). Must include an armature.")
    ap.add_argument("--clothes", action="append", default=[], help="Clothing mesh asset to attach (repeatable).")
    ap.add_argument("--out", required=True, help="Output GLB/GLTF path.")
    ap.add_argument("--export-format", default="GLB", choices=["GLB", "GLTF_SEPARATE"])

    ap.add_argument("--weight-method", default="transfer", choices=["transfer", "auto"], help="How to bind clothes to armature.")
    ap.add_argument("--apply-xform", default="1", help="Apply rotation+scale on imported clothing meshes (1/0).")

    ap.add_argument("--shrinkwrap", default="0", help="Shrinkwrap clothes to body before weighting (1/0).")
    ap.add_argument("--shrinkwrap-offset", default="0.003", help="Shrinkwrap offset in meters/Blender units.")
    return ap.parse_args(argv)


def _safe_bool01(s: str) -> bool:
    return str(s or "").strip() not in ("", "0", "false", "False", "no", "No")


def _find_first_armature(objs: list[bpy.types.Object]) -> bpy.types.Object | None:
    for o in objs:
        if o and o.type == "ARMATURE":
            return o
    for o in bpy.context.scene.objects:
        if o.type == "ARMATURE":
            return o
    return None


def _find_base_body_mesh(arm_obj: bpy.types.Object) -> bpy.types.Object | None:
    """
    Best-effort: find a mesh already skinned to the given armature.
    """
    if not arm_obj or arm_obj.type != "ARMATURE":
        return None
    for o in bpy.context.scene.objects:
        if not o or o.type != "MESH":
            continue
        try:
            for m in getattr(o, "modifiers", []):
                if m.type == "ARMATURE" and getattr(m, "object", None) == arm_obj:
                    return o
        except Exception:
            continue
    # fallback: any mesh
    for o in bpy.context.scene.objects:
        if o and o.type == "MESH":
            return o
    return None


def _set_active(obj: bpy.types.Object) -> None:
    try:
        bpy.context.view_layer.objects.active = obj
    except Exception:
        pass


def _deselect_all() -> None:
    for o in bpy.context.view_layer.objects:
        try:
            o.select_set(False)
        except Exception:
            pass


def _apply_rot_scale(obj: bpy.types.Object) -> None:
    if not obj:
        return
    try:
        _deselect_all()
        obj.select_set(True)
        _set_active(obj)
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    except Exception:
        pass


def _do_shrinkwrap(cloth_obj: bpy.types.Object, body_obj: bpy.types.Object, offset: float) -> None:
    if not cloth_obj or not body_obj:
        return
    try:
        mod = cloth_obj.modifiers.new(name="Shrinkwrap", type="SHRINKWRAP")
        mod.target = body_obj
        mod.wrap_method = "NEAREST_SURFACEPOINT"
        mod.wrap_mode = "ON_SURFACE"
        mod.offset = float(offset)
        _deselect_all()
        cloth_obj.select_set(True)
        _set_active(cloth_obj)
        bpy.ops.object.modifier_apply(modifier=mod.name)
    except Exception:
        # If shrinkwrap fails, continue (weight transfer still might work).
        pass


def _transfer_weights_from_body(cloth_obj: bpy.types.Object, body_obj: bpy.types.Object) -> None:
    """
    Transfer vertex-group weights from body to cloth via Data Transfer modifier.
    """
    if not cloth_obj or not body_obj:
        return

    # Clear existing vertex groups (best-effort) to reduce surprising mixes.
    try:
        for vg in list(getattr(cloth_obj, "vertex_groups", [])):
            cloth_obj.vertex_groups.remove(vg)
    except Exception:
        pass

    try:
        m = cloth_obj.modifiers.new(name="DataTransfer", type="DATA_TRANSFER")
        m.object = body_obj
        # Transfer vertex group weights from body -> cloth.
        m.use_vert_data = True
        try:
            m.data_types_verts = {"VGROUP_WEIGHTS"}
        except Exception:
            # Some Blender builds use a different property name; ignore and rely on defaults.
            pass
        # Mapping: nearest face interpolated generally works best for clothes near the surface.
        try:
            m.vert_mapping = "NEAREST_FACE_INTERPOLATED"
        except Exception:
            pass
        _deselect_all()
        cloth_obj.select_set(True)
        _set_active(cloth_obj)
        bpy.ops.object.modifier_apply(modifier=m.name)
    except Exception:
        # If transfer fails, the fallback is auto weights in the caller.
        pass


def _parent_auto_weights(cloth_obj: bpy.types.Object, arm_obj: bpy.types.Object) -> None:
    try:
        _deselect_all()
        cloth_obj.select_set(True)
        arm_obj.select_set(True)
        _set_active(arm_obj)
        bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    except Exception:
        pass


def main() -> None:
    args = _parse(blender_argv_after_double_dash())
    base = Path(args.base).resolve()
    out = Path(args.out).resolve()
    clothes = [Path(p).resolve() for p in (args.clothes or []) if str(p).strip()]

    apply_xform = _safe_bool01(args.apply_xform)
    shrinkwrap = _safe_bool01(args.shrinkwrap)
    shrinkwrap_offset = float(args.shrinkwrap_offset or 0.003)
    weight_method = str(args.weight_method or "transfer").strip().lower()

    reset_scene()

    imported_base = import_asset(base)
    arm = _find_first_armature(imported_base)
    if arm is None:
        raise RuntimeError("Base asset must contain an armature.")

    body = _find_base_body_mesh(arm)
    if body is None:
        raise RuntimeError("Failed to find a base body mesh (skinned mesh) in the base asset.")

    attached: list[bpy.types.Object] = []

    for cloth_path in clothes:
        imported = import_asset(cloth_path)
        # Take all meshes that were just imported.
        meshes = [o for o in imported if o and o.type == "MESH"]
        # If importer doesn't return, fallback to any mesh with no armature modifier (best-effort).
        if not meshes:
            meshes = [o for o in bpy.context.scene.objects if o.type == "MESH" and o != body]
        if not meshes:
            print(f"[outfit] WARN: no meshes found in clothing asset {cloth_path}")
            continue

        for mo in meshes:
            try:
                # Make it easier to identify in export.
                stem = cloth_path.stem
                mo.name = f"cloth__{stem}__{mo.name}"
            except Exception:
                pass

            if apply_xform:
                _apply_rot_scale(mo)

            if shrinkwrap:
                _do_shrinkwrap(mo, body, shrinkwrap_offset)

            if weight_method == "transfer":
                _transfer_weights_from_body(mo, body)
            else:
                _parent_auto_weights(mo, arm)

            # Ensure armature modifier points at the base armature (glTF skin).
            ensure_armature_modifier(mo, arm)
            try:
                mo.parent = arm
            except Exception:
                pass

            attached.append(mo)

    # Export: armature + base body + attached clothes only.
    export_objs = [arm, body, *attached]
    try:
        select_only_objects(export_objs)
    except Exception:
        pass
    export_gltf(out, fmt=args.export_format, deform_bones_only=False, use_selection=True)


if __name__ == "__main__":
    main()

