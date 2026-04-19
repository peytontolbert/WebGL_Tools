#!/usr/bin/env python3
"""
Download real Overture buildings for Hampton Roads cities (bbox-based), no API keys.

This mirrors `tools/osm_extract_hampton_roads_cities.py`, but uses DuckDB to query
Overture's public S3 GeoParquet release and writes GeoJSON outputs.

Prereqs:
  pip install duckdb

Example:
  python tools/overture_extract_hampton_roads_cities.py --release 2025-12-17.0
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys


CITY_BBOX = {
    # format: (minLon, minLat, maxLon, maxLat)
    "virginia_beach": (-76.33, 36.55, -75.90, 36.99),
    "chesapeake": (-76.63, 36.55, -76.02, 36.92),
    "norfolk": (-76.35, 36.80, -76.17, 36.97),
    "portsmouth": (-76.41, 36.78, -76.25, 36.92),
    # Suffolk is geographically huge; this is the more urban/northern portion.
    "suffolk": (-76.80, 36.62, -76.38, 37.05),
    "hampton": (-76.43, 36.96, -76.20, 37.12),
    "newport_news": (-76.62, 36.92, -76.35, 37.20),
}


def _bbox_str(min_lon: float, min_lat: float, max_lon: float, max_lat: float) -> str:
    if max_lon <= min_lon or max_lat <= min_lat:
        raise ValueError("bbox max must be > min")
    return f"{min_lon},{min_lat},{max_lon},{max_lat}"


def _run(cmd: list[str]) -> None:
    p = subprocess.run(cmd, check=False)
    if p.returncode != 0:
        raise RuntimeError(f"Command failed ({p.returncode}): {' '.join(cmd)}")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--release", required=True, help="Overture release (e.g. 2025-12-17.0)")
    ap.add_argument("--out-root", default="assets/datasets", help="Datasets root (default: assets/datasets)")
    ap.add_argument("--max-features", type=int, default=20000, help="Max buildings per city (safety cap).")
    ap.add_argument("--theme", default="buildings", help="Overture theme (default: buildings)")
    ap.add_argument("--type", dest="type_", default="building", help="Overture type (default: building)")
    ap.add_argument("--hive-partitioning", action="store_true", help="Use hive_partitioning when reading parquet (recommended for releases).")
    ap.add_argument("--cities", default="", help="Comma-separated city keys to run (default: all).")
    ap.add_argument("--start-at", default="", help="Start at this city key (useful to resume).")
    ap.add_argument("--skip-existing", action="store_true", help="Skip cities whose output GeoJSON already exists.")
    ap.add_argument("--no-progress", action="store_true", help="Disable DuckDB progress output in the extractor.")
    ap.add_argument("--no-fast-bbox", action="store_true", help="Disable fast bbox filtering (use ST_Intersects).")
    args = ap.parse_args(argv)

    tool = os.path.join(os.path.dirname(__file__), "overture_extract_geojson.py")
    if not os.path.exists(tool):
        print(f"Missing tool: {tool}", file=sys.stderr)
        return 2

    # Filter cities (optional)
    selected = list(CITY_BBOX.items())
    if args.cities.strip():
        want = {c.strip() for c in args.cities.split(",") if c.strip()}
        selected = [(k, v) for (k, v) in selected if k in want]
        missing = sorted(want - {k for (k, _) in selected})
        if missing:
            print(f"Unknown city keys in --cities: {missing}", file=sys.stderr)
            print(f"Known: {sorted(CITY_BBOX.keys())}", file=sys.stderr)
            return 2

    if args.start_at.strip():
        start = args.start_at.strip()
        if start not in dict(selected):
            print(f"--start-at '{start}' not in selected cities.", file=sys.stderr)
            print(f"Selected: {[k for (k, _) in selected]}", file=sys.stderr)
            return 2
        # Drop all items until we reach start.
        while selected and selected[0][0] != start:
            selected.pop(0)

    try:
        for city, (min_lon, min_lat, max_lon, max_lat) in selected:
            bbox = _bbox_str(min_lon, min_lat, max_lon, max_lat)
            outdir = os.path.join(args.out_root, f"overture_{city}")
            os.makedirs(outdir, exist_ok=True)
            prefix = f"va_{city}_overture"
            out_path = os.path.join(outdir, f"{prefix}_buildings.geojson")
            if args.skip_existing and os.path.exists(out_path):
                print(f"\n=== {city} ===")
                print(f"Skip (exists): {out_path}")
                continue
            print(f"\n=== {city} ===")
            print(f"bbox={bbox}")
            _run(
                [
                    sys.executable,
                    tool,
                    "--release",
                    args.release,
                    "--theme",
                    args.theme,
                    "--type",
                    args.type_,
                    f"--bbox={bbox}",
                    "--outdir",
                    outdir,
                    "--prefix",
                    prefix,
                    "--max-features",
                    str(int(args.max_features)),
                ]
                + (["--hive-partitioning"] if args.hive_partitioning else [])
                + (["--no-progress"] if args.no_progress else [])
                + (["--no-fast-bbox"] if args.no_fast_bbox else [])
            )
            print(f"Wrote: {out_path}")
    except KeyboardInterrupt:
        print("\nCancelled.", file=sys.stderr)
        return 130

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))


