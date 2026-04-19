// Tile-based Wave Function Collapse (WFC), 4-neighborhood.
//
// MVP goals:
// - Learn adjacency constraints from an example tile grid
// - Generate new grids that "look like" the example locally
// - Deterministic by seed string
// - Robust: bounded retries, optional pinned cells
//
// Implementation notes:
// - Tile domains are a Uint32 bitset (supports up to 32 distinct tile ids).
// - Constraints are stored as allowed[tileId][dir] bitmasks (dir: 0=N,1=E,2=S,3=W)

function hashStringToU32(s) {
  const str = String(s || '');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 255;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seedU32) {
  let a = seedU32 >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function popcount32(x) {
  // Hamming weight (uint32)
  let v = x >>> 0;
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
}

function lowestBitIndex(mask) {
  // Returns index of least-significant set bit (0..31), or -1 if none.
  const m = mask >>> 0;
  if (!m) return -1;
  // isolate lsb
  const lsb = (m & -m) >>> 0;
  return Math.clz32(lsb) === 32 ? -1 : (31 - Math.clz32(lsb));
}

function forEachBit(mask, cb) {
  let m = mask >>> 0;
  while (m) {
    const lsb = (m & -m) >>> 0;
    const i = 31 - Math.clz32(lsb);
    cb(i);
    m ^= lsb;
  }
}

function pickWeightedBitFromMask(mask, weights, rand01) {
  const m = mask >>> 0;
  if (!m) return -1;
  let sum = 0;
  forEachBit(m, (i) => { sum += Math.max(0, Number(weights?.[i]) || 0); });
  if (!(sum > 0)) {
    // Uniform fallback
    const n = popcount32(m);
    const k = Math.max(0, Math.min(n - 1, Math.floor(rand01() * n)));
    let seen = 0;
    let out = -1;
    forEachBit(m, (i) => {
      if (out !== -1) return;
      if (seen === k) out = i;
      seen++;
    });
    return out;
  }
  let r = rand01() * sum;
  let out = -1;
  forEachBit(m, (i) => {
    if (out !== -1) return;
    const w = Math.max(0, Number(weights?.[i]) || 0);
    r -= w;
    if (r <= 0) out = i;
  });
  // Numerical safety
  if (out === -1) out = lowestBitIndex(m);
  return out;
}

const DIRS = [
  { dx: 0, dy: -1 }, // N
  { dx: 1, dy: 0 },  // E
  { dx: 0, dy: 1 },  // S
  { dx: -1, dy: 0 }, // W
];
const OPP = [2, 3, 0, 1];

function domainToAllowedNeighborMask(domainMask, dir, allowedByTileAndDir) {
  // Union of allowed[t][dir] for all t in domain.
  let out = 0 >>> 0;
  forEachBit(domainMask, (t) => {
    out |= (allowedByTileAndDir?.[t]?.[dir] ?? 0) >>> 0;
  });
  return out >>> 0;
}

/**
 * Learn adjacency constraints from a tile id grid.
 * @param {Uint8Array|number[]} tiles row-major tile ids
 * @param {number} w
 * @param {number} h
 * @param {number} tileCount number of distinct tile ids
 */
export function learnAdjacencyFromExample(tiles, w, h, tileCount) {
  const n = Math.max(1, Math.min(32, tileCount | 0));
  /** @type {number[][]} */
  const allowed = [];
  for (let t = 0; t < n; t++) allowed.push([0, 0, 0, 0]);
  const weights = new Float32Array(n);

  const W = Math.max(1, w | 0);
  const H = Math.max(1, h | 0);

  const get = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return -1;
    const v = Number(tiles[y * W + x]);
    if (!Number.isFinite(v)) return -1;
    const i = v | 0;
    if (i < 0 || i >= n) return -1;
    return i;
  };

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = get(x, y);
      if (t < 0) continue;
      weights[t] += 1;
      for (let d = 0; d < 4; d++) {
        const nx = x + DIRS[d].dx;
        const ny = y + DIRS[d].dy;
        const u = get(nx, ny);
        if (u < 0) continue;
        allowed[t][d] |= (1 << u) >>> 0;
      }
    }
  }

  // Safety: ensure every tile can at least neighbor something. If a tile never appeared adjacent
  // in the example (rare), allow it next to itself in all dirs to prevent immediate contradictions.
  for (let t = 0; t < n; t++) {
    for (let d = 0; d < 4; d++) {
      if ((allowed[t][d] >>> 0) === 0) allowed[t][d] = (1 << t) >>> 0;
    }
    // Also avoid 0 weights (so weighted sampling doesn't go degenerate).
    if (!(weights[t] > 0)) weights[t] = 0.01;
  }

  return { tileCount: n, allowed, weights };
}

/**
 * Run WFC to produce a new tile id grid.
 * @param {{
 *   outW: number,
 *   outH: number,
 *   seed?: string|number,
 *   model: { tileCount:number, allowed:number[][], weights:Float32Array },
 *   pins?: Array<{ x:number, y:number, tile:number }>,
 *   maxAttempts?: number,
 * }} opts
 */
