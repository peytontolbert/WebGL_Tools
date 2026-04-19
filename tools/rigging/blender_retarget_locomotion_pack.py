from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

import bpy

from blender_common import (
    blender_argv_after_double_dash,
    export_gltf,
    import_asset,
    reset_scene,
    select_only_objects,
)

def _rest_quat(arm_obj: bpy.types.Object, bone_name: str):
    """
    Return bone rest rotation as a quaternion in the bone's *local* space (best-effort).
    (i.e. parent-relative, which is the same space `PoseBone.matrix_basis` lives in.)

    Used to build a simple axis-alignment offset between mismatched rigs without
    needing a full retarget solver.
    """
    try:
        b = arm_obj.data.bones.get(str(bone_name))
        if b is None:
            return None
        # Bone.matrix_local is in armature space. Convert to parent-relative so it matches
        # PoseBone.matrix_basis' convention (delta from rest in local bone space).
        m = b.matrix_local.copy()
        if b.parent is not None:
            try:
                m = b.parent.matrix_local.inverted() @ m
            except Exception:
                # If parent inversion fails, fall back to armature space.
                pass
        return m.to_quaternion()
    except Exception:
        return None


def _build_rest_offsets(src_arm: bpy.types.Object, dst_arm: bpy.types.Object, mapping: dict) -> dict:
    """
    Build per-bone quaternion offsets to compensate for rest-pose axis differences.
    We treat pose rotations as deltas from rest:
      pose = rest * delta
    and want:
      rest_dst * delta_dst ≈ rest_src * delta_src
    therefore:
      delta_dst ≈ inv(rest_dst) * rest_src * delta_src
    This is not a full retarget solution, but it fixes the common "frozen/garbage"
    result from naive quaternion copy when bone local axes differ.
    """
    out = {"root": None, "bones": {}}
    root_map = mapping.get("root") or {}
    if isinstance(root_map, dict):
        src_root = str(root_map.get("source") or "").strip()
        dst_root = str(root_map.get("target") or "").strip()
        if src_root and dst_root:
            qs = _rest_quat(src_arm, src_root)
            qd = _rest_quat(dst_arm, dst_root)
            if qs is not None and qd is not None:
                try:
                    out["root"] = qd.inverted() @ qs
                except Exception:
                    out["root"] = None

    bones = mapping.get("bones") or []
    if isinstance(bones, list):
        for ent in bones:
            if not isinstance(ent, dict):
                continue
            sname = str(ent.get("source") or "").strip()
            tname = str(ent.get("target") or "").strip()
            if not sname or not tname:
                continue
            qs = _rest_quat(src_arm, sname)
            qd = _rest_quat(dst_arm, tname)
            if qs is None or qd is None:
                continue
            try:
                out["bones"][tname] = qd.inverted() @ qs
            except Exception:
                pass
    return out


def _parse(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="blender_retarget_locomotion_pack.py")
    ap.add_argument("--rig", required=True, help="Target rig asset (glb/gltf/fbx/blend).")
    ap.add_argument("--map", required=True, help="Mapping json path.")
    ap.add_argument("--clips-json", required=True, help="JSON file describing clips to retarget.")
    ap.add_argument("--out", required=True, help="Output glTF/GLB path (contains multiple actions).")
    ap.add_argument("--export-format", default="GLB", choices=["GLB", "GLTF_SEPARATE"])
    ap.add_argument("--include-mesh", default="1", help="Include target mesh in output (1/0).")
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


def _find_meshes(objs: list[bpy.types.Object]) -> list[bpy.types.Object]:
    out: list[bpy.types.Object] = []
    for o in objs:
        if o and o.type == "MESH":
            out.append(o)
    # include meshes already in scene if .blend was opened
    for o in bpy.context.scene.objects:
        if o.type == "MESH" and o not in out:
            out.append(o)
    return out


def _load_mapping(path: Path) -> dict:
    obj = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(obj, dict):
        raise ValueError("mapping must be a JSON object")
    root = obj.get("root") or {}
    bones = obj.get("bones") or []
    if not isinstance(root, dict) or not isinstance(bones, list):
        raise ValueError("mapping must contain { root: {...}, bones: [...] }")
    return obj


def _ensure_pose_quat(pbone: bpy.types.PoseBone) -> None:
    try:
        pbone.rotation_mode = "QUATERNION"
    except Exception:
        pass


def _frame_range_from_action(action: bpy.types.Action) -> tuple[int, int]:
    fr = action.frame_range
    return int(round(fr[0])), int(round(fr[1]))


def _safe_int(v, default: int | None) -> int | None:
    if v is None:
        return default
    s = str(v).strip()
    if not s:
        return default
    try:
        return int(s)
    except Exception:
        return default


