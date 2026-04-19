import { el, clear } from '../../ui/dom.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeTrim(v) {
  return String(v ?? '').trim();
}

const STEP_OPTIONS = [
  { id: 'build_metadata', label: 'Build metadata' },
  { id: 'download', label: 'Download assets' },
  { id: 'dump_mesh', label: 'Dump mesh' },
  { id: 'dump_pbr', label: 'Dump PBR textures' },
  { id: 'asset_stats', label: 'Asset stats' },
  { id: 'dual_grid', label: 'Dual-grid (O-Voxel structure)' },
  { id: 'voxelize_pbr', label: 'Voxelize PBR' },
  { id: 'encode_shape_latent', label: 'Encode shape latent' },
  { id: 'encode_pbr_latent', label: 'Encode PBR latent' },
  { id: 'encode_ss_latent', label: 'Encode SS latent' },
  { id: 'render_cond', label: 'Render conditioning views' },
];

const RECIPES = [
  {
    id: 'objaverse_full',
    label: 'Objaverse Full Prep (README-style)',
    steps: [
      'build_metadata',
      'download',
      'build_metadata',
      'dump_mesh',
      'dump_pbr',
      'asset_stats',
      'build_metadata',
      'dual_grid',
      'voxelize_pbr',
      'encode_shape_latent',
      'encode_pbr_latent',
      'build_metadata',
      'encode_ss_latent',
      'build_metadata',
      'render_cond',
      'build_metadata',
    ],
  },
  {
    id: 'prep_core',
    label: 'Core Prep (metadata/download/dumps/voxels)',
    steps: [
      'build_metadata',
      'download',
      'build_metadata',
      'dump_mesh',
      'dump_pbr',
      'asset_stats',
      'build_metadata',
      'dual_grid',
      'voxelize_pbr',
      'build_metadata',
    ],
  },
  {
    id: 'latents_only',
    label: 'Latents + Cond Views',
    steps: [
      'encode_shape_latent',
      'encode_pbr_latent',
      'build_metadata',
      'encode_ss_latent',
      'render_cond',
      'build_metadata',
    ],
  },
];

const SUBSET_OPTIONS = [
  'ObjaverseXL',
  'ABO',
  'HSSD',
  'TexVerse',
  'SketchfabPicked',
  'Toys4k',
];

export class TrellisDatasetTool {
  constructor() {
    this.id = 'trellis_dataset';
    this.label = 'Trellis Dataset Prep';
    this._ctx = null;
    this._root = null;

    this._state = {
      runner: 'conda_trellis',
      step: 'build_metadata',
      subset: 'ObjaverseXL',
      source: 'sketchfab',
      rootPath: 'repos/TRELLIS.2/datasets/ObjaverseXL_sketchfab',
      resolution: '1024',
      numViews: '16',
      shapeLatentName: '',
      rank: '0',
      worldSize: '1',
      recipeId: 'objaverse_full',
    };

    this._job = { id: '', status: '', stdout: '', stderr: '', cmd: '', exitCode: null };
    this._polling = false;
    this._recipeRunning = false;
    this._abortRequested = false;
    this._statusEl = null;
    this._logEl = null;
    this._cmdEl = null;
    this._envEl = null;
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;
    this._buildUi();
  }

  async unmount() {
    this._polling = false;
    this._abortRequested = true;
    this._ctx = null;
    this._root = null;
  }

  tick() {}

  getStats() {
    return { step: this._state.step, job: this._job?.status || '', recipe: this._recipeRunning ? 'running' : '' };
  }

