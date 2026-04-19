import { ShaderProgram } from './shader_program.js';

// Packed instanced-box tiles renderer (for BUI2).
// - Keeps per-building instance data packed (u16/i16/u8) on the GPU.
// - Decodes in the vertex shader with per-chunk uniforms.
//
// Instance record layout (18 bytes), repeated count times:
//   tx01,ty01,tz01,sx01,sy01,sz01: u16 (normalized)  -> 0..1
//   yaw01: i16 (normalized) -> -1..1, mapped to [-pi..pi]
//   rgba: u8 normalized -> 0..1

const VS = `#version 300 es
precision highp float;

in vec3 aPos;
in vec3 aNrm;

// Packed instance attributes (normalized by GL):
in vec3 iTranslate01;
in vec3 iScale01;
in float iYaw01;
in vec4 iColor01;

uniform mat4 uViewProjection;
uniform vec3 uLightDir;

// Per-chunk decode params:
uniform float uChunkMinX;
uniform float uChunkMinZ;
uniform float uChunkSize;
uniform float uMaxTy;
uniform float uMaxScale;
uniform float uChunkFade;
uniform float uGroundY;
uniform vec3 uCameraPos;
uniform vec3 uFogColor;
uniform vec2 uFogParams; // start, end (meters)

out vec3 vN;
out vec4 vC;
out vec3 vWorldPos;
flat out float vSeed;

mat3 rotY(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat3(
    c, 0.0, -s,
    0.0, 1.0, 0.0,
    s, 0.0, c
  );
}

void main() {
  vec3 translate = vec3(
    uChunkMinX + iTranslate01.x * uChunkSize,
    iTranslate01.y * uMaxTy + uGroundY,
    uChunkMinZ + iTranslate01.z * uChunkSize
  );
  vec3 scale = iScale01 * uMaxScale;
  float yaw = iYaw01 * 3.141592653589793;

  mat3 R = rotY(yaw);
  vec3 p = (R * (aPos * scale)) + translate;
  vec3 n = normalize(R * aNrm);
  vN = n;
  vC = vec4(iColor01.rgb, iColor01.a * uChunkFade);
  vWorldPos = p;
  // Stable per-instance seed (decoded translate).
  vSeed = fract(sin(dot(translate.xz, vec2(12.9898, 78.233))) * 43758.5453);
  gl_Position = uViewProjection * vec4(p, 1.0);
}
`;

