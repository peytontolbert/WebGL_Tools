import { ShaderProgram } from './shader_program.js';

const VS = `#version 300 es
precision highp float;

in vec3 aPos;
uniform mat4 uViewProjection;
uniform vec4 uBoundsXZ; // minX, minZ, sizeX, sizeZ

out vec2 vUv;
out vec3 vWorldPos;

void main() {
  vWorldPos = aPos;
  vec2 minXZ = uBoundsXZ.xy;
  vec2 sizeXZ = max(uBoundsXZ.zw, vec2(1e-6));
  vUv = (aPos.xz - minXZ) / sizeXZ;
  gl_Position = uViewProjection * vec4(aPos, 1.0);
}
`;

const FS = `#version 300 es
precision mediump float;

in vec2 vUv;
in vec3 vWorldPos;
out vec4 fragColor;

uniform float uTimeSec;
uniform float uOpacity;
uniform vec3 uWaterColor;

void main() {
  // Cheap animated "ripples" in UV space; purely aesthetic.
  float t = uTimeSec;
  float w0 = sin((vUv.x * 18.0 + t * 0.55) + cos(vUv.y * 13.0 - t * 0.40));
  float w1 = cos((vUv.y * 25.0 - t * 0.35) + sin(vUv.x * 11.0 + t * 0.28));
  float w = (w0 + w1) * 0.5;
  float foam = smoothstep(0.55, 1.0, w * 0.5 + 0.5);

  vec3 base = uWaterColor;
  vec3 col = base + vec3(0.05) * foam + vec3(0.02) * w;
  float a = clamp(uOpacity * (0.72 + 0.18 * (w * 0.5 + 0.5)), 0.0, 1.0);

  fragColor = vec4(col, a);
}
`;

export class WaterRenderer {
  constructor(gl) {
    this.gl = gl;
    this.program = new ShaderProgram(gl);
    this.ready = false;

    this._vao = null;
    this._vbo = null;

    // XZ bounds and water params.
    this._minX = -100;
    this._minZ = -100;
    this._maxX = 100;
    this._maxZ = 100;
    this.levelY = 0.0;
    this.opacity = 0.55;
    this.color = [0.04, 0.20, 0.32]; // deep-ish blue
    // Push water slightly behind terrain depth to avoid z-fighting on flat maps.
    this.depthOffset = { factor: 1.0, units: 1.0 };

    this.u = {};
  }

  async init() {
    const ok = await this.program.createProgram(VS, FS);
    if (!ok) throw new Error('Water shader failed');
    const gl = this.gl;

    this.u.uViewProjection = this.program.u('uViewProjection');
    this.u.uBoundsXZ = this.program.u('uBoundsXZ');
    this.u.uTimeSec = this.program.u('uTimeSec');
    this.u.uOpacity = this.program.u('uOpacity');
    this.u.uWaterColor = this.program.u('uWaterColor');

    const aPos = this.program.a('aPos');

    this._vao = gl.createVertexArray();
    this._vbo = gl.createBuffer();

    gl.bindVertexArray(this._vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(12), gl.DYNAMIC_DRAW); // 4 verts * vec3
    if (aPos !== -1) {
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null);

    this.ready = true;
    this._rebuildPlane();
  }

  setBoundsFromMapBounds(mapBounds, {
    padFactor = 0.06,
    padMeters = 0,
    padWestMeters = 0,
    padEastMeters = 0,
    padSouthMeters = 0,
    padNorthMeters = 0,
  } = {}) {
    // mapBounds uses minX/maxX and minY/maxY as ground plane extents (XZ in renderer).
    const minX = Number(mapBounds?.minX) || 0;
    const maxX = Number(mapBounds?.maxX) || 0;
    const minZ = Number(mapBounds?.minY) || 0;
    const maxZ = Number(mapBounds?.maxY) || 0;
    const dx = maxX - minX;
    const dz = maxZ - minZ;
    const pf = Math.max(0, Number(padFactor) || 0);
    const pm = Math.max(0, Number(padMeters) || 0);
    const padX = Math.max(1.0, Math.abs(dx) * pf + pm);
    const padZ = Math.max(1.0, Math.abs(dz) * pf + pm);
    const pw = Math.max(0, Number(padWestMeters) || 0);
    const pe = Math.max(0, Number(padEastMeters) || 0);
    const ps = Math.max(0, Number(padSouthMeters) || 0);
    const pn = Math.max(0, Number(padNorthMeters) || 0);

    this._minX = minX - padX - pw;
    this._maxX = maxX + padX + pe;
    this._minZ = minZ - padZ - ps;
    this._maxZ = maxZ + padZ + pn;
    this._rebuildPlane();
  }

  _rebuildPlane() {
    if (!this.ready || !this._vbo) return;
    const gl = this.gl;
    const y = Number(this.levelY) || 0.0;
    const minX = this._minX, maxX = this._maxX;
    const minZ = this._minZ, maxZ = this._maxZ;

    // Triangle strip: (minX,minZ), (maxX,minZ), (minX,maxZ), (maxX,maxZ)
    const v = new Float32Array([
      minX, y, minZ,
      maxX, y, minZ,
      minX, y, maxZ,
      maxX, y, maxZ,
    ]);

    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.DYNAMIC_DRAW);
  }

  render(viewProjection, { timeSec = 0.0 } = {}) {
    if (!this.ready) return;
    const gl = this.gl;
    gl.useProgram(this.program.program);

    // Use terrain depth buffer, but don't write depth so later overlays still work.
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    // Avoid z-fighting with terrain when waterLevel is close to terrain surface.
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(Number(this.depthOffset.factor) || 1.0, Number(this.depthOffset.units) || 1.0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);

    const minX = this._minX, maxX = this._maxX;
    const minZ = this._minZ, maxZ = this._maxZ;
    const sizeX = maxX - minX;
    const sizeZ = maxZ - minZ;
    gl.uniformMatrix4fv(this.u.uViewProjection, false, viewProjection);
    gl.uniform4f(this.u.uBoundsXZ, minX, minZ, sizeX, sizeZ);
    gl.uniform1f(this.u.uTimeSec, Number(timeSec) || 0.0);
    gl.uniform1f(this.u.uOpacity, Number(this.opacity) || 0.55);
    gl.uniform3f(this.u.uWaterColor, Number(this.color[0]) || 0.04, Number(this.color[1]) || 0.20, Number(this.color[2]) || 0.32);

    gl.bindVertexArray(this._vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    // Restore depth write for rest of frame (other renderers assume default true).
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
  }

  dispose() {
    const gl = this.gl;
    try { if (this._vbo) gl.deleteBuffer(this._vbo); } catch { /* ignore */ }
    try { if (this._vao) gl.deleteVertexArray(this._vao); } catch { /* ignore */ }
    this._vbo = null;
    this._vao = null;
    this.ready = false;
  }
}


