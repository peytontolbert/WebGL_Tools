import { el, clear, clamp } from '../../ui/dom.js';
import { getGl } from '../../runtime/gl.js';
import { Camera } from '../../runtime/camera.js';
import { TerrainRenderer } from '../../runtime/terrain_renderer.js';
import { WaterRenderer } from '../../runtime/water_renderer.js';
import { loadHeightmapU16 } from '../../runtime/heightmap_loader.js';
import { createAssetPicker, createProgressBar } from '../components/ui_components.js';

function resizeCanvasToDisplaySize(canvasEl, maxDpr = 2.0) {
  const dpr = Math.min(maxDpr, window.devicePixelRatio || 1);
  const rect = canvasEl.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (canvasEl.width !== w || canvasEl.height !== h) {
    canvasEl.width = w;
    canvasEl.height = h;
    return true;
  }
  return false;
}

function makeDefaultMaskRgba(w, h) {
  return new Uint8Array(Math.max(0, (w | 0) * (h | 0) * 4));
}

function debounce(fn, ms = 150) {
  let t = 0;
  return (...args) => {
    try { clearTimeout(t); } catch { /* ignore */ }
    t = setTimeout(() => fn(...args), Math.max(0, Number(ms) || 0));
  };
}

export class TerrainTool {
  constructor() {
    this.id = 'terrain';
    this.label = 'Terrain Editor';

    this._ctx = null;
    this._root = null;

    this._canvas = null;
    this._gl = null;
    this._camera = null;
    this._terrain = null;
    this._water = null;

    this._timeSec = 0;

    this._state = {
      hmMetaUrl: 'assets/datasets/generated/ai_city_example/heightmap/meta.json',
      sizeX: 600,
      sizeZ: 600,
      centerX: 0,
      centerZ: 0,
      heightScale: 1.0,
      showWater: false,
      waterLevelY: 0.0,
      waterOpacity: 0.55,

      // Mesh -> heightmap (offline tool via dev server)
      hmRunner: 'conda_trellis',
      hmMeshPath: '',
      hmGrid: 256,
      hmBlenderPath: '',
      hmArgs: '',
      hmOutName: '',
      hmJobAutoLoad: 1,
    };

    this._hmInfoEl = null;
    this._hmJob = { id: '', status: '', stdout: '', stderr: '', outMeta: '' };
    this._pollingHm = false;

    this._prefsKey = 'devtools.terrain.state';
    this._loadPrefs();
    this._savePrefsDebounced = debounce(() => this._savePrefs(), 150);
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;

    this._canvas = document.createElement('canvas');
    this._canvas.style.width = '100%';
    this._canvas.style.height = '100%';
    ctx.canvasHost.appendChild(this._canvas);

    this._gl = getGl(this._canvas);
    this._camera = new Camera();
    this._camera.attach(this._canvas);
    this._camera.setAllowOrbitLmb(true);

    this._terrain = new TerrainRenderer(this._gl);
    await this._terrain.init(128, 128);

    this._water = new WaterRenderer(this._gl);
    await this._water.init();

    this._buildUi();

    // Auto-load default heightmap
    try {
      await this._loadHeightmap(this._state.hmMetaUrl);
    } catch (e) {
      ctx.log(`Terrain: could not auto-load heightmap: ${e?.message || e}`);
      ctx?.toast?.(String(e?.message || e || 'Auto-load failed'), 'error', { title: 'Terrain' });
    }
  }

  async unmount() {
    this._pollingHm = false;
    try { this._terrain?.dispose?.(); } catch { /* ignore */ }
    try { this._water?.dispose?.(); } catch { /* ignore */ }
    this._terrain = null;
    this._water = null;
    this._camera = null;
    this._gl = null;

    if (this._canvas?.parentNode) this._canvas.parentNode.removeChild(this._canvas);
    this._canvas = null;
    this._ctx = null;
    this._root = null;
  }

