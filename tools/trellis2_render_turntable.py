#!/usr/bin/env python3
"""
Trellis2 PBR turntable renderer: GLB/GLTF -> MP4.

This lifts Trellis' renderer stack (nvdiffrast + nvdiffrec env lighting) to give
consistent preview videos/thumbnails for assets in your pipeline.

Typical usage:
  conda run -n trellis python3 tools/trellis2_render_turntable.py \
    --glb assets/generated/trellis/foo.glb \
    --out-mp4 outputs/foo_turntable.mp4 \
    --envmap repos/TRELLIS.2/assets/hdri/studio.exr
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def _eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


def _auto_pick_envmap(repo_root: Path) -> Path | None:
    try:
        override = str(os.environ.get("WEBGL_GAME_DEFAULT_ENVMAP", "")).strip()
        if override:
            p = Path(override).expanduser()
            if p.exists():
                return p.resolve()
    except Exception:
        pass

    candidates = [
        repo_root / "assets" / "hdri" / "studio.exr",
        repo_root / "repos" / "TRELLIS.2" / "assets" / "hdri" / "studio.exr",
        repo_root / "assets" / "hdri" / "forest.exr",
        repo_root / "repos" / "TRELLIS.2" / "assets" / "hdri" / "forest.exr",
    ]
    for p in candidates:
        if p.exists():
            return p.resolve()

    for d in [repo_root / "assets" / "hdri", repo_root / "repos" / "TRELLIS.2" / "assets" / "hdri"]:
        try:
            if not d.exists():
                continue
            hits = sorted([*d.glob("*.exr"), *d.glob("*.hdr")])
            if hits:
                return hits[0].resolve()
        except Exception:
            continue
    return None


def _resolve_envmap_arg(args_envmap: str, repo_root: Path) -> Path | None:
    raw = str(args_envmap or "").strip()
    if raw:
        p = Path(raw).expanduser()
        if p.exists():
            return p.resolve()
        _eprint(f"Warning: --envmap not found: {p}. Falling back to default envmap (if available).")
    return _auto_pick_envmap(repo_root)


def _generate_fallback_envmap():
    """
    Generate a simple studio-like environment map as a torch tensor
    when no HDRI file is available.  Returns a float32 CUDA tensor of
    shape [H, W, 3].
    """
    import numpy as np  # type: ignore
    import torch  # type: ignore

    H, W = 512, 1024
    env = np.full((H, W, 3), 0.35, dtype=np.float32)  # neutral grey base

    # Brighter upper hemisphere (sky / studio overhead light)
    for y in range(H):
        t = y / max(H - 1, 1)  # 0=top, 1=bottom
        # top-down gradient: bright at top, dimmer at bottom
        brightness = 1.0 - 0.55 * t
        env[y, :, :] *= brightness

    # Add a soft key light (bright spot upper-front)
    cy, cx = int(H * 0.25), int(W * 0.5)
    for y in range(H):
        for x in range(W):
            dx = (x - cx) / W
            dy = (y - cy) / H
            d2 = dx * dx + dy * dy
            env[y, x, :] += 1.8 * np.exp(-d2 / 0.012)

    env = np.clip(env, 0.0, 8.0)
    return torch.from_numpy(env).float().cuda()


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="tools/trellis2_render_turntable.py")
    ap.add_argument("--glb", required=True, help="Input GLB/GLTF path.")
    ap.add_argument("--out-mp4", required=True, help="Output MP4 path.")
    ap.add_argument("--envmap", default="", help="HDRI envmap (EXR/HDR). If omitted, auto-pick.")
    ap.add_argument("--fps", type=int, default=15)
    ap.add_argument("--num-frames", type=int, default=120)
    ap.add_argument("--resolution", type=int, default=768)
    ap.add_argument("--r", type=float, default=2.0)
    ap.add_argument("--fov", type=float, default=40.0)
    ap.add_argument("--device", default="cuda", help='Only "cuda" is supported for Trellis renderers.')
    return ap.parse_args()


def _to_float01_img(img):
    import numpy as np  # type: ignore
    from PIL import Image  # type: ignore

    if img is None:
        return None
    if isinstance(img, Image.Image):
        arr = np.array(img)
    else:
        arr = np.array(img)
    if arr.ndim == 2:
        arr = arr[..., None]
    if arr.shape[-1] == 4:
        arr = arr[..., :4]
    if arr.dtype != np.uint8:
        # best-effort normalize common float formats
        arr = np.clip(arr, 0.0, 1.0)
        return arr.astype("float32")
    return (arr.astype("float32") / 255.0)


def _load_glb_as_trellis_mesh(glb_path: Path):
    """
    Convert a GLB/GLTF into Trellis' MeshWithPbrMaterial representation.

    Notes:
    - This is best-effort and supports the common "single mesh + single material" case.
    - If UVs are missing, we try UV unwrap via CuMesh.
    """
    import numpy as np  # type: ignore
    import torch  # type: ignore
    import trimesh  # type: ignore

    from trellis2.representations.mesh import MeshWithPbrMaterial, PbrMaterial, Texture, AlphaMode  # type: ignore

    loaded = trimesh.load(str(glb_path), force=None, skip_materials=False, process=False)
    if isinstance(loaded, trimesh.Scene):
        geoms = []
        for g in loaded.geometry.values():
            if isinstance(g, trimesh.Trimesh) and len(g.vertices) and len(g.faces):
                geoms.append(g)
        if not geoms:
            raise ValueError("GLB load returned an empty scene")
        # Pick the biggest geom; multi-primitive materials are not handled yet.
        geoms.sort(key=lambda m: int(getattr(m, "faces", []).shape[0]), reverse=True)
        mesh = geoms[0]
    elif isinstance(loaded, trimesh.Trimesh):
        mesh = loaded
    else:
        raise TypeError(f"Unsupported trimesh load result: {type(loaded)}")

    v = torch.from_numpy(np.asarray(mesh.vertices)).float().cuda()
    f = torch.from_numpy(np.asarray(mesh.faces)).int().cuda()

    # UVs
    uvs = None
    try:
        uvs = getattr(mesh.visual, "uv", None)
    except Exception:
        uvs = None

    if uvs is None or (hasattr(uvs, "shape") and int(uvs.shape[0]) == 0):
        # Try UV unwrap via CuMesh (same dependency Trellis uses elsewhere).
        try:
            import cumesh  # type: ignore

            cm = cumesh.CuMesh()
            cm.init(v, f)
            v2, f2, uv2, vmap = cm.uv_unwrap(return_vmaps=True)
            v = v2.cuda()
            f = f2.cuda()
            uvs = uv2.cpu().numpy()
        except Exception as e:
            raise RuntimeError(f"Mesh has no UVs and uv_unwrap failed: {e}") from e

    uvs = np.asarray(uvs, dtype=np.float32)
    if uvs.shape[-1] != 2:
        raise ValueError(f"Unexpected UV shape: {uvs.shape}")
    uv_face = uvs[np.asarray(f.cpu().numpy())]  # [M, 3, 2]
    uv_coords = torch.from_numpy(uv_face).float().cuda()

    # Material (best-effort for trimesh PBR)
    mat = getattr(getattr(mesh, "visual", None), "material", None)
    base_factor = [1.0, 1.0, 1.0]
    metallic_factor = 1.0
    roughness_factor = 1.0
    alpha_mode = AlphaMode.OPAQUE
    alpha_cutoff = 0.5

    base_tex = None
    mr_tex = None

    if mat is not None:
        try:
            bf = getattr(mat, "baseColorFactor", None)
            if bf is not None and len(bf) >= 3:
                base_factor = [float(bf[0]), float(bf[1]), float(bf[2])]
        except Exception:
            pass
        try:
            metallic_factor = float(getattr(mat, "metallicFactor", metallic_factor))
        except Exception:
            pass
        try:
            roughness_factor = float(getattr(mat, "roughnessFactor", roughness_factor))
        except Exception:
            pass
        try:
            am = str(getattr(mat, "alphaMode", "") or "").upper()
            if am == "MASK":
                alpha_mode = AlphaMode.MASK
            elif am == "BLEND":
                alpha_mode = AlphaMode.BLEND
            else:
                alpha_mode = AlphaMode.OPAQUE
        except Exception:
            pass
        try:
            alpha_cutoff = float(getattr(mat, "alphaCutoff", alpha_cutoff))
        except Exception:
            pass

        base_tex = getattr(mat, "baseColorTexture", None)
        mr_tex = getattr(mat, "metallicRoughnessTexture", None)

    def to_tex_rgb(img_any):
        arr = _to_float01_img(img_any)
        if arr is None:
            return None, None
        if arr.shape[-1] == 4:
            rgb = arr[..., :3]
            a = arr[..., 3:4]
        elif arr.shape[-1] >= 3:
            rgb = arr[..., :3]
            a = None
        else:
            rgb = None
            a = None
        if rgb is None:
            return None, None
        rgb_t = torch.from_numpy(rgb).float().cuda()
        a_t = torch.from_numpy(a).float().cuda() if a is not None else None
        return rgb_t, a_t

    def to_tex_mr(img_any):
        arr = _to_float01_img(img_any)
        if arr is None:
            return None, None
        if arr.shape[-1] < 3:
            return None, None
        # glTF metallicRoughnessTexture: G=roughness, B=metallic.
        rough = arr[..., 1:2]
        metal = arr[..., 2:3]
        return torch.from_numpy(metal).float().cuda(), torch.from_numpy(rough).float().cuda()

    bc_rgb, bc_a = to_tex_rgb(base_tex)
    m_tex, r_tex = to_tex_mr(mr_tex)

    pbr = PbrMaterial(
        base_color_texture=Texture(bc_rgb) if bc_rgb is not None else None,
        base_color_factor=base_factor,
        metallic_texture=Texture(m_tex) if m_tex is not None else None,
        metallic_factor=metallic_factor,
        roughness_texture=Texture(r_tex) if r_tex is not None else None,
        roughness_factor=roughness_factor,
        alpha_texture=Texture(bc_a) if bc_a is not None else None,
        alpha_factor=1.0,
        alpha_mode=alpha_mode,
        alpha_cutoff=alpha_cutoff,
    )

    material_ids = torch.zeros((f.shape[0],), dtype=torch.int64, device="cuda")
    mesh = MeshWithPbrMaterial(v, f, material_ids, uv_coords, [pbr])
    # Ensure all tensors (including PbrMaterial.base_color_factor) are on CUDA.
    return mesh.to("cuda")


def main() -> int:
    os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

    repo_root = Path(__file__).resolve().parents[1]
    trellis_src = repo_root / "repos" / "TRELLIS.2"
    if trellis_src.exists() and (trellis_src / "trellis2").exists():
        sys.path.insert(0, str(trellis_src))

    args = _parse_args()
    glb_path = Path(args.glb).expanduser().resolve()
    out_mp4 = Path(args.out_mp4).expanduser().resolve()
    out_mp4.parent.mkdir(parents=True, exist_ok=True)

    if not glb_path.exists():
        _eprint(f"Input GLB not found: {glb_path}")
        return 2

    if not str(args.device).startswith("cuda"):
        _eprint('Only CUDA rendering is supported (pass --device cuda).')
        return 2

    try:
        import cv2  # type: ignore
        import imageio  # type: ignore
        import torch  # type: ignore
        from trellis2.utils import render_utils  # type: ignore
        from trellis2.renderers import EnvMap  # type: ignore
    except Exception as e:
        _eprint(f"Missing render dependencies (cv2/imageio/torch/trellis2): {e}")
        return 2

    envmap_path = _resolve_envmap_arg(str(args.envmap), repo_root)
    if envmap_path and envmap_path.exists():
        img = cv2.imread(str(envmap_path), cv2.IMREAD_UNCHANGED)
        if img is None:
            _eprint(f"Failed to read envmap: {envmap_path} (OpenCV returned None)")
            return 2
        env = EnvMap(torch.tensor(cv2.cvtColor(img, cv2.COLOR_BGR2RGB), dtype=torch.float32, device="cuda"))
    else:
        _eprint("No HDRI envmap found. Using procedural studio fallback. "
                "For better results, place an .exr/.hdr file under assets/hdri/ or repos/TRELLIS.2/assets/hdri/")
        env = EnvMap(_generate_fallback_envmap())

    # Load + convert mesh
    try:
        mesh = _load_glb_as_trellis_mesh(glb_path)
    except Exception as e:
        _eprint(f"Failed loading GLB for render: {e}")
        return 2

    # Render frames
    res = render_utils.render_video(
        mesh,
        envmap=env,
        resolution=int(args.resolution),
        num_frames=int(args.num_frames),
        r=float(args.r),
        fov=float(args.fov),
    )
    frames = res.get("shaded", []) or []
    if not frames:
        _eprint("Render returned no frames.")
        return 2

    imageio.mimsave(str(out_mp4), frames, fps=int(args.fps))
    _eprint(f"Wrote {out_mp4}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

