from __future__ import annotations

import argparse
import sys
from pathlib import Path

import bpy

# Make sure we can import sibling helpers when run via Blender.
_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

import bmesh  # type: ignore

from blender_common import (
    blender_argv_after_double_dash,
    export_gltf,
    import_asset,
    reset_scene,
    select_only_objects,
)


def _safe_bool01(v: str) -> bool:
    return str(v or "").strip() not in ("", "0", "false", "False", "no", "No")


def _parse(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="blender_cleanup_mesh_particles.py")
    ap.add_argument("--in", dest="input", required=True, help="Input asset path (glb/gltf/fbx/usd/etc).")
    ap.add_argument("--out", dest="output", required=True, help="Output GLB/GLTF path.")
    ap.add_argument("--export-format", default="GLB", choices=["GLB", "GLTF_SEPARATE"])
    ap.add_argument("--deform-only", default="0", help="Export only deform bones (1/0).")
    ap.add_argument("--use-selection", default="1", help="Export only imported objects (1/0).")

    # Cleanup tuning: delete disconnected islands that look like floaters/particles.
    # Defaults are intentionally conservative for characters: many valid parts are disconnected
    # (eyes/teeth/hair/clothing/accessories). You can tighten these later once you confirm results.
    ap.add_argument("--min-face-count", type=int, default=20, help="Delete islands with fewer faces than this.")
    ap.add_argument(
        "--min-area-ratio",
        type=float,
        default=0.0005,
        help="Delete islands whose surface area is below this ratio of the largest island in the mesh.",
    )
    ap.add_argument(
        "--min-bbox-diag-ratio",
        type=float,
        default=0.01,
        help="Delete islands whose AABB diagonal is below this ratio of the largest island in the mesh.",
    )
    ap.add_argument(
        "--keep-largest-n",
        type=int,
        default=6,
        help="Always keep at least N largest islands in each mesh (by area), regardless of thresholds.",
    )

    # Distance-based island cleanup: remove disconnected islands that are far away
    # from the main character volume (helps with "marble sized" floaters).
    ap.add_argument(
        "--max-distance-ratio",
        type=float,
        default=0.0,
        help="Delete islands whose centroid is farther than ratio * main-bbox-diagonal from the main bbox (0 disables).",
    )
    ap.add_argument(
        "--main-islands-n",
        type=int,
        default=20,
        help="Number of largest islands used to define the main bbox (by area).",
    )
    ap.add_argument(
        "--main-bbox-pad-ratio",
        type=float,
        default=0.03,
        help="Expand the main bbox by this fraction of main diagonal before distance testing.",
    )

    # Object-level cleanup: sometimes generators emit "dust" as separate mesh objects.
    ap.add_argument("--min-object-face-count", type=int, default=0, help="Delete mesh objects with fewer faces than this (0 disables).")
    ap.add_argument(
        "--min-object-area-ratio",
        type=float,
        default=0.0,
        help="Delete mesh objects with area < ratio * largest-mesh-object-area (0 disables).",
    )
    ap.add_argument(
        "--min-object-bbox-diag-ratio",
        type=float,
        default=0.0,
        help="Delete mesh objects with AABB diagonal < ratio * largest-mesh-object-diagonal (0 disables).",
    )
    ap.add_argument(
        "--keep-largest-objects-n",
        type=int,
        default=0,
        help="Always keep at least N largest mesh objects (by area), regardless of object thresholds (0 disables).",
    )
    return ap.parse_args(argv)


def _mesh_islands_stats(mesh: bpy.types.Mesh):
    """
    Return list of islands:
      [{faces: set(bmesh.faces), area: float, face_count: int, diag: float}]
    """
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.faces.ensure_lookup_table()
    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()

    seen = set()
    islands = []

    for f in bm.faces:
        if f in seen:
            continue
        stack = [f]
        faces = set()
        verts = set()
        area = 0.0

        while stack:
            cur = stack.pop()
            if cur in seen:
                continue
            seen.add(cur)
            faces.add(cur)
            try:
                area += float(cur.calc_area())
            except Exception:
                pass
            for v in cur.verts:
                verts.add(v)
            for e in cur.edges:
                for lf in e.link_faces:
                    if lf not in seen:
                        stack.append(lf)

        # AABB diagonal (in object local space)
        diag = 0.0
        centroid = (0.0, 0.0, 0.0)
        bb_min = (0.0, 0.0, 0.0)
        bb_max = (0.0, 0.0, 0.0)
        if verts:
            minx = min(v.co.x for v in verts)
            miny = min(v.co.y for v in verts)
            minz = min(v.co.z for v in verts)
            maxx = max(v.co.x for v in verts)
            maxy = max(v.co.y for v in verts)
            maxz = max(v.co.z for v in verts)
            dx = float(maxx - minx)
            dy = float(maxy - miny)
            dz = float(maxz - minz)
            diag = (dx * dx + dy * dy + dz * dz) ** 0.5
            bb_min = (float(minx), float(miny), float(minz))
            bb_max = (float(maxx), float(maxy), float(maxz))
            # centroid (avg of verts)
            sx = sum(float(v.co.x) for v in verts)
            sy = sum(float(v.co.y) for v in verts)
            sz = sum(float(v.co.z) for v in verts)
            inv = 1.0 / float(len(verts))
            centroid = (sx * inv, sy * inv, sz * inv)

        islands.append(
            {
                "faces": faces,
                "area": float(area),
                "face_count": int(len(faces)),
                "diag": float(diag),
                "centroid": centroid,
                "bb_min": bb_min,
                "bb_max": bb_max,
                "_bm": bm,  # keep alive until caller frees
            }
        )

    return islands


