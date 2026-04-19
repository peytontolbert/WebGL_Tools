import { el, clear } from '../../ui/dom.js';
import { createDropZone, createProgressBar, createAssetPicker, fileToDataUrl, guessExtFromDataUrl } from '../components/ui_components.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeTrim(s) {
  return String(s ?? '').trim();
}

function applyCheckerboard(host, enabled) {
  if (!host) return;
  if (enabled) {
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
}

export class RembgTool {
  constructor() {
    this.id = 'rembg';
    this.label = 'Remove BG (BiRefNet)';

    this._ctx = null;
    this._root = null;

    this._host = null;
    this._inPane = null;
    this._outPane = null;
    this._inImg = null;
    this._outImg = null;
    this._inLabel = null;
    this._outLabel = null;

    this._state = {
      runner: 'conda_trellis', // python3 | conda_trellis
      inImageAssetPath: '',
      outName: 'cutout',
      device: 'cuda',
      rembgModel: 'ZhengPeng7/BiRefNet',
      showChecker: true,
    };

    this._job = { id: '', status: '', stdout: '', stderr: '', outImage: '' };
    this._polling = false;
    this._logEl = null;
    this._statusEl = null;
    this._outEl = null;

    this._fileDataUrl = '';
    this._fileExt = 'png';
    this._fileName = '';
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;
    this._buildPreviewHost();
    this._buildUi();
  }

  async unmount() {
    this._polling = false;
    this._ctx = null;
    this._root = null;
    try {
      if (this._inImg) this._inImg.src = '';
      if (this._outImg) this._outImg.src = '';
    } catch { /* ignore */ }
    if (this._host?.parentNode) this._host.parentNode.removeChild(this._host);
    this._host = null;
    this._inPane = null;
    this._outPane = null;
    this._inImg = null;
    this._outImg = null;
    this._inLabel = null;
    this._outLabel = null;
  }

  tick() {}

  getStats() {
    return {
      job: this._job?.status || '',
      outImage: this._job?.outImage || '',
    };
  }

  _buildPreviewHost() {
    const ctx = this._ctx;
    if (!ctx?.canvasHost) return;

    const host = document.createElement('div');
    host.style.width = '100%';
    host.style.height = '100%';
    host.style.display = 'grid';
    host.style.gridTemplateColumns = '1fr 1fr';
    host.style.gap = '10px';
    host.style.padding = '10px';
    host.style.boxSizing = 'border-box';
    host.style.alignItems = 'stretch';
    host.style.justifyItems = 'stretch';
    host.style.overflow = 'hidden';
    this._host = host;
    ctx.canvasHost.appendChild(host);

    const mkPane = (title) => {
      const pane = document.createElement('div');
      pane.style.position = 'relative';
      pane.style.borderRadius = '12px';
      pane.style.border = '1px solid rgba(255,255,255,0.14)';
      pane.style.background = 'rgba(0,0,0,0.25)';
      pane.style.overflow = 'hidden';
      pane.style.display = 'flex';
      pane.style.alignItems = 'center';
      pane.style.justifyContent = 'center';

      const label = document.createElement('div');
      label.style.position = 'absolute';
      label.style.left = '10px';
      label.style.top = '10px';
      label.style.zIndex = '2';
      label.style.padding = '6px 8px';
      label.style.borderRadius = '10px';
      label.style.border = '1px solid rgba(255,255,255,0.14)';
      label.style.background = 'rgba(0,0,0,0.45)';
      label.style.color = 'rgba(234,240,255,0.92)';
      label.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      label.style.fontSize = '11px';
      label.textContent = title;
      pane.appendChild(label);

      const img = document.createElement('img');
      img.alt = title;
      img.decoding = 'async';
      img.loading = 'eager';
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'contain';
      img.style.userSelect = 'none';
      img.draggable = false;
      pane.appendChild(img);

      return { pane, label, img };
    };

    const a = mkPane('input');
    const b = mkPane('cutout');
    this._inPane = a.pane;
    this._outPane = b.pane;
    this._inLabel = a.label;
    this._outLabel = b.label;
    this._inImg = a.img;
    this._outImg = b.img;
    host.appendChild(a.pane);
    host.appendChild(b.pane);

    this._syncChecker();
    this._syncPreviewImages();
  }

  _syncChecker() {
    const st = this._state;
    applyCheckerboard(this._inPane, !!st.showChecker);
    applyCheckerboard(this._outPane, !!st.showChecker);
  }

  _syncPreviewImages() {
    // Input preview
    if (this._inImg) {
      if (this._fileDataUrl) this._inImg.src = this._fileDataUrl;
      else if (this._state.inImageAssetPath) this._inImg.src = this._state.inImageAssetPath;
      else this._inImg.src = '';
    }
    // Output preview
    if (this._outImg) {
      this._outImg.src = this._job?.outImage ? this._job.outImage : '';
    }
    if (this._inLabel) {
      const src = this._fileDataUrl ? (this._fileName ? `upload: ${this._fileName}` : 'upload') : (this._state.inImageAssetPath || '(none)');
      this._inLabel.textContent = `input: ${src}`;
    }
    if (this._outLabel) {
      this._outLabel.textContent = this._job?.outImage ? `cutout: ${this._job.outImage}` : 'cutout: (none)';
    }
  }

  _buildUi() {
    if (!this._root) return;
    clear(this._root);
    const st = this._state;

    const runner = el('select', {
      value: st.runner,
      onchange: (e) => { st.runner = String(e.target.value || 'conda_trellis'); },
    }, [
      el('option', { value: 'conda_trellis' }, ['conda run -n trellis python3 (recommended)']),
      el('option', { value: 'python3' }, ['python3 (uses current env)']),
    ]);

    const inPath = el('input', {
      value: st.inImageAssetPath,
      placeholder: 'assets/.../image.png',
      oninput: (e) => {
        st.inImageAssetPath = safeTrim(e.target.value);
        // If user starts typing an asset path, consider that authoritative.
        if (st.inImageAssetPath) {
          this._fileDataUrl = '';
          this._fileName = '';
        }
        this._syncPreviewImages();
      },
    });

    const dropZone = createDropZone({
      accept: 'image/*',
      label: 'Drop image or click to browse',
      hint: 'PNG, JPG, WebP',
      icon: '◐',
      onFiles: async (files) => {
        try {
          const f = files[0];
          if (!f) return;
          this._fileDataUrl = await fileToDataUrl(f);
          this._fileExt = guessExtFromDataUrl(this._fileDataUrl);
          this._fileName = String(f.name || '');
          st.inImageAssetPath = '';
          inPath.value = '';
          this._ctx?.log?.(`Rembg: staged upload (${f.name}, ${f.size} bytes)`);
          if (this._statusEl) this._statusEl.textContent = `Staged upload: ${f.name}`;
          this._syncPreviewImages();
        } catch (err) {
          this._ctx?.log?.(`Rembg: upload read failed: ${err?.message || err}`);
        }
      },
    });

    const outName = el('input', {
      value: st.outName,
      placeholder: 'name hint',
      oninput: (e) => { st.outName = safeTrim(e.target.value); },
    });

    const device = el('input', {
      value: st.device,
      placeholder: 'cuda | cuda:0 | cpu',
      oninput: (e) => { st.device = safeTrim(e.target.value); },
    });

    const model = el('input', {
      value: st.rembgModel,
      oninput: (e) => { st.rembgModel = safeTrim(e.target.value); },
    });

    const showChecker = el('input', {
      type: 'checkbox',
      checked: !!st.showChecker,
      onchange: (e) => { st.showChecker = !!e.target.checked; this._syncChecker(); },
    });

    this._rembgProgress = createProgressBar();
    this._statusEl = el('div', { class: 'muted', style: { marginTop: '8px', display: 'flex', alignItems: 'center', gap: '6px' } }, ['Idle.']);
    this._outEl = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
    this._logEl = el('div', { class: 'scrollArea', style: { height: '240px' } }, ['(logs will appear here)']);

    const startBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { await this._startJob(); } catch (e) { this._ctx?.log?.(`Rembg: start failed: ${e?.message || e}`); }
      },
    }, ['Remove background']);

    const killBtn = el('button', {
      class: 'danger',
      onclick: async () => {
        const id = this._job?.id;
        if (!id) return;
        try {
          await fetch('/__devtools_zimage_rembg_kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
        } catch { /* ignore */ }
      },
    }, ['Kill job']);

    const copyOutBtn = el('button', {
      onclick: async () => {
        const p = this._job?.outImage || '';
        if (!p) return;
        try { await navigator.clipboard.writeText(p); this._ctx?.log?.('Rembg: copied output path'); } catch { /* ignore */ }
      },
    }, ['Copy cutout path']);

    const openInTexturesBtn = el('button', {
      onclick: () => {
        const p = this._job?.outImage || '';
        if (!p) return;
        try { localStorage.setItem('devtools.texture.path', p); } catch { /* ignore */ }
        this._ctx?.log?.('Rembg: set devtools.texture.path (switch to Textures tool)');
      },
    }, ['Send to Texture Viewer']);

    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Background remover']),
      el('div', { class: 'muted' }, [
        'Runs `tools/remove_bg_birefnet.py` (BiRefNet) via the local Vite dev server. ',
        'Outputs go to `assets/generated/zimage/` as an RGBA PNG.',
      ]),
      el('div', { class: 'muted', style: { marginTop: '6px' } }, ['Runner']),
      runner,
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Input image (asset path)']),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [inPath]),
      el('div', { class: 'muted', style: { marginTop: '6px' } }, ['…or upload']),
      dropZone,
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['outName']), outName]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['device']), device]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['model']), model]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
          showChecker,
          el('div', { class: 'muted', style: { flex: '1 1 auto' } }, ['Checkerboard preview']),
        ]),
      ]),
      el('div', { class: 'row', style: { marginTop: '12px' } }, [startBtn, killBtn, copyOutBtn, openInTexturesBtn]),
      this._rembgProgress.element,
      this._statusEl,
      this._outEl,
    ]));

    this._root.appendChild(createAssetPicker({
      ctx: this._ctx,
      title: 'Asset Picker (images)',
      ext: '.png,.jpg,.jpeg,.webp',
      placeholder: 'Search images\u2026',
      onPick: (p) => {
        st.inImageAssetPath = p;
        inPath.value = p;
        this._fileDataUrl = '';
        this._fileName = '';
        this._syncPreviewImages();
      },
    }));

    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Logs']),
      this._logEl,
    ]));
  }

  async _startJob() {
    const st = this._state;
    const ctx = this._ctx;

    const useUpload = !!this._fileDataUrl;
    const inAsset = safeTrim(st.inImageAssetPath);
    if (!useUpload && !inAsset) {
      throw new Error('Pick an asset image or upload one');
    }

    const payload = {
      runner: st.runner,
      outName: st.outName,
      device: st.device,
      rembgModel: st.rembgModel,
    };

    if (useUpload) {
      payload.inImageDataUrl = this._fileDataUrl;
      payload.inImageExt = this._fileExt;
    } else {
      payload.inImageAssetPath = inAsset;
    }

    this._updateRembgStatus('Starting job\u2026', 'running');
    this._rembgProgress?.setIndeterminate();
    if (this._outEl) this._outEl.textContent = '';
    if (this._logEl) this._logEl.textContent = '(starting\u2026)';
    this._job = { id: '', status: 'running', stdout: '', stderr: '', outImage: '' };
    this._syncPreviewImages();

    const resp = await fetch('/__devtools_zimage_rembg_start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'start failed'));

    this._job = {
      id: String(j.id || ''),
      status: 'running',
      stdout: '',
      stderr: '',
      outImage: String(j.outImage || ''),
    };
    ctx?.log?.(`Rembg: job started (${this._job.id})`);
    this._ctx?.toast?.('Background removal started', 'info', { title: 'Remove BG' });
    this._syncPreviewImages();

    this._polling = true;
    void this._pollJobLoop();
  }

  _updateRembgStatus(text, dotClass = 'idle') {
    if (!this._statusEl) return;
    clear(this._statusEl);
    this._statusEl.appendChild(el('div', { class: `statusDot ${dotClass}` }));
    this._statusEl.appendChild(document.createTextNode(text));
  }

  async _pollJobLoop() {
    const id = this._job?.id;
    if (!id) return;
    let backoff = 400;
    while (this._polling && this._job?.id === id) {
      try {
        const resp = await fetch(`/__devtools_zimage_rembg_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'job query failed'));
        this._job.status = String(j.status || '');
        this._job.stdout = String(j.stdout || '');
        this._job.stderr = String(j.stderr || '');
        this._job.outImage = String(j.outImage || this._job.outImage || '');

        const code = (j.exitCode == null) ? '' : ` (exit ${j.exitCode})`;
        const dotClass = (this._job.status === 'done') ? 'done'
          : (this._job.status === 'error' || this._job.status === 'killed') ? 'error' : 'running';
        this._updateRembgStatus(`${this._job.status}${code}`, dotClass);

        if (this._logEl) {
          const out = this._job.stdout || '';
          const err = this._job.stderr || '';
          const text = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output yet)';
          this._logEl.textContent = text;
          try { this._logEl.scrollTop = this._logEl.scrollHeight; } catch { /* ignore */ }
        }
        if (this._outEl) {
          this._outEl.textContent = this._job.outImage ? `PNG: ${this._job.outImage}` : '';
        }

        this._syncPreviewImages();

        if (this._job.status === 'done' || this._job.status === 'error' || this._job.status === 'killed') {
          this._polling = false;
          this._rembgProgress?.hide();
          if (this._job.status === 'done') {
            this._rembgProgress?.set(1);
            this._ctx?.log?.(`Rembg: done → ${this._job.outImage}`);
            this._ctx?.toast?.('Background removed successfully', 'success', { title: 'Remove BG' });
            try { localStorage.setItem('devtools.rembg.lastOutImage', this._job.outImage || ''); } catch { /* ignore */ }
          } else {
            this._ctx?.log?.(`Rembg: finished (${this._job.status})`);
            this._ctx?.toast?.(`Remove BG: ${this._job.status}`, 'error', { title: 'Remove BG' });
          }
          return;
        }
        backoff = 500;
      } catch (e) {
        this._updateRembgStatus(`Polling failed: ${e?.message || e}`, 'error');
        backoff = Math.min(2000, Math.floor(backoff * 1.4));
      }
      await sleep(backoff);
    }
  }
}

