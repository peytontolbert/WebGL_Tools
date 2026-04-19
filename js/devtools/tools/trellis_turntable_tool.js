import { el, clear } from '../../ui/dom.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeTrim(s) {
  return String(s ?? '').trim();
}

function extOf(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i).toLowerCase() : '';
}

function isGlbLikeExt(ext) {
  return ext === '.glb' || ext === '.gltf';
}

function basename(p) {
  return String(p || '').split('/').pop() || p;
}

function timeAgo(ms) {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export class TrellisTurntableTool {
  constructor() {
    this.id = 'turntable';
    this.label = 'Turntable';
    this._ctx = null;
    this._root = null;

    this._state = {
      runner: 'conda_trellis',
      assetPath: '',
      outName: 'turntable',
      device: 'cuda',
      envmap: '',
      fps: 15,
      numFrames: 120,
      resolution: 768,
      r: 2.0,
      fov: 40.0,
    };

    this._envmaps = [];
    this._job = { id: '', status: '', stdout: '', stderr: '', outMp4: '' };
    this._convertJob = { id: '', status: '', stdout: '', stderr: '', outGlb: '' };
    this._polling = false;
    this._logEl = null;
    this._statusEl = null;
    this._outEl = null;
    this._previewEl = null;
    this._galleryEl = null;
    this._envEl = null;
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;
    try {
      const last = String(localStorage.getItem('devtools.lastGeneratedModelUrl') || '').trim();
      if (last && !safeTrim(this._state.assetPath)) this._state.assetPath = last;
    } catch { /* ignore */ }
    try {
      const resp = await fetch('/__devtools_envmaps');
      const j = await resp.json();
      this._envmaps = Array.isArray(j?.items) ? j.items.map((x) => String(x || '')).filter(Boolean) : [];
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
    return { job: this._job?.status || '', outMp4: this._job?.outMp4 || '' };
  }

  /* ─── Main UI ─── */

  _buildUi() {
    if (!this._root) return;
    clear(this._root);
    const st = this._state;

    // ── Asset input ──
    const assetPath = el('input', {
      value: st.assetPath,
      placeholder: 'assets/.../model.glb  (or USD/FBX — auto-converts)',
      oninput: (e) => { st.assetPath = safeTrim(e.target.value); },
      style: { width: '100%' },
    });

    // ── Output name ──
    const outName = el('input', {
      value: st.outName,
      placeholder: 'turntable',
      oninput: (e) => { st.outName = safeTrim(e.target.value); },
    });

    // ── Render settings (compact row) ──
    const resolution = el('input', {
      type: 'number', value: String(st.resolution), style: { width: '60px' },
      oninput: (e) => { st.resolution = Math.max(64, Number(e.target.value) || 768); },
    });
    const numFrames = el('input', {
      type: 'number', value: String(st.numFrames), style: { width: '60px' },
      oninput: (e) => { st.numFrames = Math.max(1, Number(e.target.value) || 120); },
    });
    const fps = el('input', {
      type: 'number', value: String(st.fps), style: { width: '50px' },
      oninput: (e) => { st.fps = Math.max(1, Number(e.target.value) || 15); },
    });
    const r = el('input', {
      type: 'number', value: String(st.r), step: '0.1', style: { width: '50px' },
      oninput: (e) => { st.r = Number(e.target.value) || 2.0; },
    });
    const fov = el('input', {
      type: 'number', value: String(st.fov), step: '1', style: { width: '50px' },
      oninput: (e) => { st.fov = Number(e.target.value) || 40.0; },
    });

    // ── Status / preview ──
    this._statusEl = el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Idle']);
    this._outEl = el('div', { style: { marginTop: '6px' } });
    this._previewEl = el('div', { style: { marginTop: '8px' } });
    this._envEl = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['No env check run yet.']);
    this._logEl = el('div', { class: 'scrollArea', style: { height: '160px' } }, ['(logs appear here)']);

    // ── Action buttons ──
    const startBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { await this._startJob(); } catch (e) { this._ctx?.log?.(`Turntable: start failed: ${e?.message || e}`); }
      },
    }, ['Render']);

    const killBtn = el('button', {
      class: 'danger',
      onclick: async () => {
        const id = this._job?.id;
        if (!id) return;
        try {
          await fetch('/__devtools_trellis_turntable_kill', {
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
            `nvdiffrast=${checks.nvdiffrast ? 'ok' : 'missing'} nvdiffrec=${checks.nvdiffrec ? 'ok' : 'missing'} cumesh=${checks.cumesh ? 'ok' : 'missing'}`,
          ];
          if (Array.isArray(j.missing) && j.missing.length) lines.push(`missing: ${j.missing.join(', ')}`);
          if (j.setupCmd) lines.push(`suggested setup: ${j.setupCmd}`);
          if (this._envEl) this._envEl.textContent = lines.join('\n');
        } catch (e) {
          if (this._envEl) this._envEl.textContent = `Env check failed: ${e?.message || e}`;
        }
      },
    }, ['Check env']);

    // ── Main card ──
    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Turntable Render']),
      el('div', { class: 'muted' }, [
        'Renders a rotating preview video (MP4) of a 3D model. USD/FBX auto-converts to GLB.',
      ]),

      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Input asset']),
      assetPath,

      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', { style: { flex: '1' } }, [el('div', { class: 'muted' }, ['Output name']), outName]),
      ]),

      el('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, [
        el('div', { style: { flex: '0 0 auto' } }, [el('div', { class: 'muted' }, ['Resolution']), resolution]),
        el('div', { style: { flex: '0 0 auto' } }, [el('div', { class: 'muted' }, ['Frames']), numFrames]),
        el('div', { style: { flex: '0 0 auto' } }, [el('div', { class: 'muted' }, ['FPS']), fps]),
        el('div', { style: { flex: '0 0 auto' } }, [el('div', { class: 'muted' }, ['Radius']), r]),
        el('div', { style: { flex: '0 0 auto' } }, [el('div', { class: 'muted' }, ['FOV']), fov]),
      ]),

      el('div', { class: 'row', style: { marginTop: '12px' } }, [startBtn, killBtn, envCheckBtn]),

      this._statusEl,
      this._outEl,
      this._previewEl,
      this._envEl,
    ]));

    // ── Advanced settings (collapsible) ──
    this._root.appendChild(this._buildAdvancedCard(st));

    // ── Asset picker ──
    this._root.appendChild(this._buildAssetPicker({
      title: 'Pick model',
      ext: '.glb,.gltf,.usd,.usda,.usdc,.usdz,.fbx',
      onPick: (p) => { st.assetPath = p; assetPath.value = p; },
    }));

    // ── Rendered gallery ──
    this._galleryEl = el('div');
    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Renders']),
      el('div', { class: 'muted' }, ['Previously rendered turntable videos.']),
      el('div', { style: { marginTop: '8px' } }, [
        el('button', { onclick: () => this._refreshGallery() }, ['Refresh']),
      ]),
      this._galleryEl,
    ]));
    void this._refreshGallery();

    // ── Logs (collapsible) ──
    const logsCard = document.createElement('details');
    logsCard.className = 'card';
    logsCard.innerHTML = '';
    const logsSummary = el('summary', {}, [el('div', { class: 'dockTitle' }, ['Logs'])]);
    const logsBody = el('div', { class: 'cardBody' }, [this._logEl]);
    logsCard.appendChild(logsSummary);
    logsCard.appendChild(logsBody);
    this._root.appendChild(logsCard);
  }

  _buildAdvancedCard(st) {
    const runner = el('select', {
      value: st.runner,
      onchange: (e) => { st.runner = String(e.target.value || 'conda_trellis'); },
    }, [
      el('option', { value: 'conda_trellis' }, ['conda run -n trellis  (recommended)']),
      el('option', { value: 'python3' }, ['python3  (current env)']),
    ]);

    const device = el('input', {
      value: st.device,
      oninput: (e) => { st.device = safeTrim(e.target.value); },
      style: { width: '80px' },
    });

    const envmapInput = el('input', {
      value: st.envmap,
      placeholder: '(auto — procedural studio)',
      oninput: (e) => { st.envmap = safeTrim(e.target.value); },
    });

    const envmapSelect = this._envmaps.length ? el('select', {
      value: st.envmap,
      onchange: (e) => {
        const v = String(e.target.value || '');
        st.envmap = v;
        envmapInput.value = v;
      },
    }, [
      el('option', { value: '' }, ['(auto)']),
      ...this._envmaps.map((p) => el('option', { value: p }, [basename(p)])),
    ]) : null;

    const card = document.createElement('details');
    card.className = 'card';
    const summary = el('summary', {}, [el('div', { class: 'dockTitle' }, ['Advanced'])]);
    const body = el('div', { class: 'cardBody' }, [
      el('div', { class: 'muted' }, ['Runner']),
      runner,
      el('div', { class: 'row', style: { marginTop: '10px' } }, [
        el('div', { style: { flex: '0 0 auto' } }, [el('div', { class: 'muted' }, ['Device']), device]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Environment map']),
      ...(envmapSelect ? [envmapSelect] : []),
      envmapInput,
    ]);
    card.appendChild(summary);
    card.appendChild(body);
    return card;
  }

  /* ─── Renders gallery ─── */

  async _refreshGallery() {
    const host = this._galleryEl;
    if (!host) return;
    clear(host);
    host.appendChild(el('div', { class: 'muted' }, ['Loading...']));
    try {
      const ctx = this._ctx;
      const items = await ctx.assetIndex({ query: 'assets/generated/trellis_render/', ext: '.mp4' });
      const sorted = (Array.isArray(items) ? items : [])
        .sort((a, b) => (Number(b?.mtimeMs) || 0) - (Number(a?.mtimeMs) || 0));
      clear(host);
      if (!sorted.length) {
        host.appendChild(el('div', { class: 'muted', style: { marginTop: '8px' } }, ['No renders yet.']));
        return;
      }
      for (const it of sorted.slice(0, 30)) {
        const p = String(it?.path || '');
        if (!p) continue;
        host.appendChild(this._renderGalleryItem(p, it?.mtimeMs));
      }
    } catch (e) {
      clear(host);
      host.appendChild(el('div', { class: 'muted' }, [`(error) ${e?.message || e}`]));
    }
  }

  _renderGalleryItem(relPath, mtimeMs) {
    const name = basename(relPath);
    const age = mtimeMs ? timeAgo(mtimeMs) : '';

    let videoEl = null;
    let expanded = false;

    const previewHost = el('div', { style: { marginTop: '6px' } });

    const togglePreview = () => {
      expanded = !expanded;
      clear(previewHost);
      if (expanded) {
        videoEl = el('video', {
          src: '/' + relPath,
          controls: true,
          autoplay: true,
          loop: true,
          muted: true,
          style: {
            width: '100%',
            maxWidth: '360px',
            borderRadius: '8px',
            marginTop: '6px',
            background: '#000',
          },
        });
        previewHost.appendChild(videoEl);
      } else {
        videoEl = null;
      }
    };

    const row = el('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginTop: '8px',
        padding: '6px 8px',
        borderRadius: '10px',
        border: '1px solid rgba(255,255,255,0.08)',
        background: 'rgba(255,255,255,0.03)',
      },
    }, [
      el('button', {
        onclick: togglePreview,
        style: { flex: '0 0 auto', padding: '4px 8px', fontSize: '11px' },
        title: 'Play/hide preview',
      }, ['Play']),
      el('div', { style: { flex: '1', minWidth: 0 } }, [
        el('div', { style: { fontSize: '12px', wordBreak: 'break-all' } }, [name]),
        el('div', { class: 'muted', style: { fontSize: '10px', opacity: '0.6' } }, [age]),
      ]),
      el('button', {
        onclick: async () => {
          try { await navigator.clipboard.writeText(relPath); this._ctx?.log?.(`Copied: ${relPath}`); } catch { /* */ }
        },
        style: { flex: '0 0 auto', padding: '4px 8px', fontSize: '11px' },
        title: 'Copy path',
      }, ['Copy']),
    ]);

    const container = el('div', {}, [row, previewHost]);
    return container;
  }

  /* ─── Video preview after render ─── */

  _showPreview(mp4Path) {
    const host = this._previewEl;
    if (!host || !mp4Path) return;
    clear(host);
    const video = el('video', {
      src: '/' + mp4Path,
      controls: true,
      autoplay: true,
      loop: true,
      muted: true,
      style: {
        width: '100%',
        maxWidth: '360px',
        borderRadius: '8px',
        background: '#000',
      },
    });
    host.appendChild(video);
  }

  /* ─── Asset picker ─── */

  _buildAssetPicker({ title, ext, onPick }) {
    const ctx = this._ctx;
    const presets = [
      { label: 'Generated', query: 'assets/generated/' },
      { label: 'All assets', query: 'assets/' },
      { label: 'Outputs', query: 'outputs/' },
      { label: 'Custom', query: '' },
    ];
    let activePreset = presets[0].query;

    const presetSel = el('select', {
      value: activePreset,
      onchange: () => {
        activePreset = String(presetSel.value || '');
        queryInput.value = activePreset;
        queryInput.style.display = activePreset ? 'none' : '';
        void refresh();
      },
    }, presets.map((p) => el('option', { value: p.query }, [p.label])));

    const queryInput = el('input', {
      placeholder: 'search path...',
      style: { display: 'none' },
    });
    queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') void refresh(); });

    const list = el('div', { class: 'scrollArea', style: { height: '180px' } }, ['(loading...)']);

    const renderItems = (items) => {
      clear(list);
      if (!items.length) { list.textContent = '(no matches)'; return; }
      items.sort((a, b) => (Number(b?.mtimeMs) || 0) - (Number(a?.mtimeMs) || 0));
      for (const it of items.slice(0, 200)) {
        const p = String(it?.path || '');
        if (!p) continue;
        const fname = basename(p);
        const dir = p.slice(0, p.length - fname.length);
        list.appendChild(el('button', {
          class: 'toolBtn',
          style: { marginTop: '4px' },
          title: p,
          onclick: () => onPick(p),
        }, [
          el('span', { style: { opacity: '0.45', fontSize: '11px' } }, [dir]),
          el('span', {}, [fname]),
        ]));
      }
    };

    const refresh = async () => {
      const q = String(activePreset || queryInput.value || '').trim();
      if (!q) { list.textContent = '(enter a search query)'; return; }
      try {
        list.textContent = 'Loading...';
        const items = await ctx.assetIndex({ query: q, ext });
        renderItems(Array.isArray(items) ? items : []);
      } catch (e) {
        list.textContent = `(error) ${e?.message || e}`;
      }
    };

    void refresh();

    const card = document.createElement('details');
    card.className = 'card';
    card.open = true;
    const summary = el('summary', {}, [el('div', { class: 'dockTitle' }, [String(title || 'Assets')])]);
    const body = el('div', { class: 'cardBody' }, [
      el('div', { class: 'row', style: { gap: '8px' } }, [
        presetSel,
        el('button', { onclick: () => void refresh() }, ['Refresh']),
      ]),
      el('div', { class: 'row', style: { marginTop: '6px' } }, [queryInput]),
      el('div', { style: { marginTop: '6px' } }, [list]),
    ]);
    card.appendChild(summary);
    card.appendChild(body);
    return card;
  }

  /* ─── Job logic ─── */

  async _startJob() {
    const st = this._state;
    const inp = safeTrim(st.assetPath);
    if (!inp) throw new Error('Missing assetPath');

    // Clear previous preview
    if (this._previewEl) clear(this._previewEl);

    // If it isn't GLB/GLTF, convert to GLB first.
    let glbPath = inp;
    const ext = extOf(inp);
    if (!isGlbLikeExt(ext)) {
      if (this._statusEl) this._statusEl.textContent = `Converting ${ext || '(unknown)'} to GLB...`;
      if (this._outEl) this._outEl.textContent = '';
      if (this._logEl) this._logEl.textContent = '(starting convert job...)';

      const outBase = safeTrim(st.outName) || 'turntable';
      const resp0 = await fetch('/__devtools_convert_start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runner: st.runner,
          inPath: inp,
          blenderPath: '',
          exportFormat: 'GLB',
          outName: outBase + '_turntable',
        }),
      });
      const j0 = await resp0.json();
      if (!j0?.ok) throw new Error(String(j0?.error || 'convert start failed'));
      this._convertJob = { id: String(j0.id || ''), status: 'running', stdout: '', stderr: '', outGlb: String(j0.outGlb || '') };
      glbPath = await this._pollConvertUntilDone(this._convertJob.id);
      try { localStorage.setItem('devtools.lastGeneratedModelUrl', glbPath); } catch { /* ignore */ }
    }

    const payload = {
      runner: st.runner,
      glbAssetPath: glbPath,
      outName: st.outName,
      device: st.device,
      envmap: st.envmap,
      fps: st.fps,
      numFrames: st.numFrames,
      resolution: st.resolution,
      r: st.r,
      fov: st.fov,
    };

    if (this._statusEl) this._statusEl.textContent = 'Rendering...';
    if (this._outEl) this._outEl.textContent = '';
    if (this._logEl) this._logEl.textContent = '(starting...)';

    const resp = await fetch('/__devtools_trellis_turntable_start', {
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
      outMp4: String(j.outMp4 || ''),
    };
    this._ctx?.log?.(`Turntable: rendering (${this._job.id})`);

    this._polling = true;
    void this._pollJobLoop();
  }

  async _pollConvertUntilDone(id) {
    const ctx = this._ctx;
    if (!id) throw new Error('Missing convert job id');
    let backoff = 450;
    while (true) {
      const resp = await fetch(`/__devtools_convert_job?id=${encodeURIComponent(id)}`);
      const j = await resp.json();
      if (!j?.ok) throw new Error(String(j?.error || 'convert job query failed'));
      const status = String(j.status || '');
      const out = String(j.stdout || '');
      const err = String(j.stderr || '');
      const outGlb = String(j.outGlb || '');

      if (this._statusEl) {
        const code = (j.exitCode == null) ? '' : ` (exit=${j.exitCode})`;
        this._statusEl.textContent = `Converting... ${status}${code}`;
      }
      if (this._logEl) {
        const text = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output yet)';
        this._logEl.textContent = text;
        try { this._logEl.scrollTop = this._logEl.scrollHeight; } catch { /* ignore */ }
      }

      if (status === 'done') {
        if (!outGlb) throw new Error('Convert finished but missing outGlb');
        ctx?.log?.(`Turntable: convert done`);
        return outGlb;
      }
      if (status === 'error' || status === 'killed') {
        throw new Error(`Convert failed (${status})`);
      }
      await sleep(backoff);
      backoff = Math.min(1800, Math.floor(backoff * 1.25));
    }
  }

  async _pollJobLoop() {
    const id = this._job?.id;
    if (!id) return;
    let backoff = 400;
    while (this._polling && this._job?.id === id) {
      try {
        const resp = await fetch(`/__devtools_trellis_turntable_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'job query failed'));
        this._job.status = String(j.status || '');
        this._job.stdout = String(j.stdout || '');
        this._job.stderr = String(j.stderr || '');
        this._job.outMp4 = String(j.outMp4 || this._job.outMp4 || '');

        if (this._statusEl) {
          const code = (j.exitCode == null) ? '' : ` (exit=${j.exitCode})`;
          this._statusEl.textContent = `Rendering... ${this._job.status}${code}`;
        }
        if (this._logEl) {
          const out = this._job.stdout || '';
          const err = this._job.stderr || '';
          const text = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output yet)';
          this._logEl.textContent = text;
          try { this._logEl.scrollTop = this._logEl.scrollHeight; } catch { /* ignore */ }
        }
        if (this._outEl) {
          this._outEl.textContent = this._job.outMp4 ? `Output: ${this._job.outMp4}` : '';
        }

        if (this._job.status === 'done' || this._job.status === 'error' || this._job.status === 'killed') {
          this._polling = false;
          if (this._job.status === 'done') {
            if (this._statusEl) this._statusEl.textContent = 'Done';
            this._ctx?.log?.(`Turntable: done`);
            this._showPreview(this._job.outMp4);
            void this._refreshGallery();
          } else {
            if (this._statusEl) this._statusEl.textContent = `Failed (${this._job.status})`;
            this._ctx?.log?.(`Turntable: ${this._job.status}`);
          }
          return;
        }
        backoff = 500;
      } catch (e) {
        if (this._statusEl) this._statusEl.textContent = `Poll error: ${e?.message || e}`;
        backoff = Math.min(2000, Math.floor(backoff * 1.4));
      }
      await sleep(backoff);
    }
  }
}