def _bbox_union(b0_min: tuple[float, float, float], b0_max: tuple[float, float, float], b1_min, b1_max):
    return (
        (min(b0_min[0], b1_min[0]), min(b0_min[1], b1_min[1]), min(b0_min[2], b1_min[2])),
        (max(b0_max[0], b1_max[0]), max(b0_max[1], b1_max[1]), max(b0_max[2], b1_max[2])),
    )


def _bbox_diag(bb_min: tuple[float, float, float], bb_max: tuple[float, float, float]) -> float:
    dx = float(bb_max[0] - bb_min[0])
    dy = float(bb_max[1] - bb_min[1])
    dz = float(bb_max[2] - bb_min[2])
    return (dx * dx + dy * dy + dz * dz) ** 0.5


def _bbox_expand(bb_min: tuple[float, float, float], bb_max: tuple[float, float, float], pad: float):
    return (
        (bb_min[0] - pad, bb_min[1] - pad, bb_min[2] - pad),
        (bb_max[0] + pad, bb_max[1] + pad, bb_max[2] + pad),
    )


def _dist_point_to_bbox(p: tuple[float, float, float], bb_min: tuple[float, float, float], bb_max: tuple[float, float, float]) -> float:
    # 0 if inside; otherwise euclidean distance to nearest point on bbox
    dx = 0.0
    dy = 0.0
    dz = 0.0
    if p[0] < bb_min[0]:
        dx = bb_min[0] - p[0]
    elif p[0] > bb_max[0]:
        dx = p[0] - bb_max[0]
    if p[1] < bb_min[1]:
        dy = bb_min[1] - p[1]
    elif p[1] > bb_max[1]:
        dy = p[1] - bb_max[1]
    if p[2] < bb_min[2]:
        dz = bb_min[2] - p[2]
    elif p[2] > bb_max[2]:
        dz = p[2] - bb_max[2]
    return (dx * dx + dy * dy + dz * dz) ** 0.5


