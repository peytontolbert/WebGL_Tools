import { el, clear } from '../../ui/dom.js';
import { getGl } from '../../runtime/gl.js';

function safeGet(gl, pname) {
  try { return gl.getParameter(pname); } catch { return null; }
}

function toStr(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

export class GlInfoTool {
  constructor() {
    this.id = 'gl';
    this.label = 'GL Info';
    this._ctx = null;
    this._root = null;
    this._canvas = null;
    this._gl = null;
    this._pre = null;
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;

    // Create a tiny WebGL2 canvas for querying caps.
    this._canvas = document.createElement('canvas');
    this._canvas.width = 4;
    this._canvas.height = 4;
    this._canvas.style.width = '100%';
    this._canvas.style.height = '100%';
    ctx.canvasHost.appendChild(this._canvas);

    this._gl = getGl(this._canvas);
    this._buildUi();
    this._refresh();
  }

  async unmount() {
    this._gl = null;
    if (this._canvas?.parentNode) this._canvas.parentNode.removeChild(this._canvas);
    this._canvas = null;
    this._ctx = null;
    this._root = null;
  }

  tick() {
    // no-op
  }

  _buildUi() {
    if (!this._root) return;
    clear(this._root);

    this._pre = el('div', { class: 'scrollArea', style: { height: '420px' } }, ['(loading...)']);

    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['WebGL2 capabilities']),
      el('div', { class: 'muted' }, ['Renderer/vendor strings are often masked by the browser; still useful for debugging driver differences.']),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('button', { class: 'primary', onclick: () => this._refresh() }, ['Refresh']),
        el('button', {
          onclick: async () => {
            try {
              const text = this._pre?.textContent || '';
              await navigator.clipboard.writeText(text);
              this._ctx?.log?.('GL Info: copied to clipboard');
              this._ctx?.toast?.('Copied GL info', 'success');
            } catch (e) {
              this._ctx?.log?.(`GL Info: copy failed: ${e?.message || e}`);
              this._ctx?.toast?.(String(e?.message || e || 'Copy failed'), 'error', { title: 'Copy failed' });
            }
          },
        }, ['Copy']),
      ]),
      el('div', { style: { marginTop: '10px' } }, [this._pre]),
    ]));
  }

  _refresh() {
    if (!this._gl || !this._pre) return;
    const gl = this._gl;

    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = dbg ? safeGet(gl, dbg.UNMASKED_VENDOR_WEBGL) : safeGet(gl, gl.VENDOR);
    const renderer = dbg ? safeGet(gl, dbg.UNMASKED_RENDERER_WEBGL) : safeGet(gl, gl.RENDERER);

    const lines = [];
    lines.push(`version: ${toStr(safeGet(gl, gl.VERSION))}`);
    lines.push(`shadingLanguageVersion: ${toStr(safeGet(gl, gl.SHADING_LANGUAGE_VERSION))}`);
    lines.push(`vendor: ${toStr(vendor)}`);
    lines.push(`renderer: ${toStr(renderer)}`);
    lines.push('');

    const caps = [
      ['MAX_TEXTURE_SIZE', gl.MAX_TEXTURE_SIZE],
      ['MAX_CUBE_MAP_TEXTURE_SIZE', gl.MAX_CUBE_MAP_TEXTURE_SIZE],
      ['MAX_RENDERBUFFER_SIZE', gl.MAX_RENDERBUFFER_SIZE],
      ['MAX_TEXTURE_IMAGE_UNITS', gl.MAX_TEXTURE_IMAGE_UNITS],
      ['MAX_VERTEX_TEXTURE_IMAGE_UNITS', gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS],
      ['MAX_COMBINED_TEXTURE_IMAGE_UNITS', gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS],
      ['MAX_VERTEX_ATTRIBS', gl.MAX_VERTEX_ATTRIBS],
      ['MAX_VERTEX_UNIFORM_VECTORS', gl.MAX_VERTEX_UNIFORM_VECTORS],
      ['MAX_FRAGMENT_UNIFORM_VECTORS', gl.MAX_FRAGMENT_UNIFORM_VECTORS],
      ['MAX_UNIFORM_BUFFER_BINDINGS', gl.MAX_UNIFORM_BUFFER_BINDINGS],
      ['MAX_COLOR_ATTACHMENTS', gl.MAX_COLOR_ATTACHMENTS],
      ['MAX_DRAW_BUFFERS', gl.MAX_DRAW_BUFFERS],
      ['MAX_SAMPLES', gl.MAX_SAMPLES],
    ];
    for (const [name, p] of caps) lines.push(`${name}: ${toStr(safeGet(gl, p))}`);

    lines.push('');
    let exts = [];
    try { exts = gl.getSupportedExtensions() || []; } catch { exts = []; }
    exts.sort();
    lines.push(`extensions (${exts.length}):`);
    for (const e of exts) lines.push(`- ${e}`);

    this._pre.textContent = lines.join('\n');
  }
}

