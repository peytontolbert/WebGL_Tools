import { clamp } from '../ui/dom.js';
import { learnAdjacencyFromExample, generateWfcTileGrid } from './wfc_tilemap.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStringToU32(s) {
  const str = String(s || '');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 255;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function paintDisk(mask, w, h, cx, cy, r, rgba) {
  const rr = r * r;
  for (let yy = -r; yy <= r; yy++) {
    for (let xx = -r; xx <= r; xx++) {
      if (xx * xx + yy * yy > rr) continue;
      const x = cx + xx;
      const y = cy + yy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const bi = (y * w + x) * 4;
      mask[bi + 0] = rgba[0];
      mask[bi + 1] = rgba[1];
      mask[bi + 2] = rgba[2];
      mask[bi + 3] = rgba[3];
    }
  }
}

function bresenhamLine(x0, y0, x1, y1, cb) {
  let dx = Math.abs(x1 - x0);
  let dy = -Math.abs(y1 - y0);
  let sx = x0 < x1 ? 1 : -1;
  let sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    cb(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

function paintRoadLine(mask, w, h, x0, y0, x1, y1, radius, rgba) {
  bresenhamLine(x0, y0, x1, y1, (x, y) => paintDisk(mask, w, h, x, y, radius, rgba));
}

function worldToGrid(bounds, gridW, gridH, x, y) {
  const u = (x - bounds.minX) / Math.max(1e-6, (bounds.maxX - bounds.minX));
  // Heightmap storage (and TerrainRenderer) treat row 0 as the "north" edge, i.e. world Z = maxY.
  // So world y (our ground-plane Z) must map with v flipped.
  const v = (bounds.maxY - y) / Math.max(1e-6, (bounds.maxY - bounds.minY));
  return {
    ix: Math.round(clamp(u, 0, 1) * (gridW - 1)),
    iy: Math.round(clamp(v, 0, 1) * (gridH - 1)),
  };
}

function gridToWorld(bounds, gridW, gridH, ix, iy) {
  const u = (gridW <= 1) ? 0 : ix / (gridW - 1);
  // Match TerrainRenderer's row->world mapping: row 0 is maxY (north), last row is minY (south).
  const v = (gridH <= 1) ? 0 : iy / (gridH - 1);
  return {
    x: bounds.minX + u * (bounds.maxX - bounds.minX),
    y: bounds.maxY - v * (bounds.maxY - bounds.minY),
  };
}

function isRoad(mask, w, h, ix, iy) {
  const bi = (iy * w + ix) * 4;
  const b = mask[bi + 2] || 0;
  const a = mask[bi + 3] || 0;
  return b > 128 || a > 128;
}

// Tile ids used by WFC / mask conversion. Keep aligned with TerrainRenderer.pickColor().
const TILE_GRASS = 0;
const TILE_DIRT = 1;
const TILE_ROAD = 2;
const TILE_STREET = 3;

function tileFromMaskRgba(maskRgba, idx) {
  const bi = idx * 4;
  const r = maskRgba[bi + 0] || 0;
  const g = maskRgba[bi + 1] || 0;
  const b = maskRgba[bi + 2] || 0;
  const a = maskRgba[bi + 3] || 0;
  if (b > 128) return TILE_ROAD;
  if (a > 128) return TILE_STREET;
  if (g > 128) return TILE_DIRT;
  // Default grass includes r=255 in current authoring.
  void r;
  return TILE_GRASS;
}

function tilesToMaskRgba(tilesU8, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const t = tilesU8[i] | 0;
    const bi = i * 4;
    if (t === TILE_ROAD) {
      out[bi + 0] = 0; out[bi + 1] = 0; out[bi + 2] = 255; out[bi + 3] = 0;
    } else if (t === TILE_STREET) {
      out[bi + 0] = 0; out[bi + 1] = 0; out[bi + 2] = 0; out[bi + 3] = 255;
    } else if (t === TILE_DIRT) {
      out[bi + 0] = 0; out[bi + 1] = 255; out[bi + 2] = 0; out[bi + 3] = 0;
    } else {
      // grass default
      out[bi + 0] = 255; out[bi + 1] = 0; out[bi + 2] = 0; out[bi + 3] = 0;
    }
  }
  return out;
}

function isRoadTile(t) {
  const x = t | 0;
  return x === TILE_ROAD || x === TILE_STREET;
}

function isCityCell(ix, iy, w, h, cx, cy, rCells) {
  const dx = ix - cx;
  const dy = iy - cy;
  return (dx * dx + dy * dy) <= (rCells * rCells);
}

export function generateAiCity({ seed = 'ai_city', gridW = 100, gridH = 100, bounds = { minX: -50, minY: -50, minZ: 0, maxX: 50, maxY: 50, maxZ: 22 } } = {}) {
  const seedU32 = (typeof seed === 'number') ? (seed >>> 0) : hashStringToU32(seed);
  const rand = mulberry32(seedU32);

  const heightsU16 = new Uint16Array(gridW * gridH);
  const paintMaskRgba = new Uint8Array(gridW * gridH * 4);

  // Default: grass.
  for (let i = 0; i < gridW * gridH; i++) {
    const bi = i * 4;
    paintMaskRgba[bi + 0] = 255;
    paintMaskRgba[bi + 1] = 0;
    paintMaskRgba[bi + 2] = 0;
    paintMaskRgba[bi + 3] = 0;
  }

  const cx = Math.floor(gridW / 2);
  const cy = Math.floor(gridH / 2);
  const cityR = Math.floor(Math.min(gridW, gridH) * 0.18); // ~18 cells for 100

  // Height: hills + noise, then flatten city core + roads.
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const u = (x / (gridW - 1)) * 2 - 1;
      const v = (y / (gridH - 1)) * 2 - 1;
      const r = Math.sqrt(u * u + v * v);
      const base = Math.max(0, 1 - r);
      const n0 = Math.sin(u * 6.3 + 0.7) * 0.5 + Math.cos(v * 5.2 - 0.2) * 0.5;
      const n1 = Math.sin((u + v) * 7.1 + 1.3) * 0.5;
      let h01 = clamp(base * 0.45 + (n0 * 0.08 + n1 * 0.06) + 0.25, 0, 1);

      // City flatten
      if (isCityCell(x, y, gridW, gridH, cx, cy, cityR)) {
        h01 = clamp(0.22 + (n0 * 0.02), 0, 1);
      }
      heightsU16[y * gridW + x] = Math.round(h01 * 65535);
    }
  }

  // Roads (mask): B=road, A=street
  const ROAD = [0, 0, 255, 0];
  const STREET = [0, 0, 0, 255];

  // Main cross roads through center
  paintRoadLine(paintMaskRgba, gridW, gridH, 6, cy, gridW - 7, cy, 2, ROAD);
  paintRoadLine(paintMaskRgba, gridW, gridH, cx, 6, cx, gridH - 7, 2, ROAD);

  // City ring street
  const ring = cityR + 4;
  for (let a = 0; a < 360; a += 6) {
    const th0 = (a * Math.PI) / 180;
    const th1 = ((a + 6) * Math.PI) / 180;
    const x0 = Math.round(cx + Math.cos(th0) * ring);
    const y0 = Math.round(cy + Math.sin(th0) * ring);
    const x1 = Math.round(cx + Math.cos(th1) * ring);
    const y1 = Math.round(cy + Math.sin(th1) * ring);
    paintRoadLine(paintMaskRgba, gridW, gridH, x0, y0, x1, y1, 1, STREET);
  }

  // Neighborhood grid streets inside city.
  for (let t = -cityR + 3; t <= cityR - 3; t += 7) {
    paintRoadLine(paintMaskRgba, gridW, gridH, cx - cityR + 2, cy + t, cx + cityR - 2, cy + t, 1, STREET);
    paintRoadLine(paintMaskRgba, gridW, gridH, cx + t, cy - cityR + 2, cx + t, cy + cityR - 2, 1, STREET);
  }

  // Flatten roads slightly in height for nicer look (reduce by small amount).
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      if (!isRoad(paintMaskRgba, gridW, gridH, x, y)) continue;
      const idx = y * gridW + x;
      const cur = heightsU16[idx] || 0;
      heightsU16[idx] = Math.max(0, cur - 1400);
    }
  }

  // Instances
  const instances = [];
  const addInst = (kind, assetPath, pos, yawDeg, scale, color) => {
    instances.push({
      id: 'inst_' + Math.random().toString(36).slice(2, 10),
      kind,
      assetPath,
      pos,
      yawDeg,
      scale,
      color, // optional hint for proxy rendering
      snapToTerrain: true,
    });
  };

  // Trees (forest ring): avoid roads + city.
  for (let y = 2; y < gridH - 2; y += 2) {
    for (let x = 2; x < gridW - 2; x += 2) {
      if (isCityCell(x, y, gridW, gridH, cx, cy, cityR + 2)) continue;
      if (isRoad(paintMaskRgba, gridW, gridH, x, y)) continue;
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const forestness = clamp((dist - (cityR + 6)) / (Math.min(gridW, gridH) * 0.5), 0, 1);
      const p = 0.22 + 0.55 * forestness;
      if (rand() > p) continue;
      const wpos = gridToWorld(bounds, gridW, gridH, x + (rand() - 0.5) * 0.9, y + (rand() - 0.5) * 0.9);
      const s = 0.7 + rand() * 1.6;
      addInst('tree', 'assets/ai_city/trees/tree_01', [wpos.x, wpos.y, 0], rand() * 360, s, [0.18, 0.45, 0.2, 1.0]);
    }
  }

  // Houses/buildings: place along city streets (not on road cells; near street cells).
  const nearRoad = (x, y) => {
    for (let yy = -2; yy <= 2; yy++) for (let xx = -2; xx <= 2; xx++) {
      const nx = x + xx, ny = y + yy;
      if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) continue;
      if (isRoad(paintMaskRgba, gridW, gridH, nx, ny)) return true;
    }
    return false;
  };

  for (let y = cy - cityR + 2; y <= cy + cityR - 2; y += 3) {
    for (let x = cx - cityR + 2; x <= cx + cityR - 2; x += 3) {
      if (!isCityCell(x, y, gridW, gridH, cx, cy, cityR)) continue;
      if (isRoad(paintMaskRgba, gridW, gridH, x, y)) continue;
      if (!nearRoad(x, y)) continue;
      if (rand() > 0.33) continue;

      const wpos = gridToWorld(bounds, gridW, gridH, x + (rand() - 0.5) * 0.6, y + (rand() - 0.5) * 0.6);
      const isTall = rand() < 0.15;
      const kind = isTall ? 'building' : 'house';
      const asset = isTall ? 'assets/ai_city/buildings/building_01' : 'assets/ai_city/houses/house_01';
      const sc = isTall ? (1.4 + rand() * 1.6) : (0.9 + rand() * 0.7);
      const col = isTall ? [0.55, 0.58, 0.62, 1.0] : [0.62, 0.52, 0.42, 1.0];
      addInst(kind, asset, [wpos.x, wpos.y, 0], rand() * 360, sc, col);
    }
  }

  // Cars: sprinkle along main roads (use grid lines near center).
  for (let i = 0; i < 18; i++) {
    const alongX = rand() < 0.5;
    const t = rand();
    const wx = alongX ? (bounds.minX + t * (bounds.maxX - bounds.minX)) : (bounds.minX + 0.5 * (bounds.maxX - bounds.minX));
    const wy = alongX ? (bounds.minY + 0.5 * (bounds.maxY - bounds.minY)) : (bounds.minY + t * (bounds.maxY - bounds.minY));
    const g = worldToGrid(bounds, gridW, gridH, wx, wy);
    if (!isRoad(paintMaskRgba, gridW, gridH, g.ix, g.iy)) continue;
    const yaw = alongX ? 90 : 0;
    addInst('car', 'assets/ai_city/cars/car_01', [wx, wy, 0], yaw + (rand() - 0.5) * 12, 0.9 + rand() * 0.4, [0.2, 0.25, 0.35, 1.0]);
  }

  return {
    ai: { seed: String(seed), generator: 'procedural_ai_city_v1', generatedAt: new Date().toISOString() },
    grid: { width: gridW, height: gridH },
    bounds,
    heightsU16,
    paintMaskRgba,
    instances,
  };
}

