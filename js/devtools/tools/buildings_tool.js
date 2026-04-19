import { el, clear } from '../../ui/dom.js';
import { SceneTool } from './scene_tool.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createAssetPicker, createJsonTextAreaCard } from '../components/ui_components.js';

function safeTrim(s) { return String(s ?? '').trim(); }

function resizeCanvasToDisplaySize(canvasEl, maxDpr = 2.0) {
  const dpr = Math.min(maxDpr, window.devicePixelRatio || 1);
  const rect = canvasEl.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (canvasEl.width !== w || canvasEl.height !== h) {
    canvasEl.width = w;
    canvasEl.height = h;
    return { changed: true, dpr, w, h };
  }
  return { changed: false, dpr, w: canvasEl.width, h: canvasEl.height };
}

/**
 * A buildings-focused tool that reuses SceneTool's 3D viewport + building authoring.
 * It intentionally omits scenario/trigger UI.
 */
export class BuildingsTool extends SceneTool {
  constructor() {
    super();
    this.id = 'buildings';
    this.label = 'Buildings Editor';
    // Buildings tool is always orbit/editing (no FPS/gameplay).
    this._state.mode = 'orbit';
    this._state.autoPlayAfterLoad = false;
    this._state.showGrid = true;

    this._activeBuildingPath = ''; // last opened building asset (assets/...json)
    this._lib = { items: [], listEl: null, statusEl: null };
    this._sceneBuildings = { items: [], selectedUuid: '', time: '' };
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;

    // Restore tool-specific prefs (do NOT share SceneTool state).
    try { this._activeBuildingPath = String(localStorage.getItem('devtools.buildings.activeBuildingPath') || '').trim(); } catch { /* ignore */ }
    // Back-compat with older builds that stored the "active set" path.
    try { if (!this._activeBuildingPath) this._activeBuildingPath = String(localStorage.getItem('devtools.buildings.activeSetPath') || '').trim(); } catch { /* ignore */ }
    // Back-compat with older builds that stored the path in sourceUrl.
    try { if (!this._activeBuildingPath) this._activeBuildingPath = String(localStorage.getItem('devtools.buildings.sourceUrl') || '').trim(); } catch { /* ignore */ }
    try { this._state.showGrid = !!Number(localStorage.getItem('devtools.buildings.showGrid') || '1'); } catch { /* ignore */ }

    // Load a lightweight index of buildings from Scene tool (no scene loading).
    try {
      const raw = String(localStorage.getItem('devtools.buildings.sceneBuildingsJson') || '').trim();
      const sel = String(localStorage.getItem('devtools.buildings.sceneBuildingsSelectedUuid') || '').trim();
      const time = String(localStorage.getItem('devtools.buildings.sceneBuildingsTime') || '').trim();
      const j = raw ? JSON.parse(raw) : null;
      const arr = Array.isArray(j?.buildings) ? j.buildings : [];
      this._sceneBuildings.items = arr;
      this._sceneBuildings.selectedUuid = sel;
      this._sceneBuildings.time = time;
    } catch { /* ignore */ }

    // Canvas + renderer
    this._canvas = document.createElement('canvas');
    this._canvas.style.width = '100%';
    this._canvas.style.height = '100%';
    ctx.canvasHost.appendChild(this._canvas);

    const renderer = new THREE.WebGLRenderer({
      canvas: this._canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    renderer.setClearColor(new THREE.Color(0x06080c), 1.0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this._renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x06080c);
    this._scene = scene;

    const camera = new THREE.PerspectiveCamera(70, 1, 0.03, 200000);
    camera.position.set(18, 12, 18);
    this._camera = camera;
    try { scene.add(camera); } catch { /* ignore */ }
    this._baseFov = Number(camera.fov) || 70;

    this._orbit = new OrbitControls(camera, this._canvas);
    this._orbit.enableDamping = true;
    this._orbit.dampingFactor = 0.07;
    this._orbit.target.set(0, 1, 0);

    // Explicitly disable pointer-lock and HUD in the Buildings tool.
    this._plock = null;
    try { this._hudOverlay?.parentNode?.removeChild(this._hudOverlay); } catch { /* ignore */ }
    this._hudOverlay = null;
    this._hudEls = { root: null, crosshair: null, topLeft: null, msg: null, hit: null };
    try { this._clearGun(); } catch { /* ignore */ }
    try { if (this._game) this._game.enabled = false; } catch { /* ignore */ }

    // Lights
    scene.add(new THREE.HemisphereLight(0xdde8ff, 0x171e2b, 0.9));
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(6, 10, 4);
    scene.add(dir);

    // Grid + axes (optional)
    this._grid = new THREE.GridHelper(80, 80, 0x3a4a64, 0x223046);
    this._grid.material.opacity = 0.6;
    this._grid.material.transparent = true;
    this._grid.visible = !!this._state.showGrid;
    scene.add(this._grid);
    scene.add(new THREE.AxesHelper(1.0));

    // Input: only what we need for selection + orbit.
    try {
      this._canvas.addEventListener('mousedown', this._handlers.mousedown);
      this._canvas.addEventListener('contextmenu', (e) => { try { e.preventDefault(); } catch { /* ignore */ } });
    } catch { /* ignore */ }

    this._buildUi();

    // Inbox: allow Scene tool to "send" buildings here without file IO.
    // If we load from inbox, do NOT immediately overwrite it by auto-loading the last opened asset.
    let inboxLoaded = false;
    try {
      const raw = String(localStorage.getItem('devtools.buildings.inboxJson') || '').trim();
      if (raw) {
        localStorage.removeItem('devtools.buildings.inboxJson');
        const obj = JSON.parse(raw);
        await this._loadBuildingsFromObject(obj, { clearFirst: true, label: 'inbox' });
        inboxLoaded = true;
      }
    } catch { /* ignore */ }

    // Auto-load last opened building, else load most recent saved asset.
    // (Skip if inbox was used this mount.)
    if (!inboxLoaded) {
      if (safeTrim(this._activeBuildingPath).endsWith('.json')) {
        try { await this._loadBuildingJson(this._activeBuildingPath, { clearFirst: true }); } catch { /* ignore */ }
      } else {
        try {
          const latest = await this._findLatestBuildingAsset();
          if (latest) await this._loadBuildingJson(latest, { clearFirst: true });
        } catch { /* ignore */ }
      }
    }

    // Build library list.
    try { await this._refreshBuildingLibrary(); } catch { /* ignore */ }
  }

  async unmount() {
    try { this._canvas?.removeEventListener?.('mousedown', this._handlers.mousedown); } catch { /* ignore */ }
    try { this._orbit?.dispose?.(); } catch { /* ignore */ }
    try { this._renderer?.dispose?.(); } catch { /* ignore */ }
    try { this._clearWorld(); } catch { /* ignore */ }

    this._orbit = null;
    this._renderer = null;
    this._scene = null;
    this._camera = null;
    this._ctx = null;
    this._root = null;

    if (this._canvas?.parentNode) this._canvas.parentNode.removeChild(this._canvas);
    this._canvas = null;
  }

  tick(dt) {
    if (!this._renderer || !this._scene || !this._camera || !this._canvas) return;
    const { dpr, w, h } = resizeCanvasToDisplaySize(this._canvas, 2.0);
    this._renderer.setPixelRatio(dpr);
    this._renderer.setSize(w / dpr, h / dpr, false);
    this._camera.aspect = Math.max(1e-6, w / Math.max(1e-6, h));
    this._camera.updateProjectionMatrix();

    this._orbit?.update?.();
    try { this._selectionBox?.update?.(); } catch { /* ignore */ }

    this._renderer.render(this._scene, this._camera);
  }

  _savePrefs() {
    // Tool-specific prefs, do not touch devtools.scene.*
    try { localStorage.setItem('devtools.buildings.activeBuildingPath', safeTrim(this._activeBuildingPath)); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.buildings.showGrid', this._state.showGrid ? '1' : '0'); } catch { /* ignore */ }
  }

  _ensureEmptyWorldRoot() {
    if (!this._scene) return null;
    if (this._worldRoot) return this._worldRoot;
    const root = new THREE.Group();
    root.name = 'buildings_root';
    this._scene.add(root);
    this._worldRoot = root;
    this._colliders = [root];
    this._obstacleBoxes = [];
    this._obstacleSources = [];
    return root;
  }

  async _findLatestBuildingAsset() {
    if (!this._ctx?.assetIndex) return '';
    const items = await this._ctx.assetIndex({ query: 'buildings/', ext: '.json' });
    const cand = (items || []).filter((it) => String(it?.path || '').startsWith('assets/buildings/'));
    cand.sort((a, b) => Number(b?.mtimeMs || 0) - Number(a?.mtimeMs || 0));
    return cand.length ? String(cand[0].path || '') : '';
  }

  async _refreshBuildingLibrary() {
    if (!this._ctx?.assetIndex) return;
    const items = await this._ctx.assetIndex({ query: 'buildings/', ext: '.json' });
    const cand = (items || []).filter((it) => String(it?.path || '').startsWith('assets/buildings/'));
    cand.sort((a, b) => Number(b?.mtimeMs || 0) - Number(a?.mtimeMs || 0));
    this._lib.items = cand.slice(0, 60);
    this._renderBuildingLibrary();
  }

  _renderBuildingLibrary() {
    const listEl = this._lib?.listEl;
    const statusEl = this._lib?.statusEl;
    if (!listEl) return;
    clear(listEl);
    const items = Array.isArray(this._lib.items) ? this._lib.items : [];
    if (statusEl) statusEl.textContent = items.length ? `Found ${items.length} buildings in assets/buildings/` : 'No building assets found yet.';
    if (!items.length) {
      listEl.appendChild(el('div', { class: 'muted' }, ['(none yet — save one from Scene → Buildings → Save selected → assets, or from this tool)']));
      return;
    }
    for (const it of items) {
      const p = String(it?.path || '');
      const file = p.split('/').pop() || p;
      listEl.appendChild(el('button', {
        class: 'toolBtn',
        style: { marginTop: '2px', padding: '4px 8px', fontSize: '11px', textAlign: 'left' },
        onclick: async () => {
          try {
            await this._loadBuildingJson(p, { clearFirst: true });
            this._activeBuildingPath = p;
            this._savePrefs();
          } catch (e) {
            this._setStatus(`Load failed: ${e?.message || e}`);
          }
        },
        title: p,
      }, [file]));
    }
  }

  async _loadBuildingJson(relPath, { clearFirst = true } = {}) {
    const p = safeTrim(relPath).replace(/\\/g, '/');
    if (!p) return;
    const resp = await fetch('/' + p.replace(/^\/+/, ''));
    const j = await resp.json().catch(() => null);
    if (!j) throw new Error('Invalid JSON');

    await this._loadBuildingsFromObject(j, { clearFirst, label: p });
    this._activeBuildingPath = p;
    this._savePrefs();
  }

  async _loadBuildingsFromObject(obj, { clearFirst = true, label = '' } = {}) {
    const j = obj;
    if (!j) return;
    if (clearFirst) this._clearWorld();
    const root = this._ensureEmptyWorldRoot();
    if (!root) return;

    // Accept a single-building JSON ({kind:'building', ...record}) or a list ({buildings:[...]}) or a raw array.
    const arr = Array.isArray(j?.buildings)
      ? j.buildings
      : ((safeTrim(j?.kind) === 'building' || safeTrim(j?.kind) === 'building_asset') ? [j] : (Array.isArray(j) ? j : []));
    for (const rec of arr) {
      const name = safeTrim(rec?.name) || 'building';
      const kind = safeTrim(rec?.building?.kind) || 'unknown';
      const t = rec?.transform || {};
      const pos = Array.isArray(t?.pos) ? t.pos : [0, 0, 0];
      const yawDeg = Number(t?.yawDeg) || 0;
      const scale = Number(t?.scale) || 1;

      const g = new THREE.Group();
      g.name = name;
      g.position.set(Number(pos[0]) || 0, Number(pos[1]) || 0, Number(pos[2]) || 0);
      g.rotation.y = yawDeg * Math.PI / 180;
      g.scale.set(scale, scale, scale);
      this._addProjectTag(g, 'buildings');
      g.userData = g.userData && typeof g.userData === 'object' ? g.userData : {};
      g.userData.building = (rec?.building && typeof rec.building === 'object') ? rec.building : { kind };
      g.userData.ai = (rec?.ai && typeof rec.ai === 'object') ? rec.ai : {};
      if (safeTrim(rec?.assetPath)) g.userData.buildingAssetPath = safeTrim(rec.assetPath);
      if (safeTrim(label).startsWith('assets/')) g.userData.buildingAssetPath = safeTrim(label);

      if (safeTrim(g.userData.building?.kind) === 'primitive_box') {
        const ww = Math.max(0.5, Number(g.userData.building?.w) || 10);
        const dd = Math.max(0.5, Number(g.userData.building?.d) || 10);
        const hh = Math.max(0.5, Number(g.userData.building?.h) || 6);
        const geo = new THREE.BoxGeometry(ww, hh, dd);
        const mat = new THREE.MeshStandardMaterial({ color: 0x6b8bbd, roughness: 0.82, metalness: 0.0 });
        const m = new THREE.Mesh(geo, mat);
        m.name = '__building_prim_box';
        m.position.set(0, hh * 0.5, 0);
        m.receiveShadow = true;
        m.userData = m.userData && typeof m.userData === 'object' ? m.userData : {};
        m.userData.isObstacle = true;
        g.add(m);
      } else if (safeTrim(g.userData.building?.kind) === 'proc:arena') {
        try { this._rebuildArenaBuilding(g); } catch { /* ignore */ }
      } else if (safeTrim(g.userData.building?.kind) === 'proc:penthouse_room_sim') {
        try { this._rebuildRoomSimPenthouseBuilding(g); } catch { /* ignore */ }
      }

      root.add(g);
    }

    this._scanTaggedBuildings();
    this._renderBuildingsUi();
    this._renderBuildingEditorUi();
    const lbl = safeTrim(label);
    this._setStatus(`Loaded ${arr.length} building(s): ${lbl || '(pasted)'}`);
  }

  // ───────────────── Buildings tool: hard-disable FPS demo hooks ─────────────────
  _buildHudOverlay() { /* no HUD in Buildings tool */ }
  _ensureGunRig() { /* no gun in Buildings tool */ }
  _spawnDefaultEnemies() { /* no gameplay */ }
  _spawnDefaultVehicles() { /* no gameplay */ }
  _buildNavGrid() { /* no gameplay pathing */ }

  async _loadProcedural(path, { scenario = null } = {}) {
    await super._loadProcedural(path, { scenario });
    // Ensure no FPS demo content lingers.
    try { if (this._game) this._game.enabled = false; } catch { /* ignore */ }
    try { this._clearGun(); } catch { /* ignore */ }
    this._state.mode = 'orbit';
    this._syncModeUi();
  }

  async _loadGlb(url, { scenario = null } = {}) {
    await super._loadGlb(url, { scenario });
    try { if (this._game) this._game.enabled = false; } catch { /* ignore */ }
    try { this._clearGun(); } catch { /* ignore */ }
    this._state.mode = 'orbit';
    this._syncModeUi();
  }

  _onMouseDown(e) {
    const btn = Number(e?.button ?? 0);
    // Buildings tool uses click-to-select, no pointer lock, no aiming.
    if (btn === 2) {
      try { e?.preventDefault?.(); } catch { /* ignore */ }
      return;
    }
    if (btn !== 0) return;
    if (this._state.mode === 'orbit') {
      try { this._pickSelectionFromEvent(e); } catch { /* ignore */ }
      try { e?.preventDefault?.(); } catch { /* ignore */ }
      return;
    }
  }

  _onMouseUp(e) {
    // no-op (avoid FPS input state)
    try { e?.preventDefault?.(); } catch { /* ignore */ }
  }

  _onKeyDown(e) {
    // Buildings tool does not use keyboard gameplay bindings.
    try { e?.preventDefault?.(); } catch { /* ignore */ }
  }

  _buildUi() {
    const host = this._root;
    if (!host) return;
    clear(host);

    const detailsCard = (title, { open = true, hint = '' } = {}, children = []) => el('details', { class: 'card', open: !!open }, [
      el('summary', {}, [
        el('div', { class: 'dockTitle' }, [String(title || 'Section')]),
        hint ? el('div', { class: 'muted', style: { marginLeft: 'auto', textAlign: 'right' } }, [String(hint)]) : el('div', {}),
      ]),
      el('div', { class: 'cardBody' }, children),
    ]);

    host.appendChild(el('div', { class: 'panelSubtitle' }, [
      'Buildings authoring tool. Click selects objects (Orbit). Tagged buildings use userData.projectTags=["buildings"].',
    ]));

    const clearBtn = el('button', {
      class: 'danger',
      onclick: () => {
        this._clearWorld();
        this._scanTaggedBuildings();
        this._renderBuildingsUi();
        this._renderBuildingEditorUi();
        this._setStatus('Cleared scene.');
        this._ctx?.toast?.('Cleared buildings', 'info');
      },
    }, ['Clear']);

    const statusEl = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
    this._ui.statusEl = statusEl;

    // --- Project buildings (JSON assets) ---
    const pasteCard = createJsonTextAreaCard({
      ctx: this._ctx,
      title: 'Paste / Import JSON',
      storageKey: 'devtools.buildings.pasteJson',
      placeholder: 'Paste building JSON (single record, array, or {buildings:[...]})',
      onApply: (j) => {
        this._loadBuildingsFromObject(j, { clearFirst: true, label: 'pasted' });
        this._scanTaggedBuildings();
        this._renderBuildingsUi();
        this._renderBuildingEditorUi();
      },
      applyLabel: 'Load JSON',
      copyLabel: 'Copy text',
    });

    const pasteBtn = el('button', {
      onclick: () => {
        try { pasteCard.open = true; } catch { /* ignore */ }
        try { pasteCard.scrollIntoView?.({ block: 'nearest' }); } catch { /* ignore */ }
      },
      title: 'Paste or import building JSON',
    }, ['Paste JSON…']);

    const saveSelBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try {
          this._scanTaggedBuildings();
          const items = Array.isArray(this._taggedBuildings) ? this._taggedBuildings : [];
          const uuid = safeTrim(this._buildingSel?.uuid || '');
          const o = items.find((x) => safeTrim(x?.uuid) === uuid) || null;
          if (!o) { this._setStatus('No building selected.'); return; }
          const j = await this._saveBuildingAssetToAssets({ obj: o, overwrite: true });
          this._activeBuildingPath = String(j?.relPath || '');
          this._savePrefs();
          try { await this._refreshBuildingLibrary(); } catch { /* ignore */ }
          const p = String(j?.relPath || '');
          this._setStatus(`Saved building → ${p}`);
          this._ctx?.toast?.(p ? `Saved: ${p.split('/').pop()}` : 'Saved building', 'success');
        } catch (e) {
          this._setStatus(`Save failed: ${e?.message || e}`);
          this._ctx?.toast?.(String(e?.message || e || 'Save failed'), 'error', { title: 'Save failed' });
        }
      },
      title: 'Saves/overwrites the selected building JSON asset (or creates a new one).',
    }, ['Save selected']);

    const saveAsBtn = el('button', {
      onclick: async () => {
        try {
          this._scanTaggedBuildings();
          const items = Array.isArray(this._taggedBuildings) ? this._taggedBuildings : [];
          const uuid = safeTrim(this._buildingSel?.uuid || '');
          const o = items.find((x) => safeTrim(x?.uuid) === uuid) || null;
          if (!o) { this._setStatus('No building selected.'); return; }
          const j = await this._saveBuildingAssetToAssets({ obj: o, overwrite: false });
          this._activeBuildingPath = String(j?.relPath || '');
          this._savePrefs();
          try { await this._refreshBuildingLibrary(); } catch { /* ignore */ }
          const p = String(j?.relPath || '');
          this._setStatus(`Saved as → ${p}`);
          this._ctx?.toast?.(p ? `Saved as: ${p.split('/').pop()}` : 'Saved as', 'success');
        } catch (e) {
          this._setStatus(`Save-as failed: ${e?.message || e}`);
          this._ctx?.toast?.(String(e?.message || e || 'Save-as failed'), 'error', { title: 'Save-as failed' });
        }
      },
      title: 'Always creates a new JSON under assets/buildings/.',
    }, ['Save as']);

    const saveAllBtn = el('button', {
      onclick: async () => {
        try {
          const out = await this._saveAllBuildingsAsAssets({ overwriteExisting: true });
          try { await this._refreshBuildingLibrary(); } catch { /* ignore */ }
          const n = Number(out?.count || 0) || 0;
          this._setStatus(`Saved ${n} building assets.`);
          this._ctx?.toast?.(`Saved ${n} buildings`, 'success');
        } catch (e) {
          this._setStatus(`Save-all failed: ${e?.message || e}`);
          this._ctx?.toast?.(String(e?.message || e || 'Save-all failed'), 'error', { title: 'Save-all failed' });
        }
      },
      title: 'Saves all tagged buildings as individual JSON assets under assets/buildings/.',
    }, ['Save all']);

    const refreshLibBtn = el('button', {
      onclick: async () => {
        await this._refreshBuildingLibrary();
        this._setStatus('Refreshed building library.');
        this._ctx?.toast?.('Library refreshed', 'info');
      },
    }, ['Refresh library']);

    host.appendChild(createAssetPicker({
      ctx: this._ctx,
      title: 'Load building (JSON asset)',
      ext: '.json',
      placeholder: 'Search assets (e.g. buildings)…',
      open: true,
      onPick: async (p) => {
        try {
          await this._loadBuildingJson(p, { clearFirst: true });
          this._ctx?.toast?.(`Loaded: ${String(p).split('/').pop()}`, 'success');
        } catch (e) {
          this._setStatus(`Load failed: ${e?.message || e}`);
          this._ctx?.toast?.(String(e?.message || e || 'Load failed'), 'error', { title: 'Load failed' });
        }
      },
    }));

    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Project buildings (assets)']),
      el('div', { class: 'muted', style: { marginTop: '4px', fontSize: '10px', whiteSpace: 'pre-line' } }, [
        `Last opened: ${safeTrim(this._activeBuildingPath) || '(none)'}\nTip: tagged building roots are discovered via projectTags=[buildings] or name prefix blg_*.`,
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
        saveSelBtn,
        saveAsBtn,
        saveAllBtn,
        clearBtn,
        pasteBtn,
        refreshLibBtn,
        el('div', { style: { flex: '1' } }),
      ]),
      pasteCard,
      statusEl,
      el('div', { class: 'muted', style: { marginTop: '8px', fontSize: '10px' } }, [
        'Library (most recent):',
      ]),
      (this._lib.statusEl = el('div', { class: 'muted', style: { marginTop: '4px', fontSize: '10px' } }, [''])),
      (this._lib.listEl = el('div', { class: 'scrollArea', style: { height: '120px', marginTop: '6px' } }, ['(loading…)'])),
    ]));

    // --- Scene buildings (from Scene tool) ---
    const sceneItems = Array.isArray(this._sceneBuildings?.items) ? this._sceneBuildings.items : [];
    const sceneTime = safeTrim(this._sceneBuildings?.time || '');
    const sceneCount = sceneItems.length;
    const sceneStatus = sceneTime ? `Last sync: ${sceneTime}\nCount: ${sceneCount}` : `Count: ${sceneCount} (open Scene tool and click “Open Buildings tool” to sync)`;

    const sceneFilterInput = el('input', {
      value: String(localStorage.getItem('devtools.buildings.sceneFilter') || ''),
      placeholder: 'filter (e.g. blg_alpha)…',
      oninput: (e) => {
        try { localStorage.setItem('devtools.buildings.sceneFilter', String(e.target.value || '')); } catch { /* ignore */ }
        this._renderSceneBuildingsList();
      },
    });
    this._ui.sceneBuildingsFilterInput = sceneFilterInput;
    this._ui.sceneBuildingsListEl = el('div', { class: 'scrollArea', style: { height: '140px', marginTop: '6px' } }, ['(no scene buildings synced)']);

    const loadSelectedBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        const uuid = safeTrim(this._sceneBuildings?.selectedUuid || '');
        if (!uuid) { this._setStatus('No scene building selected.'); return; }
        const rec = sceneItems.find((x) => safeTrim(x?.uuid) === uuid) || null;
        if (!rec) { this._setStatus('Selected scene building not found in synced list.'); return; }
        try {
          await this._loadBuildingsFromObject([rec], { clearFirst: true, label: 'scene:selected' });
          this._setStatus(`Loaded building: ${safeTrim(rec?.name) || uuid}`);
        } catch (e) {
          this._setStatus(`Load selected failed: ${e?.message || e}`);
        }
      },
      title: 'Loads just the selected scene building into this tool (one at a time).',
    }, ['Load selected']);

    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Scene buildings (one-at-a-time)']),
      el('div', { class: 'muted', style: { marginTop: '4px', fontSize: '10px', whiteSpace: 'pre-line' } }, [sceneStatus]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
        loadSelectedBtn,
        el('div', { style: { flex: '1 1 220px' } }, [el('div', { class: 'fieldLabel' }, ['Filter']), sceneFilterInput]),
      ]),
      this._ui.sceneBuildingsListEl,
    ]));

    // (Status is shown inside the card above.)

    // --- Buildings (project tagged) ---
    const buildingFilterInput = el('input', {
      value: String(localStorage.getItem('devtools.buildings.taggedFilter') || (this._buildings?.filter || '')),
      placeholder: 'filter buildings…',
      oninput: (e) => {
        this._buildings.filter = String(e.target?.value || '');
        try { localStorage.setItem('devtools.buildings.taggedFilter', this._buildings.filter); } catch { /* ignore */ }
        this._renderBuildingsUi();
      },
      title: 'Matches by object name/uuid',
    });
    this._ui.buildingFilterInput = buildingFilterInput;

    const selectionInfoEl = el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-line', fontSize: '10px' } }, ['']);
    this._ui.selectionInfoEl = selectionInfoEl;

    const buildingsHost = el('div', { class: 'scrollArea', style: { height: '180px', marginTop: '8px' } }, ['(no tagged buildings)']);
    const buildingEditorHost = el('div', { style: { marginTop: '8px' } }, ['']);
    this._ui.buildingsHost = buildingsHost;
    this._ui.buildingEditorHost = buildingEditorHost;

    const scanBtn = el('button', {
      onclick: () => {
        this._scanTaggedBuildings();
        this._renderBuildingsUi();
        this._renderBuildingEditorUi();
        this._setStatus('Scanned tagged buildings.');
      },
      title: 'Re-scan the scene for objects tagged projectTags=["buildings"]',
    }, ['Scan']);

    const createPrimBtn = el('button', {
      class: 'primary',
      onclick: () => {
        this._createPrimitiveBuildingAtPlayer({ name: 'building', w: 14, d: 12, h: 7 });
        this._setStatus('Created primitive building at player.');
      },
      title: 'Creates a new tagged building (primitive box) at the player position.',
    }, ['Create building (primitive)']);

    const tagSelBtn = el('button', {
      onclick: () => {
        const o = this._selection?.obj || null;
        if (!o) { this._setStatus('No selection. Click an object in the viewport to select it.'); return; }
        this._addProjectTag(o, 'buildings');
        this._scanTaggedBuildings();
        this._buildingSel.uuid = o.uuid;
        this._renderBuildingsUi();
        this._renderBuildingEditorUi();
        this._setStatus(`Tagged as building: ${safeTrim(o?.name) || o?.uuid || '(unnamed)'}`);
      },
      title: 'Tags the currently selected object as a building.',
    }, ['Tag selection as building']);

    const copyAllBtn = el('button', {
      onclick: async () => {
        this._scanTaggedBuildings();
        const items = Array.isArray(this._taggedBuildings) ? this._taggedBuildings : [];
        const payload = items.map((o) => ({
          uuid: o?.uuid || '',
          name: safeTrim(o?.name),
          tags: this._getProjectTags(o),
          transform: {
            pos: [Number(o.position.x) || 0, Number(o.position.y) || 0, Number(o.position.z) || 0],
            yawDeg: Number(o.rotation.y) * 180 / Math.PI,
            scale: Number(o.scale.x) || 1,
          },
          building: o?.userData?.building || {},
          ai: o?.userData?.ai || {},
        }));
        try { await navigator.clipboard.writeText(JSON.stringify(payload, null, 2)); } catch { /* ignore */ }
        this._setStatus(`Copied ${payload.length} buildings JSON to clipboard.`);
      },
      title: 'Copies an array of all tagged buildings to clipboard',
    }, ['Copy all JSON']);

    host.appendChild(detailsCard('Buildings', { open: true, hint: 'projectTags: buildings' }, [
      el('div', { class: 'row', style: { marginTop: '6px', gap: '8px', flexWrap: 'wrap' } }, [
        scanBtn,
        createPrimBtn,
        tagSelBtn,
        copyAllBtn,
        el('div', { style: { flex: '1' } }),
        el('div', { style: { flex: '1 1 220px' } }, [el('div', { class: 'fieldLabel' }, ['Filter']), buildingFilterInput]),
      ]),
      selectionInfoEl,
      buildingsHost,
      buildingEditorHost,
    ]));

    // Initial render
    this._syncModeUi();
    this._scanTaggedBuildings();
    this._renderBuildingsUi();
    this._renderBuildingEditorUi();
    this._renderSceneBuildingsList();
  }

  _renderSceneBuildingsList() {
    const listEl = this._ui?.sceneBuildingsListEl;
    const filterEl = this._ui?.sceneBuildingsFilterInput;
    if (!listEl) return;
    clear(listEl);
    const items = Array.isArray(this._sceneBuildings?.items) ? this._sceneBuildings.items : [];
    const q = safeTrim(filterEl?.value || '').toLowerCase();
    const shown = items.filter((r) => {
      if (!q) return true;
      const nm = safeTrim(r?.name).toLowerCase();
      const id = safeTrim(r?.uuid).toLowerCase();
      return nm.includes(q) || id.includes(q);
    });
    if (!shown.length) {
      listEl.appendChild(el('div', { class: 'muted' }, [items.length ? '(no matches)' : '(no scene buildings synced)']));
      return;
    }
    for (const r of shown.slice(0, 200)) {
      const nm = safeTrim(r?.name) || '(unnamed)';
      const uuid = safeTrim(r?.uuid);
      const isSel = uuid && uuid === safeTrim(this._sceneBuildings?.selectedUuid || '');
      listEl.appendChild(el('button', {
        class: isSel ? 'toolBtn primary' : 'toolBtn',
        style: { marginTop: '2px', padding: '4px 8px', fontSize: '11px', textAlign: 'left' },
        onclick: () => {
          this._sceneBuildings.selectedUuid = uuid;
          try { localStorage.setItem('devtools.buildings.sceneBuildingsSelectedUuid', uuid); } catch { /* ignore */ }
          this._renderSceneBuildingsList();
        },
        title: uuid ? `${nm}\n${uuid}` : nm,
      }, [nm]));
    }
  }
}

