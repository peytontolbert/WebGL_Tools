from __future__ import annotations

import json
import math
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .geojson import fc, feature, linestring, point, polygon
from .heightmap_u16 import HeightmapU16, write_heightmap_u16
from .rng import Mulberry32, seed_to_u32
from .wgs84 import Origin, bbox_meters_to_wgs84, meters_to_lonlat


@dataclass(frozen=True)
class ProcCityConfig:
    dataset_id: str
    out_dir: Path
    seed: str
    origin_lon: float
    origin_lat: float
    size_m: float
    grid_n: int
    max_buildings: int
    max_trees: int
    max_props: int
    tile_buildings: bool
    tile_chunk_m: float


def _clamp(x: float, a: float, b: float) -> float:
    return a if x < a else (b if x > b else x)


def _fbm2(rand: Mulberry32, x: float, y: float, octaves: int = 5) -> float:
    """
    Tiny deterministic "noise-ish" function (not true Perlin),
    good enough for terrain variation without deps.
    """
    # Hash lattice values with sin/cos mixtures.
    amp = 0.5
    freq = 1.0
    s = 0.0
    nrm = 0.0
    for _ in range(max(1, int(octaves))):
        v = math.sin((x * 1.371 + y * 1.911) * freq + 0.7) * 0.5 + math.cos((x * 2.113 - y * 1.327) * freq - 1.2) * 0.5
        # tiny seed-dependent warp
        v += math.sin((x + y + (rand._a & 1023) * 0.01) * freq * 0.73) * 0.15
        s += v * amp
        nrm += amp
        amp *= 0.55
        freq *= 2.02
    if nrm <= 1e-9:
        return 0.0
    return s / nrm


def _meters_bounds(cfg: ProcCityConfig) -> tuple[float, float, float, float]:
    half = float(cfg.size_m) * 0.5
    return (-half, -half, half, half)  # minX, minZ, maxX, maxZ


def _grid_to_world(cfg: ProcCityConfig, ix: int, iz: int) -> tuple[float, float]:
    n = int(cfg.grid_n)
    min_x, min_z, max_x, max_z = _meters_bounds(cfg)
    u = 0.0 if n <= 1 else (ix / (n - 1))
    v = 0.0 if n <= 1 else (iz / (n - 1))
    x = min_x + u * (max_x - min_x)
    z = min_z + v * (max_z - min_z)
    return x, z


def _world_to_grid(cfg: ProcCityConfig, x: float, z: float) -> tuple[int, int]:
    n = int(cfg.grid_n)
    min_x, min_z, max_x, max_z = _meters_bounds(cfg)
    u = (x - min_x) / max(1e-6, (max_x - min_x))
    v = (z - min_z) / max(1e-6, (max_z - min_z))
    ix = int(round(_clamp(u, 0.0, 1.0) * (n - 1)))
    iz = int(round(_clamp(v, 0.0, 1.0) * (n - 1)))
    return ix, iz


def _gen_heightmap(cfg: ProcCityConfig, rand: Mulberry32) -> tuple[HeightmapU16, dict]:
    n = int(cfg.grid_n)
    min_x, min_z, max_x, max_z = _meters_bounds(cfg)
    origin = Origin(cfg.origin_lon, cfg.origin_lat)
    bbox = bbox_meters_to_wgs84(min_x, min_z, max_x, max_z, origin)

    heights = [0] * (n * n)

    # Production-friendly: mostly-flat terrain for a playable city.
    # Keep subtle variation + gentle edge falloff to avoid looking like a perfect plane.
    for iz in range(n):
        for ix in range(n):
            x, z = _grid_to_world(cfg, ix, iz)
            u = (x / (cfg.size_m * 0.5))
            v = (z / (cfg.size_m * 0.5))
            r = math.sqrt(u * u + v * v)
            edge = _clamp((r - 0.65) / 0.45, 0.0, 1.0)  # 0 in core, 1 at edges
            n0 = _fbm2(rand, u * 0.75, v * 0.75, octaves=5)
            # Base near-flat with tiny noise; edges slightly higher (hills around city).
            h01 = 0.10 + n0 * 0.03 + edge * 0.10
            h01 = _clamp(h01, 0.0, 1.0)
            heights[iz * n + ix] = int(round(h01 * 65535))

    hm = HeightmapU16(width=n, height=n, heights_u16=heights)
    return hm, bbox


def _sorted_unique(xs: list[float], eps: float = 1e-6) -> list[float]:
    out: list[float] = []
    for x in sorted(xs):
        if not out or abs(x - out[-1]) > eps:
            out.append(x)
    return out


