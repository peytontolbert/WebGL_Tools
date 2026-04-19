import { el, clear } from '../../ui/dom.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

function normClipName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, '').replace(/[-_.:]/g, '');
}

function isNvidiaAnimName(name) {
  const s = String(name || '').trim().toLowerCase();
  if (!s) return false;
  return s.startsWith('@nvidia') || s.startsWith('@nvd') || s.startsWith('animgraph_nvd_') || s.includes('animgraph_nvd_') || s.includes('nvidia');
}

function pickClipByAliases(clips, aliases, { preferNvidia = false } = {}) {
  const arr = Array.isArray(clips) ? clips : [];
  if (!arr.length) return '';
  const values = arr.map((x) => String(x?.name || '').trim()).filter(Boolean);
  const byNorm = new Map(values.map((v) => [normClipName(v), v]));
  const wants = Array.isArray(aliases) ? aliases : [];

  const find = (filterFn) => {
    for (const a of wants) {
      const hit = byNorm.get(normClipName(a));
      if (hit && (!filterFn || filterFn(hit))) return hit;
    }
    for (const a of wants) {
      const k = normClipName(a);
      for (const name of values) {
        const n = normClipName(name);
        if (n.includes(k) && (!filterFn || filterFn(name))) return name;
      }
    }
    return '';
  };

  if (preferNvidia) {
    const nvd = find((n) => isNvidiaAnimName(n));
    if (nvd) return nvd;
  }
  return find(null);
}

export class Mesh2MotionTool {
  constructor() {
    this.id = 'mesh2motion';
    this.label = 'Mesh2Motion';

    this._ctx = null;
    this._root = null;
    this._onWindowMessage = null;
    this._m2mWins = { create: null, retarget: null };

    this._state = {
      modelUrl: '',
      motionUrl: 'assets/external/ual2/UAL2_Standard.glb',
      mapUrl: 'tools/rigging/mappings/example_map.json',
      runner: 'conda_trellis',
      blenderPath: '',
      autoRig: 1,
      rigBackend: 'rigify',
      outName: 'mesh2motion_locomotion',
      includeMesh: 1,
      exportFormat: 'GLB',
      standaloneUrl: '/mesh2motion/create.html',
      savedAssetPath: '',
      activeSlot: 'idle',
      clipFilter: '',
      clipVendor: 'all',
      clips: {
        idle: { motionPath: 'assets/external/ual2/UAL2_Standard.glb', motionClip: '' },
        walk_fwd: { motionPath: 'assets/external/ual2/UAL2_Standard.glb', motionClip: '' },
        walk_back: { motionPath: 'assets/external/ual2/UAL2_Standard.glb', motionClip: '' },
        walk_left: { motionPath: 'assets/external/ual2/UAL2_Standard.glb', motionClip: '' },
        walk_right: { motionPath: 'assets/external/ual2/UAL2_Standard.glb', motionClip: '' },
        run_fwd: { motionPath: 'assets/external/ual2/UAL2_Standard.glb', motionClip: '' },
        run_back: { motionPath: 'assets/external/ual2/UAL2_Standard.glb', motionClip: '' },
        run_left: { motionPath: 'assets/external/ual2/UAL2_Standard.glb', motionClip: '' },
        run_right: { motionPath: 'assets/external/ual2/UAL2_Standard.glb', motionClip: '' },
        jump_start: { motionPath: 'assets/external/ual2/UAL2_Standard.glb', motionClip: '' },
        jump_air: { motionPath: 'assets/external/ual2/UAL2_Standard.glb', motionClip: '' },
        jump_land: { motionPath: 'assets/external/ual2/UAL2_Standard.glb', motionClip: '' },
      },
    };

    this._rigJob = { id: '', status: '', outRig: '', stdout: '', stderr: '' };
    this._animJob = { id: '', status: '', outGlb: '', stdout: '', stderr: '' };
    this._smokeJob = { id: '', status: '', stdout: '', stderr: '' };
    this._pollingAnim = false;
    this._pollingSmoke = false;

    this._motionClips = [];

    this._viewer = {
      host: null,
      canvas: null,
      statusEl: null,
      renderer: null,
      scene: null,
      camera: null,
      controls: null,
      loader: null,
      model: null,
      raf: 0,
      resizeObs: null,
    };
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;
    try {
      const last = String(localStorage.getItem('devtools.lastGeneratedModelUrl') || '').trim();
      if (last && !String(this._state.modelUrl || '').trim()) this._state.modelUrl = last;
    } catch { /* ignore */ }
    try {
      const lastMotion = String(localStorage.getItem('devtools.lastMotionUrl') || '').trim();
      if (lastMotion) this._state.motionUrl = lastMotion;
    } catch { /* ignore */ }
    try {
      const lastMap = String(localStorage.getItem('devtools.lastAnimMapUrl') || '').trim();
      if (lastMap && String(this._state.mapUrl || '').trim() === 'tools/rigging/mappings/example_map.json') this._state.mapUrl = lastMap;
    } catch { /* ignore */ }
    try {
      const raw = String(localStorage.getItem('devtools.mesh2motion.prefill') || '').trim();
      if (raw) {
        localStorage.removeItem('devtools.mesh2motion.prefill');
        let cfg = null;
        try { cfg = JSON.parse(raw); } catch { cfg = null; }
        const modelUrl = String(cfg?.modelUrl || '').trim();
        if (modelUrl) this._state.modelUrl = modelUrl;
      }
    } catch { /* ignore */ }
    this._buildUi();
    this._installWindowMessageListener();
  }

  async unmount() {
    this._pollingAnim = false;
    this._pollingSmoke = false;
    this._disposeViewer();
    this._removeWindowMessageListener();
    this._ctx = null;
    this._root = null;
  }

  tick() {}