def _pick_action_for_armature(src_arm: bpy.types.Object, want: str) -> bpy.types.Action:
    want = str(want or "").strip()
    src_action = None
    acts = list(bpy.data.actions)

    def _fallback_first_action() -> bpy.types.Action | None:
        if src_arm.animation_data and src_arm.animation_data.action:
            return src_arm.animation_data.action
        if acts:
            return acts[0]
        return None

    if want:
        src_action = next((a for a in acts if a.name == want), None)
        if src_action is None:
            low = want.lower()
            src_action = next((a for a in acts if a.name.lower() == low), None)
        if src_action is None:
            low = want.lower()
            src_action = next((a for a in acts if low in a.name.lower()), None)
        if src_action is None:
            names = [a.name for a in acts]
            fb = _fallback_first_action()
            if fb is None:
                raise RuntimeError(f"Requested motion clip not found: '{want}'. Available actions: {names[:40]}")
            print(
                f"[retarget-pack] warning: requested motion clip '{want}' not found; "
                f"using fallback action '{fb.name}'. Available actions: {names[:40]}"
            )
            src_action = fb

    if src_action is None and src_arm.animation_data and src_arm.animation_data.action:
        src_action = src_arm.animation_data.action
    if src_action is None and acts:
        src_action = acts[0]
    if src_action is None:
        raise RuntimeError("No animation action found on source motion.")

    if not src_arm.animation_data:
        src_arm.animation_data_create()
    src_arm.animation_data.action = src_action
    _bind_action_to_armature(src_arm, src_action)
    return src_action


def _apply_pose_sample(
    *,
    src_arm: bpy.types.Object,
    dst_arm: bpy.types.Object,
    mapping: dict,
    copy_root_location: bool,
    offsets: dict | None = None,
) -> None:
    src_pose = src_arm.pose
    dst_pose = dst_arm.pose

    root_map = mapping.get("root") or {}
    bones = mapping.get("bones") or []

    if isinstance(root_map, dict):
        src_root = str(root_map.get("source") or "").strip()
        dst_root = str(root_map.get("target") or "").strip()
        if src_root and dst_root:
            sp = src_pose.bones.get(src_root)
            dp = dst_pose.bones.get(dst_root)
            if sp and dp:
                # NOTE: BVH imports often animate rotation_euler, leaving rotation_quaternion at identity.
                # Read the evaluated delta from rest via matrix_basis instead.
                _ensure_pose_quat(dp)
                try:
                    q = sp.matrix_basis.to_quaternion().copy()
                except Exception:
                    q = sp.rotation_quaternion.copy()
                qoff = None
                try:
                    qoff = (offsets or {}).get("root")
                except Exception:
                    qoff = None
                if qoff is not None:
                    try:
                        q = qoff @ q
                    except Exception:
                        pass
                dp.rotation_quaternion = q
                if copy_root_location:
                    dp.location = sp.location.copy()

    for ent in bones:
        if not isinstance(ent, dict):
            continue
        sname = str(ent.get("source") or "").strip()
        tname = str(ent.get("target") or "").strip()
        if not sname or not tname:
            continue
        sp = src_pose.bones.get(sname)
        dp = dst_pose.bones.get(tname)
        if not sp or not dp:
            continue
        _ensure_pose_quat(dp)
        try:
            q = sp.matrix_basis.to_quaternion().copy()
        except Exception:
            q = sp.rotation_quaternion.copy()
        qoff = None
        try:
            qoff = ((offsets or {}).get("bones") or {}).get(tname)
        except Exception:
            qoff = None
        if qoff is not None:
            try:
                q = qoff @ q
            except Exception:
                pass
        dp.rotation_quaternion = q


def _keyframe_pose(dst_arm: bpy.types.Object, mapping: dict, *, frame: int, key_root_location: bool) -> None:
    pose = dst_arm.pose

    root_map = mapping.get("root") or {}
    bones = mapping.get("bones") or []

    if isinstance(root_map, dict):
        dst_root = str(root_map.get("target") or "").strip()
        if dst_root:
            dp = pose.bones.get(dst_root)
            if dp:
                dp.keyframe_insert(data_path="rotation_quaternion", frame=frame)
                if key_root_location:
                    dp.keyframe_insert(data_path="location", frame=frame)

    for ent in bones:
        if not isinstance(ent, dict):
            continue
        tname = str(ent.get("target") or "").strip()
        if not tname:
            continue
        dp = pose.bones.get(tname)
        if not dp:
            continue
        dp.keyframe_insert(data_path="rotation_quaternion", frame=frame)


