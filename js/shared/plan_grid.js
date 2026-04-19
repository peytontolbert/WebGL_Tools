/**
 * PlanGrid: a structured, text-friendly grid representation for buildings.
 *
 * Coordinate system:
 * - Grid is 2D in (x, y) on the ground plane.
 * - World/data-space: x -> x, y -> y (z is up in the game).
 *
 * Cells store a numeric "region id":
 * - 0: outside/void
 * - >0: inside walkable/room region (hallway, corridor, hall, suite ids, etc.)
 *
 * Walls are derived from boundaries where adjacent cells have different region ids.
 * Doors are modeled by "omitting" specific boundary edges from wall generation.
 */
export class PlanGrid {
  /**
   * @param {{width:number,height:number,cellSize:number,originX:number,originY:number}} cfg
   */
  constructor(cfg) {
    const w = Math.max(1, Math.floor(Number(cfg?.width) || 1));
    const h = Math.max(1, Math.floor(Number(cfg?.height) || 1));
    const cs = Number(cfg?.cellSize) || 1;
    this.width = w;
    this.height = h;
    this.cellSize = (Number.isFinite(cs) && cs > 1e-6) ? cs : 1.0;
    this.originX = Number(cfg?.originX) || 0;
    this.originY = Number(cfg?.originY) || 0;
    /** @type {Uint16Array} */
    this.cells = new Uint16Array(w * h);
  }

  idx(x, y) { return (y * this.width) + x; }

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  get(x, y) {
    if (!this.inBounds(x, y)) return 0;
    return this.cells[this.idx(x, y)] || 0;
  }

  set(x, y, v) {
    if (!this.inBounds(x, y)) return;
    this.cells[this.idx(x, y)] = (Number(v) >>> 0) & 0xffff;
  }

  fill(v) {
    this.cells.fill((Number(v) >>> 0) & 0xffff);
  }

  /**
   * Set a rectangle [x0,x1)×[y0,y1) to region id.
   */
  setRect(x0, y0, x1, y1, v) {
    const rx0 = Math.max(0, Math.min(this.width, Math.floor(x0)));
    const ry0 = Math.max(0, Math.min(this.height, Math.floor(y0)));
    const rx1 = Math.max(0, Math.min(this.width, Math.floor(x1)));
    const ry1 = Math.max(0, Math.min(this.height, Math.floor(y1)));
    const vv = (Number(v) >>> 0) & 0xffff;
    for (let y = ry0; y < ry1; y++) {
      const base = y * this.width;
      for (let x = rx0; x < rx1; x++) this.cells[base + x] = vv;
    }
  }

  /**
   * World-space center of a cell.
   */
  cellCenterWorld(x, y) {
    const cx = this.originX + (x + 0.5) * this.cellSize;
    const cy = this.originY + (y + 0.5) * this.cellSize;
    return [cx, cy];
  }

  /**
   * World-space coordinate of a vertical grid edge at integer x, spanning one cell at y.
   * Returns { x, y0, y1 } in world.
   */
  vEdgeWorld(xEdge, yCell) {
    const x = this.originX + xEdge * this.cellSize;
    const y0 = this.originY + yCell * this.cellSize;
    const y1 = y0 + this.cellSize;
    return { x, y0, y1 };
  }

  /**
   * World-space coordinate of a horizontal grid edge at integer y, spanning one cell at x.
   * Returns { y, x0, x1 } in world.
   */
  hEdgeWorld(xCell, yEdge) {
    const y = this.originY + yEdge * this.cellSize;
    const x0 = this.originX + xCell * this.cellSize;
    const x1 = x0 + this.cellSize;
    return { y, x0, x1 };
  }
}

// Edge key encoding used for doors/openings.
// Vertical edge key at grid xEdge, yCell: `v:xEdge:yCell`
// Horizontal edge key at grid xCell, yEdge: `h:xCell:yEdge`
export function edgeKeyV(xEdge, yCell) { return `v:${xEdge}:${yCell}`; }
export function edgeKeyH(xCell, yEdge) { return `h:${xCell}:${yEdge}`; }

/**
 * Convert a plan grid to a compact ASCII representation.
 * Use `legend` to map region ids to single characters (or default heuristics).
 *
 * @param {PlanGrid} grid
 * @param {{ [regionId:number]: string }} legend
 */
