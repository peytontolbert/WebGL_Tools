#!/usr/bin/env python3
"""
Tile WGS84 building GeoJSON into chunked instanced-box binaries for fast streaming.

Why:
- The standalone viewer can load huge GeoJSONs, but parsing + projecting everything up-front is slow.
- This tool preprocesses GeoJSON into small spatial chunks (e.g. 512m) and writes prebuilt
  InstancedBoxRenderer buffers (11 floats per instance), ready to stream by camera.

Outputs:
  <outdir>/index.json
  <outdir>/chunks/b_<cx>_<cz>.bin

Binary chunk format (little-endian):
  magic: 4 bytes 'BUI1'
  count: u32
  floats: count * 11 float32s

Example (combine multiple city GeoJSONs into one tiled dataset):
  python tools/tile_instanced_buildings.py \
    --in assets/datasets/overture_virginia_beach/va_virginia_beach_overture_buildings.geojson \
    --in assets/datasets/overture_chesapeake/va_chesapeake_overture_buildings.geojson \
    --in assets/datasets/overture_norfolk/va_norfolk_overture_buildings.geojson \
    --in assets/datasets/overture_portsmouth/va_portsmouth_overture_buildings.geojson \
    --in assets/datasets/overture_suffolk/va_suffolk_overture_buildings.geojson \
    --in assets/datasets/overture_hampton/va_hampton_overture_buildings.geojson \
    --in assets/datasets/overture_newport_news/va_newport_news_overture_buildings.geojson \
    --outdir assets/datasets/tiles/overture_va_hampton_roads_buildings \
    --chunk-size-m 512 \
    --min-footprint-m 1.5 \
    --default-height-m 7.5
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


def _infer_yaw_from_ring_m(ring_m: list[tuple[float, float]]) -> float:
    # Match viewer heuristic: take the longest edge direction.
    best = 0.0
    best_dx = 0.0
    best_dz = 1.0
    n = len(ring_m)
    if n < 2:
        return 0.0
    for i in range(n - 1):
        ax, az = ring_m[i]
        bx, bz = ring_m[i + 1]
        dx = bx - ax
        dz = bz - az
        l = math.hypot(dx, dz)
        if not math.isfinite(l) or l <= 0:
            continue
        if l > best:
            best = l
            best_dx = dx
            best_dz = dz
    if best <= 1e-6:
        return 0.0
    return float(math.atan2(best_dx, best_dz))


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
    # Accumulate lon/lat bounds from nested coordinates.
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


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inputs", action="append", required=True, help="Input GeoJSON path (repeatable).")
    ap.add_argument("--outdir", required=True, help="Output directory.")
    ap.add_argument("--chunk-size-m", type=float, default=512.0, help="Chunk size in projected meters (default: 512).")
    ap.add_argument("--min-footprint-m", type=float, default=1.5, help="Minimum footprint size in meters (default: 1.5).")
    ap.add_argument("--default-height-m", type=float, default=7.5, help="Default building height in meters (default: 7.5).")
    ap.add_argument(
        "--format",
        choices=["float32", "packed16"],
        default="packed16",
        help="Chunk encoding: float32 (BUI1) or packed16 (BUI2, smaller). Default: packed16.",
    )
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

    min_fp = float(args.min_footprint_m)
    if not (math.isfinite(min_fp) and min_fp > 0):
        min_fp = 1.5
    default_h = float(args.default_height_m)
    if not (math.isfinite(default_h) and default_h > 0):
        default_h = 7.5

    # Chunk accumulation: key -> list[float] (instances)
    chunk_data: dict[str, list[float]] = {}
    chunk_counts: dict[str, int] = {}
    built = 0

    def add_instance(key: str, inst11: list[float]) -> None:
        nonlocal built
        if args.max_buildings and built >= int(args.max_buildings):
            return
        arr = chunk_data.get(key)
        if arr is None:
            arr = []
            chunk_data[key] = arr
            chunk_counts[key] = 0
        arr.extend(inst11)
        chunk_counts[key] = int(chunk_counts.get(key, 0)) + 1
        built += 1

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
            # Only polygons
            for ring in _iter_outer_rings(geom):
                if args.max_buildings and built >= int(args.max_buildings):
                    break
                if not isinstance(ring, list) or len(ring) < 3:
                    continue

                ring_m: list[tuple[float, float]] = []
                bx0 = bz0 = 1e18
                bx1 = bz1 = -1e18
                ok = False
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
                    ring_m.append((x, z))
                    bx0 = min(bx0, x); bx1 = max(bx1, x)
                    bz0 = min(bz0, z); bz1 = max(bz1, z)
                    ok = True
                if not ok:
                    continue

                sx = max(min_fp, bx1 - bx0)
                sz = max(min_fp, bz1 - bz0)
                cx = (bx0 + bx1) * 0.5
                cz = (bz0 + bz1) * 0.5
                h = _parse_height_m(props, default_h)
                span_h = max(0.25, float(h))
                tx = float(cx)
                ty = float(span_h * 0.5)
                tz = float(cz)
                yaw = _infer_yaw_from_ring_m(ring_m)

                # Simple color (slight variation by height)
                tcol = min(1.0, max(0.0, (span_h - 3.0) / 60.0))
                r = 0.62 + 0.10 * tcol
                g = 0.64 + 0.10 * tcol
                b = 0.70 + 0.08 * tcol
                a = 1.0

                # Chunk key by center position
                cxi = int(math.floor(tx / chunk_size))
                czi = int(math.floor(tz / chunk_size))
                key = f"{cxi}_{czi}"

                add_instance(key, [tx, ty, tz, float(sx), float(span_h), float(sz), float(yaw), float(r), float(g), float(b), float(a)])

    # Write chunks
    chunks_meta: dict[str, dict[str, Any]] = {}
    floats_per = 11
    for key in sorted(chunk_data.keys()):
        floats = chunk_data[key]
        count = int(chunk_counts.get(key, 0))
        if count <= 0:
            continue
        if len(floats) != count * floats_per:
            # Should never happen, but avoid corrupt output.
            continue
        cx, cz = key.split("_", 1)
        fname = f"b_{cx}_{cz}.bin"
        out_path = os.path.join(chunks_dir, fname)
        with open(out_path, "wb") as f:
            if args.format == "float32":
                f.write(b"BUI1")
                f.write(struct.pack("<I", count))
                f.write(struct.pack("<%sf" % (len(floats),), *floats))
                chunks_meta[key] = {"file": f"chunks/{fname}", "count": count, "magic": "BUI1"}
            else:
                # Packed16 (BUI2):
                # Header:
                #   magic 'BUI2'
                #   count u32
                #   chunkMinX f32, chunkMinZ f32, chunkSize f32, maxTy f32, maxScale f32
                # Records (count):
                #   tx,ty,tz,sx,sy,sz: u16 (quantized)
                #   yaw: i16 (quantized to [-pi..pi])
                #   rgba: u8
                cxi = int(cx)
                czi = int(cz)
                chunk_min_x = float(cxi * chunk_size)
                chunk_min_z = float(czi * chunk_size)
                # Derive per-chunk ranges for better precision.
                max_ty = 0.0
                max_sc = 0.0
                for i in range(0, len(floats), floats_per):
                    ty = float(floats[i + 1])
                    sx = float(floats[i + 3])
                    sy = float(floats[i + 4])
                    sz = float(floats[i + 5])
                    if math.isfinite(ty):
                        max_ty = max(max_ty, ty)
                    if math.isfinite(sx):
                        max_sc = max(max_sc, sx)
                    if math.isfinite(sy):
                        max_sc = max(max_sc, sy)
                    if math.isfinite(sz):
                        max_sc = max(max_sc, sz)
                # Safety padding / non-zero ranges
                max_ty = float(max(1.0, min(512.0, max_ty * 1.05)))
                max_sc = float(max(1.0, min(1024.0, max_sc * 1.05)))

                f.write(b"BUI2")
                f.write(struct.pack("<I", count))
                f.write(struct.pack("<fffff", chunk_min_x, chunk_min_z, float(chunk_size), max_ty, max_sc))

                inv_cs = 1.0 / float(chunk_size)
                inv_ty = 1.0 / max_ty
                inv_sc = 1.0 / max_sc

                def q_u16(v01: float) -> int:
                    if not math.isfinite(v01):
                        return 0
                    x = max(0.0, min(1.0, float(v01)))
                    return int(round(x * 65535.0))

                def q_i16_yaw(rad: float) -> int:
                    if not math.isfinite(rad):
                        return 0
                    x = float(rad) / math.pi
                    x = max(-1.0, min(1.0, x))
                    return int(round(x * 32767.0))

                def q_u8(c01: float) -> int:
                    if not math.isfinite(c01):
                        return 0
                    x = max(0.0, min(1.0, float(c01)))
                    return int(round(x * 255.0))

                rec_struct = struct.Struct("<6Hh4B")  # 18 bytes
                for i in range(0, len(floats), floats_per):
                    tx = float(floats[i + 0])
                    ty = float(floats[i + 1])
                    tz = float(floats[i + 2])
                    sx = float(floats[i + 3])
                    sy = float(floats[i + 4])
                    sz = float(floats[i + 5])
                    yaw = float(floats[i + 6])
                    r = float(floats[i + 7])
                    g = float(floats[i + 8])
                    b = float(floats[i + 9])
                    a = float(floats[i + 10])

                    # Quantize:
                    # - tx/tz relative to chunk min corner over chunk_size
                    # - ty relative to max_ty
                    # - scale relative to max_sc
                    tx01 = (tx - chunk_min_x) * inv_cs
                    tz01 = (tz - chunk_min_z) * inv_cs
                    ty01 = ty * inv_ty
                    sx01 = sx * inv_sc
                    sy01 = sy * inv_sc
                    sz01 = sz * inv_sc

                    f.write(rec_struct.pack(
                        q_u16(tx01),
                        q_u16(ty01),
                        q_u16(tz01),
                        q_u16(sx01),
                        q_u16(sy01),
                        q_u16(sz01),
                        q_i16_yaw(yaw),
                        q_u8(r),
                        q_u8(g),
                        q_u8(b),
                        q_u8(a),
                    ))

                chunks_meta[key] = {"file": f"chunks/{fname}", "count": count, "magic": "BUI2", "maxTy": max_ty, "maxScale": max_sc}

    index = {
        "schema": "webglgta-dataset-tiles-v1",
        "kind": "instanced-box-buildings",
        "chunkSizeMeters": chunk_size,
        "originLonLat": [origin_lon, origin_lat],
        "sourceInputs": inputs,
        "lonLatBounds": {
            "minLon": acc["minLon"],
            "minLat": acc["minLat"],
            "maxLon": acc["maxLon"],
            "maxLat": acc["maxLat"],
        },
        "chunks": chunks_meta,
        "totalInstances": built,
        "floatsPerInstance": 11,
        "chunkMagic": ("BUI1" if args.format == "float32" else "BUI2"),
        "encoding": ("float32" if args.format == "float32" else "packed16"),
    }
    with open(os.path.join(outdir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f)

    print("Wrote tiled building dataset:")
    print(f"- outdir: {outdir}")
    print(f"- chunks: {len(chunks_meta)}")
    print(f"- instances: {built}")
    print(f"- originLonLat: {origin_lon:.6f},{origin_lat:.6f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))