  _buildUi() {
    if (!this._root) return;
    clear(this._root);
    const st = this._state;

    const runner = el('select', {
      value: st.runner,
      onchange: (e) => { st.runner = safeTrim(e.target.value) || 'conda_trellis'; },
    }, [
      el('option', { value: 'conda_trellis' }, ['conda run -n trellis python3 (recommended)']),
      el('option', { value: 'python3' }, ['python3 (current env)']),
    ]);

    const step = el('select', {
      value: st.step,
      onchange: (e) => { st.step = safeTrim(e.target.value) || 'build_metadata'; },
    }, STEP_OPTIONS.map((x) => el('option', { value: x.id }, [x.label])));
    const recipe = el('select', {
      value: st.recipeId,
      onchange: (e) => { st.recipeId = safeTrim(e.target.value) || 'objaverse_full'; },
    }, RECIPES.map((x) => el('option', { value: x.id }, [x.label])));

    const subset = el('select', {
      value: st.subset,
      onchange: (e) => {
        st.subset = safeTrim(e.target.value) || 'ObjaverseXL';
        if (!safeTrim(st.rootPath)) {
          st.rootPath = `repos/TRELLIS.2/datasets/${st.subset}`;
          rootPath.value = st.rootPath;
        }
      },
    }, SUBSET_OPTIONS.map((s) => el('option', { value: s }, [s])));

    const source = el('select', {
      value: st.source,
      onchange: (e) => { st.source = safeTrim(e.target.value); },
    }, [
      el('option', { value: '' }, ['(none)']),
      el('option', { value: 'sketchfab' }, ['sketchfab']),
      el('option', { value: 'github' }, ['github']),
    ]);

    const rootPath = el('input', {
      value: st.rootPath,
      placeholder: 'repos/TRELLIS.2/datasets/ObjaverseXL_sketchfab',
      oninput: (e) => { st.rootPath = safeTrim(e.target.value); },
    });

    const resolution = el('input', {
      value: st.resolution,
      placeholder: 'e.g. 256,512,1024 or 1024',
      oninput: (e) => { st.resolution = safeTrim(e.target.value); },
    });

    const numViews = el('input', {
      value: st.numViews,
      placeholder: '16',
      oninput: (e) => { st.numViews = safeTrim(e.target.value); },
    });

    const shapeLatentName = el('input', {
      value: st.shapeLatentName,
      placeholder: 'shape_enc_next_dc_f16c32_fp16_1024',
      oninput: (e) => { st.shapeLatentName = safeTrim(e.target.value); },
    });

    const rank = el('input', {
      value: st.rank,
      placeholder: '0',
      oninput: (e) => { st.rank = safeTrim(e.target.value); },
    });

    const worldSize = el('input', {
      value: st.worldSize,
      placeholder: '1',
      oninput: (e) => { st.worldSize = safeTrim(e.target.value); },
    });

    this._statusEl = el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Idle']);
    this._cmdEl = el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-wrap' } }, ['']);
    this._envEl = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['No env check run yet.']);
    this._logEl = el('div', { class: 'scrollArea', style: { height: '220px', marginTop: '8px' } }, ['(logs appear here)']);

