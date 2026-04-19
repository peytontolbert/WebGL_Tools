import { el, clear } from '../../ui/dom.js';
import { fileToDataUrl, guessExtFromDataUrl } from '../components/ui_components.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeTrim(s) {
  return String(s ?? '').trim();
}

export class TrellisRetextureTool {
  constructor() {
    this.id = 'trellis_retexture';
    this.label = 'Retexture mesh';
    this._ctx = null;
    this._root = null;

    this._state = {
      runner: 'conda_trellis', // python3 | conda_trellis
      meshAssetPath: '',
      imageAssetPath: '',
      outName: 'trellis_retexture',
      device: 'cuda',
      model: 'microsoft/TRELLIS.2-4B',
      configFile: 'texturing_pipeline.json',
      seed: 42,
      resolution: 1024,
      textureSize: 4096,
      preprocessImage: 1,
      texSteps: 12,
      texGuidanceStrength: 1.0,
      texGuidanceRescale: 0.0,
      texRescaleT: 3.0,
      preserveUv: 1,
      extensionWebp: 1,
    };

    this._job = { id: '', status: '', stdout: '', stderr: '', outGlb: '', exitCode: null };
    this._polling = false;
    this._logEl = null;
    this._statusEl = null;
    this._outEl = null;
    this._fileInput = null;
    this._fileDataUrl = '';
    this._fileExt = 'png';
    this._envEl = null;

    // Tracks the last shared "active model" we synced from localStorage.
    // Tool instances persist across unmount/mount, so without this the mesh input can feel "disconnected"
    // from the rest of the devtools (Assets tool / Model Viewer / generators).
    this._lastStorageModelUrlSeen = '';
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;
    this._buildUi();
  }

  async unmount() {
    this._polling = false;
    this._ctx = null;
    this._root = null;
  }

  tick() {}

