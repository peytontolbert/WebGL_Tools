#!/usr/bin/env python3
"""
Build coarse multi-LOD building tilesets (LOD0 and optional LOD2) from an existing BUI2 tileset (LOD1).

Why:
- LOD1 BUI2 tiles are great near camera but still heavy for "render the whole metro".
- LOD0 aggregates many buildings into a sparse grid of larger boxes (blocks),
  dramatically reducing instance count at distance.

Input:
  <lod1_dir>/index.json   (schema webglgta-dataset-tiles-v1, chunkMagic BUI2)
  <lod1_dir>/chunks/*.bin (BUI2 chunks)

Output:
  <outdir>/lod0/index.json
  <outdir>/lod0/chunks/*.bin
  <outdir>/lod2/index.json              (optional)
  <outdir>/lod2/chunks/*.bin            (optional)
  <outdir>/multilod_index.json          (schema webglgta-buildings-multilod-v1)

Notes:
- LOD0 uses the same BUI2 packed chunk format.
- LOD0 boxes represent occupied cells in a fixed grid (cell meters) per LOD0 chunk.
  Each occupied cell becomes one instanced box whose height is max building height in that cell.

Example:
  python3 tools/build_lod0_from_bui2_tiles.py \
    --lod1 assets/datasets/tiles/overture_va_hampton_roads_buildings_lod1 \
    --outdir assets/datasets/tiles/overture_va_hampton_roads_buildings_multilod \
    --lod0-mult 4 \
    --cell-m 64 \
    --overwrite

With LOD2:
  python3 tools/build_lod0_from_bui2_tiles.py \
    --lod1 <outdir_lod1> \
    --outdir <outdir_multilod> \
    --lod0-mult 4 \
    --cell-m 64 \
    --lod2-mult 16 \
    --lod2-cell-m 256 \
    --overwrite
"""

from __future__ import annotations

import argparse
import json
import math
import os
import struct
import sys
from typing import Any


REC_BYTES = 18  # <6Hh4B
REC_STRUCT = struct.Struct("<6Hh4B")


def _read_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _write_json(path: str, obj: Any) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f)


def _u16_to_01(v: int) -> float:
    return float(v) / 65535.0


def _clamp01(x: float) -> float:
    if not math.isfinite(x):
        return 0.0
    return 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)


def _q_u16(x01: float) -> int:
    return int(round(_clamp01(x01) * 65535.0))


def _q_i16_yaw(rad: float) -> int:
    if not math.isfinite(rad):
        return 0
    x = float(rad) / math.pi
    if x < -1.0:
        x = -1.0
    if x > 1.0:
        x = 1.0
    return int(round(x * 32767.0))


def _q_u8(c01: float) -> int:
    if not math.isfinite(c01):
        return 0
    x = 0.0 if c01 < 0.0 else (1.0 if c01 > 1.0 else float(c01))
    return int(round(x * 255.0))


