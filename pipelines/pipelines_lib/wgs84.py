from __future__ import annotations

import math
from dataclasses import dataclass


R_EARTH_M = 6378137.0


@dataclass(frozen=True)
class Origin:
    lon: float
    lat: float


def meters_to_lonlat(x_m: float, z_m: float, origin: Origin) -> tuple[float, float]:
    """
    Inverse of the runtime's equirectangular projection:
      x = (lon-lon0)*cos(lat0)*R
      y = (lat-lat0)*R
    Runtime uses returned (x,y) as (x,z).
    """
    phi0 = math.radians(origin.lat)
    dlon = (float(x_m) / (math.cos(phi0) * R_EARTH_M)) if abs(math.cos(phi0)) > 1e-12 else 0.0
    dlat = float(z_m) / R_EARTH_M
    lon = origin.lon + math.degrees(dlon)
    lat = origin.lat + math.degrees(dlat)
    return lon, lat


def bbox_meters_to_wgs84(min_x: float, min_z: float, max_x: float, max_z: float, origin: Origin) -> dict:
    lon0, lat0 = meters_to_lonlat(min_x, min_z, origin)
    lon1, lat1 = meters_to_lonlat(max_x, max_z, origin)
    return {
        "minLon": min(lon0, lon1),
        "minLat": min(lat0, lat1),
        "maxLon": max(lon0, lon1),
        "maxLat": max(lat0, lat1),
    }

