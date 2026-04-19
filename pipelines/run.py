#!/usr/bin/env python3
"""
Offline generative pipelines that emit viewer-ready formats:
  - heightmap-u16 (meta.json + raw u16 bin)
  - GeoJSON WGS84 layers (roads/buildings/trees/props)

This is intentionally dependency-free (stdlib only).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from pipelines_lib.proc_city import generate_proc_city_dataset, ProcCityConfig


def _mkdirp(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)


def _write_json(path: Path, obj) -> None:
    _mkdirp(path.parent)
    path.write_text(json.dumps(obj, indent=2, sort_keys=False) + "\n", encoding="utf-8")


def _read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json_atomic(path: Path, obj) -> None:
    _mkdirp(path.parent)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def _upsert_manifest(manifest_path: Path, entries_obj: dict) -> None:
    existing = {"datasets": []}
    if manifest_path.exists():
        try:
            existing = _read_json(manifest_path)
        except Exception:
            existing = {"datasets": []}

    cur = existing.get("datasets")
    if not isinstance(cur, list):
        cur = []
        existing["datasets"] = cur

    by_id: dict[str, dict] = {}
    for d in cur:
        if isinstance(d, dict) and "id" in d:
            by_id[str(d["id"])] = d

    new_list = entries_obj.get("datasets")
    if not isinstance(new_list, list):
        raise ValueError("entries json must be { datasets: [...] }")

    for d in new_list:
        if not isinstance(d, dict) or "id" not in d:
            continue
        by_id[str(d["id"])] = d

    # Stable order: keep existing order, append truly new IDs at end.
    seen = set()
    out = []
    for d in cur:
        did = str(d.get("id"))
        if did in by_id and did not in seen:
            out.append(by_id[did])
            seen.add(did)
    for did, d in by_id.items():
        if did not in seen:
            out.append(d)
            seen.add(did)

    existing["datasets"] = out
    _write_json_atomic(manifest_path, existing)


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="pipelines/run.py")
    sub = ap.add_subparsers(dest="cmd", required=True)

    pc = sub.add_parser("proc-city", help="Generate a procedural GTA-like city dataset (heightmap + GeoJSON layers).")
    pc.add_argument("--id", required=True, help="Dataset id (used for suggested manifest entries).")
    pc.add_argument("--out", required=True, help="Output directory (e.g. assets/datasets/generated/my_city).")
    pc.add_argument("--seed", default="", help="String seed for deterministic generation.")
    pc.add_argument("--origin-lon", type=float, default=-76.30, help="WGS84 lon for dataset origin.")
    pc.add_argument("--origin-lat", type=float, default=36.85, help="WGS84 lat for dataset origin.")
    pc.add_argument("--size-m", type=float, default=2400.0, help="World size in meters (square).")
    pc.add_argument("--grid", type=int, default=256, help="Heightmap resolution (NxN).")
    pc.add_argument("--max-buildings", type=int, default=12000)
    pc.add_argument("--max-trees", type=int, default=25000)
    pc.add_argument("--max-props", type=int, default=12000)
    pc.add_argument("--tile-buildings", action="store_true", help="Build BUI2 tiles + multi-LOD tileset (calls tools/*).")
    pc.add_argument("--tile-chunk-m", type=float, default=512.0, help="Tiler chunk size in meters.")
    pc.add_argument("--update-manifest", action="store_true", help="Upsert generated entries into assets/datasets/manifest.json.")
    pc.add_argument("--manifest", default="assets/datasets/manifest.json", help="Manifest path used with --update-manifest.")

    me = sub.add_parser("write-manifest-entry", help="Print JSON dataset entries for a generated proc-city dataset.")
    me.add_argument("--id", required=True, help="Dataset id used at generation time.")
    me.add_argument("--out", required=True, help="Output directory used at generation time.")

    um = sub.add_parser("upsert-manifest", help="Upsert entries into assets/datasets/manifest.json.")
    um.add_argument("--manifest", default="assets/datasets/manifest.json", help="Path to manifest.json (usually ignored by git).")
    um.add_argument("--entries", required=True, help="Path to entries JSON (e.g. <out>/manifest_entries.json).")

    return ap.parse_args()


def _rel_asset_url(path: Path) -> str:
    # Prefer a stable URL-like path in manifest entries.
    # If user passes an absolute output dir, normalize by stripping repo root if possible.
    p = path.as_posix()
    # A common convention in this repo is to serve from repo root.
    # If the path contains "/assets/", use the portion starting at "assets/".
    i = p.find("/assets/")
    if i >= 0:
        return p[i + 1 :]  # drop leading slash
    if p.startswith("assets/"):
        return p
    return p


def _proc_city_manifest_entries(dataset_id: str, out_dir: Path) -> dict:
    base = out_dir
    return {
        "datasets": [
            {
                "id": dataset_id,
                "label": f"{dataset_id} (generated)",
                "kind": "bundle",
                "bundle": [
                    f"{dataset_id}_heightmap",
                    f"{dataset_id}_roads",
                    f"{dataset_id}_buildings",
                    f"{dataset_id}_trees",
                    f"{dataset_id}_props",
                ],
            },
            {
                "id": f"{dataset_id}_heightmap",
                "label": f"{dataset_id} — heightmap",
                "kind": "heightmap-u16",
                "url": _rel_asset_url(base / "heightmap" / "meta.json"),
            },
            {
                "id": f"{dataset_id}_roads",
                "label": f"{dataset_id} — roads",
                "kind": "geojson-wgs84-roads",
                "url": _rel_asset_url(base / "roads.geojson"),
            },
            {
                "id": f"{dataset_id}_buildings",
                "label": f"{dataset_id} — buildings",
                "kind": "geojson-wgs84-buildings",
                "url": _rel_asset_url(base / "buildings.geojson"),
            },
            {
                "id": f"{dataset_id}_trees",
                "label": f"{dataset_id} — trees",
                "kind": "geojson-wgs84-trees",
                "url": _rel_asset_url(base / "trees.geojson"),
            },
            {
                "id": f"{dataset_id}_props",
                "label": f"{dataset_id} — props",
                "kind": "geojson-wgs84-props",
                "url": _rel_asset_url(base / "props.geojson"),
            },
        ]
    }


def _proc_city_manifest_entries_multilod(dataset_id: str, out_dir: Path) -> dict:
    """
    Same as `_proc_city_manifest_entries`, but uses the generated multi-LOD building tiles
    (when `proc-city --tile-buildings` is used).
    """
    base = out_dir
    return {
        "datasets": [
            {
                "id": f"{dataset_id}_multilod",
                "label": f"{dataset_id} (generated, multi-LOD buildings)",
                "kind": "bundle",
                "bundle": [
                    f"{dataset_id}_heightmap",
                    f"{dataset_id}_roads",
                    f"{dataset_id}_buildings_multilod",
                    f"{dataset_id}_trees",
                    f"{dataset_id}_props",
                ],
            },
            {
                "id": f"{dataset_id}_heightmap",
                "label": f"{dataset_id} — heightmap",
                "kind": "heightmap-u16",
                "url": _rel_asset_url(base / "heightmap" / "meta.json"),
            },
            {
                "id": f"{dataset_id}_roads",
                "label": f"{dataset_id} — roads",
                "kind": "geojson-wgs84-roads",
                "url": _rel_asset_url(base / "roads.geojson"),
            },
            {
                "id": f"{dataset_id}_buildings_multilod",
                "label": f"{dataset_id} — buildings (multi-LOD tiles)",
                "kind": "instanced-tiles-buildings-multilod",
                "url": _rel_asset_url(base / "tiles" / "multilod" / "multilod_index.json"),
            },
            {
                "id": f"{dataset_id}_trees",
                "label": f"{dataset_id} — trees",
                "kind": "geojson-wgs84-trees",
                "url": _rel_asset_url(base / "trees.geojson"),
            },
            {
                "id": f"{dataset_id}_props",
                "label": f"{dataset_id} — props",
                "kind": "geojson-wgs84-props",
                "url": _rel_asset_url(base / "props.geojson"),
            },
        ]
    }


def main() -> int:
    args = _parse_args()

    if args.cmd == "proc-city":
        out_dir = Path(args.out)
        cfg = ProcCityConfig(
            dataset_id=str(args.id),
            out_dir=out_dir,
            seed=str(args.seed or args.id),
            origin_lon=float(args.origin_lon),
            origin_lat=float(args.origin_lat),
            size_m=float(args.size_m),
            grid_n=int(args.grid),
            max_buildings=int(args.max_buildings),
            max_trees=int(args.max_trees),
            max_props=int(args.max_props),
            tile_buildings=bool(args.tile_buildings),
            tile_chunk_m=float(args.tile_chunk_m),
        )
        generate_proc_city_dataset(cfg)

        entries = _proc_city_manifest_entries_multilod(cfg.dataset_id, out_dir) if cfg.tile_buildings else _proc_city_manifest_entries(cfg.dataset_id, out_dir)
        entries_path = out_dir / "manifest_entries.json"
        _write_json(entries_path, entries)
        if bool(getattr(args, "update_manifest", False)):
            manifest_path = Path(str(getattr(args, "manifest", "assets/datasets/manifest.json")))
            _upsert_manifest(manifest_path, entries)
            print(f"Updated manifest: {manifest_path}")
        print(f"Wrote dataset to: {out_dir}")
        print(f"Wrote suggested manifest entries: {entries_path}")
        return 0

    if args.cmd == "write-manifest-entry":
        out_dir = Path(args.out)
        obj = _proc_city_manifest_entries(str(args.id), out_dir)
        print(json.dumps(obj, indent=2))
        return 0

    if args.cmd == "upsert-manifest":
        manifest_path = Path(args.manifest)
        entries_path = Path(args.entries)
        if not entries_path.exists():
            raise FileNotFoundError(str(entries_path))
        entries = _read_json(entries_path)
        _upsert_manifest(manifest_path, entries)
        print(f"Updated manifest: {manifest_path}")
        return 0

    raise RuntimeError(f"Unhandled cmd: {args.cmd}")


if __name__ == "__main__":
    raise SystemExit(main())
