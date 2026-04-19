import { el, clear } from '../../ui/dom.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeTrim(s) {
  return String(s ?? '').trim();
}

function guessExtFromDataUrl(dataUrl) {
  const s = String(dataUrl || '');
  const m = s.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,/);
  if (!m) return 'png';
  const ext = m[1].toLowerCase();
  if (ext.includes('jpeg')) return 'jpg';
  if (ext.includes('png')) return 'png';
  if (ext.includes('webp')) return 'webp';
  return 'png';
}

async function fileToDataUrl(file) {
  const f = file;
  if (!f) throw new Error('Missing file');
  const ab = await f.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  const mime = f.type || 'image/png';
  return `data:${mime};base64,${b64}`;
}

function safeImgSrcForProjectPath(p) {
  const s = safeTrim(p);
  if (!s) return '';
  // Only allow repo-relative paths that are served by Vite.
  if (!(s.startsWith('assets/') || s.startsWith('outputs/'))) return '';
  return `/${encodeURI(s)}`;
}

function sortNewestFirst(items) {
  const arr = Array.isArray(items) ? [...items] : [];
  arr.sort((a, b) => Number(b?.mtimeMs || 0) - Number(a?.mtimeMs || 0));
  return arr;
}

export class ImageModelGenTool {
  constructor() {
    this.id = 'image_model_gen';
    this.label = 'Image → 3D';
    this._ctx = null;
    this._root = null;

    this._state = {
      runner: 'conda_hunyuan3d', // python3 | conda_hunyuan3d | conda_trellis
      meshBackend: 'hunyuan', // hunyuan | trellis
      inputMode: 'asset', // 'asset' | 'upload'
      imageAssetPath: '',
      outName: 'model_gen_asset',
      device: 'cuda',
      model: 'tencent/Hunyuan3D-2',
      pipelineType: '1024_cascade',
      seed: 42,
      preprocessImage: 1,
      steps: 50,
      guidanceStrength: 3.0,
      ssSteps: 12,
      ssGuidanceStrength: 7.5,
      ssGuidanceRescale: 0.7,
      ssRescaleT: 5.0,
      shapeSteps: 12,
      shapeGuidanceStrength: 7.5,
      shapeGuidanceRescale: 0.5,
      shapeRescaleT: 3.0,
      texSteps: 12,
      texGuidanceStrength: 1.0,
      texGuidanceRescale: 0.0,
      texRescaleT: 3.0,
      simplify: 16777216,
      aabb: '-0.5,-0.5,-0.5,0.5,0.5,0.5',
      decimationTarget: 1000000,
      textureSize: 4096,
      remesh: 1,
      remeshBand: 1,
      remeshProject: 0,
      extensionWebp: 1,
      // Optional preview render
      renderMp4: 0,
      envmap: '',
      fps: 15,
      rigBackend: '',
      rigArgs: '',

      // Gallery
      galleryQuery: 'assets/generated/',
    };

    this._envmaps = [];
    this._job = { id: '', status: '', stdout: '', stderr: '', outGlb: '', outMp4: '', outRig: '' };
    this._polling = false;
    this._envCheck = { checking: false, result: null, error: '' };

    // UI refs
    this._logEl = null;
    this._statusEl = null;
    this._outEl = null;
    this._fileInput = null;
    this._previewImg = null;
    this._previewCaption = null;
    this._galleryListEl = null;
    this._envEl = null;

    // Upload state
    this._fileDataUrl = '';
    this._fileExt = 'png';
    this._fileName = '';
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;

    // Restore persisted state (best-effort).
    try {
      const raw = localStorage.getItem('devtools.image_model_gen.state');
      if (raw) {
        const j = JSON.parse(raw);
        if (j && typeof j === 'object') Object.assign(this._state, j);
      }
    } catch { /* ignore */ }

    try {
      const resp = await fetch('/__devtools_envmaps');
      const j = await resp.json();
      this._envmaps = Array.isArray(j?.items) ? j.items.map((x) => String(x || '')).filter(Boolean) : [];
    } catch { /* ignore */ }

    this._buildUi();
    void this._refreshGallery({ auto: true });
  }