def _load_clips_spec(path: Path) -> list[dict]:
    obj = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(obj, dict) and isinstance(obj.get("clips"), list):
        clips = obj.get("clips") or []
    elif isinstance(obj, list):
        clips = obj
    else:
        raise ValueError("clips-json must be either an array or { clips: [...] }")

    out: list[dict] = []
    for ent in clips:
        if not isinstance(ent, dict):
            continue
        clip_name = str(ent.get("clipName") or ent.get("name") or "").strip()
        motion_path = str(ent.get("motionPath") or ent.get("motion") or "").strip()
        if not clip_name or not motion_path:
            continue
        out.append(ent)

    if not out:
        raise ValueError("clips-json contained no valid clips (need clipName + motionPath)")
    return out


def _remove_imported_objects(objs: list[bpy.types.Object]) -> None:
    for o in objs or []:
        if not o:
            continue
        try:
            bpy.data.objects.remove(o, do_unlink=True)
        except Exception:
            try:
                o.hide_set(True)
            except Exception:
                pass


def _bind_action_to_armature(arm_obj: bpy.types.Object, action: bpy.types.Action) -> None:
    """
    Blender 5 uses action slots. Ensure the armature's animation_data is bound to a
    compatible slot on the action so exporters can discover the animation.
    """
    if not arm_obj or arm_obj.type != "ARMATURE" or not action:
        return
    if not arm_obj.animation_data:
        arm_obj.animation_data_create()
    ad = arm_obj.animation_data
    if ad is None:
        return
    try:
        ad.action = action
    except Exception:
        return
    # Legacy Blender path (no action slots).
    if not hasattr(action, "slots") or not hasattr(ad, "action_slot"):
        return
    slot = None
    try:
        for s in action.slots:
            if str(getattr(s, "target_id_type", "")).upper() == "OBJECT":
                slot = s
                break
    except Exception:
        slot = None
    if slot is None:
        try:
            slot = action.slots.new("OBJECT", str(getattr(arm_obj, "name", "Armature") or "Armature"))
        except Exception:
            slot = None
    if slot is not None:
        try:
            ad.action_slot = slot
        except Exception:
            pass


def _build_nla_from_actions(dst_arm: bpy.types.Object, actions: list[bpy.types.Action]) -> None:
    """
    Push each baked action to NLA using Blender's operator path so strips carry
    valid action slots in Blender 5+ (manual strip construction can yield
    strip.action_slot=None and crash glTF export).
    """
    if not dst_arm or dst_arm.type != "ARMATURE":
        return
    if not dst_arm.animation_data:
        dst_arm.animation_data_create()
    ad = dst_arm.animation_data
    if ad is None:
        return
    # Clear existing NLA tracks.
    for tr in list(ad.nla_tracks):
        try:
            ad.nla_tracks.remove(tr)
        except Exception:
            pass
    # Ensure context for pushdown.
    try:
        bpy.ops.object.mode_set(mode="OBJECT")
    except Exception:
        pass
    try:
        bpy.context.view_layer.objects.active = dst_arm
        dst_arm.select_set(True)
    except Exception:
        pass

    for act in actions:
        if not act:
            continue
        try:
            act.use_fake_user = True
        except Exception:
            pass
        try:
            ad.action = act
        except Exception:
            continue
        pushed = False
        try:
            bpy.ops.nla.action_pushdown(channel_index=0)
            pushed = True
        except Exception:
            try:
                bpy.ops.nla.action_pushdown()
                pushed = True
            except Exception:
                pushed = False
        if pushed:
            try:
                # Last track is the one just pushed.
                tr = ad.nla_tracks[-1]
                tr.name = str(act.name or tr.name)
                tr.mute = False
                tr.lock = False
            except Exception:
                pass
    try:
        ad.action = None
    except Exception:
        pass