  tick(dt, absTimeSec) {
    if (!this._gl || !this._canvas || !this._camera || !this._terrain) return;
    this._timeSec = Number(absTimeSec) || (this._timeSec + (Number(dt) || 0));

    resizeCanvasToDisplaySize(this._canvas, 2.0);
    const gl = this._gl;
    gl.viewport(0, 0, this._canvas.width, this._canvas.height);

    this._camera.setAspect(this._canvas.width, this._canvas.height);
    this._camera.tick(dt);

    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.clearColor(0.04, 0.05, 0.07, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this._terrain.render(this._camera.viewProj);

    if (this._state.showWater && this._water) {
      this._water.levelY = Number(this._state.waterLevelY) || 0.0;
      this._water.opacity = clamp(this._state.waterOpacity, 0.0, 1.0);
      const minX = this._terrain.boundsMin[0];
      const minZ = this._terrain.boundsMin[1];
      const maxX = minX + this._terrain.boundsSize[0];
      const maxZ = minZ + this._terrain.boundsSize[1];
      this._water._minX = minX;
      this._water._maxX = maxX;
      this._water._minZ = minZ;
      this._water._maxZ = maxZ;
      this._water._rebuildPlane?.();
      this._water.render(this._camera.viewProj, { timeSec: this._timeSec });
    }
  }

  /* ═══════════════════════════════════════════════
   *  UI
   * ═══════════════════════════════════════════════ */

  _buildUi() {
    if (!this._root) return;
    clear(this._root);

    const ctx = this._ctx;
    const st = this._state;

    // ── Load heightmap ──
    const hmUrlInput = el('input', {
      value: st.hmMetaUrl,
      placeholder: 'assets/.../heightmap/meta.json',
      oninput: (e) => { st.hmMetaUrl = String(e.target.value || '').trim(); this._savePrefsDebounced?.(); },
    });

    const loadProgress = createProgressBar();
    this._loadProgress = loadProgress;

    const loadBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { await this._loadHeightmap(st.hmMetaUrl); }
        catch (e) {
          ctx?.log(`Terrain: load failed: ${e?.message || e}`);
          ctx?.toast?.(String(e?.message || e || 'Load failed'), 'error', { title: 'Terrain load failed' });
        }
      },
    }, ['Load']);

    this._hmInfoEl = el('div', { class: 'muted', style: { marginTop: '6px' } }, ['No heightmap loaded yet.']);

    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Heightmap']),
      el('div', { class: 'muted', style: { marginTop: '2px' } }, [
        'Load a u16 DEM heightmap from a meta.json file.',
      ]),
      el('div', { class: 'formGroup' }, [
        el('div', { class: 'formLabel' }, ['Meta URL']),
        el('div', { class: 'row' }, [hmUrlInput, loadBtn]),
      ]),
      loadProgress.element,
      this._hmInfoEl,
    ]));

    // ── Asset picker (heightmap meta) ──
    this._root.appendChild(createAssetPicker({
      ctx,
      title: 'Find Heightmap',
      ext: '.json,.gz',
      placeholder: 'Search for meta.json\u2026',
      onPick: (p) => {
        st.hmMetaUrl = p;
        hmUrlInput.value = p;
        ctx?.toast?.(`Selected: ${p.split('/').pop()}`, 'info');
      },
    }));

    // ── Bounds / Scale ──
    const sizeX = el('input', {
      value: String(st.sizeX),
      oninput: (e) => { st.sizeX = Math.max(1, Number(e.target.value) || 1); this._applyBounds(); },
    });
    const sizeZ = el('input', {
      value: String(st.sizeZ),
      oninput: (e) => { st.sizeZ = Math.max(1, Number(e.target.value) || 1); this._applyBounds(); },
    });
    const centerX = el('input', {
      value: String(st.centerX),
      oninput: (e) => { st.centerX = Number(e.target.value) || 0; this._applyBounds(); },
    });
    const centerZ = el('input', {
      value: String(st.centerZ),
      oninput: (e) => { st.centerZ = Number(e.target.value) || 0; this._applyBounds(); },
    });
    const heightScale = el('input', {
      value: String(st.heightScale),
      oninput: (e) => {
        st.heightScale = Math.max(0.01, Number(e.target.value) || 1.0);
        this._terrain?.setHeightScale?.(st.heightScale);
        this._savePrefsDebounced?.();
      },
    });

    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Bounds & Scale']),
      el('div', { class: 'formRow', style: { marginTop: '8px' } }, [
        el('div', { class: 'formGroup', style: { marginTop: '0' } }, [
          el('div', { class: 'formLabel' }, ['Size X (m)']),
          sizeX,
        ]),
        el('div', { class: 'formGroup', style: { marginTop: '0' } }, [
          el('div', { class: 'formLabel' }, ['Size Z (m)']),
          sizeZ,
        ]),
      ]),
      el('div', { class: 'formRow', style: { marginTop: '4px' } }, [
        el('div', { class: 'formGroup', style: { marginTop: '0' } }, [
          el('div', { class: 'formLabel' }, ['Center X']),
          centerX,
        ]),
        el('div', { class: 'formGroup', style: { marginTop: '0' } }, [
          el('div', { class: 'formLabel' }, ['Center Z']),
          centerZ,
        ]),
      ]),
      el('div', { class: 'formGroup' }, [
        el('div', { class: 'formLabel' }, ['Height scale']),
        heightScale,
      ]),
      el('div', { class: 'formHint', style: { marginTop: '6px' } }, ['Wheel zoom, drag orbit, WASDQE move.']),
    ]));

    // ── Water ──
    const waterLevel = el('input', {
      value: String(st.waterLevelY),
      oninput: (e) => { st.waterLevelY = Number(e.target.value) || 0.0; },
    });
    const waterOpacity = el('input', {
      value: String(st.waterOpacity),
      oninput: (e) => { st.waterOpacity = clamp(Number(e.target.value) || 0.55, 0.0, 1.0); },
    });

    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Water Overlay']),
      el('div', { style: { marginTop: '4px' } }, [
        el('label', { class: 'layerToggle' }, [
          el('input', {
            type: 'checkbox',
            checked: !!st.showWater,
            onchange: (e) => { st.showWater = !!e.target.checked; },
          }),
          el('span', { class: 'layerName' }, ['Show water plane']),
        ]),
        el('div', { class: 'formRow', style: { marginTop: '8px' } }, [
          el('div', { class: 'formGroup', style: { marginTop: '0' } }, [
            el('div', { class: 'formLabel' }, ['Level Y']),
            waterLevel,
          ]),
          el('div', { class: 'formGroup', style: { marginTop: '0' } }, [
            el('div', { class: 'formLabel' }, ['Opacity']),
            waterOpacity,
          ]),
        ]),
      ]),
    ]));

    // ── Mesh -> Heightmap Job ──
    const hmRunner = el('select', {
      value: st.hmRunner,
      onchange: (e) => { st.hmRunner = String(e.target.value || 'conda_trellis'); },
    }, [
      el('option', { value: 'conda_trellis' }, ['conda_trellis']),
      el('option', { value: 'python3' }, ['python3']),
    ]);

    const hmMeshPath = el('input', {
      value: st.hmMeshPath,
      placeholder: 'e.g. assets/generated/trellis/my_terrain.glb',
      oninput: (e) => { st.hmMeshPath = String(e.target.value || '').trim(); },
    });

    const hmGrid = el('input', {
      value: String(st.hmGrid || 256),
      oninput: (e) => {
        st.hmGrid = Math.max(16, Math.min(4096, Math.floor(Number(e.target.value) || 256)));
        this._savePrefsDebounced?.();
      },
    });

    const hmOutName = el('input', {
      value: st.hmOutName,
      placeholder: 'e.g. my_terrain (optional)',
      oninput: (e) => { st.hmOutName = String(e.target.value || '').trim(); this._savePrefsDebounced?.(); },
    });

    const hmAutoLoad = el('input', {
      type: 'checkbox',
      checked: !!st.hmJobAutoLoad,
      onchange: (e) => { st.hmJobAutoLoad = e.target.checked ? 1 : 0; this._savePrefsDebounced?.(); },
    });

    const hmJobProgress = createProgressBar();
    this._hmJobProgress = hmJobProgress;

    const hmStatus = el('div', { class: 'muted', style: { marginTop: '6px', display: 'flex', alignItems: 'center', gap: '6px' } }, ['']);
    const hmLog = el('div', { class: 'scrollArea', style: { height: '140px', marginTop: '6px', whiteSpace: 'pre' } }, ['Ready.']);

    const hmStartBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        if (!st.hmMeshPath?.trim()) {
          ctx?.toast?.('Please select a mesh file first', 'warning');
          return;
        }
        try {
          await this._startHeightmapJob({
            runner: st.hmRunner,
            inMeshPath: st.hmMeshPath,
            grid: st.hmGrid,
            heightmapArgs: st.hmArgs,
            blenderPath: st.hmBlenderPath,
            outName: st.hmOutName,
            statusEl: hmStatus,
            logEl: hmLog,
            autoLoad: !!st.hmJobAutoLoad,
            hmUrlInput,
          });
        } catch (e) {
          ctx?.log?.(`Heightmap: start failed: ${e?.message || e}`);
          ctx?.toast?.(`Heightmap job failed: ${e?.message || e}`, 'error');
        }
      },
    }, ['Convert Mesh']);

    const hmKillBtn = el('button', {
      class: 'danger',
      onclick: async () => {
        const id = String(this._hmJob?.id || '');
        if (!id) return;
        try {
          await fetch('/__devtools_heightmap_kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
          ctx?.toast?.('Job killed', 'warning');
        } catch { /* ignore */ }
        this._pollingHm = false;
      },
    }, ['Kill']);

    const hmCopyBtn = el('button', {
      onclick: async () => {
        const p = String(this._hmJob?.outMeta || '');
        if (!p) { ctx?.toast?.('No output path yet', 'warning'); return; }
        try { await navigator.clipboard.writeText(p); ctx?.toast?.('Path copied', 'success'); } catch { /* ignore */ }
      },
    }, ['Copy Path']);

    // Advanced options (collapsible)
    const hmBlenderPath = el('input', {
      value: st.hmBlenderPath,
      placeholder: '/usr/bin/blender (optional)',
      oninput: (e) => { st.hmBlenderPath = String(e.target.value || '').trim(); this._savePrefsDebounced?.(); },
    });
    const hmArgs = el('input', {
      value: st.hmArgs,
      placeholder: 'Extra args (optional)',
      oninput: (e) => { st.hmArgs = String(e.target.value || ''); this._savePrefsDebounced?.(); },
    });

    this._root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Mesh \u2192 Heightmap']),
      el('div', { class: 'muted', style: { marginTop: '2px' } }, [
        'Convert a 3D mesh to a u16 DEM heightmap.',
      ]),
      el('div', { class: 'formGroup' }, [
        el('div', { class: 'formLabel' }, ['Runner']),
        hmRunner,
      ]),
      el('div', { class: 'formGroup' }, [
        el('div', { class: 'formLabel' }, ['Mesh Path']),
        hmMeshPath,
      ]),
      el('div', { class: 'formRow', style: { marginTop: '8px' } }, [
        el('div', { class: 'formGroup', style: { marginTop: '0' } }, [
          el('div', { class: 'formLabel' }, ['Grid']),
          hmGrid,
          el('div', { class: 'formHint' }, ['Heightmap resolution (higher = slower).']),
        ]),
        el('div', { class: 'formGroup', style: { marginTop: '0' } }, [
          el('div', { class: 'formLabel' }, ['Out Name']),
          hmOutName,
        ]),
      ]),
      el('label', { class: 'layerToggle', style: { marginTop: '6px' } }, [
        hmAutoLoad,
        el('span', { class: 'layerName' }, ['Auto-load output']),
      ]),
      el('details', { class: 'card', style: { marginTop: '8px' } }, [
        el('summary', {}, [el('div', { class: 'dockTitle' }, ['Advanced'])]),
        el('div', { class: 'cardBody' }, [
          el('div', { class: 'formGroup', style: { marginTop: '0' } }, [
            el('div', { class: 'formLabel' }, ['Blender Path']),
            hmBlenderPath,
          ]),
          el('div', { class: 'formGroup' }, [
            el('div', { class: 'formLabel' }, ['Extra Args']),
            hmArgs,
          ]),
        ]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [hmStartBtn, hmKillBtn, hmCopyBtn]),
      hmJobProgress.element,
      hmStatus,
      hmLog,
    ]));

    // ── Asset picker for mesh ──
    this._root.appendChild(createAssetPicker({
      ctx,
      title: 'Find Terrain Mesh',
      ext: '.glb,.gltf,.obj,.fbx,.blend',
      placeholder: 'Search for mesh file\u2026',
      onPick: (p) => {
        st.hmMeshPath = p;
        hmMeshPath.value = p;
        this._savePrefsDebounced?.();
        ctx?.toast?.(`Selected: ${p.split('/').pop()}`, 'info');
      },
    }));
  }

  /* ═══════════════════════════════════════════════
   *  Data loading
   * ═══════════════════════════════════════════════ */

  async _loadHeightmap(metaUrl) {
    const ctx = this._ctx;
    if (!this._terrain) return;
    const url = String(metaUrl || '').trim();
    if (!url) throw new Error('Missing heightmap meta url');

    this._loadProgress?.setIndeterminate();
    ctx?.log(`Terrain: loading ${url}`);
    ctx?.toast?.('Loading heightmap\u2026', 'info');

    const hm = await loadHeightmapU16(url);
    const w = hm.width | 0;
    const h = hm.height | 0;

    const mask = makeDefaultMaskRgba(w, h);
    this._terrain.uploadHeightU16(w, h, hm.heightsU16);
    this._terrain.uploadMaskRgba(w, h, mask);

    const minZ = Number.isFinite(hm.minZ) ? hm.minZ : 0.0;
    const maxZ = Number.isFinite(hm.maxZ) ? hm.maxZ : (minZ + 40.0);

    // Auto-fill bounds from meta bbox if available
    try {
      const bb = hm?.meta?.bbox || null;
      const minXb = Number(bb?.minX);
      const maxXb = Number(bb?.maxX);
      const minYb = Number(bb?.minY);
      const maxYb = Number(bb?.maxY);
      if (Number.isFinite(minXb) && Number.isFinite(maxXb) && Number.isFinite(minYb) && Number.isFinite(maxYb) && (maxXb > minXb) && (maxYb > minYb)) {
        this._state.sizeX = Math.max(1, maxXb - minXb);
        this._state.sizeZ = Math.max(1, maxYb - minYb);
        this._state.centerX = (minXb + maxXb) * 0.5;
        this._state.centerZ = (minYb + maxYb) * 0.5;
      }
    } catch { /* ignore */ }
    this._applyBounds({ minZ, maxZ });

    // Frame camera
    const min = [this._terrain.boundsMin[0], minZ, this._terrain.boundsMin[1]];
    const max = [
      this._terrain.boundsMin[0] + this._terrain.boundsSize[0],
      maxZ,
      this._terrain.boundsMin[1] + this._terrain.boundsSize[1],
    ];
    this._camera?.frameAABB?.(min, max);

    if (this._hmInfoEl) {
      this._hmInfoEl.textContent =
        `${w}\u00D7${h}  |  Z: ${Number.isFinite(hm.minZ) ? hm.minZ.toFixed(1) : '?'} \u2013 ${Number.isFinite(hm.maxZ) ? hm.maxZ.toFixed(1) : '?'}`;
    }

    this._loadProgress?.set(1);
    setTimeout(() => this._loadProgress?.hide(), 1200);
    ctx?.log(`Terrain: loaded ${w}x${h}`);
    ctx?.toast?.(`Heightmap loaded: ${w}\u00D7${h}`, 'success');
    this._savePrefsDebounced?.();
  }

  /* ═══════════════════════════════════════════════
   *  Heightmap job
   * ═══════════════════════════════════════════════ */

  async _startHeightmapJob({ runner, inMeshPath, grid, heightmapArgs, blenderPath, outName, statusEl, logEl, autoLoad, hmUrlInput }) {
    const ctx = this._ctx;
    const inp = String(inMeshPath || '').trim();
    if (!inp) throw new Error('Missing inMeshPath');

    this._hmJob = { id: '', status: 'running', stdout: '', stderr: '', outMeta: '' };
    this._pollingHm = false;

    clear(statusEl);
    statusEl.appendChild(el('div', { class: 'statusDot running' }));
    statusEl.appendChild(document.createTextNode('Starting\u2026'));
    logEl.textContent = '(starting\u2026)';
    this._hmJobProgress?.setIndeterminate();
    ctx?.toast?.('Heightmap conversion started', 'info');

    const payload = {
      runner: String(runner || 'conda_trellis'),
      inMeshPath: inp,
      grid: Number(grid || 256),
      heightmapArgs: String(heightmapArgs || ''),
      blenderPath: String(blenderPath || ''),
      outName: String(outName || ''),
    };

    const resp = await fetch('/__devtools_heightmap_start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'heightmap start failed'));

    this._hmJob.id = String(j.id || '');
    this._hmJob.outMeta = String(j.outMeta || '');
    this._pollingHm = true;
    void this._pollHeightmapLoop({ id: this._hmJob.id, statusEl, logEl, autoLoad: !!autoLoad, hmUrlInput });
    ctx?.log?.('Heightmap: started');
  }

  async _pollHeightmapLoop({ id, statusEl, logEl, autoLoad, hmUrlInput }) {
    const ctx = this._ctx;
    if (!id) return;
    let backoff = 400;
    while (this._pollingHm && this._hmJob?.id === id) {
      try {
        const resp = await fetch(`/__devtools_heightmap_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'job query failed'));
        this._hmJob.status = String(j.status || '');
        this._hmJob.stdout = String(j.stdout || '');
        this._hmJob.stderr = String(j.stderr || '');
        this._hmJob.outMeta = String(j.outMeta || this._hmJob.outMeta || '');

        // Update status
        clear(statusEl);
        const dotClass = (this._hmJob.status === 'done') ? 'done' : (this._hmJob.status === 'error' || this._hmJob.status === 'killed') ? 'error' : 'running';
        statusEl.appendChild(el('div', { class: `statusDot ${dotClass}` }));
        statusEl.appendChild(document.createTextNode(
          `${this._hmJob.status}${this._hmJob.outMeta ? ` \u2014 ${this._hmJob.outMeta}` : ''}`
        ));

        // Update log
        const out = this._hmJob.stdout || '';
        const err = this._hmJob.stderr || '';
        logEl.textContent = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output yet)';
        try { logEl.scrollTop = logEl.scrollHeight; } catch { /* ignore */ }

        if (this._hmJob.status === 'done' || this._hmJob.status === 'error' || this._hmJob.status === 'killed') {
          this._pollingHm = false;
          this._hmJobProgress?.hide();

          if (this._hmJob.status === 'done') {
            this._hmJobProgress?.set(1);
            const outMeta = String(this._hmJob.outMeta || '').trim();
            if (outMeta) {
              ctx?.log?.(`Heightmap: done \u2192 ${outMeta}`);
              ctx?.toast?.(`Heightmap ready: ${outMeta.split('/').pop()}`, 'success');
              if (hmUrlInput) hmUrlInput.value = outMeta;
              this._state.hmMetaUrl = outMeta;
              if (autoLoad) {
                try { await this._loadHeightmap(outMeta); }
                catch (e) {
                  ctx?.log?.(`Heightmap: auto-load failed: ${e?.message || e}`);
                  ctx?.toast?.(String(e?.message || e || 'Auto-load failed'), 'error', { title: 'Heightmap' });
                }
              }
            }
          } else {
            ctx?.toast?.(`Heightmap job ${this._hmJob.status}`, 'error');
          }
          return;
        }

        backoff = 500;
      } catch (e) {
        clear(statusEl);
        statusEl.appendChild(el('div', { class: 'statusDot error' }));
        statusEl.appendChild(document.createTextNode(`Poll error: ${e?.message || e}`));
        backoff = Math.min(2000, Math.floor(backoff * 1.4));
      }
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  _applyBounds({ minZ, maxZ } = {}) {
    if (!this._terrain) return;
    const st = this._state;
    const sizeX = Math.max(1, Number(st.sizeX) || 1);
    const sizeZ = Math.max(1, Number(st.sizeZ) || 1);
    const cx = Number(st.centerX) || 0;
    const cz = Number(st.centerZ) || 0;
    const minX = cx - sizeX * 0.5;
    const minY = cz - sizeZ * 0.5;

    const z0 = Number.isFinite(Number(minZ)) ? Number(minZ) : this._terrain.boundsMin[2];
    const z1 = Number.isFinite(Number(maxZ)) ? Number(maxZ) : (this._terrain.boundsMin[2] + this._terrain.boundsSize[2]);
    const minZVal = Number.isFinite(z0) ? z0 : 0.0;
    const maxZVal = Number.isFinite(z1) ? z1 : (minZVal + 40.0);

    this._terrain.setBounds({
      minX,
      minY,
      minZ: minZVal,
      maxX: minX + sizeX,
      maxY: minY + sizeZ,
      maxZ: maxZVal,
    });
    this._terrain.setHeightScale(st.heightScale);
    this._savePrefsDebounced?.();
  }

  _loadPrefs() {
    try {
      const raw = localStorage.getItem(this._prefsKey);
      const j = raw ? JSON.parse(raw) : null;
      if (!j || typeof j !== 'object') return;
      for (const k of Object.keys(this._state)) {
        if (j[k] === undefined) continue;
        this._state[k] = j[k];
      }
    } catch { /* ignore */ }
  }

  _savePrefs() {
    try { localStorage.setItem(this._prefsKey, JSON.stringify(this._state)); } catch { /* ignore */ }
  }
}
