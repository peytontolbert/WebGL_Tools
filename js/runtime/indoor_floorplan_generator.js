// Seeded, deterministic indoor floorplan generation from OSM building footprints.
//
// MVP goals:
// - Given a building footprint ring (XZ in meters) + minY/maxY, generate:
//   - 1 entrance on the exterior
//   - 1 corridor + several rectangular rooms (all 2D polygons in XZ)
// - Deterministic per-building (stable hash of footprint geometry).
// - Fast enough for on-demand near-camera generation.

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

function fnv1a32Init() {
  return 2166136261 >>> 0;
}

function fnv1a32AddByte(h, b) {
  h ^= (b & 255);
  return Math.imul(h, 16777619) >>> 0;
}

function fnv1a32AddI32(h, v) {
  const x = (v | 0) >>> 0;
  h = fnv1a32AddByte(h, x & 255);
  h = fnv1a32AddByte(h, (x >>> 8) & 255);
  h = fnv1a32AddByte(h, (x >>> 16) & 255);
  h = fnv1a32AddByte(h, (x >>> 24) & 255);
  return h >>> 0;
}

function signedArea2XZ(ring) {
  // ring: [{x,z}, ...] (open loop). Returns 2*area.
  let a = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    a += (p.x * q.z - q.x * p.z);
  }
  return a;
}

function cleanRingXZ(ringXZ, { minPoints = 3, eps = 1e-4 } = {}) {
  if (!Array.isArray(ringXZ) || ringXZ.length < minPoints) return [];
  let pts = ringXZ.map((p) => ({ x: Number(p?.[0]), z: Number(p?.[1]) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.z));
  if (pts.length < minPoints) return [];

  // Drop last if same as first
  const a0 = pts[0];
  const al = pts[pts.length - 1];
  if (Math.hypot(al.x - a0.x, al.z - a0.z) < eps) pts.pop();
  if (pts.length < minPoints) return [];

  // Remove near-duplicate consecutive points
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const prev = out.length ? out[out.length - 1] : null;
    if (prev && Math.hypot(p.x - prev.x, p.z - prev.z) < eps) continue;
    out.push(p);
  }
  if (out.length >= 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.hypot(first.x - last.x, first.z - last.z) < eps) out.pop();
  }
  return (out.length >= minPoints) ? out : [];
}

function pointInPolyXZ(px, pz, poly) {
  // Ray cast in XZ. poly: [{x,z}, ...] open loop.
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, zi = poly[i].z;
    const xj = poly[j].x, zj = poly[j].z;
    const intersect = ((zi > pz) !== (zj > pz)) &&
      (px < (xj - xi) * (pz - zi) / Math.max(1e-12, (zj - zi)) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function rectCorners(cx, cz, hx, hz) {
  return [
    [cx - hx, cz - hz],
    [cx + hx, cz - hz],
    [cx + hx, cz + hz],
    [cx - hx, cz + hz],
  ];
}

function rectAllCornersInside(cx, cz, hx, hz, poly) {
  const cs = rectCorners(cx, cz, hx, hz);
  for (let i = 0; i < cs.length; i++) {
    const p = cs[i];
    if (!pointInPolyXZ(p[0], p[1], poly)) return false;
  }
  return true;
}

function rotate2(x, z, ang) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return [x * c - z * s, x * s + z * c];
}

function inferYawFromRing(points) {
  // points: [{x,z}...]. Use longest edge direction.
  let best = 0;
  let bestDx = 0, bestDz = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz);
    if (l > best) { best = l; bestDx = dx; bestDz = dz; }
  }
  if (best <= 1e-6) return 0.0;
  return Math.atan2(bestDx, bestDz);
}

function fingerprintBuildingU32({ ring, minY = 0, maxY = 0 }) {
  // Stable-ish hash from quantized geometry.
  // Quantization: 0.1m for XZ, 0.01m for Y range.
  let h = fnv1a32Init();
  h = fnv1a32AddI32(h, Math.round((Number(minY) || 0) * 100));
  h = fnv1a32AddI32(h, Math.round((Number(maxY) || 0) * 100));
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    h = fnv1a32AddI32(h, Math.round(p.x * 10));
    h = fnv1a32AddI32(h, Math.round(p.z * 10));
  }
  h = fnv1a32AddI32(h, ring.length | 0);
  return h >>> 0;
}

