from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

import bpy

from blender_common import blender_argv_after_double_dash, export_gltf, import_asset, reset_scene, select_only_objects


def _rest_quat(arm_obj: bpy.types.Object, bone_name: str):
    """
    Return bone rest rotation as a quaternion in the bone's *local* (parent-relative) space.
    This matches the space of `PoseBone.matrix_basis` and lets us compensate for differing
    bone local axes between rigs when doing simple quaternion-copy retargeting.
    """
    try:
        b = arm_obj.data.bones.get(str(bone_name))
        if b is None:
            return None
        m = b.matrix_local.copy()
        if b.parent is not None:
            try:
                m = b.parent.matrix_local.inverted() @ m
            except Exception:
                pass
        return m.to_quaternion()
    except Exception:
        return None


def _build_rest_offsets(src_arm: bpy.types.Object, dst_arm: bpy.types.Object, mapping: dict) -> dict:
    """
    Build per-bone quaternion offsets to compensate for rest-pose axis differences.

    We treat pose rotations as deltas from rest (matrix_basis):
      pose = rest * delta
    and want:
      rest_dst * delta_dst ≈ rest_src * delta_src
    therefore:
      delta_dst ≈ inv(rest_dst) * rest_src * delta_src
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
    ap = argparse.ArgumentParser(prog="blender_retarget_motion.py")
    ap.add_argument("--rig", required=True, help="Target rig asset (glb/gltf/fbx/blend).")
    ap.add_argument("--motion", required=True, help="Source motion (bvh/fbx/glb/gltf/usd/usda/usdc/usdz).")
    ap.add_argument("--map", required=True, help="Mapping json path.")
    ap.add_argument("--out", required=True, help="Output glTF/GLB path.")
    ap.add_argument("--export-format", default="GLB", choices=["GLB", "GLTF_SEPARATE"])
    ap.add_argument("--clip-name", default="", help="Optional name for the baked action.")
    ap.add_argument("--motion-clip", default="", help="Optional source action name to retarget (exact match preferred).")
    ap.add_argument("--fps", default="", help="Scene FPS override (int).")
    ap.add_argument("--start", default="", help="Start frame (inclusive). Default: motion start.")
    ap.add_argument("--end", default="", help="End frame (inclusive). Default: motion end.")
    ap.add_argument("--root-motion", default="0", help="Copy root translation (1/0).")
    ap.add_argument("--include-mesh", default="0", help="Include target mesh in output (1/0).")
    return ap.parse_args(argv)


def _find_first_armature(objs: list[bpy.types.Object]) -> bpy.types.Object | None:
    for o in objs:
        if o and o.type == "ARMATURE":
            return o
    for o in bpy.context.scene.objects:
        if o.type == "ARMATURE":
            return o
    return None


def _find_meshes(objs: list[bpy.types.Object]) -> list[bpy.types.Object]:
    out = []
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
    # Expected (minimal) schema:
    # {
    #   "root": {"source": "Hips", "target": "hips"},
    #   "bones": [{"source": "Spine", "target": "spine"}, ...]
    # }
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


def _safe_int(s: str, default: int | None) -> int | None:
    ss = str(s or "").strip()
    if not ss:
        return default
    try:
        return int(ss)
    except Exception:
        return default


def _safe_bool01(s: str) -> bool:
    return str(s or "").strip() not in ("", "0", "false", "False", "no", "No")


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
                _ensure_pose_quat(dp)
                # BVH imports often animate rotation_euler, leaving rotation_quaternion at identity.
                # Use matrix_basis so we read the evaluated delta-from-rest.
                try:
                    q = sp.matrix_basis.to_quaternion().copy()
                except Exception:
                    _ensure_pose_quat(sp)
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
            _ensure_pose_quat(sp)
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


def _keyframe_pose(dst_arm: bpy.types.Object, mapping: dict, *, key_root_location: bool) -> None:
    pose = dst_arm.pose

    root_map = mapping.get("root") or {}
    bones = mapping.get("bones") or []

    if isinstance(root_map, dict):
        dst_root = str(root_map.get("target") or "").strip()
        if dst_root:
            dp = pose.bones.get(dst_root)
            if dp:
                dp.keyframe_insert(data_path="rotation_quaternion")
                if key_root_location:
                    dp.keyframe_insert(data_path="location")

    for ent in bones:
        if not isinstance(ent, dict):
            continue
        tname = str(ent.get("target") or "").strip()
        if not tname:
            continue
        dp = pose.bones.get(tname)
        if not dp:
            continue
        dp.keyframe_insert(data_path="rotation_quaternion")


def main() -> None:
    args = _parse(blender_argv_after_double_dash())
    rig_path = Path(args.rig).resolve()
    motion_path = Path(args.motion).resolve()
    map_path = Path(args.map).resolve()
    out_path = Path(args.out).resolve()

    reset_scene()

    mapping = _load_mapping(map_path)
    copy_root_location = _safe_bool01(args.root_motion)
    include_mesh = _safe_bool01(args.include_mesh)

    fps = _safe_int(args.fps, None)
    if fps and fps > 0:
        bpy.context.scene.render.fps = int(fps)

    # Import target rig first.
    rig_objs = import_asset(rig_path)
    dst_arm = _find_first_armature(rig_objs)
    if dst_arm is None or dst_arm.type != "ARMATURE":
        raise RuntimeError("Target rig import did not produce an armature.")

    # Import motion second (source armature + action).
    motion_objs = import_asset(motion_path)
    src_arm = _find_first_armature(motion_objs)
    if src_arm is None or src_arm.type != "ARMATURE":
        raise RuntimeError("Motion import did not produce an armature.")

    # Pick a source action.
    src_action = None
    want = str(getattr(args, "motion_clip", "") or "").strip()
    if want:
        # Try exact match first, then case-insensitive, then substring.
        acts = list(bpy.data.actions)
        src_action = next((a for a in acts if a.name == want), None)
        if src_action is None:
            low = want.lower()
            src_action = next((a for a in acts if a.name.lower() == low), None)
        if src_action is None:
            low = want.lower()
            src_action = next((a for a in acts if low in a.name.lower()), None)
        if src_action is None:
            names = [a.name for a in acts]
            raise RuntimeError(f"Requested motion clip not found: '{want}'. Available actions: {names[:40]}")
    # Only fall back to the source armature's active action when a specific
    # `--motion-clip` wasn't requested.
    if not want and src_arm.animation_data and src_arm.animation_data.action:
        src_action = src_arm.animation_data.action
    if src_action is None and bpy.data.actions:
        src_action = bpy.data.actions[0]
    if src_action is None:
        raise RuntimeError("No animation action found on source motion.")

    # Ensure the source action is active on the source armature.
    if not src_arm.animation_data:
        src_arm.animation_data_create()
    src_arm.animation_data.action = src_action

    offsets = _build_rest_offsets(src_arm, dst_arm, mapping)

    src_start, src_end = _frame_range_from_action(src_action)
    start = _safe_int(args.start, src_start)
    end = _safe_int(args.end, src_end)
    if start is None or end is None:
        start, end = src_start, src_end
    start = int(start)
    end = int(end)
    if end < start:
        start, end = end, start

    # Create destination action.
    clip_name = str(args.clip_name or "").strip() or (src_action.name or "clip")
    dst_action = bpy.data.actions.new(name=clip_name)
    if not dst_arm.animation_data:
        dst_arm.animation_data_create()
    dst_arm.animation_data.action = dst_action

    # Ensure export determinism: keep only the new action on the target.
    # (Blender's glTF exporter may export all actions it finds.)
    for act in list(bpy.data.actions):
        if act != dst_action and act != src_action:
            try:
                bpy.data.actions.remove(act)
            except Exception:
                pass

    # Bake by sampling every frame.
    bpy.context.scene.frame_start = start
    bpy.context.scene.frame_end = end

    for f in range(start, end + 1):
        bpy.context.scene.frame_set(f)
        _apply_pose_sample(
            src_arm=src_arm,
            dst_arm=dst_arm,
            mapping=mapping,
            copy_root_location=copy_root_location,
            offsets=offsets,
        )
        _keyframe_pose(dst_arm, mapping, key_root_location=copy_root_location)

    # Optionally strip meshes for animation-only output.
    if not include_mesh:
        for m in _find_meshes(rig_objs):
            try:
                bpy.data.objects.remove(m, do_unlink=True)
            except Exception:
                pass
        for m in _find_meshes(motion_objs):
            try:
                bpy.data.objects.remove(m, do_unlink=True)
            except Exception:
                pass

    # Remove source armature to keep output clean.
    try:
        bpy.data.objects.remove(src_arm, do_unlink=True)
    except Exception:
        pass

    # Remove the source action too (it can otherwise get exported).
    try:
        if src_action != dst_action:
            bpy.data.actions.remove(src_action)
    except Exception:
        pass

    # Export only the destination rig (and meshes if requested).
    try:
        export_objs = [dst_arm]
        if include_mesh:
            export_objs += _find_meshes(rig_objs)
        select_only_objects(export_objs)
    except Exception:
        pass
    export_gltf(out_path, fmt=args.export_format, deform_bones_only=True, use_selection=True)


if __name__ == "__main__":
    main()

