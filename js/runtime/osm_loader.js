function clamp(n, a, b) {
  const x = Number(n);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

async function fetchJsonMaybeGzip(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  const u = String(url || '').toLowerCase();
  if (u.endsWith('.gz')) {
    if (!resp.body) throw new Error(`Failed to stream ${url}`);
    if (typeof DecompressionStream === 'undefined') {
      throw new Error(`DecompressionStream not available; cannot read ${url}. Use .geojson instead of .geojson.gz.`);
    }
    const ds = new DecompressionStream('gzip');
    const decompressed = resp.body.pipeThrough(ds);
    const text = await new Response(decompressed).text();
    return JSON.parse(text);
  }
  return await resp.json();
}

function toRad(deg) {
  return (Number(deg) || 0) * Math.PI / 180;
}

// Equirectangular projection around a chosen origin (good enough for city-scale).
function projectLonLatMeters(lon, lat, originLon, originLat) {
  const R = 6378137.0;
  const lam = toRad(lon);
  const phi = toRad(lat);
  const lam0 = toRad(originLon);
  const phi0 = toRad(originLat);
  const x = (lam - lam0) * Math.cos(phi0) * R;
  const y = (phi - phi0) * R;
  return [x, y];
}

function extractLineStrings(geojson) {
  const out = [];
  const feats = geojson?.features;
  if (!Array.isArray(feats)) return out;
  for (const f of feats) {
    const g = f?.geometry;
    if (!g) continue;
    const t = g.type;
    const coords = g.coordinates;
    if (t === 'LineString' && Array.isArray(coords)) out.push(coords);
    if (t === 'MultiLineString' && Array.isArray(coords)) {
      for (const ls of coords) if (Array.isArray(ls)) out.push(ls);
    }
    // Buildings sometimes come as Polygon outlines; treat exterior ring as line
    if (t === 'Polygon' && Array.isArray(coords) && Array.isArray(coords[0])) out.push(coords[0]);
    if (t === 'MultiPolygon' && Array.isArray(coords)) {
      for (const p of coords) if (Array.isArray(p) && Array.isArray(p[0]) && Array.isArray(p[0][0])) out.push(p[0][0]);
    }
  }
  return out;
}

function computeLonLatBounds(lines) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const ls of lines) {
    for (const pt of ls) {
      const lon = Number(pt?.[0]);
      const lat = Number(pt?.[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      minLon = Math.min(minLon, lon);
      minLat = Math.min(minLat, lat);
      maxLon = Math.max(maxLon, lon);
      maxLat = Math.max(maxLat, lat);
    }
  }
  if (!Number.isFinite(minLon)) return null;
  return { minLon, minLat, maxLon, maxLat };
}

function extractRoadLineStrings(geojson) {
  /** @type {{ coords: any[], props: any }[]} */
  const out = [];
  const feats = geojson?.features;
  if (!Array.isArray(feats)) return out;
  for (const f of feats) {
    const g = f?.geometry;
    if (!g) continue;
    const t = g.type;
    const coords = g.coordinates;
    const props = f?.properties || null;
    if (t === 'LineString' && Array.isArray(coords)) out.push({ coords, props });
    if (t === 'MultiLineString' && Array.isArray(coords)) {
      for (const ls of coords) if (Array.isArray(ls)) out.push({ coords: ls, props });
    }
  }
  return out;
}

function extractPointFeatures(geojson) {
  /** @type {{ lon: number, lat: number, props: any }[]} */
  const out = [];
  const feats = geojson?.features;
  if (!Array.isArray(feats)) return out;
  for (const f of feats) {
    const g = f?.geometry;
    if (!g) continue;
    const t = g.type;
    const props = f?.properties || null;
    const coords = g.coordinates;
    if (t === 'Point' && Array.isArray(coords)) {
      const lon = Number(coords?.[0]);
      const lat = Number(coords?.[1]);
      if (Number.isFinite(lon) && Number.isFinite(lat)) out.push({ lon, lat, props });
      continue;
    }
    if (t === 'MultiPoint' && Array.isArray(coords)) {
      for (const c of coords) {
        const lon = Number(c?.[0]);
        const lat = Number(c?.[1]);
        if (Number.isFinite(lon) && Number.isFinite(lat)) out.push({ lon, lat, props });
      }
    }
  }
  return out;
}

function computeLonLatBoundsPoints(points) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const p of points) {
    const lon = Number(p?.lon);
    const lat = Number(p?.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  if (!Number.isFinite(minLon)) return null;
  return { minLon, minLat, maxLon, maxLat };
}

function inferPropColor(props) {
  const amenity = String(props?.amenity ?? '').toLowerCase();
  const shop = String(props?.shop ?? '').toLowerCase();
  const tourism = String(props?.tourism ?? '').toLowerCase();
  const historic = String(props?.historic ?? '').toLowerCase();
  const leisure = String(props?.leisure ?? '').toLowerCase();
  const manMade = String(props?.man_made ?? '').toLowerCase();

  if (amenity) return [0.25, 0.80, 0.55, 1.0];
  if (shop) return [0.95, 0.75, 0.25, 1.0];
  if (tourism) return [0.55, 0.65, 0.95, 1.0];
  if (historic) return [0.75, 0.60, 0.50, 1.0];
  if (leisure) return [0.40, 0.85, 0.95, 1.0];
  if (manMade) return [0.75, 0.75, 0.78, 1.0];
  return [0.95, 0.35, 0.35, 1.0];
}

function inferRoadWidthMeters(props) {
  const highway = String(props?.highway ?? '').toLowerCase();
  const surface = String(props?.surface ?? '').toLowerCase();
  const lanesRaw = props?.lanes;
  const lanes = (lanesRaw != null) ? Number(String(lanesRaw).split(';')[0]) : NaN;
  const explicitWidthRaw = props?.width;
  const explicitWidth = (explicitWidthRaw != null) ? Number(String(explicitWidthRaw).replace(/[^\d.+-]/g, '')) : NaN;
  if (Number.isFinite(explicitWidth) && explicitWidth > 0) return Math.max(1.5, Math.min(40, explicitWidth));

  // Rough defaults: lane ≈ 3.2m, plus some shoulder.
  const laneW = 3.2;
  const laneCount = Number.isFinite(lanes) && lanes > 0 ? lanes : NaN;
  if (Number.isFinite(laneCount)) return Math.max(3.0, Math.min(40, laneCount * laneW + 1.0));

  if (highway === 'motorway') return 14.0;
  if (highway === 'trunk') return 12.0;
  if (highway === 'primary') return 10.0;
  if (highway === 'secondary') return 9.0;
  if (highway === 'tertiary') return 8.0;
  if (highway === 'residential') return 6.5;
  if (highway === 'unclassified') return 6.0;
  if (highway === 'service') return 4.5;
  if (highway === 'living_street') return 5.0;
  if (highway === 'track') return 3.0;
  if (highway === 'path' || highway === 'footway' || highway === 'cycleway') return 2.5;

  // Surface hints (fallback)
  if (surface === 'asphalt' || surface === 'concrete') return 6.0;
  return 5.5;
}

function inferRoadColor(props) {
  const surface = String(props?.surface ?? '').toLowerCase();
  if (surface === 'asphalt') return [0.14, 0.14, 0.16, 1.0];
  if (surface === 'concrete') return [0.20, 0.20, 0.22, 1.0];
  if (surface === 'gravel' || surface === 'dirt' || surface === 'ground') return [0.25, 0.20, 0.16, 1.0];
  return [0.16, 0.16, 0.18, 1.0];
}

function parseLayer(props) {
  const raw = props?.layer;
  if (raw == null) return 0;
  const n = Number(String(raw).trim().split(';')[0]);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-5, Math.min(5, Math.round(n)));
}

function yOffsetFromBridgeTunnelLayer(props, { perLayer = 0.45, bridgeBoost = 0.85, tunnelDrop = 0.85 } = {}) {
  // Heuristic: use layer primarily; then nudge bridges up and tunnels down.
  const layer = parseLayer(props);
  const bridge = String(props?.bridge ?? '').toLowerCase();
  const tunnel = String(props?.tunnel ?? '').toLowerCase();
  let y = layer * (Number(perLayer) || 0.45);
  if (bridge && bridge !== 'no' && bridge !== 'false' && bridge !== '0') y += (Number(bridgeBoost) || 0.85);
  if (tunnel && tunnel !== 'no' && tunnel !== 'false' && tunnel !== '0') y -= (Number(tunnelDrop) || 0.85);
  return y;
}

function tintForBridgeTunnel(props, col) {
  // Subtle visual cue: bridges slightly lighter, tunnels slightly darker.
  const bridge = String(props?.bridge ?? '').toLowerCase();
  const tunnel = String(props?.tunnel ?? '').toLowerCase();
  const isBridge = bridge && bridge !== 'no' && bridge !== 'false' && bridge !== '0';
  const isTunnel = tunnel && tunnel !== 'no' && tunnel !== 'false' && tunnel !== '0';
  if (!isBridge && !isTunnel) return col;
  const mul = isBridge ? 1.10 : 0.85;
  return [Math.min(1, col[0] * mul), Math.min(1, col[1] * mul), Math.min(1, col[2] * mul), col[3]];
}

function looksLikeWaterPolygonProps(props) {
  if (!props) return false;
  const natural = String(props.natural ?? '').toLowerCase();
  const waterway = String(props.waterway ?? '').toLowerCase();
  const landuse = String(props.landuse ?? '').toLowerCase();
  const water = String(props.water ?? '').toLowerCase();
  const wetland = String(props.wetland ?? '').toLowerCase();
  if (natural === 'water' || natural === 'bay') return true;
  if (waterway === 'riverbank') return true;
  if (landuse === 'reservoir') return true;
  if (water) return true;
  if (wetland) return true;
  return false;
}

function looksLikeWaterwayLineProps(props) {
  if (!props) return false;
  const natural = String(props.natural ?? '').toLowerCase();
  const waterway = String(props.waterway ?? '').toLowerCase();
  if (natural === 'coastline') return true;
  if (!waterway) return false;
  // Common line waterways (centerlines)
  if (waterway === 'river' || waterway === 'stream' || waterway === 'canal') return true;
  if (waterway === 'drain' || waterway === 'ditch') return true;
  return false;
}

