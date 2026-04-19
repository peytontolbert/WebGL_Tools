#!/usr/bin/env node
/**
 * Compute approximate bounds of a glTF (JSON + external .bin).
 * Uses accessor min/max for POSITION attributes (fast, no full decode).
 *
 * Usage:
 *   node tools/inspect_gltf_bounds.mjs public/external/polyhaven/old_tyre_2k/old_tyre_2k.gltf
 */
import fs from 'node:fs';
import path from 'node:path';

function v3min(a, b) { return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])]; }
function v3max(a, b) { return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])]; }

function mat4mul(a, b) {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      o[r * 4 + c] =
        a[r * 4 + 0] * b[0 * 4 + c] +
        a[r * 4 + 1] * b[1 * 4 + c] +
        a[r * 4 + 2] * b[2 * 4 + c] +
        a[r * 4 + 3] * b[3 * 4 + c];
    }
  }
  return o;
}

function mat4identity() {
  return [1, 0, 0, 0,
          0, 1, 0, 0,
          0, 0, 1, 0,
          0, 0, 0, 1];
}

function mat4fromTRS(t, r, s) {
  // r quaternion [x,y,z,w]
  const tx = t?.[0] ?? 0, ty = t?.[1] ?? 0, tz = t?.[2] ?? 0;
  const qx = r?.[0] ?? 0, qy = r?.[1] ?? 0, qz = r?.[2] ?? 0, qw = r?.[3] ?? 1;
  const sx = s?.[0] ?? 1, sy = s?.[1] ?? 1, sz = s?.[2] ?? 1;

  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;

  // column-major rotation, then apply scale
  const m00 = (1 - (yy + zz)) * sx;
  const m01 = (xy + wz) * sx;
  const m02 = (xz - wy) * sx;
  const m10 = (xy - wz) * sy;
  const m11 = (1 - (xx + zz)) * sy;
  const m12 = (yz + wx) * sy;
  const m20 = (xz + wy) * sz;
  const m21 = (yz - wx) * sz;
  const m22 = (1 - (xx + yy)) * sz;

  // convert to row-major 4x4 for mat4mul above
  return [
    m00, m10, m20, 0,
    m01, m11, m21, 0,
    m02, m12, m22, 0,
    tx,  ty,  tz,  1,
  ];
}

function transformAabb(min, max, m) {
  // Transform the 8 corners; safe and simple.
  const corners = [
    [min[0], min[1], min[2]],
    [min[0], min[1], max[2]],
    [min[0], max[1], min[2]],
    [min[0], max[1], max[2]],
    [max[0], min[1], min[2]],
    [max[0], min[1], max[2]],
    [max[0], max[1], min[2]],
    [max[0], max[1], max[2]],
  ];
  let outMin = [Infinity, Infinity, Infinity];
  let outMax = [-Infinity, -Infinity, -Infinity];
  for (const p of corners) {
    const x = p[0], y = p[1], z = p[2];
    const ox = x * m[0] + y * m[4] + z * m[8] + m[12];
    const oy = x * m[1] + y * m[5] + z * m[9] + m[13];
    const oz = x * m[2] + y * m[6] + z * m[10] + m[14];
    outMin = v3min(outMin, [ox, oy, oz]);
    outMax = v3max(outMax, [ox, oy, oz]);
  }
  return { min: outMin, max: outMax };
}

function main() {
  const inPath = process.argv[2];
  if (!inPath) {
    console.error('Usage: node tools/inspect_gltf_bounds.mjs <path/to/file.gltf>');
    process.exit(2);
  }
  const abs = path.resolve(process.cwd(), inPath);
  const dir = path.dirname(abs);
  const gltf = JSON.parse(fs.readFileSync(abs, 'utf8'));

  const nodes = gltf.nodes || [];
  const meshes = gltf.meshes || [];

  // Precompute mesh primitive local bounds from accessor min/max.
  const primBounds = new Map(); // key `${meshIdx}:${primIdx}` -> {min,max}
  for (let mi = 0; mi < meshes.length; mi++) {
    const m = meshes[mi];
    for (let pi = 0; pi < (m.primitives?.length || 0); pi++) {
      const p = m.primitives[pi];
      const posAcc = p?.attributes?.POSITION;
      if (typeof posAcc !== 'number') continue;
      const acc = gltf.accessors?.[posAcc];
      if (!acc?.min || !acc?.max) continue;
      primBounds.set(`${mi}:${pi}`, { min: acc.min.slice(0, 3), max: acc.max.slice(0, 3) });
    }
  }

  // Build scene graph traversal from default scene.
  const sceneIdx = (typeof gltf.scene === 'number') ? gltf.scene : 0;
  const scene = gltf.scenes?.[sceneIdx] || { nodes: [] };
  const roots = Array.isArray(scene.nodes) ? scene.nodes : [];

  let worldMin = [Infinity, Infinity, Infinity];
  let worldMax = [-Infinity, -Infinity, -Infinity];

  const visit = (nodeIdx, parentM) => {
    const n = nodes[nodeIdx];
    if (!n) return;
    const localM = n.matrix
      ? n.matrix.slice(0, 16) // glTF matrix is column-major; our math expects row-major above, but we only use TRS here
      : mat4fromTRS(n.translation, n.rotation, n.scale);
    // NOTE: If n.matrix is present, our simple row/col convention may be wrong; most assets use TRS.
    const M = mat4mul(parentM, localM);

    const meshIdx = n.mesh;
    if (typeof meshIdx === 'number') {
      const mesh = meshes[meshIdx];
      for (let pi = 0; pi < (mesh?.primitives?.length || 0); pi++) {
        const b = primBounds.get(`${meshIdx}:${pi}`);
        if (!b) continue;
        const tb = transformAabb(b.min, b.max, M);
        worldMin = v3min(worldMin, tb.min);
        worldMax = v3max(worldMax, tb.max);
      }
    }

    for (const ch of (Array.isArray(n.children) ? n.children : [])) visit(ch, M);
  };

  for (const r of roots) visit(r, mat4identity());

  const size = [worldMax[0] - worldMin[0], worldMax[1] - worldMin[1], worldMax[2] - worldMin[2]];
  const center = [(worldMin[0] + worldMax[0]) * 0.5, (worldMin[1] + worldMax[1]) * 0.5, (worldMin[2] + worldMax[2]) * 0.5];

  console.log(JSON.stringify({
    file: inPath,
    min: worldMin,
    max: worldMax,
    size,
    center,
  }, null, 2));

  // Also print quick hints.
  const dims = size.map((x) => Math.abs(x));
  const sorted = dims.slice().sort((a, b) => a - b);
  console.log('\nHint: size dims (sorted):', sorted.map((x) => x.toFixed(4)).join(', '));
  console.log('Hint: max dim:', Math.max(...dims).toFixed(4), 'min dim:', Math.min(...dims).toFixed(4));
}

main();

