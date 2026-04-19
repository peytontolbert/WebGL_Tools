from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

import bpy
from mathutils import Vector

from blender_common import blender_argv_after_double_dash, import_asset, reset_scene


def _parse(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="blender_render_action_mp4.py")
    ap.add_argument("--in", dest="inp", required=True, help="Input GLB/GLTF/BVH/FBX.")
    ap.add_argument("--action", default="", help="Action name to render (default: first action).")
    ap.add_argument("--out", required=True, help="Output MP4 path.")
    ap.add_argument("--fps", type=int, default=24)
    ap.add_argument("--start", type=int, default=0, help="Start frame (0 = action start).")
    ap.add_argument("--end", type=int, default=0, help="End frame (0 = action end).")
    ap.add_argument("--width", type=int, default=960)
    ap.add_argument("--height", type=int, default=540)
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
    try:
        out = [m for m in out if "background" not in str(getattr(m, "name", "") or "").strip().lower()]
    except Exception:
        pass
    return out


def _hide_background_cards(root_obj: bpy.types.Object) -> None:
    if not root_obj:
        return
    try:
        root_obj.traverse(lambda n: setattr(n, "visible", False) if "background" in str(getattr(n, "name", "") or "").strip().lower() else None)
    except Exception:
        # Best-effort only.
        pass


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


def _compute_bounds(meshes: list[bpy.types.Object]) -> tuple[Vector, Vector] | None:
    if not meshes:
        return None
    depsgraph = bpy.context.evaluated_depsgraph_get()
    mn = Vector((1e30, 1e30, 1e30))
    mx = Vector((-1e30, -1e30, -1e30))
    any_ok = False
    for m in meshes:
        try:
            e = m.evaluated_get(depsgraph)
            bb = getattr(e, "bound_box", None)
            if not bb:
                continue
            mat = e.matrix_world
            pts = [mat @ Vector(p) for p in bb]
            mn = Vector((min(mn.x, min(p.x for p in pts)), min(mn.y, min(p.y for p in pts)), min(mn.z, min(p.z for p in pts))))
            mx = Vector((max(mx.x, max(p.x for p in pts)), max(mx.y, max(p.y for p in pts)), max(mx.z, max(p.z for p in pts))))
            any_ok = True
        except Exception:
            continue
    return (mn, mx) if any_ok else None


