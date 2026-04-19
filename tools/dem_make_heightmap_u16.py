#!/usr/bin/env python3
"""
Make a viewer-compatible Uint16 heightmap from a DEM GeoTIFF using GDAL.

Output format matches what js/runtime/heightmap_loader.js expects:
  - heightmap_u16.bin: raw uint16 samples (normalized 0..65535), row-major, top-to-bottom
  - heightmap_u16.json: { width, height, file, endian, minZ, maxZ, bbox }

Dependencies:
  - gdalwarp, gdal_translate, gdalinfo (CLI)  -> install via your system/conda
  - This script is NOT used by the viewer at runtime; it's offline preprocessing.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile


# WGS84 bbox presets (minLon,minLat,maxLon,maxLat)
PRESET_BBOX = {
    "hampton_roads": (-76.80, 36.55, -75.90, 37.20),  # loose bbox covering the 7-city metro
    "richmond": (-77.65, 37.40, -77.30, 37.63),  # small-ish Richmond metro bbox (tweak as desired)
}


def _which(name: str) -> str | None:
    return shutil.which(name)


def _run(cmd: list[str]) -> str:
    p = subprocess.run(cmd, check=False, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"Command failed ({p.returncode}): {' '.join(cmd)}\n{p.stdout}")
    return p.stdout


def _parse_bbox(s: str) -> tuple[float, float, float, float]:
    parts = [p.strip() for p in str(s).split(",")]
    if len(parts) != 4:
        raise ValueError("bbox must be 'minLon,minLat,maxLon,maxLat'")
    min_lon = float(parts[0])
    min_lat = float(parts[1])
    max_lon = float(parts[2])
    max_lat = float(parts[3])
    if max_lon <= min_lon or max_lat <= min_lat:
        raise ValueError("bbox max must be > min")
    return (min_lon, min_lat, max_lon, max_lat)


def _gdal_minmax(gdalinfo_out: str) -> tuple[float, float]:
    m = re.search(r"Computed Min/Max=\s*([-\d.]+)\s*,\s*([-\d.]+)", gdalinfo_out)
    if m:
        return float(m.group(1)), float(m.group(2))
    m2 = re.search(r"Computed Minimum=\s*([-\d.]+)\s*,\s*Maximum=\s*([-\d.]+)", gdalinfo_out)
    if m2:
        return float(m2.group(1)), float(m2.group(2))
    raise RuntimeError("Could not parse min/max from gdalinfo output. Try running gdalinfo -mm manually.")


def _gdal_nodata(gdalinfo_out: str) -> float | None:
    m = re.search(r"NoData Value=\s*([-\d.]+)", gdalinfo_out)
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


def _percentile(sorted_vals: list[float], pct: float) -> float:
    if not sorted_vals:
        raise ValueError("empty values")
    p = max(0.0, min(100.0, float(pct)))
    if len(sorted_vals) == 1:
        return float(sorted_vals[0])
    pos = (p / 100.0) * (len(sorted_vals) - 1)
    lo = int(pos)
    hi = min(len(sorted_vals) - 1, lo + 1)
    t = pos - lo
    return float(sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * t)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in-dem", required=True, help="Input DEM GeoTIFF")
    ap.add_argument("--outdir", default="assets/datasets/dem_out", help="Output directory")
    ap.add_argument("--size", type=int, default=512, help="Output grid size (NxN). Default 512.")
    ap.add_argument("--bbox", default="", help="Override bbox 'minLon,minLat,maxLon,maxLat'")
    ap.add_argument("--preset", default="", help=f"Named bbox preset: {', '.join(sorted(PRESET_BBOX.keys()))}")
    ap.add_argument("--prefix", default="heightmap_u16", help="Output basename (default: heightmap_u16)")
    ap.add_argument("--endian", default="little", choices=["little", "big"], help="Endian for output .bin")
    ap.add_argument("--minz", type=float, default=float("nan"), help="Override minZ meters (one-sided override)")
    ap.add_argument("--maxz", type=float, default=float("nan"), help="Override maxZ meters (one-sided override)")
    ap.add_argument("--pmin", type=float, default=1.0, help="Min percentile for robust scaling (default 1)")
    ap.add_argument("--pmax", type=float, default=99.0, help="Max percentile for robust scaling (default 99)")
    args = ap.parse_args(argv)

    for exe in ("gdalwarp", "gdal_translate", "gdalinfo"):
        if not _which(exe):
            print(f"Missing dependency: {exe} (install GDAL).", file=sys.stderr)
            return 2

    in_dem = args.in_dem
    if not os.path.exists(in_dem):
        print(f"Input not found: {in_dem}", file=sys.stderr)
        return 2

    if args.bbox.strip():
        bbox = _parse_bbox(args.bbox)
    elif args.preset.strip():
        p = args.preset.strip().lower()
        if p not in PRESET_BBOX:
            print(f"Unknown preset '{args.preset}'. Known: {', '.join(sorted(PRESET_BBOX.keys()))}", file=sys.stderr)
            return 2
        bbox = PRESET_BBOX[p]
    else:
        print("Must pass --preset or --bbox.", file=sys.stderr)
        return 2

    n = max(2, int(args.size))
    outdir = args.outdir
    os.makedirs(outdir, exist_ok=True)
    prefix = args.prefix.strip() or "heightmap_u16"

    with tempfile.TemporaryDirectory(prefix="demhm_") as td:
        clipped_tif = os.path.join(td, "clipped.tif")
        scaled_png = os.path.join(td, "scaled_u16.png")
        xyz_txt = os.path.join(td, "clipped.xyz")

        min_lon, min_lat, max_lon, max_lat = bbox
        print(f"Clipping bbox={min_lon},{min_lat},{max_lon},{max_lat} -> {n}x{n}")

        _run(
            [
                "gdalwarp",
                "-overwrite",
                "-t_srs",
                "EPSG:4326",
                "-te",
                str(min_lon),
                str(min_lat),
                str(max_lon),
                str(max_lat),
                "-ts",
                str(n),
                str(n),
                "-r",
                "bilinear",
                in_dem,
                clipped_tif,
            ]
        )

        info = _run(["gdalinfo", "-mm", clipped_tif])
        nodata = _gdal_nodata(info)

        # Robust stats: avoid coastal fill values dominating minZ.
        min_z = float("nan")
        max_z = float("nan")
        try:
            _run(["gdal_translate", "-q", "-of", "XYZ", clipped_tif, xyz_txt])
            xyz = open(xyz_txt, "r", encoding="utf-8", errors="ignore").read()
            vals: list[float] = []
            for line in xyz.splitlines():
                parts = line.split()
                if len(parts) < 3:
                    continue
                try:
                    v = float(parts[2])
                except ValueError:
                    continue
                if nodata is not None and v == nodata:
                    continue
                if not (v == v) or v in (float("inf"), float("-inf")):
                    continue
                vals.append(v)
            if len(vals) >= 100:
                vals.sort()
                # Drop repeated minimum (common fill) if it dominates.
                min_v = vals[0]
                c = 0
                for v in vals:
                    if v != min_v:
                        break
                    c += 1
                if min_v <= -50.0 and (c / len(vals)) >= 0.05:
                    vals = vals[c:]
                min_z = _percentile(vals, float(args.pmin))
                max_z = _percentile(vals, float(args.pmax))
            else:
                min_z, max_z = _gdal_minmax(info)
        except Exception:
            min_z, max_z = _gdal_minmax(info)

        # One-sided overrides (useful to force sea-level minZ=0).
        if args.minz == args.minz:
            min_z = float(args.minz)
        if args.maxz == args.maxz:
            max_z = float(args.maxz)

        if not (max_z > min_z):
            raise RuntimeError(f"Bad DEM stats: minZ={min_z}, maxZ={max_z}")
        print(f"DEM minZ={min_z:.3f} maxZ={max_z:.3f}")

        _run(
            [
                "gdal_translate",
                "-ot",
                "UInt16",
                "-scale",
                str(min_z),
                str(max_z),
                "0",
                "65535",
                "-of",
                "PNG",
                clipped_tif,
                scaled_png,
            ]
        )

        conv = os.path.join(os.path.dirname(__file__), "convert_heightmap16_png_to_u16bin.py")
        _run(
            [
                sys.executable,
                conv,
                scaled_png,
                "--out-dir",
                outdir,
                "--prefix",
                prefix,
                "--endian",
                args.endian,
            ]
        )

    # Extend metadata JSON with bbox/minZ/maxZ for runtime (if you choose to use it).
    json_path = os.path.join(outdir, f"{prefix}.json")
    bin_name = f"{prefix}.bin"
    meta = {
        "width": int(n),
        "height": int(n),
        "file": bin_name,
        "endian": args.endian,
        "minZ": float(min_z),
        "maxZ": float(max_z),
        "bbox": {"minLon": bbox[0], "minLat": bbox[1], "maxLon": bbox[2], "maxLat": bbox[3]},
        "source": {"kind": "dem", "path": os.path.basename(in_dem)},
    }
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
        f.write("\n")

    print("Wrote:")
    print(f"- {os.path.join(outdir, bin_name)}")
    print(f"- {json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))


