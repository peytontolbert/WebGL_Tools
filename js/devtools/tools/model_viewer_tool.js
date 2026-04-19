import { el, clear, clamp } from '../../ui/dom.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

function isNvidiaAnimName(name) {
  const s = String(name || '').trim();
  if (!s) return false;
  const low = s.toLowerCase();
  // Common conventions in this repo / NVIDIA demo assets.
  if (low.startsWith('@nvidia')) return true;
  if (low.startsWith('@nvd')) return true;
  if (low.startsWith('animgraph_nvd_')) return true;
  if (low.includes('animgraph_nvd_')) return true;
  if (low.startsWith('nvd_')) return true;
  if (low.includes('nvidia')) return true;
  return false;
}

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

function disposeThreeObject(obj) {
  if (!obj) return;
  obj.traverse?.((n) => {
    if (n?.geometry) {
      try { n.geometry.dispose?.(); } catch { /* ignore */ }
    }
    const mat = n?.material;
    const mats = Array.isArray(mat) ? mat : (mat ? [mat] : []);
    for (const m of mats) {
      if (!m) continue;
      for (const k of ['map', 'normalMap', 'metalnessMap', 'roughnessMap', 'emissiveMap', 'aoMap']) {
        const t = m[k];
        if (t && t.isTexture) {
          try { t.dispose?.(); } catch { /* ignore */ }
        }
      }
      try { m.dispose?.(); } catch { /* ignore */ }
    }
  });
}

function isUsdExt(ext) {
  return ext === '.usd' || ext === '.usda' || ext === '.usdc' || ext === '.usdz';
}

export class ModelViewerTool {
  constructor() {
    this.id = 'model_viewer';
    this.label = 'Model Viewer';

    this._ctx = null;
    this._root = null;

    this._canvas = null;
    this._renderer = null;
    this._scene = null;
    this._camera = null;
    this._controls = null;
    this._clock = new THREE.Clock();

    this._gltf = null;
    this._modelRoot = null;
    this._mixer = null;
    this._actions = [];
    this._activeAction = null;
    this._skeletonHelpers = [];
    this._grid = null;

    this._state = {
      modelUrl: '',
      textureOverrideUrl: '',
      showGrid: true,
      showSkeleton: false,
      wireframe: false,
      playing: true,
      speed: 1.0,
      animName: '',

      // Animation library UI (for large multi-clip assets)
      animLibVendor: 'all', // all | nvidia | other
      animLibMax: 200,
    };

    this._modelUrlInputEl = null;
    this._animSelectEl = null;
    this._uiLoadedStatusEl = null;
    this._uiAnimLibFilterEl = null;
    this._uiAnimLibListEl = null;

    this._lastStorageModelUrlSeen = '';

    // Model library state
    this._libSource = 'project'; // project | omniverse
    this._libQuery = '';
    this._libOmniPack = '(all)';
    this._libItems = [];
    this._libListEl = null;
    this._libStatusEl = null;
    this._libOmniPackSel = null;

    // Restore lightweight UI prefs
    try { this._libSource = String(localStorage.getItem('devtools.modelViewer.libSource') || this._libSource); } catch { /* ignore */ }
    try { this._libQuery = String(localStorage.getItem('devtools.modelViewer.libQuery') || this._libQuery); } catch { /* ignore */ }
    try { this._libOmniPack = String(localStorage.getItem('devtools.modelViewer.libOmniPack') || this._libOmniPack); } catch { /* ignore */ }
    try { this._state.animLibVendor = String(localStorage.getItem('devtools.modelViewer.animLibVendor') || this._state.animLibVendor); } catch { /* ignore */ }
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;

    // Sync model url from other tools.
    let syncedFromStorage = false;
    try {
      const saved = String(localStorage.getItem('devtools.lastGeneratedModelUrl') || '').trim();
      if (saved && saved !== this._lastStorageModelUrlSeen) {
        this._state.modelUrl = saved;
        this._lastStorageModelUrlSeen = saved;
        syncedFromStorage = true;
      }
    } catch { /* ignore */ }

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
    renderer.setClearColor(new THREE.Color(0x07090d), 1.0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this._renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x07090d);
    this._scene = scene;

    const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 200000);
    camera.position.set(3.0, 2.2, 4.0);
    this._camera = camera;