def _road_positions_1d(min_v: float, max_v: float, step: float, jitter_abs: float, rand: Mulberry32) -> list[float]:
    """Centerlines in [min_v..max_v]."""
    if step <= 1e-6:
        return [0.0]
    v = min_v + step * 0.5
    out = []
    while v <= max_v - step * 0.5 + 1e-6:
        out.append(v + rand.uniform(-jitter_abs, jitter_abs))
        v += step
    return _sorted_unique(out)


def _polyline_wgs84_from_meters(points_xz: list[tuple[float, float]], origin: Origin) -> list[list[float]]:
    return [[meters_to_lonlat(x, z, origin)[0], meters_to_lonlat(x, z, origin)[1]] for (x, z) in points_xz]


def _gen_roads(cfg: ProcCityConfig, rand: Mulberry32) -> tuple[list[dict], dict]:
    """
    Generate a coherent road network + return metadata used by block/lot generation.
    Output is GeoJSON WGS84 LineStrings with OSM-ish `highway` tags.
    """
    origin = Origin(cfg.origin_lon, cfg.origin_lat)
    min_x, min_z, max_x, max_z = _meters_bounds(cfg)
    span = float(cfg.size_m)

    major_step = 240.0
    minor_step = 120.0
    major_j = 10.0
    minor_j = 6.0

    # Primary grid: these define blocks.
    xs_major = _road_positions_1d(min_x, max_x, major_step, major_j, rand)
    zs_major = _road_positions_1d(min_z, max_z, major_step, major_j, rand)

    feats: list[dict] = []

    # Major roads (primary/secondary, with a denser center).
    for xi, x in enumerate(xs_major):
        hw = "primary" if (xi % 2 == 0) else "secondary"
        coords = _polyline_wgs84_from_meters([(x, min_z), (x, max_z)], origin)
        feats.append(feature(linestring(coords), {"highway": hw, "name": f"Ave {xi+1}"}))

    for zi, z in enumerate(zs_major):
        hw = "primary" if (zi % 2 == 0) else "secondary"
        coords = _polyline_wgs84_from_meters([(min_x, z), (max_x, z)], origin)
        feats.append(feature(linestring(coords), {"highway": hw, "name": f"St {zi+1}"}))

    # Minor streets inside the inner city.
    inner = span * 0.42
    xs_minor = _road_positions_1d(-inner, inner, minor_step, minor_j, rand)
    zs_minor = _road_positions_1d(-inner, inner, minor_step, minor_j, rand)

    for x in xs_minor:
        coords = _polyline_wgs84_from_meters([(x, -inner), (x, inner)], origin)
        feats.append(feature(linestring(coords), {"highway": "residential"}))
    for z in zs_minor:
        coords = _polyline_wgs84_from_meters([(-inner, z), (inner, z)], origin)
        feats.append(feature(linestring(coords), {"highway": "residential"}))

    # Highway ring (motorway): approximate a rounded rectangle / loop.
    ring_r = span * 0.46
    ring = []
    segs = 28
    for i in range(segs + 1):
        t = (i / segs) * math.tau
        # Squircle-ish
        cx = math.cos(t)
        cz = math.sin(t)
        x = math.copysign(abs(cx) ** 0.6, cx) * ring_r
        z = math.copysign(abs(cz) ** 0.6, cz) * ring_r
        ring.append((x, z))
    feats.append(feature(linestring(_polyline_wgs84_from_meters(ring, origin)), {"highway": "motorway", "ref": "I-1"}))

    meta = {
        "xs_major": xs_major,
        "zs_major": zs_major,
        "inner": inner,
        "major_step": major_step,
        "minor_step": minor_step,
    }
    return feats, meta


def _gen_buildings(cfg: ProcCityConfig, rand: Mulberry32) -> list[dict]:
    raise RuntimeError("_gen_buildings now requires road/block metadata; call _gen_buildings_from_blocks().")


def _rect_poly_wgs84(x0: float, z0: float, x1: float, z1: float, origin: Origin) -> list[list[float]]:
    return [
        [*meters_to_lonlat(x0, z0, origin)],
        [*meters_to_lonlat(x1, z0, origin)],
        [*meters_to_lonlat(x1, z1, origin)],
        [*meters_to_lonlat(x0, z1, origin)],
    ]


def _zone_for_block(cx: float, cz: float, span: float, rand: Mulberry32) -> str:
    d = math.hypot(cx, cz)
    t = _clamp(d / max(1.0, span * 0.5), 0.0, 1.0)
    if t < 0.20:
        return "downtown"
    if t < 0.40:
        return "commercial" if rand.rand01() < 0.45 else "mixed"
    if t < 0.70:
        return "residential"
    return "industrial" if rand.rand01() < 0.30 else "residential"


