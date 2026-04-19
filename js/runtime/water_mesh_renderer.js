import { ShaderProgram } from './shader_program.js';

const VS = `#version 300 es
precision highp float;

in vec3 aPos;
in vec3 aCol;

uniform mat4 uViewProjection;
uniform float uOpacity;

out vec4 vC;

void main() {
  vC = vec4(aCol, uOpacity);
  gl_Position = uViewProjection * vec4(aPos, 1.0);
}
`;

const FS = `#version 300 es
precision mediump float;

in vec4 vC;
out vec4 fragColor;

void main() {
  fragColor = vC;
}
`;

export class WaterMeshRenderer {
  constructor(gl) {
    this.gl = gl;
    this.program = new ShaderProgram(gl);
    this.ready = false;

    this._vao = null;
    this._vboPos = null;
    this._vboCol = null;
    this._ibo = null;
    this._indexCount = 0;

    this.opacity = 0.72;

    this.u = {};
  }

  async init() {
    const ok = await this.program.createProgram(VS, FS);
    if (!ok) throw new Error('WaterMesh shader failed');
    const gl = this.gl;

    this.u.uViewProjection = this.program.u('uViewProjection');
    this.u.uOpacity = this.program.u('uOpacity');

    const aPos = this.program.a('aPos');
    const aCol = this.program.a('aCol');

    this._vao = gl.createVertexArray();
    this._vboPos = gl.createBuffer();
    this._vboCol = gl.createBuffer();
    this._ibo = gl.createBuffer();

    gl.bindVertexArray(this._vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this._vboPos);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.DYNAMIC_DRAW);
    if (aPos !== -1) {
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this._vboCol);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(0), gl.DYNAMIC_DRAW);
    if (aCol !== -1) {
      gl.enableVertexAttribArray(aCol);
      gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 0, 0);
    }

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(0), gl.DYNAMIC_DRAW);

    gl.bindVertexArray(null);
    this.ready = true;
  }

  setMesh({ positions, colors, indices }) {
    if (!this.ready) return;
    const gl = this.gl;
    const pos = (positions instanceof Float32Array) ? positions : new Float32Array(positions || []);
    const col = (colors instanceof Float32Array) ? colors : new Float32Array(colors || []);
    const ind = (indices instanceof Uint32Array) ? indices : new Uint32Array(indices || []);

    this._indexCount = Math.max(0, ind.length | 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this._vboPos);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vboCol);
    gl.bufferData(gl.ARRAY_BUFFER, col, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ind, gl.DYNAMIC_DRAW);
  }

  clear() {
    this.setMesh({ positions: new Float32Array(0), colors: new Float32Array(0), indices: new Uint32Array(0) });
  }

  render(viewProjection) {
    if (!this.ready || this._indexCount <= 0) return;
    const gl = this.gl;
    gl.useProgram(this.program.program);

    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);

    gl.uniformMatrix4fv(this.u.uViewProjection, false, viewProjection);
    gl.uniform1f(this.u.uOpacity, Number(this.opacity) || 0.72);

    gl.bindVertexArray(this._vao);
    gl.drawElements(gl.TRIANGLES, this._indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);

    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  dispose() {
    const gl = this.gl;
    try { if (this._vboPos) gl.deleteBuffer(this._vboPos); } catch { /* ignore */ }
    try { if (this._vboCol) gl.deleteBuffer(this._vboCol); } catch { /* ignore */ }
    try { if (this._ibo) gl.deleteBuffer(this._ibo); } catch { /* ignore */ }
    try { if (this._vao) gl.deleteVertexArray(this._vao); } catch { /* ignore */ }
    this._vboPos = this._vboCol = null;
    this._ibo = this._vao = null;
    this._indexCount = 0;
    this.ready = false;
  }
}


