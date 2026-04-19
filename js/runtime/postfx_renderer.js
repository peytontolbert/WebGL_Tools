import { ShaderProgram } from './shader_program.js';

/**
 * Post-processing:
 * - Render the whole scene into an offscreen framebuffer in linear-ish space
 * - Apply CodeWalker-like tone mapping + (optional) bloom
 * - Encode to sRGB once when drawing to the canvas
 *
 * NOTE: This is a direct port of the viewer's PostFxRenderer; it assumes WebGL2.
 */
export class PostFxRenderer {
  /**
   * @param {WebGL2RenderingContext} gl
   */
  constructor(gl) {
    this.gl = gl;
    this.ready = false;

    // Public knobs
    this.enabled = false;
    this.exposure = 1.0;
    this.avgLum = 1.0;
    this.enableAutoExposure = false;
    this.autoExposureSpeed = 1.5;
    this.enableBloom = true;
    this.bloomStrength = 0.52;
    this.bloomThreshold = 0.78;
    this.bloomRadius = 1.65;
    this.enableVignette = true;
    this.vignetteStrength = 0.12;
    this.vignetteSoftness = 0.78;
    this.enableGrain = true;
    this.grainStrength = 0.028;
    this.grainSpeed = 0.75;

    // Scene render target
    this._scene = { fbo: null, tex: null, depth: null, w: 0, h: 0, isHdr: false };

    // Bloom ping-pong targets (quarter res)
    this._bloom = { w: 0, h: 0, fboA: null, texA: null, fboB: null, texB: null };

    // Luminance reduction targets (auto exposure)
    this._lum = { base: 64, levels: [], isFloat: false };
    this._auto = {
      lastMs: 0,
      measuredLum: 1.0,
      adaptedLum: 1.0,
      readbackEveryNFrames: 3,
      frame: 0,
      pixF32: new Float32Array(4),
      pixU8: new Uint8Array(4),
    };

    // Shader programs
    this._tonemapProg = new ShaderProgram(gl);
    this._bloomExtractProg = new ShaderProgram(gl);
    this._bloomBlurProg = new ShaderProgram(gl);
    this._lumExtractProg = new ShaderProgram(gl);
    this._lumDownProg = new ShaderProgram(gl);
    this._fsVao = null;

    this.lastError = null;
    this._u = { tonemap: null, extract: null, blur: null, lumExtract: null, lumDown: null };
  }

  _setLastError(where, message, detail = null, status = null) {
    try {
      this.lastError = {
        where: String(where || 'postfx'),
        status: (status === null || status === undefined) ? null : status,
        message: String(message || 'error'),
        detail: detail ?? null,
        whenMs: (performance?.now?.() ?? Date.now()),
      };
    } catch {
      // ignore
    }
  }

