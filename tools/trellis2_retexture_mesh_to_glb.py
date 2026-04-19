#!/usr/bin/env python3
"""
Trellis2 (microsoft/TRELLIS.2-4B) connector: mesh + reference image -> textured GLB.

This is the "lifted" Trellis texturing pipeline, useful for character iteration:
- keep a fixed topology/rig-friendly mesh (body, hair mesh, clothing mesh)
- retexture it from a new reference render / concept image

Typical usage:
  conda run -n trellis python3 tools/trellis2_retexture_mesh_to_glb.py \
    --mesh assets/characters/base.glb \
    --image outputs/ref_outfit.png \
    --out-glb assets/generated/trellis_retexture/base_retex.glb
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def _eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="tools/trellis2_retexture_mesh_to_glb.py")
    ap.add_argument("--model", default="microsoft/TRELLIS.2-4B", help="HF model id.")
    ap.add_argument(
        "--config-file",
        default="texturing_pipeline.json",
        help="Pipeline config filename on HF (e.g. texturing_pipeline.json).",
    )
    ap.add_argument("--mesh", required=True, help="Input mesh path (GLB/GLTF/OBJ/PLY...).")
    ap.add_argument("--image", required=True, help="Reference image path.")
    ap.add_argument("--device", default="cuda", help='Device: "cuda", "cuda:0", or "cpu".')
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--resolution", type=int, default=1024, choices=[512, 1024], help="Internal voxel/bake resolution.")
    ap.add_argument("--texture-size", type=int, default=4096, help="Output texture resolution (power-of-two recommended).")
    ap.add_argument("--preprocess-image", type=int, default=1, choices=[0, 1], help="Run Trellis preprocessing (rembg/crop).")
    ap.add_argument("--tex-steps", type=int, default=None, help="Texture latent stage sampling steps.")
    ap.add_argument("--tex-guidance-strength", type=float, default=None, help="Texture latent stage guidance strength.")
    ap.add_argument("--tex-guidance-rescale", type=float, default=None, help="Texture latent stage guidance rescale.")
    ap.add_argument("--tex-rescale-t", type=float, default=None, help="Texture latent stage rescale_t.")
    ap.add_argument(
        "--preserve-uv",
        type=int,
        default=1,
        choices=[0, 1],
        help="Preserve input UVs when present (recommended for existing textured assets).",
    )
    ap.add_argument(
        "--extension-webp",
        type=int,
        default=1,
        choices=[0, 1],
        help="Use EXT_texture_webp when exporting GLB (smaller textures).",
    )
    ap.add_argument("--out-glb", required=True, help="Output GLB path.")
    return ap.parse_args()


def _get_mesh_uv(mesh) -> "object | None":
    """
    Returns an (N,2) ndarray of UVs if present, else None.
    """
    try:
        uv = getattr(getattr(mesh, "visual", None), "uv", None)
        if uv is None:
            return None
        # Guard: some trimesh visuals expose uv as a property that can throw.
        if getattr(uv, "shape", None) is None:
            return None
        return uv
    except Exception:
        return None


def _concat_meshes_preserve_uv(meshes):
    import numpy as np  # type: ignore
    import trimesh  # type: ignore

    verts = []
    faces = []
    uvs = []
    offset = 0
    all_have_uv = True
    for m in meshes:
        v = getattr(m, "vertices", None)
        f = getattr(m, "faces", None)
        if v is None or f is None:
            continue
        if len(v) == 0 or len(f) == 0:
            continue
        verts.append(np.asarray(v))
        faces.append(np.asarray(f) + int(offset))
        offset += int(np.asarray(v).shape[0])
        uv = _get_mesh_uv(m)
        if uv is None or np.asarray(uv).shape[0] != np.asarray(v).shape[0]:
            all_have_uv = False
        uvs.append(None if uv is None else np.asarray(uv))

    if not verts or not faces:
        raise ValueError("No usable meshes to concatenate")

    v_all = np.vstack(verts)
    f_all = np.vstack(faces)

    visual = None
    if all_have_uv:
        uv_all = np.vstack([u for u in uvs if u is not None])
        # trimesh expects per-vertex UVs.
        if uv_all.shape[0] == v_all.shape[0]:
            visual = trimesh.visual.texture.TextureVisuals(uv=uv_all)

    return trimesh.Trimesh(vertices=v_all, faces=f_all, process=False, visual=visual)


def _load_mesh_trimesh(mesh_path: Path, *, preserve_uv: bool):
    # Lazy import: trimesh can be slow and optional outside the trellis env.
    import trimesh  # type: ignore

    loaded = trimesh.load(str(mesh_path), force=None, skip_materials=False, process=False)
    if isinstance(loaded, trimesh.Trimesh):
        return loaded
    if isinstance(loaded, trimesh.Scene):
        # Prefer Scene.dump() so node transforms are applied (common in GLB/GLTF).
        meshes = []
        try:
            dumped = loaded.dump(concatenate=False)
            if isinstance(dumped, list):
                meshes = dumped
            elif isinstance(dumped, trimesh.Trimesh):
                meshes = [dumped]
        except Exception:
            meshes = []

        # Fallback: raw geometry dict (may miss transforms).
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

        # For existing textured assets, preserving UVs avoids costly/fragile unwrap.
        if preserve_uv:
            try:
                return _concat_meshes_preserve_uv(meshes)
            except Exception:
                pass

        # Fallback: concatenate without UV preservation (Trellis will unwrap later).
        try:
            return trimesh.util.concatenate(meshes)
        except Exception:
            # Fall back: pick the largest geom by face count.
            meshes.sort(key=lambda m: int(getattr(m, "faces", []).shape[0]), reverse=True)
            return meshes[0]
    raise TypeError(f"Unsupported mesh type from trimesh.load(): {type(loaded)}")


def _trellis_preprocess_mesh_keep_uv(mesh):
    """
    Trellis2 preprocess_mesh(), but preserve UVs if they exist on input mesh.

    Trellis upstream drops UVs during preprocess, forcing a fresh unwrap in postprocess.
    That often hurts existing assets which already have good UVs/materials.
    """
    import numpy as np  # type: ignore
    import trimesh  # type: ignore

    vertices = np.asarray(mesh.vertices).copy()
    faces = np.asarray(mesh.faces).copy()
    uv = _get_mesh_uv(mesh)
    uv = None if uv is None else np.asarray(uv).copy()

    if vertices.size == 0 or faces.size == 0:
        raise ValueError("Empty mesh")

    vmin = vertices.min(axis=0)
    vmax = vertices.max(axis=0)
    center = (vmin + vmax) / 2.0
    denom = float((vmax - vmin).max())
    scale = (0.99999 / denom) if denom > 0 else 1.0
    vertices = (vertices - center) * scale

    tmp = vertices[:, 1].copy()
    vertices[:, 1] = -vertices[:, 2]
    vertices[:, 2] = tmp

    if not np.all(np.isfinite(vertices)):
        raise ValueError("Mesh vertices contain NaN/Inf after preprocess")
    if not (np.all(vertices >= -0.5) and np.all(vertices <= 0.5)):
        raise ValueError("vertices out of range after preprocess (expected within [-0.5, 0.5])")

    visual = None
    if uv is not None and uv.shape[0] == vertices.shape[0]:
        try:
            visual = trimesh.visual.texture.TextureVisuals(uv=uv)
        except Exception:
            visual = None

    return trimesh.Trimesh(vertices=vertices, faces=faces, process=False, visual=visual)


def main() -> int:
    os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

    # Local checkout import shim (like other tools/* connectors)
    repo_root = Path(__file__).resolve().parents[1]
    trellis_src = repo_root / "repos" / "TRELLIS.2"
    if trellis_src.exists() and (trellis_src / "trellis2").exists():
        sys.path.insert(0, str(trellis_src))

    args = _parse_args()
    mesh_path = Path(args.mesh).expanduser().resolve()
    image_path = Path(args.image).expanduser().resolve()
    out_glb = Path(args.out_glb).expanduser().resolve()
    out_glb.parent.mkdir(parents=True, exist_ok=True)

    if not mesh_path.exists():
        _eprint(f"Input mesh not found: {mesh_path}")
        return 2
    if not image_path.exists():
        _eprint(f"Reference image not found: {image_path}")
        return 2

    try:
        import torch  # type: ignore
        from PIL import Image  # type: ignore
        from trellis2.pipelines import Trellis2TexturingPipeline  # type: ignore
    except Exception as e:
        _eprint(
            "Missing dependencies for Trellis2 texturing.\n"
            "Activate your Trellis environment first, then re-run:\n"
            "  conda activate trellis\n"
            "  python3 tools/trellis2_retexture_mesh_to_glb.py ...\n"
            f"\nImport error: {e}"
        )
        return 2

    device = str(args.device).strip() or "cuda"

    pipeline = Trellis2TexturingPipeline.from_pretrained(str(args.model), config_file=str(args.config_file))
    if device.startswith("cuda"):
        pipeline.cuda()
    else:
        to = getattr(pipeline, "to", None)
        if callable(to):
            pipeline.to(device)

    # Load inputs
    mesh = _load_mesh_trimesh(mesh_path, preserve_uv=bool(int(args.preserve_uv)))
    image = Image.open(str(image_path))

    # Run
    #
    # Upstream Trellis2TexturingPipeline.run() calls preprocess_mesh() which drops UVs.
    # For existing assets (omniverse + prior trellis outputs), preserving UVs makes
    # retexturing far more reliable and avoids expensive unwrap on high-poly meshes.
    if bool(int(args.preserve_uv)):
        if bool(int(args.preprocess_image)):
            image = pipeline.preprocess_image(image)
        mesh_pp = _trellis_preprocess_mesh_keep_uv(mesh)
        torch.manual_seed(int(args.seed))
        cond = pipeline.get_cond([image], 512) if int(args.resolution) == 512 else pipeline.get_cond([image], 1024)
        shape_slat = pipeline.encode_shape_slat(mesh_pp, int(args.resolution))
        tex_model = pipeline.models["tex_slat_flow_model_512"] if int(args.resolution) == 512 else pipeline.models["tex_slat_flow_model_1024"]
        tex_sampler = {}
        if args.tex_steps is not None:
            tex_sampler["steps"] = int(args.tex_steps)
        if args.tex_guidance_strength is not None:
            tex_sampler["guidance_strength"] = float(args.tex_guidance_strength)
        if args.tex_guidance_rescale is not None:
            tex_sampler["guidance_rescale"] = float(args.tex_guidance_rescale)
        if args.tex_rescale_t is not None:
            tex_sampler["rescale_t"] = float(args.tex_rescale_t)
        tex_slat = pipeline.sample_tex_slat(cond, tex_model, shape_slat, tex_sampler)
        pbr_voxel = pipeline.decode_tex_slat(tex_slat)
        out_mesh = pipeline.postprocess_mesh(mesh_pp, pbr_voxel, int(args.resolution), int(args.texture_size))
    else:
        run_kwargs = {
            "mesh": mesh,
            "image": image,
            "seed": int(args.seed),
            "preprocess_image": bool(int(args.preprocess_image)),
            "resolution": int(args.resolution),
            "texture_size": int(args.texture_size),
        }
        tex_sampler = {}
        if args.tex_steps is not None:
            tex_sampler["steps"] = int(args.tex_steps)
        if args.tex_guidance_strength is not None:
            tex_sampler["guidance_strength"] = float(args.tex_guidance_strength)
        if args.tex_guidance_rescale is not None:
            tex_sampler["guidance_rescale"] = float(args.tex_guidance_rescale)
        if args.tex_rescale_t is not None:
            tex_sampler["rescale_t"] = float(args.tex_rescale_t)
        if tex_sampler:
            run_kwargs["tex_slat_sampler_params"] = tex_sampler
        while True:
            try:
                out_mesh = pipeline.run(**run_kwargs)
                break
            except TypeError as e:
                msg = str(e)
                if "tex_slat_sampler_params" in run_kwargs and "tex_slat_sampler_params" in msg:
                    run_kwargs.pop("tex_slat_sampler_params", None)
                    continue
                raise

    # Export
    try:
        out_mesh.export(str(out_glb), extension_webp=bool(int(args.extension_webp)))
        _eprint(f"Wrote {out_glb}")
    except Exception as e:
        _eprint(f"Failed exporting GLB via trimesh: {e}")
        return 2

    # Best-effort: free VRAM
    try:
        if device.startswith("cuda"):
            torch.cuda.empty_cache()
    except Exception:
        pass

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

