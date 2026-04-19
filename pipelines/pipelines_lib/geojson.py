from __future__ import annotations


def feature(geom: dict, props: dict | None = None) -> dict:
    return {"type": "Feature", "geometry": geom, "properties": props or {}}


def point(lon: float, lat: float) -> dict:
    return {"type": "Point", "coordinates": [float(lon), float(lat)]}


def linestring(coords: list[list[float]]) -> dict:
    return {"type": "LineString", "coordinates": [[float(a), float(b)] for a, b in coords]}


def polygon(ring: list[list[float]]) -> dict:
    # GeoJSON polygons require a list of rings; we provide one exterior ring.
    if ring and (ring[0][0] != ring[-1][0] or ring[0][1] != ring[-1][1]):
        ring = ring + [ring[0]]
    return {"type": "Polygon", "coordinates": [[[float(a), float(b)] for a, b in ring]]}


def fc(features: list[dict]) -> dict:
    return {"type": "FeatureCollection", "features": features}

