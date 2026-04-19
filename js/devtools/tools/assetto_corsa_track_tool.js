import { el, clear } from '../../ui/dom.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeTrim(v) {
  return String(v ?? '').trim();
}

function parseResultJsonFromText(text) {
  const s = String(text || '');
  const m = s.match(/ASSETTO_CORSA_TRACK_EXPORT_RESULT_JSON:({[\s\S]*})/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function defaultRunId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `run_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function ensureLeadingSlash(relPath) {
  const p = safeTrim(relPath).replace(/^\/+/, '');
  return p ? `/${p}` : '';
}

export class AssettoCorsaTrackTool {
  constructor() {
    this.id = 'assetto_corsa_track_export';
    this.label = 'Assetto Track Export';
    this._ctx = null;
    this._root = null;
    this._polling = false;

    this._state = {
      runner: 'python3',
      acRoot: 'assetto/assettocorsa',
      trackFilter: '',
      trackLimit: 250,
      trackRoot: '',
      outRoot: 'assets/generated/assetto_corsa/tracks',
      runId: defaultRunId(),
    };

    this._job = { id: '', status: '', stdout: '', stderr: '', cmd: '', exitCode: null, outPath: '' };
    this._statusEl = null;
    this._cmdEl = null;
    this._outEl = null;
    this._resultEl = null;
    this._logEl = null;

    /** @type {{ trackName: string, trackRootRel: string, kn5Count: number, modelsIni: boolean, kn5PickRel: string }[]} */
    this._tracks = [];
    this._tracksStatus = '';
    this._tracksLoadedAt = 0;
    this._selectedTrackName = '';
    this._tracksSelectEl = null;
    this._tracksInfoEl = null;
    this._trackRootInputEl = null;

    this._lastExport = { trackName: '', runId: '', scenario: null, scenarioRel: '', modelRel: '', bundleRel: '' };
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;
    try {
      const raw = localStorage.getItem('devtools.assetto_corsa_track_export.state');
      if (raw) {
        const j = JSON.parse(raw);
        if (j && typeof j === 'object') Object.assign(this._state, j);
      }
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
      track: safeTrim(this._state.trackRoot),
      out: this._job?.outPath || '',
    };
  }

  _persistState() {
    try { localStorage.setItem('devtools.assetto_corsa_track_export.state', JSON.stringify(this._state)); } catch { /* ignore */ }
  }

  _setStatus(text) {
    if (this._statusEl) this._statusEl.textContent = text;
  }

  _buildPayload() {
    const st = this._state;
    return {
      runner: 'python3',
      trackRoot: st.trackRoot,
      outRoot: st.outRoot,
      runId: st.runId,
    };
  }

  _syncTracksUi() {
    const sel = this._tracksSelectEl;
    if (sel) {
      const old = safeTrim(this._selectedTrackName);
      clear(sel);
      sel.appendChild(el('option', { value: '' }, ['(pick a track)']));
      for (const it of (Array.isArray(this._tracks) ? this._tracks : [])) {
        const name = safeTrim(it?.trackName || '');
        if (!name) continue;
        sel.appendChild(el('option', { value: name }, [name]));
      }
      const still = old && this._tracks.some((t) => String(t?.trackName || '') === old);
      this._selectedTrackName = still ? old : (safeTrim(this._selectedTrackName) || '');
      try { sel.value = this._selectedTrackName || ''; } catch { /* ignore */ }
    }

    const info = this._tracksInfoEl;
    if (!info) return;
    const it = this._tracks.find((t) => String(t?.trackName || '') === safeTrim(this._selectedTrackName)) || null;
    const modelUrl = ensureLeadingSlash(it?.kn5PickRel || '');
    const scenarioRel = safeTrim(this._lastExport?.scenarioRel || '');
    const bundleRel = safeTrim(this._lastExport?.bundleRel || '');
    const scenarioFromExport = this._lastExport?.scenario || null;

    const lines = [];
    if (this._tracksStatus) lines.push(this._tracksStatus);
    if (this._tracksLoadedAt) lines.push(`Loaded: ${new Date(this._tracksLoadedAt).toLocaleString()}`);
    if (it) {
      lines.push('');
      lines.push(`trackName: ${safeTrim(it.trackName)}`);
      lines.push(`trackRoot: ${safeTrim(it.trackRootRel)}`);
      lines.push(`kn5: ${Number(it.kn5Count) || 0}   models.ini: ${it.modelsIni ? 'yes' : 'no'}`);
      lines.push(`Picked KN5: ${safeTrim(it.kn5PickRel) || '(none)'}`);
      lines.push(`KN5 URL: ${modelUrl || '(none)'}`);
      if (scenarioRel) lines.push(`Latest exported scenario: ${ensureLeadingSlash(scenarioRel)}`);
      if (bundleRel) lines.push(`Latest exported track bundle: ${ensureLeadingSlash(bundleRel)}`);
      lines.push('');
      lines.push('Actions:');
      lines.push('- Export track → GLB + raw bundle');
      lines.push('- Send scenario to Scene tool (imports + loads)');
    }
    info.textContent = lines.join('\n').trim();

    try {
      const parent = info.parentNode;
      if (!parent) return;
      while (info.nextSibling && info.nextSibling.__assettoTrackActionRow) parent.removeChild(info.nextSibling);

      if (!it) return;
      if (!scenarioFromExport || typeof scenarioFromExport !== 'object') return;

      const ctx = this._ctx;
      const sendScenarioBtn = el('button', {
        class: 'primary',
        onclick: async () => {
          try {
            localStorage.setItem('devtools.scene.inbox', JSON.stringify({
              schema: 1,
              kind: 'import_scenario',
              scenario: scenarioFromExport,
              autoLoad: true,
              source: 'assetto_corsa_track_tool',
              time: new Date().toISOString(),
            }));
          } catch { /* ignore */ }
          try {
            const app = globalThis.__devtools;
            if (app?.setActiveTool) await app.setActiveTool('scene');
          } catch { /* ignore */ }
          ctx?.toast?.('Sent scenario to Scene tool', 'success', { title: 'Scene' });
        },
        title: 'Imports the scenario into Scene tool and loads the exported GLB',
      }, ['Send to Scene (scenario)']);

      const sendScenarioWithTrafficBtn = el('button', {
        class: 'primary',
        onclick: async () => {
          // Extend the exported scenario with a default player vehicle + traffic.
          const clone = (() => {
            try { return structuredClone ? structuredClone(scenarioFromExport) : JSON.parse(JSON.stringify(scenarioFromExport)); } catch { return null; }
          })();
          if (!clone || typeof clone !== 'object') return;
          try {
            clone.name = safeTrim(clone?.name || it?.trackName || 'AC Track') + ' (350Z + Traffic)';
          } catch { /* ignore */ }
          try {
            clone.settings = (clone.settings && typeof clone.settings === 'object') ? clone.settings : {};
            clone.settings.drivingEnabled = true;
          } catch { /* ignore */ }
          try {
            clone.content = (clone.content && typeof clone.content === 'object') ? clone.content : {};
            clone.content.vehicles = [
              {
                role: 'player',
                name: '350Z',
                url: '/webautos/ac__streetcarpack_nissan_350z/stream/ac__streetcarpack_nissan_350z_hi.glb',
                metaUrl: '/webautos/ac__streetcarpack_nissan_350z/stream/ac__streetcarpack_nissan_350z_hi.meta.json',
                place: 'spawn',
                yawDeg: 0,
                scale: 1.0,
                autoEnter: true,
                vehicleConfig: {
                  schema: 1,
                  source: 'assetto_corsa_track_tool',
                  modelUrl: '/webautos/ac__streetcarpack_nissan_350z/stream/ac__streetcarpack_nissan_350z_hi.glb',
                  metaUrl: '/webautos/ac__streetcarpack_nissan_350z/stream/ac__streetcarpack_nissan_350z_hi.meta.json',
                },
              },
            ];
            clone.content.traffic = {
              enabled: true,
              route: { kind: 'ac_ai_fast_lane' },
              vehicleUrl: '/webautos/ac__streetcarpack_nissan_350z/stream/ac__streetcarpack_nissan_350z_hi.glb',
              count: 32,
              spacingM: 26,
              speedKphMin: 70,
              speedKphMax: 120,
              laneOffsetM: 3.2,
            };
          } catch { /* ignore */ }
          try {
            localStorage.setItem('devtools.scene.inbox', JSON.stringify({
              schema: 1,
              kind: 'import_scenario',
              scenario: clone,
              autoLoad: true,
              source: 'assetto_corsa_track_tool',
              time: new Date().toISOString(),
            }));
          } catch { /* ignore */ }
          try {
            const app = globalThis.__devtools;
            if (app?.setActiveTool) await app.setActiveTool('scene');
          } catch { /* ignore */ }
          ctx?.toast?.('Sent scenario (350Z + traffic) to Scene tool', 'success', { title: 'Scene' });
        },
        title: 'Imports + loads, spawns 350Z as player, and starts traffic following fast_lane.ai (if exported)',
      }, ['Send to Scene (350Z + traffic)']);

      const copyScenarioBtn = el('button', {
        onclick: async () => {
          try { await navigator.clipboard.writeText(JSON.stringify(scenarioFromExport, null, 2)); } catch { /* ignore */ }
          ctx?.toast?.('Copied scenario JSON', 'success');
        },
        title: 'Copy SceneTool scenario JSON to clipboard',
      }, ['Copy scenario JSON']);

      const openScenarioBtn = scenarioRel ? el('button', {
        onclick: () => { try { window.open(ensureLeadingSlash(scenarioRel), '_blank', 'noopener,noreferrer'); } catch { /* ignore */ } },
        title: 'Open the exported scenario JSON asset in a new tab',
      }, ['Open scenario file']) : null;

      const openBundleBtn = bundleRel ? el('button', {
        onclick: () => { try { window.open(ensureLeadingSlash(bundleRel), '_blank', 'noopener,noreferrer'); } catch { /* ignore */ } },
        title: 'Open the exported track.bundle.json in a new tab',
      }, ['Open track bundle']) : null;

      const copyBundleBtn = bundleRel ? el('button', {
        onclick: async () => {
          try { await navigator.clipboard.writeText(ensureLeadingSlash(bundleRel)); } catch { /* ignore */ }
          ctx?.toast?.('Copied track bundle URL', 'success');
        },
        title: 'Copy the exported track.bundle.json URL',
      }, ['Copy track bundle URL']) : null;

      const row = el('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap', gap: '8px' } }, [
        sendScenarioBtn,
        sendScenarioWithTrafficBtn,
        copyScenarioBtn,
        openScenarioBtn,
        openBundleBtn,
        copyBundleBtn,
      ].filter(Boolean));
      row.__assettoTrackActionRow = true;
      parent.insertBefore(row, info.nextSibling);
    } catch { /* ignore */ }
  }

  async _refreshTracks() {
    const st = this._state;
    const root = safeTrim(st.acRoot) || 'assetto/assettocorsa';
    const filter = safeTrim(st.trackFilter);
    const limit = Math.max(1, Math.min(2000, Number(st.trackLimit) || 250));

    this._tracksStatus = 'Scanning…';
    this._syncTracksUi();
    const q = new URLSearchParams({ root, filter, limit: String(limit) }).toString();
    const resp = await fetch(`/__devtools_assetto_corsa_tracks?${q}`, { cache: 'no-store' });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'scan failed'));
    this._tracks = Array.isArray(j?.items) ? j.items : [];
    this._tracksLoadedAt = Date.now();
    this._tracksStatus = `Found ${this._tracks.length} track(s).`;
    this._syncTracksUi();
  }

  async _startJob() {
    const payload = this._buildPayload();
    if (!safeTrim(payload.trackRoot)) throw new Error('Missing trackRoot');

    this._setStatus('Starting export...');
    if (this._cmdEl) this._cmdEl.textContent = '';
    if (this._outEl) this._outEl.textContent = '';
    if (this._resultEl) this._resultEl.textContent = '';
    if (this._logEl) this._logEl.textContent = '(starting...)';

    const resp = await fetch('/__devtools_assetto_corsa_track_export_start', {
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
    let backoff = 450;
    while (this._polling && safeTrim(this._job?.id || '') === id) {
      try {
        const resp = await fetch(`/__devtools_assetto_corsa_track_export_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'job query failed'));

        this._job.status = String(j.status || '');
        this._job.stdout = String(j.stdout || '');
        this._job.stderr = String(j.stderr || '');
        this._job.cmd = String(j.cmd || this._job.cmd || '');
        this._job.exitCode = (j.exitCode == null) ? null : Number(j.exitCode);
        this._job.outPath = String(j.outPathRel || this._job.outPath || '');

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
        if (parsed && this._resultEl) this._resultEl.textContent = JSON.stringify(parsed, null, 2);
        try {
          const scenario = parsed?.scenario && typeof parsed.scenario === 'object' ? parsed.scenario : null;
          const scenarioRel = safeTrim(parsed?.scenarioRel || '');
          const modelRel = safeTrim(parsed?.modelGlbRel || '');
          const bundleRel = safeTrim(parsed?.bundleRel || '');
          const trackName = safeTrim(parsed?.trackName || '');
          const runId = safeTrim(parsed?.runId || '');
          if (scenario) this._lastExport = { trackName, runId, scenario, scenarioRel, modelRel, bundleRel };
        } catch { /* ignore */ }
        try { this._syncTracksUi(); } catch { /* ignore */ }

        if (this._job.status === 'done' || this._job.status === 'error' || this._job.status === 'killed') {
          this._polling = false;
          return;
        }
        backoff = 650;
      } catch (e) {
        this._setStatus(`Polling failed: ${e?.message || e}`);
        backoff = Math.min(2500, Math.floor(backoff * 1.35));
      }
      await sleep(backoff);
    }
  }

  _buildUi() {
    if (!this._root) return;
    clear(this._root);
    const st = this._state;

    const acRoot = el('input', {
      value: st.acRoot,
      placeholder: 'assetto/assettocorsa (or absolute path)',
      oninput: (e) => { st.acRoot = safeTrim(e.target.value); this._persistState(); },
      title: 'Assetto Corsa install root (contains content/tracks/)',
    });
    const trackFilter = el('input', {
      value: st.trackFilter,
      placeholder: 'Filter tracks (e.g. brooklyn)…',
      oninput: (e) => { st.trackFilter = safeTrim(e.target.value); this._persistState(); },
      title: 'Filter track names',
    });
    const trackLimit = el('input', {
      type: 'number',
      step: '50',
      min: '1',
      max: '2000',
      value: String(Number(st.trackLimit) || 250),
      onchange: (e) => { st.trackLimit = Math.max(1, Math.min(2000, Number(e.target.value) || 250)); this._persistState(); },
      title: 'Max tracks returned',
    });
    const refreshTracksBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { await this._refreshTracks(); } catch (e) { this._tracksStatus = `Scan failed: ${e?.message || e}`; this._syncTracksUi(); }
      },
      title: 'Scan local Assetto install for tracks',
    }, ['Scan tracks']);

    this._tracksSelectEl = el('select', {
      value: this._selectedTrackName || '',
      onchange: (e) => {
        this._selectedTrackName = safeTrim(e.target.value);
        const it = this._tracks.find((t) => String(t?.trackName || '') === this._selectedTrackName) || null;
        if (it?.trackRootRel) {
          st.trackRoot = safeTrim(it.trackRootRel);
          try { if (this._trackRootInputEl) this._trackRootInputEl.value = st.trackRoot; } catch { /* ignore */ }
          this._persistState();
        }
        this._syncTracksUi();
      },
      title: 'Pick a track folder from your local install',
    }, [el('option', { value: '' }, ['(pick a track)'])]);
    this._tracksInfoEl = el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-wrap' } }, ['']);

    const runner = el('select', {
      value: 'python3',
      onchange: () => {
        st.runner = 'python3';
        this._persistState();
      },
    }, [
      el('option', { value: 'python3' }, ['python3']),
    ]);

    const trackRoot = el('input', {
      value: st.trackRoot,
      placeholder: '/path/to/Assetto Corsa/content/tracks/<track>',
      oninput: (e) => { st.trackRoot = safeTrim(e.target.value); this._persistState(); },
    });
    this._trackRootInputEl = trackRoot;

    const outRoot = el('input', {
      value: st.outRoot,
      placeholder: 'assets/generated/assetto_corsa/tracks',
      oninput: (e) => { st.outRoot = safeTrim(e.target.value); this._persistState(); },
    });
    const runId = el('input', {
      value: st.runId,
      placeholder: 'run_2026-... (optional)',
      oninput: (e) => { st.runId = safeTrim(e.target.value); this._persistState(); },
    });
    const startBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { await this._startJob(); } catch (e) { this._setStatus(`Start failed: ${e?.message || e}`); }
      },
    }, ['Export track → GLB + bundle + scenario']);
    const killBtn = el('button', {
      class: 'danger',
      onclick: async () => {
        const id = safeTrim(this._job?.id || '');
        if (!id) return;
        try {
          await fetch('/__devtools_assetto_corsa_track_export_kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
        } catch { /* ignore */ }
      },
    }, ['Kill']);
    const resetRunBtn = el('button', {
      onclick: () => {
        st.runId = defaultRunId();
        runId.value = st.runId;
        this._persistState();
      },
    }, ['New run id']);

    this._statusEl = el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Idle']);
    this._cmdEl = el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-wrap' } }, ['']);
    this._outEl = el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-wrap' } }, ['']);
    this._resultEl = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
    this._logEl = el('div', { class: 'scrollArea', style: { height: '250px', marginTop: '8px' } }, ['(logs appear here)']);

    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Assetto Corsa Track Export']),
      el('div', { class: 'muted' }, [
        'Converts an AC track .kn5 into a GLB and writes a SceneTool scenario snapshot JSON pointing at it.',
      ]),

      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Local install scan (optional)']),
      el('div', { class: 'row', style: { marginTop: '6px', flexWrap: 'wrap' } }, [
        acRoot,
        trackFilter,
        el('div', { class: 'muted', style: { alignSelf: 'center' } }, ['limit']),
        trackLimit,
        refreshTracksBtn,
      ]),
      this._tracksSelectEl,
      this._tracksInfoEl,

      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', { style: { flex: '1' } }, [el('div', { class: 'muted' }, ['Runner']), runner]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['trackRoot']),
      trackRoot,
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['outRoot']),
      outRoot,
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['runId']),
      runId,
      el('div', { class: 'row', style: { marginTop: '12px', flexWrap: 'wrap', gap: '8px' } }, [startBtn, killBtn, resetRunBtn]),
      this._statusEl,
      this._cmdEl,
      this._outEl,
      this._resultEl,
      this._logEl,
    ]));

    this._syncTracksUi();
  }
}

