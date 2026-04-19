export class ShaderProgram {
  constructor(gl) {
    this.gl = gl;
    this.program = null;
  }

  async createProgram(vsSource, fsSource) {
    const gl = this.gl;
    const vsText = String(vsSource || '');
    const fsText = String(fsSource || '');
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    if (!vs || !fs) return false;

    gl.shaderSource(vs, vsText);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.error('VS compile error:', gl.getShaderInfoLog(vs) || '(empty log)');
      console.error('--- VS source ---\n' + vsText);
      return false;
    }

    gl.shaderSource(fs, fsText);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error('FS compile error:', gl.getShaderInfoLog(fs) || '(empty log)');
      console.error('--- FS source ---\n' + fsText);
      return false;
    }

    const prog = gl.createProgram();
    if (!prog) return false;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(prog) || '(empty log)');
      // These often contain more useful messages than the program log on some drivers.
      console.error('VS info log:', gl.getShaderInfoLog(vs) || '(empty)');
      console.error('FS info log:', gl.getShaderInfoLog(fs) || '(empty)');
      return false;
    }
    try { gl.deleteShader(vs); } catch { /* ignore */ }
    try { gl.deleteShader(fs); } catch { /* ignore */ }
    this.program = prog;
    return true;
  }

  u(name) {
    if (!this.program) return null;
    return this.gl.getUniformLocation(this.program, name);
  }

  a(name) {
    if (!this.program) return -1;
    return this.gl.getAttribLocation(this.program, name);
  }

  use() {
    if (!this.program) return;
    this.gl.useProgram(this.program);
  }

  dispose() {
    if (!this.program) return;
    try { this.gl.deleteProgram(this.program); } catch { /* ignore */ }
    this.program = null;
  }
}


