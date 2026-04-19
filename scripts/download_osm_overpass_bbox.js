#!/usr/bin/env node
/**
 * Download OSM data from Overpass for a WGS84 bounding box and write GeoJSON.
 *
 * This is intentionally dependency-free (no osmtogeojson). It focuses on:
 * - roads: ways with "highway"
 * - buildings: closed ways with "building" or "building:part"
 *
 * Example (Hampton Roads preset):
 *   node scripts/download_osm_overpass_bbox.js --preset hampton_roads --kind roads
 *   node scripts/download_osm_overpass_bbox.js --preset hampton_roads --kind buildings
 *   node scripts/download_osm_overpass_bbox.js --preset hampton_roads --kind both
 */
import fs from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const args = { preset: '', kind: 'both', outDir: '', tileDeg: 0.12, sleepMs: 350, maxBuildingFeatures: 30000, maxPropFeatures: 50000, maxRailFeatures: 600000, maxBarrierFeatures: 400000, maxPowerLineFeatures: 400000, maxTreeFeatures: 60000, maxWaterFeatures: 200000 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--preset') args.preset = String(argv[++i] || '');
    else if (a === '--kind') args.kind = String(argv[++i] || 'both');
    else if (a === '--outDir') args.outDir = String(argv[++i] || '');
    else if (a === '--tileDeg') args.tileDeg = Number(argv[++i]);
    else if (a === '--sleepMs') args.sleepMs = Number(argv[++i]);
    else if (a === '--maxBuildingFeatures') args.maxBuildingFeatures = Number(argv[++i]);
    else if (a === '--maxPropFeatures') args.maxPropFeatures = Number(argv[++i]);
    else if (a === '--maxRailFeatures') args.maxRailFeatures = Number(argv[++i]);
    else if (a === '--maxBarrierFeatures') args.maxBarrierFeatures = Number(argv[++i]);
    else if (a === '--maxPowerLineFeatures') args.maxPowerLineFeatures = Number(argv[++i]);
    else if (a === '--maxTreeFeatures') args.maxTreeFeatures = Number(argv[++i]);
    else if (a === '--maxWaterFeatures') args.maxWaterFeatures = Number(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function clamp(n, a, b) {
  const x = Number(n);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function bboxTiles({ minLat, minLon, maxLat, maxLon, tileDeg }) {
  const tiles = [];
  const d = clamp(tileDeg, 0.02, 1.0);
  for (let lat0 = minLat; lat0 < maxLat - 1e-12; lat0 += d) {
    const lat1 = Math.min(maxLat, lat0 + d);
    for (let lon0 = minLon; lon0 < maxLon - 1e-12; lon0 += d) {
      const lon1 = Math.min(maxLon, lon0 + d);
      tiles.push({ minLat: lat0, minLon: lon0, maxLat: lat1, maxLon: lon1 });
    }
  }
  return tiles;
}

function ensureRingClosed(coords) {
  if (!coords.length) return coords;
  const a = coords[0];
  const b = coords[coords.length - 1];
  if (a[0] === b[0] && a[1] === b[1]) return coords;
  return coords.concat([[a[0], a[1]]]);
}

function wayToCoords(way) {
  const g = way?.geometry;
  if (!Array.isArray(g) || g.length < 2) return null;
  const coords = [];
  for (const p of g) {
    const lat = Number(p?.lat);
    const lon = Number(p?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    coords.push([lon, lat]);
  }
  return coords.length >= 2 ? coords : null;
}

function overpassQueryRoadsBBox({ minLat, minLon, maxLat, maxLon }) {
  return `
[out:json][timeout:180];
(
  way["highway"](${minLat},${minLon},${maxLat},${maxLon});
);
out body geom;
`;
}

function overpassQueryBuildingsBBox({ minLat, minLon, maxLat, maxLon }) {
  return `
[out:json][timeout:180];
(
  // Keep this scoped to "interesting" buildings to avoid massive house-scale downloads.
  way["building"]["height"](${minLat},${minLon},${maxLat},${maxLon});
  way["building"]["building:levels"](${minLat},${minLon},${maxLat},${maxLon});
  way["building"~"apartments|commercial|industrial|retail|office|hospital|school|university|college|hotel|parking|warehouse"](${minLat},${minLon},${maxLat},${maxLon});
  way["building:part"]["height"](${minLat},${minLon},${maxLat},${maxLon});
  way["building:part"]["building:levels"](${minLat},${minLon},${maxLat},${maxLon});

  // Important POIs that are often mapped without levels/height
  way["amenity"~"hospital|school|university|college|place_of_worship"](${minLat},${minLon},${maxLat},${maxLon});
  way["shop"](${minLat},${minLon},${maxLat},${maxLon});
  way["office"](${minLat},${minLon},${maxLat},${maxLon});
);
out body geom;
`;
}

function overpassQueryPropsBBox({ minLat, minLon, maxLat, maxLon }) {
  // High-signal node features that add immediate city readability.
  // Keep this intentionally small and "game-feel" oriented.
  return `
[out:json][timeout:180];
(
  node["highway"="traffic_signals"](${minLat},${minLon},${maxLat},${maxLon});
  node["highway"="crossing"](${minLat},${minLon},${maxLat},${maxLon});
  node["highway"="stop"](${minLat},${minLon},${maxLat},${maxLon});
  node["highway"="give_way"](${minLat},${minLon},${maxLat},${maxLon});
  node["traffic_sign"~"stop|give_way"](${minLat},${minLon},${maxLat},${maxLon});
  node["man_made"="street_lamp"](${minLat},${minLon},${maxLat},${maxLon});
  node["highway"="street_lamp"](${minLat},${minLon},${maxLat},${maxLon});
  node["emergency"="fire_hydrant"](${minLat},${minLon},${maxLat},${maxLon});
  node["highway"="bus_stop"](${minLat},${minLon},${maxLat},${maxLon});
  node["public_transport"="platform"](${minLat},${minLon},${maxLat},${maxLon});
  node["amenity"="fuel"](${minLat},${minLon},${maxLat},${maxLon});
  node["amenity"="charging_station"](${minLat},${minLon},${maxLat},${maxLon});
  node["amenity"="parking_entrance"](${minLat},${minLon},${maxLat},${maxLon});
  // Building/Place semantics (POIs) — keep to high-signal categories to avoid huge downloads.
  node["entrance"](${minLat},${minLon},${maxLat},${maxLon});
  node["door"](${minLat},${minLon},${maxLat},${maxLon});

  node["amenity"~"restaurant|cafe|bar|fast_food|pub|bank|atm|pharmacy|hospital|clinic|doctors|dentist|school|university|college|police|fire_station|post_office|library|cinema|theatre|parking|marketplace"](${minLat},${minLon},${maxLat},${maxLon});
  node["shop"~"supermarket|convenience|mall|department_store|clothes|hardware|electronics|bakery|butcher|pharmacy"](${minLat},${minLon},${maxLat},${maxLon});
  node["tourism"~"attraction|museum|hotel|motel|viewpoint|information"](${minLat},${minLon},${maxLat},${maxLon});
  node["leisure"~"park|stadium|sports_centre|pitch|playground"](${minLat},${minLon},${maxLat},${maxLon});
  node["historic"~"monument|memorial"](${minLat},${minLon},${maxLat},${maxLon});
  // Power infrastructure as props
  node["power"="pole"](${minLat},${minLon},${maxLat},${maxLon});
  node["power"="tower"](${minLat},${minLon},${maxLat},${maxLon});
);
out body;
`;
}

function overpassQueryRailsBBox({ minLat, minLon, maxLat, maxLon }) {
  return `
[out:json][timeout:180];
(
  way["railway"](${minLat},${minLon},${maxLat},${maxLon});
);
out body geom;
`;
}

function overpassQueryBarriersBBox({ minLat, minLon, maxLat, maxLon }) {
  return `
[out:json][timeout:180];
(
  way["barrier"~"fence|wall|guard_rail"](${minLat},${minLon},${maxLat},${maxLon});
);
out body geom;
`;
}

function overpassQueryPowerLinesBBox({ minLat, minLon, maxLat, maxLon }) {
  return `
[out:json][timeout:180];
(
  way["power"~"line|minor_line"](${minLat},${minLon},${maxLat},${maxLon});
);
out body geom;
`;
}

function overpassQueryTreesBBox({ minLat, minLon, maxLat, maxLon }) {
  // Trees can be very dense; keep this separate so it can be capped independently.
  return `
[out:json][timeout:180];
(
  node["natural"="tree"](${minLat},${minLon},${maxLat},${maxLon});
  // Tree rows are often mapped as ways; we can sample them client-side into points.
  way["natural"="tree_row"](${minLat},${minLon},${maxLat},${maxLon});
);
out body geom;
`;
}

function overpassQueryWaterBBox({ minLat, minLon, maxLat, maxLon }) {
  // Water polygons + waterways + coastline. We intentionally query *ways* only (dependency-free),
  // which means we miss some multipolygon relations (large lakes/bays). Coastlines/waterways still help a lot visually.
  return `
[out:json][timeout:180];
(
  // Water polygons
  way["natural"="water"](${minLat},${minLon},${maxLat},${maxLon});
  way["natural"="bay"](${minLat},${minLon},${maxLat},${maxLon});
  way["waterway"="riverbank"](${minLat},${minLon},${maxLat},${maxLon});
  way["landuse"="reservoir"](${minLat},${minLon},${maxLat},${maxLon});
  way["water"](${minLat},${minLon},${maxLat},${maxLon});
  way["wetland"](${minLat},${minLon},${maxLat},${maxLon});

  // Water lines
  way["natural"="coastline"](${minLat},${minLon},${maxLat},${maxLon});
  way["waterway"~"river|stream|canal|drain|ditch"](${minLat},${minLon},${maxLat},${maxLon});
);
out body geom;
`;
}

async function fetchOverpass(query) {
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.openstreetmap.ru/api/interpreter',
    'https://overpass.nchc.org.tw/api/interpreter',
  ];

  const maxAttempts = 8;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const url = endpoints[(attempt - 1) % endpoints.length];
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        const retryable = [429, 502, 503, 504].includes(resp.status);
        const err = new Error(`Overpass failed (${url}): ${resp.status} ${resp.statusText}\n${text.slice(0, 400)}`);
        if (!retryable) throw err;
        lastErr = err;
      } else {
        return await resp.json();
      }
    } catch (e) {
      lastErr = e;
    }

    const base = Math.min(20000, 500 * (2 ** (attempt - 1)));
    const jitter = Math.floor(Math.random() * 250);
    const waitMs = base + jitter;
    console.log(`  retrying in ${waitMs}ms (attempt ${attempt}/${maxAttempts})...`);
    await sleep(waitMs);
  }
  throw lastErr || new Error('Overpass failed (unknown error)');
}

