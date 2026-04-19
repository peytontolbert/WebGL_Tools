import { getGl, isWebGL2 } from './gl.js';
import { Camera } from './camera.js';
import { TerrainRenderer } from './terrain_renderer.js';
import { WaterRenderer } from './water_renderer.js';
import { WaterMeshRenderer } from './water_mesh_renderer.js';
import { LinesRenderer } from './lines_renderer.js';
import { SkyRenderer } from './sky_renderer.js';
import { PostFxRenderer } from './postfx_renderer.js';
import { loadDatasetManifest, resolveDatasetBundle, loadWgs84LineGeoJson, loadWgs84BuildingsGeoJson, loadWgs84BuildingFootprintsGeoJson, loadWgs84RoadsGeoJson, loadWgs84RoadLabelsGeoJson, loadWgs84PropsGeoJson, loadWgs84WaterGeoJson, loadWgs84RailsGeoJson, loadWgs84BarriersGeoJson, loadWgs84PowerLinesGeoJson, loadWgs84TreesGeoJson } from './osm_loader.js';
import { loadHeightmapU16 } from './heightmap_loader.js';
import { InstancedBoxRenderer } from './instanced_box_renderer.js';
import { InstancedBoxTilesRenderer } from './instanced_box_tiles_renderer.js';
import { InstancedTilesStreamer } from './instanced_tiles_streamer.js';
import { ExtrudedBuildingsRenderer, buildExtrudedBuildingsMesh } from './extruded_buildings_renderer.js';
import { BuildingFootprintsTilesStreamer } from './building_footprints_tiles_streamer.js';
import { generateIndoorFloorplan, buildIndoorDebugLinesFromFloorplan } from './indoor_floorplan_generator.js';
import { generateAiCity, generateAiCityWfc } from './procedural_ai_city.js';
import { PlayerController } from './player_controller.js';
import { MmoClient } from './mmo_client.js';
import { ThreeAvatarLayer } from './three_avatar_layer.js';
import { ThreeModelLayer } from './three_model_layer.js';
import { InteractionManager, buildInteractablesFromInstances } from './interaction_manager.js';
import { el, clear, clamp } from '../ui/dom.js';
import { DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS, mergeRoomSimPenthouseParams } from '../shared/room_sim_penthouse_defaults.js';
import { buildRoomSimPenthouseLayout } from '../shared/room_sim_penthouse_layout.js';
import { mat4, vec4 } from 'gl-matrix';

function extractCityFromDatasetLabel(label) {
  const s = String(label || '').trim();
  if (!s) return '';
  const i0 = s.indexOf('(');
  const i1 = s.indexOf(')', i0 + 1);
  if (i0 >= 0 && i1 > i0 + 1) return s.slice(i0 + 1, i1).trim();
  return '';
}

// Rough city bounding boxes (WGS84) for "Hampton Roads cities" mode.
// These are used only to pick the *current* city label for the camera.
const HAMPTON_ROADS_CITY_BBOX_WGS84 = [
  { name: 'Virginia Beach', bb: { minLon: -76.35, minLat: 36.65, maxLon: -75.86, maxLat: 36.97 } },
  { name: 'Chesapeake', bb: { minLon: -76.65, minLat: 36.50, maxLon: -76.05, maxLat: 36.86 } },
  { name: 'Norfolk', bb: { minLon: -76.36, minLat: 36.84, maxLon: -76.16, maxLat: 36.97 } },
  { name: 'Portsmouth', bb: { minLon: -76.45, minLat: 36.78, maxLon: -76.28, maxLat: 36.90 } },
  { name: 'Suffolk', bb: { minLon: -76.95, minLat: 36.55, maxLon: -76.30, maxLat: 37.16 } },
  { name: 'Hampton', bb: { minLon: -76.40, minLat: 37.00, maxLon: -76.20, maxLat: 37.10 } },
  { name: 'Newport News', bb: { minLon: -76.70, minLat: 36.93, maxLon: -76.38, maxLat: 37.18 } },
];

function hamptonRoadsCityAtXZ(x, z, originLonLat) {
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(z))) return '';
  const mb0 = computeMeterBoundsFromWgs84Bbox(HAMPTON_ROADS_CITY_BBOX_WGS84[0]?.bb, originLonLat);
  if (!mb0) return '';

  const px = Number(x);
  const pz = Number(z);
  /** @type {{ name: string, area: number }|null} */
  let bestInside = null;
  /** @type {{ name: string, d2: number }|null} */
  let bestNear = null;

  for (const c of HAMPTON_ROADS_CITY_BBOX_WGS84) {
    const mb = computeMeterBoundsFromWgs84Bbox(c.bb, originLonLat);
    if (!mb) continue;
    const minX = Number(mb.minX), maxX = Number(mb.maxX), minZ = Number(mb.minY), maxZ = Number(mb.maxY);
    const inside = (px >= minX && px <= maxX && pz >= minZ && pz <= maxZ);
    if (inside) {
      const area = Math.max(1, (maxX - minX) * (maxZ - minZ));
      if (!bestInside || area < bestInside.area) bestInside = { name: c.name, area };
      continue;
    }
    const dx = (px < minX) ? (minX - px) : ((px > maxX) ? (px - maxX) : 0);
    const dz = (pz < minZ) ? (minZ - pz) : ((pz > maxZ) ? (pz - maxZ) : 0);
    const d2 = dx * dx + dz * dz;
    if (!bestNear || d2 < bestNear.d2) bestNear = { name: c.name, d2 };
  }

  if (bestInside) return bestInside.name;
  // If we're outside all bboxes (e.g. over water), still pick the nearest city when reasonably close.
  if (bestNear && Math.sqrt(bestNear.d2) < 35000) return bestNear.name; // 35km
  return '';
}

function prettyRegionFromDataset(dsId, extractedCity) {
  const id = String(dsId || '').trim();
  const city = String(extractedCity || '').trim();
  // Hampton Roads "cities" bundle is intentionally metro-wide; surface the actual city set.
  if (city.toLowerCase() === 'hampton roads cities' || id.includes('hampton_roads_cities')) {
    return 'Virginia Beach · Chesapeake · Norfolk · Portsmouth · Suffolk · Hampton · Newport News';
  }
  return '';
}

function toRad(deg) {
  return (Number(deg) || 0) * Math.PI / 180;
}

function normDeg360(deg) {
  const d = Number(deg) || 0;
  return ((d % 360) + 360) % 360;
}

function angularDiffDeg(a, b) {
  // Smallest difference in degrees, in [0..180].
  const da = normDeg360(a);
  const db = normDeg360(b);
  const d = ((da - db + 540) % 360) - 180;
  return Math.abs(d);
}

function cardinal8FromDeg(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const d = normDeg360(deg);
  const i = Math.round(d / 45) % 8;
  return dirs[i] || 'N';
}

// Equirectangular projection around a chosen origin (matches `osm_loader.js`).
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

function downsampleU16Nearest(srcU16, srcW, srcH, dstW, dstH) {
  const sw = Math.max(2, Number(srcW) | 0);
  const sh = Math.max(2, Number(srcH) | 0);
  const dw = Math.max(2, Number(dstW) | 0);
  const dh = Math.max(2, Number(dstH) | 0);
  if (!(srcU16 instanceof Uint16Array) || srcU16.length < sw * sh) return new Uint16Array(dw * dh);
  if (sw === dw && sh === dh) return srcU16;
  const out = new Uint16Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.max(0, Math.round((y / (dh - 1)) * (sh - 1))));
    const rowS = sy * sw;
    const rowD = y * dw;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.max(0, Math.round((x / (dw - 1)) * (sw - 1))));
      out[rowD + x] = srcU16[rowS + sx] || 0;
    }
  }
  return out;
}

function heightmapSampleSource(map) {
  const hw = Number(map?.heightmap?.fullGrid?.width);
  const hh = Number(map?.heightmap?.fullGrid?.height);
  const hu16 = map?.heightmap?.heightsU16Full;
  if (Number.isFinite(hw) && Number.isFinite(hh) && hw > 1 && hh > 1 && (hu16 instanceof Uint16Array) && hu16.length >= hw * hh) {
    return { w: hw | 0, h: hh | 0, u16: hu16 };
  }
  const w = Number(map?.grid?.width);
  const h = Number(map?.grid?.height);
  const u16 = map?.data?.heightsU16;
  return { w: (w | 0) || 2, h: (h | 0) || 2, u16: (u16 instanceof Uint16Array) ? u16 : new Uint16Array(Math.max(4, ((w | 0) || 2) * ((h | 0) || 2))) };
}

function pickCellFromWorld(map, x, z) {
  const b = heightmapXYBounds(map);
  const src = heightmapSampleSource(map);
  const w = src.w;
  const h = src.h;
  const u = (x - b.minX) / Math.max(1e-6, (b.maxX - b.minX));
  // Heightmap storage is row-major, top-to-bottom (north -> south).
  // Our world Z increases north (lat increases), so "top row" corresponds to maxY.
  const v = (b.maxY - z) / Math.max(1e-6, (b.maxY - b.minY));
  const ix = Math.round(clamp(u, 0, 1) * (w - 1));
  const iy = Math.round(clamp(v, 0, 1) * (h - 1));
  return { ix, iy };
}

function heightAtCell(map, ix, iy) {
  const src = heightmapSampleSource(map);
  const w = src.w;
  const h = src.h;
  const x = clamp(ix, 0, w - 1);
  const y = clamp(iy, 0, h - 1);
  const u16 = src.u16[y * w + x] || 0;
  const height01 = u16 / 65535.0;
  const s = Number(map?._elevation?.heightScale ?? 1.0);
  const hs = (Number.isFinite(s) && s > 0) ? s : 1.0;
  return map.bounds.minZ + height01 * (map.bounds.maxZ - map.bounds.minZ) * hs;
}

function computeHeightmapMeterBoundsFromBbox(map, originLonLat) {
  const bb = map?.heightmap?.bbox;
  const olon = Number(originLonLat?.[0]);
  const olat = Number(originLonLat?.[1]);
  if (!bb || !Number.isFinite(olon) || !Number.isFinite(olat)) return null;
  const minLon = Number(bb.minLon);
  const minLat = Number(bb.minLat);
  const maxLon = Number(bb.maxLon);
  const maxLat = Number(bb.maxLat);
  if (![minLon, minLat, maxLon, maxLat].every((v) => Number.isFinite(v))) return null;
  const [x0, z0] = projectLonLatMeters(minLon, minLat, olon, olat);
  const [x1, z1] = projectLonLatMeters(maxLon, maxLat, olon, olat);
  const out = {
    minX: Math.min(x0, x1),
    maxX: Math.max(x0, x1),
    minY: Math.min(z0, z1),
    maxY: Math.max(z0, z1),
    originLonLat: [olon, olat],
  };
  if (!map.heightmap) map.heightmap = {};
  map.heightmap.meterBounds = out;
  return out;
}

function computeMeterBoundsFromWgs84Bbox(bb, originLonLat) {
  const olon = Number(originLonLat?.[0]);
  const olat = Number(originLonLat?.[1]);
  if (!bb || !Number.isFinite(olon) || !Number.isFinite(olat)) return null;
  const minLon = Number(bb.minLon);
  const minLat = Number(bb.minLat);
  const maxLon = Number(bb.maxLon);
  const maxLat = Number(bb.maxLat);
  if (![minLon, minLat, maxLon, maxLat].every((v) => Number.isFinite(v))) return null;

  // Project all 4 corners; equirectangular approximation is fine at state scale for "background plane" use.
  const p0 = projectLonLatMeters(minLon, minLat, olon, olat);
  const p1 = projectLonLatMeters(minLon, maxLat, olon, olat);
  const p2 = projectLonLatMeters(maxLon, minLat, olon, olat);
  const p3 = projectLonLatMeters(maxLon, maxLat, olon, olat);
  const xs = [p0[0], p1[0], p2[0], p3[0]];
  const ys = [p0[1], p1[1], p2[1], p3[1]];
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
    originLonLat: [olon, olat],
  };
}

function heightmapXYBounds(map) {
  const preferDem = !!map?._elevation?.useDemBboxForSampling;
  const mb = map?.heightmap?.meterBounds;
  if (preferDem && mb && Number.isFinite(mb.minX) && Number.isFinite(mb.maxX) && Number.isFinite(mb.minY) && Number.isFinite(mb.maxY)) {
    // If the world bounds extend beyond the DEM coverage, using DEM bounds for UV mapping makes elevation
    // affect only a "portion" of the map (outside clamps to edge samples). In that case, prefer world bounds
    // so the DEM is stretched to cover the whole map, unless the world bounds were explicitly fitted to the DEM.
    const b = map?.bounds;
    const fitted = !!map?._elevation?.fitWorldXYToDemBbox;
    const containsWorld = !!b
      && Number.isFinite(b.minX) && Number.isFinite(b.maxX) && Number.isFinite(b.minY) && Number.isFinite(b.maxY)
      && b.minX >= mb.minX && b.maxX <= mb.maxX
      && b.minY >= mb.minY && b.maxY <= mb.maxY;
    if (fitted || containsWorld) return mb;
  }
  return map.bounds;
}

function heightAtWorld(map, x, z) {
  const b = heightmapXYBounds(map);
  const src = heightmapSampleSource(map);
  const w = src.w;
  const h = src.h;
  const du = Math.max(1e-6, (b.maxX - b.minX));
  const dv = Math.max(1e-6, (b.maxY - b.minY));
  const u = clamp((x - b.minX) / du, 0, 1);
  // Heightmap rows are stored top-to-bottom (north -> south), so v=0 should map to maxY.
  const v = clamp((b.maxY - z) / dv, 0, 1);
  const fx = u * (w - 1);
  const fy = v * (h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const h00 = heightAtCell(map, x0, y0);
  const h10 = heightAtCell(map, x1, y0);
  const h01 = heightAtCell(map, x0, y1);
  const h11 = heightAtCell(map, x1, y1);

  const hx0 = h00 + (h10 - h00) * tx;
  const hx1 = h01 + (h11 - h01) * tx;
  return hx0 + (hx1 - hx0) * ty;
}

function makeBoundsSquareXY(b) {
  // Keep center, pad the shorter axis so (maxX-minX) == (maxY-minY).
  const minX = Number(b?.minX) || 0;
  const maxX = Number(b?.maxX) || 0;
  const minY = Number(b?.minY) || 0;
  const maxY = Number(b?.maxY) || 0;
  const dx = maxX - minX;
  const dy = maxY - minY;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || dx <= 0 || dy <= 0) return;
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const half = Math.max(dx, dy) * 0.5;
  b.minX = cx - half;
  b.maxX = cx + half;
  b.minY = cy - half;
  b.maxY = cy + half;
}

function appendBoundsOutlineLines(outVerts, b, y = 0.12) {
  // LinesRenderer draws GL.LINES, so we emit pairs.
  const minX = Number(b?.minX) || 0;
  const maxX = Number(b?.maxX) || 0;
  const minY = Number(b?.minY) || 0;
  const maxY = Number(b?.maxY) || 0;
  // corners on XZ plane (map schema minY/maxY is Z axis in renderer)
  const ax = minX, az = minY;
  const bx = maxX, bz = minY;
  const cx = maxX, cz = maxY;
  const dx = minX, dz = maxY;
  // a-b
  outVerts.push(ax, y, az, bx, y, bz);
  // b-c
  outVerts.push(bx, y, bz, cx, y, cz);
  // c-d
  outVerts.push(cx, y, cz, dx, y, dz);
  // d-a
  outVerts.push(dx, y, dz, ax, y, az);
}