  getStats() {
    return {
      model: this._state.modelUrl || '',
      clips: Array.isArray(this._motionClips) ? this._motionClips.length : 0,
      rigJob: this._rigJob?.status || '',
      animJob: this._animJob?.status || '',
      smoke: this._smokeJob?.status || '',
    };
  }

  _buildUi() {
    const root = this._root;
    if (!root) return;
    clear(root);
    const ctx = this._ctx;
    const st = this._state;

    const detailsCard = (title, { open = true, hint = '' } = {}, children = []) => el('details', { class: 'card', open: !!open }, [
      el('summary', {}, [
        el('div', { class: 'dockTitle' }, [String(title || 'Section')]),
        hint ? el('div', { class: 'muted', style: { marginLeft: 'auto', textAlign: 'right' } }, [String(hint)]) : el('div', {}),
      ]),
      el('div', { class: 'cardBody' }, children),
    ]);

    const assetPicker = this._buildAssetPicker({
      title: 'Character assets',
      ext: '.glb,.gltf,.fbx,.obj',
      onPick: (p) => {
        st.modelUrl = p;
        modelUrl.value = p;
        void this._viewerLoadModelFromPath(p, viewerStatus);
      },
      allowEmptyQuery: true,
    });

    const modelUrl = el('input', {
      value: st.modelUrl,
      placeholder: 'assets/.../character.glb',
      oninput: (e) => { st.modelUrl = String(e.target.value || '').trim(); },
    });
    const useLastBtn = el('button', {
      onclick: () => {
        try {
          const saved = String(localStorage.getItem('devtools.lastGeneratedModelUrl') || '').trim();
          if (saved) {
            st.modelUrl = saved;
            modelUrl.value = saved;
            void this._viewerLoadModelFromPath(saved, viewerStatus);
          }
        } catch { /* ignore */ }
      },
    }, ['Use last output']);
    const uploadStatus = el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-wrap' } }, ['']);
    const viewerStatus = el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-wrap' } }, ['Viewer: idle']);
    const loadViewerBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        const p = String(st.modelUrl || '').trim();
        if (!p) return;
        await this._viewerLoadModelFromPath(p, viewerStatus);
      },
    }, ['Load in viewer']);
    const uploadInput = el('input', {
      type: 'file',
      accept: '.glb,.gltf,.fbx,.obj',
      onchange: async (e) => {
        try {
          const f = e?.target?.files?.[0];
          if (!f) return;
          uploadStatus.textContent = `Uploading ${f.name}...`;
          const rel = await this._uploadCharacterFile(f);
          st.modelUrl = rel;
          modelUrl.value = rel;
          uploadStatus.textContent = `Uploaded: ${rel}`;
          await this._viewerLoadModelFromPath(rel, viewerStatus);
        } catch (err) {
          uploadStatus.textContent = `Upload failed: ${err?.message || err}`;
        }
      },
    });

    const motionUrl = el('input', {
      value: st.motionUrl,
      placeholder: 'animation source library path',
      oninput: (e) => {
        st.motionUrl = String(e.target.value || '').trim();
        try { localStorage.setItem('devtools.lastMotionUrl', st.motionUrl); } catch { /* ignore */ }
      },
    });
    const useUal2Btn = el('button', {
      title: 'Use built-in UAL2 library (100+ animations)',
      onclick: () => {
        const p = 'assets/external/ual2/UAL2_Standard.glb';
        st.motionUrl = p;
        motionUrl.value = p;
        try { localStorage.setItem('devtools.lastMotionUrl', p); } catch { /* ignore */ }
      },
    }, ['Use 100+ animation library']);

    const clipStatus = el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-wrap' } }, ['']);
    const clipFilter = el('input', {
      value: st.clipFilter,
      placeholder: 'filter clips (walk, idle, jump, 10010...)',
      oninput: (e) => {
        st.clipFilter = String(e.target.value || '');
        this._buildUi();
      },
    });
    const clipVendor = el('select', {
      value: st.clipVendor,
      onchange: (e) => {
        st.clipVendor = String(e.target.value || 'all');
        this._buildUi();
      },
    }, [
      el('option', { value: 'all' }, ['All']),
      el('option', { value: 'nvidia' }, ['NVIDIA-style']),
      el('option', { value: 'other' }, ['Non-NVIDIA']),
    ]);
    const loadClipsBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try {
          clipStatus.textContent = 'Loading clip library...';
          const clips = await this._loadMotionClips();
          clipStatus.textContent = `Loaded ${clips.length} clip(s)`;
          this._buildUi();
        } catch (e) {
          clipStatus.textContent = `Load clips failed: ${e?.message || e}`;
        }
      },
    }, ['Load clips']);
    const autoFillBtn = el('button', {
      class: 'primary',
      onclick: () => {
        try {
          const out = this._autoFillLocomotionFromLoadedClips({ preferNvidia: true });
          clipStatus.textContent = `Auto-fill complete: ${out.filled} slot(s)`;
          this._buildUi();
        } catch (e) {
          clipStatus.textContent = `Auto-fill failed: ${e?.message || e}`;
        }
      },
    }, ['Auto-fill locomotion']);

    const clipLib = this._renderClipLibraryList();

    const activeSlot = el('select', {
      value: String(st.activeSlot || 'idle'),
      onchange: (e) => { st.activeSlot = String(e.target.value || 'idle'); },
    }, [
      'idle',
      'walk_fwd', 'walk_back', 'walk_left', 'walk_right',
      'run_fwd', 'run_back', 'run_left', 'run_right',
      'jump_start', 'jump_air', 'jump_land',
    ].map((k) => el('option', { value: k }, [k])));
    const applyFirstClipBtn = el('button', {
      title: 'Assign first visible clip to active slot',
      onclick: () => {
        const first = this._getVisibleClipNames().at(0) || '';
        if (!first) return;
        const ent = st.clips[st.activeSlot] || (st.clips[st.activeSlot] = { motionPath: '', motionClip: '' });
        ent.motionClip = first;
        if (!String(ent.motionPath || '').trim()) ent.motionPath = String(st.motionUrl || '').trim();
        this._buildUi();
      },
    }, ['Apply first filtered clip']);

    const mapUrl = el('input', {
      value: st.mapUrl,
      placeholder: 'tools/rigging/mappings/...json',
      oninput: (e) => {
        st.mapUrl = String(e.target.value || '').trim();
        try { localStorage.setItem('devtools.lastAnimMapUrl', st.mapUrl); } catch { /* ignore */ }
      },
    });
    const runner = el('select', {
      value: st.runner,
      onchange: (e) => { st.runner = String(e.target.value || 'conda_trellis'); },
    }, [
      el('option', { value: 'conda_trellis' }, ['conda_trellis']),
      el('option', { value: 'python3' }, ['python3']),
    ]);
    const blenderPath = el('input', {
      value: st.blenderPath,
      placeholder: 'blender executable path (optional)',
      oninput: (e) => { st.blenderPath = String(e.target.value || '').trim(); },
    });
    const autoRig = el('input', {
      type: 'checkbox',
      checked: !!st.autoRig,
      onchange: (e) => { st.autoRig = e.target.checked ? 1 : 0; },
    });
    const rigBackend = el('select', {
      value: st.rigBackend,
      onchange: (e) => { st.rigBackend = String(e.target.value || 'rigify'); },
    }, [
      el('option', { value: 'rigify' }, ['rigify']),
      el('option', { value: 'blenrig' }, ['blenrig']),
      el('option', { value: 'unirig' }, ['unirig']),
      el('option', { value: 'riganything' }, ['riganything']),
    ]);
    const outName = el('input', {
      value: st.outName,
      placeholder: 'output name',
      oninput: (e) => { st.outName = String(e.target.value || '').trim(); },
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
    const fillClipPathsBtn = el('button', {
      title: 'Set empty motionPath values from Motion URL',
      onclick: () => {
        const src = String(st.motionUrl || '').trim();
        if (!src) return;
        for (const ent of Object.values(st.clips || {})) {
          if (!ent || typeof ent !== 'object') continue;
          if (!String(ent.motionPath || '').trim()) ent.motionPath = src;
        }
        this._buildUi();
      },
    }, ['Fill empty motionPath']);

    const slotsCard = this._renderLocomotionSlots();

    const status = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
    const log = el('div', { class: 'scrollArea', style: { height: '180px', marginTop: '8px', whiteSpace: 'pre' } }, ['(no job yet)']);

    const startBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try {
          startBtn.disabled = true;
          await this._runMesh2Motion({ statusEl: status, logEl: log });
        } catch (e) {
          status.textContent = `Mesh2Motion failed: ${e?.message || e}`;
        } finally {
          startBtn.disabled = false;
        }
      },
    }, ['Apply animations (retarget)']);
    const killBtn = el('button', {
      class: 'danger',
      onclick: async () => {
        const animId = String(this._animJob?.id || '');
        const rigId = String(this._rigJob?.id || '');
        try {
          if (animId) {
            await fetch('/__devtools_anim_kill', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: animId }),
            });
          }
          if (rigId) {
            await fetch('/__devtools_rig_kill', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: rigId }),
            });
          }
        } catch { /* ignore */ }
        this._pollingAnim = false;
      },
    }, ['Kill']);
    const copyOutputBtn = el('button', {
      onclick: async () => {
        const p = String(this._animJob?.outGlb || this._rigJob?.outRig || '').trim();
        if (!p) return;
        try { await navigator.clipboard.writeText(p); } catch { /* ignore */ }
      },
    }, ['Copy output']);
    const openViewerBtn = el('button', {
      class: 'primary',
      onclick: () => {
        const p = String(this._animJob?.outGlb || this._rigJob?.outRig || '').trim();
        if (!p) return;
        try { localStorage.setItem('devtools.lastGeneratedModelUrl', p); } catch { /* ignore */ }
        try { globalThis.__devtools?.setActiveTool?.('model_viewer'); } catch { /* ignore */ }
      },
    }, ['Open in viewer']);
    const setGameplayBtn = el('button', {
      onclick: () => {
        const p = String(this._animJob?.outGlb || '').trim();
        if (!p) return;
        try { localStorage.setItem('gameplay.avatarUrl', p); } catch { /* ignore */ }
        ctx?.toast?.('Set gameplay avatar from Mesh2Motion output', 'success', { title: 'Mesh2Motion' });
      },
    }, ['Set gameplay avatar']);

    const standaloneStatus = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
    const standaloneUrl = el('input', {
      value: st.standaloneUrl,
      placeholder: 'http://127.0.0.1:5174/create.html',
      oninput: (e) => { st.standaloneUrl = String(e.target.value || '').trim(); },
    });
    const checkStandaloneBtn = el('button', {
      onclick: async () => {
        try {
          standaloneStatus.textContent = 'Checking standalone app...';
          const resp = await fetch('/__devtools_mesh2motion_status');
          const j = await resp.json();
          if (!j?.ok) throw new Error(String(j?.error || 'status failed'));
          const online = !!j.online;
          if (online && j.createUrl) {
            st.standaloneUrl = String(j.createUrl);
            standaloneUrl.value = st.standaloneUrl;
          }
          standaloneStatus.textContent = online
            ? `Online: ${String(j.createUrl || '(unknown URL)')}`
            : 'Offline (expected ports: 5174, 5175, 5179)';
        } catch (e) {
          standaloneStatus.textContent = `Status check failed: ${e?.message || e}`;
        }
      },
    }, ['Check server']);
    const openStandaloneBtn = el('button', {
      class: 'primary',
      onclick: () => {
        const u = String(st.standaloneUrl || '').trim();
        if (!u) return;
        try { window.open(u, '_blank', 'noopener,noreferrer'); } catch { /* ignore */ }
      },
    }, ['Open standalone app']);

    const savedPath = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, [
      st.savedAssetPath ? `Last saved to assets: ${st.savedAssetPath}` : 'Last saved to assets: (none)',
    ]);

    const openCreateBtn = el('button', {
      class: 'primary',
      onclick: () => {
        try {
          this._m2mWins.create = window.open(this._buildM2MCreateUrl(), '_blank', 'noopener,noreferrer');
        } catch { /* ignore */ }
      },
    }, ['Open editor (rig + skeleton)']);

    const openRetargetBtn = el('button', {
      class: 'primary',
      onclick: () => {
        try {
          this._m2mWins.retarget = window.open(this._buildM2MRetargetUrl(), '_blank', 'noopener,noreferrer');
        } catch { /* ignore */ }
      },
    }, ['Open editor (retarget)']);

    const sendModelToCreateBtn = el('button', {
      onclick: async () => {
        const p = String(st.modelUrl || '').trim();
        if (!p) return;
        const w = this._m2mWins.create;
        if (!w || w.closed) {
          try { this._m2mWins.create = window.open(this._buildM2MCreateUrl(), '_blank', 'noopener,noreferrer'); } catch { /* ignore */ }
        }
        await this._sendModelToM2MWindow({
          win: this._m2mWins.create,
          modelPath: p,
          messageType: 'M2M_LOAD_MODEL_DATAURL',
        });
      },
      title: 'Loads the current model into Mesh2Motion create flow',
    }, ['Send current model → rig editor']);

    const sendLastOutputToRetargetBtn = el('button', {
      onclick: async () => {
        const p = String(this._animJob?.outGlb || this._rigJob?.outRig || '').trim();
        if (!p) return;
        const w = this._m2mWins.retarget;
        if (!w || w.closed) {
          try { this._m2mWins.retarget = window.open(this._buildM2MRetargetUrl(), '_blank', 'noopener,noreferrer'); } catch { /* ignore */ }
        }
        await this._sendModelToM2MWindow({
          win: this._m2mWins.retarget,
          modelPath: p,
          messageType: 'M2M_LOAD_TARGET_MODEL_DATAURL',
        });
      },
      title: 'Loads last pipeline output into Mesh2Motion retarget flow',
    }, ['Send last output → retarget editor']);

    const smokeStatus = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
    const smokeLog = el('div', { class: 'scrollArea', style: { height: '150px', marginTop: '8px', whiteSpace: 'pre' } }, ['(no job yet)']);
    const smokeStartBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try {
          smokeStartBtn.disabled = true;
          await this._startSmokeTest({ statusEl: smokeStatus, logEl: smokeLog });
        } catch (e) {
          smokeStatus.textContent = `Smoke test failed: ${e?.message || e}`;
        } finally {
          smokeStartBtn.disabled = false;
        }
      },
    }, ['Run pipeline smoke test']);
    const smokeKillBtn = el('button', {
      class: 'danger',
      onclick: async () => {
        const id = String(this._smokeJob?.id || '');
        if (!id) return;
        try {
          await fetch('/__devtools_mesh2motion_test_kill', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
        } catch { /* ignore */ }
        this._pollingSmoke = false;
      },
    }, ['Kill smoke test']);

    root.appendChild(detailsCard('Step 1: Character', { open: true, hint: 'select or upload' }, [
      el('div', { class: 'muted', style: { whiteSpace: 'pre-wrap' } }, [
        'Use an existing asset or upload a new character model.',
      ]),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['modelUrl']),
      el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, [modelUrl, useLastBtn, loadViewerBtn]),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Upload character file']),
      uploadInput,
      uploadStatus,
      viewerStatus,
      assetPicker,
    ]));

    root.appendChild(detailsCard('Step 2: Rigging + Retarget Settings', { open: true, hint: 'auto-rig + mapping' }, [
      el('div', { class: 'row', style: { gap: '10px', alignItems: 'center', flexWrap: 'wrap' } }, [
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [autoRig, el('span', { class: 'muted' }, ['Attempt auto-rig'])]),
        rigBackend,
      ]),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['mapPath']),
      mapUrl,
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['outName']), outName]),
        el('div', {}, [el('div', { class: 'muted' }, ['export']), exportFormat]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '12px', alignItems: 'center', flexWrap: 'wrap' } }, [
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [includeMesh, el('span', { class: 'muted' }, ['Include mesh'])]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '10px' } }, ['runner']),
      runner,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['blenderPath (optional)']),
      blenderPath,
    ]));

    root.appendChild(detailsCard('Step 3: Animation Library (100+ clips)', { open: true, hint: 'load + assign' }, [
      el('div', { class: 'muted', style: { whiteSpace: 'pre-wrap' } }, [
        'Load a motion library, filter clips, then assign them to locomotion slots.',
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [motionUrl, useUal2Btn]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [loadClipsBtn, autoFillBtn, fillClipPathsBtn]),
      clipStatus,
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [clipFilter, clipVendor]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, [
        el('div', { class: 'muted' }, ['active slot']),
        activeSlot,
        applyFirstClipBtn,
      ]),
      clipLib,
      slotsCard,
    ]));

    root.appendChild(detailsCard('Step 4: Apply + Export', { open: true, hint: 'retarget pack' }, [
      el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, [
        startBtn,
        killBtn,
        copyOutputBtn,
        openViewerBtn,
        setGameplayBtn,
      ]),
      status,
      log,
    ]));

    root.appendChild(detailsCard('Standalone Bridge', { open: false, hint: 'optional' }, [
      el('div', { class: 'muted', style: { whiteSpace: 'pre-wrap' } }, [
        'Launch Mesh2Motion (repos/mesh2motion-app) and bridge export → this repo assets/.',
        'Tip: export inside Mesh2Motion; it will still download locally, but also gets written into assets/generated/mesh2motion.',
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [standaloneUrl, checkStandaloneBtn, openStandaloneBtn]),
      standaloneStatus,
      el('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } }, [
        openCreateBtn,
        openRetargetBtn,
        sendModelToCreateBtn,
        sendLastOutputToRetargetBtn,
      ]),
      savedPath,
    ]));

    root.appendChild(detailsCard('Standalone Pipeline Smoke Test', { open: false, hint: 'tools/mesh2motion_pipeline_test.mjs' }, [
      el('div', { class: 'muted', style: { whiteSpace: 'pre-wrap' } }, [
        'Runs the Playwright smoke test against standalone Mesh2Motion.',
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px' } }, [smokeStartBtn, smokeKillBtn]),
      smokeStatus,
      smokeLog,
    ]));

    this._initViewer(viewerStatus);
    if (!this._viewer?.model && String(st.modelUrl || '').trim()) {
      void this._viewerLoadModelFromPath(String(st.modelUrl || '').trim(), viewerStatus);
    }
  }

  _initViewer(statusEl) {
    if (this._viewer?.renderer) {
      this._viewer.statusEl = statusEl || this._viewer.statusEl;
      return;
    }
    const host = this._ctx?.canvasHost;
    if (!host) return;
    clear(host);
    host.style.position = 'relative';
    const canvas = document.createElement('canvas');
    canvas.style.position = 'fixed';
    canvas.style.inset = '0';
    canvas.style.width = '100vw';
    canvas.style.height = '100vh';
    canvas.style.display = 'block';
    host.appendChild(canvas);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111217);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
    camera.position.set(1.4, 1.2, 2.2);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(Math.max(320, window.innerWidth || 320), Math.max(240, window.innerHeight || 240), false);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x2c3440, 1.1);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(4, 6, 3);
    scene.add(dir);
    const grid = new THREE.GridHelper(8, 16, 0x334155, 0x1f2937);
    scene.add(grid);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0.9, 0);
    controls.update();

    const loader = new GLTFLoader();

    const fit = () => {
      const w = Math.max(240, window.innerWidth || host.clientWidth || 320);
      const h = Math.max(180, window.innerHeight || host.clientHeight || 240);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    };
    fit();

    const resizeObs = new ResizeObserver(() => fit());
    resizeObs.observe(host);

    const tick = () => {
      controls.update();
      renderer.render(scene, camera);
      this._viewer.raf = requestAnimationFrame(tick);
    };
    this._viewer = { host, canvas, statusEl, renderer, scene, camera, controls, loader, model: null, raf: requestAnimationFrame(tick), resizeObs };
  }

  _disposeViewer() {
    const v = this._viewer;
    if (!v) return;
    try { if (v.raf) cancelAnimationFrame(v.raf); } catch { /* ignore */ }
    try { v.resizeObs?.disconnect?.(); } catch { /* ignore */ }
    try { v.controls?.dispose?.(); } catch { /* ignore */ }
    try {
      if (v.model && v.scene) v.scene.remove(v.model);
    } catch { /* ignore */ }
    try { v.renderer?.dispose?.(); } catch { /* ignore */ }
    try { v.canvas?.remove?.(); } catch { /* ignore */ }
    try { v.renderer?.domElement?.remove?.(); } catch { /* ignore */ }
    try { clear(this._ctx?.canvasHost); } catch { /* ignore */ }
    this._viewer = { host: null, canvas: null, statusEl: null, renderer: null, scene: null, camera: null, controls: null, loader: null, model: null, raf: 0, resizeObs: null };
  }

  _normalizeViewerUrl(p) {
    const raw = String(p || '').trim().replace(/\\/g, '/');
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw) || raw.startsWith('data:') || raw.startsWith('blob:')) return raw;
    let rel = raw;
    rel = rel.replace(/^\/data\/webgl-game\//, '');
    rel = rel.replace(/^\/+/, '');
    return `/${rel}`;
  }

  _withParams(url, params) {
    try {
      const u = new URL(String(url || '').trim());
      for (const [k, v] of Object.entries(params || {})) {
        if (v == null) continue;
        u.searchParams.set(String(k), String(v));
      }
      return u.toString();
    } catch {
      return String(url || '').trim();
    }
  }

  _buildM2MCreateUrl() {
    const st = this._state;
    const base = String(st.standaloneUrl || '').trim() || '/mesh2motion/create.html';
    return this._withParams(base, {
      bridge: 'webgl',
      autofix: '1',
      folder: 'assets/generated/mesh2motion',
      saveUrl: `${window.location.origin}/__devtools_mesh2motion_save_asset`,
    });
  }

  _buildM2MRetargetUrl() {
    const st = this._state;
    const baseCreate = String(st.standaloneUrl || '').trim() || '/mesh2motion/create.html';
    const base = baseCreate.replace(/\/create\.html(\?.*)?$/i, '/retarget.html');
    return this._withParams(base, {
      bridge: 'webgl',
      folder: 'assets/generated/mesh2motion',
      saveUrl: `${window.location.origin}/__devtools_mesh2motion_save_asset`,
    });
  }

  async _sendModelToM2MWindow({ win, modelPath, messageType }) {
    const w = win;
    if (!w || w.closed) throw new Error('Mesh2Motion window is not open');
    const inputPath = String(modelPath || '').trim();
    if (!inputPath) throw new Error('Missing model path');

    const fileName = inputPath.split('/').filter(Boolean).at(-1) || 'upload.glb';
    const url = this._normalizeViewerUrl(inputPath);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch model: ${resp.status}`);
    const blob = await resp.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('file read failed'));
      reader.onload = () => resolve(String(reader.result || ''));
      reader.readAsDataURL(blob);
    });
    w.postMessage({ type: String(messageType || ''), fileName, dataUrl }, '*');
  }

  _installWindowMessageListener() {
    if (this._onWindowMessage) return;
    this._onWindowMessage = (ev) => {
      try {
        const d = ev?.data || {};
        if (String(d?.type || '') !== 'M2M_SAVED_ASSET') return;
        const p = String(d?.path || '').trim();
        if (!p) return;
        this._state.savedAssetPath = p;
        try { localStorage.setItem('devtools.lastGeneratedModelUrl', p); } catch { /* ignore */ }
        this._ctx?.toast?.(`Saved to ${p}`, 'success', { title: 'Mesh2Motion export' });
        this._buildUi();
      } catch { /* ignore */ }
    };
    window.addEventListener('message', this._onWindowMessage);
  }

  _removeWindowMessageListener() {
    if (!this._onWindowMessage) return;
    try { window.removeEventListener('message', this._onWindowMessage); } catch { /* ignore */ }
    this._onWindowMessage = null;
  }

  async _viewerLoadModelFromPath(inputPath, statusEl) {
    const v = this._viewer;
    if (!v?.loader || !v?.scene || !v?.camera || !v?.controls) return;
    const url = this._normalizeViewerUrl(inputPath);
    if (!url) return;
    if (statusEl) statusEl.textContent = `Viewer: loading ${url}`;
    try {
      const gltf = await new Promise((resolve, reject) => {
        v.loader.load(url, resolve, undefined, reject);
      });
      if (v.model) v.scene.remove(v.model);
      const root = gltf?.scene || (Array.isArray(gltf?.scenes) ? gltf.scenes[0] : null);
      if (!root) throw new Error('No scene in model');
      v.model = root;
      v.scene.add(root);

      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z, 0.5);
      const dist = maxDim * 1.6;
      v.camera.position.set(center.x + dist, center.y + dist * 0.65, center.z + dist);
      v.controls.target.copy(center);
      v.controls.update();
      if (statusEl) statusEl.textContent = 'Viewer: loaded';
    } catch (e) {
      if (statusEl) statusEl.textContent = `Viewer load failed: ${e?.message || e}`;
    }
  }

  _buildAssetPicker({ title, ext, onPick, allowEmptyQuery = false }) {
    const ctx = this._ctx;
    const queryInput = el('input', { placeholder: allowEmptyQuery ? 'search assets (optional; empty to list)' : 'search assets (e.g. character)' });
    const list = el('div', { class: 'scrollArea', style: { height: '140px' } }, ['(search to populate)']);
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
        for (const it of items.slice(0, 120)) {
          const p = String(it?.path || '');
          list.appendChild(el('button', {
            class: 'toolBtn',
            style: { marginTop: '6px' },
            onclick: () => onPick(p),
          }, [p]));
        }
      } catch (e) {
        list.textContent = `(error) ${e?.message || e}`;
      }
    };
    queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') refresh(); });
    return el('div', { class: 'card', style: { marginTop: '8px' } }, [
      el('div', { class: 'dockTitle' }, [String(title || 'Assets')]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [queryInput, el('button', { onclick: refresh }, ['Search'])]),
      el('div', { style: { marginTop: '8px' } }, [list]),
    ]);
  }

  _renderClipLibraryList() {
    const st = this._state;
    const clips = Array.isArray(this._motionClips) ? this._motionClips : [];
    const host = el('div', { class: 'scrollArea', style: { height: '190px', marginTop: '8px', whiteSpace: 'pre-wrap' } }, []);
    if (!clips.length) {
      host.textContent = '(load clips to populate)';
      return host;
    }
    const filter = String(st.clipFilter || '').trim().toLowerCase();
    const vendor = String(st.clipVendor || 'all');
    const shown = [];
    for (const c of clips) {
      const name = String(c?.name || '').trim();
      if (!name) continue;
      const isNvd = isNvidiaAnimName(name);
      if (vendor === 'nvidia' && !isNvd) continue;
      if (vendor === 'other' && isNvd) continue;
      if (filter && !name.toLowerCase().includes(filter)) continue;
      shown.push(name);
    }
    host.appendChild(el('div', { class: 'muted', style: { marginBottom: '6px' } }, [`showing ${shown.length} clip(s)`]));
    if (!shown.length) {
      host.appendChild(el('div', { class: 'muted' }, ['(no matches)']));
      return host;
    }
    for (const name of shown.slice(0, 400)) {
      host.appendChild(el('button', {
        class: 'toolBtn',
        style: { marginTop: '6px' },
        onclick: () => {
          const slot = String(st.activeSlot || 'idle');
          const ent = st.clips[slot] || (st.clips[slot] = { motionPath: '', motionClip: '' });
          ent.motionClip = name;
          if (!String(ent.motionPath || '').trim()) ent.motionPath = String(st.motionUrl || '').trim();
          this._buildUi();
        },
        title: `Assign to ${String(st.activeSlot || 'idle')}`,
      }, [name]));
    }
    return host;
  }

  _renderLocomotionSlots() {
    const st = this._state;
    const keys = [
      'idle',
      'walk_fwd', 'walk_back', 'walk_left', 'walk_right',
      'run_fwd', 'run_back', 'run_left', 'run_right',
      'jump_start', 'jump_air', 'jump_land',
    ];
    const host = el('div', { class: 'card', style: { marginTop: '10px' } }, []);
    host.appendChild(el('div', { class: 'muted', style: { whiteSpace: 'pre-wrap' } }, ['Editable slot mapping (similar flow to Mesh2Motion create/retarget).']));
    for (const k of keys) {
      const ent = st.clips[k] || (st.clips[k] = { motionPath: '', motionClip: '' });
      const p = el('input', {
        value: String(ent.motionPath || ''),
        placeholder: 'motionPath',
        oninput: (e) => { ent.motionPath = String(e.target.value || '').trim(); },
      });
      const c = el('input', {
        value: String(ent.motionClip || ''),
        placeholder: 'motionClip',
        onfocus: () => { st.activeSlot = k; },
        oninput: (e) => { ent.motionClip = String(e.target.value || '').trim(); },
      });
      host.appendChild(el('div', { class: 'row', style: { marginTop: '8px', gap: '8px' } }, [
        el('button', {
          class: `toolBtn${String(st.activeSlot || 'idle') === k ? ' active' : ''}`,
          style: { flex: '0 0 96px' },
          onclick: () => {
            st.activeSlot = k;
            this._buildUi();
          },
        }, [k]),
        p,
        c,
      ]));
    }
    return host;
  }

  _getVisibleClipNames() {
    const st = this._state;
    const clips = Array.isArray(this._motionClips) ? this._motionClips : [];
    const filter = String(st.clipFilter || '').trim().toLowerCase();
    const vendor = String(st.clipVendor || 'all');
    return clips
      .map((x) => String(x?.name || '').trim())
      .filter(Boolean)
      .filter((name) => {
        const isNvd = isNvidiaAnimName(name);
        if (vendor === 'nvidia' && !isNvd) return false;
        if (vendor === 'other' && isNvd) return false;
        if (filter && !name.toLowerCase().includes(filter)) return false;
        return true;
      });
  }

  async _loadMotionClips() {
    const st = this._state;
    const motionPath = String(st.motionUrl || '').trim();
    if (!motionPath) throw new Error('Set motionUrl first');
    const resp = await fetch('/__devtools_anim_list_clips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runner: String(st.runner || 'conda_trellis'),
        blenderPath: String(st.blenderPath || ''),
        motionPath,
      }),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'list clips failed'));
    this._motionClips = Array.isArray(j?.clips) ? j.clips : [];
    return this._motionClips;
  }

  _autoFillLocomotionFromLoadedClips({ preferNvidia = true } = {}) {
    const st = this._state;
    const clips = Array.isArray(this._motionClips) ? this._motionClips : [];
    if (!clips.length) throw new Error('Load clips first');
    const aliases = {
      idle: ['idle', 'stand', 'rest', 'idle_no_loop', 'idle_foldarms_loop', 'zombie_idle_loop'],
      walk_fwd: ['walk_fwd', 'walkforward', 'walk_forward', 'walk', 'walk_carry_loop', 'zombie_walk_fwd_loop'],
      walk_back: ['walk_back', 'walkback', 'walkbackward', 'walk_backward'],
      walk_left: ['walk_left', 'walkleft', 'strafeleft', 'strafe_left'],
      walk_right: ['walk_right', 'walkright', 'straferight', 'strafe_right'],
      run_fwd: ['run_fwd', 'runforward', 'run_forward', 'run', 'jog', 'sprint'],
      run_back: ['run_back', 'runback', 'runbackward', 'run_backward'],
      run_left: ['run_left', 'runleft', 'run_strafeleft'],
      run_right: ['run_right', 'runright', 'run_straferight'],
      jump_start: ['jump_start', 'jumpstart', 'jump_takeoff', 'takeoff', 'jump'],
      jump_air: ['jump_air', 'jumpair', 'inair', 'air', 'fall'],
      jump_land: ['jump_land', 'jumpland', 'land', 'landing'],
    };
    let n = 0;
    for (const [k, a] of Object.entries(aliases)) {
      const ent = st.clips[k] || (st.clips[k] = { motionPath: '', motionClip: '' });
      const picked = pickClipByAliases(clips, a, { preferNvidia: !!preferNvidia });
      if (picked) {
        ent.motionClip = picked;
        if (!String(ent.motionPath || '').trim()) ent.motionPath = String(st.motionUrl || '').trim();
        n++;
      }
    }
    const defaultMap = 'tools/rigging/mappings/example_map.json';
    const nvdMap = 'tools/rigging/mappings/nvidia_biped_demo_to_zimage.json';
    const hasNvd = Object.values(st.clips || {}).some((ent) => isNvidiaAnimName(String(ent?.motionClip || '')));
    if (hasNvd && String(st.mapUrl || '').trim() === defaultMap) st.mapUrl = nvdMap;
    return { filled: n };
  }

  async _uploadCharacterFile(file) {
    const reader = new FileReader();
    const dataUrl = await new Promise((resolve, reject) => {
      reader.onerror = () => reject(new Error('file read failed'));
      reader.onload = () => resolve(String(reader.result || ''));
      reader.readAsDataURL(file);
    });
    const resp = await fetch('/__devtools_mesh2motion_upload_asset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: String(file?.name || 'upload.glb'),
        dataUrl,
      }),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'upload failed'));
    return String(j?.path || '');
  }

  async _runMesh2Motion({ statusEl, logEl }) {
    const st = this._state;
    const model = String(st.modelUrl || '').trim();
    const mapPath = String(st.mapUrl || '').trim();
    if (!model) throw new Error('Set modelUrl first');
    if (!mapPath) throw new Error('Set mapPath first');

    // Step 1: optional rigging
    let rigPath = model;
    if (Number(st.autoRig)) {
      statusEl.textContent = 'Step 1/2: auto-rigging...';
      const rigResp = await fetch('/__devtools_rig_start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runner: String(st.runner || 'conda_trellis'),
          inModelPath: model,
          rigBackend: String(st.rigBackend || 'rigify'),
          rigArgs: '--deform-only',
          blenderPath: String(st.blenderPath || ''),
          outName: String(st.outName || 'mesh2motion_locomotion'),
        }),
      });
      const rigJson = await rigResp.json();
      if (!rigJson?.ok) throw new Error(String(rigJson?.error || 'rig start failed'));
      this._rigJob = { id: String(rigJson.id || ''), status: 'running', outRig: String(rigJson.outRig || ''), stdout: '', stderr: '' };
      rigPath = await this._waitRigDone({ id: this._rigJob.id, statusEl, logEl });
    }

    // Step 2: locomotion pack
    const clips = [];
    for (const [clipName, ent] of Object.entries(st.clips || {})) {
      const motionPath = String(ent?.motionPath || '').trim();
      if (!motionPath) continue;
      clips.push({
        clipName,
        motionPath,
        motionClip: String(ent?.motionClip || '').trim(),
      });
    }
    if (!clips.length) throw new Error('Configure at least one clip (idle.motionPath recommended)');

    statusEl.textContent = 'Step 2/2: building locomotion pack...';
    logEl.textContent = '(starting...)';

    const resp = await fetch('/__devtools_anim_locomotion_pack_start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runner: String(st.runner || 'conda_trellis'),
        blenderPath: String(st.blenderPath || ''),
        rigPath,
        mapPath,
        clips,
        exportFormat: String(st.exportFormat || 'GLB'),
        includeMesh: Number(st.includeMesh) ? 1 : 0,
        outName: String(st.outName || 'mesh2motion_locomotion').trim(),
      }),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'locomotion start failed'));
    this._animJob = { id: String(j.id || ''), status: 'running', outGlb: String(j.outGlb || ''), stdout: '', stderr: '' };
    this._pollingAnim = true;
    await this._pollAnimJob({ id: this._animJob.id, statusEl, logEl });
  }

  async _waitRigDone({ id, statusEl, logEl }) {
    if (!id) throw new Error('Missing rig job id');
    let backoff = 500;
    while (true) {
      const resp = await fetch(`/__devtools_rig_job?id=${encodeURIComponent(id)}`);
      const j = await resp.json();
      if (!j?.ok) throw new Error(String(j?.error || 'rig query failed'));
      const s = String(j.status || '');
      const outRig = String(j.outRig || '').trim();
      statusEl.textContent = `Rig job: ${s}${outRig ? `\nRig: ${outRig}` : ''}`;
      const out = String(j.stdout || '');
      const err = String(j.stderr || '');
      logEl.textContent = (err ? (out + '\n--- stderr ---\n' + err) : out) || '(no output yet)';
      if (s === 'done') {
        if (!outRig) throw new Error('Rig finished but no output');
        try { localStorage.setItem('devtools.lastGeneratedModelUrl', outRig); } catch { /* ignore */ }
        return outRig;
      }
      if (s === 'error' || s === 'killed') throw new Error(`Rig job ${s}`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(1500, Math.floor(backoff * 1.2));
    }
  }

  async _pollAnimJob({ id, statusEl, logEl }) {
    let backoff = 400;
    while (this._pollingAnim && this._animJob?.id === id) {
      try {
        const resp = await fetch(`/__devtools_anim_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'anim job query failed'));
        this._animJob.status = String(j.status || '');
        this._animJob.stdout = String(j.stdout || '');
        this._animJob.stderr = String(j.stderr || '');
        this._animJob.outGlb = String(j.outGlb || this._animJob.outGlb || '');

        statusEl.textContent = `Locomotion pack: ${this._animJob.status}${this._animJob.outGlb ? `\nOutput: ${this._animJob.outGlb}` : ''}`;
        logEl.textContent = (this._animJob.stderr ? (this._animJob.stdout + '\n--- stderr ---\n' + this._animJob.stderr) : this._animJob.stdout) || '(no output yet)';
        try { logEl.scrollTop = logEl.scrollHeight; } catch { /* ignore */ }

        if (this._animJob.status === 'done' || this._animJob.status === 'error' || this._animJob.status === 'killed') {
          this._pollingAnim = false;
          if (this._animJob.status === 'done') {
            const out = String(this._animJob.outGlb || '').trim();
            if (out) {
              try { localStorage.setItem('devtools.lastGeneratedModelUrl', out); } catch { /* ignore */ }
              try { localStorage.setItem('gameplay.avatarUrl', out); } catch { /* ignore */ }
              this._ctx?.toast?.('Mesh2Motion flow complete', 'success', { title: 'Mesh2Motion' });
            }
          }
          return;
        }
        backoff = 500;
      } catch (e) {
        statusEl.textContent = `Anim polling failed: ${e?.message || e}`;
        backoff = Math.min(2000, Math.floor(backoff * 1.4));
      }
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  async _startSmokeTest({ statusEl, logEl }) {
    const resp = await fetch('/__devtools_mesh2motion_test_start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'start failed'));
    this._smokeJob = { id: String(j.id || ''), status: 'running', stdout: '', stderr: '' };
    this._pollingSmoke = true;
    statusEl.textContent = 'Smoke test running...';
    await this._pollSmokeJob({ id: this._smokeJob.id, statusEl, logEl });
  }

  async _pollSmokeJob({ id, statusEl, logEl }) {
    let backoff = 500;
    while (this._pollingSmoke && this._smokeJob?.id === id) {
      try {
        const resp = await fetch(`/__devtools_mesh2motion_test_job?id=${encodeURIComponent(id)}`);
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'job query failed'));
        this._smokeJob.status = String(j.status || '');
        this._smokeJob.stdout = String(j.stdout || '');
        this._smokeJob.stderr = String(j.stderr || '');
        statusEl.textContent = `Smoke test: ${this._smokeJob.status}`;
        logEl.textContent = (this._smokeJob.stderr ? (this._smokeJob.stdout + '\n--- stderr ---\n' + this._smokeJob.stderr) : this._smokeJob.stdout) || '(no output yet)';
        try { logEl.scrollTop = logEl.scrollHeight; } catch { /* ignore */ }
        if (this._smokeJob.status === 'done' || this._smokeJob.status === 'error' || this._smokeJob.status === 'killed') {
          this._pollingSmoke = false;
          return;
        }
        backoff = 700;
      } catch (e) {
        statusEl.textContent = `Smoke polling failed: ${e?.message || e}`;
        backoff = Math.min(2500, Math.floor(backoff * 1.4));
      }
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

