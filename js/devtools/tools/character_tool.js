import { el, clear } from '../../ui/dom.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

function normClipName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, '').replace(/[-_.:]/g, '');
}

function clipNameFromPath(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  const tail = s.split('/').pop() || s;
  return String(tail).replace(/\.[^.]+$/, '').trim();
}

function extFromPath(p) {
  const s = String(p || '').trim().split('#')[0].split('?')[0];
  if (!s) return '';
  const i = s.lastIndexOf('.');
  if (i < 0) return '';
  return s.slice(i).toLowerCase();
}

function isGenericImportedClipName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return true;
  if (n === 'default') return true;
  if (n === 'take' || n === 'take 001' || n === 'take001') return true;
  if (n === 'layer0' || n === 'layer 0') return true;
  if (n === 'armature|mixamo.com|layer0') return true;
  if (n === 'armature|mixamo.com|layer 0') return true;
  if (n === 'armature|mixamo.com|mixamo.com|layer0') return true;
  if (/^(armature\|)?layer\s*0$/i.test(n)) return true;
  return false;
}

function clipDisplayNameForFile(rawName, filePath, clipIndex = 0, clipCount = 1) {
  const fallback = clipNameFromPath(filePath);
  const base = String(rawName || '').trim();
  if (!base || isGenericImportedClipName(base)) {
    if (!fallback) return base;
    if (clipCount > 1) return `${fallback}#${clipIndex + 1}`;
    return fallback;
  }
  return base;
}