function polyBounds(points) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    minX = Math.min(minX, p.x);
    minZ = Math.min(minZ, p.z);
    maxX = Math.max(maxX, p.x);
    maxZ = Math.max(maxZ, p.z);
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minZ, maxX, maxZ, dx: maxX - minX, dz: maxZ - minZ };
}

function rectPolyFromCorners(corners) {
  return corners.map((p) => [p[0], p[1]]);
}

function doorFromEdgeCCW(a, b, { width = 1.2 } = {}) {
  // a,b: {x,z} in local; ring winding assumed CCW.
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (!Number.isFinite(len) || len < 0.5) return null;
  const mx = (a.x + b.x) * 0.5;
  const mz = (a.z + b.z) * 0.5;
  // outward normal for CCW ring (same as extruded buildings: (dz, -dx))
  const nx = dz / len;
  const nz = -dx / len;
  // Clamp door width so it doesn't exceed the edge
  const w = Math.max(0.8, Math.min(Number(width) || 1.2, len * 0.6));
  return { pos: [mx, mz], n: [nx, nz], width: w };
}

function tryMakeCorridor(polyLocal, bounds, rand, {
  margin = 0.9,
  corridorWidth = 1.8,
} = {}) {
  const dx = bounds.dx;
  const dz = bounds.dz;
  const majorX = dx >= dz;
  const cx = (bounds.minX + bounds.maxX) * 0.5;
  const cz = (bounds.minZ + bounds.maxZ) * 0.5;

  // Length along major axis with inset.
  const usableMajor = (majorX ? dx : dz) - 2 * margin;
  const usableMinor = (majorX ? dz : dx) - 2 * margin;
  if (!(usableMajor > 3.0 && usableMinor > 3.0)) return null;

  // Start with a corridor that fits comfortably; then shrink if it fails inside-test.
  let cw = Math.max(1.4, Math.min(corridorWidth, usableMinor * 0.45));
  let halfMajor = usableMajor * (0.42 + rand() * 0.10); // 0.42..0.52 of usable length
  halfMajor = Math.max(1.6, Math.min(halfMajor, usableMajor * 0.60));

  for (let attempt = 0; attempt < 8; attempt++) {
    const hx = majorX ? halfMajor : (cw * 0.5);
    const hz = majorX ? (cw * 0.5) : halfMajor;
    // Small random offset to avoid perfectly centered repeats.
    const offMinor = (rand() - 0.5) * Math.min(usableMinor * 0.25, 1.2);
    const rcx = majorX ? cx : (cx + offMinor);
    const rcz = majorX ? (cz + offMinor) : cz;
    if (rectAllCornersInside(rcx, rcz, hx, hz, polyLocal)) {
      return { majorX, cx: rcx, cz: rcz, hx, hz };
    }
    cw *= 0.85;
    halfMajor *= 0.92;
  }
  return null;
}

function subdivideRoomsAlongCorridor(polyLocal, corridor, rand, {
  roomDepthMin = 2.2,
  roomDepthMax = 6.5,
  minSegment = 2.4,
  maxRooms = 8,
} = {}) {
  // Returns list of rectangular room polys in local coordinates (XZ).
  const rooms = [];
  const majorX = corridor.majorX;
  const halfMajor = majorX ? corridor.hx : corridor.hz;
  const halfMinor = majorX ? corridor.hz : corridor.hx; // corridor half-width
  const cMajor = majorX ? corridor.cx : corridor.cz;
  const cMinor = majorX ? corridor.cz : corridor.cx;

  const totalLen = halfMajor * 2;
  const targetRooms = Math.max(2, Math.min(maxRooms, Math.floor(2 + rand() * 6)));
  const segCount = Math.max(2, Math.min(targetRooms, Math.floor(totalLen / Math.max(1e-6, minSegment))));
  const baseSeg = totalLen / segCount;

  const pushRoomRect = (segCenterMajor, segHalfLen, sideSign) => {
    const depth = Math.max(roomDepthMin, Math.min(roomDepthMax, roomDepthMin + rand() * (roomDepthMax - roomDepthMin)));
    const halfDepth = depth * 0.5;
    const roomMinorCenter = cMinor + sideSign * (halfMinor + halfDepth + 0.1);
    const hx = majorX ? segHalfLen : halfDepth;
    const hz = majorX ? halfDepth : segHalfLen;
    const rcx = majorX ? segCenterMajor : roomMinorCenter;
    const rcz = majorX ? roomMinorCenter : segCenterMajor;

    if (!rectAllCornersInside(rcx, rcz, hx, hz, polyLocal)) return false;
    rooms.push(rectPolyFromCorners(rectCorners(rcx, rcz, hx, hz)));
    return true;
  };

  for (let i = 0; i < segCount; i++) {
    const t0 = (i / segCount) * totalLen;
    const t1 = ((i + 1) / segCount) * totalLen;
    // jitter segment boundaries slightly
    const jitter = (rand() - 0.5) * Math.min(0.8, baseSeg * 0.25);
    const segA = -halfMajor + t0 + jitter;
    const segB = -halfMajor + t1 - jitter;
    const segLen = Math.max(1.8, segB - segA);
    const segCenter = cMajor + (segA + segB) * 0.5;
    const segHalfLen = Math.min(segLen * 0.5, halfMajor);

    // Alternate sides; some segments only get one room.
    const sideFirst = (i % 2 === 0) ? 1 : -1;
    const ok1 = pushRoomRect(segCenter, segHalfLen * 0.86, sideFirst);
    if (ok1 && rand() < 0.55) pushRoomRect(segCenter, segHalfLen * 0.72, -sideFirst);
  }

  return rooms;
}

