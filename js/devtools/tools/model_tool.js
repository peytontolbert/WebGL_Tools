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

export class ModelTool {
  constructor() {
    this.id = 'model';
    this.label = 'Model / Rig / Anim';

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

    this._state = {
      modelUrl: '',
      textureOverrideUrl: '',
      showGrid: true,
      showSkeleton: false,
      wireframe: false,
      playing: true,
      speed: 1.0,
      animName: '',

      // Conversion (USD/FBX/etc -> GLB)
      convertSplitMeshes: false,

      // Animation library UI (for large multi-clip assets)
      animLibVendor: 'all', // all | nvidia | other
      animLibMax: 200, // "show first N" with a Show More button

      // Rigging
      rigRunner: 'conda_trellis', // python3 | conda_trellis
      rigBackend: 'rigify',
      blenderPath: '',
      rigArgs: '--deform-only',
      rigOutName: '',
      rigJobAutoLoad: 1,

      // Retarget animation onto rig
      animRunner: 'conda_trellis', // python3 | conda_trellis
      motionUrl: '',
      mapUrl: 'tools/rigging/mappings/example_map.json',
      motionClip: '',
      clipName: 'walk',
      animBlenderPath: '',
      rootMotion: 0,
      includeMesh: 1,
      exportFormat: 'GLB',
      animOutName: '',
      animJobAutoLoad: 1,

      // Outfit / clothing (attach meshes to an existing rigged base)
      outfitRunner: 'conda_trellis', // python3 | conda_trellis
      outfitBaseRigUrl: '',
      outfitClothesText: '',
      outfitBlenderPath: '',
      outfitArgs: '--weight-method transfer',
      outfitOutName: '',
      outfitJobAutoLoad: 1,
    };

    this._rigJob = { id: '', status: '', stdout: '', stderr: '', outRig: '' };
    this._animJob = { id: '', status: '', stdout: '', stderr: '', outGlb: '' };
    this._outfitJob = { id: '', status: '', stdout: '', stderr: '', outGlb: '' };
    this._convertJob = { id: '', status: '', stdout: '', stderr: '', outGlb: '', outMeshesDir: '', outMeshes: [] };
    this._pollingRig = false;
    this._pollingAnim = false;
    this._pollingOutfit = false;
    this._pollingConvert = false;

    this._modelUrlInputEl = null;

    // UI: loaded indicators + animation library
    this._uiLoadedStatusEl = null;
    this._uiAnimLibFilterEl = null;
    this._uiAnimLibListEl = null;

    // Tracks the last localStorage "lastGeneratedModelUrl" we synced from.
    // This lets other tools (Assets/ZImage/Trellis) drive the initial model
    // URL without clobbering a user's manually-entered URL on every mount.
    this._lastStorageModelUrlSeen = '';

    // Conversion UI preference: auto-enable split meshes for USD unless user overrides.
    this._convertSplitMeshesUserSet = false;
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;

    // Restore last generated model (e.g. from Trellis/ZImage tools).
    let syncedFromStorage = false;
    try {
      const saved = String(localStorage.getItem('devtools.lastGeneratedModelUrl') || '').trim();
      // NOTE: Tool instances persist across unmount/mount, so `_state.modelUrl`
      // may still hold a stale URL from a previous session. If the storage value
      // changed since we last saw it, prefer the new storage value.
      if (saved && saved !== this._lastStorageModelUrlSeen) {
        this._state.modelUrl = saved;
        this._lastStorageModelUrlSeen = saved;
        syncedFromStorage = true;
      }
    } catch { /* ignore */ }

    // Restore last-used Blender paths (portable installs, etc).
    try {
      const p = String(localStorage.getItem('devtools.lastRigBlenderPath') || '').trim();
      if (p && !this._state.blenderPath) this._state.blenderPath = p;
    } catch { /* ignore */ }
    try {
      const p = String(localStorage.getItem('devtools.lastAnimBlenderPath') || '').trim();
      if (p && !this._state.animBlenderPath) this._state.animBlenderPath = p;
    } catch { /* ignore */ }
    try {
      const p = String(localStorage.getItem('devtools.lastOutfitBlenderPath') || '').trim();
      if (p && !this._state.outfitBlenderPath) this._state.outfitBlenderPath = p;
    } catch { /* ignore */ }

    // Restore last-used retarget inputs.
    try {
      const savedMotion = String(localStorage.getItem('devtools.lastMotionUrl') || '').trim();
      if (savedMotion && !this._state.motionUrl) this._state.motionUrl = savedMotion;
    } catch { /* ignore */ }
    try {
      const savedMotionClip = String(localStorage.getItem('devtools.lastMotionClip') || '').trim();
      if (savedMotionClip && !this._state.motionClip) this._state.motionClip = savedMotionClip;
    } catch { /* ignore */ }
    try {
      const savedMap = String(localStorage.getItem('devtools.lastAnimMapUrl') || '').trim();
      const defaultMap = 'tools/rigging/mappings/example_map.json';
      if (savedMap && (String(this._state.mapUrl || '').trim() === defaultMap)) this._state.mapUrl = savedMap;
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
      ctx?.log?.(`Model: auto-load failed: ${e?.message || e}`);
      // If the autoload came from storage, it may be a stale file that no longer
      // exists (e.g. outputs cleaned, dev server restarted). Clear it so we
      // don't keep forcing a broken URL on subsequent opens.
      if (syncedFromStorage) {
        try { localStorage.removeItem('devtools.lastGeneratedModelUrl'); } catch { /* ignore */ }
        this._lastStorageModelUrlSeen = '';
        if (String(this._state.modelUrl || '').trim()) this._state.modelUrl = '';
        try { if (this._modelUrlInputEl) this._modelUrlInputEl.value = ''; } catch { /* ignore */ }
        ctx?.log?.('Model: cleared stale saved model URL');
      }
    }
  }

