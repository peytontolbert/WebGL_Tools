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

export const scenePropsMixin = {};

scenePropsMixin._ensurePropsRoot = function _ensurePropsRoot() {
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
};

scenePropsMixin._readSceneInbox = function _readSceneInbox() {
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
};

scenePropsMixin._clearSceneInbox = function _clearSceneInbox() {
  try { localStorage.removeItem('devtools.scene.inbox'); } catch { /* ignore */ }
};

scenePropsMixin._tryApplyForgeInbox = async function _tryApplyForgeInbox() {
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
};

scenePropsMixin._removeWorldObjectByName = function _removeWorldObjectByName(name) {
  const nm = safeTrim(name);
  if (!nm || !this._worldRoot) return null;
  const obj = this._worldRoot.getObjectByName?.(nm) || null;
  if (!obj) return null;
  try { if (obj.parent) obj.parent.remove(obj); } catch { /* ignore */ }
  try { disposeThreeObject(obj); } catch { /* ignore */ }
  return obj;
};

scenePropsMixin._createForgeTerrainMesh = function _createForgeTerrainMesh({ size = 120, resolution = 65, color = 0x2a313f, heights = [] } = {}) {
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
};

scenePropsMixin._applyForgeWorldPayload = async function _applyForgeWorldPayload(payload) {
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
};

