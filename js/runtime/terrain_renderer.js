import { ShaderProgram } from './shader_program.js';

// NOTE: We intentionally avoid vertex-texture fetch and float textures here.
// Some WebGL2 drivers can lose the context (CONTEXT_LOST_WEBGL) when doing
// texelFetch/textureSize in the vertex shader or using R32F textures.
// We bake displaced positions + colors on the CPU (100x100 is tiny) for maximal compatibility.
const VS = `#version 300 es
precision highp float;
in vec3 aPos;
in vec3 aCol;
in vec2 aUv;
uniform mat4 uViewProjection;
out vec3 vCol;
out vec3 vN;
out vec2 vUv;
uniform vec3 uLightDir;
void main() {
  vCol = aCol;
  // Flat normal (good enough for now; we can compute real normals later).
  vN = vec3(0.0, 1.0, 0.0);
  vUv = aUv;
  gl_Position = uViewProjection * vec4(aPos, 1.0);
}
`;

const FS = `#version 300 es
precision mediump float;
in vec3 vCol;
in vec3 vN;
in vec2 vUv;
out vec4 fragColor;
uniform vec3 uLightDir;
uniform sampler2D uLabelsTex;
uniform float uLabelsEnabled;
void main() {
  vec3 N = normalize(vN);
  vec3 L = normalize(uLightDir);
  float ndl = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);
  float ambient = 0.25;
  float lit = ambient + (1.0 - ambient) * ndl;
  vec3 base = vCol * lit;
  if (uLabelsEnabled > 0.5) {
    vec4 lab = texture(uLabelsTex, vUv);
    base = mix(base, lab.rgb, clamp(lab.a, 0.0, 1.0));
  }
  fragColor = vec4(base, 1.0);
}
`;

function makeGridIndices(gridW, gridH) {
  const w = Math.max(2, gridW | 0);
  const h = Math.max(2, gridH | 0);
  const idx = [];
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const v0 = y * w + x;
      const v1 = v0 + 1;
      const v2 = (y + 1) * w + x;
      const v3 = v2 + 1;
      idx.push(v0, v2, v1);
      idx.push(v1, v2, v3);
    }
  }
  // 100x100 fits in 16-bit indices comfortably.
  return { idx: new Uint16Array(idx), indexCount: idx.length };
}

export class TerrainRenderer {
  constructor(gl) {
    this.gl = gl;
    this.program = new ShaderProgram(gl);
    this.ready = false;
    this._vao = null;
    this._vboPos = null;
    this._vboCol = null;
    this._vboUv = null;
    this._ibo = null;
    this._indexCount = 0;

    this.boundsMin = [-50, -50, 0]; // minX, minY, minZ
    this.boundsSize = [100, 100, 20]; // dx, dy, dz

    // Visual-only vertical exaggeration. Keep at 1 for true meters.
    this.heightScale = 1.0;

    this._gridW = 100;
    this._gridH = 100;
    this._heightsU16 = null;
    this._maskRgba = null;
    // Optional per-vertex water mask: when present, terrain vertices marked as water are flattened to waterLevelY.
    // This prevents "terrain stretching over water" when using world-scale bounds or coarse DEM coverage.
    this._waterMask = null; // Uint8Array length w*h (0/1)
    this._waterMaskW = 0;
    this._waterMaskH = 0;
    this._waterLevelY = 0.0;

    // Optional label overlay (world-anchored texture sampled by terrain UVs).
    this._labelsTex = null;
    this._labelsEnabled = false;
    this._labelsW = 1;
    this._labelsH = 1;

    this.u = {};
  }