export function generateWfcTileGrid(opts) {
  const outW = Math.max(1, opts?.outW | 0);
  const outH = Math.max(1, opts?.outH | 0);
  const model = opts?.model;
  const tileCount = Math.max(1, Math.min(32, Number(model?.tileCount) | 0));
  const allowed = model?.allowed || [];
  const weights = model?.weights || new Float32Array(tileCount);
  const pins = Array.isArray(opts?.pins) ? opts.pins : [];
  const maxAttempts = Math.max(1, Math.floor(Number(opts?.maxAttempts ?? 8) || 8));

  const baseSeedU32 = (typeof opts?.seed === 'number') ? (opts.seed >>> 0) : hashStringToU32(String(opts?.seed ?? 'wfc'));

  const ALL = (tileCount >= 32) ? 0xFFFFFFFF >>> 0 : ((1 << tileCount) - 1) >>> 0;
  const cellCount = outW * outH;

  const pinMasks = new Map(); // idx -> mask
  for (const p of pins) {
    const x = p?.x | 0;
    const y = p?.y | 0;
    const t = p?.tile | 0;
    if (x < 0 || y < 0 || x >= outW || y >= outH) continue;
    if (t < 0 || t >= tileCount) continue;
    pinMasks.set(y * outW + x, ((1 << t) >>> 0));
  }

  const pickMinEntropyCell = (domains, rand01) => {
    let bestIdx = -1;
    let bestSize = 999;
    // Tie-break randomness: reservoir sample among equals.
    let ties = 0;
    for (let i = 0; i < domains.length; i++) {
      const m = domains[i] >>> 0;
      const c = popcount32(m);
      if (c <= 1) continue;
      if (c < bestSize) {
        bestSize = c;
        bestIdx = i;
        ties = 1;
      } else if (c === bestSize) {
        ties++;
        if (rand01() < (1 / ties)) bestIdx = i;
      }
    }
    return bestIdx;
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rand = mulberry32((baseSeedU32 ^ ((attempt + 1) * 0x9E3779B9)) >>> 0);
    const domains = new Uint32Array(cellCount);
    for (let i = 0; i < cellCount; i++) domains[i] = ALL;
    // Apply pins.
    for (const [idx, m] of pinMasks.entries()) domains[idx] = m >>> 0;

    /** @type {number[]} */
    const queue = [];
    // Seed queue with pinned cells to propagate constraints early.
    for (const idx of pinMasks.keys()) queue.push(idx | 0);

    const enqueueNeighbors = (idx) => {
      const x = idx % outW;
      const y = Math.floor(idx / outW);
      for (let d = 0; d < 4; d++) {
        const nx = x + DIRS[d].dx;
        const ny = y + DIRS[d].dy;
        if (nx < 0 || ny < 0 || nx >= outW || ny >= outH) continue;
        queue.push(ny * outW + nx);
      }
    };

    const propagateFrom = (srcIdx) => {
      const sx = srcIdx % outW;
      const sy = Math.floor(srcIdx / outW);
      const srcDomain = domains[srcIdx] >>> 0;
      if (!srcDomain) return false;

      for (let d = 0; d < 4; d++) {
        const nx = sx + DIRS[d].dx;
        const ny = sy + DIRS[d].dy;
        if (nx < 0 || ny < 0 || nx >= outW || ny >= outH) continue;
        const nIdx = ny * outW + nx;

        // Neighbor domain must be compatible with *some* choice in srcDomain in direction d.
        const allowedMask = domainToAllowedNeighborMask(srcDomain, d, allowed);
        const old = domains[nIdx] >>> 0;
        const next = (old & allowedMask) >>> 0;
        if (next === old) continue;

        // If neighbor is pinned, don't change it (but allow contradictions to be detected).
        const pin = pinMasks.get(nIdx);
        if (pin != null) {
          // If pin conflicts with constraints, contradiction.
          if (((pin >>> 0) & allowedMask) === 0) return false;
          continue;
        }

        domains[nIdx] = next >>> 0;
        if (!next) return false;
        enqueueNeighbors(nIdx);
      }
      return true;
    };

    // Initial propagation from pins.
    let ok = true;
    while (queue.length && ok) {
      const idx = queue.pop() | 0;
      ok = propagateFrom(idx);
    }
    if (!ok) continue;

    // Main collapse loop.
    for (;;) {
      const idx = pickMinEntropyCell(domains, rand);
      if (idx === -1) break; // all collapsed

      const domain = domains[idx] >>> 0;
      const choice = pickWeightedBitFromMask(domain, weights, rand);
      if (choice < 0) { ok = false; break; }
      domains[idx] = ((1 << choice) >>> 0);
      enqueueNeighbors(idx);

      while (queue.length && ok) {
        const j = queue.pop() | 0;
        ok = propagateFrom(j);
      }
      if (!ok) break;
    }

    if (!ok) continue;

    // Emit collapsed tiles.
    const out = new Uint8Array(cellCount);
    for (let i = 0; i < cellCount; i++) {
      const m = domains[i] >>> 0;
      const t = lowestBitIndex(m);
      if (t < 0) { ok = false; break; }
      out[i] = t & 255;
    }
    if (!ok) continue;
    return { ok: true, attempt: attempt + 1, tiles: out, width: outW, height: outH };
  }

  return { ok: false, attempt: maxAttempts, tiles: new Uint8Array(outW * outH), width: outW, height: outH };
}