const FS = `#version 300 es
precision mediump float;
in vec3 vN;
in vec4 vC;
in vec3 vWorldPos;
flat in float vSeed;
out vec4 fragColor;

uniform vec3 uLightDir;
uniform vec3 uCameraPos;
uniform vec3 uFogColor;
uniform vec2 uFogParams; // start, end

// 4x4 Bayer matrix threshold in [0..1).
// Screen-door transparency: avoids blending + sorting issues and keeps depth correct.
float bayer4x4(vec2 p) {
  // p is pixel coords; convert to 0..3
  int x = int(mod(p.x, 4.0));
  int y = int(mod(p.y, 4.0));
  int i = x + y * 4;
  // Values 0..15
  int v = 0;
  if (i == 0) v = 0;
  else if (i == 1) v = 8;
  else if (i == 2) v = 2;
  else if (i == 3) v = 10;
  else if (i == 4) v = 12;
  else if (i == 5) v = 4;
  else if (i == 6) v = 14;
  else if (i == 7) v = 6;
  else if (i == 8) v = 3;
  else if (i == 9) v = 11;
  else if (i == 10) v = 1;
  else if (i == 11) v = 9;
  else if (i == 12) v = 15;
  else if (i == 13) v = 7;
  else if (i == 14) v = 13;
  else v = 5;
  return (float(v) + 0.5) / 16.0;
}

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7)) + vSeed * 19.19) * 43758.5453);
}

void main() {
  // Dithered crossfade (alpha in vC.a). We keep output alpha=1 so the pass stays "opaque" for depth.
  float a = clamp(vC.a, 0.0, 1.0);
  if (a < 0.999) {
    float t = bayer4x4(gl_FragCoord.xy);
    if (a < t) discard;
  }
  vec3 N = normalize(vN);
  vec3 L = normalize(uLightDir);
  float ndl = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);
  float ambient = 0.22;
  float lit = ambient + (1.0 - ambient) * ndl;
  vec3 col = vC.rgb * lit;

  // Procedural facade/window hint (helps boxes read as buildings).
  float isVertical = 1.0 - smoothstep(0.35, 0.55, abs(N.y));
  if (N.y > 0.65) col *= 0.90;
  if (isVertical > 0.001) {
    vec2 uv;
    if (abs(N.x) > abs(N.z)) uv = vec2(vWorldPos.z, vWorldPos.y);
    else uv = vec2(vWorldPos.x, vWorldPos.y);

    vec2 freq = vec2(0.45, 0.33); // cells per meter
    vec2 g = uv * freq + vec2(vSeed * 11.0, 0.0);
    vec2 cell = fract(g);
    vec2 id = floor(g);

    float wx = smoothstep(0.16, 0.20, cell.x) * (1.0 - smoothstep(0.80, 0.84, cell.x));
    float wy = smoothstep(0.18, 0.22, cell.y) * (1.0 - smoothstep(0.86, 0.90, cell.y));
    float win = wx * wy;
    float rnd = hash21(id);
    float litW = step(0.62, rnd);
    vec3 warm = vec3(1.00, 0.86, 0.68);
    vec3 winCol = mix(col * 0.45, warm * 0.35, litW);
    float stripe = smoothstep(0.48, 0.50, abs(cell.x - 0.5));
    stripe *= (1.0 - smoothstep(0.50, 0.52, abs(cell.x - 0.5)));
    float detail = clamp(win + stripe * 0.35, 0.0, 1.0);
    col = mix(col * 0.92, winCol, detail);
    float h = clamp((vWorldPos.y + 2.0) / 55.0, 0.0, 1.0);
    col *= mix(0.86, 1.05, h);
  }

  // Aerial perspective / fog (very helpful for huge metros + hides LOD transitions).
  float fogStart = max(0.0, uFogParams.x);
  float fogEnd = max(fogStart + 1.0, uFogParams.y);
  float d = distance(vWorldPos, uCameraPos);
  float f = clamp((d - fogStart) / (fogEnd - fogStart), 0.0, 1.0);
  // Slightly curved ramp feels less “linear wall”.
  f = f * f;
  col = mix(col, uFogColor, f);

  fragColor = vec4(col, 1.0);
}
`;

function createCube() {
  const P = [];
  const N = [];
  const pushFace = (nx, ny, nz, a, b, c, d) => {
    P.push(...a, ...b, ...c, ...a, ...c, ...d);
    for (let i = 0; i < 6; i++) N.push(nx, ny, nz);
  };
  const s = 0.5;
  const v000 = [-s, -s, -s], v001 = [-s, -s, s], v010 = [-s, s, -s], v011 = [-s, s, s];
  const v100 = [s, -s, -s], v101 = [s, -s, s], v110 = [s, s, -s], v111 = [s, s, s];
  pushFace(1, 0, 0, v100, v110, v111, v101);
  pushFace(-1, 0, 0, v000, v001, v011, v010);
  pushFace(0, 1, 0, v010, v011, v111, v110);
  pushFace(0, -1, 0, v000, v100, v101, v001);
  pushFace(0, 0, 1, v001, v101, v111, v011);
  pushFace(0, 0, -1, v000, v010, v110, v100);
  return {
    positions: new Float32Array(P),
    normals: new Float32Array(N),
    vertexCount: P.length / 3,
  };
}

/**
 * @typedef {{
 *   key: string,
 *   magic: 'BUI2',
 *   count: number,
 *   header: { chunkMinX:number, chunkMinZ:number, chunkSize:number, maxTy:number, maxScale:number },
 *   data: Uint8Array,
 * }} PackedChunk
 */

export class InstancedBoxTilesRenderer {
  constructor(gl) {
    this.gl = gl;
    this.program = new ShaderProgram(gl);
    this.ready = false;
    this._vao = null;
    this._vboPos = null;
    this._vboNrm = null;
    this._vertCount = 0;

    /** @type {Map<string, { vbo: WebGLBuffer, count: number, header: any }>} */
    this._chunks = new Map();
    this._chunkOrder = [];
    this._instCountTotal = 0;
    this.u = {};
  }

