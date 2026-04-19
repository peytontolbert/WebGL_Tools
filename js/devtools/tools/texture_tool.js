import { el, clear } from '../../ui/dom.js';
import { createCopyButton } from '../components/ui_components.js';

function bytesToMiB(n) {
  const b = Number(n) || 0;
  return (b / (1024 * 1024)).toFixed(2);
}

function isProbablyKtx2(path) {
  return String(path || '').toLowerCase().endsWith('.ktx2');
}

export class TextureTool {
  constructor() {
    this.id = 'textures';
    this.label = 'Textures';

    this._ctx = null;
    this._root = null;

    this._host = null;
    this._img = null;
    this._placeholder = null;

    this._state = {
      path: '',
      fit: 'contain', // contain | cover | pixel
      checker: true,
      smooth: true,
    };

    this._info = {
      bytes: 0,
      width: 0,
      height: 0,
      loaded: false,
      error: '',
    };

    this._infoEl = null;
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;

    // Canvas host: show image preview.
    const host = document.createElement('div');
    host.style.width = '100%';
    host.style.height = '100%';
    host.style.display = 'flex';
    host.style.alignItems = 'center';
    host.style.justifyContent = 'center';
    host.style.position = 'relative';
    host.style.overflow = 'hidden';
    this._host = host;
    ctx.canvasHost.appendChild(host);

    const placeholder = document.createElement('div');
    placeholder.style.position = 'absolute';
    placeholder.style.inset = '0';
    placeholder.style.display = 'flex';
    placeholder.style.alignItems = 'center';
    placeholder.style.justifyContent = 'center';
    placeholder.style.color = 'rgba(234,240,255,0.75)';
    placeholder.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    placeholder.style.fontSize = '12px';
    placeholder.style.whiteSpace = 'pre';
    placeholder.textContent = 'Texture preview\n(search + select on the right)';
    this._placeholder = placeholder;
    host.appendChild(placeholder);

    const img = document.createElement('img');
    img.alt = 'texture preview';
    img.decoding = 'async';
    img.loading = 'eager';
    img.style.maxWidth = '100%';
    img.style.maxHeight = '100%';
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'contain';
    img.style.display = 'none';
    img.style.userSelect = 'none';
    img.draggable = false;
    this._img = img;
    host.appendChild(img);

    img.addEventListener('load', () => {
      this._info.loaded = true;
      this._info.error = '';
      this._info.width = img.naturalWidth | 0;
      this._info.height = img.naturalHeight | 0;
      this._syncInfo();
    });
    img.addEventListener('error', () => {
      this._info.loaded = false;
      this._info.width = 0;
      this._info.height = 0;
      this._info.error = 'Failed to load image (check path / type)';
      this._syncInfo();
    });

    this._applyPreviewStyle();
    this._buildUi();

    // Restore last selection if any.
    try {
      const saved = String(localStorage.getItem('devtools.texture.path') || '');
      if (saved) {
        this._state.path = saved;
        await this._loadTexture(saved);
      }
    } catch { /* ignore */ }
  }

  async unmount() {
    this._ctx = null;
    this._root = null;
    try {
      if (this._img) this._img.src = '';
    } catch { /* ignore */ }
    if (this._host?.parentNode) this._host.parentNode.removeChild(this._host);
    this._host = null;
    this._img = null;
    this._placeholder = null;
  }

  tick() {}

  getStats() {
    const p = String(this._state.path || '');
    return {
      texture: p,
      size: (this._info.loaded && this._info.width && this._info.height) ? `${this._info.width}x${this._info.height}` : '',
      bytesMiB: this._info.bytes ? `${bytesToMiB(this._info.bytes)} MiB` : '',
      fit: String(this._state.fit || ''),
    };
  }

