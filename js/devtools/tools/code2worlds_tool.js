import { el, clear } from '../../ui/dom.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeTrim(v) {
  return String(v ?? '').trim();
}

function parseResultJsonFromText(text) {
  const s = String(text || '');
  const m = s.match(/CODE2WORLDS_RESULT_JSON:({[\s\S]*})/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

const DEFAULT_CODE2WORLDS_MODEL = 'meta-llama/Llama-3.2-3B-Instruct';

export class Code2WorldsTool {
  constructor() {
    this.id = 'code2worlds';
    this.label = 'Code2Worlds';
    this._ctx = null;
    this._root = null;
    this._polling = false;

    this._state = {
      runner: 'python3',
      prompt: 'A calm forest valley at dawn with a river and mist.',
      modelName: DEFAULT_CODE2WORLDS_MODEL,
      baseUrl: '',
      code2worldsRoot: 'repos/Code2Worlds',
      infinigenRoot: 'repos/infinigen',
      outName: 'world',
      runRender: '1',
      seed: '0',
      blenderPath: '',
    };

    this._job = { id: '', status: '', stdout: '', stderr: '', cmd: '', exitCode: null, outPath: '' };
    this._statusEl = null;
    this._cmdEl = null;
    this._outEl = null;
    this._resultEl = null;
    this._envEl = null;
    this._logEl = null;
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;
    try {
      const raw = localStorage.getItem('devtools.code2worlds.state');
      if (raw) {
        const j = JSON.parse(raw);
        if (j && typeof j === 'object') Object.assign(this._state, j);
      }
      let migrated = false;
      if (safeTrim(this._state.runner) !== 'python3') {
        this._state.runner = 'python3';
        migrated = true;
      }
      if (!safeTrim(this._state.modelName) || safeTrim(this._state.modelName) === 'gpt-4o-mini') {
        this._state.modelName = DEFAULT_CODE2WORLDS_MODEL;
        migrated = true;
      }
      if (migrated) this._persistState();
    } catch { /* ignore */ }
    this._buildUi();
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
      out: this._job?.outPath || '',
    };
  }

  _setStatus(s) {
    if (this._statusEl) this._statusEl.textContent = String(s || '');
  }

  _persistState() {
    try { localStorage.setItem('devtools.code2worlds.state', JSON.stringify(this._state)); } catch { /* ignore */ }
  }

  _buildUi() {
    if (!this._root) return;
    clear(this._root);
    const st = this._state;

    const runner = el('select', {
      value: 'python3',
      onchange: () => {
        st.runner = 'python3';
        this._persistState();
      },
    }, [
      el('option', { value: 'python3' }, ['python3 (current devtools env)']),
    ]);

    const prompt = el('textarea', {
      rows: 5,
      value: st.prompt,
      placeholder: 'Describe the world you want...',
      oninput: (e) => { st.prompt = String(e.target.value || ''); this._persistState(); },
    });

    const modelName = el('input', {
      value: st.modelName,
      placeholder: `e.g. ${DEFAULT_CODE2WORLDS_MODEL}`,
      oninput: (e) => { st.modelName = safeTrim(e.target.value); this._persistState(); },
    });
    const baseUrl = el('input', {
      value: st.baseUrl,
      placeholder: 'http://127.0.0.1:8000/v1',
      oninput: (e) => { st.baseUrl = safeTrim(e.target.value); this._persistState(); },
    });
    const code2worldsRoot = el('input', {
      value: st.code2worldsRoot,
      oninput: (e) => { st.code2worldsRoot = safeTrim(e.target.value); this._persistState(); },
    });
    const infinigenRoot = el('input', {
      value: st.infinigenRoot,
      oninput: (e) => { st.infinigenRoot = safeTrim(e.target.value); this._persistState(); },
    });
    const outName = el('input', {
      value: st.outName,
      oninput: (e) => { st.outName = safeTrim(e.target.value); this._persistState(); },
    });
    const runRender = el('select', {
      value: st.runRender,
      onchange: (e) => { st.runRender = safeTrim(e.target.value) || '1'; this._persistState(); },
    }, [el('option', { value: '1' }, ['1']), el('option', { value: '0' }, ['0'])]);
    const seed = el('input', {
      value: st.seed,
      oninput: (e) => { st.seed = safeTrim(e.target.value); this._persistState(); },
    });
    const blenderPath = el('input', {
      value: st.blenderPath,
      placeholder: '(optional) /path/to/blender',
      oninput: (e) => { st.blenderPath = safeTrim(e.target.value); this._persistState(); },
    });

    const startBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { await this._startJob(); } catch (e) { this._setStatus(`Start failed: ${e?.message || e}`); }
      },
    }, ['Generate world']);
    const killBtn = el('button', {
      class: 'danger',
      onclick: async () => {
        const id = safeTrim(this._job?.id || '');
        if (!id) return;
        try {
          await fetch('/__devtools_code2worlds_kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
        } catch { /* ignore */ }
      },
    }, ['Kill']);
    const envCheckBtn = el('button', {
      onclick: async () => {
        if (this._envEl) this._envEl.textContent = 'Checking environment...';
        try {
          const payload = this._buildPayload();
          const resp = await fetch('/__devtools_code2worlds_env_check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const j = await resp.json();
          if (!j?.ok) throw new Error(String(j?.error || 'env check failed'));
          const c = j?.checks || {};
          const lines = [
            `runner=${j.runner} exit=${j.exitCode}`,
            `code2worldsRoot=${c.code2worldsRoot ? 'ok' : 'missing'} infinigenRoot=${c.infinigenRoot ? 'ok' : 'missing'}`,
            `bridgeScript=${c.bridgeScript ? 'ok' : 'missing'} localLlmRuntime=${c.localLlmRuntime ? 'ok' : 'missing'} infinigenPkg=${c.infinigenImport ? 'ok' : 'missing'}`,
            `blender=${c.blender ? 'ok' : 'missing'} genNatureHelp=${c.infinigenGenerateNatureHelp ? 'ok' : 'failed'}`,
          ];
          if (j.stderr) lines.push(`stderr: ${String(j.stderr).slice(0, 400)}`);
          if (this._envEl) this._envEl.textContent = lines.join('\n');
        } catch (e) {
          if (this._envEl) this._envEl.textContent = `Env check failed: ${e?.message || e}`;
        }
      },
    }, ['Check env']);
    const loadSceneBtn = el('button', {
      title: 'If a GLB was produced, hand off to Scene Tool and switch there',
      onclick: () => {
        let source = '';
        try {
          const raw = localStorage.getItem('devtools.code2worlds.lastResult');
          if (raw) {
            const j = JSON.parse(raw);
            source = safeTrim(j?.sceneSourceUrl || '');
          }
        } catch { /* ignore */ }
        if (!source) {
          this._setStatus('No loadable scene source yet. Run with render/export first.');
          return;
        }
        try { localStorage.setItem('devtools.scene.sourceUrl', source); } catch { /* ignore */ }
        try { localStorage.setItem('devtools.scene.lastGlbUrl', source); } catch { /* ignore */ }
        try { localStorage.setItem('devtools.lastGeneratedModelUrl', source); } catch { /* ignore */ }
        try { globalThis.__devtools?.setActiveTool?.('scene'); } catch { /* ignore */ }
        this._setStatus(`Scene handoff ready: ${source}`);
      },
    }, ['Load in Scene Tool']);

    this._statusEl = el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Idle']);
    this._cmdEl = el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-wrap' } }, ['']);
    this._outEl = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
    this._resultEl = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
    this._envEl = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['No env check run yet.']);
    this._logEl = el('div', { class: 'scrollArea', style: { height: '280px', marginTop: '8px' } }, ['(logs appear here)']);

    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Code2Worlds (Local Transformer + Blender)']),
      el('div', { class: 'muted' }, [
        'Runs Planner → Resolver → Realizer with your model endpoint, then optionally renders via Infinigen/Blender.',
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', { style: { flex: '1' } }, [el('div', { class: 'muted' }, ['Runner']), runner]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Prompt']),
      prompt,
      el('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, [
        el('div', { style: { flex: '1' } }, [el('div', { class: 'muted' }, ['modelName']), modelName]),
        el('div', { style: { flex: '1' } }, [el('div', { class: 'muted' }, ['baseUrl']), baseUrl]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['code2worldsRoot']),
      code2worldsRoot,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['infinigenRoot']),
      infinigenRoot,
      el('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['outName']), outName]),
        el('div', {}, [el('div', { class: 'muted' }, ['runRender']), runRender]),
        el('div', {}, [el('div', { class: 'muted' }, ['seed']), seed]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['blenderPath (optional)']),
      blenderPath,
      el('div', { class: 'row', style: { marginTop: '12px' } }, [startBtn, killBtn, envCheckBtn, loadSceneBtn]),
      this._statusEl,
      this._cmdEl,
      this._outEl,
      this._resultEl,
      this._envEl,
      this._logEl,
    ]));
  }

  _buildPayload() {
    const st = this._state;
    return {
      runner: st.runner,
      prompt: st.prompt,
      modelName: st.modelName,
      baseUrl: st.baseUrl,
      code2worldsRoot: st.code2worldsRoot,
      infinigenRoot: st.infinigenRoot,
      outName: st.outName,
      runRender: Number(st.runRender || 0) ? 1 : 0,
      seed: Number(st.seed || 0),
      blenderPath: st.blenderPath,
    };
  }

  async _startJob() {
    const payload = this._buildPayload();
    if (!safeTrim(payload.prompt)) throw new Error('Missing prompt');
    if (!safeTrim(payload.modelName)) throw new Error('Missing modelName');
    if (!safeTrim(payload.code2worldsRoot)) throw new Error('Missing code2worldsRoot');
    if (!safeTrim(payload.infinigenRoot)) throw new Error('Missing infinigenRoot');

    this._setStatus('Starting job...');
    if (this._cmdEl) this._cmdEl.textContent = '';
    if (this._outEl) this._outEl.textContent = '';
    if (this._resultEl) this._resultEl.textContent = '';
    if (this._logEl) this._logEl.textContent = '(starting...)';

    const resp = await fetch('/__devtools_code2worlds_start', {
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
      outPath: String(j.outPath || ''),
    };
    this._polling = true;
    void this._pollJobLoop();
  }

  async _pollJobLoop() {
    const id = safeTrim(this._job?.id || '');
    if (!id) return;
    let backoff = 500;
    while (this._polling && safeTrim(this._job?.id || '') === id) {
      try {
        const resp = await fetch(`/__devtools_code2worlds_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'job query failed'));

        this._job.status = String(j.status || '');
        this._job.stdout = String(j.stdout || '');
        this._job.stderr = String(j.stderr || '');
        this._job.cmd = String(j.cmd || this._job.cmd || '');
        this._job.exitCode = (j.exitCode == null) ? null : Number(j.exitCode);
        this._job.outPath = String(j.outPath || this._job.outPath || '');

        const code = (j.exitCode == null) ? '' : ` (exit=${j.exitCode})`;
        this._setStatus(`Job ${id}: ${this._job.status}${code}`);
        if (this._cmdEl) this._cmdEl.textContent = this._job.cmd ? `Command: ${this._job.cmd}` : '';
        if (this._outEl) this._outEl.textContent = this._job.outPath ? `Output: ${this._job.outPath}` : '';
        if (this._logEl) {
          const out = this._job.stdout || '';
          const err = this._job.stderr || '';
          this._logEl.textContent = (err ? `${out}\n--- stderr ---\n${err}` : out) || '(no output yet)';
          try { this._logEl.scrollTop = this._logEl.scrollHeight; } catch { /* ignore */ }
        }
        const parsed = parseResultJsonFromText(this._job.stdout || '');
        if (parsed) {
          if (this._resultEl) this._resultEl.textContent = JSON.stringify(parsed, null, 2);
          try { localStorage.setItem('devtools.code2worlds.lastResult', JSON.stringify(parsed)); } catch { /* ignore */ }
        }

        if (this._job.status === 'done' || this._job.status === 'error' || this._job.status === 'killed') {
          this._polling = false;
          return;
        }
        backoff = 600;
      } catch (e) {
        this._setStatus(`Polling failed: ${e?.message || e}`);
        backoff = Math.min(2200, Math.floor(backoff * 1.35));
      }
      await sleep(backoff);
    }
  }
}