function pointInPolyXZFlat(px, pz, ringXZ) {
  // Ray-cast on +X. ringXZ is flat [x0,z0,x1,z1,...] (not necessarily closed).
  const n = Math.floor((ringXZ?.length || 0) / 2);
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ringXZ[i * 2 + 0], zi = ringXZ[i * 2 + 1];
    const xj = ringXZ[j * 2 + 0], zj = ringXZ[j * 2 + 1];
    // Edge crosses horizontal line at pz?
    const intersect = ((zi > pz) !== (zj > pz))
      && (px < ((xj - xi) * (pz - zi)) / ((zj - zi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function buildWaterMaskForTerrainGrid(polygons, b, gridW, gridH) {
  const w = Math.max(2, gridW | 0);
  const h = Math.max(2, gridH | 0);
  const mask = new Uint8Array(w * h);
  if (!Array.isArray(polygons) || polygons.length === 0) return mask;
  const minX = Number(b?.minX) || 0;
  const maxX = Number(b?.maxX) || 0;
  const minZ = Number(b?.minY) || 0;
  const maxZ = Number(b?.maxY) || 0;
  const sizeX = maxX - minX;
  const sizeZ = maxZ - minZ;
  if (!Number.isFinite(sizeX) || !Number.isFinite(sizeZ) || sizeX <= 0 || sizeZ <= 0) return mask;

  // Cap work for safety; water datasets can be huge. Keep the biggest polygons first (bbox area proxy).
  const polys = polygons
    .slice()
    .sort((a, c) => {
      const ab = a?.bbox, cb = c?.bbox;
      const aa = ab ? Math.abs((ab[2] - ab[0]) * (ab[3] - ab[1])) : 0;
      const ca = cb ? Math.abs((cb[2] - cb[0]) * (cb[3] - cb[1])) : 0;
      return ca - aa;
    })
    .slice(0, 6000);

  const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, v | 0));
  for (const p of polys) {
    const ring = p?.ringXZ;
    const bb = p?.bbox;
    if (!(ring instanceof Float32Array) || !bb) continue;
    const pMinX = Number(bb[0]), pMinZ = Number(bb[1]), pMaxX = Number(bb[2]), pMaxZ = Number(bb[3]);
    if (![pMinX, pMinZ, pMaxX, pMaxZ].every((v) => Number.isFinite(v))) continue;
    // Overlap test vs terrain bounds
    if (pMaxX < minX || pMinX > maxX || pMaxZ < minZ || pMinZ > maxZ) continue;

    const ix0 = clampI(Math.floor(((Math.max(pMinX, minX) - minX) / sizeX) * (w - 1)), 0, w - 1);
    const ix1 = clampI(Math.ceil(((Math.min(pMaxX, maxX) - minX) / sizeX) * (w - 1)), 0, w - 1);
    // Z -> iy uses inverted mapping: iy=0 is maxZ (north), iy=h-1 is minZ (south)
    const iy0 = clampI(Math.floor(((maxZ - Math.min(pMaxZ, maxZ)) / sizeZ) * (h - 1)), 0, h - 1);
    const iy1 = clampI(Math.ceil(((maxZ - Math.max(pMinZ, minZ)) / sizeZ) * (h - 1)), 0, h - 1);
    if (ix1 < ix0 || iy1 < iy0) continue;

    for (let iy = iy0; iy <= iy1; iy++) {
      const v = (h <= 1) ? 0 : iy / (h - 1);
      const z = maxZ - v * sizeZ;
      for (let ix = ix0; ix <= ix1; ix++) {
        const u = (w <= 1) ? 0 : ix / (w - 1);
        const x = minX + u * sizeX;
        if (pointInPolyXZFlat(x, z, ring)) {
          mask[iy * w + ix] = 1;
        }
      }
    }
  }
  return mask;
}

function ensureRightDock(uiRoot) {
  let dock = uiRoot.querySelector('.rightDock');
  if (dock) return /** @type {HTMLDivElement} */ (dock);
  dock = el('div', { class: 'rightDock' });
  uiRoot.appendChild(dock);
  return /** @type {HTMLDivElement} */ (dock);
}

function ensureLeftDock(uiRoot) {
  let dock = uiRoot.querySelector('.leftDock');
  if (dock) return /** @type {HTMLDivElement} */ (dock);
  dock = el('div', { class: 'leftDock' });
  uiRoot.appendChild(dock);
  return /** @type {HTMLDivElement} */ (dock);
}

function ensureBottomDock(uiRoot) {
  let dock = uiRoot.querySelector('.bottomDock');
  if (dock) return /** @type {HTMLDivElement} */ (dock);
  dock = el('div', { class: 'bottomDock' });
  uiRoot.appendChild(dock);
  return /** @type {HTMLDivElement} */ (dock);
}

export class EditorApp {
  constructor(canvas, uiRoot, store) {
    this.canvas = canvas;
    this.uiRoot = uiRoot;
    this.store = store;
    this.gl = getGl(canvas);
    if (!isWebGL2(this.gl)) {
      console.warn('WebGL2 not detected; editor expects WebGL2 for R32F height texture.');
    }

    this.camera = new Camera();
    this.camera.attach(canvas);

    this.terrain = new TerrainRenderer(this.gl);
    this.water = new WaterRenderer(this.gl);
    // Simple ocean plane (flat). Useful as a background "ocean fill" for coastal regions.
    // It can coexist with OSM water polygons (rivers/lakes/bays) which render on top.
    this._water = {
      enabled: false,
      levelY: 0.0,
      opacity: 0.55,
      padFactor: 0.06,
      padMeters: 0,
      padWestMeters: 0,
      padEastMeters: 0,
      padSouthMeters: 0,
      padNorthMeters: 0,
    };
    // Optional world-scale bounds override used ONLY for visuals like the ocean plane.
    // Keep terrain mesh + height sampling tied to dataset/DEM bounds to avoid stretching.
    this._worldBoundsOverride = null; // { minX,maxX,minY,maxY,minZ,maxZ } | null
    // Tracks whether an OSM water dataset is loaded (for UI hints / debug).
    this._hasOsmWater = false;
    // Cached water polygons (projected to XZ meters) used to flatten terrain under water.
    this._activeWaterPolygons = null; // Array<{ ringXZ: Float32Array, bbox: [number,number,number,number] }> | null
    this._activeWaterLevelY = 0.0;
    // OSM water (polygons + shorelines + waterways)
    this.osmWater = new WaterMeshRenderer(this.gl);
    this.osmWaterShoreline = new LinesRenderer(this.gl);
    this.osmWaterways = new InstancedBoxRenderer(this.gl);
    this.osmLines = new LinesRenderer(this.gl);
    // Separate line layer so large-scale outlines (e.g. Virginia state boundary) can be styled independently.
    this.osmLinesState = new LinesRenderer(this.gl);
    this.osmRoads = new InstancedBoxRenderer(this.gl);
    this.osmRails = new InstancedBoxRenderer(this.gl);
    this.osmBarriers = new InstancedBoxRenderer(this.gl);
    this.osmPowerLines = new LinesRenderer(this.gl);
    this.osmTrees = new InstancedBoxRenderer(this.gl);
    this.osmBuildings = new InstancedBoxRenderer(this.gl);
    this.osmBuildingsTiles = new InstancedBoxTilesRenderer(this.gl);
    this.osmBuildingsTilesFar = new InstancedBoxTilesRenderer(this.gl);
    this.osmBuildingsTilesSuperFar = new InstancedBoxTilesRenderer(this.gl);
    this.osmProps = new InstancedBoxRenderer(this.gl);
    this.osmBuildingsExtruded = new ExtrudedBuildingsRenderer(this.gl);
    this.indoorDebugLines = new LinesRenderer(this.gl);
    this._datasetBuildingsExtrude = { enabled: false, maxBuildings: 12000 };
    this._activeBuildingsMode = 'boxes'; // boxes | tiles | tiles_lod | extruded
    this.instances = new InstancedBoxRenderer(this.gl);
    this.playerViz = new InstancedBoxRenderer(this.gl);
    this._datasetManifest = null;
    this._datasetManifestPromise = null;
    this._datasetCache = new Map(); // id -> { positions, bounds }
    this._datasetBuildingsCache = new Map(); // id -> { instances, bounds, buildingCount }
    this._datasetRoadsCache = new Map(); // id@origin -> { instances, bounds, segmentCount }
    this._datasetRoadLabelsCache = new Map(); // id@origin -> { labels, bounds, labelCount }
    this._datasetRailsCache = new Map(); // id@origin -> { instances, bounds, segmentCount }
    this._datasetBarriersCache = new Map(); // id@origin -> { instances, bounds, segmentCount }
    this._datasetPowerLinesCache = new Map(); // id@origin -> { positions, bounds, segmentCount }
    this._datasetTreesCache = new Map(); // id@origin -> { instances, bounds, treeCount }
    this._datasetPropsCache = new Map(); // id@origin -> { instances, bounds, propCount }
    this._datasetWaterCache = new Map(); // id@origin -> { waterMesh, shoreline, waterways, bounds, polygonCount, segmentCount }
    this._datasetOriginByDatasetId = new Map(); // datasetId -> [originLon, originLat]
    this._activeDatasetBuildingFootprints = []; // [{ ringXZ, centerXZ, minY, maxY, color }]
    /** @type {{ x: number, z: number, dirX: number, dirZ: number, text: string, kind: string, priority: number, isRef: boolean }[]} */
    this._activeRoadLabels = [];
    this._labels = {
      enabled: true,
      bakeToTerrain: false,
      maxDraw: 280,
      cellPx: 90,
      minPolylineMeters: 40,
      minSegmentMeters: 3,
      preferRef: false,
      terrainTexSize: 2048,
      terrainMaxDraw: 5000,
    };
    this._labelCanvas = /** @type {HTMLCanvasElement|null} */ (uiRoot.querySelector('#labelCanvas'));
    if (!this._labelCanvas) {
      this._labelCanvas = /** @type {HTMLCanvasElement} */ (el('canvas', { id: 'labelCanvas' }));
      this._labelCanvas.style.position = 'fixed';
      this._labelCanvas.style.inset = '0';
      this._labelCanvas.style.zIndex = '15';
      this._labelCanvas.style.pointerEvents = 'none';
      this._labelCanvas.style.width = '100vw';
      this._labelCanvas.style.height = '100vh';
      uiRoot.appendChild(this._labelCanvas);
    }
    this._labelCtx = /** @type {CanvasRenderingContext2D|null} */ (this._labelCanvas.getContext('2d'));
    this._labelsTerrainCanvas = null;
    this._labelsTerrainCtx = null;
    // One-shot "preferred spawn" framing for certain large regional templates.
    // This avoids always framing the dataset's full extent (often centers on a less-interesting area).
    this._didInitialDatasetFrame = false;

    // Indoor generation (MVP): deterministic per-building, debug visualization only for now.
    this._indoors = {
      enabled: false,
      debug: false,
      seed: 'indoors_v1',
      radiusMeters: 140,
      maxBuildings: 60,
    };
    this._indoorsCache = new Map(); // buildingIdU32 -> floorplan
    this._indoorsLastDebugUpdateMs = 0;
    this._inspect = { enabled: true, nearestBuilding: null };

    // Elevation remap:
    // - DEM heightmaps include a WGS84 bbox in meta.bbox
    // - map.bounds may be padded/squared for UX, which breaks sampling if we use bounds->UV mapping
    // - so we optionally sample using DEM bbox projected to meters around originLonLat
    this._elevation = {
      useDemBboxForSampling: true,
      fitWorldXYToDemBbox: true,
      heightScale: 1.0,
      autoLoadDem: true,
      maxTerrainGrid: 256,
    };
    this._datasetStreaming = {
      enabled: true,
      chunkSizeMeters: 800,
      radiusChunksRoads: 10,
      // Buildings are visually important; keep a larger default radius than before.
      radiusChunksBuildings: 10,
      updateEveryMs: 200,
    };
    // "Full world" mode: prefer eventually loading all tile chunks (instead of camera-radius only).
    // This can use a lot of memory for big metros; keep it opt-in.
    this._datasetFullWorld = {
      enabled: false,
    };
    // Adaptive streaming budget controller (simple EMA on frame time).
    // Goal: load more when FPS is good, back off when it's not.
    this._streamBudget = {
      emaFrameMs: 16.7,
      lastAdjustMs: 0,
      enabled: true,
    };
    this._activeDatasetStreamState = null;
    this._buildingTilesStreamer = null;
    this._buildingTilesStreamerFar = null;
    this._buildingTilesStreamerSuperFar = null;
    this._buildingFootprintsTilesStreamer = null;
    this._datasetLoadStatus = {
      phase: 'idle', // idle | loading | loaded | error
      datasetId: '',
      message: '',
      roadsCount: 0,
      railCount: 0,
      barrierCount: 0,
      powerLineCount: 0,
      treeCount: 0,
      buildingsCount: 0,
      propsCount: 0,
      lastError: '',
    };

    this.map = null;

    // High-signal visuals (ported from the full viewer)
    this.sky = new SkyRenderer(this.gl);
    this.postfx = new PostFxRenderer(this.gl);
    this._sky = {
      enabled: true,
      topColor: [0.20, 0.35, 0.65],
      bottomColor: [0.60, 0.70, 0.82],
      sunIntensity: 1.0,
      starIntensity: 0.0,
    };
    this._postfx = {
      enabled: true,
      exposure: 1.0,
      avgLum: 1.0,
      enableAutoExposure: false,
      autoExposureSpeed: 1.5,
      enableBloom: true,
      bloomStrength: 0.52,
      bloomThreshold: 0.78,
      bloomRadius: 1.65,
      enableVignette: true,
      vignetteStrength: 0.12,
      vignetteSoftness: 0.78,
      enableGrain: true,
      grainStrength: 0.028,
      grainSpeed: 0.75,
    };

    // Debug: add ?debugBounds=1 to URL to draw a bounds outline and expose metrics on globalThis.
    this._debugBounds = false;
    // Debug: add ?debugCam=1 to log camera pose for the first few frames.
    this._debugCam = false;
    this._debugCamFrames = 0;
    try {
      const sp = new URLSearchParams(String(globalThis?.location?.search || ''));
      this._debugBounds = sp.get('debugBounds') === '1' || sp.get('debugBounds') === 'true';
      this._debugCam = sp.get('debugCam') === '1' || sp.get('debugCam') === 'true';
    } catch { /* ignore */ }

    // App mode
    this.appMode = 'editor'; // 'editor' | 'gameplay'

    // Gameplay (simple follow/FP camera + proxy player cube)
    this.gameplayEnabled = false;
    this._keys = new Set();
    this._bindKeys();
    this.player = new PlayerController({
      getHeightAtXY: (x, y) => this._heightAtXY(x, y),
    });
    // Proximity interactions (beds/chairs/TV).
    this._interactions = new InteractionManager({ app: this });
    // Gameplay mouse-look uses Pointer Lock; Esc exits gameplay and releases it.
    this._pointerLockActive = false;

    // Gameplay avatar (skinned mesh + animations) rendered via three.js on the same WebGL2 context.
    // This is optional; the placeholder player cube remains as fallback if loading fails.
    this._avatar = {
      enabled: true,
      url: '',
      scale: 1.0,
      yOffset: 0.0,
    };
    try {
      const v = String(localStorage.getItem('gameplay.avatarEnabled') || '').trim();
      if (v) this._avatar.enabled = (v === '1' || v === 'true' || v === 'yes');
    } catch { /* ignore */ }
    try {
      const saved = String(localStorage.getItem('gameplay.avatarUrl') || '').trim();
      if (saved) this._avatar.url = saved;
    } catch { /* ignore */ }
    try {
      // Convenience: reuse the latest devtools output if present.
      const saved = String(localStorage.getItem('devtools.lastGeneratedModelUrl') || '').trim();
      if (saved && !this._avatar.url) this._avatar.url = saved;
    } catch { /* ignore */ }
    this.avatarLayer = new ThreeAvatarLayer({ canvas: this.canvas, gl: this.gl });

    // Simple NPC (skinned avatar + locomotion) rendered via three.js.
    // Intended for quick "Debra walking around" testing in the penthouse room-sim map.
    this._npc = {
      enabled: true,
      url: '',
      scale: 1.0,
      yOffset: 0.0,
      speed: 1.5,      // m/s (walk)
      cornerPauseSec: 0.8,
    };
    this._npcLastUrl = '';
    this._npcLoadRequested = false;
    try {
      const v = String(localStorage.getItem('gameplay.npcEnabled') || '').trim();
      if (v) this._npc.enabled = (v === '1' || v === 'true' || v === 'yes');
    } catch { /* ignore */ }
    try {
      const saved = String(localStorage.getItem('gameplay.npcUrl') || '').trim();
      if (saved) this._npc.url = saved;
    } catch { /* ignore */ }
    // Default NPC: Debra locomotion pack output (if present).
    // If the user hasn't built it yet, they can still override with any skinned GLB.
    if (!String(this._npc.url || '').trim()) this._npc.url = 'outputs/debra_locomotion_pack.glb';
    // Convenience: if user hasn't set an NPC URL, fall back to the current gameplay avatar (if any).
    try {
      const av = String(localStorage.getItem('gameplay.avatarUrl') || '').trim();
      if (av && !String(this._npc.url || '').trim()) this._npc.url = av;
    } catch { /* ignore */ }
    this.npcLayer = new ThreeAvatarLayer({ canvas: this.canvas, gl: this.gl });
    this._npcState = {
      enabled: false,
      pos: { x: 0, y: 0, z: 0 },
      yawRad: 0,
      onGround: true,
      planarSpeed: 0,
      hasMoveInput: false,
      moveDir: { x: 0, y: 1 }, // world XZ as (x, y)
      walkSpeed: 1.5,
      runSpeed: 3.0,
      running: false,
      justJumped: false,
      justLanded: false,
    };
    this._npcPath = [];
    this._npcPathIdx = 0;
    this._npcCornerPauseT = 0;
    this._npcJump = { active: false, t: 0, dur: 0.75, height: 0.55, baseZ: 0 };

    // Gameplay test vehicle overlay (GLB) rendered via three.js.
    this._vehicle = {
      enabled: true,
      url: '/webautos/Abarth_124/stream/124spider_hi.glb',
      scale: 1.0,
      yOffset: 0.0,
      forwardMeters: 8.0,
    };
    /** @type {{ x: number, y: number, z: number, yawRad: number }|null} */
    this._vehiclePose = null;
    this._vehicleLoadRequested = false;
    this._vehicleLastUrl = '';
    try {
      const saved = String(localStorage.getItem('gameplay.vehicleUrl') || '').trim();
      if (saved) this._vehicle.url = saved;
    } catch { /* ignore */ }
    try {
      const v = String(localStorage.getItem('gameplay.vehicleEnabled') || '').trim();
      if (v) this._vehicle.enabled = (v === '1' || v === 'true' || v === 'yes');
    } catch { /* ignore */ }
    this.vehicleLayer = new ThreeModelLayer({ canvas: this.canvas, gl: this.gl });

    // MMO (optional): authoritative multiplayer via Colyseus + a simple remote-player viz.
    this._mmoCfg = {
      enabled: true,
      endpoint: 'ws://127.0.0.1:2567',
      roomName: 'city',
      autoConnect: false, // can be enabled via URL (?mmo=1)
      renderRadiusMeters: 1200, // only render nearby remote players
    };
    try {
      const sp = new URLSearchParams(String(globalThis?.location?.search || ''));
      const ep = String(sp.get('mmoServer') || '').trim();
      if (ep) this._mmoCfg.endpoint = ep;
      const rn = String(sp.get('mmoRoom') || '').trim();
      if (rn) this._mmoCfg.roomName = rn;
      const rr = Number(sp.get('mmoRenderRadius') || 0);
      if (Number.isFinite(rr) && rr > 0) this._mmoCfg.renderRadiusMeters = rr;
      const on = sp.get('mmo');
      this._mmoCfg.autoConnect = (on === '1' || on === 'true' || on === 'yes');
    } catch { /* ignore */ }
    this.mmo = new MmoClient({
      endpoint: this._mmoCfg.endpoint,
      roomName: this._mmoCfg.roomName,
      sendRateHz: 20,
      onStatus: () => { try { this._renderEditorUi(); } catch { /* ignore */ } },
    });
    this.remotePlayersViz = new InstancedBoxRenderer(this.gl);

    // Editor state
    // Tooling/UI
    this.tool = 'navigate'; // navigate | paint | sculpt | select | place
    this.inspectorTab = 'terrain'; // map | terrain | datasets | ai
    this.mode = 'paint'; // paint | height
    this.paintKind = 'grass'; // grass | dirt | road | street
    this.brushRadius = 2;
    this.heightDelta = 1200; // u16 delta per stroke
    this._pointer = { x: 0, y: 0, down: false };
    this._lastFrameMs = performance.now();
    this._autosaveTimer = null;

    this._dockRight = ensureRightDock(uiRoot);
    this._dockLeft = ensureLeftDock(uiRoot);
    this._dockBottom = ensureBottomDock(uiRoot);
    this._dockRight.style.display = 'block';
    this._dockLeft.style.display = 'block';
    this._dockBottom.style.display = 'block';

    this._cityLabelEl = /** @type {HTMLDivElement|null} */ (uiRoot.querySelector('#cityLabel'));
    if (!this._cityLabelEl) {
      this._cityLabelEl = /** @type {HTMLDivElement} */ (el('div', { id: 'cityLabel', class: 'hudCityLabel' }, []));
      uiRoot.appendChild(this._cityLabelEl);
    }
    this._hudCityTextEl = null;
    this._hudCompassEl = null;
    this._hudCompassNeedleEl = null;
    this._hudHeadingDeg = null;
    this._ensureCityLabelHud();
    this._buildDockUi();
    this._updateCityLabel();

    this._attachInput();
  }

  _enterGameplay() {
    this.gameplayEnabled = true;
    this.appMode = 'gameplay';
    // Ensure the editor camera isn't left "dragging" when switching modes.
    try { this.camera._dragging = false; } catch { /* ignore */ }
    // IMPORTANT: sync gameplay look direction from the current editor camera so entering gameplay
    // doesn't "snap" to the PlayerController defaults (yaw=0, pitch=-0.15) which can look like
    // an initial tilt until the first mouse-look event.
    try {
      const cam = this.camera;
      const p = this.player;
      if (p?.enabled && cam?.position && cam?.target) {
        const fx = (Number(cam.target[0]) || 0) - (Number(cam.position[0]) || 0);
        const fy = (Number(cam.target[1]) || 0) - (Number(cam.position[1]) || 0);
        const fz = (Number(cam.target[2]) || 0) - (Number(cam.position[2]) || 0);
        const fl = Math.hypot(fx, fy, fz);
        if (fl > 1e-6) {
          const nx = fx / fl;
          const ny = fy / fl;
          const nz = fz / fl;
          const yaw = Math.atan2(nx, nz);
          const pitch = Math.asin(Math.max(-1, Math.min(1, ny)));
          // Respect PlayerController's pitch clamp.
          const lim = Math.PI * 0.49;
          p.yawRad = yaw;
          p.pitchRad = Math.max(-lim, Math.min(lim, pitch));
        }
      }
    } catch { /* ignore */ }
    // Safety: ensure collisions aren't accidentally disabled via dev console state.
    // (`PlayerController.noClip` bypasses wall collision entirely.)
    try { this.player?.setNoClip?.(false); } catch { /* ignore */ }
    // Defer camera snap to the render loop so the first gameplay frame
    // cannot render with a stale (editor/orbit) view matrix.
    this._pendingGameplayCameraSnap = true;
    try { this._renderEditorUi(); } catch { /* ignore */ }
    // If a vehicle is enabled + loaded but we don't yet have a pose, drop it in front of the player.
    try {
      const url = String(this._vehicle?.url || '').trim();
      if (this._vehicle?.enabled && url) {
        if (!this.vehicleLayer?.loaded) void this.vehicleLayer.load(url);
        if (!this._vehiclePose && this.player?.enabled) this._spawnTestVehicleInFrontOfPlayer();
      }
    } catch { /* ignore */ }
    // Optional auto-connect (URL flag) so you can quickly open two tabs and see each other.
    try { if (this._mmoCfg?.autoConnect) void this.mmo.connect(); } catch { /* ignore */ }
  }

  _exitGameplay() {
    this.gameplayEnabled = false;
    this.appMode = 'editor';
    this._pointerLockActive = false;
    if (this._lookDrag) this._lookDrag.active = false;
    try { if (document?.pointerLockElement) document.exitPointerLock(); } catch { /* ignore */ }
    try { this._renderEditorUi(); } catch { /* ignore */ }
  }

  _applyWaterFromMapBounds() {
    const b = this._worldBoundsOverride || this.map?.bounds;
    if (!b) return;
    try {
      this.water.levelY = Number(this._water?.levelY ?? 0.0) || 0.0;
      this.water.opacity = Number(this._water?.opacity ?? 0.55) || 0.55;
      this.water.setBoundsFromMapBounds(b, {
        padFactor: Number(this._water?.padFactor ?? 0.06) || 0.06,
        padMeters: Number(this._water?.padMeters ?? 0) || 0,
        padWestMeters: Number(this._water?.padWestMeters ?? 0) || 0,
        padEastMeters: Number(this._water?.padEastMeters ?? 0) || 0,
        padSouthMeters: Number(this._water?.padSouthMeters ?? 0) || 0,
        padNorthMeters: Number(this._water?.padNorthMeters ?? 0) || 0,
      });
    } catch { /* ignore */ }
  }

  _applyTerrainWaterMask() {
    try {
      if (!this.map || !this.terrain?.ready) return;
      const w = Math.max(2, Number(this.map?.grid?.width) || 0);
      const h = Math.max(2, Number(this.map?.grid?.height) || 0);
      const polys = this._activeWaterPolygons;
      if (!Array.isArray(polys) || polys.length === 0) {
        this.terrain.clearWaterMask();
        return;
      }
      this.terrain.setWaterLevelY(Number(this._activeWaterLevelY) || 0.0);
      const mask = buildWaterMaskForTerrainGrid(polys, this.map.bounds, w, h);
      this.terrain.uploadWaterMask(w, h, mask);
    } catch { /* ignore */ }
  }

  _computeCityLabelText() {
    const mapName = String(this.map?.name || '').trim();
    const dsId = (this.map?.dataset?.enabled && this.map?.dataset?.datasetId) ? String(this.map.dataset.datasetId) : '';

    // Prefer dataset label (usually encodes the city), but fall back to map name.
    if (dsId && Array.isArray(this._datasetManifest)) {
      const entry = this._datasetManifest.find((d) => String(d?.id || '') === dsId) || null;
      const dsLabel = String(entry?.label || '').trim();
      const city = extractCityFromDatasetLabel(dsLabel);
      const pretty = prettyRegionFromDataset(dsId, city);
      if (pretty) {
        const ol = this._datasetOriginByDatasetId?.get(dsId) || null;
        const tx = Number(this.camera?.target?.[0]);
        const tz = Number(this.camera?.target?.[2]);
        const dyn = hamptonRoadsCityAtXZ(tx, tz, ol);
        if (dyn) return dyn;
        return pretty;
      }
      if (city) return city;
      if (dsLabel) return dsLabel;
      return dsId;
    }

    if (mapName) return mapName;
    if (dsId) return dsId;
    return '';
  }

  _ensureCityLabelHud() {
    const eln = this._cityLabelEl;
    if (!eln) return;

    // If the label was created as a plain div (or has been overwritten), rebuild a stable structure:
    // [text scroll area] [compass]
    let textEl = /** @type {HTMLDivElement|null} */ (eln.querySelector('.hudCityText'));
    let compassEl = /** @type {HTMLDivElement|null} */ (eln.querySelector('.hudCompass'));
    let needleEl = /** @type {HTMLDivElement|null} */ (eln.querySelector('.hudCompassNeedle'));

    if (!textEl || !compassEl || !needleEl) {
      const existingText = String(eln.textContent || '').trim();
      try { clear(eln); } catch { /* ignore */ }

      textEl = /** @type {HTMLDivElement} */ (el('div', { class: 'hudCityText' }, []));
      textEl.textContent = existingText;

      needleEl = /** @type {HTMLDivElement} */ (el('div', { class: 'hudCompassNeedle' }, []));
      const nEl = el('div', { class: 'hudCompassN' }, ['N']);
      compassEl = /** @type {HTMLDivElement} */ (el('div', { class: 'hudCompass', title: 'Heading' }, [needleEl, nEl]));

      eln.appendChild(textEl);
      eln.appendChild(compassEl);
    }

    this._hudCityTextEl = textEl;
    this._hudCompassEl = compassEl;
    this._hudCompassNeedleEl = needleEl;
  }

  _ensureDebugHud() {
    try {
      if (!this.uiRoot) return;
      if (this._hudDebugEl) return;
      let eln = /** @type {HTMLDivElement|null} */ (this.uiRoot.querySelector('#hudDebug'));
      if (!eln) {
        eln = /** @type {HTMLDivElement} */ (el('div', { id: 'hudDebug' }, []));
        this.uiRoot.appendChild(eln);
      }
      eln.style.position = 'fixed';
      eln.style.left = '12px';
      eln.style.bottom = '12px';
      eln.style.padding = '8px 10px';
      eln.style.borderRadius = '10px';
      eln.style.fontFamily = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
      eln.style.fontSize = '12px';
      eln.style.lineHeight = '1.25';
      eln.style.color = '#e7eefc';
      eln.style.background = 'rgba(8,12,20,0.72)';
      eln.style.border = '1px solid rgba(150,175,210,0.16)';
      eln.style.whiteSpace = 'pre';
      eln.style.zIndex = '55';
      eln.style.pointerEvents = 'none';
      eln.style.display = 'none';
      this._hudDebugEl = eln;
    } catch { /* ignore */ }
  }

  _computeHeadingDegFromCamera() {
    // Convention: 0° = +Z (north), 90° = +X (east).
    const cam = this.camera;
    if (!cam || !cam.position || !cam.target) return 0;
    const fx = Number(cam.target[0]) - Number(cam.position[0]);
    const fz = Number(cam.target[2]) - Number(cam.position[2]);
    if (!Number.isFinite(fx) || !Number.isFinite(fz)) return 0;
    const l = Math.hypot(fx, fz);
    if (l < 1e-6) return 0;
    const rad = Math.atan2(fx / l, fz / l);
    return normDeg360((rad * 180) / Math.PI);
  }

  _updateHudCompass(nowMs) {
    const needle = this._hudCompassNeedleEl;
    if (!needle) return;
    const deg = this._computeHeadingDegFromCamera();
    const prev = this._hudHeadingDeg;
    if (typeof prev === 'number' && angularDiffDeg(deg, prev) < 0.35) return;

    this._hudHeadingDeg = deg;
    needle.style.transform = `translate(-50%, -100%) rotate(${deg}deg)`;
    const ce = this._hudCompassEl;
    if (ce) ce.title = `Heading ${Math.round(deg)}° (${cardinal8FromDeg(deg)})`;
  }

  _updateCityLabel() {
    const eln = this._cityLabelEl;
    if (!eln) return;
    this._ensureCityLabelHud();
    const txt = this._computeCityLabelText();
    const tEl = this._hudCityTextEl || eln;
    tEl.textContent = txt;
    eln.style.display = txt ? 'flex' : 'none';
    // Subtle scaling so the label feels responsive without being jumpy.
    const d = Math.max(1e-3, Number(this.camera?._dist) || 0);
    const t = clamp((Math.log(d) - Math.log(30)) / (Math.log(8000) - Math.log(30)), 0, 1);
    const px = Math.round(16 - t * 4); // 16px (close) -> 12px (far)
    eln.style.fontSize = `${px}px`;
  }

  async _ensureDatasetManifestLoaded() {
    if (Array.isArray(this._datasetManifest)) return this._datasetManifest;
    if (this._datasetManifestPromise) return await this._datasetManifestPromise;
    this._datasetManifestPromise = (async () => {
      try {
        this._datasetManifest = await loadDatasetManifest('assets/datasets/manifest.json');
      } catch {
        this._datasetManifest = [];
      } finally {
        this._datasetManifestPromise = null;
      }
      return this._datasetManifest;
    })();
    return await this._datasetManifestPromise;
  }

  _bindKeys() {
    window.addEventListener('keydown', (e) => {
      this._keys.add(e.code);
      // Exit gameplay even if the mouse is captured (pointer lock).
      if (this.gameplayEnabled && e.code === 'Escape') {
        try { e.preventDefault(); } catch { /* ignore */ }
        try { this._exitGameplay(); } catch { /* ignore */ }
        return;
      }
      // Gameplay camera toggle
      if (this.gameplayEnabled && (e.code === 'KeyV')) {
        try { this.player.toggleViewMode(); } catch { /* ignore */ }
        try { this._renderEditorUi(); } catch { /* ignore */ }
      }
      // Gameplay camera side toggle (over-shoulder)
      if (this.gameplayEnabled && (e.code === 'Tab')) {
        // Prevent focus switching in browser while playing.
        try { e.preventDefault(); } catch { /* ignore */ }
        try { this.player.toggleCameraSide(); } catch { /* ignore */ }
      }
      // Quick vehicle spawn toggle (B)
      if (this.gameplayEnabled && (e.code === 'KeyB')) {
        try { this._spawnTestVehicleInFrontOfPlayer(); } catch { /* ignore */ }
        try { this._renderEditorUi(); } catch { /* ignore */ }
      }
      // NPC toggle (N) and action test (J = jump)
      if (this.gameplayEnabled && (e.code === 'KeyN')) {
        try {
          this._npc.enabled = !this._npc.enabled;
          localStorage.setItem('gameplay.npcEnabled', this._npc.enabled ? '1' : '0');
        } catch { /* ignore */ }
        try { this._renderEditorUi(); } catch { /* ignore */ }
      }
      if (this.gameplayEnabled && (e.code === 'KeyJ')) {
        try { this._npcTriggerJump(); } catch { /* ignore */ }
      }
    });
    window.addEventListener('keyup', (e) => { this._keys.delete(e.code); });
  }

  _spawnTestVehicleInFrontOfPlayer() {
    const p = this.player?.pos;
    if (!p || !this.player?.enabled) return;
    const yaw = Number(this.player?.yawRad) || 0.0;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const fwd = Math.max(0.0, Number(this._vehicle?.forwardMeters ?? 8.0) || 8.0);
    const x = (Number(p.x) || 0.0) + fx * fwd;
    const y = (Number(p.y) || 0.0) + fz * fwd;
    const z = Number.isFinite(Number(p.z)) ? (Number(p.z) || 0.0) : (Number(this._heightAtXY(x, y)) || 0.0);
    const gz = Number(this._heightAtXY(x, y)) || 0.0;
    this._vehiclePose = { x, y, z: Number.isFinite(z) ? z : gz, yawRad: yaw };
    // Ground it by default (vehicle models usually expect to sit on the terrain).
    this._vehiclePose.z = gz;
  }

  _heightAtXY(x, y) {
    if (!this.map) return 0;
    const src = heightmapSampleSource(this.map);
    const w = src.w;
    const h = src.h;
    const b = heightmapXYBounds(this.map);
    const u = (x - b.minX) / Math.max(1e-6, (b.maxX - b.minX));
    // Heightmap rows are stored top-to-bottom (north -> south), so v=0 should map to maxY.
    const v = (b.maxY - y) / Math.max(1e-6, (b.maxY - b.minY));
    const ix = Math.round(clamp(u, 0, 1) * (w - 1));
    const iy = Math.round(clamp(v, 0, 1) * (h - 1));
    const u16 = src.u16[iy * w + ix] || 0;
    const h01 = u16 / 65535.0;
    const s = Number(this.map?._elevation?.heightScale ?? 1.0);
    const hs = (Number.isFinite(s) && s > 0) ? s : 1.0;
    return this.map.bounds.minZ + h01 * (this.map.bounds.maxZ - this.map.bounds.minZ) * hs;
  }

  _npcTriggerJump() {
    if (!this.gameplayEnabled) return;
    if (!this._npc?.enabled) return;
    if (this._npcJump?.active) return;
    const st = this._npcState;
    if (!st) return;
    const gz = Number(this._heightAtXY(Number(st.pos?.x) || 0, Number(st.pos?.y) || 0)) || 0;
    this._npcJump.active = true;
    this._npcJump.t = 0;
    this._npcJump.baseZ = gz;
    st.onGround = false;
    st.justJumped = true;
    st.justLanded = false;
  }

  async _resetNpcForMap(map) {
    const b = map?.bounds;
    if (!b) return;

    // Default: a simple loop near the map center (works for any map).
    let pts = [];
    const tid = String(map?.templateId || '');
    if (tid === 'room_sim') {
      const params = await this._loadRoomSimPenthouseParamsFromAsset(map);
      const hall = this._computeRoomSimHallRect(params);
      const m = 2.1;
      const x0 = hall.hallLeftX + m;
      const x1 = hall.hallRightX - m;
      const y0 = hall.minY + m;
      const y1 = hall.maxY - m;
      pts = [
        { x: x0, y: y1 },
        { x: x1, y: y1 },
        { x: x1, y: y0 },
        { x: x0, y: y0 },
      ];
    } else {
      const cx = (Number(b.minX) + Number(b.maxX)) * 0.5;
      const cy = (Number(b.minY) + Number(b.maxY)) * 0.5;
      const rx = Math.max(3.0, Math.min(18.0, (Number(b.maxX) - Number(b.minX)) * 0.08));
      const ry = Math.max(3.0, Math.min(18.0, (Number(b.maxY) - Number(b.minY)) * 0.08));
      pts = [
        { x: cx - rx, y: cy + ry },
        { x: cx + rx, y: cy + ry },
        { x: cx + rx, y: cy - ry },
        { x: cx - rx, y: cy - ry },
      ];
    }

    this._npcPath = pts;
    this._npcPathIdx = 0;
    this._npcCornerPauseT = 0;
    try {
      this._npcJump.active = false;
      this._npcJump.t = 0;
    } catch { /* ignore */ }

    // Spawn at first waypoint and ground it.
    const st = this._npcState;
    if (st && pts.length) {
      st.pos.x = Number(pts[0].x) || 0;
      st.pos.y = Number(pts[0].y) || 0;
      st.pos.z = Number(this._heightAtXY(st.pos.x, st.pos.y)) || 0;
      st.yawRad = 0;
      st.onGround = true;
      st.planarSpeed = 0;
      st.hasMoveInput = false;
      st.justJumped = false;
      st.justLanded = false;
    }
  }

  async _loadRoomSimPenthouseParamsFromAsset(map) {
    // Single source of truth lives in `js/shared/room_sim_penthouse_defaults.js`.
    const defaults = DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS;
    const p = String(map?.roomSim?.buildingAssetPath || '').trim();
    if (!p) return defaults;
    try {
      const resp = await fetch(p);
      const j = await resp.json();
      const b = (j?.building && typeof j.building === 'object') ? j.building : {};
      // Only accept expected proc kind; otherwise fall back.
      const kind = String(b?.kind || '');
      if (kind && kind !== 'proc:penthouse_room_sim') return defaults;
      return mergeRoomSimPenthouseParams(b);
    } catch {
      return defaults;
    }
  }

  _computeRoomSimHallRect(params) {
    const rows = Math.max(1, Math.floor(Number(params?.rows) || 5));
    const cols = Math.max(1, Math.floor(Number(params?.cols) || 5));
    const roomW = Number(params?.roomW) || 6.0;
    const roomD = Number(params?.roomD) || 6.0;
    const suiteHallW = Number(params?.suiteHallW) || 2.8;
    const corridorD = Number(params?.corridorD) || 3.2;
    const hallW = Number(params?.hallW) || 46.0;
    const wallT = Number(params?.wallT) || 0.25;

    const bedWingW = (cols * roomW) + ((cols + 1) * suiteHallW);
    const bedWingD = (rows * roomD) + ((rows + 1) * suiteHallW);
    const totalW = bedWingW + corridorD + hallW + wallT * 2;
    const totalD = bedWingD + wallT * 2;
    const minX = -totalW * 0.5;
    const maxX = totalW * 0.5;
    const minY = -totalD * 0.5;
    const maxY = totalD * 0.5;

    const wingLeftX = minX + wallT;
    const wingRightX = wingLeftX + bedWingW;
    const corridorRightX = wingRightX + corridorD;
    const hallLeftX = corridorRightX;
    const hallRightX = maxX - wallT;

    return { hallLeftX, hallRightX, minY, maxY };
  }

  _tickNpc(dt) {
    const st = this._npcState;
    if (!st) return;

    // Keep config values synced.
    const spd = Math.max(0.0, Number(this._npc?.speed ?? 1.5) || 1.5);
    st.walkSpeed = Math.max(0.01, spd);
    st.runSpeed = Math.max(st.walkSpeed + 0.01, st.walkSpeed * 2.0);
    st.running = false;

    // Only simulate while in gameplay and enabled.
    const simOn = !!this.gameplayEnabled && !!this._npc?.enabled && Array.isArray(this._npcPath) && this._npcPath.length >= 2;
    if (!simOn) {
      st.hasMoveInput = false;
      st.planarSpeed = 0;
      st.onGround = true;
      st.justJumped = false;
      st.justLanded = false;
      return;
    }

    const delta = Math.max(0, Math.min(0.25, Number(dt) || 0));

    // Jump state drives onGround + z (optional action test).
    if (this._npcJump?.active) {
      st.justJumped = false; // only true for the first frame after trigger
      st.justLanded = false;
      st.onGround = false;
      this._npcJump.t += delta;
      const a = Math.max(0, Math.min(1, this._npcJump.t / Math.max(1e-6, this._npcJump.dur)));
      const hz = this._npcJump.baseZ + Math.sin(Math.PI * a) * (Number(this._npcJump.height) || 0.55);
      st.pos.z = hz;
      if (a >= 1.0 - 1e-6) {
        this._npcJump.active = false;
        st.onGround = true;
        st.justLanded = true;
        st.pos.z = Number(this._heightAtXY(st.pos.x, st.pos.y)) || 0;
      }
    } else {
      st.onGround = true;
      st.justJumped = false;
      st.justLanded = false;
      st.pos.z = Number(this._heightAtXY(st.pos.x, st.pos.y)) || 0;
    }

    // Corner pause: idle a moment at each waypoint.
    if (this._npcCornerPauseT > 0) {
      this._npcCornerPauseT = Math.max(0, this._npcCornerPauseT - delta);
      st.hasMoveInput = false;
      st.planarSpeed = 0;
      return;
    }

    // Move along the waypoint loop (x,y in map ground plane).
    const pts = this._npcPath;
    const idx = Math.max(0, Math.min(pts.length - 1, Math.floor(this._npcPathIdx || 0)));
    const goal = pts[idx];
    const gx = Number(goal?.x) || 0;
    const gy = Number(goal?.y) || 0;
    const dx = gx - (Number(st.pos.x) || 0);
    const dy = gy - (Number(st.pos.y) || 0);
    const dist = Math.hypot(dx, dy);

    if (dist < 0.55) {
      this._npcPathIdx = (idx + 1) % pts.length;
      const pause = Math.max(0, Number(this._npc?.cornerPauseSec ?? 0.8) || 0);
      this._npcCornerPauseT = pause;
      st.hasMoveInput = false;
      st.planarSpeed = 0;
      return;
    }

    const inv = 1.0 / Math.max(1e-6, dist);
    const dirX = dx * inv;
    const dirY = dy * inv;
    const step = Math.min(dist, spd * delta);
    st.pos.x += dirX * step;
    st.pos.y += dirY * step;

    st.hasMoveInput = true;
    st.planarSpeed = (delta > 1e-6) ? (step / delta) : 0;
    st.moveDir.x = dirX;
    st.moveDir.y = dirY;
    st.yawRad = Math.atan2(dirX, dirY);
  }

  _attachInput() {
    // Prevent right-click menu so RMB drag can be used for orbit/look.
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Gameplay look drag state (RMB)
    this._lookDrag = { active: false, x: 0, y: 0 };

    // Pointer lock state for gameplay mouse-look.
    document.addEventListener('pointerlockchange', () => {
      this._pointerLockActive = (document.pointerLockElement === this.canvas);
    });

    // Capture-phase handlers to suppress editor camera orbit listeners while in gameplay.
    // (Camera.attach() adds its listeners before EditorApp._attachInput().)
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.gameplayEnabled) return;
      // LMB captures mouse for FPS-style look.
      if (e.button === 0) {
        try { e.preventDefault(); } catch { /* ignore */ }
        try { e.stopImmediatePropagation(); } catch { /* ignore */ }
        try { this.canvas.requestPointerLock(); } catch { /* ignore */ }
        return;
      }
      // Suppress RMB orbit in gameplay (mouse is for look).
      if (e.button === 2) {
        try { e.preventDefault(); } catch { /* ignore */ }
        try { e.stopImmediatePropagation(); } catch { /* ignore */ }
      }
    }, { capture: true });

    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.gameplayEnabled) return;
      if (document.pointerLockElement === this.canvas) {
        try { this.player.look(e.movementX || 0, e.movementY || 0); } catch { /* ignore */ }
        try { e.preventDefault(); } catch { /* ignore */ }
        try { e.stopImmediatePropagation(); } catch { /* ignore */ }
      }
    }, { capture: true });

    this.canvas.addEventListener('pointermove', (e) => {
      this._pointer.x = e.clientX;
      this._pointer.y = e.clientY;
      if (this.gameplayEnabled && this._lookDrag.active) {
        const dx = e.clientX - this._lookDrag.x;
        const dy = e.clientY - this._lookDrag.y;
        this._lookDrag.x = e.clientX;
        this._lookDrag.y = e.clientY;
        try { this.player.look(dx, dy); } catch { /* ignore */ }
      }
    });
    this.canvas.addEventListener('pointerdown', (e) => {
      // RMB in gameplay = look
      if (e.button === 2 && this.gameplayEnabled) {
        this._lookDrag.active = true;
        this._lookDrag.x = e.clientX;
        this._lookDrag.y = e.clientY;
        return;
      }
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (e.button === 2) this._lookDrag.active = false;
    });

    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this._pointer.down = true;
      this._pointer.painting = (this.tool === 'paint' || this.tool === 'sculpt');
      if (this._pointer.painting) this._applyBrushFromPointer();
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (e.button !== 0) return;
      this._pointer.down = false;
      this._pointer.painting = false;
    });
  }

  _buildDockUi() {
    this._renderEditorUi();
  }

  _syncDock() {
    // Minimal: hide paint selector when sculpting, but keep UI simple.
    // (We keep it always visible for now.)
  }

  _setTool(toolId) {
    this.tool = String(toolId || 'navigate');
    if (this.tool === 'paint') this.mode = 'paint';
    if (this.tool === 'sculpt') this.mode = 'height';
    // Tool-driven mouse behavior:
    // - Navigate: LMB orbit
    // - Paint/Sculpt: LMB edits (disable LMB orbit; RMB orbit still works)
    try { this.camera.setAllowOrbitLmb?.(!(this.tool === 'paint' || this.tool === 'sculpt')); } catch { /* ignore */ }
    this._renderEditorUi();
  }

  _setTab(tabId) {
    this.inspectorTab = String(tabId || 'terrain');
    this._renderEditorUi();
  }

  _renderEditorUi() {
    const mkToolBtn = (id, label) => el('button', {
      class: 'toolBtn' + (this.tool === id ? ' active' : ''),
      onclick: () => this._setTool(id),
    }, [label]);

    // LEFT: tools
    clear(this._dockLeft);
    this._dockLeft.appendChild(el('div', { class: 'dockTitle' }, ['Tools']));
    this._dockLeft.appendChild(mkToolBtn('navigate', 'Navigate'));
    this._dockLeft.appendChild(mkToolBtn('paint', 'Paint'));
    this._dockLeft.appendChild(mkToolBtn('sculpt', 'Sculpt'));
    this._dockLeft.appendChild(mkToolBtn('select', 'Select (soon)'));
    this._dockLeft.appendChild(mkToolBtn('place', 'Place (soon)'));
    this._dockLeft.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'muted' }, [
        'Camera: ',
        el('span', { class: 'kbd' }, ['WASD']),
        ' + ',
        el('span', { class: 'kbd' }, ['Q/E']),
        ', drag orbit (RMB always, LMB in Navigate), wheel zoom.\n',
        'Paint/Sculpt tools: LMB edits, RMB orbits.',
      ]),
    ]));

    // RIGHT: inspector tabs
    clear(this._dockRight);
    this._dockRight.appendChild(el('div', { class: 'dockTitle' }, ['Inspector']));
    const tabs = [
      ['map', 'Map'],
      ['terrain', 'Terrain'],
      ['datasets', 'Datasets'],
      ['ai', 'AI'],
    ];
    this._dockRight.appendChild(el('div', { class: 'tabRow' }, tabs.map(([id, label]) => el('button', {
      class: 'tabBtn' + (this.inspectorTab === id ? ' active' : ''),
      onclick: () => this._setTab(id),
    }, [label]))));

    const body = el('div', {});
    this._dockRight.appendChild(body);

    const saveBtn = el('button', { class: 'primary', onclick: () => this.requestAutosave(true) }, ['Save now']);

    if (this.inspectorTab === 'map') {
      const regenBtn = el('button', {
        onclick: async () => {
          if (!this.map) return;
          const tid = String(this.map.templateId || '');
          const isAiCity = (tid === 'ai_city' || tid === 'ai_city_wfc');
          if (!isAiCity) return;
          const seed = String(this.map?.ai?.seed || 'ai_city');
          const gen = (tid === 'ai_city_wfc')
            ? generateAiCityWfc({ seed, gridW: this.map.grid.width, gridH: this.map.grid.height, bounds: this.map.bounds })
            : generateAiCity({ seed, gridW: this.map.grid.width, gridH: this.map.grid.height, bounds: this.map.bounds });
          this.map.ai = gen.ai;
          this.map.bounds = gen.bounds;
          this.map.grid = gen.grid;
          this.map.data.heightsU16 = gen.heightsU16;
          this.map.data.paintMaskRgba = gen.paintMaskRgba;
          this.map.data.instances = gen.instances;
          this.terrain.setBounds(this.map.bounds);
          try { this.player?.setWorldBounds?.(this.map?.bounds || null); } catch { /* ignore */ }
          try {
            this._applyWaterFromMapBounds();
          } catch { /* ignore */ }
          this.terrain.uploadHeightU16(this.map.grid.width, this.map.grid.height, this.map.data.heightsU16);
          this.terrain.uploadMaskRgba(this.map.grid.width, this.map.grid.height, this.map.data.paintMaskRgba);
          this._rebuildInstanceBuffer();
          this.requestAutosave(true);
        },
      }, ['Regenerate AI City']);

      const spawnBtn = el('button', {
        onclick: async () => {
          if (!this.map) return;
          const b = this.map.bounds;
          const cx = (b.minX + b.maxX) * 0.5;
          const cy = (b.minY + b.maxY) * 0.5;

          // Prefer spawning at Virginia Beach when a real-world dataset origin is available.
          // (Virginia Beach, VA) WGS84: lat 36.8529, lon -75.9780
          let sx = cx;
          let sy = cy;
          const dsId = (this.map?.dataset?.enabled && this.map?.dataset?.datasetId) ? String(this.map.dataset.datasetId) : '';
          const originLonLat = dsId ? (this._datasetOriginByDatasetId.get(dsId) || null) : null;
          const olon = Number(originLonLat?.[0]);
          const olat = Number(originLonLat?.[1]);
          if (Number.isFinite(olon) && Number.isFinite(olat)) {
            const [x, y] = projectLonLatMeters(-75.9780, 36.8529, olon, olat);
            // Only use the VB spawn if it lands inside the current map bounds; otherwise keep center spawn.
            if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY) {
              sx = x;
              sy = y;
            }
          }

          this.player.spawnAt(sx, sy);
          this.player.setViewMode('third'); // default
          this._enterGameplay();

          // Auto-load + spawn the default test vehicle (Abarth) so we can validate it quickly.
          try {
            const url = String(this._vehicle?.url || '').trim();
            if (this._vehicle?.enabled && url) {
              if (!this.vehicleLayer?.loaded) await this.vehicleLayer.load(url);
              this._spawnTestVehicleInFrontOfPlayer();
            }
          } catch { /* ignore */ }

          // If multiplayer is enabled, also spawn on the server so other clients see us quickly.
          try {
            if (this._mmoCfg?.enabled) {
              if (!this.mmo?.connected) {
                // If autoConnect is enabled (URL flag), connect opportunistically when spawning.
                if (this._mmoCfg.autoConnect) await this.mmo.connect();
              }
              if (this.mmo?.connected) this.mmo.spawnAt(sx, sy);
            }
          } catch { /* ignore */ }
          // Avoid accidental edits while in gameplay mode + keep LMB orbit available.
          try { this._setTool('navigate'); } catch { /* ignore */ }
          this._renderEditorUi();
        },
      }, ['Spawn character']);

      const mmoBtn = el('button', {
        class: this.mmo?.connected ? 'danger' : '',
        onclick: async () => {
          try {
            if (!this._mmoCfg?.enabled) return;
            if (this.mmo?.connected) this.mmo.disconnect();
            else await this.mmo.connect();
          } catch { /* ignore */ }
          this._renderEditorUi();
        },
        title: 'Connect to local MMO server (Colyseus)',
      }, [this.mmo?.connected ? 'Disconnect MMO' : 'Connect MMO']);

      const viewBtn = el('button', {
        onclick: () => {
          this.player.toggleViewMode();
          this._renderEditorUi();
        },
        title: 'Toggle camera view (V)',
      }, [this.player.viewMode === 'first' ? 'First person' : 'Third person']);

      const avatarEnabledToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px' } }, [
        el('input', {
          type: 'checkbox',
          checked: this._avatar?.enabled !== false,
          onchange: (e) => {
            this._avatar.enabled = !!e.target.checked;
            try { localStorage.setItem('gameplay.avatarEnabled', this._avatar.enabled ? '1' : '0'); } catch { /* ignore */ }
            this._renderEditorUi();
          },
        }),
        el('span', {}, ['Use skinned avatar (GLB)']),
      ]);

      const avatarUrlInput = el('input', {
        value: String(this._avatar?.url || ''),
        placeholder: 'Avatar GLB URL (must include animations)',
        onchange: (e) => { this._avatar.url = String(e.target.value || '').trim(); },
      });
      const avatarScaleInput = el('input', {
        type: 'number',
        value: String(Number(this._avatar?.scale ?? 1.0) || 1.0),
        step: '0.05',
        title: 'Avatar scale',
        onchange: (e) => { this._avatar.scale = Number(e.target.value) || 1.0; },
      });
      const avatarYOffsetInput = el('input', {
        type: 'number',
        value: String(Number(this._avatar?.yOffset ?? 0.0) || 0.0),
        step: '0.05',
        title: 'Avatar Y offset (meters)',
        onchange: (e) => { this._avatar.yOffset = Number(e.target.value) || 0.0; },
      });
      const avatarLoadBtn = el('button', {
        class: 'primary',
        onclick: async () => {
          const url = String(this._avatar?.url || '').trim();
          try { localStorage.setItem('gameplay.avatarUrl', url); } catch { /* ignore */ }
          try { localStorage.setItem('devtools.lastGeneratedModelUrl', url); } catch { /* ignore */ }
          try {
            if (url) await this.avatarLayer.load(url);
            else await this.avatarLayer.load('');
          } catch { /* ignore */ }
          this._renderEditorUi();
        },
        title: 'Load avatar GLB (skinned + animations)',
      }, ['Load avatar']);
      const avatarUnloadBtn = el('button', {
        class: '',
        onclick: async () => {
          this._avatar.url = '';
          try { localStorage.setItem('gameplay.avatarUrl', ''); } catch { /* ignore */ }
          try { await this.avatarLayer.load(''); } catch { /* ignore */ }
          this._renderEditorUi();
        },
      }, ['Unload']);

      const vehicleEnabledToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px' } }, [
        el('input', {
          type: 'checkbox',
          checked: this._vehicle?.enabled !== false,
          onchange: (e) => {
            this._vehicle.enabled = !!e.target.checked;
            try { localStorage.setItem('gameplay.vehicleEnabled', this._vehicle.enabled ? '1' : '0'); } catch { /* ignore */ }
            this._renderEditorUi();
          },
        }),
        el('span', {}, ['Render test vehicle (GLB)']),
      ]);
      const vehicleUrlInput = el('input', {
        value: String(this._vehicle?.url || ''),
        placeholder: 'Vehicle GLB URL (static model is fine)',
        onchange: (e) => { this._vehicle.url = String(e.target.value || '').trim(); },
      });
      const vehicleScaleInput = el('input', {
        type: 'number',
        value: String(Number(this._vehicle?.scale ?? 1.0) || 1.0),
        step: '0.05',
        title: 'Vehicle scale',
        onchange: (e) => { this._vehicle.scale = Number(e.target.value) || 1.0; },
      });
      const vehicleYOffsetInput = el('input', {
        type: 'number',
        value: String(Number(this._vehicle?.yOffset ?? 0.0) || 0.0),
        step: '0.05',
        title: 'Vehicle Y offset (meters)',
        onchange: (e) => { this._vehicle.yOffset = Number(e.target.value) || 0.0; },
      });
      const vehicleLoadBtn = el('button', {
        class: 'primary',
        onclick: async () => {
          const url = String(this._vehicle?.url || '').trim();
          try { localStorage.setItem('gameplay.vehicleUrl', url); } catch { /* ignore */ }
          try {
            if (url) await this.vehicleLayer.load(url);
            else await this.vehicleLayer.load('');
          } catch { /* ignore */ }
          // If we don't have a pose yet, drop it in front of the player.
          try { if (!this._vehiclePose) this._spawnTestVehicleInFrontOfPlayer(); } catch { /* ignore */ }
          this._renderEditorUi();
        },
        title: 'Load vehicle GLB',
      }, ['Load vehicle']);
      const vehicleSpawnBtn = el('button', {
        onclick: () => {
          try { this._spawnTestVehicleInFrontOfPlayer(); } catch { /* ignore */ }
          this._renderEditorUi();
        },
        title: 'Spawn vehicle in front of player (B)',
      }, ['Spawn (B)']);

      const npcEnabledToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px' } }, [
        el('input', {
          type: 'checkbox',
          checked: this._npc?.enabled !== false,
          onchange: (e) => {
            this._npc.enabled = !!e.target.checked;
            try { localStorage.setItem('gameplay.npcEnabled', this._npc.enabled ? '1' : '0'); } catch { /* ignore */ }
            this._renderEditorUi();
          },
        }),
        el('span', {}, ['Render NPC (skinned avatar)']),
      ]);
      const npcUrlInput = el('input', {
        value: String(this._npc?.url || ''),
        placeholder: 'NPC GLB URL (Debra locomotion pack output)',
        onchange: (e) => { this._npc.url = String(e.target.value || '').trim(); },
      });
      const npcScaleInput = el('input', {
        type: 'number',
        value: String(Number(this._npc?.scale ?? 1.0) || 1.0),
        step: '0.05',
        title: 'NPC scale',
        onchange: (e) => { this._npc.scale = Number(e.target.value) || 1.0; },
      });
      const npcYOffsetInput = el('input', {
        type: 'number',
        value: String(Number(this._npc?.yOffset ?? 0.0) || 0.0),
        step: '0.05',
        title: 'NPC Y offset (meters)',
        onchange: (e) => { this._npc.yOffset = Number(e.target.value) || 0.0; },
      });
      const npcSpeedInput = el('input', {
        type: 'number',
        value: String(Number(this._npc?.speed ?? 1.5) || 1.5),
        step: '0.05',
        title: 'NPC walk speed (m/s)',
        onchange: (e) => { this._npc.speed = Math.max(0.0, Number(e.target.value) || 1.5); },
      });
      const npcLoadBtn = el('button', {
        class: 'primary',
        onclick: async () => {
          const url = String(this._npc?.url || '').trim();
          try { localStorage.setItem('gameplay.npcUrl', url); } catch { /* ignore */ }
          try {
            if (url) await this.npcLayer.load(url);
            else await this.npcLayer.load('');
          } catch { /* ignore */ }
          try { await this._resetNpcForMap(this.map); } catch { /* ignore */ }
          this._renderEditorUi();
        },
        title: 'Load NPC GLB (skinned + animations)',
      }, ['Load NPC']);
      const npcUnloadBtn = el('button', {
        onclick: async () => {
          this._npc.url = '';
          try { localStorage.setItem('gameplay.npcUrl', ''); } catch { /* ignore */ }
          try { await this.npcLayer.load(''); } catch { /* ignore */ }
          this._renderEditorUi();
        },
      }, ['Unload']);
      const npcResetPathBtn = el('button', {
        onclick: async () => {
          try { await this._resetNpcForMap(this.map); } catch { /* ignore */ }
          this._renderEditorUi();
        },
        title: 'Recompute NPC loop from map',
      }, ['Reset path']);

      const gameplayBtn = el('button', {
        class: this.gameplayEnabled ? 'danger' : '',
        onclick: () => {
          if (this.gameplayEnabled) this._exitGameplay();
          else this._enterGameplay();
          this._renderEditorUi();
        },
      }, [this.gameplayEnabled ? 'Exit gameplay' : 'Gameplay']);

      body.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'mapName' }, ['Map']),
        el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-line' } }, [
          (() => {
            const n = this.map?.name || '';
            const t = this.map?.templateId || '';
            const s = this.map?.ai?.seed || '';
            const parts = [];
            if (n) parts.push(`Name: ${n}`);
            if (t) parts.push(`Template: ${t}`);
            if ((t === 'ai_city' || t === 'ai_city_wfc') && s) parts.push(`Seed: ${s}`);
            return parts.join('\n') || 'No map loaded.';
          })(),
        ]),
        el('div', { class: 'row', style: { marginTop: '10px' } }, [saveBtn, regenBtn]),
        el('div', { class: 'row', style: { marginTop: '8px' } }, [spawnBtn, gameplayBtn]),
        el('div', { class: 'row', style: { marginTop: '8px' } }, [mmoBtn]),
        el('div', { class: 'row', style: { marginTop: '8px' } }, [viewBtn]),
        avatarEnabledToggle,
        el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Expected clip names: idle, walk_fwd/back/left/right, run_fwd/back/left/right, jump_start/air/land.']),
        el('div', { class: 'row', style: { marginTop: '8px' } }, [avatarUrlInput]),
        el('div', { class: 'row', style: { marginTop: '8px' } }, [avatarScaleInput, avatarYOffsetInput]),
        el('div', { class: 'row', style: { marginTop: '8px' } }, [avatarLoadBtn, avatarUnloadBtn]),
        vehicleEnabledToggle,
        el('div', { class: 'row', style: { marginTop: '8px' } }, [vehicleUrlInput]),
        el('div', { class: 'row', style: { marginTop: '8px' } }, [vehicleScaleInput, vehicleYOffsetInput]),
        el('div', { class: 'row', style: { marginTop: '8px' } }, [vehicleLoadBtn, vehicleSpawnBtn]),
        npcEnabledToggle,
        el('div', { class: 'muted', style: { marginTop: '8px' } }, ['NPC: loops a simple path (N toggles NPC, J triggers jump).']),
        el('div', { class: 'row', style: { marginTop: '8px' } }, [npcUrlInput]),
        el('div', { class: 'row', style: { marginTop: '8px' } }, [npcScaleInput, npcYOffsetInput, npcSpeedInput]),
        el('div', { class: 'row', style: { marginTop: '8px' } }, [npcLoadBtn, npcUnloadBtn, npcResetPathBtn]),
        el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-line' } }, [
          'Gameplay: WASD move, Shift run. Click the 3D view to capture mouse and look around.\n' +
          'Press Esc to exit gameplay (works even with mouse captured). V toggles view, Tab toggles shoulder.\n' +
          (() => {
            if (!this.avatarLayer?.loaded) return 'Character: placeholder cube (load an avatar GLB to replace it).\n';
            const clipCount = Number(this.avatarLayer?.clipCount) || 0;
            const actionKeys = Array.isArray(this.avatarLayer?.actionKeys) ? this.avatarLayer.actionKeys : [];
            const nActions = actionKeys.length;
            const head = `Character: skinned avatar loaded (${clipCount} clip(s)${nActions ? `, ${nActions} mapped action(s)` : ''}).\n`;
            if (clipCount > 0) return head;
            return head + 'Character: no animations found in this GLB.\n' +
              'Tip: use DevTools → Animation / Retarget to bake idle/walk/run onto your rig, then load that output GLB here.\n';
          })() +
          (() => {
            const on = !!this._npc?.enabled;
            const url = String(this._npc?.url || '').trim();
            const loaded = !!this.npcLayer?.loaded;
            const clipCount = Number(this.npcLayer?.clipCount) || 0;
            const keys = Array.isArray(this.npcLayer?.actionKeys) ? this.npcLayer.actionKeys : [];
            const ktxt = keys.length ? ` keys=${keys.join(',')}` : '';
            return `NPC: ${(on ? 'enabled' : 'disabled')}, ${loaded ? `loaded (${clipCount} clip(s)${ktxt})` : (url ? 'not loaded' : 'no URL')}\n` +
              'Tip: press N to toggle NPC. Press J to trigger jump.\n';
          })() +
          (() => {
            const on = !!this._vehicle?.enabled;
            const url = String(this._vehicle?.url || '').trim();
            const loaded = !!this.vehicleLayer?.loaded;
            const pose = this._vehiclePose;
            const ptxt = pose ? ` at x=${pose.x.toFixed(2)} y=${pose.y.toFixed(2)} z=${pose.z.toFixed(2)}` : '';
            return `Vehicle: ${(on ? 'enabled' : 'disabled')}, ${loaded ? 'loaded' : (url ? 'not loaded' : 'no URL')}${ptxt}\n` +
              'Tip: press B to spawn it in front of you.\n';
          })() +
          (() => {
            if (!this._mmoCfg?.enabled) return '';
            const st = String(this.mmo?.status || 'disconnected');
            const err = String(this.mmo?.lastError || '').trim();
            const n = (this.mmo?.players && typeof this.mmo.players.size === 'number') ? this.mmo.players.size : 0;
            const line = `MMO: ${st}${(st === 'connected') ? ` (${n} players in room)` : ''}`;
            return err ? (line + `\nMMO error: ${err}`) : line;
          })() + '\n' +
          (() => {
            const p = this.player?.pos;
            const on = !!this.player?.enabled;
            if (!on || !p) return 'Player: not spawned';
            return `Player: spawned at x=${p.x.toFixed(2)} y=${p.y.toFixed(2)} z=${p.z.toFixed(2)}`;
          })(),
        ]),
      ]));
    } else if (this.inspectorTab === 'terrain') {
      const paintSel = el('select', {
        value: this.paintKind,
        onchange: (e) => { this.paintKind = e.target.value; },
      }, [
        el('option', { value: 'grass' }, ['Grass']),
        el('option', { value: 'dirt' }, ['Dirt']),
        el('option', { value: 'road' }, ['Road']),
        el('option', { value: 'street' }, ['Street']),
      ]);
      const radius = el('input', {
        type: 'range', min: '1', max: '12', step: '1', value: String(this.brushRadius),
        oninput: (e) => { this.brushRadius = Number(e.target.value) || 2; },
      });
      const heightDelta = el('input', {
        type: 'range', min: '50', max: '5000', step: '50', value: String(this.heightDelta),
        oninput: (e) => { this.heightDelta = Number(e.target.value) || 1200; },
      });

      const demToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px' } }, [
        el('input', {
          type: 'checkbox',
          checked: !!this._elevation?.useDemBboxForSampling,
          onchange: async (e) => {
            this._elevation.useDemBboxForSampling = !!e.target.checked;
            const cur = (this.map?.dataset?.enabled && this.map?.dataset?.datasetId) ? String(this.map.dataset.datasetId) : '';
            try { await this._setDataset(cur); } catch { /* ignore */ }
          },
        }),
        el('span', {}, ['Use DEM bbox for elevation mapping']),
      ]);

      const autoDemToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px' } }, [
        el('input', {
          type: 'checkbox',
          checked: this._elevation?.autoLoadDem !== false,
          onchange: async (e) => {
            this._elevation.autoLoadDem = !!e.target.checked;
            const cur = (this.map?.dataset?.enabled && this.map?.dataset?.datasetId) ? String(this.map.dataset.datasetId) : '';
            try { if (cur) await this._setDataset(cur); } catch { /* ignore */ }
            try { this._renderEditorUi(); } catch { /* ignore */ }
          },
        }),
        el('span', {}, ['Auto-load DEM when available']),
      ]);

      const heightScaleInput = el('input', {
        type: 'range',
        min: '0.5',
        max: '8',
        step: '0.1',
        value: String(Number(this._elevation?.heightScale ?? 1.0)),
        onchange: async (e) => {
          const v = Number(e.target.value);
          this._elevation.heightScale = (Number.isFinite(v) && v > 0) ? v : 1.0;
          try { if (this.map) this.map._elevation = this._elevation; } catch { /* ignore */ }
          try { this.terrain.setHeightScale(this._elevation.heightScale); } catch { /* ignore */ }
          // Re-load current dataset so grounding uses the same scale as the terrain mesh.
          const cur = (this.map?.dataset?.enabled && this.map?.dataset?.datasetId) ? String(this.map.dataset.datasetId) : '';
          try { if (cur) await this._setDataset(cur); } catch { /* ignore */ }
          try { this._renderEditorUi(); } catch { /* ignore */ }
        },
      });

      const heightmapInfo = (() => {
        const m = this.map;
        const dsId = (m?.dataset?.enabled && m?.dataset?.datasetId) ? String(m.dataset.datasetId) : '';
        const dsLine = dsId ? `Dataset: ${dsId}` : 'Dataset: none';
        const dsMsg = String(this._datasetLoadStatus?.message || '').trim();
        const dsMsgLine = dsMsg ? `Dataset status: ${dsMsg}` : '';

        if (!m?.data?.heightsU16 || !m?.grid?.width || !m?.grid?.height) {
          return [dsLine, dsMsgLine, 'Heightmap: not loaded'].filter(Boolean).join('\n');
        }
        const minZ = Number(m?.bounds?.minZ);
        const maxZ = Number(m?.bounds?.maxZ);
        const dz = (Number.isFinite(minZ) && Number.isFinite(maxZ)) ? (maxZ - minZ) : NaN;
        const hs = Number(this._elevation?.heightScale ?? 1.0);
        const bb = m?.heightmap?.bbox;
        const bboxTxt = (bb && Number.isFinite(bb.minLon) && Number.isFinite(bb.minLat) && Number.isFinite(bb.maxLon) && Number.isFinite(bb.maxLat))
          ? `bbox=[${bb.minLon.toFixed(4)},${bb.minLat.toFixed(4)} → ${bb.maxLon.toFixed(4)},${bb.maxLat.toFixed(4)}]`
          : 'bbox=missing';
        const dzTxt = Number.isFinite(dz) ? `${dz.toFixed(2)}m (effective ${(dz * ((Number.isFinite(hs) && hs > 0) ? hs : 1.0)).toFixed(2)}m @ scale ${hs.toFixed(1)})` : 'n/a';
        const hmLine = `Heightmap: ${m.grid.width}×${m.grid.height}, range=${dzTxt}, ${bboxTxt}`;

        // Helpful hint: if bbox is missing and we're still at the editor default grid, the DEM likely didn't load.
        const hint = (!String(bboxTxt).includes('bbox=[') && m.grid.width <= 128 && m.grid.height <= 128)
          ? 'Hint: select the dataset bundle that includes DEM (…_dem). If DEM is optional and missing, check the devtools Network tab for a 404 on the heightmap .json/.bin.'
          : '';

        return [dsLine, dsMsgLine, hmLine, hint].filter(Boolean).join('\n');
      })();

      const waterToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px' } }, [
        el('input', {
          type: 'checkbox',
          checked: !!this._water?.enabled,
          onchange: (e) => {
            this._water.enabled = !!e.target.checked;
            try { this._applyWaterFromMapBounds(); } catch { /* ignore */ }
            try { this._renderEditorUi(); } catch { /* ignore */ }
          },
        }),
        el('span', {}, ['Ocean water (flat plane)']),
      ]);
      const waterOpacity = el('input', {
        type: 'range',
        min: '0',
        max: '1',
        step: '0.01',
        value: String(Number(this._water?.opacity ?? 0.55)),
        oninput: (e) => {
          this._water.opacity = clamp(Number(e.target.value) || 0.55, 0, 1);
          try { this._renderEditorUi(); } catch { /* ignore */ }
        },
      });
      const oceanEastKm = el('input', {
        type: 'range',
        min: '0',
        max: '200',
        step: '1',
        value: String(Math.round((Number(this._water?.padEastMeters ?? 0) || 0) / 1000)),
        oninput: (e) => {
          const km = Math.max(0, Number(e.target.value) || 0);
          this._water.padEastMeters = km * 1000;
          try { this._applyWaterFromMapBounds(); } catch { /* ignore */ }
          try { this._renderEditorUi(); } catch { /* ignore */ }
        },
      });

      const skyToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px' } }, [
        el('input', {
          type: 'checkbox',
          checked: !!this._sky?.enabled,
          onchange: (e) => {
            this._sky.enabled = !!e.target.checked;
            try { this._renderEditorUi(); } catch { /* ignore */ }
          },
        }),
        el('span', {}, ['Sky (gradient + sun)']),
      ]);

      const postfxToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px' } }, [
        el('input', {
          type: 'checkbox',
          checked: !!this._postfx?.enabled,
          onchange: (e) => {
            this._postfx.enabled = !!e.target.checked;
            try { this._renderEditorUi(); } catch { /* ignore */ }
          },
        }),
        el('span', {}, ['PostFX (tonemap + bloom + vignette + grain)']),
      ]);

      const postfxExposure = el('input', {
        type: 'range',
        min: '0',
        max: '3',
        step: '0.01',
        value: String(Number(this._postfx?.exposure ?? 1.0)),
        oninput: (e) => {
          this._postfx.exposure = clamp(Number(e.target.value) || 1.0, 0, 3);
          try { this._renderEditorUi(); } catch { /* ignore */ }
        },
      });

      const postfxBloomToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' } }, [
        el('input', {
          type: 'checkbox',
          checked: !!this._postfx?.enableBloom,
          onchange: (e) => {
            this._postfx.enableBloom = !!e.target.checked;
            try { this._renderEditorUi(); } catch { /* ignore */ }
          },
        }),
        el('span', {}, ['Bloom']),
      ]);

      const postfxBloomStrength = el('input', {
        type: 'range',
        min: '0',
        max: '2',
        step: '0.01',
        value: String(Number(this._postfx?.bloomStrength ?? 0.52)),
        oninput: (e) => {
          this._postfx.bloomStrength = clamp(Number(e.target.value) || 0.52, 0, 2);
          try { this._renderEditorUi(); } catch { /* ignore */ }
        },
      });

      const postfxBloomThreshold = el('input', {
        type: 'range',
        min: '0',
        max: '2',
        step: '0.01',
        value: String(Number(this._postfx?.bloomThreshold ?? 0.78)),
        oninput: (e) => {
          this._postfx.bloomThreshold = clamp(Number(e.target.value) || 0.78, 0, 2);
          try { this._renderEditorUi(); } catch { /* ignore */ }
        },
      });

      const postfxBloomRadius = el('input', {
        type: 'range',
        min: '0',
        max: '3',
        step: '0.01',
        value: String(Number(this._postfx?.bloomRadius ?? 1.65)),
        oninput: (e) => {
          this._postfx.bloomRadius = clamp(Number(e.target.value) || 1.65, 0, 3);
          try { this._renderEditorUi(); } catch { /* ignore */ }
        },
      });

      const postfxVignetteToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' } }, [
        el('input', {
          type: 'checkbox',
          checked: !!this._postfx?.enableVignette,
          onchange: (e) => {
            this._postfx.enableVignette = !!e.target.checked;
            try { this._renderEditorUi(); } catch { /* ignore */ }
          },
        }),
        el('span', {}, ['Vignette']),
      ]);

      const postfxVignetteStrength = el('input', {
        type: 'range',
        min: '0',
        max: '0.5',
        step: '0.005',
        value: String(Number(this._postfx?.vignetteStrength ?? 0.12)),
        oninput: (e) => {
          this._postfx.vignetteStrength = clamp(Number(e.target.value) || 0.12, 0, 0.5);
          try { this._renderEditorUi(); } catch { /* ignore */ }
        },
      });

      const postfxVignetteSoftness = el('input', {
        type: 'range',
        min: '0.05',
        max: '0.98',
        step: '0.01',
        value: String(Number(this._postfx?.vignetteSoftness ?? 0.78)),
        oninput: (e) => {
          this._postfx.vignetteSoftness = clamp(Number(e.target.value) || 0.78, 0.05, 0.98);
          try { this._renderEditorUi(); } catch { /* ignore */ }
        },
      });

      const postfxGrainToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' } }, [
        el('input', {
          type: 'checkbox',
          checked: !!this._postfx?.enableGrain,
          onchange: (e) => {
            this._postfx.enableGrain = !!e.target.checked;
            try { this._renderEditorUi(); } catch { /* ignore */ }
          },
        }),
        el('span', {}, ['Film grain']),
      ]);

      const postfxGrainStrength = el('input', {
        type: 'range',
        min: '0',
        max: '0.1',
        step: '0.001',
        value: String(Number(this._postfx?.grainStrength ?? 0.028)),
        oninput: (e) => {
          this._postfx.grainStrength = clamp(Number(e.target.value) || 0.028, 0, 0.1);
          try { this._renderEditorUi(); } catch { /* ignore */ }
        },
      });

      body.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'mapName' }, ['Terrain']),
        el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-line' } }, [
          heightmapInfo,
          '\nTip: “Ocean water” is always flat by design. It’s great for coastal fill; disable it to see raw terrain relief.\n' +
          'Workflow:\n- Select Paint or Sculpt tool\n- LMB drag edits\n- RMB drag orbits camera',
        ]),
        el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Paint kind']),
        paintSel,
        el('div', { class: 'muted', style: { marginTop: '10px' } }, [`Brush radius: ${this.brushRadius}`]),
        radius,
        el('div', { class: 'muted', style: { marginTop: '10px' } }, [`Sculpt delta: ${this.heightDelta}`]),
        heightDelta,
        demToggle,
        autoDemToggle,
        el('div', { class: 'muted', style: { marginTop: '10px' } }, [`Height scale: ${(Number(this._elevation?.heightScale ?? 1.0)).toFixed(1)}×`]),
        heightScaleInput,
        waterToggle,
        el('div', { class: 'muted', style: { marginTop: '8px' } }, [`Water opacity: ${(Number(this._water?.opacity ?? 0.55)).toFixed(2)}`]),
        waterOpacity,
        el('div', { class: 'muted', style: { marginTop: '10px' } }, [`Ocean extent east: ${Math.round((Number(this._water?.padEastMeters ?? 0) || 0) / 1000)} km`]),
        oceanEastKm,
        el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Visuals']),
        skyToggle,
        postfxToggle,
        el('div', { class: 'muted', style: { marginTop: '8px' } }, [`PostFX exposure: ${(Number(this._postfx?.exposure ?? 1.0)).toFixed(2)}`]),
        postfxExposure,
        postfxBloomToggle,
        el('div', { class: 'muted', style: { marginTop: '6px' } }, [`Bloom strength: ${(Number(this._postfx?.bloomStrength ?? 0.52)).toFixed(2)}`]),
        postfxBloomStrength,
        el('div', { class: 'muted', style: { marginTop: '6px' } }, [`Bloom threshold: ${(Number(this._postfx?.bloomThreshold ?? 0.78)).toFixed(2)}`]),
        postfxBloomThreshold,
        el('div', { class: 'muted', style: { marginTop: '6px' } }, [`Bloom radius: ${(Number(this._postfx?.bloomRadius ?? 1.65)).toFixed(2)}`]),
        postfxBloomRadius,
        postfxVignetteToggle,
        el('div', { class: 'muted', style: { marginTop: '6px' } }, [`Vignette strength: ${(Number(this._postfx?.vignetteStrength ?? 0.12)).toFixed(3)}`]),
        postfxVignetteStrength,
        el('div', { class: 'muted', style: { marginTop: '6px' } }, [`Vignette softness: ${(Number(this._postfx?.vignetteSoftness ?? 0.78)).toFixed(2)}`]),
        postfxVignetteSoftness,
        postfxGrainToggle,
        el('div', { class: 'muted', style: { marginTop: '6px' } }, [`Film grain: ${(Number(this._postfx?.grainStrength ?? 0.028)).toFixed(3)}`]),
        postfxGrainStrength,
        el('div', { style: { marginTop: '10px' } }, [saveBtn]),
      ]));
    } else if (this.inspectorTab === 'datasets') {
      // Load manifest in background so the list is data-driven.
      if (!Array.isArray(this._datasetManifest) && !this._datasetManifestPromise) {
        this._ensureDatasetManifestLoaded()
          .then(() => { try { this._renderEditorUi(); } catch { /* ignore */ } })
          .catch(() => { try { this._renderEditorUi(); } catch { /* ignore */ } });
      }

      const currentDatasetId = (this.map?.dataset?.enabled && this.map?.dataset?.datasetId) ? String(this.map.dataset.datasetId) : '';
      const items = Array.isArray(this._datasetManifest) ? this._datasetManifest.slice() : [];
      items.sort((a, b) => String(a?.label || a?.id || '').localeCompare(String(b?.label || b?.id || '')));

      const datasetSel = el('select', { value: currentDatasetId, onchange: async (e) => this._setDataset(String(e.target.value || '')) }, [
        el('option', { value: '' }, ['Dataset overlay: none']),
        ...items.map((d) => el('option', { value: String(d?.id || '') }, [String(d?.label || d?.id || '')])),
      ]);

      const labelsToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px' } }, [
        el('input', {
          type: 'checkbox',
          checked: !!this._labels?.enabled,
          onchange: (e) => {
            this._labels.enabled = !!e.target.checked;
            try { this._bakeRoadLabelsToTerrainTexture(); } catch { /* ignore */ }
            try { this._renderEditorUi(); } catch { /* ignore */ }
          },
        }),
        el('span', {}, ['Road labels']),
      ]);

      const labelsBakeToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' } }, [
        el('input', {
          type: 'checkbox',
          checked: !!this._labels?.bakeToTerrain,
          onchange: (e) => {
            this._labels.bakeToTerrain = !!e.target.checked;
            try { this._bakeRoadLabelsToTerrainTexture(); } catch { /* ignore */ }
            try { this._renderEditorUi(); } catch { /* ignore */ }
          },
        }),
        el('span', {}, ['Bake labels onto terrain (map-like)']),
      ]);

      const streamToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px' } }, [
        el('input', {
          type: 'checkbox',
          checked: !!this._datasetStreaming?.enabled,
          onchange: async (e) => {
            this._datasetStreaming.enabled = !!e.target.checked;
            // Reload current dataset so the chosen mode applies immediately.
            const cur = (this.map?.dataset?.enabled && this.map?.dataset?.datasetId) ? String(this.map.dataset.datasetId) : '';
            try { await this._setDataset(cur); } catch { /* ignore */ }
          },
        }),
        el('span', {}, ['Stream by camera (recommended for very large datasets)']),
      ]);

      const fullWorldToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px' } }, [
        el('input', {
          type: 'checkbox',
          checked: !!this._datasetFullWorld?.enabled,
          onchange: async (e) => {
            this._datasetFullWorld.enabled = !!e.target.checked;
            // Reload current dataset so tile streamers can switch between radius vs "load all chunks".
            const cur = (this.map?.dataset?.enabled && this.map?.dataset?.datasetId) ? String(this.map.dataset.datasetId) : '';
            try { await this._setDataset(cur); } catch { /* ignore */ }
          },
        }),
        el('span', {}, ['Load full world (tiles: stream all chunks over time; can be heavy)']),
      ]);

      const extrudeToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px' } }, [
        el('input', {
          type: 'checkbox',
          checked: !!this._datasetBuildingsExtrude?.enabled,
          onchange: async (e) => {
            this._datasetBuildingsExtrude.enabled = !!e.target.checked;
            // Reload current dataset so the chosen mode applies immediately.
            const cur = (this.map?.dataset?.enabled && this.map?.dataset?.datasetId) ? String(this.map.dataset.datasetId) : '';
            try { await this._setDataset(cur); } catch { /* ignore */ }
          },
        }),
        el('span', {}, ['Extrude building footprints (GeoJSON only; slower, capped)']),
      ]);

      const extrudeCapRow = el('div', { class: 'muted', style: { marginTop: '6px' } }, [
        el('div', { class: 'row' }, [
          el('span', { style: { minWidth: '140px' } }, [`Extrude cap: ${Number(this._datasetBuildingsExtrude?.maxBuildings ?? 12000) || 12000}`]),
          el('input', {
            type: 'range',
            min: '500',
            max: '20000',
            step: '500',
            value: String(Number(this._datasetBuildingsExtrude?.maxBuildings ?? 12000) || 12000),
            oninput: (e) => {
              this._datasetBuildingsExtrude.maxBuildings = Math.max(0, Number(e.target.value) || 12000);
              try { this._renderEditorUi(); } catch { /* ignore */ }
            },
            onchange: async () => {
              const cur = (this.map?.dataset?.enabled && this.map?.dataset?.datasetId) ? String(this.map.dataset.datasetId) : '';
              try { await this._setDataset(cur); } catch { /* ignore */ }
            },
          }),
        ]),
      ]);

      const indoorsToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px' } }, [
        el('input', {
          type: 'checkbox',
          checked: !!this._indoors?.enabled,
          onchange: async (e) => {
            this._indoors.enabled = !!e.target.checked;
            // Reload current dataset so the chosen mode applies immediately.
            const cur = (this.map?.dataset?.enabled && this.map?.dataset?.datasetId) ? String(this.map.dataset.datasetId) : '';
            try { await this._setDataset(cur); } catch { /* ignore */ }
          },
        }),
        el('span', {}, ['Indoors (procedural; uses building footprints)']),
      ]);

      const indoorsDebugToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' } }, [
        el('input', {
          type: 'checkbox',
          checked: !!this._indoors?.debug,
          onchange: (e) => {
            this._indoors.debug = !!e.target.checked;
            this._indoorsLastDebugUpdateMs = 0;
            try { this._renderEditorUi(); } catch { /* ignore */ }
          },
        }),
        el('span', {}, ['Show indoor debug lines']),
      ]);

      const indoorsRadius = el('input', {
        type: 'range',
        min: '40',
        max: '400',
        step: '10',
        value: String(Number(this._indoors?.radiusMeters ?? 140) || 140),
        oninput: (e) => {
          this._indoors.radiusMeters = Math.max(10, Number(e.target.value) || 140);
          this._indoorsLastDebugUpdateMs = 0;
          try { this._renderEditorUi(); } catch { /* ignore */ }
        },
      });

      const indoorsMax = el('input', {
        type: 'range',
        min: '10',
        max: '200',
        step: '5',
        value: String(Number(this._indoors?.maxBuildings ?? 60) || 60),
        oninput: (e) => {
          this._indoors.maxBuildings = Math.max(1, Number(e.target.value) || 60);
          this._indoorsLastDebugUpdateMs = 0;
          try { this._renderEditorUi(); } catch { /* ignore */ }
        },
      });

      const radiusRow = el('div', { class: 'muted', style: { marginTop: '10px' } }, [
        el('div', { style: { marginBottom: '6px' } }, [`Streaming radius (chunks of ~${this._datasetStreaming.chunkSizeMeters}m)`]),
        el('div', { class: 'row' }, [
          el('span', { style: { minWidth: '90px' } }, [`Roads: ${this._datasetStreaming.radiusChunksRoads}`]),
          el('input', {
            type: 'range',
            min: '1',
            max: '10',
            step: '1',
            value: String(this._datasetStreaming.radiusChunksRoads),
            oninput: (e) => {
              this._datasetStreaming.radiusChunksRoads = Math.max(1, Number(e.target.value) || 4);
              try { this._updateDatasetStreaming(true); } catch { /* ignore */ }
              try { this._renderEditorUi(); } catch { /* ignore */ }
            },
          }),
        ]),
        el('div', { class: 'row', style: { marginTop: '6px' } }, [
          el('span', { style: { minWidth: '90px' } }, [`Buildings: ${this._datasetStreaming.radiusChunksBuildings}`]),
          el('input', {
            type: 'range',
            min: '1',
            max: '10',
            step: '1',
            value: String(this._datasetStreaming.radiusChunksBuildings),
            oninput: (e) => {
              this._datasetStreaming.radiusChunksBuildings = Math.max(1, Number(e.target.value) || 4);
              try { this._updateDatasetStreaming(true); } catch { /* ignore */ }
              try { this._renderEditorUi(); } catch { /* ignore */ }
            },
          }),
        ]),
      ]);

      const st = this._datasetLoadStatus || {};
      const statusText = [
        `Status: ${st.phase || 'idle'}`,
        st.datasetId ? `Dataset: ${st.datasetId}` : '',
        st.message ? `Note: ${st.message}` : '',
        (Number.isFinite(st.roadsCount) && st.roadsCount > 0) ? `Road boxes: ${st.roadsCount}` : '',
        (Number.isFinite(st.roadLabelsCount) && st.roadLabelsCount > 0) ? `Road labels: ${st.roadLabelsCount}` : '',
        (Number.isFinite(st.railCount) && st.railCount > 0) ? `Rails: ${st.railCount}` : '',
        (Number.isFinite(st.barrierCount) && st.barrierCount > 0) ? `Barriers: ${st.barrierCount}` : '',
        (Number.isFinite(st.powerLineCount) && st.powerLineCount > 0) ? `Power lines: ${st.powerLineCount}` : '',
        (Number.isFinite(st.treeCount) && st.treeCount > 0) ? `Trees: ${st.treeCount}` : '',
        (Number.isFinite(st.buildingsCount) && st.buildingsCount > 0) ? `Buildings: ${st.buildingsCount} (${this._activeBuildingsMode || 'boxes'})` : '',
        (Number.isFinite(st.propsCount) && st.propsCount > 0) ? `Props: ${st.propsCount}` : '',
        (this._indoors?.enabled && this._indoors?.debug) ? `Indoors debug: radius ${Number(this._indoors.radiusMeters) || 140}m, max ${Number(this._indoors.maxBuildings) || 60}` : '',
        st.lastError ? `Error: ${st.lastError}` : '',
      ].filter(Boolean).join('\n');
      const statusBox = el('div', { class: 'muted', style: { marginTop: '10px', whiteSpace: 'pre-line' } }, [statusText || '']);

      const nearest = this._inspect?.nearestBuilding;
      const nearestProps = nearest?.props || null;
      const hasFootprints = Array.isArray(this._activeDatasetBuildingFootprints) && this._activeDatasetBuildingFootprints.length > 0;
      const usingFootprintsTiles = !!this._buildingFootprintsTilesStreamer;
      const nearestMsg =
        nearestProps
          ? `Nearest building tags:\n${JSON.stringify(nearestProps, null, 2)}`
          : (!hasFootprints
            ? 'Nearest building tags: (not available — enable Building footprints by turning on Indoors or Extruded Buildings)'
            : (usingFootprintsTiles
              ? 'Nearest building tags: (not available — footprint tiles (BFP1) intentionally omit OSM tag dictionaries)'
              : 'Nearest building tags: (not available — this footprint has no props)'
            )
          );
      const nearestBox = el('div', { class: 'muted', style: { marginTop: '10px', whiteSpace: 'pre-line' } }, [
        nearestMsg,
      ]);

      body.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'mapName' }, ['Datasets']),
        el('div', { class: 'muted', style: { marginTop: '6px' } }, ['Overlay-only for now.']),
        datasetSel,
        labelsToggle,
        labelsBakeToggle,
        streamToggle,
        fullWorldToggle,
        extrudeToggle,
        extrudeCapRow,
        indoorsToggle,
        indoorsDebugToggle,
        el('div', { class: 'muted', style: { marginTop: '6px' } }, [`Indoors radius: ${Number(this._indoors?.radiusMeters ?? 140) || 140}m`]),
        indoorsRadius,
        el('div', { class: 'muted', style: { marginTop: '6px' } }, [`Indoors max buildings: ${Number(this._indoors?.maxBuildings ?? 60) || 60}`]),
        indoorsMax,
        radiusRow,
        statusBox,
        nearestBox,
      ]));
    } else {
      body.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'mapName' }, ['AI Pipeline']),
        el('div', { class: 'muted', style: { marginTop: '6px' } }, ['Use the bottom Asset Browser to queue generation requests and search assets.']),
      ]));
    }

    // BOTTOM: Asset browser + generation
    clear(this._dockBottom);
    this._dockBottom.appendChild(el('div', { class: 'dockTitle' }, ['Asset Browser']));
    const bottomGrid = el('div', { class: 'bottomGrid' });
    this._dockBottom.appendChild(bottomGrid);

    const assetQuery = el('input', { placeholder: 'Search assets (in assets/)…', value: '' });
    const assetList = el('div', { class: 'scrollArea' });
    const searchBtn = el('button', {
      onclick: async () => {
        const q = String(assetQuery.value || '');
        const res = await fetch(`/__editor_assets_index?query=${encodeURIComponent(q)}&ext=.obj,.bin,.ktx2,.png,.jpg,.glb,.gltf,.geojson`);
        const j = await res.json().catch(() => null);
        clear(assetList);
        if (!j?.ok) {
          assetList.appendChild(el('div', { class: 'muted' }, ['Asset index failed (dev server only).']));
          return;
        }
        const items = (j.items || []).slice(0, 60);
        if (!items.length) assetList.appendChild(el('div', { class: 'muted' }, ['No matches']));
        for (const it of items) {
          assetList.appendChild(el('div', { class: 'row' }, [
            el('div', { class: 'muted', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, [it.path]),
            el('button', {
              onclick: () => {
                if (!this.map) return;
                this.map.data.instances.push({
                  id: 'inst_' + Math.random().toString(36).slice(2, 10),
                  kind: 'custom',
                  assetPath: it.path,
                  pos: [0, 0, 0],
                  yawDeg: 0,
                  scale: 1.0,
                  snapToTerrain: true,
                });
                this._rebuildInstanceBuffer();
                this.requestAutosave();
              },
            }, ['Place']),
          ]));
        }
      },
    }, ['Search']);

    const left = el('div', { class: 'card', style: { marginTop: '0' } }, [
      el('div', { class: 'mapName' }, ['Search']),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [assetQuery, searchBtn]),
      el('div', { style: { marginTop: '8px' } }, [assetList]),
    ]);

    const genPrompt = el('textarea', { rows: 3, placeholder: 'Request an asset… (model/texture/etc)' });
    const genBtn = el('button', {
      onclick: async () => {
        const prompt = String(genPrompt.value || '').trim();
        if (!prompt) return;
        const payload = {
          kind: 'model',
          prompt,
          nameHint: prompt.slice(0, 60),
          desiredFormats: ['.bin', '.ktx2'],
          targetDir: 'assets/user_generated/',
          mapId: this.map?.id || null,
        };
        const resp = await fetch('/__editor_request_asset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const j = await resp.json().catch(() => null);
        if (j?.ok) {
          genPrompt.value = '';
          alert('Asset request saved (dev server).');
        } else {
          alert('Asset request failed (dev server only).');
        }
      },
    }, ['Request generation']);

    const genAiCityPackBtn = el('button', {
      onclick: async () => {
        const tid = String(this.map?.templateId || '');
        const isAiCity = (tid === 'ai_city' || tid === 'ai_city_wfc');
        if (!this.map || !isAiCity) {
          alert('Load an AI City map first.');
          return;
        }
        const requests = [
          { kind: 'model', nameHint: 'ai_city_tree_01', prompt: 'Stylized game-ready tree, trunk + canopy, suitable for instancing.', desiredFormats: ['.bin', '.ktx2'], targetDir: 'assets/ai_city/trees/' },
          { kind: 'model', nameHint: 'ai_city_house_01', prompt: 'Small suburban house, 1-2 floors, simple roof, game-ready.', desiredFormats: ['.bin', '.ktx2'], targetDir: 'assets/ai_city/houses/' },
          { kind: 'model', nameHint: 'ai_city_building_01', prompt: 'Small city mid-rise building, 6-10 floors, simple facade, game-ready.', desiredFormats: ['.bin', '.ktx2'], targetDir: 'assets/ai_city/buildings/' },
          { kind: 'model', nameHint: 'ai_city_car_01', prompt: 'Compact car, low poly game-ready, clean topology.', desiredFormats: ['.bin', '.ktx2'], targetDir: 'assets/ai_city/cars/' },
        ];
        for (const r of requests) {
          // eslint-disable-next-line no-await-in-loop
          await fetch('/__editor_request_asset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...r, mapId: this.map.id }) });
        }
        alert('AI City asset pack requests saved (dev server).');
      },
    }, ['Request AI City asset pack']);

    const right = el('div', { class: 'card', style: { marginTop: '0' } }, [
      el('div', { class: 'mapName' }, ['Generation']),
      el('div', { class: 'muted', style: { marginTop: '6px' } }, ['Writes JSON requests for your external generator.']),
      genPrompt,
      el('div', { class: 'row', style: { marginTop: '8px' } }, [genBtn, genAiCityPackBtn]),
    ]);

    bottomGrid.appendChild(left);
    bottomGrid.appendChild(right);

    // When in gameplay mode, hide heavy editor panels and show minimal UI.
    const inGame = this.appMode === 'gameplay';
    try { this._dockBottom.style.display = inGame ? 'none' : 'block'; } catch { /* ignore */ }
    try { this._dockLeft.style.display = inGame ? 'none' : 'block'; } catch { /* ignore */ }
  }

  async loadMap(map) {
    this.map = map;
    this._didInitialDatasetFrame = false;
    // Room-sim: always regenerate instances from current generator on load.
    // Saved maps in localStorage can contain stale instance records (missing meta.sx/sz),
    // which makes collision silently skip walls.
    try {
      const tid = String(map?.templateId || '');
      if (tid === 'room_sim' && map?.data) {
        const params = await this._loadRoomSimPenthouseParamsFromAsset(map);
        const layout = buildRoomSimPenthouseLayout(params);
        const inst = Array.isArray(layout?.instances) ? layout.instances : [];
        if (inst.length) map.data.instances = inst;
        const b = layout?.bounds;
        if (b && Number.isFinite(b.minX) && Number.isFinite(b.maxX) && Number.isFinite(b.minY) && Number.isFinite(b.maxY)) {
          map.bounds.minX = b.minX; map.bounds.maxX = b.maxX;
          map.bounds.minY = b.minY; map.bounds.maxY = b.maxY;
          map.bounds.minZ = Number.isFinite(b.minZ) ? b.minZ : (map.bounds.minZ ?? 0);
          map.bounds.maxZ = Number.isFinite(b.maxZ) ? b.maxZ : (map.bounds.maxZ ?? 4);
        }
      }
    } catch { /* ignore */ }
    // NPC pathing is map-dependent (room-sim penthouse gets a nice indoor loop).
    try { await this._resetNpcForMap(map); } catch { /* ignore */ }
    // Reset world-scale visual bounds and water masking state for the new map.
    this._worldBoundsOverride = null;
    this._hasOsmWater = false;
    this._activeWaterPolygons = null;
    this._activeWaterLevelY = 0.0;
    try { this.terrain.clearWaterMask(); } catch { /* ignore */ }
    // For brand-new Hampton Roads maps, start the *initial* camera view in Virginia Beach (not the dataset centroid).
    // Key trick: seed a stable dataset origin upfront so loaders project into the same meter-frame we preview in.
    try {
      const tid = String(map?.templateId || '');
      const dsId = (map?.dataset?.enabled && map?.dataset?.datasetId) ? String(map.dataset.datasetId) : '';
      const isHr = tid === 'hampton_roads_osm' || tid === 'hampton_roads_osm_overture' || tid.includes('hampton_roads') || dsId.includes('hampton_roads');
      const b = map?.bounds || null;
      const isPlaceholderBounds = !!b
        && Number(b.minX) === -500 && Number(b.maxX) === 500
        && Number(b.minY) === -500 && Number(b.maxY) === 500;
      if (isHr && dsId && isPlaceholderBounds) {
        // Virginia Beach, VA (WGS84 lon/lat)
        const vbLonLat = [-75.9780, 36.8529];
        // Set origin if not already known.
        if (!this._datasetOriginByDatasetId.get(dsId)) this._datasetOriginByDatasetId.set(dsId, vbLonLat);
        // Preview bounds: a modest city-scale window around VB while the dataset streams in.
        // Since origin==VB, the VB point maps to (0,0) in projected meters.
        const r = 9000;
        map.bounds.minX = -r;
        map.bounds.maxX = r;
        map.bounds.minY = -r;
        map.bounds.maxY = r;
      }
    } catch { /* ignore */ }
    // Make elevation settings accessible to map-space helpers (sampling uses map._elevation).
    try { this.map._elevation = this._elevation; } catch { /* ignore */ }
    // Initialize renderers
    await this.terrain.init(map.grid.width, map.grid.height);
    await this.water.init();
    await this.osmWater.init();
    await this.osmWaterShoreline.init();
    await this.osmWaterways.init();
    await this.osmLines.init();
    await this.osmLinesState.init();
    await this.osmRoads.init();
    await this.osmRails.init();
    await this.osmBarriers.init();
    await this.osmPowerLines.init();
    await this.osmTrees.init();
    await this.osmBuildings.init();
    await this.osmBuildingsTiles.init();
    await this.osmBuildingsTilesFar.init();
    await this.osmBuildingsTilesSuperFar.init();
    await this.osmProps.init();
    await this.osmBuildingsExtruded.init();
    await this.indoorDebugLines.init();
    await this.instances.init();
    await this.playerViz.init();
    await this.remotePlayersViz.init();
    try { await this.avatarLayer.init(); } catch { /* ignore */ }
    try {
      this.avatarLayer.enabled = !!this._avatar.enabled;
      this.avatarLayer.scale = Number(this._avatar.scale) || 1.0;
      this.avatarLayer.yOffset = Number(this._avatar.yOffset) || 0.0;
      if (this._avatar.url) await this.avatarLayer.load(this._avatar.url);
    } catch { /* ignore */ }
    try { await this.npcLayer.init(); } catch { /* ignore */ }
    try {
      this.npcLayer.enabled = !!this._npc.enabled;
      this.npcLayer.scale = Number(this._npc.scale) || 1.0;
      this.npcLayer.yOffset = Number(this._npc.yOffset) || 0.0;
      if (this._npc.url) await this.npcLayer.load(this._npc.url);
    } catch { /* ignore */ }
    try { await this.vehicleLayer.init(); } catch { /* ignore */ }
    try {
      this.vehicleLayer.enabled = !!this._vehicle.enabled;
      this.vehicleLayer.scale = Number(this._vehicle.scale) || 1.0;
      this.vehicleLayer.yOffset = Number(this._vehicle.yOffset) || 0.0;
      if (this._vehicle.url) await this.vehicleLayer.load(this._vehicle.url);
      if (!this._vehiclePose && this.player?.enabled) this._spawnTestVehicleInFrontOfPlayer();
    } catch { /* ignore */ }
    // Visual pipeline
    try { await this.sky.init(); } catch { /* ignore */ }
    try { await this.postfx.init(); } catch { /* ignore */ }
    this.terrain.setBounds(map.bounds);
    try { this.terrain.setHeightScale(Number(this._elevation?.heightScale ?? 1.0)); } catch { /* ignore */ }
    // Coastal preset: when using Virginia/Hampton Roads templates, default to a visible Atlantic "ocean" area.
    try {
      const tid = String(map?.templateId || '');
      const hasWorldBbox = !!map?.worldBboxWgs84;
      const isVaLike = hasWorldBbox && (tid.includes('hampton_roads') || tid.includes('virginia'));
      if (isVaLike) {
        this._water.enabled = true;
        // Push ocean mostly to the east (Atlantic). Keep other directions small so we don't surround the whole state in water.
        this._water.padEastMeters = Math.max(Number(this._water.padEastMeters) || 0, 90000); // 90km
        this._water.padNorthMeters = Math.max(Number(this._water.padNorthMeters) || 0, 12000); // 12km
        this._water.padSouthMeters = Math.max(Number(this._water.padSouthMeters) || 0, 12000); // 12km
        this._water.padWestMeters = Math.max(Number(this._water.padWestMeters) || 0, 2000); // 2km
        this._water.padFactor = Math.max(Number(this._water.padFactor) || 0.06, 0.08);
      }
    } catch { /* ignore */ }
    this._applyWaterFromMapBounds();
    this.terrain.uploadHeightU16(map.grid.width, map.grid.height, map.data.heightsU16);
    this.terrain.uploadMaskRgba(map.grid.width, map.grid.height, map.data.paintMaskRgba);
    this._applyTerrainWaterMask();
    this._rebuildInstanceBuffer();
    // Keep player constrained to current map bounds (prevents walking off-world
    // even if wall colliders are missing or reconciliation nudges us out).
    try { this.player?.setWorldBounds?.(map?.bounds || null); } catch { /* ignore */ }

    // Frame camera close to map
    const b = map.bounds;
    const aabbMin = [b.minX, b.minZ, b.minY];
    const aabbMax = [b.maxX, b.maxZ, b.maxY];
    this.camera.frameAABB(aabbMin, aabbMax);
    // Keep initial camera orientation consistent across templates.

    // Load dataset overlay if enabled
    if (map.dataset?.enabled && map.dataset?.datasetId) {
      await this._setDataset(map.dataset.datasetId);
    } else {
      try { this.osmWater.clear(); } catch { /* ignore */ }
      try { this.osmWaterShoreline.setLinesPositions(new Float32Array(0)); } catch { /* ignore */ }
      try { this.osmWaterways.setInstances(new Float32Array(0), 0); } catch { /* ignore */ }
      try { this.osmPowerLines.setLinesPositions(new Float32Array(0)); } catch { /* ignore */ }
      this._hasOsmWater = false;
      this._activeWaterPolygons = null;
      this._activeWaterLevelY = 0.0;
      try { this.terrain.clearWaterMask(); } catch { /* ignore */ }
      this.osmLines.setLinesPositions(new Float32Array(0));
      try { this.osmLinesState.setLinesPositions(new Float32Array(0)); } catch { /* ignore */ }
      this.osmRoads.setInstances(new Float32Array(0), 0);
      this.osmRails.setInstances(new Float32Array(0), 0);
      this.osmBarriers.setInstances(new Float32Array(0), 0);
      this.osmTrees.setInstances(new Float32Array(0), 0);
      this.osmBuildings.setInstances(new Float32Array(0), 0);
      this.osmProps.setInstances(new Float32Array(0), 0);
      try { this.osmBuildingsExtruded.clear(); } catch { /* ignore */ }
      try { this.indoorDebugLines.setLinesPositions(new Float32Array(0)); } catch { /* ignore */ }
      this._activeDatasetBuildingFootprints = [];
      this._activeBuildingsMode = 'boxes';
    }
    // City label depends on map + dataset selection; loadMap is where those are set.
    try { await this._ensureDatasetManifestLoaded(); } catch { /* ignore */ }
    try { this._updateCityLabel(); } catch { /* ignore */ }
  }

  async _setDataset(datasetId) {
    if (!this.map) return;
    if (!datasetId) {
      this.map.dataset = { enabled: false, datasetId: '', fitToBounds: true };
      try { this.osmWater.clear(); } catch { /* ignore */ }
      try { this.osmWaterShoreline.setLinesPositions(new Float32Array(0)); } catch { /* ignore */ }
      try { this.osmWaterways.setInstances(new Float32Array(0), 0); } catch { /* ignore */ }
      try { this.osmPowerLines.setLinesPositions(new Float32Array(0)); } catch { /* ignore */ }
      this._hasOsmWater = false;
      this._activeWaterPolygons = null;
      this._activeWaterLevelY = 0.0;
      try { this.terrain.clearWaterMask(); } catch { /* ignore */ }
      this.osmLines.setLinesPositions(new Float32Array(0));
      try { this.osmLinesState.setLinesPositions(new Float32Array(0)); } catch { /* ignore */ }
      this.osmRoads.setInstances(new Float32Array(0), 0);
      this.osmRails.setInstances(new Float32Array(0), 0);
      this.osmBarriers.setInstances(new Float32Array(0), 0);
      this.osmTrees.setInstances(new Float32Array(0), 0);
      this.osmBuildings.setInstances(new Float32Array(0), 0);
      this.osmProps.setInstances(new Float32Array(0), 0);
      try { this.osmBuildingsExtruded.clear(); } catch { /* ignore */ }
      try { this.indoorDebugLines.setLinesPositions(new Float32Array(0)); } catch { /* ignore */ }
      this._activeDatasetBuildingFootprints = [];
      this._activeBuildingsMode = 'boxes';
      this._activeDatasetStreamState = null;
      this._activeRoadLabels = [];
      this._datasetLoadStatus = { phase: 'idle', datasetId: '', message: '', roadsCount: 0, roadLabelsCount: 0, railCount: 0, barrierCount: 0, powerLineCount: 0, treeCount: 0, buildingsCount: 0, propsCount: 0, lastError: '' };
      this.requestAutosave();
      try { this._updateCityLabel(); } catch { /* ignore */ }
      return;
    }
    this.map.dataset = { enabled: true, datasetId, fitToBounds: true };
    this.requestAutosave();
    try { await this._ensureDatasetManifestLoaded(); } catch { /* ignore */ }
    try { this._updateCityLabel(); } catch { /* ignore */ }

    this._datasetLoadStatus = { phase: 'loading', datasetId, message: 'Loading…', roadsCount: 0, roadLabelsCount: 0, railCount: 0, barrierCount: 0, powerLineCount: 0, treeCount: 0, buildingsCount: 0, propsCount: 0, lastError: '' };
    try { this._renderEditorUi(); } catch { /* ignore */ }

    await this._ensureDatasetManifestLoaded();
    let ids = resolveDatasetBundle(this._datasetManifest, datasetId);
    // Auto-apply DEM (heightmap) when available.
    // Rationale: users expect terrain to just work if the heightmap assets are present locally,
    // even if they selected a non-DEM "scene" bundle.
    try {
      const wantAuto = this._elevation?.autoLoadDem !== false;
      const hasHm = Array.isArray(ids) && ids.some((x) => {
        const d = (Array.isArray(this._datasetManifest) ? this._datasetManifest.find((e) => String(e?.id || '') === String(x)) : null);
        return String(d?.kind || '') === 'heightmap-u16';
      });
      if (wantAuto && !hasHm) {
        // Today we only have one high-signal DEM: Hampton Roads.
        // Extend this map as you add more DEM assets.
        const dsKey = String(datasetId || '');
        const demByRegion = {
          hampton_roads: 'dem_va_hampton_roads_heightmap_u16',
        };
        const matchKey = Object.keys(demByRegion).find((k) => dsKey.includes(k)) || '';
        const demId = matchKey ? demByRegion[matchKey] : '';
        if (demId && Array.isArray(this._datasetManifest)) {
          const demEntry = this._datasetManifest.find((d) => String(d?.id || '') === String(demId)) || null;
          if (demEntry && String(demEntry.kind || '') === 'heightmap-u16') {
            // Put heightmap first so terrain buffers exist before grounding overlays.
            ids = [demId, ...ids];
          }
        }
      }
    } catch { /* ignore */ }
    const allVerts = [];
    const stateVerts = [];
    let boundsMin = [Infinity, Infinity, Infinity];
    let boundsMax = [-Infinity, -Infinity, -Infinity];
    const roadInst = [];
    /** @type {{ x: number, z: number, text: string, kind: string, priority: number }[]} */
    const roadLabels = [];
    const railInst = [];
    const barrierInst = [];
    const powerLineVerts = [];
    const treeInst = [];
    const buildingInst = [];
    const propsInst = [];
    /** @type {{ ringXZ: number[][], centerXZ: [number, number], minY: number, maxY: number, color: number[] }[]} */
    const buildingFootprints = [];
    const floatsPerRoad = 11;
    const floatsPerRail = 11;
    const floatsPerBarrier = 11;
    const floatsPerTrees = 11;
    const floatsPerInst = 11; // InstancedBoxRenderer packing
    const floatsPerProps = 11; // InstancedBoxRenderer packing
    let originLonLat = this._datasetOriginByDatasetId.get(datasetId) || null;
    let wantsExtruded = !!this._datasetBuildingsExtrude?.enabled;
    const wantsIndoors = !!this._indoors?.enabled;
    let wantsFootprints = wantsExtruded || wantsIndoors;

    // Clear current overlay immediately so we don't show stale data while loading.
    try { this.osmWater.clear(); } catch { /* ignore */ }
    try { this.osmWaterShoreline.setLinesPositions(new Float32Array(0)); } catch { /* ignore */ }
    try { this.osmWaterways.setInstances(new Float32Array(0), 0); } catch { /* ignore */ }
    try { this.osmPowerLines.setLinesPositions(new Float32Array(0)); } catch { /* ignore */ }
    this.osmLines.setLinesPositions(new Float32Array(0));
    this.osmRoads.setInstances(new Float32Array(0), 0);
    this.osmRails.setInstances(new Float32Array(0), 0);
    this.osmBarriers.setInstances(new Float32Array(0), 0);
    this.osmTrees.setInstances(new Float32Array(0), 0);
    this.osmBuildings.setInstances(new Float32Array(0), 0);
    this.osmProps.setInstances(new Float32Array(0), 0);
    try { this.osmBuildingsTiles.setChunks([]); } catch { /* ignore */ }
    try { this.osmBuildingsTilesFar.setChunks([]); } catch { /* ignore */ }
    try { this.osmBuildingsTilesSuperFar.setChunks([]); } catch { /* ignore */ }
    try { this.osmBuildingsExtruded.clear(); } catch { /* ignore */ }
    try { this.indoorDebugLines.setLinesPositions(new Float32Array(0)); } catch { /* ignore */ }
    this._activeBuildingsMode = 'boxes';
    this._activeDatasetBuildingFootprints = [];
    this._activeRoadLabels = [];
    this._activeDatasetStreamState = null;
    this._hasOsmWater = false;
    try { if (this._buildingTilesStreamer) this._buildingTilesStreamer.dispose(); } catch { /* ignore */ }
    this._buildingTilesStreamer = null;
    try { if (this._buildingTilesStreamerFar) this._buildingTilesStreamerFar.dispose(); } catch { /* ignore */ }
    this._buildingTilesStreamerFar = null;
    try { if (this._buildingTilesStreamerSuperFar) this._buildingTilesStreamerSuperFar.dispose(); } catch { /* ignore */ }
    this._buildingTilesStreamerSuperFar = null;
    try { if (this._buildingFootprintsTilesStreamer) this._buildingFootprintsTilesStreamer.dispose(); } catch { /* ignore */ }
    this._buildingFootprintsTilesStreamer = null;

    const originKey = (ol) => {
      const lon = Number(ol?.[0]);
      const lat = Number(ol?.[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return 'none';
      return `${lon.toFixed(6)},${lat.toFixed(6)}`;
    };

    const kindPri = (k) => {
      const s = String(k || '');
      if (s === 'heightmap-u16') return -1;
      if (s === 'geojson-wgs84-lines') return 0;
      if (s === 'geojson-wgs84-powerlines') return 0.6;
      if (s === 'geojson-wgs84-water') return 0.75;
      if (s === 'geojson-wgs84-roads') return 1.0;
      if (s === 'geojson-wgs84-rails') return 1.1;
      if (s === 'geojson-wgs84-barriers') return 1.2;
      if (s === 'geojson-wgs84-trees') return 1.3;
      if (s === 'geojson-wgs84-props') return 1.5;
      if (s === 'geojson-wgs84-buildings') return 2.0;
      if (s === 'tiles-footprints-buildings') return 2.5;
      if (s === 'instanced-tiles-buildings' || s === 'instanced-tiles-buildings-multilod') return 3.0;
      return 99;
    };
    const entries = [];
    for (const id of ids) {
      const entry = this._datasetManifest.find((d) => d.id === id);
      if (!entry) continue;
      if (entry.kind !== 'geojson-wgs84-lines' && entry.kind !== 'geojson-wgs84-water' && entry.kind !== 'geojson-wgs84-roads' && entry.kind !== 'geojson-wgs84-rails' && entry.kind !== 'geojson-wgs84-barriers' && entry.kind !== 'geojson-wgs84-powerlines' && entry.kind !== 'geojson-wgs84-trees' && entry.kind !== 'geojson-wgs84-props' && entry.kind !== 'geojson-wgs84-buildings' && entry.kind !== 'tiles-footprints-buildings' && entry.kind !== 'heightmap-u16' && entry.kind !== 'instanced-tiles-buildings' && entry.kind !== 'instanced-tiles-buildings-multilod') continue;
      entries.push(entry);
    }
    entries.sort((a, b) => kindPri(a.kind) - kindPri(b.kind));

    // If this dataset includes pre-tiled buildings, force a consistent originLonLat BEFORE loading roads/lines.
    // Otherwise roads (GeoJSON) may choose a different origin than the tiler used, causing visible offsets.
    const tilesEntry = entries.find((e) => e.kind === 'instanced-tiles-buildings' || e.kind === 'instanced-tiles-buildings-multilod');
    const footprintsTilesEntry = entries.find((e) => e.kind === 'tiles-footprints-buildings');
    const geoBuildingsEntry = entries.find((e) => e.kind === 'geojson-wgs84-buildings');

    // Auto-extrude small/medium GeoJSON building datasets (realistic footprints) when no tiles are present.
    // Keeps huge metros safe (they should use tile formats instead).
    const isHugeMetroDataset = String(datasetId || '').includes('hampton_roads');
    const geoMaxBuildings = geoBuildingsEntry ? Math.max(0, Number(geoBuildingsEntry.maxBuildings ?? 20000) || 20000) : 0;
    const autoExtrude = !!geoBuildingsEntry && !tilesEntry && !footprintsTilesEntry && !isHugeMetroDataset && geoMaxBuildings <= 60000;
    if (autoExtrude) wantsExtruded = true;
    wantsFootprints = wantsExtruded || wantsIndoors;

    if (tilesEntry) wantsExtruded = false; // tiles are instanced boxes today
    // If we have pre-tiled footprints, we can extrude in a near-camera radius even for huge datasets.
    if (footprintsTilesEntry) wantsExtruded = false;
    if ((tilesEntry || footprintsTilesEntry) && !originLonLat) {
      try {
        const resp = await fetch(String((tilesEntry?.url || footprintsTilesEntry?.url || '')));
        if (resp.ok) {
          const idx = await resp.json().catch(() => null);
          const ol = idx?.originLonLat;
          const lon = Number(ol?.[0]);
          const lat = Number(ol?.[1]);
          if (Number.isFinite(lon) && Number.isFinite(lat)) {
            originLonLat = [lon, lat];
            this._datasetOriginByDatasetId.set(datasetId, originLonLat);
          }
        }
      } catch { /* ignore */ }
    }

    const applyOverlayPartial = ({ applyRoads = true, applyBuildings = true } = {}) => {
      this.osmLines.setLinesPositions(new Float32Array(allVerts));
      try { this.osmLinesState.setLinesPositions(new Float32Array(stateVerts)); } catch { /* ignore */ }
      const roadsFull = applyRoads ? new Float32Array(roadInst) : new Float32Array(0);
      const railsFull = new Float32Array(railInst);
      const barriersFull = new Float32Array(barrierInst);
      const powerLinesFull = new Float32Array(powerLineVerts);
      const treesFull = new Float32Array(treeInst);
      const buildingsFull = applyBuildings ? new Float32Array(buildingInst) : new Float32Array(0);
      const propsFull = new Float32Array(propsInst);
      const roadCountFull = Math.floor(roadsFull.length / floatsPerRoad);
      const railCountFull = Math.floor(railsFull.length / floatsPerRail);
      const barrierCountFull = Math.floor(barriersFull.length / floatsPerBarrier);
      const powerLineCountFull = Math.floor(powerLinesFull.length / 6); // 2 verts per seg, 3 floats per vert
      const treeCountFull = Math.floor(treesFull.length / floatsPerTrees);
      const buildingCountFull = Math.floor(buildingsFull.length / floatsPerInst);
      const propsCountFull = Math.floor(propsFull.length / floatsPerProps);
      try {
        this._datasetLoadStatus.roadsCount = roadCountFull;
        this._datasetLoadStatus.railCount = railCountFull;
        this._datasetLoadStatus.barrierCount = barrierCountFull;
        this._datasetLoadStatus.powerLineCount = powerLineCountFull;
        this._datasetLoadStatus.treeCount = treeCountFull;
        this._datasetLoadStatus.buildingsCount = buildingCountFull;
        this._datasetLoadStatus.propsCount = propsCountFull;
        this._datasetLoadStatus.message = applyBuildings ? 'Loaded roads+buildings (may stream by camera).' : 'Loaded roads; buildings still loading…';
        this._datasetLoadStatus.phase = 'loading';
        this._renderEditorUi();
      } catch { /* ignore */ }

      // Details: always applied (cheap enough, and not streamed today).
      try { this.osmRails.setInstances(railsFull, railCountFull); } catch { /* ignore */ }
      try { this.osmBarriers.setInstances(barriersFull, barrierCountFull); } catch { /* ignore */ }
      try { this.osmPowerLines.setLinesPositions(powerLinesFull); } catch { /* ignore */ }
      try { this.osmTrees.setInstances(treesFull, treeCountFull); } catch { /* ignore */ }

      // Props are always applied (they're cheap and don't participate in streaming today).
      try { this.osmProps.setInstances(propsFull, propsCountFull); } catch { /* ignore */ }

      // Stream if very large so the renderer always shows something near the camera.
      const isHugeMetro = String(datasetId || '').includes('hampton_roads');
      const shouldStream = !!this._datasetStreaming?.enabled && (isHugeMetro || roadCountFull > 90000 || buildingCountFull > 25000);
      if (shouldStream) {
        this._activeDatasetStreamState = this._buildDatasetStreamState({
          datasetId,
          roadsFull,
          buildingsFull,
          floatsPerRoad,
          floatsPerInst,
          chunkSizeMeters: this._datasetStreaming.chunkSizeMeters,
        });
        this._updateDatasetStreaming(true);
      } else {
        this._activeDatasetStreamState = null;
        this.osmRoads.setInstances(roadsFull, roadCountFull);
        this.osmBuildings.setInstances(buildingsFull, buildingCountFull);
      }
    };

    let startedBuildings = false;
    try {
      for (const entry of entries) {
      const id = entry.id;
      if (entry.kind === 'heightmap-u16') {
        try {
          const hm = await loadHeightmapU16(entry.url);
          if (!this.map) continue;

          const fullW = hm.width;
          const fullH = hm.height;
          // TerrainRenderer is CPU-meshed; keep render grid modest even if the DEM is high-res.
          const maxGrid = Math.max(64, Math.floor(Number(this._elevation?.maxTerrainGrid ?? 256) || 256));
          const renderW = Math.min(fullW, maxGrid);
          const renderH = Math.min(fullH, maxGrid);
          const needResize = this.map.grid?.width !== renderW || this.map.grid?.height !== renderH;

          // Ensure map buffers match.
          this.map.grid = { width: renderW, height: renderH };
          // Keep full-res DEM for accurate sampling/grounding, but render a downsampled grid for terrain.
          if (!this.map.heightmap) this.map.heightmap = {};
          this.map.heightmap.fullGrid = { width: fullW, height: fullH };
          this.map.heightmap.heightsU16Full = (hm.heightsU16 instanceof Uint16Array) ? hm.heightsU16 : new Uint16Array(fullW * fullH);
          this.map.data.heightsU16 = downsampleU16Nearest(this.map.heightmap.heightsU16Full, fullW, fullH, renderW, renderH);

          if (!this.map.data.paintMaskRgba || this.map.data.paintMaskRgba.length !== renderW * renderH * 4) {
            const mask = new Uint8Array(renderW * renderH * 4);
            for (let i = 0; i < renderW * renderH; i++) {
              const bi = i * 4;
              mask[bi + 0] = 255; // grass default
              mask[bi + 1] = 0;
              mask[bi + 2] = 0;
              mask[bi + 3] = 0;
            }
            this.map.data.paintMaskRgba = mask;
          }

          // Apply vertical range in meters (keeps existing XY extents, which may be set by vector overlays).
          const b = this.map.bounds;
          if (Number.isFinite(hm.minZ)) b.minZ = hm.minZ;
          if (Number.isFinite(hm.maxZ)) b.maxZ = hm.maxZ;

          // Stash optional bbox metadata:
          // - Geographic WGS84 bbox: {minLon,minLat,maxLon,maxLat} (needs originLonLat to project into meters)
          // - Meter bbox: {minX,maxX,minY,maxY} (already in projected meters; can apply immediately)
          try {
            const bb = hm?.bbox || hm?.meta?.bbox;
            if (bb && typeof bb === 'object') {
              const minLon = Number(bb.minLon);
              const minLat = Number(bb.minLat);
              const maxLon = Number(bb.maxLon);
              const maxLat = Number(bb.maxLat);
              const isGeo =
                Number.isFinite(minLon) && Number.isFinite(minLat) &&
                Number.isFinite(maxLon) && Number.isFinite(maxLat) &&
                (maxLon > minLon) && (maxLat > minLat);
              if (isGeo) {
                // Later: set XY bounds consistently once dataset origin is known.
                // (The OSM overlay uses a projected-meters frame around an originLonLat; fitToBounds uses that too.)
                if (!this.map.heightmap) this.map.heightmap = {};
                this.map.heightmap.bbox = { minLon, minLat, maxLon, maxLat };
                if (originLonLat) {
                  try { computeHeightmapMeterBoundsFromBbox(this.map, originLonLat); } catch { /* ignore */ }
                }
              } else {
                const minX = Number(bb.minX);
                const maxX = Number(bb.maxX);
                const minY = Number(bb.minY);
                const maxY = Number(bb.maxY);
                const isMeters =
                  Number.isFinite(minX) && Number.isFinite(maxX) &&
                  Number.isFinite(minY) && Number.isFinite(maxY) &&
                  (maxX > minX) && (maxY > minY);
                if (isMeters) {
                  b.minX = minX;
                  b.maxX = maxX;
                  b.minY = minY;
                  b.maxY = maxY;
                  if (!this.map.heightmap) this.map.heightmap = {};
                  this.map.heightmap.meterBounds = { minX, maxX, minY, maxY };
                }
              }
            }
          } catch { /* ignore */ }

          // Re-init terrain buffers if resolution changed (more detail).
          if (needResize) {
            try { this.terrain.dispose(); } catch { /* ignore */ }
            await this.terrain.init(renderW, renderH);
          }

          this.terrain.setBounds(b);
          try { this.terrain.setHeightScale(Number(this._elevation?.heightScale ?? 1.0)); } catch { /* ignore */ }
          try { this._applyWaterFromMapBounds(); } catch { /* ignore */ }
          this.terrain.uploadHeightU16(renderW, renderH, this.map.data.heightsU16);
          this.terrain.uploadMaskRgba(renderW, renderH, this.map.data.paintMaskRgba);
          this._applyTerrainWaterMask();
          this.requestAutosave();

          try {
            this._datasetLoadStatus.message = `Loaded heightmap (${fullW}×${fullH} → render ${renderW}×${renderH})`;
            this._renderEditorUi();
          } catch { /* ignore */ }
        } catch (e) {
          // Allow optional heightmaps: if a DEM isn't present locally, still load vector overlays.
          if (!entry.optional) throw e;
          try {
            this._datasetLoadStatus.message = `Heightmap missing (optional): ${String(e?.message || e)}`;
            this._renderEditorUi();
          } catch { /* ignore */ }
        }
        continue;
      }
      if (!startedBuildings && entry.kind === 'geojson-wgs84-buildings') {
        // Make "something" appear (roads + overview lines) before we start the heavy building fetch/parse.
        applyOverlayPartial({ applyRoads: true, applyBuildings: false });
        startedBuildings = true;
      }

      if (entry.kind === 'geojson-wgs84-lines') {
        const maxSegments = Math.max(0, Number(entry.maxSegments ?? 250000) || 250000);
        const k = `${id}@${originKey(originLonLat)}@ms${maxSegments}`;
        let cached = this._datasetCache.get(k);
        if (!cached) {
          const { positions, bounds } = await loadWgs84LineGeoJson(entry.url, { maxSegments, originLonLat });
          cached = { positions, bounds };
          this._datasetCache.set(k, cached);
        }
        // Some "decorative" line layers (e.g. a state outline) should not define the dataset origin,
        // otherwise subsequent city-scale datasets may get projected around a far-away center and drift.
        const allowLineLayerToSetOrigin = entry.setOrigin !== false;
        if (allowLineLayerToSetOrigin && !originLonLat && cached.bounds?.originLonLat) {
          originLonLat = cached.bounds.originLonLat;
          this._datasetOriginByDatasetId.set(datasetId, originLonLat);
        }
        const pos = cached.positions;
        const isStateLayer = String(entry.lineLayer || '') === 'state';
        const dst = isStateLayer ? stateVerts : allVerts;
        for (let i = 0; i < pos.length; i++) dst.push(pos[i]);

        // Update bounds (XZ plane)
        // Note: state outline should not expand dataset bounds (keeps framing/loading based on Hampton Roads).
        if (cached.bounds && !isStateLayer) {
          boundsMin[0] = Math.min(boundsMin[0], cached.bounds.min[0]);
          boundsMin[2] = Math.min(boundsMin[2], cached.bounds.min[2]);
          boundsMax[0] = Math.max(boundsMax[0], cached.bounds.max[0]);
          boundsMax[2] = Math.max(boundsMax[2], cached.bounds.max[2]);
        }
      } else if (entry.kind === 'geojson-wgs84-water') {
        const maxPolygons = Math.max(0, Number(entry.maxPolygons ?? 20000) || 20000);
        const maxSegments = Math.max(0, Number(entry.maxSegments ?? 250000) || 250000);
        const waterLevelY = Number(entry.waterLevelY ?? this._water?.levelY ?? 0.0) || 0.0;
        const k = `${id}@${originKey(originLonLat)}@wp${maxPolygons}@ms${maxSegments}@y${waterLevelY.toFixed(2)}`;
        let cached = this._datasetWaterCache.get(k);
        if (!cached) {
          const res = await loadWgs84WaterGeoJson(entry.url, {
            originLonLat,
            waterLevelY,
            maxPolygons,
            maxSegments,
          });
          cached = {
            waterMesh: res.waterMesh,
            shoreline: res.shoreline,
            waterways: res.waterways,
            waterPolygons: res.waterPolygons || null,
            bounds: res.bounds,
            polygonCount: res.polygonCount,
            segmentCount: res.segmentCount,
          };
          this._datasetWaterCache.set(k, cached);
        }
        if (!originLonLat && cached.bounds?.originLonLat) {
          originLonLat = cached.bounds.originLonLat;
          this._datasetOriginByDatasetId.set(datasetId, originLonLat);
        }
        try { this.osmWater.setMesh(cached.waterMesh); } catch { /* ignore */ }
        try { this.osmWaterShoreline.setLinesPositions(cached.shoreline); } catch { /* ignore */ }
        try { this.osmWaterways.setInstances(cached.waterways, Math.floor((cached.waterways?.length || 0) / 11)); } catch { /* ignore */ }
        // Mark that we have real water geometry; the simple ocean plane becomes redundant/confusing.
        this._hasOsmWater = true;
        this._activeWaterPolygons = Array.isArray(cached.waterPolygons) ? cached.waterPolygons : null;
        this._activeWaterLevelY = waterLevelY;
        this._applyTerrainWaterMask();

        if (cached.bounds) {
          boundsMin[0] = Math.min(boundsMin[0], cached.bounds.min[0]);
          boundsMin[2] = Math.min(boundsMin[2], cached.bounds.min[2]);
          boundsMax[0] = Math.max(boundsMax[0], cached.bounds.max[0]);
          boundsMax[2] = Math.max(boundsMax[2], cached.bounds.max[2]);
        }
      } else if (entry.kind === 'geojson-wgs84-roads') {
        // Overview LOD: draw lightweight lines for the whole dataset so zoomed-out views still show "everything".
        // Near-camera LOD: instanced road boxes (possibly camera-streamed).
        const overviewMaxSegments = Math.max(0, Number(entry.overviewMaxSegments ?? 0) || 0);
        if (overviewMaxSegments > 0) {
          const kLine = `${id}@${originKey(originLonLat)}@overview@ms${overviewMaxSegments}`;
          let cachedLine = this._datasetCache.get(kLine);
          if (!cachedLine) {
            const { positions, bounds } = await loadWgs84LineGeoJson(entry.url, { maxSegments: overviewMaxSegments, originLonLat });
            cachedLine = { positions, bounds };
            this._datasetCache.set(kLine, cachedLine);
          }
          if (!originLonLat && cachedLine.bounds?.originLonLat) {
            originLonLat = cachedLine.bounds.originLonLat;
            this._datasetOriginByDatasetId.set(datasetId, originLonLat);
          }
          const pos = cachedLine.positions;
          for (let i = 0; i < pos.length; i++) allVerts.push(pos[i]);
          if (cachedLine.bounds) {
            boundsMin[0] = Math.min(boundsMin[0], cachedLine.bounds.min[0]);
            boundsMin[2] = Math.min(boundsMin[2], cachedLine.bounds.min[2]);
            boundsMax[0] = Math.max(boundsMax[0], cachedLine.bounds.max[0]);
            boundsMax[2] = Math.max(boundsMax[2], cachedLine.bounds.max[2]);
          }
        }

        const maxSegments = Math.max(0, Number(entry.maxSegments ?? 250000) || 250000);
        const thicknessMeters = Number(entry.thicknessMeters ?? 0.12) || 0.12;
        const minSegmentMeters = Number(entry.minSegmentMeters ?? 2.0) || 2.0;
        const k = `${id}@${originKey(originLonLat)}@ms${maxSegments}@th${thicknessMeters}@min${minSegmentMeters}`;
        let cached = this._datasetRoadsCache.get(k);
        if (!cached) {
          const { instances, bounds, segmentCount } = await loadWgs84RoadsGeoJson(entry.url, { originLonLat, maxSegments, thicknessMeters, minSegmentMeters });
          cached = { instances, bounds, segmentCount };
          this._datasetRoadsCache.set(k, cached);
        }
        if (!originLonLat && cached.bounds?.originLonLat) {
          originLonLat = cached.bounds.originLonLat;
          this._datasetOriginByDatasetId.set(datasetId, originLonLat);
        }
        const inst = cached.instances;
        for (let i = 0; i < inst.length; i++) roadInst.push(inst[i]);

        // Road-name labels (2D overlay). This is optional and capped at draw-time.
        try {
          const maxLabels = 12000;
          const minPolylineMeters = Number(this._labels?.minPolylineMeters ?? 40) || 40;
          const minSegmentMeters = Number(this._labels?.minSegmentMeters ?? 3) || 3;
          const preferRef = !!this._labels?.preferRef;
          const kLab = `${id}@${originKey(originLonLat)}@labels@max${maxLabels}@minP${minPolylineMeters}@minS${minSegmentMeters}@ref${preferRef ? 1 : 0}`;
          let cachedLab = this._datasetRoadLabelsCache.get(kLab);
          if (!cachedLab) {
            const res = await loadWgs84RoadLabelsGeoJson(entry.url, {
              originLonLat,
              maxLabels,
              minPolylineMeters,
              minSegmentMeters,
              preferRef,
            });
            cachedLab = { labels: res.labels, bounds: res.bounds, labelCount: res.labelCount };
            this._datasetRoadLabelsCache.set(kLab, cachedLab);
          }
          if (!originLonLat && cachedLab.bounds?.originLonLat) {
            originLonLat = cachedLab.bounds.originLonLat;
            this._datasetOriginByDatasetId.set(datasetId, originLonLat);
          }
          if (Array.isArray(cachedLab.labels) && cachedLab.labels.length) {
            for (let i = 0; i < cachedLab.labels.length; i++) roadLabels.push(cachedLab.labels[i]);
            // Keep pre-sorted so render-time can be simple.
            roadLabels.sort((a, b) => (Number(b?.priority) || 0) - (Number(a?.priority) || 0));
            this._activeRoadLabels = roadLabels;
            try { this._bakeRoadLabelsToTerrainTexture(); } catch { /* ignore */ }
            try {
              this._datasetLoadStatus.roadLabelsCount = roadLabels.length;
              this._renderEditorUi();
            } catch { /* ignore */ }
          }
        } catch { /* ignore labels */ }

        if (cached.bounds) {
          boundsMin[0] = Math.min(boundsMin[0], cached.bounds.min[0]);
          boundsMin[2] = Math.min(boundsMin[2], cached.bounds.min[2]);
          boundsMax[0] = Math.max(boundsMax[0], cached.bounds.max[0]);
          boundsMax[2] = Math.max(boundsMax[2], cached.bounds.max[2]);
        }
      } else if (entry.kind === 'geojson-wgs84-rails') {
        const maxSegments = Math.max(0, Number(entry.maxSegments ?? 300000) || 300000);
        const thicknessMeters = Number(entry.thicknessMeters ?? 0.10) || 0.10;
        const minSegmentMeters = Number(entry.minSegmentMeters ?? 2.0) || 2.0;
        const k = `${id}@${originKey(originLonLat)}@ms${maxSegments}@th${thicknessMeters}@min${minSegmentMeters}`;
        let cached = this._datasetRailsCache.get(k);
        if (!cached) {
          try {
            const { instances, bounds, segmentCount } = await loadWgs84RailsGeoJson(entry.url, { originLonLat, maxSegments, thicknessMeters, minSegmentMeters });
            cached = { instances, bounds, segmentCount };
            this._datasetRailsCache.set(k, cached);
          } catch (e) {
            if (!entry.optional) throw e;
            try {
              this._datasetLoadStatus.message = `Rails missing (optional): ${String(e?.message || e)}`;
              this._renderEditorUi();
            } catch { /* ignore */ }
            continue;
          }
        }
        if (!originLonLat && cached.bounds?.originLonLat) {
          originLonLat = cached.bounds.originLonLat;
          this._datasetOriginByDatasetId.set(datasetId, originLonLat);
        }
        const inst = cached.instances;
        for (let i = 0; i < inst.length; i++) railInst.push(inst[i]);
        if (cached.bounds) {
          boundsMin[0] = Math.min(boundsMin[0], cached.bounds.min[0]);
          boundsMin[2] = Math.min(boundsMin[2], cached.bounds.min[2]);
          boundsMax[0] = Math.max(boundsMax[0], cached.bounds.max[0]);
          boundsMax[2] = Math.max(boundsMax[2], cached.bounds.max[2]);
        }
      } else if (entry.kind === 'geojson-wgs84-barriers') {
        const maxSegments = Math.max(0, Number(entry.maxSegments ?? 250000) || 250000);
        const thicknessMeters = Number(entry.thicknessMeters ?? 0.10) || 0.10;
        const minSegmentMeters = Number(entry.minSegmentMeters ?? 2.0) || 2.0;
        const k = `${id}@${originKey(originLonLat)}@ms${maxSegments}@th${thicknessMeters}@min${minSegmentMeters}`;
        let cached = this._datasetBarriersCache.get(k);
        if (!cached) {
          try {
            const { instances, bounds, segmentCount } = await loadWgs84BarriersGeoJson(entry.url, { originLonLat, maxSegments, thicknessMeters, minSegmentMeters });
            cached = { instances, bounds, segmentCount };
            this._datasetBarriersCache.set(k, cached);
          } catch (e) {
            if (!entry.optional) throw e;
            try {
              this._datasetLoadStatus.message = `Barriers missing (optional): ${String(e?.message || e)}`;
              this._renderEditorUi();
            } catch { /* ignore */ }
            continue;
          }
        }
        if (!originLonLat && cached.bounds?.originLonLat) {
          originLonLat = cached.bounds.originLonLat;
          this._datasetOriginByDatasetId.set(datasetId, originLonLat);
        }
        const inst = cached.instances;
        for (let i = 0; i < inst.length; i++) barrierInst.push(inst[i]);
        if (cached.bounds) {
          boundsMin[0] = Math.min(boundsMin[0], cached.bounds.min[0]);
          boundsMin[2] = Math.min(boundsMin[2], cached.bounds.min[2]);
          boundsMax[0] = Math.max(boundsMax[0], cached.bounds.max[0]);
          boundsMax[2] = Math.max(boundsMax[2], cached.bounds.max[2]);
        }
      } else if (entry.kind === 'geojson-wgs84-powerlines') {
        const maxSegments = Math.max(0, Number(entry.maxSegments ?? 300000) || 300000);
        const lineHeightY = Number(entry.lineHeightY ?? 10.0) || 10.0;
        const k = `${id}@${originKey(originLonLat)}@ms${maxSegments}@y${lineHeightY.toFixed(2)}`;
        let cached = this._datasetPowerLinesCache.get(k);
        if (!cached) {
          try {
            const { positions, bounds, segmentCount } = await loadWgs84PowerLinesGeoJson(entry.url, { originLonLat, maxSegments, lineHeightY });
            cached = { positions, bounds, segmentCount };
            this._datasetPowerLinesCache.set(k, cached);
          } catch (e) {
            if (!entry.optional) throw e;
            try {
              this._datasetLoadStatus.message = `Power lines missing (optional): ${String(e?.message || e)}`;
              this._renderEditorUi();
            } catch { /* ignore */ }
            continue;
          }
        }
        if (!originLonLat && cached.bounds?.originLonLat) {
          originLonLat = cached.bounds.originLonLat;
          this._datasetOriginByDatasetId.set(datasetId, originLonLat);
        }
        const pos = cached.positions;
        for (let i = 0; i < pos.length; i++) powerLineVerts.push(pos[i]);
        if (cached.bounds) {
          boundsMin[0] = Math.min(boundsMin[0], cached.bounds.min[0]);
          boundsMin[2] = Math.min(boundsMin[2], cached.bounds.min[2]);
          boundsMax[0] = Math.max(boundsMax[0], cached.bounds.max[0]);
          boundsMax[2] = Math.max(boundsMax[2], cached.bounds.max[2]);
        }
      } else if (entry.kind === 'geojson-wgs84-trees') {
        const maxTrees = Math.max(0, Number(entry.maxTrees ?? 40000) || 40000);
        const sampleTreeRows = entry.sampleTreeRows == null ? true : !!entry.sampleTreeRows;
        const treeRowSpacingMeters = Number(entry.treeRowSpacingMeters ?? 12) || 12;
        const k = `${id}@${originKey(originLonLat)}@mt${maxTrees}@sr${sampleTreeRows ? 1 : 0}@sp${treeRowSpacingMeters}`;
        let cached = this._datasetTreesCache.get(k);
        if (!cached) {
          try {
            const { instances, bounds, treeCount } = await loadWgs84TreesGeoJson(entry.url, { originLonLat, maxTrees, sampleTreeRows, treeRowSpacingMeters });
            cached = { instances, bounds, treeCount };
            this._datasetTreesCache.set(k, cached);
          } catch (e) {
            if (!entry.optional) throw e;
            try {
              this._datasetLoadStatus.message = `Trees missing (optional): ${String(e?.message || e)}`;
              this._renderEditorUi();
            } catch { /* ignore */ }
            continue;
          }
        }
        if (!originLonLat && cached.bounds?.originLonLat) {
          originLonLat = cached.bounds.originLonLat;
          this._datasetOriginByDatasetId.set(datasetId, originLonLat);
        }
        const inst = cached.instances;
        for (let i = 0; i < inst.length; i++) treeInst.push(inst[i]);
        if (cached.bounds) {
          boundsMin[0] = Math.min(boundsMin[0], cached.bounds.min[0]);
          boundsMin[2] = Math.min(boundsMin[2], cached.bounds.min[2]);
          boundsMax[0] = Math.max(boundsMax[0], cached.bounds.max[0]);
          boundsMax[2] = Math.max(boundsMax[2], cached.bounds.max[2]);
        }
      } else if (entry.kind === 'geojson-wgs84-props') {
        const maxProps = Math.max(0, Number(entry.maxProps ?? 20000) || 20000);
        const k = `${id}@${originKey(originLonLat)}@mp${maxProps}`;
        let cached = this._datasetPropsCache.get(k);
        if (!cached) {
          try {
            const { instances, bounds, propCount } = await loadWgs84PropsGeoJson(entry.url, { originLonLat, maxProps });
            cached = { instances, bounds, propCount };
            this._datasetPropsCache.set(k, cached);
          } catch (e) {
            if (!entry.optional) throw e;
            try {
              this._datasetLoadStatus.message = `Props missing (optional): ${String(e?.message || e)}`;
              this._renderEditorUi();
            } catch { /* ignore */ }
            continue;
          }
        }
        if (!originLonLat && cached.bounds?.originLonLat) {
          originLonLat = cached.bounds.originLonLat;
          this._datasetOriginByDatasetId.set(datasetId, originLonLat);
        }
        const inst = cached.instances;
        for (let i = 0; i < inst.length; i++) propsInst.push(inst[i]);
        if (cached.bounds) {
          boundsMin[0] = Math.min(boundsMin[0], cached.bounds.min[0]);
          boundsMin[2] = Math.min(boundsMin[2], cached.bounds.min[2]);
          boundsMax[0] = Math.max(boundsMax[0], cached.bounds.max[0]);
          boundsMax[2] = Math.max(boundsMax[2], cached.bounds.max[2]);
        }
      } else if (entry.kind === 'geojson-wgs84-buildings') {
        const maxBuildings = Math.max(0, Number(entry.maxBuildings ?? 20000) || 20000);
        const extrudeCap = Math.max(0, Number(this._datasetBuildingsExtrude?.maxBuildings ?? 12000) || 12000);
        const isHugeMetro = String(datasetId || '').includes('hampton_roads');
        const indoorCap = Math.max(0, Number(this._indoors?.maxBuildings ?? 60) || 60);
        const wantsThis = wantsFootprints && !isHugeMetro && (extrudeCap > 0 || indoorCap > 0);
        if (wantsThis) {
          const useMax = Math.min(maxBuildings, Math.max(extrudeCap, indoorCap));
          const kfp = `${id}@${originKey(originLonLat)}@fp@mb${useMax}`;
          let cachedFp = this._datasetBuildingsCache.get(kfp);
          if (!cachedFp) {
            const { buildings, bounds, buildingCount } = await loadWgs84BuildingFootprintsGeoJson(entry.url, { maxBuildings: useMax, originLonLat });
            cachedFp = { buildings, bounds, buildingCount };
            this._datasetBuildingsCache.set(kfp, cachedFp);
          }
          if (!originLonLat && cachedFp.bounds?.originLonLat) {
            originLonLat = cachedFp.bounds.originLonLat;
            this._datasetOriginByDatasetId.set(datasetId, originLonLat);
          }
          const bldgs = cachedFp.buildings || [];
          for (let i = 0; i < bldgs.length; i++) buildingFootprints.push(bldgs[i]);
          if (cachedFp.bounds) {
            boundsMin[0] = Math.min(boundsMin[0], cachedFp.bounds.min[0]);
            boundsMin[2] = Math.min(boundsMin[2], cachedFp.bounds.min[2]);
            boundsMax[0] = Math.max(boundsMax[0], cachedFp.bounds.max[0]);
            boundsMax[2] = Math.max(boundsMax[2], cachedFp.bounds.max[2]);
          }
        } else {
          const k = `${id}@${originKey(originLonLat)}@mb${maxBuildings}`;
          let cached = this._datasetBuildingsCache.get(k);
          if (!cached) {
            const { instances, bounds, buildingCount } = await loadWgs84BuildingsGeoJson(entry.url, { maxBuildings, originLonLat });
            cached = { instances, bounds, buildingCount };
            this._datasetBuildingsCache.set(k, cached);
          }
          if (!originLonLat && cached.bounds?.originLonLat) {
            originLonLat = cached.bounds.originLonLat;
            this._datasetOriginByDatasetId.set(datasetId, originLonLat);
          }
          const inst = cached.instances;
          for (let i = 0; i < inst.length; i++) buildingInst.push(inst[i]);
          if (cached.bounds) {
            boundsMin[0] = Math.min(boundsMin[0], cached.bounds.min[0]);
            boundsMin[2] = Math.min(boundsMin[2], cached.bounds.min[2]);
            boundsMax[0] = Math.max(boundsMax[0], cached.bounds.max[0]);
            boundsMax[2] = Math.max(boundsMax[2], cached.bounds.max[2]);
          }
        }
      } else if (entry.kind === 'instanced-tiles-buildings') {
        // Buildings streamed directly from precomputed instanced-box tiles.
        const fullWorld = !!this._datasetFullWorld?.enabled;
        const st = new InstancedTilesStreamer();
        st.radiusChunks = Math.max(1, Number(this._datasetStreaming?.radiusChunksBuildings ?? 8) || 8);
        // For the Hampton Roads metro tiles, we want to eventually load the whole region.
        // (2660 chunks in current index.) This will steadily stream tiles in the background.
        const isHamptonRoadsTiles = String(entry.id || '').includes('hampton_roads') || String(entry.url || '').includes('hampton_roads');
        st.loadAllChunks = !!(fullWorld || isHamptonRoadsTiles);
        st.maxNewLoadsPerUpdate = fullWorld ? 60 : (isHamptonRoadsTiles ? 24 : 10);
        st.updateEveryMs = Math.max(60, fullWorld ? 60 : (Number(this._datasetStreaming?.updateEveryMs ?? 200) || 200));

        // Prefer packed per-chunk rendering when tiles are BUI2 (no giant merges / no float32 decode).
        st.onWantedChunks = (chunks, totalCount) => {
          try {
            const packed = (Array.isArray(chunks) ? chunks : []).filter((c) => c && c.magic === 'BUI2');
            if (packed.length > 0) {
              this.osmBuildingsTiles.setChunks(packed);
              try { this.osmBuildings.setInstances(new Float32Array(0), 0); } catch { /* ignore */ }
              try { this.osmBuildingsExtruded.clear(); } catch { /* ignore */ }
              this._activeBuildingsMode = 'tiles';
              this._datasetLoadStatus.buildingsCount = Number(totalCount) || 0;
              this._datasetLoadStatus.phase = 'loaded';
              this._datasetLoadStatus.message = 'Loaded (buildings BUI2 tiles stream by camera; packed GPU path).';
              return;
            }
            // If not BUI2, fall through to merged float32 path.
          } catch { /* ignore */ }
        };
        st.onMergedInstances = (buf, count) => {
          try {
            this.osmBuildings.setInstances(buf, count);
            try { this.osmBuildingsTiles.setChunks([]); } catch { /* ignore */ }
            try { this.osmBuildingsExtruded.clear(); } catch { /* ignore */ }
            this._activeBuildingsMode = 'boxes';
            this._datasetLoadStatus.buildingsCount = count;
            this._datasetLoadStatus.phase = 'loaded';
            this._datasetLoadStatus.message = 'Loaded (roads+overview full; buildings tile-streamed by camera).';
          } catch { /* ignore */ }
        };
        await st.init(entry.url);
        this._buildingTilesStreamer = st;
        try { st.update(this.camera, { force: true }); } catch { /* ignore */ }
      } else if (entry.kind === 'instanced-tiles-buildings-multilod') {
        // Multi-LOD building tiles:
        // - LOD0: far "blocks" (very low instance count)
        // - LOD1: near buildings (full detail, BUI2)
        //
        // This avoids the "merge giant buffers" path by rendering per-chunk packed BUI2.
        const baseUrl = String(entry.url || '');
        const resp = await fetch(baseUrl);
        const multi = resp.ok ? await resp.json().catch(() => null) : null;
        if (!multi || multi.schema !== 'webglgta-buildings-multilod-v1') throw new Error('Bad multilod index schema');

        const baseDir = baseUrl.replace(/\/[^\/?#]+(\?|#|$).*/g, '');
        const resolveUrl = (u) => {
          const s = String(u || '').trim();
          if (!s) return '';
          if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('/')) return s;
          return baseDir ? `${baseDir}/${s}` : s;
        };

        const lod0Url = resolveUrl(multi?.lod0?.indexUrl);
        const lod1Url = resolveUrl(multi?.lod1?.indexUrl);
        const lod2Url = resolveUrl(multi?.lod2?.indexUrl);
        if (!lod0Url || !lod1Url) throw new Error('multilod index missing lod0/lod1 indexUrl');

        const isHamptonRoadsTiles = String(entry.id || '').includes('hampton_roads') || String(entry.url || '').includes('hampton_roads');
        const fullWorld = !!this._datasetFullWorld?.enabled;

        // Near buildings (LOD1)
        const stNear = new InstancedTilesStreamer();
        stNear.radiusChunks = Math.max(1, Number(multi?.recommended?.lod1RadiusChunks ?? this._datasetStreaming?.radiusChunksBuildings ?? 6) || 6);
        stNear.maxNewLoadsPerUpdate = 12;
        stNear.updateEveryMs = Math.max(60, Number(this._datasetStreaming?.updateEveryMs ?? 200) || 200);

        // Far blocks (LOD0)
        const stFar = new InstancedTilesStreamer();
        stFar.radiusChunks = Math.max(stNear.radiusChunks + 2, Number(multi?.recommended?.lod0RadiusChunks ?? 20) || 20);
        // Hampton Roads: far LOD is cheap; stream *all* chunks to keep the whole metro visible.
        stFar.loadAllChunks = !!(fullWorld || isHamptonRoadsTiles);
        stFar.maxNewLoadsPerUpdate = fullWorld ? 90 : (isHamptonRoadsTiles ? 60 : 20);
        stFar.updateEveryMs = Math.max(60, fullWorld ? 60 : (Number(this._datasetStreaming?.updateEveryMs ?? 200) || 200));
        stFar.evictUnwanted = !stFar.loadAllChunks; // bounded by radius unless we intentionally load everything

        // Super-far mass (LOD2) if present
        const hasLod2 = !!lod2Url;
        const stSuper = hasLod2 ? new InstancedTilesStreamer() : null;
        if (stSuper) {
          stSuper.radiusChunks = Math.max(stFar.radiusChunks + 6, Number(multi?.recommended?.lod2RadiusChunks ?? 60) || 60);
          // LOD2 is very cheap; it is safe to load the whole world over time when enabled.
          stSuper.loadAllChunks = !!(fullWorld || isHamptonRoadsTiles);
          stSuper.maxNewLoadsPerUpdate = fullWorld ? 140 : (isHamptonRoadsTiles ? 90 : 30);
          stSuper.updateEveryMs = Math.max(60, fullWorld ? 80 : (Number(this._datasetStreaming?.updateEveryMs ?? 200) || 200));
          stSuper.evictUnwanted = !stSuper.loadAllChunks;
        }

        // State to coordinate far/near cutover
        this._buildingsMultiLod = {
          nearCount: 0,
          farCount: 0,
          superCount: 0,
        };

        stNear.onWantedChunks = (chunks, totalCount) => {
          try {
            const packed = (Array.isArray(chunks) ? chunks : []).filter((c) => c && c.magic === 'BUI2');
            this.osmBuildingsTiles.setChunks(packed);
            this._buildingsMultiLod.nearCount = Number(totalCount) || 0;
            // Ensure float-instanced path is cleared.
            try { this.osmBuildings.setInstances(new Float32Array(0), 0); } catch { /* ignore */ }
            try { this.osmBuildingsExtruded.clear(); } catch { /* ignore */ }
            this._activeBuildingsMode = 'tiles_lod';
            this._datasetLoadStatus.phase = 'loaded';
            this._datasetLoadStatus.buildingsCount = this._buildingsMultiLod.nearCount;
            this._datasetLoadStatus.message = 'Loaded (multi-LOD tiles: near buildings + far blocks).';
          } catch { /* ignore */ }
        };

        stFar.onWantedChunks = (chunks, totalCount) => {
          try {
            const packed = (Array.isArray(chunks) ? chunks : []).filter((c) => c && c.magic === 'BUI2');
            // No hard cutoff; we crossfade in the renderer.
            // Still update chunk set so far LOD can cover entire metro (Hampton Roads: loadAllChunks).
            this.osmBuildingsTilesFar.setChunks(packed);
            this._buildingsMultiLod.farCount = Number(totalCount) || 0;
          } catch { /* ignore */ }
        };

        if (stSuper) {
          stSuper.onWantedChunks = (chunks, totalCount) => {
            try {
              const packed = (Array.isArray(chunks) ? chunks : []).filter((c) => c && c.magic === 'BUI2');
              this.osmBuildingsTilesSuperFar.setChunks(packed);
              this._buildingsMultiLod.superCount = Number(totalCount) || 0;
            } catch { /* ignore */ }
          };
        }

        await stNear.init(lod1Url);
        await stFar.init(lod0Url);
        if (stSuper) await stSuper.init(lod2Url);

        this._buildingTilesStreamer = stNear;
        this._buildingTilesStreamerFar = stFar;
        this._buildingTilesStreamerSuperFar = stSuper;
        try { stFar.update(this.camera, { force: true }); } catch { /* ignore */ }
        try { stNear.update(this.camera, { force: true }); } catch { /* ignore */ }
        try { if (stSuper) stSuper.update(this.camera, { force: true }); } catch { /* ignore */ }
      } else if (entry.kind === 'tiles-footprints-buildings') {
        // Near-camera streamed footprint tiles, intended for detailed buildings without loading giant GeoJSONs.
        const st = new BuildingFootprintsTilesStreamer();
        st.radiusChunks = Math.max(1, Number(this._datasetStreaming?.radiusChunksBuildings ?? 4) || 4);
        st.maxNewLoadsPerUpdate = 8;
        st.updateEveryMs = Math.max(60, Number(this._datasetStreaming?.updateEveryMs ?? 200) || 200);
        st.onMergedBuildings = (bldgs, count) => {
          try {
            // Build a fresh mesh for the current wanted chunks.
            const cap = Math.max(0, Number(this._datasetBuildingsExtrude?.maxBuildings ?? 12000) || 12000);
            const mesh = buildExtrudedBuildingsMesh(bldgs, { maxBuildings: cap });
            this.osmBuildingsExtruded.setMesh(mesh);
            // If we also have tile streamers active, keep tiles as the base (far LOD) and use extrusion as near detail.
            const hasTilesBase = !!(this._buildingTilesStreamer || this._buildingTilesStreamerFar || this._buildingTilesStreamerSuperFar);
            if (!hasTilesBase) this._activeBuildingsMode = 'extruded';
            this._activeDatasetBuildingFootprints = Array.isArray(bldgs) ? bldgs.slice() : [];
            this._datasetLoadStatus.buildingsCount = Number(count) || (Array.isArray(bldgs) ? bldgs.length : 0);
            this._datasetLoadStatus.phase = 'loaded';
            this._datasetLoadStatus.message = hasTilesBase
              ? 'Loaded (buildings: tiles far + footprint-extruded near camera).'
              : 'Loaded (buildings footprint tiles stream near camera).';
          } catch { /* ignore */ }
        };
        try {
          await st.init(entry.url);
          this._buildingFootprintsTilesStreamer = st;
          try { st.update(this.camera, { force: true }); } catch { /* ignore */ }
        } catch (e) {
          // Footprint tiles are optional in some builds; missing files should not break dataset load.
          if (!entry.optional) throw e;
          const msg = String(e?.message || e || 'Footprint tiles missing');
          try {
            this._datasetLoadStatus.message = `Footprint tiles missing (optional): ${msg}`;
            this._renderEditorUi();
          } catch { /* ignore */ }
          try { st.dispose(); } catch { /* ignore */ }
          this._buildingFootprintsTilesStreamer = null;
        }
      }
      }
    } catch (e) {
      const msg = String(e?.message || e || 'Dataset load failed');
      this._datasetLoadStatus = { ...this._datasetLoadStatus, phase: 'error', lastError: msg, message: 'Failed while loading dataset.' };
      try { this._renderEditorUi(); } catch { /* ignore */ }
      throw e;
    }

    this.osmLines.setLinesPositions(new Float32Array(allVerts));
    const roadsFull = new Float32Array(roadInst);
    const railsFull = new Float32Array(railInst);
    const barriersFull = new Float32Array(barrierInst);
    const powerLinesFull = new Float32Array(powerLineVerts);
    const treesFull = new Float32Array(treeInst);
    const buildingsFull = new Float32Array(buildingInst);
    const propsFull = new Float32Array(propsInst);
    const roadCountFull = Math.floor(roadsFull.length / floatsPerRoad);
    const railCountFull = Math.floor(railsFull.length / floatsPerRail);
    const barrierCountFull = Math.floor(barriersFull.length / floatsPerBarrier);
    const powerLineCountFull = Math.floor(powerLinesFull.length / 6);
    const treeCountFull = Math.floor(treesFull.length / floatsPerTrees);
    const buildingCountFull = Math.floor(buildingsFull.length / floatsPerInst);
    const propsCountFull = Math.floor(propsFull.length / floatsPerProps);
    const hasExtruded = wantsExtruded && buildingFootprints.length > 0;
    const hasFootprints = wantsFootprints && buildingFootprints.length > 0;
    try { this.osmRails.setInstances(railsFull, railCountFull); } catch { /* ignore */ }
    try { this.osmBarriers.setInstances(barriersFull, barrierCountFull); } catch { /* ignore */ }
    try { this.osmPowerLines.setLinesPositions(powerLinesFull); } catch { /* ignore */ }
    try { this.osmTrees.setInstances(treesFull, treeCountFull); } catch { /* ignore */ }
    try { this.osmProps.setInstances(propsFull, propsCountFull); } catch { /* ignore */ }

    // Camera-based streaming/culling for heavy overlays (modeled after the older viewer's chunk streamers).
    // For small datasets, upload everything as before.
    const isHugeMetro = String(datasetId || '').includes('hampton_roads');
    const shouldStream = !!this._datasetStreaming?.enabled && !hasExtruded && (isHugeMetro || roadCountFull > 90000 || buildingCountFull > 25000);
    if (shouldStream) {
      this._activeDatasetStreamState = this._buildDatasetStreamState({
        datasetId,
        roadsFull,
        buildingsFull,
        floatsPerRoad,
        floatsPerInst,
        chunkSizeMeters: this._datasetStreaming.chunkSizeMeters,
      });
      this._updateDatasetStreaming(true);
    } else {
      this._activeDatasetStreamState = null;
      this.osmRoads.setInstances(roadsFull, roadCountFull);
      if (!hasExtruded) {
        this.osmBuildings.setInstances(buildingsFull, buildingCountFull);
        try { this.osmBuildingsExtruded.clear(); } catch { /* ignore */ }
        this._activeBuildingsMode = 'boxes';
      } else {
        this.osmBuildings.setInstances(new Float32Array(0), 0);
        this._activeBuildingsMode = 'extruded';
      }
    }
    this._datasetLoadStatus = {
      ...this._datasetLoadStatus,
      phase: 'loaded',
      message: hasExtruded ? 'Loaded (extruded footprints).' : 'Loaded.',
      roadsCount: roadCountFull,
      roadLabelsCount: Array.isArray(this._activeRoadLabels) ? this._activeRoadLabels.length : 0,
      railCount: railCountFull,
      barrierCount: barrierCountFull,
      powerLineCount: powerLineCountFull,
      treeCount: treeCountFull,
      buildingsCount: hasExtruded ? buildingFootprints.length : buildingCountFull,
      propsCount: propsCountFull,
      lastError: '',
    };
    try { this._renderEditorUi(); } catch { /* ignore */ }
    if (Number.isFinite(boundsMin[0]) && this.map?.dataset?.fitToBounds) {
      // Optionally:
      // - Re-frame camera to include dataset overlay
      // - AND update map XY bounds to match dataset meters so painting aligns with real-world overlays.
      try {
        const b = this.map.bounds;
        let appliedWorldBboxOverride = false;
        // Reset world-scale visual bounds (used by the ocean plane only). We'll recompute below if applicable.
        this._worldBoundsOverride = null;
        // If we have a DEM bbox, compute projected meter bounds for stable elevation mapping.
        try { if (originLonLat) computeHeightmapMeterBoundsFromBbox(this.map, originLonLat); } catch { /* ignore */ }

        const demB = this.map?.heightmap?.meterBounds;
        const useDemBounds = !!this._elevation?.fitWorldXYToDemBbox && !!demB && Number.isFinite(demB.minX) && Number.isFinite(demB.maxX) && Number.isFinite(demB.minY) && Number.isFinite(demB.maxY);
        // Dataset is rendered on XZ plane; map uses (X, Y) as ground plane in its schema.
        // IMPORTANT: Keep the overlay meter bounds as the world extents.
        // NOTE: we can optionally drive world bounds from the DEM bbox to keep elevation mapping correct.
        b.minX = useDemBounds ? demB.minX : boundsMin[0];
        b.maxX = useDemBounds ? demB.maxX : boundsMax[0];
        b.minY = useDemBounds ? demB.minY : boundsMin[2];
        b.maxY = useDemBounds ? demB.maxY : boundsMax[2];

        // Optional: render a larger background plane than the loaded dataset (e.g., whole Virginia),
        // without changing what data is actually requested/streamed OR how the terrain is sampled.
        try {
          const wb = this.map?.worldBboxWgs84;
          const bb = wb ? { minLon: wb.minLon, minLat: wb.minLat, maxLon: wb.maxLon, maxLat: wb.maxLat } : null;
          const mb2 = (bb && originLonLat) ? computeMeterBoundsFromWgs84Bbox(bb, originLonLat) : null;
          if (mb2 && Number.isFinite(mb2.minX) && Number.isFinite(mb2.maxX) && Number.isFinite(mb2.minY) && Number.isFinite(mb2.maxY)) {
            this._worldBoundsOverride = {
              minX: mb2.minX,
              maxX: mb2.maxX,
              minY: mb2.minY,
              maxY: mb2.maxY,
              // Keep vertical range consistent with the map/terrain.
              minZ: b.minZ,
              maxZ: b.maxZ,
            };
            appliedWorldBboxOverride = true;
          }
        } catch { /* ignore */ }

        // If we have a square height grid (common: 512x512), pad world extents to a square so the terrain
        // doesn't visually "squash" into a rectangle. This keeps overlay coordinates correct (adds margins).
        if (!appliedWorldBboxOverride && !useDemBounds && this.map?.grid?.width === this.map?.grid?.height) makeBoundsSquareXY(b);
        // Keep minZ/maxZ as-is (vertical range, set by heightmap).
        this.terrain.setBounds(b);
        try { this._applyWaterFromMapBounds(); } catch { /* ignore */ }
        this._applyTerrainWaterMask();

        // Export debug metrics for quick verification.
        try {
          const dx = (Number(b.maxX) || 0) - (Number(b.minX) || 0);
          const dy = (Number(b.maxY) || 0) - (Number(b.minY) || 0);
          globalThis.__debugMapBounds = {
            minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY,
            dx, dy,
            aspect: (dy !== 0) ? (dx / dy) : null,
            grid: { w: this.map?.grid?.width, h: this.map?.grid?.height },
            datasetId,
          };
        } catch { /* ignore */ }
      } catch { /* ignore */ }

      // Frame using the *final* map bounds (after optional squaring), otherwise the camera still frames the
      // original rectangular overlay extents and it looks like nothing changed.
      // World-scale bounds override (ocean plane) no longer changes map bounds, so framing stays dataset-focused.
      const frameMinX = Number(this.map?.bounds?.minX) || boundsMin[0];
      const frameMaxX = Number(this.map?.bounds?.maxX) || boundsMax[0];
      const frameMinY = Number(this.map?.bounds?.minY) || boundsMin[2];
      const frameMaxY = Number(this.map?.bounds?.maxY) || boundsMax[2];
      const min = [frameMinX, 0, frameMinY];
      const max = [frameMaxX, 0, frameMaxY];

      // Hampton Roads: default initial framing to Virginia Beach (more intuitive than dataset centroid near Suffolk).
      // Only do this once per map load so manual dataset switching keeps expected behavior.
      try {
        const tid = String(this.map?.templateId || '');
        const isHr = tid.includes('hampton_roads') || String(datasetId || '').includes('hampton_roads');
        if (isHr && !this._didInitialDatasetFrame && originLonLat) {
          const olon = Number(originLonLat?.[0]);
          const olat = Number(originLonLat?.[1]);
          if (Number.isFinite(olon) && Number.isFinite(olat)) {
            // Use a single known-good point for Virginia Beach (same as the Spawn button),
            // and frame a modest area around it.
            const [vx, vz] = projectLonLatMeters(-75.9780, 36.8529, olon, olat);
            if (Number.isFinite(vx) && Number.isFinite(vz)) {
              const r = 9000; // meters; "city-scale" starting view
              min[0] = vx - r;
              max[0] = vx + r;
              min[2] = vz - r;
              max[2] = vz + r;
              this._didInitialDatasetFrame = true;
            }
          }
        }
      } catch { /* ignore */ }
      // Give it some Y extents so frameAABB doesn't collapse.
      min[1] = -5; max[1] = 5;
      this.camera.frameAABB(min, max);
    }

    // Optional visual debug: draw map bounds outline so it's obvious whether bounds are square or not.
    if (this._debugBounds && this.map?.bounds) {
      try { appendBoundsOutlineLines(allVerts, this.map.bounds, 0.2); } catch { /* ignore */ }
    }

    // With a real heightmap, the terrain is no longer y=0. The OSM overlays are authored at y≈0,
    // so they will float or be buried unless we "ground" them to the terrain height.
    //
    // We do this AFTER fitToBounds updates map XY extents, so XZ->heightmap sampling is consistent.
    if (this.map?.data?.heightsU16 && this.map.grid?.width > 1 && this.map.grid?.height > 1) {
      const b = this.map.bounds;
      const dz = (Number(b.maxZ) || 0) - (Number(b.minZ) || 0);
      const hasElevation = Number.isFinite(dz) && Math.abs(dz) > 0.01;
      if (hasElevation) {
        const applyGround = (arr, floatsPer) => {
          for (let off = 0; off + floatsPer - 1 < arr.length; off += floatsPer) {
            const tx = arr[off + 0];
            const tz = arr[off + 2];
            const baseY = heightAtWorld(this.map, tx, tz);
            // ty is center-y in InstancedBoxRenderer packing; add base height.
            arr[off + 1] = (arr[off + 1] || 0) + baseY;
          }
        };
        applyGround(roadsFull, floatsPerRoad);
        if (!hasExtruded) applyGround(buildingsFull, floatsPerInst);
        if (hasExtruded) {
          // Approximate grounding: sample at building center and shift the whole building.
          for (let i = 0; i < buildingFootprints.length; i++) {
            const fp = buildingFootprints[i];
            const cx = Number(fp?.centerXZ?.[0]);
            const cz = Number(fp?.centerXZ?.[1]);
            if (!Number.isFinite(cx) || !Number.isFinite(cz)) continue;
            const baseY = heightAtWorld(this.map, cx, cz);
            fp.minY = (Number(fp.minY) || 0) + baseY;
            fp.maxY = (Number(fp.maxY) || 0) + baseY;
          }
        }

        // Re-upload / re-stream with grounded positions.
        if (shouldStream) {
          this._activeDatasetStreamState = this._buildDatasetStreamState({
            datasetId,
            roadsFull,
            buildingsFull,
            floatsPerRoad,
            floatsPerInst,
            chunkSizeMeters: this._datasetStreaming.chunkSizeMeters,
          });
          this._updateDatasetStreaming(true);
        } else {
          this.osmRoads.setInstances(roadsFull, roadCountFull);
          if (!hasExtruded) this.osmBuildings.setInstances(buildingsFull, buildingCountFull);
        }
      }
    }

    if (hasExtruded) {
      try {
        const cap = Math.max(0, Number(this._datasetBuildingsExtrude?.maxBuildings ?? 12000) || 12000);
        const mesh = buildExtrudedBuildingsMesh(buildingFootprints, { maxBuildings: cap });
        this.osmBuildingsExtruded.setMesh(mesh);
        this._activeBuildingsMode = 'extruded';
      } catch (e) {
        // Fallback to instanced boxes if extrusion fails.
        try { this.osmBuildingsExtruded.clear(); } catch { /* ignore */ }
        this._activeBuildingsMode = 'boxes';
        this.osmBuildings.setInstances(buildingsFull, buildingCountFull);
        try {
          this._datasetLoadStatus.message = `Loaded (extrusion failed; using boxes): ${String(e?.message || e)}`;
          this._renderEditorUi();
        } catch { /* ignore */ }
      }
    } else {
      try { this.osmBuildingsExtruded.clear(); } catch { /* ignore */ }
      this._activeBuildingsMode = 'boxes';
    }

    this._activeDatasetBuildingFootprints = hasFootprints ? buildingFootprints.slice() : [];
    this._indoorsLastDebugUpdateMs = 0;
  }

  _buildDatasetStreamState({ datasetId, roadsFull, buildingsFull, floatsPerRoad, floatsPerInst, chunkSizeMeters }) {
    const chunkSize = Math.max(50, Number(chunkSizeMeters) || 600);
    const chunkKey = (ix, iz) => `${ix},${iz}`;
    const floorDiv = (v, d) => Math.floor((Number(v) || 0) / d);

    /** @type {Map<string, Float32Array>} */
    const roadChunks = new Map();
    /** @type {Map<string, Float32Array>} */
    const buildingChunks = new Map();

    const buildChunks = (src, floatsPer, outMap) => {
      /** @type {Map<string, number[]>} */
      const tmp = new Map();
      for (let off = 0; off + floatsPer - 1 < src.length; off += floatsPer) {
        const tx = src[off + 0];
        const tz = src[off + 2];
        const ix = floorDiv(tx, chunkSize);
        const iz = floorDiv(tz, chunkSize);
        const k = chunkKey(ix, iz);
        let arr = tmp.get(k);
        if (!arr) { arr = []; tmp.set(k, arr); }
        for (let j = 0; j < floatsPer; j++) arr.push(src[off + j]);
      }
      for (const [k, arr] of tmp) outMap.set(k, new Float32Array(arr));
    };

    buildChunks(roadsFull, floatsPerRoad, roadChunks);
    buildChunks(buildingsFull, floatsPerInst, buildingChunks);

    return {
      datasetId,
      chunkSize,
      floatsPerRoad,
      floatsPerInst,
      roadChunks,
      buildingChunks,
      lastCamChunk: null,
      lastUpdateMs: 0,
    };
  }

  _updateDatasetStreaming(force = false) {
    const st = this._activeDatasetStreamState;
    if (!st || !this._datasetStreaming?.enabled) return;
    const now = performance.now();
    if (!force && (now - (st.lastUpdateMs || 0)) < (this._datasetStreaming.updateEveryMs || 200)) return;

    const chunkSize = st.chunkSize;
    const cx = Math.floor((this.camera?.position?.[0] || 0) / chunkSize);
    const cz = Math.floor((this.camera?.position?.[2] || 0) / chunkSize);
    const camKey = `${cx},${cz}`;
    if (!force && st.lastCamChunk === camKey) return;
    st.lastCamChunk = camKey;
    st.lastUpdateMs = now;

    const collect = (out, chunks, r) => {
      out.length = 0;
      const rr = Math.max(0, r | 0);
      for (let dz = -rr; dz <= rr; dz++) {
        for (let dx = -rr; dx <= rr; dx++) {
          const k = `${cx + dx},${cz + dz}`;
          const c = chunks.get(k);
          if (!c) continue;
          out.push(c);
        }
      }
    };

    /** @type {Float32Array[]} */
    const roadPicked = [];
    /** @type {Float32Array[]} */
    const bldgPicked = [];
    collect(roadPicked, st.roadChunks, this._datasetStreaming.radiusChunksRoads);
    collect(bldgPicked, st.buildingChunks, this._datasetStreaming.radiusChunksBuildings);

    const concat = (arrays) => {
      let n = 0;
      for (const a of arrays) n += a.length;
      const out = new Float32Array(n);
      let o = 0;
      for (const a of arrays) { out.set(a, o); o += a.length; }
      return out;
    };

    const roads = concat(roadPicked);
    const bldgs = concat(bldgPicked);
    this.osmRoads.setInstances(roads, Math.floor(roads.length / st.floatsPerRoad));
    this.osmBuildings.setInstances(bldgs, Math.floor(bldgs.length / st.floatsPerInst));
  }

  requestAutosave(immediate = false) {
    if (!this.map) return;
    if (immediate) {
      this.store.saveMap(this.map);
      return;
    }
    if (this._autosaveTimer) return;
    this._autosaveTimer = setTimeout(() => {
      this._autosaveTimer = null;
      try { if (this.map) this.store.saveMap(this.map); } catch { /* ignore */ }
    }, 400);
  }

  _updateIndoorsDebug(nowMs) {
    if (!this._indoors?.enabled || !this._indoors?.debug) return;
    const everyMs = 250;
    if ((nowMs - (this._indoorsLastDebugUpdateMs || 0)) < everyMs) return;
    this._indoorsLastDebugUpdateMs = nowMs;

    const footprints = Array.isArray(this._activeDatasetBuildingFootprints) ? this._activeDatasetBuildingFootprints : [];
    if (!footprints.length) {
      try { this.indoorDebugLines.setLinesPositions(new Float32Array(0)); } catch { /* ignore */ }
      return;
    }

    const camX = Number(this.camera?.position?.[0] || 0);
    const camZ = Number(this.camera?.position?.[2] || 0);
    const r = Math.max(10, Number(this._indoors?.radiusMeters ?? 140) || 140);
    const r2 = r * r;
    const maxB = Math.max(1, Number(this._indoors?.maxBuildings ?? 60) || 60);

    /** @type {{ fp: any, d2: number }[]} */
    const picked = [];
    for (let i = 0; i < footprints.length; i++) {
      const fp = footprints[i];
      const bx = Number(fp?.centerXZ?.[0]);
      const bz = Number(fp?.centerXZ?.[1]);
      if (!Number.isFinite(bx) || !Number.isFinite(bz)) continue;
      const dx = bx - camX;
      const dz = bz - camZ;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      picked.push({ fp, d2 });
    }
    picked.sort((a, b) => a.d2 - b.d2);
    if (picked.length > maxB) picked.length = maxB;

    /** @type {number[]} */
    const verts = [];
    const worldSeed = String(this._indoors?.seed || 'indoors_v1');
    for (let i = 0; i < picked.length; i++) {
      const fp = picked[i].fp;
      let plan = null;
      // Use generated plan's idU32 as cache key.
      const tmp = generateIndoorFloorplan(fp, { worldSeed });
      if (!tmp || !Number.isFinite(tmp.idU32)) continue;
      const key = tmp.idU32 >>> 0;
      plan = this._indoorsCache.get(key) || tmp;
      this._indoorsCache.set(key, plan);

      const lines = buildIndoorDebugLinesFromFloorplan(plan, { maxRooms: 40 });
      for (let j = 0; j < lines.length; j++) verts.push(lines[j]);
    }

    try { this.indoorDebugLines.setLinesPositions(new Float32Array(verts)); } catch { /* ignore */ }
  }

  _updateNearestBuildingInspect() {
    if (!this._inspect?.enabled) return;
    const footprints = Array.isArray(this._activeDatasetBuildingFootprints) ? this._activeDatasetBuildingFootprints : [];
    if (!footprints.length) {
      this._inspect.nearestBuilding = null;
      return;
    }
    const camX = Number(this.camera?.position?.[0] || 0);
    const camZ = Number(this.camera?.position?.[2] || 0);
    let best = null;
    let bestD2 = Infinity;
    for (let i = 0; i < footprints.length; i++) {
      const fp = footprints[i];
      const bx = Number(fp?.centerXZ?.[0]);
      const bz = Number(fp?.centerXZ?.[1]);
      if (!Number.isFinite(bx) || !Number.isFinite(bz)) continue;
      const dx = bx - camX;
      const dz = bz - camZ;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = fp; }
    }
    this._inspect.nearestBuilding = best;
  }

  _applyBrushFromPointer() {
    if (!this.map) return;
    const rect = this.canvas.getBoundingClientRect();
    const nx = (this._pointer.x - rect.left) / Math.max(1, rect.width);
    const ny = (this._pointer.y - rect.top) / Math.max(1, rect.height);

    // Extremely simple "pick": intersect with ground plane at y=0 in world space.
    // This is not exact for a displaced terrain, but it is stable and good enough for grid painting.
    // We approximate by unprojecting a point at y=0 along the view ray via a binary-ish solve on t.
    const invVP = mat4.create();
    mat4.invert(invVP, this.camera.viewProj);

    const unproject = (sx, sy, sz) => {
      const x = sx * 2 - 1;
      const y = (1 - sy) * 2 - 1;
      const z = sz * 2 - 1;
      const p = [x, y, z, 1];
      const out = [0, 0, 0, 0];
      // mat4 * vec4
      out[0] = invVP[0]*p[0] + invVP[4]*p[1] + invVP[8]*p[2] + invVP[12]*p[3];
      out[1] = invVP[1]*p[0] + invVP[5]*p[1] + invVP[9]*p[2] + invVP[13]*p[3];
      out[2] = invVP[2]*p[0] + invVP[6]*p[1] + invVP[10]*p[2] + invVP[14]*p[3];
      out[3] = invVP[3]*p[0] + invVP[7]*p[1] + invVP[11]*p[2] + invVP[15]*p[3];
      const iw = out[3] ? 1 / out[3] : 1;
      return [out[0] * iw, out[1] * iw, out[2] * iw];
    };

    const p0 = unproject(nx, ny, 0.0);
    const p1 = unproject(nx, ny, 1.0);
    const dir = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const dy = dir[1];
    if (Math.abs(dy) < 1e-6) return;
    const t = (0.0 - p0[1]) / dy;
    const hit = [p0[0] + dir[0]*t, 0.0, p0[2] + dir[2]*t];

    const { ix, iy } = pickCellFromWorld(this.map, hit[0], hit[2]);
    this._applyBrushAt(ix, iy, hit[0], hit[2]);
  }

  _applyBrushAt(ix, iy, worldX, worldZ) {
    if (!this.map) return;
    const w = this.map.grid.width;
    const h = this.map.grid.height;
    const r = Math.max(1, this.brushRadius | 0);
    let changedHeight = false;
    let changedMask = false;

    for (let yy = -r; yy <= r; yy++) {
      for (let xx = -r; xx <= r; xx++) {
        if (xx*xx + yy*yy > r*r) continue;
        const x = ix + xx;
        const y = iy + yy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const idx = y * w + x;
        if (this.mode === 'height') {
          const cur = this.map.data.heightsU16[idx] || 0;
          const next = clamp(cur + this.heightDelta, 0, 65535);
          this.map.data.heightsU16[idx] = next;
          changedHeight = true;
        } else {
          const bi = idx * 4;
          const setOneHot = (r0, g0, b0, a0) => {
            this.map.data.paintMaskRgba[bi + 0] = r0;
            this.map.data.paintMaskRgba[bi + 1] = g0;
            this.map.data.paintMaskRgba[bi + 2] = b0;
            this.map.data.paintMaskRgba[bi + 3] = a0;
          };
          if (this.paintKind === 'dirt') setOneHot(0, 255, 0, 0);
          else if (this.paintKind === 'road') setOneHot(0, 0, 255, 0);
          else if (this.paintKind === 'street') setOneHot(0, 0, 0, 255);
          else setOneHot(255, 0, 0, 0);
          changedMask = true;
        }
      }
    }

    // Re-upload whole textures for simplicity (100x100 is tiny). Later we can do texSubImage2D for brush rects.
    if (changedHeight) this.terrain.uploadHeightU16(w, h, this.map.data.heightsU16);
    if (changedMask) this.terrain.uploadMaskRgba(w, h, this.map.data.paintMaskRgba);

    // Keep instances grounded to terrain at cursor (simple behavior: move last selected / last created later).
    // For now, just autosave.
    if (changedHeight || changedMask) this.requestAutosave();
  }

  _rebuildInstanceBuffer() {
    if (!this.map) return;
    const inst = Array.isArray(this.map.data?.instances) ? this.map.data.instances : [];
    const floatsPer = 11; // matches InstancedBoxRenderer
    const buf = new Float32Array(inst.length * floatsPer);

    const heightAtXY = (x, y) => this._heightAtXY(x, y);

    const kindToDims = (k) => {
      const kk = String(k || '');
      if (kk === 'tree') return { sx: 1.0, sy: 6.0, sz: 1.0, yOff: 3.0, col: [0.18, 0.45, 0.2, 1] };
      if (kk === 'house') return { sx: 4.0, sy: 3.2, sz: 4.0, yOff: 1.6, col: [0.62, 0.52, 0.42, 1] };
      if (kk === 'building') return { sx: 6.0, sy: 10.0, sz: 6.0, yOff: 5.0, col: [0.55, 0.58, 0.62, 1] };
      if (kk === 'car') return { sx: 2.2, sy: 1.1, sz: 4.2, yOff: 0.55, col: [0.2, 0.25, 0.35, 1] };
      // Room-sim primitives (usually overridden per-instance via it.meta.sx/sy/sz).
      if (kk === 'room_floor') return { sx: 10.0, sy: 0.2, sz: 10.0, yOff: 0.1, col: [0.11, 0.14, 0.20, 1] };
      if (kk === 'room_wall') return { sx: 8.0, sy: 3.0, sz: 0.25, yOff: 1.5, col: [0.45, 0.50, 0.56, 1] };
      if (kk === 'room_bed') return { sx: 2.0, sy: 0.55, sz: 1.0, yOff: 0.275, col: [0.48, 0.36, 0.33, 1] };
      if (kk === 'room_desk') return { sx: 1.8, sy: 0.78, sz: 0.85, yOff: 0.39, col: [0.25, 0.29, 0.36, 1] };
      if (kk === 'room_chair') return { sx: 0.55, sy: 0.95, sz: 0.55, yOff: 0.475, col: [0.17, 0.19, 0.23, 1] };
      if (kk === 'room_tv') return { sx: 0.10, sy: 0.90, sz: 1.60, yOff: 1.35, col: [0.06, 0.07, 0.09, 1] };
      if (kk === 'room_tv_screen') return { sx: 0.04, sy: 0.70, sz: 1.35, yOff: 1.35, col: [0.06, 0.07, 0.09, 1] };
      if (kk === 'room_computer') return { sx: 0.42, sy: 0.52, sz: 0.22, yOff: 0.26, col: [0.07, 0.09, 0.12, 1] };
      if (kk === 'room_agent_spawn') return { sx: 0.35, sy: 0.10, sz: 0.35, yOff: 0.05, col: [0.36, 0.86, 0.54, 1] };
      return { sx: 2.0, sy: 2.0, sz: 2.0, yOff: 1.0, col: [0.8, 0.8, 0.8, 1] };
    };

    // Collision colliders built from the SAME dims used for rendering (no meta-only dependency).
    /** @type {{ cx:number, cy:number, hx:number, hy:number, yawRad:number }[]} */
    const wallCols = [];
    /** @type {{ cx:number, cy:number, hx:number, hy:number, yawRad:number }[]} */
    const objCols = [];
    /** @type {Set<string>} */
    const solidKinds = new Set([
      'room_bed',
      'room_chair',
      'room_desk',
      'room_computer',
      'room_tv',
    ]);

    for (let i = 0; i < inst.length; i++) {
      const it = inst[i] || {};
      const pos = it.pos || [0, 0, 0];
      const x = Number(pos[0]) || 0;
      const y = Number(pos[1]) || 0;
      const snap = (it.snapToTerrain !== false);
      const hz = snap ? heightAtXY(x, y) : (Number(pos[2]) || 0);
      const yawRad = ((Number(it.yawDeg) || 0) * Math.PI) / 180;
      const sc = Number(it.scale);
      const s = Number.isFinite(sc) ? sc : 1.0;
      // Base dims by kind, then allow per-instance overrides for procedural scenes.
      const dims = kindToDims(it.kind);
      const meta = (it.meta && typeof it.meta === 'object') ? it.meta : null;
      const sx = (meta && Number.isFinite(Number(meta.sx))) ? Number(meta.sx) : dims.sx;
      const sy = (meta && Number.isFinite(Number(meta.sy))) ? Number(meta.sy) : dims.sy;
      const sz = (meta && Number.isFinite(Number(meta.sz))) ? Number(meta.sz) : dims.sz;
      const yOff = (meta && Number.isFinite(Number(meta.yOff))) ? Number(meta.yOff) : (Number.isFinite(Number(dims.yOff)) ? dims.yOff : (sy * 0.5));
      const col = Array.isArray(it.color) ? it.color : (Array.isArray(meta?.color) ? meta.color : dims.col);

      const base = i * floatsPer;
      // translate (x, yUp, zPlane)
      buf[base + 0] = x;
      buf[base + 1] = hz + yOff * s;
      buf[base + 2] = y;
      // scale
      buf[base + 3] = sx * s;
      buf[base + 4] = sy * s;
      buf[base + 5] = sz * s;
      // yaw
      buf[base + 6] = yawRad;
      // color
      buf[base + 7] = Number(col[0] ?? 1);
      buf[base + 8] = Number(col[1] ?? 1);
      buf[base + 9] = Number(col[2] ?? 1);
      buf[base + 10] = Number(col[3] ?? 1);

      // Build colliders directly from computed dims.
      const hx = (sx * s) * 0.5;
      const hy = (sz * s) * 0.5;
      if (hx > 1e-4 && hy > 1e-4) {
        const kind = String(it.kind || '');
        const role = String(meta?.role || '');
        const wallRole = String(meta?.wallRole || '');
        const isWall =
          kind === 'room_wall' ||
          kind === 'wall' ||
          kind.endsWith('_wall') ||
          role === 'wall' ||
          role.endsWith('_wall') ||
          role.includes('wall') ||
          !!wallRole;
        if (isWall) {
          wallCols.push({ cx: x, cy: y, hx, hy, yawRad });
        } else if (solidKinds.has(kind)) {
          if (!(meta && meta.solid === false)) objCols.push({ cx: x, cy: y, hx, hy, yawRad });
        }
      }
    }

    this.instances.setInstances(buf, inst.length);

    // Gameplay collision: apply colliders (built from render-dims, not meta-only).
    try { this.player?.setWallColliders?.(wallCols); } catch { /* ignore */ }
    try { this.player?.setObjectColliders?.(objCols); } catch { /* ignore */ }
    try { globalThis.__debugWallColliders = wallCols.length; } catch { /* ignore */ }
    try { globalThis.__debugObjectColliders = objCols.length; } catch { /* ignore */ }

    // Gameplay interactions: beds/chairs/TVs.
    try {
      const interactables = buildInteractablesFromInstances(inst);
      this._interactions?.setInteractables?.(interactables);
    } catch { /* ignore */ }
  }

  _updatePlayerViz() {
    // If a skinned avatar is loaded, hide the placeholder cube.
    try {
      if (this.avatarLayer?.enabled && this.avatarLayer?.loaded) {
        this.playerViz.setInstances(new Float32Array(0), 0);
        return;
      }
    } catch { /* ignore */ }
    if (!this.player?.enabled) {
      try { this.playerViz.setInstances(new Float32Array(0), 0); } catch { /* ignore */ }
      return;
    }
    const p = this.player.pos;
    const floatsPer = 11;
    const buf = new Float32Array(floatsPer);
    // translate (x, yUp, zPlane)
    buf[0] = p.x;
    buf[1] = p.z + 0.9;
    buf[2] = p.y;
    // scale
    buf[3] = 0.8;
    buf[4] = 1.8;
    buf[5] = 0.8;
    // yaw
    buf[6] = Number(this.player.yawRad) || 0.0;
    // color (red)
    buf[7] = 0.9;
    buf[8] = 0.2;
    buf[9] = 0.2;
    buf[10] = 1.0;
    this.playerViz.setInstances(buf, 1);
  }

  _updateRemotePlayersViz() {
    // Remote players are rendered as blue placeholder capsules (boxes) for now.
    if (!this.remotePlayersViz) return;
    if (!this.mmo?.connected) {
      try { this.remotePlayersViz.setInstances(new Float32Array(0), 0); } catch { /* ignore */ }
      return;
    }
    const floatsPer = 11;
    const all = this.mmo.listPlayers();
    const myId = String(this.mmo.sessionId || '');
    // Distance-cull remote players. Use player position if spawned, otherwise camera.
    const cx = this.player?.enabled ? (Number(this.player?.pos?.x) || 0) : (Number(this.camera?.position?.[0]) || 0);
    const cz = this.player?.enabled ? (Number(this.player?.pos?.y) || 0) : (Number(this.camera?.position?.[2]) || 0);
    const r = Math.max(1, Number(this._mmoCfg?.renderRadiusMeters) || 1200);
    const r2 = r * r;
    const rem = all.filter((p) => {
      const id = String(p?.id || '');
      if (!id || id === myId) return false;
      const dx = (Number(p?.x) || 0) - cx;
      const dz = (Number(p?.y) || 0) - cz;
      return (dx * dx + dz * dz) <= r2;
    });
    if (!rem.length) {
      try { this.remotePlayersViz.setInstances(new Float32Array(0), 0); } catch { /* ignore */ }
      return;
    }
    const buf = new Float32Array(rem.length * floatsPer);
    for (let i = 0; i < rem.length; i++) {
      const p = rem[i];
      const x = Number(p.x) || 0;
      const y = Number(p.y) || 0;
      const hz = this._heightAtXY(x, y);
      const base = i * floatsPer;
      buf[base + 0] = x;
      buf[base + 1] = (Number.isFinite(hz) ? hz : 0) + 0.9;
      buf[base + 2] = y;
      buf[base + 3] = 0.8;
      buf[base + 4] = 1.8;
      buf[base + 5] = 0.8;
      buf[base + 6] = Number(p.yaw) || 0.0;
      // blue
      buf[base + 7] = 0.25;
      buf[base + 8] = 0.55;
      buf[base + 9] = 0.98;
      buf[base + 10] = 1.0;
    }
    try { this.remotePlayersViz.setInstances(buf, rem.length); } catch { /* ignore */ }
  }

  render() {
    const gl = this.gl;
    const now = performance.now();
    const dt = (now - this._lastFrameMs) / 1000;
    this._lastFrameMs = now;

    // Adaptive streaming budgets (tiles): adjust load rates based on smoothed frame time.
    try {
      const ms = Math.max(0.0, Math.min(250.0, dt * 1000.0));
      const sb = this._streamBudget;
      if (sb && sb.enabled) {
        const a = 0.10; // EMA alpha
        sb.emaFrameMs = (Number(sb.emaFrameMs) || 16.7) * (1.0 - a) + ms * a;
        const since = now - (Number(sb.lastAdjustMs) || 0);
        if (since > 450) {
          sb.lastAdjustMs = now;
          const ema = Number(sb.emaFrameMs) || 16.7;
          const target = 16.7;
          const good = ema < target * 1.10;
          const bad = ema > target * 1.70;

          const tweak = (st, { minBudget, maxBudget, minEvery, maxEvery }) => {
            if (!st) return;
            const curB = Math.max(1, Math.floor(Number(st.maxNewLoadsPerUpdate) || 1));
            const curE = Math.max(30, Math.floor(Number(st.updateEveryMs) || 160));
            let nb = curB;
            let ne = curE;
            if (good) { nb = curB + 6; ne = curE - 10; }
            if (bad) { nb = curB - 8; ne = curE + 30; }
            nb = Math.max(minBudget, Math.min(maxBudget, nb));
            ne = Math.max(minEvery, Math.min(maxEvery, ne));
            st.maxNewLoadsPerUpdate = nb;
            st.updateEveryMs = ne;
          };

          // Tune per-layer: near should stay modest; far/super-far can ramp higher.
          tweak(this._buildingTilesStreamer, { minBudget: 4, maxBudget: 28, minEvery: 50, maxEvery: 260 });
          tweak(this._buildingTilesStreamerFar, { minBudget: 6, maxBudget: 140, minEvery: 50, maxEvery: 320 });
          tweak(this._buildingTilesStreamerSuperFar, { minBudget: 6, maxBudget: 180, minEvery: 50, maxEvery: 400 });
        }
      }
    } catch { /* ignore */ }

    // Canvas aspect
    this.camera.setAspect(this.canvas.width, this.canvas.height);
    if (this.gameplayEnabled) {
      // Guarantee the first gameplay frame uses the correct follow-cam matrices.
      // (Spawn/mode switches can happen mid-frame via UI events.)
      try {
        if (this._pendingGameplayCameraSnap && this.player?.enabled) {
          this._pendingGameplayCameraSnap = false;
          this.player.snapCamera?.(this.camera);
        }
      } catch { /* ignore */ }
      this.player.tick(dt, this.camera, this._keys);
    }
    else this.camera.tick(dt);
    try { this._interactions?.tick?.(now, dt); } catch { /* ignore */ }
    // NOTE: collision final-authority is enforced later in the frame (after MMO reconciliation),
    // so nothing can move the player through walls unless no-clip is explicitly enabled.

    // Debug HUD (collision status). Helpful while iterating on indoor collision.
    try {
      this._ensureDebugHud?.();
      const eln = this._hudDebugEl;
      if (eln) {
        eln.style.display = this.gameplayEnabled ? 'block' : 'none';
        if (this.gameplayEnabled) {
          const inst = Array.isArray(this.map?.data?.instances) ? this.map.data.instances : [];
          const wallInst = inst.reduce((n, it) => n + ((String(it?.kind || '') === 'room_wall') ? 1 : 0), 0);
          const wc = Number(globalThis.__debugWallColliders) || 0;
          const oc = Number(globalThis.__debugObjectColliders) || 0;
          const cc = Number(globalThis.__debugCollisionCalls) || 0;
          const ov = Number(globalThis.__debugCollisionOverlaps) || 0;
          const p = this.player?.pos;
          const px = Number(p?.x) || 0;
          const py = Number(p?.y) || 0;
          const noclip = !!this.player?.noClip;
          eln.textContent =
            `collision debug\n` +
            `wallInst=${wallInst} wallCols=${wc} objCols=${oc}\n` +
            `collCalls=${cc} overlaps=${ov} noClip=${noclip ? '1' : '0'}\n` +
            `player=(${px.toFixed(2)}, ${py.toFixed(2)})`;
        }
      }
    } catch { /* ignore */ }

    // Optional early-frame camera debug to pinpoint "tilt" source.
    try {
      if (this._debugCam && (this._debugCamFrames | 0) < 12) {
        this._debugCamFrames = (this._debugCamFrames | 0) + 1;
        const c = this.camera;
        const p = c?.position || [0, 0, 0];
        const t = c?.target || [0, 0, 0];
        const fx = (Number(t[0]) || 0) - (Number(p[0]) || 0);
        const fy = (Number(t[1]) || 0) - (Number(p[1]) || 0);
        const fz = (Number(t[2]) || 0) - (Number(p[2]) || 0);
        const fl = Math.max(1e-9, Math.hypot(fx, fy, fz));
        const yaw = Math.atan2(fx / fl, fz / fl);
        const pitch = Math.asin(Math.max(-1, Math.min(1, (fy / fl))));
        // Approx roll (degrees): compare camera-up vs an "ideal" up from worldUp and forward.
        let rollDeg = 0;
        try {
          const fwd = [fx / fl, fy / fl, fz / fl];
          const worldUp = [0, 1, 0];
          // idealRight = normalize(fwd x worldUp)
          let rx = fwd[1] * worldUp[2] - fwd[2] * worldUp[1];
          let ry = fwd[2] * worldUp[0] - fwd[0] * worldUp[2];
          let rz = fwd[0] * worldUp[1] - fwd[1] * worldUp[0];
          const rl = Math.hypot(rx, ry, rz);
          if (rl > 1e-9) { rx /= rl; ry /= rl; rz /= rl; }
          // idealUp = idealRight x fwd
          const ux = ry * fwd[2] - rz * fwd[1];
          const uy = rz * fwd[0] - rx * fwd[2];
          const uz = rx * fwd[1] - ry * fwd[0];
          const cu = c?.up ? [Number(c.up[0]) || 0, Number(c.up[1]) || 0, Number(c.up[2]) || 0] : worldUp;
          const a = (cu[0] * rx + cu[1] * ry + cu[2] * rz);
          const b = (cu[0] * ux + cu[1] * uy + cu[2] * uz);
          rollDeg = (Math.atan2(a, b) * 180) / Math.PI;
        } catch { /* ignore */ }
        const mode = this.gameplayEnabled ? 'gameplay' : 'editor';
        const py = Number(this.player?.yawRad);
        const pp = Number(this.player?.pitchRad);
        // eslint-disable-next-line no-console
        console.log('[debugCam]', {
          frame: this._debugCamFrames,
          mode,
          dt,
          camPos: [Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0],
          camTarget: [Number(t[0]) || 0, Number(t[1]) || 0, Number(t[2]) || 0],
          camUp: c?.up ? [Number(c.up[0]) || 0, Number(c.up[1]) || 0, Number(c.up[2]) || 0] : null,
          camYawDeg: (yaw * 180) / Math.PI,
          camPitchDeg: (pitch * 180) / Math.PI,
          camRollDeg: rollDeg,
          orbitYaw: Number(c?._yaw),
          orbitPitch: Number(c?._pitch),
          orbitDist: Number(c?._dist),
          playerYaw: Number.isFinite(py) ? py : null,
          playerPitch: Number.isFinite(pp) ? pp : null,
        });
      }
    } catch { /* ignore */ }

    // Multiplayer: send inputs + gently reconcile local predicted position toward server state (if present).
    try {
      if (this.gameplayEnabled && this.player?.enabled && this.mmo?.connected) {
        const k = this._keys;
        const mask =
          (k.has('KeyW') ? 1 : 0) |
          (k.has('KeyA') ? 2 : 0) |
          (k.has('KeyS') ? 4 : 0) |
          (k.has('KeyD') ? 8 : 0) |
          ((k.has('ShiftLeft') || k.has('ShiftRight')) ? 16 : 0);
        this.mmo.tick(now, { mask, yaw: Number(this.player?.yawRad) || 0 });

        const me = this.mmo.players?.get?.(String(this.mmo.sessionId || '')) || null;
        if (me && Number.isFinite(me.x) && Number.isFinite(me.y)) {
          // Small correction factor so it doesn't feel like rubber-banding.
          const a = 1.0 - Math.exp(-10.0 * Math.min(0.10, Math.max(0, dt)));
          this.player.pos.x += (Number(me.x) - this.player.pos.x) * a;
          this.player.pos.y += (Number(me.y) - this.player.pos.y) * a;
          // Keep z grounded locally.
          try { this.player._groundSnap?.(); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }

    // Final authority: enforce collision after *all* systems that can move the player.
    // Only bypassed when no-clip is explicitly enabled (off by default).
    try { if (this.gameplayEnabled && this.player?.enabled) this.player._applyWallCollision?.(); } catch { /* ignore */ }

    // NPC movement/behavior (independent of player).
    try { this._tickNpc(dt); } catch { /* ignore */ }

    // Live compass: update every frame (cheap; only touches transform when heading changes).
    try { this._updateHudCompass(now); } catch { /* ignore */ }

    // Update top city label from camera location (throttled).
    try {
      const since = now - (Number(this._lastCityLabelUpdateMs) || 0);
      if (since > 220) {
        this._lastCityLabelUpdateMs = now;
        this._updateCityLabel();
      }
    } catch { /* ignore */ }

    const canvasW = this.canvas.width;
    const canvasH = this.canvas.height;

    const usePostFx = !!(this.postfx?.ready && this._postfx?.enabled);
    if (usePostFx) {
      this.postfx.enabled = true;
      this.postfx.exposure = Number(this._postfx.exposure ?? 1.0) || 1.0;
      this.postfx.avgLum = Number(this._postfx.avgLum ?? 1.0) || 1.0;
      this.postfx.enableAutoExposure = !!this._postfx.enableAutoExposure;
      this.postfx.autoExposureSpeed = Number(this._postfx.autoExposureSpeed ?? 1.5) || 1.5;
      this.postfx.enableBloom = !!this._postfx.enableBloom;
      this.postfx.bloomStrength = Number(this._postfx.bloomStrength ?? 0.52) || 0.52;
      this.postfx.bloomThreshold = Number(this._postfx.bloomThreshold ?? 0.78) || 0.78;
      this.postfx.bloomRadius = Number(this._postfx.bloomRadius ?? 1.65) || 1.65;
      this.postfx.enableVignette = !!this._postfx.enableVignette;
      this.postfx.vignetteStrength = Number(this._postfx.vignetteStrength ?? 0.12) || 0.12;
      this.postfx.vignetteSoftness = Number(this._postfx.vignetteSoftness ?? 0.78) || 0.78;
      this.postfx.enableGrain = !!this._postfx.enableGrain;
      this.postfx.grainStrength = Number(this._postfx.grainStrength ?? 0.028) || 0.028;
      this.postfx.grainSpeed = Number(this._postfx.grainSpeed ?? 0.75) || 0.75;
      this.postfx.beginScene({ w: canvasW, h: canvasH });
    } else {
      try { gl.bindFramebuffer(gl.FRAMEBUFFER, null); } catch { /* ignore */ }
      gl.viewport(0, 0, canvasW, canvasH);
      gl.clearColor(0.02, 0.03, 0.05, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }

    // Sky (draw first; no depth)
    if (this._sky?.enabled && this.sky?.ready) {
      const t = (now * 0.00004) % (Math.PI * 2);
      const sunDir = [Math.cos(t) * 0.35, 0.85, Math.sin(t) * 0.35];
      this.sky.render({
        topColor: this._sky.topColor,
        bottomColor: this._sky.bottomColor,
        sunDir,
        sunIntensity: Number(this._sky.sunIntensity ?? 1.0) || 1.0,
        starIntensity: Number(this._sky.starIntensity ?? 0.0) || 0.0,
      });
    }

    if (this.map) {
      this.terrain.render(this.camera.viewProj);
      // Ocean plane background (optional). Render before OSM water so detailed polygons can draw on top.
      if (this._water?.enabled) {
        try {
          this.water.opacity = Number(this._water?.opacity ?? 0.55) || 0.55;
          this.water.levelY = Number(this._water?.levelY ?? 0.0) || 0.0;
          this.water.render(this.camera.viewProj, { timeSec: now * 0.001 });
        } catch { /* ignore */ }
      }
      // OSM water (polygons) + waterways, if a geojson-wgs84-water dataset is loaded.
      try {
        this.osmWater.render(this.camera.viewProj);
        this.osmWaterways.render(this.camera.viewProj, { lightDir: [0.25, 0.95, 0.25] });
        this.osmWaterShoreline.render(this.camera.viewProj, { color: [0.85, 0.95, 1.0, 0.55], depthTest: true });
      } catch { /* ignore */ }
      // State outline is a separate layer so it can be styled independently.
      try { this.osmLinesState.render(this.camera.viewProj, { color: [0.25, 0.85, 1.0, 0.55], depthTest: false }); } catch { /* ignore */ }
      this.osmLines.render(this.camera.viewProj, { color: [0.98, 0.65, 0.22, 0.65], depthTest: false });
      // Keep streamed overlays updated as the camera moves.
      try { this._updateDatasetStreaming(false); } catch { /* ignore */ }
      try { if (this._buildingTilesStreamer) this._buildingTilesStreamer.update(this.camera, { force: false }); } catch { /* ignore */ }
      try { if (this._buildingTilesStreamerFar) this._buildingTilesStreamerFar.update(this.camera, { force: false }); } catch { /* ignore */ }
      try { if (this._buildingTilesStreamerSuperFar) this._buildingTilesStreamerSuperFar.update(this.camera, { force: false }); } catch { /* ignore */ }
      try { if (this._buildingFootprintsTilesStreamer) this._buildingFootprintsTilesStreamer.update(this.camera, { force: false }); } catch { /* ignore */ }
      this.osmRoads.render(this.camera.viewProj, { lightDir: [0.25, 0.95, 0.25] });
      // Extra detail layers
      this.osmRails.render(this.camera.viewProj, { lightDir: [0.25, 0.95, 0.25] });
      this.osmBarriers.render(this.camera.viewProj, { lightDir: [0.25, 0.95, 0.25] });
      this.osmTrees.render(this.camera.viewProj, { lightDir: [0.25, 0.95, 0.25] });
      this.osmPowerLines.render(this.camera.viewProj, { color: [0.78, 0.80, 0.86, 0.45], depthTest: true });
      const hasNearExtruded = !!this._buildingFootprintsTilesStreamer && !!this.osmBuildingsExtruded?.hasMesh;
      if (this._activeBuildingsMode === 'extruded') this.osmBuildingsExtruded.render(this.camera.viewProj);
      else if (this._activeBuildingsMode === 'tiles_lod') {
        // Crossfade between:
        // - LOD2: super-far mass
        // - LOD0: mid blocks
        // - LOD1: near buildings
        const camX = Number(this.camera?.position?.[0] ?? 0);
        const camZ = Number(this.camera?.position?.[2] ?? 0);
        const camY = Number(this.camera?.position?.[1] ?? 0);
        const cs1 = Number(this._buildingTilesStreamer?.chunkSizeMeters ?? 512) || 512;
        const r1 = Math.max(1, Number(this._buildingTilesStreamer?.radiusChunks ?? 6) || 6);
        const inner10 = Math.max(0, (r1 - 1) * cs1);
        const outer10 = r1 * cs1;

        const cs0 = Number(this._buildingTilesStreamerFar?.chunkSizeMeters ?? (cs1 * 4)) || (cs1 * 4);
        const r0 = Math.max(r1 + 2, Number(this._buildingTilesStreamerFar?.radiusChunks ?? 20) || 20);
        const inner20 = Math.max(0, (r0 - 2) * cs0);
        const outer20 = r0 * cs0;
        const hasLod2 = !!this._buildingTilesStreamerSuperFar;
        // Even in "full world" mode, frustum culling should stay on (it doesn't affect streaming, only draw cost).
        const cullEnabled = true;
        // Fog: start around the LOD0<->LOD1 band, end well into the distance. Hides LOD seams and adds depth.
        const fogStart = Math.max(outer10 * 0.9, 1200);
        const fogEnd = Math.max(fogStart + 1, Math.min(Number(this.camera?.far ?? 50000) || 50000, fogStart * 6.0));
        const fog = { cameraPos: [camX, camY, camZ], color: [0.70, 0.78, 0.90], start: fogStart, end: fogEnd };
        // Bands:
        // - LOD1 fades OUT across (inner10..outer10)
        // - LOD0 fades IN across (inner10..outer10)
        // - If LOD2 exists: LOD0 fades OUT across (inner20..outer20), and LOD2 fades IN across (inner20..outer20)
        const fadeLod1 = { cameraX: camX, cameraZ: camZ, bands: [{ inner: inner10, outer: outer10, invert: true }] };
        const fadeLod0 = hasLod2
          ? { cameraX: camX, cameraZ: camZ, bands: [{ inner: inner10, outer: outer10, invert: false }, { inner: inner20, outer: outer20, invert: true }] }
          : { cameraX: camX, cameraZ: camZ, bands: [{ inner: inner10, outer: outer10, invert: false }] };
        const fadeLod2 = { cameraX: camX, cameraZ: camZ, bands: [{ inner: inner20, outer: outer20, invert: false }] };

        if (hasLod2) this.osmBuildingsTilesSuperFar.render(this.camera.viewProj, { fade: fadeLod2, fog, cull: { enabled: cullEnabled } });
        this.osmBuildingsTilesFar.render(this.camera.viewProj, { fade: fadeLod0, fog, cull: { enabled: cullEnabled } });
        // If we have near-camera footprint extrusion, use it as near LOD and skip LOD1 boxes.
        if (!hasNearExtruded) this.osmBuildingsTiles.render(this.camera.viewProj, { fade: fadeLod1, fog, cull: { enabled: cullEnabled } });
        else this.osmBuildingsExtruded.render(this.camera.viewProj);
      } else if (this._activeBuildingsMode === 'tiles') {
        const camX = Number(this.camera?.position?.[0] ?? 0);
        const camY = Number(this.camera?.position?.[1] ?? 0);
        const camZ = Number(this.camera?.position?.[2] ?? 0);
        const fogStart = Math.max(900, Math.min(4500, (Number(this.camera?._dist) || 0) * 0.9));
        const fogEnd = Math.max(fogStart + 1, Math.min(Number(this.camera?.far ?? 50000) || 50000, fogStart * 6.0));
        const fog = { cameraPos: [camX, camY, camZ], color: [0.70, 0.78, 0.90], start: fogStart, end: fogEnd };
        if (hasNearExtruded) {
          // Fade tiles in beyond the footprint-tile radius to reduce double-coverage.
          const cs = Number(this._buildingFootprintsTilesStreamer?.chunkSizeMeters ?? 512) || 512;
          const r = Math.max(1, Number(this._buildingFootprintsTilesStreamer?.radiusChunks ?? 3) || 3);
          const inner = Math.max(0, (r - 1) * cs);
          const outer = r * cs;
          const fade = { cameraX: camX, cameraZ: camZ, bands: [{ inner, outer, invert: false }] };
          this.osmBuildingsTiles.render(this.camera.viewProj, { fog, fade, cull: { enabled: true } });
          this.osmBuildingsExtruded.render(this.camera.viewProj);
        } else {
          this.osmBuildingsTiles.render(this.camera.viewProj, { fog, cull: { enabled: true } });
        }
      }
      else this.osmBuildings.render(this.camera.viewProj, { facade: 1.0 });
      this.osmProps.render(this.camera.viewProj);
      try { this._updateIndoorsDebug(now); } catch { /* ignore */ }
      try { this._updateNearestBuildingInspect(); } catch { /* ignore */ }
      if (this._indoors?.enabled && this._indoors?.debug) {
        this.indoorDebugLines.render(this.camera.viewProj, { color: [0.22, 0.92, 0.70, 0.80], depthTest: false });
      }
      this.instances.render(this.camera.viewProj);
      this._updatePlayerViz();
      this.playerViz.render(this.camera.viewProj);
      this._updateRemotePlayersViz();
      this.remotePlayersViz.render(this.camera.viewProj);
      try {
        this.avatarLayer.enabled = !!this._avatar?.enabled;
        this.avatarLayer.scale = Number(this._avatar?.scale) || 1.0;
        this.avatarLayer.yOffset = Number(this._avatar?.yOffset) || 0.0;
        this.avatarLayer.tickAndRender({ dtSec: dt, appCamera: this.camera, player: this.player });
      } catch { /* ignore */ }
      try {
        // NPC is only rendered in gameplay mode (to keep editor navigation uncluttered).
        this.npcLayer.enabled = !!this._npc?.enabled && !!this.gameplayEnabled;
        this.npcLayer.scale = Number(this._npc?.scale) || 1.0;
        this.npcLayer.yOffset = Number(this._npc?.yOffset) || 0.0;
        const url = String(this._npc?.url || '').trim();
        if (this.npcLayer.enabled && url) {
          const urlChanged = (url !== String(this._npcLastUrl || ''));
          if (urlChanged) {
            this._npcLastUrl = url;
            this._npcLoadRequested = false;
          }
          if (!this.npcLayer.loaded && !this._npcLoadRequested) {
            this._npcLoadRequested = true;
            this.npcLayer.load(url).then(() => {
              this._npcLoadRequested = false;
            }).catch(() => { this._npcLoadRequested = false; });
          }
        }
        // Drive the animation layer with a "player-shaped" state object.
        this._npcState.enabled = this.npcLayer.enabled && !!this.npcLayer.loaded;
        this.npcLayer.tickAndRender({ dtSec: dt, appCamera: this.camera, player: this._npcState });
      } catch { /* ignore */ }
      try {
        this.vehicleLayer.enabled = !!this._vehicle?.enabled;
        this.vehicleLayer.scale = Number(this._vehicle?.scale) || 1.0;
        this.vehicleLayer.yOffset = Number(this._vehicle?.yOffset) || 0.0;
        // Ensure the selected vehicle is actually loaded (covers cases where the user only toggles Gameplay).
        const url = String(this._vehicle?.url || '').trim();
        if (this.vehicleLayer.enabled && url) {
          const urlChanged = (url !== String(this._vehicleLastUrl || ''));
          if (urlChanged) {
            this._vehicleLastUrl = url;
            this._vehicleLoadRequested = false;
            this._vehiclePose = null;
          }
          if (!this.vehicleLayer.loaded && !this._vehicleLoadRequested) {
            this._vehicleLoadRequested = true;
            this.vehicleLayer.load(url).then(() => {
              this._vehicleLoadRequested = false;
              try { if (!this._vehiclePose && this.player?.enabled) this._spawnTestVehicleInFrontOfPlayer(); } catch { /* ignore */ }
            }).catch(() => { this._vehicleLoadRequested = false; });
          }
        }

        this.vehicleLayer.tickAndRender({ appCamera: this.camera, pose: this._vehiclePose, dtSec: dt });
      } catch { /* ignore */ }
      if (this._pointer.down && this._pointer.painting && (this.tool === 'paint' || this.tool === 'sculpt')) this._applyBrushFromPointer();
    }

    if (usePostFx) {
      this.postfx.endScene({ canvasW, canvasH });
    }

    // 2D overlay labels (draw last, after postfx resolve).
    try { this._renderRoadLabels2d(); } catch { /* ignore */ }
  }

  _resizeLabelCanvasToGl() {
    const c = this._labelCanvas;
    if (!c) return;
    const w = this.canvas?.width || 1;
    const h = this.canvas?.height || 1;
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
  }

  _renderRoadLabels2d() {
    const ctx = this._labelCtx;
    const c = this._labelCanvas;
    if (!ctx || !c) return;
    this._resizeLabelCanvasToGl();

    // Always clear; labels are dynamic with camera movement.
    ctx.clearRect(0, 0, c.width, c.height);

    if (!this.map) return;
    if (!this._labels?.enabled) return;
    // If labels are baked into the terrain texture, don't also draw the screen-space overlay.
    if (this._labels?.bakeToTerrain) return;
    const labels = this._activeRoadLabels;
    if (!Array.isArray(labels) || labels.length === 0) return;

    const vp = this.camera?.viewProj;
    if (!vp) return;

    const maxDraw = Math.max(0, Math.floor(Number(this._labels?.maxDraw ?? 280) || 280));
    const baseCellPx = Math.max(20, Math.floor(Number(this._labels?.cellPx ?? 90) || 90));
    const dist = Math.max(1e-3, Number(this.camera?._dist) || 0);
    // Scale labels with zoom (wheel) so they stay readable up close, and de-clutter when zoomed out.
    // This is intentionally gentle: a ~100x zoom-out shrinks labels by ~35%.
    const zoomScale = clamp(Math.pow(180 / dist, 0.15), 0.65, 1.35);
    const cellPx = Math.max(20, Math.floor(baseCellPx * zoomScale));

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // Hint for better glyph positioning (where supported).
    try { ctx.fontKerning = 'normal'; } catch { /* ignore */ }

    const occ = new Set(); // coarse collision grid; key = `${bx},${by}`
    const tmp = vec4.create();
    const tmp2 = vec4.create();
    let drawn = 0;

    const kindTone = (kind) => {
      const h = String(kind || '').toLowerCase();
      if (h === 'motorway') return { fg: 'rgba(238,245,255,0.98)', plate: 'rgba(54,115,210,0.40)', plateStroke: 'rgba(140,190,255,0.22)' };
      if (h === 'trunk') return { fg: 'rgba(238,245,255,0.98)', plate: 'rgba(70,140,220,0.34)', plateStroke: 'rgba(140,190,255,0.18)' };
      if (h === 'primary') return { fg: 'rgba(245,248,255,0.98)', plate: 'rgba(255,170,70,0.28)', plateStroke: 'rgba(255,210,160,0.18)' };
      if (h === 'secondary') return { fg: 'rgba(245,248,255,0.98)', plate: 'rgba(255,210,120,0.22)', plateStroke: 'rgba(255,240,200,0.14)' };
      if (h === 'tertiary') return { fg: 'rgba(242,246,255,0.98)', plate: 'rgba(255,255,255,0.14)', plateStroke: 'rgba(255,255,255,0.10)' };
      return { fg: 'rgba(236,242,255,0.98)', plate: 'rgba(0,0,0,0.18)', plateStroke: 'rgba(255,255,255,0.10)' };
    };

    const roundRectPath = (x, y, w, h, r) => {
      const rr = Math.max(0, Math.min(r, Math.min(w, h) * 0.5));
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    };

    for (let i = 0; i < labels.length; i++) {
      if (drawn >= maxDraw) break;
      const lab = labels[i];
      const x = Number(lab?.x);
      const z = Number(lab?.z);
      const text = String(lab?.text || '').trim();
      if (!Number.isFinite(x) || !Number.isFinite(z) || !text) continue;

      const y = this._heightAtXY(x, z) + 0.35;
      tmp[0] = x; tmp[1] = y; tmp[2] = z; tmp[3] = 1.0;
      vec4.transformMat4(tmp, tmp, vp);
      const w = tmp[3];
      if (!(w > 0)) continue;
      const ndcX = tmp[0] / w;
      const ndcY = tmp[1] / w;
      const ndcZ = tmp[2] / w;
      if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) continue;
      // Clip Z: tolerate a bit since depth ranges can vary; just reject far-behind.
      if (ndcZ < -2 || ndcZ > 2) continue;

      const sx = (ndcX * 0.5 + 0.5) * c.width;
      const sy = (-ndcY * 0.5 + 0.5) * c.height;
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;

      const pri = Number(lab?.priority) || 0;
      const baseSize = (pri >= 4) ? 15 : (pri >= 2 ? 14 : 13);
      const size = Math.max(10, Math.round(baseSize * zoomScale));
      ctx.font = `800 ${size}px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif`;

      // Fade: deemphasize low-priority labels and distant labels.
      const priAlpha = clamp((pri - 0.25) / 5.0, 0.25, 1.0);
      const distAlpha = clamp(Math.pow(zoomScale, 0.85), 0.55, 1.0);
      const alpha = clamp(priAlpha * distAlpha, 0.18, 1.0);
      if (alpha < 0.2 && pri < 0.8) continue;

      // Compute a screen-space angle from the road tangent (project two points).
      let ang = 0;
      const dirXw = Number(lab?.dirX);
      const dirZw = Number(lab?.dirZ);
      if (Number.isFinite(dirXw) && Number.isFinite(dirZw) && (Math.abs(dirXw) + Math.abs(dirZw) > 1e-6)) {
        const step = 18; // meters
        tmp2[0] = x + dirXw * step;
        tmp2[1] = y;
        tmp2[2] = z + dirZw * step;
        tmp2[3] = 1.0;
        vec4.transformMat4(tmp2, tmp2, vp);
        const w2 = tmp2[3];
        if (w2 > 0) {
          const ndcX2 = tmp2[0] / w2;
          const ndcY2 = tmp2[1] / w2;
          const sx2 = (ndcX2 * 0.5 + 0.5) * c.width;
          const sy2 = (-ndcY2 * 0.5 + 0.5) * c.height;
          const dxs = sx2 - sx;
          const dys = sy2 - sy;
          if (Number.isFinite(dxs) && Number.isFinite(dys) && (Math.abs(dxs) + Math.abs(dys) > 1e-3)) {
            ang = Math.atan2(dys, dxs);
            // Keep text upright-ish.
            if (ang > Math.PI * 0.5) ang -= Math.PI;
            if (ang < -Math.PI * 0.5) ang += Math.PI;
          }
        }
      }

      // Measure bounds for collision (rotated rect -> AABB).
      const m = ctx.measureText(text);
      const isRef = !!lab?.isRef;
      const padX = (isRef ? 9 : 7) * zoomScale;
      const padY = (isRef ? 6 : 5) * zoomScale;
      const tw = Math.max(6, Number(m.width) || 0);
      const th = Math.max(10, size * 1.1);
      const rw = tw + padX * 2;
      const rh = th + padY * 2;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const aabbW = Math.abs(rw * ca) + Math.abs(rh * sa);
      const aabbH = Math.abs(rw * sa) + Math.abs(rh * ca);

      const bx0 = Math.floor((sx - aabbW * 0.5) / cellPx);
      const bx1 = Math.floor((sx + aabbW * 0.5) / cellPx);
      const by0 = Math.floor((sy - aabbH * 0.5) / cellPx);
      const by1 = Math.floor((sy + aabbH * 0.5) / cellPx);
      let blocked = false;
      for (let by = by0; by <= by1 && !blocked; by++) {
        for (let bx = bx0; bx <= bx1; bx++) {
          const key = `${bx},${by}`;
          if (occ.has(key)) { blocked = true; break; }
        }
      }
      if (blocked) continue;
      for (let by = by0; by <= by1; by++) {
        for (let bx = bx0; bx <= bx1; bx++) {
          occ.add(`${bx},${by}`);
        }
      }

      // Readability: dark stroke + soft shadow.
      ctx.save();
      ctx.translate(sx, sy);
      if (ang) ctx.rotate(ang);

      ctx.globalAlpha = alpha;
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = Math.round(6 * zoomScale);
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = Math.round(2 * zoomScale);

      const tone = kindTone(lab?.kind);
      const x0 = -rw * 0.5;
      const y0 = -rh * 0.5;
      // Plate: refs always get a plate; names get one when zoomed out to keep legibility.
      const wantPlate = isRef || zoomScale < 0.95 || pri < 1.2;
      if (wantPlate) {
        roundRectPath(x0, y0, rw, rh, (isRef ? 10 : 9) * zoomScale);
        ctx.fillStyle = isRef ? 'rgba(0,0,0,0.56)' : tone.plate;
        ctx.fill();
        ctx.shadowBlur = 0;
        // Keep the plate border extremely subtle (borders easily read as "weird outlines").
        ctx.lineWidth = Math.max(1, Math.round(1.0 * zoomScale));
        ctx.strokeStyle = isRef ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.06)';
        ctx.stroke();
        ctx.shadowBlur = Math.round(6 * zoomScale);
        ctx.shadowOffsetY = Math.round(2 * zoomScale);
      }

      // Softer halo: shadow-underpaint (no hard strokeText outline).
      // This reads much more "production map" than a crisp outline.
      const fill = isRef ? 'rgba(245,250,255,0.98)' : tone.fg;
      ctx.shadowColor = 'rgba(0,0,0,0.70)';
      ctx.shadowBlur = Math.round(10 * zoomScale);
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = Math.round(2 * zoomScale);
      // Underpaint pass (shadow applied).
      ctx.fillStyle = fill;
      ctx.fillText(text, 0, 0);
      // Crisp pass (no shadow).
      ctx.shadowBlur = 0;
      ctx.fillStyle = fill;
      ctx.fillText(text, 0, 0);

      ctx.restore();

      drawn++;
    }
  }

  _ensureTerrainLabelsCanvas(sizePx) {
    const s = Math.max(256, Math.min(8192, Math.floor(Number(sizePx) || 2048)));
    let c = this._labelsTerrainCanvas;
    if (!c) {
      c = document.createElement('canvas');
      this._labelsTerrainCanvas = c;
      this._labelsTerrainCtx = /** @type {CanvasRenderingContext2D|null} */ (c.getContext('2d'));
    }
    if (c.width !== s) c.width = s;
    if (c.height !== s) c.height = s;
    return c;
  }

  _bakeRoadLabelsToTerrainTexture() {
    if (!this.map || !this.terrain?.ready) return;
    const enabled = !!this._labels?.enabled;
    const bake = !!this._labels?.bakeToTerrain;
    const labels = this._activeRoadLabels;
    if (!enabled || !bake || !Array.isArray(labels) || labels.length === 0) {
      try { this.terrain.clearLabels(); } catch { /* ignore */ }
      return;
    }

    const b = this.map?.bounds;
    if (!b) return;
    const minX = Number(b.minX) || 0;
    const maxX = Number(b.maxX) || 0;
    const minY = Number(b.minY) || 0;
    const maxY = Number(b.maxY) || 0;
    const sizeX = Math.max(1e-6, maxX - minX);
    const sizeZ = Math.max(1e-6, maxY - minY);

    const texSize = Number(this._labels?.terrainTexSize ?? 2048) || 2048;
    const c = this._ensureTerrainLabelsCanvas(texSize);
    const ctx = this._labelsTerrainCtx;
    if (!ctx) return;

    ctx.clearRect(0, 0, c.width, c.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    try { ctx.fontKerning = 'normal'; } catch { /* ignore */ }

    const maxDraw = Math.max(0, Math.floor(Number(this._labels?.terrainMaxDraw ?? 5000) || 5000));
    const cellPx = Math.max(18, Math.floor(c.width / 32)); // coarse de-clutter grid
    const occ = new Set();
    let drawn = 0;

    const kindTone = (kind) => {
      const h = String(kind || '').toLowerCase();
      if (h === 'motorway') return { fg: 'rgba(250,252,255,0.95)' };
      if (h === 'trunk') return { fg: 'rgba(250,252,255,0.92)' };
      if (h === 'primary') return { fg: 'rgba(252,252,252,0.90)' };
      if (h === 'secondary') return { fg: 'rgba(252,252,252,0.88)' };
      return { fg: 'rgba(250,250,250,0.84)' };
    };

    for (let i = 0; i < labels.length; i++) {
      if (drawn >= maxDraw) break;
      const lab = labels[i];
      const x = Number(lab?.x);
      const z = Number(lab?.z);
      const text = String(lab?.text || '').trim();
      if (!Number.isFinite(x) || !Number.isFinite(z) || !text) continue;

      // Map world (x,z) to terrain UV:
      // u = (x - minX) / sizeX
      // v = (maxY - z) / sizeZ   (matches terrain's north-up mapping)
      const u = (x - minX) / sizeX;
      const v = (maxY - z) / sizeZ;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const sx = u * c.width;
      const sy = v * c.height;

      const pri = Number(lab?.priority) || 0;
      const baseSize = (pri >= 4) ? 18 : (pri >= 2 ? 16 : 14);
      const size = Math.max(11, Math.min(22, Math.round(baseSize)));
      ctx.font = `800 ${size}px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif`;

      // Approximate rotated AABB for occupancy (good enough).
      const m = ctx.measureText(text);
      const tw = Math.max(6, Number(m.width) || 0);
      const th = Math.max(10, size * 1.1);
      const rw = tw + 12;
      const rh = th + 10;
      const bx0 = Math.floor((sx - rw * 0.5) / cellPx);
      const bx1 = Math.floor((sx + rw * 0.5) / cellPx);
      const by0 = Math.floor((sy - rh * 0.5) / cellPx);
      const by1 = Math.floor((sy + rh * 0.5) / cellPx);
      let blocked = false;
      for (let by = by0; by <= by1 && !blocked; by++) {
        for (let bx = bx0; bx <= bx1; bx++) {
          const key = `${bx},${by}`;
          if (occ.has(key)) { blocked = true; break; }
        }
      }
      if (blocked) continue;
      for (let by = by0; by <= by1; by++) {
        for (let bx = bx0; bx <= bx1; bx++) occ.add(`${bx},${by}`);
      }

      // Rotation from road direction (in world); since our texture maps x->right, z->up (north),
      // and v is flipped, use atan2(-dirZ, dirX) so text follows the road in texture space.
      let ang = 0;
      const dirX = Number(lab?.dirX);
      const dirZ = Number(lab?.dirZ);
      if (Number.isFinite(dirX) && Number.isFinite(dirZ) && (Math.abs(dirX) + Math.abs(dirZ) > 1e-6)) {
        ang = Math.atan2(-dirZ, dirX);
        if (ang > Math.PI * 0.5) ang -= Math.PI;
        if (ang < -Math.PI * 0.5) ang += Math.PI;
      }

      ctx.save();
      ctx.translate(sx, sy);
      if (ang) ctx.rotate(ang);

      // Halo + fill (map-like).
      ctx.shadowColor = 'rgba(0,0,0,0.40)';
      ctx.shadowBlur = 6;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 1;
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.strokeText(text, 0, 0);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(text, 0, 0);

      const tone = kindTone(lab?.kind);
      ctx.fillStyle = tone.fg;
      ctx.fillText(text, 0, 0);

      ctx.restore();
      drawn++;
    }

    try {
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const u8 = new Uint8Array(img.data.buffer);
      this.terrain.uploadLabelsRgba(c.width, c.height, u8);
    } catch {
      // If getImageData fails (tainted canvas / memory), just disable.
      try { this.terrain.clearLabels(); } catch { /* ignore */ }
    }
  }

  dispose() {
    try { this.terrain.dispose(); } catch { /* ignore */ }
    try { this.water.dispose(); } catch { /* ignore */ }
    try { this.osmWater.dispose(); } catch { /* ignore */ }
    try { this.osmWaterShoreline.dispose(); } catch { /* ignore */ }
    try { this.osmWaterways.dispose(); } catch { /* ignore */ }
    try { this.osmPowerLines.dispose(); } catch { /* ignore */ }
    try { this.osmLines.setLinesPositions(new Float32Array(0)); } catch { /* ignore */ }
    try { this.osmRoads.dispose(); } catch { /* ignore */ }
    try { this.osmRails.dispose(); } catch { /* ignore */ }
    try { this.osmBarriers.dispose(); } catch { /* ignore */ }
    try { this.osmTrees.dispose(); } catch { /* ignore */ }
    try { this.osmBuildings.dispose(); } catch { /* ignore */ }
    try { this.osmBuildingsTiles.dispose(); } catch { /* ignore */ }
    try { this.osmBuildingsTilesFar.dispose(); } catch { /* ignore */ }
    try { this.osmBuildingsTilesSuperFar.dispose(); } catch { /* ignore */ }
    try { this.osmProps.dispose(); } catch { /* ignore */ }
    try { this.osmBuildingsExtruded.dispose(); } catch { /* ignore */ }
    try { this.indoorDebugLines.dispose(); } catch { /* ignore */ }
    try { this.instances.dispose(); } catch { /* ignore */ }
    try { this.playerViz.dispose(); } catch { /* ignore */ }
    try { this.remotePlayersViz.dispose(); } catch { /* ignore */ }
    try { if (this.avatarLayer) this.avatarLayer.dispose(); } catch { /* ignore */ }
    try { if (this.npcLayer) this.npcLayer.dispose(); } catch { /* ignore */ }
    try { if (this.vehicleLayer) this.vehicleLayer.dispose(); } catch { /* ignore */ }
    try { if (this.mmo) this.mmo.disconnect(); } catch { /* ignore */ }
    try { if (this._dockRight) this._dockRight.style.display = 'none'; } catch { /* ignore */ }
    try { if (this._dockLeft) this._dockLeft.style.display = 'none'; } catch { /* ignore */ }
    try { if (this._dockBottom) this._dockBottom.style.display = 'none'; } catch { /* ignore */ }
  }
}