  async init(gridW = 100, gridH = 100) {
    const ok = await this.program.createProgram(VS, FS);
    if (!ok) throw new Error('Terrain shader failed');
    const gl = this.gl;

    this.u.uViewProjection = this.program.u('uViewProjection');
    this.u.uLightDir = this.program.u('uLightDir');
    this.u.uLabelsTex = this.program.u('uLabelsTex');
    this.u.uLabelsEnabled = this.program.u('uLabelsEnabled');

    const aPos = this.program.a('aPos');
    const aCol = this.program.a('aCol');
    const aUv = this.program.a('aUv');

    this._gridW = Math.max(2, gridW | 0);
    this._gridH = Math.max(2, gridH | 0);
    const { idx, indexCount } = makeGridIndices(this._gridW, this._gridH);
    this._indexCount = indexCount;

    this._vao = gl.createVertexArray();
    this._vboPos = gl.createBuffer();
    this._vboCol = gl.createBuffer();
    this._vboUv = gl.createBuffer();
    this._ibo = gl.createBuffer();

    gl.bindVertexArray(this._vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vboPos);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this._gridW * this._gridH * 3), gl.DYNAMIC_DRAW);
    if (aPos !== -1) {
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this._vboCol);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this._gridW * this._gridH * 3), gl.DYNAMIC_DRAW);
    if (aCol !== -1) {
      gl.enableVertexAttribArray(aCol);
      gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 0, 0);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this._vboUv);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(this._gridW * this._gridH * 2), gl.DYNAMIC_DRAW);
    if (aUv !== -1) {
      gl.enableVertexAttribArray(aUv);
      gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);
    }

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    // Create a default 1x1 transparent label texture so the sampler is always valid.
    this._labelsTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._labelsTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.bindTexture(gl.TEXTURE_2D, null);
    this._labelsEnabled = false;
    this._labelsW = 1;
    this._labelsH = 1;

    this.ready = true;
  }

  setBounds({ minX, minY, minZ, maxX, maxY, maxZ }) {
    this.boundsMin[0] = Number(minX) || 0;
    this.boundsMin[1] = Number(minY) || 0;
    this.boundsMin[2] = Number(minZ) || 0;
    this.boundsSize[0] = (Number(maxX) || 0) - this.boundsMin[0];
    this.boundsSize[1] = (Number(maxY) || 0) - this.boundsMin[1];
    this.boundsSize[2] = (Number(maxZ) || 0) - this.boundsMin[2];
    this._rebuildMesh();
  }

  setHeightScale(s) {
    const v = Number(s);
    this.heightScale = (Number.isFinite(v) && v > 0) ? v : 1.0;
    this._rebuildMesh();
  }

  uploadHeightU16(width, height, heightsU16) {
    // Keep CPU copy; rebuild GPU mesh.
    this._heightsU16 = heightsU16;
    this._gridW = Math.max(2, width | 0);
    this._gridH = Math.max(2, height | 0);
    this._rebuildMesh();
  }

  uploadMaskRgba(width, height, rgbaU8) {
    this._maskRgba = rgbaU8;
    this._gridW = Math.max(2, width | 0);
    this._gridH = Math.max(2, height | 0);
    this._rebuildMesh();
  }

  setWaterLevelY(y) {
    const v = Number(y);
    this._waterLevelY = Number.isFinite(v) ? v : 0.0;
    this._rebuildMesh();
  }

  uploadWaterMask(width, height, maskU8) {
    this._waterMask = (maskU8 instanceof Uint8Array) ? maskU8 : new Uint8Array(maskU8 || []);
    this._waterMaskW = Math.max(0, width | 0);
    this._waterMaskH = Math.max(0, height | 0);
    this._rebuildMesh();
  }

  clearWaterMask() {
    this._waterMask = null;
    this._waterMaskW = 0;
    this._waterMaskH = 0;
    this._rebuildMesh();
  }

  uploadLabelsRgba(width, height, rgbaU8) {
    // Upload an RGBA overlay texture (world-anchored labels).
    const gl = this.gl;
    if (!this.ready || !this._labelsTex) return;
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    const bytes = w * h * 4;
    const src = (rgbaU8 instanceof Uint8Array) ? rgbaU8 : new Uint8Array(rgbaU8 || []);
    if (src.length < bytes) return;
    gl.bindTexture(gl.TEXTURE_2D, this._labelsTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this._labelsEnabled = true;
    this._labelsW = w;
    this._labelsH = h;
  }

  clearLabels() {
    const gl = this.gl;
    if (!this.ready || !this._labelsTex) return;
    gl.bindTexture(gl.TEXTURE_2D, this._labelsTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.bindTexture(gl.TEXTURE_2D, null);
    this._labelsEnabled = false;
    this._labelsW = 1;
    this._labelsH = 1;
  }

  _rebuildMesh() {
    if (!this.ready) return;
    if (!this._vboPos || !this._vboCol || !this._vboUv) return;
    const w = this._gridW;
    const h = this._gridH;
    if (!w || !h) return;
    if (!this._heightsU16 || this._heightsU16.length < w * h) return;
    if (!this._maskRgba || this._maskRgba.length < w * h * 4) return;

    const pos = new Float32Array(w * h * 3);
    const col = new Float32Array(w * h * 3);
    const uv = new Float32Array(w * h * 2);

    const minX = this.boundsMin[0];
    const minY = this.boundsMin[1];
    const minZ = this.boundsMin[2];
    const sizeX = this.boundsSize[0];
    const sizeY = this.boundsSize[1];
    const sizeZ = this.boundsSize[2];
    const hs = (Number.isFinite(this.heightScale) && this.heightScale > 0) ? this.heightScale : 1.0;
    const waterMaskOk = !!this._waterMask && (this._waterMaskW === w) && (this._waterMaskH === h) && (this._waterMask.length >= w * h);
    const waterY = Number(this._waterLevelY) || 0.0;

    const pickColor = (r, g, b, a) => {
      // grass/dirt/road/street one-hot-ish
      if (b > 128) return [0.12, 0.12, 0.14];
      if (a > 128) return [0.18, 0.18, 0.20];
      if (g > 128) return [0.42, 0.30, 0.18];
      return [0.16, 0.42, 0.16];
    };

    for (let iy = 0; iy < h; iy++) {
      for (let ix = 0; ix < w; ix++) {
        const u = (w <= 1) ? 0 : ix / (w - 1);
        const v = (h <= 1) ? 0 : iy / (h - 1);
        const idx = iy * w + ix;
        const h01 = (this._heightsU16[idx] || 0) / 65535.0;
        const x = minX + u * sizeX;
        // Heightmap storage is row-major, top-to-bottom (north -> south). Our world Z increases north,
        // so row 0 should map to maxY (north edge), not minY.
        const maxY = minY + sizeY;
        const z = maxY - v * sizeY;
        let y = minZ + h01 * sizeZ * hs;
        if (waterMaskOk && (this._waterMask[idx] | 0) !== 0) {
          y = waterY;
        }

        const pBase = idx * 3;
        pos[pBase + 0] = x;
        pos[pBase + 1] = y;
        pos[pBase + 2] = z;

        const mBase = idx * 4;
        const c = pickColor(
          this._maskRgba[mBase + 0] || 0,
          this._maskRgba[mBase + 1] || 0,
          this._maskRgba[mBase + 2] || 0,
          this._maskRgba[mBase + 3] || 0
        );
        col[pBase + 0] = c[0];
        col[pBase + 1] = c[1];
        col[pBase + 2] = c[2];

        const uvBase = idx * 2;
        uv[uvBase + 0] = u;
        uv[uvBase + 1] = v;
      }
    }

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vboPos);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vboCol);
    gl.bufferData(gl.ARRAY_BUFFER, col, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vboUv);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.DYNAMIC_DRAW);
  }

  render(viewProjection) {
    if (!this.ready) return;
    const gl = this.gl;
    gl.useProgram(this.program.program);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    gl.uniformMatrix4fv(this.u.uViewProjection, false, viewProjection);
    gl.uniform3f(this.u.uLightDir, 0.35, 0.85, 0.25);
    gl.uniform1f(this.u.uLabelsEnabled, this._labelsEnabled ? 1.0 : 0.0);
    // Bind labels texture (even if disabled; keeps shader simple).
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._labelsTex);
    gl.uniform1i(this.u.uLabelsTex, 0);

    gl.bindVertexArray(this._vao);
    gl.drawElements(gl.TRIANGLES, this._indexCount, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  dispose() {
    const gl = this.gl;
    try { if (this._vboPos) gl.deleteBuffer(this._vboPos); } catch { /* ignore */ }
    try { if (this._vboCol) gl.deleteBuffer(this._vboCol); } catch { /* ignore */ }
    try { if (this._vboUv) gl.deleteBuffer(this._vboUv); } catch { /* ignore */ }
    try { if (this._ibo) gl.deleteBuffer(this._ibo); } catch { /* ignore */ }
    try { if (this._vao) gl.deleteVertexArray(this._vao); } catch { /* ignore */ }
    try { if (this._labelsTex) gl.deleteTexture(this._labelsTex); } catch { /* ignore */ }
    this._vboPos = this._vboCol = null;
    this._vboUv = null;
    this._ibo = this._vao = null;
    this._labelsTex = null;
    this.ready = false;
  }
}


