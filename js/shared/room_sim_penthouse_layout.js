/**
 * Shared penthouse "room sim" layout generator.
 *
 * Coordinate convention:
 * - data-space ground plane is (x, y)
 * - vertical is z (up)
 *
 * Returns:
 * - bounds: {minX,maxX,minY,maxY,minZ,maxZ}
 * - instances: InstancedBox-style records for runtime (`EditorApp`).
 * - parts: Simple box parts for devtools procedural building rebuild.
 */

import { PlanGrid, edgeKeyV, deriveWallsFromPlan, validatePlanDoors, validatePlanConnectivity } from './plan_grid.js';

function fnum(x, d) {
  const n = Number(x);
  if (!Number.isFinite(n)) return d;
  return n;
}

function clampNum(x, lo, hi, d) {
  const n = fnum(x, d);
  return Math.max(lo, Math.min(hi, n));
}

function asRgba01(hex, a = 1) {
  const h = (Number(hex) >>> 0);
  const r = ((h >> 16) & 255) / 255;
  const g = ((h >> 8) & 255) / 255;
  const b = (h & 255) / 255;
  return [r, g, b, clampNum(a, 0, 1, 1)];
}

function addBoxPart(out, p) {
  out.push({
    id: String(p.id || ''),
    kind: String(p.kind || 'box'),
    x: fnum(p.x, 0),
    y: fnum(p.y, 0),
    z: fnum(p.z, 0),
    sx: Math.max(0.01, fnum(p.sx, 1)),
    sy: Math.max(0.01, fnum(p.sy, 1)),
    sz: Math.max(0.01, fnum(p.sz, 1)),
    yawDeg: fnum(p.yawDeg, 0),
    colorHex: Number.isFinite(Number(p.colorHex)) ? (Number(p.colorHex) >>> 0) : 0xffffff,
    alpha: clampNum(p.alpha, 0, 1, 1),
    meta: (p.meta && typeof p.meta === 'object') ? p.meta : {},
  });
}

function addInst(out, it) {
  out.push({
    id: String(it.id || ''),
    kind: String(it.kind || 'room_part'),
    pos: [fnum(it.x, 0), fnum(it.y, 0), fnum(it.z, 0)],
    yawDeg: fnum(it.yawDeg, 0),
    scale: fnum(it.scale, 1) || 1,
    snapToTerrain: it.snapToTerrain === false ? false : false,
    color: Array.isArray(it.color) ? it.color : undefined,
    meta: (it.meta && typeof it.meta === 'object') ? it.meta : {},
  });
}

/**
 * Generate a penthouse layout with 25 bedrooms + 25 workstations.
 * The result is intentionally parametric so the Buildings tool can tweak it.
 */