  async unmount() {
    this._pollingRig = false;
    this._pollingAnim = false;
    this._pollingOutfit = false;
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

    const copyBtn = (v) => el('button', {
      onclick: async () => { try { await navigator.clipboard.writeText(String(v || '')); } catch { /* ignore */ } },
      title: 'Copy to clipboard',
    }, ['Copy']);

    const ctxRow = (label, value, actions = []) => el('div', { style: { marginTop: '8px' } }, [
      el('div', { class: 'muted' }, [String(label || '')]),
      el('div', { class: 'row', style: { gap: '8px', marginTop: '6px' } }, [
        el('div', {
          class: 'kbd',
          style: { flex: '1 1 auto', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
          title: String(value || ''),
        }, [String(value || '(none)')]),
        ...actions,
      ]),
    ]);

    // Convenience: if the user is currently viewing a rig/model, use it as outfit base by default.
    if (!String(st.outfitBaseRigUrl || '').trim() && String(st.modelUrl || '').trim()) {
      st.outfitBaseRigUrl = String(st.modelUrl || '').trim();
    }

    const modelUrl = el('input', {
      value: st.modelUrl,
      placeholder: 'assets/.../model.glb',
      oninput: (e) => { st.modelUrl = String(e.target.value || '').trim(); },
    });
    this._modelUrlInputEl = modelUrl;

    const useGameplayAvatarBtn = el('button', {
      title: 'Use gameplay.avatarUrl as model input (from the main app)',
      onclick: () => {
        try {
          const saved = String(localStorage.getItem('gameplay.avatarUrl') || '').trim();
          if (!saved) return;
          st.modelUrl = saved;
          modelUrl.value = saved;
        } catch { /* ignore */ }
      },
    }, ['Use gameplay avatar']);

    // Heuristic default: if input looks like USD, auto-enable split-mesh conversion (unless user has overridden).
    try {
      const u = String(st.modelUrl || '').trim().toLowerCase();
      const isUsd = u.endsWith('.usd') || u.endsWith('.usda') || u.endsWith('.usdc') || u.endsWith('.usdz');
      if (isUsd && !this._convertSplitMeshesUserSet) st.convertSplitMeshes = true;
    } catch { /* ignore */ }

    const loadBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { await this._loadModel(st.modelUrl); }
        catch (e) { ctx?.log(`Model: load failed: ${e?.message || e}`); }
      },
    }, ['Load model']);

    const convertStatus = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
    const convertLog = el('div', { class: 'scrollArea', style: { height: '140px', marginTop: '8px', whiteSpace: 'pre' } }, ['(no convert job yet)']);
    const convertSplitMeshes = el('input', {
      type: 'checkbox',
      checked: !!st.convertSplitMeshes,
      onchange: (e) => {
        st.convertSplitMeshes = !!e.target.checked;
        this._convertSplitMeshesUserSet = true;
      },
    });
    const convertBtn = el('button', {
      onclick: async () => {
        try { convertBtn.disabled = true; } catch { /* ignore */ }
        try {
          await this._startConvertJob({
            inPath: st.modelUrl,
            runner: st.rigRunner || 'conda_trellis',
            blenderPath: st.blenderPath || '',
            exportFormat: 'GLB',
            outName: (String(st.modelUrl || '').split('/').pop() || '').replace(/\.[^.]+$/g, ''),
            splitMeshes: !!st.convertSplitMeshes,
            statusEl: convertStatus,
            logEl: convertLog,
            autoLoad: true,
          });
        } catch (e) {
          ctx?.log?.(`Convert: start failed: ${e?.message || e}`);
          convertStatus.textContent = `Convert start failed: ${e?.message || e}`;
        }
        try { convertBtn.disabled = false; } catch { /* ignore */ }
      },
      title: 'Convert USD/FBX/etc to GLB for preview/runtime',
    }, ['Convert → GLB']);

    const texUrl = el('input', {
      value: st.textureOverrideUrl,
      placeholder: 'assets/.../albedo.png (optional override)',
      oninput: (e) => { st.textureOverrideUrl = String(e.target.value || '').trim(); },
    });

    const applyTex = el('button', {
      onclick: async () => {
        try { await this._applyTextureOverride(st.textureOverrideUrl); }
        catch (e) { ctx?.log(`Model: texture override failed: ${e?.message || e}`); }
      },
    }, ['Apply texture']);

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

    const animSel = el('select', { value: st.animName, onchange: (e) => { this._setAnimation(String(e.target.value || '')); } }, [
      el('option', { value: '' }, ['(no animation)']),
    ]);
    this._animSelectEl = animSel;

    // Indicators: what's actually loaded, and what clips exist.
    const loadedStatus = el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-wrap' } }, ['']);
    this._uiLoadedStatusEl = loadedStatus;

    const animLibFilter = el('input', {
      placeholder: 'filter animation library (e.g. walk)',
      value: '',
      oninput: () => {
        st.animLibMax = 200;
        this._syncAnimLibrary();
      },
    });
    this._uiAnimLibFilterEl = animLibFilter;

    const animLibVendor = el('select', {
      value: String(st.animLibVendor || 'all'),
      onchange: (e) => {
        st.animLibVendor = String(e.target.value || 'all');
        st.animLibMax = 200;
        this._syncAnimLibrary();
      },
      title: 'Filter clips by source/vendor (best-effort name heuristic)',
    }, [
      el('option', { value: 'all' }, ['All clips']),
      el('option', { value: 'nvidia' }, ['NVIDIA (@nvidia / NVD / AnimGraph_NVD_*)']),
      el('option', { value: 'other' }, ['Non-NVIDIA']),
    ]);

    const animLibList = el('div', { class: 'scrollArea', style: { height: '140px', marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['(no model loaded)']);
    this._uiAnimLibListEl = animLibList;

    const assetPickModel = this._buildAssetPicker({
      title: 'Asset Picker (model)',
      ext: '.glb,.gltf,.usd,.usda,.usdc,.usdz,.fbx',
      onPick: (p) => { st.modelUrl = p; modelUrl.value = p; },
      allowEmptyQuery: true,
    });
    const assetPickTex = this._buildAssetPicker({
      title: 'Asset Picker (texture)',
      ext: '.png,.jpg,.jpeg',
      onPick: (p) => { st.textureOverrideUrl = p; texUrl.value = p; },
    });

    // Rigging UI
    const rigRunner = el('select', {
      value: st.rigRunner,
      onchange: (e) => { st.rigRunner = String(e.target.value || 'conda_trellis'); },
    }, [
      el('option', { value: 'conda_trellis' }, ['conda_trellis']),
      el('option', { value: 'python3' }, ['python3']),
    ]);

    const rigBackend = el('select', {
      value: st.rigBackend,
      onchange: (e) => { st.rigBackend = String(e.target.value || ''); },
    }, [
      el('option', { value: 'rigify' }, ['rigify']),
      el('option', { value: 'blenrig' }, ['blenrig']),
      el('option', { value: 'rigacar' }, ['rigacar']),
      el('option', { value: 'unirig' }, ['unirig']),
      el('option', { value: 'riganything' }, ['riganything']),
      el('option', { value: 'rignet' }, ['rignet']),
    ]);

    const rigArgs = el('input', {
      value: st.rigArgs,
      placeholder: 'extra args for tools/rig_asset.py (optional)',
      oninput: (e) => { st.rigArgs = String(e.target.value || ''); },
    });

    const blenderPath = el('input', {
      value: st.blenderPath,
      placeholder: 'blender executable path (optional, e.g. /usr/bin/blender)',
      oninput: (e) => {
        st.blenderPath = String(e.target.value || '').trim();
        try { localStorage.setItem('devtools.lastRigBlenderPath', st.blenderPath); } catch { /* ignore */ }
      },
    });

    const rigOutName = el('input', {
      value: st.rigOutName,
      placeholder: 'optional output name hint (e.g. hero)',
      oninput: (e) => { st.rigOutName = String(e.target.value || '').trim(); },
    });

    const rigAutoLoad = el('input', {
      type: 'checkbox',
      checked: !!st.rigJobAutoLoad,
      onchange: (e) => { st.rigJobAutoLoad = e.target.checked ? 1 : 0; },
    });

    const rigStatus = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
    const rigLog = el('div', { class: 'scrollArea', style: { height: '160px', marginTop: '8px', whiteSpace: 'pre' } }, ['(no job yet)']);

    const rigStartBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { rigStartBtn.disabled = true; } catch { /* ignore */ }
        try {
          await this._startRigJob({
            inModelPath: st.modelUrl,
            runner: st.rigRunner,
            rigBackend: st.rigBackend,
            rigArgs: st.rigArgs,
            blenderPath: st.blenderPath,
            outName: st.rigOutName,
            statusEl: rigStatus,
            logEl: rigLog,
            autoLoad: !!st.rigJobAutoLoad,
          });
        } catch (e) {
          ctx?.log?.(`Rig: start failed: ${e?.message || e}`);
          rigStatus.textContent = `Rig start failed: ${e?.message || e}`;
        }
        try { rigStartBtn.disabled = false; } catch { /* ignore */ }
      },
    }, ['Auto-rig']);

    const rigKillBtn = el('button', {
      class: 'danger',
      onclick: async () => {
        const id = String(this._rigJob?.id || '');
        if (!id) return;
        try {
          await fetch('/__devtools_rig_kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
        } catch { /* ignore */ }
        this._pollingRig = false;
      },
    }, ['Kill job']);

    const rigCopyBtn = el('button', {
      onclick: async () => {
        const p = String(this._rigJob?.outRig || '');
        if (!p) return;
        try { await navigator.clipboard.writeText(p); ctx?.log?.('Rig: copied output path'); } catch { /* ignore */ }
      },
    }, ['Copy output']);

    const rigOpenViewerBtn = el('button', {
      class: 'primary',
      title: 'Open the rig output in the Model Viewer',
      onclick: () => {
        const p = String(this._rigJob?.outRig || '').trim();
        if (!p) return;
        try { localStorage.setItem('devtools.lastGeneratedModelUrl', p); } catch { /* ignore */ }
        try { globalThis.__devtools?.setActiveTool?.('model_viewer'); } catch { /* ignore */ }
      },
    }, ['Open in viewer']);

    const rigSetGameplayAvatarBtn = el('button', {
      title: 'Set this rig as the gameplay avatar (writes gameplay.avatarUrl)',
      onclick: () => {
        const p = String(this._rigJob?.outRig || '').trim();
        if (!p) return;
        try { localStorage.setItem('gameplay.avatarUrl', p); } catch { /* ignore */ }
        ctx?.toast?.('Set gameplay avatar to rig output', 'success', { title: 'Rigging' });
      },
    }, ['Set gameplay avatar']);

    // Retarget UI
    const animRunner = el('select', {
      value: st.animRunner,
      onchange: (e) => { st.animRunner = String(e.target.value || 'conda_trellis'); },
    }, [
      el('option', { value: 'conda_trellis' }, ['conda_trellis']),
      el('option', { value: 'python3' }, ['python3']),
    ]);

    const motionUrl = el('input', {
      value: st.motionUrl,
      placeholder: 'motion file path (e.g. outputs/walk.bvh, assets/.../walk.fbx, or assets/external/.../*.usd)',
      oninput: (e) => {
        st.motionUrl = String(e.target.value || '').trim();
        try { localStorage.setItem('devtools.lastMotionUrl', st.motionUrl); } catch { /* ignore */ }
      },
    });
    const useTestMotionBtn = el('button', {
      title: 'Set motionPath to outputs/mixamo_idle.bvh',
      onclick: () => {
        const p = 'outputs/mixamo_idle.bvh';
        st.motionUrl = p;
        motionUrl.value = p;
        try { localStorage.setItem('devtools.lastMotionUrl', p); } catch { /* ignore */ }
        ctx?.log?.(`Anim: motionPath set → ${p}`);
      },
    }, ['Use test BVH']);

    const animBlenderPath = el('input', {
      value: st.animBlenderPath,
      placeholder: 'blender executable path (optional, e.g. /usr/bin/blender)',
      oninput: (e) => {
        st.animBlenderPath = String(e.target.value || '').trim();
        try { localStorage.setItem('devtools.lastAnimBlenderPath', st.animBlenderPath); } catch { /* ignore */ }
      },
    });

    const mapUrl = el('input', {
      value: st.mapUrl,
      placeholder: 'tools/rigging/mappings/...json',
      oninput: (e) => {
        st.mapUrl = String(e.target.value || '').trim();
        try { localStorage.setItem('devtools.lastAnimMapUrl', st.mapUrl); } catch { /* ignore */ }
      },
    });

    const inspectStatus = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
    const inspectLog = el('div', { class: 'scrollArea', style: { height: '120px', marginTop: '8px', whiteSpace: 'pre' } }, ['(no inspect output yet)']);
    const runInspect = async (mode) => {
      try {
        const motion = String(st.motionUrl || '').trim();
        if (!motion) throw new Error('Missing motionPath');
        inspectStatus.textContent = `Inspect: running (${mode})...`;
        inspectLog.textContent = '(running...)';
        const resp = await fetch('/__devtools_anim_inspect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            runner: String(st.animRunner || 'conda_trellis'),
            blenderPath: String(st.animBlenderPath || ''),
            inputPath: motion,
            mode: String(mode || 'list-clips'),
          }),
        });
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'inspect failed'));
        const out = String(j.stdout || '');
        const err = String(j.stderr || '');
        const code = (j.exitCode == null) ? null : Number(j.exitCode);
        inspectStatus.textContent = `Inspect: ${(code === 0) ? 'done' : 'error'}${(typeof code === 'number') ? ` (exit ${code})` : ''}`;
        inspectLog.textContent = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output)';
        try { inspectLog.scrollTop = inspectLog.scrollHeight; } catch { /* ignore */ }
      } catch (e) {
        inspectStatus.textContent = `Inspect failed: ${e?.message || e}`;
        inspectLog.textContent = String(e?.stack || e?.message || e || '(unknown error)');
      }
    };
    const listClipsBtn = el('button', {
      title: 'List action/clip names found in the motion file (use for motionClip)',
      onclick: () => runInspect('list-clips'),
    }, ['List clips']);
    const printBonesBtn = el('button', {
      title: 'Print bone names for the motion file (use for mapping)',
      onclick: () => runInspect('print-bones'),
    }, ['Print bones']);
    const validateMapBtn = el('button', {
      title: 'Validate that the selected mapping references bones that exist in both source + target rigs',
      onclick: async () => {
        try {
          const rigPath = String(st.modelUrl || '').trim();
          const motionPath = String(st.motionUrl || '').trim();
          const mapPath = String(st.mapUrl || '').trim();
          if (!rigPath) throw new Error('Load or enter a model (rig) path first');
          if (!motionPath) throw new Error('Set motionPath first');
          if (!mapPath) throw new Error('Set mapPath first');

          inspectStatus.textContent = 'Validate map: running...';
          inspectLog.textContent = '(running...)';
          const resp = await fetch('/__devtools_anim_validate_map', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              runner: st.animRunner,
              blenderPath: st.animBlenderPath,
              rigPath,
              motionPath,
              mapPath,
            }),
          });
          const j = await resp.json();
          if (!j?.ok) throw new Error(String(j?.error || 'validate map failed'));
          const out = String(j.stdout || '');
          const err = String(j.stderr || '');
          const code = (j.exitCode == null) ? null : Number(j.exitCode);
          inspectStatus.textContent = `Validate map: ${(code === 0) ? 'OK' : 'error'}${(typeof code === 'number') ? ` (exit ${code})` : ''}`;
          inspectLog.textContent = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output)';
          try { inspectLog.scrollTop = inspectLog.scrollHeight; } catch { /* ignore */ }
        } catch (e) {
          inspectStatus.textContent = `Validate map failed: ${e?.message || e}`;
          inspectLog.textContent = String(e?.stack || e?.message || e || '(unknown error)');
        }
      },
    }, ['Validate map']);

    const motionClip = el('input', {
      value: st.motionClip,
      placeholder: 'source action (motionClip) (e.g. AnimGraph_NVD_10010)',
      oninput: (e) => {
        const v = String(e.target.value || '');
        setMotionClip(v);
      },
    });

    const setMotionClip = (vRaw) => {
      st.motionClip = String(vRaw || '').trim();
      try { localStorage.setItem('devtools.lastMotionClip', st.motionClip); } catch { /* ignore */ }
      // Helpful default: if the user enters an NVIDIA-style action name and
      // they haven't changed the default mapping, switch to the NVIDIA map.
      const defaultMap = 'tools/rigging/mappings/example_map.json';
      const nvdMap = 'tools/rigging/mappings/nvidia_biped_demo_to_zimage.json';
      const looksNvd = isNvidiaAnimName(String(st.motionClip || ''));
      if (looksNvd && String(st.mapUrl || '').trim() === defaultMap) {
        st.mapUrl = nvdMap;
        mapUrl.value = nvdMap;
        try { localStorage.setItem('devtools.lastAnimMapUrl', st.mapUrl); } catch { /* ignore */ }
      }
    };

    const motionClipStatus = el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-wrap' } }, ['']);
    const motionClipSel = el('select', {
      value: '',
      onchange: (e) => {
        const v = String(e.target.value || '').trim();
        if (!v) return;
        setMotionClip(v);
        motionClip.value = st.motionClip;
      },
    }, [
      el('option', { value: '' }, ['(load clips from motion asset)']),
    ]);
    const loadMotionClipsBtn = el('button', {
      title: 'Read action/clip names from the motion asset and populate a dropdown',
      onclick: async () => {
        try {
          const motionPath = String(st.motionUrl || '').trim();
          if (!motionPath) throw new Error('Set motionPath first');

          motionClipStatus.textContent = 'Loading clips...';
          clear(motionClipSel);
          motionClipSel.appendChild(el('option', { value: '' }, ['(loading...)']));

          const resp = await fetch('/__devtools_anim_list_clips', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              runner: st.animRunner,
              blenderPath: st.animBlenderPath,
              motionPath,
            }),
          });
          const j = await resp.json();
          if (!j?.ok) throw new Error(String(j?.error || 'list clips failed'));

          const clips = Array.isArray(j?.clips) ? j.clips : [];
          clear(motionClipSel);
          motionClipSel.appendChild(el('option', { value: '' }, ['(select a clip)']));
          for (const c of clips) {
            const name = String(c?.name || '').trim();
            if (!name) continue;
            const s = (c?.start != null) ? Number(c.start) : null;
            const e = (c?.end != null) ? Number(c.end) : null;
            const label = (Number.isFinite(s) && Number.isFinite(e)) ? `${name}  [${s}..${e}]` : name;
            motionClipSel.appendChild(el('option', { value: name }, [label]));
          }
          motionClipStatus.textContent = `Found ${clips.length} clip(s)`;

          const cur = String(st.motionClip || '').trim();
          if (!cur && clips.length) {
            const first = String(clips[0]?.name || '').trim();
            if (first) {
              setMotionClip(first);
              motionClip.value = st.motionClip;
              motionClipSel.value = first;
            }
          } else {
            motionClipSel.value = cur;
          }
        } catch (e) {
          motionClipStatus.textContent = `Load clips failed: ${e?.message || e}`;
          clear(motionClipSel);
          motionClipSel.appendChild(el('option', { value: '' }, ['(load clips from motion asset)']));
        }
      },
    }, ['Load clips']);

    const clipName = el('input', {
      value: st.clipName,
      placeholder: 'output clip name (optional; defaults to source action)',
      oninput: (e) => { st.clipName = String(e.target.value || '').trim(); },
    });

    const rootMotion = el('input', {
      type: 'checkbox',
      checked: !!st.rootMotion,
      onchange: (e) => { st.rootMotion = e.target.checked ? 1 : 0; },
    });

    const includeMesh = el('input', {
      type: 'checkbox',
      checked: !!st.includeMesh,
      onchange: (e) => { st.includeMesh = e.target.checked ? 1 : 0; },
    });

    const exportFormat = el('select', {
      value: st.exportFormat,
      onchange: (e) => { st.exportFormat = String(e.target.value || 'GLB'); },
    }, [
      el('option', { value: 'GLB' }, ['GLB']),
      el('option', { value: 'GLTF_SEPARATE' }, ['GLTF_SEPARATE']),
    ]);

    const animOutName = el('input', {
      value: st.animOutName,
      placeholder: 'output name (e.g. walk, idle, run_left)',
      oninput: (e) => { st.animOutName = String(e.target.value || '').trim(); },
    });

    const animAutoLoad = el('input', {
      type: 'checkbox',
      checked: !!st.animJobAutoLoad,
      onchange: (e) => { st.animJobAutoLoad = e.target.checked ? 1 : 0; },
    });

    const animStatus = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
    const animLog = el('div', { class: 'scrollArea', style: { height: '160px', marginTop: '8px', whiteSpace: 'pre' } }, ['(no job yet)']);

    const animStartBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { animStartBtn.disabled = true; } catch { /* ignore */ }
        try {
          await this._startAnimJob({
            rigPath: st.modelUrl,
            motionPath: st.motionUrl,
            mapPath: st.mapUrl,
            runner: st.animRunner,
            blenderPath: st.animBlenderPath,
            motionClip: st.motionClip,
            clipName: st.clipName,
            exportFormat: st.exportFormat,
            rootMotion: !!st.rootMotion,
            includeMesh: !!st.includeMesh,
            outName: st.animOutName,
            statusEl: animStatus,
            logEl: animLog,
            autoLoad: !!st.animJobAutoLoad,
          });
        } catch (e) {
          ctx?.log?.(`Anim: retarget start failed: ${e?.message || e}`);
          animStatus.textContent = `Anim start failed: ${e?.message || e}`;
        }
        try { animStartBtn.disabled = false; } catch { /* ignore */ }
      },
    }, ['Retarget']);

    const animKillBtn = el('button', {
      class: 'danger',
      onclick: async () => {
        const id = String(this._animJob?.id || '');
        if (!id) return;
        try {
          await fetch('/__devtools_anim_kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
        } catch { /* ignore */ }
        this._pollingAnim = false;
      },
    }, ['Kill job']);

    const animCopyBtn = el('button', {
      onclick: async () => {
        const p = String(this._animJob?.outGlb || '');
        if (!p) return;
        try { await navigator.clipboard.writeText(p); ctx?.log?.('Anim: copied output path'); } catch { /* ignore */ }
      },
    }, ['Copy output']);

    const assetPickMotion = this._buildAssetPicker({
      title: 'Asset Picker (motion)',
      ext: '.bvh,.fbx,.glb,.gltf,.usd,.usda,.usdc,.usdz',
      onPick: (p) => {
        st.motionUrl = p;
        motionUrl.value = p;
        try { localStorage.setItem('devtools.lastMotionUrl', p); } catch { /* ignore */ }
      },
      allowEmptyQuery: true,
    });
    const assetPickAnimMap = this._buildAssetPicker({
      title: 'Asset Picker (retarget map)',
      ext: '.json',
      onPick: (p) => {
        st.mapUrl = p;
        mapUrl.value = p;
        try { localStorage.setItem('devtools.lastAnimMapUrl', p); } catch { /* ignore */ }
      },
      allowEmptyQuery: true,
    });

    // Best-effort: detect skeleton flavor to enable one-click presets.
    const detectSkeletonFlavor = () => {
      try {
        const root = this._modelRoot;
        if (!root) return '';
        const names = [];
        root.traverse?.((n) => {
          if (!n) return;
          const nm = String(n.name || '').trim();
          if (n.isBone && nm) names.push(nm);
        });
        const lower = new Set(names.map((s) => s.toLowerCase()));
        const has = (s) => lower.has(String(s).toLowerCase());
        const unreal = has('pelvis') && has('spine_01') && (has('thigh_l') || has('calf_l') || has('foot_l'));
        if (unreal) return 'unreal_mannequin';
        const mixamo = has('hips') && (has('spine') || has('spine1')) && (has('leftarm') || has('rightarm'));
        if (mixamo) return 'mixamo';
        const rigify = Array.from(lower).some((n) => n.startsWith('def-'));
        if (rigify) return 'rigify';
        return '';
      } catch {
        return '';
      }
    };
    const skelFlavor = detectSkeletonFlavor();

    // ---- Current context (makes this feel like an editor) ----
    // Keep UX uncluttered: a single "Bring to life" CTA that either:
    // - runs a known good preset (UAL2) when we recognize the skeleton, or
    // - opens the Rigging tool with this model prefilled for a guided flow.
    const bringToLifeBtn = el('button', {
      class: 'primary',
      title: (skelFlavor === 'unreal_mannequin')
        ? 'Build a full locomotion pack from UAL2 and open the Locomotion tool.'
        : 'Open Rigging → Bring to life for a guided locomotion setup.',
      onclick: () => {
        const modelUrlNow = String(st.modelUrl || '').trim();
        if (!modelUrlNow) return;
        try { localStorage.setItem('devtools.lastGeneratedModelUrl', modelUrlNow); } catch { /* ignore */ }
        if (skelFlavor === 'unreal_mannequin') {
          const motion = 'assets/external/ual2/UAL2_Standard.glb';
          const map = 'tools/rigging/mappings/unreal_mannequin_identity.json';
          const cfg = {
            modelUrl: modelUrlNow,
            bringToLife: {
              autoRig: 0,
              rigBackend: 'rigify',
              runner: 'conda_trellis',
              blenderPath: '',
              mapUrl: map,
              outName: 'locomotion_pack',
              includeMesh: 1,
              exportFormat: 'GLB',
              clips: {
                idle: { motionPath: motion, motionClip: 'Idle_No_Loop' },
                walk_fwd: { motionPath: motion, motionClip: 'Zombie_Walk_Fwd_Loop' },
                walk_back: { motionPath: motion, motionClip: 'Zombie_Walk_Fwd_Loop' },
                walk_left: { motionPath: motion, motionClip: 'Zombie_Walk_Fwd_Loop' },
                walk_right: { motionPath: motion, motionClip: 'Zombie_Walk_Fwd_Loop' },
                run_fwd: { motionPath: motion, motionClip: 'Zombie_Walk_Fwd_Loop' },
                run_back: { motionPath: motion, motionClip: 'Zombie_Walk_Fwd_Loop' },
                run_left: { motionPath: motion, motionClip: 'Zombie_Walk_Fwd_Loop' },
                run_right: { motionPath: motion, motionClip: 'Zombie_Walk_Fwd_Loop' },
                jump_start: { motionPath: motion, motionClip: 'NinjaJump_Start' },
                jump_air: { motionPath: motion, motionClip: 'NinjaJump_Idle_Loop' },
                jump_land: { motionPath: motion, motionClip: 'NinjaJump_Land' },
              },
            },
          };
          try { localStorage.setItem('devtools.rig.autoBringToLife', JSON.stringify(cfg)); } catch { /* ignore */ }
        }
        try { globalThis.__devtools?.setActiveTool?.('rig'); } catch { /* ignore */ }
      },
    }, ['Bring to life']);

    this._root.appendChild(detailsCard('Current character', { open: true, hint: 'context' }, [
      el('div', { class: 'muted' }, ['What you have selected right now. Use Assets tool for quick picking.']),
      ctxRow('Rig / Model', st.modelUrl, [
        copyBtn(st.modelUrl),
        el('button', { class: 'primary', onclick: async () => { try { await this._loadModel(st.modelUrl); } catch (e) { ctx?.log?.(`Model: load failed: ${e?.message || e}`); } } }, ['Open']),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } }, [
        bringToLifeBtn,
      ]),
      ctxRow('Motion', st.motionUrl, [copyBtn(st.motionUrl)]),
      ctxRow('Retarget map', st.mapUrl, [copyBtn(st.mapUrl)]),
      ctxRow('Last rig output', this._rigJob?.outRig || '', [
        copyBtn(this._rigJob?.outRig || ''),
        el('button', {
          class: 'primary',
          onclick: async () => {
            const p = String(this._rigJob?.outRig || '').trim();
            if (!p) return;
            st.modelUrl = p;
            if (this._modelUrlInputEl) this._modelUrlInputEl.value = p;
            try { await this._loadModel(p); } catch (e) { ctx?.log?.(`Model: load failed: ${e?.message || e}`); }
          },
        }, ['Open']),
      ]),
      ctxRow('Last anim output', this._animJob?.outGlb || '', [
        copyBtn(this._animJob?.outGlb || ''),
        el('button', {
          class: 'primary',
          onclick: async () => {
            const p = String(this._animJob?.outGlb || '').trim();
            if (!p) return;
            st.modelUrl = p;
            if (this._modelUrlInputEl) this._modelUrlInputEl.value = p;
            try { await this._loadModel(p); } catch (e) { ctx?.log?.(`Model: load failed: ${e?.message || e}`); }
          },
        }, ['Open']),
      ]),
      ctxRow('Last outfit output', this._outfitJob?.outGlb || '', [
        copyBtn(this._outfitJob?.outGlb || ''),
        el('button', {
          class: 'primary',
          onclick: async () => {
            const p = String(this._outfitJob?.outGlb || '').trim();
            if (!p) return;
            st.modelUrl = p;
            if (this._modelUrlInputEl) this._modelUrlInputEl.value = p;
            try { await this._loadModel(p); } catch (e) { ctx?.log?.(`Model: load failed: ${e?.message || e}`); }
          },
        }, ['Open']),
      ]),
    ]));

    // ---- Model ----
    this._root.appendChild(detailsCard('Model', { open: true, hint: 'preview' }, [
      el('div', { class: 'muted' }, ['Loads glTF/GLB and can preview skinning + animations + skeleton. USD packs: pick a USD and click Convert → GLB.']),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [modelUrl, loadBtn, convertBtn, useGameplayAvatarBtn]),
      el('label', { class: 'row', style: { marginTop: '8px', gap: '8px', alignItems: 'center' } }, [
        convertSplitMeshes,
        el('div', { class: 'muted' }, ['Split meshes (also export one GLB per mesh into a folder)']),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [texUrl, applyTex]),
      loadedStatus,
      convertStatus,
      convertLog,
    ]));

    this._root.appendChild(assetPickModel);
    this._root.appendChild(assetPickTex);

    this._root.appendChild(detailsCard('Rigging', { open: false, hint: 'pipeline' }, [
      el('div', { class: 'muted' }, ['Auto-rig a mesh and export a runtime-friendly GLB.']),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['backend']),
      rigBackend,
      el('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } }, [rigStartBtn, rigKillBtn, rigCopyBtn, rigOpenViewerBtn, rigSetGameplayAvatarBtn]),
      rigStatus,
      rigLog,
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Advanced']),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['runner']),
      rigRunner,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['blenderPath (optional)']),
      blenderPath,
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['outName']), rigOutName]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [rigArgs]),
      el('div', { class: 'row', style: { marginTop: '8px', alignItems: 'center' } }, [
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
          rigAutoLoad,
          el('div', { class: 'muted' }, ['Auto-load output']),
        ]),
      ]),
    ]));

    // Outfit UI
    const outfitRunner = el('select', {
      value: st.outfitRunner,
      onchange: (e) => { st.outfitRunner = String(e.target.value || 'conda_trellis'); },
    }, [
      el('option', { value: 'conda_trellis' }, ['conda_trellis']),
      el('option', { value: 'python3' }, ['python3']),
    ]);

    const outfitBaseRig = el('input', {
      value: st.outfitBaseRigUrl,
      placeholder: 'base rig path (e.g. assets/generated/rig/hero_...glb)',
      oninput: (e) => { st.outfitBaseRigUrl = String(e.target.value || '').trim(); },
    });

    const outfitClothes = el('textarea', {
      value: st.outfitClothesText,
      placeholder: 'clothing asset paths (one per line)\nassets/generated/trellis/shirt.glb\nassets/generated/trellis/pants.glb',
      oninput: (e) => { st.outfitClothesText = String(e.target.value || ''); },
      style: { height: '92px', resize: 'vertical' },
    });

    const outfitArgs = el('input', {
      value: st.outfitArgs,
      placeholder: 'extra args for tools/outfit_asset.py (optional)',
      oninput: (e) => { st.outfitArgs = String(e.target.value || ''); },
    });

    const outfitBlenderPath = el('input', {
      value: st.outfitBlenderPath,
      placeholder: 'blender executable path (optional, e.g. /usr/bin/blender)',
      oninput: (e) => {
        st.outfitBlenderPath = String(e.target.value || '').trim();
        try { localStorage.setItem('devtools.lastOutfitBlenderPath', st.outfitBlenderPath); } catch { /* ignore */ }
      },
    });

    const outfitOutName = el('input', {
      value: st.outfitOutName,
      placeholder: 'optional output name hint (e.g. hero_outfit1)',
      oninput: (e) => { st.outfitOutName = String(e.target.value || '').trim(); },
    });

    const outfitAutoLoad = el('input', {
      type: 'checkbox',
      checked: !!st.outfitJobAutoLoad,
      onchange: (e) => { st.outfitJobAutoLoad = e.target.checked ? 1 : 0; },
    });

    const outfitStatus = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
    const outfitLog = el('div', { class: 'scrollArea', style: { height: '160px', marginTop: '8px', whiteSpace: 'pre' } }, ['(no job yet)']);

    const outfitStartBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { outfitStartBtn.disabled = true; } catch { /* ignore */ }
        try {
          await this._startOutfitJob({
            runner: st.outfitRunner,
            baseRigPath: st.outfitBaseRigUrl || st.modelUrl,
            clothesText: st.outfitClothesText,
            outfitArgs: st.outfitArgs,
            blenderPath: st.outfitBlenderPath,
            outName: st.outfitOutName,
            statusEl: outfitStatus,
            logEl: outfitLog,
            autoLoad: !!st.outfitJobAutoLoad,
          });
        } catch (e) {
          ctx?.log?.(`Outfit: start failed: ${e?.message || e}`);
          outfitStatus.textContent = `Outfit start failed: ${e?.message || e}`;
        }
        try { outfitStartBtn.disabled = false; } catch { /* ignore */ }
      },
    }, ['Build outfit']);

    const outfitKillBtn = el('button', {
      class: 'danger',
      onclick: async () => {
        const id = String(this._outfitJob?.id || '');
        if (!id) return;
        try {
          await fetch('/__devtools_outfit_kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
        } catch { /* ignore */ }
        this._pollingOutfit = false;
      },
    }, ['Kill job']);

    const outfitCopyBtn = el('button', {
      onclick: async () => {
        const p = String(this._outfitJob?.outGlb || '');
        if (!p) return;
        try { await navigator.clipboard.writeText(p); ctx?.log?.('Outfit: copied output path'); } catch { /* ignore */ }
      },
    }, ['Copy output']);

    const assetPickOutfitClothes = this._buildAssetPicker({
      title: 'Asset Picker (clothes)',
      ext: '.glb,.gltf',
      onPick: (p) => {
        const cur = String(st.outfitClothesText || '');
        const next = (cur.trim() ? (cur.replace(/\s+$/g, '') + '\n') : '') + p + '\n';
        st.outfitClothesText = next;
        outfitClothes.value = next;
      },
    });

    this._root.appendChild(detailsCard('Outfit / Clothing', { open: false, hint: 'attach' }, [
      el('div', { class: 'muted' }, ['Attach one or more clothing meshes onto a rigged base GLB.']),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [outfitStartBtn, outfitKillBtn, outfitCopyBtn]),
      outfitStatus,
      outfitLog,
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Inputs']),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['baseRigPath']),
      outfitBaseRig,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['clothesPaths']),
      outfitClothes,
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Advanced']),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['runner']),
      outfitRunner,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['blenderPath (optional)']),
      outfitBlenderPath,
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['outName']), outfitOutName]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [outfitArgs]),
      el('div', { class: 'row', style: { marginTop: '8px', alignItems: 'center' } }, [
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
          outfitAutoLoad,
          el('div', { class: 'muted' }, ['Auto-load output']),
        ]),
      ]),
    ]));

    this._root.appendChild(assetPickOutfitClothes);

    this._root.appendChild(detailsCard('Animation (preview)', { open: false, hint: 'viewer' }, [
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
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
        el('button', {
          class: 'primary',
          title: 'Use the currently selected preview clip as the retarget source (motionPath = current model, motionClip = selected clip)',
          onclick: () => {
            const model = String(st.modelUrl || '').trim();
            const clip = String(st.animName || '').trim();
            if (!model || !clip) return;
            st.motionUrl = model;
            motionUrl.value = model;
            try { localStorage.setItem('devtools.lastMotionUrl', model); } catch { /* ignore */ }
            setMotionClip(clip);
            motionClip.value = st.motionClip;
            // Keep the dropdown in sync if clips were loaded.
            try { motionClipSel.value = st.motionClip; } catch { /* ignore */ }
          },
        }, ['Use for retarget']),
        el('div', { class: 'muted' }, ['(copies current preview clip into Retarget animation)']),
      ]),
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Animation library (loaded asset)']),
      el('div', { class: 'row', style: { marginTop: '6px', gap: '8px' } }, [animLibFilter, animLibVendor]),
      animLibList,
    ]));

    this._root.appendChild(detailsCard('Retarget animation', { open: true, hint: 'AnimGraph' }, [
      el('div', { class: 'muted' }, [
        'Pick a motion file + choose the clip (action) to bake onto your rig. Outputs go to `assets/animations/`.',
      ]),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['motionPath']),
      el('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [motionUrl, useTestMotionBtn]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [listClipsBtn, printBonesBtn, validateMapBtn]),
      inspectStatus,
      inspectLog,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['mapPath']),
      mapUrl,
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['motionClip (source)']), motionClip]),
        el('div', {}, [el('div', { class: 'muted' }, ['motion asset clips']), el('div', { class: 'row', style: { gap: '8px' } }, [loadMotionClipsBtn, motionClipSel])]),
      ]),
      motionClipStatus,
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['outName']), animOutName]),
        el('div', {}, [el('div', { class: 'muted' }, ['clipName (optional)']), clipName]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px' } }, [animStartBtn, animKillBtn, animCopyBtn]),
      animStatus,
      animLog,
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['Advanced']),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['runner']),
      animRunner,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['blenderPath (optional)']),
      animBlenderPath,
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['exportFormat']), exportFormat]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', alignItems: 'center' } }, [
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
          rootMotion,
          el('div', { class: 'muted' }, ['Root motion']),
        ]),
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
          includeMesh,
          el('div', { class: 'muted' }, ['Include mesh (preview)']),
        ]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', alignItems: 'center' } }, [
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
          animAutoLoad,
          el('div', { class: 'muted' }, ['Auto-load output']),
        ]),
      ]),
    ]));

    this._root.appendChild(assetPickMotion);
    this._root.appendChild(assetPickAnimMap);

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

    // Populate indicators after initial build.
    this._syncLoadedIndicators();
    this._syncAnimLibrary();
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
        }, [`Show more (+200)`]),
        el('div', { class: 'muted' }, [`(${filtered.length - shown.length} more)`]),
      ]));
    }
  }

  async _startRigJob({ inModelPath, runner, rigBackend, rigArgs, blenderPath, outName, statusEl, logEl, autoLoad }) {
    const ctx = this._ctx;
    const u = String(inModelPath || '').trim();
    if (!u) throw new Error('Load or enter a model path first');
    const backend = String(rigBackend || '').trim();
    if (!backend) throw new Error('Missing rig backend');

    // UX preflight: rigging expects an importable mesh/model asset, not a USD pack entry.
    // We intentionally push USD through Convert → GLB first so the rigging step is deterministic.
    const low = u.toLowerCase();
    const isUsd = low.endsWith('.usd') || low.endsWith('.usda') || low.endsWith('.usdc') || low.endsWith('.usdz');
    if (isUsd) {
      throw new Error('Rigging expects a GLB/GLTF (or FBX/OBJ/BLEND). Convert USD → GLB first (Model → Convert), then auto-rig the GLB.');
    }

    // If user didn’t provide an outName hint, derive one from the input filename.
    const outHint = String(outName || '').trim() || (String(u).split('/').pop() || '').replace(/\.[^.]+$/g, '');

    this._rigJob = { id: '', status: 'running', stdout: '', stderr: '', outRig: '' };
    this._pollingRig = false;
    if (statusEl) statusEl.textContent = 'Starting rig job...';
    if (logEl) logEl.textContent = '(starting...)';

    const payload = {
      runner: String(runner || 'conda_trellis'),
      inModelPath: u,
      rigBackend: backend,
      rigArgs: String(rigArgs || ''),
      blenderPath: String(blenderPath || ''),
      outName: outHint,
    };
    const resp = await fetch('/__devtools_rig_start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'rig start failed'));

    this._rigJob.id = String(j.id || '');
    this._rigJob.outRig = String(j.outRig || '');
    this._pollingRig = true;
    void this._pollRigLoop({ id: this._rigJob.id, statusEl, logEl, autoLoad: !!autoLoad });
    ctx?.log?.(`Rig: started (${backend})`);
  }

  async _pollRigLoop({ id, statusEl, logEl, autoLoad }) {
    const ctx = this._ctx;
    if (!id) return;
    let backoff = 400;
    while (this._pollingRig && this._rigJob?.id === id) {
      try {
        const resp = await fetch(`/__devtools_rig_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'job query failed'));
        this._rigJob.status = String(j.status || '');
        this._rigJob.stdout = String(j.stdout || '');
        this._rigJob.stderr = String(j.stderr || '');
        this._rigJob.outRig = String(j.outRig || this._rigJob.outRig || '');

        if (statusEl) statusEl.textContent = `Rig job: ${this._rigJob.status}${this._rigJob.outRig ? `\nOutput: ${this._rigJob.outRig}` : ''}`;
        if (logEl) {
          const out = this._rigJob.stdout || '';
          const err = this._rigJob.stderr || '';
          logEl.textContent = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output yet)';
          try { logEl.scrollTop = logEl.scrollHeight; } catch { /* ignore */ }
        }

        if (this._rigJob.status === 'done' || this._rigJob.status === 'error' || this._rigJob.status === 'killed') {
          this._pollingRig = false;
          if (this._rigJob.status === 'done') {
            const outRig = String(this._rigJob.outRig || '').trim();
            if (outRig) {
              try { localStorage.setItem('devtools.lastGeneratedModelUrl', outRig); } catch { /* ignore */ }
              ctx?.log?.(`Rig: done → ${outRig}`);
              if (autoLoad) {
                this._state.modelUrl = outRig;
                if (this._modelUrlInputEl) this._modelUrlInputEl.value = outRig;
                try { await this._loadModel(outRig); } catch (e) { ctx?.log?.(`Rig: auto-load failed: ${e?.message || e}`); }
              }
            }
          }
          return;
        }

        backoff = 500;
      } catch (e) {
        if (statusEl) statusEl.textContent = `Rig polling failed: ${e?.message || e}`;
        backoff = Math.min(2000, Math.floor(backoff * 1.4));
      }
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  async _startAnimJob({ rigPath, motionPath, mapPath, runner, blenderPath, motionClip, clipName, exportFormat, rootMotion, includeMesh, outName, statusEl, logEl, autoLoad }) {
    const ctx = this._ctx;
    const rig = String(rigPath || '').trim();
    const motion = String(motionPath || '').trim();
    const map = String(mapPath || '').trim();
    if (!rig) throw new Error('Load or enter a rig/model path first');
    if (!motion) throw new Error('Missing motionPath (BVH/FBX/GLB/GLTF/USD). Try outputs/mixamo_idle.bvh');
    if (!map) throw new Error('Missing mapPath');

    this._animJob = { id: '', status: 'running', stdout: '', stderr: '', outGlb: '' };
    this._pollingAnim = false;
    if (statusEl) statusEl.textContent = 'Starting retarget job...';
    if (logEl) logEl.textContent = '(starting...)';

    const payload = {
      rigPath: rig,
      motionPath: motion,
      mapPath: map,
      runner: String(runner || 'conda_trellis'),
      blenderPath: String(blenderPath || ''),
      motionClip: String(motionClip || '').trim().replace(/^@+/, ''),
      clipName: String(clipName || '').trim().replace(/^@+/, ''),
      exportFormat: String(exportFormat || ''),
      rootMotion: rootMotion ? 1 : 0,
      includeMesh: includeMesh ? 1 : 0,
      outName: String(outName || ''),
    };

    const resp = await fetch('/__devtools_anim_retarget_start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'anim start failed'));

    this._animJob.id = String(j.id || '');
    this._animJob.outGlb = String(j.outGlb || '');
    this._pollingAnim = true;
    void this._pollAnimLoop({ id: this._animJob.id, statusEl, logEl, autoLoad: !!autoLoad });
    ctx?.log?.('Anim: retarget started');
  }

  async _startOutfitJob({ runner, baseRigPath, clothesText, outfitArgs, blenderPath, outName, statusEl, logEl, autoLoad }) {
    const ctx = this._ctx;
    const baseRig = String(baseRigPath || '').trim();
    const clothesPathsText = String(clothesText || '').trim();
    if (!baseRig) throw new Error('Missing base rig path');
    if (!clothesPathsText) throw new Error('Missing clothes paths');

    this._outfitJob = { id: '', status: 'running', stdout: '', stderr: '', outGlb: '' };
    this._pollingOutfit = false;
    if (statusEl) statusEl.textContent = 'Starting outfit job...';
    if (logEl) logEl.textContent = '(starting...)';

    const payload = {
      runner: String(runner || 'conda_trellis'),
      baseRigPath: baseRig,
      clothesPathsText,
      outfitArgs: String(outfitArgs || ''),
      blenderPath: String(blenderPath || ''),
      outName: String(outName || ''),
    };

    const resp = await fetch('/__devtools_outfit_start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'outfit start failed'));

    this._outfitJob.id = String(j.id || '');
    this._outfitJob.outGlb = String(j.outGlb || '');
    this._pollingOutfit = true;
    void this._pollOutfitLoop({ id: this._outfitJob.id, statusEl, logEl, autoLoad: !!autoLoad });
    ctx?.log?.('Outfit: started');
  }

  async _pollOutfitLoop({ id, statusEl, logEl, autoLoad }) {
    const ctx = this._ctx;
    if (!id) return;
    let backoff = 400;
    while (this._pollingOutfit && this._outfitJob?.id === id) {
      try {
        const resp = await fetch(`/__devtools_outfit_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'job query failed'));
        this._outfitJob.status = String(j.status || '');
        this._outfitJob.stdout = String(j.stdout || '');
        this._outfitJob.stderr = String(j.stderr || '');
        this._outfitJob.outGlb = String(j.outGlb || this._outfitJob.outGlb || '');

        if (statusEl) statusEl.textContent = `Outfit job: ${this._outfitJob.status}${this._outfitJob.outGlb ? `\nOutput: ${this._outfitJob.outGlb}` : ''}`;
        if (logEl) {
          const out = this._outfitJob.stdout || '';
          const err = this._outfitJob.stderr || '';
          logEl.textContent = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output yet)';
          try { logEl.scrollTop = logEl.scrollHeight; } catch { /* ignore */ }
        }

        if (this._outfitJob.status === 'done' || this._outfitJob.status === 'error' || this._outfitJob.status === 'killed') {
          this._pollingOutfit = false;
          if (this._outfitJob.status === 'done') {
            const outGlb = String(this._outfitJob.outGlb || '').trim();
            if (outGlb) {
              try { localStorage.setItem('devtools.lastGeneratedModelUrl', outGlb); } catch { /* ignore */ }
              ctx?.log?.(`Outfit: done → ${outGlb}`);
              if (autoLoad) {
                this._state.modelUrl = outGlb;
                if (this._modelUrlInputEl) this._modelUrlInputEl.value = outGlb;
                try { await this._loadModel(outGlb); } catch (e) { ctx?.log?.(`Outfit: auto-load failed: ${e?.message || e}`); }
              }
            }
          }
          return;
        }

        backoff = 500;
      } catch (e) {
        if (statusEl) statusEl.textContent = `Outfit polling failed: ${e?.message || e}`;
        backoff = Math.min(2000, Math.floor(backoff * 1.4));
      }
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  async _pollAnimLoop({ id, statusEl, logEl, autoLoad }) {
    const ctx = this._ctx;
    if (!id) return;
    let backoff = 400;
    while (this._pollingAnim && this._animJob?.id === id) {
      try {
        const resp = await fetch(`/__devtools_anim_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'job query failed'));
        this._animJob.status = String(j.status || '');
        this._animJob.stdout = String(j.stdout || '');
        this._animJob.stderr = String(j.stderr || '');
        this._animJob.outGlb = String(j.outGlb || this._animJob.outGlb || '');

        if (statusEl) statusEl.textContent = `Retarget job: ${this._animJob.status}${this._animJob.outGlb ? `\nOutput: ${this._animJob.outGlb}` : ''}`;
        if (logEl) {
          const out = this._animJob.stdout || '';
          const err = this._animJob.stderr || '';
          logEl.textContent = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output yet)';
          try { logEl.scrollTop = logEl.scrollHeight; } catch { /* ignore */ }
        }

        if (this._animJob.status === 'done' || this._animJob.status === 'error' || this._animJob.status === 'killed') {
          this._pollingAnim = false;
          if (this._animJob.status === 'done') {
            const outGlb = String(this._animJob.outGlb || '').trim();
            if (outGlb) {
              try { localStorage.setItem('devtools.lastGeneratedModelUrl', outGlb); } catch { /* ignore */ }
              ctx?.log?.(`Anim: done → ${outGlb}`);
              if (autoLoad) {
                this._state.modelUrl = outGlb;
                if (this._modelUrlInputEl) this._modelUrlInputEl.value = outGlb;
                try { await this._loadModel(outGlb); } catch (e) { ctx?.log?.(`Anim: auto-load failed: ${e?.message || e}`); }
              }
            }
          }
          return;
        }

        backoff = 500;
      } catch (e) {
        if (statusEl) statusEl.textContent = `Anim polling failed: ${e?.message || e}`;
        backoff = Math.min(2000, Math.floor(backoff * 1.4));
      }
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  async _startConvertJob({ inPath, runner, blenderPath, exportFormat, outName, splitMeshes, statusEl, logEl, autoLoad }) {
    const ctx = this._ctx;
    const inp = String(inPath || '').trim();
    if (!inp) throw new Error('Missing input path');

    this._convertJob = { id: '', status: 'running', stdout: '', stderr: '', outGlb: '', outMeshesDir: '', outMeshes: [] };
    this._pollingConvert = false;
    if (statusEl) statusEl.textContent = 'Starting convert job...';
    if (logEl) logEl.textContent = '(starting...)';

    const payload = {
      runner: String(runner || 'conda_trellis'),
      inPath: inp,
      blenderPath: String(blenderPath || ''),
      exportFormat: String(exportFormat || 'GLB'),
      outName: String(outName || ''),
      splitMeshes: !!splitMeshes,
    };
    const resp = await fetch('/__devtools_convert_start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'convert start failed'));

    this._convertJob.id = String(j.id || '');
    this._convertJob.outGlb = String(j.outGlb || '');
    this._convertJob.outMeshesDir = String(j.outMeshesDir || '');
    this._convertJob.outMeshes = Array.isArray(j.outMeshes) ? j.outMeshes : [];
    this._pollingConvert = true;
    void this._pollConvertLoop({ id: this._convertJob.id, statusEl, logEl, autoLoad: !!autoLoad });
    ctx?.log?.('Convert: started');
  }

  async _pollConvertLoop({ id, statusEl, logEl, autoLoad }) {
    const ctx = this._ctx;
    if (!id) return;
    let backoff = 400;
    while (this._pollingConvert && this._convertJob?.id === id) {
      try {
        const resp = await fetch(`/__devtools_convert_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'job query failed'));
        this._convertJob.status = String(j.status || '');
        this._convertJob.stdout = String(j.stdout || '');
        this._convertJob.stderr = String(j.stderr || '');
        this._convertJob.outGlb = String(j.outGlb || this._convertJob.outGlb || '');
        this._convertJob.outMeshesDir = String(j.outMeshesDir || this._convertJob.outMeshesDir || '');
        this._convertJob.outMeshes = Array.isArray(j.outMeshes) ? j.outMeshes : (this._convertJob.outMeshes || []);

        if (statusEl) {
          const meshesDir = String(this._convertJob.outMeshesDir || '').trim();
          const meshCount = Array.isArray(this._convertJob.outMeshes) ? this._convertJob.outMeshes.length : 0;
          statusEl.textContent = `Convert job: ${this._convertJob.status}`
            + (this._convertJob.outGlb ? `\nOutput: ${this._convertJob.outGlb}` : '')
            + (meshesDir ? `\nMeshes: ${meshCount || '?'} in ${meshesDir}` : '');
        }
        if (logEl) {
          const out = this._convertJob.stdout || '';
          const err = this._convertJob.stderr || '';
          logEl.textContent = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output yet)';
          try { logEl.scrollTop = logEl.scrollHeight; } catch { /* ignore */ }
        }

        if (this._convertJob.status === 'done' || this._convertJob.status === 'error' || this._convertJob.status === 'killed') {
          this._pollingConvert = false;
          if (this._convertJob.status === 'done') {
            const outGlb = String(this._convertJob.outGlb || '').trim();
            if (outGlb) {
              ctx?.log?.(`Convert: done → ${outGlb}`);
              if (autoLoad) {
                this._state.modelUrl = outGlb;
                if (this._modelUrlInputEl) this._modelUrlInputEl.value = outGlb;
                try { await this._loadModel(outGlb); } catch (e) { ctx?.log?.(`Convert: auto-load failed: ${e?.message || e}`); }
              }
            }
          }
          return;
        }

        backoff = 500;
      } catch (e) {
        if (statusEl) statusEl.textContent = `Convert polling failed: ${e?.message || e}`;
        backoff = Math.min(2000, Math.floor(backoff * 1.4));
      }
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  _buildAssetPicker({ title, ext, onPick, allowEmptyQuery = false }) {
    const ctx = this._ctx;
    const queryInput = el('input', { placeholder: allowEmptyQuery ? 'search assets (optional; empty to list)' : 'search assets (e.g. character)' });
    const list = el('div', { class: 'scrollArea', style: { height: '160px' } }, ['(search to populate)']);

    const refresh = async () => {
      const q = String(queryInput.value || '').trim();
      if (!q && !allowEmptyQuery) {
        list.textContent = '(search to populate)';
        return;
      }
      try {
        list.textContent = 'Loading...';
        const items = await ctx.assetIndex({ query: q, ext });
        if (!items.length) {
          list.textContent = '(no matches)';
          return;
        }
        clear(list);
        for (const it of items.slice(0, 250)) {
          const p = String(it?.path || '');
          const btn = el('button', {
            class: 'toolBtn',
            style: { marginTop: '6px' },
            onclick: () => onPick(p),
          }, [p]);
          list.appendChild(btn);
        }
      } catch (e) {
        list.textContent = `(error) ${e?.message || e}`;
      }
    };
    queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') refresh(); });

    return el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, [String(title || 'Assets')]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        queryInput,
        el('button', { onclick: refresh }, ['Search']),
      ]),
      el('div', { class: 'muted', style: { marginTop: '6px' } }, ['Uses local Vite dev endpoint `/__editor_assets_index`.']),
      el('div', { style: { marginTop: '8px' } }, [list]),
    ]);
  }

  async _loadModel(url) {
    const ctx = this._ctx;
    const u = String(url || '').trim();
    if (!u) throw new Error('Missing model url');
    if (!this._scene) return;

    ctx?.log(`Model: loading ${u}`);
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

    // Refresh animation select options
    this._refreshAnimSelect();
    this._syncLoadedIndicators();
    this._syncAnimLibrary();

    ctx?.log(`Model: loaded (${gltf.animations?.length || 0} clips)`);
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

    ctx?.log(`Model: loading texture ${u}`);
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

    ctx?.log(`Model: applied texture to ${changed} material(s)`);
  }
}