def main() -> None:
    args = _parse(blender_argv_after_double_dash())
    inp = Path(args.inp).resolve()
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    if not inp.exists():
        raise RuntimeError(f"Missing input: {inp}")

    reset_scene()
    imported = import_asset(inp)
    for o in imported:
        try:
            _hide_background_cards(o)
        except Exception:
            pass
    arm = _find_first_armature(imported)
    meshes = _find_meshes(imported)
    if not meshes:
        raise RuntimeError("No mesh objects found after import.")

    act = _pick_action(args.action)
    if act is None:
        raise RuntimeError("No actions found to render.")
    if arm is not None:
        if not arm.animation_data:
            arm.animation_data_create()
        arm.animation_data.action = act

    fr0 = int(round(act.frame_range[0]))
    fr1 = int(round(act.frame_range[1]))
    if int(args.start) > 0:
        fr0 = int(args.start)
    if int(args.end) > 0:
        fr1 = int(args.end)
    if fr1 < fr0:
        fr0, fr1 = fr1, fr0

    bpy.context.scene.frame_set(fr0)
    b = _compute_bounds(meshes)
    if b is None:
        raise RuntimeError("Failed to compute mesh bounds.")
    mn, mx = b
    ctr = (mn + mx) * 0.5
    size = mx - mn
    radius = max(float(size.x), float(size.y), float(size.z), 0.1)

    cam_data = bpy.data.cameras.new("RenderCam")
    cam_obj = bpy.data.objects.new("RenderCam", cam_data)
    bpy.context.scene.collection.objects.link(cam_obj)
    bpy.context.scene.camera = cam_obj

    target = bpy.data.objects.new("RenderTarget", None)
    target.empty_display_type = "PLAIN_AXES"
    target.location = ctr
    bpy.context.scene.collection.objects.link(target)

    cam_obj.location = Vector((ctr.x + radius * 1.7, ctr.y - radius * 1.7, ctr.z + radius * 0.8))
    con = cam_obj.constraints.new(type="TRACK_TO")
    con.target = target
    con.track_axis = "TRACK_NEGATIVE_Z"
    con.up_axis = "UP_Y"
    cam_data.lens = 45.0

    key = bpy.data.lights.new(name="Key", type="SUN")
    key.energy = 3.0
    key_obj = bpy.data.objects.new(name="Key", object_data=key)
    bpy.context.scene.collection.objects.link(key_obj)
    key_obj.location = Vector((ctr.x + radius, ctr.y + radius, ctr.z + radius * 2.0))

    fill = bpy.data.lights.new(name="Fill", type="AREA")
    fill.energy = 1000.0
    fill.size = radius * 0.8
    fill_obj = bpy.data.objects.new(name="Fill", object_data=fill)
    bpy.context.scene.collection.objects.link(fill_obj)
    fill_obj.location = Vector((ctr.x - radius * 0.7, ctr.y - radius * 0.7, ctr.z + radius * 1.2))
    fill_obj.rotation_euler = (0.9, 0.0, 0.7)

    scn = bpy.context.scene
    scn.render.engine = "BLENDER_WORKBENCH"
    scn.render.fps = max(1, int(args.fps))
    scn.frame_start = fr0
    scn.frame_end = fr1
    scn.render.resolution_x = max(64, int(args.width))
    scn.render.resolution_y = max(64, int(args.height))
    scn.render.resolution_percentage = 100

    # Some Blender builds (like certain portable binaries) are compiled without
    # movie output codecs. If FFMPEG output is unavailable, render a PNG sequence
    # and encode MP4 with system ffmpeg.
    try:
        ff = scn.render.ffmpeg
        scn.render.image_settings.file_format = "FFMPEG"
        ff.format = "MPEG4"
        ff.codec = "H264"
        ff.constant_rate_factor = "MEDIUM"
        ff.ffmpeg_preset = "GOOD"
        ff.audio_codec = "NONE"
        scn.render.filepath = str(out)
        print(f"Rendering action '{act.name}' frames [{fr0}..{fr1}] to {out}")
        bpy.ops.render.render(animation=True, write_still=False)
        print(f"Wrote: {out}")
        return
    except Exception:
        pass

    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        raise RuntimeError(
            "Blender movie output is unavailable and `ffmpeg` was not found in PATH. "
            "Install ffmpeg to enable MP4 encoding fallback."
        )

    with tempfile.TemporaryDirectory(prefix="blender_action_frames_") as td:
        td_path = Path(td)
        # Blender will append frame number before extension.
        # Example output: frame_0001.png
        scn.render.image_settings.file_format = "PNG"
        scn.render.filepath = str(td_path / "frame_")
        print(f"Rendering PNG sequence for '{act.name}' frames [{fr0}..{fr1}] ...")
        bpy.ops.render.render(animation=True, write_still=False)

        pattern = str(td_path / "frame_%04d.png")
        print("Encoding MP4 with ffmpeg fallback...")
        codec_cmds = [
            ["-c:v", "libx264", "-pix_fmt", "yuv420p"],
            ["-c:v", "libopenh264", "-b:v", "4M", "-pix_fmt", "yuv420p"],
            ["-c:v", "mpeg4", "-q:v", "4", "-pix_fmt", "yuv420p"],
        ]
        logs: list[str] = []
        ok = False
        for codec_args in codec_cmds:
            cmd = [
                ffmpeg_bin,
                "-y",
                "-framerate",
                str(max(1, int(args.fps))),
                "-i",
                pattern,
                *codec_args,
                str(out),
            ]
            p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            if p.returncode == 0 and out.exists() and out.stat().st_size > 0:
                ok = True
                break
            logs.append(f"Codec attempt failed: {' '.join(codec_args)}\n{p.stdout}")
        if not ok:
            raise RuntimeError("ffmpeg encoding failed for all codecs.\n\n" + "\n\n".join(logs))
        print(f"Wrote: {out}")


if __name__ == "__main__":
    main()