  _checkFramebufferComplete(where, fbo) {
    const gl = this.gl;
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      try { gl.drawBuffers([gl.COLOR_ATTACHMENT0]); } catch { /* ignore */ }
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        this._setLastError(where, 'Framebuffer incomplete', { status }, status);
        try { console.warn(`PostFxRenderer: ${where} framebuffer incomplete:`, status); } catch { /* ignore */ }
        return false;
      }
      return true;
    } catch (e) {
      this._setLastError(where, 'Exception during framebuffer status check', { error: String(e) });
      try { console.warn(`PostFxRenderer: ${where} framebuffer status check threw:`, e); } catch { /* ignore */ }
      return false;
    } finally {
      try { gl.bindFramebuffer(gl.FRAMEBUFFER, null); } catch { /* ignore */ }
    }
  }

  async init() {
    const gl = this.gl;

    // Fullscreen triangle
    this._fsVao = gl.createVertexArray();

    const vs = `#version 300 es
out vec2 vUv;
void main() {
    vec2 p;
    if (gl_VertexID == 0) p = vec2(-1.0, -1.0);
    else if (gl_VertexID == 1) p = vec2(3.0, -1.0);
    else p = vec2(-1.0, 3.0);
    vUv = p * 0.5 + 0.5;
    gl_Position = vec4(p, 0.0, 1.0);
}`;

    const fsTonemap = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSceneTex;
uniform sampler2D uBloomTex;
uniform bool uEnableBloom;

uniform float uExposure;
uniform float uAvgLum;
uniform float uBloomStrength;
uniform bool uEnableVignette;
uniform float uVignetteStrength;
uniform float uVignetteSoftness;
uniform bool uEnableGrain;
uniform float uGrainStrength;
uniform float uTime;
uniform vec2 uInvResolution;

const float MIDDLE_GRAY = 0.72;
const float LUM_WHITE = 1.5;

vec3 encodeSrgb(vec3 c) {
    vec3 x = max(c, vec3(0.0));
    vec3 low = x * 12.92;
    vec3 high = 1.055 * pow(x, vec3(1.0 / 2.4)) - 0.055;
    bvec3 cut = lessThanEqual(x, vec3(0.0031308));
    return vec3(cut.x ? low.x : high.x,
                cut.y ? low.y : high.y,
                cut.z ? low.z : high.z);
}

vec3 toneMapCodeWalker(vec3 c, float lum) {
    float fLum = clamp(lum, 0.2, 10.0);
    vec3 v = c * (MIDDLE_GRAY / (fLum + 0.001));
    v *= (1.0 + v / LUM_WHITE);
    v /= (1.0 + v);
    return v;
}

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

void main() {
    vec3 c = texture(uSceneTex, vUv).rgb;
    float lum = max(0.0, uAvgLum) * max(0.0, uExposure);
    vec3 outLin = toneMapCodeWalker(c, lum);
    if (uEnableBloom) {
        vec3 b = texture(uBloomTex, vUv).rgb;
        outLin += max(0.0, uBloomStrength) * b;
    }
    if (uEnableVignette) {
        vec2 p = (vUv - 0.5) * 2.0;
        p.x *= max(1e-5, (1.0 / max(1e-5, uInvResolution.x)) * uInvResolution.y);
        float d = dot(p, p);
        float soft = clamp(uVignetteSoftness, 0.05, 0.98);
        float inner = mix(0.14, 0.60, soft);
        float outer = mix(0.70, 1.15, soft);
        float vignette = 1.0 - max(0.0, uVignetteStrength) * smoothstep(inner, outer, d);
        outLin *= clamp(vignette, 0.0, 1.0);
    }
    if (uEnableGrain) {
        vec2 frag = vUv / max(uInvResolution, vec2(1e-6));
        float t = floor(uTime * 24.0);
        float n = hash12(frag + vec2(t, t * 0.61803)) - 0.5;
        float lumOut = dot(outLin, vec3(0.2126, 0.7152, 0.0722));
        float tonalMask = clamp(1.0 - lumOut * 0.6, 0.35, 1.0);
        outLin += n * max(0.0, uGrainStrength) * tonalMask;
    }
    outLin = max(outLin, vec3(0.0));
    fragColor = vec4(encodeSrgb(outLin), 1.0);
}`;

    const fsBloomExtract = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSceneTex;
uniform float uThreshold;

void main() {
    vec3 c = texture(uSceneTex, vUv).rgb;
    vec3 b = max(c - vec3(uThreshold), vec3(0.0));
    fragColor = vec4(b, 1.0);
}`;

    const fsBloomBlur = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform vec2 uDir;
uniform float uRadius;
void main() {
    vec2 o = uDir * uTexel * max(0.0, uRadius);
    vec3 s = vec3(0.0);
    s += texture(uTex, vUv - 3.0 * o).rgb * 0.06;
    s += texture(uTex, vUv - 2.0 * o).rgb * 0.12;
    s += texture(uTex, vUv - 1.0 * o).rgb * 0.18;
    s += texture(uTex, vUv).rgb          * 0.28;
    s += texture(uTex, vUv + 1.0 * o).rgb * 0.18;
    s += texture(uTex, vUv + 2.0 * o).rgb * 0.12;
    s += texture(uTex, vUv + 3.0 * o).rgb * 0.06;
    fragColor = vec4(s, 1.0);
}`;

    const fsLumExtract = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSceneTex;
void main() {
    vec3 c = texture(uSceneTex, vUv).rgb;
    float y = max(0.0, dot(c, vec3(0.2126, 0.7152, 0.0722)));
    float logY = log(max(y, 1e-6));
    const float LOG_MIN = -8.0;
    const float LOG_MAX =  2.0;
    float enc = clamp((logY - LOG_MIN) / (LOG_MAX - LOG_MIN), 0.0, 1.0);
    fragColor = vec4(enc, enc, enc, 1.0);
}`;

    const fsLumDown = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTex;
uniform vec2 uTexel;
void main() {
    vec2 o = uTexel * 0.5;
    vec3 a = texture(uTex, vUv + vec2(-o.x, -o.y)).rgb;
    vec3 b = texture(uTex, vUv + vec2( o.x, -o.y)).rgb;
    vec3 c = texture(uTex, vUv + vec2(-o.x,  o.y)).rgb;
    vec3 d = texture(uTex, vUv + vec2( o.x,  o.y)).rgb;
    vec3 m = (a + b + c + d) * 0.25;
    fragColor = vec4(m, 1.0);
}`;

    const ok0 = await this._tonemapProg.createProgram(vs, fsTonemap);
    const ok1 = await this._bloomExtractProg.createProgram(vs, fsBloomExtract);
    const ok2 = await this._bloomBlurProg.createProgram(vs, fsBloomBlur);
    const ok3 = await this._lumExtractProg.createProgram(vs, fsLumExtract);
    const ok4 = await this._lumDownProg.createProgram(vs, fsLumDown);
    if (!ok0 || !ok1 || !ok2 || !ok3 || !ok4) return false;

    this._u.tonemap = {
      uSceneTex: gl.getUniformLocation(this._tonemapProg.program, 'uSceneTex'),
      uBloomTex: gl.getUniformLocation(this._tonemapProg.program, 'uBloomTex'),
      uEnableBloom: gl.getUniformLocation(this._tonemapProg.program, 'uEnableBloom'),
      uExposure: gl.getUniformLocation(this._tonemapProg.program, 'uExposure'),
      uAvgLum: gl.getUniformLocation(this._tonemapProg.program, 'uAvgLum'),
      uBloomStrength: gl.getUniformLocation(this._tonemapProg.program, 'uBloomStrength'),
      uEnableVignette: gl.getUniformLocation(this._tonemapProg.program, 'uEnableVignette'),
      uVignetteStrength: gl.getUniformLocation(this._tonemapProg.program, 'uVignetteStrength'),
      uVignetteSoftness: gl.getUniformLocation(this._tonemapProg.program, 'uVignetteSoftness'),
      uEnableGrain: gl.getUniformLocation(this._tonemapProg.program, 'uEnableGrain'),
      uGrainStrength: gl.getUniformLocation(this._tonemapProg.program, 'uGrainStrength'),
      uTime: gl.getUniformLocation(this._tonemapProg.program, 'uTime'),
      uInvResolution: gl.getUniformLocation(this._tonemapProg.program, 'uInvResolution'),
    };
    this._u.extract = {
      uSceneTex: gl.getUniformLocation(this._bloomExtractProg.program, 'uSceneTex'),
      uThreshold: gl.getUniformLocation(this._bloomExtractProg.program, 'uThreshold'),
    };
    this._u.blur = {
      uTex: gl.getUniformLocation(this._bloomBlurProg.program, 'uTex'),
      uTexel: gl.getUniformLocation(this._bloomBlurProg.program, 'uTexel'),
      uDir: gl.getUniformLocation(this._bloomBlurProg.program, 'uDir'),
      uRadius: gl.getUniformLocation(this._bloomBlurProg.program, 'uRadius'),
    };
    this._u.lumExtract = {
      uSceneTex: gl.getUniformLocation(this._lumExtractProg.program, 'uSceneTex'),
    };
    this._u.lumDown = {
      uTex: gl.getUniformLocation(this._lumDownProg.program, 'uTex'),
      uTexel: gl.getUniformLocation(this._lumDownProg.program, 'uTexel'),
    };

    this.ready = true;
    return true;
  }

  resize(w, h) {
    const gl = this.gl;
    const W = Math.max(1, (w | 0) || 1);
    const H = Math.max(1, (h | 0) || 1);
    if (this._scene.fbo && this._scene.w === W && this._scene.h === H) return;

    const delTex = (t) => { try { if (t) gl.deleteTexture(t); } catch { /* ignore */ } };
    const delRb = (r) => { try { if (r) gl.deleteRenderbuffer(r); } catch { /* ignore */ } };
    const delFb = (f) => { try { if (f) gl.deleteFramebuffer(f); } catch { /* ignore */ } };

    delTex(this._scene.tex);
    delRb(this._scene.depth);
    delFb(this._scene.fbo);
    this._scene = { fbo: null, tex: null, depth: null, w: W, h: H, isHdr: false };

    // Scene color texture
    const sceneTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    const depthRb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, W, H);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
    try { gl.drawBuffers([gl.COLOR_ATTACHMENT0]); } catch { /* ignore */ }
    const ok = this._checkFramebufferComplete('scene', fbo);
    if (!ok) {
      try { gl.bindFramebuffer(gl.FRAMEBUFFER, null); } catch { /* ignore */ }
      return;
    }
    this._scene = { fbo, tex: sceneTex, depth: depthRb, w: W, h: H, isHdr: false };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);

    // Bloom targets (quarter res)
    this._ensureBloomTargets();
    // Luminance chain
    this._ensureLumTargets();
  }

  _ensureBloomTargets() {
    const gl = this.gl;
    const W = Math.max(1, (this._scene.w / 4) | 0);
    const H = Math.max(1, (this._scene.h / 4) | 0);
    if (this._bloom?.texA && this._bloom?.w === W && this._bloom?.h === H) return;

    const del = (t) => { try { if (t) gl.deleteTexture(t); } catch { /* ignore */ } };
    const delf = (f) => { try { if (f) gl.deleteFramebuffer(f); } catch { /* ignore */ } };
    del(this._bloom.texA); del(this._bloom.texB);
    delf(this._bloom.fboA); delf(this._bloom.fboB);

    const make = () => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      try { gl.drawBuffers([gl.COLOR_ATTACHMENT0]); } catch { /* ignore */ }
      return { tex, fbo };
    };

    const a = make();
    const b = make();
    this._bloom = { w: W, h: H, texA: a.tex, fboA: a.fbo, texB: b.tex, fboB: b.fbo };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  _ensureLumTargets() {
    const gl = this.gl;
    const base = Math.max(8, Math.min(256, this._lum.base | 0));
    const levels = [];
    let w = base;
    let h = base;
    while (w >= 1 && h >= 1) {
      levels.push({ w, h, tex: null, fbo: null });
      if (w === 1 && h === 1) break;
      w = Math.max(1, (w / 2) | 0);
      h = Math.max(1, (h / 2) | 0);
    }

    const del = (t) => { try { if (t) gl.deleteTexture(t); } catch { /* ignore */ } };
    const delf = (f) => { try { if (f) gl.deleteFramebuffer(f); } catch { /* ignore */ } };
    for (const L of this._lum.levels || []) { del(L.tex); delf(L.fbo); }

    for (const L of levels) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, L.w, L.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      try { gl.drawBuffers([gl.COLOR_ATTACHMENT0]); } catch { /* ignore */ }
      L.tex = tex;
      L.fbo = fbo;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this._lum.levels = levels;
  }

  /**
   * Bind the scene framebuffer to start rendering the world into it.
   * Returns the framebuffer to bind (or null if disabled/not ready).
   */
  beginScene({ w, h } = {}) {
    if (!this.ready || !this.enabled) return null;
    this.resize(w, h);
    if (!this._scene?.fbo || !this._scene?.tex) return null;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._scene.fbo);
    try { gl.drawBuffers([gl.COLOR_ATTACHMENT0]); } catch { /* ignore */ }
    gl.viewport(0, 0, this._scene.w, this._scene.h);

    // Stabilize state
    try { gl.disable(gl.SCISSOR_TEST); } catch { /* ignore */ }
    try { gl.disable(gl.STENCIL_TEST); } catch { /* ignore */ }
    try { gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE); } catch { /* ignore */ }
    try { gl.colorMask(true, true, true, true); } catch { /* ignore */ }
    try { gl.depthMask(true); } catch { /* ignore */ }
    try { gl.clearDepth(1.0); } catch { /* ignore */ }
    try {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
    } catch { /* ignore */ }

    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    return this._scene.fbo;
  }

  /**
   * Run bloom (optional) + tonemap + encode to the default framebuffer.
   */
  endScene({ canvasW, canvasH } = {}) {
    if (!this.ready || !this.enabled) return;
    if (!this._scene?.tex) return;
    const gl = this.gl;

    // Stabilize state
    try { gl.disable(gl.SCISSOR_TEST); } catch { /* ignore */ }
    try { gl.disable(gl.STENCIL_TEST); } catch { /* ignore */ }
    try { gl.disable(gl.CULL_FACE); } catch { /* ignore */ }
    try { gl.colorMask(true, true, true, true); } catch { /* ignore */ }
    try { gl.disable(gl.BLEND); } catch { /* ignore */ }
    try { gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE); } catch { /* ignore */ }
    try {
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ZERO);
    } catch { /* ignore */ }

    if (this.enableAutoExposure) {
      try { this._updateAutoExposure(); } catch { /* ignore */ }
    }

    // Bloom (quarter res)
    let bloomTexForTonemap = null;
    if (this.enableBloom && this._bloom?.fboA && this._bloom?.fboB) {
      const bw = this._bloom.w;
      const bh = this._bloom.h;

      // Extract
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._bloom.fboA);
      try { gl.drawBuffers([gl.COLOR_ATTACHMENT0]); } catch { /* ignore */ }
      gl.viewport(0, 0, bw, bh);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      this._bloomExtractProg.use();
      gl.bindVertexArray(this._fsVao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._scene.tex);
      gl.uniform1i(this._u.extract.uSceneTex, 0);
      gl.uniform1f(this._u.extract.uThreshold, Number(this.bloomThreshold) || 0.0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Blur X
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._bloom.fboB);
      try { gl.drawBuffers([gl.COLOR_ATTACHMENT0]); } catch { /* ignore */ }
      gl.viewport(0, 0, bw, bh);
      this._bloomBlurProg.use();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._bloom.texA);
      gl.uniform1i(this._u.blur.uTex, 0);
      gl.uniform2f(this._u.blur.uTexel, 1.0 / bw, 1.0 / bh);
      gl.uniform2f(this._u.blur.uDir, 1.0, 0.0);
      gl.uniform1f(this._u.blur.uRadius, Number(this.bloomRadius) || 0.0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Blur Y (back to A)
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._bloom.fboA);
      try { gl.drawBuffers([gl.COLOR_ATTACHMENT0]); } catch { /* ignore */ }
      gl.viewport(0, 0, bw, bh);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._bloom.texB);
      gl.uniform1i(this._u.blur.uTex, 0);
      gl.uniform2f(this._u.blur.uTexel, 1.0 / bw, 1.0 / bh);
      gl.uniform2f(this._u.blur.uDir, 0.0, 1.0);
      gl.uniform1f(this._u.blur.uRadius, Number(this.bloomRadius) || 0.0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      bloomTexForTonemap = this._bloom.texA;
    }

    // Tonemap to canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, Math.max(1, canvasW | 0), Math.max(1, canvasH | 0));
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    this._tonemapProg.use();
    gl.bindVertexArray(this._fsVao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._scene.tex);
    gl.uniform1i(this._u.tonemap.uSceneTex, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloomTexForTonemap || this._scene.tex);
    gl.uniform1i(this._u.tonemap.uBloomTex, 1);

    gl.uniform1i(this._u.tonemap.uEnableBloom, (this.enableBloom && !!bloomTexForTonemap) ? 1 : 0);
    gl.uniform1f(this._u.tonemap.uExposure, Number(this.exposure) || 0.0);
    const lumBias = Number(this.avgLum) || 0.0;
    const lum = this.enableAutoExposure ? (Math.max(0.0, this._auto.adaptedLum) * Math.max(0.0, lumBias)) : Math.max(0.0, lumBias);
    gl.uniform1f(this._u.tonemap.uAvgLum, lum);
    gl.uniform1f(this._u.tonemap.uBloomStrength, Number(this.bloomStrength) || 0.0);
    gl.uniform1i(this._u.tonemap.uEnableVignette, this.enableVignette ? 1 : 0);
    gl.uniform1f(this._u.tonemap.uVignetteStrength, Number(this.vignetteStrength) || 0.0);
    gl.uniform1f(this._u.tonemap.uVignetteSoftness, Number(this.vignetteSoftness) || 0.0);
    gl.uniform1i(this._u.tonemap.uEnableGrain, this.enableGrain ? 1 : 0);
    gl.uniform1f(this._u.tonemap.uGrainStrength, Number(this.grainStrength) || 0.0);
    gl.uniform1f(this._u.tonemap.uTime, (performance?.now?.() ?? Date.now()) * 0.001 * (Number(this.grainSpeed) || 0.0));
    gl.uniform2f(this._u.tonemap.uInvResolution, 1.0 / Math.max(1, canvasW | 0), 1.0 / Math.max(1, canvasH | 0));

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.depthMask(true);
    try {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
    } catch { /* ignore */ }
  }

  _updateAutoExposure() {
    const gl = this.gl;
    const lv = this._lum?.levels;
    if (!lv || lv.length < 1) return;
    if (!this._scene?.tex) return;
    if (!this._lumExtractProg?.program || !this._lumDownProg?.program) return;

    try { gl.disable(gl.SCISSOR_TEST); } catch { /* ignore */ }
    try { gl.disable(gl.STENCIL_TEST); } catch { /* ignore */ }
    try { gl.disable(gl.CULL_FACE); } catch { /* ignore */ }
    try { gl.disable(gl.BLEND); } catch { /* ignore */ }
    try { gl.colorMask(true, true, true, true); } catch { /* ignore */ }

    this._auto.frame = (this._auto.frame + 1) >>> 0;
    const doReadback = (this._auto.frame % Math.max(1, this._auto.readbackEveryNFrames | 0)) === 0;

    // Extract
    {
      const L0 = lv[0];
      gl.bindFramebuffer(gl.FRAMEBUFFER, L0.fbo);
      gl.viewport(0, 0, L0.w, L0.h);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      this._lumExtractProg.use();
      gl.bindVertexArray(this._fsVao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._scene.tex);
      gl.uniform1i(this._u.lumExtract.uSceneTex, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // Downsample chain
    for (let i = 0; i + 1 < lv.length; i++) {
      const src = lv[i];
      const dst = lv[i + 1];
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, dst.w, dst.h);
      this._lumDownProg.use();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(this._u.lumDown.uTex, 0);
      gl.uniform2f(this._u.lumDown.uTexel, 1.0 / src.w, 1.0 / src.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // Read 1x1
    if (doReadback) {
      const last = lv[lv.length - 1];
      gl.bindFramebuffer(gl.FRAMEBUFFER, last.fbo);
      let avgLum = null;
      try {
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._auto.pixU8);
        const u = (this._auto.pixU8[0] || 0) / 255.0;
        const logY = (-8.0) + u * 10.0;
        avgLum = Math.exp(logY);
      } catch { /* ignore */ }
      if (avgLum !== null && Number.isFinite(avgLum)) {
        this._auto.measuredLum = Math.max(1e-3, Math.min(1e3, avgLum));
      }
    }

    const now = performance.now();
    const dt = (this._auto.lastMs > 0) ? Math.max(0.0, (now - this._auto.lastMs) * 0.001) : (1.0 / 60.0);
    this._auto.lastMs = now;
    const speed = Math.max(0.0, Number(this.autoExposureSpeed) || 0.0);
    const k = 1.0 - Math.exp(-dt * speed);
    const prev = Number(this._auto.adaptedLum) || 1.0;
    const next = prev + (this._auto.measuredLum - prev) * k;
    this._auto.adaptedLum = Number.isFinite(next) ? next : prev;

    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** @returns {WebGLFramebuffer|null} */
  get sceneFramebuffer() {
    return this._scene?.fbo || null;
  }
}


