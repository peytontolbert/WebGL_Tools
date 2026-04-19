import { el, clear } from '../../ui/dom.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeTrim(v) {
  return String(v ?? '').trim();
}

function parseResultJsonFromText(text) {
  const s = String(text || '');
  const m = s.match(/ASSETTO_CORSA_EXPORT_RESULT_JSON:({[\s\S]*})/);
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

export class AssettoCorsaTool {
  constructor() {
    this.id = 'assetto_corsa_export';
    this.label = 'Assetto Corsa Export';
    this._ctx = null;
    this._root = null;
    this._polling = false;

    this._state = {
      runner: 'python3',
      acRoot: 'assetto/assettocorsa',
      carFilter: '',
      carLimit: 600,
      carRoot: '',
      outRoot: 'assets/generated/assetto_corsa',
      runId: defaultRunId(),
      runtimeTrace: '',
      exportModel: false,
      exportAudio: false,
    };

    this._job = { id: '', status: '', stdout: '', stderr: '', cmd: '', exitCode: null, outPath: '' };
    this._statusEl = null;
    this._cmdEl = null;
    this._outEl = null;
    this._resultEl = null;
    this._logEl = null;

    // Car scanning (local AC install)
    /** @type {{ carId: string, carRootRel: string, hasDataDir: boolean, hasDataAcd: boolean, kn5Count: number, glbCount: number, metaCount: number, modelRel: string, metaRel: string }[]} */
    this._cars = [];
    this._carsStatus = '';
    this._carsLoadedAt = 0;
    this._selectedCarId = '';
    this._carsSelectEl = null;
    this._carsInfoEl = null;
    this._carRootInputEl = null;

    // Last successful export (used to hand physics bundle to SceneTool).
    this._lastExport = { carId: '', runId: '', outDirRel: '', bundleUrl: '', chronoManifestUrl: '', modelUrl: '' };
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;
    try {
      const raw = localStorage.getItem('devtools.assetto_corsa_export.state');
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
      car: safeTrim(this._state.carRoot),
      out: this._job?.outPath || '',
    };
  }

  _persistState() {
    try { localStorage.setItem('devtools.assetto_corsa_export.state', JSON.stringify(this._state)); } catch { /* ignore */ }
  }

  _setStatus(text) {
    if (this._statusEl) this._statusEl.textContent = text;
  }

  _buildUi() {
    if (!this._root) return;
    clear(this._root);
    const st = this._state;

    const acRoot = el('input', {
      value: st.acRoot,
      placeholder: 'assetto/assettocorsa (or absolute path)',
      oninput: (e) => { st.acRoot = safeTrim(e.target.value); this._persistState(); },
      title: 'Assetto Corsa install root (contains content/cars/)',
    });
    const carFilter = el('input', {
      value: st.carFilter,
      placeholder: 'Filter cars (e.g. abarth, rx7)…',
      oninput: (e) => { st.carFilter = safeTrim(e.target.value); this._persistState(); },
      title: 'Filter car ids',
    });
    const carLimit = el('input', {
      type: 'number',
      step: '50',
      min: '1',
      max: '2000',
      value: String(Number(st.carLimit) || 600),
      onchange: (e) => { st.carLimit = Math.max(1, Math.min(2000, Number(e.target.value) || 600)); this._persistState(); },
      title: 'Max cars returned',
    });
    const refreshCarsBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { await this._refreshCars(); } catch (e) { this._carsStatus = `Scan failed: ${e?.message || e}`; this._syncCarsUi(); }
      },
      title: 'Scan local Assetto install for cars + detect any exported GLBs',
    }, ['Scan cars']);

    this._carsSelectEl = el('select', {
      value: this._selectedCarId || '',
      onchange: (e) => {
        this._selectedCarId = safeTrim(e.target.value);
        const it = this._cars.find((c) => String(c?.carId || '') === this._selectedCarId) || null;
        if (it?.carRootRel) {
          st.carRoot = safeTrim(it.carRootRel);
          try { if (this._carRootInputEl) this._carRootInputEl.value = st.carRoot; } catch { /* ignore */ }
          this._persistState();
        }
        this._syncCarsUi();
      },
      title: 'Pick a car folder from your local install',
    }, [el('option', { value: '' }, ['(pick a car)'])]);
    this._carsInfoEl = el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-wrap' } }, ['']);

    const runner = el('select', {
      value: 'python3',
      onchange: () => {
        st.runner = 'python3';
        this._persistState();
      },
    }, [
      el('option', { value: 'python3' }, ['python3']),
    ]);

    const carRoot = el('input', {
      value: st.carRoot,
      placeholder: '/path/to/Assetto Corsa/content/cars/<car_id>',
      oninput: (e) => { st.carRoot = safeTrim(e.target.value); this._persistState(); },
    });
    this._carRootInputEl = carRoot;
    const outRoot = el('input', {
      value: st.outRoot,
      placeholder: 'assets/generated/assetto_corsa',
      oninput: (e) => { st.outRoot = safeTrim(e.target.value); this._persistState(); },
    });
    const runId = el('input', {
      value: st.runId,
      placeholder: 'run_2026-... (optional)',
      oninput: (e) => { st.runId = safeTrim(e.target.value); this._persistState(); },
    });
    const runtimeTrace = el('input', {
      value: st.runtimeTrace,
      placeholder: '/path/to/runtime_trace.ndjson (optional)',
      oninput: (e) => { st.runtimeTrace = safeTrim(e.target.value); this._persistState(); },
    });
    const exportModelToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px' } }, [
      el('input', {
        type: 'checkbox',
        checked: !!st.exportModel,
        onchange: (e) => { st.exportModel = !!e.target.checked; this._persistState(); },
        title: 'Also export a driveable GLB model + write sibling .meta.json. This can take longer.',
      }),
      el('span', {}, ['Export model GLB (driveable, writes .meta.json, publishes to webautos/)']),
    ]);
    const exportAudioToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' } }, [
      el('input', {
        type: 'checkbox',
        checked: !!st.exportAudio,
        onchange: (e) => { st.exportAudio = !!e.target.checked; this._persistState(); },
        title: 'Copies car-root audio assets (sfx/ + audio.ini) into the export bundle. Typically FMOD bank/guids (raw).',
      }),
      el('span', {}, ['Export audio (copies sfx/ + audio.ini into the bundle; publishes to webautos/ when exporting model)']),
    ]);

    const startBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { await this._startJob(); } catch (e) { this._setStatus(`Start failed: ${e?.message || e}`); }
      },
    }, ['Export car bundle']);
    const killBtn = el('button', {
      class: 'danger',
      onclick: async () => {
        const id = safeTrim(this._job?.id || '');
        if (!id) return;
        try {
          await fetch('/__devtools_assetto_corsa_export_kill', {
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
      el('div', { class: 'dockTitle' }, ['Assetto Corsa Physics Export']),
      el('div', { class: 'muted' }, [
        'Copies AC static car physics inputs (data/*.ini/*.lut) and writes a devtools bundle. ',
        'Optionally imports a runtime trace (NDJSON/CSV) into runtime/runtime_trace.ndjson.',
      ]),

      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Local install scan (optional)']),
      el('div', { class: 'row', style: { marginTop: '6px', flexWrap: 'wrap' } }, [
        acRoot,
        carFilter,
        el('div', { class: 'muted', style: { alignSelf: 'center' } }, ['limit']),
        carLimit,
        refreshCarsBtn,
      ]),
      this._carsSelectEl,
      this._carsInfoEl,

      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', { style: { flex: '1' } }, [el('div', { class: 'muted' }, ['Runner']), runner]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['carRoot']),
      carRoot,
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['outRoot']),
      outRoot,
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['runId']),
      runId,
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['runtimeTrace (optional)']),
      runtimeTrace,
      exportModelToggle,
      exportAudioToggle,
      el('div', { class: 'row', style: { marginTop: '12px', flexWrap: 'wrap' } }, [startBtn, killBtn, resetRunBtn]),
      this._statusEl,
      this._cmdEl,
      this._outEl,
      this._resultEl,
      this._logEl,
    ]));

    // Populate cars select if we already have a cached list (e.g., restored state).
    this._syncCarsUi();
  }

  _buildPayload() {
    const st = this._state;
    return {
      runner: 'python3',
      carRoot: st.carRoot,
      outRoot: st.outRoot,
      runId: st.runId,
      runtimeTrace: st.runtimeTrace,
      exportModel: !!st.exportModel,
      exportAudio: !!st.exportAudio,
    };
  }

  async _refreshCars() {
    const st = this._state;
    const root = safeTrim(st.acRoot) || 'assetto/assettocorsa';
    const filter = safeTrim(st.carFilter);
    const limit = Math.max(1, Math.min(2000, Number(st.carLimit) || 600));

    this._carsStatus = 'Scanning…';
    this._syncCarsUi();
    const q = new URLSearchParams({ root, filter, limit: String(limit) }).toString();
    const resp = await fetch(`/__devtools_assetto_corsa_cars?${q}`, { cache: 'no-store' });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'scan failed'));
    this._cars = Array.isArray(j?.items) ? j.items : [];
    this._carsLoadedAt = Date.now();
    this._carsStatus = `Found ${this._cars.length} car(s).`;
    this._syncCarsUi();
  }

  _syncCarsUi() {
    const sel = this._carsSelectEl;
    if (sel) {
      // Rebuild options (simple; list can be large but still OK).
      const old = safeTrim(this._selectedCarId);
      clear(sel);
      sel.appendChild(el('option', { value: '' }, ['(pick a car)']));
      for (const it of (Array.isArray(this._cars) ? this._cars : [])) {
        const id = safeTrim(it?.carId || '');
        if (!id) continue;
        sel.appendChild(el('option', { value: id }, [id]));
      }
      // Restore selection if possible.
      const still = old && this._cars.some((c) => String(c?.carId || '') === old);
      this._selectedCarId = still ? old : (safeTrim(this._selectedCarId) || '');
      try { sel.value = this._selectedCarId || ''; } catch { /* ignore */ }
    }

    const info = this._carsInfoEl;
    if (!info) return;
    const it = this._cars.find((c) => String(c?.carId || '') === safeTrim(this._selectedCarId)) || null;
    const modelUrl = ensureLeadingSlash(it?.modelRel || '');
    const metaUrl = ensureLeadingSlash(it?.metaRel || '');
    const bundleUrl = safeTrim(this._lastExport?.bundleUrl || '');
    const chronoManifestUrl = safeTrim(this._lastExport?.chronoManifestUrl || '');
    const modelUrlFromExport = safeTrim(this._lastExport?.modelUrl || '');
    const canUsePhysics = !!(it && safeTrim(it?.carId) && safeTrim(this._lastExport?.carId) === safeTrim(it?.carId) && bundleUrl);
    const lines = [];
    if (this._carsStatus) lines.push(this._carsStatus);
    if (this._carsLoadedAt) lines.push(`Loaded: ${new Date(this._carsLoadedAt).toLocaleString()}`);
    if (it) {
      lines.push('');
      lines.push(`carId: ${safeTrim(it.carId)}`);
      lines.push(`carRoot: ${safeTrim(it.carRootRel)}`);
      lines.push(`data/: ${it.hasDataDir ? 'yes' : 'no'}   data.acd: ${it.hasDataAcd ? 'yes' : 'no'}`);
      lines.push(`kn5: ${Number(it.kn5Count) || 0}   glb/gltf: ${Number(it.glbCount) || 0}   meta.json: ${Number(it.metaCount) || 0}`);
      if (it.hasDataAcd && !it.hasDataDir) {
        lines.push('Note: this car has data.acd but no unpacked data/. Export will auto-unpack data.acd into the bundle (via vendored repos/acd).');
      }
      lines.push(`Detected model URL: ${modelUrl || '(none found)'}`);
      lines.push(`Detected meta URL: ${metaUrl || '(none found)'}`);
      if (canUsePhysics) lines.push(`Latest physics bundle: ${bundleUrl}`);
      if (modelUrlFromExport) lines.push(`Latest exported model GLB: ${modelUrlFromExport}`);
      lines.push('');
      lines.push('Tip: if you export a GLB + sibling .meta.json into this car folder, you can send it to SceneTool as a driveable vehicle.');
      lines.push('Expected: <car>.glb and <car>.meta.json (wheel anchors) next to the .kn5.');
      lines.push('');
      lines.push('Actions:');
      lines.push('- Use carRoot above for physics export');
      lines.push('- If a model is detected, send it to SceneTool to test driving');
    }
    info.textContent = lines.join('\n').trim();

    // Add action buttons below info (simple: replace info element contents with a wrapper).
    // We keep this minimal: only when a model URL exists.
    try {
      const parent = info.parentNode;
      if (!parent) return;
      // Remove any prior action rows inserted after info.
      while (info.nextSibling && info.nextSibling.__assettoCarsActionRow) parent.removeChild(info.nextSibling);

      // Prefer the AC-install detected model, but fall back to the latest exported model (assets/generated).
      const modelUrlEffective = modelUrl || modelUrlFromExport;
      if (!it || !modelUrlEffective) return;
      const ctx = this._ctx;
      const sendBtn = el('button', {
        class: 'primary',
        onclick: async () => {
          try {
            localStorage.setItem('devtools.scene.inbox', JSON.stringify({
              schema: 1,
              kind: 'spawn_vehicle_asset',
              url: modelUrlEffective,
              name: safeTrim(it?.carId || ''),
              vehicleConfig: {
                schema: 1,
                source: 'assetto_corsa_tool',
                modelUrl: modelUrlEffective,
                metaUrl: metaUrl || '',
                chronoManifestUrl: chronoManifestUrl || '',
              },
              source: 'assetto_corsa_tool',
              time: new Date().toISOString(),
            }));
          } catch { /* ignore */ }
          try {
            const app = globalThis.__devtools;
            if (app?.setActiveTool) await app.setActiveTool('scene');
          } catch { /* ignore */ }
          ctx?.toast?.('Sent to Scene tool (spawn as driveable vehicle)', 'success');
        },
        title: 'Open Scene tool and stage this Assetto car model for driveable spawning',
      }, ['Send to Scene (vehicle)']);
      const sendWithPhysicsBtn = el('button', {
        class: canUsePhysics ? 'primary' : '',
        disabled: !canUsePhysics,
        onclick: async () => {
          if (!canUsePhysics) return;
          try {
            localStorage.setItem('devtools.scene.inbox', JSON.stringify({
              schema: 1,
              kind: 'spawn_vehicle_asset',
              url: modelUrlEffective,
              name: safeTrim(it?.carId || ''),
              vehicleConfig: {
                schema: 1,
                source: 'assetto_corsa_tool',
                modelUrl: modelUrlEffective,
                metaUrl: metaUrl || '',
                acBundleUrl: bundleUrl,
                chronoManifestUrl: chronoManifestUrl || '',
              },
              source: 'assetto_corsa_tool',
              time: new Date().toISOString(),
            }));
          } catch { /* ignore */ }
          try {
            const app = globalThis.__devtools;
            if (app?.setActiveTool) await app.setActiveTool('scene');
          } catch { /* ignore */ }
          ctx?.toast?.('Sent to Scene tool (vehicle + AC physics bundle)', 'success');
        },
        title: canUsePhysics
          ? 'Spawn this vehicle with the latest exported AC physics bundle applied to the JS vehicle sim'
          : 'Run “Export car bundle” for this car first to enable physics handoff',
      }, ['Send to Scene (vehicle + physics)']);
      const openBtn = el('button', {
        onclick: () => { try { window.open(modelUrlEffective, '_blank', 'noopener,noreferrer'); } catch { /* ignore */ } },
        title: 'Open detected model URL in a new tab',
      }, ['Open model URL']);
      const copyBtn = el('button', {
        onclick: async () => {
          try { await navigator.clipboard.writeText(modelUrlEffective); } catch { /* ignore */ }
          ctx?.toast?.('Copied model URL', 'success');
        },
      }, ['Copy model URL']);

      const row = el('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } }, [sendBtn, openBtn, copyBtn]);
      row.__assettoCarsActionRow = true;
      parent.insertBefore(row, info.nextSibling);

      const row2 = el('div', { class: 'row', style: { marginTop: '6px', flexWrap: 'wrap' } }, [
        sendWithPhysicsBtn,
        bundleUrl ? el('button', {
          onclick: async () => {
            try { await navigator.clipboard.writeText(bundleUrl); } catch { /* ignore */ }
            ctx?.toast?.('Copied AC bundle URL', 'success');
          },
          title: 'Copy the exported car.bundle.json URL',
        }, ['Copy physics bundle URL']) : null,
      ].filter(Boolean));
      row2.__assettoCarsActionRow = true;
      parent.insertBefore(row2, info.nextSibling);
    } catch { /* ignore */ }
  }

  async _startJob() {
    const payload = this._buildPayload();
    if (!safeTrim(payload.carRoot)) throw new Error('Missing carRoot');

    this._setStatus('Starting export...');
    if (this._cmdEl) this._cmdEl.textContent = '';
    if (this._outEl) this._outEl.textContent = '';
    if (this._resultEl) this._resultEl.textContent = '';
    if (this._logEl) this._logEl.textContent = '(starting...)';

    const resp = await fetch('/__devtools_assetto_corsa_export_start', {
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
        const resp = await fetch(`/__devtools_assetto_corsa_export_job?id=${encodeURIComponent(id)}`);
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
        // Track last export so we can attach physics bundle to spawned vehicles.
        try {
          const carId = safeTrim(parsed?.carId || '');
          const runId = safeTrim(parsed?.runId || '');
          const outDirRel = safeTrim(this._job?.outPath || '').replace(/^\/+/, '');
          const bundleUrl = (carId && runId && outDirRel)
            ? ensureLeadingSlash(`${outDirRel}/normalized/car.bundle.json`)
            : '';
          const chronoManifestUrl = safeTrim(parsed?.chronoManifestUrl || '') || (
            (carId && runId && outDirRel)
              ? ensureLeadingSlash(`${outDirRel}/normalized/chrono/manifest.json`)
              : ''
          );
          const modelRel = safeTrim(parsed?.modelGlbRel || '');
          const modelOutAbs = safeTrim(parsed?.modelGlbPath || '');
          const modelOut = (modelRel || modelOutAbs).replace(/^\/+/, '');
          // Prefer modelGlbRel (served by Vite). Fall back to modelGlbPath only if it already looks like a served path.
          const modelUrl = modelRel
            ? ensureLeadingSlash(modelRel)
            : (modelOut.includes('assets/') || modelOut.includes('webautos/')) ? ensureLeadingSlash(modelOut) : '';
          if (bundleUrl || modelUrl || chronoManifestUrl) this._lastExport = { carId, runId, outDirRel, bundleUrl, chronoManifestUrl, modelUrl };
        } catch { /* ignore */ }
        try { this._syncCarsUi(); } catch { /* ignore */ }

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

