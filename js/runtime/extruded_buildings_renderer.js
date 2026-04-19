import { ShaderProgram } from './shader_program.js';

const VS = `#version 300 es
precision highp float;

in vec3 aPos;
in vec3 aNrm;
in vec4 aCol;

uniform mat4 uViewProjection;

out vec3 vN;
out vec4 vC;

void main() {
  vN = aNrm;
  vC = aCol;
  gl_Position = uViewProjection * vec4(aPos, 1.0);
}
`;

const FS = `#version 300 es
precision mediump float;
in vec3 vN;
in vec4 vC;
out vec4 fragColor;

uniform vec3 uLightDir;

void main() {
  vec3 N = normalize(vN);
  vec3 L = normalize(uLightDir);
  float ndl = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);
  float ambient = 0.22;
  float lit = ambient + (1.0 - ambient) * ndl;
  fragColor = vec4(vC.rgb * lit, vC.a);
}
`;

function _signedArea2(points) {
  // points: [{x,z}, ...] assumed closed or open; we treat as open loop.
  let a = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const q = points[(i + 1) % n];
    a += (p.x * q.z - q.x * p.z);
  }
  return a; // 2*area
}

function _isPointInTri2D(px, pz, ax, az, bx, bz, cx, cz) {
  // Barycentric in XZ
  const v0x = cx - ax, v0z = cz - az;
  const v1x = bx - ax, v1z = bz - az;
  const v2x = px - ax, v2z = pz - az;

  const dot00 = v0x * v0x + v0z * v0z;
  const dot01 = v0x * v1x + v0z * v1z;
  const dot02 = v0x * v2x + v0z * v2z;
  const dot11 = v1x * v1x + v1z * v1z;
  const dot12 = v1x * v2x + v1z * v2z;
  const denom = dot00 * dot11 - dot01 * dot01;
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-12) return false;
  const inv = 1.0 / denom;
  const u = (dot11 * dot02 - dot01 * dot12) * inv;
  const v = (dot00 * dot12 - dot01 * dot02) * inv;
  return (u >= -1e-6) && (v >= -1e-6) && (u + v <= 1.0 + 1e-6);
}

function triangulateSimplePolygonEarclip(points) {
  // points: [{x,z}, ...] CCW, no holes. Returns indices array (triples), or null on failure.
  const n0 = points.length;
  if (n0 < 3) return null;

  // Index list (mutable)
  const idx = [];
  for (let i = 0; i < n0; i++) idx.push(i);

  /** @type {number[]} */
  const out = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 100000) {
    let earFound = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k - 1 + idx.length) % idx.length];
      const i1 = idx[k];
      const i2 = idx[(k + 1) % idx.length];
      const a = points[i0], b = points[i1], c = points[i2];

      // Convex test (CCW polygon => convex if cross > 0)
      const abx = b.x - a.x, abz = b.z - a.z;
      const bcx = c.x - b.x, bcz = c.z - b.z;
      const cross = abx * bcz - abz * bcx;
      if (!(cross > 1e-10)) continue;

      // Contains any other point?
      let contains = false;
      for (let j = 0; j < idx.length; j++) {
        const ii = idx[j];
        if (ii === i0 || ii === i1 || ii === i2) continue;
        const p = points[ii];
        if (_isPointInTri2D(p.x, p.z, a.x, a.z, b.x, b.z, c.x, c.z)) { contains = true; break; }
      }
      if (contains) continue;

      // Ear clipped
      out.push(i0, i1, i2);
      idx.splice(k, 1);
      earFound = true;
      break;
    }
    if (!earFound) return null;
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

function _normalize3(x, y, z) {
  const l = Math.hypot(x, y, z);
  if (!Number.isFinite(l) || l <= 1e-12) return [0, 1, 0];
  return [x / l, y / l, z / l];
}

function _cleanRingXZ(ringXZ, { minPoints = 3, eps = 1e-4 } = {}) {
  // ringXZ: array of [x,z] possibly closed; returns array of {x,z}
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
  if (out.length < minPoints) return [];

  // Remove collinear points (cheap)
  const out2 = [];
  for (let i = 0; i < out.length; i++) {
    const prev = out[(i - 1 + out.length) % out.length];
    const cur = out[i];
    const next = out[(i + 1) % out.length];
    const v0x = cur.x - prev.x, v0z = cur.z - prev.z;
    const v1x = next.x - cur.x, v1z = next.z - cur.z;
    const cross = v0x * v1z - v0z * v1x;
    if (Math.abs(cross) < 1e-10 && (v0x * v0x + v0z * v0z) > 1e-10 && (v1x * v1x + v1z * v1z) > 1e-10) continue;
    out2.push(cur);
  }
  return (out2.length >= minPoints) ? out2 : out;
}