export function buildRoomSimPenthouseLayout(params = {}) {
  const rows = Math.max(1, Math.min(12, Math.floor(fnum(params.rows, 5))));
  const cols = Math.max(1, Math.min(12, Math.floor(fnum(params.cols, 5))));
  const deskRows = Math.max(1, Math.min(12, Math.floor(fnum(params.deskRows, rows))));
  const deskCols = Math.max(1, Math.min(12, Math.floor(fnum(params.deskCols, cols))));

  const roomW = clampNum(params.roomW, 3.2, 18.0, 6.0);
  const roomD = clampNum(params.roomD, 3.2, 18.0, 6.0);
  // Internal corridor width inside the bedroom wing.
  const suiteHallW = clampNum(params.suiteHallW, 1.8, 7.0, 2.8);
  const corridorD = clampNum(params.corridorD, 2.2, 6.0, 3.2);
  const hallW = clampNum(params.hallW, 18.0, 120.0, 46.0);

  const wallT = clampNum(params.wallT, 0.12, 0.8, 0.25);
  const wallH = clampNum(params.wallH, 2.2, 5.0, 3.1);
  const doorW = clampNum(params.doorW, 0.75, 1.8, 0.95);
  const hallDoorW = clampNum(params.hallDoorW, 2.0, 8.0, 4.5);

  const deskPadX = clampNum(params.deskPadX, 2.4, 8.0, 4.0);
  const deskPadY = clampNum(params.deskPadY, 2.4, 8.0, 3.6);

  // Bedroom wing is a hotel-like grid: suites are separated by hallways so all 25 are reachable
  // without walking through another suite.
  const bedWingW = (cols * roomW) + ((cols + 1) * suiteHallW);
  const bedWingD = (rows * roomD) + ((rows + 1) * suiteHallW);
  const totalW = bedWingW + corridorD + hallW + wallT * 2;
  const totalD = bedWingD + wallT * 2;

  // Centered around origin for simplicity.
  const minX = -totalW * 0.5;
  const maxX = totalW * 0.5;
  const minY = -totalD * 0.5;
  const maxY = totalD * 0.5;

  const wingLeftX = minX + wallT;
  const wingRightX = wingLeftX + bedWingW;
  const corridorLeftX = wingRightX;
  const corridorRightX = corridorLeftX + corridorD;
  const hallLeftX = corridorRightX;
  const hallRightX = maxX - wallT;

  const parts = [];
  const instances = [];

  // Structured artifacts (filled later if plan-grid pass runs).
  /** @type {any|null} */
  let planOut = null;
  /** @type {string[]|null} */
  let planOmitEdgesOut = null;
  /** @type {any|null} */
  let planValidationOut = null;
  /** @type {any|null} */
  let planDerivedStatsOut = null;

  // Palette (luxury + warmer highlights).
  const colFloor = 0x121827; // deep stone
  const colOuter = 0x8a97aa;
  const colInner = 0x5d697a;
  const colBed = 0x7a5c55;
  const colDesk = 0x3b4658;
  const colChair = 0x2b2f3a;
  const colPc = 0x0f1720;
  const colSpawn = 0x5bda8a;

  const SUITE_THEMES = [
    { name: 'music_studio', accent: 0x9b5de5 },
    { name: 'gaming_den', accent: 0xf15bb5 },
    { name: 'artist_loft', accent: 0xfee440 },
    { name: 'athlete_recovery', accent: 0x00bbf9 },
    { name: 'botanist_sunroom', accent: 0x00f5d4 },
    { name: 'library_study', accent: 0x8ecae6 },
    { name: 'chef_test_kitchen', accent: 0xffb703 },
    { name: 'film_editor', accent: 0xadb5bd },
    { name: 'astronomy_nook', accent: 0x7f7eff },
    { name: 'fashion_atelier', accent: 0xff5c8a },
    { name: 'photography_lab', accent: 0xa3a3a3 },
    { name: 'maker_workbench', accent: 0xf77f00 },
    { name: 'zen_meditation', accent: 0x90be6d },
    { name: 'collector_gallery', accent: 0x6c757d },
    { name: 'dj_booth', accent: 0x48cae4 },
    { name: 'strategy_war_room', accent: 0x3a86ff },
    { name: 'writer_den', accent: 0x5e548e },
    { name: 'comic_studio', accent: 0xff006e },
    { name: 'science_bench', accent: 0x2ec4b6 },
    { name: 'spa_suite', accent: 0x52b788 },
    { name: 'streetwear_lab', accent: 0xffd166 },
    { name: 'puzzle_arcade', accent: 0x06d6a0 },
    { name: 'language_lounge', accent: 0x118ab2 },
    { name: 'travel_map_room', accent: 0xef476f },
    { name: 'minimalist_mono', accent: 0xe9ecef },
  ];

  const hash01 = (i) => {
    // Tiny deterministic hash -> [0,1).
    const x = Math.sin((Number(i) || 0) * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  };

  const addWall = ({ id, x, y, len, along = 'x', doorAt = null, doorWidth = 1.0, colorHex = colOuter }) => {
    // along === 'x': wall spans X, thickness in Y
    // along === 'y': wall spans Y, thickness in X
    const thick = wallT;
    const h = wallH;

    // `doorAt` is optional; allow 0 (centered door), but treat null/undefined as "no door".
    const hasDoor = (doorAt !== null && doorAt !== undefined && Number.isFinite(Number(doorAt)));
    if (!hasDoor) {
      const sx = (along === 'x') ? len : thick;
      const sz = (along === 'x') ? thick : len;
      addBoxPart(parts, { id, kind: 'wall', x, y, z: 0, sx, sy: h, sz, yawDeg: 0, colorHex });
      addInst(instances, {
        id,
        kind: 'room_wall',
        x, y, z: 0,
        // We encode orientation via (sx, sz); yaw is unnecessary and was causing 90° glitches.
        yawDeg: 0,
        meta: { sx, sy: h, sz, yOff: h * 0.5, role: 'wall' },
        color: asRgba01(colorHex, 1),
      });
      return;
    }

    // Doorway: split into two segments.
    const dw = Math.max(0.6, doorWidth);
    const halfLen = len * 0.5;
    const d0 = Math.max(-halfLen + 0.2, Math.min(halfLen - 0.2, doorAt));
    const leftLen = Math.max(0, (d0 - dw * 0.5) + halfLen);
    const rightLen = Math.max(0, halfLen - (d0 + dw * 0.5));

    const placeSeg = (segId, segCenterOffset, segLen) => {
      if (segLen < 0.18) return;
      const sx = (along === 'x') ? segLen : thick;
      const sz = (along === 'x') ? thick : segLen;
      const cx = (along === 'x') ? (x + segCenterOffset) : x;
      const cy = (along === 'x') ? y : (y + segCenterOffset);
      addBoxPart(parts, { id: segId, kind: 'wall', x: cx, y: cy, z: 0, sx, sy: h, sz, yawDeg: 0, colorHex });
      addInst(instances, {
        id: segId,
        kind: 'room_wall',
        x: cx, y: cy, z: 0,
        yawDeg: 0,
        meta: { sx, sy: h, sz, yOff: h * 0.5, role: 'wall' },
        color: asRgba01(colorHex, 1),
      });
    };

    // Left segment center offset.
    const leftCenter = -halfLen + leftLen * 0.5;
    const rightCenter = halfLen - rightLen * 0.5;
    placeSeg(`${id}_L`, leftCenter, leftLen);
    placeSeg(`${id}_R`, rightCenter, rightLen);
  };

  // Floor slab (slightly thick for nicer silhouettes).
  addBoxPart(parts, { id: 'floor', kind: 'floor', x: 0, y: 0, z: -0.08, sx: totalW, sy: 0.16, sz: totalD, yawDeg: 0, colorHex: colFloor });
  addInst(instances, {
    id: 'floor',
    kind: 'room_floor',
    x: 0, y: 0, z: -0.08,
    yawDeg: 0,
    meta: { sx: totalW, sy: 0.16, sz: totalD, yOff: 0.08, role: 'floor' },
    color: asRgba01(colFloor, 1),
  });

  // Outer walls.
  addWall({ id: 'wall_n', x: 0, y: maxY - wallT * 0.5, len: totalW, along: 'x', colorHex: colOuter });
  addWall({ id: 'wall_s', x: 0, y: minY + wallT * 0.5, len: totalW, along: 'x', colorHex: colOuter });
  addWall({ id: 'wall_w', x: minX + wallT * 0.5, y: 0, len: totalD, along: 'y', colorHex: colOuter });

  // East wall is the "city view" facade: parapet + full-height glass.
  // This reads like a top-floor skyscraper penthouse.
  {
    const x = maxX - wallT * 0.5;
    const len = totalD;
    const parapetH = Math.max(0.9, Math.min(1.25, wallH * 0.35));
    const glassH = Math.max(1.1, wallH - parapetH);

    // Parapet (solid).
    addBoxPart(parts, { id: 'wall_e_parapet', kind: 'wall', x, y: 0, z: 0, sx: wallT, sy: parapetH, sz: len, yawDeg: 0, colorHex: colOuter, meta: { role: 'parapet' } });
    addInst(instances, { id: 'wall_e_parapet', kind: 'room_wall', x, y: 0, z: 0, yawDeg: 0, meta: { sx: wallT, sy: parapetH, sz: len, yOff: parapetH * 0.5, role: 'wall', wallRole: 'parapet' }, color: asRgba01(colOuter, 1) });

    // Glass above (transparent).
    const glassCol = 0x9fb7d8;
    addBoxPart(parts, { id: 'wall_e_glass', kind: 'window_wall', x, y: 0, z: parapetH, sx: wallT, sy: glassH, sz: len, yawDeg: 0, colorHex: glassCol, alpha: 0.22, meta: { role: 'glass' } });
    addInst(instances, { id: 'wall_e_glass', kind: 'room_window', x, y: 0, z: parapetH, yawDeg: 0, meta: { sx: wallT, sy: glassH, sz: len, yOff: parapetH + glassH * 0.5, role: 'window' }, color: asRgba01(glassCol, 0.22) });

    // Mullions (frames) to break up the plane.
    const frameCol = 0x465363;
    const mullionW = Math.max(0.05, wallT * 0.22);
    const mullionEvery = 4.2;
    const count = Math.max(2, Math.floor(len / mullionEvery));
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const yy = (-len * 0.5) + t * len;
      addBoxPart(parts, { id: `wall_e_mull_${i}`, kind: 'window_frame', x: x - wallT * 0.18, y: yy, z: parapetH, sx: mullionW, sy: glassH, sz: wallT * 0.9, yawDeg: 0, colorHex: frameCol, meta: { role: 'window_frame' } });
    }
  }

  // ----------------------------
  // Blueprint-first layout pass.
  // ----------------------------
  // We compute suite rectangles + hallway centerlines first, then derive walls/doors from that blueprint,
  // then decorate/furnish. This keeps the structure deterministic and prevents drift.
  const wingMinY = minY + wallT;
  /** @type {number[]} */
  const wingHallY = [];
  for (let k = 0; k <= rows; k++) {
    wingHallY.push(wingMinY + suiteHallW * 0.5 + k * (roomD + suiteHallW));
  }
  /** @type {{ agentIdx:number, r:number, c:number, rid:string, x0:number, x1:number, y0:number, y1:number, cx:number, cy:number }[]} */
  const suites = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const agentIdx = r * cols + c;
      const x0 = wingLeftX + suiteHallW + c * (roomW + suiteHallW);
      const x1 = x0 + roomW;
      const y0 = minY + wallT + suiteHallW + r * (roomD + suiteHallW);
      const y1 = y0 + roomD;
      suites.push({
        agentIdx,
        r, c,
        rid: `bedroom_${r}_${c}`,
        x0, x1, y0, y1,
        cx: (x0 + x1) * 0.5,
        cy: (y0 + y1) * 0.5,
      });
    }
  }

  // Plan-grid driven structure:
  // - Regions: wing_hallway, corridor, hall, suites.
  // - Doors/openings: omit wall edges at those boundaries.
  {
    // Plan-grid resolution: 0.5m gives a good balance of fidelity and size.
    // (Using 1.0m caused noticeable quantization drift for non-integer widths like corridorD=4.2.)
    const cellSize = 0.5;
    const interiorW = (bedWingW + corridorD + hallW);
    const interiorD = bedWingD;
    const gridW = Math.max(6, Math.ceil(interiorW / cellSize));
    const gridH = Math.max(6, Math.ceil(interiorD / cellSize));
    const originX = wingLeftX;
    const originY = minY + wallT;

    const REG_WING_HALL = 1;
    const REG_CORRIDOR = 2;
    const REG_HALL = 3;
    const SUITE_BASE = 100;

    const plan = new PlanGrid({ width: gridW, height: gridH, cellSize, originX, originY });

    // Boundary indices: use rounding to keep metric->cell mapping stable and symmetric.
    const toEdgeX = (x) => Math.max(0, Math.min(plan.width, Math.round((x - originX) / cellSize)));
    const toEdgeY = (y) => Math.max(0, Math.min(plan.height, Math.round((y - originY) / cellSize)));
    const toCellY = (y) => Math.max(0, Math.min(plan.height - 1, Math.floor((y - originY) / cellSize)));

    // Fill main regions.
    plan.setRect(toEdgeX(wingLeftX), toEdgeY(minY + wallT), toEdgeX(wingRightX), toEdgeY(maxY - wallT), REG_WING_HALL);
    plan.setRect(toEdgeX(corridorLeftX), toEdgeY(minY + wallT), toEdgeX(corridorRightX), toEdgeY(maxY - wallT), REG_CORRIDOR);
    plan.setRect(toEdgeX(hallLeftX), toEdgeY(minY + wallT), toEdgeX(hallRightX), toEdgeY(maxY - wallT), REG_HALL);

    // Suites overwrite wing hall region.
    for (const s of suites) {
      const sid = SUITE_BASE + s.agentIdx;
      plan.setRect(
        toEdgeX(s.x0), toEdgeY(s.y0),
        toEdgeX(s.x1), toEdgeY(s.y1),
        sid,
      );
    }

    // Door/opening edges: omit these edges from wall derivation.
    const omit = new Set();
    // Suite doors (one per suite): east wall midpoint opens to wing hallway.
    for (const s of suites) {
      const sid = SUITE_BASE + s.agentIdx;
      void sid; // sid is implicit; we validate via region ids + omitted edges.
      const xEdge = toEdgeX(s.x1);
      const yCell = toCellY(s.cy);
      // Door clearance: omit multiple edge-cells so the gap is actually walkable.
      // (With cellSize=0.5, omitting only 1 cell creates a 0.5m slit.)
      const doorClearW = Math.max(1.35, doorW * 1.35);
      const openCells = Math.max(3, Math.round(doorClearW / cellSize));
      const half = Math.max(1, Math.floor(openCells * 0.5));
      for (let dy = -half; dy <= half; dy++) omit.add(edgeKeyV(xEdge, yCell + dy));
    }

    // Openings from wing hallways into corridor (spine wall).
    {
      const xEdge = toEdgeX(corridorLeftX);
      const openCells = Math.max(1, Math.round(suiteHallW / cellSize));
      const half = Math.max(0, Math.floor(openCells * 0.5));
      for (const yHall of wingHallY) {
        const yc = toCellY(yHall);
        for (let dy = -half; dy <= half; dy++) omit.add(edgeKeyV(xEdge, yc + dy));
      }
      // Big central lobby opening.
      {
        const yc = toCellY(0);
        const big = Math.max(openCells, Math.round((suiteHallW * 1.6) / cellSize));
        const hh = Math.floor(big * 0.5);
        for (let dy = -hh; dy <= hh; dy++) omit.add(edgeKeyV(xEdge, yc + dy));
      }
    }

    // Corridor ↔ hall opening (grand doorway) centered at y=0.
    {
      const xEdge = toEdgeX(hallLeftX);
      const openCells = Math.max(2, Math.round(hallDoorW / cellSize));
      const half = Math.max(1, Math.floor(openCells * 0.5));
      const yc = toCellY(0);
      for (let dy = -half; dy <= half; dy++) omit.add(edgeKeyV(xEdge, yc + dy));
    }

    // Validate: every suite must have at least one omitted edge into wing hallway.
    const vDoors = validatePlanDoors(plan, omit, {
      suiteRegionMin: SUITE_BASE,
      suiteRegionMax: SUITE_BASE + (rows * cols) - 1,
      hallRegionIds: [REG_WING_HALL],
    });
    // Validate: suites are reachable from the hall via openings.
    const suiteRegionIds = [];
    for (let i = 0; i < rows * cols; i++) suiteRegionIds.push(SUITE_BASE + i);
    const vConn = validatePlanConnectivity(plan, omit, {
      startRegionIds: [REG_HALL],
      requiredRegionIds: suiteRegionIds,
    });
    // If validation fails, we still generate walls (debug), but we tag the layout.
    const planValidation = { doors: vDoors, connectivity: vConn };

    // Derive interior walls (skip outer boundary; outer envelope is authored separately above).
    const derived = deriveWallsFromPlan(plan, {
      wallT,
      wallH,
      outerColorHex: colOuter,
      innerColorHex: colInner,
      omitEdges: omit,
      classify: (a, b, orientation, edgeWorld) => {
        void orientation; void edgeWorld;
        const outer = (a === 0 || b === 0);
        if (outer) return { skip: true };
        const hi = Math.max(a, b);
        const lo = Math.min(a, b);
        const isSuite = (x) => x >= SUITE_BASE && x < (SUITE_BASE + rows * cols);
        if (isSuite(hi) && lo === REG_WING_HALL) return { role: 'suite_wall', colorHex: colInner };
        if ((hi === REG_CORRIDOR && lo === REG_WING_HALL) || (hi === REG_WING_HALL && lo === REG_CORRIDOR)) return { role: 'spine_wall', colorHex: colInner };
        if ((hi === REG_HALL && lo === REG_CORRIDOR) || (hi === REG_CORRIDOR && lo === REG_HALL)) return { role: 'corridor_wall', colorHex: colInner };
        return { role: 'inner', colorHex: colInner };
      },
    });

    // Add derived wall segments to instances + parts.
    for (let i = 0; i < derived.mergedEdges.length; i++) {
      const e = derived.mergedEdges[i];
      const alongY = (e.orientation === 'v');
      const len = alongY ? Math.abs(e.y1 - e.y0) : Math.abs(e.x1 - e.x0);
      if (!(len > 1e-6)) continue;
      const cx = alongY ? e.x0 : (e.x0 + e.x1) * 0.5;
      const cy = alongY ? (e.y0 + e.y1) * 0.5 : e.y0;
      // Like `addWall`, we encode orientation via (sx, sz).
      const yawDeg = 0;
      const sx = alongY ? wallT : len;
      const sz = alongY ? len : wallT;
      const id = `plan_wall_${i}`;
      addBoxPart(parts, { id, kind: 'wall', x: cx, y: cy, z: 0, sx, sy: wallH, sz, yawDeg, colorHex: e.colorHex, meta: { role: 'wall', wallRole: e.role } });
      addInst(instances, { id, kind: 'room_wall', x: cx, y: cy, z: 0, yawDeg, meta: { sx, sy: wallH, sz, yOff: wallH * 0.5, role: 'wall', wallRole: e.role }, color: asRgba01(e.colorHex, 1) });
    }

    // Expose plan + validation to callers/devtools.
    // (Editor runtime ignores this, but it’s crucial for a solid authoring workflow.)
    planOut = plan;
    planOmitEdgesOut = Array.from(omit);
    planValidationOut = planValidation;
    planDerivedStatsOut = { unitEdges: derived.unitEdges.length, mergedEdges: derived.mergedEdges.length };
  }

  // Bedroom wing: corridor grid + fully enclosed suites (each with its own hallway door).
  // Hallways are simply the empty spaces between the suite walls; we only need to author walls/doors.
  for (const s of suites) {
    const { agentIdx, rid, x0, x1, y0, y1, cx, cy } = s;

      // Suite interior: bathroom + closet + bedroom furnishings.
      // Keep the corridor-side (east) more "service-y" and the west side more "rest" oriented.
      {
        const innerT = Math.max(0.10, wallT * 0.72);
        const bathW = clampNum(params.bathW, 2.0, Math.max(2.6, roomW * 0.55), Math.min(3.4, roomW * 0.40));
        const bathD = clampNum(params.bathD, 2.0, Math.max(2.6, roomD * 0.55), Math.min(3.4, roomD * 0.40));
        const closW = clampNum(params.closW, 1.8, Math.max(2.4, roomW * 0.55), Math.min(3.0, roomW * 0.36));
        const closD = clampNum(params.closD, 2.0, Math.max(2.6, roomD * 0.55), Math.min(3.2, roomD * 0.38));
        const colSuiteWall = colInner;
        const colBath = 0x3a475c;
        const colClos = 0x4b5566;
        const colTv = 0x0b1018;

        // Variation: swap bath/closet placement per suite so the wing doesn't feel copy/pasted.
        // Pattern index 0..3:
        // 0: bath NE, closet SE (default)
        // 1: bath SE, closet NE
        // 2: bath NE, closet centered east (longer), closet becomes "vanity" south
        // 3: bath north-east but pulled inward, closet south-east pulled inward
        const pat = agentIdx % 4;

        const addBath = (bx0, by0, bx1, by1) => {
          addBoxPart(parts, { id: `suite_${rid}_bath_wall_x`, kind: 'wall_interior', x: bx0, y: (by0 + by1) * 0.5, z: 0, sx: innerT, sy: wallH, sz: (by1 - by0), yawDeg: 90, colorHex: colSuiteWall, meta: { role: 'bath_wall', bedroomId: rid, agentIdx } });
          addBoxPart(parts, { id: `suite_${rid}_bath_wall_y`, kind: 'wall_interior', x: (bx0 + bx1) * 0.5, y: by1, z: 0, sx: (bx1 - bx0), sy: wallH, sz: innerT, yawDeg: 0, colorHex: colSuiteWall, meta: { role: 'bath_wall', bedroomId: rid, agentIdx } });
          // Fixtures.
          addBoxPart(parts, { id: `suite_${rid}_shower`, kind: 'shower', x: (bx0 + bx1) * 0.5, y: by0 + (by1 - by0) * 0.65, z: 0, sx: Math.max(1.2, (bx1 - bx0) * 0.82), sy: 2.2, sz: Math.max(1.1, (by1 - by0) * 0.62), yawDeg: 0, colorHex: colBath, alpha: 0.18, meta: { role: 'bath_fixture', bedroomId: rid, agentIdx } });
          addBoxPart(parts, { id: `suite_${rid}_toilet`, kind: 'toilet', x: bx1 - (bx1 - bx0) * 0.25, y: by0 + (by1 - by0) * 0.22, z: 0, sx: 0.40, sy: 0.52, sz: 0.66, yawDeg: 0, colorHex: 0xe6eef8, meta: { role: 'bath_fixture', bedroomId: rid, agentIdx } });
          addBoxPart(parts, { id: `suite_${rid}_sink`, kind: 'sink', x: bx0 + (bx1 - bx0) * 0.25, y: by0 + (by1 - by0) * 0.20, z: 0, sx: 0.68, sy: 0.95, sz: 0.42, yawDeg: 0, colorHex: 0xd9e2f0, meta: { role: 'bath_fixture', bedroomId: rid, agentIdx } });
        };
        const addCloset = (cx0, cy0, cx1, cy1) => {
          addBoxPart(parts, { id: `suite_${rid}_clos_wall_x`, kind: 'wall_interior', x: cx0, y: (cy0 + cy1) * 0.5, z: 0, sx: innerT, sy: wallH, sz: (cy1 - cy0), yawDeg: 90, colorHex: colSuiteWall, meta: { role: 'closet_wall', bedroomId: rid, agentIdx } });
          addBoxPart(parts, { id: `suite_${rid}_clos_wall_y`, kind: 'wall_interior', x: (cx0 + cx1) * 0.5, y: cy0, z: 0, sx: (cx1 - cx0), sy: wallH, sz: innerT, yawDeg: 0, colorHex: colSuiteWall, meta: { role: 'closet_wall', bedroomId: rid, agentIdx } });
          addBoxPart(parts, { id: `suite_${rid}_wardrobe`, kind: 'wardrobe', x: cx0 + (cx1 - cx0) * 0.55, y: cy0 + (cy1 - cy0) * 0.55, z: 0, sx: Math.max(1.4, (cx1 - cx0) * 0.82), sy: 2.25, sz: 0.60, yawDeg: 90, colorHex: colClos, meta: { role: 'closet_storage', bedroomId: rid, agentIdx } });
        };

        if (pat === 0) {
          // Bath NE, closet SE.
          addBath(x1 - bathW, y0, x1, y0 + bathD);
          addCloset(x1 - closW, y1 - closD, x1, y1);
        } else if (pat === 1) {
          // Bath SE, closet NE.
          addBath(x1 - bathW, y1 - bathD, x1, y1);
          addCloset(x1 - closW, y0, x1, y0 + closD);
        } else if (pat === 2) {
          // Longer bath along east wall (spa-ish), closet becomes a vanity nook.
          const longBathD = Math.min(roomD * 0.62, bathD * 1.55);
          addBath(x1 - bathW, y0, x1, y0 + longBathD);
          const vx0 = x1 - Math.max(closW, 2.2);
          const vy1 = y1;
          const vy0 = y1 - Math.max(closD * 0.75, 1.9);
          addBoxPart(parts, { id: `suite_${rid}_vanity_wall_x`, kind: 'wall_interior', x: vx0, y: (vy0 + vy1) * 0.5, z: 0, sx: innerT, sy: wallH, sz: (vy1 - vy0), yawDeg: 90, colorHex: colSuiteWall, meta: { role: 'vanity_wall', bedroomId: rid, agentIdx } });
          addBoxPart(parts, { id: `suite_${rid}_vanity`, kind: 'vanity', x: vx0 + 0.55, y: vy0 + 0.65, z: 0, sx: 1.25, sy: 0.92, sz: 0.55, yawDeg: 0, colorHex: 0x2b3341, meta: { role: 'vanity', bedroomId: rid, agentIdx } });
          addBoxPart(parts, { id: `suite_${rid}_vanity_mirror`, kind: 'mirror', x: vx0 + 0.30, y: vy0 + 0.65, z: 1.35, sx: 0.05, sy: 0.70, sz: 0.55, yawDeg: 90, colorHex: 0x9fb7d8, alpha: 0.18, meta: { role: 'mirror', bedroomId: rid, agentIdx } });
        } else {
          // Pull both rooms inward to create a small corridor-side "entry alcove".
          const inset = Math.max(0.45, Math.min(0.85, roomW * 0.05));
          addBath(x1 - bathW - inset, y0, x1 - inset, y0 + bathD);
          addCloset(x1 - closW - inset, y1 - closD, x1 - inset, y1);
        }

        // TV + console on west wall (faces the bed).
        addBoxPart(parts, { id: `suite_${rid}_tv`, kind: 'tv', x: x0 + 0.25, y: cy, z: 1.25, sx: 0.08, sy: 0.72, sz: 1.25, yawDeg: 90, colorHex: colTv, meta: { role: 'tv', bedroomId: rid, agentIdx } });
        addBoxPart(parts, { id: `suite_${rid}_tv_console`, kind: 'tv_console', x: x0 + 0.40, y: cy, z: 0, sx: 0.55, sy: 0.55, sz: 1.15, yawDeg: 90, colorHex: 0x2b3341, meta: { role: 'tv_console', bedroomId: rid, agentIdx } });
        // Runtime instances (interactable): TV body + screen.
        addInst(instances, {
          id: `suite_${rid}_tv`,
          kind: 'room_tv',
          x: x0 + 0.25, y: cy, z: 1.25,
          yawDeg: 90,
          meta: { sx: 0.08, sy: 0.72, sz: 1.25, yOff: 0.0, role: 'tv', bedroomId: rid, agentIdx, interactRadius: 2.2 },
          color: asRgba01(colTv, 1),
        });
        // Slightly in front of the TV so it reads as a lit panel when "on".
        addInst(instances, {
          id: `suite_${rid}_tv_screen`,
          kind: 'room_tv_screen',
          x: x0 + 0.32, y: cy, z: 1.25,
          yawDeg: 90,
          meta: { sx: 0.03, sy: 0.62, sz: 1.10, yOff: 0.0, role: 'tv_screen', bedroomId: rid, agentIdx },
          color: asRgba01(0x0f1218, 1),
        });
      }

      // Bed (upgraded placement).
      addBoxPart(parts, {
        id: `bed_${agentIdx}`,
        kind: 'bed',
        x: cx - roomW * 0.12, y: cy, z: 0,
        sx: 2.18, sy: 0.62, sz: 1.06,
        yawDeg: 90, // faces west-wall TV
        colorHex: colBed,
        meta: { role: 'bed', bedroomId: rid, agentIdx },
      });
      addInst(instances, {
        id: `bed_${agentIdx}`,
        kind: 'room_bed',
        x: cx - roomW * 0.12, y: cy, z: 0,
        yawDeg: 90,
        meta: { sx: 2.18, sy: 0.62, sz: 1.06, yOff: 0.31, bedroomId: rid, agentIdx, role: 'bed', interactRadius: 2.0 },
        color: asRgba01(colBed, 1),
      });

      // Nightstands (two) + dresser for a more "home" feel.
      addBoxPart(parts, { id: `suite_${rid}_night_a`, kind: 'nightstand', x: cx - roomW * 0.12, y: cy - 0.95, z: 0, sx: 0.45, sy: 0.48, sz: 0.45, yawDeg: 0, colorHex: 0x2a2f3a, meta: { role: 'nightstand', bedroomId: rid, agentIdx } });
      addBoxPart(parts, { id: `suite_${rid}_night_b`, kind: 'nightstand', x: cx - roomW * 0.12, y: cy + 0.95, z: 0, sx: 0.45, sy: 0.48, sz: 0.45, yawDeg: 0, colorHex: 0x2a2f3a, meta: { role: 'nightstand', bedroomId: rid, agentIdx } });
      addBoxPart(parts, { id: `suite_${rid}_dresser`, kind: 'dresser', x: cx + roomW * 0.18, y: cy - roomD * 0.22, z: 0, sx: 1.25, sy: 0.92, sz: 0.55, yawDeg: 0, colorHex: 0x343d4c, meta: { role: 'dresser', bedroomId: rid, agentIdx } });

      // Make each suite feel "lived in": rug + lounge + personal desk + decor.
      {
        const theme = SUITE_THEMES[agentIdx % SUITE_THEMES.length];
        const accent = Number(theme?.accent) >>> 0;
        const t0 = hash01(agentIdx * 3.1);
        const t1 = hash01(agentIdx * 7.7);

        // Rug (accented).
        addBoxPart(parts, {
          id: `suite_${rid}_rug`,
          kind: 'rug',
          x: cx - roomW * 0.10, y: cy, z: -0.01,
          sx: Math.max(4.4, roomW * 0.72),
          sy: 0.02,
          sz: Math.max(3.8, roomD * 0.62),
          yawDeg: (t0 < 0.5) ? 0 : 90,
          colorHex: (accent & 0xffffff),
          alpha: 1,
          meta: { role: 'suite_rug', bedroomId: rid, agentIdx, suiteTheme: theme?.name || '' },
        });

        // Lounge corner (sofa + chair + coffee table) near the window/TV side.
        const loungeX = x0 + Math.max(2.1, roomW * 0.28);
        const loungeY = cy + (t0 - 0.5) * Math.max(0.8, roomD * 0.12);
        addBoxPart(parts, { id: `suite_${rid}_sofa`, kind: 'sofa', x: loungeX, y: loungeY, z: 0, sx: 2.8, sy: 0.95, sz: 1.05, yawDeg: 90, colorHex: 0x2f4059, meta: { role: 'suite_sofa', bedroomId: rid, agentIdx, suiteTheme: theme?.name || '' } });
        addBoxPart(parts, { id: `suite_${rid}_chair`, kind: 'chair', x: loungeX + 1.4, y: loungeY + 1.2, z: 0, sx: 0.70, sy: 0.95, sz: 0.70, yawDeg: 135, colorHex: 0x273044, meta: { role: 'suite_chair', bedroomId: rid, agentIdx, suiteTheme: theme?.name || '' } });
        addBoxPart(parts, { id: `suite_${rid}_coffee`, kind: 'coffee_table', x: loungeX + 0.7, y: loungeY + 0.05, z: 0, sx: 1.2, sy: 0.42, sz: 0.70, yawDeg: 90, colorHex: 0x231f2a, meta: { role: 'suite_table', bedroomId: rid, agentIdx, suiteTheme: theme?.name || '' } });
        // Runtime instance: lounge chair (interactable).
        addInst(instances, {
          id: `suite_${rid}_chair`,
          kind: 'room_chair',
          x: loungeX + 1.4, y: loungeY + 1.2, z: 0,
          yawDeg: 135,
          meta: { sx: 0.70, sy: 0.95, sz: 0.70, yOff: 0.475, bedroomId: rid, agentIdx, role: 'chair', suiteTheme: theme?.name || '', interactRadius: 1.6 },
          color: asRgba01(0x273044, 1),
        });

        // Personal desk (different from cowork): tucked away opposite lounge.
        const deskX = x0 + roomW * 0.55;
        const deskY = y0 + roomD * (0.22 + 0.50 * t1);
        addBoxPart(parts, { id: `suite_${rid}_personal_desk`, kind: 'desk', x: deskX, y: deskY, z: 0, sx: 1.65, sy: 0.78, sz: 0.82, yawDeg: 180, colorHex: colDesk, meta: { role: 'suite_desk', bedroomId: rid, agentIdx, suiteTheme: theme?.name || '' } });
        addBoxPart(parts, { id: `suite_${rid}_personal_chair`, kind: 'chair', x: deskX + 0.95, y: deskY, z: 0, sx: 0.55, sy: 0.95, sz: 0.55, yawDeg: 0, colorHex: colChair, meta: { role: 'suite_desk_chair', bedroomId: rid, agentIdx, suiteTheme: theme?.name || '' } });
        // Runtime instance: personal chair (interactable).
        addInst(instances, {
          id: `suite_${rid}_personal_chair`,
          kind: 'room_chair',
          x: deskX + 0.95, y: deskY, z: 0,
          yawDeg: 0,
          meta: { sx: 0.55, sy: 0.95, sz: 0.55, yOff: 0.475, bedroomId: rid, agentIdx, role: 'chair', suiteTheme: theme?.name || '', interactRadius: 1.5 },
          color: asRgba01(colChair, 1),
        });

        // Bookshelf / display wall (varies a bit).
        const shelfX = x0 + 0.55;
        const shelfY = y0 + roomD * (0.20 + 0.55 * (1 - t0));
        addBoxPart(parts, { id: `suite_${rid}_shelf`, kind: 'bookshelf', x: shelfX, y: shelfY, z: 0, sx: 0.55, sy: 2.25, sz: Math.max(1.6, roomD * 0.30), yawDeg: 90, colorHex: 0x2b3341, meta: { role: 'suite_shelf', bedroomId: rid, agentIdx, suiteTheme: theme?.name || '' } });

        // Wall art panel (accent) and a couple plants to soften the boxy look.
        addBoxPart(parts, { id: `suite_${rid}_art`, kind: 'art_panel', x: cx, y: y1 - 0.30, z: 1.45, sx: Math.max(1.6, roomW * 0.38), sy: 0.75, sz: 0.06, yawDeg: 0, colorHex: accent, meta: { role: 'suite_art', bedroomId: rid, agentIdx, suiteTheme: theme?.name || '' } });
        addBoxPart(parts, { id: `suite_${rid}_plant_a`, kind: 'plant', x: x0 + roomW * 0.18, y: y0 + 0.75, z: 0, sx: 0.55, sy: 1.35, sz: 0.55, yawDeg: 0, colorHex: 0x2c5a3b, meta: { role: 'suite_plant', bedroomId: rid, agentIdx, suiteTheme: theme?.name || '' } });
        addBoxPart(parts, { id: `suite_${rid}_plant_b`, kind: 'plant', x: x0 + roomW * 0.22, y: y1 - 0.75, z: 0, sx: 0.50, sy: 1.25, sz: 0.50, yawDeg: 0, colorHex: 0x2a6038, meta: { role: 'suite_plant', bedroomId: rid, agentIdx, suiteTheme: theme?.name || '' } });

        // Signature prop per theme (purely visual, but makes rooms feel like "someone lives here").
        const px = cx + roomW * 0.18;
        const py = cy + roomD * 0.20;
        const sig = String(theme?.name || '');
        if (sig.includes('music') || sig.includes('dj')) {
          addBoxPart(parts, { id: `suite_${rid}_prop_music`, kind: 'prop_instrument', x: px, y: py, z: 0, sx: 1.4, sy: 1.05, sz: 0.55, yawDeg: 15, colorHex: 0x3a2c2a, meta: { role: 'signature', bedroomId: rid, agentIdx, suiteTheme: sig } });
          addBoxPart(parts, { id: `suite_${rid}_prop_amp`, kind: 'prop_amp', x: px + 1.2, y: py - 0.5, z: 0, sx: 0.70, sy: 0.80, sz: 0.45, yawDeg: 0, colorHex: 0x161a22, meta: { role: 'signature', bedroomId: rid, agentIdx, suiteTheme: sig } });
        } else if (sig.includes('artist') || sig.includes('comic') || sig.includes('photography')) {
          addBoxPart(parts, { id: `suite_${rid}_prop_easel`, kind: 'prop_easel', x: px, y: py, z: 0, sx: 0.65, sy: 1.75, sz: 0.55, yawDeg: -20, colorHex: 0x3b2f28, meta: { role: 'signature', bedroomId: rid, agentIdx, suiteTheme: sig } });
          addBoxPart(parts, { id: `suite_${rid}_prop_canvas`, kind: 'prop_canvas', x: px - 0.25, y: py + 0.25, z: 1.05, sx: 0.06, sy: 0.80, sz: 0.60, yawDeg: 70, colorHex: accent, meta: { role: 'signature', bedroomId: rid, agentIdx, suiteTheme: sig } });
        } else if (sig.includes('athlete') || sig.includes('spa') || sig.includes('zen')) {
          addBoxPart(parts, { id: `suite_${rid}_prop_mat`, kind: 'prop_mat', x: px, y: py, z: -0.005, sx: 2.0, sy: 0.02, sz: 0.85, yawDeg: 0, colorHex: 0x1f2632, meta: { role: 'signature', bedroomId: rid, agentIdx, suiteTheme: sig } });
          addBoxPart(parts, { id: `suite_${rid}_prop_weights`, kind: 'prop_weights', x: px + 1.25, y: py + 0.65, z: 0, sx: 0.75, sy: 0.35, sz: 0.40, yawDeg: 0, colorHex: 0x303846, meta: { role: 'signature', bedroomId: rid, agentIdx, suiteTheme: sig } });
        } else if (sig.includes('library') || sig.includes('writer') || sig.includes('language')) {
          addBoxPart(parts, { id: `suite_${rid}_prop_books`, kind: 'prop_books', x: px, y: py, z: 0.78, sx: 0.55, sy: 0.18, sz: 0.35, yawDeg: 0, colorHex: 0x9c6b30, meta: { role: 'signature', bedroomId: rid, agentIdx, suiteTheme: sig } });
          addBoxPart(parts, { id: `suite_${rid}_prop_lamp`, kind: 'prop_lamp', x: px - 0.55, y: py - 0.25, z: 0.78, sx: 0.18, sy: 0.42, sz: 0.18, yawDeg: 0, colorHex: 0xfff2c0, meta: { role: 'signature', bedroomId: rid, agentIdx, suiteTheme: sig } });
        } else if (sig.includes('science') || sig.includes('maker')) {
          addBoxPart(parts, { id: `suite_${rid}_prop_bench`, kind: 'prop_bench', x: px, y: py, z: 0, sx: 1.8, sy: 0.92, sz: 0.75, yawDeg: 0, colorHex: 0x2c3647, meta: { role: 'signature', bedroomId: rid, agentIdx, suiteTheme: sig } });
          addBoxPart(parts, { id: `suite_${rid}_prop_gear`, kind: 'prop_gear', x: px + 0.95, y: py + 0.35, z: 0.92, sx: 0.45, sy: 0.25, sz: 0.25, yawDeg: 0, colorHex: accent, meta: { role: 'signature', bedroomId: rid, agentIdx, suiteTheme: sig } });
        } else if (sig.includes('travel') || sig.includes('collector')) {
          addBoxPart(parts, { id: `suite_${rid}_prop_map`, kind: 'prop_map', x: cx + roomW * 0.20, y: y1 - 0.30, z: 1.35, sx: 0.06, sy: 0.90, sz: 1.35, yawDeg: 90, colorHex: accent, meta: { role: 'signature', bedroomId: rid, agentIdx, suiteTheme: sig } });
          addBoxPart(parts, { id: `suite_${rid}_prop_case`, kind: 'prop_display_case', x: cx + roomW * 0.20, y: y1 - 1.10, z: 0, sx: 1.20, sy: 1.10, sz: 0.55, yawDeg: 0, colorHex: 0x2b3341, alpha: 0.9, meta: { role: 'signature', bedroomId: rid, agentIdx, suiteTheme: sig } });
        } else if (sig.includes('gaming') || sig.includes('puzzle') || sig.includes('strategy')) {
          addBoxPart(parts, { id: `suite_${rid}_prop_arcade`, kind: 'prop_arcade', x: px + 0.45, y: py, z: 0, sx: 0.85, sy: 1.80, sz: 0.80, yawDeg: 0, colorHex: accent, meta: { role: 'signature', bedroomId: rid, agentIdx, suiteTheme: sig } });
        } else if (sig.includes('chef')) {
          addBoxPart(parts, { id: `suite_${rid}_prop_counter`, kind: 'prop_counter', x: px, y: py, z: 0, sx: 2.2, sy: 0.95, sz: 0.80, yawDeg: 0, colorHex: 0x2a3444, meta: { role: 'signature', bedroomId: rid, agentIdx, suiteTheme: sig } });
          addBoxPart(parts, { id: `suite_${rid}_prop_stools`, kind: 'prop_stools', x: px - 1.0, y: py, z: 0, sx: 1.8, sy: 0.60, sz: 0.35, yawDeg: 0, colorHex: 0x1f2632, meta: { role: 'signature', bedroomId: rid, agentIdx, suiteTheme: sig } });
        } else {
          // Minimalist/default: a sculpture plinth.
          addBoxPart(parts, { id: `suite_${rid}_prop_plinth`, kind: 'prop_plinth', x: px, y: py, z: 0, sx: 0.65, sy: 1.05, sz: 0.65, yawDeg: 0, colorHex: 0x3a4350, meta: { role: 'signature', bedroomId: rid, agentIdx, suiteTheme: sig } });
          addBoxPart(parts, { id: `suite_${rid}_prop_sculpt`, kind: 'prop_sculpt', x: px, y: py, z: 1.05, sx: 0.35, sy: 0.35, sz: 0.35, yawDeg: 0, colorHex: accent, meta: { role: 'signature', bedroomId: rid, agentIdx, suiteTheme: sig } });
        }
      }

      // Agent spawn marker (small).
      addBoxPart(parts, {
        id: `agent_spawn_${agentIdx}`,
        kind: 'agent_spawn',
        x: cx + roomW * 0.18, y: cy, z: 0,
        sx: 0.35, sy: 0.10, sz: 0.35,
        yawDeg: 0,
        colorHex: colSpawn,
        meta: { role: 'agent_spawn', bedroomId: rid, agentIdx },
      });
      addInst(instances, {
        id: `agent_spawn_${agentIdx}`,
        kind: 'room_agent_spawn',
        x: cx + roomW * 0.18, y: cy, z: 0,
        yawDeg: 0,
        meta: { sx: 0.35, sy: 0.10, sz: 0.35, yOff: 0.05, bedroomId: rid, agentIdx, role: 'agent_spawn', suiteTheme: (SUITE_THEMES[agentIdx % SUITE_THEMES.length]?.name || '') },
        color: asRgba01(colSpawn, 1),
      });
  }

  // Hall zoning (super-penthouse amenities).
  const hallMinY = minY + wallT;
  const hallMaxY = maxY - wallT;
  const hallDepth = (hallMaxY - hallMinY);
  const gymY0 = hallMinY + hallDepth * 0.02;
  const gymY1 = hallMinY + hallDepth * 0.18;
  const galleryY0 = hallMinY + hallDepth * 0.18;
  const galleryY1 = hallMinY + hallDepth * 0.30;
  const coworkY0 = hallMinY + hallDepth * 0.30;
  const coworkY1 = hallMinY + hallDepth * 0.44;
  const cinemaY0 = hallMinY + hallDepth * 0.44;
  const cinemaY1 = hallMinY + hallDepth * 0.56;
  const loungeY0 = hallMinY + hallDepth * 0.56;
  const loungeY1 = hallMinY + hallDepth * 0.76;
  const barY0 = hallMinY + hallDepth * 0.76;
  const barY1 = hallMinY + hallDepth * 0.86;
  const kitchenY0 = hallMinY + hallDepth * 0.86;
  const kitchenY1 = hallMaxY;

  // Co-work: desk stations (desk + chair + computer) in a common area (smaller than original).
  const gridW = (deskCols - 1) * deskPadX;
  const gridD = (deskRows - 1) * deskPadY;
  const coworkCX = hallLeftX + (hallW * 0.32);
  const coworkCY = (coworkY0 + coworkY1) * 0.5;
  const baseX = coworkCX - gridW * 0.5;
  const baseY = coworkCY - gridD * 0.5;

  let pcIdx = 0;
  for (let rr = 0; rr < deskRows; rr++) {
    for (let cc = 0; cc < deskCols; cc++) {
      const dx = baseX + cc * deskPadX;
      const dy = baseY + rr * deskPadY;

      addBoxPart(parts, {
        id: `desk_${pcIdx}`,
        kind: 'desk',
        x: dx, y: dy, z: 0,
        sx: 1.8, sy: 0.78, sz: 0.85,
        yawDeg: 0,
        colorHex: colDesk,
        meta: { role: 'desk', pcIdx },
      });
      addInst(instances, {
        id: `desk_${pcIdx}`,
        kind: 'room_desk',
        x: dx, y: dy, z: 0,
        yawDeg: 0,
        meta: { sx: 1.8, sy: 0.78, sz: 0.85, yOff: 0.39, pcIdx, role: 'desk' },
        color: asRgba01(colDesk, 1),
      });

      addBoxPart(parts, {
        id: `chair_${pcIdx}`,
        kind: 'chair',
        x: dx - 0.92, y: dy, z: 0,
        sx: 0.55, sy: 0.95, sz: 0.55,
        yawDeg: 180,
        colorHex: colChair,
        meta: { role: 'chair', pcIdx },
      });
      addInst(instances, {
        id: `chair_${pcIdx}`,
        kind: 'room_chair',
        x: dx - 0.92, y: dy, z: 0,
        yawDeg: 180,
        meta: { sx: 0.55, sy: 0.95, sz: 0.55, yOff: 0.475, pcIdx, role: 'chair' },
        color: asRgba01(colChair, 1),
      });

      // Computer as monitor+tower combined box (we'll refine later).
      addBoxPart(parts, {
        id: `pc_${pcIdx}`,
        kind: 'computer',
        x: dx + 0.78, y: dy, z: 0,
        sx: 0.42, sy: 0.52, sz: 0.22,
        yawDeg: 0,
        colorHex: colPc,
        meta: { role: 'computer', pcIdx },
      });
      addInst(instances, {
        id: `pc_${pcIdx}`,
        kind: 'room_computer',
        x: dx + 0.78, y: dy, z: 0,
        yawDeg: 0,
        meta: { sx: 0.42, sy: 0.52, sz: 0.22, yOff: 0.26, pcIdx, role: 'computer' },
        color: asRgba01(colPc, 1),
      });

      pcIdx++;
    }
  }

  // Gallery: benches, plinths, and art panels along the corridor-facing side.
  {
    const gx0 = hallLeftX + 2.8;
    const gx1 = hallRightX - 3.6;
    const gy = (galleryY0 + galleryY1) * 0.5;
    const colPlinth = 0x2b3341;
    const colArtA = 0x7bdff2;
    const colArtB = 0xfde74c;
    const n = Math.max(6, Math.min(14, Math.floor((gx1 - gx0) / 5.8)));
    for (let i = 0; i < n; i++) {
      const t = (n <= 1) ? 0.5 : (i / (n - 1));
      const x = gx0 + t * (gx1 - gx0);
      addBoxPart(parts, { id: `gallery_plinth_${i}`, kind: 'plinth', x, y: gy, z: 0, sx: 0.75, sy: 1.05, sz: 0.75, yawDeg: 0, colorHex: colPlinth, meta: { role: 'gallery' } });
      addBoxPart(parts, { id: `gallery_sculpt_${i}`, kind: 'sculpt', x, y: gy, z: 1.05, sx: 0.35, sy: 0.35, sz: 0.35, yawDeg: 0, colorHex: (i % 2) ? colArtA : colArtB, meta: { role: 'gallery' } });
    }
    // Benches.
    addBoxPart(parts, { id: 'gallery_bench_a', kind: 'bench', x: hallLeftX + hallW * 0.55, y: galleryY0 + 0.9, z: 0, sx: 3.2, sy: 0.52, sz: 0.55, yawDeg: 0, colorHex: 0x1f2632, meta: { role: 'gallery_seat' } });
    addBoxPart(parts, { id: 'gallery_bench_b', kind: 'bench', x: hallLeftX + hallW * 0.55, y: galleryY1 - 0.9, z: 0, sx: 3.2, sy: 0.52, sz: 0.55, yawDeg: 180, colorHex: 0x1f2632, meta: { role: 'gallery_seat' } });
  }

  // Cinema: screen + tiered seating (simple steps).
  {
    const sx = hallRightX - Math.max(8.0, hallW * 0.18);
    const sy = (cinemaY0 + cinemaY1) * 0.5;
    // Screen on the corridor-facing side.
    addBoxPart(parts, { id: 'cinema_screen', kind: 'screen', x: hallLeftX + 2.2, y: sy, z: 1.55, sx: 0.10, sy: 1.35, sz: 3.20, yawDeg: 90, colorHex: 0xe9ecef, alpha: 0.95, meta: { role: 'cinema' } });
    // Tiered risers.
    const tiers = 4;
    for (let i = 0; i < tiers; i++) {
      const tx = sx - i * 2.0;
      const tz = i * 0.20;
      addBoxPart(parts, { id: `cinema_riser_${i}`, kind: 'riser', x: tx, y: sy, z: tz, sx: 1.8, sy: 0.20, sz: (cinemaY1 - cinemaY0) * 0.72, yawDeg: 0, colorHex: 0x141a24, meta: { role: 'cinema' } });
      addBoxPart(parts, { id: `cinema_seat_${i}`, kind: 'sofa', x: tx, y: sy, z: tz + 0.20, sx: 1.6, sy: 0.90, sz: 0.90, yawDeg: 180, colorHex: 0x2f4059, meta: { role: 'cinema_seat' } });
    }
  }

  // Kitchen (massive, many fridges).
  {
    const colCounter = 0x2a3444;
    const colIsland = 0x253142;
    const colFridge = 0xd3dbe6;
    const colCab = 0x3a4350;
    const kcx = hallLeftX + hallW * 0.55;
    const kcy = (kitchenY0 + kitchenY1) * 0.5;

    // Long counter run (north wall).
    addBoxPart(parts, { id: 'kitchen_counter_n', kind: 'counter', x: kcx, y: kitchenY1 - 0.90, z: 0, sx: hallW * 0.86, sy: 0.92, sz: 0.90, yawDeg: 0, colorHex: colCounter, meta: { role: 'kitchen_counter' } });
    // Upper cabinets band.
    addBoxPart(parts, { id: 'kitchen_cabs_n', kind: 'cabinet', x: kcx, y: kitchenY1 - 0.92, z: 1.55, sx: hallW * 0.80, sy: 0.55, sz: 0.55, yawDeg: 0, colorHex: colCab, meta: { role: 'kitchen_cabinet' } });

    // Island.
    addBoxPart(parts, { id: 'kitchen_island', kind: 'island', x: kcx, y: kcy, z: 0, sx: hallW * 0.42, sy: 0.96, sz: Math.max(3.2, (kitchenY1 - kitchenY0) * 0.42), yawDeg: 0, colorHex: colIsland, meta: { role: 'kitchen_island' } });

    // Many fridges along the inner wall (near corridor side) — "always stocked".
    const fx = hallLeftX + 2.2;
    const fy0 = kitchenY0 + 1.0;
    const fy1 = kitchenY1 - 1.2;
    const fCount = Math.max(6, Math.min(18, Math.floor((fy1 - fy0) / 1.8)));
    for (let i = 0; i < fCount; i++) {
      const t = (fCount <= 1) ? 0.5 : (i / (fCount - 1));
      const yy = fy0 + t * (fy1 - fy0);
      addBoxPart(parts, { id: `kitchen_fridge_${i}`, kind: 'fridge', x: fx, y: yy, z: 0, sx: 1.05, sy: 2.25, sz: 0.92, yawDeg: 90, colorHex: colFridge, meta: { role: 'kitchen_fridge', stocked: true, idx: i } });
    }

    // Pantry shelving.
    addBoxPart(parts, { id: 'kitchen_pantry', kind: 'shelves', x: hallLeftX + 4.4, y: kitchenY0 + 1.2, z: 0, sx: 2.4, sy: 2.35, sz: 0.55, yawDeg: 0, colorHex: 0x3b4658, meta: { role: 'pantry', stocked: true } });
  }

  // Large lounge / common area (relax + socialize) on the window side.
  {
    const loungeX = hallRightX - Math.max(10.0, hallW * 0.22);
    const loungeY = (loungeY0 + loungeY1) * 0.5;
    const colSofa = 0x31435d;
    const colTable = 0x2a2430;
    const colPlant = 0x2c5a3b;
    const colTv = 0x0b1018;

    // Big rug.
    addBoxPart(parts, { id: 'lounge_rug', kind: 'rug', x: loungeX, y: loungeY, z: -0.01, sx: 12.0, sy: 0.02, sz: Math.max(6.8, (loungeY1 - loungeY0) * 0.78), yawDeg: 0, colorHex: 0x141a24, meta: { role: 'lounge' } });

    // Sectional sofas.
    addBoxPart(parts, { id: 'lounge_sofa_a', kind: 'sofa', x: loungeX - 2.2, y: loungeY - 1.9, z: 0, sx: 3.8, sy: 0.95, sz: 1.15, yawDeg: 0, colorHex: colSofa, meta: { role: 'lounge_sofa' } });
    addBoxPart(parts, { id: 'lounge_sofa_b', kind: 'sofa', x: loungeX + 2.0, y: loungeY - 1.9, z: 0, sx: 3.4, sy: 0.95, sz: 1.15, yawDeg: 0, colorHex: colSofa, meta: { role: 'lounge_sofa' } });
    addBoxPart(parts, { id: 'lounge_sofa_c', kind: 'sofa', x: loungeX - 2.8, y: loungeY + 1.6, z: 0, sx: 2.8, sy: 0.95, sz: 1.15, yawDeg: 180, colorHex: colSofa, meta: { role: 'lounge_sofa' } });

    // Coffee table + side tables.
    addBoxPart(parts, { id: 'lounge_table', kind: 'coffee_table', x: loungeX, y: loungeY - 0.1, z: 0, sx: 1.8, sy: 0.45, sz: 1.1, yawDeg: 0, colorHex: colTable, meta: { role: 'lounge_table' } });
    addBoxPart(parts, { id: 'lounge_side_a', kind: 'side_table', x: loungeX - 5.2, y: loungeY - 2.1, z: 0, sx: 0.55, sy: 0.55, sz: 0.55, yawDeg: 0, colorHex: colTable, meta: { role: 'side_table' } });
    addBoxPart(parts, { id: 'lounge_side_b', kind: 'side_table', x: loungeX + 5.0, y: loungeY - 2.1, z: 0, sx: 0.55, sy: 0.55, sz: 0.55, yawDeg: 0, colorHex: colTable, meta: { role: 'side_table' } });

    // TV wall facing the lounge (towards corridor side).
    const tvX = hallLeftX + Math.max(2.8, hallW * 0.18);
    addBoxPart(parts, { id: 'lounge_tv', kind: 'tv', x: tvX, y: loungeY, z: 1.4, sx: 0.10, sy: 1.05, sz: 2.1, yawDeg: 90, colorHex: colTv, meta: { role: 'tv' } });
    addBoxPart(parts, { id: 'lounge_tv_console', kind: 'tv_console', x: tvX + 0.55, y: loungeY, z: 0, sx: 0.65, sy: 0.55, sz: 2.0, yawDeg: 90, colorHex: 0x2b3341, meta: { role: 'tv_console' } });
    // Runtime instances (interactable): TV body + screen.
    addInst(instances, {
      id: 'lounge_tv',
      kind: 'room_tv',
      x: tvX, y: loungeY, z: 1.4,
      yawDeg: 90,
      meta: { sx: 0.10, sy: 1.05, sz: 2.1, yOff: 0.0, role: 'tv', interactRadius: 2.6 },
      color: asRgba01(colTv, 1),
    });
    addInst(instances, {
      id: 'lounge_tv_screen',
      kind: 'room_tv_screen',
      x: tvX + 0.08, y: loungeY, z: 1.4,
      yawDeg: 90,
      meta: { sx: 0.03, sy: 0.90, sz: 1.85, yOff: 0.0, role: 'tv_screen' },
      color: asRgba01(0x0f1218, 1),
    });

    // Plants near windows.
    for (const [i, yy] of [loungeY0 + 1.1, loungeY1 - 1.1].entries()) {
      addBoxPart(parts, { id: `lounge_plant_${i}`, kind: 'plant', x: hallRightX - 1.2, y: yy, z: 0, sx: 0.55, sy: 1.35, sz: 0.55, yawDeg: 0, colorHex: colPlant, meta: { role: 'plant' } });
    }
  }

  // Dining table bridging lounge ↔ kitchen.
  {
    const dx = hallLeftX + hallW * 0.60;
    const dy = barY0 + (barY1 - barY0) * 0.45;
    addBoxPart(parts, { id: 'dining_table', kind: 'dining_table', x: dx, y: dy, z: 0, sx: 5.2, sy: 0.78, sz: 1.55, yawDeg: 0, colorHex: 0x2b3341, meta: { role: 'dining' } });
    // Benches.
    addBoxPart(parts, { id: 'dining_bench_a', kind: 'bench', x: dx, y: dy - 1.0, z: 0, sx: 3.8, sy: 0.52, sz: 0.55, yawDeg: 0, colorHex: 0x1f2632, meta: { role: 'dining_seat' } });
    addBoxPart(parts, { id: 'dining_bench_b', kind: 'bench', x: dx, y: dy + 1.0, z: 0, sx: 3.8, sy: 0.52, sz: 0.55, yawDeg: 180, colorHex: 0x1f2632, meta: { role: 'dining_seat' } });
  }

  // Bar: long counter + stools + backbar.
  {
    const bx = hallLeftX + hallW * 0.58;
    const by = (barY0 + barY1) * 0.5;
    const colBar = 0x2a3444;
    const colStool = 0x1f2632;
    addBoxPart(parts, { id: 'bar_counter', kind: 'bar', x: bx, y: by, z: 0, sx: hallW * 0.52, sy: 1.05, sz: 0.85, yawDeg: 0, colorHex: colBar, meta: { role: 'bar' } });
    addBoxPart(parts, { id: 'bar_back', kind: 'backbar', x: bx, y: barY1 - 0.95, z: 0, sx: hallW * 0.48, sy: 2.25, sz: 0.60, yawDeg: 0, colorHex: 0x3a4350, meta: { role: 'bar' } });
    const stoolCount = Math.max(6, Math.min(14, Math.floor((hallW * 0.52) / 2.4)));
    for (let i = 0; i < stoolCount; i++) {
      const t = (stoolCount <= 1) ? 0.5 : (i / (stoolCount - 1));
      const x = (bx - (hallW * 0.26)) + t * (hallW * 0.52);
      addBoxPart(parts, { id: `bar_stool_${i}`, kind: 'stool', x, y: by - 1.05, z: 0, sx: 0.45, sy: 0.75, sz: 0.45, yawDeg: 0, colorHex: colStool, meta: { role: 'bar_seat' } });
    }
  }

  // Gym: treadmills + weights along the glass wall.
  {
    const colGym = 0x2c3647;
    const gx = hallRightX - 2.2;
    const gy0 = gymY0 + 0.8;
    const gy1 = gymY1 - 0.8;
    const n = Math.max(4, Math.min(10, Math.floor((gy1 - gy0) / 2.2)));
    for (let i = 0; i < n; i++) {
      const t = (n <= 1) ? 0.5 : (i / (n - 1));
      const y = gy0 + t * (gy1 - gy0);
      addBoxPart(parts, { id: `gym_tread_${i}`, kind: 'treadmill', x: gx - 1.8, y, z: 0, sx: 1.8, sy: 0.95, sz: 0.72, yawDeg: 90, colorHex: colGym, meta: { role: 'gym' } });
    }
    addBoxPart(parts, { id: 'gym_weights', kind: 'weights_rack', x: hallLeftX + 4.2, y: (gymY0 + gymY1) * 0.5, z: 0, sx: 2.6, sy: 1.6, sz: 0.55, yawDeg: 0, colorHex: 0x303846, meta: { role: 'gym' } });
  }

  // Spa: hot tub + sauna block (simple).
  {
    const sx = hallRightX - Math.max(10.0, hallW * 0.22);
    const sy = (kitchenY0 + barY1) * 0.5;
    // Put spa near the north end but before the kitchen: just a hint of luxury.
    const y = barY1 + (kitchenY0 - barY1) * 0.50;
    addBoxPart(parts, { id: 'spa_tub', kind: 'hot_tub', x: sx, y, z: 0, sx: 3.2, sy: 0.55, sz: 2.2, yawDeg: 0, colorHex: 0x3a475c, alpha: 0.22, meta: { role: 'spa' } });
    addBoxPart(parts, { id: 'spa_sauna', kind: 'sauna', x: sx - 4.2, y, z: 0, sx: 2.6, sy: 2.35, sz: 2.0, yawDeg: 0, colorHex: 0x3b2f28, meta: { role: 'spa' } });
  }

  // Lighting pass: ceiling lights down the corridor and across hall zones.
  {
    const lightCol = 0xffffff;
    const lampCol = 0xfff2c0;
    const lampH = Math.max(2.6, wallH - 0.35);
    const corridorX = corridorLeftX + corridorD * 0.5;
    const cY0 = minY + wallT + 1.2;
    const cY1 = maxY - wallT - 1.2;
    const cCount = Math.max(6, Math.floor((cY1 - cY0) / 4.2));
    for (let i = 0; i <= cCount; i++) {
      const t = (cCount <= 0) ? 0.5 : (i / cCount);
      const yy = cY0 + t * (cY1 - cY0);
      addBoxPart(parts, { id: `light_corr_${i}`, kind: 'ceiling_light', x: corridorX, y: yy, z: lampH, sx: 0.95, sy: 0.10, sz: 0.30, yawDeg: 0, colorHex: lampCol, alpha: 1, meta: { role: 'light', intensity: 0.9 } });
      addInst(instances, { id: `light_corr_${i}`, kind: 'room_light', x: corridorX, y: yy, z: lampH, yawDeg: 0, meta: { sx: 0.95, sy: 0.10, sz: 0.30, yOff: lampH, role: 'light', colorHex: lightCol, intensity: 0.9 }, color: asRgba01(lampCol, 1) });
    }
    // Hall lights (soft grid).
    const hx0 = hallLeftX + 6.0;
    const hx1 = hallRightX - 6.0;
    const hy0 = hallMinY + 3.0;
    const hy1 = hallMaxY - 3.0;
    const hxCount = Math.max(2, Math.floor((hx1 - hx0) / 10.0));
    const hyCount = Math.max(2, Math.floor((hy1 - hy0) / 10.0));
    let idx = 0;
    for (let iy = 0; iy <= hyCount; iy++) {
      for (let ix = 0; ix <= hxCount; ix++) {
        const x = hx0 + (ix / hxCount) * (hx1 - hx0);
        const y = hy0 + (iy / hyCount) * (hy1 - hy0);
        addBoxPart(parts, { id: `light_hall_${idx}`, kind: 'ceiling_light', x, y, z: lampH, sx: 0.90, sy: 0.10, sz: 0.26, yawDeg: 0, colorHex: lampCol, meta: { role: 'light', intensity: 0.65 } });
        idx++;
      }
    }
  }

  // Include the floor slab thickness: floor is centered at z=-0.08 with thickness 0.16 → minZ=-0.16.
  // This keeps initial camera framing + gameplay grounding consistent with the actual geometry.
  const bounds = { minX, maxX, minY, maxY, minZ: -0.16, maxZ: Math.max(4.0, wallH + 0.6) };

  return {
    schema: 1,
    kind: 'room_sim_penthouse_layout',
    params: {
      rows, cols, roomW, roomD, suiteHallW,
      corridorD, hallW,
      wallT, wallH,
      doorW, hallDoorW,
      deskRows, deskCols,
      deskPadX, deskPadY,
    },
    // Optional structured artifacts:
    // - plan: region grid for deterministic wall/door construction
    // - planOmitEdges: omitted edges used as doors/openings
    // - planValidation: basic door coverage check
    // - planDerivedStats: counts for debugging
    plan: planOut,
    planOmitEdges: planOmitEdgesOut,
    planValidation: planValidationOut,
    planDerivedStats: planDerivedStatsOut,
    bounds,
    parts,
    instances,
  };
}