export function planToAscii(grid, legend = {}) {
  const w = grid.width;
  const h = grid.height;
  const lines = [];
  for (let y = h - 1; y >= 0; y--) {
    let s = '';
    for (let x = 0; x < w; x++) {
      const v = grid.get(x, y);
      const ch = legend[v];
      if (typeof ch === 'string' && ch.length) s += ch[0];
      else if (v === 0) s += ' ';
      else if (v < 10) s += String(v);
      else if (v < 36) s += (v - 10).toString(36).toUpperCase(); // 10->A
      else s += '#';
    }
    lines.push(s);
  }
  return lines.join('\n');
}

/**
 * Parse an ASCII plan into a PlanGrid using an inverse legend.
 * Unknown chars become 0.
 *
 * @param {string} ascii
 * @param {{cellSize:number,originX:number,originY:number, legend:{[ch:string]:number}}} cfg
 */
export function asciiToPlan(ascii, cfg) {
  const raw = String(ascii || '').replace(/\r/g, '').split('\n');
  const lines = raw.filter((l) => l.length > 0);
  const h = lines.length || 1;
  const w = Math.max(1, ...lines.map((l) => l.length));
  const grid = new PlanGrid({ width: w, height: h, cellSize: cfg?.cellSize, originX: cfg?.originX, originY: cfg?.originY });
  const inv = (cfg?.legend && typeof cfg.legend === 'object') ? cfg.legend : {};
  for (let yy = 0; yy < h; yy++) {
    const y = (h - 1) - yy;
    const line = lines[yy] || '';
    for (let x = 0; x < w; x++) {
      const ch = line[x] ?? ' ';
      const v = inv[ch];
      if (Number.isFinite(Number(v))) grid.set(x, y, Number(v));
      else grid.set(x, y, 0);
    }
  }
  return grid;
}

/**
 * Derive wall segments from region boundaries in a plan grid.
 *
 * Strategy:
 * - Generate per-cell boundary edges (unit edges).
 * - Skip edges in `omitEdges` (doors/openings).
 * - Merge contiguous edges with the same orientation + wallRole to reduce instance count.
 *
 * @param {PlanGrid} grid
 * @param {{
 *   wallT:number,
 *   wallH:number,
 *   outerColorHex:number,
 *   innerColorHex:number,
 *   omitEdges?: Set<string>,
 *   classify?: (a:number,b:number,orientation:'v'|'h',edgeWorld:any)=>({ role:string, colorHex:number, kind?:'wall'|'glass_east' })
 * }} opts
 */
