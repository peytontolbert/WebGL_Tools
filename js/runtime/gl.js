export function getGl(canvas) {
  const opts = {
    antialias: true,
    alpha: false,
    depth: true,
    stencil: false,
    preserveDrawingBuffer: false,
    premultipliedAlpha: false,
    powerPreference: 'high-performance',
    desynchronized: true,
  };
  /** @type {WebGL2RenderingContext|null} */
  let gl = null;
  try { gl = canvas.getContext('webgl2', opts); } catch { gl = null; }
  // This editor relies on WebGL2 features:
  // - GLSL ES 3.00 shaders (`#version 300 es`)
  // - `texelFetch` + `textureSize` in vertex shader
  // - R32F height textures
  if (!gl) throw new Error('WebGL2 is required for the map editor (failed to create WebGL2 context).');
  return gl;
}

export function isWebGL2(gl) {
  try {
    return (typeof WebGL2RenderingContext !== 'undefined') && (gl instanceof WebGL2RenderingContext);
  } catch {
    return false;
  }
}


