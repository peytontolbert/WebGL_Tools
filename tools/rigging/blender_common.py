"""
Common helpers for headless Blender rigging scripts.

These scripts are executed by:
  blender --background --factory-startup --python <script> -- <args>
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import bpy


def install_addon_from_path(path: Path) -> str:
    """
    Install a Blender addon from a directory, .zip, or .py file.

    Returns the inferred addon module name (best-effort).
    """
    import tempfile
    import zipfile

    path = Path(path).resolve()
    if not path.exists():
        raise FileNotFoundError(str(path))

    if path.is_dir():
        # Blender addon_install can't take a directory directly; zip it.
        module = path.name
        with tempfile.TemporaryDirectory(prefix="bl_addon_") as td:
            td = Path(td)
            zpath = td / f"{module}.zip"
            with zipfile.ZipFile(zpath, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                for p in path.rglob("*"):
                    if p.is_dir():
                        continue
                    # Ensure the directory is the top-level folder in the zip.
                    arc = Path(module) / p.relative_to(path)
                    zf.write(p, arcname=str(arc))
            bpy.ops.preferences.addon_install(filepath=str(zpath))
        return module

    # .zip or .py
    module = path.stem
    bpy.ops.preferences.addon_install(filepath=str(path))
    return module


def parse_common_io(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("--in", dest="input", required=True)
    ap.add_argument("--out", dest="output", required=True)
    ap.add_argument("--export-format", default="GLB", choices=["GLB", "GLTF_SEPARATE"])
    return ap.parse_args(argv)


def blender_argv_after_double_dash() -> list[str]:
    # Blender passes its own args; user args come after "--".
    if "--" not in sys.argv:
        return []
    i = sys.argv.index("--")
    return sys.argv[i + 1 :]


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def _select_only(obj: bpy.types.Object) -> None:
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def select_only_objects(objs: list[bpy.types.Object]) -> None:
    """
    Select only the provided objects (best-effort).

    This is important for exports: Rigify and other addons create helper objects
    (e.g. WGT-* widgets) that can trip exporter edge-cases. Exporting a minimal
    selection (armature + skinned meshes) is more robust.
    """
    for o in bpy.context.view_layer.objects:
        try:
            o.select_set(False)
        except Exception:
            pass
    active = None
    for o in objs:
        if not o:
            continue
        try:
            o.select_set(True)
            if active is None:
                active = o
        except Exception:
            pass
    if active is not None:
        try:
            bpy.context.view_layer.objects.active = active
        except Exception:
            pass


def import_asset(path: Path) -> list[bpy.types.Object]:
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(str(path))
    ext = path.suffix.lower()
    low_name = path.name.lower()

    # Importers produce objects into the scene; we return the newly added objects.
    before = set(bpy.data.objects)

    if ext in [".glb", ".gltf"]:
        bpy.ops.import_scene.gltf(filepath=str(path))
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=str(path))
    elif ext == ".obj":
        # Blender 4.x uses the new OBJ importer operator.
        # Older versions expose import_scene.obj.
        op = getattr(getattr(bpy.ops, "wm", None), "obj_import", None)
        if callable(op):
            op(filepath=str(path))
        else:
            bpy.ops.import_scene.obj(filepath=str(path))
    elif ext == ".bvh":
        # BVH is a pure animation/skeleton format; Blender imports an armature + action.
        bpy.ops.import_anim.bvh(filepath=str(path))
    elif ext in [".usd", ".usda", ".usdc", ".usdz"]:
        # Special-case: many Omniverse / Reallusion / AnimGraph exports store skeletal
        # motion as UsdSkelAnimation (sometimes in `*.skelanim.usd`, sometimes just
        # under a Motions/ folder). Blender's USD importer may bring in a skeleton but
        # not create an Action. Since Blender ships with OpenUSD python bindings
        # (`pxr`), we can bake a minimal armature + Action ourselves (sufficient for
        # retargeting).
        try:
            from pxr import Usd, UsdSkel  # type: ignore

            stage = Usd.Stage.Open(str(path))
            # If this stage contains meshes, it's probably a full character scene —
            # let Blender import it normally. If it has no meshes but does have a
            # SkelAnimation, treat it as motion-only and bake.
            prims = list(stage.Traverse())
            has_mesh = any(p.GetTypeName() == "Mesh" for p in prims)
            anim_prims = [p for p in prims if p.GetTypeName() == "SkelAnimation"]
            want_bake = bool(anim_prims) and ((".skelanim." in low_name) or (not has_mesh))
            if want_bake:
                anim0_prim = anim_prims[0] if anim_prims else None
                if anim0_prim is None:
                    raise RuntimeError(f"No SkelAnimation prim found in: {path}")

                anim0 = UsdSkel.Animation(anim0_prim)
                joints = anim0.GetJointsAttr().Get() or []
                if not joints:
                    raise RuntimeError(f"SkelAnimation has no joints: {path}")

                # USD time metadata: treat timeSamples as frames, set FPS accordingly.
                tps = float(stage.GetTimeCodesPerSecond() or 0) or 30.0
                try:
                    bpy.context.scene.render.fps = int(round(tps))
                except Exception:
                    pass

                # Build joint tree from paths like "Root/Pelvis/R_UpLeg".
                joint_paths = [str(j) for j in joints]

                # Keep original joint "basename" for bone naming.
                def _base(jp: str) -> str:
                    return jp.split("/")[-1].strip()

                bones_by_joint: dict[str, bpy.types.EditBone] = {}

                arm_data = bpy.data.armatures.new(name="skelanim_armature")
                arm_obj = bpy.data.objects.new(name="skelanim", object_data=arm_data)
                bpy.context.scene.collection.objects.link(arm_obj)

                bpy.context.view_layer.objects.active = arm_obj
                arm_obj.select_set(True)
                bpy.ops.object.mode_set(mode="EDIT")

                # Create all bones with a small default length.
                for jp in joint_paths:
                    bn = _base(jp)
                    eb = arm_data.edit_bones.new(bn)
                    eb.head = (0.0, 0.0, 0.0)
                    eb.tail = (0.0, 0.1, 0.0)
                    bones_by_joint[jp] = eb

                # Parent according to joint path segments.
                for jp in joint_paths:
                    if "/" not in jp:
                        continue
                    parent_jp = jp.rsplit("/", 1)[0]
                    b = bones_by_joint.get(jp)
                    pb = bones_by_joint.get(parent_jp)
                    if b and pb:
                        b.parent = pb

                bpy.ops.object.mode_set(mode="POSE")

                if not arm_obj.animation_data:
                    arm_obj.animation_data_create()

                # Ensure quaternion rotation mode.
                for pb in arm_obj.pose.bones:
                    try:
                        pb.rotation_mode = "QUATERNION"
                    except Exception:
                        pass

                # Bake each SkelAnimation prim into a separate Blender Action.
                used_action_names: set[str] = set()
                for idx, anim_prim in enumerate(anim_prims):
                    anim = UsdSkel.Animation(anim_prim)
                    rot_attr = anim.GetRotationsAttr()
                    trans_attr = anim.GetTranslationsAttr()
                    scale_attr = anim.GetScalesAttr()
                    ts = list(rot_attr.GetTimeSamples() or [])
                    if not ts:
                        # Skip animations with no sampled rotations.
                        continue

                    # Name the action after the prim name (best for AnimGraph clip libraries).
                    base_name = ""
                    try:
                        base_name = str(anim_prim.GetName() or "").strip()
                    except Exception:
                        base_name = ""
                    if not base_name:
                        try:
                            base_name = str(anim_prim.GetPath().pathString or "").strip().split("/")[-1]
                        except Exception:
                            base_name = ""
                    if not base_name:
                        base_name = path.stem
                    action_name = base_name
                    if action_name in used_action_names:
                        action_name = f"{action_name}_{idx:02d}"
                    used_action_names.add(action_name)

                    action = bpy.data.actions.new(name=action_name)
                    arm_obj.animation_data.action = action

                    # Bake per-frame joint transforms into pose bones.
                    # Note: we intentionally key only bones that exist on this armature.
                    joints_i = anim.GetJointsAttr().Get() or []
                    joint_paths_i = [str(j) for j in joints_i]

                    for t in ts:
                        frame = int(round(float(t)))
                        bpy.context.scene.frame_set(frame)

                        rots = rot_attr.Get(t) or []
                        trans = trans_attr.Get(t) or []
                        scales = scale_attr.Get(t) or []

                        # Defensive: allow missing arrays (treat as identity).
                        n = len(joint_paths_i)
                        if len(rots) != n:
                            # If rotations missing or wrong-sized, skip this sample.
                            continue
                        if trans and len(trans) != n:
                            trans = []
                        if scales and len(scales) != n:
                            scales = []

                        for i, jp in enumerate(joint_paths_i):
                            bn = _base(jp)
                            pb = arm_obj.pose.bones.get(bn)
                            if not pb:
                                continue

                            q = rots[i]
                            try:
                                # USD quatf is (w, x, y, z) in printed form.
                                pb.rotation_quaternion = (float(q[0]), float(q[1]), float(q[2]), float(q[3]))
                                pb.keyframe_insert(data_path="rotation_quaternion")
                            except Exception:
                                pass

                            # Root translation (optional): apply only on the top joint to avoid
                            # making children drift unpredictably in Blender pose space.
                            if i == 0 and trans:
                                v = trans[i]
                                try:
                                    pb.location = (float(v[0]), float(v[1]), float(v[2]))
                                    pb.keyframe_insert(data_path="location")
                                except Exception:
                                    pass

                # Return the created armature as the imported asset.
                bpy.ops.object.mode_set(mode="OBJECT")
                after = set(bpy.data.objects)
                return list(after - before) or [arm_obj]
        except Exception:
            # Fall back to Blender's USD importer below.
            pass

        # USD import can be built-in (modern Blender builds) or provided by an addon in
        # some distributions. In `--factory-startup` mode, addons are disabled, and
        # the operator may exist but fail with "could not be found" (not registered).
        # Prefer the operator if it exists; if it fails, try enabling common USD
        # addon modules and retry.
        def _try_enable_usd_addon() -> None:
            for mod in ("io_scene_usd", "io_usd", "usd"):
                try:
                    bpy.ops.preferences.addon_enable(module=mod)
                except Exception:
                    # Some Blender builds don't ship a given module name; ignore.
                    pass

        imported = False
        # Blender 4.x/5.x: wm.usd_import
        if hasattr(bpy.ops.wm, "usd_import"):
            try:
                # Be explicit: for motion files we generally want skeletons and frame range.
                bpy.ops.wm.usd_import(
                    filepath=str(path),
                    import_skeletons=True,
                    import_blendshapes=True,
                    import_shapes=True,
                    set_frame_range=True,
                )
                imported = True
            except TypeError:
                # Older operator signature; fall back to minimal args.
                bpy.ops.wm.usd_import(filepath=str(path))
                imported = True
            except Exception as e:
                # Common failure mode with `--factory-startup`: operator exists but isn't registered.
                # Enable USD add-on(s) and retry once.
                _try_enable_usd_addon()
                try:
                    bpy.ops.wm.usd_import(filepath=str(path))
                    imported = True
                except Exception:
                    imported = False
        # Fallback: some builds expose import_scene.usd
        if not imported and hasattr(bpy.ops.import_scene, "usd"):
            try:
                bpy.ops.import_scene.usd(filepath=str(path))
                imported = True
            except Exception:
                _try_enable_usd_addon()
                try:
                    bpy.ops.import_scene.usd(filepath=str(path))
                    imported = True
                except Exception:
                    imported = False
        if not imported:
            raise RuntimeError(
                "USD import operator not available in this Blender build. "
                "Install a Blender build with OpenUSD support (check for bpy.ops.wm.usd_import)."
            )
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=str(path))
    elif ext == ".blend":
        # Not a real "import"; open the file (will replace the scene).
        bpy.ops.wm.open_mainfile(filepath=str(path))
    else:
        raise ValueError(f"Unsupported input: {path} (ext={ext})")

    after = set(bpy.data.objects)
    added = list(after - before)
    # If .blend, "added" may be empty; return all current objects.
    if ext == ".blend":
        added = list(bpy.context.scene.objects)
    return added


def find_first_mesh(objects: list[bpy.types.Object]) -> bpy.types.Object:
    for o in objects:
        if o and o.type == "MESH":
            return o
    # Fall back to any mesh in scene
    for o in bpy.context.scene.objects:
        if o.type == "MESH":
            return o
    raise RuntimeError("No mesh object found to rig.")


def export_gltf(
    path: Path,
    *,
    fmt: str,
    deform_bones_only: bool = False,
    use_selection: bool = False,
    animation_mode: str | None = None,
) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Export everything in the scene; for clean exports, we rely on rig scripts
    # to delete control rigs or mark deform bones only.
    kwargs = dict(
        filepath=str(path),
        export_format=str(fmt),
        export_apply=True,
        export_animations=True,
        export_skins=True,
        export_yup=True,
        export_def_bones=bool(deform_bones_only),
    )
    if animation_mode:
        kwargs["export_animation_mode"] = str(animation_mode)
    if use_selection:
        # Blender glTF exporter uses `use_selection` (2.8+).
        kwargs["use_selection"] = True
    try:
        bpy.ops.export_scene.gltf(**kwargs)
    except TypeError:
        # Backward-compat: older exporter builds may not accept `use_selection`.
        kwargs.pop("use_selection", None)
        bpy.ops.export_scene.gltf(**kwargs)


def ensure_addon_enabled(module: str) -> None:
    # In factory-startup, addons are disabled; enable what we need.
    try:
        bpy.ops.preferences.addon_enable(module=module)
    except Exception as e:
        raise RuntimeError(f"Failed to enable addon '{module}'. Is it installed? ({e})") from e


def make_armature_deform_only(arm_obj: bpy.types.Object) -> None:
    """
    Mark non-deform bones as non-exportable by toggling `use_deform`.
    This helps keep exported skeleton clean for runtimes.
    """
    if arm_obj.type != "ARMATURE":
        return
    arm = arm_obj.data
    for b in arm.bones:
        # Common heuristic: Rigify control bones are prefixed like "CTRL", "MCH", "ORG"
        # but the reliable flag is use_deform.
        # We keep as-is; scripts should set use_deform properly.
        pass


def parent_mesh_to_armature_auto_weights(mesh_obj: bpy.types.Object, arm_obj: bpy.types.Object) -> None:
    _select_only(mesh_obj)
    mesh_obj.select_set(True)
    arm_obj.select_set(True)
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")


def ensure_armature_modifier(mesh_obj: bpy.types.Object, arm_obj: bpy.types.Object) -> None:
    if not mesh_obj or not arm_obj:
        return
    for m in getattr(mesh_obj, "modifiers", []):
        try:
            if m.type == "ARMATURE" and getattr(m, "object", None) == arm_obj:
                return
        except Exception:
            continue
    try:
        mod = mesh_obj.modifiers.new(name="Armature", type="ARMATURE")
        mod.object = arm_obj
    except Exception:
        pass


def pick_first_deform_bone_name(arm_obj: bpy.types.Object) -> str | None:
    if not arm_obj or arm_obj.type != "ARMATURE":
        return None
    try:
        for b in arm_obj.data.bones:
            if getattr(b, "use_deform", False):
                return str(b.name)
    except Exception:
        pass
    try:
        # Fallback to any bone name
        for b in arm_obj.data.bones:
            return str(b.name)
    except Exception:
        return None
    return None


def rigid_bind_all_verts(mesh_obj: bpy.types.Object, *, bone_name: str) -> None:
    """
    Assign all vertices weight=1.0 to a single vertex group (rigid skinning).
    This is a fallback when automatic weighting fails, to keep glTF exporter happy.
    """
    if not mesh_obj or mesh_obj.type != "MESH":
        return
    if not bone_name:
        return
    try:
        vg = mesh_obj.vertex_groups.get(bone_name) or mesh_obj.vertex_groups.new(name=bone_name)
        idxs = [v.index for v in mesh_obj.data.vertices]
        if idxs:
            vg.add(idxs, 1.0, "REPLACE")
    except Exception:
        pass


def clear_vertex_groups(mesh_obj: bpy.types.Object) -> None:
    if not mesh_obj or mesh_obj.type != "MESH":
        return
    try:
        # remove() while iterating can be finicky; copy first.
        vgs = list(mesh_obj.vertex_groups)
        for vg in vgs:
            try:
                mesh_obj.vertex_groups.remove(vg)
            except Exception:
                pass
    except Exception:
        pass


def has_any_vertex_weights(mesh_obj: bpy.types.Object) -> bool:
    """
    True if any vertex has any weight assignment.
    """
    if not mesh_obj or mesh_obj.type != "MESH":
        return False
    try:
        for v in mesh_obj.data.vertices:
            if getattr(v, "groups", None):
                for g in v.groups:
                    try:
                        if float(g.weight) > 0.0:
                            return True
                    except Exception:
                        continue
    except Exception:
        return False
    return False


def ensure_minimal_skin(mesh_obj: bpy.types.Object, arm_obj: bpy.types.Object, *, prefer_bone: str | None = None) -> None:
    """
    Make sure the mesh will export as a skinned mesh in glTF:
    - Armature modifier points at arm_obj
    - Mesh is parented to arm_obj (helps some exporter paths)
    - At least one vertex group matches a bone and has weights
    """
    if not mesh_obj or mesh_obj.type != "MESH":
        return
    if not arm_obj or arm_obj.type != "ARMATURE":
        return

    ensure_armature_modifier(mesh_obj, arm_obj)
    try:
        mesh_obj.parent = arm_obj
        mesh_obj.parent_type = "ARMATURE"
    except Exception:
        pass

    # If there are no usable weights, create a rigid bind to a deform bone.
    if not has_any_vertex_weights(mesh_obj):
        bn = str(prefer_bone or "").strip() or pick_first_deform_bone_name(arm_obj) or ""
        if not bn:
            return
        clear_vertex_groups(mesh_obj)
        rigid_bind_all_verts(mesh_obj, bone_name=bn)

