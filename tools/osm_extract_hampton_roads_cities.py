#!/usr/bin/env python3
"""
Build per-city Hampton Roads GeoJSON datasets from a Geofabrik .osm.pbf, using osmium-tool.

This mirrors the Richmond workflow (pbf extract -> tags-filter -> export geojson), but splits
into smaller city bboxes to keep file sizes manageable.

Prereqs:
  - osmium-tool installed (osmium)
  - Virginia extract downloaded:
      python tools/download_osm_extract.py --region virginia --download --outdir data/osm --filename virginia-latest.osm.pbf

Run:
  python tools/osm_extract_hampton_roads_cities.py --in-pbf data/osm/virginia-latest.osm.pbf
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys


def _osmium() -> str | None:
    return shutil.which("osmium")


def _run(cmd: list[str]) -> None:
    p = subprocess.run(cmd, check=False, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"Command failed ({p.returncode}): {' '.join(cmd)}\n{p.stdout}")


def _bbox(min_lon: float, min_lat: float, max_lon: float, max_lat: float) -> str:
    if max_lon <= min_lon or max_lat <= min_lat:
        raise ValueError("bbox max must be > min")
    return f"{min_lon},{min_lat},{max_lon},{max_lat}"


CITY_BBOX = {
    # Note: bboxes are approximate (WGS84 lon/lat). Tweak if you want tighter coverage.
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


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in-pbf", required=True, help="Input .osm.pbf (e.g. data/osm/virginia-latest.osm.pbf)")
    ap.add_argument("--out-root", default="assets/datasets", help="Datasets root (default: assets/datasets)")
    args = ap.parse_args(argv)

    osmium = _osmium()
    if not osmium:
        print("Missing dependency: osmium-tool (osmium). Install it and retry.", file=sys.stderr)
        return 2

    in_pbf = args.in_pbf
    if not os.path.exists(in_pbf):
        print(f"Input not found: {in_pbf}", file=sys.stderr)
        return 2

    for city, (min_lon, min_lat, max_lon, max_lat) in CITY_BBOX.items():
        bbox_str = _bbox(min_lon, min_lat, max_lon, max_lat)
        outdir = os.path.join(args.out_root, f"osm_va_{city}")
        os.makedirs(outdir, exist_ok=True)
        prefix = f"va_{city}"
        print(f"\n=== {city} ===")
        print(f"bbox={bbox_str}")
        # Reuse the generic extractor so behavior stays consistent.
        _run([
            sys.executable,
            os.path.join(os.path.dirname(__file__), "osm_extract_geojson.py"),
            "--in-pbf", in_pbf,
            f"--bbox={bbox_str}",
            "--outdir", outdir,
            "--prefix", prefix,
            "--overwrite",
        ])
        print(f"Wrote: {outdir}/{prefix}_highways.geojson")
        print(f"Wrote: {outdir}/{prefix}_buildings.geojson")

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))


