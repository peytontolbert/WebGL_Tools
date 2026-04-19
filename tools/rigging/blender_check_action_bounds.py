from __future__ import annotations

import argparse
import sys
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

import bpy
from mathutils import Vector

from blender_common import blender_argv_after_double_dash, import_asset, reset_scene


def _parse(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="blender_check_action_bounds.py")
    ap.add_argument("--in", dest="inp", required=True, help="Input GLB/GLTF path to inspect.")
    ap.add_argument("--action", default="", help="Action name to sample (default: first action).")
    ap.add_argument("--max-frames", default="2000", help="Safety cap on sampled frames.")
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
    out: list[bpy.types.Object] = []
    for o in objs:
        if o and o.type == "MESH":
            out.append(o)
    for o in bpy.context.scene.objects:
        if o.type == "MESH" and o not in out:
            out.append(o)
    # filter common "Background" card meshes
    try:
        out = [m for m in out if "background" not in str(getattr(m, "name", "") or "").strip().lower()]
    except Exception:
        pass
    return out


def _pick_action(name: str) -> bpy.types.Action | None:
    want = str(name or "").strip()
    if want:
        a = bpy.data.actions.get(want)
        if a:
            return a
        low = want.lower()
        for aa in bpy.data.actions:
            if aa.name.lower() == low:
                return aa
        for aa in bpy.data.actions:
            if low in aa.name.lower():
                return aa
    return bpy.data.actions[0] if bpy.data.actions else None


def _mesh_world_bounds(mesh_obj: bpy.types.Object, depsgraph) -> tuple[Vector, Vector] | None:
    try:
        eval_obj = mesh_obj.evaluated_get(depsgraph)
        bb = getattr(eval_obj, "bound_box", None)
        if not bb:
            return None
        mat = eval_obj.matrix_world
        pts = [mat @ Vector(p) for p in bb]
        mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
        return mn, mx
    except Exception:
        return None


def main() -> None:
    args = _parse(blender_argv_after_double_dash())
    inp = Path(args.inp).resolve()
    if not inp.exists():
        raise RuntimeError(f"Missing input: {inp}")

    reset_scene()
    imported = import_asset(inp)
    arm = _find_first_armature(imported)
    meshes = _find_meshes(imported)

    act = _pick_action(args.action)
    if act is None:
        print("No actions found.")
        return

    if arm is not None:
        if not arm.animation_data:
            arm.animation_data_create()
        arm.animation_data.action = act

    fr0 = int(round(act.frame_range[0]))
    fr1 = int(round(act.frame_range[1]))
    max_frames = int(str(args.max_frames or "2000").strip() or "2000")
    fr1 = min(fr1, fr0 + max(1, max_frames) - 1)

    depsgraph = bpy.context.evaluated_depsgraph_get()

    mn_all = Vector((1e30, 1e30, 1e30))
    mx_all = Vector((-1e30, -1e30, -1e30))
    worst_size = 0.0
    worst_frame = fr0

    for f in range(fr0, fr1 + 1):
        bpy.context.scene.frame_set(f)
        # Keep bounds per-frame (so a single bad frame doesn't poison mn/mx printing)
        mn = Vector((1e30, 1e30, 1e30))
        mx = Vector((-1e30, -1e30, -1e30))
        any_ok = False
        for m in meshes:
            b = _mesh_world_bounds(m, depsgraph)
            if b is None:
                continue
            any_ok = True
            mn = Vector((min(mn.x, b[0].x), min(mn.y, b[0].y), min(mn.z, b[0].z)))
            mx = Vector((max(mx.x, b[1].x), max(mx.y, b[1].y), max(mx.z, b[1].z)))
        if not any_ok:
            continue
        size = (mx - mn)
        dim = max(size.x, size.y, size.z)
        if dim > worst_size:
            worst_size = dim
            worst_frame = f
        mn_all = Vector((min(mn_all.x, mn.x), min(mn_all.y, mn.y), min(mn_all.z, mn.z)))
        mx_all = Vector((max(mx_all.x, mx.x), max(mx_all.y, mx.y), max(mx_all.z, mx.z)))

    size_all = mx_all - mn_all
    print(f"Input: {inp}")
    print(f"Action: {act.name}  frames: [{fr0}..{fr1}]  meshes: {len(meshes)}  armature: {arm.name if arm else '(none)'}")
    print(f"Bounds (union): min={tuple(round(v, 4) for v in mn_all)} max={tuple(round(v, 4) for v in mx_all)}")
    print(f"Size (union):  {tuple(round(v, 4) for v in size_all)}")
    print(f"Worst max-dimension: {worst_size:.4f} at frame {worst_frame}")

    if worst_size > 50.0:
        print("WARNING: bounds are extremely large; animation may be broken (exploding/morphed).")


if __name__ == "__main__":
    main()