export function buildExtrudedBuildingsMesh(buildings, {
  maxBuildings = 15000,
  wallColorScale = 0.92,
  roofColorScale = 1.0,
} = {}) {
  // buildings: [{ ringXZ: [[x,z],...], minY, maxY, color:[r,g,b,a] }]
  const P = [];
  const N = [];
  const C = [];
  /** @type {number[]} */
  const I = [];
  let vtx = 0;

  const count = Math.min(Math.max(0, buildings?.length || 0), Math.max(0, maxBuildings | 0) || 0);
  for (let bi = 0; bi < count; bi++) {
    const b = buildings[bi];
    const ring = _cleanRingXZ(b?.ringXZ);
    if (ring.length < 3) continue;
    let minY = Number(b?.minY ?? 0);
    let maxY = Number(b?.maxY ?? 10);
    if (!Number.isFinite(minY)) minY = 0;
    if (!Number.isFinite(maxY)) maxY = minY + 7.5;
    if (maxY <= minY + 0.25) maxY = minY + 0.25;

    const col = Array.isArray(b?.color) ? b.color : [0.72, 0.72, 0.74, 0.9];
    const r = Number(col[0] ?? 0.7), g = Number(col[1] ?? 0.7), bb = Number(col[2] ?? 0.7), a = Number(col[3] ?? 0.9);
    const wallCol = [r * wallColorScale, g * wallColorScale, bb * wallColorScale, a];
    const roofCol = [r * roofColorScale, g * roofColorScale, bb * roofColorScale, a];

    // Ensure CCW
    if (_signedArea2(ring) < 0) ring.reverse();

    // Roof vertices
    const baseIndex = vtx;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      P.push(p.x, maxY, p.z);
      N.push(0, 1, 0);
      C.push(roofCol[0], roofCol[1], roofCol[2], roofCol[3]);
      vtx++;
    }

    // Triangulate roof
    const tris = triangulateSimplePolygonEarclip(ring);
    if (tris) {
      for (let i = 0; i < tris.length; i += 3) {
        I.push(baseIndex + tris[i], baseIndex + tris[i + 1], baseIndex + tris[i + 2]);
      }
    }

    // Walls: per edge create 4 verts + 2 tris (indexed)
    for (let i = 0; i < ring.length; i++) {
      const a0 = ring[i];
      const a1 = ring[(i + 1) % ring.length];
      const dx = a1.x - a0.x;
      const dz = a1.z - a0.z;
      const len = Math.hypot(dx, dz);
      if (!Number.isFinite(len) || len < 0.25) continue;

      // Outward normal (for CCW winding)
      const [nx, ny, nz] = _normalize3(dz, 0, -dx);

      const iBase = vtx;
      // bottom a0
      P.push(a0.x, minY, a0.z);
      N.push(nx, ny, nz);
      C.push(wallCol[0], wallCol[1], wallCol[2], wallCol[3]);
      // bottom a1
      P.push(a1.x, minY, a1.z);
      N.push(nx, ny, nz);
      C.push(wallCol[0], wallCol[1], wallCol[2], wallCol[3]);
      // top a1
      P.push(a1.x, maxY, a1.z);
      N.push(nx, ny, nz);
      C.push(wallCol[0], wallCol[1], wallCol[2], wallCol[3]);
      // top a0
      P.push(a0.x, maxY, a0.z);
      N.push(nx, ny, nz);
      C.push(wallCol[0], wallCol[1], wallCol[2], wallCol[3]);
      vtx += 4;

      // Two triangles (CCW when viewed from outside)
      I.push(iBase + 0, iBase + 1, iBase + 2);
      I.push(iBase + 0, iBase + 2, iBase + 3);
    }
  }

  const positions = new Float32Array(P);
  const normals = new Float32Array(N);
  const colors = new Float32Array(C);
  const indices = new Uint32Array(I);
  return { positions, normals, colors, indices, vertexCount: Math.floor(positions.length / 3), indexCount: indices.length };
}

