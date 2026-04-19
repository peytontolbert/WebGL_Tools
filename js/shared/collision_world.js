import * as THREE from 'three';

const RESUME_SHOWCASE_COLLIDER_ALLOWLIST = [
  /^resume_wall_[nsew]$/,
  /^lab_wall_[nsew]$/,
  /^pavilion_(projects|experience|about|contact)_(north|south|south_l|south_r|west|east)$/,
];

function finiteBox(box) {
  if (!box?.min || !box?.max) return false;
  const vals = [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z];
  return vals.every((v) => Number.isFinite(Number(v)));
}

function boxSize(box) {
  return {
    x: (Number(box?.max?.x) || 0) - (Number(box?.min?.x) || 0),
    y: (Number(box?.max?.y) || 0) - (Number(box?.min?.y) || 0),
    z: (Number(box?.max?.z) || 0) - (Number(box?.min?.z) || 0),
  };
}

function clampAxis(v, lo, hi) {
  return Math.max(Number(lo) || 0, Math.min(Number(hi) || 0, Number(v) || 0));
}

function boxLooksLikeFloorSlab(box, yFeet) {
  const s = boxSize(box);
  return s.y < 0.35 && (Number(box?.max?.y) || 0) <= ((Number(yFeet) || 0) + 0.30);
}

function hitCircleAabbXZ(x, z, radius, box) {
  const min = box.min;
  const max = box.max;
  const qx = clampAxis(x, min.x, max.x);
  const qz = clampAxis(z, min.z, max.z);
  const dx = x - qx;
  const dz = z - qz;
  return (dx * dx + dz * dz) < (radius * radius);
}

/**
 * Build world-space AABBs from mesh/object sources.
 * @param {{ sources:any[], worldRoot?:any }} opts
 * @returns {THREE.Box3[]}
 */
export function buildObstacleBoxesFromSources(opts = {}) {
  const src = Array.isArray(opts?.sources) ? opts.sources : [];
  const worldRoot = opts?.worldRoot;
  try { worldRoot?.updateMatrixWorld?.(true); } catch { /* ignore */ }

  /** @type {THREE.Box3[]} */
  const out = [];
  const dedupe = new Set();
  for (const o of src) {
    if (!o) continue;
    try {
      const b = new THREE.Box3().setFromObject(o);
      if (!finiteBox(b)) continue;
      const s = boxSize(b);
      if (s.x <= 1e-6 || s.y <= 1e-6 || s.z <= 1e-6) continue;
      // Quantized dedupe protects against duplicate mesh references.
      const key = [
        b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z,
      ].map((v) => Math.round(Number(v) * 1000)).join('|');
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      out.push(b);
    } catch { /* ignore */ }
  }
  return out;
}

/**
 * 2.5D player-style collision test against static + dynamic AABBs.
 * @param {{
 *   x:number, z:number, yFeet:number,
 *   radius:number, height:number,
 *   staticBoxes?:THREE.Box3[], dynamicBoxes?:THREE.Box3[]
 * }} opts
 * @returns {boolean}
 */
export function collidesCircleAgainstBoxes(opts = {}) {
  const x = Number(opts?.x);
  const z = Number(opts?.z);
  const yFeet = Number(opts?.yFeet);
  const radius = Math.max(0.05, Number(opts?.radius) || 0.35);
  const height = Math.max(0.5, Number(opts?.height) || 1.7);
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(yFeet)) return false;

  const bottom = yFeet + 0.05;
  const top = yFeet + height;
  const staticBoxes = Array.isArray(opts?.staticBoxes) ? opts.staticBoxes : [];
  const dynamicBoxes = Array.isArray(opts?.dynamicBoxes) ? opts.dynamicBoxes : [];
  if (!staticBoxes.length && !dynamicBoxes.length) return false;

  const hits = (box) => {
    if (!finiteBox(box)) return false;
    if (boxLooksLikeFloorSlab(box, yFeet)) return false;
    if (!(bottom < box.max.y && top > box.min.y)) return false;
    return hitCircleAabbXZ(x, z, radius, box);
  };
  for (const b of staticBoxes) {
    if (hits(b)) return true;
  }
  for (const b of dynamicBoxes) {
    if (hits(b)) return true;
  }
  return false;
}

/**
 * Restrict showcase collisions to structural walls only.
 * @param {any[]} sources
 * @returns {any[]}
 */
export function filterResumeShowcaseColliderSources(sources) {
  const src = Array.isArray(sources) ? sources : [];
  return src.filter((m) => {
    const n = String(m?.name || '');
    return RESUME_SHOWCASE_COLLIDER_ALLOWLIST.some((re) => re.test(n));
  });
}