def _parse_bui2_chunk(path: str) -> tuple[int, dict[str, float], memoryview]:
    with open(path, "rb") as f:
        data = f.read()
    if len(data) < 8 + 5 * 4:
        return (0, {}, memoryview(b""))
    if data[0:4] != b"BUI2":
        return (0, {}, memoryview(b""))
    count = struct.unpack_from("<I", data, 4)[0]
    chunk_min_x, chunk_min_z, chunk_size, max_ty, max_scale = struct.unpack_from("<fffff", data, 8)
    hdr = {
        "chunkMinX": float(chunk_min_x),
        "chunkMinZ": float(chunk_min_z),
        "chunkSize": float(chunk_size),
        "maxTy": float(max_ty),
        "maxScale": float(max_scale),
    }
    off = 8 + 5 * 4
    need = off + int(count) * REC_BYTES
    if need > len(data):
        return (0, hdr, memoryview(b""))
    return (int(count), hdr, memoryview(data)[off:need])


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lod1", required=True, help="Input LOD1 tiles directory (contains index.json + chunks/).")
    ap.add_argument("--outdir", required=True, help="Output directory.")
    ap.add_argument("--lod0-mult", type=int, default=4, help="LOD0 chunk size multiplier relative to LOD1 (default: 4).")
    ap.add_argument("--cell-m", type=float, default=64.0, help="LOD0 aggregation cell size in meters (default: 64).")
    ap.add_argument("--lod2-mult", type=int, default=16, help="LOD2 chunk size multiplier relative to LOD1 (default: 16).")
    ap.add_argument("--lod2-cell-m", type=float, default=256.0, help="LOD2 aggregation cell size in meters (default: 256).")
    ap.add_argument("--no-lod2", action="store_true", help="Disable LOD2 generation.")
    ap.add_argument("--max-height-m", type=float, default=220.0, help="Clamp aggregated block height (default: 220).")
    ap.add_argument("--overwrite", action="store_true", help="Overwrite outdir if non-empty.")
    args = ap.parse_args(argv)

    lod1_dir = str(args.lod1)
    idx1_path = os.path.join(lod1_dir, "index.json")
    if not os.path.exists(idx1_path):
        print(f"Missing LOD1 index.json: {idx1_path}", file=sys.stderr)
        return 2
    idx1 = _read_json(idx1_path)
    if not isinstance(idx1, dict) or idx1.get("schema") != "webglgta-dataset-tiles-v1":
        print("LOD1 index schema mismatch.", file=sys.stderr)
        return 2
    if str(idx1.get("chunkMagic")) != "BUI2":
        print("LOD1 must be chunkMagic=BUI2.", file=sys.stderr)
        return 2

    cs1 = float(idx1.get("chunkSizeMeters") or 0)
    if not (math.isfinite(cs1) and cs1 > 0):
        print("LOD1 chunkSizeMeters invalid.", file=sys.stderr)
        return 2

    mult = int(args.lod0_mult)
    if mult < 2 or mult > 16:
        print("--lod0-mult out of range (2..16).", file=sys.stderr)
        return 2
    cs0 = cs1 * float(mult)

    mult2 = int(args.lod2_mult)
    if mult2 < 4 or mult2 > 64:
        print("--lod2-mult out of range (4..64).", file=sys.stderr)
        return 2
    cs2 = cs1 * float(mult2)
    wants_lod2 = not bool(args.no_lod2)

    cell_m = float(args.cell_m)
    if not (math.isfinite(cell_m) and cell_m > 1):
        print("--cell-m invalid.", file=sys.stderr)
        return 2
    # Ensure at least 1 cell, and avoid absurdly dense LOD0.
    max_cells = int(max(1, min(128, round(cs0 / max(1.0, cell_m)))))
    cell_m = cs0 / float(max_cells)

    cell2_m = float(args.lod2_cell_m)
    if not (math.isfinite(cell2_m) and cell2_m > 1):
        cell2_m = 256.0
    max_cells2 = int(max(1, min(256, round(cs2 / max(1.0, cell2_m)))))
    cell2_m = cs2 / float(max_cells2)

    outdir = str(args.outdir)
    if os.path.exists(outdir) and os.listdir(outdir) and not args.overwrite:
        print(f"Refusing to overwrite non-empty outdir without --overwrite: {outdir}", file=sys.stderr)
        return 3
    os.makedirs(outdir, exist_ok=True)
    lod0_dir = os.path.join(outdir, "lod0")
    lod0_chunks_dir = os.path.join(lod0_dir, "chunks")
    os.makedirs(lod0_chunks_dir, exist_ok=True)
    lod2_dir = os.path.join(outdir, "lod2")
    lod2_chunks_dir = os.path.join(lod2_dir, "chunks")
    if wants_lod2:
        os.makedirs(lod2_chunks_dir, exist_ok=True)

    chunks1: dict[str, Any] = idx1.get("chunks") if isinstance(idx1.get("chunks"), dict) else {}
    if not chunks1:
        print("LOD1 index has no chunks.", file=sys.stderr)
        return 4

    # Accumulate into LOD0 grid cells: (c0x,c0z,ix,iz) -> stats
    # stats: count, max_h, sum_rgb
    cells: dict[tuple[int, int, int, int], dict[str, float]] = {}
    cells2: dict[tuple[int, int, int, int], dict[str, float]] = {}

    max_h_cap = float(args.max_height_m)
    if not (math.isfinite(max_h_cap) and max_h_cap > 1):
        max_h_cap = 220.0

    processed = 0
    for key1, meta in chunks1.items():
        if not isinstance(meta, dict):
            continue
        file0 = str(meta.get("file") or "")
        if not file0:
            continue
        path = os.path.join(lod1_dir, file0.replace("/", os.sep))
        if not os.path.exists(path):
            continue
        count, hdr, recs = _parse_bui2_chunk(path)
        if count <= 0 or not recs:
            continue

        cminx = float(hdr.get("chunkMinX") or 0.0)
        cminz = float(hdr.get("chunkMinZ") or 0.0)
        cs = float(hdr.get("chunkSize") or cs1)
        max_scale = float(hdr.get("maxScale") or 256.0)
        if not (math.isfinite(cs) and cs > 0):
            cs = cs1
        if not (math.isfinite(max_scale) and max_scale > 0):
            max_scale = 256.0

        # Iterate packed records
        for i in range(count):
            off = i * REC_BYTES
            txu, tyu, tzu, sxu, syu, szu, yaw_i, r8, g8, b8, a8 = REC_STRUCT.unpack_from(recs, off)
            tx = cminx + _u16_to_01(txu) * cs
            tz = cminz + _u16_to_01(tzu) * cs
            # Interpret sy as height (since tiler uses sy=height, ty=height/2)
            h = _u16_to_01(syu) * max_scale
            if not math.isfinite(h) or h <= 0:
                continue
            if h > max_h_cap:
                h = max_h_cap

            c0x = int(math.floor(tx / cs0))
            c0z = int(math.floor(tz / cs0))
            local_x = tx - (c0x * cs0)
            local_z = tz - (c0z * cs0)
            ix = int(max(0, min(max_cells - 1, math.floor(local_x / cell_m))))
            iz = int(max(0, min(max_cells - 1, math.floor(local_z / cell_m))))

            k = (c0x, c0z, ix, iz)
            st = cells.get(k)
            if st is None:
                st = {"count": 0.0, "max_h": 0.0, "sr": 0.0, "sg": 0.0, "sb": 0.0}
                cells[k] = st
            st["count"] += 1.0
            if h > st["max_h"]:
                st["max_h"] = h
            st["sr"] += float(r8) / 255.0
            st["sg"] += float(g8) / 255.0
            st["sb"] += float(b8) / 255.0

            if wants_lod2:
                c2x = int(math.floor(tx / cs2))
                c2z = int(math.floor(tz / cs2))
                local2_x = tx - (c2x * cs2)
                local2_z = tz - (c2z * cs2)
                i2x = int(max(0, min(max_cells2 - 1, math.floor(local2_x / cell2_m))))
                i2z = int(max(0, min(max_cells2 - 1, math.floor(local2_z / cell2_m))))
                k2 = (c2x, c2z, i2x, i2z)
                st2 = cells2.get(k2)
                if st2 is None:
                    st2 = {"count": 0.0, "max_h": 0.0, "sr": 0.0, "sg": 0.0, "sb": 0.0}
                    cells2[k2] = st2
                st2["count"] += 1.0
                if h > st2["max_h"]:
                    st2["max_h"] = h
                st2["sr"] += float(r8) / 255.0
                st2["sg"] += float(g8) / 255.0
                st2["sb"] += float(b8) / 255.0
        processed += count

    # Build LOD0 chunks from accumulated cells.
    chunks0_meta: dict[str, Any] = {}
    built0 = 0

    # Group cells by lod0 chunk
    by_chunk: dict[tuple[int, int], list[tuple[int, int, dict[str, float]]]] = {}
    for (c0x, c0z, ix, iz), st in cells.items():
        by_chunk.setdefault((c0x, c0z), []).append((ix, iz, st))

    for (c0x, c0z), items in sorted(by_chunk.items(), key=lambda t: (t[0][0], t[0][1])):
        # Materialize instances (float form first for easier range calc)
        inst = []
        for ix, iz, st in items:
            cnt = float(st.get("count") or 0.0)
            if cnt <= 0:
                continue
            h = float(st.get("max_h") or 0.0)
            if not (math.isfinite(h) and h > 0):
                continue
            # Cell center in world meters
            chunk_min_x = float(c0x) * cs0
            chunk_min_z = float(c0z) * cs0
            tx = chunk_min_x + (float(ix) + 0.5) * cell_m
            tz = chunk_min_z + (float(iz) + 0.5) * cell_m
            sy = h
            ty = sy * 0.5
            sx = cell_m
            sz = cell_m
            yaw = 0.0
            # Color: average of source colors, slightly biased by height so skylines pop.
            r = float(st.get("sr") or 0.0) / cnt
            g = float(st.get("sg") or 0.0) / cnt
            b = float(st.get("sb") or 0.0) / cnt
            ht = min(1.0, max(0.0, (sy - 6.0) / 80.0))
            r = min(1.0, max(0.0, r + 0.10 * ht))
            g = min(1.0, max(0.0, g + 0.08 * ht))
            b = min(1.0, max(0.0, b + 0.05 * ht))
            inst.append((tx, ty, tz, sx, sy, sz, yaw, r, g, b, 1.0))
        if not inst:
            continue

        # Per-chunk ranges for quantization
        max_ty = 0.0
        max_sc = 0.0
        for (tx, ty, tz, sx, sy, sz, yaw, r, g, b, a) in inst:
            if math.isfinite(ty):
                max_ty = max(max_ty, ty)
            for s in (sx, sy, sz):
                if math.isfinite(s):
                    max_sc = max(max_sc, s)
        max_ty = float(max(1.0, min(1024.0, max_ty * 1.05)))
        max_sc = float(max(1.0, min(4096.0, max_sc * 1.05)))

        fname = f"b_{c0x}_{c0z}.bin"
        out_path = os.path.join(lod0_chunks_dir, fname)
        with open(out_path, "wb") as f:
            f.write(b"BUI2")
            f.write(struct.pack("<I", len(inst)))
            chunk_min_x = float(c0x) * cs0
            chunk_min_z = float(c0z) * cs0
            f.write(struct.pack("<fffff", chunk_min_x, chunk_min_z, float(cs0), max_ty, max_sc))
            inv_cs0 = 1.0 / float(cs0)
            inv_ty = 1.0 / max_ty
            inv_sc = 1.0 / max_sc
            for (tx, ty, tz, sx, sy, sz, yaw, r, g, b, a) in inst:
                tx01 = (tx - chunk_min_x) * inv_cs0
                tz01 = (tz - chunk_min_z) * inv_cs0
                ty01 = ty * inv_ty
                sx01 = sx * inv_sc
                sy01 = sy * inv_sc
                sz01 = sz * inv_sc
                f.write(REC_STRUCT.pack(
                    _q_u16(tx01),
                    _q_u16(ty01),
                    _q_u16(tz01),
                    _q_u16(sx01),
                    _q_u16(sy01),
                    _q_u16(sz01),
                    _q_i16_yaw(yaw),
                    _q_u8(r),
                    _q_u8(g),
                    _q_u8(b),
                    _q_u8(a),
                ))

        key0 = f"{c0x}_{c0z}"
        chunks0_meta[key0] = {"file": f"chunks/{fname}", "count": len(inst), "magic": "BUI2", "cellMeters": cell_m}
        built0 += len(inst)

    # Write LOD0 index
    idx0 = {
        "schema": "webglgta-dataset-tiles-v1",
        "kind": "instanced-box-buildings",
        "chunkSizeMeters": cs0,
        "originLonLat": idx1.get("originLonLat"),
        "sourceInputs": idx1.get("sourceInputs"),
        "lonLatBounds": idx1.get("lonLatBounds"),
        "chunks": chunks0_meta,
        "totalInstances": built0,
        "floatsPerInstance": 11,
        "chunkMagic": "BUI2",
        "encoding": "packed16",
        "lod": {"level": 0, "cellMeters": cell_m, "derivedFrom": os.path.abspath(lod1_dir)},
    }
    os.makedirs(lod0_dir, exist_ok=True)
    _write_json(os.path.join(lod0_dir, "index.json"), idx0)

    # Build LOD2 chunks (super-far) if enabled.
    chunks2_meta: dict[str, Any] = {}
    built2 = 0
    if wants_lod2 and cells2:
        by_chunk2: dict[tuple[int, int], list[tuple[int, int, dict[str, float]]]] = {}
        for (c2x, c2z, ix, iz), st in cells2.items():
            by_chunk2.setdefault((c2x, c2z), []).append((ix, iz, st))

        for (c2x, c2z), items in sorted(by_chunk2.items(), key=lambda t: (t[0][0], t[0][1])):
            inst = []
            for ix, iz, st in items:
                cnt = float(st.get("count") or 0.0)
                if cnt <= 0:
                    continue
                h = float(st.get("max_h") or 0.0)
                if not (math.isfinite(h) and h > 0):
                    continue
                chunk_min_x = float(c2x) * cs2
                chunk_min_z = float(c2z) * cs2
                tx = chunk_min_x + (float(ix) + 0.5) * cell2_m
                tz = chunk_min_z + (float(iz) + 0.5) * cell2_m
                sy = h
                ty = sy * 0.5
                sx = cell2_m
                sz = cell2_m
                yaw = 0.0
                r = float(st.get("sr") or 0.0) / cnt
                g = float(st.get("sg") or 0.0) / cnt
                b = float(st.get("sb") or 0.0) / cnt
                ht = min(1.0, max(0.0, (sy - 6.0) / 120.0))
                r = min(1.0, max(0.0, r + 0.08 * ht))
                g = min(1.0, max(0.0, g + 0.06 * ht))
                b = min(1.0, max(0.0, b + 0.04 * ht))
                inst.append((tx, ty, tz, sx, sy, sz, yaw, r, g, b, 1.0))
            if not inst:
                continue

            max_ty = 0.0
            max_sc = 0.0
            for (tx, ty, tz, sx, sy, sz, yaw, r, g, b, a) in inst:
                if math.isfinite(ty):
                    max_ty = max(max_ty, ty)
                for s in (sx, sy, sz):
                    if math.isfinite(s):
                        max_sc = max(max_sc, s)
            max_ty = float(max(1.0, min(2048.0, max_ty * 1.05)))
            max_sc = float(max(1.0, min(8192.0, max_sc * 1.05)))

            fname = f"b_{c2x}_{c2z}.bin"
            out_path = os.path.join(lod2_chunks_dir, fname)
            with open(out_path, "wb") as f:
                f.write(b"BUI2")
                f.write(struct.pack("<I", len(inst)))
                chunk_min_x = float(c2x) * cs2
                chunk_min_z = float(c2z) * cs2
                f.write(struct.pack("<fffff", chunk_min_x, chunk_min_z, float(cs2), max_ty, max_sc))
                inv_cs2 = 1.0 / float(cs2)
                inv_ty = 1.0 / max_ty
                inv_sc = 1.0 / max_sc
                for (tx, ty, tz, sx, sy, sz, yaw, r, g, b, a) in inst:
                    tx01 = (tx - chunk_min_x) * inv_cs2
                    tz01 = (tz - chunk_min_z) * inv_cs2
                    ty01 = ty * inv_ty
                    sx01 = sx * inv_sc
                    sy01 = sy * inv_sc
                    sz01 = sz * inv_sc
                    f.write(REC_STRUCT.pack(
                        _q_u16(tx01),
                        _q_u16(ty01),
                        _q_u16(tz01),
                        _q_u16(sx01),
                        _q_u16(sy01),
                        _q_u16(sz01),
                        _q_i16_yaw(yaw),
                        _q_u8(r),
                        _q_u8(g),
                        _q_u8(b),
                        _q_u8(a),
                    ))

            key2 = f"{c2x}_{c2z}"
            chunks2_meta[key2] = {"file": f"chunks/{fname}", "count": len(inst), "magic": "BUI2", "cellMeters": cell2_m}
            built2 += len(inst)

        idx2 = {
            "schema": "webglgta-dataset-tiles-v1",
            "kind": "instanced-box-buildings",
            "chunkSizeMeters": cs2,
            "originLonLat": idx1.get("originLonLat"),
            "sourceInputs": idx1.get("sourceInputs"),
            "lonLatBounds": idx1.get("lonLatBounds"),
            "chunks": chunks2_meta,
            "totalInstances": built2,
            "floatsPerInstance": 11,
            "chunkMagic": "BUI2",
            "encoding": "packed16",
            "lod": {"level": 2, "cellMeters": cell2_m, "derivedFrom": os.path.abspath(lod1_dir)},
        }
        os.makedirs(lod2_dir, exist_ok=True)
        _write_json(os.path.join(lod2_dir, "index.json"), idx2)

    # Multi-LOD index (for runtime convenience)
    multi = {
        "schema": "webglgta-buildings-multilod-v1",
        "originLonLat": idx1.get("originLonLat"),
        "lonLatBounds": idx1.get("lonLatBounds"),
        "lod0": {"label": "mid blocks", "indexUrl": "lod0/index.json"},
        "lod1": {"label": "buildings", "indexUrl": os.path.relpath(idx1_path, outdir).replace(os.sep, "/")},
        "recommended": {
            "lod1RadiusChunks": 6,
            "lod0RadiusChunks": 20,
            "lod0CellMeters": cell_m,
            "lod0ChunkSizeMeters": cs0,
            "lod2RadiusChunks": 60,
            "lod2CellMeters": cell2_m,
            "lod2ChunkSizeMeters": cs2,
        },
    }
    if wants_lod2 and chunks2_meta:
        multi["lod2"] = {"label": "super-far mass", "indexUrl": "lod2/index.json"}
    _write_json(os.path.join(outdir, "multilod_index.json"), multi)

    print("Wrote multi-LOD building tiles:")
    print(f"- outdir: {outdir}")
    print(f"- LOD1 (input): {lod1_dir}")
    print(f"- LOD0 chunks: {len(chunks0_meta)}")
    print(f"- LOD0 instances: {built0}")
    print(f"- cellMeters: {cell_m:.3f}")
    print(f"- processed LOD1 instances: {processed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))


