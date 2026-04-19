import { el, clear, clamp } from '../../../ui/dom.js';
import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { createAssetPicker, createJobRunner, createJsonTextAreaCard } from '../components/ui_components.js';

import {
  SCENE_ASSET_LOCATIONS,
  SCENE_VEHICLE_PRESETS,
  withVehiclePathFallbacks,
} from './scene_presets.js';

import {
  safeTrim,
  lerp,
  clamp01,
  debounce,
  normQuery,
  extOf,
  isCharacterProfileAssetPath,
  isGlTfExt,
  isUsdExt,
  isConvertibleSceneExt,
  isProceduralPath,
  resizeCanvasToDisplaySize,
  disposeThreeObject,
  safeName,
  getFileStem,
  normalizeAssetUrl,
  metaUrlForModelUrl,
  resumeAssetCandidates,
  disableCreateImageBitmapForResumeExport,
  normalizeWebUrl,
  uniqStrings,
  escapeHtml,
  degToRad,
} from './core/scene_utils.js';

export function installScenePropsMixin(SceneTool) {
  SceneTool.prototype._ensurePropsRoot = function() {
    if (!this._scene) return null;
    if (!this._worldRoot) {
      // If user hasn't loaded/generated anything yet, create a minimal world root.
      const root = new THREE.Group();
      root.name = 'world_root';
      this._worldRoot = root;
      this._scene.add(root);
      // Make sure raycasts can still find "ground" on any subsequently added meshes.
      this._colliders = [root];
    }
    if (this._propsRoot && this._propsRoot.parent === this._worldRoot) return this._propsRoot;
    const g = new THREE.Group();
    g.name = '__spawned_props';
    this._propsRoot = g;
    try { this._worldRoot.add(g); } catch { /* ignore */ }
    return g;
  }

  SceneTool.prototype._readSceneInbox = function() {
    try {
      const raw = String(localStorage.getItem('devtools.scene.inbox') || '').trim();
      if (!raw) return null;
      const j = JSON.parse(raw);
      if (!j || typeof j !== 'object') return null;
      if (Number(j.schema) !== 1) return null;
      return j;
    } catch {
      return null;
    }
  }

  SceneTool.prototype._clearSceneInbox = function() {
    try { localStorage.removeItem('devtools.scene.inbox'); } catch { /* ignore */ }
  }

  SceneTool.prototype._tryApplyForgeInbox = async function() {
    const inbox = this._readSceneInbox?.() || null;
    if (!inbox || safeTrim(inbox?.kind) !== 'forge_world') return false;
    const payload = (inbox?.payload && typeof inbox.payload === 'object') ? inbox.payload : null;
    if (!payload) {
      this._clearSceneInbox();
      return false;
    }
    try {
      await this._applyForgeWorldPayload(payload);
      this._setStatus('Loaded world from Forge inbox.');
      this._ctx?.toast?.('Loaded Forge world', 'success', { title: 'Scene' });
    } catch (e) {
      this._setStatus(`Forge inbox import failed: ${e?.message || e}`);
      this._ctx?.toast?.(String(e?.message || e || 'Forge import failed'), 'error', { title: 'Scene' });
    } finally {
      this._clearSceneInbox();
    }
    return true;
  }

  SceneTool.prototype._removeWorldObjectByName = function(name) {
    const nm = safeTrim(name);
    if (!nm || !this._worldRoot) return null;
    const obj = this._worldRoot.getObjectByName?.(nm) || null;
    if (!obj) return null;
    try { if (obj.parent) obj.parent.remove(obj); } catch { /* ignore */ }
    try { disposeThreeObject(obj); } catch { /* ignore */ }
    return obj;
  }

  SceneTool.prototype._createForgeTerrainMesh = function({ size = 120, resolution = 65, color = 0x2a313f, heights = [] } = {}) {
    if (!this._worldRoot) return null;
    const n0 = Math.max(17, Math.min(129, Math.floor(Number(resolution) || 65)));
    const n = (n0 % 2 === 0) ? (n0 + 1) : n0;
    const s = Math.max(20, Math.min(500, Number(size) || 120));
    const hArr = Array.isArray(heights) ? heights : [];
    const want = n * n;

    const geo = new THREE.PlaneGeometry(s, s, n - 1, n - 1);
    geo.rotateX(-Math.PI * 0.5);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = (i < want) ? (Number(hArr[i]) || 0) : 0;
      pos.setY(i, y);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: Number(color) || 0x2a313f,
      roughness: 0.95,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'forge_terrain';
    mesh.receiveShadow = true;
    mesh.userData = mesh.userData || {};
    mesh.userData.isForgeTerrain = true;
    this._worldRoot.add(mesh);
    return mesh;
  }

  SceneTool.prototype._applyForgeWorldPayload = async function(payload) {
    const p = (payload && typeof payload === 'object') ? payload : {};
    const terrain = (p.terrain && typeof p.terrain === 'object') ? p.terrain : {};
    const blocks = Array.isArray(p.blocks) ? p.blocks : [];
    const props = Array.isArray(p.props) ? p.props : [];
    const spawn = (p.spawn && typeof p.spawn === 'object') ? p.spawn : {};

    const groundSize = Math.max(24, Math.min(500, Number(terrain?.size) || 120));
    this._createBlankGroundScene({
      groundSize,
      addPerimeterWalls: false,
      includePhysics: true,
      includeCollision: true,
      includeLocomotion: true,
      includeWeapons: false,
      includeInteractions: true,
      includeEnemies: false,
      includeVehicles: false,
      worldName: 'Forge Import',
      mapStartMode: 'flat',
      addStarterWaypoints: false,
      addStarterGoalTrigger: false,
    });

    // Replace the flat base with sculpted terrain from Forge.
    this._removeWorldObjectByName('ground_base');
    this._removeWorldObjectByName('forge_terrain');
    this._createForgeTerrainMesh({
      size: Number(terrain?.size) || groundSize,
      resolution: Number(terrain?.resolution) || 65,
      color: Number(terrain?.color) || 0x2a313f,
      heights: Array.isArray(terrain?.heights) ? terrain.heights : [],
    });
    this._colliders = [this._worldRoot];

    // Rebuild blocks as SceneTool primitive buildings so editor/play collisions continue to work.
    for (const rec of blocks) {
      const t = rec?.transform && typeof rec.transform === 'object' ? rec.transform : {};
      const b = rec?.building && typeof rec.building === 'object' ? rec.building : {};
      const nm = safeTrim(rec?.name) || 'forge_block';
      const w = Math.max(0.5, Number(b?.w) || 4);
      const d = Math.max(0.5, Number(b?.d) || 4);
      const h = Math.max(0.5, Number(b?.h) || 4);
      const g = this._createPrimitiveBuildingAt({
        name: nm,
        w,
        d,
        h,
        x: Number(Array.isArray(t?.pos) ? t.pos[0] : 0) || 0,
        z: Number(Array.isArray(t?.pos) ? t.pos[2] : 0) || 0,
      });
      if (!g) continue;
      try { g.position.y = Number(Array.isArray(t?.pos) ? t.pos[1] : 0) || 0; } catch { /* ignore */ }
      try { g.rotation.y = (Number(t?.yawDeg) || 0) * Math.PI / 180; } catch { /* ignore */ }
      try {
        const s = Math.max(1e-4, Number(t?.scale) || 1);
        g.scale.set(s, s, s);
      } catch { /* ignore */ }
    }

    for (const it of props) {
      const u = safeTrim(it?.url || '');
      if (!u) continue;
      try {
        this._player.x = Number(Array.isArray(it?.pos) ? it.pos[0] : 0) || 0;
        this._player.z = Number(Array.isArray(it?.pos) ? it.pos[2] : 0) || 0;
        this._player.y = Number(Array.isArray(it?.pos) ? it.pos[1] : 0) || 0;
        await this._spawnPropFromUrl(u, {
          name: safeTrim(it?.name || ''),
          scale: Number(it?.scale) || 1,
          yawDeg: Number(it?.yawDeg) || 0,
          place: 'player',
        });
      } catch { /* ignore */ }
    }

    this._spawn = {
      x: Number(spawn?.x) || 0,
      y: Number(spawn?.y) || 0,
      z: Number(spawn?.z) || 0,
    };
    this._player.x = this._spawn.x;
    this._player.y = this._spawn.y;
    this._player.z = this._spawn.z;
    this._player.vy = 0;

    this._state.mode = 'fps';
    this._syncModeUi();
    this._scanTaggedBuildings();
    this._renderBuildingsUi();
    this._renderBuildingEditorUi();
    this._renderPropsUi();
    this._rebuildScenarioDebug();
  }

  SceneTool.prototype._getVehiclePresetCatalog = function() {
    const base = Array.isArray(SCENE_VEHICLE_PRESETS) ? SCENE_VEHICLE_PRESETS.slice() : [];
    const dyn = Array.isArray(this._vehiclePresetsDyn) ? this._vehiclePresetsDyn.slice() : [];
    return base.concat(dyn);
  }

  SceneTool.prototype._refreshVehiclePresetsFromWebautos = async function() {
    const ctx = this._ctx;
    if (!ctx || typeof ctx.assetIndex !== 'function') return;
    if (this._vehiclePresetsDynLoading) return;
    this._vehiclePresetsDynLoading = true;
    this._vehiclePresetsDynStatus = 'Scanning webautos/…';
    try { if (this._ui?.vehiclePresetStatusEl) this._ui.vehiclePresetStatusEl.textContent = this._vehiclePresetsDynStatus; } catch { /* ignore */ }

    try {
      const items = await ctx.assetIndex({ query: 'webautos/', ext: '.glb,.gltf' });
      let arr = Array.isArray(items) ? items : [];
      // Prefer hi LOD stream models; keep list small since presets dropdown has no search.
      arr = arr.filter((it) => {
        const p = safeTrim(it?.path || '').replace(/\\/g, '/');
        if (!p.startsWith('webautos/')) return false;
        if (!p.includes('/stream/')) return false;
        const low = p.toLowerCase();
        if (!(low.endsWith('.glb') || low.endsWith('.gltf'))) return false;
        return low.includes('_hi.') || low.includes('/ac__') || low.includes('ac__') || low.endsWith('.glb');
      });
      arr.sort((a, b) => (Number(b?.mtimeMs) || 0) - (Number(a?.mtimeMs) || 0));
      arr = arr.slice(0, 350);

      const presets = [];
      for (const it of arr) {
        const rel = safeTrim(it?.path || '').replace(/^\/+/, '').replace(/\\/g, '/');
        if (!rel) continue;
        const parts = rel.split('/').filter(Boolean);
        const name = (parts[0] === 'webautos' && parts[1]) ? parts[1] : (parts[parts.length - 1] || rel);
        const label = String(name || '').trim() || rel;
        const modelUrl = '/' + rel;
        const metaUrl = (modelUrl.toLowerCase().endsWith('.glb'))
          ? modelUrl.slice(0, -4) + '.meta.json'
          : (modelUrl.toLowerCase().endsWith('.gltf') ? modelUrl.slice(0, -5) + '.meta.json' : modelUrl + '.meta.json');
        presets.push({
          id: `webautos:${rel}`,
          label,
          modelUrl,
          metaUrl,
          recommendedScale: 1.0,
          source: 'webautos',
        });
      }
      this._vehiclePresetsDyn = presets;
      this._vehiclePresetsDynLoadedAtMs = Date.now();
      this._vehiclePresetsDynStatus = `Loaded ${presets.length} preset(s) from webautos/.`;
    } catch (e) {
      this._vehiclePresetsDyn = [];
      this._vehiclePresetsDynStatus = `Scan failed: ${String(e?.message || e)}`;
    } finally {
      this._vehiclePresetsDynLoading = false;
      try { if (this._ui?.vehiclePresetStatusEl) this._ui.vehiclePresetStatusEl.textContent = this._vehiclePresetsDynStatus; } catch { /* ignore */ }
      try { if (this._ui?.vehiclePresetRefreshBtn) this._ui.vehiclePresetRefreshBtn.disabled = false; } catch { /* ignore */ }
      try { this._syncVehiclePresetSelectOptions?.(); } catch { /* ignore */ }
    }
  }

  SceneTool.prototype._syncVehiclePresetSelectOptions = function() {
    const sel = this._ui?.vehiclePresetSel;
    if (!sel) return;
    const cur = safeTrim(sel.value || '');
    const presets = this._getVehiclePresetCatalog();
    clear(sel);
    for (const p of presets) {
      const pid = safeTrim(p?.id);
      if (!pid) continue;
      sel.appendChild(el('option', { value: pid }, [safeTrim(p?.label) || pid]));
    }
    // Restore selection if possible.
    const still = cur && presets.some((p) => safeTrim(p?.id) === cur);
    const pick = still ? cur : safeTrim(presets?.[0]?.id || '');
    try { sel.value = pick; } catch { /* ignore */ }
    try {
      if (this._ui?.vehicleScaleInput) {
        const vehicleScaleStorageKeyFor = (presetId) => `devtools.scene.vehicleScale.${safeTrim(presetId) || 'default'}`;
        const p = presets.find((pp) => safeTrim(pp?.id) === safeTrim(pick)) || null;
        const rec = Number(p?.recommendedScale);
        const recScale = (Number.isFinite(rec) && rec > 0) ? rec : 1.0;
        let v = '';
        try { v = String(localStorage.getItem(vehicleScaleStorageKeyFor(pick)) || '').trim(); } catch { v = ''; }
        const n = v ? Number(v) : NaN;
        this._ui.vehicleScaleInput.value = String((Number.isFinite(n) && n > 0) ? n : recScale);
      }
    } catch { /* ignore */ }
    try { this._ui?.vehiclePresetSel?.onchange?.(); } catch { /* ignore */ }
  }

  SceneTool.prototype._resolveVehiclePresetSelection = async function(presetId) {
    const id = safeTrim(presetId);
    if (!id) return null;
    const preset = this._getVehiclePresetCatalog().find((p) => safeTrim(p?.id) === id) || null;
    if (!preset) return null;

    const modelCandidates = withVehiclePathFallbacks(preset.modelUrl || '').map((u) => normalizeAssetUrl(u)).filter(Boolean);
    const modelUrl = modelCandidates[0] || '';
    if (!modelUrl) throw new Error('Vehicle preset has no model URL.');

    let vehicleConfig = null;
    // Preferred: consume authored scene-inbox payload when available.
    try {
      const inboxCandidates = withVehiclePathFallbacks(preset.sceneInboxUrl || '').map((u) => normalizeAssetUrl(u)).filter(Boolean);
      for (const inboxUrl of inboxCandidates) {
        try {
          const resp = await fetch(inboxUrl, { cache: 'no-store' });
          if (!resp.ok) continue;
          const j = await resp.json();
          if (j && typeof j === 'object') {
            const vc = (j?.vehicleConfig && typeof j.vehicleConfig === 'object') ? j.vehicleConfig : null;
            if (vc) {
              vehicleConfig = vc;
              break;
            }
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    // Fallback: build a compatible config from meta.json.
    if (!vehicleConfig) {
      let meta = null;
      const rawMeta = safeTrim(preset.metaUrl || '') || metaUrlForModelUrl(modelUrl);
      const metaCandidates = withVehiclePathFallbacks(rawMeta).map((u) => normalizeAssetUrl(u)).filter(Boolean);
      let metaUrl = metaCandidates[0] || '';
      for (const u of metaCandidates) {
        try {
          const resp = await fetch(u, { cache: 'no-store' });
          if (!resp.ok) continue;
          meta = await resp.json();
          metaUrl = u;
          break;
        } catch { /* ignore */ }
      }
      vehicleConfig = {
        schema: 1,
        source: 'scene_tool.vehicle_presets',
        modelUrl,
        metaUrl: metaUrl || '',
        meta: (meta && typeof meta === 'object') ? {
          wheelType: String(meta?.wheelType || ''),
          wheelScale: Number(meta?.wheelScale),
          wheelScaleRear: Number(meta?.wheelScaleRear),
          anchors: (meta?.anchors && typeof meta.anchors === 'object') ? meta.anchors : null,
        } : null,
        wheelOverlay: {
          enabled: true,
          useMetaScale: true,
          frontScaleMul: 1.0,
          rearScaleMul: 1.0,
          placeholderWidth: 0.20,
        },
        animationClipNames: [],
      };
    }

    // Normalize essential config fields.
    vehicleConfig = {
      ...(vehicleConfig && typeof vehicleConfig === 'object' ? vehicleConfig : {}),
      schema: 1,
      source: safeTrim(vehicleConfig?.source) || 'scene_tool.vehicle_presets',
      modelUrl: safeTrim(vehicleConfig?.modelUrl) || modelUrl,
      metaUrl: safeTrim(vehicleConfig?.metaUrl) || metaUrlForModelUrl(modelUrl),
    };

    return {
      preset,
      modelUrl,
      vehicleConfig,
    };
  }

  SceneTool.prototype._acBundleToParamsUrl = function(bundleUrl) {
    const u = safeTrim(bundleUrl);
    if (!u) return '';
    // Bundle layout from tools/assetto_corsa_export.py:
    // <out>/<car>/<run>/normalized/car.bundle.json
    // <out>/<car>/<run>/ac_raw/params.raw.json
    // Prefer stable string replacement so we don't depend on absolute filesystem paths inside the JSON.
    if (u.endsWith('/normalized/car.bundle.json')) return u.replace(/\/normalized\/car\.bundle\.json$/i, '/ac_raw/params.raw.json');
    // Fallback: if user passes the run directory, accept that too.
    if (!u.endsWith('.json') && !u.endsWith('/')) return `${u}/ac_raw/params.raw.json`;
    if (u.endsWith('/')) return `${u}ac_raw/params.raw.json`;
    return '';
  }

  SceneTool.prototype._getAcPhysicsTuningFromBundleUrl = async function(bundleUrl) {
    const u = normalizeAssetUrl(bundleUrl);
    if (!u) return null;
    const now = Date.now();
    const cached = this._acPhysicsCache?.get?.(u) || null;
    if (cached && (now - (Number(cached.atMs) || 0)) < 30_000) return cached;

    const paramsUrl = normalizeAssetUrl(this._acBundleToParamsUrl(u));
    if (!paramsUrl) return null;

    // Fetch params.raw.json (lossless INI parse)
    const resp = await fetch(paramsUrl, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`AC params fetch failed: HTTP ${resp.status}`);
    const j = await resp.json();
    const entries = Array.isArray(j?.entries) ? j.entries : [];

    const norm = (s) => String(s || '').trim().toLowerCase();
    const get = (fileEndsWith, sectionName, keyName) => {
      const fe = norm(fileEndsWith);
      const sec = norm(sectionName);
      const key = norm(keyName);
      for (const e of entries) {
        const f = norm(e?.file || '');
        if (!f) continue;
        if (fe && !(f.endsWith(fe) || f.endsWith('/' + fe))) continue;
        const s0 = norm(e?.section || '');
        const k0 = norm(e?.key || '');
        if (sec && s0 !== sec) continue;
        if (key && k0 !== key) continue;
        return String(e?.value ?? '').trim();
      }
      return '';
    };
    const getAnySection = (fileEndsWith, keyName) => {
      const fe = norm(fileEndsWith);
      const key = norm(keyName);
      for (const e of entries) {
        const f = norm(e?.file || '');
        if (!f) continue;
        if (fe && !(f.endsWith(fe) || f.endsWith('/' + fe))) continue;
        const k0 = norm(e?.key || '');
        if (key && k0 !== key) continue;
        return String(e?.value ?? '').trim();
      }
      return '';
    };
    const fnum = (s) => {
      const v = Number(String(s || '').trim().split(/[,\s]+/)[0]);
      return Number.isFinite(v) ? v : NaN;
    };
    const clampN = (x, a, b) => {
      const v = Number(x);
      if (!Number.isFinite(v)) return a;
      return Math.max(a, Math.min(b, v));
    };

    // --- Derivations (best-effort; fall back to existing defaults) ---
    const dbg = {};
    const simSpeedScale = 0.35; // pragmatic mapping from "AC-ish" speeds to our small JS sim speed range

    // Mass (kg)
    const massRaw =
      get('car.ini', 'basic', 'totalmass') ||
      getAnySection('car.ini', 'totalmass') ||
      get('car.ini', 'basic', 'mass') ||
      getAnySection('car.ini', 'mass') ||
      '';
    const massKg = fnum(massRaw);
    if (Number.isFinite(massKg) && massKg > 200) dbg.massKg = massKg;

    // Wheelbase + CG distribution
    const wbRaw =
      get('suspensions.ini', 'basic', 'wheelbase') ||
      getAnySection('suspensions.ini', 'wheelbase') ||
      '';
    const wheelbase = fnum(wbRaw);
    if (Number.isFinite(wheelbase) && wheelbase > 0.6) dbg.wheelbase = wheelbase;
    const cgLocRaw =
      get('suspensions.ini', 'basic', 'cg_location') ||
      getAnySection('suspensions.ini', 'cg_location') ||
      '';
    const frontWeightFrac = fnum(cgLocRaw);
    if (Number.isFinite(frontWeightFrac)) dbg.frontWeightFrac = frontWeightFrac;
    const cgToFront = (Number.isFinite(wheelbase) && Number.isFinite(frontWeightFrac))
      ? clampN(wheelbase * (1.0 - clampN(frontWeightFrac, 0.25, 0.85)), 0.20, wheelbase - 0.20)
      : NaN;

    // Steering: AC uses STEER_LOCK (deg steering wheel) and STEER_RATIO.
    // Approximate road wheel max steer: lock/ratio (deg) -> rad.
    const steerLockDeg = fnum(getAnySection('car.ini', 'steer_lock') || '');
    const steerRatio = fnum(getAnySection('car.ini', 'steer_ratio') || '');
    if (Number.isFinite(steerLockDeg)) dbg.steerLockDeg = steerLockDeg;
    if (Number.isFinite(steerRatio)) dbg.steerRatio = steerRatio;
    const maxSteerDeg = (Number.isFinite(steerLockDeg) && Number.isFinite(steerRatio) && steerRatio > 0.1)
      ? (steerLockDeg / steerRatio)
      : NaN;
    if (Number.isFinite(maxSteerDeg)) dbg.maxSteerDeg = maxSteerDeg;
    const maxSteerRad = Number.isFinite(maxSteerDeg)
      ? degToRad(clampN(maxSteerDeg, 10, 55))
      : NaN;

    // Tires: radius/width + friction-like coefficient
    const rFront = fnum(get('tyres.ini', 'front', 'radius') || get('tires.ini', 'front', 'radius') || '');
    const wFront = fnum(get('tyres.ini', 'front', 'width') || get('tires.ini', 'front', 'width') || '');
    const rRear = fnum(get('tyres.ini', 'rear', 'radius') || get('tires.ini', 'rear', 'radius') || '');
    const wRear = fnum(get('tyres.ini', 'rear', 'width') || get('tires.ini', 'rear', 'width') || '');
    const dy0 = fnum(get('tyres.ini', 'front', 'dy0') || get('tires.ini', 'front', 'dy0') || '');
    const dx0 = fnum(get('tyres.ini', 'front', 'dx0') || get('tires.ini', 'front', 'dx0') || '');
    const muLike = Math.max(Number.isFinite(dy0) ? dy0 : 0, Number.isFinite(dx0) ? dx0 : 0);
    if (Number.isFinite(rFront)) dbg.tireRadiusM = rFront;
    if (Number.isFinite(wFront)) dbg.tireWidthM = wFront;
    if (Number.isFinite(rRear)) dbg.tireRadiusRearM = rRear;
    if (Number.isFinite(wRear)) dbg.tireWidthRearM = wRear;
    if (Number.isFinite(muLike)) dbg.muLike = muLike;
    const mu = Number.isFinite(muLike) ? clampN(muLike, 0.6, 2.0) : NaN;

    // Rolling resistance: map AC constant component to our linear-ish model.
    const rr0 = fnum(get('tyres.ini', 'front', 'rolling_resistance_0') || get('tires.ini', 'front', 'rolling_resistance_0') || '');
    const rollingResist = Number.isFinite(rr0) ? clampN(rr0 * 2.0, 4.0, 80.0) : NaN;
    if (Number.isFinite(rr0)) dbg.rollingResistance0 = rr0;

    // Cornering stiffness: estimate from mu * normal load and a guessed peak slip angle.
    const fz0Front = fnum(get('tyres.ini', 'front', 'fz0') || get('tires.ini', 'front', 'fz0') || '');
    const fz0Rear = fnum(get('tyres.ini', 'rear', 'fz0') || get('tires.ini', 'rear', 'fz0') || '');
    if (Number.isFinite(fz0Front)) dbg.fz0Front = fz0Front;
    if (Number.isFinite(fz0Rear)) dbg.fz0Rear = fz0Rear;
    const alphaPeak = (() => {
      if (!Number.isFinite(mu)) return 0.08;
      const t = clampN((mu - 0.85) / 0.85, 0, 1);
      return clampN(lerp(0.11, 0.06, t), 0.05, 0.12);
    })();
    const cornerStiffFront = (Number.isFinite(mu) && Number.isFinite(fz0Front) && fz0Front > 10)
      ? clampN((2.0 * mu * fz0Front) / Math.max(1e-4, alphaPeak), 20_000, 260_000)
      : NaN;
    const cornerStiffRear = (Number.isFinite(mu) && Number.isFinite(fz0Rear) && fz0Rear > 10)
      ? clampN((2.0 * mu * fz0Rear) / Math.max(1e-4, alphaPeak), 20_000, 260_000)
      : NaN;

    // Aero drag: AC doesn't always provide simple (Cd, frontal area) values in aero.ini.
    // Keep this best-effort; if missing, we just leave SceneTool's defaults.
    const cd = fnum(get('aero.ini', 'data', 'cd') || getAnySection('aero.ini', 'cd') || '');
    const fa = fnum(get('aero.ini', 'data', 'fa') || get('aero.ini', 'data', 'frontal_area') || getAnySection('aero.ini', 'fa') || '');
    if (Number.isFinite(cd) && cd > 0) dbg.cd = cd;
    if (Number.isFinite(fa) && fa > 0) dbg.frontalArea = fa;
    const rho = 1.225;
    const aeroDrag = (Number.isFinite(cd) && Number.isFinite(fa) && cd > 0 && fa > 0)
      ? (0.5 * rho * cd * fa)
      : NaN;

    // Engine force: derive from max power in power.lut (kW) using a reference speed.
    const maxPowerKw = (() => {
      const txt = getAnySection('power.lut', '') || ''; // not an ini, so this will be empty
      return NaN;
    })();
    // Read power.lut content from entries if present (keys show up as ini entries only for .ini files).
    // power.lut is still present in the bundle; easiest is to fetch it directly.
    let engineForceMax = NaN;
    let maxPowerW = NaN;
    let maxTorqueNm = NaN;
    try {
      const powerUrl = normalizeAssetUrl(u.replace(/\/normalized\/car\.bundle\.json$/i, '/ac_raw/data/power.lut'));
      if (powerUrl) {
        const pr = await fetch(powerUrl, { cache: 'no-store' });
        if (pr.ok) {
          const t = await pr.text();
          let mx = 0;
          let mxT = 0;
          for (const line of String(t || '').split(/\r?\n/)) {
            const s = line.trim();
            if (!s || s.startsWith(';') || !s.includes('|')) continue;
            const parts = s.split('|');
            const rpm = Number(parts[0]);
            const pKw = Number(parts[1]);
            if (Number.isFinite(pKw)) mx = Math.max(mx, pKw);
            if (Number.isFinite(rpm) && rpm > 100 && Number.isFinite(pKw) && pKw > 0) {
              const omega = (rpm * (2 * Math.PI)) / 60;
              const tq = (pKw * 1000) / Math.max(1e-6, omega);
              if (Number.isFinite(tq)) mxT = Math.max(mxT, tq);
            }
          }
          if (mx > 1) {
            dbg.maxPowerKw = mx;
            maxPowerW = mx * 1000;
            if (mxT > 1) {
              dbg.maxTorqueNm = mxT;
              maxTorqueNm = mxT;
            }
            const vRef = 11.0; // m/s (~40 km/h) for a reasonable "launch" force
            engineForceMax = clampN((mx * 1000) / vRef, 1500, 35_000);
          }
        }
      }
    } catch { /* ignore */ }

    // Drivetrain: drive type, gear ratios, and a "top speed" hint (used only as a soft cap in JS sim).
    const tractionTypeRaw = get('drivetrain.ini', 'traction', 'type') || getAnySection('drivetrain.ini', 'type') || '';
    const tractionType = String(tractionTypeRaw || '').trim().split(/[\s;,#]+/)[0].toUpperCase();
    const driveBias = (() => {
      if (!tractionType) return NaN;
      if (tractionType === 'FWD') return 1.0;
      if (tractionType === 'RWD') return 0.0;
      if (tractionType === 'AWD' || tractionType === '4WD') return 0.5;
      return NaN;
    })();
    if (tractionType) dbg.tractionType = tractionType;

    const finalRatio = fnum(get('drivetrain.ini', 'gears', 'final') || getAnySection('drivetrain.ini', 'final') || '');
    const gearRatios = [];
    for (let i = 1; i <= 12; i++) {
      const gr = fnum(get('drivetrain.ini', 'gears', `gear_${i}`) || '');
      if (Number.isFinite(gr) && gr > 0) gearRatios.push(gr);
    }
    const firstGear = gearRatios.length ? gearRatios[0] : fnum(get('drivetrain.ini', 'gears', 'gear_1') || '');
    const topGear = gearRatios.length ? Math.min(...gearRatios) : NaN;
    if (Number.isFinite(finalRatio)) dbg.finalRatio = finalRatio;
    if (Number.isFinite(firstGear)) dbg.firstGear = firstGear;
    if (Number.isFinite(topGear)) dbg.topGear = topGear;

    const limiterRpmRaw =
      get('engine.ini', 'engine_data', 'limiter') ||
      getAnySection('engine.ini', 'limiter') ||
      get('engine.ini', 'coast_ref', 'rpm') ||
      getAnySection('engine.ini', 'rpm') ||
      '';
    const limiterRpm = fnum(limiterRpmRaw);
    if (Number.isFinite(limiterRpm) && limiterRpm > 100) dbg.limiterRpm = limiterRpm;

    const vTopReal = (Number.isFinite(limiterRpm) && limiterRpm > 100 && Number.isFinite(topGear) && topGear > 0.01 && Number.isFinite(finalRatio) && finalRatio > 0.01 && Number.isFinite(rFront) && rFront > 0.05)
      ? (((limiterRpm * (2 * Math.PI)) / 60) / (topGear * finalRatio)) * rFront
      : NaN;
    if (Number.isFinite(vTopReal)) dbg.topSpeedMS = vTopReal;
    const speedMax = Number.isFinite(vTopReal) ? clampN(vTopReal * simSpeedScale, 10.0, 45.0) : NaN;

    // Prefer a torque×gear-based wheel force estimate when possible.
    if (Number.isFinite(maxTorqueNm) && Number.isFinite(firstGear) && firstGear > 0.01 && Number.isFinite(finalRatio) && finalRatio > 0.01 && Number.isFinite(rFront) && rFront > 0.05) {
      const ratio = firstGear * finalRatio;
      const eff = 0.86;
      const fx = (maxTorqueNm * ratio * eff) / rFront;
      dbg.engineForceFromTorque = fx;
      if (Number.isFinite(fx) && fx > 100) {
        // Blend a bit with the power-based estimate if we have both, to reduce sensitivity to mods with odd LUT units.
        const blended = Number.isFinite(engineForceMax) ? lerp(engineForceMax, fx, 0.65) : fx;
        engineForceMax = clampN(blended, 1500, 45_000);
      }
    }

    // If we have a power estimate and a speed cap, derive a drag coefficient that makes reaching speedMax plausible.
    const aeroDragFromPower = (Number.isFinite(maxPowerW) && Number.isFinite(speedMax) && speedMax > 1.0)
      ? clampN((2.5 * maxPowerW) / (speedMax * speedMax * speedMax), 5.0, 120.0)
      : NaN;
    if (Number.isFinite(aeroDragFromPower)) dbg.aeroDragFromPower = aeroDragFromPower;

    // Engine braking torque (Nm) -> approximate braking force (very rough; gearing ignored).
    const coastTq = fnum(get('engine.ini', 'coast_ref', 'torque') || getAnySection('engine.ini', 'torque') || '');
    if (Number.isFinite(coastTq)) dbg.coastTorqueNm = coastTq;
    const engineBrakeForce = (Number.isFinite(coastTq) && Number.isFinite(rFront) && rFront > 0.05)
      ? clampN((coastTq / rFront) * 10.0, 100, 8000)
      : NaN;

    // Brakes: different cars expose either:
    // - MAX_TORQUE + FRONT_SHARE (common)
    // - MAX_TORQUE_FRONT/REAR (less common)
    const bMax = fnum(get('brakes.ini', 'data', 'max_torque') || getAnySection('brakes.ini', 'max_torque') || '');
    const bShare = fnum(get('brakes.ini', 'data', 'front_share') || getAnySection('brakes.ini', 'front_share') || '');
    const bFrontTq = fnum(get('brakes.ini', 'data', 'max_torque_front') || getAnySection('brakes.ini', 'max_torque_front') || '');
    const bRearTq = fnum(get('brakes.ini', 'data', 'max_torque_rear') || getAnySection('brakes.ini', 'max_torque_rear') || '');
    let bTq = NaN;
    if (Number.isFinite(bFrontTq) && Number.isFinite(bRearTq) && bFrontTq > 0 && bRearTq > 0) {
      // Treat as per-wheel torques; total wheel torque sum ≈ 2*(front+rear)
      bTq = 2 * (bFrontTq + bRearTq);
    } else if (Number.isFinite(bMax) && bMax > 0) {
      // Treat MAX_TORQUE as axle torque; approximate total wheel torque ≈ 2*MAX_TORQUE.
      bTq = 2 * bMax;
      if (Number.isFinite(bShare)) dbg.brakeFrontShare = bShare;
    }
    const brakeForceMax = (Number.isFinite(bTq) && Number.isFinite(rFront) && rFront > 0.05)
      ? (bTq / rFront)
      : NaN;
    if (Number.isFinite(bMax)) dbg.brakeMaxTorqueNm = bMax;
    if (Number.isFinite(brakeForceMax)) dbg.brakeForceMax = brakeForceMax;

    /** @type {any} */
    const simTuning = {};
    if (Number.isFinite(massKg)) simTuning.mass = clampN(massKg, 200, 4000);
    if (Number.isFinite(wheelbase)) simTuning.wheelbase = clampN(wheelbase, 0.6, 6.0);
    if (Number.isFinite(cgToFront)) simTuning.cgToFront = cgToFront;
    if (Number.isFinite(massKg) && Number.isFinite(wheelbase)) {
      // Approximate yaw inertia from mass + wheelbase (keeps cars from feeling too twitchy).
      simTuning.iz = clampN(0.25 * massKg * wheelbase * wheelbase, 300, 25_000);
    }
    if (Number.isFinite(maxSteerRad)) simTuning.maxSteerRad = clampN(maxSteerRad, 0.15, 0.95);
    if (Number.isFinite(mu)) simTuning.mu = mu;
    if (Number.isFinite(rollingResist)) simTuning.rollingResist = rollingResist;
    if (Number.isFinite(cornerStiffFront)) simTuning.cornerStiffFront = cornerStiffFront;
    if (Number.isFinite(cornerStiffRear)) simTuning.cornerStiffRear = cornerStiffRear;
    if (Number.isFinite(speedMax)) simTuning.speedMax = speedMax;
    if (Number.isFinite(driveBias)) simTuning.driveBias = clampN(driveBias, 0, 1);
    if (Number.isFinite(bShare)) simTuning.brakeBiasFront = clampN(bShare, 0, 1);
    if (Number.isFinite(aeroDragFromPower)) simTuning.aeroDrag = aeroDragFromPower;
    else if (Number.isFinite(aeroDrag)) simTuning.aeroDrag = clampN(aeroDrag, 5.0, 120.0);
    if (Number.isFinite(engineForceMax)) simTuning.engineForceMax = engineForceMax;
    if (Number.isFinite(engineBrakeForce)) simTuning.engineBrakeForce = engineBrakeForce;
    if (Number.isFinite(brakeForceMax)) simTuning.brakeForceMax = clampN(brakeForceMax, 2000, 40_000);

    const out = {
      atMs: now,
      simTuning,
      wheelRadius: Number.isFinite(rFront) ? clampN(rFront, 0.18, 0.65) : 0,
      wheelWidth: Number.isFinite(wFront) ? clampN(wFront, 0.08, 0.45) : 0,
      wheelRadiusRear: Number.isFinite(rRear) ? clampN(rRear, 0.18, 0.65) : 0,
      wheelWidthRear: Number.isFinite(wRear) ? clampN(wRear, 0.08, 0.45) : 0,
      debug: dbg,
    };
    try { this._acPhysicsCache?.set?.(u, out); } catch { /* ignore */ }
    return out;
  }

  SceneTool.prototype._getPropTemplate = async function(url) {
    const u = normalizeAssetUrl(url);
    if (!u) return null;
    const cached = this._propCache.get(u);
    if (cached?.templateRoot) return cached;
    const gltf = await this._propLoader.loadAsync(u);
    const root = gltf?.scene || null;
    if (!root) throw new Error('GLTF missing scene');
    // Best-effort stability: allow frustum culling.
    try { root.traverse?.((n) => { try { n.frustumCulled = true; } catch { /* ignore */ } }); } catch { /* ignore */ }
    const rec = { templateRoot: root, clips: Array.isArray(gltf?.animations) ? gltf.animations : [] };
    this._propCache.set(u, rec);
    return rec;
  }

  SceneTool.prototype._acDdsBlockBytes = function(info) {
    const fourCC = String(info?.fourCC || '');
    const dxgi = info?.dxgiFormat;
    if (fourCC === 'DXT1' || fourCC === 'ATI1') return 8;
    if (fourCC === 'DXT3' || fourCC === 'DXT5' || fourCC === 'ATI2') return 16;
    if (dxgi === 71 || dxgi === 80) return 8;
    if (dxgi === 74 || dxgi === 77 || dxgi === 83 || dxgi === 95 || dxgi === 96 || dxgi === 98 || dxgi === 99) return 16;
    return 0;
  }

  SceneTool.prototype._acDdsThreeFormat = function(info) {
    const fourCC = String(info?.fourCC || '');
    const dxgi = info?.dxgiFormat;
    if (fourCC === 'DXT1') return THREE.RGBA_S3TC_DXT1_Format;
    if (fourCC === 'DXT3') return THREE.RGBA_S3TC_DXT3_Format;
    if (fourCC === 'DXT5') return THREE.RGBA_S3TC_DXT5_Format;
    if (fourCC === 'ATI1') return THREE.RED_RGTC1_Format;
    if (fourCC === 'ATI2') return THREE.RED_GREEN_RGTC2_Format;
    if (dxgi === 71) return THREE.RGBA_S3TC_DXT1_Format;
    if (dxgi === 74) return THREE.RGBA_S3TC_DXT3_Format;
    if (dxgi === 77) return THREE.RGBA_S3TC_DXT5_Format;
    if (dxgi === 80) return THREE.RED_RGTC1_Format;
    if (dxgi === 83) return THREE.RED_GREEN_RGTC2_Format;
    if (dxgi === 95) return THREE.RGB_BPTC_UNSIGNED_Format;
    if (dxgi === 96) return THREE.RGB_BPTC_SIGNED_Format;
    if (dxgi === 98 || dxgi === 99) return THREE.RGBA_BPTC_Format;
    return null;
  }

  SceneTool.prototype._loadAcTexture = async function(url, { kind = 'diffuse' } = {}) {
    const u = normalizeAssetUrl(url);
    if (!u) return null;
    const cached = this._acTextureCache?.get?.(u) || null;
    if (cached) return cached;

    const ext = String(u).toLowerCase().split('?')[0].split('#')[0];
    const isDds = ext.endsWith('.dds');
    const wantSrgb = (String(kind || 'diffuse').toLowerCase() === 'diffuse');

    try {
      if (!isDds) {
        const loader = new THREE.TextureLoader();
        const tex = await loader.loadAsync(u);
        // These textures are applied onto GLTF materials post-load.
        // GLTF expects flipY=false for external texture assignments.
        try { tex.flipY = false; } catch { /* ignore */ }
        try { tex.colorSpace = wantSrgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; } catch { /* ignore */ }
        try { tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping; } catch { /* ignore */ }
        try { tex.anisotropy = 4; } catch { /* ignore */ }
        try { tex.needsUpdate = true; } catch { /* ignore */ }
        this._acTextureCache.set(u, tex);
        return tex;
      }

      const resp = await fetch(u, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const ab = await resp.arrayBuffer();
      const info = parseDds(ab);
      const blockBytes = this._acDdsBlockBytes(info);
      const fmt = this._acDdsThreeFormat(info);
      if (!blockBytes || !fmt) throw new Error(`Unsupported DDS format (fourCC=${info?.fourCC} dxgi=${info?.dxgiFormat})`);

      // Prefer CPU decode for BC1/2/3 (DXT1/3/5) to avoid WebGL2/ANGLE compressed texStorage quirks
      // and to keep texture orientation predictable when assigned to GLTF materials.
      const fourCC = String(info?.fourCC || '');
      const canCpuDecode = (fourCC === 'DXT1' || fourCC === 'DXT3' || fourCC === 'DXT5');
      if (canCpuDecode) {
        const w0 = Math.max(1, Number(info.width) || 1);
        const h0 = Math.max(1, Number(info.height) || 1);
        const offset0 = Math.max(0, Number(info.dataOffset) || 0);
        const bw0 = Math.max(1, Math.ceil(w0 / 4));
        const bh0 = Math.max(1, Math.ceil(h0 / 4));
        const size0 = bw0 * bh0 * blockBytes;
        if (offset0 + size0 > ab.byteLength) throw new Error('DDS: level0 out of range');

        const src = new Uint8Array(ab, offset0, size0);
        const out = new Uint8Array(w0 * h0 * 4);

        const dec565 = (c) => {
          const r = ((c >> 11) & 31) * (255 / 31);
          const g = ((c >> 5) & 63) * (255 / 63);
          const b = (c & 31) * (255 / 31);
          return [r | 0, g | 0, b | 0];
        };
        const lerp8 = (a, b, tNum, tDen) => ((a * (tDen - tNum) + b * tNum) / tDen) | 0;
        const readU16 = (i) => (src[i] | (src[i + 1] << 8)) >>> 0;
        const readU32 = (i) => (src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24)) >>> 0;

        const decodeColorBlock = (base) => {
          const c0 = readU16(base + 0);
          const c1 = readU16(base + 2);
          const [r0, g0, b0] = dec565(c0);
          const [r1, g1, b1] = dec565(c1);
          // DXT1 transparency rules apply only for DXT1.
          const useDxt1Mode = (fourCC === 'DXT1') && (c0 <= c1);
          /** @type {Array<[number,number,number,number]>} */
          const cols = [
            [r0, g0, b0, 255],
            [r1, g1, b1, 255],
            [0, 0, 0, 255],
            [0, 0, 0, 255],
          ];
          if (useDxt1Mode) {
            cols[2] = [lerp8(r0, r1, 1, 2), lerp8(g0, g1, 1, 2), lerp8(b0, b1, 1, 2), 255];
            cols[3] = [0, 0, 0, 0];
          } else {
            cols[2] = [lerp8(r0, r1, 1, 3), lerp8(g0, g1, 1, 3), lerp8(b0, b1, 1, 3), 255];
            cols[3] = [lerp8(r0, r1, 2, 3), lerp8(g0, g1, 2, 3), lerp8(b0, b1, 2, 3), 255];
          }
          const idx = readU32(base + 4);
          return { cols, idx };
        };

        const blocksX = bw0;
        const blocksY = bh0;
        const blockStride = (fourCC === 'DXT1') ? 8 : 16;
        for (let by = 0; by < blocksY; by++) {
          for (let bx = 0; bx < blocksX; bx++) {
            const blockBase = (by * blocksX + bx) * blockStride;
            let colorBase = blockBase;
            /** @type {number[] | null} */
            let a4 = null;
            /** @type {{a0:number,a1:number,mask:bigint} | null} */
            let a5 = null;

            if (fourCC === 'DXT3') {
              // 4-bit alpha per pixel, stored as 8 bytes (little-endian rows).
              a4 = [];
              for (let i = 0; i < 8; i++) a4.push(src[blockBase + i] >>> 0);
              colorBase = blockBase + 8;
            } else if (fourCC === 'DXT5') {
              const a0 = src[blockBase + 0] >>> 0;
              const a1 = src[blockBase + 1] >>> 0;
              // 48-bit alpha index mask, little-endian.
              let mask = 0n;
              for (let i = 0; i < 6; i++) mask |= BigInt(src[blockBase + 2 + i] >>> 0) << BigInt(8 * i);
              a5 = { a0, a1, mask };
              colorBase = blockBase + 8;
            }

            const { cols, idx } = decodeColorBlock(colorBase);
            const aLut5 = (() => {
              if (!a5) return null;
              const a0 = a5.a0;
              const a1 = a5.a1;
              const arr = new Array(8).fill(0);
              arr[0] = a0;
              arr[1] = a1;
              if (a0 > a1) {
                arr[2] = ((6 * a0 + 1 * a1) / 7) | 0;
                arr[3] = ((5 * a0 + 2 * a1) / 7) | 0;
                arr[4] = ((4 * a0 + 3 * a1) / 7) | 0;
                arr[5] = ((3 * a0 + 4 * a1) / 7) | 0;
                arr[6] = ((2 * a0 + 5 * a1) / 7) | 0;
                arr[7] = ((1 * a0 + 6 * a1) / 7) | 0;
              } else {
                arr[2] = ((4 * a0 + 1 * a1) / 5) | 0;
                arr[3] = ((3 * a0 + 2 * a1) / 5) | 0;
                arr[4] = ((2 * a0 + 3 * a1) / 5) | 0;
                arr[5] = ((1 * a0 + 4 * a1) / 5) | 0;
                arr[6] = 0;
                arr[7] = 255;
              }
              return arr;
            })();
            for (let py = 0; py < 4; py++) {
              for (let px = 0; px < 4; px++) {
                const x = bx * 4 + px;
                const y = by * 4 + py;
                if (x >= w0 || y >= h0) continue;

                const pi = py * 4 + px;
                const ci = (idx >> (2 * pi)) & 3;
                const c = cols[ci];
                let a = c[3] | 0;

                if (a4) {
                  const byte = a4[(pi >> 1)] | 0;
                  const nib = (pi & 1) ? (byte >> 4) : (byte & 0x0F);
                  a = (nib * 17) | 0; // 0..15 -> 0..255
                } else if (a5 && aLut5) {
                  const code = Number((a5.mask >> BigInt(3 * pi)) & 0x7n) | 0;
                  a = aLut5[code] | 0;
                }

                const di = (y * w0 + x) * 4;
                out[di + 0] = c[0] | 0;
                out[di + 1] = c[1] | 0;
                out[di + 2] = c[2] | 0;
                out[di + 3] = a | 0;
              }
            }
          }
        }

        const tex = new THREE.DataTexture(out, w0, h0, THREE.RGBAFormat, THREE.UnsignedByteType);
        // GLTF-compatible orientation.
        try { tex.flipY = false; } catch { /* ignore */ }
        try { tex.colorSpace = wantSrgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; } catch { /* ignore */ }
        tex.needsUpdate = true;
        try { tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping; } catch { /* ignore */ }
        try { tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = true; } catch { /* ignore */ }
        try { tex.anisotropy = 4; } catch { /* ignore */ }
        this._acTextureCache.set(u, tex);
        return tex;
      }

      // Build mipmaps list.
      const mipmaps = [];
      let offset = Number(info.dataOffset) || 0;
      let w = Number(info.width) || 1;
      let h = Number(info.height) || 1;
      const mipCount = Math.max(1, Number(info.mipMapCount) || 1);
      for (let i = 0; i < mipCount; i++) {
        const bw = Math.max(1, Math.ceil(w / 4));
        const bh = Math.max(1, Math.ceil(h / 4));
        const size = bw * bh * blockBytes;
        if (offset + size > ab.byteLength) break;
        mipmaps.push({ data: new Uint8Array(ab, offset, size), width: w, height: h });
        offset += size;
        w = Math.max(1, w >> 1);
        h = Math.max(1, h >> 1);
      }

      const tex = new THREE.CompressedTexture(mipmaps, Number(info.width) || 1, Number(info.height) || 1, fmt);
      try { tex.flipY = false; } catch { /* ignore */ }
      try { tex.colorSpace = wantSrgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; } catch { /* ignore */ }
      tex.needsUpdate = true;
      try { tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping; } catch { /* ignore */ }
      try {
        const useMips = mipmaps.length > 1;
        tex.minFilter = useMips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
      } catch { /* ignore */ }
      this._acTextureCache.set(u, tex);
      return tex;
    } catch {
      // Many exports ship both .dds and pre-converted .png. If DDS parsing/upload fails (unsupported
      // format / missing extensions), fall back to a same-stem PNG and cache under the DDS URL.
      if (isDds) {
        const u2 = String(u).replace(/\.dds(?=([?#]|$))/i, '.png');
        if (u2 && u2 !== u) {
          try {
            const cached2 = this._acTextureCache?.get?.(u2) || null;
            if (cached2) {
              try { this._acTextureCache.set(u, cached2); } catch { /* ignore */ }
              return cached2;
            }
            const loader = new THREE.TextureLoader();
            const tex = await loader.loadAsync(u2);
            try { tex.flipY = false; } catch { /* ignore */ }
            try { tex.colorSpace = wantSrgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; } catch { /* ignore */ }
            try { tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping; } catch { /* ignore */ }
            try { tex.anisotropy = 4; } catch { /* ignore */ }
            try { tex.needsUpdate = true; } catch { /* ignore */ }
            try { this._acTextureCache.set(u2, tex); } catch { /* ignore */ }
            try { this._acTextureCache.set(u, tex); } catch { /* ignore */ }
            return tex;
          } catch { /* ignore */ }
        }
      }
      return null;
    }
  }

  SceneTool.prototype._applyAcTexturesToRoot = async function(root, cfgMeta) {
    const texDir = safeTrim(cfgMeta?.acTextureDirUrl || '');
    const matsEmbedded = (cfgMeta?.acMaterials && typeof cfgMeta.acMaterials === 'object') ? cfgMeta.acMaterials : null;
    const matsUrl = safeTrim(cfgMeta?.acMaterialsUrl || '');
    const matsFromUrl = await (async () => {
      const u = normalizeAssetUrl(matsUrl);
      if (!u) return null;
      try {
        const resp = await fetch(u, { cache: 'no-store' });
        if (!resp.ok) return null;
        const j = await resp.json();
        const arr = (j && typeof j === 'object' && Array.isArray(j.materials)) ? j.materials : null;
        if (!arr) return null;
        /** @type {Record<string, any>} */
        const out = {};
        for (const it of arr) {
          if (!it || typeof it !== 'object') continue;
          const name = safeTrim(it.name || '');
          if (!name) continue;
          const shaderName = safeTrim(it.shader || '');
          const samples = (it.samples && typeof it.samples === 'object') ? it.samples : {};
          const props = (it.props && typeof it.props === 'object') ? it.props : {};
          const dmul = Number(props.detailUVMultiplier);
          const ksSpec = Number(props.ksSpecular);
          const ksExp = Number(props.ksSpecularEXP);
          const ksAlphaRef = Number(props.ksAlphaRef);
          const ksEmissive = Number(props.ksEmissive);
          out[name] = {
            shader: shaderName,
            txDiffuse: safeTrim(samples.txDiffuse || ''),
            txNormal: safeTrim(samples.txNormal || ''),
            txMask: safeTrim(samples.txMask || ''),
            txDetail: safeTrim(samples.txDetail || ''),
            txMaps: safeTrim(samples.txMaps || ''),
            useDetail: (Number(props.useDetail) || 0) > 0,
            detailUVMultiplier: Number.isFinite(dmul) ? dmul : 0,
            ksSpecular: Number.isFinite(ksSpec) ? ksSpec : null,
            ksSpecularEXP: Number.isFinite(ksExp) ? ksExp : null,
            ksAlphaRef: Number.isFinite(ksAlphaRef) ? ksAlphaRef : null,
            ksEmissive: Number.isFinite(ksEmissive) ? ksEmissive : null,
          };
        }
        return out;
      } catch {
        return null;
      }
    })();

    const mats = (() => {
      // Prefer URL manifest (often rewritten to PNGs), then fill gaps from embedded meta.
      if (matsFromUrl && typeof matsFromUrl === 'object') {
        /** @type {any} */
        const out = { ...(matsEmbedded || {}) };
        for (const [k, v] of Object.entries(matsFromUrl || {})) {
          if (!k || !v || typeof v !== 'object') continue;
          out[k] = { ...(out[k] || {}), ...v };
        }
        return out;
      }
      return (matsEmbedded && typeof matsEmbedded === 'object') ? matsEmbedded : null;
    })();
    if (!root || !texDir || !mats) return;

    const stripDupSuffix = (s) => String(s || '').replace(/\.\d+$/g, '');
    const normKey = (s, { stripSuffix = false, spacesFromUnderscore = false } = {}) => {
      let out = safeTrim(s).toLowerCase();
      if (spacesFromUnderscore) out = out.replace(/_+/g, ' ');
      out = out.replace(/\s+/g, ' ').trim();
      if (stripSuffix) out = stripDupSuffix(out);
      return out;
    };
    /** @type {Map<string, any>} */
    const matsExactLo = new Map(); // lowercased original key -> rec
    /** @type {Map<string, { name: string, rec: any }[]>} */
    const matsIndex = new Map(); // normalized variants -> candidate recs
    try {
      for (const [k, v] of Object.entries(mats)) {
        if (!k || !v || typeof v !== 'object') continue;
        const kLo = safeTrim(k).toLowerCase();
        const kLoStrip = stripDupSuffix(kLo);
        if (kLo && !matsExactLo.has(kLo)) matsExactLo.set(kLo, v);
        if (kLoStrip && !matsExactLo.has(kLoStrip)) matsExactLo.set(kLoStrip, v);
        const keys = [
          normKey(k),
          normKey(k, { stripSuffix: true }),
          normKey(k, { spacesFromUnderscore: true }),
          normKey(k, { stripSuffix: true, spacesFromUnderscore: true }),
        ];
        for (const kk of keys) {
          if (!kk) continue;
          const arr = matsIndex.get(kk) || [];
          arr.push({ name: k, rec: v });
          matsIndex.set(kk, arr);
        }
      }
    } catch { /* ignore */ }

    const join = (dir, name) => {
      const d = String(dir || '').replace(/\/+$/, '');
      const n = String(name || '').replace(/^\/+/, '');
      return d && n ? `${d}/${n}` : '';
    };

    const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
    const phongExpToRoughness = (exp) => {
      const e = Math.max(0.0, Number(exp) || 0.0);
      return Math.max(0.02, Math.min(1.0, Math.sqrt(2.0 / (e + 2.0))));
    };

    const ensurePhysical = (mesh, mat) => {
      if (!mesh || !mat) return mat;
      const m0 = /** @type {any} */ (mat);
      if (m0?.isMeshPhysicalMaterial) return m0;
      if (!THREE.MeshPhysicalMaterial) return m0;
      try {
        /** @type {any} */
        const p = new THREE.MeshPhysicalMaterial();
        p.name = safeTrim(m0.name || '');
        try { p.color = m0.color?.clone?.() || p.color; } catch { /* ignore */ }
        try { p.emissive = m0.emissive?.clone?.() || p.emissive; } catch { /* ignore */ }
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap']) {
          try { if (m0[k]) p[k] = m0[k]; } catch { /* ignore */ }
        }
        for (const k of ['roughness', 'metalness', 'opacity', 'alphaTest', 'envMapIntensity']) {
          try { if (Number.isFinite(Number(m0[k]))) p[k] = Number(m0[k]); } catch { /* ignore */ }
        }
        for (const k of ['transparent', 'depthWrite', 'depthTest', 'side']) {
          try { if (m0[k] != null) p[k] = m0[k]; } catch { /* ignore */ }
        }
        try { if (m0.normalScale) p.normalScale = m0.normalScale.clone?.() || m0.normalScale; } catch { /* ignore */ }
        try { p.userData = { ...(m0.userData || {}) }; } catch { /* ignore */ }
        try {
          if (Array.isArray(mesh.material)) {
            const idx = mesh.material.indexOf(mat);
            if (idx >= 0) mesh.material[idx] = p;
          } else if (mesh.material === mat) {
            mesh.material = p;
          }
        } catch { /* ignore */ }
        return p;
      } catch {
        return m0;
      }
    };

    const applyAcShaderTuning = (mesh, mat, rec) => {
      if (!mesh || !mat || !rec || typeof rec !== 'object') return mat;
      /** @type {any} */
      let m = mat;
      const nmLo = safeTrim(m?.name || '').toLowerCase();
      const shLo = safeTrim(rec.shader || '').toLowerCase();

      const ksSpec = (rec.ksSpecular == null) ? NaN : Number(rec.ksSpecular);
      const ksExp = (rec.ksSpecularEXP == null) ? NaN : Number(rec.ksSpecularEXP);
      const ksEm = (rec.ksEmissive == null) ? NaN : Number(rec.ksEmissive);

      const roughFromExp = Number.isFinite(ksExp) ? phongExpToRoughness(ksExp) : NaN;
      const metalFromSpec = Number.isFinite(ksSpec) ? clamp01((ksSpec - 0.04) / 0.96) : NaN;

      const isTire = shLo.includes('kstyres') || nmLo.includes('tyre') || nmLo.includes('tire');
      const isBrake = shLo.includes('ksbrakedisc') || nmLo.includes('brake') || nmLo.includes('disk') || nmLo.includes('disc');
      const isChrome = nmLo.includes('chrome');
      const isPaint = shLo.includes('ksperpixelmultimap') || nmLo.includes('bodypaint') || nmLo.includes('_paint') || (nmLo === 'paint');
      const isGlass = shLo.includes('glass') || shLo.includes('alpha') || shLo.startsWith('ksperpixelat') || nmLo.includes('glass') || nmLo.includes('window') || nmLo.includes('windscreen') || nmLo.includes('windshield') || nmLo.includes('headlight') || nmLo.includes('mirror');
      const isReflection = shLo.includes('reflection');

      try { if (Number.isFinite(roughFromExp)) m.roughness = roughFromExp; } catch { /* ignore */ }
      try { if (Number.isFinite(metalFromSpec)) m.metalness = metalFromSpec; } catch { /* ignore */ }

      if (isTire) {
        try { m.metalness = 0.0; } catch { /* ignore */ }
        try { m.roughness = Math.max(0.78, Number(m.roughness) || 0.9); } catch { /* ignore */ }
        try { if (m.envMapIntensity != null) m.envMapIntensity = 0.25; } catch { /* ignore */ }
      } else if (isChrome) {
        try { m.metalness = Math.max(0.9, Number(m.metalness) || 1.0); } catch { /* ignore */ }
        try { m.roughness = Math.min(0.22, Number(m.roughness) || 0.12); } catch { /* ignore */ }
        try { if (m.envMapIntensity != null) m.envMapIntensity = 2.0; } catch { /* ignore */ }
      } else if (isPaint) {
        m = ensurePhysical(mesh, m);
        try { m.metalness = Math.max(0.10, Math.min(0.6, Number(m.metalness) || 0.2)); } catch { /* ignore */ }
        try { m.roughness = Math.min(0.35, Math.max(0.08, Number(m.roughness) || 0.22)); } catch { /* ignore */ }
        try { m.clearcoat = 0.9; } catch { /* ignore */ }
        try { m.clearcoatRoughness = Math.min(0.28, Math.max(0.04, (Number(m.roughness) || 0.2) * 0.7)); } catch { /* ignore */ }
        try { if (m.envMapIntensity != null) m.envMapIntensity = 1.6; } catch { /* ignore */ }
      } else if (isGlass) {
        m = ensurePhysical(mesh, m);
        try { m.metalness = 0.0; } catch { /* ignore */ }
        try { m.roughness = Math.min(0.12, Math.max(0.02, Number(m.roughness) || 0.06)); } catch { /* ignore */ }
        try { m.transparent = true; } catch { /* ignore */ }
        try { m.opacity = Math.min(0.65, Math.max(0.15, Number(m.opacity) || 0.35)); } catch { /* ignore */ }
        try { m.depthWrite = false; } catch { /* ignore */ }
        try { m.transmission = 0.88; } catch { /* ignore */ }
        try { m.thickness = 0.02; } catch { /* ignore */ }
        try { m.ior = 1.45; } catch { /* ignore */ }
        try { if (m.envMapIntensity != null) m.envMapIntensity = 1.2; } catch { /* ignore */ }
      } else if (isReflection) {
        try { m.roughness = Math.min(0.32, Math.max(0.06, Number(m.roughness) || 0.18)); } catch { /* ignore */ }
        try { if (m.envMapIntensity != null) m.envMapIntensity = 1.4; } catch { /* ignore */ }
      }

      if (isBrake) {
        try { m.metalness = Math.max(0.2, Math.min(0.8, Number(m.metalness) || 0.4)); } catch { /* ignore */ }
        try { m.roughness = Math.max(0.35, Math.min(0.9, Number(m.roughness) || 0.6)); } catch { /* ignore */ }
      }

      try {
        if (Number.isFinite(ksEm) && ksEm > 0) {
          if (!Number.isFinite(Number(m.emissiveIntensity))) m.emissiveIntensity = 1.0;
          m.emissiveIntensity = Math.max(Number(m.emissiveIntensity) || 1.0, Math.min(6.0, ksEm * 2.0));
        }
      } catch { /* ignore */ }

      try { m.needsUpdate = true; } catch { /* ignore */ }
      return m;
    };

    const pickRec = (raw) => {
      const r0 = safeTrim(raw);
      if (!r0) return null;
      const lo = r0.toLowerCase();
      const loStrip = stripDupSuffix(lo);
      const direct = matsExactLo.get(lo) || matsExactLo.get(loStrip) || null;
      if (direct && typeof direct === 'object') return direct;
      const ks = [
        normKey(r0),
        normKey(r0, { stripSuffix: true }),
        normKey(r0, { spacesFromUnderscore: true }),
        normKey(r0, { stripSuffix: true, spacesFromUnderscore: true }),
      ];
      let best = null;
      let bestScore = -Infinity;
      for (const kk of ks) {
        const arr = kk ? (matsIndex.get(kk) || null) : null;
        if (!arr || !arr.length) continue;
        for (const it of arr) {
          const nmLo = safeTrim(it?.name || '').toLowerCase();
          const nmLoStrip = stripDupSuffix(nmLo);
          let score = 0;
          if (nmLo === lo) score = 100;
          else if (nmLoStrip === loStrip) score = 90;
          else if (nmLo.includes(loStrip) || loStrip.includes(nmLoStrip)) score = 40;
          else score = 10;
          if (score > bestScore) { bestScore = score; best = it?.rec || null; }
        }
      }
      return best && typeof best === 'object' ? best : null;
    };

    const tasks = [];
    root.traverse?.((n) => {
      const mesh = /** @type {any} */ (n);
      if (!mesh?.isMesh) return;
      const matsArr = Array.isArray(mesh.material) ? mesh.material : (mesh.material ? [mesh.material] : []);
      for (const m0 of matsArr) {
        if (!m0) continue;
        /** @type {any} */
        let m = m0;
        const candidatesRaw = [
          safeTrim(m.name || ''),
          safeTrim(mesh.name || ''),
          safeTrim(mesh?.userData?.name || ''),
          safeTrim(mesh?.userData?.material || ''),
          safeTrim(stripDupSuffix(m.name || '')),
          safeTrim(stripDupSuffix(mesh.name || '')),
        ].filter(Boolean);
        let rec = null;
        for (const raw of candidatesRaw) {
          const hit = pickRec(raw);
          if (hit) { rec = hit; break; }
        }
        if (!rec || typeof rec !== 'object') continue;
        const txDiffuse = safeTrim(rec.txDiffuse || '');
        const txNormal = safeTrim(rec.txNormal || '');
        const txMaps = safeTrim(rec.txMaps || '');
        const txMask = safeTrim(rec.txMask || '');
        const txDetail = safeTrim(rec.txDetail || '');
        const shaderName = safeTrim(rec.shader || '');
        const ksSpecular = (rec.ksSpecular == null) ? NaN : Number(rec.ksSpecular);
        const ksSpecularEXP = (rec.ksSpecularEXP == null) ? NaN : Number(rec.ksSpecularEXP);
        const ksAlphaRef = (rec.ksAlphaRef == null) ? NaN : Number(rec.ksAlphaRef);
        const ksEmissive = (rec.ksEmissive == null) ? NaN : Number(rec.ksEmissive);

        try { m = applyAcShaderTuning(mesh, m, rec) || m; } catch { /* ignore */ }

        // Alpha test / transparency heuristics (helps glass + cutouts look correct).
        try {
          const nmLo = safeTrim(m?.name || '').toLowerCase();
          const shLo = shaderName.toLowerCase();
          if (Number.isFinite(ksAlphaRef) && ksAlphaRef > 0) {
            try { m.alphaTest = Math.max(0.0, Math.min(1.0, ksAlphaRef)); } catch { /* ignore */ }
          }
          const wantsTransparent = shLo.includes('alpha') || shLo.startsWith('ksperpixelat') || nmLo.includes('glass') || nmLo.includes('window') || nmLo.includes('headlight');
          if (wantsTransparent) {
            try { m.transparent = true; } catch { /* ignore */ }
            try { m.depthWrite = false; } catch { /* ignore */ }
            try {
              const o = Number(m.opacity);
              m.opacity = Number.isFinite(o) ? Math.min(0.75, Math.max(0.15, o)) : 0.35;
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
        if (txDiffuse) {
          tasks.push(this._loadAcTexture(join(texDir, txDiffuse), { kind: 'diffuse' }).then((t) => {
            if (t) {
              try { if (m.color && typeof m.color.set === 'function') m.color.set(0xffffff); } catch { /* ignore */ }
              m.map = t;
              m.needsUpdate = true;
            }
          }));
        }
        if (txNormal) {
          tasks.push(this._loadAcTexture(join(texDir, txNormal), { kind: 'normal' }).then((t) => {
            if (t) {
              m.normalMap = t;
              // Assetto normal maps are typically authored in DirectX convention (Y-).
              try {
                if (m.normalScale && typeof m.normalScale.set === 'function') m.normalScale.set(1, -1);
                else m.normalScale = new THREE.Vector2(1, -1);
              } catch { /* ignore */ }
              m.needsUpdate = true;
            }
          }));
        }
        if (txMaps) {
          tasks.push(this._loadAcTexture(join(texDir, txMaps), { kind: 'linear' }).then((t) => {
            if (!t) return;
            try { if (!m.roughnessMap) m.roughnessMap = t; } catch { /* ignore */ }
            try { if (!m.metalnessMap) m.metalnessMap = t; } catch { /* ignore */ }
            try { if (!Number.isFinite(Number(m.roughness))) m.roughness = 1.0; } catch { /* ignore */ }
            try { if (!Number.isFinite(Number(m.metalness))) m.metalness = 0.0; } catch { /* ignore */ }
            try { m.needsUpdate = true; } catch { /* ignore */ }
          }));
        }
        if (txMask) {
          tasks.push(this._loadAcTexture(join(texDir, txMask), { kind: 'linear' }).then((t) => {
            if (!t) return;
            try { if (!m.roughnessMap) m.roughnessMap = t; } catch { /* ignore */ }
            try { if (!m.metalnessMap) m.metalnessMap = t; } catch { /* ignore */ }
            try { if (!Number.isFinite(Number(m.roughness))) m.roughness = 1.0; } catch { /* ignore */ }
            try { if (!Number.isFinite(Number(m.metalness))) m.metalness = 0.0; } catch { /* ignore */ }
            try { m.needsUpdate = true; } catch { /* ignore */ }
          }));
        }
        if (txDetail) {
          tasks.push(this._loadAcTexture(join(texDir, txDetail), { kind: 'linear' }));
        }

        // Heuristic fallback when packed maps textures aren't usable (often BC7).
        try {
          const haveMapsTex = !!(m.roughnessMap || m.metalnessMap);
          if (!haveMapsTex && (Number.isFinite(ksSpecularEXP) || Number.isFinite(ksSpecular))) {
            const nmLo = safeTrim(m?.name || '').toLowerCase();
            const shLo = shaderName.toLowerCase();
            let rough = Number.isFinite(ksSpecularEXP) ? phongExpToRoughness(ksSpecularEXP) : (Number(m.roughness) || 0.9);
            let metal = Number.isFinite(ksSpecular) ? clamp01((ksSpecular - 0.04) / 0.96) : (Number(m.metalness) || 0.0);

            const isTire = shLo.includes('kstyres') || nmLo.includes('tyre') || nmLo.includes('tire');
            const isChrome = nmLo.includes('chrome');
            const isPaint = (nmLo === 'bodypaint') || nmLo.includes('bodypaint') || nmLo.includes('_paint') || nmLo.includes('paint');

            if (isTire) {
              metal = 0.0;
              rough = Math.max(0.75, rough);
            }
            if (isChrome) {
              metal = Math.max(0.9, metal);
              rough = Math.min(0.22, rough);
            } else if (isPaint) {
              metal = Math.max(0.10, metal);
              rough = Math.min(0.35, rough);
            }

            try { if (Number.isFinite(Number(m.roughness))) m.roughness = Math.max(0.02, Math.min(1.0, Number(rough) || 0.9)); } catch { /* ignore */ }
            try { if (Number.isFinite(Number(m.metalness))) m.metalness = Math.max(0.0, Math.min(1.0, Number(metal) || 0.0)); } catch { /* ignore */ }
            try { m.needsUpdate = true; } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }
    });

    if (tasks.length) {
      try { await Promise.all(tasks); } catch { /* ignore */ }
    }
  }

  SceneTool.prototype._spawnPropFromUrl = async function(rawUrl, { name = '', scale = 1.0, yawDeg = 0, place = 'player' } = {}) {
    const url = normalizeAssetUrl(rawUrl);
    if (!url) return null;
    const root = this._ensurePropsRoot();
    if (!root) return null;

    const tpl = await this._getPropTemplate(url);
    if (!tpl?.templateRoot) return null;

    const inst = SkeletonUtils.clone(tpl.templateRoot);
    inst.name = safeTrim(name) || `prop_${safeName(getFileStem(url))}`;

    const sc = Math.max(0.001, Number(scale) || 1.0);
    try { inst.scale.set(sc, sc, sc); } catch { /* ignore */ }
    try { inst.rotation.set(0, degToRad(Number(yawDeg) || 0), 0); } catch { /* ignore */ }

    const x = (place === 'spawn') ? Number(this._spawn?.x) || 0 : Number(this._player?.x) || 0;
    const z = (place === 'spawn') ? Number(this._spawn?.z) || 0 : Number(this._player?.z) || 0;
    inst.position.set(x, 0, z);
    root.add(inst);

    // Snap to ground.
    try {
      inst.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(inst);
      const bottom = Number(box.min.y) || 0;
      const gy = this._findGroundY(x, (Number(this._player?.y) || 0) + 2.0, z);
      const groundY = (gy == null) ? 0 : Number(gy) || 0;
      inst.position.y += (groundY - bottom);
      inst.updateMatrixWorld(true);
    } catch { /* ignore */ }

    const id = `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
    this._props.push({ id, url, root: inst });

    // Best-effort: if a sibling .meta.json exists (common for Assetto exports),
    // load it and apply AC textures so props render correctly too.
    try {
      const metaUrl = normalizeAssetUrl(metaUrlForModelUrl(url));
      if (metaUrl) {
        const resp = await fetch(metaUrl, { cache: 'no-store' });
        if (resp.ok) {
          const j = await resp.json();
          try { await this._applyAcTexturesToRoot(inst, j); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }

    try { this._renderPropsUi(); } catch { /* ignore */ }
    return inst;
  }

  SceneTool.prototype._spawnDriveableVehicleFromAssetUrl = async function(rawUrl, { name = '', scale = 1.0, yawDeg = 0, place = 'player', vehicleConfig = null } = {}) {
    return (await this._vehicleSystem?.spawnDriveableVehicleFromAssetUrl?.(rawUrl, { name, scale, yawDeg, place, vehicleConfig })) || null;
  }

  SceneTool.prototype._deletePropById = function(id) {
    const key = safeTrim(id);
    if (!key) return false;
    const arr = Array.isArray(this._props) ? this._props : [];
    const i = arr.findIndex((p) => safeTrim(p?.id) === key);
    if (i < 0) return false;
    const p = arr[i];
    try { if (p?.root?.parent) p.root.parent.remove(p.root); } catch { /* ignore */ }
    try { disposeThreeObject(p?.root); } catch { /* ignore */ }
    arr.splice(i, 1);
    this._props = arr;
    try { this._renderPropsUi(); } catch { /* ignore */ }
    return true;
  }

  SceneTool.prototype._clearAllProps = function() {
    for (const p of (this._props || [])) {
      try { if (p?.root?.parent) p.root.parent.remove(p.root); } catch { /* ignore */ }
      try { disposeThreeObject(p?.root); } catch { /* ignore */ }
    }
    this._props = [];
    if (this._propsRoot) {
      try { this._propsRoot.clear?.(); } catch { /* ignore */ }
    }
    try { this._renderPropsUi(); } catch { /* ignore */ }
  }

  SceneTool.prototype._renderPropsUi = function() {
    const host = this._ui?.propsHost || null;
    if (!host) return;
    clear(host);

    const inbox = this._readSceneInbox();
    if (inbox && safeTrim(inbox.kind) === 'import_scenario' && inbox.scenario && typeof inbox.scenario === 'object') {
      const sc = inbox.scenario;
      const name = safeTrim(sc?.name) || '(unnamed scenario)';
      const p = safeTrim(sc?.path);
      host.appendChild(el('div', { class: 'muted', style: { whiteSpace: 'pre-wrap' } }, [
        `Inbox: scenario received\n${name}\n${p}`,
      ]));
      host.appendChild(el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
        el('button', {
          class: 'primary',
          onclick: async () => {
            try {
              this._importScenario(sc);
              this._pendingScenario = sc;
              if (p) {
                this._setSourceUrl(p);
                try { if (this._ui?.sourceInput) this._ui.sourceInput.value = p; } catch { /* ignore */ }
                if (isProceduralPath(p)) await this._loadProcedural(p, { scenario: sc });
                else if (isGlTfExt(extOf(p))) await this._loadGlb(p, { scenario: sc });
              }
              this._setStatus(`Imported scenario: ${name}`);
              this._ctx?.toast?.(`Imported scenario: ${name}`, 'success', { title: 'Scene' });
            } catch (e) {
              this._ctx?.toast?.(`Scenario import failed: ${e?.message || e}`, 'error', { title: 'Scene' });
            } finally {
              this._clearSceneInbox();
              try { this._buildUi(); } catch { /* ignore */ }
            }
          },
          title: 'Imports this scenario into saved scenarios and loads it now',
        }, ['Import + load']),
        el('button', {
          onclick: () => {
            this._clearSceneInbox();
            this._renderPropsUi();
          },
          title: 'Dismiss this inbox message',
        }, ['Dismiss']),
      ]));
      host.appendChild(el('div', { class: 'separator' }, []));
    }
    if (inbox && safeTrim(inbox.kind) === 'spawn_prop' && safeTrim(inbox.url)) {
      const u = normalizeAssetUrl(inbox.url);
      host.appendChild(el('div', { class: 'muted', style: { whiteSpace: 'pre-wrap' } }, [
        `Inbox: vehicle model received\n${u}`,
      ]));
      host.appendChild(el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
        el('button', {
          class: 'primary',
          onclick: async () => {
            try {
              if (this._ui?.propUrlInput) this._ui.propUrlInput.value = u;
              await this._spawnPropFromUrl(u, {
                name: safeTrim(inbox?.name) || '',
                scale: Number(this._ui?.propScaleInput?.value) || 1.0,
                yawDeg: Number(this._ui?.propYawInput?.value) || 0,
                place: 'player',
              });
              this._setStatus('Spawned prop from inbox.');
              this._ctx?.toast?.('Spawned prop from Vehicles tool', 'success', { title: 'Props' });
            } catch (e) {
              this._ctx?.toast?.(`Spawn failed: ${e?.message || e}`, 'error', { title: 'Props' });
            } finally {
              this._clearSceneInbox();
              try { this._renderPropsUi(); } catch { /* ignore */ }
            }
          },
          title: 'Spawns the received vehicle GLB as a prop at the player position',
        }, ['Spawn inbox @ player']),
        el('button', {
          onclick: () => { this._clearSceneInbox(); this._renderPropsUi(); },
          title: 'Dismiss this inbox message',
        }, ['Dismiss']),
      ]));
      host.appendChild(el('div', { class: 'separator' }, []));
    }

    if (inbox && safeTrim(inbox.kind) === 'spawn_vehicle_asset' && safeTrim(inbox.url)) {
      const u = normalizeAssetUrl(inbox.url);
      host.appendChild(el('div', { class: 'muted', style: { whiteSpace: 'pre-wrap' } }, [
        `Inbox: driveable vehicle model received\n${u}\nTip: spawn it, walk to a door and press E (F to exit).`,
      ]));
      host.appendChild(el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
        el('button', {
          class: 'primary',
          onclick: async () => {
            try {
              if (this._ui?.propUrlInput) this._ui.propUrlInput.value = u;
              await this._vehicleSystem?.spawnDriveableVehicleFromAssetUrl?.(u, {
                name: safeTrim(inbox?.name) || '',
                scale: Number(this._ui?.propScaleInput?.value) || 1.0,
                yawDeg: Number(this._ui?.propYawInput?.value) || 0,
                place: 'player',
                vehicleConfig: (inbox?.vehicleConfig && typeof inbox.vehicleConfig === 'object') ? inbox.vehicleConfig : null,
              });
              this._setStatus('Spawned driveable vehicle from inbox.');
              this._ctx?.toast?.('Driveable vehicle spawned from Vehicles tool', 'success', { title: 'Vehicles' });
            } catch (e) {
              this._ctx?.toast?.(`Spawn failed: ${e?.message || e}`, 'error', { title: 'Vehicles' });
            } finally {
              this._clearSceneInbox();
              try { this._renderPropsUi(); } catch { /* ignore */ }
            }
          },
          title: 'Spawns the received vehicle GLB as a driveable vehicle at the player position',
        }, ['Spawn vehicle inbox @ player']),
        el('button', {
          onclick: async () => {
            try {
              if (this._ui?.propUrlInput) this._ui.propUrlInput.value = u;
              await this._vehicleSystem?.spawnDriveableVehicleFromAssetUrl?.(u, {
                name: safeTrim(inbox?.name) || '',
                scale: Number(this._ui?.propScaleInput?.value) || 1.0,
                yawDeg: Number(this._ui?.propYawInput?.value) || 0,
                place: 'spawn',
                vehicleConfig: (inbox?.vehicleConfig && typeof inbox.vehicleConfig === 'object') ? inbox.vehicleConfig : null,
              });
              this._setStatus('Spawned driveable vehicle from inbox @ spawn.');
              this._ctx?.toast?.('Driveable vehicle spawned @ spawn', 'success', { title: 'Vehicles' });
            } catch (e) {
              this._ctx?.toast?.(`Spawn failed: ${e?.message || e}`, 'error', { title: 'Vehicles' });
            } finally {
              this._clearSceneInbox();
              try { this._renderPropsUi(); } catch { /* ignore */ }
            }
          },
          title: 'Spawns the received vehicle GLB as a driveable vehicle at the spawn marker',
        }, ['Spawn vehicle inbox @ spawn']),
        el('button', {
          onclick: () => { this._clearSceneInbox(); this._renderPropsUi(); },
          title: 'Dismiss this inbox message',
        }, ['Dismiss']),
      ]));
      host.appendChild(el('div', { class: 'separator' }, []));
    }

    const list = Array.isArray(this._props) ? this._props : [];
    const vehCount = Number(this._vehicleSystem?.getSpawnedAssetVehicleCount?.() || 0);
    host.appendChild(el('div', { class: 'muted' }, [`Spawned driveable vehicles: ${vehCount}`]));
    if (!list.length) {
      host.appendChild(el('div', { class: 'muted' }, ['(no spawned props yet)']));
      return;
    }

    host.appendChild(el('div', { class: 'muted' }, [`Spawned props: ${list.length}`]));
    host.appendChild(el('div', { style: { marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' } }, [
      ...list.slice().reverse().map((p) => {
        const label = safeTrim(p?.root?.name) || safeName(getFileStem(p?.url || 'prop'));
        const u = safeTrim(p?.url || '');
        return el('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
          el('div', { class: 'muted', style: { flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis' }, title: u }, [label]),
          el('button', { class: 'danger', onclick: () => this._deletePropById(p.id) }, ['Delete']),
        ]);
      }),
    ]));
  }

  
}
