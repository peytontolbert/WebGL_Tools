import { clamp } from '../ui/dom.js';
import { generateAiCity, generateAiCityWfc } from './procedural_ai_city.js';
import { buildRoomSimPenthouseLayout } from '../shared/room_sim_penthouse_layout.js';
import { DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS, ROOM_SIM_PENTHOUSE_BUILDING_ASSET_PATH } from '../shared/room_sim_penthouse_defaults.js';

const LS_INDEX_KEY = 'webgl.editor.maps.index.v1';
const LS_MAP_PREFIX = 'webgl.editor.map.v1.'; // + id

function randId() {
  // Short, human-ish id.
  return 'map_' + Math.random().toString(36).slice(2, 8) + '_' + Date.now().toString(36).slice(-4);
}

function nowIso() {
  return new Date().toISOString();
}

function safeParseJson(s) {
  try { return JSON.parse(String(s || '')); } catch { return null; }
}

function abToB64(ab) {
  const bytes = new Uint8Array(ab);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function b64ToAb(b64) {
  const bin = atob(String(b64 || ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 255;
  return bytes.buffer;
}

function serializeTypedArray(ta) {
  if (!ta) return null;
  return { type: ta.constructor.name, b64: abToB64(ta.buffer), byteOffset: ta.byteOffset, byteLength: ta.byteLength };
}

function deserializeTypedArray(obj) {
  if (!obj || !obj.b64 || !obj.type) return null;
  const ab = b64ToAb(obj.b64);
  const off = obj.byteOffset || 0;
  const len = obj.byteLength || (ab.byteLength - off);
  const slice = ab.slice(off, off + len);
  switch (obj.type) {
    case 'Uint8Array': return new Uint8Array(slice);
    case 'Uint16Array': return new Uint16Array(slice);
    case 'Float32Array': return new Float32Array(slice);
    default: return null;
  }
}

function makeAiCityMap({ name = 'AI City', seed = 'ai_city' } = {}) {
  const gen = generateAiCity({ seed, gridW: 100, gridH: 100 });
  return {
    id: randId(),
    name,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    templateId: 'ai_city',
    bounds: gen.bounds,
    grid: gen.grid,
    dataset: { enabled: false, datasetId: '', fitToBounds: true },
    legacy: { kind: '' },
    ai: gen.ai,
    data: {
      heightsU16: gen.heightsU16,
      paintMaskRgba: gen.paintMaskRgba,
      instances: gen.instances,
    },
  };
}

function makeAiCityWfcMap({ name = 'AI City (WFC)', seed = 'ai_city_wfc' } = {}) {
  const gen = generateAiCityWfc({ seed, gridW: 100, gridH: 100 });
  return {
    id: randId(),
    name,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    templateId: 'ai_city_wfc',
    bounds: gen.bounds,
    grid: gen.grid,
    dataset: { enabled: false, datasetId: '', fitToBounds: true },
    legacy: { kind: '' },
    ai: gen.ai,
    data: {
      heightsU16: gen.heightsU16,
      paintMaskRgba: gen.paintMaskRgba,
      instances: gen.instances,
    },
  };
}

function makeRichmondOsmMap({ name = 'Richmond (OSM)' } = {}) {
  const w = 100;
  const h = 100;
  const heights = new Uint16Array(w * h);
  const mask = new Uint8Array(w * h * 4);
  const instances = [];

  // Flat seed: real-world dataset will define the interesting structure first.
  for (let i = 0; i < heights.length; i++) heights[i] = 0;
  for (let i = 0; i < w * h; i++) {
    const bi = i * 4;
    mask[bi + 0] = 255; mask[bi + 1] = 0; mask[bi + 2] = 0; mask[bi + 3] = 0;
  }

  return {
    id: randId(),
    name,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    templateId: 'richmond_osm',
    // Temporary bounds; EditorApp will optionally replace XY bounds with dataset bounds when it loads.
    bounds: { minX: -500, minY: -500, minZ: 0, maxX: 500, maxY: 500, maxZ: 20 },
    grid: { width: w, height: h },
    dataset: {
      enabled: true,
      datasetId: 'osm_va_richmond_small_scene',
      fitToBounds: true,
    },
    legacy: { kind: '' },
    data: { heightsU16: heights, paintMaskRgba: mask, instances },
  };
}

function makeHamptonRoadsOsmMap({ name = 'Hampton Roads (OSM)' } = {}) {
  const w = 100;
  const h = 100;
  const heights = new Uint16Array(w * h);
  const mask = new Uint8Array(w * h * 4);
  const instances = [];

  // Flat seed: real-world dataset will define the interesting structure first.
  for (let i = 0; i < heights.length; i++) heights[i] = 0;
  for (let i = 0; i < w * h; i++) {
    const bi = i * 4;
    mask[bi + 0] = 255; mask[bi + 1] = 0; mask[bi + 2] = 0; mask[bi + 3] = 0;
  }

  return {
    id: randId(),
    name,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    templateId: 'hampton_roads_osm',
    // Render a larger "Virginia" ground plane while keeping dataset loading scoped to Hampton Roads.
    // (Used by EditorApp to override map.bounds after dataset origin is known.)
    worldBboxWgs84: { minLon: -83.6753, minLat: 36.5407, maxLon: -75.2420, maxLat: 39.4660 },
    // Temporary bounds; EditorApp will optionally replace XY bounds with dataset bounds when it loads.
    bounds: { minX: -500, minY: -500, minZ: 0, maxX: 500, maxY: 500, maxZ: 20 },
    grid: { width: w, height: h },
    dataset: {
      enabled: true,
      // Full Hampton Roads (all cities): roads + buildings. Rendering is camera-streamed in the editor to stay usable.
      datasetId: 'osm_va_hampton_roads_cities_scene_va_outline',
      fitToBounds: true,
    },
    legacy: { kind: '' },
    data: { heightsU16: heights, paintMaskRgba: mask, instances },
  };
}

function makeHamptonRoadsOsmRoadsOvertureBuildingsMap({ name = 'Hampton Roads (OSM roads + Overture buildings)' } = {}) {
  const w = 100;
  const h = 100;
  const heights = new Uint16Array(w * h);
  const mask = new Uint8Array(w * h * 4);
  const instances = [];

  // Flat seed: real-world dataset will define the interesting structure first.
  for (let i = 0; i < heights.length; i++) heights[i] = 0;
  for (let i = 0; i < w * h; i++) {
    const bi = i * 4;
    mask[bi + 0] = 255; mask[bi + 1] = 0; mask[bi + 2] = 0; mask[bi + 3] = 0;
  }

  return {
    id: randId(),
    name,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    templateId: 'hampton_roads_osm_overture',
    // Render a larger "Virginia" ground plane while keeping dataset loading scoped to Hampton Roads.
    worldBboxWgs84: { minLon: -83.6753, minLat: 36.5407, maxLon: -75.2420, maxLat: 39.4660 },
    // Temporary bounds; EditorApp will optionally replace XY bounds with dataset bounds when it loads.
    bounds: { minX: -500, minY: -500, minZ: 0, maxX: 500, maxY: 500, maxZ: 20 },
    grid: { width: w, height: h },
    dataset: {
      enabled: true,
      datasetId: 'osm_va_hampton_roads_cities_osm_roads_overture_buildings_va_outline',
      fitToBounds: true,
    },
    legacy: { kind: '' },
    data: { heightsU16: heights, paintMaskRgba: mask, instances },
  };
}

function makeRoomSimMap({ name = 'Room Sim (Penthouse)', seed = 'room_sim_v1' } = {}) {
  // A compact, flat indoor-ish map. Geometry is authored as instance boxes.
  const w = 64;
  const h = 64;
  const heights = new Uint16Array(w * h);
  const mask = new Uint8Array(w * h * 4);

  // Flat ground.
  for (let i = 0; i < heights.length; i++) heights[i] = 0;
  // Paint everything as "street" (arbitrary, but makes it visually distinct from grass).
  for (let i = 0; i < w * h; i++) {
    const bi = i * 4;
    mask[bi + 0] = 0; mask[bi + 1] = 0; mask[bi + 2] = 0; mask[bi + 3] = 255;
  }

  /** @type {any[]} */
  const layout = buildRoomSimPenthouseLayout(DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS);
  const instances = Array.isArray(layout?.instances) ? layout.instances : [];
  const b = layout?.bounds || { minX: -40, maxX: 40, minY: -20, maxY: 20, minZ: 0, maxZ: 4 };

  return {
    id: randId(),
    name,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    templateId: 'room_sim',
    bounds: { minX: b.minX, minY: b.minY, minZ: b.minZ ?? 0, maxX: b.maxX, maxY: b.maxY, maxZ: b.maxZ ?? 4 },
    grid: { width: w, height: h },
    dataset: { enabled: false, datasetId: '', fitToBounds: true },
    legacy: { kind: '' },
    ai: { seed },
    // Optional: runtime can load/override layout from this building asset.
    roomSim: { schema: 1, buildingAssetPath: ROOM_SIM_PENTHOUSE_BUILDING_ASSET_PATH },
    data: { heightsU16: heights, paintMaskRgba: mask, instances },
  };
}

export class MapStore {
  constructor() {
    this.maxMaps = 5;
    this._ensureIndex();
    this._ensureExampleExists();
  }

  _ensureIndex() {
    const raw = localStorage.getItem(LS_INDEX_KEY);
    if (!raw) localStorage.setItem(LS_INDEX_KEY, JSON.stringify({ version: 1, ids: [] }));
  }

  _readIndex() {
    const obj = safeParseJson(localStorage.getItem(LS_INDEX_KEY));
    if (!obj || !Array.isArray(obj.ids)) return { version: 1, ids: [] };
    return obj;
  }

  _writeIndex(ids) {
    localStorage.setItem(LS_INDEX_KEY, JSON.stringify({ version: 1, ids: ids.slice(0, this.maxMaps) }));
  }

  _ensureExampleExists() {
    const ids = this._readIndex().ids;
    if (ids.length) return;
    const m = makeAiCityMap({ name: 'AI City' });
    this.saveMap(m);
  }

  listMaps() {
    const ids = this._readIndex().ids;
    const out = [];
    for (const id of ids) {
      const m = this.loadMap(id);
      if (m) out.push({ id: m.id, name: m.name, createdAt: m.createdAt, updatedAt: m.updatedAt, templateId: m.templateId, dataset: m.dataset, legacy: m.legacy });
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return out;
  }

  createMapFromTemplate(templateId) {
    if (this._readIndex().ids.length >= this.maxMaps) throw new Error('Map limit reached');
    // Back-compat: older UI used this mixed name; treat as a Richmond real-world map.
    if (templateId === 'ai_city_richmond_osm') return makeRichmondOsmMap({ name: 'Richmond (OSM)' });
    if (templateId === 'ai_city_wfc') return makeAiCityWfcMap({ name: 'AI City (WFC)' });
    if (templateId === 'richmond_osm') return makeRichmondOsmMap({ name: 'Richmond (OSM)' });
    if (templateId === 'hampton_roads_osm') return makeHamptonRoadsOsmMap({ name: 'Hampton Roads (OSM)' });
    if (templateId === 'hampton_roads_osm_overture') return makeHamptonRoadsOsmRoadsOvertureBuildingsMap({ name: 'Hampton Roads (OSM roads + Overture buildings)' });
    if (templateId === 'room_sim') return makeRoomSimMap({ name: 'Room Sim (Penthouse)' });
    return makeAiCityMap({ name: 'AI City' });
  }

  saveMap(map) {
    if (!map || !map.id) return false;
    const ids = this._readIndex().ids.slice();
    if (!ids.includes(map.id)) {
      if (ids.length >= this.maxMaps) return false;
      ids.push(map.id);
    }
    map.updatedAt = nowIso();

    const payload = {
      id: map.id,
      name: map.name || map.id,
      createdAt: map.createdAt || nowIso(),
      updatedAt: map.updatedAt,
      templateId: map.templateId || '',
      bounds: map.bounds,
      worldBboxWgs84: map.worldBboxWgs84 || null,
      grid: map.grid,
      dataset: map.dataset || { enabled: false, datasetId: '', fitToBounds: true },
      legacy: map.legacy || { kind: '' },
      ai: map.ai || null,
      data: {
        heightsU16: serializeTypedArray(map.data?.heightsU16),
        paintMaskRgba: serializeTypedArray(map.data?.paintMaskRgba),
        instances: Array.isArray(map.data?.instances) ? map.data.instances : [],
      },
    };
    localStorage.setItem(LS_MAP_PREFIX + map.id, JSON.stringify(payload));
    this._writeIndex(ids);
    return true;
  }

  loadMap(id) {
    const obj = safeParseJson(localStorage.getItem(LS_MAP_PREFIX + id));
    if (!obj || !obj.id) return null;
    const heightsU16 = deserializeTypedArray(obj.data?.heightsU16);
    const paintMaskRgba = deserializeTypedArray(obj.data?.paintMaskRgba);
    return {
      ...obj,
      data: {
        heightsU16: (heightsU16 instanceof Uint16Array) ? heightsU16 : new Uint16Array(100 * 100),
        paintMaskRgba: (paintMaskRgba instanceof Uint8Array) ? paintMaskRgba : new Uint8Array(100 * 100 * 4),
        instances: Array.isArray(obj.data?.instances) ? obj.data.instances : [],
      },
    };
  }

  deleteMap(id) {
    localStorage.removeItem(LS_MAP_PREFIX + id);
    const ids = this._readIndex().ids.filter((x) => x !== id);
    this._writeIndex(ids);
  }

  detectLegacyGtaAssets() {
    // Cheap heuristic: these are present in the copied GTA viewer exports.
    try {
      // We can't FS-scan in the browser; rely on build-time packaging and a known URL.
      // If fetch fails quickly, treat as missing.
      return true;
    } catch {
      return false;
    }
  }
}


