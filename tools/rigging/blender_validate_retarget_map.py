from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

import bpy

from blender_common import blender_argv_after_double_dash, import_asset, reset_scene


def _parse(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="blender_validate_retarget_map.py")
    ap.add_argument("--rig", required=True, help="Target rig asset (glb/gltf/fbx/blend).")
    ap.add_argument("--motion", required=True, help="Source motion asset (bvh/fbx/glb/gltf).")
    ap.add_argument("--map", required=True, help="Mapping json path.")
    return ap.parse_args(argv)


def _find_first_armature(objs: list[bpy.types.Object]) -> bpy.types.Object | None:
    for o in objs:
        if o and o.type == "ARMATURE":
            return o
    for o in bpy.context.scene.objects:
        if o.type == "ARMATURE":
            return o
    return None


def _load_mapping(path: Path) -> dict:
    obj = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(obj, dict):
        raise ValueError("mapping must be a JSON object")
    root = obj.get("root") or {}
    bones = obj.get("bones") or []
    if not isinstance(root, dict) or not isinstance(bones, list):
        raise ValueError("mapping must contain { root: {...}, bones: [...] }")
    return obj


def main() -> None:
    args = _parse(blender_argv_after_double_dash())
    rig_path = Path(args.rig).resolve()
    motion_path = Path(args.motion).resolve()
    map_path = Path(args.map).resolve()

    reset_scene()
    mapping = _load_mapping(map_path)

    rig_objs = import_asset(rig_path)
    dst_arm = _find_first_armature(rig_objs)
    if dst_arm is None or dst_arm.type != "ARMATURE":
        raise RuntimeError("Target rig import did not produce an armature.")

    motion_objs = import_asset(motion_path)
    src_arm = _find_first_armature(motion_objs)
    if src_arm is None or src_arm.type != "ARMATURE":
        raise RuntimeError("Motion import did not produce an armature.")

    src_names = {b.name for b in src_arm.data.bones}
    dst_names = {b.name for b in dst_arm.data.bones}

    missing_src: list[str] = []
    missing_dst: list[str] = []

    root = mapping.get("root") or {}
    if isinstance(root, dict):
        sroot = str(root.get("source") or "").strip()
        troot = str(root.get("target") or "").strip()
        if sroot and sroot not in src_names:
            missing_src.append(sroot)
        if troot and troot not in dst_names:
            missing_dst.append(troot)

    bones = mapping.get("bones") or []
    for ent in bones:
        if not isinstance(ent, dict):
            continue
        s = str(ent.get("source") or "").strip()
        t = str(ent.get("target") or "").strip()
        if s and s not in src_names:
            missing_src.append(s)
        if t and t not in dst_names:
            missing_dst.append(t)

    missing_src = sorted(set(missing_src))
    missing_dst = sorted(set(missing_dst))

    print("OK: loaded source + target armatures")
    print(f"Source armature: {src_arm.name} ({len(src_names)} bones)")
    print(f"Target armature: {dst_arm.name} ({len(dst_names)} bones)")

    if missing_src:
        print("\nMissing in SOURCE (mapping.source not found):")
        for n in missing_src:
            print(n)
    if missing_dst:
        print("\nMissing in TARGET (mapping.target not found):")
        for n in missing_dst:
            print(n)

    if missing_src or missing_dst:
        raise RuntimeError("Mapping validation failed (missing bones).")

    print("\nMapping validation: OK")


if __name__ == "__main__":
    main()