def _gen_buildings_from_blocks(cfg: ProcCityConfig, rand: Mulberry32, road_meta: dict) -> tuple[list[dict], list[tuple[float, float, str]]]:
    """
    Block-based city: major road grid defines blocks; generate lots and street-facing buildings.
    Returns (buildingFeatures, poiCandidatesMeters).
    """
    origin = Origin(cfg.origin_lon, cfg.origin_lat)
    min_x, min_z, max_x, max_z = _meters_bounds(cfg)
    span = float(cfg.size_m)
    xs = list(road_meta.get("xs_major") or [])
    zs = list(road_meta.get("zs_major") or [])
    xs = _sorted_unique([min_x] + xs + [max_x])
    zs = _sorted_unique([min_z] + zs + [max_z])

    feats: list[dict] = []
    poi: list[tuple[float, float, str]] = []  # x,z,kind for later prop/service placement

    # Approx road half-width + sidewalks.
    # (Road rendering is independent; this is just for setback.)
    setback_primary = 10.0 * 0.5 + 7.0
    setback_res = 6.5 * 0.5 + 6.0

    placed = 0
    for zi in range(len(zs) - 1):
        for xi in range(len(xs) - 1):
            if placed >= cfg.max_buildings:
                break
            bx0, bx1 = xs[xi], xs[xi + 1]
            bz0, bz1 = zs[zi], zs[zi + 1]
            bw = bx1 - bx0
            bh = bz1 - bz0
            if bw < 120 or bh < 120:
                continue

            cx = (bx0 + bx1) * 0.5
            cz = (bz0 + bz1) * 0.5
            zone = _zone_for_block(cx, cz, span, rand)

            # Parks: occasionally leave a block empty for trees.
            if zone == "residential" and rand.rand01() < 0.10:
                poi.append((cx, cz, "park"))
                continue

            # Inner buildable area.
            setback = setback_primary if zone in ("downtown", "commercial", "mixed", "industrial") else setback_res
            ix0 = bx0 + setback
            ix1 = bx1 - setback
            iz0 = bz0 + setback
            iz1 = bz1 - setback
            if ix1 - ix0 < 40 or iz1 - iz0 < 40:
                continue

            # Zoning parameters.
            if zone == "downtown":
                lot_depth = 42.0
                lot_w_min, lot_w_max = 18.0, 42.0
                lv_min, lv_max = 8, 28
                btag = "commercial"
            elif zone in ("commercial", "mixed"):
                lot_depth = 34.0
                lot_w_min, lot_w_max = 14.0, 30.0
                lv_min, lv_max = 3, 12
                btag = "commercial" if zone == "commercial" else "apartments"
            elif zone == "industrial":
                lot_depth = 46.0
                lot_w_min, lot_w_max = 22.0, 60.0
                lv_min, lv_max = 1, 5
                btag = "industrial"
            else:
                lot_depth = 26.0
                lot_w_min, lot_w_max = 10.0, 20.0
                lv_min, lv_max = 1, 4
                btag = "residential"

            # Place buildings along the 4 edges (street-facing rows).
            margin = 3.0
            depth = max(10.0, lot_depth - margin * 2)

            def add_strip_along_x(z_edge: float, outward: int) -> None:
                nonlocal placed
                x = ix0
                while x < ix1 - 6 and placed < cfg.max_buildings:
                    w = _clamp(rand.uniform(lot_w_min, lot_w_max), 8.0, 80.0)
                    if x + w > ix1:
                        w = ix1 - x
                    if w < 8.0:
                        break
                    # footprint depth inward from edge
                    if outward > 0:
                        z0 = z_edge + margin
                        z1 = z_edge + margin + depth
                    else:
                        z1 = z_edge - margin
                        z0 = z_edge - margin - depth
                    x0 = x + margin
                    x1 = x + w - margin
                    if x1 - x0 >= 6 and abs(z1 - z0) >= 6:
                        levels = int(_clamp(rand.uniform(lv_min, lv_max + 0.99), lv_min, lv_max))
                        height_m = levels * 3.1
                        props = {"building": btag, "building:levels": str(levels), "height": f"{height_m:.1f}"}
                        feats.append(feature(polygon(_rect_poly_wgs84(x0, z0, x1, z1, origin)), props))
                        placed += 1
                    x += w

            def add_strip_along_z(x_edge: float, outward: int) -> None:
                nonlocal placed
                z = iz0
                while z < iz1 - 6 and placed < cfg.max_buildings:
                    w = _clamp(rand.uniform(lot_w_min, lot_w_max), 8.0, 80.0)
                    if z + w > iz1:
                        w = iz1 - z
                    if w < 8.0:
                        break
                    if outward > 0:
                        x0 = x_edge + margin
                        x1 = x_edge + margin + depth
                    else:
                        x1 = x_edge - margin
                        x0 = x_edge - margin - depth
                    z0 = z + margin
                    z1 = z + w - margin
                    if z1 - z0 >= 6 and abs(x1 - x0) >= 6:
                        levels = int(_clamp(rand.uniform(lv_min, lv_max + 0.99), lv_min, lv_max))
                        height_m = levels * 3.1
                        props = {"building": btag, "building:levels": str(levels), "height": f"{height_m:.1f}"}
                        feats.append(feature(polygon(_rect_poly_wgs84(x0, z0, x1, z1, origin)), props))
                        placed += 1
                    z += w

            # Top edge (north, z increasing): street at bz1, build inward (negative)
            add_strip_along_x(iz1, outward=-1)
            # Bottom edge (south)
            add_strip_along_x(iz0, outward=+1)
            # Right edge (east)
            add_strip_along_z(ix1, outward=-1)
            # Left edge (west)
            add_strip_along_z(ix0, outward=+1)

            # POI candidates: place services in/near commercial/downtown blocks.
            if zone in ("downtown", "commercial") and rand.rand01() < 0.18:
                poi.append((cx, cz, "poi"))
            if zone == "residential" and rand.rand01() < 0.08:
                poi.append((cx, cz, "school"))
            if zone in ("downtown", "mixed") and rand.rand01() < 0.04:
                poi.append((cx, cz, "hospital"))

        if placed >= cfg.max_buildings:
            break

    return feats, poi