def _cleanup_mesh_object(
    obj: bpy.types.Object,
    *,
    min_face_count: int,
    min_area_ratio: float,
    min_bbox_diag_ratio: float,
    keep_largest_n: int,
    max_distance_ratio: float,
    main_islands_n: int,
    main_bbox_pad_ratio: float,
) -> dict:
    if not obj or obj.type != "MESH":
        return {"object": getattr(obj, "name", ""), "skipped": True}

    mesh = obj.data
    if not isinstance(mesh, bpy.types.Mesh):
        return {"object": getattr(obj, "name", ""), "skipped": True}

    islands = _mesh_islands_stats(mesh)
    if not islands:
        return {"object": obj.name, "islands": 0, "deleted_islands": 0}

    bm = islands[0]["_bm"]
    # Sort by area descending.
    islands_sorted = sorted(islands, key=lambda d: float(d.get("area", 0.0)), reverse=True)

    max_area = float(islands_sorted[0]["area"] or 0.0)
    max_diag = float(islands_sorted[0]["diag"] or 0.0)

    keep_n = max(0, int(keep_largest_n))
    keep_set = set()
    for i in range(min(keep_n, len(islands_sorted))):
        for f in islands_sorted[i]["faces"]:
            keep_set.add(f)

    # Define "main bbox" from the N largest islands (by area).
    main_n = max(1, int(main_islands_n))
    main_n = min(main_n, len(islands_sorted))
    mbb_min = islands_sorted[0]["bb_min"]
    mbb_max = islands_sorted[0]["bb_max"]
    for i in range(1, main_n):
        mbb_min, mbb_max = _bbox_union(mbb_min, mbb_max, islands_sorted[i]["bb_min"], islands_sorted[i]["bb_max"])
    main_diag = _bbox_diag(mbb_min, mbb_max)
    pad = float(main_bbox_pad_ratio) * float(main_diag or 0.0)
    mbb_min2, mbb_max2 = _bbox_expand(mbb_min, mbb_max, pad)

    del_faces = set()
    deleted_islands = 0
    deleted_by_distance = 0
    for idx, isl in enumerate(islands_sorted):
        faces = isl["faces"]
        # If any face belongs to the "always keep" islands, keep this island.
        if any((f in keep_set) for f in faces):
            continue

        area = float(isl["area"] or 0.0)
        face_count = int(isl["face_count"] or 0)
        diag = float(isl["diag"] or 0.0)
        centroid = isl.get("centroid") or (0.0, 0.0, 0.0)

        too_few_faces = face_count < int(min_face_count)
        too_small_area = (max_area > 0.0) and (area < float(min_area_ratio) * max_area)
        too_small_diag = (max_diag > 0.0) and (diag < float(min_bbox_diag_ratio) * max_diag)
        too_far = False
        if float(max_distance_ratio) > 0.0 and float(main_diag) > 0.0:
            dist = _dist_point_to_bbox(centroid, mbb_min2, mbb_max2)
            too_far = dist > (float(max_distance_ratio) * float(main_diag))

        # Delete if it looks like a floater.
        if too_few_faces or too_small_area or too_small_diag or too_far:
            deleted_islands += 1
            if too_far:
                deleted_by_distance += 1
            for f in faces:
                del_faces.add(f)

    if del_faces:
        try:
            bmesh.ops.delete(bm, geom=list(del_faces), context="FACES")
        except Exception:
            # Fallback: mark faces and delete via selecting in edit mode.
            pass

        # Remove loose edges/verts left behind.
        try:
            loose_edges = [e for e in bm.edges if not e.link_faces]
            if loose_edges:
                bmesh.ops.delete(bm, geom=loose_edges, context="EDGES")
        except Exception:
            pass
        try:
            loose_verts = [v for v in bm.verts if not v.link_faces]
            if loose_verts:
                bmesh.ops.delete(bm, geom=loose_verts, context="VERTS")
        except Exception:
            pass

    # Write back to the mesh datablock.
    bm.to_mesh(mesh)
    mesh.update()
    bm.free()

    return {
        "object": obj.name,
        "islands": len(islands),
        "deleted_islands": int(deleted_islands),
        "deleted_by_distance": int(deleted_by_distance),
        "min_face_count": int(min_face_count),
        "min_area_ratio": float(min_area_ratio),
        "min_bbox_diag_ratio": float(min_bbox_diag_ratio),
        "keep_largest_n": int(keep_largest_n),
        "max_distance_ratio": float(max_distance_ratio),
        "main_islands_n": int(main_islands_n),
        "main_bbox_pad_ratio": float(main_bbox_pad_ratio),
    }


def _mesh_object_area_diag(obj: bpy.types.Object) -> tuple[float, float, int]:
    """
    Approximate surface area + local AABB diagonal + face count for a mesh object.
    Uses the object's mesh datablock in local space (good enough for relative thresholds).
    """
    if not obj or obj.type != "MESH":
        return (0.0, 0.0, 0)
    mesh = obj.data
    if not isinstance(mesh, bpy.types.Mesh):
        return (0.0, 0.0, 0)
    # Face count
    try:
        face_count = int(len(mesh.polygons))
    except Exception:
        face_count = 0
    # Area
    area = 0.0
    try:
        for p in mesh.polygons:
            area += float(p.area)
    except Exception:
        area = 0.0
    # AABB diag
    diag = 0.0
    try:
        verts = mesh.vertices
        if verts:
            minx = min(v.co.x for v in verts)
            miny = min(v.co.y for v in verts)
            minz = min(v.co.z for v in verts)
            maxx = max(v.co.x for v in verts)
            maxy = max(v.co.y for v in verts)
            maxz = max(v.co.z for v in verts)
            dx = float(maxx - minx)
            dy = float(maxy - miny)
            dz = float(maxz - minz)
            diag = (dx * dx + dy * dy + dz * dz) ** 0.5
    except Exception:
        diag = 0.0
    return (float(area), float(diag), int(face_count))


