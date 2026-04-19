import { el, clear, clamp } from '../../ui/dom.js';
import { getGl } from '../../runtime/gl.js';
import { Camera } from '../../runtime/camera.js';
import { TerrainRenderer } from '../../runtime/terrain_renderer.js';
import { WaterRenderer } from '../../runtime/water_renderer.js';
import { WaterMeshRenderer } from '../../runtime/water_mesh_renderer.js';
import { LinesRenderer } from '../../runtime/lines_renderer.js';
import { InstancedBoxRenderer } from '../../runtime/instanced_box_renderer.js';
import { ExtrudedBuildingsRenderer, buildExtrudedBuildingsMesh } from '../../runtime/extruded_buildings_renderer.js';
import { InstancedTilesStreamer } from '../../runtime/instanced_tiles_streamer.js';
import { InstancedBoxTilesRenderer } from '../../runtime/instanced_box_tiles_renderer.js';
import { loadHeightmapU16 } from '../../runtime/heightmap_loader.js';
import {
  loadDatasetManifest,
  resolveDatasetBundle,
  loadWgs84RoadsGeoJson,
  loadWgs84BuildingsGeoJson,
  loadWgs84BuildingFootprintsGeoJson,
  loadWgs84TreesGeoJson,
  loadWgs84PropsGeoJson,
  loadWgs84WaterGeoJson,
  loadWgs84RailsGeoJson,
  loadWgs84BarriersGeoJson,
  loadWgs84PowerLinesGeoJson,
} from '../../runtime/osm_loader.js';
import { createProgressBar, createAssetPicker, createJobRunner } from '../components/ui_components.js';
import { generateAiCity, generateAiCityWfc } from '../../runtime/procedural_ai_city.js';

/* ═══════════════════════════════════════════════════════════
 *  Helpers
 * ═══════════════════════════════════════════════════════════ */

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

function bytesToMiB(n) {
  const b = Number(n) || 0;
  return (b / (1024 * 1024)).toFixed(2);
}

function formatNum(n) {
  const v = Number(n) || 0;
  if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return String(v);
}