export function deriveWallsFromPlan(grid, opts) {
  const wallT = Number(opts?.wallT) || 0.25;
  const wallH = Number(opts?.wallH) || 3.2;
  const outerColorHex = (Number(opts?.outerColorHex) >>> 0) || 0x888888;
  const innerColorHex = (Number(opts?.innerColorHex) >>> 0) || 0x555555;
  const omitEdges = (opts?.omitEdges instanceof Set) ? opts.omitEdges : new Set();
  const classify = (typeof opts?.classify === 'function')
    ? opts.classify
    : ((a, b) => {
      // Default: outer if either side is 0.
      const outer = (a === 0 || b === 0);
      return { role: outer ? 'outer' : 'inner', colorHex: outer ? outerColorHex : innerColorHex, kind: outer ? 'wall' : 'wall' };
    });

  /** @type {{orientation:'v'|'h', role:string, colorHex:number, x0:number, y0:number, x1:number, y1:number}[]} */
  const unitEdges = [];

  const w = grid.width;
  const h = grid.height;

  // Vertical edges at xEdge in 1..w-1 boundaries (and include outer boundaries at xEdge=0 and xEdge=w).
  for (let xEdge = 0; xEdge <= w; xEdge++) {
    for (let yCell = 0; yCell < h; yCell++) {
      const a = grid.get(xEdge - 1, yCell); // west cell (out of bounds -> 0)
      const b = grid.get(xEdge, yCell);     // east cell
      if (a === b) continue;
      if (a === 0 && b === 0) continue;
      const k = edgeKeyV(xEdge, yCell);
      if (omitEdges.has(k)) continue;
      const ew = grid.vEdgeWorld(xEdge, yCell);
      const meta = classify(a, b, 'v', ew);
      if (!meta || meta.skip) continue;
      unitEdges.push({
        orientation: 'v',
        role: String(meta.role || ''),
        colorHex: (Number(meta.colorHex) >>> 0) || innerColorHex,
        x0: ew.x, y0: ew.y0,
        x1: ew.x, y1: ew.y1,
      });
    }
  }

  // Horizontal edges at yEdge in 0..h boundaries.
  for (let yEdge = 0; yEdge <= h; yEdge++) {
    for (let xCell = 0; xCell < w; xCell++) {
      const a = grid.get(xCell, yEdge - 1); // south cell
      const b = grid.get(xCell, yEdge);     // north cell
      if (a === b) continue;
      if (a === 0 && b === 0) continue;
      const k = edgeKeyH(xCell, yEdge);
      if (omitEdges.has(k)) continue;
      const ew = grid.hEdgeWorld(xCell, yEdge);
      const meta = classify(a, b, 'h', ew);
      if (!meta || meta.skip) continue;
      unitEdges.push({
        orientation: 'h',
        role: String(meta.role || ''),
        colorHex: (Number(meta.colorHex) >>> 0) || innerColorHex,
        x0: ew.x0, y0: ew.y,
        x1: ew.x1, y1: ew.y,
      });
    }
  }

  // Merge contiguous unit edges.
  // For vertical edges: merge along y when x is same and x0==x1.
  // For horizontal edges: merge along x when y is same and y0==y1.
  const merged = [];
  const byKey = new Map();
  for (const e of unitEdges) {
    const k = (e.orientation === 'v')
      ? `v:${e.role}:${e.colorHex}:${e.x0.toFixed(6)}`
      : `h:${e.role}:${e.colorHex}:${e.y0.toFixed(6)}`;
    let arr = byKey.get(k);
    if (!arr) { arr = []; byKey.set(k, arr); }
    arr.push(e);
  }

  for (const [k, arr] of byKey.entries()) {
    const o = k[0];
    if (o === 'v') arr.sort((a, b) => (a.y0 - b.y0));
    else arr.sort((a, b) => (a.x0 - b.x0));
    let cur = null;
    for (const e of arr) {
      if (!cur) { cur = { ...e }; continue; }
      const canMerge = (o === 'v')
        ? (Math.abs(cur.x0 - e.x0) < 1e-6 && Math.abs(cur.y1 - e.y0) < 1e-6)
        : (Math.abs(cur.y0 - e.y0) < 1e-6 && Math.abs(cur.x1 - e.x0) < 1e-6);
      if (canMerge) {
        cur.x1 = e.x1;
        cur.y1 = e.y1;
      } else {
        merged.push(cur);
        cur = { ...e };
      }
    }
    if (cur) merged.push(cur);
  }

  // Convert merged segments to instanced wall boxes.
  /** @type {any[]} */
  const instances = [];
  for (let i = 0; i < merged.length; i++) {
    const e = merged[i];
    const alongY = (e.orientation === 'v');
    const len = alongY ? Math.abs(e.y1 - e.y0) : Math.abs(e.x1 - e.x0);
    if (!(len > 1e-6)) continue;
    const cx = alongY ? e.x0 : (e.x0 + e.x1) * 0.5;
    const cy = alongY ? (e.y0 + e.y1) * 0.5 : e.y0;
    const yawDeg = alongY ? 90 : 0;
    const sx = alongY ? wallT : len;
    const sz = alongY ? len : wallT;
    instances.push({
      id: `plan_wall_${i}`,
      kind: 'room_wall',
      pos: [cx, cy, 0],
      yawDeg,
      scale: 1,
      snapToTerrain: false,
      color: undefined,
      meta: { sx, sy: wallH, sz, yOff: wallH * 0.5, role: 'wall', wallRole: e.role, colorHex: e.colorHex >>> 0 },
    });
  }

  return { unitEdges, mergedEdges: merged, instances };
}

/**
 * Validate that each suite region has at least one doorway boundary omitted.
 *
 * @param {PlanGrid} grid
 * @param {Set<string>} omitEdges
 * @param {{suiteRegionMin:number, suiteRegionMax:number, hallRegionIds:number[]}} cfg
 */