export class ExtrudedBuildingsRenderer {
  constructor(gl) {
    this.gl = gl;
    this.program = new ShaderProgram(gl);
    this.ready = false;
    this._vao = null;
    this._vboPos = null;
    this._vboNrm = null;
    this._vboCol = null;
    this._ibo = null;
    this._indexCount = 0;
    this.u = {};
  }

  async init() {
    const ok = await this.program.createProgram(VS, FS);
    if (!ok) throw new Error('ExtrudedBuildings shader failed');
    const gl = this.gl;
    this.u.uViewProjection = this.program.u('uViewProjection');
    this.u.uLightDir = this.program.u('uLightDir');

    const aPos = this.program.a('aPos');
    const aNrm = this.program.a('aNrm');
    const aCol = this.program.a('aCol');

    this._vao = gl.createVertexArray();
    this._vboPos = gl.createBuffer();
    this._vboNrm = gl.createBuffer();
    this._vboCol = gl.createBuffer();
    this._ibo = gl.createBuffer();

    gl.bindVertexArray(this._vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this._vboPos);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.DYNAMIC_DRAW);
    if (aPos !== -1) {
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(aPos, 0);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this._vboNrm);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.DYNAMIC_DRAW);
    if (aNrm !== -1) {
      gl.enableVertexAttribArray(aNrm);
      gl.vertexAttribPointer(aNrm, 3, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(aNrm, 0);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this._vboCol);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.DYNAMIC_DRAW);
    if (aCol !== -1) {
      gl.enableVertexAttribArray(aCol);
      gl.vertexAttribPointer(aCol, 4, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(aCol, 0);
    }

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(0), gl.DYNAMIC_DRAW);

    gl.bindVertexArray(null);
    this._indexCount = 0;
    this.ready = true;
  }

  get hasMesh() {
    return this.ready && (this._indexCount > 0);
  }

  setMesh({ positions, normals, colors, indices }) {
    if (!this.ready) return;
    const gl = this.gl;
    const p = (positions instanceof Float32Array) ? positions : new Float32Array(positions || []);
    const n = (normals instanceof Float32Array) ? normals : new Float32Array(normals || []);
    const c = (colors instanceof Float32Array) ? colors : new Float32Array(colors || []);
    const i = (indices instanceof Uint32Array) ? indices : new Uint32Array(indices || []);

    this._indexCount = Math.max(0, i.length | 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this._vboPos);
    gl.bufferData(gl.ARRAY_BUFFER, p, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vboNrm);
    gl.bufferData(gl.ARRAY_BUFFER, n, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vboCol);
    gl.bufferData(gl.ARRAY_BUFFER, c, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, i, gl.DYNAMIC_DRAW);
  }

  clear() {
    this.setMesh({ positions: new Float32Array(0), normals: new Float32Array(0), colors: new Float32Array(0), indices: new Uint32Array(0) });
  }

  render(viewProjection, { lightDir = [0.35, 0.85, 0.25] } = {}) {
    if (!this.ready || this._indexCount <= 0) return;
    const gl = this.gl;
    gl.useProgram(this.program.program);
    gl.uniformMatrix4fv(this.u.uViewProjection, false, viewProjection);
    gl.uniform3f(this.u.uLightDir, lightDir[0] ?? 0.3, lightDir[1] ?? 0.9, lightDir[2] ?? 0.2);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.bindVertexArray(this._vao);
    gl.drawElements(gl.TRIANGLES, this._indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    gl.disable(gl.CULL_FACE);
  }

  dispose() {
    const gl = this.gl;
    try { if (this._vboPos) gl.deleteBuffer(this._vboPos); } catch { /* ignore */ }
    try { if (this._vboNrm) gl.deleteBuffer(this._vboNrm); } catch { /* ignore */ }
    try { if (this._vboCol) gl.deleteBuffer(this._vboCol); } catch { /* ignore */ }
    try { if (this._ibo) gl.deleteBuffer(this._ibo); } catch { /* ignore */ }
    try { if (this._vao) gl.deleteVertexArray(this._vao); } catch { /* ignore */ }
    this._vboPos = this._vboNrm = this._vboCol = this._ibo = this._vao = null;
    this._indexCount = 0;
    this.ready = false;
  }
}