function aabbUnion(a, b) {
  if (!a) return b ? { min: [...b.min], max: [...b.max] } : null;
  if (!b) return a;
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

function boundsToAabb(bounds) {
  if (!bounds?.min || !bounds?.max) return null;
  const min = bounds.min.map((v) => Number(v) || 0);
  const max = bounds.max.map((v) => Number(v) || 0);
  return { min, max };
}

function projectLonLatMeters(lon, lat, originLon, originLat) {
  const R = 6378137.0;
  const lam = (Number(lon) || 0) * Math.PI / 180;
  const phi = (Number(lat) || 0) * Math.PI / 180;
  const lam0 = (Number(originLon) || 0) * Math.PI / 180;
  const phi0 = (Number(originLat) || 0) * Math.PI / 180;
  const x = (lam - lam0) * Math.cos(phi0) * R;
  const y = (phi - phi0) * R;
  return [x, y];
}

function terrainBoundsFromBbox(bbox, originLonLat = null) {
  const minLon = Number(bbox?.minLon);
  const minLat = Number(bbox?.minLat);
  const maxLon = Number(bbox?.maxLon);
  const maxLat = Number(bbox?.maxLat);
  if (!Number.isFinite(minLon) || !Number.isFinite(minLat) || !Number.isFinite(maxLon) || !Number.isFinite(maxLat)) return null;

  const oLon = Number(originLonLat?.[0]);
  const oLat = Number(originLonLat?.[1]);
  const originLon = Number.isFinite(oLon) ? oLon : (minLon + maxLon) * 0.5;
  const originLat = Number.isFinite(oLat) ? oLat : (minLat + maxLat) * 0.5;

  const [x0, z0] = projectLonLatMeters(minLon, minLat, originLon, originLat);
  const [x1, z1] = projectLonLatMeters(maxLon, maxLat, originLon, originLat);
  return {
    minX: Math.min(x0, x1),
    maxX: Math.max(x0, x1),
    minZPlane: Math.min(z0, z1),
    maxZPlane: Math.max(z0, z1),
    originLonLat: [originLon, originLat],
  };
}

/* ═══════════════════════════════════════════════════════════
 *  City Presets — notable real-world locations
 * ═══════════════════════════════════════════════════════════ */

const CITY_PRESETS = [
  { name: 'Richmond, VA',       region: 'USA',   lon: -77.436,  lat: 37.541,  sizeM: 2400, badge: '' },
  { name: 'Hampton Roads',      region: 'USA',   lon: -76.30,   lat: 36.85,   sizeM: 3200, badge: 'metro' },
  { name: 'Manhattan, NYC',     region: 'USA',   lon: -73.985,  lat: 40.748,  sizeM: 2000, badge: 'dense' },
  { name: 'San Francisco',      region: 'USA',   lon: -122.419, lat: 37.775,  sizeM: 2400, badge: '' },
  { name: 'Chicago Loop',       region: 'USA',   lon: -87.630,  lat: 41.882,  sizeM: 2000, badge: '' },
  { name: 'London, UK',         region: 'Europe', lon: -0.118,  lat: 51.509,  sizeM: 2400, badge: '' },
  { name: 'Tokyo, Japan',       region: 'Asia',  lon: 139.692,  lat: 35.690,  sizeM: 2400, badge: 'dense' },
  { name: 'Paris, France',      region: 'Europe', lon: 2.349,   lat: 48.864,  sizeM: 2000, badge: '' },
  { name: 'Sydney, Australia',  region: 'Oceania', lon: 151.209, lat: -33.868, sizeM: 2400, badge: '' },
  { name: 'Dubai, UAE',         region: 'Middle East', lon: 55.274, lat: 25.197, sizeM: 3000, badge: '' },
  { name: 'Singapore',          region: 'Asia',  lon: 103.851,  lat: 1.290,   sizeM: 2400, badge: '' },
  { name: 'Berlin, Germany',    region: 'Europe', lon: 13.405,  lat: 52.520,  sizeM: 2400, badge: '' },
];

/* ═══════════════════════════════════════════════════════════
 *  DatasetTool
 * ═══════════════════════════════════════════════════════════ */

export class DatasetTool {
  constructor() {
    this.id = 'datasets';
    this.label = 'Datasets / City';

    this._ctx = null;
    this._root = null;

    this._canvas = null;
    this._gl = null;
    this._camera = null;

    this._terrain = null;
    this._waterPlane = null;
    this._waterMesh = null;
    this._shoreline = null;
    this._powerLines = null;

    this._roads = null;
    this._rails = null;
    this._barriers = null;
    this._trees = null;
    this._props = null;
    this._buildingsBoxes = null;
    this._buildingsExtruded = null;

    this._tilesStreamer = null;
    this._tilesBuildings = null;

    this._manifest = null;
    this._manifestPromise = null;
    this._originLonLat = null;
    this._hmZ = null;
    this._hmSample = null;

    this._loaded = {
      datasetId: '',
      label: '',
      entries: [],
      aabb: null,
      stats: {},
    };

    this._state = {
      manifestUrl: 'assets/datasets/manifest.json',
      datasetId: '',

      // City generation
      cityRunner: 'python3',
      cityId: 'my_city',
      originLon: -76.30,
      originLat: 36.85,
      sizeM: 2400,
      grid: 256,
      maxBuildings: 12000,
      maxTrees: 25000,
      maxProps: 12000,
      tileBuildings: 0,
      tileChunkM: 512,
      updateManifest: 1,
      manifestPath: 'assets/datasets/manifest.json',
      heightmapMeshPath: '',
      heightmapGrid: 256,
      blenderPath: '',
      heightmapArgs: '',
      cityJobAutoLoad: 1,

      // AI City (procedural, client-side)
      aiCitySeed: 'ai_city',
      aiCityGridW: 100,
      aiCityGridH: 100,
      aiCityMode: 'standard', // 'standard' | 'wfc'
      aiCitySizeM: 100,

      // Layer toggles
      showTerrain: true,
      showWater: true,
      showRoads: true,
      showBuildings: true,
      buildingsMode: 'extruded',
      showTrees: true,
      showProps: true,
      showRails: false,
      showBarriers: false,
      showPowerLines: false,

      // Tiles streaming
      tilesRadiusChunks: 8,
      tilesLoadAll: false,
      tilesCull: true,

      // Visuals
      fogEnabled: true,
      fogStart: 2200,
      fogEnd: 8500,
      buildingsFacade: 1.0,
      waterLevelY: 0.0,
      waterPlaneEnabled: false,
    };

    this._activeTab = 'browse';
    this._cityJob = { id: '', status: '', stdout: '', stderr: '', outDir: '', datasetId: '' };
    this._pollingCity = false;
    this._isLoading = false;
  }

  /* ═══════════════════════════════════════════════
   *  Lifecycle
   * ═══════════════════════════════════════════════ */

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

    // Renderers
    this._terrain = new TerrainRenderer(this._gl);
    await this._terrain.init(128, 128);
    // Ensure terrain is visible even when a dataset is missing a heightmap (or it fails to load).
    // TerrainRenderer only builds a mesh after both height + mask are uploaded.
    try {
      const w = 128, h = 128;
      this._terrain.uploadHeightU16(w, h, new Uint16Array(w * h));    // flat
      this._terrain.uploadMaskRgba(w, h, new Uint8Array(w * h * 4));  // default grass
      this._terrain.setBounds({ minX: -500, minY: -500, minZ: 0, maxX: 500, maxY: 500, maxZ: 40 });
      this._terrain.setHeightScale(1.0);
    } catch { /* ignore */ }
    this._waterPlane = new WaterRenderer(this._gl);
    await this._waterPlane.init();
    this._waterMesh = new WaterMeshRenderer(this._gl);
    await this._waterMesh.init();
    this._shoreline = new LinesRenderer(this._gl);
    await this._shoreline.init();
    this._powerLines = new LinesRenderer(this._gl);
    await this._powerLines.init();

    this._roads = new InstancedBoxRenderer(this._gl);
    await this._roads.init();
    this._rails = new InstancedBoxRenderer(this._gl);
    await this._rails.init();
    this._barriers = new InstancedBoxRenderer(this._gl);
    await this._barriers.init();
    this._trees = new InstancedBoxRenderer(this._gl);
    await this._trees.init();
    this._props = new InstancedBoxRenderer(this._gl);
    await this._props.init();
    this._buildingsBoxes = new InstancedBoxRenderer(this._gl);
    await this._buildingsBoxes.init();

    this._buildingsExtruded = new ExtrudedBuildingsRenderer(this._gl);
    await this._buildingsExtruded.init();

    this._tilesStreamer = new InstancedTilesStreamer();
    this._tilesBuildings = new InstancedBoxTilesRenderer(this._gl);
    await this._tilesBuildings.init();
    this._tilesStreamer.onWantedChunks = (chunks, total) => {
      try { this._tilesBuildings.setChunks(chunks); } catch { /* ignore */ }
      this._loaded.stats.tilesInstances = total | 0;
      this._loaded.stats.tilesChunks = (chunks?.length || 0) | 0;
    };

    this._buildUi();

    // Load manifest + auto-select.
    try {
      await this._loadManifest();
      if (!this._state.datasetId && Array.isArray(this._manifest) && this._manifest.length) {
        const firstBundle = this._manifest.find((d) => d?.kind === 'bundle') || this._manifest[0];
        this._state.datasetId = String(firstBundle?.id || '');
        this._syncDatasetSelect?.();
      }
      if (this._state.datasetId) await this._loadDataset(this._state.datasetId);
    } catch (e) {
      ctx.log(`Datasets: init error: ${e?.message || e}`);
    }
  }

  async unmount() {
    this._pollingCity = false;
    try { this._tilesStreamer?.dispose?.(); } catch { /* ignore */ }
    this._tilesStreamer = null;
    try { this._terrain?.dispose?.(); } catch { /* ignore */ }
    try { this._waterPlane?.dispose?.(); } catch { /* ignore */ }
    try { this._waterMesh?.dispose?.(); } catch { /* ignore */ }
    try { this._shoreline?.dispose?.(); } catch { /* ignore */ }
    try { this._powerLines?.dispose?.(); } catch { /* ignore */ }

    const rs = [
      this._roads, this._rails, this._barriers, this._trees, this._props, this._buildingsBoxes,
      this._buildingsExtruded, this._tilesBuildings,
    ];
    for (const r of rs) {
      try { r?.dispose?.(); } catch { /* ignore */ }
    }

    this._terrain = null;
    this._waterPlane = null;
    this._waterMesh = null;
    this._shoreline = null;
    this._powerLines = null;
    this._roads = null;
    this._rails = null;
    this._barriers = null;
    this._trees = null;
    this._props = null;
    this._buildingsBoxes = null;
    this._buildingsExtruded = null;
    this._tilesBuildings = null;

    this._camera = null;
    this._gl = null;

    if (this._canvas?.parentNode) this._canvas.parentNode.removeChild(this._canvas);
    this._canvas = null;
    this._ctx = null;
    this._root = null;
  }

  getStats() {
    const s = this._loaded?.stats || {};
    return {
      dataset: this._loaded?.datasetId || '',
      origin: this._originLonLat ? `${this._originLonLat[0].toFixed(4)}, ${this._originLonLat[1].toFixed(4)}` : '',
      roads: s.roadSegments || 0,
      buildings: s.buildingCount || 0,
      trees: s.treeCount || 0,
      props: s.propCount || 0,
      waterPolys: s.waterPolygons || 0,
      tilesChunks: s.tilesChunks || 0,
      tilesInstances: s.tilesInstances || 0,
    };
  }

  /* ═══════════════════════════════════════════════
   *  Render loop
   * ═══════════════════════════════════════════════ */

  tick(dt, absTimeSec) {
    if (!this._gl || !this._canvas || !this._camera) return;

    resizeCanvasToDisplaySize(this._canvas, 2.0);
    const gl = this._gl;
    gl.viewport(0, 0, this._canvas.width, this._canvas.height);
    this._camera.setAspect(this._canvas.width, this._canvas.height);
    this._camera.tick(dt);

    // Update tiles streamer.
    if (this._tilesStreamer?.ready) {
      this._tilesStreamer.radiusChunks = Math.max(1, this._state.tilesRadiusChunks | 0);
      this._tilesStreamer.loadAllChunks = !!this._state.tilesLoadAll;
      this._tilesStreamer.update(this._camera);
    }

    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.clearColor(0.04, 0.05, 0.07, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (this._state.showTerrain) this._terrain?.render?.(this._camera.viewProj);

    if (this._state.showWater) {
      if (this._waterMesh) {
        this._waterMesh.opacity = 0.72;
        this._waterMesh.render(this._camera.viewProj);
      }
      if (this._shoreline) {
        this._shoreline.render(this._camera.viewProj, { color: [0.78, 0.92, 1.00, 0.35], depthTest: false });
      }
    }

    if (this._state.showRoads) this._roads?.render?.(this._camera.viewProj, { facade: 0.0 });
    if (this._state.showRails) this._rails?.render?.(this._camera.viewProj, { facade: 0.0 });
    if (this._state.showBarriers) this._barriers?.render?.(this._camera.viewProj, { facade: 0.0 });

    if (this._state.showBuildings) {
      if (this._state.buildingsMode === 'extruded') {
        this._buildingsExtruded?.render?.(this._camera.viewProj);
      } else if (this._state.buildingsMode === 'boxes') {
        this._buildingsBoxes?.render?.(this._camera.viewProj, { facade: clamp(this._state.buildingsFacade, 0.0, 1.0) });
      } else if (this._state.buildingsMode === 'tiles') {
        const fog = this._state.fogEnabled
          ? {
            cameraPos: this._camera.position,
            color: [0.70, 0.78, 0.90],
            start: Number(this._state.fogStart) || 2200,
            end: Number(this._state.fogEnd) || 8500,
          }
          : { cameraPos: this._camera.position, color: [0.0, 0.0, 0.0], start: 999999, end: 999999 };
        const fade = { cameraX: this._camera.position[0], cameraZ: this._camera.position[2] };
        const cull = { enabled: !!this._state.tilesCull };
        this._tilesBuildings?.render?.(this._camera.viewProj, { fog, fade, cull });
      }
    }

    if (this._state.showTrees) this._trees?.render?.(this._camera.viewProj, { facade: 0.0 });
    if (this._state.showProps) this._props?.render?.(this._camera.viewProj, { facade: 0.0 });

    if (this._state.showPowerLines) {
      this._powerLines?.render?.(this._camera.viewProj, { color: [0.92, 0.92, 0.96, 0.35], depthTest: false });
    }

    if (this._state.waterPlaneEnabled && this._waterPlane) {
      this._waterPlane.levelY = Number(this._state.waterLevelY) || 0.0;
      this._waterPlane.opacity = 0.35;
      const minX = this._terrain.boundsMin[0];
      const minZ = this._terrain.boundsMin[1];
      const maxX = minX + this._terrain.boundsSize[0];
      const maxZ = minZ + this._terrain.boundsSize[1];
      this._waterPlane._minX = minX; this._waterPlane._maxX = maxX;
      this._waterPlane._minZ = minZ; this._waterPlane._maxZ = maxZ;
      this._waterPlane._rebuildPlane?.();
      this._waterPlane.render(this._camera.viewProj, { timeSec: Number(absTimeSec) || 0 });
    }
  }

  /* ═══════════════════════════════════════════════
   *  UI — Main build
   * ═══════════════════════════════════════════════ */

  _buildUi() {
    if (!this._root) return;
    clear(this._root);

    // ── Tabs ──
    const tabs = [
      { id: 'browse',   label: 'Browse',   icon: '▤' },
      { id: 'generate', label: 'Generate', icon: '◆' },
      { id: 'settings', label: 'Settings', icon: '⚙' },
    ];

    const tabBar = el('div', { class: 'tabBar' });
    const pages = {};

    for (const tab of tabs) {
      const btn = el('button', {
        class: `tabBtn${tab.id === this._activeTab ? ' active' : ''}`,
        onclick: () => this._switchTab(tab.id, tabBar, pages),
      }, [
        el('span', { class: 'tabIcon' }, [tab.icon]),
        tab.label,
      ]);
      btn.dataset.tabId = tab.id;
      tabBar.appendChild(btn);

      const page = el('div', { class: `tabPage${tab.id === this._activeTab ? ' active' : ''}` });
      page.dataset.tabId = tab.id;
      pages[tab.id] = page;
    }

    this._root.appendChild(tabBar);
    for (const page of Object.values(pages)) {
      this._root.appendChild(page);
    }

    // Build tab content
    this._buildBrowseTab(pages.browse);
    this._buildGenerateTab(pages.generate);
    this._buildSettingsTab(pages.settings);

    // Fill dataset select once manifest available
    void this._loadManifest().then(() => this._fillDatasetSelect()).catch(() => {});
  }

  _switchTab(tabId, tabBar, pages) {
    this._activeTab = tabId;
    for (const btn of tabBar.children) {
      btn.classList.toggle('active', btn.dataset.tabId === tabId);
    }
    for (const [id, page] of Object.entries(pages)) {
      page.classList.toggle('active', id === tabId);
    }
  }

  /* ═══════════════════════════════════════════════
   *  Tab: Browse
   * ═══════════════════════════════════════════════ */

  _buildBrowseTab(page) {
    const st = this._state;

    // ── Dataset selector ──
    const datasetSel = el('select', {
      value: st.datasetId,
      onchange: (e) => { st.datasetId = String(e.target.value || ''); },
    }, [el('option', { value: '' }, ['Select a dataset\u2026'])]);
    this._datasetSelectEl = datasetSel;
    this._syncDatasetSelect = () => { try { datasetSel.value = String(st.datasetId || ''); } catch { /* ignore */ } };

    const loadProgress = createProgressBar();
    this._loadProgress = loadProgress;

    const loadBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        if (!st.datasetId) {
          this._ctx?.toast?.('Please select a dataset first', 'warning');
          return;
        }
        try { await this._loadDataset(st.datasetId); }
        catch (e) { this._ctx?.log?.(`Datasets: load failed: ${e?.message || e}`); }
      },
    }, ['Load']);

    const reloadManifestBtn = el('button', {
      onclick: async () => {
        this._manifest = null;
        this._manifestPromise = null;
        try {
          await this._loadManifest();
          this._fillDatasetSelect();
          this._ctx?.toast?.('Manifest reloaded', 'success');
        } catch (e) {
          this._ctx?.log?.(`Datasets: manifest load failed: ${e?.message || e}`);
          this._ctx?.toast?.('Manifest load failed', 'error');
        }
      },
      title: 'Reload manifest from disk',
    }, ['↻']);

    page.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Dataset']),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [datasetSel, loadBtn, reloadManifestBtn]),
      loadProgress.element,
    ]));

    // ── Stats dashboard ──
    this._statsContainer = el('div', { style: { display: 'none' } });
    page.appendChild(this._statsContainer);

    // ── Layers ──
    this._layerCountEls = {};
    const layerToggle = (key, label, countKey) => {
      const countEl = el('span', { class: 'layerCount' }, ['']);
      if (countKey) this._layerCountEls[countKey] = countEl;
      return el('label', { class: 'layerToggle' }, [
        el('input', {
          type: 'checkbox',
          checked: !!st[key],
          onchange: (e) => { st[key] = !!e.target.checked; },
        }),
        el('span', { class: 'layerName' }, [label]),
        countEl,
      ]);
    };

    const buildingsMode = el('select', {
      value: st.buildingsMode,
      style: { marginLeft: '8px', flex: '0 0 auto', width: 'auto' },
      onchange: (e) => { st.buildingsMode = String(e.target.value || 'extruded'); },
    }, [
      el('option', { value: 'extruded' }, ['Extruded']),
      el('option', { value: 'boxes' }, ['Boxes']),
      el('option', { value: 'tiles' }, ['Tiles (LOD)']),
    ]);

    const buildingsRow = el('div', { style: { display: 'flex', alignItems: 'center' } }, [
      layerToggle('showBuildings', 'Buildings', 'buildingCount'),
      buildingsMode,
    ]);

    page.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Layers']),
      el('div', { style: { marginTop: '4px' } }, [
        layerToggle('showTerrain', 'Terrain', 'heightmap'),
        layerToggle('showWater', 'Water', 'waterPolygons'),
        layerToggle('showRoads', 'Roads', 'roadSegments'),
        buildingsRow,
        layerToggle('showTrees', 'Trees', 'treeCount'),
        layerToggle('showProps', 'Props', 'propCount'),
        layerToggle('showRails', 'Rails', 'railSegments'),
        layerToggle('showBarriers', 'Barriers', 'barrierSegments'),
        layerToggle('showPowerLines', 'Power lines', 'powerSegments'),
      ]),
    ]));
  }

  _updateStatsDashboard() {
    const container = this._statsContainer;
    if (!container) return;

    const s = this._loaded?.stats || {};
    const hasData = this._loaded?.datasetId;

    if (!hasData) {
      container.style.display = 'none';
      return;
    }

    container.style.display = 'block';
    clear(container);

    const stats = [
      { label: 'Buildings', value: formatNum(s.buildingCount || 0), show: (s.buildingCount || 0) > 0 },
      { label: 'Roads', value: formatNum(s.roadSegments || 0), show: (s.roadSegments || 0) > 0 },
      { label: 'Trees', value: formatNum(s.treeCount || 0), show: (s.treeCount || 0) > 0 },
      { label: 'Props', value: formatNum(s.propCount || 0), show: (s.propCount || 0) > 0 },
      { label: 'Water', value: formatNum(s.waterPolygons || 0), show: (s.waterPolygons || 0) > 0 },
      { label: 'Heightmap', value: s.heightmap || '—', show: !!s.heightmap },
      { label: 'Tiles', value: `${formatNum(s.tilesInstances || 0)}`, show: (s.tilesInstances || 0) > 0 },
    ].filter((x) => x.show);

    if (stats.length === 0) return;

    const grid = el('div', { class: 'statGrid' });
    for (const stat of stats) {
      grid.appendChild(el('div', { class: 'statCard' }, [
        el('div', { class: 'statValue' }, [stat.value]),
        el('div', { class: 'statLabel' }, [stat.label]),
      ]));
    }

    const originStr = this._originLonLat
      ? `${this._originLonLat[0].toFixed(4)}, ${this._originLonLat[1].toFixed(4)}`
      : '';

    container.appendChild(el('div', { class: 'card' }, [
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
        el('div', { class: 'dockTitle' }, [this._loaded?.label || this._loaded?.datasetId || 'Dataset']),
        originStr ? el('span', { class: 'badge' }, [originStr]) : null,
      ].filter(Boolean)),
      grid,
    ]));

    // Update layer counts
    for (const [key, countEl] of Object.entries(this._layerCountEls || {})) {
      const v = s[key];
      countEl.textContent = v ? formatNum(v) : '';
    }
  }

  /* ═══════════════════════════════════════════════
   *  Tab: Generate
   * ═══════════════════════════════════════════════ */

  _buildGenerateTab(page) {
    const st = this._state;

    // ═══════════════════════════════════════════════
    //  AI City (procedural, client-side)
    // ═══════════════════════════════════════════════

    const aiSeedInput = el('input', {
      value: st.aiCitySeed,
      placeholder: 'Seed string',
      oninput: (e) => { st.aiCitySeed = String(e.target.value || '').trim(); },
    });
    const aiGridW = el('input', {
      value: String(st.aiCityGridW),
      oninput: (e) => { st.aiCityGridW = Math.max(32, Math.min(512, Math.floor(Number(e.target.value) || 100))); },
    });
    const aiGridH = el('input', {
      value: String(st.aiCityGridH),
      oninput: (e) => { st.aiCityGridH = Math.max(32, Math.min(512, Math.floor(Number(e.target.value) || 100))); },
    });
    const aiSizeM = el('input', {
      value: String(st.aiCitySizeM),
      oninput: (e) => { st.aiCitySizeM = Math.max(10, Number(e.target.value) || 100); },
    });
    const aiMode = el('select', {
      value: st.aiCityMode,
      onchange: (e) => { st.aiCityMode = String(e.target.value || 'standard'); },
    }, [
      el('option', { value: 'standard' }, ['Standard (deterministic grid)']),
      el('option', { value: 'wfc' }, ['WFC (wave function collapse)']),
    ]);

    const aiProgress = createProgressBar();
    const aiStatusEl = el('div', { class: 'muted', style: { marginTop: '6px', display: 'flex', alignItems: 'center', gap: '6px' } }, ['']);
    const aiStatsEl = el('div', { style: { display: 'none' } });

    const aiRandomBtn = el('button', {
      onclick: () => {
        const newSeed = 'city_' + Math.random().toString(36).slice(2, 8);
        st.aiCitySeed = newSeed;
        aiSeedInput.value = newSeed;
        this._ctx?.toast?.(`New seed: ${newSeed}`, 'info');
      },
      title: 'Randomize seed',
    }, ['\u2684']);

    const aiGenerateBtn = el('button', {
      class: 'primary',
      onclick: () => {
        try {
          // Show progress
          aiProgress.setIndeterminate();
          clear(aiStatusEl);
          aiStatusEl.appendChild(el('div', { class: 'statusDot running' }));
          aiStatusEl.appendChild(document.createTextNode('Generating\u2026'));
          this._ctx?.toast?.('Generating AI city\u2026', 'info');

          // Defer to next frame to let the UI update
          requestAnimationFrame(() => {
            try {
              const halfSize = st.aiCitySizeM * 0.5;
              const bounds = { minX: -halfSize, minY: -halfSize, minZ: 0, maxX: halfSize, maxY: halfSize, maxZ: 22 };
              const gen = (st.aiCityMode === 'wfc')
                ? generateAiCityWfc({ seed: st.aiCitySeed, gridW: st.aiCityGridW, gridH: st.aiCityGridH, bounds })
                : generateAiCity({ seed: st.aiCitySeed, gridW: st.aiCityGridW, gridH: st.aiCityGridH, bounds });

              // Upload to terrain renderer for preview
              const w = gen.grid.width;
              const h = gen.grid.height;
              this._terrain.uploadHeightU16(w, h, gen.heightsU16);
              this._terrain.uploadMaskRgba(w, h, gen.paintMaskRgba);
              const cx = (Number(gen.bounds.maxX) + Number(gen.bounds.minX)) * 0.5;
              const cz = (Number(gen.bounds.maxY) + Number(gen.bounds.minY)) * 0.5;
              const half = 2500;
              this._terrain.setBounds({
                minX: cx - half,
                minY: cz - half,
                minZ: gen.bounds.minZ,
                maxX: cx + half,
                maxY: cz + half,
                maxZ: gen.bounds.maxZ,
              });
              this._terrain.setHeightScale(1.0);

              // Upload instances as tree/building/car boxes
              // NOTE: `generateAiCity*()` uses a 2D ground plane (x, y) where `y` corresponds to world Z.
              // Its instance `pos` is `[x, zPlane, 0]` (3rd component unused).
              // TerrainRenderer uses bounds `{minX, minY(zPlane), minZ(vertical), ...}` and flips rows so
              // `zPlane` increases north. Keep the same convention here and snap to the generated heightmap.
              const heightAtGenWorld = (x, zPlane) => {
                const b = gen.bounds;
                const w0 = Math.max(2, gen.grid?.width | 0);
                const h0 = Math.max(2, gen.grid?.height | 0);
                const heights = gen.heightsU16;
                if (!(heights instanceof Uint16Array) || heights.length < w0 * h0) return 0.0;
                const sizeX = Math.max(1e-6, (Number(b.maxX) || 0) - (Number(b.minX) || 0));
                const sizeZPlane = Math.max(1e-6, (Number(b.maxY) || 0) - (Number(b.minY) || 0));
                const minX = Number(b.minX) || 0;
                const minZ = Number(b.minZ) || 0;
                const maxZPlane = (Number(b.maxY) || 0);
                let u = (Number(x) - minX) / sizeX;
                let v = (maxZPlane - Number(zPlane)) / sizeZPlane; // match TerrainRenderer row->world mapping
                if (!Number.isFinite(u)) u = 0;
                if (!Number.isFinite(v)) v = 0;
                if (u < 0) u = 0; else if (u > 1) u = 1;
                if (v < 0) v = 0; else if (v > 1) v = 1;
                const ix = Math.max(0, Math.min(w0 - 1, Math.round(u * (w0 - 1))));
                const iy = Math.max(0, Math.min(h0 - 1, Math.round(v * (h0 - 1))));
                const h01 = (heights[iy * w0 + ix] || 0) / 65535.0;
                const sizeY = (Number(b.maxZ) || 0) - (Number(b.minZ) || 0);
                return minZ + h01 * sizeY;
              };

              const instData = [];
              for (const inst of (gen.instances || [])) {
                const px = Number(inst.pos?.[0]) || 0;     // world X
                const pzPlane = Number(inst.pos?.[1]) || 0; // world Z (ground-plane)
                const s = Number(inst.scale) || 1.0;
                const c = inst.color || [0.5, 0.5, 0.5, 1.0];
                // InstancedBoxRenderer packed format:
                // iTranslate(3), iScale(3), iYaw(1), iColor(4) = 11 floats
                const height = (inst.kind === 'building') ? s * 4 : (inst.kind === 'house') ? s * 2.5 : (inst.kind === 'car') ? s * 0.8 : s * 3;
                const baseY = inst.snapToTerrain ? heightAtGenWorld(px, pzPlane) : 0.0;
                const yaw = (Number(inst.yawDeg) || 0) * Math.PI / 180.0;
                instData.push(
                  px, baseY + height * 0.5, pzPlane,
                  s * 0.8, height, s * 0.8,
                  yaw,
                  c[0], c[1], c[2], (c[3] == null ? 1 : c[3])
                );
              }
              const instFloat = new Float32Array(instData);
              const instCount = Math.floor(instFloat.length / 11);
              this._trees.setInstances(instFloat, instCount);

              // Clear other layers so they don't show stale data
              this._roads.setInstances(new Float32Array(0), 0);
              this._buildingsBoxes.setInstances(new Float32Array(0), 0);
              this._buildingsExtruded.clear();
              this._props.setInstances(new Float32Array(0), 0);
              this._waterMesh.clear();
              this._shoreline.setLinesPositions(new Float32Array(0));
              this._powerLines.setLinesPositions(new Float32Array(0));
              this._rails.setInstances(new Float32Array(0), 0);
              this._barriers.setInstances(new Float32Array(0), 0);

              // Frame camera
              this._camera?.frameAABB?.(
                [gen.bounds.minX, gen.bounds.minZ, gen.bounds.minY],
                [gen.bounds.maxX, gen.bounds.maxZ, gen.bounds.maxY]
              );

              // Update stats
              const treeCount = gen.instances.filter((i) => i.kind === 'tree').length;
              const buildingCount = gen.instances.filter((i) => i.kind === 'building' || i.kind === 'house').length;
              const carCount = gen.instances.filter((i) => i.kind === 'car').length;

              this._loaded = {
                datasetId: `ai_city_${st.aiCitySeed}`,
                label: `AI City (${st.aiCityMode === 'wfc' ? 'WFC' : 'Standard'})`,
                entries: [],
                aabb: { min: [gen.bounds.minX, gen.bounds.minZ, gen.bounds.minY], max: [gen.bounds.maxX, gen.bounds.maxZ, gen.bounds.maxY] },
                stats: {
                  heightmap: `${w}\u00D7${h}`,
                  treeCount,
                  buildingCount,
                  propCount: carCount,
                },
              };
              this._originLonLat = null;
              this._updateStatsDashboard();

              // Show completion
              aiProgress.set(1);
              setTimeout(() => aiProgress.hide(), 1500);
              clear(aiStatusEl);
              aiStatusEl.appendChild(el('div', { class: 'statusDot done' }));
              const wfcInfo = gen.ai?.wfc ? (gen.ai.wfc.ok ? ` (attempt ${gen.ai.wfc.attempt})` : ' (fallback)') : '';
              aiStatusEl.appendChild(document.createTextNode(
                `Done \u2014 ${w}\u00D7${h} grid, ${gen.instances.length} instances${wfcInfo}`
              ));

              // AI stats
              clear(aiStatsEl);
              aiStatsEl.style.display = 'block';
              const statsGrid = el('div', { class: 'statGrid' });
              statsGrid.appendChild(el('div', { class: 'statCard' }, [
                el('div', { class: 'statValue' }, [String(treeCount)]),
                el('div', { class: 'statLabel' }, ['Trees']),
              ]));
              statsGrid.appendChild(el('div', { class: 'statCard' }, [
                el('div', { class: 'statValue' }, [String(buildingCount)]),
                el('div', { class: 'statLabel' }, ['Buildings']),
              ]));
              statsGrid.appendChild(el('div', { class: 'statCard' }, [
                el('div', { class: 'statValue' }, [String(carCount)]),
                el('div', { class: 'statLabel' }, ['Cars']),
              ]));
              statsGrid.appendChild(el('div', { class: 'statCard' }, [
                el('div', { class: 'statValue' }, [`${w}\u00D7${h}`]),
                el('div', { class: 'statLabel' }, ['Grid']),
              ]));
              aiStatsEl.appendChild(statsGrid);

              this._ctx?.log?.(`AI City: generated ${st.aiCityMode} (seed=${st.aiCitySeed}, ${gen.instances.length} instances)`);
              this._ctx?.toast?.(`AI City generated: ${gen.instances.length} objects`, 'success');

            } catch (e) {
              aiProgress.hide();
              clear(aiStatusEl);
              aiStatusEl.appendChild(el('div', { class: 'statusDot error' }));
              aiStatusEl.appendChild(document.createTextNode(`Failed: ${e?.message || e}`));
              this._ctx?.log?.(`AI City: generation failed: ${e?.message || e}`);
              this._ctx?.toast?.(`AI City failed: ${e?.message || e}`, 'error');
            }
          });
        } catch (e) {
          this._ctx?.toast?.(`AI City error: ${e?.message || e}`, 'error');
        }
      },
    }, ['Generate AI City']);

    page.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['AI City (Procedural)']),
      el('div', { class: 'muted', style: { marginTop: '2px' } }, [
        'Generate a procedural city with terrain, roads, buildings, trees, and cars — entirely client-side.',
      ]),
      el('div', { class: 'formGroup' }, [
        el('div', { class: 'formLabel' }, ['Generator']),
        aiMode,
      ]),
      el('div', { class: 'formGroup' }, [
        el('div', { class: 'formLabel' }, ['Seed']),
        el('div', { class: 'row' }, [aiSeedInput, aiRandomBtn]),
        el('div', { class: 'formHint' }, ['Same seed produces same city. Click the die to randomize.']),
      ]),
      el('div', { class: 'formRow', style: { marginTop: '8px' } }, [
        el('div', { class: 'formGroup', style: { marginTop: '0' } }, [
          el('div', { class: 'formLabel' }, ['Grid W']),
          aiGridW,
        ]),
        el('div', { class: 'formGroup', style: { marginTop: '0' } }, [
          el('div', { class: 'formLabel' }, ['Grid H']),
          aiGridH,
        ]),
        el('div', { class: 'formGroup', style: { marginTop: '0' } }, [
          el('div', { class: 'formLabel' }, ['Size (m)']),
          aiSizeM,
        ]),
      ]),
      el('div', { style: { marginTop: '10px' } }, [aiGenerateBtn]),
      aiProgress.element,
      aiStatusEl,
      aiStatsEl,
    ]));

    page.appendChild(el('div', { class: 'separator' }));

    // ═══════════════════════════════════════════════
    //  OSM City Dataset (server-side)
    // ═══════════════════════════════════════════════

    // ── City presets ──
    const presetsCard = el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['City Presets']),
      el('div', { class: 'muted', style: { marginTop: '2px' } }, ['Quick-fill coordinates from a city.']),
    ]);

    const presetGrid = el('div', { class: 'presetGrid' });
    this._presetCards = [];

    for (const preset of CITY_PRESETS) {
      const card = el('div', {
        class: 'presetCard',
        onclick: () => {
          st.originLon = preset.lon;
          st.originLat = preset.lat;
          st.sizeM = preset.sizeM;
          st.cityId = preset.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
          // Refresh form inputs
          this._refreshGenFormValues?.();
          // Highlight active preset
          for (const c of this._presetCards) c.classList.remove('presetActive');
          card.classList.add('presetActive');
          this._ctx?.toast?.(`Preset: ${preset.name}`, 'info');
        },
      }, [
        el('div', { class: 'presetName' }, [preset.name]),
        el('div', { class: 'presetRegion' }, [preset.region]),
        el('div', { class: 'presetCoords' }, [`${preset.lon.toFixed(3)}, ${preset.lat.toFixed(3)}`]),
        preset.badge ? el('div', { class: 'presetBadge' }, [preset.badge]) : null,
      ].filter(Boolean));

      this._presetCards.push(card);
      presetGrid.appendChild(card);
    }

    presetsCard.appendChild(presetGrid);
    page.appendChild(presetsCard);

    // ── Generation form ──
    const formCard = el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Generate City Dataset']),
      el('div', { class: 'muted', style: { marginTop: '2px' } }, [
        'Generates terrain, roads, buildings, trees, and props from OSM data.',
      ]),
    ]);

    // Form fields
    const cityRunner = el('select', {
      value: st.cityRunner,
      onchange: (e) => { st.cityRunner = String(e.target.value || 'python3'); },
    }, [
      el('option', { value: 'python3' }, ['python3']),
      el('option', { value: 'conda_trellis' }, ['conda_trellis']),
    ]);

    const cityId = el('input', {
      value: String(st.cityId || ''),
      placeholder: 'e.g. richmond_va',
      oninput: (e) => { st.cityId = String(e.target.value || '').trim(); },
    });
    const originLon = el('input', { value: String(st.originLon), oninput: (e) => { st.originLon = Number(e.target.value) || st.originLon; } });
    const originLat = el('input', { value: String(st.originLat), oninput: (e) => { st.originLat = Number(e.target.value) || st.originLat; } });
    const sizeM = el('input', { value: String(st.sizeM), oninput: (e) => { st.sizeM = Math.max(10, Number(e.target.value) || st.sizeM); } });
    const grid = el('input', { value: String(st.grid), oninput: (e) => { st.grid = Math.max(64, Math.min(2048, Math.floor(Number(e.target.value) || st.grid))); } });
    const maxBuildings = el('input', { value: String(st.maxBuildings), oninput: (e) => { st.maxBuildings = Math.max(0, Math.floor(Number(e.target.value) || st.maxBuildings)); } });
    const maxTrees = el('input', { value: String(st.maxTrees), oninput: (e) => { st.maxTrees = Math.max(0, Math.floor(Number(e.target.value) || st.maxTrees)); } });
    const maxProps = el('input', { value: String(st.maxProps), oninput: (e) => { st.maxProps = Math.max(0, Math.floor(Number(e.target.value) || st.maxProps)); } });

    // Store refs for preset refresh
    this._refreshGenFormValues = () => {
      cityId.value = String(st.cityId || '');
      originLon.value = String(st.originLon);
      originLat.value = String(st.originLat);
      sizeM.value = String(st.sizeM);
    };

    // Build form with proper groups
    const makeGroup = (label, children, hint) => {
      const group = el('div', { class: 'formGroup' }, [
        el('div', { class: 'formLabel' }, [label]),
        ...(Array.isArray(children) ? children : [children]),
      ]);
      if (hint) group.appendChild(el('div', { class: 'formHint' }, [hint]));
      return group;
    };

    formCard.appendChild(el('div', { style: { marginTop: '12px' } }, [
      makeGroup('Runner', cityRunner, 'Python environment for generation'),
      makeGroup('Dataset ID', cityId, 'Unique identifier; used as output folder name'),
      el('div', { class: 'formGroup' }, [
        el('div', { class: 'formLabel' }, ['Location']),
        el('div', { class: 'formRow' }, [
          el('div', {}, [el('div', { class: 'formHint' }, ['Longitude']), originLon]),
          el('div', {}, [el('div', { class: 'formHint' }, ['Latitude']), originLat]),
        ]),
      ]),
      el('div', { class: 'formGroup' }, [
        el('div', { class: 'formLabel' }, ['Dimensions']),
        el('div', { class: 'formRow' }, [
          el('div', {}, [el('div', { class: 'formHint' }, ['Size (meters)']), sizeM]),
          el('div', {}, [el('div', { class: 'formHint' }, ['Grid resolution']), grid]),
        ]),
      ]),
      el('div', { class: 'formGroup' }, [
        el('div', { class: 'formLabel' }, ['Limits']),
        el('div', { class: 'formRow' }, [
          el('div', {}, [el('div', { class: 'formHint' }, ['Buildings']), maxBuildings]),
          el('div', {}, [el('div', { class: 'formHint' }, ['Trees']), maxTrees]),
          el('div', {}, [el('div', { class: 'formHint' }, ['Props']), maxProps]),
        ]),
      ]),
    ]));

    // ── Advanced options (collapsible) ──
    const tileBuildings = el('input', { type: 'checkbox', checked: !!st.tileBuildings, onchange: (e) => { st.tileBuildings = e.target.checked ? 1 : 0; } });
    const tileChunkM = el('input', { value: String(st.tileChunkM), oninput: (e) => { st.tileChunkM = Math.max(64, Number(e.target.value) || st.tileChunkM); } });
    const updateManifest = el('input', { type: 'checkbox', checked: !!st.updateManifest, onchange: (e) => { st.updateManifest = e.target.checked ? 1 : 0; } });
    const cityAutoLoad = el('input', { type: 'checkbox', checked: !!st.cityJobAutoLoad, onchange: (e) => { st.cityJobAutoLoad = e.target.checked ? 1 : 0; } });

    const heightmapMeshPath = el('input', {
      value: String(st.heightmapMeshPath || ''),
      placeholder: 'e.g. assets/generated/trellis/terrain.glb',
      oninput: (e) => { st.heightmapMeshPath = String(e.target.value || '').trim(); },
    });
    const heightmapGrid = el('input', { value: String(st.heightmapGrid || st.grid), oninput: (e) => { st.heightmapGrid = Math.max(16, Math.min(4096, Math.floor(Number(e.target.value) || st.heightmapGrid))); } });
    const blenderPath = el('input', {
      value: String(st.blenderPath || ''),
      placeholder: '/usr/bin/blender (optional)',
      oninput: (e) => { st.blenderPath = String(e.target.value || '').trim(); },
    });
    const heightmapArgs = el('input', {
      value: String(st.heightmapArgs || ''),
      placeholder: '--min-z 0 --max-z 40 (optional)',
      oninput: (e) => { st.heightmapArgs = String(e.target.value || ''); },
    });

    const advancedDetails = el('details', { class: 'card' }, [
      el('summary', {}, [el('div', { class: 'dockTitle' }, ['Advanced Options'])]),
      el('div', { class: 'cardBody' }, [
        el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, [
          el('label', { class: 'layerToggle' }, [
            tileBuildings,
            el('span', { class: 'layerName' }, ['Tile buildings (multi-LOD)']),
          ]),
          el('div', { class: 'formGroup', style: { marginTop: '0' } }, [
            el('div', { class: 'formLabel' }, ['Tile chunk (m)']),
            tileChunkM,
          ]),
          el('label', { class: 'layerToggle' }, [
            updateManifest,
            el('span', { class: 'layerName' }, ['Update manifest.json']),
          ]),
          el('label', { class: 'layerToggle' }, [
            cityAutoLoad,
            el('span', { class: 'layerName' }, ['Auto-load after generation']),
          ]),
          el('div', { class: 'separator' }),
          el('div', { class: 'formGroup', style: { marginTop: '0' } }, [
            el('div', { class: 'formLabel' }, ['Heightmap Mesh Override']),
            heightmapMeshPath,
            el('div', { class: 'formHint' }, ['Optional: overwrite terrain from a 3D mesh (Trellis terrain).']),
          ]),
          el('div', { class: 'formGroup', style: { marginTop: '0' } }, [
            el('div', { class: 'formLabel' }, ['Heightmap grid']),
            heightmapGrid,
          ]),
          el('div', { class: 'formGroup', style: { marginTop: '0' } }, [
            el('div', { class: 'formLabel' }, ['Blender path']),
            blenderPath,
          ]),
          el('div', { class: 'formGroup', style: { marginTop: '0' } }, [
            el('div', { class: 'formLabel' }, ['Extra heightmap args']),
            heightmapArgs,
          ]),
        ]),
      ]),
    ]);

    formCard.appendChild(advancedDetails);

    // ── Asset picker for heightmap mesh ──
    const meshPicker = createAssetPicker({
      ctx: this._ctx,
      title: 'Pick Heightmap Mesh',
      ext: '.glb,.gltf,.obj,.fbx,.blend',
      onPick: (p) => {
        st.heightmapMeshPath = p;
        heightmapMeshPath.value = p;
        this._ctx?.toast?.(`Selected: ${p.split('/').pop()}`, 'info');
      },
    });
    formCard.appendChild(meshPicker);

    page.appendChild(formCard);

    // ── Job runner ──
    const cityJobProgress = createProgressBar();
    this._cityJobProgress = cityJobProgress;

    const cityStatus = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap', display: 'flex', alignItems: 'center', gap: '6px' } }, ['']);
    const cityLog = el('div', { class: 'scrollArea', style: { height: '180px', marginTop: '8px', whiteSpace: 'pre' } }, ['Ready to generate.']);
    this._cityStatusEl = cityStatus;
    this._cityLogEl = cityLog;

    const cityStartBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        if (!st.cityId?.trim()) {
          this._ctx?.toast?.('Please enter a Dataset ID', 'warning');
          return;
        }
        try {
          await this._startCitygenJob({
            runner: st.cityRunner,
            datasetId: st.cityId,
            originLon: st.originLon,
            originLat: st.originLat,
            sizeM: st.sizeM,
            grid: st.grid,
            maxBuildings: st.maxBuildings,
            maxTrees: st.maxTrees,
            maxProps: st.maxProps,
            tileBuildings: st.tileBuildings,
            tileChunkM: st.tileChunkM,
            updateManifest: st.updateManifest,
            manifestPath: st.manifestPath,
            heightmapMeshPath: st.heightmapMeshPath,
            heightmapGrid: st.heightmapGrid,
            blenderPath: st.blenderPath,
            heightmapArgs: st.heightmapArgs,
            statusEl: cityStatus,
            logEl: cityLog,
            autoLoad: !!st.cityJobAutoLoad,
          });
        } catch (e) {
          this._ctx?.log?.(`Citygen: start failed: ${e?.message || e}`);
          cityStatus.textContent = `Start failed: ${e?.message || e}`;
        }
      },
    }, ['Generate City']);

    const cityKillBtn = el('button', {
      class: 'danger',
      onclick: async () => {
        const id = String(this._cityJob?.id || '');
        if (!id) return;
        try {
          await fetch('/__devtools_citygen_kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
          this._ctx?.toast?.('Job killed', 'warning');
        } catch { /* ignore */ }
        this._pollingCity = false;
      },
    }, ['Kill']);

    page.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Generation Job']),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [cityStartBtn, cityKillBtn]),
      cityJobProgress.element,
      cityStatus,
      cityLog,
    ]));

    // ── Info banner ──
    page.appendChild(el('div', { class: 'infoBanner' }, [
      el('span', { class: 'infoIcon' }, ['●']),
      el('span', {}, [
        'Output goes to ',
        el('span', { class: 'kbd' }, ['assets/datasets/generated/<id>/']),
        '. For Omniverse asset imports, use the dedicated Omniverse tool in the sidebar.',
      ]),
    ]));
  }

  /* ═══════════════════════════════════════════════
   *  Tab: Settings
   * ═══════════════════════════════════════════════ */

  _buildSettingsTab(page) {
    const st = this._state;

    // ── Manifest ──
    const manifestUrl = el('input', {
      value: st.manifestUrl,
      oninput: (e) => { st.manifestUrl = String(e.target.value || '').trim(); },
    });

    page.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Manifest']),
      el('div', { class: 'formGroup' }, [
        el('div', { class: 'formLabel' }, ['Manifest URL']),
        manifestUrl,
        el('div', { class: 'formHint' }, ['Default: assets/datasets/manifest.json']),
      ]),
    ]));

    // ── Tiles streaming ──
    const tilesRadius = el('input', {
      value: String(st.tilesRadiusChunks),
      oninput: (e) => { st.tilesRadiusChunks = Math.max(1, Number(e.target.value) || 8); },
    });

    page.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Tiles Streaming']),
      el('div', { style: { marginTop: '4px' } }, [
        el('label', { class: 'layerToggle' }, [
          el('input', { type: 'checkbox', checked: !!st.tilesLoadAll, onchange: (e) => { st.tilesLoadAll = !!e.target.checked; } }),
          el('span', { class: 'layerName' }, ['Load all chunks']),
        ]),
        el('label', { class: 'layerToggle' }, [
          el('input', { type: 'checkbox', checked: !!st.tilesCull, onchange: (e) => { st.tilesCull = !!e.target.checked; } }),
          el('span', { class: 'layerName' }, ['Frustum cull chunks']),
        ]),
        el('div', { class: 'formGroup' }, [
          el('div', { class: 'formLabel' }, ['Radius (chunks)']),
          tilesRadius,
        ]),
      ]),
    ]));

    // ── Fog ──
    const fogStart = el('input', { value: String(st.fogStart), oninput: (e) => { st.fogStart = Math.max(0, Number(e.target.value) || 0); } });
    const fogEnd = el('input', { value: String(st.fogEnd), oninput: (e) => { st.fogEnd = Math.max(0, Number(e.target.value) || 0); } });
    const facade = el('input', { value: String(st.buildingsFacade), oninput: (e) => { st.buildingsFacade = clamp(Number(e.target.value) || 1.0, 0.0, 1.0); } });

    page.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Fog & Rendering']),
      el('div', { style: { marginTop: '4px' } }, [
        el('label', { class: 'layerToggle' }, [
          el('input', { type: 'checkbox', checked: !!st.fogEnabled, onchange: (e) => { st.fogEnabled = !!e.target.checked; } }),
          el('span', { class: 'layerName' }, ['Enable fog (tiles renderer)']),
        ]),
        el('div', { class: 'formRow', style: { marginTop: '8px' } }, [
          el('div', { class: 'formGroup', style: { marginTop: '0' } }, [
            el('div', { class: 'formLabel' }, ['Fog start']),
            fogStart,
          ]),
          el('div', { class: 'formGroup', style: { marginTop: '0' } }, [
            el('div', { class: 'formLabel' }, ['Fog end']),
            fogEnd,
          ]),
        ]),
        el('div', { class: 'formGroup' }, [
          el('div', { class: 'formLabel' }, ['Facade (boxes mode)']),
          facade,
          el('div', { class: 'formHint' }, ['0.0 = wireframe, 1.0 = solid']),
        ]),
      ]),
    ]));

    // ── Water ──
    const waterLevel = el('input', { value: String(st.waterLevelY), oninput: (e) => { st.waterLevelY = Number(e.target.value) || 0.0; } });

    page.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Water']),
      el('div', { style: { marginTop: '4px' } }, [
        el('div', { class: 'formGroup', style: { marginTop: '0' } }, [
          el('div', { class: 'formLabel' }, ['Water level Y']),
          waterLevel,
        ]),
        el('label', { class: 'layerToggle' }, [
          el('input', { type: 'checkbox', checked: !!st.waterPlaneEnabled, onchange: (e) => { st.waterPlaneEnabled = !!e.target.checked; } }),
          el('span', { class: 'layerName' }, ['Draw flat water plane']),
        ]),
        el('div', { class: 'formHint' }, ['Reload dataset to regenerate water polygons at a new level.']),
      ]),
    ]));
  }

  /* ═══════════════════════════════════════════════
   *  Data loading
   * ═══════════════════════════════════════════════ */

  async _loadManifest() {
    const url = String(this._state.manifestUrl || 'assets/datasets/manifest.json').trim();
    if (this._manifest) return this._manifest;
    if (this._manifestPromise) return await this._manifestPromise;
    this._manifestPromise = (async () => {
      this._ctx?.log?.(`Datasets: loading manifest ${url}`);
      const list = await loadDatasetManifest(url);
      this._manifest = Array.isArray(list) ? list : [];
      this._manifestPromise = null;
      this._ctx?.log?.(`Datasets: manifest loaded (${this._manifest.length})`);
      return this._manifest;
    })();
    return await this._manifestPromise;
  }

  async _loadDataset(datasetId) {
    const ctx = this._ctx;
    const id = String(datasetId || '').trim();
    if (!id) return;

    this._isLoading = true;
    this._loadProgress?.setIndeterminate();
    ctx?.toast?.(`Loading dataset: ${id}`, 'info');

    const manifest = await this._loadManifest();
    const entry = manifest.find((d) => String(d?.id || '') === id) || null;
    const label = String(entry?.label || id);

    ctx?.log?.(`Datasets: loading ${id} (${label})`);

    // Reset
    this._originLonLat = null;
    this._hmZ = null;
    this._hmSample = null;
    this._loaded = { datasetId: id, label, entries: [], aabb: null, stats: {} };

    // Clear renderers
    this._roads.setInstances(new Float32Array(0), 0);
    this._rails.setInstances(new Float32Array(0), 0);
    this._barriers.setInstances(new Float32Array(0), 0);
    this._trees.setInstances(new Float32Array(0), 0);
    this._props.setInstances(new Float32Array(0), 0);
    this._buildingsBoxes.setInstances(new Float32Array(0), 0);
    this._buildingsExtruded.clear();
    this._waterMesh.clear();
    this._shoreline.setLinesPositions(new Float32Array(0));
    this._powerLines.setLinesPositions(new Float32Array(0));
    try { this._tilesStreamer.dispose(); } catch { /* ignore */ }
    this._tilesStreamer = new InstancedTilesStreamer();
    this._tilesStreamer.onWantedChunks = (chunks, total) => {
      this._applyTileGrounding(chunks);
      try { this._tilesBuildings.setChunks(chunks); } catch { /* ignore */ }
      this._loaded.stats.tilesInstances = total | 0;
      this._loaded.stats.tilesChunks = (chunks?.length || 0) | 0;
    };

    // Resolve bundle
    const leafIds = resolveDatasetBundle(manifest, id);
    const leaf = leafIds.map((lid) => manifest.find((d) => String(d?.id || '') === lid)).filter(Boolean);
    this._loaded.entries = leaf.map((d) => ({ id: d.id, kind: d.kind, url: d.url || '' }));

    let sceneAabb = null;
    const layers = {
      roads: null,
      rails: null,
      barriers: null,
      trees: null,
      props: null,
      buildingsBoxes: null,
      buildingsFootprints: null,
    };

    const totalEntries = leaf.length;
    let loadedEntries = 0;

    for (const d of leaf) {
      const kind = String(d?.kind || '');
      const url = String(d?.url || '');
      if (!url) continue;
      try {
        if (kind === 'heightmap-u16') {
          const hm = await loadHeightmapU16(url);
          const w = hm.width | 0;
          const h = hm.height | 0;
          this._terrain.uploadHeightU16(w, h, hm.heightsU16);
          this._terrain.uploadMaskRgba(w, h, new Uint8Array(w * h * 4));
          this._hmSample = { w, h, heightsU16: hm.heightsU16 };
          const minZ = Number.isFinite(hm.minZ) ? hm.minZ : 0.0;
          const maxZ = Number.isFinite(hm.maxZ) ? hm.maxZ : (minZ + 40.0);
          this._hmZ = { minZ, maxZ };
          const bbox = hm?.meta?.bbox;
          const bboxBounds = terrainBoundsFromBbox(bbox, this._originLonLat);
          if (bboxBounds) {
            if (!this._originLonLat) this._originLonLat = bboxBounds.originLonLat;
            const cx = (bboxBounds.minX + bboxBounds.maxX) * 0.5;
            const cz = (bboxBounds.minZPlane + bboxBounds.maxZPlane) * 0.5;
            const half = 2500;
            this._terrain.setBounds({
              minX: cx - half,
              minY: cz - half,
              minZ,
              maxX: cx + half,
              maxY: cz + half,
              maxZ,
            });
            sceneAabb = aabbUnion(sceneAabb, {
              min: [bboxBounds.minX, minZ, bboxBounds.minZPlane],
              max: [bboxBounds.maxX, maxZ, bboxBounds.maxZPlane],
            });
          } else {
            const size = 6000;
            this._terrain.setBounds({
              minX: -size * 0.5,
              minY: -size * 0.5,
              minZ,
              maxX: size * 0.5,
              maxY: size * 0.5,
              maxZ,
            });
            sceneAabb = aabbUnion(sceneAabb, {
              min: [-size * 0.5, minZ, -size * 0.5],
              max: [size * 0.5, maxZ, size * 0.5],
            });
          }
          this._terrain.setHeightScale(1.0);
          this._loaded.stats.heightmap = `${w}x${h}`;
        } else if (kind === 'geojson-wgs84-roads') {
          const r = await loadWgs84RoadsGeoJson(url, { originLonLat: this._originLonLat });
          if (!this._originLonLat && r?.bounds?.originLonLat) this._originLonLat = r.bounds.originLonLat;
          const instCount = Math.floor((r.instances?.length || 0) / (r.floatsPer || 11));
          this._roads.setInstances(r.instances, instCount);
          layers.roads = { instances: r.instances, floatsPer: (r.floatsPer || 11), count: instCount };
          this._loaded.stats.roadSegments = r.segmentCount || instCount;
          sceneAabb = aabbUnion(sceneAabb, boundsToAabb(r.bounds));
        } else if (kind === 'geojson-wgs84-rails') {
          const r = await loadWgs84RailsGeoJson(url, { originLonLat: this._originLonLat });
          if (!this._originLonLat && r?.bounds?.originLonLat) this._originLonLat = r.bounds.originLonLat;
          const instCount = Math.floor((r.instances?.length || 0) / (r.floatsPer || 11));
          this._rails.setInstances(r.instances, instCount);
          layers.rails = { instances: r.instances, floatsPer: (r.floatsPer || 11), count: instCount };
          this._loaded.stats.railSegments = r.segmentCount || instCount;
          sceneAabb = aabbUnion(sceneAabb, boundsToAabb(r.bounds));
        } else if (kind === 'geojson-wgs84-barriers') {
          const r = await loadWgs84BarriersGeoJson(url, { originLonLat: this._originLonLat });
          if (!this._originLonLat && r?.bounds?.originLonLat) this._originLonLat = r.bounds.originLonLat;
          const instCount = Math.floor((r.instances?.length || 0) / (r.floatsPer || 11));
          this._barriers.setInstances(r.instances, instCount);
          layers.barriers = { instances: r.instances, floatsPer: (r.floatsPer || 11), count: instCount };
          this._loaded.stats.barrierSegments = r.segmentCount || instCount;
          sceneAabb = aabbUnion(sceneAabb, boundsToAabb(r.bounds));
        } else if (kind === 'geojson-wgs84-powerlines') {
          const r = await loadWgs84PowerLinesGeoJson(url, { originLonLat: this._originLonLat });
          if (!this._originLonLat && r?.bounds?.originLonLat) this._originLonLat = r.bounds.originLonLat;
          this._powerLines.setLinesPositions(r.positions);
          this._loaded.stats.powerSegments = r.segmentCount || Math.floor((r.positions?.length || 0) / 6);
          sceneAabb = aabbUnion(sceneAabb, boundsToAabb(r.bounds));
        } else if (kind === 'geojson-wgs84-water') {
          const r = await loadWgs84WaterGeoJson(url, { originLonLat: this._originLonLat, waterLevelY: this._state.waterLevelY });
          if (!this._originLonLat && r?.bounds?.originLonLat) this._originLonLat = r.bounds.originLonLat;
          this._waterMesh.setMesh(r.waterMesh);
          this._shoreline.setLinesPositions(r.shoreline);
          this._loaded.stats.waterPolygons = r.polygonCount || 0;
          this._loaded.stats.waterSegments = r.segmentCount || 0;
          sceneAabb = aabbUnion(sceneAabb, boundsToAabb(r.bounds));
        } else if (kind === 'geojson-wgs84-buildings') {
          const boxes = await loadWgs84BuildingsGeoJson(url, { originLonLat: this._originLonLat });
          if (!this._originLonLat && boxes?.bounds?.originLonLat) this._originLonLat = boxes.bounds.originLonLat;
          const instCount = Math.floor((boxes.instances?.length || 0) / (boxes.floatsPer || 11));
          this._buildingsBoxes.setInstances(boxes.instances, instCount);
          layers.buildingsBoxes = { instances: boxes.instances, floatsPer: (boxes.floatsPer || 11), count: instCount };
          this._loaded.stats.buildingCount = boxes.buildingCount || instCount;
          sceneAabb = aabbUnion(sceneAabb, boundsToAabb(boxes.bounds));

          const fp = await loadWgs84BuildingFootprintsGeoJson(url, { originLonLat: this._originLonLat });
          layers.buildingsFootprints = fp.buildings;
        } else if (kind === 'geojson-wgs84-trees') {
          const r = await loadWgs84TreesGeoJson(url, { originLonLat: this._originLonLat });
          if (!this._originLonLat && r?.bounds?.originLonLat) this._originLonLat = r.bounds.originLonLat;
          const instCount = Math.floor((r.instances?.length || 0) / (r.floatsPer || 11));
          this._trees.setInstances(r.instances, instCount);
          layers.trees = { instances: r.instances, floatsPer: (r.floatsPer || 11), count: instCount };
          this._loaded.stats.treeCount = r.treeCount || instCount;
          sceneAabb = aabbUnion(sceneAabb, boundsToAabb(r.bounds));
        } else if (kind === 'geojson-wgs84-props') {
          const r = await loadWgs84PropsGeoJson(url, { originLonLat: this._originLonLat });
          if (!this._originLonLat && r?.bounds?.originLonLat) this._originLonLat = r.bounds.originLonLat;
          const instCount = Math.floor((r.instances?.length || 0) / (r.floatsPer || 11));
          this._props.setInstances(r.instances, instCount);
          layers.props = { instances: r.instances, floatsPer: (r.floatsPer || 11), count: instCount };
          this._loaded.stats.propCount = r.propCount || instCount;
          sceneAabb = aabbUnion(sceneAabb, boundsToAabb(r.bounds));
        } else if (kind === 'instanced-tiles-buildings-multilod') {
          await this._tilesStreamer.init(url);
          this._loaded.stats.tilesIndex = url;
        }
      } catch (e) {
        ctx?.log?.(`Datasets: failed ${String(d?.id || '')} (${String(d?.kind || '')}): ${e?.message || e}`);
      }

      loadedEntries++;
      this._loadProgress?.set(loadedEntries / Math.max(1, totalEntries));
    }

    this._loaded.aabb = sceneAabb;

    // Fit terrain bounds to vector layers.
    // Do this even if the heightmap is missing/failed; we still want a terrain plane under the city.
    if (sceneAabb && this._terrain) {
      const minX = Number(sceneAabb.min[0]) || 0;
      const maxX = Number(sceneAabb.max[0]) || 0;
      const minZPlane = Number(sceneAabb.min[2]) || 0;
      const maxZPlane = Number(sceneAabb.max[2]) || 0;
      const cx = (minX + maxX) * 0.5;
      const cz = (minZPlane + maxZPlane) * 0.5;
      const half = 2500;
      // Vertical range: prefer heightmap metadata when available; otherwise keep current terrain range.
      const curMinZ = Number(this._terrain.boundsMin?.[2]) || 0;
      const curMaxZ = curMinZ + (Number(this._terrain.boundsSize?.[2]) || 40);
      const minZ = (this._hmZ && Number.isFinite(this._hmZ.minZ)) ? this._hmZ.minZ : curMinZ;
      const maxZ = (this._hmZ && Number.isFinite(this._hmZ.maxZ)) ? this._hmZ.maxZ : curMaxZ;
      this._terrain.setBounds({
        minX: cx - half,
        minY: cz - half,
        minZ,
        maxX: cx + half,
        maxY: cz + half,
        maxZ,
      });
    }

    // Ground overlays to terrain height
    try {
      if (this._hmSample && this._terrain && sceneAabb && this._hmZ) {
        const dz = (Number(this._hmZ.maxZ) || 0) - (Number(this._hmZ.minZ) || 0);
        const hasElevation = Number.isFinite(dz) && Math.abs(dz) > 0.01;
        if (hasElevation) {
          const applyGround = (arr, floatsPer) => {
            if (!(arr instanceof Float32Array) || !arr.length) return;
            const fp = Math.max(1, floatsPer | 0);
            for (let off = 0; off + fp - 1 < arr.length; off += fp) {
              const tx = arr[off + 0];
              const tz = arr[off + 2];
              const baseY = this._heightAtWorld(tx, tz);
              arr[off + 1] = (arr[off + 1] || 0) + baseY;
            }
          };
          applyGround(layers.roads?.instances, layers.roads?.floatsPer);
          applyGround(layers.rails?.instances, layers.rails?.floatsPer);
          applyGround(layers.barriers?.instances, layers.barriers?.floatsPer);
          applyGround(layers.trees?.instances, layers.trees?.floatsPer);
          applyGround(layers.props?.instances, layers.props?.floatsPer);
          applyGround(layers.buildingsBoxes?.instances, layers.buildingsBoxes?.floatsPer);

          if (layers.roads) this._roads.setInstances(layers.roads.instances, layers.roads.count);
          if (layers.rails) this._rails.setInstances(layers.rails.instances, layers.rails.count);
          if (layers.barriers) this._barriers.setInstances(layers.barriers.instances, layers.barriers.count);
          if (layers.trees) this._trees.setInstances(layers.trees.instances, layers.trees.count);
          if (layers.props) this._props.setInstances(layers.props.instances, layers.props.count);
          if (layers.buildingsBoxes) this._buildingsBoxes.setInstances(layers.buildingsBoxes.instances, layers.buildingsBoxes.count);

          const fps = Array.isArray(layers.buildingsFootprints) ? layers.buildingsFootprints : [];
          if (fps.length) {
            for (let i = 0; i < fps.length; i++) {
              const fp = fps[i];
              const cx = Number(fp?.centerXZ?.[0]);
              const cz = Number(fp?.centerXZ?.[1]);
              if (!Number.isFinite(cx) || !Number.isFinite(cz)) continue;
              const baseY = this._heightAtWorld(cx, cz);
              fp.minY = (Number(fp.minY) || 0) + baseY;
              fp.maxY = (Number(fp.maxY) || 0) + baseY;
            }
          }
        }
      }
    } catch (e) {
      this._ctx?.log?.(`Datasets: grounding failed: ${e?.message || e}`);
    }

    // Build extruded buildings
    try {
      if (Array.isArray(layers.buildingsFootprints) && layers.buildingsFootprints.length) {
        const mesh = buildExtrudedBuildingsMesh(layers.buildingsFootprints, { maxBuildings: 15000 });
        this._buildingsExtruded.setMesh(mesh);
      } else {
        this._buildingsExtruded.clear();
      }
    } catch (e) {
      this._ctx?.log?.(`Datasets: building extrusion failed: ${e?.message || e}`);
      try { this._buildingsExtruded.clear(); } catch { /* ignore */ }
    }

    // Frame camera
    if (sceneAabb) {
      this._camera.frameAABB(sceneAabb.min, sceneAabb.max);
    }

    this._isLoading = false;
    this._loadProgress?.set(1);
    setTimeout(() => this._loadProgress?.hide(), 1500);

    ctx?.log?.(`Datasets: loaded ${id} (${leaf.length} entries)`);
    ctx?.toast?.(`Dataset loaded: ${label}`, 'success');

    // Update stats dashboard
    this._updateStatsDashboard();
  }

  _heightAtWorld(x, z) {
    const hm = this._hmSample;
    const t = this._terrain;
    if (!hm || !t) return 0.0;
    const w = Math.max(2, hm.w | 0);
    const h = Math.max(2, hm.h | 0);
    const heights = hm.heightsU16;
    if (!(heights instanceof Uint16Array) || heights.length < w * h) return 0.0;

    const minX = Number(t.boundsMin?.[0]) || 0;
    const minZPlane = Number(t.boundsMin?.[1]) || 0;
    const minY = Number(t.boundsMin?.[2]) || 0;
    const sizeX = Number(t.boundsSize?.[0]) || 1;
    const sizeZPlane = Number(t.boundsSize?.[1]) || 1;
    const sizeY = Number(t.boundsSize?.[2]) || 0;
    const hs = (Number.isFinite(t.heightScale) && t.heightScale > 0) ? t.heightScale : 1.0;

    const maxZPlane = minZPlane + sizeZPlane;
    let u = (Number(x) - minX) / Math.max(1e-6, sizeX);
    let v = (maxZPlane - Number(z)) / Math.max(1e-6, sizeZPlane);
    if (!Number.isFinite(u)) u = 0;
    if (!Number.isFinite(v)) v = 0;
    if (u < 0) u = 0; else if (u > 1) u = 1;
    if (v < 0) v = 0; else if (v > 1) v = 1;

    const ix = Math.max(0, Math.min(w - 1, Math.round(u * (w - 1))));
    const iy = Math.max(0, Math.min(h - 1, Math.round(v * (h - 1))));
    const h01 = (heights[iy * w + ix] || 0) / 65535.0;
    return minY + h01 * sizeY * hs;
  }

  _applyTileGrounding(chunks) {
    if (!Array.isArray(chunks) || !chunks.length) return;
    if (!this._terrain || !this._hmSample || !this._hmZ) return;
    for (const ch of chunks) {
      const h = ch?.header;
      if (!h) continue;
      const cs = Number(h.chunkSize) || 512;
      const cx = (Number(h.chunkMinX) || 0) + cs * 0.5;
      const cz = (Number(h.chunkMinZ) || 0) + cs * 0.5;
      h.groundY = this._heightAtWorld(cx, cz);
    }
  }

  /* ═══════════════════════════════════════════════
   *  City generation job
   * ═══════════════════════════════════════════════ */

  async _startCitygenJob({
    runner, datasetId, originLon, originLat, sizeM, grid,
    maxBuildings, maxTrees, maxProps, tileBuildings, tileChunkM,
    updateManifest, manifestPath, heightmapMeshPath, heightmapGrid,
    blenderPath, heightmapArgs, statusEl, logEl, autoLoad,
  }) {
    const ctx = this._ctx;
    const did = String(datasetId || '').trim();
    if (!did) throw new Error('Missing datasetId');

    this._cityJob = { id: '', status: 'running', stdout: '', stderr: '', outDir: '', datasetId: '' };
    this._pollingCity = false;

    // Update status UI
    clear(statusEl);
    statusEl.appendChild(el('div', { class: 'statusDot running' }));
    statusEl.appendChild(document.createTextNode('Starting\u2026'));
    logEl.textContent = '(starting\u2026)';
    this._cityJobProgress?.setIndeterminate();

    ctx?.toast?.('City generation started', 'info');

    const payload = {
      runner: String(runner || 'python3'),
      datasetId: did,
      originLon: Number(originLon),
      originLat: Number(originLat),
      sizeM: Number(sizeM),
      grid: Number(grid),
      maxBuildings: Number(maxBuildings),
      maxTrees: Number(maxTrees),
      maxProps: Number(maxProps),
      tileBuildings: Number(tileBuildings || 0) ? 1 : 0,
      tileChunkM: Number(tileChunkM),
      updateManifest: (updateManifest == null) ? 1 : (Number(updateManifest || 0) ? 1 : 0),
      manifestPath: String(manifestPath || 'assets/datasets/manifest.json'),
      heightmapMeshPath: String(heightmapMeshPath || ''),
      heightmapGrid: Number(heightmapGrid || grid),
      blenderPath: String(blenderPath || ''),
      heightmapArgs: String(heightmapArgs || ''),
    };

    const resp = await fetch('/__devtools_citygen_start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'citygen start failed'));

    this._cityJob.id = String(j.id || '');
    this._cityJob.datasetId = String(j.datasetId || did);
    this._cityJob.outDir = String(j.outDir || '');
    this._pollingCity = true;
    void this._pollCitygenLoop({ id: this._cityJob.id, statusEl, logEl, autoLoad: !!autoLoad });
    ctx?.log?.('Citygen: started');
  }

  async _pollCitygenLoop({ id, statusEl, logEl, autoLoad }) {
    const ctx = this._ctx;
    if (!id) return;
    let backoff = 400;
    while (this._pollingCity && this._cityJob?.id === id) {
      try {
        const resp = await fetch(`/__devtools_citygen_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'job query failed'));
        this._cityJob.status = String(j.status || '');
        this._cityJob.stdout = String(j.stdout || '');
        this._cityJob.stderr = String(j.stderr || '');
        this._cityJob.outDir = String(j.outDir || this._cityJob.outDir || '');
        this._cityJob.datasetId = String(j.datasetId || this._cityJob.datasetId || '');

        // Update status
        clear(statusEl);
        const dotClass = (this._cityJob.status === 'done') ? 'done' : (this._cityJob.status === 'error' || this._cityJob.status === 'killed') ? 'error' : 'running';
        statusEl.appendChild(el('div', { class: `statusDot ${dotClass}` }));
        statusEl.appendChild(document.createTextNode(
          `${this._cityJob.status}${this._cityJob.outDir ? ` \u2014 ${this._cityJob.outDir}` : ''}`
        ));

        // Update log
        const out = this._cityJob.stdout || '';
        const err = this._cityJob.stderr || '';
        logEl.textContent = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output yet)';
        try { logEl.scrollTop = logEl.scrollHeight; } catch { /* ignore */ }

        if (this._cityJob.status === 'done' || this._cityJob.status === 'error' || this._cityJob.status === 'killed') {
          this._pollingCity = false;
          this._cityJobProgress?.hide();

          if (this._cityJob.status === 'done') {
            this._cityJobProgress?.set(1);
            const did = String(this._cityJob.datasetId || '').trim();
            ctx?.log?.(`Citygen: done \u2192 ${did}`);
            ctx?.toast?.(`City generated: ${did}`, 'success');

            // Reload manifest
            try {
              this._manifest = null;
              this._manifestPromise = null;
              await this._loadManifest();
              this._fillDatasetSelect();
            } catch { /* ignore */ }

            if (autoLoad && did) {
              try {
                this._state.datasetId = did;
                this._syncDatasetSelect?.();
                // Switch to browse tab to show the results
                this._activeTab = 'browse';
                this._buildUi();
                await this._loadDataset(did);
              } catch (e) {
                ctx?.log?.(`Citygen: auto-load failed: ${e?.message || e}`);
              }
            }
          } else {
            ctx?.toast?.(`City generation ${this._cityJob.status}`, 'error');
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

  _fillDatasetSelect() {
    const sel = this._datasetSelectEl;
    if (!sel) return;
    const cur = String(this._state.datasetId || '');
    clear(sel);
    sel.appendChild(el('option', { value: '' }, ['Select a dataset\u2026']));
    for (const d of (this._manifest || [])) {
      const id = String(d?.id || '');
      if (!id) continue;
      const label = String(d?.label || id);
      const kind = String(d?.kind || '');
      const suffix = kind ? ` \u2014 ${kind}` : '';
      sel.appendChild(el('option', { value: id }, [`${label} (${id})${suffix}`]));
    }
    sel.value = cur;
  }
}