def _gen_trees(cfg: ProcCityConfig, rand: Mulberry32, poi: list[tuple[float, float, str]]) -> list[dict]:
    origin = Origin(cfg.origin_lon, cfg.origin_lat)
    min_x, min_z, max_x, max_z = _meters_bounds(cfg)

    feats = []
    placed = 0

    # Parks: dense clusters.
    for (cx, cz, kind) in poi:
        if placed >= cfg.max_trees:
            break
        if kind != "park":
            continue
        for _ in range(900):
            if placed >= cfg.max_trees:
                break
            x = cx + rand.uniform(-55, 55)
            z = cz + rand.uniform(-55, 55)
            lon, lat = meters_to_lonlat(x, z, origin)
            feats.append(feature(point(lon, lat), {"natural": "tree"}))
            placed += 1

    # Background trees: bias to edges.
    while placed < cfg.max_trees:
        x = rand.uniform(min_x, max_x)
        z = rand.uniform(min_z, max_z)
        d = math.hypot(x, z)
        t = _clamp(d / (cfg.size_m * 0.5), 0.0, 1.0)
        if rand.rand01() < (t * t * 0.55):
            lon, lat = meters_to_lonlat(x, z, origin)
            feats.append(feature(point(lon, lat), {"natural": "tree"}))
            placed += 1
    return feats