function transformPolyLocalToWorld(polyLocal, centerXZ, yaw) {
  const out = [];
  for (let i = 0; i < polyLocal.length; i++) {
    const p = polyLocal[i];
    const [x, z] = rotate2(p[0], p[1], yaw);
    out.push([x + centerXZ[0], z + centerXZ[1]]);
  }
  return out;
}

export function generateIndoorFloorplan(building, {
  worldSeed = 'indoors_v1',
  floorOnly = true,
  marginMeters = 0.9,
  corridorWidthMeters = 1.8,
  doorWidthMeters = 1.2,
} = {}) {
  const ring = cleanRingXZ(building?.ringXZ);
  if (ring.length < 3) return null;

  // Ensure CCW for outward normals.
  if (signedArea2XZ(ring) < 0) ring.reverse();

  const minY = Number(building?.minY ?? 0) || 0;
  const maxY = Number(building?.maxY ?? (minY + 7.5)) || (minY + 7.5);
  const spanY = Math.max(0.25, maxY - minY);

  const centerXZ = Array.isArray(building?.centerXZ)
    ? [Number(building.centerXZ[0]) || 0, Number(building.centerXZ[1]) || 0]
    : (() => {
      let sx = 0, sz = 0;
      for (const p of ring) { sx += p.x; sz += p.z; }
      return [sx / ring.length, sz / ring.length];
    })();

  // Seed per building.
  const fp = fingerprintBuildingU32({ ring, minY, maxY });
  let baseSeed = fnv1a32Init();
  for (let i = 0; i < String(worldSeed).length; i++) baseSeed = fnv1a32AddByte(baseSeed, String(worldSeed).charCodeAt(i) & 255);
  const seedU32 = (baseSeed ^ fp) >>> 0;
  const rand = mulberry32(seedU32);

  const yaw = inferYawFromRing(ring);
  // Transform ring into local space (centered, rotated so major edge aligns).
  const ringLocal = ring.map((p) => {
    const dx = p.x - centerXZ[0];
    const dz = p.z - centerXZ[1];
    const [lx, lz] = rotate2(dx, dz, -yaw);
    return { x: lx, z: lz };
  });

  const b = polyBounds(ringLocal);
  if (!b) return null;

  // Entrance: choose the longest edge (deterministic), then derive a door.
  let bestEdge = null;
  let bestLen = 0;
  for (let i = 0; i < ringLocal.length; i++) {
    const a = ringLocal[i];
    const c = ringLocal[(i + 1) % ringLocal.length];
    const len = Math.hypot(c.x - a.x, c.z - a.z);
    if (len > bestLen) { bestLen = len; bestEdge = { a, b: c }; }
  }
  const door = bestEdge ? doorFromEdgeCCW(bestEdge.a, bestEdge.b, { width: doorWidthMeters }) : null;
  if (!door) return null;

  const corridor = tryMakeCorridor(ringLocal, b, rand, { margin: marginMeters, corridorWidth: corridorWidthMeters });
  const roomsLocal = corridor ? subdivideRoomsAlongCorridor(ringLocal, corridor, rand) : [];

  // If corridor/rooms fail (irregular footprint), fall back to a single “main room” rectangle inset.
  const fallbackRoomsLocal = (() => {
    if (roomsLocal.length) return roomsLocal;
    const inset = Math.max(0.6, Math.min(1.8, Math.min(b.dx, b.dz) * 0.12));
    const cx = (b.minX + b.maxX) * 0.5;
    const cz = (b.minZ + b.maxZ) * 0.5;
    const hx = Math.max(1.2, (b.dx * 0.5) - inset);
    const hz = Math.max(1.2, (b.dz * 0.5) - inset);
    if (!rectAllCornersInside(cx, cz, hx, hz, ringLocal)) return [];
    return [rectPolyFromCorners(rectCorners(cx, cz, hx, hz))];
  })();

  // Convert generated shapes back to world XZ.
  const corridorPolyWorld = corridor
    ? transformPolyLocalToWorld(rectPolyFromCorners(rectCorners(corridor.cx, corridor.cz, corridor.hx, corridor.hz)), centerXZ, yaw)
    : null;

  const roomsWorld = fallbackRoomsLocal.map((poly) => transformPolyLocalToWorld(poly, centerXZ, yaw));

  const [doorWx, doorWz] = rotate2(door.pos[0], door.pos[1], yaw);
  const [nWx, nWz] = rotate2(door.n[0], door.n[1], yaw);
  const entrance = {
    posXZ: [doorWx + centerXZ[0], doorWz + centerXZ[1]],
    normalXZ: [nWx, nWz],
    width: door.width,
  };

  return {
    idU32: fp,
    seedU32,
    centerXZ,
    yawRad: yaw,
    minY,
    maxY,
    floors: [{
      y: minY + 0.05, // floor debug height
      entrances: [entrance],
      corridor: corridorPolyWorld ? { polyXZ: corridorPolyWorld } : null,
      rooms: roomsWorld.map((polyXZ, idx) => ({ id: idx, kind: 'room', polyXZ })),
    }],
    // Keep a copy of the footprint in case we want to validate later.
    footprint: ring.map((p) => [p.x, p.z]),
  };
}