function extractWaterPolygons(geojson) {
  /** @type {{ ring: any[], props: any }[]} */
  const out = [];
  const feats = geojson?.features;
  if (!Array.isArray(feats)) return out;
  for (const f of feats) {
    const g = f?.geometry;
    if (!g) continue;
    const t = g.type;
    const coords = g.coordinates;
    const props = f?.properties || null;
    if (!looksLikeWaterPolygonProps(props)) continue;

    if (t === 'Polygon' && Array.isArray(coords) && Array.isArray(coords[0])) {
      out.push({ ring: coords[0], props });
      continue;
    }
    if (t === 'MultiPolygon' && Array.isArray(coords)) {
      for (const p of coords) {
        if (Array.isArray(p) && Array.isArray(p[0])) out.push({ ring: p[0], props });
      }
    }
  }
  return out;
}

function extractWaterwayLineStrings(geojson) {
  /** @type {{ coords: any[], props: any }[]} */
  const out = [];
  const feats = geojson?.features;
  if (!Array.isArray(feats)) return out;
  for (const f of feats) {
    const g = f?.geometry;
    if (!g) continue;
    const t = g.type;
    const coords = g.coordinates;
    const props = f?.properties || null;
    if (!looksLikeWaterwayLineProps(props)) continue;
    if (t === 'LineString' && Array.isArray(coords)) out.push({ coords, props });
    if (t === 'MultiLineString' && Array.isArray(coords)) {
      for (const ls of coords) if (Array.isArray(ls)) out.push({ coords: ls, props });
    }
  }
  return out;
}

function inferWaterColorRgb(props) {
  // Subtle variation by tag, but keep palette cohesive.
  const waterway = String(props?.waterway ?? '').toLowerCase();
  const natural = String(props?.natural ?? '').toLowerCase();
  const landuse = String(props?.landuse ?? '').toLowerCase();
  const water = String(props?.water ?? '').toLowerCase();
  if (natural === 'bay' || natural === 'coastline') return [0.03, 0.17, 0.30];
  if (landuse === 'reservoir') return [0.04, 0.20, 0.30];
  if (waterway === 'river' || water === 'river') return [0.05, 0.22, 0.33];
  if (waterway === 'canal') return [0.04, 0.21, 0.30];
  if (waterway === 'stream') return [0.06, 0.25, 0.34];
  return [0.04, 0.20, 0.32];
}

function inferWaterwayWidthMeters(props) {
  const waterway = String(props?.waterway ?? '').toLowerCase();
  const widthRaw = props?.width;
  const explicitWidth = (widthRaw != null) ? Number(String(widthRaw).replace(/[^\d.+-]/g, '')) : NaN;
  if (Number.isFinite(explicitWidth) && explicitWidth > 0) return Math.max(1.0, Math.min(120, explicitWidth));
  if (waterway === 'river') return 14.0;
  if (waterway === 'canal') return 10.0;
  if (waterway === 'stream') return 4.0;
  if (waterway === 'drain') return 2.0;
  if (waterway === 'ditch') return 1.5;
  return 3.0;
}

function _signedArea2XZ(points) {
  // points: [[x,z], ...] treated as open loop
  let a = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const q = points[(i + 1) % n];
    a += (p[0] * q[1] - q[0] * p[1]);
  }
  return a;
}

function _isPointInTri2D(px, pz, ax, az, bx, bz, cx, cz) {
  const v0x = cx - ax, v0z = cz - az;
  const v1x = bx - ax, v1z = bz - az;
  const v2x = px - ax, v2z = pz - az;
  const dot00 = v0x * v0x + v0z * v0z;
  const dot01 = v0x * v1x + v0z * v1z;
  const dot02 = v0x * v2x + v0z * v2z;
  const dot11 = v1x * v1x + v1z * v1z;
  const dot12 = v1x * v2x + v1z * v2z;
  const denom = dot00 * dot11 - dot01 * dot01;
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-12) return false;
  const inv = 1.0 / denom;
  const u = (dot11 * dot02 - dot01 * dot12) * inv;
  const v = (dot00 * dot12 - dot01 * dot02) * inv;
  return (u >= -1e-6) && (v >= -1e-6) && (u + v <= 1.0 + 1e-6);
}

function triangulateSimplePolygonEarclipXZ(pointsXZ) {
  // pointsXZ: [[x,z], ...] CCW, no holes. Returns indices (triples) or null.
  const n0 = pointsXZ.length;
  if (n0 < 3) return null;
  const idx = [];
  for (let i = 0; i < n0; i++) idx.push(i);
  /** @type {number[]} */
  const out = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 200000) {
    let earFound = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k - 1 + idx.length) % idx.length];
      const i1 = idx[k];
      const i2 = idx[(k + 1) % idx.length];
      const a = pointsXZ[i0], b = pointsXZ[i1], c = pointsXZ[i2];
      const abx = b[0] - a[0], abz = b[1] - a[1];
      const bcx = c[0] - b[0], bcz = c[1] - b[1];
      const cross = abx * bcz - abz * bcx;
      if (!(cross > 1e-10)) continue;

      let contains = false;
      for (let j = 0; j < idx.length; j++) {
        const ii = idx[j];
        if (ii === i0 || ii === i1 || ii === i2) continue;
        const p = pointsXZ[ii];
        if (_isPointInTri2D(p[0], p[1], a[0], a[1], b[0], b[1], c[0], c[1])) { contains = true; break; }
      }
      if (contains) continue;

      out.push(i0, i1, i2);
      idx.splice(k, 1);
      earFound = true;
      break;
    }
    if (!earFound) return null;
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

function looksLikeBuildingProps(props) {
  if (!props) return false;
  const b = props.building;
  if (b != null && String(b).toLowerCase() !== 'no' && String(b).trim() !== '') return true;
  // Common alternatives
  if (props['building:part'] != null) return true;
  if (props.amenity === 'parking' && (props.parking === 'multi-storey' || props.parking === 'multi_storey')) return true;
  return false;
}

function extractBuildingPolygons(geojson) {
  /** @type {{ ring: any[], props: any }[]} */
  const out = [];
  const feats = geojson?.features;
  if (!Array.isArray(feats)) return out;
  for (const f of feats) {
    const g = f?.geometry;
    if (!g) continue;
    const t = g.type;
    const coords = g.coordinates;
    const props = f?.properties || null;
    if (!looksLikeBuildingProps(props)) continue;

    if (t === 'Polygon' && Array.isArray(coords) && Array.isArray(coords[0])) {
      out.push({ ring: coords[0], props });
      continue;
    }
    if (t === 'MultiPolygon' && Array.isArray(coords)) {
      for (const p of coords) {
        if (Array.isArray(p) && Array.isArray(p[0])) out.push({ ring: p[0], props });
      }
    }
  }
  return out;
}

function parseBuildingHeightMeters(props, { defaultMeters = 7.5, metersPerLevel = 3.0, minMeters = 3.0, maxMeters = 120.0 } = {}) {
  const clamp = (v) => Math.max(minMeters, Math.min(maxMeters, v));
  if (!props) return clamp(defaultMeters);

  // OSM: height in meters (often "12", "12 m", "12.5")
  // Common keys: height, building:height, est_height
  const hRaw = props.height ?? props['building:height'] ?? props.est_height;
  if (hRaw != null) {
    const n = Number(String(hRaw).replace(/[^\d.+-]/g, ''));
    if (Number.isFinite(n) && n > 0) return clamp(n);
  }

  // Roof height can exist separately; if present, add it.
  const roofRaw = props['roof:height'];
  const roofH = (roofRaw != null) ? Number(String(roofRaw).replace(/[^\d.+-]/g, '')) : NaN;

  // OSM: building:levels (string/integer)
  // Prefer explicit aboveground if present.
  const lvRaw = props['building:levels:aboveground'] ?? props['building:levels'] ?? props.levels;
  if (lvRaw != null) {
    const n = Number(String(lvRaw).split(';')[0]);
    if (Number.isFinite(n) && n > 0) {
      const base = n * metersPerLevel;
      const extra = (Number.isFinite(roofH) && roofH > 0) ? roofH : 0;
      return clamp(base + extra);
    }
  }

  // Fallback: default + optional roof
  const extra = (Number.isFinite(roofH) && roofH > 0) ? roofH : 0;
  return clamp(defaultMeters + extra);
}

function parseBuildingMinHeightMeters(props, { defaultMeters = 0.0, minMeters = 0.0, maxMeters = 120.0 } = {}) {
  const clamp = (v) => Math.max(minMeters, Math.min(maxMeters, v));
  if (!props) return clamp(defaultMeters);

  // OSM commonly uses min_height for building parts (e.g. overhangs).
  const raw = props.min_height ?? props['building:min_height'] ?? props['building:min_height:meters'];
  if (raw != null) {
    const n = Number(String(raw).replace(/[^\d.+-]/g, ''));
    if (Number.isFinite(n) && n >= 0) return clamp(n);
  }

  // building:min_level is not directly meters; ignore here (needs floor height assumption).
  return clamp(defaultMeters);
}

function inferBuildingCategory(props) {
  const b = String(props?.building ?? '').toLowerCase();
  const use = String(props?.['building:use'] ?? '').toLowerCase();
  const amenity = String(props?.amenity ?? '').toLowerCase();
  const shop = String(props?.shop ?? '').toLowerCase();
  const office = String(props?.office ?? '').toLowerCase();
  const manMade = String(props?.man_made ?? '').toLowerCase();
  const parking = String(props?.parking ?? '').toLowerCase();

  if (parking === 'multi-storey' || parking === 'multi_storey' || b.includes('parking')) return 'parking';
  if (amenity === 'school' || amenity === 'university' || amenity === 'college') return 'education';
  if (amenity === 'hospital' || amenity === 'clinic') return 'health';
  if (amenity === 'place_of_worship' || b.includes('church') || b.includes('mosque') || b.includes('temple')) return 'religious';
  if (b.includes('industrial') || b.includes('warehouse') || use.includes('industrial')) return 'industrial';
  if (b.includes('commercial') || b.includes('retail') || shop || office || use.includes('commercial')) return 'commercial';
  if (b.includes('apartments') || b.includes('residential') || b.includes('house') || use.includes('residential')) return 'residential';
  if (manMade) return 'infrastructure';
  if (b) return 'generic';
  return 'generic';
}

