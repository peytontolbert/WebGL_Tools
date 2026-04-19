#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys
from typing import Iterable


def _run(cmd: list[str], cwd: Path) -> None:
    print(f"\n$ {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, cwd=str(cwd), check=True)


def _build_metadata(
    trellis_root: Path,
    subset: str,
    dataset_root: Path,
    source_root: Path,
    mesh_extensions: str,
) -> None:
    _run(
        [
            sys.executable,
            "data_toolkit/build_metadata.py",
            subset,
            "--root",
            str(dataset_root),
            "--source_root",
            str(source_root),
            "--mesh_extensions",
            mesh_extensions,
        ],
        cwd=trellis_root,
    )


def _maybe_instances_arg(instances: str) -> list[str]:
    if not instances:
        return []
    return ["--instances", instances]


def _shape_latent_name(shape_enc_pretrained: str, latent_resolution: int) -> str:
    return f"{shape_enc_pretrained.split('/')[-1]}_{latent_resolution}"


def _step_selected(step: str, selected_steps: set[str]) -> bool:
    return "all" in selected_steps or step in selected_steps


def _run_if_selected(
    step: str,
    selected_steps: set[str],
    cmd: Iterable[str],
    trellis_root: Path,
    dataset_root: Path,
    subset: str,
    source_root: Path,
    mesh_extensions: str,
) -> None:
    if not _step_selected(step, selected_steps):
        return
    _run(list(cmd), cwd=trellis_root)
    _build_metadata(
        trellis_root=trellis_root,
        subset=subset,
        dataset_root=dataset_root,
        source_root=source_root,
        mesh_extensions=mesh_extensions,
    )


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Preprocess HumanDataset for TRELLIS.2 training"
    )
    ap.add_argument(
        "--trellis-root",
        default="repos/TRELLIS.2",
        help="Path to TRELLIS.2 repo root",
    )
    ap.add_argument(
        "--dataset-root",
        default="repos/TRELLIS.2/datasets/humandataset/trellis_train",
        help="Output root for TRELLIS-style dataset",
    )
    ap.add_argument(
        "--source-root",
        default="repos/TRELLIS.2/datasets/humandataset/rigged",
        help="Input HumanDataset rigged root",
    )
    ap.add_argument(
        "--subset",
        default="humandataset",
        help="Dataset adapter name under data_toolkit/datasets",
    )
    ap.add_argument(
        "--mesh-extensions",
        default=".fbx,.glb,.gltf,.obj",
        help="Comma-separated mesh extensions",
    )
    ap.add_argument(
        "--resolutions",
        default="1024",
        help="Comma-separated O-Voxel resolutions for dual_grid/voxelize_pbr",
    )
    ap.add_argument(
        "--latent-resolution",
        type=int,
        default=1024,
        help="Resolution used by shape/pbr latent encoders",
    )
    ap.add_argument(
        "--ss-resolution",
        type=int,
        default=64,
        help="Resolution used by sparse-structure encoder",
    )
    ap.add_argument(
        "--shape-enc-pretrained",
        default="microsoft/TRELLIS.2-4B/ckpts/shape_enc_next_dc_f16c32_fp16",
        help="Shape encoder checkpoint name",
    )
    ap.add_argument(
        "--pbr-enc-pretrained",
        default="microsoft/TRELLIS.2-4B/ckpts/tex_enc_next_dc_f16c32_fp16",
        help="PBR encoder checkpoint name",
    )
    ap.add_argument(
        "--ss-enc-pretrained",
        default="microsoft/TRELLIS-image-large/ckpts/ss_enc_conv3d_16l8_fp16",
        help="SS encoder checkpoint name",
    )
    ap.add_argument(
        "--num-cond-views",
        type=int,
        default=16,
        help="Number of rendered conditioning views",
    )
    ap.add_argument(
        "--instances",
        default="",
        help="Optional instance list file or comma-separated sha256 list",
    )
    ap.add_argument(
        "--max-workers",
        type=int,
        default=8,
        help="max_workers for mesh/pbr/render scripts",
    )
    ap.add_argument(
        "--steps",
        default="all",
        help=(
            "Comma-separated steps: all,metadata,dump_mesh,dump_pbr,asset_stats,"
            "dual_grid,voxelize_pbr,render_cond,encode_shape,encode_pbr,encode_ss"
        ),
    )
    args = ap.parse_args()

    trellis_root = Path(args.trellis_root).resolve()
    dataset_root = Path(args.dataset_root).resolve()
    source_root = Path(args.source_root).resolve()
    selected_steps = {s.strip() for s in args.steps.split(",") if s.strip()}
    instances_arg = _maybe_instances_arg(args.instances)

    if not trellis_root.exists():
        raise SystemExit(f"TRELLIS root not found: {trellis_root}")
    if not source_root.exists():
        raise SystemExit(f"source_root not found: {source_root}")
    dataset_root.mkdir(parents=True, exist_ok=True)

    # Initialize and/or merge metadata first.
    if _step_selected("metadata", selected_steps):
        _build_metadata(
            trellis_root=trellis_root,
            subset=args.subset,
            dataset_root=dataset_root,
            source_root=source_root,
            mesh_extensions=args.mesh_extensions,
        )

    _run_if_selected(
        "dump_mesh",
        selected_steps,
        [
            sys.executable,
            "data_toolkit/dump_mesh.py",
            args.subset,
            "--root",
            str(dataset_root),
            "--source_root",
            str(source_root),
            "--mesh_extensions",
            args.mesh_extensions,
            "--max_workers",
            str(args.max_workers),
            *instances_arg,
        ],
        trellis_root,
        dataset_root,
        args.subset,
        source_root,
        args.mesh_extensions,
    )

    _run_if_selected(
        "dump_pbr",
        selected_steps,
        [
            sys.executable,
            "data_toolkit/dump_pbr.py",
            args.subset,
            "--root",
            str(dataset_root),
            "--source_root",
            str(source_root),
            "--mesh_extensions",
            args.mesh_extensions,
            "--max_workers",
            str(args.max_workers),
            *instances_arg,
        ],
        trellis_root,
        dataset_root,
        args.subset,
        source_root,
        args.mesh_extensions,
    )

    _run_if_selected(
        "asset_stats",
        selected_steps,
        [
            sys.executable,
            "data_toolkit/asset_stats.py",
            "--root",
            str(dataset_root),
            *instances_arg,
        ],
        trellis_root,
        dataset_root,
        args.subset,
        source_root,
        args.mesh_extensions,
    )

    _run_if_selected(
        "dual_grid",
        selected_steps,
        [
            sys.executable,
            "data_toolkit/dual_grid.py",
            args.subset,
            "--root",
            str(dataset_root),
            "--source_root",
            str(source_root),
            "--mesh_extensions",
            args.mesh_extensions,
            "--resolution",
            args.resolutions,
            "--max_workers",
            str(args.max_workers),
            *instances_arg,
        ],
        trellis_root,
        dataset_root,
        args.subset,
        source_root,
        args.mesh_extensions,
    )

    _run_if_selected(
        "voxelize_pbr",
        selected_steps,
        [
            sys.executable,
            "data_toolkit/voxelize_pbr.py",
            args.subset,
            "--root",
            str(dataset_root),
            "--source_root",
            str(source_root),
            "--mesh_extensions",
            args.mesh_extensions,
            "--resolution",
            args.resolutions,
            "--max_workers",
            str(args.max_workers),
            *instances_arg,
        ],
        trellis_root,
        dataset_root,
        args.subset,
        source_root,
        args.mesh_extensions,
    )

    _run_if_selected(
        "render_cond",
        selected_steps,
        [
            sys.executable,
            "data_toolkit/render_cond.py",
            args.subset,
            "--root",
            str(dataset_root),
            "--source_root",
            str(source_root),
            "--mesh_extensions",
            args.mesh_extensions,
            "--num_cond_views",
            str(args.num_cond_views),
            "--max_workers",
            str(args.max_workers),
            *instances_arg,
        ],
        trellis_root,
        dataset_root,
        args.subset,
        source_root,
        args.mesh_extensions,
    )

    _run_if_selected(
        "encode_shape",
        selected_steps,
        [
            sys.executable,
            "data_toolkit/encode_shape_latent.py",
            "--root",
            str(dataset_root),
            "--resolution",
            str(args.latent_resolution),
            "--enc_pretrained",
            args.shape_enc_pretrained,
            *instances_arg,
        ],
        trellis_root,
        dataset_root,
        args.subset,
        source_root,
        args.mesh_extensions,
    )

    _run_if_selected(
        "encode_pbr",
        selected_steps,
        [
            sys.executable,
            "data_toolkit/encode_pbr_latent.py",
            "--root",
            str(dataset_root),
            "--resolution",
            str(args.latent_resolution),
            "--enc_pretrained",
            args.pbr_enc_pretrained,
            *instances_arg,
        ],
        trellis_root,
        dataset_root,
        args.subset,
        source_root,
        args.mesh_extensions,
    )

    shape_latent_name = _shape_latent_name(
        shape_enc_pretrained=args.shape_enc_pretrained,
        latent_resolution=args.latent_resolution,
    )
    _run_if_selected(
        "encode_ss",
        selected_steps,
        [
            sys.executable,
            "data_toolkit/encode_ss_latent.py",
            "--root",
            str(dataset_root),
            "--resolution",
            str(args.ss_resolution),
            "--enc_pretrained",
            args.ss_enc_pretrained,
            "--shape_latent_name",
            shape_latent_name,
            *instances_arg,
        ],
        trellis_root,
        dataset_root,
        args.subset,
        source_root,
        args.mesh_extensions,
    )

    print("\nPreprocessing complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