export function validatePlanDoors(grid, omitEdges, cfg) {
  const min = Number(cfg?.suiteRegionMin ?? 100);
  const max = Number(cfg?.suiteRegionMax ?? 200);
  const hallIds = Array.isArray(cfg?.hallRegionIds) ? cfg.hallRegionIds.map((x) => Number(x)) : [];
  /** @type {Map<number, number>} */
  const suiteDoorCount = new Map();

  const w = grid.width;
  const h = grid.height;

  // Check omitted edges and count those that separate a suite from a hall region.
  const add = (suiteId) => suiteDoorCount.set(suiteId, (suiteDoorCount.get(suiteId) || 0) + 1);

  // Vertical omitted edges.
  for (let xEdge = 0; xEdge <= w; xEdge++) {
    for (let yCell = 0; yCell < h; yCell++) {
      const k = edgeKeyV(xEdge, yCell);
      if (!omitEdges.has(k)) continue;
      const a = grid.get(xEdge - 1, yCell);
      const b = grid.get(xEdge, yCell);
      const suite = (a >= min && a <= max) ? a : ((b >= min && b <= max) ? b : 0);
      if (!suite) continue;
      const other = (suite === a) ? b : a;
      if (hallIds.includes(other)) add(suite);
    }
  }
  // Horizontal omitted edges.
  for (let yEdge = 0; yEdge <= h; yEdge++) {
    for (let xCell = 0; xCell < w; xCell++) {
      const k = edgeKeyH(xCell, yEdge);
      if (!omitEdges.has(k)) continue;
      const a = grid.get(xCell, yEdge - 1);
      const b = grid.get(xCell, yEdge);
      const suite = (a >= min && a <= max) ? a : ((b >= min && b <= max) ? b : 0);
      if (!suite) continue;
      const other = (suite === a) ? b : a;
      if (hallIds.includes(other)) add(suite);
    }
  }

  // Ensure every suite present in the grid has >=1 door.
  /** @type {Set<number>} */
  const suiteIdsPresent = new Set();
  for (let i = 0; i < grid.cells.length; i++) {
    const v = grid.cells[i] || 0;
    if (v >= min && v <= max) suiteIdsPresent.add(v);
  }
  const missing = [];
  for (const sid of suiteIdsPresent) {
    const n = suiteDoorCount.get(sid) || 0;
    if (n <= 0) missing.push(sid);
  }
  return { ok: missing.length === 0, missingSuites: missing, suiteDoorCount };
}

/**
 * Build an adjacency graph between region ids using omitted edges (doors/openings).
 * Each omitted edge implies traversability between the two regions it separates.
 *
 * @param {PlanGrid} grid
 * @param {Set<string>} omitEdges
 */
export function buildRegionAdjacencyFromOmitEdges(grid, omitEdges) {
  const w = grid.width;
  const h = grid.height;
  /** @type {Map<number, Set<number>>} */
  const adj = new Map();
  const add = (a, b) => {
    if (!a || !b || a === b) return;
    let sa = adj.get(a);
    if (!sa) { sa = new Set(); adj.set(a, sa); }
    sa.add(b);
  };

  // Vertical omitted edges.
  for (let xEdge = 0; xEdge <= w; xEdge++) {
    for (let yCell = 0; yCell < h; yCell++) {
      const k = edgeKeyV(xEdge, yCell);
      if (!omitEdges.has(k)) continue;
      const a = grid.get(xEdge - 1, yCell);
      const b = grid.get(xEdge, yCell);
      if (!a || !b || a === b) continue;
      add(a, b); add(b, a);
    }
  }
  // Horizontal omitted edges.
  for (let yEdge = 0; yEdge <= h; yEdge++) {
    for (let xCell = 0; xCell < w; xCell++) {
      const k = edgeKeyH(xCell, yEdge);
      if (!omitEdges.has(k)) continue;
      const a = grid.get(xCell, yEdge - 1);
      const b = grid.get(xCell, yEdge);
      if (!a || !b || a === b) continue;
      add(a, b); add(b, a);
    }
  }

  return adj;
}

/**
 * Validate that all required regions are reachable from one of the start regions
 * by traversing omitted edges (doors/openings).
 *
 * @param {PlanGrid} grid
 * @param {Set<string>} omitEdges
 * @param {{ startRegionIds:number[], requiredRegionIds:number[] }} cfg
 */
export function validatePlanConnectivity(grid, omitEdges, cfg) {
  const starts = Array.isArray(cfg?.startRegionIds) ? cfg.startRegionIds.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0) : [];
  const required = Array.isArray(cfg?.requiredRegionIds) ? cfg.requiredRegionIds.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0) : [];
  const adj = buildRegionAdjacencyFromOmitEdges(grid, omitEdges);

  /** @type {Set<number>} */
  const seen = new Set();
  /** @type {number[]} */
  const q = [];
  for (const s of starts) { seen.add(s); q.push(s); }
  while (q.length) {
    const cur = q.shift();
    const nbs = adj.get(cur);
    if (!nbs) continue;
    for (const nb of nbs) {
      if (seen.has(nb)) continue;
      seen.add(nb);
      q.push(nb);
    }
  }

  const unreachable = [];
  for (const r of required) if (!seen.has(r)) unreachable.push(r);
  unreachable.sort((a, b) => a - b);

  return {
    ok: unreachable.length === 0,
    unreachable,
    startRegionIds: starts,
    requiredCount: required.length,
    reachedCount: seen.size,
    adjacencyNodes: adj.size,
  };
}

