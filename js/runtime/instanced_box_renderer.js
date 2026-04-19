import { ShaderProgram } from './shader_program.js';

const VS = `#version 300 es
precision highp float;

in vec3 aPos;
in vec3 aNrm;

in vec3 iTranslate;
in vec3 iScale;
in float iYaw;
in vec4 iColor;

uniform mat4 uViewProjection;

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
  mat3 R = rotY(iYaw);
  vec3 p = (R * (aPos * iScale)) + iTranslate;
  vec3 n = normalize(R * aNrm);
  vN = n;
  vC = iColor;
  vWorldPos = p;
  // Stable per-instance seed from world translation (XZ).
  vSeed = fract(sin(dot(iTranslate.xz, vec2(12.9898, 78.233))) * 43758.5453);
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
uniform float uFacade; // 0 = plain, 1 = building facade treatment

float hash21(vec2 p) {
  // Cheap hash in [0..1).
  return fract(sin(dot(p, vec2(127.1, 311.7)) + vSeed * 19.19) * 43758.5453);
}

void main() {
  vec3 N = normalize(vN);
  vec3 L = normalize(uLightDir);
  float ndl = clamp(dot(N, L) * 0.5 + 0.5, 0.0, 1.0);
  float ambient = 0.22;
  float lit = ambient + (1.0 - ambient) * ndl;

  vec3 col = vC.rgb * lit;

  // Optional building facade shading: adds window grid + subtle vertical gradient.
  if (uFacade > 0.5) {
    float isVertical = 1.0 - smoothstep(0.35, 0.55, abs(N.y));
    // Darken roofs slightly.
    if (N.y > 0.65) col *= 0.90;

    if (isVertical > 0.001) {
      vec2 uv;
      if (abs(N.x) > abs(N.z)) uv = vec2(vWorldPos.z, vWorldPos.y);
      else uv = vec2(vWorldPos.x, vWorldPos.y);

      // Window cell frequency (cells per meter): ~2.2m wide, ~3.0m tall.
      vec2 freq = vec2(0.45, 0.33);
      vec2 g = uv * freq + vec2(vSeed * 11.0, 0.0);
      vec2 cell = fract(g);
      vec2 id = floor(g);

      // Window rectangle inside each cell (soft edges).
      float wx = smoothstep(0.16, 0.20, cell.x) * (1.0 - smoothstep(0.80, 0.84, cell.x));
      float wy = smoothstep(0.18, 0.22, cell.y) * (1.0 - smoothstep(0.86, 0.90, cell.y));
      float win = wx * wy;

      // Randomly "lit" windows (very subtle in daylight).
      float rnd = hash21(id);
      float litW = step(0.62, rnd);
      vec3 warm = vec3(1.00, 0.86, 0.68);
      vec3 winCol = mix(col * 0.45, warm * 0.35, litW);

      // Mullion/striping hint.
      float stripe = smoothstep(0.48, 0.50, abs(cell.x - 0.5));
      stripe *= (1.0 - smoothstep(0.50, 0.52, abs(cell.x - 0.5)));
      float detail = clamp(win + stripe * 0.35, 0.0, 1.0);

      col = mix(col * 0.92, winCol, detail);

      // Vertical gradient: a bit darker near ground, slightly lighter up high.
      float h = clamp((vWorldPos.y + 2.0) / 55.0, 0.0, 1.0);
      col *= mix(0.86, 1.05, h);
    }
  }

  fragColor = vec4(col, vC.a);
}
`;

function createCube() {
  // Unit cube centered at origin. 12 triangles (36 verts).
  const P = [];
  const N = [];
  const pushFace = (nx, ny, nz, a, b, c, d) => {
    // two triangles: a b c, a c d
    P.push(...a, ...b, ...c, ...a, ...c, ...d);
    for (let i = 0; i < 6; i++) N.push(nx, ny, nz);
  };
  const s = 0.5;
  const v000 = [-s, -s, -s], v001 = [-s, -s, s], v010 = [-s, s, -s], v011 = [-s, s, s];
  const v100 = [s, -s, -s], v101 = [s, -s, s], v110 = [s, s, -s], v111 = [s, s, s];
  // +X
  pushFace(1, 0, 0, v100, v110, v111, v101);
  // -X
  pushFace(-1, 0, 0, v000, v001, v011, v010);
  // +Y
  pushFace(0, 1, 0, v010, v011, v111, v110);
  // -Y
  pushFace(0, -1, 0, v000, v100, v101, v001);
  // +Z
  pushFace(0, 0, 1, v001, v101, v111, v011);
  // -Z
  pushFace(0, 0, -1, v000, v010, v110, v100);

  return {
    positions: new Float32Array(P),
    normals: new Float32Array(N),
    vertexCount: P.length / 3,
  };
}

