#!/usr/bin/env python3
"""
Download NOAA (Office for Coastal Management) Virginia DEM GeoTIFFs (no API key).

Why this exists:
- Mirror the "safe downloader" UX of tools/download_osm_extract.py
  - Always HEAD first to show remote size
  - Require explicit --download to fetch multi-GB files
- Provide an easy preset for Hampton Roads (cities) elevation.

Source:
  https://coast.noaa.gov/htdata/raster2/elevation/SLR_viewer_DEM_6230/VA/

Examples:
  # Preview size only (no download)
  python tools/download_noaa_va_dem.py --region va_southern --info

  # Download the Hampton Roads covering DEM (VA Southern)
  python tools/download_noaa_va_dem.py --region hampton_roads --download --outdir data/dem

  # (Optional) After download, split Southern DEM into per-city clipped GeoTIFFs
  # Requires gdalwarp installed (sudo apt-get install gdal-bin)
  python tools/download_noaa_va_dem.py --region hampton_roads --download --outdir data/dem --split-cities --cities-outdir data/dem/hampton_roads_cities
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


_DEFAULT_BASE = "https://coast.noaa.gov/htdata/raster2/elevation/SLR_viewer_DEM_6230/VA/"

# NOAA regional DEMs (GCS, 3m, NAVD meters).
_REGION_TO_FILE = {
    "va_eastern_shore": "VA_EasternShore_GCS_3m_NAVDm.tif",
    "va_middle": "VA_Middle_GCS_3m_NAVDm.tif",
    "va_northern": "VA_Northern_GCS_3m_NAVDm.tif",
    "va_southern": "VA_Southern_GCS_3m_NAVDm.tif",
    # Convenience aliases
    "virginia": "",  # special-case: download all 4
    "va": "",  # special-case: download all 4
    # City bundle presets (these are still just "which big DEM covers this area")
    "hampton_roads": "VA_Southern_GCS_3m_NAVDm.tif",
    "hampton_roads_cities": "VA_Southern_GCS_3m_NAVDm.tif",
    # Richmond is generally best covered by VA Middle (works well for the metro).
    "richmond": "VA_Middle_GCS_3m_NAVDm.tif",
}

# Reuse the same city bbox presets as tools/osm_extract_hampton_roads_cities.py
# Note: WGS84 lon/lat; approximate.
_HAMPTON_ROADS_CITY_BBOX = {
    "virginia_beach": (-76.33, 36.55, -75.90, 36.99),
    "chesapeake": (-76.63, 36.55, -76.02, 36.92),
    "norfolk": (-76.35, 36.80, -76.17, 36.97),
    "portsmouth": (-76.41, 36.78, -76.25, 36.92),
    "suffolk": (-76.80, 36.62, -76.38, 37.05),
    "hampton": (-76.43, 36.96, -76.20, 37.12),
    "newport_news": (-76.62, 36.92, -76.35, 37.20),
}


def _fmt_bytes(n: int | None) -> str:
    if not isinstance(n, int) or n < 0:
        return "unknown"
    kb = 1024
    mb = kb * 1024
    gb = mb * 1024
    if n >= gb:
        return f"{n / gb:.2f} GiB"
    if n >= mb:
        return f"{n / mb:.2f} MiB"
    if n >= kb:
        return f"{n / kb:.2f} KiB"
    return f"{n} B"


def _head(url: str, timeout_s: float = 20.0) -> tuple[int | None, str | None]:
    req = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        cl = resp.headers.get("Content-Length")
        try:
            n = int(cl) if cl is not None else None
        except ValueError:
            n = None
        return n, getattr(resp, "url", None)


def _download(url: str, out_path: str, timeout_s: float = 30.0, chunk_bytes: int = 1024 * 1024) -> None:
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    tmp_path = out_path + ".part"

    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=timeout_s) as resp, open(tmp_path, "wb") as f:
        total = resp.headers.get("Content-Length")
        try:
            total_n = int(total) if total is not None else None
        except ValueError:
            total_n = None

        done = 0
        t0 = time.time()
        last_print = 0.0
        while True:
            b = resp.read(chunk_bytes)
            if not b:
                break
            f.write(b)
            done += len(b)
            now = time.time()
            if now - last_print >= 0.5:
                dt = max(0.001, now - t0)
                mbps = (done / (1024 * 1024)) / dt
                if isinstance(total_n, int) and total_n > 0:
                    pct = (done / total_n) * 100.0
                    sys.stdout.write(f"\rDownloaded: {_fmt_bytes(done)} / {_fmt_bytes(total_n)} ({pct:.1f}%)  {mbps:.2f} MiB/s")
                else:
                    sys.stdout.write(f"\rDownloaded: {_fmt_bytes(done)}  {mbps:.2f} MiB/s")
                sys.stdout.flush()
                last_print = now

    sys.stdout.write("\n")
    sys.stdout.flush()
    os.replace(tmp_path, out_path)

def _local_size(path: str) -> int | None:
    try:
        if not os.path.exists(path):
            return None
        return int(os.path.getsize(path))
    except Exception:
        return None


def _gdalwarp() -> str | None:
    return shutil.which("gdalwarp")


def _clip_city_tiles(src_tif: str, outdir: str, prefix: str = "va_hampton_roads") -> None:
    gdalwarp = _gdalwarp()
    if not gdalwarp:
        raise RuntimeError("Missing dependency: gdalwarp (GDAL). Install: sudo apt-get install gdal-bin")
    os.makedirs(outdir, exist_ok=True)

    # The NOAA DEMs are named "*_GCS_*" and are typically already geographic CRS; we keep target SRS explicit.
    # Note: -te uses (minX minY maxX maxY) in target SRS coordinates.
    for city, (min_lon, min_lat, max_lon, max_lat) in _HAMPTON_ROADS_CITY_BBOX.items():
        out_path = os.path.join(outdir, f"{prefix}_{city}_dem.tif")
        print(f"\nClipping {city}: bbox={min_lon},{min_lat},{max_lon},{max_lat}")
        cmd = [
            gdalwarp,
            "-overwrite",
            "-t_srs",
            "EPSG:4326",
            "-te",
            str(min_lon),
            str(min_lat),
            str(max_lon),
            str(max_lat),
            src_tif,
            out_path,
        ]
        p = subprocess.run(cmd, check=False, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        if p.returncode != 0:
            raise RuntimeError(f"gdalwarp failed ({p.returncode}) for {city}:\n{p.stdout}")
        print(f"Wrote: {out_path}")


def _url_for_file(base: str, filename: str) -> str:
    return urllib.parse.urljoin(base.rstrip("/") + "/", filename)


def _known_regions() -> str:
    keys = sorted(_REGION_TO_FILE.keys())
    return ", ".join(keys)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=_DEFAULT_BASE, help=f"Base URL (default: {_DEFAULT_BASE})")
    ap.add_argument(
        "--region",
        default="hampton_roads",
        help=f"Which DEM to fetch. Known: {_known_regions()}",
    )
    ap.add_argument("--url", default="", help="Explicit .tif URL (overrides --region).")
    ap.add_argument("--outdir", default="data/dem", help="Output directory (default: data/dem).")
    ap.add_argument("--filename", default="", help="Override output filename (default: inferred from URL).")
    ap.add_argument("--info", action="store_true", help="Only print remote URL + size (no download).")
    ap.add_argument("--download", action="store_true", help="Perform the download (explicit).")
    ap.add_argument("--overwrite", action="store_true", help="If output exists but size mismatches remote, overwrite it.")
    ap.add_argument(
        "--split-cities",
        action="store_true",
        help="After download, clip per-city DEM GeoTIFFs for Hampton Roads using gdalwarp.",
    )
    ap.add_argument(
        "--cities-outdir",
        default="data/dem/hampton_roads_cities",
        help="Output directory for --split-cities.",
    )
    args = ap.parse_args(argv)

    region = (args.region or "").strip().lower()
    base = args.base

    # Allow explicit URL override.
    if args.url.strip():
        urls = [args.url.strip()]
    else:
        if region not in _REGION_TO_FILE:
            print(f"Unknown --region '{args.region}'. Known: {_known_regions()}", file=sys.stderr)
            return 2

        # Special-case: download all VA region DEMs.
        if region in ("virginia", "va"):
            urls = [_url_for_file(base, _REGION_TO_FILE[k]) for k in ("va_southern", "va_middle", "va_northern", "va_eastern_shore")]
        else:
            fn = _REGION_TO_FILE[region]
            if not fn:
                print(f"Region '{region}' is not mapped to a filename.", file=sys.stderr)
                return 2
            urls = [_url_for_file(base, fn)]

    # Download each URL
    downloaded_paths: list[str] = []
    for url in urls:
        name = args.filename.strip() or os.path.basename(urllib.parse.urlparse(url).path) or "dem.tif"
        out_path = os.path.join(args.outdir, name)

        try:
            size, final_url = _head(url)
        except urllib.error.HTTPError as e:
            print(f"HEAD failed: {e.code} {e.reason}\nURL: {url}", file=sys.stderr)
            return 2
        except Exception as e:
            print(f"HEAD failed: {e}\nURL: {url}", file=sys.stderr)
            return 2

        if final_url and final_url != url:
            url = final_url

        print(f"\nURL: {url}")
        print(f"Remote size: {_fmt_bytes(size)} ({size if isinstance(size, int) else 'n/a'} bytes)")
        print(f"Output path: {out_path}")

        if args.info and not args.download:
            print("Info-only; not downloading.")
            continue

        if not args.download:
            print("Refusing to download without --download. (Use --info to preview size.)", file=sys.stderr)
            return 3

        local_n = _local_size(out_path)
        if isinstance(local_n, int) and local_n > 0:
            if isinstance(size, int) and size > 0 and local_n == size:
                print("Already exists with matching size; skipping download.")
                downloaded_paths.append(out_path)
                continue
            if not args.overwrite:
                print(
                    "Output already exists but size does not match remote (or remote size unknown).\n"
                    f"- local:  {_fmt_bytes(local_n)} ({local_n} bytes)\n"
                    f"- remote: {_fmt_bytes(size)} ({size if isinstance(size, int) else 'n/a'} bytes)\n"
                    "Refusing to overwrite without --overwrite.",
                    file=sys.stderr,
                )
                return 4
            print("Output exists but size mismatches remote; overwriting (--overwrite).")
            try:
                os.remove(out_path)
            except Exception:
                pass
            try:
                part = out_path + ".part"
                if os.path.exists(part):
                    os.remove(part)
            except Exception:
                pass

        print("Starting download...")
        try:
            _download(url, out_path)
        except Exception as e:
            print(f"Download failed: {e}", file=sys.stderr)
            return 4

        print("Done.")
        downloaded_paths.append(out_path)

    # Optional: clip Hampton Roads cities.
    if args.split_cities:
        # Only meaningful when using the Hampton Roads covering DEM (Southern).
        src = None
        for p in downloaded_paths:
            if p.lower().endswith("va_southern_gcs_3m_navdm.tif"):
                src = p
                break
        if not src and downloaded_paths:
            # If user passed explicit URL, use the first downloaded file.
            src = downloaded_paths[0]
        if not src:
            print("Nothing downloaded; cannot split cities.", file=sys.stderr)
            return 5
        print(f"\nSplitting cities using source DEM: {src}")
        try:
            _clip_city_tiles(src, args.cities_outdir, prefix="va_hampton_roads")
        except Exception as e:
            print(f"City split failed: {e}", file=sys.stderr)
            return 6

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))


