import { ShaderProgram } from './shader_program.js';

const VS = `#version 300 es
precision highp float;
in vec3 aPos;
uniform mat4 uViewProjection;
void main() {
  gl_Position = uViewProjection * vec4(aPos, 1.0);
}
`;

const FS = `#version 300 es
precision mediump float;
out vec4 fragColor;
uniform vec4 uColor;
void main() { fragColor = uColor; }
`;

export class LinesRenderer {
  constructor(gl) {
    this.gl = gl;
    this.program = new ShaderProgram(gl);
    this.ready = false;
    this._vao = null;
    this._vbo = null;
    this._count = 0;
    this.u = {};
    this.aPos = -1;
  }

  async init() {
    const ok = await this.program.createProgram(VS, FS);
    if (!ok) throw new Error('Lines shader failed');
    const gl = this.gl;
    this.u.uViewProjection = this.program.u('uViewProjection');
    this.u.uColor = this.program.u('uColor');
    this.aPos = this.program.a('aPos');
    this._vao = gl.createVertexArray();
    this._vbo = gl.createBuffer();
    gl.bindVertexArray(this._vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
    if (this.aPos !== -1) {
      gl.enableVertexAttribArray(this.aPos);
      gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null);
    this.ready = true;
  }

  setLinesPositions(positionsFloat32) {
    if (!this.ready) return;
    const gl = this.gl;
    const pos = (positionsFloat32 instanceof Float32Array) ? positionsFloat32 : new Float32Array(positionsFloat32 || []);
    this._count = Math.floor(pos.length / 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
  }

  render(viewProjection, { color = [1, 1, 1, 0.85], depthTest = false } = {}) {
    if (!this.ready || this._count <= 0) return;
    const gl = this.gl;
    gl.useProgram(this.program.program);
    gl.uniformMatrix4fv(this.u.uViewProjection, false, viewProjection);
    gl.uniform4f(this.u.uColor, color[0] ?? 1, color[1] ?? 1, color[2] ?? 1, color[3] ?? 1);
    if (depthTest) gl.enable(gl.DEPTH_TEST);
    else gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this._vao);
    gl.drawArrays(gl.LINES, 0, this._count);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }
}