export class InstancedBoxRenderer {
  constructor(gl) {
    this.gl = gl;
    this.program = new ShaderProgram(gl);
    this.ready = false;
    this._vao = null;
    this._vboPos = null;
    this._vboNrm = null;
    this._vboInst = null;
    this._instCount = 0;
    this._vertCount = 0;
    this.u = {};
  }

  async init() {
    const ok = await this.program.createProgram(VS, FS);
    if (!ok) throw new Error('InstancedBox shader failed');
    const gl = this.gl;
    this.u.uViewProjection = this.program.u('uViewProjection');
    this.u.uLightDir = this.program.u('uLightDir');
    this.u.uFacade = this.program.u('uFacade');

    const aPos = this.program.a('aPos');
    const aNrm = this.program.a('aNrm');
    const iTranslate = this.program.a('iTranslate');
    const iScale = this.program.a('iScale');
    const iYaw = this.program.a('iYaw');
    const iColor = this.program.a('iColor');

    const cube = createCube();
    this._vertCount = cube.vertexCount;

    this._vao = gl.createVertexArray();
    this._vboPos = gl.createBuffer();
    this._vboNrm = gl.createBuffer();
    this._vboInst = gl.createBuffer();

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

    // Per-instance packed buffer:
    // iTranslate(3), iScale(3), iYaw(1), iColor(4) = 11 floats
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vboInst);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.DYNAMIC_DRAW);
    const stride = 11 * 4;
    let off = 0;
    const bindInst = (loc, size) => {
      if (loc === -1) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off);
      gl.vertexAttribDivisor(loc, 1);
      off += size * 4;
    };
    bindInst(iTranslate, 3);
    bindInst(iScale, 3);
    bindInst(iYaw, 1);
    bindInst(iColor, 4);

    gl.bindVertexArray(null);
    this.ready = true;
  }

  setInstances(instancesFloat32, instCount) {
    if (!this.ready) return;
    const gl = this.gl;
    const buf = (instancesFloat32 instanceof Float32Array) ? instancesFloat32 : new Float32Array(instancesFloat32 || []);
    this._instCount = Math.max(0, instCount | 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vboInst);
    gl.bufferData(gl.ARRAY_BUFFER, buf, gl.DYNAMIC_DRAW);
  }

  render(viewProjection, { lightDir = [0.35, 0.85, 0.25], facade = 0.0 } = {}) {
    if (!this.ready || this._instCount <= 0) return;
    const gl = this.gl;
    gl.useProgram(this.program.program);
    gl.uniformMatrix4fv(this.u.uViewProjection, false, viewProjection);
    gl.uniform3f(this.u.uLightDir, lightDir[0] ?? 0.3, lightDir[1] ?? 0.9, lightDir[2] ?? 0.2);
    try { if (this.u.uFacade) gl.uniform1f(this.u.uFacade, Number(facade) || 0.0); } catch { /* ignore */ }
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.bindVertexArray(this._vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, this._vertCount, this._instCount);
    gl.bindVertexArray(null);
    gl.disable(gl.CULL_FACE);
  }

  dispose() {
    const gl = this.gl;
    try { if (this._vboPos) gl.deleteBuffer(this._vboPos); } catch { /* ignore */ }
    try { if (this._vboNrm) gl.deleteBuffer(this._vboNrm); } catch { /* ignore */ }
    try { if (this._vboInst) gl.deleteBuffer(this._vboInst); } catch { /* ignore */ }
    try { if (this._vao) gl.deleteVertexArray(this._vao); } catch { /* ignore */ }
    this._vboPos = this._vboNrm = this._vboInst = this._vao = null;
    this.ready = false;
  }
}