function inferDefaultHeightMeters(props, category) {
  // Small heuristic defaults when no height/levels exist.
  // These are intentionally conservative to keep city readable.
  const b = String(props?.building ?? '').toLowerCase();
  if (category === 'parking') return 12.0;
  if (category === 'industrial') return 9.0;
  if (category === 'commercial') return (b.includes('skyscraper') || b.includes('highrise')) ? 60.0 : 15.0;
  if (category === 'education') return 12.0;
  if (category === 'health') return 18.0;
  if (category === 'religious') return 14.0;
  if (b.includes('apartments')) return 18.0;
  if (category === 'residential') return 7.5;
  return 9.0;
}

function parseColorHex(s) {
  const str = String(s || '').trim();
  if (!str) return null;
  const m = str.match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return null;
  const hex = m[1];
  const full = (hex.length === 3)
    ? (hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2])
    : hex;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return [r / 255, g / 255, b / 255];
}

function parseNamedColor(s) {
  const k = String(s || '').trim().toLowerCase();
  if (!k) return null;
  const table = {
    white: [0.92, 0.92, 0.92],
    black: [0.08, 0.08, 0.08],
    grey: [0.55, 0.55, 0.55],
    gray: [0.55, 0.55, 0.55],
    lightgrey: [0.75, 0.75, 0.75],
    lightgray: [0.75, 0.75, 0.75],
    darkgrey: [0.30, 0.30, 0.30],
    darkgray: [0.30, 0.30, 0.30],
    red: [0.70, 0.20, 0.20],
    green: [0.20, 0.55, 0.25],
    blue: [0.22, 0.30, 0.70],
    brown: [0.45, 0.33, 0.24],
    beige: [0.78, 0.72, 0.62],
    tan: [0.75, 0.67, 0.55],
    brick: [0.60, 0.28, 0.20],
  };
  return table[k] || null;
}

function inferMaterialColor(mat) {
  const m = String(mat || '').toLowerCase();
  if (!m) return null;
  if (m.includes('brick')) return [0.60, 0.28, 0.20];
  if (m.includes('concrete')) return [0.62, 0.64, 0.66];
  if (m.includes('glass')) return [0.55, 0.65, 0.75];
  if (m.includes('metal')) return [0.55, 0.58, 0.62];
  if (m.includes('wood')) return [0.55, 0.42, 0.30];
  if (m.includes('stone')) return [0.58, 0.56, 0.52];
  return null;
}

function inferBuildingColor(props, { category = 'generic', heightMeters = 10 } = {}) {
  // Prefer explicit color tags if present.
  const cRaw = props?.['building:colour'] ?? props?.['building:color'] ?? props?.colour ?? props?.color;
  const c = parseColorHex(cRaw) || parseNamedColor(cRaw);
  if (c) return [...c, 0.92];

  const matRaw = props?.['building:material'] ?? props?.material ?? props?.['facade:material'];
  const mc = inferMaterialColor(matRaw);
  if (mc) return [...mc, 0.92];

  // Category/height based fallback palette.
  if (category === 'residential') return [0.72, 0.70, 0.66, 0.90];
  if (category === 'commercial') return (heightMeters >= 30) ? [0.58, 0.64, 0.72, 0.92] : [0.70, 0.72, 0.74, 0.90];
  if (category === 'industrial') return [0.55, 0.56, 0.58, 0.92];
  if (category === 'parking') return [0.52, 0.54, 0.56, 0.92];
  if (category === 'religious') return [0.70, 0.66, 0.60, 0.92];
  if (category === 'education') return [0.68, 0.66, 0.62, 0.92];
  if (category === 'health') return [0.74, 0.74, 0.76, 0.92];
  return (heightMeters >= 30) ? [0.62, 0.66, 0.70, 0.92] : [0.72, 0.72, 0.74, 0.90];
}

function inferYawFromRingMeters(ringMeters) {
  // Use the longest edge direction as a cheap orientation estimate.
  if (!Array.isArray(ringMeters) || ringMeters.length < 2) return 0.0;
  let best = 0;
  let bestDx = 0, bestDz = 0;
  for (let i = 0; i < ringMeters.length - 1; i++) {
    const a = ringMeters[i];
    const b = ringMeters[i + 1];
    const dx = (b[0] - a[0]);
    const dz = (b[1] - a[1]);
    const l = Math.hypot(dx, dz);
    if (l > best) {
      best = l;
      bestDx = dx;
      bestDz = dz;
    }
  }
  if (best <= 1e-6) return 0.0;
  // Our yaw convention matches PlayerController: forward uses sin(yaw) for x and cos(yaw) for z.
  return Math.atan2(bestDx, bestDz);
}

export async function loadWgs84LineGeoJson(url, { maxSegments = 500000, originLonLat = null } = {}) {
  const geojson = await fetchJsonMaybeGzip(url);
  const lines = extractLineStrings(geojson);
  const b = computeLonLatBounds(lines);
  if (!b) return { positions: new Float32Array(0), bounds: null };
  const originLon = Number(originLonLat?.[0]);
  const originLat = Number(originLonLat?.[1]);
  const useLon = Number.isFinite(originLon) ? originLon : (b.minLon + b.maxLon) * 0.5;
  const useLat = Number.isFinite(originLat) ? originLat : (b.minLat + b.maxLat) * 0.5;

  // Build WebGL lines: pairs of vertices. World space is XZ plane (Y up).
  const verts = [];
  let segs = 0;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;

  for (const ls of lines) {
    for (let i = 0; i < ls.length - 1; i++) {
      if (segs >= maxSegments) break;
      const a = ls[i], c = ls[i + 1];
      const lon0 = Number(a?.[0]), lat0 = Number(a?.[1]);
      const lon1 = Number(c?.[0]), lat1 = Number(c?.[1]);
      if (!Number.isFinite(lon0) || !Number.isFinite(lat0) || !Number.isFinite(lon1) || !Number.isFinite(lat1)) continue;
      const [x0, z0] = projectLonLatMeters(lon0, lat0, useLon, useLat);
      const [x1, z1] = projectLonLatMeters(lon1, lat1, useLon, useLat);
      verts.push(x0, 0.05, z0, x1, 0.05, z1);
      minX = Math.min(minX, x0, x1);
      maxX = Math.max(maxX, x0, x1);
      minZ = Math.min(minZ, z0, z1);
      maxZ = Math.max(maxZ, z0, z1);
      segs++;
    }
    if (segs >= maxSegments) break;
  }

  const bounds = {
    min: [minX, 0, minZ],
    max: [maxX, 0, maxZ],
    originLonLat: [useLon, useLat],
  };
  return { positions: new Float32Array(verts), bounds };
}