  async unmount() {
    this._polling = false;
    this._ctx = null;
    this._root = null;
  }

  tick() {}

  getStats() {
    return {
      job: this._job?.status || '',
      outGlb: this._job?.outGlb || '',
      outRig: this._job?.outRig || '',
    };
  }

  _persistState() {
    try {
      localStorage.setItem('devtools.image_model_gen.state', JSON.stringify(this._state));
    } catch { /* ignore */ }
  }

  _setPreviewFromState() {
    if (!this._previewImg || !this._previewCaption) return;
    const st = this._state;

    if (st.inputMode === 'upload' && this._fileDataUrl) {
      this._previewImg.src = this._fileDataUrl;
      this._previewCaption.textContent = this._fileName ? `Upload: ${this._fileName}` : 'Upload: (staged)';
      return;
    }

    const src = safeImgSrcForProjectPath(st.imageAssetPath);
    if (src) {
      this._previewImg.src = src;
      this._previewCaption.textContent = `Asset: ${st.imageAssetPath}`;
      return;
    }

    // Placeholder
    this._previewImg.removeAttribute('src');
    this._previewCaption.textContent = 'No image selected yet.';
  }

  _buildUi() {
    if (!this._root) return;
    clear(this._root);
    const st = this._state;

    const runner = el('select', {
      value: st.runner,
      onchange: (e) => {
        st.runner = String(e.target.value || 'conda_hunyuan3d');
        this._persistState();
      },
    }, [
      el('option', { value: 'conda_hunyuan3d' }, ['conda run -n hunyuan3d python3 (recommended)']),
      el('option', { value: 'conda_trellis' }, ['conda run -n trellis python3 (recommended)']),
      el('option', { value: 'python3' }, ['python3 (uses current env)']),
    ]);

    const meshBackend = el('select', {
      value: st.meshBackend || 'hunyuan',
      onchange: (e) => {
        st.meshBackend = String(e.target.value || 'hunyuan') === 'trellis' ? 'trellis' : 'hunyuan';
        this._persistState();
      },
    }, [
      el('option', { value: 'hunyuan' }, ['Hunyuan (default)']),
      el('option', { value: 'trellis' }, ['Trellis']),
    ]);

    const inputMode = el('select', {
      value: st.inputMode,
      onchange: (e) => {
        st.inputMode = String(e.target.value || 'asset') === 'upload' ? 'upload' : 'asset';
        this._persistState();
        this._setPreviewFromState();
      },
    }, [
      el('option', { value: 'asset' }, ['Use asset path / library image']),
      el('option', { value: 'upload' }, ['Use uploaded image']),
    ]);

    const imgPath = el('input', {
      value: st.imageAssetPath,
      placeholder: 'assets/.../input.png',
      oninput: (e) => {
        st.imageAssetPath = safeTrim(e.target.value);
        if (st.imageAssetPath) st.inputMode = 'asset';
        this._persistState();
        this._setPreviewFromState();
      },
    });

    const fileInput = el('input', {
      type: 'file',
      accept: 'image/*',
      onchange: async (e) => {
        try {
          const f = e.target.files?.[0] || null;
          if (!f) return;
          this._fileDataUrl = await fileToDataUrl(f);
          this._fileExt = guessExtFromDataUrl(this._fileDataUrl);
          this._fileName = String(f.name || '').trim();
          st.inputMode = 'upload';
          this._persistState();
          this._ctx?.log?.(`Image → 3D: staged upload (${f.name}, ${f.size} bytes)`);
          if (this._statusEl) this._statusEl.textContent = `Staged upload: ${f.name}`;
          this._setPreviewFromState();
        } catch (err) {
          this._ctx?.log?.(`Image → 3D: upload read failed: ${err?.message || err}`);
        }
      },
    });
    this._fileInput = fileInput;

    const clearUploadBtn = el('button', {
      onclick: () => {
        this._fileDataUrl = '';
        this._fileExt = 'png';
        this._fileName = '';
        try { if (this._fileInput) this._fileInput.value = ''; } catch { /* ignore */ }
        if (st.inputMode === 'upload') st.inputMode = 'asset';
        this._persistState();
        this._setPreviewFromState();
      },
      title: 'Clear the staged upload',
    }, ['Clear upload']);

    const outName = el('input', {
      value: st.outName,
      placeholder: 'name hint',
      oninput: (e) => { st.outName = safeTrim(e.target.value); this._persistState(); },
    });

    const device = el('input', {
      value: st.device,
      placeholder: 'cuda | cuda:0 | cpu',
      oninput: (e) => { st.device = safeTrim(e.target.value); this._persistState(); },
    });

    const model = el('input', {
      value: st.model,
      oninput: (e) => { st.model = safeTrim(e.target.value); this._persistState(); },
    });

    const pipelineType = el('select', {
      value: st.pipelineType,
      onchange: (e) => { st.pipelineType = safeTrim(e.target.value) || '1024_cascade'; this._persistState(); },
    }, [
      el('option', { value: '512' }, ['512 (fast)']),
      el('option', { value: '1024' }, ['1024 (balanced)']),
      el('option', { value: '1024_cascade' }, ['1024 cascade (quality)']),
      el('option', { value: '1536_cascade' }, ['1536 cascade (high quality)']),
    ]);

    const seed = el('input', {
      value: String(st.seed),
      oninput: (e) => { st.seed = Number(e.target.value) || 0; this._persistState(); },
    });
    const preprocessImage = el('select', {
      value: String(st.preprocessImage),
      onchange: (e) => { st.preprocessImage = Number(e.target.value) ? 1 : 0; this._persistState(); },
    }, [el('option', { value: '1' }, ['1']), el('option', { value: '0' }, ['0'])]);
    const steps = el('input', {
      value: String(st.steps),
      oninput: (e) => { st.steps = Math.max(1, Number(e.target.value) || 1); this._persistState(); },
    });
    const guidanceStrength = el('input', {
      value: String(st.guidanceStrength),
      oninput: (e) => { st.guidanceStrength = Math.max(0, Number(e.target.value) || 0); this._persistState(); },
    });
    const ssSteps = el('input', {
      value: String(st.ssSteps),
      oninput: (e) => { st.ssSteps = Math.max(1, Number(e.target.value) || 1); this._persistState(); },
    });
    const ssGuidanceStrength = el('input', {
      value: String(st.ssGuidanceStrength),
      oninput: (e) => { st.ssGuidanceStrength = Math.max(0, Number(e.target.value) || 0); this._persistState(); },
    });
    const ssGuidanceRescale = el('input', {
      value: String(st.ssGuidanceRescale),
      oninput: (e) => { st.ssGuidanceRescale = Math.max(0, Number(e.target.value) || 0); this._persistState(); },
    });
    const ssRescaleT = el('input', {
      value: String(st.ssRescaleT),
      oninput: (e) => { st.ssRescaleT = Math.max(0, Number(e.target.value) || 0); this._persistState(); },
    });
    const shapeSteps = el('input', {
      value: String(st.shapeSteps),
      oninput: (e) => { st.shapeSteps = Math.max(1, Number(e.target.value) || 1); this._persistState(); },
    });
    const shapeGuidanceStrength = el('input', {
      value: String(st.shapeGuidanceStrength),
      oninput: (e) => { st.shapeGuidanceStrength = Math.max(0, Number(e.target.value) || 0); this._persistState(); },
    });
    const shapeGuidanceRescale = el('input', {
      value: String(st.shapeGuidanceRescale),
      oninput: (e) => { st.shapeGuidanceRescale = Math.max(0, Number(e.target.value) || 0); this._persistState(); },
    });
    const shapeRescaleT = el('input', {
      value: String(st.shapeRescaleT),
      oninput: (e) => { st.shapeRescaleT = Math.max(0, Number(e.target.value) || 0); this._persistState(); },
    });
    const texSteps = el('input', {
      value: String(st.texSteps),
      oninput: (e) => { st.texSteps = Math.max(1, Number(e.target.value) || 1); this._persistState(); },
    });
    const texGuidanceStrength = el('input', {
      value: String(st.texGuidanceStrength),
      oninput: (e) => { st.texGuidanceStrength = Math.max(0, Number(e.target.value) || 0); this._persistState(); },
    });
    const texGuidanceRescale = el('input', {
      value: String(st.texGuidanceRescale),
      oninput: (e) => { st.texGuidanceRescale = Math.max(0, Number(e.target.value) || 0); this._persistState(); },
    });
    const texRescaleT = el('input', {
      value: String(st.texRescaleT),
      oninput: (e) => { st.texRescaleT = Math.max(0, Number(e.target.value) || 0); this._persistState(); },
    });

    const simplify = el('input', {
      value: String(st.simplify),
      oninput: (e) => { st.simplify = Math.max(0, Number(e.target.value) || 0); this._persistState(); },
    });
    const aabb = el('input', {
      value: st.aabb,
      oninput: (e) => { st.aabb = safeTrim(e.target.value); this._persistState(); },
    });
    const decimationTarget = el('input', {
      value: String(st.decimationTarget),
      oninput: (e) => { st.decimationTarget = Math.max(0, Number(e.target.value) || 0); this._persistState(); },
    });
    const textureSize = el('input', {
      value: String(st.textureSize),
      oninput: (e) => { st.textureSize = Math.max(64, Number(e.target.value) || 4096); this._persistState(); },
    });
    const remesh = el('select', {
      value: String(st.remesh),
      onchange: (e) => { st.remesh = Number(e.target.value) ? 1 : 0; this._persistState(); },
    }, [el('option', { value: '1' }, ['1']), el('option', { value: '0' }, ['0'])]);
    const extensionWebp = el('select', {
      value: String(st.extensionWebp),
      onchange: (e) => { st.extensionWebp = Number(e.target.value) ? 1 : 0; this._persistState(); },
    }, [el('option', { value: '1' }, ['1']), el('option', { value: '0' }, ['0'])]);

    const renderMp4 = el('select', {
      value: String(st.renderMp4),
      onchange: (e) => { st.renderMp4 = Number(e.target.value) ? 1 : 0; this._persistState(); },
    }, [el('option', { value: '0' }, ['0']), el('option', { value: '1' }, ['1'])]);

    const envmapInput = el('input', {
      value: st.envmap,
      placeholder: '(auto default) repos/TRELLIS.2/assets/hdri/studio.exr',
      oninput: (e) => { st.envmap = safeTrim(e.target.value); this._persistState(); },
    });

    const envmapSelect = el('select', {
      value: st.envmap,
      onchange: (e) => {
        const v = String(e.target.value || '');
        st.envmap = v;
        envmapInput.value = v;
        this._persistState();
      },
    }, [
      el('option', { value: '' }, ['(auto default)']),
      ...(this._envmaps || []).map((p) => el('option', { value: p }, [p])),
    ]);

    const fps = el('input', {
      value: String(st.fps),
      oninput: (e) => { st.fps = Math.max(1, Number(e.target.value) || 15); this._persistState(); },
    });

    const rigBackend = el('select', {
      value: st.rigBackend,
      onchange: (e) => { st.rigBackend = String(e.target.value || ''); this._persistState(); },
    }, [
      el('option', { value: '' }, ['(no rig)']),
      el('option', { value: 'rigify' }, ['rigify']),
      el('option', { value: 'blenrig' }, ['blenrig']),
      el('option', { value: 'rigacar' }, ['rigacar']),
      el('option', { value: 'unirig' }, ['unirig']),
      el('option', { value: 'riganything' }, ['riganything']),
      el('option', { value: 'rignet' }, ['rignet']),
    ]);

    const rigArgs = el('input', {
      value: st.rigArgs,
      placeholder: 'extra args for tools/rig_asset.py (optional)',
      oninput: (e) => { st.rigArgs = String(e.target.value || ''); this._persistState(); },
    });

    // Preview image
    const previewImg = el('img', {
      style: {
        width: '100%',
        maxHeight: '260px',
        objectFit: 'contain',
        borderRadius: '12px',
        border: '1px solid rgba(255,255,255,0.10)',
        background: 'rgba(0,0,0,0.25)',
        display: 'block',
      },
      onerror: () => {
        // If the src is bad, clear it (prevents broken image icon).
        try { previewImg.removeAttribute('src'); } catch { /* ignore */ }
      },
    });
    const previewCaption = el('div', { class: 'muted', style: { marginTop: '8px', wordBreak: 'break-word' } }, ['']);
    this._previewImg = previewImg;
    this._previewCaption = previewCaption;

    this._statusEl = el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Idle.']);
    this._outEl = el('div', { class: 'muted', style: { marginTop: '8px' } }, ['']);
    this._logEl = el('div', { class: 'scrollArea', style: { height: '240px' } }, ['(logs will appear here)']);

    const startBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { await this._startJob(); } catch (e) { this._ctx?.log?.(`Image → 3D: start failed: ${e?.message || e}`); }
      },
    }, ['Generate GLB']);

    const killBtn = el('button', {
      class: 'danger',
      onclick: async () => {
        const id = this._job?.id;
        if (!id) return;
        try {
          await fetch('/__devtools_trellis_kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
        } catch { /* ignore */ }
      },
    }, ['Kill job']);

    const copyOutBtn = el('button', {
      onclick: async () => {
        const p = this._job?.outGlb || '';
        if (!p) return;
        try { await navigator.clipboard.writeText(p); this._ctx?.log?.('Image → 3D: copied GLB path'); } catch { /* ignore */ }
      },
    }, ['Copy GLB path']);

    const runEnvCheckBtn = el('button', {
      onclick: async () => {
        await this._runEnvCheck();
      },
      title: 'Check runtime dependencies for selected runner',
    }, ['Check runtime env']);

    const galleryQuery = el('input', {
      value: st.galleryQuery,
      placeholder: 'e.g. assets/generated/ or zimage_',
      oninput: (e) => { st.galleryQuery = String(e.target.value || ''); this._persistState(); },
    });

    const galleryList = el('div', { style: { marginTop: '8px' } }, [
      el('div', { class: 'muted' }, ['(loading…)']),
    ]);
    this._galleryListEl = galleryList;

    const galleryRefreshBtn = el('button', { onclick: () => this._refreshGallery() }, ['Refresh']);

    const quickBtn = (label, q) => el('button', {
      onclick: () => {
        st.galleryQuery = q;
        galleryQuery.value = q;
        this._persistState();
        void this._refreshGallery();
      },
      title: `Search "${q}"`,
    }, [label]);

    // Main cards
    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Image → 3D (Hunyuan)']),
      el('div', { class: 'muted' }, [
        'Generates GLBs via `tools/hunyuan_mesh_texture_to_glb.py`. Outputs go to `assets/generated/trellis/`.',
      ]),
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Runner']),
      runner,
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Backend']),
      meshBackend,

      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['Input mode']), inputMode]),
      ]),

      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Input image (asset path)']),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [imgPath]),
      el('div', { class: 'muted', style: { marginTop: '6px' } }, ['…or upload']),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [fileInput, clearUploadBtn]),

      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Preview']),
      previewImg,
      previewCaption,

      el('div', { class: 'row', style: { marginTop: '12px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['outName']), outName]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['device']), device]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['model']), model]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['pipelineType']), pipelineType]),
        el('div', {}, [el('div', { class: 'muted' }, ['seed']), seed]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['preprocessImage']), preprocessImage]),
        el('div', {}, [el('div', { class: 'muted' }, ['steps']), steps]),
        el('div', {}, [el('div', { class: 'muted' }, ['guidanceStrength']), guidanceStrength]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Legacy stage controls (safe to ignore for Hunyuan)']),
      el('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['ssSteps']), ssSteps]),
        el('div', {}, [el('div', { class: 'muted' }, ['ssGuidanceStrength']), ssGuidanceStrength]),
        el('div', {}, [el('div', { class: 'muted' }, ['ssGuidanceRescale']), ssGuidanceRescale]),
        el('div', {}, [el('div', { class: 'muted' }, ['ssRescaleT']), ssRescaleT]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['shapeSteps']), shapeSteps]),
        el('div', {}, [el('div', { class: 'muted' }, ['shapeGuidanceStrength']), shapeGuidanceStrength]),
        el('div', {}, [el('div', { class: 'muted' }, ['shapeGuidanceRescale']), shapeGuidanceRescale]),
        el('div', {}, [el('div', { class: 'muted' }, ['shapeRescaleT']), shapeRescaleT]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['texSteps']), texSteps]),
        el('div', {}, [el('div', { class: 'muted' }, ['texGuidanceStrength']), texGuidanceStrength]),
        el('div', {}, [el('div', { class: 'muted' }, ['texGuidanceRescale']), texGuidanceRescale]),
        el('div', {}, [el('div', { class: 'muted' }, ['texRescaleT']), texRescaleT]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['simplify']), simplify]),
        el('div', {}, [el('div', { class: 'muted' }, ['textureSize']), textureSize]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['decimationTarget']), decimationTarget]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['aabb']), aabb]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['remesh']), remesh]),
        el('div', {}, [el('div', { class: 'muted' }, ['extensionWebp']), extensionWebp]),
      ]),

      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Optional preview MP4']),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['renderMp4']), renderMp4]),
        el('div', {}, [el('div', { class: 'muted' }, ['fps']), fps]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['envmap']), envmapSelect]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [envmapInput]),

      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Optional rigging chain']),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['rigBackend']), rigBackend]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [rigArgs]),

      el('div', { class: 'row', style: { marginTop: '12px' } }, [startBtn, killBtn, copyOutBtn]),
      this._statusEl,
      this._outEl,
    ]));

    this._envEl = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['No env check run yet.']);
    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Runtime diagnostics']),
      el('div', { class: 'muted' }, ['Checks Python/runtime dependencies for the selected runner.']),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [runEnvCheckBtn]),
      this._envEl,
    ]));

    // Image library / generated images preview
    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Image library (preview + pick)']),
      el('div', { class: 'muted' }, ['Shows images under `assets/` and lets you click to use one as input.']),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        galleryQuery,
        galleryRefreshBtn,
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px' } }, [
        quickBtn('Generated', 'assets/generated/'),
        quickBtn('Image3D output', 'assets/generated/trellis/'),
        quickBtn('ZImage', 'assets/generated/zimage/'),
      ]),
      galleryList,
    ]));

    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Logs']),
      this._logEl,
    ]));

    // Initialize preview from current state.
    this._setPreviewFromState();
  }

  async _runEnvCheck() {
    const st = this._state;
    this._envCheck.checking = true;
    this._envCheck.error = '';
    if (this._envEl) this._envEl.textContent = 'Checking environment...';
    try {
      const resp = await fetch('/__devtools_trellis_env_check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runner: st.runner }),
      });
      const j = await resp.json();
      if (!j?.ok) throw new Error(String(j?.error || 'env check failed'));
      this._envCheck.result = j;
      const checks = j?.probe?.checks || {};
      const bits = [
        `runner=${j.runner} exit=${j.exitCode}`,
        `torch=${checks.torch ? 'ok' : 'missing'} cuda=${j?.probe?.cuda?.available ? 'yes' : 'no'} devices=${j?.probe?.cuda?.device_count ?? 0}`,
        `flash_attn=${checks.flash_attn ? 'ok' : 'missing'} cumesh=${checks.cumesh ? 'ok' : 'missing'} o_voxel=${checks.o_voxel ? 'ok' : 'missing'}`,
        `flex_gemm=${checks.flex_gemm ? 'ok' : 'missing'} nvdiffrast=${checks.nvdiffrast ? 'ok' : 'missing'} nvdiffrec=${checks.nvdiffrec ? 'ok' : 'missing'}`,
      ];
      if (Array.isArray(j.missing) && j.missing.length) bits.push(`missing: ${j.missing.join(', ')}`);
      if (j.setupCmd) bits.push(`suggested setup: ${j.setupCmd}`);
      if (this._envEl) this._envEl.textContent = bits.join('\n');
    } catch (e) {
      this._envCheck.error = String(e?.message || e);
      if (this._envEl) this._envEl.textContent = `Env check failed: ${this._envCheck.error}`;
    } finally {
      this._envCheck.checking = false;
    }
  }

  async _refreshGallery({ auto = false } = {}) {
    const ctx = this._ctx;
    const st = this._state;
    const host = this._galleryListEl;
    if (!ctx || !host) return;

    const q = String(st.galleryQuery || '').trim();
    if (!q) {
      clear(host);
      host.appendChild(el('div', { class: 'muted' }, ['Enter a search query to populate.']));
      return;
    }

    try {
      clear(host);
      host.appendChild(el('div', { class: 'muted' }, ['Loading…']));
      const itemsRaw = await ctx.assetIndex({ query: q, ext: '.png,.jpg,.jpeg,.webp' });
      const items = sortNewestFirst(itemsRaw).slice(0, 96);
      clear(host);

      if (!items.length) {
        host.appendChild(el('div', { class: 'muted' }, ['(no matches)']));
        return;
      }

      // Grid of clickable thumbnails.
      const grid = el('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '8px',
        },
      });

      const pick = (p) => {
        st.imageAssetPath = String(p || '');
        st.inputMode = 'asset';
        this._persistState();
        this._setPreviewFromState();
        if (this._statusEl) this._statusEl.textContent = `Selected: ${st.imageAssetPath}`;
      };

      for (const it of items) {
        const p = String(it?.path || '');
        if (!(p.startsWith('assets/') || p.startsWith('outputs/'))) continue; // only preview served files
        const src = safeImgSrcForProjectPath(p);
        const btn = el('button', {
          class: 'toolBtn',
          style: {
            width: '100%',
            marginTop: '0',
            padding: '8px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'stretch',
            gap: '6px',
          },
          onclick: () => pick(p),
          title: p,
        }, [
          el('img', {
            src,
            style: {
              width: '100%',
              height: '84px',
              objectFit: 'cover',
              borderRadius: '10px',
              border: '1px solid rgba(255,255,255,0.10)',
              background: 'rgba(0,0,0,0.20)',
              display: 'block',
            },
            loading: 'lazy',
          }),
          el('div', { class: 'muted', style: { fontSize: '10px', wordBreak: 'break-word', textAlign: 'left' } }, [p]),
        ]);
        grid.appendChild(btn);
      }

      host.appendChild(grid);

      if (!auto) this._ctx?.log?.(`Image → 3D: gallery loaded (${items.length} items)`);
    } catch (e) {
      clear(host);
      host.appendChild(el('div', { class: 'muted' }, [`(error) ${e?.message || e}`]));
    }
  }

  async _startJob() {
    const st = this._state;
    const ctx = this._ctx;

    const payload = {
      runner: st.runner,
      meshBackend: st.meshBackend || 'hunyuan',
      outName: st.outName,
      device: st.device,
      model: st.model,
      pipelineType: st.pipelineType,
      seed: st.seed,
      preprocessImage: st.preprocessImage,
      steps: st.steps,
      guidanceStrength: st.guidanceStrength,
      ssSteps: st.ssSteps,
      ssGuidanceStrength: st.ssGuidanceStrength,
      ssGuidanceRescale: st.ssGuidanceRescale,
      ssRescaleT: st.ssRescaleT,
      shapeSteps: st.shapeSteps,
      shapeGuidanceStrength: st.shapeGuidanceStrength,
      shapeGuidanceRescale: st.shapeGuidanceRescale,
      shapeRescaleT: st.shapeRescaleT,
      texSteps: st.texSteps,
      texGuidanceStrength: st.texGuidanceStrength,
      texGuidanceRescale: st.texGuidanceRescale,
      texRescaleT: st.texRescaleT,
      simplify: st.simplify,
      aabb: st.aabb,
      decimationTarget: st.decimationTarget,
      textureSize: st.textureSize,
      remesh: st.remesh,
      remeshBand: st.remeshBand,
      remeshProject: st.remeshProject,
      extensionWebp: st.extensionWebp,
      renderMp4: st.renderMp4,
      envmap: st.envmap,
      fps: st.fps,
      rigBackend: st.rigBackend,
      rigArgs: st.rigArgs,
    };

    if (st.inputMode === 'upload') {
      if (!this._fileDataUrl) throw new Error('Input mode is "upload" but no upload is staged.');
      payload.imageDataUrl = this._fileDataUrl;
      payload.imageExt = this._fileExt;
    } else {
      const p = safeTrim(st.imageAssetPath);
      if (!p) throw new Error('Select an input image (asset path / library) or switch to "upload".');
      payload.imageAssetPath = p;
    }

    if (this._statusEl) this._statusEl.textContent = 'Starting job...';
    if (this._outEl) this._outEl.textContent = '';
    if (this._logEl) this._logEl.textContent = '(starting...)';

    const resp = await fetch('/__devtools_trellis_start', {
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
      outGlb: String(j.outGlb || ''),
      outMp4: String(j.outMp4 || ''),
      outRig: String(j.outRig || ''),
    };
    ctx?.log?.(`Image → 3D: job started (${this._job.id})`);
    try { localStorage.setItem('devtools.image_model_gen.lastOutGlb', this._job.outGlb || ''); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.image_model_gen.lastOutRig', this._job.outRig || ''); } catch { /* ignore */ }

    this._polling = true;
    void this._pollJobLoop();
  }

  async _pollJobLoop() {
    const id = this._job?.id;
    if (!id) return;
    let backoff = 400;
    while (this._polling && this._job?.id === id) {
      try {
        const resp = await fetch(`/__devtools_trellis_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'job query failed'));
        this._job.status = String(j.status || '');
        this._job.stdout = String(j.stdout || '');
        this._job.stderr = String(j.stderr || '');
        this._job.outGlb = String(j.outGlbRel || j.outGlb || '');
        this._job.outMp4 = String(j.outMp4Rel || j.outMp4 || '');
        this._job.outRig = String(j.outRigRel || j.outRig || '');

        if (this._statusEl) {
          const code = (j.exitCode == null) ? '' : ` (exit=${j.exitCode})`;
          this._statusEl.textContent = `Job ${id}: ${this._job.status}${code}`;
        }
        if (this._logEl) {
          const out = this._job.stdout || '';
          const err = this._job.stderr || '';
          const text = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output yet)';
          this._logEl.textContent = text;
          try { this._logEl.scrollTop = this._logEl.scrollHeight; } catch { /* ignore */ }
        }
        if (this._outEl) {
          const parts = [];
          if (this._job.outGlb) parts.push(`GLB: ${this._job.outGlb}`);
          if (this._job.outMp4) parts.push(`MP4: ${this._job.outMp4}`);
          if (this._job.outRig) parts.push(`RIG: ${this._job.outRig}`);
          this._outEl.textContent = parts.join('   ');
        }

        if (this._job.status === 'done' || this._job.status === 'error' || this._job.status === 'killed') {
          this._polling = false;
          if (this._job.status === 'done') {
            this._ctx?.log?.(`Image → 3D: done → ${this._job.outGlb}`);
            try { localStorage.setItem('devtools.lastGeneratedModelUrl', this._job.outRig || this._job.outGlb || ''); } catch { /* ignore */ }
          } else {
            this._ctx?.log?.(`Image → 3D: finished (${this._job.status})`);
          }
          return;
        }
        backoff = 500;
      } catch (e) {
        if (this._statusEl) this._statusEl.textContent = `Polling failed: ${e?.message || e}`;
        backoff = Math.min(2000, Math.floor(backoff * 1.4));
      }
      await sleep(backoff);
    }
  }
}