/**
 * AI city generation using WFC "from examples" for the road/street tile layer.
 *
 * Shape matches `generateAiCity` so the rest of the app (MapStore/EditorApp) can treat it identically.
 */
export function generateAiCityWfc({
  seed = 'ai_city_wfc',
  gridW = 100,
  gridH = 100,
  bounds = { minX: -50, minY: -50, minZ: 0, maxX: 50, maxY: 50, maxZ: 22 },
  exampleSeed = 'ai_city_example',
  exampleW = 64,
  exampleH = 64,
  maxAttempts = 10,
  pinEdges = true,
  pinCenter = true,
} = {}) {
  const seedU32 = (typeof seed === 'number') ? (seed >>> 0) : hashStringToU32(seed);
  const rand = mulberry32(seedU32);

  const W = Math.max(16, gridW | 0);
  const H = Math.max(16, gridH | 0);

  // 1) Learn constraints from an example map.
  // We derive the example from the existing generator so this stays dependency-free.
  const ex = generateAiCity({
    seed: String(exampleSeed || 'ai_city_example'),
    gridW: Math.max(24, exampleW | 0),
    gridH: Math.max(24, exampleH | 0),
    bounds: { minX: -50, minY: -50, minZ: 0, maxX: 50, maxY: 50, maxZ: 22 },
  });
  const exW = ex.grid.width;
  const exH = ex.grid.height;
  const exTiles = new Uint8Array(exW * exH);
  for (let i = 0; i < exW * exH; i++) exTiles[i] = tileFromMaskRgba(ex.paintMaskRgba, i);

  const model = learnAdjacencyFromExample(exTiles, exW, exH, 4);

  // 2) Build pins (hard constraints) for stability/playability.
  /** @type {{ x:number, y:number, tile:number }[]} */
  const pins = [];
  if (pinEdges) {
    // Keep a 1-cell grass border; avoids roads "leaking" off the map edge.
    for (let x = 0; x < W; x++) {
      pins.push({ x, y: 0, tile: TILE_GRASS });
      pins.push({ x, y: H - 1, tile: TILE_GRASS });
    }
    for (let y = 0; y < H; y++) {
      pins.push({ x: 0, y, tile: TILE_GRASS });
      pins.push({ x: W - 1, y, tile: TILE_GRASS });
    }
  }
  if (pinCenter) {
    const cx = Math.floor(W / 2);
    const cy = Math.floor(H / 2);
    // Encourage a navigable core. Prefer STREET (more common in example neighborhoods).
    pins.push({ x: cx, y: cy, tile: TILE_STREET });
    // Small 3x3 "hint" so the seed doesn't collapse into all-grass.
    pins.push({ x: cx + 1, y: cy, tile: TILE_STREET });
    pins.push({ x: cx - 1, y: cy, tile: TILE_STREET });
    pins.push({ x: cx, y: cy + 1, tile: TILE_STREET });
    pins.push({ x: cx, y: cy - 1, tile: TILE_STREET });
  }

  // 3) Run WFC.
  const wfc = generateWfcTileGrid({
    outW: W,
    outH: H,
    seed: String(seed),
    model,
    pins,
    maxAttempts,
  });

  // If WFC fails (contradictions), fall back to the previous generator (robustness > novelty).
  if (!wfc.ok) {
    const fallback = generateAiCity({ seed, gridW: W, gridH: H, bounds });
    fallback.ai = {
      seed: String(seed),
      generator: 'procedural_ai_city_wfc_v1',
      generatedAt: new Date().toISOString(),
      wfc: { ok: false, attempts: maxAttempts, exampleSeed: String(exampleSeed || ''), fallback: true },
    };
    return fallback;
  }

  const tiles = wfc.tiles;
  const paintMaskRgba = tilesToMaskRgba(tiles, W, H);

  // 4) Heightmap: reuse the playable "mostly flat city" terrain, but flatten road/street tiles.
  const heightsU16 = new Uint16Array(W * H);
  const cx = Math.floor(W / 2);
  const cy = Math.floor(H / 2);
  const cityR = Math.floor(Math.min(W, H) * 0.18);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x / (W - 1)) * 2 - 1;
      const v = (y / (H - 1)) * 2 - 1;
      const r = Math.sqrt(u * u + v * v);
      const base = Math.max(0, 1 - r);
      const n0 = Math.sin(u * 6.3 + 0.7) * 0.5 + Math.cos(v * 5.2 - 0.2) * 0.5;
      const n1 = Math.sin((u + v) * 7.1 + 1.3) * 0.5;
      let h01 = clamp(base * 0.45 + (n0 * 0.08 + n1 * 0.06) + 0.25, 0, 1);
      if (isCityCell(x, y, W, H, cx, cy, cityR)) {
        h01 = clamp(0.22 + (n0 * 0.02), 0, 1);
      }
      heightsU16[y * W + x] = Math.round(h01 * 65535);
    }
  }
  // Slight road flattening.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (!isRoadTile(tiles[idx])) continue;
      const cur = heightsU16[idx] || 0;
      heightsU16[idx] = Math.max(0, cur - 1400);
    }
  }

  // 5) Instances: reuse the existing heuristics, but drive "roadness" from tiles instead of mask paint strokes.
  const instances = [];
  const addInst = (kind, assetPath, pos, yawDeg, scale, color) => {
    instances.push({
      id: 'inst_' + Math.random().toString(36).slice(2, 10),
      kind,
      assetPath,
      pos,
      yawDeg,
      scale,
      color,
      snapToTerrain: true,
    });
  };

  // Trees: avoid city core and avoid roads.
  for (let y = 2; y < H - 2; y += 2) {
    for (let x = 2; x < W - 2; x += 2) {
      if (isCityCell(x, y, W, H, cx, cy, cityR + 2)) continue;
      if (isRoadTile(tiles[y * W + x])) continue;
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const forestness = clamp((dist - (cityR + 6)) / (Math.min(W, H) * 0.5), 0, 1);
      const p = 0.22 + 0.55 * forestness;
      if (rand() > p) continue;
      const wpos = gridToWorld(bounds, W, H, x + (rand() - 0.5) * 0.9, y + (rand() - 0.5) * 0.9);
      const s = 0.7 + rand() * 1.6;
      addInst('tree', 'assets/ai_city/trees/tree_01', [wpos.x, wpos.y, 0], rand() * 360, s, [0.18, 0.45, 0.2, 1.0]);
    }
  }

  const nearRoad = (x, y) => {
    for (let yy = -2; yy <= 2; yy++) for (let xx = -2; xx <= 2; xx++) {
      const nx = x + xx, ny = y + yy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (isRoadTile(tiles[ny * W + nx])) return true;
    }
    return false;
  };

  // Houses/buildings: place near streets in city core.
  for (let y = cy - cityR + 2; y <= cy + cityR - 2; y += 3) {
    for (let x = cx - cityR + 2; x <= cx + cityR - 2; x += 3) {
      if (!isCityCell(x, y, W, H, cx, cy, cityR)) continue;
      if (isRoadTile(tiles[y * W + x])) continue;
      if (!nearRoad(x, y)) continue;
      if (rand() > 0.33) continue;
      const wpos = gridToWorld(bounds, W, H, x + (rand() - 0.5) * 0.6, y + (rand() - 0.5) * 0.6);
      const isTall = rand() < 0.15;
      const kind = isTall ? 'building' : 'house';
      const asset = isTall ? 'assets/ai_city/buildings/building_01' : 'assets/ai_city/houses/house_01';
      const sc = isTall ? (1.4 + rand() * 1.6) : (0.9 + rand() * 0.7);
      const col = isTall ? [0.55, 0.58, 0.62, 1.0] : [0.62, 0.52, 0.42, 1.0];
      addInst(kind, asset, [wpos.x, wpos.y, 0], rand() * 360, sc, col);
    }
  }

  // Cars: sprinkle on road tiles near the center.
  for (let i = 0; i < 18; i++) {
    const alongX = rand() < 0.5;
    const t = rand();
    const wx = alongX ? (bounds.minX + t * (bounds.maxX - bounds.minX)) : (bounds.minX + 0.5 * (bounds.maxX - bounds.minX));
    const wy = alongX ? (bounds.minY + 0.5 * (bounds.maxY - bounds.minY)) : (bounds.minY + t * (bounds.maxY - bounds.minY));
    const g = worldToGrid(bounds, W, H, wx, wy);
    if (!isRoadTile(tiles[g.iy * W + g.ix])) continue;
    const yaw = alongX ? 90 : 0;
    addInst('car', 'assets/ai_city/cars/car_01', [wx, wy, 0], yaw + (rand() - 0.5) * 12, 0.9 + rand() * 0.4, [0.2, 0.25, 0.35, 1.0]);
  }

  return {
    ai: {
      seed: String(seed),
      generator: 'procedural_ai_city_wfc_v1',
      generatedAt: new Date().toISOString(),
      wfc: {
        ok: true,
        attempt: wfc.attempt,
        maxAttempts,
        exampleSeed: String(exampleSeed || ''),
        exampleSize: [exW, exH],
        pins: { edges: !!pinEdges, center: !!pinCenter },
      },
    },
    grid: { width: W, height: H },
    bounds,
    heightsU16,
    paintMaskRgba,
    instances,
  };
}