export function buildIndoorDebugLinesFromFloorplan(floorplan, {
  maxRooms = 40,
  y = null,
} = {}) {
  // Returns Float32Array positions for GL.LINES (pairs of vertices).
  if (!floorplan?.floors?.length) return new Float32Array(0);
  const f0 = floorplan.floors[0];
  const yy = Number.isFinite(y) ? Number(y) : (Number(f0?.y) || 0.05);
  /** @type {number[]} */
  const out = [];

  const pushPoly = (polyXZ) => {
    if (!Array.isArray(polyXZ) || polyXZ.length < 2) return;
    for (let i = 0; i < polyXZ.length; i++) {
      const a = polyXZ[i];
      const b = polyXZ[(i + 1) % polyXZ.length];
      out.push(Number(a?.[0]) || 0, yy, Number(a?.[1]) || 0);
      out.push(Number(b?.[0]) || 0, yy, Number(b?.[1]) || 0);
    }
  };

  // Corridor
  if (f0?.corridor?.polyXZ) pushPoly(f0.corridor.polyXZ);
  // Rooms
  const rooms = Array.isArray(f0?.rooms) ? f0.rooms : [];
  for (let i = 0; i < Math.min(maxRooms, rooms.length); i++) pushPoly(rooms[i]?.polyXZ);

  // Entrance markers: draw a small door segment + normal arrow.
  const ents = Array.isArray(f0?.entrances) ? f0.entrances : [];
  for (const e of ents) {
    const px = Number(e?.posXZ?.[0]);
    const pz = Number(e?.posXZ?.[1]);
    const nx = Number(e?.normalXZ?.[0]);
    const nz = Number(e?.normalXZ?.[1]);
    const w = Math.max(0.6, Math.min(3.0, Number(e?.width) || 1.2));
    const len = Math.hypot(nx, nz) || 1;
    const ux = nx / len;
    const uz = nz / len;
    // tangent
    const tx = -uz;
    const tz = ux;
    // door segment across the boundary
    out.push(px - tx * (w * 0.5), yy + 0.02, pz - tz * (w * 0.5));
    out.push(px + tx * (w * 0.5), yy + 0.02, pz + tz * (w * 0.5));
    // normal arrow (points outward)
    out.push(px, yy + 0.02, pz);
    out.push(px + ux * 2.0, yy + 0.02, pz + uz * 2.0);
  }

  return new Float32Array(out);
}