function errorTailText(...parts) {
  for (const p of parts) {
    const lines = String(p || '').split(/\r?\n/).map((x) => String(x || '').trim()).filter(Boolean);
    if (lines.length) return lines[lines.length - 1];
  }
  return '';
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

function pickIdleLikeClipName(clips) {
  const picked = pickClipByAliases(clips, ['idle', 'stand', 'rest', 'idle_loop', 'idle_no_loop'], { preferNvidia: false });
  return String(picked || '').trim();
}

const LOCOMOTION_SLOT_KEYS = [
  'idle',
  'walk_fwd', 'walk_back', 'walk_left', 'walk_right',
  'run_fwd', 'run_back', 'run_left', 'run_right',
  'turn_left', 'turn_right',
  'jump_start', 'jump_air', 'jump_land',
];

function safeCharacterId(raw) {
  const s = String(raw || '').trim();
  const id = s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
  return id || 'character';
}

function defaultSlots() {
  const p = '';
  return {
    idle: { motionPath: p, motionClip: '' },
    walk_fwd: { motionPath: p, motionClip: '' },
    walk_back: { motionPath: p, motionClip: '' },
    walk_left: { motionPath: p, motionClip: '' },
    walk_right: { motionPath: p, motionClip: '' },
    run_fwd: { motionPath: p, motionClip: '' },
    run_back: { motionPath: p, motionClip: '' },
    run_left: { motionPath: p, motionClip: '' },
    run_right: { motionPath: p, motionClip: '' },
    turn_left: { motionPath: p, motionClip: '' },
    turn_right: { motionPath: p, motionClip: '' },
    jump_start: { motionPath: p, motionClip: '' },
    jump_air: { motionPath: p, motionClip: '' },
    jump_land: { motionPath: p, motionClip: '' },
  };
}

function resizeCanvasToDisplaySize(canvasEl, maxDpr = 2.0) {
  if (!canvasEl) return { changed: false, dpr: 1, w: 1, h: 1 };
  const dpr = Math.min(maxDpr, window.devicePixelRatio || 1);
  const rect = canvasEl.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (canvasEl.width !== w || canvasEl.height !== h) {
    canvasEl.width = w;
    canvasEl.height = h;
    return { changed: true, dpr, w, h };
  }
  return { changed: false, dpr, w: canvasEl.width || w, h: canvasEl.height || h };
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

export class CharacterTool {
  constructor() {
    this.id = 'character';
    this.label = 'Character';

    this._ctx = null;
    this._root = null;

    this._state = {
      profileName: 'sample_multi',
      manifestPath: '',
      modelUrl: '',
      rigPath: '',
      modelRotationDeg: [0, 0, 0],
      textureUrl: '',
      mapUrl: 'tools/rigging/mappings/example_map.json',
      motionUrl: '',
      runner: 'conda_trellis',
      blenderPath: '',
      outName: 'sample_multi_locomotion',
      includeMesh: 1,
      exportFormat: 'GLB',
      clipFilter: '',
      clipVendor: 'all',
      activeSlot: 'idle',
      selectedMotionClip: '',
      selectedMotionPath: '',
      slots: defaultSlots(),
    };

    this._profiles = {};
    this._characterManifests = [];
    this._motionClips = [];
    this._motionClipsLoading = false;
    this._rigJob = { id: '', status: '', outRig: '', stdout: '', stderr: '' };
    this._animJob = { id: '', status: '', outGlb: '', stdout: '', stderr: '' };
    this._pollingRig = false;
    this._pollingAnim = false;
    this._workspaceHost = null;
    this._workspaceStatusEl = null;
    this._workspaceSummaryEl = null;

    this._workspaceCanvas = null;
    this._workspaceRenderer = null;
    this._workspaceScene = null;
    this._workspaceCamera = null;
    this._workspaceControls = null;
    this._workspaceClock = new THREE.Clock();
    this._workspaceGrid = null;
    this._workspaceModelRoot = null;
    this._workspaceGltf = null;
    this._workspaceMixer = null;
    this._workspaceActiveClip = '';
    this._workspaceLoadedModelUrl = '';
    this._workspaceIsLoading = false;
    this._workspacePlay = true;
    this._workspaceSpeed = 1.0;
    this._workspaceAutoConnectBusy = false;
    this._workspaceViewerStatusEl = null;
    this._workspaceModelInputEl = null;
    this._workspaceAnimSelectEl = null;
    this._workspacePlayBtn = null;
    this._workspaceCharacterSelectEl = null;
    this._workspaceModelClipFilterEl = null;
    this._workspaceModelClipListEl = null;
    this._workspaceMotionClipSelectEl = null;
    this._workspaceMotionClipListEl = null;
    this._workspaceMotionClipStatusEl = null;
    this._workspaceRetargetLogEl = null;
    this._workspaceDeferredSourcePreviewTimer = 0;
    this._workspaceUnifyAllBtn = null;
    this._workspaceQueuedLoad = null;
    this._workspaceLastDpr = 1.0;
    this._autoUnifyTimer = 0;
    this._autoUnifyBusy = false;
    this._autoUnifyEnabled = true;
    this._autoUnifyCooldownMs = 45_000;
    this._autoUnifyLastStartMsByProfile = {};
  }

  _loadUnifiedModelCache() {
    try {
      const raw = String(localStorage.getItem('devtools.character.unifiedByProfile') || '').trim();
      const j = raw ? JSON.parse(raw) : {};
      return (j && typeof j === 'object') ? j : {};
    } catch {
      return {};
    }
  }

  _saveUnifiedModelCache(cache) {
    try { localStorage.setItem('devtools.character.unifiedByProfile', JSON.stringify(cache || {})); } catch { /* ignore */ }
  }

  _loadUnifiedInputSigCache() {
    try {
      const raw = String(localStorage.getItem('devtools.character.unifiedInputSigByProfile') || '').trim();
      const j = raw ? JSON.parse(raw) : {};
      return (j && typeof j === 'object') ? j : {};
    } catch {
      return {};
    }
  }

  _saveUnifiedInputSigCache(cache) {
    try { localStorage.setItem('devtools.character.unifiedInputSigByProfile', JSON.stringify(cache || {})); } catch { /* ignore */ }
  }

  _loadAutoUnifyEnabled() {
    try {
      const raw = String(localStorage.getItem('devtools.character.autoUnifyEnabled') || '').trim();
      if (!raw) return true;
      return raw !== '0' && raw !== 'false';
    } catch {
      return true;
    }
  }

  _saveAutoUnifyEnabled(enabled) {
    try { localStorage.setItem('devtools.character.autoUnifyEnabled', enabled ? '1' : '0'); } catch { /* ignore */ }
  }

  _getUnifiedInputSigForProfile(profileName) {
    const key = String(profileName || this._state?.profileName || '').trim();
    if (!key) return '';
    const cache = this._loadUnifiedInputSigCache();
    return String(cache?.[key] || '').trim();
  }

  _setUnifiedInputSigForProfile(profileName, inputSig) {
    const key = String(profileName || this._state?.profileName || '').trim();
    const sig = String(inputSig || '').trim();
    if (!key || !sig) return;
    const cache = this._loadUnifiedInputSigCache();
    cache[key] = sig;
    this._saveUnifiedInputSigCache(cache);
  }

  _computeUnifiedInputSignature({ profileName, rigPath, mapPath, sourceEntries }) {
    const profile = String(profileName || '').trim();
    const rig = String(rigPath || '').trim();
    const map = String(mapPath || '').trim();
    const rows = (Array.isArray(sourceEntries) ? sourceEntries : [])
      .map((x) => ({
        name: String(x?.name || '').trim(),
        sourcePath: String(x?.sourcePath || '').trim(),
      }))
      .filter((x) => x.name && x.sourcePath)
      .map((x) => `${x.sourcePath}::${normClipName(x.name)}`)
      .sort((a, b) => a.localeCompare(b));
    const payload = `${profile}\n${rig}\n${map}\n${rows.join('\n')}`;
    let h = 2166136261;
    for (let i = 0; i < payload.length; i++) {
      h ^= payload.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return `${profile}:${rows.length}:${(h >>> 0).toString(16)}`;
  }

  _getUnifiedModelForProfile(profileName) {
    const key = String(profileName || this._state?.profileName || '').trim();
    if (!key) return '';
    const cache = this._loadUnifiedModelCache();
    return String(cache?.[key] || '').trim();
  }

  async _findLatestUnifiedModelForProfile(profileName, currentPath = '') {
    const ctx = this._ctx;
    const key = String(profileName || '').trim().toLowerCase();
    if (!ctx || !key) {
      return {
        bestPath: '',
        bestMtimeMs: 0,
        currentFound: false,
        currentMtimeMs: 0,
      };
    }
    const out = [];
    const seen = new Set();
    const queries = [
      `assets/animations/${key}_unified_clips`,
      `assets/animations/${key}`,
      `assets/generated/${key}`,
      `${key}_unified_clips`,
      `${key} unified`,
    ];
    for (const q of queries) {
      let items = [];
      try { items = await ctx.assetIndex({ query: q, ext: '.glb,.gltf' }); } catch { items = []; }
      for (const it of (Array.isArray(items) ? items : [])) {
        const p = String(it?.path || '').trim().replace(/^\/+/, '');
        if (!p || seen.has(p)) continue;
        seen.add(p);
        const low = p.toLowerCase();
        if (!low.includes('unified')) continue;
        if (!low.includes(key)) continue;
        const base = String(low.split('/').pop() || low);
        let score = 0;
        if (low.includes('assets/animations/')) score += 300;
        if (base.startsWith(`${key}_unified_clips`)) score += 250;
        if (base.includes(`${key}_unified`)) score += 180;
        if (base.includes('unified_clips')) score += 120;
        if (base.includes(`${key}_`)) score += 80;
        const debugMatch = base.match(/debug[_-]?(\d+)/);
        if (debugMatch) score += 20 + (Number(debugMatch[1]) || 0);
        out.push({
          path: p,
          mtimeMs: Number(it?.mtimeMs) || 0,
          score,
        });
      }
    }
    out.sort((a, b) => (
      (Number(b.score) || 0) - (Number(a.score) || 0)
      || (Number(b.mtimeMs) || 0) - (Number(a.mtimeMs) || 0)
      || String(b.path || '').localeCompare(String(a.path || ''))
    ));
    const best = out[0] || null;
    const current = String(currentPath || '').trim().replace(/^\/+/, '');
    const currentHit = current ? (out.find((x) => x.path === current) || null) : null;
    return {
      bestPath: String(best?.path || '').trim(),
      bestMtimeMs: Number(best?.mtimeMs) || 0,
      currentFound: !!currentHit,
      currentMtimeMs: Number(currentHit?.mtimeMs) || 0,
    };
  }

  _setUnifiedModelForProfile(profileName, modelPath) {
    const key = String(profileName || this._state?.profileName || '').trim();
    const p = String(modelPath || '').trim();
    if (!key || !p) return;
    const cache = this._loadUnifiedModelCache();
    cache[key] = p;
    this._saveUnifiedModelCache(cache);
  }

  _clearUnifiedModelForProfile(profileName) {
    const key = String(profileName || this._state?.profileName || '').trim();
    if (!key) return;
    const cache = this._loadUnifiedModelCache();
    if (!Object.prototype.hasOwnProperty.call(cache, key)) return;
    delete cache[key];
    this._saveUnifiedModelCache(cache);
  }

  _applyUnifiedModelIfAvailable() {
    const st = this._state;
    const unified = this._getUnifiedModelForProfile(st.profileName);
    if (unified) st.modelUrl = unified;
    return unified;
  }

  async _ensureUnifiedModelValidForProfile(profileName) {
    const key = String(profileName || this._state?.profileName || '').trim();
    if (!key) return '';
    const unified = this._getUnifiedModelForProfile(key);
    const scan = await this._findLatestUnifiedModelForProfile(key, unified);
    const discovered = String(scan?.bestPath || '').trim();
    if (discovered) {
      const shouldUseDiscovered = (
        !unified
        || discovered === unified
        || !scan.currentFound
        || Number(scan.bestMtimeMs || 0) >= Number(scan.currentMtimeMs || 0)
      );
      if (shouldUseDiscovered) {
        this._setUnifiedModelForProfile(key, discovered);
        return discovered;
      }
    }
    if (!unified) return '';
    // Blender list-clips can report 0 for valid large multi-animation GLBs,
    // so do not invalidate cached unified outputs based on that probe alone.
    return unified;
  }

  _syncWorkspaceUnifyButton() {
    const btn = this._workspaceUnifyAllBtn;
    if (!btn) return;
    // Keep action visible so users can rebuild if auto-unify output is stale.
    btn.style.display = '';
    const unified = this._getUnifiedModelForProfile(this._state?.profileName);
    btn.textContent = String(unified || '').trim() ? 'Rebuild unified clips' : 'Unify all loaded clips';
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;
    this._loadProfiles();
    this._hydrateDefaults();
    try { await this._loadCharacterManifests(); } catch { /* ignore */ }
    this._buildWorkspace();
    this._buildUi();
  }

  async unmount() {
    this._pollingRig = false;
    this._pollingAnim = false;
    try {
      if (this._workspaceHost?.parentNode) this._workspaceHost.parentNode.removeChild(this._workspaceHost);
    } catch { /* ignore */ }
    this._workspaceHost = null;
    this._workspaceStatusEl = null;
    this._workspaceSummaryEl = null;
    this._workspaceViewerStatusEl = null;
    this._workspaceModelInputEl = null;
    this._workspaceAnimSelectEl = null;
    this._workspacePlayBtn = null;
    this._workspaceAutoConnectBusy = false;
    this._workspaceCharacterSelectEl = null;
    this._workspaceModelClipFilterEl = null;
    this._workspaceModelClipListEl = null;
    this._workspaceMotionClipSelectEl = null;
    this._workspaceMotionClipListEl = null;
    this._workspaceMotionClipStatusEl = null;
    this._workspaceRetargetLogEl = null;
    this._workspaceUnifyAllBtn = null;
    if (this._workspaceDeferredSourcePreviewTimer) {
      try { globalThis.clearTimeout?.(this._workspaceDeferredSourcePreviewTimer); } catch { /* ignore */ }
      this._workspaceDeferredSourcePreviewTimer = 0;
    }
    if (this._autoUnifyTimer) {
      try { globalThis.clearTimeout?.(this._autoUnifyTimer); } catch { /* ignore */ }
      this._autoUnifyTimer = 0;
    }
    this._autoUnifyBusy = false;
    this._workspaceQueuedLoad = null;
    this._disposeWorkspaceViewer();
    this._ctx = null;
    this._root = null;
  }

  tick(dt) {
    if (!this._workspaceRenderer || !this._workspaceScene || !this._workspaceCamera || !this._workspaceCanvas) return;
    const { changed, dpr, w, h } = resizeCanvasToDisplaySize(this._workspaceCanvas, 2.0);
    if (Math.abs((Number(this._workspaceLastDpr) || 1) - dpr) > 1e-6) {
      this._workspaceRenderer.setPixelRatio(dpr);
      this._workspaceLastDpr = dpr;
    }
    if (changed && w > 0 && h > 0) {
      this._workspaceRenderer.setSize(w / dpr, h / dpr, false);
    }
    this._workspaceCamera.aspect = Math.max(1e-6, w / Math.max(1e-6, h));
    this._workspaceCamera.updateProjectionMatrix();
    this._workspaceControls?.update?.();

    const delta = Math.max(0, Math.min(0.25, Number(dt) || 0));
    if (this._workspaceMixer && this._workspacePlay) {
      this._workspaceMixer.update(delta * Math.max(0, Number(this._workspaceSpeed) || 1));
    }
    this._workspaceRenderer.render(this._workspaceScene, this._workspaceCamera);
  }

  getStats() {
    return {
      profile: this._state.profileName || '',
      model: this._state.modelUrl || '',
      rig: this._rigJob?.status || '',
      anim: this._animJob?.status || '',
      clips: Array.isArray(this._motionClips) ? this._motionClips.length : 0,
    };
  }

  _hydrateDefaults() {
    const st = this._state;
    this._autoUnifyEnabled = this._loadAutoUnifyEnabled();
    try {
      const p = String(localStorage.getItem('devtools.lastGeneratedModelUrl') || '').trim();
      if (p && !String(st.modelUrl || '').trim()) st.modelUrl = p;
      if (p && !String(st.rigPath || '').trim()) st.rigPath = p;
    } catch { /* ignore */ }
    try {
      const m = String(localStorage.getItem('devtools.lastMotionUrl') || '').trim();
      if (m && !String(st.motionUrl || '').trim()) st.motionUrl = m;
    } catch { /* ignore */ }
    try {
      const map = String(localStorage.getItem('devtools.lastAnimMapUrl') || '').trim();
      if (map && String(st.mapUrl || '').trim() === 'tools/rigging/mappings/example_map.json') st.mapUrl = map;
    } catch { /* ignore */ }
  }

  _loadProfiles() {
    try {
      const raw = String(localStorage.getItem('devtools.character.profiles') || '').trim();
      const j = raw ? JSON.parse(raw) : {};
      this._profiles = (j && typeof j === 'object') ? j : {};
    } catch {
      this._profiles = {};
    }
  }

  _saveProfiles() {
    try {
      localStorage.setItem('devtools.character.profiles', JSON.stringify(this._profiles || {}));
    } catch { /* ignore */ }
  }

  _snapshotStateForProfile() {
    const st = this._state;
    return {
      profileName: String(st.profileName || '').trim(),
      modelUrl: String(st.modelUrl || '').trim(),
      rigPath: String(st.rigPath || '').trim(),
      modelRotationDeg: Array.isArray(st.modelRotationDeg) ? st.modelRotationDeg.slice(0, 3) : [0, 0, 0],
      textureUrl: String(st.textureUrl || '').trim(),
      mapUrl: String(st.mapUrl || '').trim(),
      motionUrl: String(st.motionUrl || '').trim(),
      selectedMotionPath: String(st.selectedMotionPath || '').trim(),
      runner: String(st.runner || 'conda_trellis'),
      blenderPath: String(st.blenderPath || '').trim(),
      outName: String(st.outName || '').trim(),
      includeMesh: Number(st.includeMesh) ? 1 : 0,
      exportFormat: String(st.exportFormat || 'GLB'),
      slots: JSON.parse(JSON.stringify(st.slots || defaultSlots())),
    };
  }

  _loadProfile(name) {
    const key = String(name || '').trim();
    if (!key) return false;
    const p = this._profiles?.[key];
    if (!p || typeof p !== 'object') return false;
    const st = this._state;
    st.profileName = key;
    st.modelUrl = String(p.modelUrl || '');
    st.rigPath = String(p.rigPath || '');
    st.modelRotationDeg = Array.isArray(p.modelRotationDeg)
      ? p.modelRotationDeg.slice(0, 3).map((v) => Number.isFinite(Number(v)) ? Number(v) : 0)
      : [0, 0, 0];
    st.textureUrl = String(p.textureUrl || '');
    st.mapUrl = String(p.mapUrl || st.mapUrl || 'tools/rigging/mappings/example_map.json');
    st.motionUrl = String(p.motionUrl || '');
    st.runner = String(p.runner || 'conda_trellis');
    st.blenderPath = String(p.blenderPath || '');
    st.outName = String(p.outName || `${key}_locomotion`);
    st.includeMesh = Number(p.includeMesh) ? 1 : 0;
    st.exportFormat = String(p.exportFormat || 'GLB');
    st.selectedMotionPath = String(p.selectedMotionPath || '');
    st.slots = (p.slots && typeof p.slots === 'object') ? p.slots : defaultSlots();
    this._applyUnifiedModelIfAvailable();
    return true;
  }

  _ensureSlotMapDefaults() {
    const st = this._state;
    const base = defaultSlots();
    st.slots = (st.slots && typeof st.slots === 'object') ? st.slots : {};
    for (const [k, v] of Object.entries(base)) {
      st.slots[k] = (st.slots[k] && typeof st.slots[k] === 'object') ? st.slots[k] : { ...v };
    }
  }

  async _loadCharacterManifests() {
    const ctx = this._ctx;
    if (!ctx) return [];
    const queries = ['assets/characters/', 'assets/', 'character_manifest'];
    const out = [];
    const discoveredCharacterNames = new Set();
    // Prefer dedicated backend scan for character manifests (reliable on large projects).
    try {
      const resp = await fetch('/__devtools_character_manifests');
      const j = await resp.json();
      if (j?.ok && Array.isArray(j?.items)) {
        for (const it of j.items) {
          const p = String(it?.path || '').trim();
          if (!p || !p.endsWith('/character_manifest.json')) continue;
          out.push(p);
          const m = p.match(/^assets\/characters\/([^/]+)\//);
          if (m && m[1]) discoveredCharacterNames.add(String(m[1]).trim());
        }
      }
    } catch { /* ignore endpoint failures and continue with generic index */ }
    for (const q of queries) {
      let items = [];
      try { items = await ctx.assetIndex({ query: q, ext: '.json' }); } catch { items = []; }
      for (const it of (Array.isArray(items) ? items : [])) {
        const p = String(it?.path || '').trim();
        if (p && p.endsWith('/character_manifest.json')) out.push(p);
        const m = p.match(/^assets\/characters\/([^/]+)\//);
        if (m && m[1]) discoveredCharacterNames.add(String(m[1]).trim());
      }
    }
    // Discover character folders by any known file type under assets/characters/<name>/...
    // This avoids hardcoded bootstrap names and keeps discovery stable for new packs.
    try {
      const anyCharItems = await ctx.assetIndex({
        query: 'assets/characters/',
        ext: '.json,.glb,.gltf,.fbx,.usd,.usda,.usdc,.usdz,.png,.jpg,.jpeg,.webp',
      });
      for (const it of (Array.isArray(anyCharItems) ? anyCharItems : [])) {
        const p = String(it?.path || '').trim();
        const m = p.match(/^assets\/characters\/([^/]+)\//);
        if (m && m[1]) discoveredCharacterNames.add(String(m[1]).trim());
      }
    } catch { /* ignore broad discovery failures */ }
    const probeCandidates = new Set();
    const activeManifest = String(this._state?.manifestPath || '').trim();
    if (activeManifest) probeCandidates.add(activeManifest);
    const activeProfile = String(this._state?.profileName || '').trim();
    if (activeProfile) probeCandidates.add(`assets/characters/${activeProfile}/character_manifest.json`);
    for (const name of discoveredCharacterNames) {
      if (!name) continue;
      probeCandidates.add(`assets/characters/${name}/character_manifest.json`);
    }
    for (const name of Object.keys(this._profiles || {})) {
      const n = String(name || '').trim();
      if (!n) continue;
      probeCandidates.add(`assets/characters/${n}/character_manifest.json`);
    }
    for (const p of probeCandidates) {
      try {
        const rel = String(p || '').trim().replace(/^\/+/, '');
        if (!rel || !rel.endsWith('/character_manifest.json')) continue;
        const resp = await fetch(`/${rel}`);
        if (!resp.ok) continue;
        const j = await resp.json();
        if (!j || typeof j !== 'object') continue;
        if (!String(j.character || '').trim() && !String(j.model || '').trim()) continue;
        out.push(rel);
      } catch { /* ignore probe failures */ }
    }
    const manifests = Array.from(new Set(out));
    manifests.sort((a, b) => a.localeCompare(b));
    this._characterManifests = manifests;
    return manifests;
  }

  async _applyCharacterManifest(manifestPath) {
    const st = this._state;
    const p = String(manifestPath || '').trim();
    if (!p) throw new Error('Missing manifest path');
    const resp = await fetch(`/${p.replace(/^\/+/, '')}`);
    if (!resp.ok) throw new Error(`Failed to read manifest: ${resp.status}`);
    const j = await resp.json();
    if (!j || typeof j !== 'object') throw new Error('Invalid manifest JSON');

    st.manifestPath = p;
    st.profileName = String(j.character || st.profileName || '').trim() || st.profileName;
    st.modelUrl = String(j.model || st.modelUrl || '').trim();
    // Do not carry stale rigPath from previous characters when manifest has no rig.
    // Prefer explicit rig, then source FBX, then model.
    st.rigPath = String(j.rig || j?.source?.fbx || st.modelUrl || '').trim();
    {
      const rawRot = Array.isArray(j?.viewer?.rotation_deg)
        ? j.viewer.rotation_deg
        : (Array.isArray(j?.viewer?.rotationDeg) ? j.viewer.rotationDeg : null);
      const rot = [0, 0, 0];
      for (let i = 0; i < 3; i++) {
        const n = Number(rawRot?.[i]);
        rot[i] = Number.isFinite(n) ? n : 0;
      }
      st.modelRotationDeg = rot;
    }
    st.textureUrl = String(j?.textures?.albedo || j.texture || st.textureUrl || '').trim();
    st.mapUrl = String(j?.retarget?.map || st.mapUrl || '').trim();
    // Prefer per-clip root when provided (faster, clearer clip library UX).
    st.motionUrl = String(
      j?.retarget?.single_clips_root
      || j?.retarget?.animation_pack_root
      || st.motionUrl
      || ''
    ).trim();
    // Reset stale clip filters when switching characters so newly loaded
    // motion libraries are immediately visible.
    st.clipFilter = '';
    st.clipVendor = 'all';
    st.selectedMotionClip = '';
    st.selectedMotionPath = '';
    this._motionClips = [];
    // Clear stale retarget output state when switching characters.
    this._animJob = { id: '', status: '', outGlb: '', stdout: '', stderr: '' };
    st.outName = `${st.profileName}_locomotion`;
    this._ensureSlotMapDefaults();
    const unified = await this._ensureUnifiedModelValidForProfile(st.profileName);
    if (unified) st.modelUrl = unified;
    else this._applyUnifiedModelIfAvailable();
    this._refreshWorkspace();
    this._scheduleAutoUnifiedBuild('manifest apply');
  }

  async _loadCharacterIntoWorkspaceFromState({ autoPreviewIdle = true } = {}) {
    const st = this._state;
    const validUnified = await this._ensureUnifiedModelValidForProfile(st.profileName);
    if (validUnified) st.modelUrl = validUnified;
    const unified = this._getUnifiedModelForProfile(st.profileName);
    const useUnified = unified && String(st.modelUrl || '').trim() === String(unified || '').trim();
    const modelPath = String(useUnified ? (st.modelUrl || st.rigPath || '') : (st.rigPath || st.modelUrl || '')).trim();
    if (!modelPath) throw new Error('Character has no model path');
    if (this._workspaceModelInputEl) this._workspaceModelInputEl.value = modelPath;
    // Character load should feel turnkey: if model has no embedded clips,
    // automatically bridge to external motion library and preview idle.
    await this._loadWorkspaceModel(modelPath, {
      preferIdle: !!autoPreviewIdle,
      // Never auto-switch away from a unified model path.
      autoConnectExternal: !useUnified,
    });
    // Ensure clip library is populated for the selected motion source even when
    // the loaded model already contains its own embedded clips.
    try {
      if (String(st.motionUrl || '').trim()) {
        await this._loadMotionClips();
        this._syncWorkspaceMotionClipLibrary();
        this._scheduleAutoUnifiedBuild('character load');
      }
    } catch (e) {
      this._setWorkspaceStatus(`Motion library bootstrap failed: ${e?.message || e}`);
    }
  }

  _buildUi() {
    const root = this._root;
    if (!root) return;
    clear(root);
    const ctx = this._ctx;
    const st = this._state;
    this._ensureSlotMapDefaults();

    const detailsCard = (title, { open = true, hint = '' } = {}, children = []) => el('details', { class: 'card', open: !!open }, [
      el('summary', {}, [
        el('div', { class: 'dockTitle' }, [String(title || 'Section')]),
        hint ? el('div', { class: 'muted', style: { marginLeft: 'auto', textAlign: 'right' } }, [String(hint)]) : el('div', {}),
      ]),
      el('div', { class: 'cardBody' }, children),
    ]);

    const status = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['Ready.']);
    const log = el('div', { class: 'scrollArea', style: { height: '140px', marginTop: '8px', whiteSpace: 'pre' } }, ['(no job yet)']);

    // Character library controls.
    const manifestSelect = el('select', { value: String(st.manifestPath || '') }, [
      el('option', { value: '' }, ['(select existing character manifest)']),
      ...((this._characterManifests || []).map((p) => el('option', { value: p }, [p]))),
    ]);
    const refreshCharactersBtn = el('button', {
      onclick: async () => {
        try {
          status.textContent = 'Refreshing character list...';
          await this._loadCharacterManifests();
          status.textContent = `Found ${this._characterManifests.length} character manifest(s).`;
          this._buildUi();
        } catch (e) {
          status.textContent = `Character list failed: ${e?.message || e}`;
        }
      },
    }, ['Refresh']);
    const loadCharacterBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try {
          const p = String(manifestSelect.value || '').trim();
          if (!p) throw new Error('Pick a manifest first');
          status.textContent = `Loading character: ${p}`;
          await this._applyCharacterManifest(p);
          await this._loadCharacterIntoWorkspaceFromState({ autoPreviewIdle: true });
          this._setWorkspaceStatus(`Loaded character manifest: ${p}`);
          this._buildUi();
        } catch (e) {
          status.textContent = `Load character failed: ${e?.message || e}`;
        }
      },
    }, ['Load character']);

    // Core character fields.
    const modelUrl = el('input', {
      value: st.modelUrl,
      placeholder: 'character model path (.glb/.gltf/.fbx/.usd)',
      oninput: (e) => { st.modelUrl = String(e.target.value || '').trim(); this._refreshWorkspace(); },
    });
    const rigPath = el('input', {
      value: st.rigPath,
      placeholder: 'rigged model path (optional; defaults to model)',
      oninput: (e) => { st.rigPath = String(e.target.value || '').trim(); this._refreshWorkspace(); },
    });
    const textureUrl = el('input', {
      value: st.textureUrl,
      placeholder: 'main texture path (optional)',
      oninput: (e) => { st.textureUrl = String(e.target.value || '').trim(); this._refreshWorkspace(); },
    });
    const mapUrl = el('input', {
      value: st.mapUrl,
      placeholder: 'tools/rigging/mappings/...json',
      oninput: (e) => {
        st.mapUrl = String(e.target.value || '').trim();
        try { localStorage.setItem('devtools.lastAnimMapUrl', st.mapUrl); } catch { /* ignore */ }
        this._refreshWorkspace();
      },
    });
    const motionUrl = el('input', {
      value: st.motionUrl,
      placeholder: 'animation source (.glb/.fbx/.bvh/.usd)',
      oninput: (e) => {
        st.motionUrl = String(e.target.value || '').trim();
        st.selectedMotionClip = '';
        st.selectedMotionPath = '';
        try { localStorage.setItem('devtools.lastMotionUrl', st.motionUrl); } catch { /* ignore */ }
        this._refreshWorkspace();
      },
    });

    const useLastBtn = el('button', {
      onclick: () => {
        try {
          const p = String(localStorage.getItem('devtools.lastGeneratedModelUrl') || '').trim();
          if (p) {
            st.modelUrl = p;
            modelUrl.value = p;
            if (!String(st.rigPath || '').trim()) {
              st.rigPath = p;
              rigPath.value = p;
            }
            this._refreshWorkspace();
          }
        } catch { /* ignore */ }
      },
    }, ['Use active model']);
    const openViewerBtn = el('button', {
      class: 'primary',
      onclick: () => {
        const p = String(st.rigPath || st.modelUrl || '').trim();
        if (!p) return;
        try { localStorage.setItem('devtools.lastGeneratedModelUrl', p); } catch { /* ignore */ }
        try { globalThis.__devtools?.setActiveTool?.('model_viewer'); } catch { /* ignore */ }
      },
    }, ['View character']);
    const openTextureBtn = el('button', {
      onclick: () => {
        const p = String(st.textureUrl || '').trim();
        if (!p) return;
        try { localStorage.setItem('devtools.texture.path', p); } catch { /* ignore */ }
        try { globalThis.__devtools?.setActiveTool?.('textures'); } catch { /* ignore */ }
      },
    }, ['View texture']);

    // Profiles
    const profileName = el('input', {
      value: String(st.profileName || ''),
      placeholder: 'character id (e.g. sample_multi)',
      oninput: (e) => { st.profileName = String(e.target.value || '').trim(); this._refreshWorkspace(); },
    });
    const profileSelect = el('select', { value: '' }, [
      el('option', { value: '' }, ['(load saved profile)']),
      ...Object.keys(this._profiles || {}).sort((a, b) => a.localeCompare(b)).map((name) => el('option', { value: name }, [name])),
    ]);
    const saveProfileBtn = el('button', {
      class: 'primary',
      onclick: () => {
        const name = String(st.profileName || '').trim();
        if (!name) return;
        this._profiles[name] = this._snapshotStateForProfile();
        this._saveProfiles();
        ctx?.toast?.(`Saved profile: ${name}`, 'success', { title: 'Character' });
        this._setWorkspaceStatus(`Saved profile: ${name}`);
        this._buildUi();
      },
    }, ['Save profile']);
    const loadProfileBtn = el('button', {
      onclick: () => {
        const name = String(profileSelect.value || '').trim();
        if (!name) return;
        if (this._loadProfile(name)) {
          ctx?.toast?.(`Loaded profile: ${name}`, 'success', { title: 'Character' });
          this._setWorkspaceStatus(`Loaded profile: ${name}`);
          this._buildUi();
        }
      },
    }, ['Load']);
    const deleteProfileBtn = el('button', {
      class: 'danger',
      onclick: () => {
        const name = String(st.profileName || '').trim();
        if (!name) return;
        delete this._profiles[name];
        this._saveProfiles();
        ctx?.toast?.(`Deleted profile: ${name}`, 'success', { title: 'Character' });
        this._buildUi();
      },
    }, ['Delete']);

    // Build/retarget settings.
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
    const outName = el('input', {
      value: st.outName,
      placeholder: 'output name (e.g. sample_multi_locomotion)',
      oninput: (e) => { st.outName = String(e.target.value || '').trim(); this._refreshWorkspace(); },
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

    const rigBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try {
          rigBtn.disabled = true;
          status.textContent = 'Starting rig job...';
          this._setWorkspaceStatus('Rigging in progress...');
          await this._startRigJob({ statusEl: status, logEl: log });
        } catch (e) {
          status.textContent = `Rig failed: ${e?.message || e}`;
          this._setWorkspaceStatus(`Rig failed: ${e?.message || e}`);
        } finally {
          rigBtn.disabled = false;
        }
      },
    }, ['Auto-rig model']);
    const previewClipBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try {
          previewClipBtn.disabled = true;
          this._setWorkspaceStatus('Previewing selected animation on character...');
          await this._startPreviewClipRetarget({ statusEl: status, logEl: log });
          const out = String(this._animJob?.outGlb || '').trim();
          if (out) {
            try { localStorage.setItem('devtools.lastGeneratedModelUrl', out); } catch { /* ignore */ }
            try {
              if (this._workspaceModelInputEl) this._workspaceModelInputEl.value = out;
              await this._loadWorkspaceModel(out);
              this._setWorkspaceStatus(`Loaded preview animation in viewer: ${out}`);
            } catch (e) {
              this._setWorkspaceStatus(`Preview generated (${out}) but viewer load failed: ${e?.message || e}`);
            }
          }
        } catch (e) {
          status.textContent = `Preview failed: ${e?.message || e}`;
        } finally {
          previewClipBtn.disabled = false;
        }
      },
    }, ['Preview selected clip']);

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
    }, ['Kill anim job']);

    const activeSlot = el('select', {
      value: String(st.activeSlot || 'idle'),
      onchange: (e) => { st.activeSlot = String(e.target.value || 'idle'); },
    }, LOCOMOTION_SLOT_KEYS.map((k) => el('option', { value: k }, [k])));

    const clipFilter = el('input', {
      value: st.clipFilter,
      placeholder: 'filter clips (walk, idle, jump...)',
      oninput: (e) => { st.clipFilter = String(e.target.value || ''); this._buildUi(); },
    });
    const clipVendor = el('select', {
      value: st.clipVendor,
      onchange: (e) => { st.clipVendor = String(e.target.value || 'all'); this._buildUi(); },
    }, [
      el('option', { value: 'all' }, ['All']),
      el('option', { value: 'nvidia' }, ['NVIDIA-style']),
      el('option', { value: 'other' }, ['Other']),
    ]);
    const clipStatus = el('div', { class: 'muted', style: { marginTop: '6px' } }, ['']);
    const selectedMotionClip = el('input', {
      value: String(st.selectedMotionClip || ''),
      placeholder: 'selected clip for preview',
      oninput: (e) => { this._setSelectedMotionClip(String(e.target.value || '').trim()); this._refreshWorkspace(); },
    });
    const loadClipsBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try {
          clipStatus.textContent = 'Loading clips...';
          const clips = await this._loadMotionClips();
          clipStatus.textContent = `Loaded ${clips.length} clip(s)`;
          if (clips.length && !String(st.selectedMotionClip || '').trim()) {
            this._setSelectedMotionClip(String(clips[0]?.name || '').trim(), String(clips[0]?.sourcePath || st.motionUrl || ''));
          }
          this._buildUi();
        } catch (e) {
          clipStatus.textContent = `Load failed: ${e?.message || e}`;
        }
      },
    }, ['Load clips']);

    const autoFillBtn = el('button', {
      onclick: () => {
        try {
          const out = this._autoFillLocomotionFromLoadedClips({ preferNvidia: true });
          clipStatus.textContent = `Auto-filled ${out.filled} slot(s)`;
          this._buildUi();
        } catch (e) {
          clipStatus.textContent = `Auto-fill failed: ${e?.message || e}`;
        }
      },
    }, ['Auto-fill slots']);

    const fillPathsBtn = el('button', {
      onclick: () => {
        const src = String(st.motionUrl || '').trim();
        if (!src) return;
        for (const ent of Object.values(st.slots || {})) {
          if (!ent || typeof ent !== 'object') continue;
          if (!String(ent.motionPath || '').trim()) ent.motionPath = src;
        }
        this._buildUi();
      },
    }, ['Fill empty motionPath']);

    const clipList = this._renderClipLibraryList();
    const visibleClipNames = this._getVisibleClipNames();
    const clipQuickList = el('div', { class: 'scrollArea', style: { height: '170px', marginTop: '8px' } }, []);
    if (!visibleClipNames.length) {
      clipQuickList.textContent = '(load clips to show animations)';
    } else {
      for (const name of visibleClipNames.slice(0, 300)) {
        clipQuickList.appendChild(el('button', {
          class: `toolBtn${String(st.selectedMotionClip || '') === name ? ' active' : ''}`,
          style: { marginTop: '6px' },
          onclick: () => {
            this._setSelectedMotionClip(name);
            this._refreshWorkspace();
            this._buildUi();
          },
        }, [name]));
      }
    }
    const slotEditor = this._renderLocomotionSlots();

    const buildLocomotionBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try {
          buildLocomotionBtn.disabled = true;
          status.textContent = 'Starting locomotion pack...';
          this._setWorkspaceStatus('Building locomotion pack...');
          await this._startLocomotionPack({ statusEl: status, logEl: log });
        } catch (e) {
          status.textContent = `Locomotion build failed: ${e?.message || e}`;
          this._setWorkspaceStatus(`Locomotion failed: ${e?.message || e}`);
        } finally {
          buildLocomotionBtn.disabled = false;
        }
      },
    }, ['Build locomotion pack']);
    const setGameplayBtn = el('button', {
      onclick: () => {
        const p = String(this._animJob?.outGlb || '').trim();
        if (!p) return;
        try { localStorage.setItem('gameplay.avatarUrl', p); } catch { /* ignore */ }
        ctx?.toast?.('Set gameplay avatar from character output', 'success', { title: 'Character' });
      },
    }, ['Set gameplay avatar']);
    const publishCharacterBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try {
          publishCharacterBtn.disabled = true;
          const modelPath = String(this._animJob?.outGlb || st.modelUrl || st.rigPath || '').trim();
          const out = await this._publishCharacterProfile({ modelPath });
          this._setWorkspaceStatus(`Published character profile: ${out.manifestPath}`);
          status.textContent = `Published character profile\nManifest: ${out.manifestPath}\nLocomotion: ${out.locomotionPath}`;
          ctx?.toast?.(`Published character: ${out.character}`, 'success', { title: 'Character' });
          this._buildUi();
        } catch (e) {
          status.textContent = `Publish failed: ${e?.message || e}`;
          this._setWorkspaceStatus(`Publish failed: ${e?.message || e}`);
        } finally {
          publishCharacterBtn.disabled = false;
        }
      },
    }, ['Publish character profile']);

    const sendToRiggingBtn = el('button', {
      onclick: () => {
        const payload = {
          modelUrl: String(st.modelUrl || '').trim(),
          bringToLife: {
            mapUrl: String(st.mapUrl || '').trim(),
            motionUrl: String(st.motionUrl || '').trim(),
            runner: String(st.runner || 'conda_trellis'),
            blenderPath: String(st.blenderPath || '').trim(),
            outName: String(st.outName || '').trim(),
            includeMesh: Number(st.includeMesh) ? 1 : 0,
            exportFormat: String(st.exportFormat || 'GLB'),
            clips: JSON.parse(JSON.stringify(st.slots || {})),
          },
        };
        try { localStorage.setItem('devtools.rig.autoBringToLife', JSON.stringify(payload)); } catch { /* ignore */ }
        try { globalThis.__devtools?.setActiveTool?.('rig'); } catch { /* ignore */ }
      },
    }, ['Open in rigging tool']);

    root.appendChild(detailsCard('Character Library', { open: false, hint: 'existing characters' }, [
      el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, [manifestSelect, refreshCharactersBtn, loadCharacterBtn]),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Pick a `character_manifest.json` to load model + source animation defaults.']),
    ]));

    root.appendChild(detailsCard('Profile', { open: false, hint: 'save/load current state' }, [
      el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, [profileName, saveProfileBtn, deleteProfileBtn]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [profileSelect, loadProfileBtn]),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Profile stores all character paths + animation slot mappings.']),
    ]));

    root.appendChild(detailsCard('Character Setup', { open: false, hint: 'model + texture + retarget inputs' }, [
      el('div', { class: 'muted' }, ['modelUrl']),
      el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, [modelUrl, useLastBtn]),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['rigPath (optional override)']),
      rigPath,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['textureUrl']),
      el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, [textureUrl, openTextureBtn]),
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['retarget map']),
      mapUrl,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['motion source']),
      motionUrl,
      el('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } }, [openViewerBtn]),
    ]));

    root.appendChild(detailsCard('Path Pickers (optional)', { open: false, hint: 'search assets quickly' }, [
      this._buildAssetPicker({
        title: 'Asset picker (model)',
        ext: '.glb,.gltf,.fbx,.usd,.usda,.usdc,.usdz',
        onPick: (p) => {
          st.modelUrl = p;
          modelUrl.value = p;
          if (!String(st.rigPath || '').trim()) {
            st.rigPath = p;
            rigPath.value = p;
          }
        },
        allowEmptyQuery: true,
      }),
      this._buildAssetPicker({
        title: 'Asset picker (texture)',
        ext: '.png,.jpg,.jpeg,.webp,.ktx2',
        onPick: (p) => { st.textureUrl = p; textureUrl.value = p; },
      }),
      this._buildAssetPicker({
        title: 'Asset picker (map)',
        ext: '.json',
        onPick: (p) => { st.mapUrl = p; mapUrl.value = p; },
      }),
    ]));

    root.appendChild(detailsCard('Animation Browser', { open: false, hint: 'select and preview animations' }, [
      el('div', { class: 'row', style: { marginTop: '4px', gap: '8px', flexWrap: 'wrap' } }, [loadClipsBtn, autoFillBtn, fillPathsBtn]),
      clipStatus,
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [clipFilter, clipVendor]),
      clipQuickList,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Selected animation']),
      selectedMotionClip,
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [previewClipBtn, openViewerBtn]),
    ]));

    root.appendChild(detailsCard('Build Character Output', { open: false, hint: 'rig + locomotion pack' }, [
      el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['runner']), runner]),
        el('div', {}, [el('div', { class: 'muted' }, ['blenderPath']), blenderPath]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
        el('div', {}, [el('div', { class: 'muted' }, ['outName']), outName]),
        el('div', {}, [el('div', { class: 'muted' }, ['export']), exportFormat]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '12px', alignItems: 'center', flexWrap: 'wrap' } }, [
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [includeMesh, el('div', { class: 'muted' }, ['include mesh'])]),
      ]),
      el('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } }, [
        rigBtn,
        buildLocomotionBtn,
        publishCharacterBtn,
        setGameplayBtn,
        sendToRiggingBtn,
        animKillBtn,
      ]),
    ]));

    root.appendChild(detailsCard('Locomotion Slot Mapping', { open: false, hint: 'optional fine tuning' }, [
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', alignItems: 'center' } }, [el('div', { class: 'muted' }, ['active slot']), activeSlot]),
      clipList,
      slotEditor,
    ]));

    root.appendChild(detailsCard('Jobs', { open: true, hint: 'status + logs' }, [
      status,
      log,
      el('div', { class: 'muted', style: { marginTop: '8px' } }, ['Primary character viewing now lives in the center workspace window.']),
    ]));

    this._refreshWorkspace();
  }

  _buildWorkspace() {
    const host = this._ctx?.canvasHost;
    if (!host) return;
    this._disposeWorkspaceViewer();
    clear(host);

    const wrap = document.createElement('div');
    wrap.style.position = 'absolute';
    wrap.style.inset = '0';
    wrap.style.boxSizing = 'border-box';
    wrap.style.paddingLeft = '252px';
    wrap.style.paddingRight = '252px';
    wrap.style.paddingTop = '12px';
    wrap.style.paddingBottom = '204px';
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'stretch';
    wrap.style.justifyContent = 'stretch';
    wrap.style.background = 'radial-gradient(ellipse at 40% 25%, rgba(77,96,139,0.18), rgba(9,12,18,0.95) 65%)';
    wrap.style.color = 'rgba(230,238,255,0.95)';
    wrap.style.fontFamily = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial';
    wrap.style.overflow = 'hidden';

    const card = document.createElement('div');
    card.style.width = '100%';
    card.style.height = '100%';
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.border = '1px solid rgba(180,196,255,0.2)';
    card.style.borderRadius = '12px';
    card.style.padding = '14px';
    card.style.boxSizing = 'border-box';
    card.style.background = 'rgba(7,10,15,0.66)';
    card.style.boxShadow = '0 12px 40px rgba(0,0,0,0.35)';
    card.style.overflow = 'hidden';

    const title = document.createElement('div');
    title.textContent = 'Character Workspace';
    title.style.fontSize = '20px';
    title.style.fontWeight = '700';
    title.style.marginBottom = '8px';

    const sub = document.createElement('div');
    sub.textContent = 'Load a character, auto-play idle, then browse clips in one place.';
    sub.style.fontSize = '13px';
    sub.style.opacity = '0.8';
    sub.style.marginBottom = '6px';

    const status = document.createElement('div');
    status.style.fontSize = '12px';
    status.style.marginBottom = '8px';
    status.style.opacity = '0.9';
    status.textContent = 'Ready.';
    this._workspaceStatusEl = status;

    const viewerStatus = document.createElement('div');
    viewerStatus.style.fontSize = '12px';
    viewerStatus.style.opacity = '0.82';
    viewerStatus.style.marginBottom = '8px';
    viewerStatus.textContent = 'Viewer: load a character model to preview animations.';
    this._workspaceViewerStatusEl = viewerStatus;

    const characterRow = document.createElement('div');
    characterRow.style.display = 'flex';
    characterRow.style.gap = '8px';
    characterRow.style.flexWrap = 'wrap';
    characterRow.style.marginBottom = '8px';

    const manifestSel = document.createElement('select');
    manifestSel.style.flex = '1 1 460px';
    this._workspaceCharacterSelectEl = manifestSel;
    const rebuildCharacterSelect = () => {
      clear(manifestSel);
      manifestSel.appendChild(el('option', { value: '' }, ['(choose stored character: manifest or saved profile)']));
      for (const p of (this._characterManifests || [])) {
        manifestSel.appendChild(el('option', { value: `manifest:${p}` }, [p]));
      }
      const profileNames = Object.keys(this._profiles || {}).sort((a, b) => a.localeCompare(b));
      for (const name of profileNames) {
        manifestSel.appendChild(el('option', { value: `profile:${name}` }, [`[profile] ${name}`]));
      }
      const currentManifest = String(this._state.manifestPath || '').trim();
      if (currentManifest) {
        manifestSel.value = `manifest:${currentManifest}`;
      } else {
        const currentProfile = String(this._state.profileName || '').trim();
        if (currentProfile) manifestSel.value = `profile:${currentProfile}`;
      }
    };
    rebuildCharacterSelect();

    const refreshCharactersBtn = document.createElement('button');
    refreshCharactersBtn.textContent = 'Refresh list';
    refreshCharactersBtn.onclick = async () => {
      try {
        this._setWorkspaceStatus('Refreshing stored character list...');
        await this._loadCharacterManifests();
        rebuildCharacterSelect();
        this._setWorkspaceStatus(`Found ${this._characterManifests.length} character manifest(s).`);
      } catch (e) {
        this._setWorkspaceStatus(`Refresh failed: ${e?.message || e}`);
      }
    };

    const loadStoredBtn = document.createElement('button');
    loadStoredBtn.className = 'primary';
    loadStoredBtn.textContent = 'Load stored character';
    loadStoredBtn.onclick = async () => {
      const selected = String(manifestSel.value || '').trim();
      if (!selected) return;
      try {
        this._setWorkspaceStatus(`Loading stored character: ${selected}`);
        if (selected.startsWith('manifest:')) {
          const p = selected.slice('manifest:'.length).trim();
          await this._applyCharacterManifest(p);
        } else if (selected.startsWith('profile:')) {
          const name = selected.slice('profile:'.length).trim();
          if (!this._loadProfile(name)) throw new Error(`Profile not found: ${name}`);
          this._ensureSlotMapDefaults();
        } else {
          throw new Error('Unknown stored character source');
        }
        await this._loadCharacterIntoWorkspaceFromState({ autoPreviewIdle: true });
        this._setWorkspaceStatus(`Loaded stored character: ${selected}`);
      } catch (e) {
        this._setWorkspaceStatus(`Load failed: ${e?.message || e}`);
      }
    };

    characterRow.appendChild(manifestSel);
    characterRow.appendChild(refreshCharactersBtn);
    characterRow.appendChild(loadStoredBtn);
    if (!(this._characterManifests || []).length && !Object.keys(this._profiles || {}).length) {
      characterRow.appendChild(el('div', { class: 'muted' }, ['No stored manifests/profiles found. Load a model path directly or save a profile first.']));
    }

    const modelRow = document.createElement('div');
    modelRow.style.display = 'flex';
    modelRow.style.gap = '8px';
    modelRow.style.flexWrap = 'wrap';
    modelRow.style.marginBottom = '8px';

    const modelInput = document.createElement('input');
    modelInput.value = String(this._getWorkspacePreferredModelPath() || '');
    modelInput.placeholder = 'character model path (.glb/.gltf/.fbx/.usd)';
    modelInput.style.flex = '1 1 460px';
    this._workspaceModelInputEl = modelInput;

    const loadModelBtn = document.createElement('button');
    loadModelBtn.className = 'primary';
    loadModelBtn.textContent = 'Load model';
    loadModelBtn.onclick = async () => {
      const p = String(modelInput.value || '').trim();
      if (!p) return;
      try { await this._loadWorkspaceModel(p, { preferIdle: true, autoConnectExternal: false }); } catch (e) { this._setWorkspaceViewerStatus(String(e?.message || e)); }
    };

    const loadCharacterBtn = document.createElement('button');
    loadCharacterBtn.textContent = 'Load character';
    loadCharacterBtn.onclick = async () => {
      try {
        await this._loadCharacterIntoWorkspaceFromState({ autoPreviewIdle: true });
      } catch (e) {
        this._setWorkspaceViewerStatus(String(e?.message || e));
      }
    };

    const loadPreviewBtn = document.createElement('button');
    loadPreviewBtn.textContent = 'Load last preview';
    loadPreviewBtn.onclick = async () => {
      const p = String(this._animJob?.outGlb || '').trim();
      if (!p) return;
      modelInput.value = p;
      try { await this._loadWorkspaceModel(p, { preferIdle: false, autoConnectExternal: false }); } catch (e) { this._setWorkspaceViewerStatus(String(e?.message || e)); }
    };

    const unifyAllCenterBtn = document.createElement('button');
    unifyAllCenterBtn.className = 'primary';
    unifyAllCenterBtn.textContent = 'Unify all loaded clips';
    this._workspaceUnifyAllBtn = unifyAllCenterBtn;
    this._syncWorkspaceUnifyButton();
    unifyAllCenterBtn.onclick = async () => {
      try {
        unifyAllCenterBtn.disabled = true;
        this._setWorkspaceStatus('Building unified animation model from loaded clips...');
        await this._startUnifiedPackFromLoadedClips({ statusEl: this._workspaceMotionClipStatusEl, logEl: this._workspaceRetargetLogEl });
      } catch (e) {
        this._setWorkspaceStatus(`Unified model build failed: ${e?.message || e}`);
      } finally {
        unifyAllCenterBtn.disabled = false;
      }
    };

    modelRow.appendChild(modelInput);
    modelRow.appendChild(loadModelBtn);
    modelRow.appendChild(loadCharacterBtn);
    modelRow.appendChild(loadPreviewBtn);
    modelRow.appendChild(unifyAllCenterBtn);

    const body = document.createElement('div');
    body.style.display = 'flex';
    body.style.flex = '1 1 auto';
    body.style.minHeight = '260px';
    body.style.gap = '10px';
    body.style.overflow = 'auto';

    const viewerCol = document.createElement('div');
    viewerCol.style.display = 'flex';
    viewerCol.style.flexDirection = 'column';
    viewerCol.style.gap = '8px';
    viewerCol.style.flex = '1 1 auto';
    viewerCol.style.minWidth = '0';

    const viewerHost = document.createElement('div');
    viewerHost.style.position = 'relative';
    viewerHost.style.flex = '1 1 auto';
    viewerHost.style.minHeight = '220px';
    viewerHost.style.borderRadius = '10px';
    viewerHost.style.overflow = 'hidden';
    viewerHost.style.border = '1px solid rgba(255,255,255,0.12)';
    viewerHost.style.background = '#07090d';

    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    viewerHost.appendChild(canvas);
    this._workspaceCanvas = canvas;
    this._initWorkspaceViewer(canvas);

    const transport = document.createElement('div');
    transport.style.display = 'flex';
    transport.style.gap = '8px';
    transport.style.alignItems = 'center';
    transport.style.flexWrap = 'wrap';

    const animSelect = document.createElement('select');
    animSelect.style.minWidth = '260px';
    animSelect.onchange = () => this._setWorkspaceAnimation(String(animSelect.value || ''));
    this._workspaceAnimSelectEl = animSelect;

    const playBtn = document.createElement('button');
    playBtn.textContent = this._workspacePlay ? 'Pause' : 'Play';
    playBtn.onclick = () => {
      this._workspacePlay = !this._workspacePlay;
      playBtn.textContent = this._workspacePlay ? 'Pause' : 'Play';
    };
    this._workspacePlayBtn = playBtn;

    const speedLabel = document.createElement('label');
    speedLabel.style.display = 'inline-flex';
    speedLabel.style.gap = '8px';
    speedLabel.style.alignItems = 'center';
    const speedTxt = document.createElement('span');
    speedTxt.textContent = 'Speed 1.0x';
    speedTxt.style.fontSize = '12px';
    const speed = document.createElement('input');
    speed.type = 'range';
    speed.min = '0';
    speed.max = '2';
    speed.step = '0.05';
    speed.value = '1';
    speed.oninput = () => {
      this._workspaceSpeed = Number(speed.value) || 1.0;
      speedTxt.textContent = `Speed ${this._workspaceSpeed.toFixed(2)}x`;
    };
    speedLabel.appendChild(speedTxt);
    speedLabel.appendChild(speed);

    transport.appendChild(animSelect);
    transport.appendChild(playBtn);
    transport.appendChild(speedLabel);

    const modelClipFilter = document.createElement('input');
    modelClipFilter.placeholder = 'filter loaded model clips';
    modelClipFilter.style.flex = '1 1 220px';
    modelClipFilter.oninput = () => this._syncWorkspaceModelClipLibrary();
    this._workspaceModelClipFilterEl = modelClipFilter;

    const modelClipList = document.createElement('div');
    modelClipList.className = 'scrollArea';
    modelClipList.style.height = '180px';
    modelClipList.style.whiteSpace = 'normal';
    this._workspaceModelClipListEl = modelClipList;

    const modelLibCard = document.createElement('div');
    modelLibCard.style.border = '1px solid rgba(255,255,255,0.12)';
    modelLibCard.style.borderRadius = '10px';
    modelLibCard.style.background = 'rgba(255,255,255,0.03)';
    modelLibCard.style.padding = '8px';
    modelLibCard.style.boxSizing = 'border-box';
    modelLibCard.appendChild(el('div', { class: 'muted' }, ['Loaded model animation library']));
    modelLibCard.appendChild(modelClipFilter);
    modelLibCard.appendChild(modelClipList);

    viewerCol.appendChild(viewerHost);
    viewerCol.appendChild(transport);
    viewerCol.appendChild(modelLibCard);

    const motionSourceInput = document.createElement('input');
    motionSourceInput.value = String(this._state.motionUrl || '');
    motionSourceInput.placeholder = 'platform motion source (.glb/.fbx/.usd)';
    motionSourceInput.oninput = (e) => {
      this._state.motionUrl = String(e.target.value || '').trim();
      this._state.selectedMotionClip = '';
      this._state.selectedMotionPath = '';
      try { localStorage.setItem('devtools.lastMotionUrl', this._state.motionUrl); } catch { /* ignore */ }
      this._refreshWorkspace();
    };

    const mapInput = document.createElement('input');
    mapInput.value = String(this._state.mapUrl || '');
    mapInput.placeholder = 'retarget map json';
    mapInput.oninput = (e) => {
      this._state.mapUrl = String(e.target.value || '').trim();
      try { localStorage.setItem('devtools.lastAnimMapUrl', this._state.mapUrl); } catch { /* ignore */ }
      this._refreshWorkspace();
    };

    const motionClipSelect = document.createElement('select');
    motionClipSelect.onchange = () => {
      const idx = Number(motionClipSelect.value);
      const entries = this._getVisibleMotionClipEntries();
      if (Number.isInteger(idx) && idx >= 0 && idx < entries.length) {
        const ent = entries[idx];
        this._setSelectedMotionClip(String(ent?.name || '').trim(), String(ent?.sourcePath || '').trim());
      } else {
        this._setSelectedMotionClip('');
      }
      this._refreshWorkspace();
    };
    this._workspaceMotionClipSelectEl = motionClipSelect;

    const motionStatus = document.createElement('div');
    motionStatus.className = 'muted';
    motionStatus.style.fontSize = '12px';
    motionStatus.textContent = '';
    this._workspaceMotionClipStatusEl = motionStatus;

    const loadMotionClipsBtn = document.createElement('button');
    loadMotionClipsBtn.textContent = 'Load platform clips';
    loadMotionClipsBtn.onclick = async () => {
      try {
        loadMotionClipsBtn.disabled = true;
        loadMotionClipsBtn.textContent = 'Loading clips...';
        motionStatus.textContent = 'Loading platform clip library...';
        const clips = await this._loadMotionClips();
        motionStatus.textContent = `Loaded ${clips.length} clip(s).`;
        this._syncWorkspaceMotionClipLibrary();
      } catch (e) {
        motionStatus.textContent = `Load failed: ${e?.message || e}`;
      } finally {
        loadMotionClipsBtn.disabled = false;
        loadMotionClipsBtn.textContent = 'Load platform clips';
      }
    };

    const retargetBtn = document.createElement('button');
    retargetBtn.className = 'primary';
    retargetBtn.textContent = 'Retarget selected clip to character';
    retargetBtn.onclick = async () => {
      try {
        retargetBtn.disabled = true;
        this._setWorkspaceStatus('Retarget preview in progress...');
        await this._startPreviewClipRetarget({ statusEl: this._workspaceMotionClipStatusEl, logEl: this._workspaceRetargetLogEl });
        const out = String(this._animJob?.outGlb || '').trim();
        if (out) {
          if (this._workspaceModelInputEl) this._workspaceModelInputEl.value = out;
          await this._loadWorkspaceModel(out, { preferIdle: false });
          this._setWorkspaceStatus(`Retarget preview loaded: ${out}`);
        }
      } catch (e) {
        this._setWorkspaceStatus(`Retarget failed: ${e?.message || e}`);
      } finally {
        retargetBtn.disabled = false;
      }
    };

    const previewSourceBtn = document.createElement('button');
    previewSourceBtn.textContent = 'Preview selected source clip';
    previewSourceBtn.onclick = async () => {
      try {
        previewSourceBtn.disabled = true;
        await this._previewSelectedSourceClipInViewer();
      } catch (e) {
        this._setWorkspaceStatus(`Source clip preview failed: ${e?.message || e}`);
      } finally {
        previewSourceBtn.disabled = false;
      }
    };

    const motionClipList = document.createElement('div');
    motionClipList.className = 'scrollArea';
    motionClipList.style.height = '130px';
    motionClipList.style.whiteSpace = 'normal';
    this._workspaceMotionClipListEl = motionClipList;

    const retargetLog = document.createElement('div');
    retargetLog.className = 'scrollArea';
    retargetLog.style.height = '90px';
    retargetLog.style.whiteSpace = 'pre-wrap';
    retargetLog.textContent = '(retarget log)';
    this._workspaceRetargetLogEl = retargetLog;

    const retargetCard = document.createElement('div');
    retargetCard.style.border = '1px solid rgba(255,255,255,0.12)';
    retargetCard.style.borderRadius = '10px';
    retargetCard.style.background = 'rgba(255,255,255,0.03)';
    retargetCard.style.padding = '8px';
    retargetCard.style.boxSizing = 'border-box';
    retargetCard.appendChild(el('div', { class: 'muted' }, ['Optional: retarget platform animations']));
    retargetCard.appendChild(motionSourceInput);
    retargetCard.appendChild(mapInput);
    retargetCard.appendChild(el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [loadMotionClipsBtn]));
    retargetCard.appendChild(motionClipSelect);
    retargetCard.appendChild(motionClipList);
    retargetCard.appendChild(el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [retargetBtn, previewSourceBtn]));
    retargetCard.appendChild(motionStatus);
    retargetCard.appendChild(retargetLog);
    retargetCard.style.maxHeight = '240px';
    retargetCard.style.overflow = 'auto';
    body.appendChild(viewerCol);
    viewerCol.appendChild(retargetCard);

    const summary = document.createElement('pre');
    summary.style.margin = '0';
    summary.style.padding = '10px';
    summary.style.borderRadius = '10px';
    summary.style.background = 'rgba(255,255,255,0.04)';
    summary.style.border = '1px solid rgba(255,255,255,0.1)';
    summary.style.fontSize = '12px';
    summary.style.maxHeight = '120px';
    summary.style.overflow = 'auto';
    summary.style.marginTop = '10px';
    summary.style.whiteSpace = 'pre-wrap';
    summary.style.lineHeight = '1.5';
    summary.textContent = '';
    this._workspaceSummaryEl = summary;

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    actions.style.marginTop = '8px';
    actions.style.flexWrap = 'wrap';

    const mkBtn = (label, onClick) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = 'primary';
      b.onclick = onClick;
      b.style.padding = '8px 12px';
      b.style.borderRadius = '8px';
      return b;
    };
    actions.appendChild(mkBtn('Open Model Viewer', () => {
      const p = String(this._state.rigPath || this._state.modelUrl || '').trim();
      if (!p) return;
      try { localStorage.setItem('devtools.lastGeneratedModelUrl', p); } catch { /* ignore */ }
      try { globalThis.__devtools?.setActiveTool?.('model_viewer'); } catch { /* ignore */ }
    }));
    actions.appendChild(mkBtn('Open Textures', () => {
      const p = String(this._state.textureUrl || '').trim();
      if (p) {
        try { localStorage.setItem('devtools.texture.path', p); } catch { /* ignore */ }
      }
      try { globalThis.__devtools?.setActiveTool?.('textures'); } catch { /* ignore */ }
    }));
    actions.appendChild(mkBtn('Open Rigging Tool', () => {
      try { globalThis.__devtools?.setActiveTool?.('rig'); } catch { /* ignore */ }
    }));

    card.appendChild(title);
    card.appendChild(sub);
    card.appendChild(status);
    card.appendChild(viewerStatus);
    card.appendChild(characterRow);
    card.appendChild(modelRow);
    card.appendChild(body);
    card.appendChild(summary);
    card.appendChild(actions);
    wrap.appendChild(card);
    host.appendChild(wrap);
    this._workspaceHost = wrap;
    this._refreshWorkspaceAnimSelect();
    this._syncWorkspaceModelClipLibrary();
    this._syncWorkspaceMotionClipLibrary();
    this._refreshWorkspace();
    const initial = String(this._getWorkspacePreferredModelPath() || '').trim();
    if (initial) {
      this._setWorkspaceViewerStatus(`Loading ${initial}...`);
      void this._loadWorkspaceModel(initial, { preferIdle: true }).catch((e) => this._setWorkspaceViewerStatus(String(e?.message || e)));
    }
  }

  _setWorkspaceStatus(text) {
    if (!this._workspaceStatusEl) return;
    this._workspaceStatusEl.textContent = String(text || '');
  }

  _refreshWorkspace() {
    if (!this._workspaceSummaryEl) return;
    this._syncWorkspaceUnifyButton();
    const st = this._state;
    const selectedSlots = Object.entries(st.slots || {}).filter(([, v]) => String(v?.motionPath || '').trim() && String(v?.motionClip || '').trim()).length;
    const visibleClips = this._getVisibleClipNames();
    const totalClips = Array.isArray(this._motionClips) ? this._motionClips.length : 0;
    const loading = !!this._motionClipsLoading;
    this._workspaceSummaryEl.textContent = [
      `profile: ${String(st.profileName || '(none)')}`,
      `model: ${String(st.modelUrl || '(unset)')}`,
      `rig: ${String(st.rigPath || '(uses model)')}`,
      `model rotation (deg): ${Array.isArray(st.modelRotationDeg) ? st.modelRotationDeg.slice(0, 3).join(', ') : '0, 0, 0'}`,
      `texture: ${String(st.textureUrl || '(unset)')}`,
      `map: ${String(st.mapUrl || '(unset)')}`,
      `motion source: ${String(st.motionUrl || '(unset)')}`,
      `selected animation: ${String(st.selectedMotionClip || '(none)')}`,
      `${String(st.selectedMotionPath || '').trim() ? `selected animation source: ${String(st.selectedMotionPath)}` : ''}`,
      `available animations: ${totalClips} total (${visibleClips.length} shown)${loading ? ' [loading...]' : ''}`,
      `slots mapped: ${selectedSlots}/${LOCOMOTION_SLOT_KEYS.length}`,
      `last rig job: ${String(this._rigJob?.status || '(none)')}`,
      `last anim job: ${String(this._animJob?.status || '(none)')}`,
      `${String(this._animJob?.outGlb || '').trim() ? `output: ${String(this._animJob.outGlb)}` : ''}`,
    ].filter(Boolean).join('\n');
    const preferred = String(this._getWorkspacePreferredModelPath() || '').trim();
    if (this._workspaceModelInputEl && preferred && !String(this._workspaceModelInputEl.value || '').trim()) {
      this._workspaceModelInputEl.value = preferred;
    }
    const selected = String(st.selectedMotionClip || '').trim();
    if (selected && this._workspaceActiveClip !== selected) {
      const has = Array.isArray(this._workspaceGltf?.animations)
        ? this._workspaceGltf.animations.some((c) => String(c?.name || '').trim() === selected)
        : false;
      if (has) this._setWorkspaceAnimation(selected);
    }
    this._syncWorkspaceMotionClipLibrary();
  }

  _setWorkspaceViewerStatus(text) {
    if (!this._workspaceViewerStatusEl) return;
    this._workspaceViewerStatusEl.textContent = `Viewer: ${String(text || '')}`;
  }

  _getWorkspacePreferredModelPath() {
    const st = this._state;
    const unified = this._getUnifiedModelForProfile(st.profileName);
    if (unified && String(st.modelUrl || '').trim() === String(unified || '').trim()) {
      return String(st.modelUrl || this._animJob?.outGlb || '').trim();
    }
    // Default path keeps source rig first unless a unified model is active.
    return String(st.rigPath || st.modelUrl || this._animJob?.outGlb || '').trim();
  }

  _initWorkspaceViewer(canvas) {
    if (!canvas) return;
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    renderer.setClearColor(new THREE.Color(0x07090d), 1.0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this._workspaceRenderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x07090d);
    this._workspaceScene = scene;

    const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 200000);
    camera.position.set(3.0, 2.2, 4.0);
    this._workspaceCamera = camera;

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.target.set(0, 1, 0);
    this._workspaceControls = controls;

    const hemi = new THREE.HemisphereLight(0xdde8ff, 0x1a2230, 0.95);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.05);
    dir.position.set(6, 10, 4);
    scene.add(dir);

    this._workspaceGrid = new THREE.GridHelper(10, 10, 0x3a4a64, 0x223046);
    this._workspaceGrid.material.opacity = 0.55;
    this._workspaceGrid.material.transparent = true;
    scene.add(this._workspaceGrid);
    scene.add(new THREE.AxesHelper(1.0));
  }

  _disposeWorkspaceViewer() {
    this._clearWorkspaceModel();
    try { this._workspaceControls?.dispose?.(); } catch { /* ignore */ }
    try { this._workspaceRenderer?.dispose?.(); } catch { /* ignore */ }
    this._workspaceCanvas = null;
    this._workspaceRenderer = null;
    this._workspaceScene = null;
    this._workspaceCamera = null;
    this._workspaceControls = null;
    this._workspaceGrid = null;
    this._workspaceLoadedModelUrl = '';
    this._workspaceIsLoading = false;
    this._workspaceActiveClip = '';
    this._workspaceLastDpr = 1.0;
  }

  _clearWorkspaceModel() {
    if (this._workspaceModelRoot && this._workspaceScene) {
      try { this._workspaceScene.remove(this._workspaceModelRoot); } catch { /* ignore */ }
      try { disposeThreeObject(this._workspaceModelRoot); } catch { /* ignore */ }
    }
    this._workspaceModelRoot = null;
    this._workspaceGltf = null;
    this._workspaceMixer = null;
    this._workspaceActiveClip = '';
    this._refreshWorkspaceAnimSelect();
  }

  _refreshWorkspaceAnimSelect() {
    const sel = this._workspaceAnimSelectEl;
    if (!sel) return;
    clear(sel);
    const clips = Array.isArray(this._workspaceGltf?.animations) ? this._workspaceGltf.animations : [];
    if (!clips.length) {
      const hasPlatform = Array.isArray(this._motionClips) && this._motionClips.length > 0;
      const label = hasPlatform
        ? '(no model animations; pick from platform clips below)'
        : '(no model animations)';
      sel.appendChild(el('option', { value: '' }, [label]));
      sel.value = '';
      sel.disabled = true;
      this._syncWorkspaceModelClipLibrary();
      return;
    }
    sel.disabled = false;
    sel.appendChild(el('option', { value: '' }, ['(no animation)']));
    for (const c of clips) {
      const name = String(c?.name || '').trim();
      sel.appendChild(el('option', { value: name }, [name || '(unnamed clip)']));
    }
    sel.value = String(this._workspaceActiveClip || '');
    this._syncWorkspaceModelClipLibrary();
  }

  _syncWorkspaceModelClipLibrary() {
    const host = this._workspaceModelClipListEl;
    if (!host) return;
    clear(host);
    const clips = Array.isArray(this._workspaceGltf?.animations) ? this._workspaceGltf.animations : [];
    const filter = String(this._workspaceModelClipFilterEl?.value || '').trim().toLowerCase();
    const names = clips.map((c) => String(c?.name || '').trim()).filter(Boolean).filter((name) => {
      if (!filter) return true;
      return name.toLowerCase().includes(filter);
    });
    host.appendChild(el('div', { class: 'muted', style: { marginBottom: '6px' } }, [`${names.length} clip(s)`]));
    if (!names.length) {
      host.appendChild(el('div', { class: 'muted' }, ['(no clips on loaded model)']));
      return;
    }
    for (const name of names.slice(0, 300)) {
      host.appendChild(el('button', {
        class: `toolBtn${String(this._workspaceActiveClip || '') === name ? ' active' : ''}`,
        style: { marginTop: '6px' },
        onclick: () => this._setWorkspaceAnimation(name),
      }, [name]));
    }
  }

  _syncWorkspaceMotionClipLibrary() {
    const entries = this._getVisibleMotionClipEntries();
    const loading = !!this._motionClipsLoading;
    const sel = this._workspaceMotionClipSelectEl;
    if (sel) {
      clear(sel);
      sel.appendChild(el('option', { value: '' }, [loading ? '(loading platform clips...)' : '(select platform motion clip)']));
      sel.disabled = loading;
      for (let i = 0; i < Math.min(600, entries.length); i++) {
        const ent = entries[i];
        const name = String(ent?.name || '').trim();
        if (!name) continue;
        const src = String(ent?.sourcePath || '').trim();
        const label = src ? `${name}  <-  ${src}` : name;
        sel.appendChild(el('option', { value: String(i) }, [label]));
      }
      const selectedName = String(this._state.selectedMotionClip || '').trim();
      const selectedPath = String(this._state.selectedMotionPath || '').trim();
      const idx = entries.findIndex((x) => String(x?.name || '').trim() === selectedName && String(x?.sourcePath || '').trim() === selectedPath);
      sel.value = idx >= 0 ? String(idx) : '';
    }
    const host = this._workspaceMotionClipListEl;
    if (!host) return;
    clear(host);
    host.appendChild(el('div', { class: 'muted', style: { marginBottom: '6px' } }, [`${entries.length} platform clip(s)${loading ? ' (loading...)' : ''}`]));
    if (!entries.length) {
      host.appendChild(el('div', { class: 'muted' }, [loading ? '(loading platform clips...)' : '(load platform clips to populate)']));
      return;
    }
    for (const ent of entries.slice(0, 250)) {
      const name = String(ent?.name || '').trim();
      if (!name) continue;
      const src = String(ent?.sourcePath || '').trim();
      host.appendChild(el('button', {
        class: `toolBtn${String(this._state.selectedMotionClip || '') === name && String(this._state.selectedMotionPath || '') === src ? ' active' : ''}`,
        style: { marginTop: '6px' },
        onclick: () => {
          this._setSelectedMotionClip(name, src);
          if (this._workspaceMotionClipSelectEl) {
            const idx = entries.findIndex((x) => String(x?.name || '').trim() === name && String(x?.sourcePath || '').trim() === src);
            this._workspaceMotionClipSelectEl.value = idx >= 0 ? String(idx) : '';
          }
          this._refreshWorkspace();
        },
        title: src || undefined,
      }, [src ? `${name} (${src})` : name]));
    }
  }

  _setWorkspaceAnimation(name) {
    const n = String(name || '').trim();
    this._workspaceActiveClip = n;
    if (!this._workspaceMixer || !Array.isArray(this._workspaceGltf?.animations)) {
      this._refreshWorkspaceAnimSelect();
      return;
    }
    this._workspaceMixer.stopAllAction();
    if (!n) {
      this._refreshWorkspaceAnimSelect();
      return;
    }
    const clip = this._workspaceGltf.animations.find((c) => String(c?.name || '').trim() === n);
    if (!clip) {
      this._refreshWorkspaceAnimSelect();
      return;
    }
    const action = this._workspaceMixer.clipAction(clip);
    action.reset();
    action.play();
    this._workspacePlay = true;
    if (this._workspacePlayBtn) this._workspacePlayBtn.textContent = 'Pause';
    if (this._workspaceAnimSelectEl) this._workspaceAnimSelectEl.value = n;
    this._setWorkspaceViewerStatus(`Playing clip: ${n}`);
  }

  async _workspaceConvertToGlb(inputPath) {
    const p = String(inputPath || '').trim();
    if (!p) throw new Error('Missing model path');
    this._setWorkspaceViewerStatus(`Converting ${p} -> GLB...`);
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
    const id = String(j.id || '');
    let outGlb = String(j.outGlb || '');
    let backoff = 450;
    while (true) {
      await new Promise((r) => setTimeout(r, backoff));
      const pr = await fetch(`/__devtools_convert_job?id=${encodeURIComponent(id)}`);
      const pj = await pr.json();
      if (!pj?.ok) throw new Error(String(pj?.error || 'convert query failed'));
      const status = String(pj.status || '');
      outGlb = String(pj.outGlb || outGlb || '');
      this._setWorkspaceViewerStatus(`Converting: ${status}`);
      if (status === 'done') {
        if (!outGlb) throw new Error('Convert finished but output GLB is missing');
        return outGlb;
      }
      if (status === 'error' || status === 'killed') {
        const errTail = String(pj.stderr || '').trim().split('\n').filter(Boolean).pop();
        throw new Error(`Convert ${status}${errTail ? `: ${errTail}` : ''}`);
      }
      backoff = 500;
    }
  }

  async _maybeConnectExternalAnimations({ autoPreviewIdle = true } = {}) {
    const st = this._state;
    const motionRoot = String(st.motionUrl || '').trim();
    if (!motionRoot) return false;
    if (this._workspaceAutoConnectBusy) return false;
    this._workspaceAutoConnectBusy = true;
    try {
      await this._loadMotionClips();
      this._syncWorkspaceMotionClipLibrary();
      this._setWorkspaceStatus(`Loaded external animation library from ${motionRoot}`);
      const entries = this._getVisibleMotionClipEntries();
      if (!entries.length) {
        this._setWorkspaceStatus(`No clips found under ${motionRoot}.`);
        return false;
      }
      this._setWorkspaceStatus(`Loaded ${entries.length} A-pose clip(s) for UI from ${motionRoot}`);
      this._scheduleAutoUnifiedBuild('auto-connect external clips');
      if (!autoPreviewIdle) return true;
      const idleName = pickIdleLikeClipName(entries) || String(entries[0]?.name || '').trim();
      if (!idleName) return true;
      const idleEntry = entries.find((x) => String(x?.name || '').trim() === idleName) || entries[0];
      this._setSelectedMotionClip(idleName, String(idleEntry?.sourcePath || motionRoot || '').trim());
      // Keep auto-connect lightweight: preview source clip directly.
      // If we're currently in the middle of a model load, queue preview right after.
      if (this._workspaceIsLoading) {
        this._setWorkspaceViewerStatus('Loaded model without embedded clips. Preparing source clip preview...');
        this._queueSourceClipPreviewAfterLoad();
        this._setWorkspaceStatus(`Loaded ${entries.length} platform clip(s) from ${motionRoot}. Source preview queued: "${idleName}".`);
      } else {
        await this._previewSelectedSourceClipInViewer();
        this._setWorkspaceStatus(`Loaded ${entries.length} platform clip(s) from ${motionRoot}. Previewing source clip "${idleName}".`);
      }
      return true;
    } catch (e) {
      this._setWorkspaceStatus(`A-pose clips loaded for UI, but source preview failed: ${e?.message || e}`);
      return false;
    } finally {
      this._workspaceAutoConnectBusy = false;
    }
  }

  async _previewSelectedSourceClipInViewer() {
    const st = this._state;
    if (!String(st.selectedMotionPath || '').trim() && String(st.selectedMotionClip || '').trim()) {
      const ent = this._findMotionClipEntryByName(st.selectedMotionClip);
      if (ent?.sourcePath) st.selectedMotionPath = String(ent.sourcePath || '').trim();
    }
    const src = String(st.selectedMotionPath || st.motionUrl || '').trim();
    if (!src) throw new Error('Select a source clip first');
    const srcExt = extFromPath(src);
    const cleanPath = (p) => String(p || '').trim().split('#')[0].split('?')[0].replace(/^\/+/, '');
    const loadedModel = cleanPath(this._workspaceLoadedModelUrl || '');
    const srcPath = cleanPath(src);
    const hasCharacterLoaded = !!this._workspaceModelRoot && !!loadedModel;
    const isDifferentModel = hasCharacterLoaded && !!srcPath && srcPath !== loadedModel;
    if (srcExt === '.fbx' || srcExt === '.bvh') {
      // Avoid repeated per-clip FBX/BVH conversions during browsing.
      // Unified background build handles conversion once for full output.
      const clipLabel = String(st.selectedMotionClip || clipNameFromPath(src) || 'source clip').trim();
      this._setWorkspaceViewerStatus(`Selected ${clipLabel} from ${src} (skipping direct ${srcExt} preview conversion).`);
      return;
    }
    if (isDifferentModel && (srcExt === '.glb' || srcExt === '.gltf' || isUsdExt(srcExt))) {
      const clipLabel = String(st.selectedMotionClip || clipNameFromPath(src) || 'source clip').trim();
      this._setWorkspaceViewerStatus(`Selected ${clipLabel} from ${src} (kept current character model).`);
      this._setWorkspaceStatus('Source file appears to be a separate character model. Use "Retarget selected clip to character" to preview on the loaded character.');
      return;
    }
    await this._loadWorkspaceModel(src, { preferIdle: false, autoConnectExternal: false });
    const clipName = String(st.selectedMotionClip || '').trim();
    if (clipName) {
      const has = Array.isArray(this._workspaceGltf?.animations)
        ? this._workspaceGltf.animations.some((c) => String(c?.name || '').trim() === clipName)
        : false;
      if (has) this._setWorkspaceAnimation(clipName);
    }
    this._setWorkspaceStatus(`Previewing A-pose source clip in viewer: ${src}`);
  }

  _queueSourceClipPreviewAfterLoad() {
    if (this._workspaceDeferredSourcePreviewTimer) return;
    const startedAt = Date.now();
    const stepMs = 120;
    const maxWaitMs = 12_000;
    const tick = async () => {
      if (!this._workspaceIsLoading) {
        this._workspaceDeferredSourcePreviewTimer = 0;
        try {
          await this._previewSelectedSourceClipInViewer();
        } catch (e) {
          this._setWorkspaceStatus(`Queued source preview failed: ${e?.message || e}`);
        }
        return;
      }
      if ((Date.now() - startedAt) > maxWaitMs) {
        this._workspaceDeferredSourcePreviewTimer = 0;
        this._setWorkspaceStatus('Source clip preview queue timed out while model was still loading.');
        return;
      }
      this._workspaceDeferredSourcePreviewTimer = globalThis.setTimeout(() => { void tick(); }, stepMs);
    };
    void tick();
  }

  async _loadWorkspaceModel(url, { preferIdle = false, autoConnectExternal = true } = {}) {
    if (!this._workspaceScene || !this._workspaceCamera || !this._workspaceControls) return;
    const raw = String(url || '').trim();
    if (!raw) throw new Error('Enter a model path first');
    if (this._workspaceIsLoading) {
      this._workspaceQueuedLoad = {
        url: raw,
        preferIdle: !!preferIdle,
        autoConnectExternal: !!autoConnectExternal,
      };
      this._setWorkspaceViewerStatus(`Queued load: ${raw}`);
      return;
    }
    this._workspaceIsLoading = true;
    this._setWorkspaceViewerStatus(`Loading ${raw}...`);
    try {
      let u = raw;
      const ext = u.lastIndexOf('.') >= 0 ? u.slice(u.lastIndexOf('.')).toLowerCase() : '';
      const needsConvert = isUsdExt(ext) || ext === '.fbx';
      if (needsConvert) {
        u = await this._workspaceConvertToGlb(u);
      }

      this._clearWorkspaceModel();
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(u);
      const root = gltf?.scene || null;
      if (!root) throw new Error('Model is missing scene data');
      root.traverse?.((n) => {
        // Skinned meshes can disappear at runtime when static bounds are culled.
        if (n?.isSkinnedMesh) n.frustumCulled = false;
      });
      const rotDeg = Array.isArray(this._state?.modelRotationDeg)
        ? this._state.modelRotationDeg.slice(0, 3).map((v) => Number(v) || 0)
        : [0, 0, 0];
      if (rotDeg.some((v) => Math.abs(v) > 1e-6)) {
        root.rotation.set(
          THREE.MathUtils.degToRad(rotDeg[0] || 0),
          THREE.MathUtils.degToRad(rotDeg[1] || 0),
          THREE.MathUtils.degToRad(rotDeg[2] || 0),
        );
        root.updateMatrixWorld(true);
      }
      this._workspaceScene.add(root);
      this._workspaceGltf = gltf;
      this._workspaceModelRoot = root;
      this._workspaceMixer = Array.isArray(gltf.animations) && gltf.animations.length
        ? new THREE.AnimationMixer(root)
        : null;
      this._workspaceLoadedModelUrl = u;

      const box = new THREE.Box3().setFromObject(root);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);
      const finiteCenter = Number.isFinite(center.x) && Number.isFinite(center.y) && Number.isFinite(center.z);
      const finiteSize = Number.isFinite(size.x) && Number.isFinite(size.y) && Number.isFinite(size.z);
      const hasBounds = finiteCenter && finiteSize && !box.isEmpty() && size.lengthSq() > 1e-10;
      if (!hasBounds) {
        center.set(0, 1, 0);
        size.set(1, 2, 1);
      }
      const maxDim = Math.max(0.25, size.x, size.y, size.z);
      const radius = Math.max(0.25, maxDim * 0.95);
      this._workspaceControls.target.copy(center);
      this._workspaceCamera.position.copy(center).add(new THREE.Vector3(radius * 1.2, radius * 0.65, radius * 1.2));
      this._workspaceCamera.near = Math.max(0.01, radius * 0.01);
      this._workspaceCamera.far = Math.max(50, radius * 50);
      this._workspaceCamera.updateProjectionMatrix();
      this._workspaceControls.update();

      this._refreshWorkspaceAnimSelect();
      const desired = String(this._state.selectedMotionClip || '').trim();
      const names = Array.isArray(gltf.animations) ? gltf.animations.map((c) => String(c?.name || '').trim()).filter(Boolean) : [];
      const idleLike = pickIdleLikeClipName(gltf.animations || []);
      if (preferIdle && idleLike) {
        this._setWorkspaceAnimation(idleLike);
      } else if (desired && names.includes(desired)) {
        this._setWorkspaceAnimation(desired);
      } else if (idleLike) {
        this._setWorkspaceAnimation(idleLike);
      } else if (names.length) {
        this._setWorkspaceAnimation(String(names[0] || '').trim());
      } else {
        const hasMotionSource = String(this._state?.motionUrl || '').trim().length > 0;
        this._setWorkspaceViewerStatus(hasMotionSource
          ? 'Loaded model (no embedded clips). Loading platform clips...'
          : 'Loaded model (no animation clips found).');
        if (autoConnectExternal) {
          await this._maybeConnectExternalAnimations({ autoPreviewIdle: !!preferIdle });
        }
      }
      if (this._workspaceModelInputEl) this._workspaceModelInputEl.value = u;
      this._refreshWorkspace();
    } finally {
      this._workspaceIsLoading = false;
      const queued = this._workspaceQueuedLoad;
      this._workspaceQueuedLoad = null;
      if (queued && String(queued.url || '').trim()) {
        void this._loadWorkspaceModel(String(queued.url || ''), {
          preferIdle: !!queued.preferIdle,
          autoConnectExternal: !!queued.autoConnectExternal,
        }).catch((e) => this._setWorkspaceViewerStatus(String(e?.message || e)));
      }
    }
  }

  _renderClipLibraryList() {
    const st = this._state;
    const clips = Array.isArray(this._motionClips) ? this._motionClips : [];
    const host = el('div', { class: 'scrollArea', style: { height: '180px', marginTop: '8px', whiteSpace: 'pre-wrap' } }, []);
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
          const ent = st.slots[slot] || (st.slots[slot] = { motionPath: '', motionClip: '' });
          ent.motionClip = name;
          const match = this._findMotionClipEntryByName(name);
          if (!String(ent.motionPath || '').trim()) ent.motionPath = String(match?.sourcePath || st.motionUrl || '').trim();
          this._buildUi();
        },
        title: `Assign to ${String(st.activeSlot || 'idle')}`,
      }, [name]));
    }
    return host;
  }

  _renderLocomotionSlots() {
    const st = this._state;
    const keys = LOCOMOTION_SLOT_KEYS;
    const host = el('div', { class: 'card', style: { marginTop: '10px' } }, []);
    host.appendChild(el('div', { class: 'muted', style: { whiteSpace: 'pre-wrap' } }, ['Per-slot mapping for this character profile.']));
    for (const k of keys) {
      const ent = st.slots[k] || (st.slots[k] = { motionPath: '', motionClip: '' });
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
          onclick: () => { st.activeSlot = k; this._buildUi(); },
        }, [k]),
        p,
        c,
      ]));
    }
    return host;
  }

  _buildAssetPicker({ title, ext, onPick, allowEmptyQuery = false }) {
    const ctx = this._ctx;
    const queryInput = el('input', { placeholder: allowEmptyQuery ? 'search assets (optional; empty to list)' : 'search assets' });
    const list = el('div', { class: 'scrollArea', style: { height: '120px' } }, ['(search to populate)']);
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

  _findMotionClipEntryByName(name) {
    const n = String(name || '').trim();
    if (!n) return null;
    const clips = Array.isArray(this._motionClips) ? this._motionClips : [];
    const selectedPath = String(this._state?.selectedMotionPath || '').trim();
    const motionRoot = String(this._state?.motionUrl || '').trim().replace(/\/+$/, '');
    const matches = clips.filter((c) => String(c?.name || '').trim() === n);
    if (!matches.length) return null;
    if (selectedPath) {
      const exact = matches.find((c) => String(c?.sourcePath || '').trim() === selectedPath);
      if (exact) return exact;
    }
    if (motionRoot) {
      const inRoot = matches.find((c) => String(c?.sourcePath || '').trim().startsWith(`${motionRoot}/`) || String(c?.sourcePath || '').trim() === motionRoot);
      if (inRoot) return inRoot;
    }
    return matches[0] || null;
  }

  _setSelectedMotionClip(name, explicitPath = '') {
    const st = this._state;
    const clip = String(name || '').trim();
    st.selectedMotionClip = clip;
    const byName = this._findMotionClipEntryByName(clip);
    const p = String(explicitPath || byName?.sourcePath || st.motionUrl || '').trim();
    st.selectedMotionPath = p;
  }

  async _listMotionClipsFromPath(motionPath) {
    const st = this._state;
    const src = String(motionPath || '').trim();
    if (!src) return [];
    const resp = await fetch('/__devtools_anim_list_clips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runner: String(st.runner || 'conda_trellis'),
        blenderPath: String(st.blenderPath || ''),
        motionPath: src,
      }),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'list clips failed'));
    return Array.isArray(j?.clips) ? j.clips : [];
  }

  async _discoverMotionFiles(motionRoot) {
    const src = String(motionRoot || '').trim();
    if (!src) return [];
    const resp = await fetch('/__devtools_anim_list_motion_files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ motionRoot: src }),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'motion file discovery failed'));
    const files = Array.isArray(j?.files) ? j.files : [];
    return files.map((p) => String(p || '').trim()).filter(Boolean);
  }

  async _loadMotionClips() {
    const st = this._state;
    const motionPath = String(st.motionUrl || '').trim();
    if (!motionPath) throw new Error('Set motionUrl first');
    this._motionClipsLoading = true;
    this._syncWorkspaceMotionClipLibrary();
    this._refreshWorkspace();
    try {
      let loadedNow = [];
      const direct = await this._listMotionClipsFromPath(motionPath);
      if (direct.length) {
        loadedNow = direct.map((c) => ({ ...c, sourcePath: motionPath }));
      } else if (/\.[^/]+$/.test(motionPath)) {
        // Single-file fallback when clip introspection returns no named actions.
        const fallbackName = clipNameFromPath(motionPath);
        loadedNow = fallbackName ? [{ name: fallbackName, start: null, end: null, sourcePath: motionPath }] : [];
      } else {
        // Folder input (common with animation packs): enumerate files and aggregate clips.
        const baseMotionPath = motionPath.replace(/\/+$/, '');
        const roots = [baseMotionPath];
        if (!/\/singles$/i.test(baseMotionPath)) {
          roots.push(`${baseMotionPath}/singles`);
        } else {
          // If source points at ".../singles", also scan parent pack root so all
          // sibling packs under ".../unzipped/*" are included.
          const parent = baseMotionPath.replace(/\/singles$/i, '');
          if (parent) roots.push(parent);
        }
        const uniqRoots = Array.from(new Set(roots));
        const files = [];
        for (const root of uniqRoots) {
          try {
            const found = await this._discoverMotionFiles(root);
            for (const p of found) files.push(p);
          } catch { /* ignore per-root discovery errors */ }
        }
        const rootsNorm = uniqRoots
          .map((r) => String(r || '').trim().replace(/\/+$/, ''))
          .filter(Boolean);
        const scopedFiles = files.filter((p) => {
          const s = String(p || '').trim();
          return rootsNorm.some((root) => s === root || s.startsWith(`${root}/`));
        });
        const uniqFiles = Array.from(new Set(scopedFiles));
        const merged = [];
        for (const filePath of uniqFiles) {
          const ext = extFromPath(filePath);
          const fallbackName = clipNameFromPath(filePath);
          // FBX/BVH clip introspection is often slow and commonly yields generic
          // action labels (Layer0). Use filename directly for fast, reliable UX.
          const useFastSingleClip = ext === '.fbx' || ext === '.bvh';
          if (useFastSingleClip) {
            if (fallbackName) {
              merged.push({
                name: fallbackName,
                start: null,
                end: null,
                sourcePath: filePath,
              });
            }
            continue;
          }
          let clips = [];
          try { clips = await this._listMotionClipsFromPath(filePath); } catch { clips = []; }
          if (clips.length) {
            const clipCount = clips.length;
            for (let clipIndex = 0; clipIndex < clipCount; clipIndex++) {
              const c = clips[clipIndex];
              const name = clipDisplayNameForFile(String(c?.name || '').trim(), filePath, clipIndex, clipCount);
              if (!name) continue;
              merged.push({
                ...c,
                name,
                sourcePath: filePath,
              });
            }
          } else {
            // Per-file fallback: still expose the file as a selectable clip.
            if (fallbackName) {
              merged.push({
                name: fallbackName,
                start: null,
                end: null,
                sourcePath: filePath,
              });
            }
          }
        }
        loadedNow = merged;
      }
      {
        const deduped = [];
        const seen = new Set();
        for (const c of loadedNow) {
          const name = String(c?.name || '').trim();
          const sourcePath = String(c?.sourcePath || '').trim();
          if (!name || !sourcePath) continue;
          const key = `${sourcePath}::${normClipName(name)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          deduped.push({ ...c, name, sourcePath });
        }
        // Replace with currently requested source set to avoid stale cross-pack drift.
        this._motionClips = deduped;
      }
      if (!String(this._state.selectedMotionClip || '').trim() && this._motionClips.length) {
        const first = this._motionClips[0];
        this._setSelectedMotionClip(String(first?.name || '').trim(), String(first?.sourcePath || motionPath));
      } else if (String(this._state.selectedMotionClip || '').trim()) {
        const ent = this._findMotionClipEntryByName(this._state.selectedMotionClip);
        if (ent) this._state.selectedMotionPath = String(ent.sourcePath || this._state.motionUrl || '').trim();
      }
      return this._motionClips;
    } finally {
      this._motionClipsLoading = false;
      this._syncWorkspaceMotionClipLibrary();
      this._refreshWorkspace();
      if (Array.isArray(this._motionClips) && this._motionClips.length) {
        this._scheduleAutoUnifiedBuild('motion clips loaded');
      }
    }
  }

  _getVisibleMotionClipEntries() {
    const st = this._state;
    const clips = Array.isArray(this._motionClips) ? this._motionClips : [];
    const filter = String(st.clipFilter || '').trim().toLowerCase();
    const vendor = String(st.clipVendor || 'all');
    return clips.filter((x) => {
      const name = String(x?.name || '').trim();
      if (!name) return false;
      const isNvd = isNvidiaAnimName(name);
      if (vendor === 'nvidia' && !isNvd) return false;
      if (vendor === 'other' && isNvd) return false;
      if (filter && !name.toLowerCase().includes(filter)) return false;
      return true;
    });
  }

  _getVisibleClipNames() {
    return this._getVisibleMotionClipEntries()
      .map((x) => String(x?.name || '').trim())
      .filter(Boolean);
  }

  async _startPreviewClipRetarget({ statusEl, logEl }) {
    const st = this._state;
    const rigPath = String(st.rigPath || st.modelUrl || '').trim();
    if (!String(st.selectedMotionPath || '').trim() && String(st.selectedMotionClip || '').trim()) {
      const ent = this._findMotionClipEntryByName(st.selectedMotionClip);
      if (ent?.sourcePath) st.selectedMotionPath = String(ent.sourcePath || '').trim();
    }
    const motionPath = String(st.selectedMotionPath || st.motionUrl || '').trim();
    const mapPath = String(st.mapUrl || '').trim();
    const motionClip = String(st.selectedMotionClip || '').trim();
    if (!rigPath) throw new Error('Set rigPath/modelUrl first');
    if (!motionPath) throw new Error('Set motion source first');
    if (!mapPath) throw new Error('Set mapPath first');
    if (!motionClip) throw new Error('Select a motion clip first');

    this._animJob = { id: '', status: 'running', outGlb: '', stdout: '', stderr: '' };
    this._pollingAnim = false;
    if (statusEl) statusEl.textContent = `Preview retarget: ${motionClip}...`;
    if (logEl) logEl.textContent = '(starting...)';

    const outName = `${String(st.profileName || 'character').trim()}_${motionClip.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 42)}_preview`;
    const resp = await fetch('/__devtools_anim_retarget_start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rigPath,
        motionPath,
        mapPath,
        runner: String(st.runner || 'conda_trellis'),
        blenderPath: String(st.blenderPath || ''),
        motionClip,
        clipName: motionClip,
        exportFormat: 'GLB',
        rootMotion: 0,
        includeMesh: 1,
        outName,
      }),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'preview retarget start failed'));
    this._animJob = {
      id: String(j.id || ''),
      status: 'running',
      outGlb: String(j.outGlb || ''),
      stdout: '',
      stderr: '',
    };
    this._pollingAnim = true;
    await this._pollAnimJob({ id: this._animJob.id, statusEl, logEl, jobLabel: 'Retarget preview' });
  }

  async _startUnifiedPackFromLoadedClips({ statusEl, logEl, maxClips = 0, sourceSignature = '' } = {}) {
    const st = this._state;
    const rigPath = String(st.rigPath || st.modelUrl || '').trim();
    const mapPath = String(st.mapUrl || '').trim();
    if (!rigPath) throw new Error('Set rigPath/modelUrl first');
    if (!mapPath) throw new Error('Set mapPath first');

    if (!Array.isArray(this._motionClips) || !this._motionClips.length) {
      await this._loadMotionClips();
    }
    const loaded = Array.isArray(this._motionClips) ? this._motionClips : [];
    const maxCount = Math.max(0, Number(maxClips) || 0);
    const sourceEntries = loaded
      .map((x) => ({
        name: String(x?.name || '').trim(),
        sourcePath: String(x?.sourcePath || '').trim(),
      }))
      .filter((x) => x.name && x.sourcePath)
      .slice(0, maxCount > 0 ? maxCount : undefined);
    if (!sourceEntries.length) throw new Error('No loaded source clips to merge');
    const inputSig = String(sourceSignature || this._computeUnifiedInputSignature({
      profileName: st.profileName,
      rigPath,
      mapPath,
      sourceEntries,
    }) || '').trim();

    const used = new Set();
    const clips = [];
    for (let i = 0; i < sourceEntries.length; i++) {
      const ent = sourceEntries[i];
      const base = String(ent.name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        || `clip_${i + 1}`;
      let clipName = base.slice(0, 48);
      if (!clipName) clipName = `clip_${i + 1}`;
      let unique = clipName;
      let n = 2;
      while (used.has(unique)) {
        unique = `${clipName}_${n++}`;
      }
      used.add(unique);
      const srcExt = extFromPath(ent.sourcePath);
      const motionClip = (srcExt.startsWith('.fbx') || srcExt.startsWith('.bvh'))
        ? ''
        : ent.name;
      clips.push({
        clipName: unique,
        motionPath: ent.sourcePath,
        motionClip,
      });
    }

    this._animJob = { id: '', status: 'running', outGlb: '', stdout: '', stderr: '' };
    this._pollingAnim = false;
    if (statusEl) {
      statusEl.textContent = `Building unified model from ${clips.length} clip(s)...`;
      if (maxCount > 0 && loaded.length > clips.length) {
        statusEl.textContent += ` (${loaded.length - clips.length} clipped by max ${maxCount})`;
      }
    }
    if (logEl) logEl.textContent = '(starting unified build...)';

    const outName = `${String(st.profileName || 'character').trim()}_unified_clips`;
    const resp = await fetch('/__devtools_anim_locomotion_pack_start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runner: String(st.runner || 'conda_trellis'),
        blenderPath: String(st.blenderPath || ''),
        rigPath,
        mapPath,
        clips,
        exportFormat: 'GLB',
        includeMesh: 1,
        outName,
      }),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'unified build start failed'));
    this._animJob = {
      id: String(j.id || ''),
      status: 'running',
      outGlb: String(j.outGlb || ''),
      stdout: '',
      stderr: '',
    };
    this._pollingAnim = true;
    await this._pollAnimJob({ id: this._animJob.id, statusEl, logEl, jobLabel: 'Unified model build' });

    const out = String(this._animJob?.outGlb || '').trim();
    if (out) {
      let embeddedClips = [];
      try { embeddedClips = await this._listMotionClipsFromPath(out); } catch { embeddedClips = []; }
      this._setUnifiedModelForProfile(st.profileName, out);
      if (inputSig) this._setUnifiedInputSigForProfile(st.profileName, inputSig);
      st.modelUrl = out;
      if (this._workspaceModelInputEl) this._workspaceModelInputEl.value = out;
      let manifestWarn = '';
      try {
        await this._writeModelPathToActiveManifest(out);
      } catch (e) {
        manifestWarn = String(e?.message || e || 'manifest update failed');
      }
      let loadWarn = '';
      try {
        await this._loadWorkspaceModel(out, { preferIdle: true, autoConnectExternal: false });
      } catch (e) {
        loadWarn = String(e?.message || e || 'viewer load failed');
      }
      const loadedClipCount = Array.isArray(this._workspaceModelClips) ? this._workspaceModelClips.length : 0;
      const probeClipCount = Array.isArray(embeddedClips) ? embeddedClips.length : 0;
      if (loadWarn) {
        this._setWorkspaceStatus(`Unified model built, but viewer load failed: ${out} (${loadWarn})`);
        if (statusEl) {
          statusEl.textContent = `Unified build finished.\nOutput: ${out}\nViewer load warning: ${loadWarn}`;
          if (manifestWarn) statusEl.textContent += `\nManifest warning: ${manifestWarn}`;
        }
        if (logEl) {
          const prior = String(logEl.textContent || '');
          const manifestTail = manifestWarn ? `\n[character_tool] Manifest update warning: ${manifestWarn}` : '';
          logEl.textContent = `${prior}\n\n[character_tool] Unified output is ready, but viewer load failed: ${loadWarn}${manifestTail}`.trim();
        }
      } else if (loadedClipCount > 0) {
        const tail = manifestWarn ? ` (manifest warning: ${manifestWarn})` : '';
        this._setWorkspaceStatus(`Unified model ready (${loadedClipCount} clip(s)): ${out}${tail}`);
      } else if (probeClipCount > 0) {
        const tail = manifestWarn ? ` (manifest warning: ${manifestWarn})` : '';
        this._setWorkspaceStatus(`Unified model ready (${probeClipCount} clip(s) reported): ${out}${tail}`);
      } else {
        const tail = manifestWarn ? ` (manifest warning: ${manifestWarn})` : '';
        this._setWorkspaceStatus(`Unified model ready (clip probe unavailable): ${out}${tail}`);
        if (statusEl) {
          statusEl.textContent = `Unified build finished.\nOutput: ${out}`;
          if (manifestWarn) statusEl.textContent += `\nManifest warning: ${manifestWarn}`;
        }
      }
      this._syncWorkspaceUnifyButton();
    }
  }

  _resolveManifestRelPath() {
    const st = this._state;
    const explicit = String(st?.manifestPath || '').trim().replace(/^\/+/, '');
    if (explicit && explicit.endsWith('/character_manifest.json')) return explicit;
    const charId = safeCharacterId(st.profileName || 'character');
    return `assets/characters/${charId}/character_manifest.json`;
  }

  _manifestDirFromPath(manifestPath) {
    const rel = String(manifestPath || '').trim().replace(/^\/+/, '');
    if (!rel) return '';
    const i = rel.lastIndexOf('/');
    return i > 0 ? rel.slice(0, i) : '';
  }

  _buildLocomotionProfileData({ modelPath = '' } = {}) {
    const st = this._state;
    const character = safeCharacterId(st.profileName || 'character');
    const slots = {};
    const actions = {};
    for (const key of LOCOMOTION_SLOT_KEYS) {
      const ent = st.slots?.[key] || {};
      const motionClip = String(ent?.motionClip || '').trim();
      const motionPath = String(ent?.motionPath || '').trim();
      slots[key] = { motionClip, motionPath };
      if (motionClip) {
        actions[key] = Array.from(new Set([key, motionClip])).filter(Boolean);
      }
    }
    return {
      schema: 1,
      kind: 'character_locomotion_profile',
      character,
      model: String(modelPath || st.modelUrl || '').trim(),
      map: String(st.mapUrl || '').trim(),
      slots,
      actions,
      slotOrder: LOCOMOTION_SLOT_KEYS.slice(),
      generatedAt: new Date().toISOString(),
    };
  }

  async _writeJsonAsset({ relPath = '', relDir = '', nameHint = '', data = {} } = {}) {
    const payload = {};
    const rp = String(relPath || '').trim().replace(/^\/+/, '');
    const rd = String(relDir || '').trim().replace(/^\/+/, '');
    if (rp) payload.relPath = rp;
    if (!rp && rd) payload.relDir = rd;
    payload.nameHint = String(nameHint || 'asset').trim() || 'asset';
    payload.data = (data && typeof data === 'object') ? data : {};
    const resp = await fetch('/__devtools_write_json_asset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await resp.json().catch(() => null);
    if (!j?.ok) throw new Error(String(j?.error || 'write_json_asset failed'));
    return {
      ok: true,
      relPath: String(j?.relPath || rp || '').trim(),
    };
  }

  async _publishCharacterProfile({ modelPath = '', requireActiveManifest = false } = {}) {
    const st = this._state;
    const outModel = String(modelPath || st.modelUrl || st.rigPath || '').trim();
    if (!outModel) throw new Error('Missing model path to publish');
    if (requireActiveManifest) {
      const hasActive = String(st?.manifestPath || '').trim().endsWith('/character_manifest.json');
      if (!hasActive) return { ok: false, skipped: 'no active manifest path' };
    }

    const manifestPath = this._resolveManifestRelPath();
    const manifestDir = this._manifestDirFromPath(manifestPath) || `assets/characters/${safeCharacterId(st.profileName || 'character')}`;
    const locomotionPath = `${manifestDir}/locomotion_profile.json`;

    let existingManifest = {};
    try {
      const readResp = await fetch(`/${manifestPath}`);
      if (readResp.ok) {
        const j = await readResp.json();
        existingManifest = (j && typeof j === 'object') ? j : {};
      }
    } catch { /* ignore missing manifests; we'll create one */ }

    const locomotion = this._buildLocomotionProfileData({ modelPath: outModel });
    const wroteLoco = await this._writeJsonAsset({
      relPath: locomotionPath,
      relDir: manifestDir,
      nameHint: `${safeCharacterId(st.profileName || 'character')}_locomotion_profile`,
      data: locomotion,
    });

    const character = safeCharacterId(existingManifest.character || st.profileName || 'character');
    const mergedManifest = {
      ...existingManifest,
      character,
      model: outModel,
      locomotion: {
        profile: String(wroteLoco.relPath || locomotionPath),
        slots: JSON.parse(JSON.stringify(locomotion.slots || {})),
        actions: JSON.parse(JSON.stringify(locomotion.actions || {})),
      },
    };
    const wroteManifest = await this._writeJsonAsset({
      relPath: manifestPath,
      relDir: manifestDir,
      nameHint: `${character}_manifest`,
      data: mergedManifest,
    });
    st.manifestPath = String(wroteManifest.relPath || manifestPath).trim();
    return {
      ok: true,
      character,
      manifestPath: st.manifestPath,
      locomotionPath: String(wroteLoco.relPath || locomotionPath).trim(),
    };
  }

  async _writeModelPathToActiveManifest(modelPath) {
    const outPath = String(modelPath || '').trim();
    if (!outPath) return { ok: false, skipped: 'missing model path' };
    return this._publishCharacterProfile({ modelPath: outPath, requireActiveManifest: true });
  }

  _scheduleAutoUnifiedBuild(reason = '') {
    if (!this._autoUnifyEnabled) return;
    if (this._autoUnifyTimer) return;
    this._autoUnifyTimer = globalThis.setTimeout(() => {
      this._autoUnifyTimer = 0;
      void this._maybeAutoBuildUnifiedModel({ reason: String(reason || '').trim() });
    }, 700);
  }

  async _maybeAutoBuildUnifiedModel({ reason = '' } = {}) {
    const st = this._state;
    if (!this._autoUnifyEnabled) return false;
    if (this._autoUnifyBusy || this._pollingAnim) return false;
    const profileName = String(st.profileName || '').trim();
    const motionUrl = String(st.motionUrl || '').trim();
    const rigPath = String(st.rigPath || st.modelUrl || '').trim();
    const mapPath = String(st.mapUrl || '').trim();
    if (!profileName || !motionUrl || !rigPath || !mapPath) return false;
    if (!Array.isArray(this._motionClips) || !this._motionClips.length) return false;
    const sourceEntries = this._motionClips
      .map((x) => ({
        name: String(x?.name || '').trim(),
        sourcePath: String(x?.sourcePath || '').trim(),
      }))
      .filter((x) => x.name && x.sourcePath);
    if (!sourceEntries.length) return false;
    const inputSig = this._computeUnifiedInputSignature({
      profileName,
      rigPath,
      mapPath,
      sourceEntries,
    });
    const lastSig = this._getUnifiedInputSigForProfile(profileName);
    const unified = await this._ensureUnifiedModelValidForProfile(profileName);
    if (String(unified || '').trim() && lastSig && inputSig === lastSig) return false;
    const now = Date.now();
    const lastStart = Number(this._autoUnifyLastStartMsByProfile?.[profileName] || 0);
    if ((now - lastStart) < this._autoUnifyCooldownMs) return false;

    this._autoUnifyBusy = true;
    this._autoUnifyLastStartMsByProfile[profileName] = now;
    try {
      const suffix = reason ? ` (${reason})` : '';
      this._setWorkspaceStatus(`Auto-building unified model in background${suffix}...`);
      await this._startUnifiedPackFromLoadedClips({
        statusEl: this._workspaceMotionClipStatusEl,
        logEl: this._workspaceRetargetLogEl,
        sourceSignature: inputSig,
      });
      return true;
    } catch (e) {
      this._setWorkspaceStatus(`Auto-unify skipped/failed: ${e?.message || e}`);
      return false;
    } finally {
      this._autoUnifyBusy = false;
    }
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
      turn_left: ['turn_left', 'turnleft', 'turn_l', 'turn_l_45', 'turn_l_90', 'rotate_left'],
      turn_right: ['turn_right', 'turnright', 'turn_r', 'turn_r_45', 'turn_r_90', 'rotate_right'],
      jump_start: ['jump_start', 'jumpstart', 'jump_takeoff', 'takeoff', 'jump'],
      jump_air: ['jump_air', 'jumpair', 'inair', 'air', 'fall'],
      jump_land: ['jump_land', 'jumpland', 'land', 'landing'],
    };
    let n = 0;
    for (const [k, a] of Object.entries(aliases)) {
      const ent = st.slots[k] || (st.slots[k] = { motionPath: '', motionClip: '' });
      const picked = pickClipByAliases(clips, a, { preferNvidia: !!preferNvidia });
      if (picked) {
        ent.motionClip = picked;
        const pickedEnt = clips.find((c) => String(c?.name || '').trim() === picked);
        if (!String(ent.motionPath || '').trim()) ent.motionPath = String(pickedEnt?.sourcePath || st.motionUrl || '').trim();
        n++;
      }
    }
    return { filled: n };
  }

  async _startRigJob({ statusEl, logEl }) {
    const st = this._state;
    const inModelPath = String(st.modelUrl || '').trim();
    if (!inModelPath) throw new Error('Set modelUrl first');
    this._rigJob = { id: '', status: 'running', outRig: '', stdout: '', stderr: '' };
    this._pollingRig = false;
    if (statusEl) statusEl.textContent = 'Starting rig job...';
    if (logEl) logEl.textContent = '(starting...)';
    const outHint = String(st.profileName || st.outName || 'character').trim();
    const resp = await fetch('/__devtools_rig_start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runner: String(st.runner || 'conda_trellis'),
        inModelPath,
        rigBackend: 'rigify',
        rigArgs: '--deform-only',
        blenderPath: String(st.blenderPath || ''),
        outName: outHint,
      }),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'rig start failed'));
    this._rigJob = {
      id: String(j.id || ''),
      status: 'running',
      outRig: String(j.outRig || ''),
      stdout: '',
      stderr: '',
    };
    this._pollingRig = true;
    await this._pollRigJob({ id: this._rigJob.id, statusEl, logEl });
  }

  async _pollRigJob({ id, statusEl, logEl }) {
    const st = this._state;
    let backoff = 500;
    while (this._pollingRig && this._rigJob?.id === id) {
      const resp = await fetch(`/__devtools_rig_job?id=${encodeURIComponent(id)}`);
      const j = await resp.json();
      if (!j?.ok) throw new Error(String(j?.error || 'rig query failed'));
      this._rigJob.status = String(j.status || '');
      this._rigJob.stdout = String(j.stdout || '');
      this._rigJob.stderr = String(j.stderr || '');
      this._rigJob.outRig = String(j.outRig || this._rigJob.outRig || '');
      if (statusEl) statusEl.textContent = `Rig job: ${this._rigJob.status}${this._rigJob.outRig ? `\nRig: ${this._rigJob.outRig}` : ''}`;
      if (logEl) logEl.textContent = (this._rigJob.stderr ? (this._rigJob.stdout + '\n--- stderr ---\n' + this._rigJob.stderr) : this._rigJob.stdout) || '(no output yet)';
      this._setWorkspaceStatus(`Rig job: ${this._rigJob.status}`);
      if (this._rigJob.status === 'done') {
        this._pollingRig = false;
        const out = String(this._rigJob.outRig || '').trim();
        if (out) {
          st.rigPath = out;
          try { localStorage.setItem('devtools.lastGeneratedModelUrl', out); } catch { /* ignore */ }
          this._ctx?.toast?.(`Rig ready: ${out}`, 'success', { title: 'Character' });
        }
        this._buildUi();
        return;
      }
      if (this._rigJob.status === 'error' || this._rigJob.status === 'killed') {
        this._pollingRig = false;
        throw new Error(`Rig job ${this._rigJob.status}`);
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(1500, Math.floor(backoff * 1.2));
    }
  }

  async _startLocomotionPack({ statusEl, logEl }) {
    const st = this._state;
    const rigPath = String(st.rigPath || st.modelUrl || '').trim();
    const mapPath = String(st.mapUrl || '').trim();
    if (!rigPath) throw new Error('Set rigPath (or modelUrl) first');
    if (!mapPath) throw new Error('Set mapUrl first');

    const clips = [];
    for (const [clipName, ent] of Object.entries(st.slots || {})) {
      const motionPath = String(ent?.motionPath || '').trim();
      const motionClip = String(ent?.motionClip || '').trim();
      if (!motionPath || !motionClip) continue;
      clips.push({ clipName, motionPath, motionClip });
    }
    if (!clips.length) throw new Error('Configure at least one slot with motionPath + motionClip');

    this._animJob = { id: '', status: 'running', outGlb: '', stdout: '', stderr: '' };
    this._pollingAnim = false;
    if (statusEl) statusEl.textContent = 'Starting locomotion pack...';
    if (logEl) logEl.textContent = '(starting...)';

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
        outName: String(st.outName || `${String(st.profileName || 'character').trim()}_locomotion`),
      }),
    });
    const j = await resp.json();
    if (!j?.ok) throw new Error(String(j?.error || 'locomotion start failed'));
    this._animJob = {
      id: String(j.id || ''),
      status: 'running',
      outGlb: String(j.outGlb || ''),
      stdout: '',
      stderr: '',
    };
    this._pollingAnim = true;
    await this._pollAnimJob({ id: this._animJob.id, statusEl, logEl, jobLabel: 'Locomotion pack' });
  }

  async _pollAnimJob({ id, statusEl, logEl, jobLabel = 'Animation job' }) {
    let backoff = 500;
    while (this._pollingAnim && this._animJob?.id === id) {
      const resp = await fetch(`/__devtools_anim_job?id=${encodeURIComponent(id)}`);
      const j = await resp.json();
      if (!j?.ok) throw new Error(String(j?.error || 'anim query failed'));
      this._animJob.status = String(j.status || '');
      this._animJob.stdout = String(j.stdout || '');
      this._animJob.stderr = String(j.stderr || '');
      this._animJob.outGlb = String(j.outGlb || this._animJob.outGlb || '');
      if (statusEl) statusEl.textContent = `${jobLabel}: ${this._animJob.status}${this._animJob.outGlb ? `\nOutput: ${this._animJob.outGlb}` : ''}`;
      if (logEl) logEl.textContent = (this._animJob.stderr ? (this._animJob.stdout + '\n--- stderr ---\n' + this._animJob.stderr) : this._animJob.stdout) || '(no output yet)';
      this._setWorkspaceStatus(`${jobLabel}: ${this._animJob.status}`);
      this._refreshWorkspace();
      if (this._animJob.status === 'done') {
        this._pollingAnim = false;
        const out = String(this._animJob.outGlb || '').trim();
        if (out) {
          try { localStorage.setItem('devtools.lastGeneratedModelUrl', out); } catch { /* ignore */ }
          this._ctx?.toast?.(`Animation pack ready: ${out}`, 'success', { title: 'Character' });
        }
        this._setWorkspaceStatus(`${jobLabel} complete.`);
        return;
      }
      if (this._animJob.status === 'error' || this._animJob.status === 'killed') {
        this._pollingAnim = false;
        const tail = errorTailText(this._animJob.stderr, this._animJob.stdout);
        throw new Error(`Anim job ${this._animJob.status}${tail ? `: ${tail}` : ''}`);
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(1800, Math.floor(backoff * 1.25));
    }
  }
}

