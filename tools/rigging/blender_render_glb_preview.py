from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def blender_argv_after_double_dash() -> list[str]:
    if "--" not in sys.argv:
        return []
    i = sys.argv.index("--")
    return sys.argv[i + 1 :]


def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="blender_render_glb_preview.py")
    ap.add_argument("--in", dest="input", required=True, help="Input GLB/GLTF path")
    ap.add_argument("--out", dest="output", required=True, help="Output PNG path")
    ap.add_argument("--resolution", type=int, default=1024, help="Square output resolution")
    return ap.parse_args(argv)


def look_at(obj: bpy.types.Object, target: Vector) -> None:
    direction = target - obj.location
    quat = direction.to_track_quat("-Z", "Y")
    obj.rotation_euler = quat.to_euler()


def main() -> None:
    args = parse_args(blender_argv_after_double_dash())
    in_path = Path(args.input).expanduser().resolve()
    out_path = Path(args.output).expanduser().resolve()

    if not in_path.exists():
        raise FileNotFoundError(f"Input model not found: {in_path}")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)

    # Import model
    bpy.ops.import_scene.gltf(filepath=str(in_path))

    # Gather mesh bounds
    depsgraph = bpy.context.evaluated_depsgraph_get()
    mins = Vector((1e30, 1e30, 1e30))
    maxs = Vector((-1e30, -1e30, -1e30))
    mesh_found = False

    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        mesh_found = True
        eval_obj = obj.evaluated_get(depsgraph)
        for c in eval_obj.bound_box:
            w = eval_obj.matrix_world @ Vector(c)
            mins.x = min(mins.x, w.x)
            mins.y = min(mins.y, w.y)
            mins.z = min(mins.z, w.z)
            maxs.x = max(maxs.x, w.x)
            maxs.y = max(maxs.y, w.y)
            maxs.z = max(maxs.z, w.z)

    if not mesh_found:
        raise RuntimeError("No mesh objects found after import.")

    center = (mins + maxs) * 0.5
    size = maxs - mins
    radius = max(0.5, size.length * 0.5)

    # Camera
    cam_data = bpy.data.cameras.new("PreviewCam")
    cam = bpy.data.objects.new("PreviewCam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = center + Vector((radius * 1.6, -radius * 1.8, radius * 1.1))
    look_at(cam, center)
    cam_data.lens = 55.0
    bpy.context.scene.camera = cam

    # Lighting
    sun_data = bpy.data.lights.new(name="Sun", type="SUN")
    sun_data.energy = 3.0
    sun = bpy.data.objects.new(name="Sun", object_data=sun_data)
    bpy.context.scene.collection.objects.link(sun)
    sun.location = center + Vector((radius * 2.0, radius * 1.5, radius * 2.8))
    look_at(sun, center)

    # Ground plane for context/shadow.
    bpy.ops.mesh.primitive_plane_add(size=radius * 8.0, location=(center.x, center.y, mins.z - 0.01))
    ground = bpy.context.active_object
    if ground and ground.type == "MESH":
        mat = bpy.data.materials.new(name="Ground")
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = (0.16, 0.17, 0.19, 1.0)
            bsdf.inputs["Roughness"].default_value = 0.9
        ground.data.materials.append(mat)

    # Render settings
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = 64
    scene.render.image_settings.file_format = "PNG"
    scene.render.resolution_x = int(args.resolution)
    scene.render.resolution_y = int(args.resolution)
    scene.render.filepath = str(out_path)

    # Neutral background
    scene.world = bpy.data.worlds.new("PreviewWorld")
    scene.world.use_nodes = True
    bg = scene.world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs["Color"].default_value = (0.03, 0.03, 0.035, 1.0)
        bg.inputs["Strength"].default_value = 0.8

    bpy.ops.render.render(write_still=True)
    print(f"Wrote preview PNG: {out_path}")


if __name__ == "__main__":
    main()
