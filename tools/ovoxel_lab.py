#!/usr/bin/env python3
"""
O-Voxel Lab utility for DevTools.

Subcommands:
  - convert:     mesh -> .vxz
  - reconstruct: .vxz -> .ply/.glb
  - render:      .vxz -> preview image/mp4 (voxel rasterization)
  - inspect:     print voxel stats/attributes
  - io-convert:  voxel format conversion (.vxz/.npz/.ply)
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path
from typing import Any


def _eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _ensure_trellis_import_path() -> None:
    trellis_src = _repo_root() / "repos" / "TRELLIS.2"
    if trellis_src.exists() and (trellis_src / "trellis2").exists():
        sys.path.insert(0, str(trellis_src))


def _parse_aabb(raw: str) -> list[list[float]]:
    s = str(raw or "").strip()
    parts = [p.strip() for p in s.split(",") if p.strip()]
    if len(parts) != 6:
        raise ValueError("aabb must contain 6 comma-separated floats")
    vals = [float(x) for x in parts]
    return [[vals[0], vals[1], vals[2]], [vals[3], vals[4], vals[5]]]


def _parse_grid_size(raw: str) -> int:
    v = int(raw)
    if v <= 0:
        raise ValueError("grid size must be > 0")
    return v


def _load_mesh_asset(mesh_path: Path):
    import trimesh  # type: ignore

    loaded = trimesh.load(str(mesh_path), force=None, process=False)
    if isinstance(loaded, trimesh.Trimesh):
        return loaded
    if isinstance(loaded, trimesh.Scene):
        dumped = loaded.dump(concatenate=True)
        if isinstance(dumped, trimesh.Trimesh):
            return dumped
    return loaded


def _pack_dual_and_intersected(dual_vertices, intersected, grid_size: int):
    import torch  # type: ignore

    dual_vertices = dual_vertices * grid_size - dual_vertices.floor() * 0 + 0  # no-op to keep shape/type stable
    dual_vertices = dual_vertices * grid_size - torch.floor(dual_vertices * grid_size)
    dual_vertices = (torch.clamp(dual_vertices, 0, 1) * 255).to(torch.uint8)
    intersected_u8 = (
        intersected[:, 0:1].to(torch.uint8)
        + 2 * intersected[:, 1:2].to(torch.uint8)
        + 4 * intersected[:, 2:3].to(torch.uint8)
    )
    return dual_vertices, intersected_u8


def _pack_dual_from_raw(coords, dual_vertices, intersected, grid_size: int):
    import torch  # type: ignore

    # Pack exactly as o-voxel examples: local offset inside each voxel + 3-bit intersected flag.
    dual_local = dual_vertices * grid_size - coords
    dual_local = (torch.clamp(dual_local, 0, 1) * 255).to(torch.uint8)
    intersected_u8 = (
        intersected[:, 0:1].to(torch.uint8)
        + 2 * intersected[:, 1:2].to(torch.uint8)
        + 4 * intersected[:, 2:3].to(torch.uint8)
    )
    return dual_local, intersected_u8


def _unpack_dual_and_intersected(data):
    import torch  # type: ignore

    if "dual_vertices" not in data:
        raise ValueError("Missing required attribute: dual_vertices")
    if "intersected" not in data:
        raise ValueError("Missing required attribute: intersected")
    dual = data["dual_vertices"].float() / 255.0
    inter = data["intersected"]
    if inter.dim() == 1:
        inter = inter.reshape(-1, 1)
    inter = torch.cat(
        [
            inter % 2,
            inter // 2 % 2,
            inter // 4 % 2,
        ],
        dim=-1,
    ).bool()
    return dual, inter


def _infer_grid_size(coords) -> int:
    mx = coords.max(dim=0).values
    return int(mx.max().item()) + 1


def _align_attributes_by_coords(coords_ref, coords_src, attr_src):
    import torch  # type: ignore
    import o_voxel  # type: ignore

    vid_ref = o_voxel.serialize.encode_seq(coords_ref)
    vid_src = o_voxel.serialize.encode_seq(coords_src)
    ref_order = torch.argsort(vid_ref)
    src_order = torch.argsort(vid_src)
    vid_ref_s = vid_ref[ref_order]
    vid_src_s = vid_src[src_order]
    pos = torch.searchsorted(vid_src_s, vid_ref_s)
    ok = (pos >= 0) & (pos < vid_src_s.shape[0]) & (vid_src_s[pos] == vid_ref_s)

    aligned = {}
    for k, v in attr_src.items():
        ch = int(v.shape[1]) if v.dim() > 1 else 1
        vv = v.reshape(v.shape[0], ch)
        out = torch.zeros((coords_ref.shape[0], ch), dtype=vv.dtype)
        src_v = vv[src_order]
        out_idx = ref_order[ok]
        src_idx = pos[ok]
        out[out_idx] = src_v[src_idx]
        aligned[k] = out
    return aligned, int(ok.sum().item()), int(coords_ref.shape[0])


def _attrs_to_volume(data, n_vox):
    import torch  # type: ignore

    def _u8_or_default(key: str, ch: int, default_val: int):
        v = data.get(key, None)
        if v is None:
            return torch.full((n_vox, ch), int(default_val), dtype=torch.uint8)
        if v.dim() == 1:
            v = v.reshape(-1, 1)
        v = v[:, :ch]
        if v.shape[1] < ch:
            pad = torch.full((n_vox, ch - v.shape[1]), int(default_val), dtype=v.dtype)
            v = torch.cat([v, pad], dim=1)
        if v.dtype != torch.uint8:
            v = torch.clamp(v, 0, 255).to(torch.uint8)
        return v

    base_color = _u8_or_default("base_color", 3, 255).float() / 255.0
    metallic = _u8_or_default("metallic", 1, 0).float() / 255.0
    roughness = _u8_or_default("roughness", 1, 255).float() / 255.0
    alpha = _u8_or_default("alpha", 1, 255).float() / 255.0
    attr_volume = torch.cat([base_color, metallic, roughness, alpha], dim=-1)
    attr_layout = {
        "base_color": slice(0, 3),
        "metallic": slice(3, 4),
        "roughness": slice(4, 5),
        "alpha": slice(5, 6),
    }
    return attr_volume, attr_layout


def _is_mesh_input(path: Path) -> bool:
    return path.suffix.lower() in {".glb", ".gltf", ".obj", ".ply", ".stl", ".off"}


def _voxelize_mesh_for_render(in_path: Path, grid_size: int, aabb: list[list[float]]):
    import torch  # type: ignore
    import o_voxel  # type: ignore

    asset = _load_mesh_asset(in_path)
    mesh = asset.to_mesh() if hasattr(asset, "to_mesh") else asset
    if mesh is None:
        raise ValueError(f"Failed to load mesh: {in_path}")

    vertices = torch.from_numpy(mesh.vertices).float()
    faces = torch.from_numpy(mesh.faces).long()
    coords_geo, _, _ = o_voxel.convert.mesh_to_flexible_dual_grid(
        vertices,
        faces,
        grid_size=grid_size,
        aabb=aabb,
        face_weight=1.0,
        boundary_weight=0.2,
        regularization_weight=1e-2,
        timing=False,
    )

    try:
        coords_mat, attrs_raw = o_voxel.convert.textured_mesh_to_volumetric_attr(
            asset,
            grid_size=grid_size,
            aabb=aabb,
            timing=False,
        )
        attrs, _, _ = _align_attributes_by_coords(coords_geo, coords_mat, attrs_raw)
    except Exception:
        attrs = {
            "base_color": torch.full((coords_geo.shape[0], 3), 255, dtype=torch.uint8),
        }

    return coords_geo, attrs


def cmd_convert(args: argparse.Namespace) -> dict[str, Any]:
    import torch  # type: ignore
    import o_voxel  # type: ignore

    mesh_path = Path(args.mesh).expanduser().resolve()
    out_vxz = Path(args.out).expanduser().resolve()
    if not mesh_path.exists():
        raise FileNotFoundError(f"Input mesh not found: {mesh_path}")
    out_vxz.parent.mkdir(parents=True, exist_ok=True)

    asset = _load_mesh_asset(mesh_path)
    mesh = asset.to_mesh() if hasattr(asset, "to_mesh") else asset
    if mesh is None:
        raise ValueError("Failed to load mesh")

    grid_size = _parse_grid_size(str(args.grid_size))
    aabb = _parse_aabb(args.aabb)
    vertices = torch.from_numpy(mesh.vertices).float()
    faces = torch.from_numpy(mesh.faces).long()

    coords_geo, dual_vertices, intersected = o_voxel.convert.mesh_to_flexible_dual_grid(
        vertices,
        faces,
        grid_size=grid_size,
        aabb=aabb,
        face_weight=float(args.face_weight),
        boundary_weight=float(args.boundary_weight),
        regularization_weight=float(args.regularization_weight),
        timing=bool(int(args.timing)),
    )

    attrs_raw = {}
    coords_mat = None
    texture_error = ""
    try:
        coords_mat, attrs_raw = o_voxel.convert.textured_mesh_to_volumetric_attr(
            asset,
            grid_size=grid_size,
            aabb=aabb,
            timing=bool(int(args.timing)),
        )
    except Exception as e:
        texture_error = str(e)
        # Keep geometry export usable even when source has no valid PBR texture setup.
        attrs_raw = {
            "base_color": torch.full((coords_geo.shape[0], 3), 255, dtype=torch.uint8),
            "metallic": torch.zeros((coords_geo.shape[0], 1), dtype=torch.uint8),
            "roughness": torch.full((coords_geo.shape[0], 1), 255, dtype=torch.uint8),
            "alpha": torch.full((coords_geo.shape[0], 1), 255, dtype=torch.uint8),
        }
        coords_mat = coords_geo

    attrs, matched, total = _align_attributes_by_coords(coords_geo, coords_mat, attrs_raw)
    dual_u8, inter_u8 = _pack_dual_from_raw(coords_geo, dual_vertices, intersected, grid_size)
    attrs["dual_vertices"] = dual_u8
    attrs["intersected"] = inter_u8
    o_voxel.io.write(str(out_vxz), coords_geo.int(), attrs)

    return {
        "mode": "convert",
        "mesh": str(mesh_path),
        "out": str(out_vxz),
        "grid_size": grid_size,
        "aabb": aabb,
        "num_voxels": int(coords_geo.shape[0]),
        "attrs": {k: [int(v.shape[1])] for k, v in attrs.items()},
        "material_alignment": {
            "matched": matched,
            "total": total,
            "ratio": (float(matched) / float(total)) if total > 0 else 0.0,
        },
        "texture_error": texture_error,
    }


def cmd_reconstruct(args: argparse.Namespace) -> dict[str, Any]:
    import torch  # type: ignore
    import trimesh  # type: ignore
    import o_voxel  # type: ignore

    in_path = Path(args.input).expanduser().resolve()
    out_path = Path(args.out).expanduser().resolve()
    if not in_path.exists():
        raise FileNotFoundError(f"Input voxel file not found: {in_path}")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    coords, data = o_voxel.io.read(str(in_path))
    grid_size = _parse_grid_size(str(args.grid_size)) if str(args.grid_size).strip() else _infer_grid_size(coords)
    aabb = _parse_aabb(args.aabb)
    dual, inter = _unpack_dual_and_intersected(data)

    if str(args.device).startswith("cuda") and torch.cuda.is_available():
        device = "cuda"
    else:
        device = "cpu"
    coords_d = coords.to(device)
    dual_d = dual.to(device)
    inter_d = inter.to(device)

    split_weight = None
    if str(args.split_weight).strip():
        split_val = float(args.split_weight)
        split_weight = torch.full((coords_d.shape[0],), split_val, dtype=torch.float32, device=device)

    rec_verts, rec_faces = o_voxel.convert.flexible_dual_grid_to_mesh(
        coords_d,
        dual_d,
        inter_d,
        split_weight=split_weight,
        grid_size=grid_size,
        aabb=aabb,
    )

    ext = out_path.suffix.lower()
    if ext == ".ply":
        mesh = trimesh.Trimesh(vertices=rec_verts.cpu().numpy(), faces=rec_faces.cpu().numpy(), process=False)
        mesh.export(str(out_path))
    elif ext == ".glb":
        attr_volume, attr_layout = _attrs_to_volume(data, int(coords.shape[0]))
        glb = o_voxel.postprocess.to_glb(
            vertices=rec_verts,
            faces=rec_faces,
            attr_volume=attr_volume.to(device),
            coords=coords_d,
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
        glb.export(str(out_path), extension_webp=bool(int(args.extension_webp)))
    else:
        raise ValueError("Output must be .ply or .glb")

    return {
        "mode": "reconstruct",
        "input": str(in_path),
        "out": str(out_path),
        "grid_size": grid_size,
        "aabb": aabb,
        "num_voxels": int(coords.shape[0]),
        "num_vertices": int(rec_verts.shape[0]),
        "num_faces": int(rec_faces.shape[0]),
        "device": device,
    }


def _camera_look_at(yaw_rad: float, pitch_rad: float, radius: float, fov_deg: float, device: str):
    import torch  # type: ignore
    import utils3d  # type: ignore

    eye = torch.tensor(
        [
            math.sin(yaw_rad) * math.cos(pitch_rad),
            math.cos(yaw_rad) * math.cos(pitch_rad),
            math.sin(pitch_rad),
        ],
        dtype=torch.float32,
        device=device,
    ) * float(radius)
    target = torch.tensor([0.0, 0.0, 0.0], dtype=torch.float32, device=device)
    up = torch.tensor([0.0, 0.0, 1.0], dtype=torch.float32, device=device)
    extr = utils3d.torch.extrinsics_look_at(eye, target, up)
    fov = torch.deg2rad(torch.tensor(float(fov_deg), dtype=torch.float32, device=device))
    intr = utils3d.torch.intrinsics_from_fov_xy(fov, fov)
    return extr, intr


def cmd_render(args: argparse.Namespace) -> dict[str, Any]:
    import numpy as np  # type: ignore
    import torch  # type: ignore
    import imageio  # type: ignore
    import o_voxel  # type: ignore

    in_path = Path(args.input).expanduser().resolve()
    out_image = Path(args.out_image).expanduser().resolve()
    out_mp4 = Path(args.out_mp4).expanduser().resolve() if str(args.out_mp4).strip() else None
    if not in_path.exists():
        raise FileNotFoundError(f"Input voxel file not found: {in_path}")
    out_image.parent.mkdir(parents=True, exist_ok=True)
    if out_mp4:
        out_mp4.parent.mkdir(parents=True, exist_ok=True)

    if not torch.cuda.is_available():
        raise RuntimeError("VoxelRenderer currently requires CUDA")

    aabb = _parse_aabb(args.aabb)
    suffix = in_path.suffix.lower()
    voxel_suffixes = {".vxz", ".npz", ".ply"}
    if suffix in voxel_suffixes:
        try:
            coords, data = o_voxel.io.read(str(in_path))
            grid_size = _parse_grid_size(str(args.grid_size)) if str(args.grid_size).strip() else _infer_grid_size(coords)
            base_color = data.get("base_color", None)
        except Exception:
            if suffix != ".ply":
                raise
            # .ply can be either a voxel container or a triangle mesh; fallback to mesh path.
            grid_size = _parse_grid_size(str(args.grid_size)) if str(args.grid_size).strip() else 512
            coords, attrs = _voxelize_mesh_for_render(in_path, grid_size, aabb)
            base_color = attrs.get("base_color", None)
    elif _is_mesh_input(in_path):
        grid_size = _parse_grid_size(str(args.grid_size)) if str(args.grid_size).strip() else 512
        coords, attrs = _voxelize_mesh_for_render(in_path, grid_size, aabb)
        base_color = attrs.get("base_color", None)
    else:
        raise ValueError(f"Unsupported input type for render: {in_path}")

    device = "cuda"

    if base_color is None:
        base_color = torch.full((coords.shape[0], 3), 255, dtype=torch.uint8)
    if base_color.dim() == 1:
        base_color = base_color.reshape(-1, 1)
    if base_color.shape[1] < 3:
        pad = torch.full((coords.shape[0], 3 - base_color.shape[1]), 255, dtype=base_color.dtype)
        base_color = torch.cat([base_color, pad], dim=1)
    attrs = (base_color[:, :3].float() / 255.0).to(device)
    position = (coords.float() / float(grid_size) - 0.5).to(device)
    voxel_size = 1.0 / float(grid_size)

    renderer = o_voxel.rasterize.VoxelRenderer(
        rendering_options={
            "resolution": int(args.resolution),
            "ssaa": int(args.ssaa),
            "near": float(args.near),
            "far": float(args.far),
        }
    )

    def _render_frame(yaw: float):
        extr, intr = _camera_look_at(
            yaw_rad=yaw,
            pitch_rad=float(args.pitch_deg) / 180.0 * math.pi,
            radius=float(args.radius),
            fov_deg=float(args.fov_deg),
            device=device,
        )
        out = renderer.render(position=position, attrs=attrs, voxel_size=voxel_size, extrinsics=extr, intrinsics=intr)
        img = np.clip(out.attr.permute(1, 2, 0).detach().cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
        return img

    first = _render_frame(float(args.yaw_deg) / 180.0 * math.pi)
    imageio.imwrite(str(out_image), first)

    num_frames = max(1, int(args.num_frames))
    if out_mp4 and num_frames > 1:
        yaws = [(-2.0 * math.pi * i / num_frames) + (math.pi / 2.0) for i in range(num_frames)]
        frames = [_render_frame(y) for y in yaws]
        imageio.mimsave(str(out_mp4), frames, fps=max(1, int(args.fps)))

    return {
        "mode": "render",
        "input": str(in_path),
        "out_image": str(out_image),
        "out_mp4": str(out_mp4) if out_mp4 and num_frames > 1 else "",
        "resolution": int(args.resolution),
        "ssaa": int(args.ssaa),
        "num_voxels": int(coords.shape[0]),
        "grid_size": grid_size,
    }


def cmd_inspect(args: argparse.Namespace) -> dict[str, Any]:
    import o_voxel  # type: ignore

    in_path = Path(args.input).expanduser().resolve()
    if not in_path.exists():
        raise FileNotFoundError(f"Input voxel file not found: {in_path}")

    coords, data = o_voxel.io.read(str(in_path))
    info = {}
    if in_path.suffix.lower() == ".vxz":
        try:
            from o_voxel.io.vxz import read_vxz_info  # type: ignore

            info = read_vxz_info(str(in_path))
        except Exception:
            info = {}

    coord_min = coords.min(dim=0).values.tolist()
    coord_max = coords.max(dim=0).values.tolist()
    inferred_grid = _infer_grid_size(coords)
    attrs = {}
    for k, v in data.items():
        vv = v.reshape(v.shape[0], -1)
        attrs[k] = {
            "shape": [int(x) for x in vv.shape],
            "dtype": str(vv.dtype),
            "min": int(vv.min().item()) if vv.numel() else 0,
            "max": int(vv.max().item()) if vv.numel() else 0,
        }

    return {
        "mode": "inspect",
        "input": str(in_path),
        "num_voxels": int(coords.shape[0]),
        "coord_min": coord_min,
        "coord_max": coord_max,
        "inferred_grid_size": inferred_grid,
        "has_required": {
            "dual_vertices": "dual_vertices" in data,
            "intersected": "intersected" in data,
            "base_color": "base_color" in data,
            "metallic": "metallic" in data,
            "roughness": "roughness" in data,
            "alpha": "alpha" in data,
        },
        "attrs": attrs,
        "vxz_info": info,
    }


def cmd_io_convert(args: argparse.Namespace) -> dict[str, Any]:
    import o_voxel  # type: ignore

    in_path = Path(args.input).expanduser().resolve()
    out_path = Path(args.out).expanduser().resolve()
    if not in_path.exists():
        raise FileNotFoundError(f"Input voxel file not found: {in_path}")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    coords, data = o_voxel.io.read(str(in_path))
    kwargs = {}
    if out_path.suffix.lower() == ".vxz":
        if str(args.compression).strip():
            kwargs["compression"] = str(args.compression).strip()
        if str(args.filter_mode).strip():
            kwargs["filter"] = str(args.filter_mode).strip()
        if str(args.attr_interleave).strip():
            kwargs["attr_interleave"] = str(args.attr_interleave).strip()
        if args.chunk_size is not None:
            kwargs["chunk_size"] = int(args.chunk_size)
    o_voxel.io.write(str(out_path), coords, data, **kwargs)
    return {
        "mode": "io-convert",
        "input": str(in_path),
        "out": str(out_path),
        "num_voxels": int(coords.shape[0]),
        "num_attrs": len(data),
    }


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="tools/ovoxel_lab.py")
    sub = ap.add_subparsers(dest="mode", required=True)

    p_convert = sub.add_parser("convert", help="Convert mesh to .vxz")
    p_convert.add_argument("--mesh", required=True)
    p_convert.add_argument("--out", required=True)
    p_convert.add_argument("--grid-size", default="512")
    p_convert.add_argument("--aabb", default="-0.5,-0.5,-0.5,0.5,0.5,0.5")
    p_convert.add_argument("--face-weight", default=1.0, type=float)
    p_convert.add_argument("--boundary-weight", default=0.2, type=float)
    p_convert.add_argument("--regularization-weight", default=1e-2, type=float)
    p_convert.add_argument("--timing", default=0, type=int, choices=[0, 1])

    p_recon = sub.add_parser("reconstruct", help="Reconstruct mesh from voxel file")
    p_recon.add_argument("--input", required=True)
    p_recon.add_argument("--out", required=True, help="Output .ply or .glb")
    p_recon.add_argument("--device", default="cuda")
    p_recon.add_argument("--grid-size", default="")
    p_recon.add_argument("--aabb", default="-0.5,-0.5,-0.5,0.5,0.5,0.5")
    p_recon.add_argument("--split-weight", default="")
    p_recon.add_argument("--decimation-target", default=100000, type=int)
    p_recon.add_argument("--texture-size", default=2048, type=int)
    p_recon.add_argument("--remesh", default=0, type=int, choices=[0, 1])
    p_recon.add_argument("--remesh-band", default=1.0, type=float)
    p_recon.add_argument("--remesh-project", default=0.9, type=float)
    p_recon.add_argument("--extension-webp", default=1, type=int, choices=[0, 1])
    p_recon.add_argument("--verbose", default=0, type=int, choices=[0, 1])

    p_render = sub.add_parser("render", help="Render voxel preview")
    p_render.add_argument("--input", required=True)
    p_render.add_argument("--out-image", required=True)
    p_render.add_argument("--out-mp4", default="")
    p_render.add_argument("--grid-size", default="")
    p_render.add_argument("--aabb", default="-0.5,-0.5,-0.5,0.5,0.5,0.5")
    p_render.add_argument("--resolution", default=512, type=int)
    p_render.add_argument("--ssaa", default=2, type=int)
    p_render.add_argument("--near", default=0.1, type=float)
    p_render.add_argument("--far", default=10.0, type=float)
    p_render.add_argument("--yaw-deg", default=45.0, type=float)
    p_render.add_argument("--pitch-deg", default=20.0, type=float)
    p_render.add_argument("--radius", default=1.8, type=float)
    p_render.add_argument("--fov-deg", default=40.0, type=float)
    p_render.add_argument("--num-frames", default=90, type=int)
    p_render.add_argument("--fps", default=15, type=int)

    p_inspect = sub.add_parser("inspect", help="Inspect voxel metadata")
    p_inspect.add_argument("--input", required=True)

    p_io = sub.add_parser("io-convert", help="Convert between .vxz/.npz/.ply")
    p_io.add_argument("--input", required=True)
    p_io.add_argument("--out", required=True)
    p_io.add_argument("--chunk-size", default=None, type=int)
    p_io.add_argument("--compression", default="")
    p_io.add_argument("--filter-mode", default="")
    p_io.add_argument("--attr-interleave", default="")

    return ap


def main() -> int:
    os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    _ensure_trellis_import_path()
    args = build_parser().parse_args()

    try:
        if args.mode == "convert":
            out = cmd_convert(args)
        elif args.mode == "reconstruct":
            out = cmd_reconstruct(args)
        elif args.mode == "render":
            out = cmd_render(args)
        elif args.mode == "inspect":
            out = cmd_inspect(args)
        elif args.mode == "io-convert":
            out = cmd_io_convert(args)
        else:
            raise ValueError(f"Unsupported mode: {args.mode}")
    except Exception as e:
        _eprint(f"O-Voxel Lab failed: {e}")
        return 2

    print("OVOXEL_LAB_RESULT_JSON:" + json.dumps(out, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