def main() -> None:
    args = _parse(blender_argv_after_double_dash())
    rig_path = Path(args.rig).resolve()
    map_path = Path(args.map).resolve()
    clips_json_path = Path(args.clips_json).resolve()
    out_path = Path(args.out).resolve()
    include_mesh = _safe_bool01(args.include_mesh)

    reset_scene()

    default_mapping = _load_mapping(map_path)
    clips_spec = _load_clips_spec(clips_json_path)

    # Import target rig first.
    rig_objs = import_asset(rig_path)
    dst_arm = _find_first_armature(rig_objs)
    if dst_arm is None or dst_arm.type != "ARMATURE":
        raise RuntimeError("Target rig import did not produce an armature.")
    dst_meshes = _find_meshes(rig_objs)
    # Many generated/converted character rigs include an extra "Background" mesh
    # (a billboard plane with the source image background baked in). It should
    # not ship as part of the character mesh.
    try:
        dst_meshes = [m for m in dst_meshes if "background" not in str(getattr(m, "name", "") or "").strip().lower()]
    except Exception:
        pass

    # Keep only the destination actions we create.
    keep_actions: list[bpy.types.Action] = []

    for i, ent in enumerate(clips_spec):
        clip_name = str(ent.get("clipName") or ent.get("name") or "").strip()
        motion_path = Path(str(ent.get("motionPath") or ent.get("motion") or "")).resolve()
        motion_clip = str(ent.get("motionClip") or "").strip()
        map_override = str(ent.get("mapPath") or ent.get("map") or "").strip()
        fps = _safe_int(ent.get("fps"), None)
        start = _safe_int(ent.get("start"), None)
        end = _safe_int(ent.get("end"), None)
        root_motion = _safe_bool01(ent.get("rootMotion", "0"))

        mapping = default_mapping
        if map_override:
            try:
                mapping = _load_mapping(Path(map_override).resolve())
            except Exception as e:
                raise RuntimeError(f"Failed to load mapPath for clip {i} ({clip_name}): {map_override} ({e})")

        if fps and fps > 0:
            try:
                bpy.context.scene.render.fps = int(fps)
            except Exception:
                pass

        # Import motion (source armature + action).
        motion_objs = import_asset(motion_path)
        src_arm = _find_first_armature(motion_objs)
        if src_arm is None or src_arm.type != "ARMATURE":
            _remove_imported_objects(motion_objs)
            raise RuntimeError(f"Motion import did not produce an armature for clip {i}: {motion_path}")

        src_action = _pick_action_for_armature(src_arm, motion_clip)
        offsets = _build_rest_offsets(src_arm, dst_arm, mapping)
        src_start, src_end = _frame_range_from_action(src_action)
        s0 = _safe_int(start, src_start)
        s1 = _safe_int(end, src_end)
        if s0 is None or s1 is None:
            s0, s1 = src_start, src_end
        s0 = int(s0)
        s1 = int(s1)
        if s1 < s0:
            s0, s1 = s1, s0

        # Create destination action on target rig.
        dst_action = bpy.data.actions.new(name=clip_name)
        keep_actions.append(dst_action)
        if not dst_arm.animation_data:
            dst_arm.animation_data_create()
        dst_arm.animation_data.action = dst_action
        _bind_action_to_armature(dst_arm, dst_action)

        # Bake by sampling every source frame, but write keys into a normalized frame range starting at 1.
        dst_frame = 1
        for src_frame in range(s0, s1 + 1):
            bpy.context.scene.frame_set(src_frame)
            _apply_pose_sample(
                src_arm=src_arm,
                dst_arm=dst_arm,
                mapping=mapping,
                copy_root_location=root_motion,
                offsets=offsets,
            )
            _keyframe_pose(dst_arm, mapping, frame=dst_frame, key_root_location=root_motion)
            dst_frame += 1
        try:
            dst_action.use_fake_user = True
        except Exception:
            pass

        # Clean up imported motion objects to keep exports clean.
        try:
            # If the source action isn't needed anymore, remove it.
            bpy.data.actions.remove(src_action)
        except Exception:
            pass
        _remove_imported_objects(motion_objs)

    # Remove any actions not created for the pack (prevents exporting junk actions).
    keep = set(keep_actions)
    for act in list(bpy.data.actions):
        if act not in keep:
            try:
                bpy.data.actions.remove(act)
            except Exception:
                pass

    # Ensure all baked actions are slot-bound to the target armature first.
    for act in keep_actions:
        _bind_action_to_armature(dst_arm, act)

    # Clear NLA tracks across armatures before ACTIONS export. Imported rigs can
    # carry stale strips with null action slots that crash Blender 5's glTF
    # ACTIONS gatherer or cause animation loss.
    for obj in list(bpy.context.scene.objects):
        if not obj or obj.type != "ARMATURE":
            continue
        if not obj.animation_data:
            continue
        ad = obj.animation_data
        try:
            ad.action = None
        except Exception:
            pass
        for tr in list(ad.nla_tracks):
            try:
                ad.nla_tracks.remove(tr)
            except Exception:
                pass

    # Keep a sensible scene range for exporters/tools that inspect timeline.
    try:
        bpy.context.scene.frame_start = 1
        if keep_actions:
            max_end = 1
            for act in keep_actions:
                try:
                    _, a_end = _frame_range_from_action(act)
                    max_end = max(max_end, int(a_end))
                except Exception:
                    pass
            bpy.context.scene.frame_end = max_end
    except Exception:
        pass
    # Export selection only.
    to_export: list[bpy.types.Object] = [dst_arm]
    if include_mesh:
        for m in dst_meshes:
            if m not in to_export:
                to_export.append(m)
    try:
        select_only_objects(to_export)
    except Exception:
        pass

    export_gltf(
        out_path,
        fmt=args.export_format,
        deform_bones_only=False,
        use_selection=True,
        animation_mode="ACTIONS",
    )


if __name__ == "__main__":
    main()