  async init() {
    const ok = await this.program.createProgram(VS, FS);
    if (!ok) throw new Error('InstancedBoxTilesRenderer shader failed');
    const gl = this.gl;

    this.u.uViewProjection = this.program.u('uViewProjection');
    this.u.uLightDir = this.program.u('uLightDir');
    this.u.uChunkMinX = this.program.u('uChunkMinX');
    this.u.uChunkMinZ = this.program.u('uChunkMinZ');
    this.u.uChunkSize = this.program.u('uChunkSize');
    this.u.uMaxTy = this.program.u('uMaxTy');
    this.u.uMaxScale = this.program.u('uMaxScale');
    this.u.uChunkFade = this.program.u('uChunkFade');
    this.u.uGroundY = this.program.u('uGroundY');
    this.u.uCameraPos = this.program.u('uCameraPos');
    this.u.uFogColor = this.program.u('uFogColor');
    this.u.uFogParams = this.program.u('uFogParams');

    const aPos = this.program.a('aPos');
    const aNrm = this.program.a('aNrm');
    const iTranslate01 = this.program.a('iTranslate01');
    const iScale01 = this.program.a('iScale01');
    const iYaw01 = this.program.a('iYaw01');
    const iColor01 = this.program.a('iColor01');

    const cube = createCube();
    this._vertCount = cube.vertexCount;

    this._vao = gl.createVertexArray();
    this._vboPos = gl.createBuffer();
    this._vboNrm = gl.createBuffer();

    gl.bindVertexArray(this._vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this._vboPos);
    gl.bufferData(gl.ARRAY_BUFFER, cube.positions, gl.STATIC_DRAW);
    if (aPos !== -1) {
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(aPos, 0);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this._vboNrm);
    gl.bufferData(gl.ARRAY_BUFFER, cube.normals, gl.STATIC_DRAW);
    if (aNrm !== -1) {
      gl.enableVertexAttribArray(aNrm);
      gl.vertexAttribPointer(aNrm, 3, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(aNrm, 0);
    }

    // Instance attributes are configured per-chunk VBO before each draw (since VBO changes).
    this._loc = { iTranslate01, iScale01, iYaw01, iColor01 };

    gl.bindVertexArray(null);
    this.ready = true;
  }

  get totalInstanceCount() {
    return this._instCountTotal;
  }

  /**
   * Replace the set of chunks to render (typically "wanted loaded chunks").
   * This does NOT merge instance data.
   * @param {PackedChunk[]} chunks
   */
  setChunks(chunks) {
    if (!this.ready) return;
    const gl = this.gl;
    const nextKeys = new Set();
    const nextOrder = [];
    let total = 0;
    for (const ch of chunks || []) {
      const key = String(ch?.key || '');
      if (!key) continue;
      if (ch.magic !== 'BUI2') continue;
      const count = Number(ch.count) || 0;
      if (count <= 0) continue;
      if (!(ch.data instanceof Uint8Array)) continue;
      nextKeys.add(key);
      nextOrder.push(key);
      total += count;

      let entry = this._chunks.get(key);
      if (!entry) {
        entry = { vbo: gl.createBuffer(), count: 0, header: null };
        this._chunks.set(key, entry);
      }
      // Upload packed records as-is.
      entry.count = count;
      entry.header = ch.header || null;
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, ch.data, gl.STATIC_DRAW);
    }

    // Delete chunks no longer present.
    for (const [key, entry] of this._chunks.entries()) {
      if (nextKeys.has(key)) continue;
      try { gl.deleteBuffer(entry.vbo); } catch { /* ignore */ }
      this._chunks.delete(key);
    }

    this._chunkOrder = nextOrder;
    this._instCountTotal = total;
  }

