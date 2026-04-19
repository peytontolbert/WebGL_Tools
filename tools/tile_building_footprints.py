#!/usr/bin/env python3
"""
Tile WGS84 building GeoJSON into chunked *footprint* binaries for near-camera extrusion.

This complements `tools/tile_instanced_buildings.py`:
- BUI1 tiles: prebuilt instanced boxes (fast, far-LOD, huge coverage)
- BFP1 tiles: compact footprint rings + minY/maxY + color (for near-LOD mesh extrusion)

Output:
  <outdir>/index.json
  <outdir>/chunks/f_<cx>_<cz>.bin

Binary chunk format (little-endian) "BFP1":
  magic: 4 bytes 'BFP1'
  count: u32 (buildings)
  For each building:
    cx, cz: float32 (center in projected meters)
    minY, maxY: float32
    color: 4 float32 (rgba)
    n: u16 (ring points, open loop)
    points: n pairs of int16 (dx, dz) quantized in units of `quantizeMeters`
      x = cx + dx * quantizeMeters
      z = cz + dz * quantizeMeters

Notes:
- This intentionally does NOT store full OSM tag dictionaries (too big). Keep that in a separate
  tag-index tile set if needed later.
- Use small radiusChunks in the runtime streamer; only a few chunks should be extruded at once.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import struct
import sys
from typing import Any, Iterable


def _to_float(v: Any) -> float | None:
    if v is None:
        return None
    try:
        n = float(v)
    except Exception:
        return None
    return n if math.isfinite(n) else None


def _to_rad(deg: float) -> float:
    return float(deg) * math.pi / 180.0


def _project_lonlat_m(lon: float, lat: float, origin_lon: float, origin_lat: float) -> tuple[float, float]:
    # Equirectangular around origin (matches viewer)
    R = 6378137.0
    lam = _to_rad(lon)
    phi = _to_rad(lat)
    lam0 = _to_rad(origin_lon)
    phi0 = _to_rad(origin_lat)
    x = (lam - lam0) * math.cos(phi0) * R
    z = (phi - phi0) * R
    return x, z


def _iter_outer_rings(geom: dict[str, Any]) -> Iterable[list[list[float]]]:
    t = geom.get("type")
    coords = geom.get("coordinates")
    if t == "Polygon" and isinstance(coords, list) and coords and isinstance(coords[0], list):
        yield coords[0]
    elif t == "MultiPolygon" and isinstance(coords, list):
        for poly in coords:
            if isinstance(poly, list) and poly and isinstance(poly[0], list):
                yield poly[0]


def _walk_lonlat_bounds(x: Any, acc: dict[str, float]) -> None:
    if isinstance(x, (list, tuple)) and len(x) >= 2 and isinstance(x[0], (int, float)) and isinstance(x[1], (int, float)):
        lon = float(x[0]); lat = float(x[1])
        if not (math.isfinite(lon) and math.isfinite(lat)):
            return
        acc["minLon"] = min(acc["minLon"], lon)
        acc["minLat"] = min(acc["minLat"], lat)
        acc["maxLon"] = max(acc["maxLon"], lon)
        acc["maxLat"] = max(acc["maxLat"], lat)
        return
    if isinstance(x, (list, tuple)):
        for y in x:
            _walk_lonlat_bounds(y, acc)


def _parse_height_m(props: dict[str, Any], default_m: float) -> float:
    # height in meters or building:levels
    h = _to_float(props.get("height"))
    if h is None:
        h = _to_float(props.get("building:height"))
    if h is not None and h > 0:
        return float(max(3.0, min(180.0, h)))
    lv = _to_float(props.get("building:levels"))
    if lv is None:
        lv = _to_float(props.get("levels"))
    if lv is not None and lv > 0:
        return float(max(3.0, min(180.0, lv * 3.0)))
    return float(max(3.0, min(180.0, default_m)))


def _parse_min_height_m(props: dict[str, Any]) -> float:
    mh = _to_float(props.get("min_height"))
    if mh is None:
        mh = _to_float(props.get("building:min_height"))
    if mh is not None and mh >= 0:
        return float(max(0.0, min(180.0, mh)))
    return 0.0


def _parse_color_rgba(props: dict[str, Any]) -> tuple[float, float, float, float]:
    # Minimal: if a building:colour exists, parse #RGB/#RRGGBB, else neutral.
    raw = props.get("building:colour") or props.get("building:color") or props.get("colour") or props.get("color")
    if isinstance(raw, str):
        s = raw.strip()
        if s.startswith("#"):
            s = s[1:]
        if len(s) == 3:
            s = s[0] * 2 + s[1] * 2 + s[2] * 2
        if len(s) == 6:
            try:
                r = int(s[0:2], 16) / 255.0
                g = int(s[2:4], 16) / 255.0
                b = int(s[4:6], 16) / 255.0
                return (float(r), float(g), float(b), 0.92)
            except Exception:
                pass
    return (0.72, 0.72, 0.74, 0.90)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inputs", action="append", required=True, help="Input GeoJSON path (repeatable).")
    ap.add_argument("--outdir", required=True, help="Output directory.")
    ap.add_argument("--chunk-size-m", type=float, default=512.0, help="Chunk size in projected meters (default: 512).")
    ap.add_argument("--quantize-m", type=float, default=0.1, help="Meters per int16 unit for ring points (default: 0.1m).")
    ap.add_argument("--default-height-m", type=float, default=7.5, help="Default building height in meters (default: 7.5).")
    ap.add_argument("--max-buildings", type=int, default=0, help="Optional cap (0 = no cap).")
    ap.add_argument("--overwrite", action="store_true", help="Overwrite output directory contents.")
    args = ap.parse_args(argv)

    inputs = [str(p).strip() for p in (args.inputs or []) if str(p).strip()]
    if not inputs:
        print("No inputs.", file=sys.stderr)
        return 2
    for p in inputs:
        if not os.path.exists(p):
            print(f"Input not found: {p}", file=sys.stderr)
            return 2

    outdir = str(args.outdir)
    chunk_size = float(args.chunk_size_m)
    if not (math.isfinite(chunk_size) and chunk_size > 1):
        print("Invalid --chunk-size-m", file=sys.stderr)
        return 2
    q = float(args.quantize_m)
    if not (math.isfinite(q) and q > 0):
        print("Invalid --quantize-m", file=sys.stderr)
        return 2

    if os.path.exists(outdir) and os.listdir(outdir) and not args.overwrite:
        print(f"Refusing to overwrite non-empty outdir without --overwrite: {outdir}", file=sys.stderr)
        return 3
    os.makedirs(outdir, exist_ok=True)
    chunks_dir = os.path.join(outdir, "chunks")
    os.makedirs(chunks_dir, exist_ok=True)

    # Pass 1: bounds over all inputs (to choose origin)
    acc = {"minLon": 1e9, "minLat": 1e9, "maxLon": -1e9, "maxLat": -1e9}
    total_feats = 0
    for p in inputs:
        with open(p, "r", encoding="utf-8") as f:
            gj = json.load(f)
        feats = gj.get("features") if isinstance(gj, dict) else None
        if not isinstance(feats, list):
            continue
        total_feats += len(feats)
        for ft in feats:
            if not isinstance(ft, dict):
                continue
            geom = ft.get("geometry") or {}
            if not isinstance(geom, dict):
                continue
            _walk_lonlat_bounds(geom.get("coordinates"), acc)
    if acc["minLon"] > acc["maxLon"]:
        print("No lon/lat coords found in inputs.", file=sys.stderr)
        return 4

    origin_lon = (acc["minLon"] + acc["maxLon"]) * 0.5
    origin_lat = (acc["minLat"] + acc["maxLat"]) * 0.5

    default_h = float(args.default_height_m)
    if not (math.isfinite(default_h) and default_h > 0):
        default_h = 7.5

    # Chunk accumulation: key -> bytes buffer
    chunk_items: dict[str, list[bytes]] = {}
    chunk_counts: dict[str, int] = {}
    built = 0

    def chunk_key_for_center(cx: float, cz: float) -> str:
        ix = math.floor(cx / chunk_size)
        iz = math.floor(cz / chunk_size)
        return f"{ix}_{iz}"

    # Pass 2: build instances
    for p in inputs:
        with open(p, "r", encoding="utf-8") as f:
            gj = json.load(f)
        feats = gj.get("features") if isinstance(gj, dict) else None
        if not isinstance(feats, list):
            continue

        for ft in feats:
            if args.max_buildings and built >= int(args.max_buildings):
                break
            if not isinstance(ft, dict):
                continue
            geom = ft.get("geometry")
            if not isinstance(geom, dict):
                continue
            props = ft.get("properties") if isinstance(ft.get("properties"), dict) else {}
            for ring in _iter_outer_rings(geom):
                if args.max_buildings and built >= int(args.max_buildings):
                    break
                if not isinstance(ring, list) or len(ring) < 3:
                    continue

                pts_m: list[tuple[float, float]] = []
                bx0 = bz0 = 1e18
                bx1 = bz1 = -1e18
                for pt in ring:
                    if not (isinstance(pt, (list, tuple)) and len(pt) >= 2):
                        continue
                    lon = _to_float(pt[0])
                    lat = _to_float(pt[1])
                    if lon is None or lat is None:
                        continue
                    x, z = _project_lonlat_m(lon, lat, origin_lon, origin_lat)
                    if not (math.isfinite(x) and math.isfinite(z)):
                        continue
                    pts_m.append((x, z))
                    bx0 = min(bx0, x); bx1 = max(bx1, x)
                    bz0 = min(bz0, z); bz1 = max(bz1, z)
                if len(pts_m) < 3 or not math.isfinite(bx0):
                    continue

                # Drop closing point if it duplicates the first
                if len(pts_m) >= 4:
                    ax, az = pts_m[0]
                    lx, lz = pts_m[-1]
                    if math.hypot(lx - ax, lz - az) < 1e-4:
                        pts_m.pop()
                if len(pts_m) < 3:
                    continue

                cx = (bx0 + bx1) * 0.5
                cz = (bz0 + bz1) * 0.5
                max_y = _parse_height_m(props, default_h)
                min_y = _parse_min_height_m(props)
                if max_y <= min_y + 0.25:
                    max_y = min_y + 0.25
                col = _parse_color_rgba(props)

                # Quantize ring relative to center
                qpts: list[tuple[int, int]] = []
                ok = True
                for (x, z) in pts_m:
                    dx = int(round((x - cx) / q))
                    dz = int(round((z - cz) / q))
                    if dx < -32768 or dx > 32767 or dz < -32768 or dz > 32767:
                        ok = False
                        break
                    qpts.append((dx, dz))
                if not ok or len(qpts) < 3 or len(qpts) > 65535:
                    continue

                # Pack record
                rec = bytearray()
                rec += struct.pack("<ffff", float(cx), float(cz), float(min_y), float(max_y))
                rec += struct.pack("<ffff", float(col[0]), float(col[1]), float(col[2]), float(col[3]))
                rec += struct.pack("<H", int(len(qpts)))
                for (dx, dz) in qpts:
                    rec += struct.pack("<hh", int(dx), int(dz))

                k = chunk_key_for_center(cx, cz)
                arr = chunk_items.get(k)
                if arr is None:
                    arr = []
                    chunk_items[k] = arr
                    chunk_counts[k] = 0
                arr.append(bytes(rec))
                chunk_counts[k] = int(chunk_counts.get(k, 0)) + 1
                built += 1

    # Write chunks + index
    index_chunks: dict[str, Any] = {}
    for key, recs in chunk_items.items():
        cnt = int(chunk_counts.get(key, 0))
        if cnt <= 0:
            continue
        out_name = f"f_{key}.bin"
        out_path = os.path.join(chunks_dir, out_name)
        with open(out_path, "wb") as f:
            f.write(b"BFP1")
            f.write(struct.pack("<I", cnt))
            for r in recs:
                f.write(r)
        index_chunks[key] = {"file": f"chunks/{out_name}", "count": cnt}

    idx = {
        "schema": "webglgta-dataset-tiles-v1",
        "kind": "building-footprints",
        "chunkSizeMeters": chunk_size,
        "originLonLat": [origin_lon, origin_lat],
        "chunkMagic": "BFP1",
        "quantizeMeters": q,
        "sourceInputs": inputs,
        "totalFeaturesScanned": total_feats,
        "totalBuildingsWritten": built,
        "chunks": index_chunks,
    }
    with open(os.path.join(outdir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(idx, f)

    print("Wrote:")
    print(f"- {outdir}/index.json")
    print(f"- {outdir}/chunks/*.bin")
    print(f"originLonLat: {origin_lon:.6f},{origin_lat:.6f}")
    print(f"chunks: {len(index_chunks)}")
    print(f"buildings: {built}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))