  getStats() {
    return { job: this._job?.status || '', outGlb: this._job?.outGlb || '' };
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

    const meshPath = el('input', {
      value: st.meshAssetPath,
      placeholder: 'assets/.../mesh.glb (required)',
      oninput: (e) => { st.meshAssetPath = safeTrim(e.target.value); },
    });

    const imgPath = el('input', {
      value: st.imageAssetPath,
      placeholder: 'assets/.../ref.png (optional if uploading)',
      oninput: (e) => { st.imageAssetPath = safeTrim(e.target.value); },
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
          this._ctx?.log?.(`TrellisRetex: staged upload (${f.name}, ${f.size} bytes)`);
          if (this._statusEl) this._statusEl.textContent = `Staged upload: ${f.name}`;
        } catch (err) {
          this._ctx?.log?.(`TrellisRetex: upload read failed: ${err?.message || err}`);
        }
      },
    });
    this._fileInput = fileInput;

    const outName = el('input', { value: st.outName, oninput: (e) => { st.outName = safeTrim(e.target.value); } });
    const device = el('input', { value: st.device, oninput: (e) => { st.device = safeTrim(e.target.value); } });
    const model = el('input', { value: st.model, oninput: (e) => { st.model = safeTrim(e.target.value); } });
    const configFile = el('input', { value: st.configFile, oninput: (e) => { st.configFile = safeTrim(e.target.value); } });

    const seed = el('input', {
      value: String(st.seed),
      oninput: (e) => { st.seed = Number(e.target.value) || 0; },
    });

    const resolution = el('select', {
      value: String(st.resolution),
      onchange: (e) => { st.resolution = Number(e.target.value) || 1024; },
    }, [el('option', { value: '1024' }, ['1024']), el('option', { value: '512' }, ['512'])]);

    const textureSize = el('input', {
      value: String(st.textureSize),
      oninput: (e) => { st.textureSize = Math.max(64, Number(e.target.value) || 4096); },
    });

    const preprocessImage = el('select', {
      value: String(st.preprocessImage),
      onchange: (e) => { st.preprocessImage = Number(e.target.value) ? 1 : 0; },
    }, [el('option', { value: '1' }, ['1']), el('option', { value: '0' }, ['0'])]);
    const texSteps = el('input', {
      value: String(st.texSteps),
      oninput: (e) => { st.texSteps = Math.max(1, Number(e.target.value) || 1); },
    });
    const texGuidanceStrength = el('input', {
      value: String(st.texGuidanceStrength),
      oninput: (e) => { st.texGuidanceStrength = Math.max(0, Number(e.target.value) || 0); },
    });
    const texGuidanceRescale = el('input', {
      value: String(st.texGuidanceRescale),
      oninput: (e) => { st.texGuidanceRescale = Math.max(0, Number(e.target.value) || 0); },
    });
    const texRescaleT = el('input', {
      value: String(st.texRescaleT),
      oninput: (e) => { st.texRescaleT = Math.max(0, Number(e.target.value) || 0); },
    });
    const preserveUv = el('select', {
      value: String(st.preserveUv),
      onchange: (e) => { st.preserveUv = Number(e.target.value) ? 1 : 0; },
    }, [el('option', { value: '1' }, ['1']), el('option', { value: '0' }, ['0'])]);
    const extensionWebp = el('select', {
      value: String(st.extensionWebp),
      onchange: (e) => { st.extensionWebp = Number(e.target.value) ? 1 : 0; },
    }, [el('option', { value: '1' }, ['1']), el('option', { value: '0' }, ['0'])]);

    this._statusEl = el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Idle.']);
    this._outEl = el('div', { class: 'muted', style: { marginTop: '8px' } }, ['']);
    this._logEl = el('div', { class: 'scrollArea', style: { height: '240px' } }, ['(logs will appear here)']);

    const startBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { await this._startJob(); } catch (e) { this._ctx?.log?.(`TrellisRetex: start failed: ${e?.message || e}`); }
      },
    }, ['Retexture mesh']);

    const envCheckBtn = el('button', {
      title: 'Check Trellis external dependencies in selected runner',
      onclick: async () => {
        if (this._envEl) this._envEl.textContent = 'Checking environment...';
        try {
          const resp = await fetch('/__devtools_trellis_env_check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ runner: st.runner }),
          });
          const j = await resp.json();
          if (!j?.ok) throw new Error(String(j?.error || 'env check failed'));
          const checks = j?.probe?.checks || {};
          const lines = [
            `runner=${j.runner} exit=${j.exitCode}`,
            `torch=${checks.torch ? 'ok' : 'missing'} cuda=${j?.probe?.cuda?.available ? 'yes' : 'no'}`,
            `cumesh=${checks.cumesh ? 'ok' : 'missing'} o_voxel=${checks.o_voxel ? 'ok' : 'missing'} flex_gemm=${checks.flex_gemm ? 'ok' : 'missing'}`,
            `nvdiffrast=${checks.nvdiffrast ? 'ok' : 'missing'} nvdiffrec=${checks.nvdiffrec ? 'ok' : 'missing'} flash_attn=${checks.flash_attn ? 'ok' : 'missing'}`,
          ];
          if (Array.isArray(j.missing) && j.missing.length) lines.push(`missing: ${j.missing.join(', ')}`);
          if (j.setupCmd) lines.push(`suggested setup: ${j.setupCmd}`);
          if (this._envEl) this._envEl.textContent = lines.join('\n');
        } catch (e) {
          if (this._envEl) this._envEl.textContent = `Env check failed: ${e?.message || e}`;
        }
      },
    }, ['Check env']);

    const killBtn = el('button', {
      class: 'danger',
      onclick: async () => {
        const id = this._job?.id;
        if (!id) return;
        try {
          await fetch('/__devtools_trellis_retexture_kill', {
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
        try { await navigator.clipboard.writeText(p); this._ctx?.log?.('TrellisRetex: copied GLB path'); } catch { /* ignore */ }
      },
    }, ['Copy GLB path']);

    const useActiveModelBtn = el('button', {
      title: 'Use devtools.lastGeneratedModelUrl as mesh input',
      onclick: () => {
        try {
          const saved = safeTrim(localStorage.getItem('devtools.lastGeneratedModelUrl') || '');
          if (!saved) return;
          st.meshAssetPath = saved;
          meshPath.value = saved;
          this._lastStorageModelUrlSeen = saved;
        } catch { /* ignore */ }
      },
    }, ['Use active model']);

    const openOutInViewerBtn = el('button', {
      class: 'primary',
      title: 'Open the last output GLB in the Model Viewer tool',
      onclick: () => {
        const p = safeTrim(this._job?.outGlb || '');
        if (!p) return;
        try { localStorage.setItem('devtools.lastGeneratedModelUrl', p); } catch { /* ignore */ }
        try { globalThis.__devtools?.setActiveTool?.('model_viewer'); } catch { /* ignore */ }
      },
    }, ['Open in viewer']);

    // Sync mesh input from shared "active model" channel (Assets tool / viewer / generators).
    try {
      const saved = safeTrim(localStorage.getItem('devtools.lastGeneratedModelUrl') || '');
      if (saved && saved !== this._lastStorageModelUrlSeen) {
        st.meshAssetPath = saved;
        meshPath.value = saved;
        this._lastStorageModelUrlSeen = saved;
      }
    } catch { /* ignore */ }

    this._envEl = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['No env check run yet.']);

    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Trellis retexture']),
      el('div', { class: 'muted' }, ['Runs `tools/trellis2_retexture_mesh_to_glb.py`. Outputs go to `assets/generated/trellis_retexture/`.']),

      el('div', { class: 'muted', style: { marginTop: '6px' } }, ['Runner']),
      runner,

      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Input mesh (assets/...)']),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px' } }, [meshPath, useActiveModelBtn]),

      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Reference image']),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [imgPath]),
      el('div', { class: 'muted', style: { marginTop: '6px' } }, ['…or upload']),
      fileInput,

      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['outName']), outName]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['device']), device]),
        el('div', {}, [el('div', { class: 'muted' }, ['seed']), seed]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['model']), model]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['configFile']), configFile]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['resolution']), resolution]),
        el('div', {}, [el('div', { class: 'muted' }, ['textureSize']), textureSize]),
        el('div', {}, [el('div', { class: 'muted' }, ['preprocessImage']), preprocessImage]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Texture stage sampler']),
      el('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['texSteps']), texSteps]),
        el('div', {}, [el('div', { class: 'muted' }, ['texGuidanceStrength']), texGuidanceStrength]),
        el('div', {}, [el('div', { class: 'muted' }, ['texGuidanceRescale']), texGuidanceRescale]),
        el('div', {}, [el('div', { class: 'muted' }, ['texRescaleT']), texRescaleT]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['preserveUv']), preserveUv]),
        el('div', {}, [el('div', { class: 'muted' }, ['extensionWebp']), extensionWebp]),
      ]),

      el('div', { class: 'row', style: { marginTop: '12px', gap: '8px', flexWrap: 'wrap' } }, [startBtn, killBtn, copyOutBtn, openOutInViewerBtn, envCheckBtn]),
      this._statusEl,
      this._outEl,
      this._envEl,
    ]));

    this._root.appendChild(this._buildAssetPicker({
      title: 'Asset Picker (meshes)',
      ext: '.glb,.gltf,.obj,.ply',
      onPick: (p) => { st.meshAssetPath = p; meshPath.value = p; },
      allowEmptyQuery: true,
    }));

    this._root.appendChild(this._buildAssetPicker({
      title: 'Asset Picker (reference images)',
      ext: '.png,.jpg,.jpeg,.webp',
      onPick: (p) => { st.imageAssetPath = p; imgPath.value = p; },
      allowEmptyQuery: true,
    }));

    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Logs']),
      this._logEl,
    ]));
  }

  _buildAssetPicker({ title, ext, onPick, allowEmptyQuery = false }) {
    const ctx = this._ctx;
    const queryInput = el('input', { placeholder: allowEmptyQuery ? 'search assets (optional; empty to list assets/)' : 'search assets' });
    const list = el('div', { class: 'scrollArea', style: { height: '160px' } }, ['(search to populate)']);

    const refresh = async () => {
      if (!ctx?.assetIndex) {
        list.textContent = '(error) asset index not available';
        return;
      }
      const qRaw = String(queryInput.value || '').trim();
      const q = qRaw || (allowEmptyQuery ? 'assets/' : '');
      if (!q) { list.textContent = '(search to populate)'; return; }
      try {
        list.textContent = 'Loading...';
        const items = await ctx.assetIndex({ query: q, ext });
        if (!items.length) { list.textContent = '(no matches)'; return; }
        clear(list);
        for (const it of items.slice(0, 250)) {
          const p = String(it?.path || '');
          list.appendChild(el('button', { class: 'toolBtn', style: { marginTop: '6px' }, onclick: () => onPick(p) }, [p]));
        }
      } catch (e) {
        list.textContent = `(error) ${e?.message || e}`;
      }
    };
    queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') refresh(); });

    return el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, [String(title || 'Assets')]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [queryInput, el('button', { onclick: refresh }, ['Search'])]),
      el('div', { class: 'muted', style: { marginTop: '6px' } }, ['Uses local Vite dev endpoint `/__editor_assets_index`.']),
      el('div', { style: { marginTop: '8px' } }, [list]),
    ]);
  }

  async _startJob() {
    const st = this._state;
    const useUpload = !!this._fileDataUrl;
    if (!safeTrim(st.meshAssetPath)) throw new Error('Missing meshAssetPath');
    if (!useUpload && !safeTrim(st.imageAssetPath)) throw new Error('Missing imageAssetPath (or upload an image)');

    const payload = {
      runner: st.runner,
      meshAssetPath: st.meshAssetPath,
      outName: st.outName,
      device: st.device,
      model: st.model,
      configFile: st.configFile,
      seed: st.seed,
      resolution: st.resolution,
      textureSize: st.textureSize,
      preprocessImage: st.preprocessImage,
      texSteps: st.texSteps,
      texGuidanceStrength: st.texGuidanceStrength,
      texGuidanceRescale: st.texGuidanceRescale,
      texRescaleT: st.texRescaleT,
      preserveUv: st.preserveUv,
      extensionWebp: st.extensionWebp,
    };
    if (useUpload) {
      payload.imageDataUrl = this._fileDataUrl;
      payload.imageExt = this._fileExt;
    } else {
      payload.imageAssetPath = st.imageAssetPath;
    }

    if (this._statusEl) this._statusEl.textContent = 'Starting job...';
    if (this._outEl) this._outEl.textContent = '';
    if (this._logEl) this._logEl.textContent = '(starting...)';

    const resp = await fetch('/__devtools_trellis_retexture_start', {
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
      exitCode: null,
    };
    this._ctx?.log?.(`TrellisRetex: job started (${this._job.id})`);

    this._polling = true;
    void this._pollJobLoop();
  }

  async _pollJobLoop() {
    const id = this._job?.id;
    if (!id) return;
    let backoff = 400;
    while (this._polling && this._job?.id === id) {
      try {
        const resp = await fetch(`/__devtools_trellis_retexture_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'job query failed'));
        this._job.status = String(j.status || '');
        this._job.stdout = String(j.stdout || '');
        this._job.stderr = String(j.stderr || '');
        this._job.outGlb = String(j.outGlb || '');
        this._job.exitCode = (j.exitCode == null) ? null : Number(j.exitCode);

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
          this._outEl.textContent = this._job.outGlb ? `GLB: ${this._job.outGlb}` : '';
        }

        if (this._job.status === 'done' || this._job.status === 'error' || this._job.status === 'killed') {
          this._polling = false;
          if (this._job.status === 'done') {
            this._ctx?.log?.(`TrellisRetex: done → ${this._job.outGlb}`);
            // Publish output to shared "active model" channel for other tools.
            try { localStorage.setItem('devtools.lastGeneratedModelUrl', safeTrim(this._job.outGlb || '')); } catch { /* ignore */ }
          }
          else this._ctx?.log?.(`TrellisRetex: finished (${this._job.status})`);
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

