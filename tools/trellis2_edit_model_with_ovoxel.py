#!/usr/bin/env python3
"""
Edit an existing 3D model with TRELLIS2 + OVOXEL blending.

Pipeline:
1) Generate an "edit target" mesh from reference image (TRELLIS2 image->3D).
2) Voxelize both base mesh and generated mesh into flexible dual grid (OVOXEL).
3) Blend occupancy in voxel space (mix/union/intersect/replace).
4) Reconstruct edited geometry and export GLB.

Typical usage:
  conda run -n trellis python3 tools/trellis2_edit_model_with_ovoxel.py \
    --base-mesh assets/characters/base.glb \
    --edit-image assets/reference/new_style.png \
    --out-glb assets/generated/trellis_edit/base_edited.glb \
    --merge-mode mix \
    --edit-strength 0.45

Text-conditioned usage (auto text->image stage):
  conda run -n trellis python3 tools/trellis2_edit_model_with_ovoxel.py \
    --base-mesh assets/characters/base.glb \
    --edit-text "raise arms, keep same character identity" \
    --out-glb assets/generated/trellis_edit/base_raise_arms.glb
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


def _eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="tools/trellis2_edit_model_with_ovoxel.py")
    ap.add_argument("--model", default="microsoft/TRELLIS.2-4B", help="HF model id.")
    ap.add_argument("--base-mesh", required=True, help="Input base mesh path (GLB/GLTF/OBJ/PLY...).")
    ap.add_argument("--edit-image", default="", help="Reference image used to drive edits.")
    ap.add_argument("--edit-text", default="", help="Optional text instruction (auto-generates edit image).")
    ap.add_argument("--out-glb", required=True, help="Output edited GLB path.")
    ap.add_argument("--device", default="cuda", help='Device: "cuda", "cuda:0", or "cpu".')
    ap.add_argument(
        "--text2img-backend",
        default="zimage",
        choices=["zimage", "flux"],
        help="Backend used when --edit-text is set and --edit-image is empty.",
    )
    ap.add_argument("--text2img-model", default="", help="Optional model override for text->image backend.")
    ap.add_argument("--text2img-size", type=int, default=1024, help="Square image size for text->image stage.")
    ap.add_argument("--text2img-steps", type=int, default=10, help="Sampling steps for text->image stage.")
    ap.add_argument("--text2img-guidance-scale", type=float, default=0.0, help="Guidance scale for text->image stage.")

    # TRELLIS generation controls.
    ap.add_argument(
        "--pipeline-type",
        default="1024_cascade",
        choices=["512", "1024", "1024_cascade", "1536_cascade"],
        help="TRELLIS generation variant for the edit target mesh.",
    )
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--preprocess-image", type=int, default=1, choices=[0, 1])
    ap.add_argument("--steps", type=int, default=36, help="Default flow steps for stages not explicitly set.")
    ap.add_argument("--guidance-strength", type=float, default=3.0, help="Default CFG strength for stages not explicitly set.")
    ap.add_argument("--ss-steps", type=int, default=None)
    ap.add_argument("--shape-steps", type=int, default=None)
    ap.add_argument("--tex-steps", type=int, default=None)

    # OVOXEL editing controls.
    ap.add_argument("--grid-size", type=int, default=256, help="Voxel grid resolution for blend/reconstruct.")
    ap.add_argument("--aabb", default="-0.5,-0.5,-0.5,0.5,0.5,0.5", help="AABB as minx,miny,minz,maxx,maxy,maxz.")
    ap.add_argument(
        "--merge-mode",
        default="mix",
        choices=["mix", "union", "intersect", "replace"],
        help="How to merge base occupancy with TRELLIS edit occupancy.",
    )
    ap.add_argument(
        "--edit-strength",
        type=float,
        default=0.45,
        help='Blend aggressiveness for merge-mode "mix" in [0,1].',
    )

    # GLB export controls.
    ap.add_argument("--decimation-target", type=int, default=250000)
    ap.add_argument("--texture-size", type=int, default=2048)
    ap.add_argument("--remesh", type=int, default=1, choices=[0, 1])
    ap.add_argument("--remesh-band", type=float, default=1.0)
    ap.add_argument("--remesh-project", type=float, default=0.9)
    ap.add_argument("--extension-webp", type=int, default=1, choices=[0, 1])
    ap.add_argument("--verbose", type=int, default=1, choices=[0, 1])
    return ap.parse_args()


def _parse_aabb(raw: str) -> list[list[float]]:
    parts = [p.strip() for p in str(raw).split(",") if p.strip()]
    if len(parts) != 6:
        raise ValueError("aabb must have 6 comma-separated floats")
    vals = [float(x) for x in parts]
    return [[vals[0], vals[1], vals[2]], [vals[3], vals[4], vals[5]]]


def _run(cmd: list[str]) -> None:
    p = subprocess.run(cmd, stdout=sys.stdout, stderr=sys.stderr)
    if p.returncode != 0:
        raise RuntimeError(f"command failed ({p.returncode}): {' '.join(cmd)}")


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _ensure_trellis_import_path() -> None:
    trellis_src = _repo_root() / "repos" / "TRELLIS.2"
    if trellis_src.exists() and (trellis_src / "trellis2").exists():
        sys.path.insert(0, str(trellis_src))


def _load_mesh_trimesh(mesh_path: Path):
    import trimesh  # type: ignore

    loaded = trimesh.load(str(mesh_path), force=None, skip_materials=False, process=False)
    if isinstance(loaded, trimesh.Trimesh):
        return loaded
    if isinstance(loaded, trimesh.Scene):
        meshes = []
        try:
            dumped = loaded.dump(concatenate=False)
            if isinstance(dumped, list):
                meshes = dumped
            elif isinstance(dumped, trimesh.Trimesh):
                meshes = [dumped]
        except Exception:
            meshes = []
        if not meshes:
            try:
                meshes = [g for g in loaded.geometry.values() if isinstance(g, trimesh.Trimesh)]
            except Exception:
                meshes = []
        meshes = [m for m in meshes if isinstance(m, trimesh.Trimesh) and len(m.vertices) and len(m.faces)]
        if not meshes:
            raise ValueError(f"Mesh load produced an empty scene: {mesh_path}")
        if len(meshes) == 1:
            return meshes[0]
        return trimesh.util.concatenate(meshes)
    raise TypeError(f"Unsupported mesh type from trimesh.load(): {type(loaded)}")


def _preprocess_mesh_to_trellis_space(mesh):
    import numpy as np  # type: ignore
    import trimesh  # type: ignore

    vertices = np.asarray(mesh.vertices).copy()
    faces = np.asarray(mesh.faces).copy()
    if vertices.size == 0 or faces.size == 0:
        raise ValueError("Empty mesh")

    # Match TRELLIS preprocess convention so base/edit occupy the same canonical space.
    vmin = vertices.min(axis=0)
    vmax = vertices.max(axis=0)
    center = (vmin + vmax) / 2.0
    denom = float((vmax - vmin).max())
    scale = (0.99999 / denom) if denom > 0 else 1.0
    vertices = (vertices - center) * scale
    tmp = vertices[:, 1].copy()
    vertices[:, 1] = -vertices[:, 2]
    vertices[:, 2] = tmp
    return trimesh.Trimesh(vertices=vertices, faces=faces, process=False)


def _sampler_params(args: argparse.Namespace, stage: str) -> dict:
    stage_steps = getattr(args, f"{stage}_steps", None)
    return {
        "steps": int(stage_steps) if stage_steps is not None else int(args.steps),
        "guidance_strength": float(args.guidance_strength),
        "guidance_rescale": 0.0,
        "rescale_t": 3.0,
    }


def _materialize_edit_image(args: argparse.Namespace, out_glb: Path) -> Path:
    edit_image_raw = str(args.edit_image or "").strip()
    edit_text_raw = str(args.edit_text or "").strip()
    if edit_image_raw:
        p = Path(edit_image_raw).expanduser().resolve()
        if not p.exists():
            raise FileNotFoundError(f"Edit image not found: {p}")
        return p
    if not edit_text_raw:
        raise ValueError("Provide either --edit-image or --edit-text.")

    repo_root = _repo_root()
    out_img = out_glb.parent / f"{out_glb.stem}.edit_prompt.png"
    out_img.parent.mkdir(parents=True, exist_ok=True)
    backend = str(args.text2img_backend).strip().lower()
    if backend == "flux":
        tool_path = repo_root / "tools" / "flux_text_to_image.py"
        cmd = [
            sys.executable,
            str(tool_path),
            "--prompt",
            edit_text_raw,
            "--out",
            str(out_img),
            "--seed",
            str(int(args.seed)),
            "--steps",
            str(int(args.text2img_steps)),
            "--guidance-scale",
            str(float(args.text2img_guidance_scale)),
            "--device",
            str(args.device),
            "--cpu-offload",
            "1" if str(args.device).startswith("cuda") else "0",
        ]
        if str(args.text2img_model).strip():
            cmd += ["--model", str(args.text2img_model).strip()]
    else:
        tool_path = repo_root / "tools" / "zimage_text_to_image.py"
        cmd = [
            sys.executable,
            str(tool_path),
            "--prompt",
            edit_text_raw,
            "--out",
            str(out_img),
            "--seed",
            str(int(args.seed)),
            "--height",
            str(int(args.text2img_size)),
            "--width",
            str(int(args.text2img_size)),
            "--steps",
            str(int(args.text2img_steps)),
            "--guidance-scale",
            str(float(args.text2img_guidance_scale)),
            "--device",
            str(args.device),
        ]
        if str(args.text2img_model).strip():
            cmd += ["--model", str(args.text2img_model).strip()]

    _eprint(f'Generating edit image from text via {backend}: "{edit_text_raw}"')
    _run(cmd)
    if not out_img.exists():
        raise FileNotFoundError(f"Text-to-image did not produce expected output: {out_img}")
    return out_img


def _run_trellis_edit_mesh(args: argparse.Namespace, image_path: Path):
    import torch  # type: ignore
    from PIL import Image  # type: ignore
    from trellis2.pipelines import Trellis2ImageTo3DPipeline  # type: ignore

    device = str(args.device).strip() or "cuda"
    pipe = Trellis2ImageTo3DPipeline.from_pretrained(str(args.model))
    if device.startswith("cuda"):
        pipe.cuda()
    else:
        to = getattr(pipe, "to", None)
        if callable(to):
            pipe.to(device)

    image = Image.open(str(image_path))
    run_kwargs = {
        "seed": int(args.seed),
        "preprocess_image": bool(int(args.preprocess_image)),
        "pipeline_type": str(args.pipeline_type),
        "sparse_structure_sampler_params": _sampler_params(args, "ss"),
        "shape_slat_sampler_params": _sampler_params(args, "shape"),
        "tex_slat_sampler_params": _sampler_params(args, "tex"),
    }
    while True:
        try:
            return pipe.run(image, **run_kwargs)[0]
        except TypeError as e:
            msg = str(e)
            dropped = False
            for key in [
                "sparse_structure_sampler_params",
                "shape_slat_sampler_params",
                "tex_slat_sampler_params",
                "pipeline_type",
                "preprocess_image",
                "seed",
            ]:
                if key in run_kwargs and key in msg:
                    run_kwargs.pop(key, None)
                    dropped = True
                    break
            if dropped:
                continue
            raise


def _voxelize_mesh(vertices, faces, grid_size: int, aabb: list[list[float]]):
    import o_voxel  # type: ignore

    coords, dual_vertices, intersected = o_voxel.convert.mesh_to_flexible_dual_grid(
        vertices,
        faces,
        grid_size=grid_size,
        aabb=aabb,
        face_weight=1.0,
        boundary_weight=0.2,
        regularization_weight=1e-2,
        timing=False,
    )
    # local dual offset in [0,1] within each voxel.
    dual_local = dual_vertices * grid_size - coords
    return coords.int(), dual_local.float(), intersected.bool()


def _id_index(coords):
    import o_voxel  # type: ignore
    import torch  # type: ignore

    ids = o_voxel.serialize.encode_seq(coords)
    order = torch.argsort(ids)
    return ids, order


def _blend_ids(base_ids_set: set[int], edit_ids_set: set[int], mode: str, strength: float) -> list[int]:
    if mode == "replace":
        return sorted(edit_ids_set)
    if mode == "union":
        return sorted(base_ids_set | edit_ids_set)
    if mode == "intersect":
        inter = base_ids_set & edit_ids_set
        return sorted(inter if inter else edit_ids_set)

    # mode == "mix"
    s = max(0.0, min(1.0, float(strength)))
    shared = base_ids_set & edit_ids_set
    base_only = sorted(base_ids_set - edit_ids_set)
    edit_only = sorted(edit_ids_set - base_ids_set)
    add_n = int(round(len(edit_only) * s))
    rem_n = int(round(len(base_only) * s * 0.5))
    out = set(shared)
    out.update(base_only[rem_n:])
    out.update(edit_only[:add_n])
    if not out:
        # Safety fallback.
        out = set(edit_ids_set) if edit_ids_set else set(base_ids_set)
    return sorted(out)


def _make_attr_layout(num_channels: int):
    if num_channels >= 6:
        return {
            "base_color": slice(0, 3),
            "metallic": slice(3, 4),
            "roughness": slice(4, 5),
            "alpha": slice(5, 6),
        }
    if num_channels >= 4:
        return {
            "base_color": slice(0, 3),
            "alpha": slice(3, 4),
        }
    return {"base_color": slice(0, min(3, num_channels))}


def main() -> int:
    os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    _ensure_trellis_import_path()
    args = _parse_args()

    base_mesh_path = Path(args.base_mesh).expanduser().resolve()
    out_glb = Path(args.out_glb).expanduser().resolve()
    out_glb.parent.mkdir(parents=True, exist_ok=True)

    if not base_mesh_path.exists():
        _eprint(f"Base mesh not found: {base_mesh_path}")
        return 2
    try:
        edit_image_path = _materialize_edit_image(args, out_glb)
    except Exception as e:
        _eprint(f"Failed to resolve edit conditioning image: {e}")
        return 2

    try:
        import torch  # type: ignore
        import o_voxel  # type: ignore
    except Exception as e:
        _eprint(
            "Missing required dependencies.\n"
            "Activate your trellis env first, then re-run:\n"
            "  conda activate trellis\n"
            "  python3 tools/trellis2_edit_model_with_ovoxel.py ...\n"
            f"\nImport error: {e}"
        )
        return 2

    try:
        aabb = _parse_aabb(args.aabb)
    except Exception as e:
        _eprint(f"Invalid --aabb: {args.aabb} ({e})")
        return 2
    grid_size = int(args.grid_size)
    if grid_size <= 0:
        _eprint("--grid-size must be > 0")
        return 2

    # 1) Load and preprocess base mesh to TRELLIS canonical frame.
    base_mesh = _load_mesh_trimesh(base_mesh_path)
    base_mesh = _preprocess_mesh_to_trellis_space(base_mesh)
    base_v = torch.from_numpy(base_mesh.vertices).float()
    base_f = torch.from_numpy(base_mesh.faces).long()

    # 2) Generate edit target from image with TRELLIS2.
    _eprint(f"Running TRELLIS2 image->3D edit target from: {edit_image_path}")
    edit_mesh = _run_trellis_edit_mesh(args, edit_image_path)

    # 3) Voxelize both and blend occupancy.
    _eprint("Voxelizing base/edit meshes...")
    base_coords, base_dual, base_inter = _voxelize_mesh(base_v, base_f, grid_size=grid_size, aabb=aabb)
    edit_coords, edit_dual, edit_inter = _voxelize_mesh(edit_mesh.vertices, edit_mesh.faces.long(), grid_size=grid_size, aabb=aabb)

    base_ids, _ = _id_index(base_coords)
    edit_ids, _ = _id_index(edit_coords)
    base_ids_set = {int(x) for x in base_ids.detach().cpu().tolist()}
    edit_ids_set = {int(x) for x in edit_ids.detach().cpu().tolist()}
    out_ids = _blend_ids(base_ids_set, edit_ids_set, mode=str(args.merge_mode), strength=float(args.edit_strength))
    if not out_ids:
        _eprint("No voxels after blend. Try merge-mode=union or lower edit-strength.")
        return 2

    # Build id->row maps.
    base_map = {int(base_ids[i].item()): i for i in range(base_ids.shape[0])}
    edit_map = {int(edit_ids[i].item()): i for i in range(edit_ids.shape[0])}

    coords_rows = []
    dual_rows = []
    inter_rows = []

    # Optional attrs from edit mesh.
    edit_attr_map = {}
    edit_attr = getattr(edit_mesh, "attrs", None)
    edit_layout = getattr(edit_mesh, "layout", None)
    edit_coords_attr = getattr(edit_mesh, "coords", None)
    if edit_attr is not None and edit_coords_attr is not None:
        edit_attr_ids = o_voxel.serialize.encode_seq(edit_coords_attr.int())
        for i in range(edit_attr_ids.shape[0]):
            edit_attr_map[int(edit_attr_ids[i].item())] = i

    for vid in out_ids:
        if vid in edit_map:
            i = edit_map[vid]
            coords_rows.append(edit_coords[i])
            dual_rows.append(edit_dual[i])
            inter_rows.append(edit_inter[i])
        else:
            i = base_map[vid]
            coords_rows.append(base_coords[i])
            dual_rows.append(base_dual[i])
            inter_rows.append(base_inter[i])

    coords_out = torch.stack(coords_rows, dim=0).int()
    dual_out = torch.stack(dual_rows, dim=0).float()
    inter_out = torch.stack(inter_rows, dim=0).bool()

    # 4) Reconstruct edited geometry.
    _eprint("Reconstructing edited mesh from blended voxels...")
    device = "cuda" if str(args.device).startswith("cuda") and torch.cuda.is_available() else "cpu"
    rec_verts, rec_faces = o_voxel.convert.flexible_dual_grid_to_mesh(
        coords_out.to(device),
        dual_out.to(device),
        inter_out.to(device),
        grid_size=grid_size,
        aabb=aabb,
    )

    # 5) Build output voxel attributes (prefer TRELLIS edit attributes).
    n_vox = int(coords_out.shape[0])
    if edit_attr is not None and edit_attr_map:
        c = int(edit_attr.shape[1]) if edit_attr.dim() > 1 else 1
        attr_volume = torch.zeros((n_vox, c), dtype=edit_attr.dtype, device=device)
        for out_i, vid in enumerate(out_ids):
            src_i = edit_attr_map.get(vid, None)
            if src_i is not None:
                attr_volume[out_i] = edit_attr[src_i].to(device)
        attr_layout = edit_layout if isinstance(edit_layout, dict) and edit_layout else _make_attr_layout(c)
    else:
        # Fallback to simple neutral PBR-like channels.
        attr_volume = torch.zeros((n_vox, 6), dtype=torch.float32, device=device)
        attr_volume[:, 0:3] = 1.0  # white base color
        attr_volume[:, 4:5] = 1.0  # roughness
        attr_volume[:, 5:6] = 1.0  # alpha
        attr_layout = {
            "base_color": slice(0, 3),
            "metallic": slice(3, 4),
            "roughness": slice(4, 5),
            "alpha": slice(5, 6),
        }

    # 6) Export GLB.
    _eprint(f"Exporting edited GLB -> {out_glb}")
    glb = o_voxel.postprocess.to_glb(
        vertices=rec_verts,
        faces=rec_faces,
        attr_volume=attr_volume,
        coords=coords_out.to(device),
        attr_layout=attr_layout,
        grid_size=grid_size,
        aabb=aabb,
        decimation_target=int(args.decimation_target),
        texture_size=int(args.texture_size),
        remesh=bool(int(args.remesh)),
        remesh_band=float(args.remesh_band),
        remesh_project=float(args.remesh_project),
        verbose=bool(int(args.verbose)),
    )
    glb.export(str(out_glb), extension_webp=bool(int(args.extension_webp)))
    _eprint(f"Wrote {out_glb}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