    const controls = new OrbitControls(camera, this._canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.target.set(0, 1, 0);
    this._controls = controls;

    // Lights
    const hemi = new THREE.HemisphereLight(0xdde8ff, 0x1a2230, 0.95);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.05);
    dir.position.set(6, 10, 4);
    scene.add(dir);

    // Grid + axes
    this._grid = new THREE.GridHelper(10, 10, 0x3a4a64, 0x223046);
    this._grid.material.opacity = 0.55;
    this._grid.material.transparent = true;
    scene.add(this._grid);
    scene.add(new THREE.AxesHelper(1.0));

    this._buildUi();

    // Auto-load on mount if we have a URL.
    try {
      const u = String(this._state.modelUrl || '').trim();
      if (u) await this._loadModel(u);
    } catch (e) {
      ctx?.log?.(`Viewer: auto-load failed: ${e?.message || e}`);
      ctx?.toast?.(String(e?.message || e || 'Auto-load failed'), 'error', { title: 'Model viewer' });
      if (syncedFromStorage) {
        try { localStorage.removeItem('devtools.lastGeneratedModelUrl'); } catch { /* ignore */ }
        this._lastStorageModelUrlSeen = '';
        if (String(this._state.modelUrl || '').trim()) this._state.modelUrl = '';
        try { if (this._modelUrlInputEl) this._modelUrlInputEl.value = ''; } catch { /* ignore */ }
        ctx?.log?.('Viewer: cleared stale saved model URL');
      }
    }
  }

  async unmount() {
    try { this._clearModel(); } catch { /* ignore */ }
    try { this._controls?.dispose?.(); } catch { /* ignore */ }
    try { this._renderer?.dispose?.(); } catch { /* ignore */ }

    this._controls = null;
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

    this._controls?.update?.();

    const delta = Math.max(0, Math.min(0.25, Number(dt) || 0));
    if (this._mixer && this._state.playing) {
      const s = clamp(this._state.speed, 0.0, 10.0);
      this._mixer.update(delta * s);
    }

    this._renderer.render(this._scene, this._camera);
  }

  getStats() {
    return {
      model: this._state.modelUrl || '',
      clips: Array.isArray(this._gltf?.animations) ? this._gltf.animations.length : 0,
      active: this._state.animName || '',
    };
  }

  _buildUi() {
    if (!this._root) return;
    clear(this._root);
    const ctx = this._ctx;
    const st = this._state;

    const detailsCard = (title, { open = true, hint = '' } = {}, children = []) => el('details', { class: 'card', open: !!open }, [
      el('summary', {}, [
        el('div', { class: 'dockTitle' }, [String(title || 'Section')]),
        hint ? el('div', { class: 'muted', style: { marginLeft: 'auto', textAlign: 'right' } }, [String(hint)]) : el('div', {}),
      ]),
      el('div', { class: 'cardBody' }, children),
    ]);

    const modelUrl = el('input', {
      value: st.modelUrl,
      placeholder: 'assets/.../model.glb',
      oninput: (e) => { st.modelUrl = String(e.target.value || '').trim(); },
    });
    this._modelUrlInputEl = modelUrl;

    const loadBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { await this._loadModel(st.modelUrl); }
        catch (e) {
          ctx?.log?.(`Viewer: load failed: ${e?.message || e}`);
          ctx?.toast?.(String(e?.message || e || 'Load failed'), 'error', { title: 'Load model failed' });
        }
      },
    }, ['Load model']);

    const texUrl = el('input', {
      value: st.textureOverrideUrl,
      placeholder: 'assets/.../albedo.png (optional override)',
      oninput: (e) => { st.textureOverrideUrl = String(e.target.value || '').trim(); },
    });

    const applyTex = el('button', {
      onclick: async () => {
        try { await this._applyTextureOverride(st.textureOverrideUrl); }
        catch (e) {
          ctx?.log?.(`Viewer: texture override failed: ${e?.message || e}`);
          ctx?.toast?.(String(e?.message || e || 'Texture override failed'), 'error', { title: 'Texture override' });
        }
      },
    }, ['Apply texture']);

    const animSel = el('select', { value: st.animName, onchange: (e) => { this._setAnimation(String(e.target.value || '')); } }, [
      el('option', { value: '' }, ['(no animation)']),
    ]);
    this._animSelectEl = animSel;

    const loadedStatus = el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-wrap' } }, ['']);
    this._uiLoadedStatusEl = loadedStatus;

    const playing = el('input', {
      type: 'checkbox',
      checked: !!st.playing,
      onchange: (e) => { st.playing = !!e.target.checked; },
    });
    const speed = el('input', {
      value: String(st.speed),
      oninput: (e) => { st.speed = clamp(Number(e.target.value) || 1.0, 0.0, 10.0); },
    });

    const showSkeleton = el('input', {
      type: 'checkbox',
      checked: !!st.showSkeleton,
      onchange: (e) => { st.showSkeleton = !!e.target.checked; this._syncSkeletonHelpers(); },
    });
    const wireframe = el('input', {
      type: 'checkbox',
      checked: !!st.wireframe,
      onchange: (e) => { st.wireframe = !!e.target.checked; this._applyWireframe(); },
    });
    const showGrid = el('input', {
      type: 'checkbox',
      checked: !!st.showGrid,
      onchange: (e) => {
        st.showGrid = !!e.target.checked;
        if (this._grid) this._grid.visible = st.showGrid;
      },
    });

    const animLibFilter = el('input', {
      placeholder: 'filter animation library (e.g. walk)',
      value: String(localStorage.getItem('devtools.modelViewer.animLibFilter') || ''),
      oninput: () => {
        try { localStorage.setItem('devtools.modelViewer.animLibFilter', String(animLibFilter.value || '')); } catch { /* ignore */ }
        st.animLibMax = 200;
        this._syncAnimLibrary();
      },
    });
    this._uiAnimLibFilterEl = animLibFilter;

    const animLibVendor = el('select', {
      value: String(st.animLibVendor || 'all'),
      onchange: (e) => {
        st.animLibVendor = String(e.target.value || 'all');
        try { localStorage.setItem('devtools.modelViewer.animLibVendor', String(st.animLibVendor || 'all')); } catch { /* ignore */ }
        st.animLibMax = 200;
        this._syncAnimLibrary();
      },
      title: 'Filter clips by source/vendor (best-effort name heuristic)',
    }, [
      el('option', { value: 'all' }, ['All clips']),
      el('option', { value: 'nvidia' }, ['NVIDIA (@nvidia / NVD / AnimGraph_NVD_*)']),
      el('option', { value: 'other' }, ['Non-NVIDIA']),
    ]);

    const animLibList = el('div', { class: 'scrollArea', style: { height: '180px', marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['(no model loaded)']);
    this._uiAnimLibListEl = animLibList;

    this._root.appendChild(detailsCard('Model', { open: true, hint: 'preview' }, [
      el('div', { class: 'muted' }, ['Loads glTF/GLB and can preview skinning + animations + skeleton. USD/FBX files are auto-converted to GLB.']),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [modelUrl, loadBtn]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [texUrl, applyTex]),
      loadedStatus,
    ]));

    // --- Model Library section ---
    this._root.appendChild(this._buildModelLibrary(ctx));

    this._root.appendChild(detailsCard('Animation (preview)', { open: true, hint: 'viewer' }, [
      el('div', { class: 'row' }, [
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
          playing,
          el('div', { class: 'muted', style: { flex: '1 1 auto' } }, ['Play']),
        ]),
        el('div', {}, [el('div', { class: 'muted' }, ['speed']), speed]),
      ]),
      el('div', { style: { marginTop: '8px' } }, [
        el('div', { class: 'muted' }, ['clip']),
        animSel,
      ]),
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Animation library (loaded asset)']),
      el('div', { class: 'row', style: { marginTop: '6px', gap: '8px' } }, [animLibFilter, animLibVendor]),
      animLibList,
    ]));

    this._root.appendChild(detailsCard('Debug', { open: false }, [
      el('div', { class: 'row' }, [
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
          showSkeleton,
          el('div', { class: 'muted', style: { flex: '1 1 auto' } }, ['Show skeleton']),
        ]),
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
          wireframe,
          el('div', { class: 'muted', style: { flex: '1 1 auto' } }, ['Wireframe']),
        ]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
          showGrid,
          el('div', { class: 'muted', style: { flex: '1 1 auto' } }, ['Show grid']),
        ]),
        el('button', { class: 'danger', onclick: () => this._clearModel() }, ['Clear model']),
      ]),
    ]));

    this._syncLoadedIndicators();
    this._syncAnimLibrary();

    // Auto-populate the model library so results appear immediately.
    void this._refreshModelLibrary();
  }

  _syncLoadedIndicators() {
    const elStatus = this._uiLoadedStatusEl;
    if (!elStatus) return;
    const modelPath = String(this._state?.modelUrl || '').trim();
    const clips = this._gltf?.animations || [];
    const n = Array.isArray(clips) ? clips.length : 0;
    const active = String(this._state?.animName || '').trim();
    const loaded = !!this._gltf;
    elStatus.textContent = [
      `loaded: ${loaded ? 'yes' : 'no'}`,
      `model: ${modelPath || '(none)'}`,
      `clips: ${n}${active ? `   active: ${active}` : ''}`,
    ].join('\n');
  }

  _syncAnimLibrary() {
    const host = this._uiAnimLibListEl;
    if (!host) return;
    clear(host);

    const clips = Array.isArray(this._gltf?.animations) ? this._gltf.animations : [];
    const q = String(this._uiAnimLibFilterEl?.value || '').trim().toLowerCase();
    const active = String(this._state?.animName || '').trim();
    const vendor = String(this._state?.animLibVendor || 'all');
    const max = Math.max(20, Math.min(5000, Number(this._state?.animLibMax) || 200));

    if (!clips.length) {
      host.textContent = '(no animations in loaded asset)';
      return;
    }

    const all = clips.map((c) => {
      const name = String(c?.name || '').trim() || '(unnamed clip)';
      return { name, isNvidia: isNvidiaAnimName(name) };
    });
    const nNvidia = all.reduce((acc, c) => acc + (c.isNvidia ? 1 : 0), 0);
    const nOther = Math.max(0, all.length - nNvidia);

    const filtered = all
      .filter((c) => {
        if (vendor === 'nvidia') return !!c.isNvidia;
        if (vendor === 'other') return !c.isNvidia;
        return true;
      })
      .filter((c) => !q || c.name.toLowerCase().includes(q));

    if (!filtered.length) {
      host.textContent = '(no matches)';
      return;
    }

    const shown = filtered.slice(0, max);

    host.appendChild(el('div', { class: 'muted', style: { marginBottom: '6px', whiteSpace: 'pre-wrap' } }, [
      `showing: ${shown.length}/${filtered.length} match(es)`,
      `total clips: ${all.length}   nvidia: ${nNvidia}   other: ${nOther}`,
    ].join('\n')));

    for (const c of shown) {
      const name = c.name;
      const btn = el('button', {
        class: 'toolBtn' + ((name === active) ? ' active' : ''),
        style: { marginTop: '6px' },
        onclick: () => this._setAnimation(name === '(unnamed clip)' ? '' : name),
        title: 'Click to play this clip',
      }, [name]);
      host.appendChild(btn);
    }

    if (filtered.length > shown.length) {
      host.appendChild(el('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } }, [
        el('button', {
          class: 'primary',
          onclick: () => {
            this._state.animLibMax = Math.min(5000, max + 200);
            this._syncAnimLibrary();
          },
          title: 'Render more clip buttons (keeps UI responsive for big libraries)',
        }, ['Show more (+200)']),
        el('div', { class: 'muted' }, [`(${filtered.length - shown.length} more)`]),
      ]));
    }
  }

  // ---------------------------------------------------------------
  // Model Library – browse & load existing project / omniverse models
  // ---------------------------------------------------------------

  _buildModelLibrary(ctx) {
    const sourceSel = el('select', {
      value: this._libSource,
      onchange: (e) => {
        this._libSource = String(e.target.value || 'project');
        try { localStorage.setItem('devtools.modelViewer.libSource', this._libSource); } catch { /* ignore */ }
        omniSection.style.display = this._libSource === 'omniverse' ? 'block' : 'none';
        this._refreshModelLibrary();
      },
    }, [
      el('option', { value: 'project' }, ['Project models']),
      el('option', { value: 'omniverse' }, ['Omniverse models']),
    ]);

    const queryInput = el('input', {
      value: this._libQuery,
      placeholder: 'filter models (e.g. character)',
      oninput: (e) => {
        this._libQuery = String(e.target.value || '').trim();
        try { localStorage.setItem('devtools.modelViewer.libQuery', this._libQuery); } catch { /* ignore */ }
      },
    });
    queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._refreshModelLibrary(); });

    const refreshBtn = el('button', { class: 'primary', onclick: () => this._refreshModelLibrary() }, ['Search']);

    this._libStatusEl = el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-wrap' } }, ['']);
    this._libListEl = el('div', { class: 'scrollArea', style: { height: '220px', marginTop: '8px' } }, ['(search or browse to populate)']);

    // --- Omniverse-specific controls ---
    const omniPackSel = el('select', {
      value: this._libOmniPack,
      onchange: (e) => {
        this._libOmniPack = String(e.target.value || '(all)');
        try { localStorage.setItem('devtools.modelViewer.libOmniPack', this._libOmniPack); } catch { /* ignore */ }
        this._refreshModelLibrary();
      },
    }, [
      el('option', { value: '(all)' }, ['(all packs)']),
    ]);
    this._libOmniPackSel = omniPackSel;

    const omniSection = el('div', {
      style: { marginTop: '8px', display: this._libSource === 'omniverse' ? 'block' : 'none' },
    }, [
      el('div', { class: 'row', style: { gap: '8px' } }, [
        el('div', { style: { flex: '1 1 auto' } }, [el('div', { class: 'muted' }, ['pack']), omniPackSel]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '6px' } }, [
        'Auto-discovers model entry points (scene USD files, not sub-components like meshes/textures/bones).',
      ]),
    ]);

    // Populate pack list lazily.
    void (async () => {
      try {
        const resp = await fetch('/__devtools_omniverse_packs');
        const j = await resp.json();
        if (!j?.ok) return;
        const packs = Array.isArray(j?.packs) ? j.packs : [];
        for (const p of packs) {
          const name = String(p?.name || '').trim();
          if (!name) continue;
          omniPackSel.appendChild(el('option', { value: name }, [name]));
        }
        omniPackSel.value = this._libOmniPack;
      } catch { /* ignore */ }
    })();

    const card = el('details', { class: 'card', open: true }, [
      el('summary', {}, [
        el('div', { class: 'dockTitle' }, ['Model Library']),
        el('div', { class: 'muted', style: { marginLeft: 'auto', textAlign: 'right' } }, ['browse & load']),
      ]),
      el('div', { class: 'cardBody' }, [
        el('div', { class: 'muted' }, ['Browse existing models from your project or Omniverse packs. GLB/GLTF load directly; USD/FBX auto-convert to GLB on load.']),
        el('div', { class: 'row', style: { marginTop: '8px', gap: '8px' } }, [
          el('div', {}, [el('div', { class: 'muted' }, ['source']), sourceSel]),
        ]),
        omniSection,
        el('div', { class: 'row', style: { marginTop: '8px' } }, [queryInput, refreshBtn]),
        this._libStatusEl,
        this._libListEl,
      ]),
    ]);

    return card;
  }

  async _refreshModelLibrary() {
    const ctx = this._ctx;
    if (!ctx || !this._libListEl) return;

    const list = this._libListEl;
    const status = this._libStatusEl;
    const q = String(this._libQuery || '').trim();
    const isOmni = this._libSource === 'omniverse';

    list.textContent = 'Loading...';
    if (status) status.textContent = isOmni ? 'Scanning Omniverse packs for model entry points...' : 'Searching project models...';

    try {
      let items = [];

      if (isOmni) {
        // Use the curated omniverse models endpoint.
        const pack = String(this._libOmniPack || '(all)').trim();
        const params = new URLSearchParams();
        if (pack && pack !== '(all)') params.set('pack', pack);
        if (q) params.set('query', q);
        const url = `/__devtools_omniverse_models?${params.toString()}`;
        const resp = await fetch(url);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'omniverse models endpoint failed'));
        items = Array.isArray(j?.models) ? j.models : [];
      } else {
        // Project models via asset index.
        const query = q || 'assets/';
        const ext = '.glb,.gltf';
        const itemsRaw = await ctx.assetIndex({ query, ext });
        items = (Array.isArray(itemsRaw) ? itemsRaw : [])
          .filter((it) => !String(it?.path || '').includes('assets/external/omniverse/'));
        // Sort project models by modification time (newest first).
        items.sort((a, b) => (Number(b?.mtimeMs) || 0) - (Number(a?.mtimeMs) || 0));
      }

      this._libItems = items;

      if (!items.length) {
        list.textContent = '(no models found)';
        if (status) status.textContent = isOmni ? 'No model entry points found in selected pack(s).' : '0 project models found.';
        return;
      }

      clear(list);
      const show = items.slice(0, 400);

      for (const it of show) {
        const p = String(it?.path || '');
        if (!p) continue;
        const bytes = Number(it?.bytes) || 0;
        const sizeMiB = bytes > 0 ? ` (${(bytes / (1024 * 1024)).toFixed(2)} MiB)` : '';
        const pExt = (p.lastIndexOf('.') >= 0 ? p.slice(p.lastIndexOf('.')).toLowerCase() : '');
        const canLoadDirect = pExt === '.glb' || pExt === '.gltf';

        // For omniverse models, show curated label: name + category + pack.
        let label;
        if (isOmni) {
          const name = String(it?.name || p.split('/').pop() || p);
          const category = String(it?.category || '').replace(/^Assets\/?/i, '');
          const packName = String(it?.pack || '');
          label = `${name}${category ? ` — ${category}` : ''}${packName ? ` [${packName}]` : ''}${sizeMiB}`;
        } else {
          label = `${p}${sizeMiB}`;
        }

        const row = el('div', { style: { marginTop: '6px' } });

        const btn = el('button', {
          class: 'toolBtn',
          style: { width: '100%' },
          onclick: async () => {
            try {
              this._state.modelUrl = p;
              if (this._modelUrlInputEl) this._modelUrlInputEl.value = p;
              await this._loadModel(p);
            } catch (e) {
              ctx?.log?.(`Viewer: load failed: ${e?.message || e}`);
            }
          },
          title: canLoadDirect
            ? `Click to load in viewer\n${p}`
            : `Click to load in viewer (auto-converts ${pExt.toUpperCase().slice(1)} → GLB)\n${p}`,
        }, [label]);

        row.appendChild(btn);

        // For non-GLB files, add a small conversion hint.
        if (!canLoadDirect) {
          row.appendChild(el('div', {
            class: 'muted',
            style: { fontSize: '11px', marginTop: '2px', paddingLeft: '4px' },
          }, [`${pExt.toUpperCase().slice(1)} → auto-converts to GLB on load`]));
        }

        list.appendChild(row);
      }

      if (status) {
        const src = isOmni ? 'Omniverse model entry points' : 'project models';
        status.textContent = `${items.length} ${src}${items.length > show.length ? ` (showing ${show.length})` : ''}`;
      }
    } catch (e) {
      list.textContent = `(error) ${e?.message || e}`;
    }
  }

  async _convertToGlb(inputPath) {
    const ctx = this._ctx;
    const p = String(inputPath || '').trim();
    if (!p) throw new Error('Missing input path');

    const statusEl = this._uiLoadedStatusEl;
    if (statusEl) statusEl.textContent = `Converting ${p} → GLB...`;
    ctx?.log?.(`Viewer: converting ${p} → GLB`);

    // Preflight: prevent wasting time converting meshless USDs (common for motion-only stages).
    // Best-effort only: if inspection isn't available, continue with conversion.
    const ext = p.lastIndexOf('.') >= 0 ? p.slice(p.lastIndexOf('.')).toLowerCase() : '';
    if (isUsdExt(ext)) {
      try {
        if (statusEl) statusEl.textContent = `Preflight USD (mesh check): ${p}`;
        const ir = await fetch('/__devtools_usd_inspect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runner: 'blender_5', inputPath: p }),
        });
        const ij = await ir.json();
        const summary = ij?.json;
        if (ij?.ok && summary?.ok) {
          const stats = summary?.stats || {};
          const meshCount = Number(stats.meshCount) || 0;
          if (meshCount <= 0) {
            const skelAnim = Number(stats.skelAnimationCount) || 0;
            const skelRoot = Number(stats.skelRootCount) || 0;
            if (skelAnim <= 0) {
              throw new Error(
                `USD has no Mesh prims (meshCount=0) and no SkelAnimation prims (skelAnim=0). (skelRoot=${skelRoot}) Pick a character/body USD that includes geometry.`
              );
            }
            // Motion-only USDs are valid inputs for conversion (armature + clips).
            // The viewer may render "empty" (no mesh), but the resulting GLB is useful for retargeting.
            ctx?.log?.(`Viewer: USD preflight: motion-only (meshCount=0, skelAnim=${skelAnim}, skelRoot=${skelRoot}) → allowing convert`);
            if (statusEl) statusEl.textContent = `Preflight USD: motion-only (meshCount=0, skelAnim=${skelAnim}) — converting anyway`;
          }
        }
      } catch (e) {
        // If this is a definitive "no mesh" failure, stop conversion.
        const msg = String(e?.message || e || '');
        if (msg.toLowerCase().includes('no mesh') || msg.toLowerCase().includes('meshcount=0')) {
          ctx?.log?.(`Viewer: convert blocked: ${msg}`);
          if (statusEl) statusEl.textContent = `Convert blocked: ${msg}`;
          throw e;
        }
        // Otherwise treat as best-effort and continue.
        ctx?.log?.(`Viewer: USD preflight skipped: ${e?.message || e}`);
      }
    }

    // Start conversion job.
    const resp = await fetch('/__devtools_convert_start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runner: 'conda_trellis',
        inPath: p,
        blenderPath: '',
        exportFormat: 'GLB',
        outName: '',
        splitMeshes: false,
      }),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'convert start failed'));

    const jobId = String(j.id || '');
    let outGlb = String(j.outGlb || '');
    if (statusEl) statusEl.textContent = `Converting... (job ${jobId})`;

    // Poll until done.
    let backoff = 400;
    while (true) {
      await new Promise((r) => setTimeout(r, backoff));
      const pr = await fetch(`/__devtools_convert_job?id=${encodeURIComponent(jobId)}`);
      const pj = await pr.json();
      if (!pj?.ok) throw new Error(String(pj?.error || 'job query failed'));
      const status = String(pj.status || '');
      outGlb = String(pj.outGlb || outGlb || '');

      if (statusEl) {
        const stderr = String(pj.stderr || '').trim();
        const lastLine = stderr ? stderr.split('\n').filter(Boolean).pop() : '';
        statusEl.textContent = `Converting: ${status}${lastLine ? `\n${lastLine}` : ''}`;
      }

      if (status === 'done') {
        if (!outGlb) throw new Error('Convert finished but no output GLB');
        ctx?.log?.(`Viewer: convert done → ${outGlb}`);
        return outGlb;
      }
      if (status === 'error' || status === 'killed') {
        const stderr = String(pj.stderr || '').trim();
        throw new Error(`Convert ${status}${stderr ? `: ${stderr.split('\n').pop()}` : ''}`);
      }
      backoff = 500;
    }
  }

  async _loadModel(url) {
    const ctx = this._ctx;
    let u = String(url || '').trim();
    if (!u) throw new Error('Missing model url');
    if (!this._scene) return;

    // If the file is USD/FBX, auto-convert to GLB first.
    const ext = u.lastIndexOf('.') >= 0 ? u.slice(u.lastIndexOf('.')).toLowerCase() : '';
    const needsConvert = ext === '.usd' || ext === '.usda' || ext === '.usdc' || ext === '.usdz' || ext === '.fbx';
    if (needsConvert) {
      u = await this._convertToGlb(u);
      this._state.modelUrl = u;
      if (this._modelUrlInputEl) this._modelUrlInputEl.value = u;
    }

    ctx?.log?.(`Viewer: loading ${u}`);
    this._clearModel();

    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(u);
    this._gltf = gltf;
    this._modelRoot = gltf.scene || null;
    if (!this._modelRoot) throw new Error('glTF missing scene');

    this._scene.add(this._modelRoot);

    // Fit camera to model bounds.
    const box = new THREE.Box3().setFromObject(this._modelRoot);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const radius = Math.max(0.25, size.length() * 0.5);
    this._controls.target.copy(center);
    this._camera.position.copy(center).add(new THREE.Vector3(radius * 1.2, radius * 0.65, radius * 1.2));
    this._camera.near = Math.max(0.01, radius * 0.01);
    this._camera.far = Math.max(50, radius * 50);
    this._camera.updateProjectionMatrix();
    this._controls.update();

    // Animations
    this._actions = [];
    this._activeAction = null;
    this._mixer = null;
    if (Array.isArray(gltf.animations) && gltf.animations.length) {
      this._mixer = new THREE.AnimationMixer(this._modelRoot);
      for (const clip of gltf.animations) {
        const a = this._mixer.clipAction(clip);
        this._actions.push(a);
      }
      const first = gltf.animations[0];
      this._setAnimation(first?.name || '');
    } else {
      this._setAnimation('');
    }

    this._applyWireframe();
    this._syncSkeletonHelpers();

    this._refreshAnimSelect();
    this._syncLoadedIndicators();
    this._syncAnimLibrary();

    ctx?.log?.(`Viewer: loaded (${gltf.animations?.length || 0} clips)`);

    // Publish the active model so other tools (Rigging/Animation/etc) can pick it up.
    // This repo uses this key as a shared "active/last opened model" channel.
    try {
      localStorage.setItem('devtools.lastGeneratedModelUrl', u);
      this._lastStorageModelUrlSeen = u;
    } catch { /* ignore */ }
  }

  _clearModel() {
    if (!this._scene) return;

    for (const h of this._skeletonHelpers) {
      try { this._scene.remove(h); } catch { /* ignore */ }
    }
    this._skeletonHelpers = [];

    if (this._activeAction) {
      try { this._activeAction.stop(); } catch { /* ignore */ }
    }
    this._actions = [];
    this._activeAction = null;
    this._mixer = null;

    if (this._modelRoot) {
      try { this._scene.remove(this._modelRoot); } catch { /* ignore */ }
      try { disposeThreeObject(this._modelRoot); } catch { /* ignore */ }
    }
    this._modelRoot = null;
    this._gltf = null;

    this._refreshAnimSelect();
    this._syncLoadedIndicators();
    this._syncAnimLibrary();
  }

  _refreshAnimSelect() {
    const sel = this._animSelectEl;
    if (!sel) return;
    const st = this._state;
    clear(sel);
    sel.appendChild(el('option', { value: '' }, ['(no animation)']));
    const clips = this._gltf?.animations || [];
    for (const c of clips) {
      const name = String(c?.name || '').trim();
      sel.appendChild(el('option', { value: name }, [name || '(unnamed clip)']));
    }
    sel.value = String(st.animName || '');
    this._syncLoadedIndicators();
  }

  _setAnimation(name) {
    const st = this._state;
    const n = String(name || '');
    st.animName = n;
    if (!this._mixer) return;

    if (this._activeAction) {
      try { this._activeAction.stop(); } catch { /* ignore */ }
      this._activeAction = null;
    }

    const clips = this._gltf?.animations || [];
    const clip = clips.find((c) => String(c?.name || '') === n) || null;
    if (!clip) return;

    const action = this._mixer.clipAction(clip);
    action.reset();
    action.play();
    this._activeAction = action;
    if (this._animSelectEl) this._animSelectEl.value = n;
    this._syncLoadedIndicators();
    this._syncAnimLibrary();
  }

  _applyWireframe() {
    const wf = !!this._state.wireframe;
    if (!this._modelRoot) return;
    this._modelRoot.traverse((n) => {
      const mat = n?.material;
      const mats = Array.isArray(mat) ? mat : (mat ? [mat] : []);
      for (const m of mats) {
        if (!m) continue;
        if ('wireframe' in m) m.wireframe = wf;
        m.needsUpdate = true;
      }
    });
  }

  _syncSkeletonHelpers() {
    if (!this._scene) return;

    // Remove existing
    for (const h of this._skeletonHelpers) {
      try { this._scene.remove(h); } catch { /* ignore */ }
    }
    this._skeletonHelpers = [];

    if (!this._state.showSkeleton || !this._modelRoot) return;
    this._modelRoot.traverse((n) => {
      if (n && n.isSkinnedMesh) {
        const h = new THREE.SkeletonHelper(n);
        h.material.linewidth = 1;
        this._scene.add(h);
        this._skeletonHelpers.push(h);
      }
    });
  }

  async _applyTextureOverride(url) {
    const ctx = this._ctx;
    const u = String(url || '').trim();
    if (!u) throw new Error('Missing texture url');
    if (!this._modelRoot) throw new Error('Load a model first');

    ctx?.log?.(`Viewer: loading texture ${u}`);
    const tl = new THREE.TextureLoader();
    const tex = await tl.loadAsync(u);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false; // glTF convention
    tex.needsUpdate = true;

    let changed = 0;
    this._modelRoot.traverse((n) => {
      const mat = n?.material;
      const mats = Array.isArray(mat) ? mat : (mat ? [mat] : []);
      for (const m of mats) {
        if (!m) continue;
        if ('map' in m) {
          m.map = tex;
          m.needsUpdate = true;
          changed++;
        }
      }
    });

    ctx?.log?.(`Viewer: applied texture to ${changed} material(s)`);
  }
}