  _buildUi() {
    if (!this._root) return;
    clear(this._root);

    const ctx = this._ctx;
    const st = this._state;

    const pathInput = el('input', {
      value: st.path,
      placeholder: 'assets/.../albedo.png',
      oninput: (e) => { st.path = String(e.target.value || '').trim(); },
    });

    const loadBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { await this._loadTexture(st.path); }
        catch (e) {
          ctx?.log?.(`Textures: load failed: ${e?.message || e}`);
          ctx?.toast?.(String(e?.message || e || 'Load failed'), 'error', { title: 'Texture load failed' });
        }
      },
    }, ['Load']);

    const copyBtn = createCopyButton({
      ctx,
      label: 'Copy',
      toastTitle: 'Path copied',
      getText: () => String(st.path || ''),
    });

    const fitSel = el('select', {
      value: st.fit,
      onchange: () => { st.fit = String(fitSel.value || 'contain'); this._applyPreviewStyle(); },
    }, [
      el('option', { value: 'contain' }, ['Fit (contain)']),
      el('option', { value: 'cover' }, ['Fill (cover)']),
      el('option', { value: 'pixel' }, ['1:1-ish (pixelated)']),
    ]);

    const checker = el('input', {
      type: 'checkbox',
      checked: !!st.checker,
      onchange: (e) => { st.checker = !!e.target.checked; this._applyPreviewStyle(); },
    });

    const smooth = el('input', {
      type: 'checkbox',
      checked: !!st.smooth,
      onchange: (e) => { st.smooth = !!e.target.checked; this._applyPreviewStyle(); },
    });

    const infoEl = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['No texture loaded yet.']);
    this._infoEl = infoEl;

    const assetPicker = this._buildAssetPicker({
      title: 'Asset Picker (textures)',
      ext: '.png,.jpg,.jpeg,.webp,.ktx2',
      onPick: async (p, bytes) => {
        try {
          st.path = p;
          pathInput.value = p;
          this._info.bytes = Number(bytes) || 0;
          await this._loadTexture(p);
          ctx?.toast?.(`Selected: ${String(p).split('/').pop()}`, 'success');
        } catch (e) {
          ctx?.toast?.(String(e?.message || e || 'Load failed'), 'error', { title: 'Texture' });
        }
      },
    });

    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Texture']),
      el('div', { class: 'muted' }, ['Preview common image textures from `assets/`. (KTX2 preview not supported here yet.)']),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px' } }, [pathInput, loadBtn, copyBtn]),
      infoEl,
    ]));

    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Preview settings']),
      el('div', { class: 'row' }, [
        el('div', {}, [el('div', { class: 'muted' }, ['fit']), fitSel]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
          checker,
          el('div', { class: 'muted', style: { flex: '1 1 auto' } }, ['Checkerboard bg']),
        ]),
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
          smooth,
          el('div', { class: 'muted', style: { flex: '1 1 auto' } }, ['Smooth scaling']),
        ]),
      ]),
    ]));

    this._root.appendChild(assetPicker);
    this._syncInfo();
  }

  _buildAssetPicker({ title, ext, onPick }) {
    const ctx = this._ctx;
    const queryInput = el('input', {
      placeholder: 'search assets (e.g. albedo, atlas, ui)',
      value: String(localStorage.getItem('devtools.textures.query') || ''),
      oninput: (e) => {
        try { localStorage.setItem('devtools.textures.query', String(e.target.value || '')); } catch { /* ignore */ }
      },
    });
    const list = el('div', { class: 'scrollArea', style: { height: '220px' } }, ['(search to populate)']);

    const refresh = async () => {
      const q = String(queryInput.value || '').trim();
      if (!q) {
        list.textContent = '(search to populate)';
        return;
      }
      try {
        list.textContent = 'Loading...';
        const items = await ctx.assetIndex({ query: q, ext });
        if (!items.length) {
          list.textContent = '(no matches)';
          return;
        }
        clear(list);
        for (const it of items.slice(0, 350)) {
          const p = String(it?.path || '');
          const bytes = Number(it?.bytes) || 0;
          const btn = el('button', {
            class: 'toolBtn',
            style: { marginTop: '6px' },
            onclick: () => onPick(p, bytes),
            title: `${bytes} bytes`,
          }, [`${p} (${bytesToMiB(bytes)} MiB)`]);
          list.appendChild(btn);
        }
      } catch (e) {
        list.textContent = `(error) ${e?.message || e}`;
      }
    };
    queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') refresh(); });

    queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') refresh(); });

    return el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, [String(title || 'Assets')]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        queryInput,
        el('button', { onclick: refresh }, ['Search']),
      ]),
      el('div', { class: 'muted', style: { marginTop: '6px' } }, ['Uses local Vite dev endpoint `/__editor_assets_index`.']),
      el('div', { style: { marginTop: '8px' } }, [list]),
    ]);
  }

  _applyPreviewStyle() {
    const st = this._state;
    const host = this._host;
    const img = this._img;
    if (!host || !img) return;

    // Checkerboard background for alpha readability.
    if (st.checker) {
      host.style.backgroundImage =
        'linear-gradient(45deg, rgba(255,255,255,0.08) 25%, transparent 25%),' +
        'linear-gradient(-45deg, rgba(255,255,255,0.08) 25%, transparent 25%),' +
        'linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.08) 75%),' +
        'linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.08) 75%)';
      host.style.backgroundSize = '32px 32px';
      host.style.backgroundPosition = '0 0, 0 16px, 16px -16px, -16px 0px';
    } else {
      host.style.backgroundImage = 'none';
    }

    const fit = String(st.fit || 'contain');
    if (fit === 'cover') {
      img.style.objectFit = 'cover';
    } else {
      img.style.objectFit = 'contain';
    }

    // "pixel" mode: keep contain but disable smoothing, plus pixelated rendering.
    const wantSmooth = !!st.smooth && fit !== 'pixel';
    img.style.imageRendering = wantSmooth ? 'auto' : 'pixelated';
    img.style.filter = 'none';
  }

  async _loadTexture(path) {
    const ctx = this._ctx;
    const p = String(path || '').trim();
    this._state.path = p;
    this._info.loaded = false;
    this._info.error = '';
    this._info.width = 0;
    this._info.height = 0;

    if (!this._img || !this._placeholder) return;

    if (!p) {
      this._img.style.display = 'none';
      this._placeholder.style.display = 'flex';
      this._placeholder.textContent = 'Texture preview\n(search + select on the right)';
      this._syncInfo();
      return;
    }

    try { localStorage.setItem('devtools.texture.path', p); } catch { /* ignore */ }

    if (isProbablyKtx2(p)) {
      // KTX2 needs a transcoder (BasisU / KTX2Loader); we keep this tool dependency-free.
      this._img.style.display = 'none';
      this._placeholder.style.display = 'flex';
      this._placeholder.textContent = `KTX2 preview not supported here yet.\n\nSelected:\n${p}`;
      this._info.error = 'KTX2 preview not supported';
      this._syncInfo();
      ctx?.log?.(`Textures: selected KTX2 (no preview): ${p}`);
      return;
    }

    this._placeholder.style.display = 'none';
    this._img.style.display = 'block';
    this._img.src = p;
    this._syncInfo();
    ctx?.log?.(`Textures: loading ${p}`);
  }

  _syncInfo() {
    const elInfo = this._infoEl;
    if (!elInfo) return;
    const p = String(this._state.path || '');
    const bytes = Number(this._info.bytes) || 0;
    const wh = (this._info.loaded && this._info.width && this._info.height)
      ? `${this._info.width} x ${this._info.height}`
      : '(not loaded)';
    const b = bytes ? `${bytesToMiB(bytes)} MiB` : '(unknown size)';
    const err = this._info.error ? `\nerror: ${this._info.error}` : '';
    elInfo.textContent = `path: ${p || '(none)'}\nsize: ${wh}\nfile: ${b}${err}`;
  }
}