def _delete_small_mesh_objects(
    objs: list[bpy.types.Object],
    *,
    min_object_face_count: int,
    min_object_area_ratio: float,
    min_object_bbox_diag_ratio: float,
    keep_largest_objects_n: int,
) -> dict:
    meshes = [o for o in (objs or []) if o and getattr(o, "type", "") == "MESH"]
    if not meshes:
        return {"deleted_objects": 0, "considered": 0}

    stats = []
    for o in meshes:
        a, d, fc = _mesh_object_area_diag(o)
        stats.append({"obj": o, "area": a, "diag": d, "face_count": fc})

    # Largest object baselines.
    stats_sorted = sorted(stats, key=lambda s: float(s.get("area", 0.0)), reverse=True)
    max_area = float(stats_sorted[0].get("area", 0.0) or 0.0)
    max_diag = max((float(s.get("diag", 0.0) or 0.0) for s in stats_sorted), default=0.0)

    keep_n = max(0, int(keep_largest_objects_n))
    keep_objs = set()
    if keep_n > 0:
        for i in range(min(keep_n, len(stats_sorted))):
            keep_objs.add(stats_sorted[i]["obj"])

    deleted = 0
    for s in stats_sorted:
        o = s["obj"]
        if o in keep_objs:
            continue
        area = float(s.get("area", 0.0) or 0.0)
        diag = float(s.get("diag", 0.0) or 0.0)
        fc = int(s.get("face_count", 0) or 0)

        too_few_faces = (int(min_object_face_count) > 0) and (fc < int(min_object_face_count))
        too_small_area = (float(min_object_area_ratio) > 0.0) and (max_area > 0.0) and (area < float(min_object_area_ratio) * max_area)
        too_small_diag = (float(min_object_bbox_diag_ratio) > 0.0) and (max_diag > 0.0) and (diag < float(min_object_bbox_diag_ratio) * max_diag)

        if too_few_faces or too_small_area or too_small_diag:
            try:
                bpy.data.objects.remove(o, do_unlink=True)
                deleted += 1
            except Exception:
                pass

    return {
        "deleted_objects": int(deleted),
        "considered": int(len(stats_sorted)),
        "min_object_face_count": int(min_object_face_count),
        "min_object_area_ratio": float(min_object_area_ratio),
        "min_object_bbox_diag_ratio": float(min_object_bbox_diag_ratio),
        "keep_largest_objects_n": int(keep_largest_objects_n),
    }


def _delete_empty_mesh_objects(objs: list[bpy.types.Object]) -> int:
    n = 0
    for o in list(objs or []):
        if not o or o.type != "MESH":
            continue
        try:
            mesh = o.data
            if isinstance(mesh, bpy.types.Mesh) and len(mesh.polygons) == 0:
                bpy.data.objects.remove(o, do_unlink=True)
                n += 1
        except Exception:
            continue
    return n


def main() -> None:
    args = _parse(blender_argv_after_double_dash())
    inp = Path(args.input).resolve()
    out = Path(args.output).resolve()

    deform_only = _safe_bool01(args.deform_only)
    use_selection = _safe_bool01(args.use_selection)

    reset_scene()
    imported = import_asset(inp)

    # Work on all mesh objects we just imported (fallback to any scene meshes).
    meshes: list[bpy.types.Object] = []
    try:
        meshes = [o for o in (imported or []) if o and getattr(o, "type", "") == "MESH"]
    except Exception:
        meshes = []
    if not meshes:
        try:
            meshes = [o for o in bpy.context.scene.objects if getattr(o, "type", "") == "MESH"]
        except Exception:
            meshes = []

    reports = []
    for m in meshes:
        reports.append(
            _cleanup_mesh_object(
                m,
                min_face_count=int(args.min_face_count),
                min_area_ratio=float(args.min_area_ratio),
                min_bbox_diag_ratio=float(args.min_bbox_diag_ratio),
                keep_largest_n=int(args.keep_largest_n),
                max_distance_ratio=float(args.max_distance_ratio),
                main_islands_n=int(args.main_islands_n),
                main_bbox_pad_ratio=float(args.main_bbox_pad_ratio),
            )
        )

    obj_report = _delete_small_mesh_objects(
        meshes,
        min_object_face_count=int(args.min_object_face_count),
        min_object_area_ratio=float(args.min_object_area_ratio),
        min_object_bbox_diag_ratio=float(args.min_object_bbox_diag_ratio),
        keep_largest_objects_n=int(args.keep_largest_objects_n),
    )

    deleted_empty = _delete_empty_mesh_objects(meshes)

    try:
        print("[cleanup] reports:", reports[:200])
        print("[cleanup] object_report:", obj_report)
        print("[cleanup] deleted empty mesh objects:", int(deleted_empty))
    except Exception:
        pass

    # Export (prefer selection = imported objects, to avoid exporting default scene junk).
    if use_selection:
        # Recompute objects to export: imported objects that still exist.
        to_export = []
        for o in imported or []:
            try:
                if o and o.name in bpy.data.objects:
                    to_export.append(o)
            except Exception:
                continue
        if to_export:
            try:
                select_only_objects(to_export)
            except Exception:
                pass

    export_gltf(out, fmt=args.export_format, deform_bones_only=deform_only, use_selection=use_selection)


if __name__ == "__main__":
    main()