function buildFeatureCollectionRoads(elements) {
  /** @type {Map<string, any>} */
  const byId = new Map();
  for (const el of (elements || [])) {
    if (el?.type !== 'way') continue;
    const id = 'way/' + String(el.id);
    const coords = wayToCoords(el);
    if (!coords) continue;
    const tags = el.tags || {};
    const props = { osm_id: id, ...tags };
    byId.set(id, {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: props,
    });
  }
  return { type: 'FeatureCollection', features: Array.from(byId.values()) };
}

function buildFeatureCollectionProps(elements, { maxFeatures = 50000 } = {}) {
  /** @type {Map<string, any>} */
  const byId = new Map();

  const rank = (tags) => {
    const highway = String(tags?.highway ?? '').toLowerCase();
    const manMade = String(tags?.man_made ?? '').toLowerCase();
    const amenity = String(tags?.amenity ?? '').toLowerCase();
    const emergency = String(tags?.emergency ?? '').toLowerCase();
    const trafficSign = String(tags?.traffic_sign ?? '').toLowerCase();
    const publicTransport = String(tags?.public_transport ?? '').toLowerCase();

    if (highway === 'traffic_signals') return 100;
    if (highway === 'street_lamp' || manMade === 'street_lamp') return 90;
    if (highway === 'stop' || trafficSign === 'stop') return 80;
    if (highway === 'give_way' || trafficSign === 'give_way') return 70;
    if (highway === 'bus_stop' || publicTransport === 'platform') return 65;
    if (emergency === 'fire_hydrant') return 60;
    if (highway === 'crossing') return 55;
    if (amenity === 'fuel') return 50;
    if (amenity === 'charging_station') return 45;
    if (amenity === 'parking_entrance') return 40;
    return 0;
  };

  for (const el of (elements || [])) {
    if (el?.type !== 'node') continue;
    const id = 'node/' + String(el.id);
    const lat = Number(el.lat);
    const lon = Number(el.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const tags = el.tags || {};
    const props = { osm_id: id, ...tags, _rank: rank(tags) };
    byId.set(id, {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: props,
    });
  }

  const feats = Array.from(byId.values());
  feats.sort((a, b) => Number(b?.properties?._rank || 0) - Number(a?.properties?._rank || 0));
  const keepN = clamp(maxFeatures, 0, feats.length);
  const kept = feats.slice(0, keepN);
  for (const f of kept) {
    if (f?.properties && ('_rank' in f.properties)) delete f.properties._rank;
  }
  return { type: 'FeatureCollection', features: kept };
}

function approxBboxAreaMetersFromRing(ringLonLat) {
  // Cheap bbox-area approximation in meters^2 (good enough for ranking).
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const pt of ringLonLat) {
    const lon = Number(pt?.[0]);
    const lat = Number(pt?.[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  if (!Number.isFinite(minLon)) return 0;
  const midLat = (minLat + maxLat) * 0.5;
  const R = 6378137.0;
  const dx = (maxLon - minLon) * (Math.PI / 180) * Math.cos(midLat * (Math.PI / 180)) * R;
  const dy = (maxLat - minLat) * (Math.PI / 180) * R;
  return Math.max(0, dx) * Math.max(0, dy);
}

function approxLineLengthMeters(coordsLonLat) {
  // Cheap polyline length approximation in meters (equirectangular around mid-lat).
  if (!Array.isArray(coordsLonLat) || coordsLonLat.length < 2) return 0;
  let minLat = Infinity, maxLat = -Infinity;
  for (const pt of coordsLonLat) {
    const lat = Number(pt?.[1]);
    if (!Number.isFinite(lat)) continue;
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  if (!Number.isFinite(minLat)) return 0;
  const midLat = (minLat + maxLat) * 0.5;
  const R = 6378137.0;
  const kx = (Math.PI / 180) * Math.cos(midLat * (Math.PI / 180)) * R;
  const ky = (Math.PI / 180) * R;
  let len = 0;
  for (let i = 0; i < coordsLonLat.length - 1; i++) {
    const a = coordsLonLat[i];
    const b = coordsLonLat[i + 1];
    const lon0 = Number(a?.[0]), lat0 = Number(a?.[1]);
    const lon1 = Number(b?.[0]), lat1 = Number(b?.[1]);
    if (![lon0, lat0, lon1, lat1].every(Number.isFinite)) continue;
    const dx = (lon1 - lon0) * kx;
    const dy = (lat1 - lat0) * ky;
    len += Math.hypot(dx, dy);
  }
  return len;
}

function buildFeatureCollectionBuildings(elements, { maxFeatures = 30000 } = {}) {
  /** @type {Map<string, any>} */
  const byId = new Map();
  for (const el of (elements || [])) {
    if (el?.type !== 'way') continue;
    const id = 'way/' + String(el.id);
    const coords = wayToCoords(el);
    if (!coords) continue;
    // Need a closed ring for Polygon.
    const ring = ensureRingClosed(coords);
    if (ring.length < 4) continue;
    const tags = el.tags || {};
    const areaApprox = approxBboxAreaMetersFromRing(ring);
    const props = { osm_id: id, ...tags, _areaApprox: areaApprox };
    byId.set(id, {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: props,
    });
  }
  const feats = Array.from(byId.values());
  feats.sort((a, b) => Number(b?.properties?._areaApprox || 0) - Number(a?.properties?._areaApprox || 0));
  const keepN = clamp(maxFeatures, 0, feats.length);
  const kept = feats.slice(0, keepN);
  for (const f of kept) {
    if (f?.properties && ('_areaApprox' in f.properties)) delete f.properties._areaApprox;
  }
  return { type: 'FeatureCollection', features: kept };
}

function buildFeatureCollectionWater(elements, { maxFeatures = 200000 } = {}) {
  /** @type {Map<string, any>} */
  const byId = new Map();

  const looksLikeWaterPolygonTags = (tags) => {
    const natural = String(tags?.natural ?? '').toLowerCase();
    const waterway = String(tags?.waterway ?? '').toLowerCase();
    const landuse = String(tags?.landuse ?? '').toLowerCase();
    const water = String(tags?.water ?? '').toLowerCase();
    const wetland = String(tags?.wetland ?? '').toLowerCase();
    if (natural === 'water' || natural === 'bay') return true;
    if (waterway === 'riverbank') return true;
    if (landuse === 'reservoir') return true;
    if (water) return true;
    if (wetland) return true;
    return false;
  };

  const looksLikeWaterLineTags = (tags) => {
    const natural = String(tags?.natural ?? '').toLowerCase();
    const waterway = String(tags?.waterway ?? '').toLowerCase();
    if (natural === 'coastline') return true;
    if (!waterway) return false;
    return ['river', 'stream', 'canal', 'drain', 'ditch'].includes(waterway);
  };

  for (const el of (elements || [])) {
    if (el?.type !== 'way') continue;
    const id = 'way/' + String(el.id);
    const coords = wayToCoords(el);
    if (!coords) continue;
    const tags = el.tags || {};

    const isClosed = coords.length >= 3 && coords[0][0] === coords[coords.length - 1][0] && coords[0][1] === coords[coords.length - 1][1];
    const isPoly = isClosed && looksLikeWaterPolygonTags(tags);
    const isLine = looksLikeWaterLineTags(tags);
    if (!isPoly && !isLine) continue;

    if (isPoly) {
      const ring = ensureRingClosed(coords);
      if (ring.length < 4) continue;
      const areaApprox = approxBboxAreaMetersFromRing(ring);
      byId.set(id, {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [ring] },
        properties: { osm_id: id, ...tags, _rank: areaApprox },
      });
    } else {
      const lenApprox = approxLineLengthMeters(coords);
      byId.set(id, {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: { osm_id: id, ...tags, _rank: lenApprox },
      });
    }
  }

  const feats = Array.from(byId.values());
  feats.sort((a, b) => Number(b?.properties?._rank || 0) - Number(a?.properties?._rank || 0));
  const keepN = clamp(maxFeatures, 0, feats.length);
  const kept = feats.slice(0, keepN);
  for (const f of kept) {
    if (f?.properties && ('_rank' in f.properties)) delete f.properties._rank;
  }
  return { type: 'FeatureCollection', features: kept };
}

function presets() {
  return {
    // Hampton Roads metro area: VB/Chesapeake/Norfolk/Portsmouth/Suffolk/Hampton/Newport News.
    // You can tweak this bbox if you want tighter/looser coverage.
    hampton_roads: {
      name: 'va_hampton_roads',
      bbox: { minLat: 36.52, minLon: -76.95, maxLat: 37.36, maxLon: -75.68 },
    },
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.preset) {
    console.log(`Usage:
  node scripts/download_osm_overpass_bbox.js --preset hampton_roads --kind roads|buildings|props|rails|barriers|powerlines|trees|water|both|all [--tileDeg 0.12] [--sleepMs 350] [--outDir assets/datasets/osm_va_hampton_roads]
  node scripts/download_osm_overpass_bbox.js --preset hampton_roads --kind buildings [--maxBuildingFeatures 30000]
  node scripts/download_osm_overpass_bbox.js --preset hampton_roads --kind props [--maxPropFeatures 50000]
  node scripts/download_osm_overpass_bbox.js --preset hampton_roads --kind rails [--maxRailFeatures 600000]
  node scripts/download_osm_overpass_bbox.js --preset hampton_roads --kind barriers [--maxBarrierFeatures 400000]
  node scripts/download_osm_overpass_bbox.js --preset hampton_roads --kind powerlines [--maxPowerLineFeatures 400000]
  node scripts/download_osm_overpass_bbox.js --preset hampton_roads --kind trees [--maxTreeFeatures 60000]
  node scripts/download_osm_overpass_bbox.js --preset hampton_roads --kind water [--maxWaterFeatures 200000]
`);
    process.exit(args.help ? 0 : 1);
  }

  const ps = presets();
  const p = ps[args.preset];
  if (!p) throw new Error(`Unknown preset "${args.preset}". Known: ${Object.keys(ps).join(', ')}`);

  const { minLat, minLon, maxLat, maxLon } = p.bbox;
  const outDir = args.outDir || `assets/datasets/osm_va_hampton_roads`;
  const outAbs = path.resolve(process.cwd(), outDir);
  await fs.mkdir(outAbs, { recursive: true });

  const tiles = bboxTiles({ minLat, minLon, maxLat, maxLon, tileDeg: args.tileDeg });
  console.log(`Preset=${args.preset} tiles=${tiles.length} tileDeg=${args.tileDeg} outDir=${outDir}`);

  const wantsRoads = args.kind === 'roads' || args.kind === 'both' || args.kind === 'all';
  const wantsBuildings = args.kind === 'buildings' || args.kind === 'both' || args.kind === 'all';
  const wantsProps = args.kind === 'props' || args.kind === 'all';
  const wantsRails = args.kind === 'rails' || args.kind === 'all';
  const wantsBarriers = args.kind === 'barriers' || args.kind === 'all';
  const wantsPowerLines = args.kind === 'powerlines' || args.kind === 'all';
  const wantsTrees = args.kind === 'trees' || args.kind === 'all';
  const wantsWater = args.kind === 'water' || args.kind === 'all';

  /** @type {any[]} */
  const roadEls = [];
  /** @type {any[]} */
  const bldgEls = [];
  /** @type {any[]} */
  const propEls = [];
  /** @type {any[]} */
  const railEls = [];
  /** @type {any[]} */
  const barrierEls = [];
  /** @type {any[]} */
  const powerLineEls = [];
  /** @type {any[]} */
  const treeEls = [];
  /** @type {any[]} */
  const waterEls = [];

  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const label = `tile ${i + 1}/${tiles.length} (${t.minLat.toFixed(3)},${t.minLon.toFixed(3)})-(${t.maxLat.toFixed(3)},${t.maxLon.toFixed(3)})`;
    console.log(`Fetching ${label}...`);

    if (wantsRoads) {
      const q = overpassQueryRoadsBBox(t);
      const j = await fetchOverpass(q);
      if (Array.isArray(j?.elements)) roadEls.push(...j.elements);
      console.log(`  roads: +${Array.isArray(j?.elements) ? j.elements.length : 0}`);
      await sleep(args.sleepMs);
    }

    if (wantsBuildings) {
      const q = overpassQueryBuildingsBBox(t);
      const j = await fetchOverpass(q);
      if (Array.isArray(j?.elements)) bldgEls.push(...j.elements);
      console.log(`  buildings: +${Array.isArray(j?.elements) ? j.elements.length : 0}`);
      await sleep(args.sleepMs);
    }

    if (wantsProps) {
      const q = overpassQueryPropsBBox(t);
      const j = await fetchOverpass(q);
      if (Array.isArray(j?.elements)) propEls.push(...j.elements);
      console.log(`  props: +${Array.isArray(j?.elements) ? j.elements.length : 0}`);
      await sleep(args.sleepMs);
    }

    if (wantsRails) {
      const q = overpassQueryRailsBBox(t);
      const j = await fetchOverpass(q);
      if (Array.isArray(j?.elements)) railEls.push(...j.elements);
      console.log(`  rails: +${Array.isArray(j?.elements) ? j.elements.length : 0}`);
      await sleep(args.sleepMs);
    }

    if (wantsBarriers) {
      const q = overpassQueryBarriersBBox(t);
      const j = await fetchOverpass(q);
      if (Array.isArray(j?.elements)) barrierEls.push(...j.elements);
      console.log(`  barriers: +${Array.isArray(j?.elements) ? j.elements.length : 0}`);
      await sleep(args.sleepMs);
    }

    if (wantsPowerLines) {
      const q = overpassQueryPowerLinesBBox(t);
      const j = await fetchOverpass(q);
      if (Array.isArray(j?.elements)) powerLineEls.push(...j.elements);
      console.log(`  powerlines: +${Array.isArray(j?.elements) ? j.elements.length : 0}`);
      await sleep(args.sleepMs);
    }

    if (wantsTrees) {
      const q = overpassQueryTreesBBox(t);
      const j = await fetchOverpass(q);
      if (Array.isArray(j?.elements)) treeEls.push(...j.elements);
      console.log(`  trees: +${Array.isArray(j?.elements) ? j.elements.length : 0}`);
      await sleep(args.sleepMs);
    }

    if (wantsWater) {
      const q = overpassQueryWaterBBox(t);
      const j = await fetchOverpass(q);
      if (Array.isArray(j?.elements)) waterEls.push(...j.elements);
      console.log(`  water: +${Array.isArray(j?.elements) ? j.elements.length : 0}`);
      await sleep(args.sleepMs);
    }
  }

  if (wantsRoads) {
    const fc = buildFeatureCollectionRoads(roadEls);
    const outPath = path.join(outAbs, `${p.name}_highways.geojson`);
    await fs.writeFile(outPath, JSON.stringify(fc));
    console.log(`Wrote ${outPath} features=${fc.features.length}`);
  }

  if (wantsBuildings) {
    const fc = buildFeatureCollectionBuildings(bldgEls, { maxFeatures: args.maxBuildingFeatures });
    const outPath = path.join(outAbs, `${p.name}_buildings.geojson`);
    await fs.writeFile(outPath, JSON.stringify(fc));
    console.log(`Wrote ${outPath} features=${fc.features.length}`);
  }

  if (wantsProps) {
    const fc = buildFeatureCollectionProps(propEls, { maxFeatures: args.maxPropFeatures });
    const outPath = path.join(outAbs, `${p.name}_props.geojson`);
    await fs.writeFile(outPath, JSON.stringify(fc));
    console.log(`Wrote ${outPath} features=${fc.features.length}`);
  }

  if (wantsRails) {
    const fc = buildFeatureCollectionRoads(railEls);
    // Cap rails by count to avoid pathological downloads.
    const keepN = clamp(args.maxRailFeatures, 0, fc.features.length);
    fc.features = fc.features.slice(0, keepN);
    const outPath = path.join(outAbs, `${p.name}_rails.geojson`);
    await fs.writeFile(outPath, JSON.stringify(fc));
    console.log(`Wrote ${outPath} features=${fc.features.length}`);
  }

  if (wantsBarriers) {
    const fc = buildFeatureCollectionRoads(barrierEls);
    const keepN = clamp(args.maxBarrierFeatures, 0, fc.features.length);
    fc.features = fc.features.slice(0, keepN);
    const outPath = path.join(outAbs, `${p.name}_barriers.geojson`);
    await fs.writeFile(outPath, JSON.stringify(fc));
    console.log(`Wrote ${outPath} features=${fc.features.length}`);
  }

  if (wantsPowerLines) {
    const fc = buildFeatureCollectionRoads(powerLineEls);
    const keepN = clamp(args.maxPowerLineFeatures, 0, fc.features.length);
    fc.features = fc.features.slice(0, keepN);
    const outPath = path.join(outAbs, `${p.name}_powerlines.geojson`);
    await fs.writeFile(outPath, JSON.stringify(fc));
    console.log(`Wrote ${outPath} features=${fc.features.length}`);
  }

  if (wantsTrees) {
    // Mixed node+way results; write as GeoJSON Point features for nodes plus LineString for tree_row ways.
    /** @type {Map<string, any>} */
    const byId = new Map();
    for (const el of (treeEls || [])) {
      if (el?.type === 'node') {
        const id = 'node/' + String(el.id);
        const lat = Number(el.lat);
        const lon = Number(el.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const tags = el.tags || {};
        byId.set(id, { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { osm_id: id, ...tags } });
      } else if (el?.type === 'way') {
        const id = 'way/' + String(el.id);
        const coords = wayToCoords(el);
        if (!coords) continue;
        const tags = el.tags || {};
        byId.set(id, { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { osm_id: id, ...tags } });
      }
    }
    const feats = Array.from(byId.values());
    const keepN = clamp(args.maxTreeFeatures, 0, feats.length);
    const fc = { type: 'FeatureCollection', features: feats.slice(0, keepN) };
    const outPath = path.join(outAbs, `${p.name}_trees.geojson`);
    await fs.writeFile(outPath, JSON.stringify(fc));
    console.log(`Wrote ${outPath} features=${fc.features.length}`);
  }

  if (wantsWater) {
    const maxWaterFeatures = Number.isFinite(Number(args.maxWaterFeatures)) ? Number(args.maxWaterFeatures) : 200000;
    const fc = buildFeatureCollectionWater(waterEls, { maxFeatures: maxWaterFeatures });
    const outPath = path.join(outAbs, `${p.name}_water.geojson`);
    await fs.writeFile(outPath, JSON.stringify(fc));
    console.log(`Wrote ${outPath} features=${fc.features.length}`);
  }
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});


