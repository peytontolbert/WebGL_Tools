from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

import bpy

from blender_common import blender_argv_after_double_dash, export_gltf, import_asset, reset_scene, select_only_objects


def _parse(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="blender_convert_asset_to_gltf.py")
    ap.add_argument("--in", dest="input", required=True, help="Input asset path (usd/usda/usdc/usdz/fbx/glb/gltf/obj/blend).")
    ap.add_argument("--out", dest="output", required=True, help="Output GLB/GLTF path.")
    ap.add_argument("--export-format", default="GLB", choices=["GLB", "GLTF_SEPARATE"])
    ap.add_argument("--deform-only", default="0", help="Export only deform bones (1/0).")
    ap.add_argument("--use-selection", default="1", help="Export only imported objects (1/0).")
    ap.add_argument("--split-meshes", default="0", help="Also export one GLB per mesh object (1/0).")
    ap.add_argument("--split-out-dir", default="", help="Directory to write per-mesh GLBs into (optional).")
    return ap.parse_args(argv)


def _safe_bool01(v: str) -> bool:
    return str(v or "").strip() not in ("", "0", "false", "False", "no", "No")


def _safe_file_stem(s: str) -> str:
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", str(s or "").strip())
    base = re.sub(r"_+", "_", base).strip("._-")
    return base or "mesh"


def _pick_armature_for_mesh(mesh_obj):
    if not mesh_obj:
        return None
    try:
        p = getattr(mesh_obj, "parent", None)
        if p and getattr(p, "type", "") == "ARMATURE":
            return p
    except Exception:
        pass
    try:
        for mod in getattr(mesh_obj, "modifiers", []) or []:
            try:
                if getattr(mod, "type", "") == "ARMATURE" and getattr(mod, "object", None):
                    return mod.object
            except Exception:
                continue
    except Exception:
        pass
    return None


def _force_objects_visible_selectable(objs) -> None:
    """
    USD imports (especially from DCC pipelines) sometimes create objects that are
    hidden / non-selectable. If we rely on "export selection", those objects may
    silently fail to export.
    """
    for o in objs or []:
        if not o:
            continue
        try:
            o.hide_viewport = False
        except Exception:
            pass
        try:
            o.hide_render = False
        except Exception:
            pass
        try:
            o.hide_select = False
        except Exception:
            pass
        try:
            # Blender 2.8+ API
            o.hide_set(False)
        except Exception:
            pass


def _export_split_meshes(*, imported, split_dir: Path, deform_only: bool) -> dict:
    """
    Export each mesh object as its own GLB into split_dir.
    Returns a manifest dict.
    """
    split_dir.mkdir(parents=True, exist_ok=True)

    meshes = []
    try:
        meshes = [o for o in (imported or []) if o and getattr(o, "type", "") == "MESH"]
    except Exception:
        meshes = []
    if not meshes:
        # Fallback: grab any mesh in the scene.
        try:
            meshes = [o for o in bpy.context.scene.objects if getattr(o, "type", "") == "MESH"]
        except Exception:
            meshes = []

    if not meshes:
        raise RuntimeError("Split-mesh export requested, but no mesh objects were found.")

    used = {}
    out_files = []
    for i, mesh_obj in enumerate(meshes):
        # Ensure mesh is selectable for export selection.
        _force_objects_visible_selectable([mesh_obj])
        stem = _safe_file_stem(getattr(mesh_obj, "name", f"mesh_{i}"))
        n = used.get(stem, 0) + 1
        used[stem] = n
        if n > 1:
            stem = f"{stem}_{n:02d}"

        out_path = (split_dir / stem).with_suffix(".glb")

        to_export = [mesh_obj]
        arm = _pick_armature_for_mesh(mesh_obj)
        if arm and arm not in to_export:
            to_export.append(arm)
        _force_objects_visible_selectable(to_export)

        # Export selection only for split outputs (avoid exporting other scene objects).
        try:
            select_only_objects(to_export)
        except Exception:
            pass

        export_gltf(out_path, fmt="GLB", deform_bones_only=deform_only, use_selection=True)
        out_files.append(str(out_path))

    manifest = {
        "count": len(out_files),
        "dir": str(split_dir),
        "files": out_files,
    }
    try:
        (split_dir / "_meshes.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    except Exception:
        pass
    return manifest


def main() -> None:
    args = _parse(blender_argv_after_double_dash())
    inp = Path(args.input).resolve()
    out = Path(args.output).resolve()
    deform_only = _safe_bool01(args.deform_only)
    use_selection = _safe_bool01(args.use_selection)
    split_meshes = _safe_bool01(args.split_meshes)
    split_out_dir_raw = str(args.split_out_dir or "").strip()

    reset_scene()
    imported = import_asset(inp)
    _force_objects_visible_selectable(imported)

    # Best-effort: ensure file-backed images are loaded so the glTF exporter can embed/write them.
    # If a texture path is missing (or references a remote URL), we log it here.
    try:
        imgs = []
        for img in bpy.data.images:
            try:
                if not img:
                    continue
                if getattr(img, "source", "") != "FILE":
                    continue
                fp = ""
                try:
                    fp = bpy.path.abspath(str(getattr(img, "filepath", "") or ""))
                except Exception:
                    fp = str(getattr(img, "filepath", "") or "")
                fp = str(fp or "")
                exists = bool(fp) and os.path.exists(fp) and os.path.isfile(fp)
                packed = bool(getattr(img, "packed_file", None))
                # Reload if it exists but isn't packed (helps on some USD imports).
                if exists and not packed:
                    try:
                        img.reload()
                    except Exception:
                        pass
                imgs.append({"name": str(getattr(img, "name", "")), "filepath": fp, "exists": exists, "packed": packed})
            except Exception:
                continue
        if imgs:
            print("[convert_asset] images:", json.dumps(imgs[:200], indent=2))
    except Exception:
        pass

    # Prefer exporting only the objects we just imported (avoids exporting default scene junk).
    if use_selection:
        try:
            select_only_objects(imported)
        except Exception:
            pass

    # Ensure frame range is sane if an action exists (helps some USD clips).
    try:
        bpy.context.scene.frame_start = int(bpy.context.scene.frame_start)
        bpy.context.scene.frame_end = int(bpy.context.scene.frame_end)
    except Exception:
        pass

    export_gltf(out, fmt=args.export_format, deform_bones_only=deform_only, use_selection=use_selection)

    if split_meshes:
        if str(args.export_format).strip() != "GLB":
            raise RuntimeError("Split-mesh export currently only supports --export-format GLB.")
        split_dir = Path(split_out_dir_raw).resolve() if split_out_dir_raw else (out.parent / f"{out.stem}_meshes").resolve()
        _export_split_meshes(imported=imported, split_dir=split_dir, deform_only=deform_only)


if __name__ == "__main__":
    main()