  render(viewProjection, { lightDir = [0.35, 0.85, 0.25], fade = null, fog = null, cull = null } = {}) {
    if (!this.ready) return;
    if (this._chunkOrder.length === 0) return;
    const gl = this.gl;

    gl.useProgram(this.program.program);
    gl.uniformMatrix4fv(this.u.uViewProjection, false, viewProjection);
    gl.uniform3f(this.u.uLightDir, lightDir[0] ?? 0.3, lightDir[1] ?? 0.9, lightDir[2] ?? 0.2);
    // Fog defaults are chosen to be "safe" if caller doesn't pass any fog settings.
    const camPos = fog?.cameraPos || [0, 0, 0];
    gl.uniform3f(this.u.uCameraPos, Number(camPos[0]) || 0, Number(camPos[1]) || 0, Number(camPos[2]) || 0);
    const fogCol = fog?.color || [0.70, 0.78, 0.90];
    gl.uniform3f(this.u.uFogColor, Number(fogCol[0]) || 0.7, Number(fogCol[1]) || 0.78, Number(fogCol[2]) || 0.90);
    const fogStart = Number(fog?.start) || 999999;
    const fogEnd = Number(fog?.end) || (fogStart + 1);
    gl.uniform2f(this.u.uFogParams, fogStart, fogEnd);

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    // We rely on dithered discard, not blending.
    try { gl.disable(gl.BLEND); } catch { /* ignore */ }
    gl.bindVertexArray(this._vao);

    const stride = 18;
    const loc = this._loc;
    const camX = Number(fade?.cameraX);
    const camZ = Number(fade?.cameraZ);
    const inner = Number(fade?.inner);
    const outer = Number(fade?.outer);
    const invert = !!fade?.invert;
    const bands = Array.isArray(fade?.bands) ? fade.bands : null;
    const useFadeLegacy = Number.isFinite(camX) && Number.isFinite(camZ) && Number.isFinite(inner) && Number.isFinite(outer) && outer > inner;
    const useFadeBands = Number.isFinite(camX) && Number.isFinite(camZ) && !!bands && bands.length > 0;

    const fadeFactor = (d, inn, out, inv) => {
      const i0 = Number(inn);
      const o0 = Number(out);
      if (!Number.isFinite(i0) || !Number.isFinite(o0) || o0 <= i0) return 1.0;
      let t = (d - i0) / (o0 - i0);
      if (!Number.isFinite(t)) t = 1.0;
      if (t < 0.0) t = 0.0;
      if (t > 1.0) t = 1.0;
      // smoothstep
      t = t * t * (3.0 - 2.0 * t);
      return inv ? (1.0 - t) : t;
    };

    // Optional frustum culling (per-chunk).
    // Uses a conservative bounding sphere around the chunk AABB in XZ and maxTy in Y.
    const doCull = !!cull?.enabled;
    let planes = null;
    const extractPlanes = (m) => {
      // m is column-major (gl-matrix). Planes in form ax+by+cz+d >= 0.
      const p = new Float32Array(24);
      const m00 = m[0], m01 = m[4], m02 = m[8],  m03 = m[12];
      const m10 = m[1], m11 = m[5], m12 = m[9],  m13 = m[13];
      const m20 = m[2], m21 = m[6], m22 = m[10], m23 = m[14];
      const m30 = m[3], m31 = m[7], m32 = m[11], m33 = m[15];
      // left
      p[0] = m30 + m00; p[1] = m31 + m10; p[2] = m32 + m20; p[3] = m33 + m03;
      // right
      p[4] = m30 - m00; p[5] = m31 - m10; p[6] = m32 - m20; p[7] = m33 - m03;
      // bottom
      p[8] = m30 + m01; p[9] = m31 + m11; p[10] = m32 + m21; p[11] = m33 + m13;
      // top
      p[12] = m30 - m01; p[13] = m31 - m11; p[14] = m32 - m21; p[15] = m33 - m13;
      // near
      p[16] = m30 + m02; p[17] = m31 + m12; p[18] = m32 + m22; p[19] = m33 + m23;
      // far
      p[20] = m30 - m02; p[21] = m31 - m12; p[22] = m32 - m22; p[23] = m33 - m23;
      // Normalize
      for (let i = 0; i < 6; i++) {
        const a = p[i * 4 + 0], b = p[i * 4 + 1], cc = p[i * 4 + 2];
        const invLen = 1.0 / Math.max(1e-6, Math.sqrt(a * a + b * b + cc * cc));
        p[i * 4 + 0] *= invLen;
        p[i * 4 + 1] *= invLen;
        p[i * 4 + 2] *= invLen;
        p[i * 4 + 3] *= invLen;
      }
      return p;
    };
    const sphereInFrustum = (p, cx, cy, cz, r) => {
      for (let i = 0; i < 6; i++) {
        const a = p[i * 4 + 0], b = p[i * 4 + 1], cc = p[i * 4 + 2], d = p[i * 4 + 3];
        const dist = a * cx + b * cy + cc * cz + d;
        if (dist < -r) return false;
      }
      return true;
    };
    if (doCull && viewProjection && viewProjection.length === 16) planes = extractPlanes(viewProjection);

    for (let i = 0; i < this._chunkOrder.length; i++) {
      const key = this._chunkOrder[i];
      const entry = this._chunks.get(key);
      if (!entry || entry.count <= 0) continue;
      const h = entry.header || {};

      // Per-chunk uniforms.
      gl.uniform1f(this.u.uChunkMinX, Number(h.chunkMinX) || 0);
      gl.uniform1f(this.u.uChunkMinZ, Number(h.chunkMinZ) || 0);
      gl.uniform1f(this.u.uChunkSize, Number(h.chunkSize) || 512);
      gl.uniform1f(this.u.uMaxTy, Number(h.maxTy) || 256);
      gl.uniform1f(this.u.uMaxScale, Number(h.maxScale) || 256);
      gl.uniform1f(this.u.uGroundY, Number(h.groundY) || 0);
      let f = 1.0;
      if (useFadeLegacy || useFadeBands) {
        const cs = Number(h.chunkSize) || 512;
        const cx = (Number(h.chunkMinX) || 0) + cs * 0.5;
        const cz = (Number(h.chunkMinZ) || 0) + cs * 0.5;
        const dx = cx - camX;
        const dz = cz - camZ;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (useFadeBands) {
          let prod = 1.0;
          for (let bi = 0; bi < bands.length; bi++) {
            const b = bands[bi] || {};
            prod *= fadeFactor(d, b.inner, b.outer, !!b.invert);
          }
          f = prod;
        } else {
          f = fadeFactor(d, inner, outer, invert);
        }
      }
      gl.uniform1f(this.u.uChunkFade, f);

      if (doCull && planes) {
        const cs = Number(h.chunkSize) || 512;
        const cx = (Number(h.chunkMinX) || 0) + cs * 0.5;
        const cz = (Number(h.chunkMinZ) || 0) + cs * 0.5;
        const maxTy = Number(h.maxTy) || 256;
        // Chunk bounds: [min..min+cs] in XZ, [0..maxTy*2] in Y-ish (ty is half-height).
        const cy = maxTy; // conservative center in Y
        const rxz = Math.sqrt(2.0) * (cs * 0.5);
        const ry = maxTy;
        const r = Math.sqrt(rxz * rxz + ry * ry);
        if (!sphereInFrustum(planes, cx, cy, cz, r)) continue;
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, entry.vbo);

      // Configure instance attributes (normalized integer fetch).
      // Layout: 6H (12 bytes), h (2 bytes), 4B (4 bytes) = 18 bytes.
      if (loc.iTranslate01 !== -1) {
        gl.enableVertexAttribArray(loc.iTranslate01);
        gl.vertexAttribPointer(loc.iTranslate01, 3, gl.UNSIGNED_SHORT, true, stride, 0);
        gl.vertexAttribDivisor(loc.iTranslate01, 1);
      }
      if (loc.iScale01 !== -1) {
        gl.enableVertexAttribArray(loc.iScale01);
        gl.vertexAttribPointer(loc.iScale01, 3, gl.UNSIGNED_SHORT, true, stride, 6);
        gl.vertexAttribDivisor(loc.iScale01, 1);
      }
      if (loc.iYaw01 !== -1) {
        gl.enableVertexAttribArray(loc.iYaw01);
        gl.vertexAttribPointer(loc.iYaw01, 1, gl.SHORT, true, stride, 12);
        gl.vertexAttribDivisor(loc.iYaw01, 1);
      }
      if (loc.iColor01 !== -1) {
        gl.enableVertexAttribArray(loc.iColor01);
        gl.vertexAttribPointer(loc.iColor01, 4, gl.UNSIGNED_BYTE, true, stride, 14);
        gl.vertexAttribDivisor(loc.iColor01, 1);
      }

      gl.drawArraysInstanced(gl.TRIANGLES, 0, this._vertCount, entry.count);
    }

    gl.bindVertexArray(null);
    gl.disable(gl.CULL_FACE);
  }

  dispose() {
    const gl = this.gl;
    for (const entry of this._chunks.values()) {
      try { if (entry?.vbo) gl.deleteBuffer(entry.vbo); } catch { /* ignore */ }
    }
    this._chunks.clear();
    this._chunkOrder = [];
    try { if (this._vboPos) gl.deleteBuffer(this._vboPos); } catch { /* ignore */ }
    try { if (this._vboNrm) gl.deleteBuffer(this._vboNrm); } catch { /* ignore */ }
    try { if (this._vao) gl.deleteVertexArray(this._vao); } catch { /* ignore */ }
    this._vboPos = this._vboNrm = this._vao = null;
    this.ready = false;
  }
}