def _gen_props(cfg: ProcCityConfig, rand: Mulberry32, road_meta: dict, poi: list[tuple[float, float, str]]) -> list[dict]:
    origin = Origin(cfg.origin_lon, cfg.origin_lat)
    min_x, min_z, max_x, max_z = _meters_bounds(cfg)
    feats = []

    placed = 0

    # 1) Intersections of major roads: traffic signals + crossings (readability/gameplay).
    xs = list(road_meta.get("xs_major") or [])
    zs = list(road_meta.get("zs_major") or [])
    for x in xs:
        for z in zs:
            if placed >= cfg.max_props:
                break
            # Skip far edges to reduce clutter
            if abs(x) > cfg.size_m * 0.46 or abs(z) > cfg.size_m * 0.46:
                continue
            lon, lat = meters_to_lonlat(x, z, origin)
            feats.append(feature(point(lon, lat), {"highway": "traffic_signals"}))
            placed += 1
            if placed >= cfg.max_props:
                break

    # 2) Street lamps along major roads: evenly spaced, deterministic.
    lamp_spacing = 55.0
    inner = float(road_meta.get("inner") or (cfg.size_m * 0.42))
    for x in xs:
        if placed >= cfg.max_props:
            break
        z = -inner
        while z <= inner and placed < cfg.max_props:
            if rand.rand01() < 0.70:
                lon, lat = meters_to_lonlat(x + rand.uniform(-3, 3), z + rand.uniform(-3, 3), origin)
                feats.append(feature(point(lon, lat), {"highway": "street_lamp"}))
                placed += 1
            z += lamp_spacing
    for z in zs:
        if placed >= cfg.max_props:
            break
        x = -inner
        while x <= inner and placed < cfg.max_props:
            if rand.rand01() < 0.70:
                lon, lat = meters_to_lonlat(x + rand.uniform(-3, 3), z + rand.uniform(-3, 3), origin)
                feats.append(feature(point(lon, lat), {"highway": "street_lamp"}))
                placed += 1
            x += lamp_spacing

    # 3) Services/POIs derived from blocks (fuel, schools, hospitals).
    for (x, z, kind) in poi:
        if placed >= cfg.max_props:
            break
        if kind == "poi":
            lon, lat = meters_to_lonlat(x, z, origin)
            feats.append(feature(point(lon, lat), {"amenity": "cafe"}))
            placed += 1
            continue
        if kind == "school":
            lon, lat = meters_to_lonlat(x, z, origin)
            feats.append(feature(point(lon, lat), {"amenity": "school"}))
            placed += 1
            continue
        if kind == "hospital":
            lon, lat = meters_to_lonlat(x, z, origin)
            feats.append(feature(point(lon, lat), {"amenity": "hospital"}))
            placed += 1
            continue
        if kind == "park":
            lon, lat = meters_to_lonlat(x, z, origin)
            feats.append(feature(point(lon, lat), {"leisure": "park"}))
            placed += 1
            continue

    # 4) A few fuel stations near the highway ring.
    for _ in range(10):
        if placed >= cfg.max_props:
            break
        t = rand.rand01() * math.tau
        r = cfg.size_m * 0.42
        x = math.cos(t) * r
        z = math.sin(t) * r
        lon, lat = meters_to_lonlat(x, z, origin)
        feats.append(feature(point(lon, lat), {"amenity": "fuel"}))
        placed += 1

    return feats


def _write_geojson(path: Path, features: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(fc(features), indent=2) + "\n", encoding="utf-8")


def _run_tool(args: list[str]) -> None:
    p = subprocess.run(args, check=False, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"Command failed ({p.returncode}): {' '.join(args)}\n{p.stdout}")


def _maybe_tile_buildings(cfg: ProcCityConfig, buildings_geojson: Path) -> None:
    """
    Uses existing repo tilers to produce instanced building tiles + multi-LOD index.
    Outputs into:
      <out_dir>/tiles/lod1/
      <out_dir>/tiles/multilod/
    """
    repo_root = Path(__file__).resolve().parents[2]
    tile1 = cfg.out_dir / "tiles" / "lod1"
    multi = cfg.out_dir / "tiles" / "multilod"
    tile1.mkdir(parents=True, exist_ok=True)
    multi.mkdir(parents=True, exist_ok=True)

    _run_tool(
        [
            "python3",
            str(repo_root / "tools" / "tile_instanced_buildings.py"),
            "--in",
            str(buildings_geojson),
            "--outdir",
            str(tile1),
            "--chunk-size-m",
            str(float(cfg.tile_chunk_m)),
            "--format",
            "packed16",
            "--overwrite",
        ]
    )
    _run_tool(
        [
            "python3",
            str(repo_root / "tools" / "build_lod0_from_bui2_tiles.py"),
            "--lod1",
            str(tile1),
            "--outdir",
            str(multi),
            "--lod0-mult",
            "4",
            "--cell-m",
            "64",
            "--lod2-mult",
            "16",
            "--lod2-cell-m",
            "256",
            "--overwrite",
        ]
    )


def generate_proc_city_dataset(cfg: ProcCityConfig) -> None:
    out = Path(cfg.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    rand = Mulberry32(seed_to_u32(cfg.seed))

    hm, bbox = _gen_heightmap(cfg, rand)
    heightmap_dir = out / "heightmap"
    write_heightmap_u16(
        heightmap_dir,
        hm,
        endian="little",
        min_z=0.0,
        max_z=22.0,
        bbox=bbox,
    )

    roads, road_meta = _gen_roads(cfg, rand)
    buildings, poi = _gen_buildings_from_blocks(cfg, rand, road_meta)
    trees = _gen_trees(cfg, rand, poi)
    props = _gen_props(cfg, rand, road_meta, poi)

    roads_path = out / "roads.geojson"
    buildings_path = out / "buildings.geojson"
    trees_path = out / "trees.geojson"
    props_path = out / "props.geojson"
    _write_geojson(roads_path, roads)
    _write_geojson(buildings_path, buildings)
    _write_geojson(trees_path, trees)
    _write_geojson(props_path, props)

    if cfg.tile_buildings:
        _maybe_tile_buildings(cfg, buildings_path)