export async function loadWgs84BuildingsGeoJson(url, {
  maxBuildings = 20000,
  minFootprintMeters = 1.5,
  defaultHeightMeters = 7.5,
  originLonLat = null,
} = {}) {
  const geojson = await fetchJsonMaybeGzip(url);

  const polys = extractBuildingPolygons(geojson);
  if (!polys.length) return { instances: new Float32Array(0), bounds: null, buildingCount: 0 };

  // First pass: lon/lat bounds (for auto origin + future use).
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const p of polys) {
    const ring = p.ring;
    if (!Array.isArray(ring)) continue;
    for (const pt of ring) {
      const lon = Number(pt?.[0]);
      const lat = Number(pt?.[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      minLon = Math.min(minLon, lon);
      minLat = Math.min(minLat, lat);
      maxLon = Math.max(maxLon, lon);
      maxLat = Math.max(maxLat, lat);
    }
  }
  if (!Number.isFinite(minLon)) return { instances: new Float32Array(0), bounds: null, buildingCount: 0 };
  const oLon = Number(originLonLat?.[0]);
  const oLat = Number(originLonLat?.[1]);
  const originLon = Number.isFinite(oLon) ? oLon : (minLon + maxLon) * 0.5;
  const originLat = Number.isFinite(oLat) ? oLat : (minLat + maxLat) * 0.5;

  const floatsPer = 11; // InstancedBoxRenderer
  const out = [];
  let placed = 0;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;

  // If the dataset contains building parts, suppress parent building outlines where a part is inside.
  // We don't have relation data here, so we do a cheap bbox-based heuristic.
  const partsCenters = [];
  for (const p of polys) {
    const props = p.props || null;
    if (!props || props['building:part'] == null) continue;
    const ring = p.ring;
    if (!Array.isArray(ring) || ring.length < 3) continue;
    let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
    for (const pt of ring) {
      const lon = Number(pt?.[0]);
      const lat = Number(pt?.[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const [x, z] = projectLonLatMeters(lon, lat, originLon, originLat);
      bx0 = Math.min(bx0, x);
      bz0 = Math.min(bz0, z);
      bx1 = Math.max(bx1, x);
      bz1 = Math.max(bz1, z);
    }
    if (!Number.isFinite(bx0)) continue;
    partsCenters.push({ x: (bx0 + bx1) * 0.5, z: (bz0 + bz1) * 0.5 });
  }

  for (const p of polys) {
    if (placed >= maxBuildings) break;
    const ring = p.ring;
    if (!Array.isArray(ring) || ring.length < 3) continue;

    const ringMeters = [];
    let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
    for (const pt of ring) {
      const lon = Number(pt?.[0]);
      const lat = Number(pt?.[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const [x, z] = projectLonLatMeters(lon, lat, originLon, originLat);
      ringMeters.push([x, z]);
      bx0 = Math.min(bx0, x);
      bz0 = Math.min(bz0, z);
      bx1 = Math.max(bx1, x);
      bz1 = Math.max(bz1, z);
    }
    if (!Number.isFinite(bx0)) continue;

    const isPart = (p.props && p.props['building:part'] != null);
    const isOutline = (p.props && p.props.building != null);
    if (!isPart && isOutline && partsCenters.length) {
      // Suppress parent outline if any part center falls inside this outline bbox.
      // (bbox containment is coarse but works well enough to remove most duplicates)
      let hasPartInside = false;
      for (let i = 0; i < partsCenters.length; i++) {
        const c = partsCenters[i];
        if (c.x >= bx0 && c.x <= bx1 && c.z >= bz0 && c.z <= bz1) { hasPartInside = true; break; }
      }
      if (hasPartInside) continue;
    }

    const sx = Math.max(minFootprintMeters, bx1 - bx0);
    const sz = Math.max(minFootprintMeters, bz1 - bz0);
    const cx = (bx0 + bx1) * 0.5;
    const cz = (bz0 + bz1) * 0.5;
    const category = inferBuildingCategory(p.props);
    const inferredDefaultH = inferDefaultHeightMeters(p.props, category);
    const baseDefault = Number.isFinite(defaultHeightMeters) ? defaultHeightMeters : inferredDefaultH;
    const topH = parseBuildingHeightMeters(p.props, { defaultMeters: baseDefault });
    const minH = parseBuildingMinHeightMeters(p.props, { defaultMeters: 0.0, maxMeters: Math.max(0, topH) });
    const spanH = Math.max(0.25, topH - minH);

    // Instanced box is centered; translate.y should be at the center of the vertical span.
    const tx = cx;
    const ty = minH + spanH * 0.5;
    const tz = cz;

    const yaw = inferYawFromRingMeters(ringMeters);
    const col = inferBuildingColor(p.props, { category, heightMeters: spanH });

    out.push(
      tx, ty, tz,
      sx, spanH, sz,
      yaw,
      col[0], col[1], col[2], col[3]
    );

    minX = Math.min(minX, bx0);
    maxX = Math.max(maxX, bx1);
    minZ = Math.min(minZ, bz0);
    maxZ = Math.max(maxZ, bz1);
    placed++;
  }

  const bounds = {
    min: [minX, 0, minZ],
    max: [maxX, 0, maxZ],
    originLonLat: [originLon, originLat],
  };
  return { instances: new Float32Array(out), bounds, buildingCount: placed, floatsPer };
}

export async function loadWgs84BuildingFootprintsGeoJson(url, {
  maxBuildings = 20000,
  minFootprintMeters = 1.5,
  defaultHeightMeters = 7.5,
  originLonLat = null,
} = {}) {
  const geojson = await fetchJsonMaybeGzip(url);
  const polys = extractBuildingPolygons(geojson);
  if (!polys.length) return { buildings: [], bounds: null, buildingCount: 0, originLonLat: null };

  // First pass: lon/lat bounds (for auto origin).
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const p of polys) {
    const ring = p.ring;
    if (!Array.isArray(ring)) continue;
    for (const pt of ring) {
      const lon = Number(pt?.[0]);
      const lat = Number(pt?.[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      minLon = Math.min(minLon, lon);
      minLat = Math.min(minLat, lat);
      maxLon = Math.max(maxLon, lon);
      maxLat = Math.max(maxLat, lat);
    }
  }
  if (!Number.isFinite(minLon)) return { buildings: [], bounds: null, buildingCount: 0, originLonLat: null };
  const oLon = Number(originLonLat?.[0]);
  const oLat = Number(originLonLat?.[1]);
  const originLon = Number.isFinite(oLon) ? oLon : (minLon + maxLon) * 0.5;
  const originLat = Number.isFinite(oLat) ? oLat : (minLat + maxLat) * 0.5;

  // If the dataset contains building parts, suppress parent building outlines where a part is inside.
  // (Same heuristic as the instanced-box path.)
  const partsCenters = [];
  for (const p of polys) {
    const props = p.props || null;
    if (!props || props['building:part'] == null) continue;
    const ring = p.ring;
    if (!Array.isArray(ring) || ring.length < 3) continue;
    let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
    for (const pt of ring) {
      const lon = Number(pt?.[0]);
      const lat = Number(pt?.[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const [x, z] = projectLonLatMeters(lon, lat, originLon, originLat);
      bx0 = Math.min(bx0, x);
      bz0 = Math.min(bz0, z);
      bx1 = Math.max(bx1, x);
      bz1 = Math.max(bz1, z);
    }
    if (!Number.isFinite(bx0)) continue;
    partsCenters.push({ x: (bx0 + bx1) * 0.5, z: (bz0 + bz1) * 0.5 });
  }

  /** @type {{ ringXZ: number[][], centerXZ: [number, number], minY: number, maxY: number, color: number[] }[]} */
  const buildings = [];
  let placed = 0;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;

  for (const p of polys) {
    if (placed >= maxBuildings) break;
    const ring = p.ring;
    if (!Array.isArray(ring) || ring.length < 3) continue;

    const ringXZ = [];
    let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
    for (const pt of ring) {
      const lon = Number(pt?.[0]);
      const lat = Number(pt?.[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const [x, z] = projectLonLatMeters(lon, lat, originLon, originLat);
      ringXZ.push([x, z]);
      bx0 = Math.min(bx0, x);
      bz0 = Math.min(bz0, z);
      bx1 = Math.max(bx1, x);
      bz1 = Math.max(bz1, z);
    }
    if (!Number.isFinite(bx0)) continue;

    const sx = Math.max(minFootprintMeters, bx1 - bx0);
    const sz = Math.max(minFootprintMeters, bz1 - bz0);
    // Skip tiny footprints
    if (sx <= (minFootprintMeters * 0.75) && sz <= (minFootprintMeters * 0.75)) continue;

    const isPart = (p.props && p.props['building:part'] != null);
    const isOutline = (p.props && p.props.building != null);
    if (!isPart && isOutline && partsCenters.length) {
      let hasPartInside = false;
      for (let i = 0; i < partsCenters.length; i++) {
        const c = partsCenters[i];
        if (c.x >= bx0 && c.x <= bx1 && c.z >= bz0 && c.z <= bz1) { hasPartInside = true; break; }
      }
      if (hasPartInside) continue;
    }

    const cx = (bx0 + bx1) * 0.5;
    const cz = (bz0 + bz1) * 0.5;
    const category = inferBuildingCategory(p.props);
    const inferredDefaultH = inferDefaultHeightMeters(p.props, category);
    const baseDefault = Number.isFinite(defaultHeightMeters) ? defaultHeightMeters : inferredDefaultH;
    const topH = parseBuildingHeightMeters(p.props, { defaultMeters: baseDefault });
    const minH = parseBuildingMinHeightMeters(p.props, { defaultMeters: 0.0, maxMeters: Math.max(0, topH) });
    const spanH = Math.max(0.25, topH - minH);
    const col = inferBuildingColor(p.props, { category, heightMeters: spanH });

    buildings.push({
      ringXZ,
      centerXZ: [cx, cz],
      minY: minH,
      maxY: minH + spanH,
      color: col,
      props: p.props || null,
    });

    minX = Math.min(minX, bx0);
    maxX = Math.max(maxX, bx1);
    minZ = Math.min(minZ, bz0);
    maxZ = Math.max(maxZ, bz1);
    placed++;
  }

  const bounds = {
    min: [minX, 0, minZ],
    max: [maxX, 0, maxZ],
    originLonLat: [originLon, originLat],
  };
  return { buildings, bounds, buildingCount: placed, originLonLat: [originLon, originLat] };
}

export async function loadWgs84RoadsGeoJson(url, {
  maxSegments = 250000,
  originLonLat = null,
  thicknessMeters = 0.12,
  minSegmentMeters = 2.0,
} = {}) {
  const geojson = await fetchJsonMaybeGzip(url);

  const roads = extractRoadLineStrings(geojson);
  if (!roads.length) return { instances: new Float32Array(0), bounds: null, segmentCount: 0, floatsPer: 11 };

  // Bounds for choosing an origin if not supplied.
  const allLines = roads.map((r) => r.coords);
  const b = computeLonLatBounds(allLines);
  if (!b) return { instances: new Float32Array(0), bounds: null, segmentCount: 0, floatsPer: 11 };

  const oLon = Number(originLonLat?.[0]);
  const oLat = Number(originLonLat?.[1]);
  const originLon = Number.isFinite(oLon) ? oLon : (b.minLon + b.maxLon) * 0.5;
  const originLat = Number.isFinite(oLat) ? oLat : (b.minLat + b.maxLat) * 0.5;

  const out = [];
  const floatsPer = 11;
  let segs = 0;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;

  for (const r of roads) {
    const coords = r.coords;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const props = r.props || null;
    const width = inferRoadWidthMeters(props);
    const col = tintForBridgeTunnel(props, inferRoadColor(props));
    const yOff = yOffsetFromBridgeTunnelLayer(props);

    for (let i = 0; i < coords.length - 1; i++) {
      if (segs >= maxSegments) break;
      const a = coords[i], c = coords[i + 1];
      const lon0 = Number(a?.[0]), lat0 = Number(a?.[1]);
      const lon1 = Number(c?.[0]), lat1 = Number(c?.[1]);
      if (!Number.isFinite(lon0) || !Number.isFinite(lat0) || !Number.isFinite(lon1) || !Number.isFinite(lat1)) continue;
      const [x0, z0] = projectLonLatMeters(lon0, lat0, originLon, originLat);
      const [x1, z1] = projectLonLatMeters(lon1, lat1, originLon, originLat);
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      if (!Number.isFinite(len) || len < minSegmentMeters) continue;

      const cx = (x0 + x1) * 0.5;
      const cz = (z0 + z1) * 0.5;
      const yaw = Math.atan2(dx, dz);

      // Box centered; place it slightly above ground to avoid z-fighting with terrain.
      const tx = cx;
      const ty = (Number(thicknessMeters) || 0.1) * 0.5 + 0.02 + yOff;
      const tz = cz;

      const sx = Math.max(1.0, width);
      const sy = Math.max(0.02, Number(thicknessMeters) || 0.1);
      const sz = len;

      out.push(
        tx, ty, tz,
        sx, sy, sz,
        yaw,
        col[0], col[1], col[2], col[3]
      );

      minX = Math.min(minX, x0, x1);
      maxX = Math.max(maxX, x0, x1);
      minZ = Math.min(minZ, z0, z1);
      maxZ = Math.max(maxZ, z0, z1);
      segs++;
    }
    if (segs >= maxSegments) break;
  }

  const bounds = {
    min: [minX, 0, minZ],
    max: [maxX, 0, maxZ],
    originLonLat: [originLon, originLat],
  };
  return { instances: new Float32Array(out), bounds, segmentCount: segs, floatsPer };
}

export async function loadWgs84RoadLabelsGeoJson(url, {
  originLonLat = null,
  maxLabels = 6000,
  minPolylineMeters = 30.0,
  minSegmentMeters = 3.0,
  preferRef = false,
} = {}) {
  const geojson = await fetchJsonMaybeGzip(url);
  const roads = extractRoadLineStrings(geojson);
  if (!roads.length) return { labels: [], bounds: null, labelCount: 0 };

  // Bounds for choosing an origin if not supplied.
  const allLines = roads.map((r) => r.coords);
  const b = computeLonLatBounds(allLines);
  if (!b) return { labels: [], bounds: null, labelCount: 0 };

  const oLon = Number(originLonLat?.[0]);
  const oLat = Number(originLonLat?.[1]);
  const originLon = Number.isFinite(oLon) ? oLon : (b.minLon + b.maxLon) * 0.5;
  const originLat = Number.isFinite(oLat) ? oLat : (b.minLat + b.maxLat) * 0.5;

  /** @type {{ x: number, z: number, dirX: number, dirZ: number, text: string, kind: string, priority: number, isRef: boolean }[]} */
  const labels = [];
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;

  const pickText = (props) => {
    if (!props) return '';
    const name = String(props?.name ?? props?.['name:en'] ?? '').trim();
    const ref = String(props?.ref ?? '').trim();
    if (preferRef) return (ref || name);
    return (name || ref);
  };
  const highwayPriority = (props) => {
    const h = String(props?.highway ?? '').toLowerCase();
    if (h === 'motorway') return 6;
    if (h === 'trunk') return 5;
    if (h === 'primary') return 4;
    if (h === 'secondary') return 3;
    if (h === 'tertiary') return 2;
    if (h === 'residential') return 1;
    if (h === 'service') return 0.5;
    return 0.25;
  };

  const looksLikeRouteRef = (s) => {
    const t = String(s || '').trim();
    if (!t) return false;
    // Common refs: I 64, I-64, US 13, US-13, VA 168, SR 337, Route 58, etc.
    if (/^(I|US|SR|VA)\s*[- ]?\s*\d{1,4}[A-Z]?$/.test(t)) return true;
    if (/^Route\s+\d{1,4}[A-Z]?$/.test(t)) return true;
    // Pure numeric refs exist too (rare); keep conservative.
    return false;
  };

  const minPoly = Math.max(0, Number(minPolylineMeters) || 0);
  const minSeg = Math.max(0, Number(minSegmentMeters) || 0);
  const cap = Math.max(0, Math.floor(Number(maxLabels) || 0));

  for (const r of roads) {
    if (labels.length >= cap) break;
    const coords = r.coords;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const props = r.props || null;

    const text = pickText(props);
    if (!text || text.length < 2) continue;

    // Project full polyline to meters, compute total length, then pick midpoint along length.
    /** @type {[number, number][]} */
    const pts = [];
    for (const pt of coords) {
      const lon = Number(pt?.[0]);
      const lat = Number(pt?.[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const [x, z] = projectLonLatMeters(lon, lat, originLon, originLat);
      pts.push([x, z]);
    }
    if (pts.length < 2) continue;

    /** @type {{ i0: number, len: number, acc0: number, dx: number, dz: number }[]} */
    const segs = [];
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const c = pts[i + 1];
      const dx = c[0] - a[0];
      const dz = c[1] - a[1];
      const len = Math.hypot(dx, dz);
      if (!Number.isFinite(len) || len < minSeg) continue;
      segs.push({ i0: i, len, acc0: total, dx, dz });
      total += len;
    }
    if (!Number.isFinite(total) || total < minPoly) continue;

    const pickAt = (tLen) => {
      let pickX = pts[0][0];
      let pickZ = pts[0][1];
      let dirX = 0;
      let dirZ = 1;
      for (let si = 0; si < segs.length; si++) {
        const s = segs[si];
        const next = s.acc0 + s.len;
        if (next >= tLen) {
          const t = (tLen - s.acc0) / Math.max(1e-6, s.len);
          const a = pts[s.i0];
          pickX = a[0] + s.dx * t;
          pickZ = a[1] + s.dz * t;
          const inv = 1.0 / Math.max(1e-6, Math.hypot(s.dx, s.dz));
          dirX = s.dx * inv;
          dirZ = s.dz * inv;
          break;
        }
      }
      return { pickX, pickZ, dirX, dirZ };
    };

    // Repeat labels along long roads (production-like). Keep bounded to control clutter.
    const repeats = Math.max(1, Math.min(4, Math.floor(total / 900) + 1)); // ~1 per 0.9km, up to 4
    const startFrac = 0.25;
    const endFrac = 0.75;
    const span = Math.max(1e-6, endFrac - startFrac);

    // Cheap bounds for framing.
    for (let i = 0; i < pts.length; i++) {
      const x = pts[i][0];
      const z = pts[i][1];
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      minX = Math.min(minX, x);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxZ = Math.max(maxZ, z);
    }

    const isRef = looksLikeRouteRef(text) || (!!props && looksLikeRouteRef(String(props?.ref ?? '').trim()));
    const basePri = highwayPriority(props);
    // Gentle boost for refs and longer (more “important”) geometries.
    const lenBoost = Math.max(0, Math.min(0.8, Math.log10(Math.max(10, total)) * 0.25));
    const pri = basePri + (isRef ? 0.45 : 0.0) + lenBoost;

    for (let k = 0; k < repeats; k++) {
      if (labels.length >= cap) break;
      const frac = startFrac + (span * (repeats === 1 ? 0.5 : (k / (repeats - 1))));
      const tLen = clamp(frac, 0, 1) * total;
      const p = pickAt(tLen);
      labels.push({
        x: p.pickX,
        z: p.pickZ,
        dirX: p.dirX,
        dirZ: p.dirZ,
        text,
        kind: String(props?.highway ?? ''),
        priority: pri,
        isRef,
      });
    }
  }

  const bounds = (Number.isFinite(minX))
    ? { min: [minX, 0, minZ], max: [maxX, 0, maxZ], originLonLat: [originLon, originLat] }
    : null;
  return { labels, bounds, labelCount: labels.length };
}

export async function loadWgs84WaterGeoJson(url, {
  originLonLat = null,
  waterLevelY = 0.0,
  maxPolygons = 20000,
  maxSegments = 250000,
  thicknessMeters = 0.09,
  minSegmentMeters = 2.0,
  minPolygonAreaM2 = 12.0,
  shorelineY = 0.03,
} = {}) {
  const geojson = await fetchJsonMaybeGzip(url);

  const polys = extractWaterPolygons(geojson);
  const lines = extractWaterwayLineStrings(geojson);

  if (!polys.length && !lines.length) {
    return {
      waterMesh: { positions: new Float32Array(0), colors: new Float32Array(0), indices: new Uint32Array(0) },
      shoreline: new Float32Array(0),
      waterways: new Float32Array(0),
      waterPolygons: [],
      bounds: null,
      originLonLat: originLonLat || null,
      polygonCount: 0,
      segmentCount: 0,
      floatsPer: 11,
    };
  }

  // Bounds for choosing an origin if not supplied.
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  const scanRing = (ring) => {
    if (!Array.isArray(ring)) return;
    for (const pt of ring) {
      const lon = Number(pt?.[0]);
      const lat = Number(pt?.[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      minLon = Math.min(minLon, lon);
      minLat = Math.min(minLat, lat);
      maxLon = Math.max(maxLon, lon);
      maxLat = Math.max(maxLat, lat);
    }
  };
  for (const p of polys) scanRing(p.ring);
  for (const l of lines) scanRing(l.coords);

  const oLon = Number(originLonLat?.[0]);
  const oLat = Number(originLonLat?.[1]);
  const originLon = Number.isFinite(oLon) ? oLon : ((minLon + maxLon) * 0.5);
  const originLat = Number.isFinite(oLat) ? oLat : ((minLat + maxLat) * 0.5);

  /** @type {number[]} */
  const P = [];
  /** @type {number[]} */
  const C = [];
  /** @type {number[]} */
  const I = [];
  /** @type {number[]} */
  const shore = [];
  /** @type {{ ringXZ: Float32Array, bbox: [number, number, number, number] }[]} */
  const waterPolygons = [];
  let vtx = 0;
  let placedPolys = 0;
  let bMinX = Infinity, bMinZ = Infinity, bMaxX = -Infinity, bMaxZ = -Infinity;

  const y = Number(waterLevelY) || 0.0;
  const shoreY = y + (Number(shorelineY) || 0.03);

  const countPolys = Math.min(Math.max(0, polys.length), Math.max(0, maxPolygons | 0) || 0);
  for (let pi = 0; pi < countPolys; pi++) {
    const p = polys[pi];
    const ring = p?.ring;
    if (!Array.isArray(ring) || ring.length < 3) continue;

    /** @type {number[][]} */
    const ringXZ = [];
    for (const pt of ring) {
      const lon = Number(pt?.[0]);
      const lat = Number(pt?.[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const [x, z] = projectLonLatMeters(lon, lat, originLon, originLat);
      ringXZ.push([x, z]);
    }
    if (ringXZ.length < 3) continue;
    // Drop last if duplicated
    const a0 = ringXZ[0];
    const al = ringXZ[ringXZ.length - 1];
    if (Math.hypot(al[0] - a0[0], al[1] - a0[1]) < 1e-4) ringXZ.pop();
    if (ringXZ.length < 3) continue;

    // Filter tiny polygons
    const area2 = _signedArea2XZ(ringXZ);
    const area = Math.abs(area2) * 0.5;
    if (!Number.isFinite(area) || area < (Number(minPolygonAreaM2) || 0)) continue;

    // Ensure CCW
    if (area2 < 0) ringXZ.reverse();

    const tri = triangulateSimplePolygonEarclipXZ(ringXZ);
    if (!tri || tri.length < 3) continue;

    const col = inferWaterColorRgb(p?.props);
    // Keep a copy of the polygon in XZ for downstream terrain masking/clipping.
    // Store as a flat float array for compactness: [x0,z0,x1,z1,...]
    try {
      let pMinX = Infinity, pMinZ = Infinity, pMaxX = -Infinity, pMaxZ = -Infinity;
      const flat = new Float32Array(ringXZ.length * 2);
      for (let i = 0; i < ringXZ.length; i++) {
        const x = ringXZ[i][0];
        const z = ringXZ[i][1];
        flat[i * 2 + 0] = x;
        flat[i * 2 + 1] = z;
        pMinX = Math.min(pMinX, x);
        pMaxX = Math.max(pMaxX, x);
        pMinZ = Math.min(pMinZ, z);
        pMaxZ = Math.max(pMaxZ, z);
      }
      if (Number.isFinite(pMinX) && Number.isFinite(pMinZ) && Number.isFinite(pMaxX) && Number.isFinite(pMaxZ)) {
        waterPolygons.push({ ringXZ: flat, bbox: [pMinX, pMinZ, pMaxX, pMaxZ] });
      }
    } catch { /* ignore */ }
    for (let i = 0; i < ringXZ.length; i++) {
      const x = ringXZ[i][0];
      const z = ringXZ[i][1];
      P.push(x, y, z);
      C.push(col[0], col[1], col[2]);
      bMinX = Math.min(bMinX, x);
      bMaxX = Math.max(bMaxX, x);
      bMinZ = Math.min(bMinZ, z);
      bMaxZ = Math.max(bMaxZ, z);
    }
    for (let i = 0; i + 2 < tri.length; i += 3) {
      I.push(vtx + tri[i], vtx + tri[i + 1], vtx + tri[i + 2]);
    }
    // Shoreline polyline (closed)
    for (let i = 0; i < ringXZ.length; i++) {
      const a = ringXZ[i];
      const b = ringXZ[(i + 1) % ringXZ.length];
      shore.push(a[0], shoreY, a[1], b[0], shoreY, b[1]);
    }

    vtx += ringXZ.length;
    placedPolys++;
  }

  // Waterway ribbons as instanced boxes (like roads, but blue + width inferred from waterway type)
  const out = [];
  const floatsPer = 11;
  let segs = 0;
  for (const r of lines) {
    const coords = r.coords;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const props = r.props || null;
    const width = inferWaterwayWidthMeters(props);
    const col = inferWaterColorRgb(props);

    for (let i = 0; i < coords.length - 1; i++) {
      if (segs >= maxSegments) break;
      const a = coords[i], c = coords[i + 1];
      const lon0 = Number(a?.[0]), lat0 = Number(a?.[1]);
      const lon1 = Number(c?.[0]), lat1 = Number(c?.[1]);
      if (!Number.isFinite(lon0) || !Number.isFinite(lat0) || !Number.isFinite(lon1) || !Number.isFinite(lat1)) continue;
      const [x0, z0] = projectLonLatMeters(lon0, lat0, originLon, originLat);
      const [x1, z1] = projectLonLatMeters(lon1, lat1, originLon, originLat);
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      if (!Number.isFinite(len) || len < minSegmentMeters) continue;

      const cx = (x0 + x1) * 0.5;
      const cz = (z0 + z1) * 0.5;
      const yaw = Math.atan2(dx, dz);

      const ty = y + (Number(thicknessMeters) || 0.08) * 0.5 + 0.01;
      const sx = Math.max(0.8, width);
      const sy = Math.max(0.02, Number(thicknessMeters) || 0.08);
      const sz = len;

      out.push(
        cx, ty, cz,
        sx, sy, sz,
        yaw,
        col[0], col[1], col[2], 0.65
      );

      bMinX = Math.min(bMinX, x0, x1);
      bMaxX = Math.max(bMaxX, x0, x1);
      bMinZ = Math.min(bMinZ, z0, z1);
      bMaxZ = Math.max(bMaxZ, z0, z1);
      segs++;
    }
    if (segs >= maxSegments) break;
  }

  const bounds = (Number.isFinite(bMinX) && Number.isFinite(bMinZ))
    ? { min: [bMinX, 0, bMinZ], max: [bMaxX, 0, bMaxZ], originLonLat: [originLon, originLat] }
    : null;

  return {
    waterMesh: {
      positions: new Float32Array(P),
      colors: new Float32Array(C),
      indices: new Uint32Array(I),
    },
    shoreline: new Float32Array(shore),
    waterways: new Float32Array(out),
    waterPolygons,
    bounds,
    originLonLat: [originLon, originLat],
    polygonCount: placedPolys,
    segmentCount: segs,
    floatsPer,
  };
}

function inferPropKind(props) {
  const highway = String(props?.highway ?? '').toLowerCase();
  const manMade = String(props?.man_made ?? '').toLowerCase();
  const amenity = String(props?.amenity ?? '').toLowerCase();
  const shop = String(props?.shop ?? '').toLowerCase();
  const tourism = String(props?.tourism ?? '').toLowerCase();
  const leisure = String(props?.leisure ?? '').toLowerCase();
  const historic = String(props?.historic ?? '').toLowerCase();
  const entrance = String(props?.entrance ?? '').toLowerCase();
  const door = String(props?.door ?? '').toLowerCase();
  const emergency = String(props?.emergency ?? '').toLowerCase();
  const trafficSign = String(props?.traffic_sign ?? '').toLowerCase();
  const publicTransport = String(props?.public_transport ?? '').toLowerCase();
  const power = String(props?.power ?? '').toLowerCase();

  if (highway === 'traffic_signals') return 'traffic_signals';
  if (highway === 'street_lamp' || manMade === 'street_lamp') return 'street_lamp';
  if (emergency === 'fire_hydrant') return 'fire_hydrant';
  if (highway === 'bus_stop' || publicTransport === 'platform') return 'bus_stop';
  if (highway === 'crossing') return 'crossing';
  if (highway === 'stop' || trafficSign === 'stop') return 'stop';
  if (highway === 'give_way' || trafficSign === 'give_way') return 'give_way';
  if (amenity === 'parking_entrance') return 'parking_entrance';
  if (amenity === 'fuel') return 'fuel';
  if (amenity === 'charging_station') return 'charging_station';
  if (power === 'pole') return 'power_pole';
  if (power === 'tower') return 'power_tower';

  // “Place” semantics (POIs)
  if (entrance || door) return 'entrance';
  if (amenity) return 'poi_amenity';
  if (shop) return 'poi_shop';
  if (tourism) return 'poi_tourism';
  if (leisure) return 'poi_leisure';
  if (historic) return 'poi_historic';
  return '';
}

function pushInstance(out, tx, ty, tz, sx, sy, sz, yaw, col) {
  out.push(
    tx, ty, tz,
    sx, sy, sz,
    yaw,
    col[0], col[1], col[2], col[3]
  );
}

function emitPropInstances(out, { x, z, kind, props }) {
  // Cheap "box props" that add a lot of readability without new shaders.
  const yaw = 0.0;
  const dark = [0.18, 0.18, 0.20, 1.0];

  if (kind === 'traffic_signals') {
    const poleH = 4.2;
    pushInstance(out, x, poleH * 0.5 + 0.02, z, 0.16, poleH, 0.16, yaw, dark);
    pushInstance(out, x, poleH + 0.40, z, 0.45, 0.55, 0.25, yaw, [0.10, 0.10, 0.10, 1.0]);
    // Hint lights
    pushInstance(out, x - 0.10, poleH + 0.52, z + 0.14, 0.10, 0.10, 0.06, yaw, [0.95, 0.20, 0.20, 1.0]);
    pushInstance(out, x - 0.10, poleH + 0.40, z + 0.14, 0.10, 0.10, 0.06, yaw, [0.98, 0.75, 0.15, 1.0]);
    pushInstance(out, x - 0.10, poleH + 0.28, z + 0.14, 0.10, 0.10, 0.06, yaw, [0.20, 0.95, 0.35, 1.0]);
    return;
  }

  if (kind === 'street_lamp') {
    const poleH = 6.0;
    pushInstance(out, x, poleH * 0.5 + 0.02, z, 0.14, poleH, 0.14, yaw, dark);
    pushInstance(out, x + 0.25, poleH + 0.10, z, 0.60, 0.14, 0.14, yaw, dark);
    pushInstance(out, x + 0.55, poleH + 0.08, z, 0.22, 0.10, 0.22, yaw, [1.00, 0.92, 0.65, 0.95]);
    return;
  }

  if (kind === 'stop') {
    const poleH = 2.6;
    pushInstance(out, x, poleH * 0.5 + 0.02, z, 0.10, poleH, 0.10, yaw, dark);
    pushInstance(out, x, poleH + 0.22, z, 0.55, 0.55, 0.08, yaw, [0.92, 0.16, 0.16, 1.0]);
    return;
  }

  if (kind === 'give_way') {
    const poleH = 2.4;
    pushInstance(out, x, poleH * 0.5 + 0.02, z, 0.10, poleH, 0.10, yaw, dark);
    pushInstance(out, x, poleH + 0.22, z, 0.55, 0.55, 0.08, yaw, [0.98, 0.98, 0.98, 1.0]);
    return;
  }

  if (kind === 'fire_hydrant') {
    pushInstance(out, x, 0.45 + 0.02, z, 0.45, 0.90, 0.45, yaw, [0.86, 0.12, 0.12, 1.0]);
    return;
  }

  if (kind === 'bus_stop') {
    const poleH = 2.8;
    pushInstance(out, x, poleH * 0.5 + 0.02, z, 0.10, poleH, 0.10, yaw, dark);
    pushInstance(out, x, poleH + 0.18, z, 0.40, 0.40, 0.08, yaw, [0.20, 0.55, 0.95, 1.0]);
    return;
  }

  if (kind === 'crossing') {
    // Placeholder marker (actual crosswalks are better as decals/quads on the road mesh).
    pushInstance(out, x, 0.03, z, 0.90, 0.06, 0.90, yaw, [0.98, 0.98, 0.98, 0.9]);
    return;
  }

  if (kind === 'parking_entrance') {
    pushInstance(out, x, 0.60, z, 0.80, 1.20, 0.20, yaw, [0.10, 0.55, 0.95, 0.9]);
    return;
  }

  if (kind === 'fuel') {
    pushInstance(out, x, 1.30, z, 1.20, 2.60, 0.50, yaw, [0.95, 0.25, 0.15, 0.9]);
    return;
  }

  if (kind === 'charging_station') {
    pushInstance(out, x, 0.80, z, 0.80, 1.60, 0.40, yaw, [0.20, 0.90, 0.55, 0.9]);
    return;
  }

  if (kind === 'power_pole') {
    const poleH = 8.5;
    pushInstance(out, x, poleH * 0.5 + 0.02, z, 0.18, poleH, 0.18, yaw, [0.45, 0.45, 0.48, 1.0]);
    pushInstance(out, x, poleH + 0.25, z, 1.6, 0.18, 0.18, yaw, [0.45, 0.45, 0.48, 1.0]);
    return;
  }

  if (kind === 'power_tower') {
    const poleH = 14.0;
    pushInstance(out, x, poleH * 0.5 + 0.02, z, 0.28, poleH, 0.28, yaw, [0.42, 0.44, 0.48, 1.0]);
    pushInstance(out, x, poleH + 0.35, z, 3.2, 0.22, 0.22, yaw, [0.42, 0.44, 0.48, 1.0]);
    return;
  }

  if (kind === 'entrance') {
    // Tiny “door marker” so you can see entrances without clutter.
    pushInstance(out, x, 0.55, z, 0.40, 1.10, 0.12, yaw, [0.95, 0.95, 0.95, 0.95]);
    return;
  }

  if (kind === 'poi_amenity' || kind === 'poi_shop' || kind === 'poi_tourism' || kind === 'poi_leisure' || kind === 'poi_historic') {
    // Generic “place block”: colored stub with a small mast.
    const col = inferPropColor(props);
    const h = 2.4;
    pushInstance(out, x, h * 0.5 + 0.02, z, 1.20, h, 1.20, yaw, [col[0], col[1], col[2], 0.75]);
    pushInstance(out, x, h + 0.90, z, 0.10, 1.80, 0.10, yaw, [0.20, 0.20, 0.22, 0.9]);
    return;
  }

  void props;
}

export async function loadWgs84PropsGeoJson(url, {
  maxProps = 20000,
  originLonLat = null,
} = {}) {
  const geojson = await fetchJsonMaybeGzip(url);
  const pts = extractPointFeatures(geojson);
  if (!pts.length) return { instances: new Float32Array(0), bounds: null, propCount: 0, floatsPer: 11 };

  // Bounds for choosing an origin if not supplied.
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const p of pts) {
    minLon = Math.min(minLon, p.lon);
    minLat = Math.min(minLat, p.lat);
    maxLon = Math.max(maxLon, p.lon);
    maxLat = Math.max(maxLat, p.lat);
  }
  if (!Number.isFinite(minLon)) return { instances: new Float32Array(0), bounds: null, propCount: 0, floatsPer: 11 };

  const oLon = Number(originLonLat?.[0]);
  const oLat = Number(originLonLat?.[1]);
  const originLon = Number.isFinite(oLon) ? oLon : (minLon + maxLon) * 0.5;
  const originLat = Number.isFinite(oLat) ? oLat : (minLat + maxLat) * 0.5;

  const pri = (kind) => (
    kind === 'traffic_signals' ? 100 :
    kind === 'street_lamp' ? 90 :
    kind === 'stop' ? 80 :
    kind === 'give_way' ? 70 :
    kind === 'bus_stop' ? 65 :
    kind === 'fire_hydrant' ? 60 :
    kind === 'crossing' ? 55 :
    kind === 'fuel' ? 50 :
    kind === 'power_tower' ? 48 :
    kind === 'power_pole' ? 47 :
    kind === 'poi_amenity' ? 46 :
    kind === 'poi_shop' ? 45.5 :
    kind === 'charging_station' ? 45 :
    kind === 'poi_tourism' ? 44.5 :
    kind === 'poi_leisure' ? 44 :
    kind === 'poi_historic' ? 43.5 :
    kind === 'entrance' ? 20 :
    kind === 'parking_entrance' ? 40 :
    0
  );

  const candidates = [];
  for (const p of pts) {
    const kind = inferPropKind(p.props);
    if (!kind) continue;
    candidates.push({ ...p, kind });
  }
  if (!candidates.length) return { instances: new Float32Array(0), bounds: null, propCount: 0, floatsPer: 11 };
  candidates.sort((a, b) => pri(b.kind) - pri(a.kind));

  const out = [];
  let placed = 0;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < candidates.length; i++) {
    if (placed >= maxProps) break;
    const p = candidates[i];
    const [x, z] = projectLonLatMeters(p.lon, p.lat, originLon, originLat);
    emitPropInstances(out, { x, z, kind: p.kind, props: p.props });
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
    placed++;
  }

  const bounds = {
    min: [minX, 0, minZ],
    max: [maxX, 0, maxZ],
    originLonLat: [originLon, originLat],
  };
  return { instances: new Float32Array(out), bounds, propCount: placed, floatsPer: 11 };
}

export async function loadWgs84RailsGeoJson(url, {
  maxSegments = 300000,
  originLonLat = null,
  thicknessMeters = 0.10,
  minSegmentMeters = 2.0,
} = {}) {
  const geojson = await fetchJsonMaybeGzip(url);
  const lines = extractRoadLineStrings(geojson);
  if (!lines.length) return { instances: new Float32Array(0), bounds: null, segmentCount: 0, floatsPer: 11 };

  const allLines = lines.map((r) => r.coords);
  const b = computeLonLatBounds(allLines);
  if (!b) return { instances: new Float32Array(0), bounds: null, segmentCount: 0, floatsPer: 11 };

  const oLon = Number(originLonLat?.[0]);
  const oLat = Number(originLonLat?.[1]);
  const originLon = Number.isFinite(oLon) ? oLon : (b.minLon + b.maxLon) * 0.5;
  const originLat = Number.isFinite(oLat) ? oLat : (b.minLat + b.maxLat) * 0.5;

  const out = [];
  const floatsPer = 11;
  let segs = 0;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;

  const inferRailWidth = (props) => {
    const railway = String(props?.railway ?? '').toLowerCase();
    if (railway === 'tram') return 1.6;
    if (railway === 'subway') return 2.2;
    if (railway === 'light_rail') return 2.2;
    if (railway === 'rail') return 2.8;
    return 2.0;
  };

  const inferRailColor = (props) => {
    const base = [0.18, 0.18, 0.20, 1.0];
    return tintForBridgeTunnel(props, base);
  };

  for (const r of lines) {
    const coords = r.coords;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const props = r.props || null;
    const width = inferRailWidth(props);
    const col = inferRailColor(props);
    const yOff = yOffsetFromBridgeTunnelLayer(props, { perLayer: 0.55, bridgeBoost: 1.0, tunnelDrop: 1.0 });

    for (let i = 0; i < coords.length - 1; i++) {
      if (segs >= maxSegments) break;
      const a = coords[i], c = coords[i + 1];
      const lon0 = Number(a?.[0]), lat0 = Number(a?.[1]);
      const lon1 = Number(c?.[0]), lat1 = Number(c?.[1]);
      if (!Number.isFinite(lon0) || !Number.isFinite(lat0) || !Number.isFinite(lon1) || !Number.isFinite(lat1)) continue;
      const [x0, z0] = projectLonLatMeters(lon0, lat0, originLon, originLat);
      const [x1, z1] = projectLonLatMeters(lon1, lat1, originLon, originLat);
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      if (!Number.isFinite(len) || len < minSegmentMeters) continue;

      const cx = (x0 + x1) * 0.5;
      const cz = (z0 + z1) * 0.5;
      const yaw = Math.atan2(dx, dz);

      const sy = Math.max(0.03, Number(thicknessMeters) || 0.10);
      const ty = sy * 0.5 + 0.04 + yOff;
      out.push(
        cx, ty, cz,
        Math.max(0.8, width), sy, len,
        yaw,
        col[0], col[1], col[2], col[3]
      );

      minX = Math.min(minX, x0, x1);
      maxX = Math.max(maxX, x0, x1);
      minZ = Math.min(minZ, z0, z1);
      maxZ = Math.max(maxZ, z0, z1);
      segs++;
    }
    if (segs >= maxSegments) break;
  }

  const bounds = {
    min: [minX, 0, minZ],
    max: [maxX, 0, maxZ],
    originLonLat: [originLon, originLat],
  };
  return { instances: new Float32Array(out), bounds, segmentCount: segs, floatsPer };
}

export async function loadWgs84BarriersGeoJson(url, {
  maxSegments = 250000,
  originLonLat = null,
  thicknessMeters = 0.10,
  minSegmentMeters = 2.0,
} = {}) {
  const geojson = await fetchJsonMaybeGzip(url);
  const lines = extractRoadLineStrings(geojson);
  if (!lines.length) return { instances: new Float32Array(0), bounds: null, segmentCount: 0, floatsPer: 11 };

  const allLines = lines.map((r) => r.coords);
  const b = computeLonLatBounds(allLines);
  if (!b) return { instances: new Float32Array(0), bounds: null, segmentCount: 0, floatsPer: 11 };

  const oLon = Number(originLonLat?.[0]);
  const oLat = Number(originLonLat?.[1]);
  const originLon = Number.isFinite(oLon) ? oLon : (b.minLon + b.maxLon) * 0.5;
  const originLat = Number.isFinite(oLat) ? oLat : (b.minLat + b.maxLat) * 0.5;

  const out = [];
  const floatsPer = 11;
  let segs = 0;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;

  const barrierH = (props) => {
    const b = String(props?.barrier ?? '').toLowerCase();
    if (b === 'wall') return 2.2;
    if (b === 'guard_rail') return 0.9;
    return 1.4; // fence/default
  };
  const barrierCol = (props) => {
    const b = String(props?.barrier ?? '').toLowerCase();
    if (b === 'wall') return [0.55, 0.55, 0.58, 0.95];
    if (b === 'guard_rail') return [0.72, 0.72, 0.76, 0.92];
    return [0.35, 0.40, 0.35, 0.92];
  };

  for (const r of lines) {
    const coords = r.coords;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const props = r.props || null;
    const h = barrierH(props);
    const col = barrierCol(props);
    const yOff = yOffsetFromBridgeTunnelLayer(props);
    const width = 0.22;

    for (let i = 0; i < coords.length - 1; i++) {
      if (segs >= maxSegments) break;
      const a = coords[i], c = coords[i + 1];
      const lon0 = Number(a?.[0]), lat0 = Number(a?.[1]);
      const lon1 = Number(c?.[0]), lat1 = Number(c?.[1]);
      if (!Number.isFinite(lon0) || !Number.isFinite(lat0) || !Number.isFinite(lon1) || !Number.isFinite(lat1)) continue;
      const [x0, z0] = projectLonLatMeters(lon0, lat0, originLon, originLat);
      const [x1, z1] = projectLonLatMeters(lon1, lat1, originLon, originLat);
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      if (!Number.isFinite(len) || len < minSegmentMeters) continue;

      const cx = (x0 + x1) * 0.5;
      const cz = (z0 + z1) * 0.5;
      const yaw = Math.atan2(dx, dz);

      const sy = Math.max(0.04, Number(thicknessMeters) || 0.10);
      const ty = (h * 0.5) + 0.03 + yOff;
      out.push(
        cx, ty, cz,
        width, Math.max(0.3, h), len,
        yaw,
        col[0], col[1], col[2], col[3]
      );

      minX = Math.min(minX, x0, x1);
      maxX = Math.max(maxX, x0, x1);
      minZ = Math.min(minZ, z0, z1);
      maxZ = Math.max(maxZ, z0, z1);
      segs++;
    }
    if (segs >= maxSegments) break;
  }

  const bounds = {
    min: [minX, 0, minZ],
    max: [maxX, 0, maxZ],
    originLonLat: [originLon, originLat],
  };
  return { instances: new Float32Array(out), bounds, segmentCount: segs, floatsPer };
}

export async function loadWgs84PowerLinesGeoJson(url, {
  maxSegments = 300000,
  originLonLat = null,
  lineHeightY = 10.0,
} = {}) {
  const geojson = await fetchJsonMaybeGzip(url);
  const lines = extractRoadLineStrings(geojson);
  if (!lines.length) return { positions: new Float32Array(0), bounds: null, segmentCount: 0 };

  const allLines = lines.map((r) => r.coords);
  const b = computeLonLatBounds(allLines);
  if (!b) return { positions: new Float32Array(0), bounds: null, segmentCount: 0 };

  const oLon = Number(originLonLat?.[0]);
  const oLat = Number(originLonLat?.[1]);
  const originLon = Number.isFinite(oLon) ? oLon : (b.minLon + b.maxLon) * 0.5;
  const originLat = Number.isFinite(oLat) ? oLat : (b.minLat + b.maxLat) * 0.5;

  const yBase = Number(lineHeightY) || 10.0;
  const verts = [];
  let segs = 0;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;

  for (const r of lines) {
    const coords = r.coords;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const props = r.props || null;
    const yOff = yOffsetFromBridgeTunnelLayer(props, { perLayer: 0.65, bridgeBoost: 1.2, tunnelDrop: 1.2 });
    const y = yBase + yOff;
    for (let i = 0; i < coords.length - 1; i++) {
      if (segs >= maxSegments) break;
      const a = coords[i], c = coords[i + 1];
      const lon0 = Number(a?.[0]), lat0 = Number(a?.[1]);
      const lon1 = Number(c?.[0]), lat1 = Number(c?.[1]);
      if (!Number.isFinite(lon0) || !Number.isFinite(lat0) || !Number.isFinite(lon1) || !Number.isFinite(lat1)) continue;
      const [x0, z0] = projectLonLatMeters(lon0, lat0, originLon, originLat);
      const [x1, z1] = projectLonLatMeters(lon1, lat1, originLon, originLat);
      verts.push(x0, y, z0, x1, y, z1);
      minX = Math.min(minX, x0, x1);
      maxX = Math.max(maxX, x0, x1);
      minZ = Math.min(minZ, z0, z1);
      maxZ = Math.max(maxZ, z0, z1);
      segs++;
    }
    if (segs >= maxSegments) break;
  }

  const bounds = {
    min: [minX, 0, minZ],
    max: [maxX, 0, maxZ],
    originLonLat: [originLon, originLat],
  };
  return { positions: new Float32Array(verts), bounds, segmentCount: segs };
}

function sampleTreeRowPointsFromGeojson(geojson, { spacingMeters = 12, originLonLat = null } = {}) {
  /** @type {{ lon: number, lat: number, props: any }[]} */
  const out = [];
  const feats = geojson?.features;
  if (!Array.isArray(feats)) return out;
  const spacing = Math.max(4, Number(spacingMeters) || 12);

  let originLon = Number(originLonLat?.[0]);
  let originLat = Number(originLonLat?.[1]);
  if (!Number.isFinite(originLon) || !Number.isFinite(originLat)) {
    const lines = extractRoadLineStrings(geojson).map((r) => r.coords);
    const b = computeLonLatBounds(lines);
    if (b) { originLon = (b.minLon + b.maxLon) * 0.5; originLat = (b.minLat + b.maxLat) * 0.5; }
  }
  if (!Number.isFinite(originLon) || !Number.isFinite(originLat)) return out;

  for (const f of feats) {
    const g = f?.geometry;
    if (!g) continue;
    const props = f?.properties || null;
    if (String(props?.natural ?? '').toLowerCase() !== 'tree_row') continue;
    const t = g.type;
    const coords = g.coordinates;
    const lines = [];
    if (t === 'LineString' && Array.isArray(coords)) lines.push(coords);
    if (t === 'MultiLineString' && Array.isArray(coords)) for (const ls of coords) if (Array.isArray(ls)) lines.push(ls);
    for (const ls of lines) {
      if (!Array.isArray(ls) || ls.length < 2) continue;
      let acc = 0;
      let last = null;
      for (let i = 0; i < ls.length; i++) {
        const lon = Number(ls[i]?.[0]);
        const lat = Number(ls[i]?.[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        if (!last) {
          out.push({ lon, lat, props });
          last = [lon, lat];
          continue;
        }
        const [x0, z0] = projectLonLatMeters(last[0], last[1], originLon, originLat);
        const [x1, z1] = projectLonLatMeters(lon, lat, originLon, originLat);
        const segLen = Math.hypot(x1 - x0, z1 - z0);
        if (!Number.isFinite(segLen) || segLen <= 1e-6) { last = [lon, lat]; continue; }
        acc += segLen;
        if (acc >= spacing) {
          out.push({ lon, lat, props });
          acc = 0;
        }
        last = [lon, lat];
      }
    }
  }
  return out;
}

export async function loadWgs84TreesGeoJson(url, {
  maxTrees = 40000,
  originLonLat = null,
  sampleTreeRows = true,
  treeRowSpacingMeters = 12,
} = {}) {
  const geojson = await fetchJsonMaybeGzip(url);
  const pts = extractPointFeatures(geojson);
  const extra = sampleTreeRows ? sampleTreeRowPointsFromGeojson(geojson, { spacingMeters: treeRowSpacingMeters, originLonLat }) : [];
  const allPts = pts.concat(extra);
  if (!allPts.length) return { instances: new Float32Array(0), bounds: null, treeCount: 0, floatsPer: 11 };

  const b = computeLonLatBoundsPoints(allPts);
  if (!b) return { instances: new Float32Array(0), bounds: null, treeCount: 0, floatsPer: 11 };

  const oLon = Number(originLonLat?.[0]);
  const oLat = Number(originLonLat?.[1]);
  const originLon = Number.isFinite(oLon) ? oLon : (b.minLon + b.maxLon) * 0.5;
  const originLat = Number.isFinite(oLat) ? oLat : (b.minLat + b.maxLat) * 0.5;

  const out = [];
  const floatsPer = 11;
  let placed = 0;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;

  const trunkCol = [0.32, 0.24, 0.18, 1.0];
  const leafCol = [0.18, 0.45, 0.22, 0.95];

  for (let i = 0; i < allPts.length && placed < maxTrees; i++) {
    const p = allPts[i];
    const [x, z] = projectLonLatMeters(p.lon, p.lat, originLon, originLat);
    const h = 6.0 + (Math.sin((x + z) * 0.01) * 1.5);
    const trunkH = Math.max(2.8, h * 0.55);
    const canopyH = Math.max(2.2, h * 0.55);
    out.push(
      x, trunkH * 0.5 + 0.02, z,
      0.35, trunkH, 0.35,
      0.0,
      trunkCol[0], trunkCol[1], trunkCol[2], trunkCol[3]
    );
    out.push(
      x, trunkH + canopyH * 0.5 + 0.02, z,
      2.8, canopyH, 2.8,
      0.0,
      leafCol[0], leafCol[1], leafCol[2], leafCol[3]
    );
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
    placed++;
  }

  const bounds = {
    min: [minX, 0, minZ],
    max: [maxX, 0, maxZ],
    originLonLat: [originLon, originLat],
  };
  return { instances: new Float32Array(out), bounds, treeCount: placed, floatsPer };
}

export async function loadDatasetManifest(url = 'assets/datasets/manifest.json') {
  const obj = await fetchJsonMaybeGzip(url);
  return obj?.datasets || [];
}

export function resolveDatasetBundle(datasets, id) {
  const byId = new Map();
  for (const d of datasets) byId.set(d.id, d);

  /** @type {string[]} */
  const out = [];
  const seen = new Set(); // prevent cycles

  const visit = (curId) => {
    const key = String(curId || '');
    if (!key) return;
    if (seen.has(key)) return;
    seen.add(key);

    const d = byId.get(key);
    if (!d) return;
    if (d.kind === 'bundle' && Array.isArray(d.bundle)) {
      for (const child of d.bundle) visit(child);
      return;
    }
    out.push(key);
  };

  visit(id);
  return out;
}


