#!/usr/bin/env python3
"""
Extract a small bbox from Overture Maps GeoParquet/Parquet into viewer-friendly GeoJSON.

Goal:
- Keep outputs small (bbox + optional limit)
- Produce GeoJSON that matches this viewer's expectations:
  - buildings: Polygon/MultiPolygon with properties containing `building` and optional `height` / `building:levels`
  - (future) roads: LineString/MultiLineString with `highway` etc.

Dependencies:
- Python package: duckdb (CLI not required)
  pip install duckdb

Notes:
- DuckDB extensions `spatial` and `httpfs` are installed/loaded at runtime.
- For public S3 releases, DuckDB can read `s3://...` paths via httpfs without AWS creds.

Example (buildings, public S3; no API keys):
  python tools/overture_extract_geojson.py \
    --release 2025-12-17.0 \
    --theme buildings \
    --type building \
    --bbox -76.40,36.75,-76.10,36.95 \
    --outdir assets/datasets/overture_bbox \
    --prefix overture_bbox \
    --max-features 20000
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any


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
    return min_lon, min_lat, max_lon, max_lat


def _sql_str(s: str) -> str:
    # Basic SQL string escaping for DuckDB.
    return "'" + str(s).replace("'", "''") + "'"


def _pick_first(cols: set[str], candidates: list[str]) -> str | None:
    for c in candidates:
        if c in cols:
            return c
    return None


def _to_float(v: Any) -> float | None:
    if v is None:
        return None
    try:
        n = float(v)
    except Exception:
        return None
    if not (n == n):  # NaN
        return None
    return n


def _to_int(v: Any) -> int | None:
    if v is None:
        return None
    try:
        n = int(float(v))
    except Exception:
        return None
    return n


def _ensure_duckdb():
    try:
        import duckdb  # type: ignore
    except Exception as e:
        print(
            "Missing dependency: duckdb.\n"
            "Install with:\n"
            "  pip install duckdb\n"
            f"Error: {e}",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return duckdb


def _enable_duckdb_extensions(con, parquet_path: str) -> None:
    # Spatial functions for ST_* + WKB->geom + GeoJSON output.
    con.execute("INSTALL spatial;")
    con.execute("LOAD spatial;")

    # For reading https:// and s3:// URLs.
    con.execute("INSTALL httpfs;")
    con.execute("LOAD httpfs;")

    # Public S3 bucket reads usually need region set (no creds required).
    if str(parquet_path).startswith("s3://"):
        # Best-effort defaults for Overture public buckets.
        con.execute("SET s3_region='us-west-2';")
        con.execute("SET s3_use_ssl=true;")


def _infer_overture_s3_glob(*, release: str, theme: str, type_: str) -> str:
    r = (release or "").strip()
    t = (theme or "").strip()
    ty = (type_ or "").strip()
    if not r or not t or not ty:
        raise ValueError("release/theme/type must be non-empty")
    # Overture public S3 layout (docs):
    # s3://overturemaps-us-west-2/release/<RELEASE>/theme=<THEME>/type=<TYPE>/...
    return f"s3://overturemaps-us-west-2/release/{r}/theme={t}/type={ty}/*"


def _read_parquet_expr(parquet_path: str, *, hive_partitioning: bool) -> str:
    # DuckDB read_parquet options help when using hive-style partition paths.
    if hive_partitioning:
        return f"read_parquet({_sql_str(parquet_path)}, filename=true, hive_partitioning=1)"
    return f"read_parquet({_sql_str(parquet_path)})"


def _describe_columns(con, parquet_path: str) -> list[tuple[str, str]]:
    q = f"DESCRIBE SELECT * FROM read_parquet({_sql_str(parquet_path)})"
    rows = con.execute(q).fetchall()
    # Rows: (column_name, column_type, null, key, default, extra) depending on DuckDB version
    out: list[tuple[str, str]] = []
    for r in rows:
        if not r:
            continue
        name = str(r[0])
        ctype = str(r[1]) if len(r) > 1 else ""
        out.append((name, ctype))
    return out


def _auto_geom_expr(con, parquet_path: str, geom_col: str) -> str:
    # Return a SQL expression that yields a DuckDB GEOMETRY.
    t = con.execute(
        f"SELECT typeof({geom_col}) FROM read_parquet({_sql_str(parquet_path)}) LIMIT 1"
    ).fetchone()[0]
    t = str(t or "")

    # Common Overture patterns:
    # - geometry: BLOB (WKB)
    # - geometry: STRUCT(wkb BLOB, ...) (WKB stored in field)
    if t == "GEOMETRY":
        return geom_col
    if t == "BLOB":
        return f"ST_GeomFromWKB({geom_col})"
    if t.startswith("STRUCT") and ("wkb" in t.lower()):
        return f"ST_GeomFromWKB({geom_col}.wkb)"

    # Fallbacks (less common):
    if t == "VARCHAR":
        # Could be WKT or a GeoJSON string depending on upstream export.
        # Try WKT first; if it fails, the user can override via --geom-col by pre-flattening,
        # or adjust their parquet path/export.
        return f"ST_GeomFromText({geom_col})"
    if "JSON" in t.upper():
        return f"ST_GeomFromGeoJSON({geom_col})"

    raise RuntimeError(f"Unsupported geometry column type for {geom_col}: {t}")


def _bbox_filter_sql(
    col_names: set[str],
    *,
    geom_expr: str,
    min_lon: float,
    min_lat: float,
    max_lon: float,
    max_lat: float,
    prefer_fast: bool,
) -> str:
    """
    Build a WHERE clause.

    Prefer using bbox struct fields if present (fast, avoids ST_Intersects),
    otherwise fall back to ST_Intersects on the geometry.
    """
    # Overture commonly has a bbox struct with xmin/ymin/xmax/ymax.
    if prefer_fast and "bbox" in col_names:
        # Conservative intersection test between feature bbox and query bbox:
        # feature_bbox intersects query_bbox iff:
        #   xmin <= qmaxLon AND xmax >= qminLon AND ymin <= qmaxLat AND ymax >= qminLat
        return (
            "WHERE "
            f"(bbox.xmin <= {max_lon}) AND (bbox.xmax >= {min_lon}) AND "
            f"(bbox.ymin <= {max_lat}) AND (bbox.ymax >= {min_lat})"
        )

    env = f"ST_MakeEnvelope({min_lon},{min_lat},{max_lon},{max_lat})"
    return f"WHERE ST_Intersects({geom_expr}, {env})"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in-parquet", default="", help="Input Parquet/GeoParquet path or glob (local/https/s3).")
    ap.add_argument("--release", default="", help="Overture release (e.g. 2025-12-17.0).")
    ap.add_argument("--theme", default="buildings", help="Overture theme (default: buildings).")
    ap.add_argument("--type", dest="type_", default="building", help="Overture type within theme (default: building).")
    ap.add_argument("--hive-partitioning", action="store_true", help="Enable DuckDB hive_partitioning=1 when reading parquet globs.")
    ap.add_argument("--no-progress", action="store_true", help="Disable DuckDB progress output.")
    ap.add_argument("--no-fast-bbox", action="store_true", help="Disable fast bbox filtering (use ST_Intersects).")
    ap.add_argument("--bbox", default="", help="Optional bbox 'minLon,minLat,maxLon,maxLat' (WGS84).")
    ap.add_argument("--outdir", required=True, help="Output directory (under repo assets/ recommended).")
    ap.add_argument("--prefix", default="overture", help="Output filename prefix.")
    ap.add_argument("--max-features", type=int, default=20000, help="Max exported buildings (safety cap).")
    ap.add_argument("--geom-col", default="", help="Override geometry column name (default: auto-detect).")
    ap.add_argument("--id-col", default="", help="Override id column name (default: auto-detect).")
    args = ap.parse_args(argv)

    in_parquet = (args.in_parquet or "").strip()
    if not in_parquet:
        try:
            in_parquet = _infer_overture_s3_glob(release=args.release, theme=args.theme, type_=args.type_)
        except Exception as e:
            print(
                "Missing --in-parquet and could not infer from --release/--theme/--type.\n"
                f"Error: {e}",
                file=sys.stderr,
            )
            return 2

    duckdb = _ensure_duckdb()
    con = duckdb.connect(database=":memory:")
    if not args.no_progress:
        # Best-effort. Different DuckDB versions vary; errors are non-fatal.
        try:
            con.execute("PRAGMA enable_progress_bar=true;")
        except Exception:
            pass
    _enable_duckdb_extensions(con, in_parquet)

    cols = _describe_columns(con, in_parquet)
    col_names = {c[0] for c in cols}

    geom_col = (args.geom_col or "").strip() or _pick_first(col_names, ["geometry", "geom", "wkb_geometry"])
    if not geom_col:
        print(f"Could not find geometry column in parquet. Columns: {sorted(col_names)[:50]}", file=sys.stderr)
        return 2

    try:
        geom_expr = _auto_geom_expr(con, in_parquet, geom_col)
    except Exception as e:
        print(f"Failed to detect geometry expression: {e}", file=sys.stderr)
        return 2

    id_col = (args.id_col or "").strip() or _pick_first(col_names, ["id", "feature_id", "overture_id", "gid"])
    height_col = _pick_first(col_names, ["height", "height_m", "height_meters", "est_height"])
    levels_col = _pick_first(col_names, ["num_floors", "levels", "building_levels", "level_count"])
    name_col = _pick_first(col_names, ["name", "primary_name"])

    # BBox filter (optional)
    where = ""
    if args.bbox.strip():
        try:
            min_lon, min_lat, max_lon, max_lat = _parse_bbox(args.bbox)
        except Exception as e:
            print(f"Invalid --bbox: {e}", file=sys.stderr)
            return 2
        where = _bbox_filter_sql(
            col_names,
            geom_expr=geom_expr,
            min_lon=min_lon,
            min_lat=min_lat,
            max_lon=max_lon,
            max_lat=max_lat,
            prefer_fast=not bool(args.no_fast_bbox),
        )

    # Build select list (only what's needed).
    select_parts = [
        f"ST_AsGeoJSON({geom_expr}) AS __geom_json",
    ]
    if id_col:
        select_parts.append(f"{id_col} AS __id")
    else:
        select_parts.append("NULL AS __id")
    if height_col:
        select_parts.append(f"{height_col} AS __height")
    else:
        select_parts.append("NULL AS __height")
    if levels_col:
        select_parts.append(f"{levels_col} AS __levels")
    else:
        select_parts.append("NULL AS __levels")
    if name_col:
        select_parts.append(f"{name_col} AS __name")
    else:
        select_parts.append("NULL AS __name")

    limit = max(0, int(args.max_features))
    from_expr = _read_parquet_expr(in_parquet, hive_partitioning=bool(args.hive_partitioning))
    q = (
        "SELECT " + ", ".join(select_parts) +
        f" FROM {from_expr} " +
        f"{where} " +
        f"LIMIT {limit}"
    )

    try:
        print("Running DuckDB query (this can take a while on first run / remote S3)...")
        rows = con.execute(q).fetchall()
    except Exception as e:
        print("DuckDB query failed.", file=sys.stderr)
        print(f"Query:\n{q}", file=sys.stderr)
        print(f"Error: {e}", file=sys.stderr)
        return 3

    features = []
    for (geom_json, _id, _height, _levels, _name) in rows:
        if not geom_json:
            continue
        try:
            geom = json.loads(geom_json)
        except Exception:
            # Keep going; skip bad feature.
            continue

        props: dict[str, Any] = {
            "source": "overture",
            "building": "yes",
        }
        if _id is not None:
            props["overture:id"] = str(_id)
        if _name is not None and str(_name).strip():
            props["name"] = str(_name).strip()

        h = _to_float(_height)
        lv = _to_int(_levels)
        if h is not None and h > 0:
            props["height"] = h
        elif lv is not None and lv > 0:
            props["building:levels"] = lv

        features.append({"type": "Feature", "geometry": geom, "properties": props})

    os.makedirs(args.outdir, exist_ok=True)
    prefix = args.prefix.strip() or "overture"
    out_path = os.path.join(args.outdir, f"{prefix}_buildings.geojson")
    fc = {"type": "FeatureCollection", "features": features}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(fc, f)

    print("Wrote:")
    print(f"- {out_path}")
    print(f"Features: {len(features)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))