    const runBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { await this._startJob(); } catch (e) { this._ctx?.log?.(`TrellisDataset: start failed: ${e?.message || e}`); }
      },
    }, ['Run step']);
    const runRecipeBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { await this._runRecipe(); } catch (e) { this._ctx?.log?.(`TrellisDataset: recipe failed: ${e?.message || e}`); }
      },
    }, ['Run recipe']);

    const killBtn = el('button', {
      class: 'danger',
      onclick: async () => {
        this._abortRequested = true;
        const id = safeTrim(this._job?.id || '');
        if (!id) {
          this._setStatus('Abort requested');
          return;
        }
        try {
          await fetch('/__devtools_trellis_dataset_kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
        } catch { /* ignore */ }
      },
    }, ['Kill']);

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
            `flash_attn=${checks.flash_attn ? 'ok' : 'missing'} cumesh=${checks.cumesh ? 'ok' : 'missing'} o_voxel=${checks.o_voxel ? 'ok' : 'missing'}`,
          ];
          if (Array.isArray(j.missing) && j.missing.length) lines.push(`missing: ${j.missing.join(', ')}`);
          if (j.setupCmd) lines.push(`suggested setup: ${j.setupCmd}`);
          if (this._envEl) this._envEl.textContent = lines.join('\n');
        } catch (e) {
          if (this._envEl) this._envEl.textContent = `Env check failed: ${e?.message || e}`;
        }
      },
    }, ['Check env']);

    const applyObjaversePresetBtn = el('button', {
      onclick: () => {
        st.subset = 'ObjaverseXL';
        st.source = 'sketchfab';
        st.rootPath = 'repos/TRELLIS.2/datasets/ObjaverseXL_sketchfab';
        subset.value = st.subset;
        source.value = st.source;
        rootPath.value = st.rootPath;
      },
      title: 'Matches README ObjaverseXL example',
    }, ['ObjaverseXL preset']);

    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Trellis Dataset Preparation']),
      el('div', { class: 'muted' }, [
        'Runs TRELLIS `data_toolkit` pipeline steps under DevTools (metadata/download/mesh/PBR/voxel/latents/render views).',
      ]),

      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', { style: { flex: '1' } }, [el('div', { class: 'muted' }, ['Runner']), runner]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', { style: { flex: '1' } }, [el('div', { class: 'muted' }, ['Step']), step]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', { style: { flex: '1' } }, [el('div', { class: 'muted' }, ['Recipe']), recipe]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, [
        el('div', { style: { flex: '1' } }, [el('div', { class: 'muted' }, ['Subset']), subset]),
        el('div', { style: { flex: '1' } }, [el('div', { class: 'muted' }, ['Source (ObjaverseXL)']), source]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Dataset root']),
      rootPath,

      el('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, [
        el('div', { style: { flex: '1' } }, [el('div', { class: 'muted' }, ['Resolution']), resolution]),
        el('div', { style: { flex: '1' } }, [el('div', { class: 'muted' }, ['Num views']), numViews]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Shape latent name (encode_ss_latent)']),
      shapeLatentName,
      el('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, [
        el('div', { style: { flex: '1' } }, [el('div', { class: 'muted' }, ['Rank']), rank]),
        el('div', { style: { flex: '1' } }, [el('div', { class: 'muted' }, ['World size']), worldSize]),
      ]),

      el('div', { class: 'row', style: { marginTop: '12px', flexWrap: 'wrap' } }, [runBtn, runRecipeBtn, killBtn, envCheckBtn, applyObjaversePresetBtn]),
      this._statusEl,
      this._cmdEl,
      this._envEl,
      this._logEl,
    ]));
  }

  _buildPayload(stepId) {
    const st = this._state;
    return {
      runner: st.runner,
      step: stepId,
      subset: st.subset,
      source: st.source,
      rootPath: st.rootPath,
      resolution: st.resolution,
      numViews: st.numViews,
      shapeLatentName: st.shapeLatentName,
      rank: st.rank,
      worldSize: st.worldSize,
    };
  }

  _setStatus(text) {
    if (this._statusEl) this._statusEl.textContent = text;
  }

  _setLog(text) {
    if (this._logEl) this._logEl.textContent = text;
  }

  async _startJob() {
    const st = this._state;
    if (!safeTrim(st.rootPath)) throw new Error('Missing rootPath');
    if (!safeTrim(st.step)) throw new Error('Missing step');
    if (st.step === 'encode_ss_latent' && !safeTrim(st.shapeLatentName)) {
      throw new Error('encode_ss_latent requires shapeLatentName');
    }
    this._abortRequested = false;
    this._recipeRunning = false;
    await this._startAndPollStep(st.step, { clearLog: true });
  }

  async _runRecipe() {
    const st = this._state;
    const recipe = RECIPES.find((x) => x.id === st.recipeId) || RECIPES[0];
    if (!recipe) throw new Error('Missing recipe');
    if (!safeTrim(st.rootPath)) throw new Error('Missing rootPath');
    if (recipe.steps.includes('encode_ss_latent') && !safeTrim(st.shapeLatentName)) {
      throw new Error('Recipe includes encode_ss_latent; provide shapeLatentName');
    }

    this._abortRequested = false;
    this._recipeRunning = true;
    this._polling = false;
    this._setLog(`(recipe: ${recipe.label})\n`);

    for (let i = 0; i < recipe.steps.length; i++) {
      if (this._abortRequested) {
        this._recipeRunning = false;
        this._setStatus('Recipe aborted');
        return;
      }
      const stepId = recipe.steps[i];
      await this._startAndPollStep(stepId, {
        clearLog: true,
        prefix: `[${i + 1}/${recipe.steps.length}] ${stepId}`,
      });
      if (this._job?.status !== 'done') {
        this._recipeRunning = false;
        throw new Error(`Recipe failed at step "${stepId}" (${this._job?.status || 'unknown'})`);
      }
    }
    this._recipeRunning = false;
    this._setStatus(`Recipe done: ${recipe.label}`);
  }

  async _startAndPollStep(stepId, { clearLog = false, prefix = '' } = {}) {
    const payload = this._buildPayload(stepId);
    const tag = safeTrim(prefix || stepId);

    this._polling = false;
    if (clearLog) this._setLog('(starting...)');
    this._setStatus(`${tag}: starting...`);
    if (this._cmdEl) this._cmdEl.textContent = '';

    const resp = await fetch('/__devtools_trellis_dataset_start', {
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
      cmd: String(j.cmd || ''),
      exitCode: null,
    };
    this._polling = true;
    this._ctx?.log?.(`TrellisDataset: started ${stepId} (${this._job.id})`);
    await this._pollJobLoop({ prefix: tag });
  }

  async _pollJobLoop({ prefix = '' } = {}) {
    const id = safeTrim(this._job?.id || '');
    if (!id) return;
    let backoff = 450;
    const tag = safeTrim(prefix || 'job');
    while (this._polling && safeTrim(this._job?.id || '') === id) {
      if (this._abortRequested) {
        this._polling = false;
        return;
      }
      try {
        const resp = await fetch(`/__devtools_trellis_dataset_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'job query failed'));

        this._job.status = String(j.status || '');
        this._job.stdout = String(j.stdout || '');
        this._job.stderr = String(j.stderr || '');
        this._job.cmd = String(j.cmd || this._job.cmd || '');
        this._job.exitCode = (j.exitCode == null) ? null : Number(j.exitCode);

        const code = (j.exitCode == null) ? '' : ` (exit=${j.exitCode})`;
        this._setStatus(`${tag}: ${this._job.status}${code}`);
        if (this._cmdEl) this._cmdEl.textContent = this._job.cmd ? `Command: ${this._job.cmd}` : '';
        if (this._logEl) {
          const out = this._job.stdout || '';
          const err = this._job.stderr || '';
          this._logEl.textContent = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output yet)';
          try { this._logEl.scrollTop = this._logEl.scrollHeight; } catch { /* ignore */ }
        }

        if (this._job.status === 'done' || this._job.status === 'error' || this._job.status === 'killed') {
          this._polling = false;
          this._ctx?.log?.(`TrellisDataset: finished (${this._job.status})`);
          return;
        }
        backoff = 500;
      } catch (e) {
        if (this._statusEl) this._statusEl.textContent = `Polling failed: ${e?.message || e}`;
        backoff = Math.min(2200, Math.floor(backoff * 1.35));
      }
      await sleep(backoff);
    }
  }
}

