import { el, clear, clamp } from '../../ui/dom.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { createAssetPicker, createJobRunner, createJsonTextAreaCard } from '../components/ui_components.js';
import { buildRoomSimPenthouseLayout } from '../../shared/room_sim_penthouse_layout.js';
import { DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS } from '../../shared/room_sim_penthouse_defaults.js';
import { SceneVehicleSystem } from './scene_vehicle_system.js';
import {
  buildObstacleBoxesFromSources,
  collidesCircleAgainstBoxes,
  filterResumeShowcaseColliderSources,
} from '../../shared/collision_world.js';

import {
  SCENE_ASSET_LOCATIONS,
  SCENE_PENTHOUSE_BUILDING_ASSET_PATH,
  SCENE_DRIFT_TRACK_BUILDING_ASSET_PATH,
  SCENE_VEHICLE_PRESETS,
  withVehiclePathFallbacks,
  WORLD_THEME_PRESETS,
  getWorldThemePreset,
  WORLD_TEMPLATE_PRESETS,
  getWorldTemplatePreset,
} from './scene/scene_presets.js';

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
} from './scene/core/scene_utils.js';

import {
  normAnimName,
  clipByAliases,
  CHARACTER_ACTION_KEYS,
  buildCharacterActionAliases,
  computeAutoGroundYOffset,
} from './scene/characters/character_anim_utils.js';

import { sceneTool_buildUi, sceneTool_syncModeUi } from './scene/ui/scene_ui.js';
import { scenarioDefaultsMixin, ensureDefaultScenarios } from './scene/scenarios/scenario_defaults_mixin.js';
import { proceduralMixin } from './scene/scenarios/procedural_mixin.js';
import { sceneTickMixin } from './scene/scene_tick_mixin.js';
import { sceneDamageMixin } from './scene/scene_damage_mixin.js';
import { scenePlayerMixin } from './scene/scene_player_mixin.js';
import { sceneEnemyMixin } from './scene/scene_enemy_mixin.js';
import { sceneNavMixin } from './scene/scene_nav_mixin.js';
import { sceneBuildingsMixin } from './scene/scene_buildings_mixin.js';
import { sceneScenarioMixin } from './scene/scene_scenario_mixin.js';
import { sceneAvatarMixin } from './scene/scene_avatar_mixin.js';
import { sceneRoomSimMixin } from './scene/scene_room_sim_mixin.js';
import { sceneResumeWalkerMixin } from './scene/scene_resume_walker_mixin.js';
import { sceneBuildingsUiMixin } from './scene/scene_buildings_ui_mixin.js';
import { sceneResumeShowcasePanelMixin } from './scene/scene_resume_showcase_panel_mixin.js';


function extractVehicleMotionClipBuckets(clips) {
  const out = {
    idle: [],
    drive: [],
    wheel: [],
    suspension: [],
    steering: [],
    combat: [],
  };
  if (!Array.isArray(clips) || !clips.length) return out;
  for (const c of clips) {
    const name = safeTrim(c?.name || '');
    if (!name) continue;
    const n = normAnimName(name);
    if (!n) continue;
    if (/(^|)(idle|park|neutral|still|aim)(|$)/.test(n)) out.idle.push(name);
    if (/(^|)(drive|move|speed|engine|motor|run)(|$)/.test(n)) out.drive.push(name);
    if (/(^|)(wheel|tire|tyre|spin|roll)(|$)/.test(n)) out.wheel.push(name);
    if (/(^|)(susp|shock|bounce)(|$)/.test(n)) out.suspension.push(name);
    if (/(^|)(steer|steering|turn|yaw)(|$)/.test(n)) out.steering.push(name);
    if (/(^|)(combat|fire|gun|shoot|weapon)(|$)/.test(n)) out.combat.push(name);
  }
  return out;
}

export class SceneTool {
  constructor() {
    this.id = 'scene';
    this.label = 'Scene';

    this._ctx = null;
    this._root = null;

    this._canvas = null;
    this._renderer = null;
    this._scene = null;
    this._camera = null;
    this._orbit = null;
    this._plock = null;
    this._pointerLockTarget = null;
    this._wasPointerLocked = false;

    this._loader = new GLTFLoader();
    this._propLoader = new GLTFLoader();
    this._gltf = null;
    this._worldRoot = null;
    this._proc = { kind: '', root: null };

    // Spawned props (ad-hoc GLBs added into the current world)
    this._propsRoot = null; // THREE.Group attached under _worldRoot
    this._props = []; // { id, url, root }
    this._propCache = new Map(); // url -> { templateRoot, clips }

    this._grid = null;
    this._spawnMarker = null;
    this._debugGroup = null;
    this._debugMarkers = { wp: new Map(), trig: new Map() }; // pooled debug markers (avoid recreate/dispose churn)

    // Player state (feet position)
    this._player = {
      x: 0,
      y: 0,
      z: 0,
      vy: 0,
      moveDx: 0,
      moveDz: 0,
      moveSpeedXZ: 0,
      yawRad: 0,
      standEyeH: 1.7,
      crouchEyeH: 1.12,
      crouchT: 0,
      leanT: 0,
      leanQ: new THREE.Quaternion(), // last applied lean (world-space) so we can unapply each frame
      eyeH: 1.7,
      onGround: false,
      radius: 0.35,
    };
    this._spawn = { x: 0, y: 0, z: 0 };
    this._ray = new THREE.Raycaster();
    this._colliders = [];
    // Ground raycast sources (defaults to the loaded world root, but can be overridden
    // by an optimized collider GLB produced by the AC track exporter).
    this._groundRaycastRoots = null; // null | [THREE.Object3D]
    this._acTrack = {
      enabled: true,
      bundleUrl: '',
      atMs: 0,
      loading: false,
      surfaceFriction: {}, // KEY -> friction scalar from surfaces.ini
      roadFriction: 1.0,
      groundColliderUrl: '',
      groundColliderRoot: null,
      groundColliderLoading: false,
    };
    this._obstacleBoxes = []; // world-space Box3 list for simple FPS wall collision
    this._tmpV3 = new THREE.Vector3();
    this._tmpV3b = new THREE.Vector3();
    this._tmpV3c = new THREE.Vector3();
    // Dedicated chase-cam temps (do NOT reuse _tmpV3/_tmpV3b; those are used by helpers like _segmentBlocked()).
    this._tmpChaseTarget = new THREE.Vector3();
    this._tmpChaseFwd = new THREE.Vector3();
    this._tmpChasePos = new THREE.Vector3();
    this._tmpQ0 = new THREE.Quaternion();
    this._tmpQ1 = new THREE.Quaternion();
    this._upV3 = new THREE.Vector3(0, 1, 0);
    this._keysDown = new Set();
    this._keysPressed = new Set(); // edge-triggered presses, cleared each tick

    // Resume export: if anything clobbers scenario content after procedural load,
    // re-seed resume triggers once during tick so interactions don't require loading a saved scenario.
    this._resumeSeed = { done: false, lastTrySec: 0 };
    this._mouseDown = false;
    this._aimDown = false;
    this._triggerInteractHintActive = false; // set by _tickTriggers when inside an interact-gated trigger

    // Resume export: mobile-friendly controls (tilt to move, touch-drag to look, tap to interact).
    // Kept opt-in behind `globalThis.__resumeShowcase` so devtools/editor behavior remains unchanged.
    this._resumeMobile = {
      enabled: false,
      // Touch look state
      touch: { active: false, pointerId: -1, x: 0, y: 0, moved: false, t0: 0 },
      // Tilt movement state
      tilt: { listening: false, neutral: null, beta: 0, gamma: 0, moveF: 0, moveS: 0 },
      // Bound handlers for add/removeEventListener
      handlers: { pointerdown: null, pointermove: null, pointerup: null, pointercancel: null, orientation: null },
    };

    // Vehicles / driving (extracted into a dedicated system).
    this._vehicleSystem = new SceneVehicleSystem(this);

    // On-foot camera mode (FPS demo). Vehicle camera lives in SceneVehicleSystem.
    this._playerCamMode = 'first'; // first | third
    this._playerChaseCam = { dist: 6.5, lift: 1.15 }; // tuned to feel like vehicle chase cam, but on-foot
    this._playerViz = { group: null, body: null, head: null, nose: null, muzzle: null }; // simple visible avatar in third-person

    // Optional skinned avatar for third-person.
    this._avatar = {
      enabled: false,
      // In Scene mode, playable characters must come from saved character manifests/profiles.
      url: '',
      scale: 3.0,
      yOffset: 0.0,
      yawOffsetRad: Math.PI, // match resume walker orientation
    };
    this._avatar3p = {
      loader: new GLTFLoader(),
      loading: false,
      loadedUrl: '',
      sourceUrl: '',
      gltf: null,
      root: null,
      mixer: null,
      actions: new Map(), // key -> THREE.AnimationAction
      activeKey: '',
      clipNames: [],
      actionAliases: buildCharacterActionAliases(),
      forcedActionKey: '',
      rootBone: null,
      cancelRootTranslation: true,
      autoGroundYOffset: 0.0,
      texturesApplied: false,
      texturesApplyRequested: false,
      jumpState: 'grounded', // grounded | start | air | land
      jumpStateT: 0.0,
      wasOnGround: true,
      lastTurnSign: 0,
    };

    // Penthouse "room sim" people (spawn 25 agents onto chairs / spawns).
    this._roomSim = {
      enabled: true,
      url: 'outputs/debra_locomotion_pack.glb',
      scale: 1.0,
      yOffset: 0.0,
      maxPeople: 25,
      hideSpawnMarkers: true,
    };
    this._roomSimPeople = {
      group: null,
      templateUrl: '',
      templateGltf: null,
      templateRoot: null,
      templateClips: [],
      loading: false,
      people: [], // { root, mixer, actions, activeKey, yawRad, clipNames, rootBone, cancelRootTranslation }
    };

    // Resume Showcase: a simple autonomous character that walks a loop and idles.
    // Uses a locomotion GLB (idle + walk) so we can sanity-check animation packs quickly.
    this._resumeWalker = {
      enabled: true,
      url: 'exported-model.glb',
      scale: 3.0,
      yOffset: 0.0,
      speed: 1.35,  // m/s
      // Default to a wide orbit so the walker stays clear of the center platform.
      radius: 24.0,  // meters
      centerX: 0.0,
      centerZ: 0.0,
      walkSec: 7.5,
      idleSec: 2.2,
      yawOffsetRad: Math.PI, // some models face +Z; flip to avoid "walking backwards"
      textureSourceUrl: 'outputs/new_tpose_trellis.glb',
    };
    this._resumeWalker3d = {
      loader: new GLTFLoader(),
      loading: false,
      loadedUrl: '',
      gltf: null,
      root: null,
      mixer: null,
      actions: new Map(), // key -> THREE.AnimationAction
      clipNames: [],
      rootBone: null,
      cancelRootTranslation: true,
      autoGroundYOffset: 0.0,
      angle: 0.0,
      mode: 'idle', // idle | walk
      modeT: 0.0,
      texturesApplied: false,
    };
    this._resumeWalkerTexSrc = {
      loader: new GLTFLoader(),
      loading: false,
      loadedUrl: '',
      gltf: null,
      root: null,
      // Cached “best” source material (fallback if name matching fails)
      material: null,
    };

    // Scenario content (saved into scenario JSON)
    /** @type {{ waypoints: any[], triggers: any[], meta?: { avatarProfile?: string, avatarAction?: string } }} */
    this._scenarioContent = { waypoints: [], triggers: [], meta: { avatarProfile: '', avatarAction: '' } };
    this._triggerInside = new Map(); // triggerId -> boolean
    this._triggerFired = new Set();  // triggerId -> fired at least once (runtime-only)
    this._completedGoals = new Set(); // goal triggerId -> completed (runtime-only)

    // Scenario editor UI state
    this._scenarioUi = {
      wpFilter: '',
      trigFilter: '',
    };
    this._scenarioSel = {
      waypointName: '',
      triggerId: '',
    };

    // Selection + building tagging/editor
    this._selection = { obj: null, uuid: '', name: '' };
    this._selectionBox = null; // THREE.BoxHelper
    this._buildings = { filter: '' };
    this._buildingSel = { uuid: '' };

    // Collider sources for procedural worlds (used to rebuild _obstacleBoxes after edits)
    /** @type {THREE.Object3D[]} */
    this._obstacleSources = [];

    // Resume Showcase walker navigation helpers.
    // The resume demo filters *player* collisions down to structural walls only,
    // but for the autonomous walker we also want to avoid the center platform collider.
    this._resumeWalkerNav = {
      sources: /** @type {THREE.Object3D[]} */ ([]),
      boxes: /** @type {THREE.Box3[]} */ ([]),
      bounds: /** @type {{ minX:number, maxX:number, minZ:number, maxZ:number }|null} */ (null),
    };

    this._handlers = {
      keydown: (e) => this._onKeyDown(e),
      keyup: (e) => this._onKeyUp(e),
      mousedown: (e) => this._onMouseDown(e),
      mouseup: (e) => this._onMouseUp(e),
      contextmenu: (e) => { try { e.preventDefault(); } catch { /* ignore */ } },
    };

    this._state = {
      sourceUrl: '',
      lastGlbUrl: '',
      mode: 'fps', // fps | orbit
      showGrid: true,
      enableLean: false,
      fly: false,
      speed: 6.0,
      sprint: 11.0,
      gravity: 25.0,
      jumpV: 7.5,
      outName: '',
      runner: 'conda_trellis', // conda_trellis | python3
      autoPlayAfterLoad: true,
      showDebug: true,
    };

    this._ui = {
      sourceInput: null,
      modeSel: null,
      statusEl: null,
      hintEl: null,
      scenarioSel: null,
      scenarioName: null,
      outNameInput: null,
      runnerSel: null,
      gridChk: null,
      leanChk: null,
      flyChk: null,
      speedInput: null,
      autoPlayChk: null,
      debugChk: null,
      waypointsHost: null,
      waypointEditorHost: null,
      wpFilterInput: null,
      triggersHost: null,
      triggerEditorHost: null,
      trigFilterInput: null,
      objectivesHost: null,
      wpNameInput: null,
      trigNameInput: null,
      trigMsgInput: null,
      trigSizeInput: null,
      trigOnceChk: null,
      trigTargetSel: null,
      trigInteractChk: null,
      trigPromptInput: null,

      buildingsHost: null,
      buildingEditorHost: null,
      buildingFilterInput: null,
      selectionInfoEl: null,

      // Props
      propUrlInput: null,
      propScaleInput: null,
      propYawInput: null,
      propsHost: null,

      // Vehicles
      vehiclePresetSel: null,
      vehiclePresetInfo: null,
      vehicleScaleInput: null,
      vehicleYawInput: null,
    };
    this._createSceneModal = { overlay: null, escHandler: null, outsideClickHandler: null };

    this._pendingScenario = null;
    this._resumeShowcase = {
      githubUser: 'peytontolbert',
      repoCache: { user: '', atMs: 0, repos: [] },
      readmeCache: new Map(), // "user/repo" -> README text
      repoBranchCache: new Map(), // "user/repo" -> default branch
      panelRoot: null,
      panelCard: null,
      panelTitle: null,
      panelMeta: null,
      panelDesc: null,
      panelReadme: null,
      panelOpenRepoBtn: null,
      panelOpenDemoBtn: null,
      panelSections: null,
      panelChrome: null,
      panelPulse: null,
      panelHideTimer: null,
      panelTimers: [],
      runtime: null,
      cycleSelection: null,
      showCurrentRepo: null,
    };

    this._fpsPrefs = {
      enemyCount: 6,
      enemyBehavior: 'attack', // attack | patrol | sim
    };

    // ─────────────────── FPS demo gameplay state (proc:arena) ───────────────────
    this._hudOverlay = null;
    this._hudEls = { root: null, crosshair: null, topLeft: null, msg: null, hit: null };
    this._fx = {
      bullets: [], // { mesh, v:Vector3, ttl, hitPoint?:Vector3 }
      tracers: [], // { line, ttl }
      flashes: [], // { mesh, ttl }
    };
    this._gun = { group: null, muzzle: null, recoil: 0, recoilKick: 0, sway: 0 };
    this._game = {
      enabled: false,
      time: 0,
      kills: 0,
      enemiesAlive: 0,
      mission: 'Eliminate all targets.',
      missionDone: false,
      viz: { showGun: true, showPlayerShots: true, showEnemyShots: true },
      msgT: 0,
      msg: '',
      hitT: 0,
      hitAlpha: 0,
      player: { hp: 250, hpMax: 250, lastHitT: -1e9, hitCooldownSec: 0.12, dead: false, respawnT: 0 },
      activeWeapon: 'rifle', // rifle | sniper
      weapons: {
        rifle: {
          id: 'rifle',
          name: 'Rifle',
          magSize: 30,
          ammoInMag: 30,
          reserve: 90,
          fireCooldown: 0,
          fireRate: 12.0, // shots/sec
          reloadT: 0,
          reloadSec: 1.35,
          damage: 28,
          headshotMul: 2.0,
          range: 120,
          spreadRad: 0.01,
          auto: true,
          bulletSpeed: 70.0,
          zoomFov: 70,
        },
        sniper: {
          id: 'sniper',
          name: 'Sniper',
          magSize: 5,
          ammoInMag: 5,
          reserve: 20,
          fireCooldown: 0,
          fireRate: 1.2,
          reloadT: 0,
          reloadSec: 1.85,
          damage: 120,
          headshotMul: 3.0,
          range: 260,
          spreadRad: 0.0008,
          auto: false,
          bulletSpeed: 140.0,
          zoomFov: 22,
        },
      },
      enemy: {
        dmg: 7,
        fireRate: 2.4,
        range: 55,
        aimErrorScale: 2.2,
        fovCos: Math.cos(THREE.MathUtils.degToRad(70)),
        seeDist: 60,
        countTarget: 6,
        behavior: 'attack', // attack | patrol | sim
      },
      nav: {
        built: false,
        minX: -28, maxX: 28, minZ: -28, maxZ: 28,
        cell: 1.0,
        w: 0, h: 0,
        occ: null, // Uint8Array w*h, 1=blocked
      },
    };
    this._enemies = [];
  }

  _resolveTireUrl() {
    // Prefer localStorage override so you can swap tire assets without changing code.
    try {
      const u = safeTrim(localStorage.getItem('gameplay.tireUrl') || '');
      if (u) return u;
    } catch { /* ignore */ }
    return safeTrim(this._tire?.url || '');
  }

  async _ensureTireAssetLoaded() {
    if (!this._tire?.enabled) return null;
    const u = this._resolveTireUrl();
    if (!u) return null;
    if (this._tireAsset && this._tireAsset.url === u && this._tireAsset.root) return this._tireAsset;
    if (this._tireLoading) return this._tireAsset;
    this._tireLoading = true;
    try {
      const gltf = await this._tireLoader.loadAsync(u);
      const root = gltf?.scene || null;
      if (!root) return null;

      const box = new THREE.Box3().setFromObject(root);
      const size = new THREE.Vector3();
      box.getSize(size);
      const dims = [Math.abs(size.x), Math.abs(size.y), Math.abs(size.z)];
      const minDim = Math.min(dims[0], dims[1], dims[2]);
      const widthAxis = (dims[0] === minDim) ? 0 : (dims[1] === minDim) ? 1 : 2;
      const widthVec = (widthAxis === 0) ? new THREE.Vector3(1, 0, 0) : (widthAxis === 1) ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
      const alignQ = new THREE.Quaternion().setFromUnitVectors(widthVec, new THREE.Vector3(1, 0, 0));
      const outerRadius = 0.5 * Math.max(dims[0], dims[1], dims[2], 1e-6);

      // Mark cached materials so disposal of vehicle groups doesn't kill the cache.
      try {
        root.traverse?.((n) => {
          const any = /** @type {any} */ (n);
          const mat = any.material;
          if (Array.isArray(mat)) for (const m of mat) { if (m) { m.userData = m.userData || {}; m.userData.__skipDispose = true; } }
          else if (mat) { mat.userData = mat.userData || {}; mat.userData.__skipDispose = true; }
        });
      } catch { /* ignore */ }

      this._tireAsset = { url: u, root, alignQ, outerRadius, width: minDim };
      return this._tireAsset;
    } catch {
      return null;
    } finally {
      this._tireLoading = false;
    }
  }

  _applyRealisticTiresToVehicle(v) {
    const asset = this._tireAsset;
    if (!asset?.root) return;
    const parts = v?.parts || null;
    const wheels = parts?.wheelsAll || null;
    if (!Array.isArray(wheels) || wheels.length === 0) return;
    const radiusFront = Number(parts?.wheelRadius) || 0;
    const radiusRear = Number(parts?.wheelRadiusRear) || radiusFront;
    const widthFront = Number(parts?.wheelWidth) || 0.20;
    const widthRear = Number(parts?.wheelWidthRear) || widthFront;
    if (!(radiusFront > 0)) return;

    const outerR = Math.max(1e-6, Number(asset.outerRadius) || 1.0);
    const baseWidth = Math.max(1e-6, Number(asset.width) || 0);
    const extraWidthMul = Number(this._tire?.widthMul) || 1.0;
    const frontSet = new Set(Array.isArray(parts?.wheelsFront) ? parts.wheelsFront : []);

    for (const pivot of wheels) {
      if (!pivot) continue;
      const isFront = frontSet.has(pivot);
      const radius = isFront ? radiusFront : radiusRear;
      const width = isFront ? widthFront : widthRear;
      const sU = Math.max(1e-6, radius / outerR);
      const wantW = Math.max(0.02, width);
      const curW = baseWidth * sU;
      const wMul = (baseWidth > 0) ? (wantW / Math.max(1e-6, curW)) : 1.0;
      // Remove prior realistic tire if present, else remove placeholder "tire".
      const kill = [];
      for (const ch of (pivot.children || [])) {
        if (!ch) continue;
        const isPlaceholder = !!(ch?.userData && ch.userData.__tirePlaceholder);
        if (ch.name === 'tire_realistic' || isPlaceholder) kill.push(ch);
      }
      for (const ch of kill) {
        try { pivot.remove(ch); } catch { /* ignore */ }
        try { disposeThreeObject(ch); } catch { /* ignore */ }
      }

      const inst = /** @type {THREE.Object3D} */ (asset.root.clone(true));
      inst.name = 'tire_realistic';
      inst.traverse?.((n) => { try { n.userData = n.userData || {}; n.userData.__skipDispose = true; } catch { /* ignore */ } });
      inst.quaternion.copy(asset.alignQ || new THREE.Quaternion(0, 0, 0, 1));
      inst.scale.setScalar(sU);
      inst.scale.x *= (wMul * extraWidthMul);
      pivot.add(inst);
    }
  }

  _ensureAssetVehicleWheelPivots(inst, vrec, anchors, anchorUnitScale = 1.0) {
    const parts = vrec?.parts || null;
    if (!inst || !parts) return;
    const have = Array.isArray(parts.wheelsAll) ? parts.wheelsAll : [];
    if (have.length) return;

    const wheelsAll = [];
    const wheelsFront = [];

    const attachPreserve = (parent, obj) => {
      if (!parent || !obj) return;
      try {
        if (typeof parent.attach === 'function') { parent.attach(obj); return; }
      } catch { /* ignore */ }
      try {
        obj.updateMatrixWorld(true);
        parent.updateMatrixWorld(true);
        const world = obj.matrixWorld.clone();
        parent.add(obj);
        const inv = parent.matrixWorld.clone().invert();
        obj.matrix.copy(inv.multiply(world));
        obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
      } catch {
        try { parent.add(obj); } catch { /* ignore */ }
      }
    };

    const candidates = [];
    try {
      inst.traverse?.((n) => {
        const any = /** @type {any} */ (n);
        if (!any || !any.isMesh) return;
        const nm = safeTrim(any.name || '').toLowerCase();
        if (!nm) return;
        if (nm.includes('tire_realistic')) return;
        if (!/(wheel|tire|tyre|rim)/.test(nm)) return;
        candidates.push(any);
      });
    } catch { /* ignore */ }

    const tmpA = new THREE.Vector3();
    const tmpB = new THREE.Vector3();
    const pickNearest = (targetWorld) => {
      let best = null;
      let bestD2 = Infinity;
      for (const m of candidates) {
        if (!m || m.userData?.__wheelTaken) continue;
        try {
          m.getWorldPosition(tmpA);
          const d2 = tmpA.distanceToSquared(targetWorld);
          if (d2 < bestD2) { bestD2 = d2; best = m; }
        } catch { /* ignore */ }
      }
      if (best) {
        try { best.userData = best.userData || {}; best.userData.__wheelTaken = true; } catch { /* ignore */ }
      }
      return best;
    };

    const mkPivot = (name, localPos) => {
      const p = new THREE.Group();
      p.name = name;
      p.position.copy(localPos);
      inst.add(p);
      return p;
    };

    const wheelAnchorLocal = (key) => {
      const p = Array.isArray(anchors?.[key]?.pos) ? anchors[key].pos : null;
      if (!p || p.length < 3) return null;
      const s = (Number(anchorUnitScale) || 1.0);
      return new THREE.Vector3((Number(p[0]) || 0) * s, (Number(p[1]) || 0) * s, (Number(p[2]) || 0) * s);
    };

    const wheelKeys = [
      { key: 'wheel_lf', id: 'lf', isFront: true },
      { key: 'wheel_rf', id: 'rf', isFront: true },
      { key: 'wheel_lr', id: 'lr', isFront: false },
      { key: 'wheel_rr', id: 'rr', isFront: false },
    ];

    const locals = wheelKeys.map((w) => ({ ...w, local: wheelAnchorLocal(w.key) }));
    const haveAnchors = locals.every((w) => !!w.local);

    if (haveAnchors) {
      for (const w of locals) {
        const local = w.local;
        const pivot = mkPivot(`wheel_${w.id}_pivot`, local);
        try { inst.localToWorld(tmpB.copy(local)); } catch { tmpB.set(0, 0, 0); }
        const mesh = pickNearest(tmpB);
        if (mesh) attachPreserve(pivot, mesh);
        wheelsAll.push(pivot);
        if (w.isFront) wheelsFront.push(pivot);
      }
    } else {
      const scored = [];
      for (const m of candidates) {
        try {
          m.getWorldPosition(tmpA);
          const local = inst.worldToLocal(tmpA.clone());
          scored.push({ m, x: local.x, y: local.y, z: local.z });
        } catch { /* ignore */ }
      }
      if (scored.length >= 2) {
        const byZ = scored.slice().sort((a, b) => a.z - b.z);
        const front = byZ.slice(0, Math.min(2, byZ.length));
        const rear = byZ.slice(Math.max(0, byZ.length - 2));
        const pickLR = (arr) => {
          if (!arr.length) return { left: null, right: null };
          const left = arr.slice().sort((a, b) => a.x - b.x)[0] || null;
          const right = arr.slice().sort((a, b) => b.x - a.x)[0] || null;
          return { left, right };
        };
        const f = pickLR(front);
        const r = pickLR(rear);
        const slots = [
          { id: 'lf', isFront: true, item: f.left },
          { id: 'rf', isFront: true, item: f.right },
          { id: 'lr', isFront: false, item: r.left },
          { id: 'rr', isFront: false, item: r.right },
        ];
        for (const s of slots) {
          const it = s.item;
          if (!it?.m) continue;
          const pivot = mkPivot(`wheel_${s.id}_pivot`, new THREE.Vector3(it.x, it.y, it.z));
          attachPreserve(pivot, it.m);
          wheelsAll.push(pivot);
          if (s.isFront) wheelsFront.push(pivot);
        }
      }
    }

    parts.wheelsAll = wheelsAll;
    parts.wheelsFront = wheelsFront;
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;

    const isResumeExport = !!globalThis.__resumeShowcase;
    if (isResumeExport) {
      try { disableCreateImageBitmapForResumeExport(); } catch { /* ignore */ }
      // Resume-only export should not depend on any prior devtools localStorage state.
      // Always boot into the interactive resume scene in FPS mode.
      this._state.sourceUrl = 'proc:resume_showcase';
      this._state.lastGlbUrl = '';
      this._state.mode = 'fps';
      this._state.showGrid = false;
      this._state.enableLean = false;
      this._state.fly = false;
      this._state.speed = 6;
      this._state.sprint = 11;
      this._state.autoPlayAfterLoad = true;
      this._state.showDebug = false;
    } else {
      // Restore state
      try { this._state.sourceUrl = String(localStorage.getItem('devtools.scene.sourceUrl') || '').trim(); } catch { /* ignore */ }
      try { this._state.lastGlbUrl = String(localStorage.getItem('devtools.scene.lastGlbUrl') || '').trim(); } catch { /* ignore */ }
      try { this._state.mode = String(localStorage.getItem('devtools.scene.mode') || 'fps'); } catch { /* ignore */ }
      try { this._state.showGrid = !!Number(localStorage.getItem('devtools.scene.showGrid') || '1'); } catch { /* ignore */ }
      try { this._state.enableLean = !!Number(localStorage.getItem('devtools.scene.enableLean') || '0'); } catch { /* ignore */ }
      try { this._state.fly = !!Number(localStorage.getItem('devtools.scene.fly') || '0'); } catch { /* ignore */ }
      try { this._state.speed = Math.max(0.1, Number(localStorage.getItem('devtools.scene.speed') || '6') || 6); } catch { /* ignore */ }
      try { this._state.sprint = Math.max(0.1, Number(localStorage.getItem('devtools.scene.sprint') || '11') || 11); } catch { /* ignore */ }
      try { this._state.autoPlayAfterLoad = !!Number(localStorage.getItem('devtools.scene.autoPlayAfterLoad') || '1'); } catch { /* ignore */ }
      try { this._state.showDebug = !!Number(localStorage.getItem('devtools.scene.showDebug') || '1'); } catch { /* ignore */ }
    }

    // Restore character prefs (Debra / avatar).
    if (isResumeExport) {
      // In the resume export, use the shipped model under dist/resume/.
      this._avatar.enabled = true;
      this._avatar.url = 'resume/exported-model.glb';
      this._avatar.scale = 3.0;
      this._avatar.yOffset = 0.0;
    } else {
      try { this._avatar.enabled = !!Number(localStorage.getItem('devtools.scene.avatarEnabled') || '0'); } catch { /* ignore */ }
      try { this._avatar.url = String(localStorage.getItem('devtools.scene.avatarUrl') || this._avatar.url || '').trim(); } catch { /* ignore */ }
      try { this._avatar.scale = Math.max(0.01, Number(localStorage.getItem('devtools.scene.avatarScale') || String(this._avatar.scale || 1.0)) || 1.0); } catch { /* ignore */ }
      try { this._avatar.yOffset = Number(localStorage.getItem('devtools.scene.avatarYOffset') || String(this._avatar.yOffset || 0.0)) || 0.0; } catch { /* ignore */ }
      if (this._avatar.url && !isCharacterProfileAssetPath(this._avatar.url)) this._avatar.enabled = false;
    }

    // Restore penthouse people prefs.
    try { this._roomSim.enabled = !!Number(localStorage.getItem('devtools.scene.roomSimPeopleEnabled') || '1'); } catch { /* ignore */ }
    try { this._roomSim.url = String(localStorage.getItem('devtools.scene.roomSimPeopleUrl') || this._roomSim.url || '').trim(); } catch { /* ignore */ }
    try { this._roomSim.scale = Math.max(0.01, Number(localStorage.getItem('devtools.scene.roomSimPeopleScale') || String(this._roomSim.scale || 1.0)) || 1.0); } catch { /* ignore */ }
    try { this._roomSim.yOffset = Number(localStorage.getItem('devtools.scene.roomSimPeopleYOffset') || String(this._roomSim.yOffset || 0.0)) || 0.0; } catch { /* ignore */ }
    try { this._roomSim.maxPeople = Math.max(0, Math.min(60, Math.floor(Number(localStorage.getItem('devtools.scene.roomSimPeopleMax') || String(this._roomSim.maxPeople || 25)) || 25))); } catch { /* ignore */ }
    try { this._roomSim.hideSpawnMarkers = !!Number(localStorage.getItem('devtools.scene.roomSimHideSpawns') || (this._roomSim.hideSpawnMarkers ? '1' : '0')); } catch { /* ignore */ }

    // Restore Resume Showcase walker prefs.
    if (isResumeExport) {
      this._resumeWalker.enabled = true;
      this._resumeWalker.url = 'resume/exported-model.glb';
      this._resumeWalker.scale = 3.0;
      this._resumeWalker.yOffset = 0.0;
      this._resumeWalker.speed = 1.35;
      this._resumeWalker.radius = 5.0;
      this._resumeWalker.textureSourceUrl = 'resume/exported-model.glb';
    } else {
      try { this._resumeWalker.enabled = !!Number(localStorage.getItem('devtools.scene.resumeWalkerEnabled') || '1'); } catch { /* ignore */ }
      try { this._resumeWalker.url = String(localStorage.getItem('devtools.scene.resumeWalkerUrl') || this._resumeWalker.url || '').trim(); } catch { /* ignore */ }
      try { this._resumeWalker.scale = Math.max(0.01, Number(localStorage.getItem('devtools.scene.resumeWalkerScale') || String(this._resumeWalker.scale || 1.0)) || 1.0); } catch { /* ignore */ }
      try { this._resumeWalker.yOffset = Number(localStorage.getItem('devtools.scene.resumeWalkerYOffset') || String(this._resumeWalker.yOffset || 0.0)) || 0.0; } catch { /* ignore */ }
      try { this._resumeWalker.speed = Math.max(0.05, Number(localStorage.getItem('devtools.scene.resumeWalkerSpeed') || String(this._resumeWalker.speed || 1.35)) || 1.35); } catch { /* ignore */ }
      try { this._resumeWalker.radius = Math.max(0.25, Number(localStorage.getItem('devtools.scene.resumeWalkerRadius') || String(this._resumeWalker.radius || 5.0)) || 5.0); } catch { /* ignore */ }
      try { this._resumeWalker.textureSourceUrl = String(localStorage.getItem('devtools.scene.resumeWalkerTextureSourceUrl') || this._resumeWalker.textureSourceUrl || '').trim(); } catch { /* ignore */ }
    }

    // Auto-migrate the known "Debra rig only" asset (no animations) for people/walker helpers.
    try {
      const def = 'outputs/debra_locomotion_pack.glb';
      const norm = (s) => safeTrim(s).replace(/\\/g, '/').toLowerCase();
      const isBad = (u) => norm(u).endsWith('/outputs/debra_omniverse.glb') || norm(u).endsWith('outputs/debra_omniverse.glb');
      if (isBad(this._roomSim?.url)) this._roomSim.url = def;
      // Persist so reloads don't revert.
      try { localStorage.setItem('devtools.scene.roomSimPeopleUrl', safeTrim(this._roomSim?.url || '')); } catch { /* ignore */ }
    } catch { /* ignore */ }

    // Restore FPS prefs (proc:arena gameplay tuning)
    try {
      const n = Number(localStorage.getItem('devtools.scene.fps.enemyCount') || '6');
      if (Number.isFinite(n)) this._fpsPrefs.enemyCount = Math.max(0, Math.min(80, Math.floor(n)));
    } catch { /* ignore */ }
    try {
      const b = String(localStorage.getItem('devtools.scene.fps.enemyBehavior') || 'attack');
      const bb = (b === 'patrol' || b === 'sim') ? b : 'attack';
      this._fpsPrefs.enemyBehavior = bb;
    } catch { /* ignore */ }
    // Apply to game config
    try {
      this._game.enemy.countTarget = this._fpsPrefs.enemyCount;
      this._game.enemy.behavior = this._fpsPrefs.enemyBehavior;
    } catch { /* ignore */ }

    this._canvas = document.createElement('canvas');
    this._canvas.style.width = '100%';
    this._canvas.style.height = '100%';
    this._canvas.tabIndex = 0;
    ctx.canvasHost.appendChild(this._canvas);

    this._buildHudOverlay(ctx);

    const renderer = new THREE.WebGLRenderer({
      canvas: this._canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    // Ensure we get full GLSL compiler errors (including sources) when a shader fails.
    try {
      const dbg = renderer?.debug;
      if (dbg) {
        dbg.checkShaderErrors = true;
        dbg.onShaderError = (gl, program, glVertexShader, glFragmentShader) => {
          try {
            const withLines = (src) => String(src || '')
              .replace(/\r\n?/g, '\n')
              .split('\n')
              .map((l, i) => `${String(i + 1).padStart(4, ' ')}|${l}`)
              .join('\n');
            const pLog = program ? (gl.getProgramInfoLog(program) || '') : '';
            const vLog = glVertexShader ? (gl.getShaderInfoLog(glVertexShader) || '') : '';
            const fLog = glFragmentShader ? (gl.getShaderInfoLog(glFragmentShader) || '') : '';
            const vSrc = glVertexShader ? (gl.getShaderSource(glVertexShader) || '') : '';
            const fSrc = glFragmentShader ? (gl.getShaderSource(glFragmentShader) || '') : '';
            console.groupCollapsed('[three] shader compile/link error');
            if (pLog) console.error('ProgramInfoLog:\n' + pLog);
            if (vLog) console.error('VertexInfoLog:\n' + vLog);
            if (fLog) console.error('FragmentInfoLog:\n' + fLog);
            if (vSrc) console.log('VertexShader:\n' + withLines(vSrc));
            if (fSrc) console.log('FragmentShader:\n' + withLines(fSrc));
            console.groupEnd();
          } catch (e) {
            console.error('[three] shader error hook failed', e);
          }
        };
      }
    } catch { /* ignore */ }
    renderer.setClearColor(new THREE.Color(0x06080c), 1.0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    try { renderer.toneMapping = THREE.ACESFilmicToneMapping; } catch { /* ignore */ }
    try { renderer.toneMappingExposure = 1.0; } catch { /* ignore */ }
    try { renderer.shadowMap.enabled = true; } catch { /* ignore */ }
    try { renderer.shadowMap.type = THREE.PCFSoftShadowMap; } catch { /* ignore */ }
    this._renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x06080c);
    this._scene = scene;

    const camera = new THREE.PerspectiveCamera(70, 1, 0.03, 200000);
    camera.position.set(3, 2, 6);
    this._camera = camera;
    try { scene.add(camera); } catch { /* ignore */ }
    this._baseFov = Number(camera.fov) || 70;

    this._orbit = new OrbitControls(camera, this._canvas);
    this._orbit.enableDamping = true;
    this._orbit.dampingFactor = 0.07;
    this._orbit.target.set(0, 1, 0);

    // Pointer lock must target an element rooted in a valid Document (not a ShadowRoot subtree).
    // In devtools shells, using canvas directly can throw WrongDocumentError.
    this._pointerLockTarget = this._canvas?.ownerDocument?.body || document.body || this._canvas;
    this._plock = new PointerLockControls(camera, this._pointerLockTarget);

    // Lights
    scene.add(new THREE.HemisphereLight(0xdde8ff, 0x171e2b, 0.9));
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(6, 10, 4);
    scene.add(dir);

    // Simple player mesh (only shown in third-person on-foot).
    try {
      const g = new THREE.Group();
      g.name = 'player_viz';
      // Body: capsule-ish (cylinder + spheres).
      const bodyMat = new THREE.MeshStandardMaterial({ color: 0x7eb3ff, roughness: 0.65, metalness: 0.0 });
      const darkMat = new THREE.MeshStandardMaterial({ color: 0x1c2433, roughness: 0.9, metalness: 0.0 });
      const r = 0.25;
      const h = 1.05;
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 16, 1), bodyMat);
      cyl.position.set(0, (h * 0.5) + r, 0);
      g.add(cyl);
      const top = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), bodyMat);
      top.position.set(0, h + r, 0);
      g.add(top);
      const bot = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), bodyMat);
      bot.position.set(0, r, 0);
      g.add(bot);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 12), bodyMat);
      head.position.set(0, h + r + 0.28, 0);
      g.add(head);
      // "Nose" to show facing direction (mesh forward is -Z).
      const nose = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.10), darkMat);
      nose.position.set(0, h + r + 0.28, -0.18);
      g.add(nose);
      // Muzzle helper for third-person shooting visuals.
      const muzzle = new THREE.Object3D();
      muzzle.name = 'player_muzzle';
      muzzle.position.set(0.18, h * 0.65 + r, -0.38);
      g.add(muzzle);
      g.visible = false;
      scene.add(g);
      this._playerViz = { group: g, body: cyl, head, nose, muzzle };
    } catch { /* ignore */ }

    // Grid + axes
    this._grid = new THREE.GridHelper(40, 40, 0x3a4a64, 0x223046);
    this._grid.material.opacity = 0.6;
    this._grid.material.transparent = true;
    this._grid.visible = !!this._state.showGrid;
    scene.add(this._grid);
    scene.add(new THREE.AxesHelper(1.0));

    // Debug group for scenario markers
    this._debugGroup = new THREE.Group();
    this._debugGroup.visible = !!this._state.showDebug;
    scene.add(this._debugGroup);

    // Spawn marker
    try {
      const geo = new THREE.ConeGeometry(0.12, 0.35, 16, 1);
      const mat = new THREE.MeshStandardMaterial({ color: 0x7eb3ff, emissive: 0x173050, roughness: 0.35, metalness: 0.0 });
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = Math.PI;
      m.visible = false;
      this._spawnMarker = m;
      this._debugGroup.add(m);
    } catch { /* ignore */ }

    // Input
    window.addEventListener('keydown', this._handlers.keydown);
    window.addEventListener('keyup', this._handlers.keyup);
    try {
      this._canvas.addEventListener('mousedown', this._handlers.mousedown);
      window.addEventListener('mouseup', this._handlers.mouseup);
      this._canvas.addEventListener('contextmenu', this._handlers.contextmenu);
    } catch { /* ignore */ }

    // Resume export: enable mobile-friendly controls (tilt + touch).
    if (isResumeExport) {
      try { this._enableResumeMobileControls(); } catch { /* ignore */ }
    }

    this._buildUi();

    // Convenience: auto-import exported AC track scenarios into the "Saved scenarios" list so they
    // show up in the scenario picker without requiring a manual import click.
    try { void this._autoImportExportedTrackScenariosToSavedList(); } catch { /* ignore */ }

    // Priority load path:
    // 1) Forge inbox handoff (explicit transfer from Forge tool),
    // 2) last opened source URL / GLB URL.
    let loadedFromForgeInbox = false;
    try { loadedFromForgeInbox = await this._tryApplyForgeInbox(); } catch { /* ignore */ }
    if (!loadedFromForgeInbox) {
      const initial = safeTrim(this._state.sourceUrl) || safeTrim(this._state.lastGlbUrl);
      if (initial) {
        try {
          if (isProceduralPath(initial)) await this._loadProcedural(initial);
          else if (isGlTfExt(extOf(initial))) await this._loadGlb(initial);
        } catch { /* ignore */ }
      }
    }

    // Kick off Project Chrono WASM init in the background (devtools should still be usable).
    try {
      const disable = !!globalThis.__disableProjectChronoWasm;
      if (!disable) this._vehicleSystem?.initProjectChronoWasm?.();
    } catch { /* ignore */ }
  }

  async _autoImportExportedTrackScenariosToSavedList() {
    if (this._didAutoImportExportedTrackScenarios) return;
    this._didAutoImportExportedTrackScenarios = true;
    try {
      const resp = await fetch('/__devtools_assetto_corsa_exported_track_scenarios?limit=500', { cache: 'no-store' });
      const j = await resp.json();
      if (!j?.ok) return;
      const items = Array.isArray(j?.items) ? j.items : [];
      if (!items.length) return;
      let imported = 0;
      // Import a small batch (newest first). Each import is idempotent by scenario name.
      const maxImport = 25;
      for (const it of items.slice(0, maxImport)) {
        const rel = safeTrim(it?.scenarioRel || '');
        if (!rel) continue;
        const url = rel.startsWith('/') ? rel : `/${rel.replace(/^\/+/, '')}`;
        let sc = null;
        try {
          const sr = await fetch(url, { cache: 'no-store' });
          if (!sr.ok) continue;
          sc = await sr.json();
        } catch { sc = null; }
        if (!sc || typeof sc !== 'object') continue;
        try {
          this._importScenarioWithOptions(sc, { prepend: false, source: 'exported_track', maxKeep: 80 });
          imported += 1;
        } catch { /* ignore */ }
      }
      if (imported) {
        try { this._buildUi(); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  async unmount() {
    try { this._closeCreateSceneModal(); } catch { /* ignore */ }
    try { this._disableResumeMobileControls?.(); } catch { /* ignore */ }
    try { window.removeEventListener('keydown', this._handlers.keydown); } catch { /* ignore */ }
    try { window.removeEventListener('keyup', this._handlers.keyup); } catch { /* ignore */ }
    try { window.removeEventListener('mouseup', this._handlers.mouseup); } catch { /* ignore */ }
    try { this._canvas?.removeEventListener?.('mousedown', this._handlers.mousedown); } catch { /* ignore */ }
    try { this._canvas?.removeEventListener?.('contextmenu', this._handlers.contextmenu); } catch { /* ignore */ }

    try { this._plock?.unlock?.(); } catch { /* ignore */ }
    try { this._orbit?.dispose?.(); } catch { /* ignore */ }
    try { this._renderer?.dispose?.(); } catch { /* ignore */ }
    try { this._clearWorld(); } catch { /* ignore */ }
    try { this._disposeThirdPersonAvatar(); } catch { /* ignore */ }
    try { this._disposeRoomSimPeople(); } catch { /* ignore */ }
    try {
      if (this._debugGroup && this._scene) this._scene.remove(this._debugGroup);
      disposeThreeObject(this._spawnMarker);
      disposeThreeObject(this._debugGroup);
    } catch { /* ignore */ }

    this._orbit = null;
    this._plock = null;
    this._renderer = null;
    this._scene = null;
    this._camera = null;
    this._ctx = null;
    this._root = null;

    if (this._canvas?.parentNode) this._canvas.parentNode.removeChild(this._canvas);
    this._canvas = null;

    try { this._hudOverlay?.parentNode?.removeChild(this._hudOverlay); } catch { /* ignore */ }
    this._hudOverlay = null;
    try { this._hideResumeProjectPanel(); } catch { /* ignore */ }
    try { this._resumeShowcase?.panelRoot?.parentNode?.removeChild?.(this._resumeShowcase.panelRoot); } catch { /* ignore */ }
    if (this._resumeShowcase) {
      this._resumeShowcase.panelRoot = null;
      this._resumeShowcase.panelTitle = null;
      this._resumeShowcase.panelMeta = null;
      this._resumeShowcase.panelDesc = null;
      this._resumeShowcase.panelReadme = null;
      this._resumeShowcase.panelOpenRepoBtn = null;
      this._resumeShowcase.panelOpenDemoBtn = null;
    }
    this._hudEls = { root: null, crosshair: null, topLeft: null, msg: null, hit: null };
    this._gun = { group: null, muzzle: null, recoil: 0, recoilKick: 0, sway: 0 };
    try { disposeThreeObject(this._playerViz?.group); } catch { /* ignore */ }
    this._playerViz = { group: null, body: null, head: null, nose: null, muzzle: null };
  }

  getStats() {
    const w = this._weapon();
    return {
      mode: this._state.mode,
      fly: this._state.fly ? '1' : '0',
      locked: this._plock?.isLocked ? '1' : '0',
      src: safeTrim(this._state.sourceUrl || ''),
      hp: String(this._game?.player?.hp ?? ''),
      weapon: String(w?.name || ''),
      ammo: String(w ? `${w.ammoInMag}/${w.reserve}` : ''),
    };
  }

  _closeCreateSceneModal() {
    const m = this._createSceneModal;
    if (!m) return;
    try {
      if (m.escHandler) {
        document.removeEventListener('keydown', m.escHandler);
        m.escHandler = null;
      }
      if (m.outsideClickHandler) {
        m.overlay?.removeEventListener?.('click', m.outsideClickHandler);
        m.outsideClickHandler = null;
      }
      if (m.overlay?.parentNode) m.overlay.parentNode.removeChild(m.overlay);
    } catch { /* ignore */ }
    m.overlay = null;
  }

  _createBlankGroundScene({
    groundSize = 80,
    addPerimeterWalls = true,
    wallHeight = 3.2,
    includePhysics = true,
    includeCollision = true,
    includeLocomotion = true,
    includeWeapons = false,
    includeInteractions = true,
    includeEnemies = false,
    includeVehicles = false,
    worldName = '',
    worldTheme = 'neutral',
    gameplayGoal = '',
    playerSpeed = 6.0,
    sprintSpeed = 11.0,
    addStarterWaypoints = true,
    addStarterGoalTrigger = true,
    mapStartMode = 'flat',
    quickMapDensity = 'balanced',
    characterStartMode = 'pill',
    characterModelUrl = '',
    characterModelScale = 3.0,
    characterModelYOffset = 0.0,
  } = {}) {
    if (!this._scene || !this._camera) return;

    this._pendingScenario = null;
    this._setSourceUrl('');
    try { if (this._ui.sourceInput) this._ui.sourceInput.value = ''; } catch { /* ignore */ }
    try { if (this._ui.scenarioSel) this._ui.scenarioSel.value = ''; } catch { /* ignore */ }
    try { if (this._ui.scenarioName) this._ui.scenarioName.value = ''; } catch { /* ignore */ }
    this._scenarioContent = { waypoints: [], triggers: [], meta: { avatarProfile: '', avatarAction: '' } };
    this._clearWorld();

    const size = Math.max(20, Math.min(400, Number(groundSize) || 80));
    const theme = getWorldThemePreset(worldTheme);
    const root = new THREE.Group();
    root.name = 'procedural_blank_ground';

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size, 1, 1),
      new THREE.MeshStandardMaterial({ color: Number(theme.groundColor) || 0x131a24, roughness: 0.96, metalness: 0.0 }),
    );
    ground.name = 'ground_base';
    ground.rotation.x = -Math.PI * 0.5;
    ground.receiveShadow = true;
    root.add(ground);

    const walls = [];
    if (addPerimeterWalls) {
      const h = Math.max(1.2, Math.min(12, Number(wallHeight) || 3.2));
      const t = 0.9;
      const half = size * 0.5;
      const wallMat = new THREE.MeshStandardMaterial({ color: Number(theme.wallColor) || 0x304058, roughness: 0.88, metalness: 0.0 });
      const mkWall = (w, d, x, z) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
        m.position.set(x, h * 0.5, z);
        m.castShadow = false;
        m.receiveShadow = true;
        m.userData = m.userData || {};
        m.userData.isObstacle = true;
        m.name = 'wall_collision';
        root.add(m);
        walls.push(m);
      };
      mkWall(size + t * 2, t, 0, -half - t * 0.5);
      mkWall(size + t * 2, t, 0, half + t * 0.5);
      mkWall(t, size, -half - t * 0.5, 0);
      mkWall(t, size, half + t * 0.5, 0);
    }

    this._worldRoot = root;
    this._proc = { kind: 'blank_ground', root };
    this._scene.add(root);
    this._colliders = [root];
    this._obstacleSources = [];
    this._obstacleBoxes = [];
    if (includeCollision && walls.length) {
      this._obstacleSources.push(...walls);
      this._rebuildObstacleBoxesFromSources();
    } else {
      try { this._vehicleSystem?.syncStatics?.(); } catch { /* ignore */ }
    }

    this._spawn = { x: 0, y: 0, z: Math.max(5, size * 0.24) };
    this._player.x = this._spawn.x;
    this._player.y = this._spawn.y;
    this._player.z = this._spawn.z;
    this._player.vy = 0;
    this._applyFpsCameraPose({ yaw: Math.PI, pitch: 0, eyeH: Number(this._player.eyeH) || 1.7, syncPosition: true });

    this._state.fly = includePhysics ? false : true;
    this._state.mode = includeLocomotion ? 'fps' : 'orbit';
    this._state.speed = Math.max(0.1, Number(playerSpeed) || 6.0);
    this._state.sprint = Math.max(0.1, Number(sprintSpeed) || 11.0);
    this._savePrefs();
    this._syncModeUi();
    if (this._state.mode === 'orbit') {
      try {
        this._camera.position.set(size * 0.24, Math.max(8, size * 0.12), size * 0.24);
        this._orbit?.target?.set?.(0, 0.5, 0);
        this._orbit?.update?.();
      } catch { /* ignore */ }
    }

    this._game.enabled = !!includeWeapons;
    this._enemies = [];
    try { this._vehicleSystem?.resetForWorldClear?.(); } catch { /* ignore */ }
    if (this._game.enabled) {
      this._resetGame();
      this._ensureGunRig();
      if (includeEnemies) this._spawnDefaultEnemies();
      if (includeVehicles) this._vehicleSystem?.spawnDefaultVehicles?.();
    } else {
      this._clearGun();
    }

    if (includeInteractions) {
      this._addTriggerAtCurrent({
        name: 'Welcome trigger',
        type: 'message',
        once: false,
        message: safeTrim(gameplayGoal) || 'Welcome. Use Edit scene to build your map and add gameplay content.',
        requireInteract: true,
        prompt: 'Start',
        size: { x: 3, y: 2, z: 3 },
      });
    }

    if (addStarterWaypoints) {
      this._addWaypointFromCurrent('Start');
      const nextName = this._uniqueWaypointName('Objective zone');
      this._scenarioContent.waypoints.push({
        name: nextName,
        x: Number(this._spawn.x) || 0,
        y: Number(this._spawn.y) || 0,
        z: (Number(this._spawn.z) || 0) - Math.max(8, size * 0.18),
      });
    }
    if (addStarterGoalTrigger) {
      this._scenarioContent.triggers.push({
        id: crypto?.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2),
        name: 'Objective',
        type: 'goal',
        once: true,
        requireInteract: true,
        prompt: 'Complete objective',
        center: { x: Number(this._spawn.x) || 0, y: (Number(this._spawn.y) || 0) + 1.0, z: (Number(this._spawn.z) || 0) - Math.max(8, size * 0.18) },
        size: { x: 4, y: 2, z: 4 },
        goal: true,
      });
    }

    if (safeTrim(mapStartMode) === 'quick_build') {
      this._seedQuickStartMapLayout({ size, density: quickMapDensity });
    }

    if (safeTrim(characterStartMode) === 'model') {
      const modelUrl = safeTrim(characterModelUrl);
      if (modelUrl && !isCharacterProfileAssetPath(modelUrl)) {
        this._avatar.enabled = false;
        this._routeModelToPropAsset(modelUrl, 'new world character accepts saved profile JSON only');
        try { this._disposeThirdPersonAvatar(); } catch { /* ignore */ }
      } else {
        this._avatar.enabled = true;
        if (modelUrl) this._avatar.url = modelUrl;
        this._avatar.scale = Math.max(0.01, Number(characterModelScale) || Number(this._avatar.scale) || 3.0);
        this._avatar.yOffset = Number(characterModelYOffset) || 0.0;
        try { void this._loadThirdPersonAvatar({ force: true }); } catch { /* ignore */ }
      }
    } else {
      this._avatar.enabled = false;
      try { this._disposeThirdPersonAvatar(); } catch { /* ignore */ }
    }
    this._savePrefs();

    try {
      if (this._scene) {
        const fogDensity = Math.max(0, Math.min(0.06, Number(theme.fogDensity) || 0));
        this._scene.fog = fogDensity > 0
          ? new THREE.FogExp2(Number(theme.fogColor) || 0x0a0e16, fogDensity)
          : null;
      }
    } catch { /* ignore */ }

    const worldNameFinal = safeTrim(worldName) || `My ${safeTrim(getWorldThemePreset(worldTheme).label) || 'New'} World`;
    try { if (this._ui.scenarioName) this._ui.scenarioName.value = worldNameFinal; } catch { /* ignore */ }
    try { if (this._ui.speedInput) this._ui.speedInput.value = String(this._state.speed); } catch { /* ignore */ }

    this._syncSpawnMarker();
    this._renderWaypointsUi();
    this._renderTriggersUi();
    this._renderObjectivesUi();
    this._rebuildScenarioDebug();
    this._scanTaggedBuildings();
    this._renderBuildingsUi();
    this._renderBuildingEditorUi();
    this._renderPropsUi();
    this._setStatus(`Created "${worldNameFinal}" (${safeTrim(mapStartMode) === 'quick_build' ? 'quick-built map' : 'flat map'}). Next: add buildings/props, tune triggers, save scenario, then press Play.`);
  }

  _openCreateSceneModal() {
    this._closeCreateSceneModal();
    if (!this._root) return;

    // Exit active play state and open a dedicated creation flow.
    try { this._plock?.unlock?.(); } catch { /* ignore */ }
    try {
      this._state.mode = 'orbit';
      this._savePrefs();
      this._syncModeUi();
    } catch { /* ignore */ }

    ensureDefaultScenarios(this);

    const state = {
      step: 1,
      mode: 'new', // new | existing
      existingType: 'saved', // saved | path | procedural | exported_tracks
      savedScenarioIdx: '',
      sourcePath: safeTrim(this._state.sourceUrl),
      proceduralKind: 'arena', // arena | drift_track | penthouse_room_sim | resume_showcase
      exportedTracks: {
        loading: false,
        loadedAtMs: 0,
        status: '',
        items: [],
        selectedScenarioRel: '',
      },
      templateKind: 'sandbox',
      includePhysics: true,
      includeCollision: true,
      includeLocomotion: true,
      includeWeapons: false,
      includeInteractions: true,
      includeEnemies: false,
      includeVehicles: false,
      worldName: 'My New World',
      worldTheme: 'neutral',
      gameplayGoal: 'Explore and build your world.',
      playerSpeed: 6.0,
      sprintSpeed: 11.0,
      groundSize: 80,
      addPerimeterWalls: true,
      wallHeight: 3.2,
      addStarterWaypoints: true,
      addStarterGoalTrigger: true,
      mapStartMode: 'flat',
      quickMapDensity: 'balanced',
      characterStartMode: 'pill', // pill | model
      characterModelUrl: safeTrim(this._avatar?.url || ''),
      characterModelScale: Number(this._avatar?.scale) || 3.0,
      characterModelYOffset: Number(this._avatar?.yOffset) || 0.0,
    };
    const applyTemplatePreset = (kind) => {
      const key = safeTrim(kind) || 'sandbox';
      const tpl = getWorldTemplatePreset(key);
      state.templateKind = key;
      state.includePhysics = !!tpl.includePhysics;
      state.includeCollision = !!tpl.includeCollision;
      state.includeLocomotion = !!tpl.includeLocomotion;
      state.includeWeapons = !!tpl.includeWeapons;
      state.includeInteractions = !!tpl.includeInteractions;
      state.includeEnemies = !!tpl.includeEnemies;
      state.includeVehicles = !!tpl.includeVehicles;
      state.groundSize = Math.max(20, Math.min(400, Number(tpl.groundSize) || state.groundSize));
      state.addPerimeterWalls = !!tpl.addPerimeterWalls;
      state.wallHeight = Math.max(1.2, Math.min(12, Number(tpl.wallHeight) || state.wallHeight));
      state.worldTheme = safeTrim(tpl.worldTheme) || state.worldTheme;
      state.playerSpeed = Math.max(0.1, Number(tpl.playerSpeed) || state.playerSpeed);
      state.sprintSpeed = Math.max(0.1, Number(tpl.sprintSpeed) || state.sprintSpeed);
      state.gameplayGoal = safeTrim(tpl.gameplayGoal) || state.gameplayGoal;
      state.mapStartMode = safeTrim(tpl.mapStartMode) || state.mapStartMode;
      state.quickMapDensity = safeTrim(tpl.quickMapDensity) || state.quickMapDensity;
      state.characterStartMode = safeTrim(tpl.characterStartMode) || state.characterStartMode;
    };
    applyTemplatePreset(state.templateKind);

    const close = () => this._closeCreateSceneModal();

    const asScenarioUrl = (relOrUrl) => {
      const s = safeTrim(relOrUrl).replace(/\\/g, '/');
      if (!s) return '';
      if (s.startsWith('http://') || s.startsWith('https://')) return s;
      // Keep absolute-from-origin URLs (served by Vite) stable.
      if (s.startsWith('/')) return normalizeAssetUrl(s);
      return normalizeAssetUrl(`/${s}`);
    };

    const loadScenarioFromUrl = async (scenarioUrl, { importScenario = true } = {}) => {
      const u = safeTrim(scenarioUrl);
      if (!u) throw new Error('Missing scenarioUrl');
      const resp = await fetch(u, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`Scenario fetch failed: HTTP ${resp.status}`);
      const sc = await resp.json();
      if (!sc || typeof sc !== 'object') throw new Error('Scenario JSON invalid');
      if (importScenario) this._importScenario(sc);
      const p = safeTrim(sc?.path);
      if (!p) throw new Error('Scenario missing path');
      this._pendingScenario = sc;
      this._setSourceUrl(p);
      try { if (this._ui?.sourceInput) this._ui.sourceInput.value = p; } catch { /* ignore */ }
      if (isProceduralPath(p)) { await this._loadProcedural(p, { scenario: sc }); return; }
      if (isGlTfExt(extOf(p))) { await this._loadGlb(p, { scenario: sc }); return; }
      throw new Error('Scenario path is not GLB/GLTF or proc:*');
    };

    const refreshExportedTracks = async () => {
      if (state.exportedTracks.loading) return;
      state.exportedTracks.loading = true;
      state.exportedTracks.status = 'Scanning exported tracks…';
      try {
        const resp = await fetch('/__devtools_assetto_corsa_exported_track_scenarios?limit=1000', { cache: 'no-store' });
        const j = await resp.json();
        if (!j?.ok) throw new Error(String(j?.error || 'scan failed'));
        const items = Array.isArray(j?.items) ? j.items : [];
        state.exportedTracks.items = items;
        state.exportedTracks.loadedAtMs = Date.now();
        state.exportedTracks.status = `Found ${items.length} exported track scenario(s).`;
        // Keep selection if still present; otherwise pick the newest.
        const sel = safeTrim(state.exportedTracks.selectedScenarioRel || '');
        const still = sel && items.some((it) => safeTrim(it?.scenarioRel) === sel);
        if (!still) state.exportedTracks.selectedScenarioRel = safeTrim(items?.[0]?.scenarioRel || '');
      } catch (e) {
        state.exportedTracks.items = [];
        state.exportedTracks.status = `Scan failed: ${String(e?.message || e)}`;
      } finally {
        state.exportedTracks.loading = false;
        try { render(); } catch { /* ignore */ }
      }
    };

    const overlay = el('div', {
      style: {
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'center',
        padding: '18px',
        background: 'rgba(0,0,0,0.68)',
        backdropFilter: 'blur(8px)',
      },
    });
    const panel = el('div', {
      style: {
        width: 'min(980px, calc(100vw - 20px))',
        maxHeight: 'calc(100vh - 20px)',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: '16px',
        border: '1px solid rgba(255,255,255,0.16)',
        background: 'linear-gradient(180deg, rgba(14,18,28,0.98), rgba(8,10,15,0.98))',
        boxShadow: '0 24px 80px rgba(0,0,0,0.55)',
        overflow: 'hidden',
      },
    });
    const bodyHost = el('div', { style: { flex: '1', overflow: 'auto', padding: '16px 20px 12px 20px' } }, []);
    const navHost = el('div', {
      style: {
        borderTop: '1px solid rgba(255,255,255,0.09)',
        padding: '12px 16px',
        display: 'flex',
        gap: '8px',
        alignItems: 'center',
        background: 'rgba(255,255,255,0.02)',
      },
    }, []);

    const runCreate = async () => {
      if (state.mode === 'existing') {
        close();
        if (state.existingType === 'saved') {
          await this._loadSavedScenarioByIndex(state.savedScenarioIdx);
          return;
        }
        if (state.existingType === 'exported_tracks') {
          const rel = safeTrim(state.exportedTracks?.selectedScenarioRel || '');
          if (!rel) throw new Error('Pick an exported track scenario first.');
          const u = asScenarioUrl(rel);
          await loadScenarioFromUrl(u, { importScenario: true });
          return;
        }
        if (state.existingType === 'procedural') {
          const p = `proc:${safeTrim(state.proceduralKind) || 'arena'}`;
          this._setSourceUrl(p);
          try { if (this._ui.sourceInput) this._ui.sourceInput.value = p; } catch { /* ignore */ }
          await this._loadProcedural(p);
          return;
        }
        const p = safeTrim(state.sourcePath);
        if (!p) { this._setStatus('Enter a scene path first.'); return; }
        this._setSourceUrl(p);
        try { if (this._ui.sourceInput) this._ui.sourceInput.value = p; } catch { /* ignore */ }
        if (isProceduralPath(p)) { await this._loadProcedural(p); return; }
        if (!isGlTfExt(extOf(p))) {
          this._setStatus('Load expects .glb/.gltf. For USD/FBX use Convert first.');
          return;
        }
        await this._loadGlb(p);
        return;
      }

      close();
      this._createBlankGroundScene({
        groundSize: state.groundSize,
        addPerimeterWalls: !!state.addPerimeterWalls,
        wallHeight: state.wallHeight,
        includePhysics: !!state.includePhysics,
        includeCollision: !!state.includeCollision,
        includeLocomotion: !!state.includeLocomotion,
        includeWeapons: !!state.includeWeapons,
        includeInteractions: !!state.includeInteractions,
        includeEnemies: !!state.includeEnemies && !!state.includeWeapons,
        includeVehicles: !!state.includeVehicles && !!state.includeWeapons,
        worldName: state.worldName,
        worldTheme: state.worldTheme,
        gameplayGoal: state.gameplayGoal,
        playerSpeed: state.playerSpeed,
        sprintSpeed: state.sprintSpeed,
        addStarterWaypoints: !!state.addStarterWaypoints,
        addStarterGoalTrigger: !!state.addStarterGoalTrigger,
        mapStartMode: state.mapStartMode,
        quickMapDensity: state.quickMapDensity,
        characterStartMode: state.characterStartMode,
        characterModelUrl: state.characterModelUrl,
        characterModelScale: state.characterModelScale,
        characterModelYOffset: state.characterModelYOffset,
      });
    };

    const render = () => {
      clear(bodyHost);
      clear(navHost);

      const mkStepBtn = (idx, label) => el('button', {
        class: state.step === idx ? 'primary' : '',
        onclick: () => { state.step = idx; render(); },
        style: { fontSize: '11px', padding: '6px 10px' },
      }, [label]);

      bodyHost.appendChild(el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap', marginBottom: '14px' } }, [
        mkStepBtn(1, '1. Source'),
        mkStepBtn(2, '2. World setup'),
        mkStepBtn(3, '3. Starter map'),
        mkStepBtn(4, '4. Character'),
        mkStepBtn(5, '5. Review'),
      ]));
      bodyHost.appendChild(el('div', { class: 'muted', style: { fontSize: '10px', marginTop: '-4px', marginBottom: '8px' } }, [`Step ${state.step} of 5`]));

      if (state.step === 1) {
        const modeCard = (title, selected, onClick, subtitle) => el('button', {
          onclick: onClick,
          class: selected ? 'primary' : '',
          style: {
            textAlign: 'left',
            padding: '12px',
            borderRadius: '10px',
            border: selected ? '1px solid rgba(91,154,255,0.45)' : '1px solid rgba(255,255,255,0.10)',
            background: selected ? 'rgba(91,154,255,0.13)' : 'rgba(255,255,255,0.03)',
          },
        }, [
          el('div', { style: { fontWeight: '650', fontSize: '13px' } }, [title]),
          el('div', { class: 'muted', style: { marginTop: '4px', fontSize: '10px' } }, [subtitle]),
        ]);
        bodyHost.appendChild(el('div', { class: 'dockTitle' }, ['Step 1: Choose source']));
        bodyHost.appendChild(el('div', { class: 'muted', style: { marginTop: '4px' } }, ['Start from scratch with Easy World Builder, or open a saved/procedural/existing scene.']));
        bodyHost.appendChild(el('div', {
          style: { marginTop: '10px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px' },
        }, [
          modeCard('Create a new world (recommended)', state.mode === 'new', () => { state.mode = 'new'; render(); }, 'Guided setup with templates, systems, and starter gameplay variables.'),
          modeCard('Open existing scene', state.mode === 'existing', () => { state.mode = 'existing'; render(); }, 'Load saved scenarios, procedural presets, or a GLB/GLTF path.'),
        ]));

        if (state.mode === 'existing') {
          bodyHost.appendChild(el('div', { class: 'separator', style: { marginTop: '12px' } }, []));
          bodyHost.appendChild(el('div', { class: 'fieldLabel' }, ['Existing scene source']));
          bodyHost.appendChild(el('select', {
            value: state.existingType,
            onchange: (e) => { state.existingType = String(e.target.value || 'saved'); render(); },
          }, [
            el('option', { value: 'saved' }, ['Saved scenario']),
            el('option', { value: 'exported_tracks' }, ['Exported tracks (auto-discovered)']),
            el('option', { value: 'path' }, ['Path (GLB/GLTF or proc:*)']),
            el('option', { value: 'procedural' }, ['Procedural preset']),
          ]));
          if (state.existingType === 'saved') {
            const list = this._loadScenarioList();
            bodyHost.appendChild(el('div', { class: 'fieldLabel', style: { marginTop: '10px' } }, ['Saved scenario']));
            bodyHost.appendChild(el('select', {
              value: String(state.savedScenarioIdx || ''),
              onchange: (e) => { state.savedScenarioIdx = String(e.target.value || ''); },
            }, [
              el('option', { value: '' }, ['Select saved scenario…']),
              ...list.map((it, i) => el('option', { value: String(i) }, [safeTrim(it?.name) || `Scenario ${i + 1}`])),
            ]));
          } else if (state.existingType === 'exported_tracks') {
            // Auto-scan once when the user opens this panel.
            if (!state.exportedTracks.loadedAtMs && !state.exportedTracks.loading) {
              void refreshExportedTracks();
            }
            bodyHost.appendChild(el('div', { class: 'fieldLabel', style: { marginTop: '10px' } }, ['Exported track scenario']));
            bodyHost.appendChild(el('div', { class: 'muted', style: { marginTop: '4px', fontSize: '10px' } }, [
              'Auto-discovers track exports under assets/generated/assetto_corsa/tracks/*/*/scene.scenario.json.',
            ]));

            const items = Array.isArray(state.exportedTracks.items) ? state.exportedTracks.items : [];
            const sel = el('select', {
              value: safeTrim(state.exportedTracks.selectedScenarioRel || ''),
              onchange: (e) => { state.exportedTracks.selectedScenarioRel = String(e.target.value || ''); },
            }, [
              el('option', { value: '' }, ['Select exported track…']),
              ...items.map((it) => {
                const rel = safeTrim(it?.scenarioRel || '');
                const name = safeTrim(it?.name || '') || safeTrim(it?.trackId || '') || '(unnamed track)';
                const runId = safeTrim(it?.runId || '');
                const label = runId ? `${name} (${runId})` : name;
                return el('option', { value: rel }, [label]);
              }),
            ]);
            bodyHost.appendChild(sel);
            bodyHost.appendChild(el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
              el('button', {
                class: 'primary',
                onclick: async () => {
                  try {
                    const rel = safeTrim(state.exportedTracks.selectedScenarioRel || '');
                    if (!rel) throw new Error('Pick an exported track scenario first.');
                    close();
                    await loadScenarioFromUrl(asScenarioUrl(rel), { importScenario: true });
                    this._ctx?.toast?.('Loaded exported track scenario', 'success', { title: 'Scene' });
                  } catch (e) {
                    this._ctx?.toast?.(String(e?.message || e || 'Load failed'), 'error', { title: 'Scene' });
                  }
                },
                disabled: !safeTrim(state.exportedTracks.selectedScenarioRel || ''),
                title: 'Imports into Saved scenarios and loads it immediately',
              }, ['Import + load now']),
              el('button', {
                onclick: () => { void refreshExportedTracks(); },
                disabled: !!state.exportedTracks.loading,
                title: 'Re-scan exported track scenarios',
              }, [state.exportedTracks.loading ? 'Scanning…' : 'Refresh list']),
            ]));
            bodyHost.appendChild(el('div', { class: 'muted', style: { marginTop: '6px', fontSize: '10px', whiteSpace: 'pre-wrap' } }, [
              safeTrim(state.exportedTracks.status || ''),
              state.exportedTracks.loadedAtMs ? `\nLoaded: ${new Date(state.exportedTracks.loadedAtMs).toLocaleString()}` : '',
            ].join('').trim()));
          } else if (state.existingType === 'procedural') {
            bodyHost.appendChild(el('div', { class: 'fieldLabel', style: { marginTop: '10px' } }, ['Preset']));
            bodyHost.appendChild(el('select', {
              value: state.proceduralKind,
              onchange: (e) => { state.proceduralKind = String(e.target.value || 'arena'); },
            }, [
              el('option', { value: 'arena' }, ['proc:arena']),
              el('option', { value: 'drift_track' }, ['proc:drift_track']),
              el('option', { value: 'penthouse_room_sim' }, ['proc:penthouse_room_sim']),
              el('option', { value: 'resume_showcase' }, ['proc:resume_showcase']),
            ]));
          } else {
            bodyHost.appendChild(el('div', { class: 'fieldLabel', style: { marginTop: '10px' } }, ['Path']));
            bodyHost.appendChild(el('input', {
              value: state.sourcePath,
              placeholder: `${SCENE_ASSET_LOCATIONS.generatedScenes}scene.glb or proc:arena`,
              oninput: (e) => { state.sourcePath = String(e.target.value || ''); },
            }));
          }
        }
      } else if (state.step === 2) {
        if (state.mode !== 'new') {
          bodyHost.appendChild(el('div', { class: 'dockTitle' }, ['Step 2: World setup']));
          bodyHost.appendChild(el('div', { class: 'infoBanner', style: { marginTop: '8px' } }, [
            el('div', { class: 'infoIcon' }, ['i']),
            el('div', {}, ['World setup applies to New blank scene mode only. Existing scenes keep their current configuration.']),
          ]));
          gotoNav();
          return;
        }
        const checkboxRow = (label, key, hint = '') => el('label', {
          class: 'row',
          style: { gap: '10px', alignItems: 'center', padding: '10px 12px', border: '1px solid rgba(255,255,255,0.09)', borderRadius: '8px', background: 'rgba(255,255,255,0.02)' },
        }, [
          el('input', {
            type: 'checkbox',
            checked: !!state[key],
            disabled: (key === 'includeEnemies' || key === 'includeVehicles') && !state.includeWeapons,
            onchange: (e) => {
              state[key] = !!e.target.checked;
              if (key === 'includeWeapons' && !state.includeWeapons) {
                state.includeEnemies = false;
                state.includeVehicles = false;
              }
              render();
            },
          }),
          el('div', {}, [
            el('div', { style: { fontWeight: '600', fontSize: '12px' } }, [label]),
            hint ? el('div', { class: 'muted', style: { fontSize: '10px' } }, [hint]) : null,
          ].filter(Boolean)),
        ]);
        const templateCard = (key, tpl) => el('button', {
          class: state.templateKind === key ? 'primary' : '',
          onclick: () => { applyTemplatePreset(key); render(); },
          style: {
            textAlign: 'left',
            padding: '12px',
            borderRadius: '10px',
            border: state.templateKind === key ? '1px solid rgba(91,154,255,0.45)' : '1px solid rgba(255,255,255,0.10)',
            background: state.templateKind === key ? 'rgba(91,154,255,0.13)' : 'rgba(255,255,255,0.03)',
          },
        }, [
          el('div', { style: { fontWeight: '650', fontSize: '12px' } }, [safeTrim(tpl.label) || key]),
          el('div', { class: 'muted', style: { marginTop: '4px', fontSize: '10px', lineHeight: '1.35' } }, [safeTrim(tpl.blurb) || '']),
        ]);

        bodyHost.appendChild(el('div', { class: 'dockTitle' }, ['Step 2: World setup']));
        bodyHost.appendChild(el('div', { class: 'muted', style: { marginTop: '4px' } }, ['Pick a template, then tune your world variables and game systems.']));
        bodyHost.appendChild(el('div', { class: 'fieldLabel', style: { marginTop: '10px' } }, ['World template']));
        bodyHost.appendChild(el('div', {
          style: { marginTop: '8px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '8px' },
        }, Object.entries(WORLD_TEMPLATE_PRESETS).map(([key, tpl]) => templateCard(key, tpl))));
        bodyHost.appendChild(el('div', { style: { marginTop: '12px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px' } }, [
          el('div', { class: 'card', style: { marginTop: '0', padding: '12px' } }, [
            el('div', { class: 'fieldLabel', style: { marginTop: '0' } }, ['World name']),
            el('input', {
              value: state.worldName,
              placeholder: 'e.g. Neon Freight District',
              oninput: (e) => { state.worldName = String(e.target.value || ''); },
            }),
            el('div', { class: 'fieldLabel', style: { marginTop: '8px' } }, ['World theme']),
            el('select', {
              value: state.worldTheme,
              onchange: (e) => { state.worldTheme = String(e.target.value || 'neutral'); },
            }, Object.entries(WORLD_THEME_PRESETS).map(([key, cfg]) => el('option', { value: key }, [safeTrim(cfg?.label) || key]))),
            el('div', { class: 'fieldLabel', style: { marginTop: '8px' } }, ['Gameplay goal']),
            el('input', {
              value: state.gameplayGoal,
              placeholder: 'What should players do first?',
              oninput: (e) => { state.gameplayGoal = String(e.target.value || ''); },
            }),
          ]),
          el('div', { class: 'card', style: { marginTop: '0', padding: '12px' } }, [
            el('div', { class: 'fieldLabel', style: { marginTop: '0' } }, ['Player speed']),
            el('input', {
              value: String(state.playerSpeed),
              onchange: (e) => { state.playerSpeed = Math.max(0.1, Math.min(20, Number(e.target.value) || state.playerSpeed)); },
            }),
            el('div', { class: 'fieldLabel', style: { marginTop: '8px' } }, ['Sprint speed']),
            el('input', {
              value: String(state.sprintSpeed),
              onchange: (e) => { state.sprintSpeed = Math.max(0.1, Math.min(30, Number(e.target.value) || state.sprintSpeed)); },
            }),
            el('div', { class: 'muted', style: { marginTop: '6px', fontSize: '10px' } }, ['Movement values are applied directly in the main viewer controls.']),
          ]),
        ]));
        bodyHost.appendChild(el('div', { class: 'fieldLabel', style: { marginTop: '8px' } }, ['Systems']));
        bodyHost.appendChild(el('div', {
          style: { marginTop: '10px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '8px' },
        }, [
          checkboxRow('Physics (gravity movement)', 'includePhysics', 'Disable for fly-first setup.'),
          checkboxRow('Collision', 'includeCollision', 'Adds perimeter collision walls if enabled in map step.'),
          checkboxRow('Locomotion (FPS controls)', 'includeLocomotion', 'Disable to start in orbit/editor mode.'),
          checkboxRow('Weapons', 'includeWeapons', 'Enables combat HUD and weapon handling.'),
          checkboxRow('Interactions', 'includeInteractions', 'Adds a starter interaction trigger.'),
          checkboxRow('Spawn enemy targets', 'includeEnemies', 'Only used when Weapons is enabled.'),
          checkboxRow('Spawn driveable vehicles', 'includeVehicles', 'Only used when Weapons is enabled.'),
        ]));
      } else if (state.step === 3) {
        if (state.mode !== 'new') {
          bodyHost.appendChild(el('div', { class: 'dockTitle' }, ['Step 3: Starter map']));
          bodyHost.appendChild(el('div', { class: 'infoBanner', style: { marginTop: '8px' } }, [
            el('div', { class: 'infoIcon' }, ['i']),
            el('div', {}, ['Starter map options are used for New blank scene mode. Open existing scene loads your chosen source directly.']),
          ]));
          gotoNav();
          return;
        }
        const mapCard = (mode, title, subtitle) => el('button', {
          class: state.mapStartMode === mode ? 'primary' : '',
          onclick: () => { state.mapStartMode = mode; render(); },
          style: {
            textAlign: 'left',
            padding: '12px',
            borderRadius: '10px',
            border: state.mapStartMode === mode ? '1px solid rgba(91,154,255,0.45)' : '1px solid rgba(255,255,255,0.10)',
            background: state.mapStartMode === mode ? 'rgba(91,154,255,0.13)' : 'rgba(255,255,255,0.03)',
          },
        }, [
          el('div', { style: { fontWeight: '650', fontSize: '12px' } }, [title]),
          el('div', { class: 'muted', style: { marginTop: '4px', fontSize: '10px', lineHeight: '1.35' } }, [subtitle]),
        ]);
        bodyHost.appendChild(el('div', { class: 'dockTitle' }, ['Step 3: Map setup']));
        bodyHost.appendChild(el('div', { class: 'muted', style: { marginTop: '4px' } }, ['Choose a flat map or let the wizard quickly build a starter map for you.']));
        bodyHost.appendChild(el('div', { class: 'fieldLabel', style: { marginTop: '10px' } }, ['How should we start your map?']));
        bodyHost.appendChild(el('div', {
          style: { marginTop: '8px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '8px' },
        }, [
          mapCard('flat', 'Flat plane map', 'Simple open ground so you can build everything from scratch.'),
          mapCard('quick_build', 'Quick build map', 'Auto-places a starter layout with building blocks so you can play immediately.'),
        ]));
        bodyHost.appendChild(el('div', { style: { marginTop: '12px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px' } }, [
          el('div', { class: 'card', style: { marginTop: '0', padding: '12px' } }, [
            el('div', { class: 'fieldLabel', style: { marginTop: '0' } }, ['Ground size (meters)']),
            el('input', {
              value: String(state.groundSize),
              onchange: (e) => { state.groundSize = Math.max(20, Math.min(400, Number(e.target.value) || 80)); render(); },
            }),
            el('div', { class: 'muted', style: { marginTop: '6px', fontSize: '10px' } }, ['Bigger size gives more map area for roads/buildings.']),
          ]),
          el('div', { class: 'card', style: { marginTop: '0', padding: '12px' } }, [
            el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
              el('input', {
                type: 'checkbox',
                checked: !!state.addPerimeterWalls,
                onchange: (e) => { state.addPerimeterWalls = !!e.target.checked; render(); },
              }),
              el('span', { style: { fontWeight: '600', fontSize: '12px' } }, ['Add perimeter walls']),
            ]),
            el('div', { class: 'fieldLabel', style: { marginTop: '8px' } }, ['Wall height']),
            el('input', {
              value: String(state.wallHeight),
              onchange: (e) => { state.wallHeight = Math.max(1.2, Math.min(12, Number(e.target.value) || 3.2)); },
              disabled: !state.addPerimeterWalls,
            }),
            el('div', { class: 'muted', style: { marginTop: '6px', fontSize: '10px' } }, ['Useful for collision testing and arena-style boundaries.']),
          ]),
        ]));
        if (state.mapStartMode === 'quick_build') {
          bodyHost.appendChild(el('div', { class: 'card', style: { marginTop: '10px', padding: '12px' } }, [
            el('div', { class: 'fieldLabel', style: { marginTop: '0' } }, ['Quick build size']),
            el('select', {
              value: state.quickMapDensity,
              onchange: (e) => { state.quickMapDensity = String(e.target.value || 'balanced'); },
            }, [
              el('option', { value: 'compact' }, ['Compact (2 blocks)']),
              el('option', { value: 'balanced' }, ['Balanced (3 blocks)']),
              el('option', { value: 'dense' }, ['Dense (5 blocks)']),
            ]),
            el('div', { class: 'muted', style: { marginTop: '6px', fontSize: '10px' } }, ['Great for non-technical users who want a map instantly.']),
          ]));
        }
        bodyHost.appendChild(el('div', { class: 'card', style: { marginTop: '10px', padding: '12px' } }, [
          el('div', { class: 'fieldLabel', style: { marginTop: '0' } }, ['Starter content']),
          el('label', { class: 'row', style: { marginTop: '8px', gap: '8px', alignItems: 'center' } }, [
            el('input', { type: 'checkbox', checked: !!state.addStarterWaypoints, onchange: (e) => { state.addStarterWaypoints = !!e.target.checked; } }),
            el('span', { class: 'muted' }, ['Add starter waypoints (Start + Objective zone)']),
          ]),
          el('label', { class: 'row', style: { marginTop: '6px', gap: '8px', alignItems: 'center' } }, [
            el('input', { type: 'checkbox', checked: !!state.addStarterGoalTrigger, onchange: (e) => { state.addStarterGoalTrigger = !!e.target.checked; } }),
            el('span', { class: 'muted' }, ['Add an objective trigger near the spawn path']),
          ]),
        ]));
      } else if (state.step === 4) {
        if (state.mode !== 'new') {
          bodyHost.appendChild(el('div', { class: 'dockTitle' }, ['Step 4: Character']));
          bodyHost.appendChild(el('div', { class: 'infoBanner', style: { marginTop: '8px' } }, [
            el('div', { class: 'infoIcon' }, ['i']),
            el('div', {}, ['Character setup applies to New blank scene mode. Existing scenes keep their own character setup.']),
          ]));
          gotoNav();
          return;
        }
        const charCard = (mode, title, subtitle) => el('button', {
          class: state.characterStartMode === mode ? 'primary' : '',
          onclick: () => { state.characterStartMode = mode; render(); },
          style: {
            textAlign: 'left',
            padding: '12px',
            borderRadius: '10px',
            border: state.characterStartMode === mode ? '1px solid rgba(91,154,255,0.45)' : '1px solid rgba(255,255,255,0.10)',
            background: state.characterStartMode === mode ? 'rgba(91,154,255,0.13)' : 'rgba(255,255,255,0.03)',
          },
        }, [
          el('div', { style: { fontWeight: '650', fontSize: '12px' } }, [title]),
          el('div', { class: 'muted', style: { marginTop: '4px', fontSize: '10px', lineHeight: '1.35' } }, [subtitle]),
        ]);
        bodyHost.appendChild(el('div', { class: 'dockTitle' }, ['Step 4: Character setup']));
        bodyHost.appendChild(el('div', { class: 'muted', style: { marginTop: '4px' } }, ['Pick a simple default character (pill) or use your own model.']));
        bodyHost.appendChild(el('div', {
          style: { marginTop: '10px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '8px' },
        }, [
          charCard('pill', 'Default pill character', 'Fastest and safest option. No model import needed.'),
          charCard('model', 'Use character model', 'Use a GLB model for third-person character visuals.'),
        ]));
        if (state.characterStartMode === 'model') {
          bodyHost.appendChild(el('div', { class: 'card', style: { marginTop: '10px', padding: '12px' } }, [
            el('div', { class: 'fieldLabel', style: { marginTop: '0' } }, ['Character model (GLB/GLTF path)']),
            el('input', {
              value: state.characterModelUrl,
              placeholder: `${SCENE_ASSET_LOCATIONS.characters}<id>/character_manifest.json`,
              oninput: (e) => { state.characterModelUrl = String(e.target.value || ''); },
            }),
            el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, [
              el('span', { class: 'muted' }, ['Scale']),
              el('input', {
                value: String(state.characterModelScale),
                style: { width: '90px' },
                onchange: (e) => { state.characterModelScale = Math.max(0.01, Number(e.target.value) || state.characterModelScale); },
              }),
              el('span', { class: 'muted' }, ['Y offset']),
              el('input', {
                value: String(state.characterModelYOffset),
                style: { width: '90px' },
                onchange: (e) => { state.characterModelYOffset = Number(e.target.value) || 0.0; },
              }),
            ]),
            el('div', { class: 'muted', style: { marginTop: '6px', fontSize: '10px' } }, ['Tip: character model is visible in third-person view (press V in gameplay).']),
          ]));
        }
      } else {
        const summary = [
          `Mode: ${state.mode === 'new' ? 'New blank scene' : `Open existing (${state.existingType})`}`,
          state.mode === 'new' ? `World: ${safeTrim(state.worldName) || '(untitled)'} · ${safeTrim(getWorldThemePreset(state.worldTheme).label) || 'Neutral studio'}` : '',
          state.mode === 'new' ? `Goal: ${safeTrim(state.gameplayGoal) || 'Explore and build your world.'}` : '',
          state.mode === 'new' ? `Movement: speed ${Number(state.playerSpeed).toFixed(1)} / sprint ${Number(state.sprintSpeed).toFixed(1)}` : '',
          state.mode === 'new' ? `Map start: ${state.mapStartMode === 'quick_build' ? `quick build (${safeTrim(state.quickMapDensity) || 'balanced'})` : 'flat plane'}` : '',
          state.mode === 'new' ? `Character: ${state.characterStartMode === 'model' ? `model (${safeTrim(state.characterModelUrl) || 'default'})` : 'default pill'}` : '',
          state.mode === 'new' ? `Ground: ${Math.round(state.groundSize)}m${state.addPerimeterWalls ? `, walls ${Number(state.wallHeight).toFixed(1)}m` : ', no walls'}` : '',
          state.mode === 'new' ? `Systems: ${[
            state.includePhysics ? 'physics' : null,
            state.includeCollision ? 'collision' : null,
            state.includeLocomotion ? 'locomotion' : null,
            state.includeWeapons ? 'weapons' : null,
            state.includeInteractions ? 'interactions' : null,
          ].filter(Boolean).join(', ') || 'none'}` : '',
          state.mode === 'new' && state.includeWeapons ? `Extras: ${[
            state.includeEnemies ? 'enemies' : null,
            state.includeVehicles ? 'vehicles' : null,
          ].filter(Boolean).join(', ') || 'none'}` : '',
          state.mode === 'new' ? `Starter content: ${[
            state.addStarterWaypoints ? 'waypoints' : null,
            state.addStarterGoalTrigger ? 'objective trigger' : null,
          ].filter(Boolean).join(', ') || 'none'}` : '',
        ].filter(Boolean);
        bodyHost.appendChild(el('div', { class: 'dockTitle' }, ['Step 5: Review']));
        bodyHost.appendChild(el('div', { class: 'card', style: { marginTop: '10px' } }, summary.map((s) => el('div', { class: 'muted', style: { marginTop: '4px' } }, [s]))));
        bodyHost.appendChild(el('div', { class: 'infoBanner', style: { marginTop: '10px' } }, [
          el('div', { class: 'infoIcon' }, ['i']),
          el('div', {}, ['After creation, use the main Scene panel checklist to continue: place spawn, add content, save scenario, and playtest.']),
        ]));
      }

      gotoNav();
    };

    function gotoNav() {
      const canBack = state.step > 1;
      const canNext = state.step < 5;
      navHost.appendChild(el('button', { onclick: close }, ['Cancel']));
      navHost.appendChild(el('div', { style: { flex: '1' } }, []));
      navHost.appendChild(el('button', { onclick: () => { if (canBack) { state.step -= 1; render(); } }, disabled: !canBack }, ['Back']));
      navHost.appendChild(el('button', {
        class: 'primary',
        onclick: () => { if (canNext) { state.step += 1; render(); } else { void runCreate(); } },
      }, [canNext ? 'Next' : (state.mode === 'new' ? 'Create world' : 'Open scene')]));
    }

    panel.appendChild(el('div', {
      style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.02)' },
    }, [
      el('div', {}, [
        el('div', { style: { fontSize: '17px', fontWeight: '700', letterSpacing: '0.01em' } }, ['Easy World Builder']),
        el('div', { class: 'muted', style: { marginTop: '2px', fontSize: '11px' } }, ['Friendly flow to create playable worlds with starter systems, goals, and map layout.']),
      ]),
      el('div', { style: { flex: '1' } }, []),
      el('button', { onclick: close, title: 'Close wizard' }, ['Esc']),
    ]));
    panel.appendChild(bodyHost);
    panel.appendChild(navHost);
    overlay.appendChild(panel);

    const outsideClickHandler = (e) => { if (e.target === overlay) close(); };
    overlay.addEventListener('click', outsideClickHandler);
    const escHandler = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', escHandler);
    panel.addEventListener('click', (e) => e.stopPropagation());

    document.body.appendChild(overlay);
    this._createSceneModal.overlay = overlay;
    this._createSceneModal.escHandler = escHandler;
    this._createSceneModal.outsideClickHandler = outsideClickHandler;
    render();
  }

  /* ─────────────────── UI ─────────────────── */

  _buildUi() {
    const host = this._root;
    if (!host) return;
    return sceneTool_buildUi.call(this);
  }

  _syncModeUi() {
    return sceneTool_syncModeUi.call(this);
  }

  /* ─────────────────── Props (spawn GLBs into world) ─────────────────── */

  _ensurePropsRoot() {
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

  _readSceneInbox() {
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

  _clearSceneInbox() {
    try { localStorage.removeItem('devtools.scene.inbox'); } catch { /* ignore */ }
  }

  async _tryApplyForgeInbox() {
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

  _removeWorldObjectByName(name) {
    const nm = safeTrim(name);
    if (!nm || !this._worldRoot) return null;
    const obj = this._worldRoot.getObjectByName?.(nm) || null;
    if (!obj) return null;
    try { if (obj.parent) obj.parent.remove(obj); } catch { /* ignore */ }
    try { disposeThreeObject(obj); } catch { /* ignore */ }
    return obj;
  }

  _createForgeTerrainMesh({ size = 120, resolution = 65, color = 0x2a313f, heights = [] } = {}) {
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

  async _applyForgeWorldPayload(payload) {
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

  _getVehiclePresetCatalog() {
    const base = Array.isArray(SCENE_VEHICLE_PRESETS) ? SCENE_VEHICLE_PRESETS.slice() : [];
    const dyn = Array.isArray(this._vehiclePresetsDyn) ? this._vehiclePresetsDyn.slice() : [];
    return base.concat(dyn);
  }

  async _refreshVehiclePresetsFromWebautos() {
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

  _syncVehiclePresetSelectOptions() {
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

  async _resolveVehiclePresetSelection(presetId) {
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

  _acBundleToParamsUrl(bundleUrl) {
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

  async _getAcPhysicsTuningFromBundleUrl(bundleUrl) {
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

  async _getPropTemplate(url) {
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

  _acDdsBlockBytes(info) {
    const fourCC = String(info?.fourCC || '');
    const dxgi = info?.dxgiFormat;
    if (fourCC === 'DXT1' || fourCC === 'ATI1') return 8;
    if (fourCC === 'DXT3' || fourCC === 'DXT5' || fourCC === 'ATI2') return 16;
    if (dxgi === 71 || dxgi === 80) return 8;
    if (dxgi === 74 || dxgi === 77 || dxgi === 83 || dxgi === 95 || dxgi === 96 || dxgi === 98 || dxgi === 99) return 16;
    return 0;
  }

  _acDdsThreeFormat(info) {
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

  async _loadAcTexture(url, { kind = 'diffuse' } = {}) {
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

  async _applyAcTexturesToRoot(root, cfgMeta) {
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
          // Best-effort: load it so it can be used by custom tooling; we don't currently inject a detail shader here.
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

  async _spawnPropFromUrl(rawUrl, { name = '', scale = 1.0, yawDeg = 0, place = 'player' } = {}) {
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

  async _spawnDriveableVehicleFromAssetUrl(rawUrl, { name = '', scale = 1.0, yawDeg = 0, place = 'player', vehicleConfig = null } = {}) {
    return (await this._vehicleSystem?.spawnDriveableVehicleFromAssetUrl?.(rawUrl, { name, scale, yawDeg, place, vehicleConfig })) || null;

  }

  _deletePropById(id) {
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

  _clearAllProps() {
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

  _renderPropsUi() {
    const host = this._ui?.propsHost || null;
    if (!host) return;
    clear(host);

    const inbox = this._readSceneInbox();
    if (inbox && safeTrim(inbox.kind) === 'import_scenario' && inbox.scenario && typeof inbox.scenario === 'object') {
      const sc = inbox.scenario;
      const name = safeTrim(sc?.name) || '(unnamed scenario)';
      const p = safeTrim(sc?.path);

      // Auto-import + load when explicitly requested by the sender (e.g. Assetto exporter tools).
      // Guard so we don't loop if UI re-renders while the async load is in flight.
      try {
        if (inbox?.autoLoad) {
          if (this._inboxAutoKey == null) this._inboxAutoKey = '';
          const key = `${name}::${p}::${safeTrim(inbox?.time || '')}`;
          if (safeTrim(this._inboxAutoKey) !== key) {
            this._inboxAutoKey = key;
            void (async () => {
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
            })();
          }
        }
      } catch { /* ignore */ }

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

  /* ─────────────────── Selection + tags ─────────────────── */

  _getProjectTags(obj) {
    const ud = obj?.userData || null;
    if (!ud) return [];
    const v = ud.projectTags ?? ud.tags ?? ud.tag ?? null;
    if (!v) return [];
    if (Array.isArray(v)) return v.map((x) => safeTrim(x)).filter(Boolean);
    if (typeof v === 'string') return v.split(',').map((x) => safeTrim(x)).filter(Boolean);
    return [];
  }

  _hasProjectTag(obj, tag) {
    const t = safeTrim(tag).toLowerCase();
    if (!t) return false;
    return this._getProjectTags(obj).some((x) => safeTrim(x).toLowerCase() === t);
  }

  _addProjectTag(obj, tag) {
    if (!obj) return false;
    const t = safeTrim(tag);
    if (!t) return false;
    if (!obj.userData || typeof obj.userData !== 'object') obj.userData = {};
    const cur = this._getProjectTags(obj);
    if (cur.some((x) => safeTrim(x).toLowerCase() === t.toLowerCase())) return true;
    cur.push(t);
    obj.userData.projectTags = cur;
    return true;
  }

  _uniqueBuildingName(baseName, { excludeUuid = '' } = {}) {
    const base = safeTrim(baseName) || 'building';
    const items = Array.isArray(this._taggedBuildings) ? this._taggedBuildings : [];
    const used = new Set(
      items
        .filter((o) => safeTrim(o?.uuid) !== safeTrim(excludeUuid))
        .map((o) => safeTrim(o?.name))
        .filter(Boolean),
    );
    if (!used.has(base)) return base;
    let i = 2;
    while (used.has(`${base}_${i}`)) i++;
    return `${base}_${i}`;
  }

  _createPrimitiveBuildingAt({ name = 'building', w = 10, d = 10, h = 6, x = 0, z = 0 } = {}) {
    if (!this._worldRoot) return null;
    const nm = this._uniqueBuildingName(name);
    const ww = Math.max(1, Number(w) || 10);
    const dd = Math.max(1, Number(d) || 10);
    const hh = Math.max(1, Number(h) || 6);
    const px = Number.isFinite(Number(x)) ? Number(x) : 0;
    const pz = Number.isFinite(Number(z)) ? Number(z) : 0;

    const g = new THREE.Group();
    g.name = nm;
    g.position.set(px, 0, pz);
    this._addProjectTag(g, 'buildings');

    const ud = this._ensureBuildingMeta(g);
    ud.building.kind = 'primitive_box';
    ud.building.w = ww;
    ud.building.d = dd;
    ud.building.h = hh;
    ud.building.primitive = { type: 'box', meshName: '__building_prim_box' };
    ud.ai.nameHint = safeTrim(ud.ai.nameHint) || nm;
    ud.ai.targetDir = safeTrim(ud.ai.targetDir) || SCENE_ASSET_LOCATIONS.aiCityBuildings;
    ud.ai.desiredFormats = Array.isArray(ud.ai.desiredFormats) ? ud.ai.desiredFormats : ['.glb', '.bin', '.ktx2'];
    ud.ai.prompt = safeTrim(ud.ai.prompt) || `Game-ready building asset for ${nm}.`;

    const geo = new THREE.BoxGeometry(ww, hh, dd);
    const mat = new THREE.MeshStandardMaterial({ color: 0x6b8bbd, roughness: 0.82, metalness: 0.0 });
    const m = new THREE.Mesh(geo, mat);
    m.name = '__building_prim_box';
    m.position.set(0, hh * 0.5, 0);
    m.castShadow = false;
    m.receiveShadow = true;
    m.userData = m.userData && typeof m.userData === 'object' ? m.userData : {};
    m.userData.isObstacle = true;
    g.add(m);

    this._worldRoot.add(g);

    // If we’re in the procedural arena, collision + nav depend on obstacle boxes.
    if (safeTrim(this._proc?.kind) === 'arena') {
      this._obstacleSources = Array.isArray(this._obstacleSources) ? this._obstacleSources : [];
      this._obstacleSources.push(m);
      this._rebuildObstacleBoxesFromSources();
      try { this._buildNavGrid(); } catch { /* ignore */ }
    }

    this._scanTaggedBuildings();
    this._buildingSel.uuid = g.uuid;
    this._setSelection(g);
    this._renderBuildingsUi();
    this._renderBuildingEditorUi();
    return g;
  }

  _createPrimitiveBuildingAtPlayer({ name = 'building', w = 10, d = 10, h = 6 } = {}) {
    return this._createPrimitiveBuildingAt({
      name,
      w,
      d,
      h,
      x: Number(this._player?.x) || 0,
      z: Number(this._player?.z) || 0,
    });
  }

  _seedQuickStartMapLayout({ size = 80, density = 'balanced' } = {}) {
    if (!this._worldRoot) return;
    const half = Math.max(8, Number(size) * 0.5);
    const mode = safeTrim(density).toLowerCase();
    const compact = (mode === 'compact');
    const dense = (mode === 'dense');
    const zFront = (Number(this._spawn?.z) || 0) - Math.max(10, Number(size) * 0.2);
    const zMid = zFront - Math.max(10, Number(size) * 0.15);
    const xWide = Math.max(8, half * 0.4);
    const xNarrow = Math.max(5, half * 0.26);
    const specs = compact
      ? [
        { name: 'hub_a', x: -xNarrow, z: zFront, w: 10, d: 9, h: 6 },
        { name: 'hub_b', x: xNarrow, z: zFront, w: 10, d: 9, h: 6 },
      ]
      : dense
        ? [
          { name: 'block_a', x: -xWide, z: zFront, w: 12, d: 10, h: 7 },
          { name: 'block_b', x: xWide, z: zFront, w: 12, d: 10, h: 7 },
          { name: 'block_c', x: -xNarrow, z: zMid, w: 10, d: 8, h: 6 },
          { name: 'block_d', x: xNarrow, z: zMid, w: 10, d: 8, h: 6 },
          { name: 'center_piece', x: 0, z: zFront - Math.max(5, Number(size) * 0.08), w: 8, d: 8, h: 5 },
        ]
        : [
          { name: 'starter_a', x: -xWide, z: zFront, w: 12, d: 10, h: 7 },
          { name: 'starter_b', x: xWide, z: zFront, w: 12, d: 10, h: 7 },
          { name: 'starter_c', x: 0, z: zMid, w: 9, d: 8, h: 5.5 },
        ];
    for (const it of specs) {
      this._createPrimitiveBuildingAt({
        name: it.name,
        w: it.w,
        d: it.d,
        h: it.h,
        x: Number(it.x) || 0,
        z: Number(it.z) || 0,
      });
    }
  }

  _collectObstacleMeshes(root) {
    const out = [];
    if (!root?.traverse) return out;
    root.traverse((n) => {
      if (!n) return;
      if (n.isMesh && n?.userData?.isObstacle) out.push(n);
    });
    return out;
  }

  _rebuildPrimitiveBoxBuilding(group) {
    const g = group || null;
    if (!g) return false;
    const ud = this._ensureBuildingMeta(g);
    const b = ud?.building || {};
    const ww = Math.max(0.5, Number(b.w) || 10);
    const dd = Math.max(0.5, Number(b.d) || 10);
    const hh = Math.max(0.5, Number(b.h) || 6);
    const meshName = safeTrim(b?.primitive?.meshName) || '__building_prim_box';

    let mesh = null;
    try { mesh = g.getObjectByName(meshName); } catch { mesh = null; }
    if (!mesh || !mesh.isMesh) return false;
    try {
      const old = mesh.geometry;
      mesh.geometry = new THREE.BoxGeometry(ww, hh, dd);
      try { old?.dispose?.(); } catch { /* ignore */ }
      mesh.position.set(0, hh * 0.5, 0);
    } catch { /* ignore */ }

    // Keep collision/nav fresh.
    if (safeTrim(this._proc?.kind) === 'arena') {
      this._rebuildObstacleBoxesFromSources();
      try { this._buildNavGrid(); } catch { /* ignore */ }
    }
    this._updateSelectionHelper();
    return true;
  }

  _rebuildArenaBuilding(group) {
    const g = group || null;
    if (!g) return false;
    const ud = this._ensureBuildingMeta(g);
    const b = ud?.building || {};
    if (safeTrim(b?.kind) !== 'proc:arena') return false;

    const ww = Math.max(2.0, Number(b.w) || 18);
    const dd = Math.max(2.0, Number(b.d) || 14);
    const wallH = Math.max(2.0, Number(b.h) || 4.2);
    const door = safeTrim(b.door || 'south') || 'south';
    const doorW = Math.max(0.8, Number(b.doorW) || 2.4);

    // Remove old obstacle meshes from sources before we dispose children.
    if (Array.isArray(this._obstacleSources)) {
      const obs = this._collectObstacleMeshes(g);
      if (obs.length) {
        const kill = new Set(obs.map((m) => m?.uuid).filter(Boolean));
        this._obstacleSources = this._obstacleSources.filter((m) => !kill.has(m?.uuid));
      }
    }

    // Dispose existing children.
    try {
      const kids = Array.isArray(g.children) ? [...g.children] : [];
      for (const c of kids) {
        try { g.remove(c); } catch { /* ignore */ }
        try { disposeThreeObject(c); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    // Simple arena-building rebuild: outer shell with a doorway and a roof.
    const t = 0.8;
    const x0 = -ww * 0.5;
    const x1 = ww * 0.5;
    const z0 = -dd * 0.5;
    const z1 = dd * 0.5;

    const outerWallMat = new THREE.MeshStandardMaterial({ color: 0x8ea3bf, roughness: 0.9, metalness: 0.0 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x10151f, roughness: 0.92, metalness: 0.0 });

    const addBox = ({ x, y, z, w, h, d, mat, name = '', collider = true }) => {
      const geo = new THREE.BoxGeometry(Math.max(0.01, w), Math.max(0.01, h), Math.max(0.01, d));
      const m = new THREE.Mesh(geo, mat);
      m.name = name || 'box';
      m.position.set(Number(x) || 0, (Number(y) || 0) + (Number(h) || 0) * 0.5, Number(z) || 0);
      m.castShadow = false;
      m.receiveShadow = true;
      m.userData = m.userData && typeof m.userData === 'object' ? m.userData : {};
      if (collider) {
        m.userData.isObstacle = true;
        this._obstacleSources = Array.isArray(this._obstacleSources) ? this._obstacleSources : [];
        this._obstacleSources.push(m);
      }
      g.add(m);
      return m;
    };

    const addWallX = ({ x0, x1, z, y = 0, h = wallH, thick = t, doorAt = null, doorW = 2.2, mat = outerWallMat, name = '' }) => {
      const len = Math.abs(x1 - x0);
      const cx = (x0 + x1) * 0.5;
      const zc = z;
      if (!doorAt) {
        addBox({ x: cx, y, z: zc, w: len, h, d: thick, mat, name });
        return;
      }
      const da = Number(doorAt.x);
      const dw = Math.max(0.8, Number(doorW) || 2.2);
      const left0 = x0;
      const left1 = da - dw * 0.5;
      const right0 = da + dw * 0.5;
      const right1 = x1;
      if (left1 - left0 > 0.2) addBox({ x: (left0 + left1) * 0.5, y, z: zc, w: (left1 - left0), h, d: thick, mat, name: name ? `${name}_L` : '' });
      if (right1 - right0 > 0.2) addBox({ x: (right0 + right1) * 0.5, y, z: zc, w: (right1 - right0), h, d: thick, mat, name: name ? `${name}_R` : '' });
    };

    const addWallZ = ({ z0, z1, x, y = 0, h = wallH, thick = t, doorAt = null, doorW = 2.2, mat = outerWallMat, name = '' }) => {
      const len = Math.abs(z1 - z0);
      const cz = (z0 + z1) * 0.5;
      const xc = x;
      if (!doorAt) {
        addBox({ x: xc, y, z: cz, w: thick, h, d: len, mat, name });
        return;
      }
      const da = Number(doorAt.z);
      const dw = Math.max(0.8, Number(doorW) || 2.2);
      const bot0 = z0;
      const bot1 = da - dw * 0.5;
      const top0 = da + dw * 0.5;
      const top1 = z1;
      if (bot1 - bot0 > 0.2) addBox({ x: xc, y, z: (bot0 + bot1) * 0.5, w: thick, h, d: (bot1 - bot0), mat, name: name ? `${name}_B` : '' });
      if (top1 - top0 > 0.2) addBox({ x: xc, y, z: (top0 + top1) * 0.5, w: thick, h, d: (top1 - top0), mat, name: name ? `${name}_T` : '' });
    };

    addWallX({ x0, x1, z: z0, mat: outerWallMat, name: `${g.name}_north`, doorAt: (door === 'north') ? { x: 0 } : null, doorW });
    addWallX({ x0, x1, z: z1, mat: outerWallMat, name: `${g.name}_south`, doorAt: (door === 'south') ? { x: 0 } : null, doorW });
    addWallZ({ z0, z1, x: x0, mat: outerWallMat, name: `${g.name}_west`, doorAt: (door === 'west') ? { z: 0 } : null, doorW });
    addWallZ({ z0, z1, x: x1, mat: outerWallMat, name: `${g.name}_east`, doorAt: (door === 'east') ? { z: 0 } : null, doorW });

    // Roof (visual only)
    addBox({ x: 0, y: wallH, z: 0, w: ww + t * 1.2, h: 0.22, d: dd + t * 1.2, mat: roofMat, name: `${g.name}_roof`, collider: false });

    // Keep collision/nav fresh (only meaningful in proc:arena SceneTool).
    if (safeTrim(this._proc?.kind) === 'arena') {
      this._rebuildObstacleBoxesFromSources();
      try { this._buildNavGrid(); } catch { /* ignore */ }
    }
    this._updateSelectionHelper();
    return true;
  }

  _rebuildRoomSimPenthouseBuilding(group) {
    const g = group || null;
    if (!g) return false;
    const ud = this._ensureBuildingMeta(g);
    const b = ud?.building || {};
    if (safeTrim(b?.kind) !== 'proc:penthouse_room_sim') return false;

    // Remove old obstacle meshes from sources before we dispose children.
    if (Array.isArray(this._obstacleSources)) {
      const obs = this._collectObstacleMeshes(g);
      if (obs.length) {
        const kill = new Set(obs.map((m) => m?.uuid).filter(Boolean));
        this._obstacleSources = this._obstacleSources.filter((m) => !kill.has(m?.uuid));
      }
    }

    // Dispose existing children.
    try {
      const kids = Array.isArray(g.children) ? [...g.children] : [];
      for (const c of kids) {
        try { g.remove(c); } catch { /* ignore */ }
        try { disposeThreeObject(c); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    const layout = buildRoomSimPenthouseLayout({
      rows: b.rows,
      cols: b.cols,
      roomW: b.roomW,
      roomD: b.roomD,
      corridorD: b.corridorD,
      hallW: b.hallW,
      wallT: b.wallT,
      wallH: b.wallH,
      doorW: b.doorW,
      hallDoorW: b.hallDoorW,
      deskRows: b.deskRows,
      deskCols: b.deskCols,
      deskPadX: b.deskPadX,
      deskPadY: b.deskPadY,
    });
    const parts = Array.isArray(layout?.parts) ? layout.parts : [];

    // Capture "semantic" anchors so we can place characters in sensible spots.
    // (Stored on the building group userData to avoid re-scanning meshes.)
    ud.roomSimPoints = {
      chairs: [],
      agentSpawns: [],
      beds: [],
      desks: [],
      lounge: [],
    };

    /** @type {Map<string, THREE.MeshStandardMaterial>} */
    const matByKey = new Map();
    const getMat = (colorHex, alpha = 1) => {
      const key = `${Number(colorHex) >>> 0}:${String(alpha)}`;
      const existing = matByKey.get(key);
      if (existing) return existing;
      const a = Math.max(0, Math.min(1, Number(alpha) || 1));
      const m = new THREE.MeshStandardMaterial({
        color: Number(colorHex) >>> 0,
        roughness: 0.86,
        metalness: 0.0,
        transparent: a < 0.999,
        opacity: a,
      });
      matByKey.set(key, m);
      return m;
    };

    // Add each part as a mesh.
    for (const p of parts) {
      const sx = Math.max(0.01, Number(p?.sx) || 1);
      const sy = Math.max(0.01, Number(p?.sy) || 1);
      const sz = Math.max(0.01, Number(p?.sz) || 1);
      const geo = new THREE.BoxGeometry(sx, sy, sz);
      const alpha = Number(p?.alpha ?? 1);
      const mat = getMat(Number(p?.colorHex) >>> 0, alpha);
      const m = new THREE.Mesh(geo, mat);
      m.name = safeTrim(p?.id) || safeTrim(p?.kind) || 'part';
      m.position.set(Number(p?.x) || 0, (Number(p?.z) || 0) + sy * 0.5, Number(p?.y) || 0);
      m.rotation.y = (Number(p?.yawDeg) || 0) * Math.PI / 180;
      m.castShadow = false;
      m.receiveShadow = true;
      m.userData = m.userData && typeof m.userData === 'object' ? m.userData : {};
      m.userData.isObstacle = true;
      m.userData.partKind = safeTrim(p?.kind) || '';
      m.userData.partMeta = (p?.meta && typeof p.meta === 'object') ? p.meta : {};
      g.add(m);

      // Add emissive + light for ceiling fixtures (visual quality).
      if (safeTrim(p?.kind) === 'ceiling_light') {
        try {
          const mm = /** @type {any} */ (m.material);
          if (mm) {
            mm.emissive = new THREE.Color(0xfff2c0);
            mm.emissiveIntensity = 0.75;
            mm.roughness = 0.25;
          }
        } catch { /* ignore */ }
        try {
          const inten = Math.max(0.1, Math.min(3.0, Number(p?.meta?.intensity) || 0.65));
          const pl = new THREE.PointLight(0xfff2c0, inten, 14, 2);
          pl.position.set(0, -0.10, 0);
          m.add(pl);
        } catch { /* ignore */ }
      }

      // Record anchors in *scene space* (x,z on ground, y up).
      try {
        const kk = safeTrim(p?.kind);
        const rec = {
          id: safeTrim(p?.id),
          kind: kk,
          x: Number(p?.x) || 0,
          z: Number(p?.y) || 0,
          y: Number(p?.z) || 0,
          yawDeg: Number(p?.yawDeg) || 0,
          meta: (p?.meta && typeof p.meta === 'object') ? p.meta : {},
        };
        if (kk === 'chair') ud.roomSimPoints.chairs.push(rec);
        else if (kk === 'agent_spawn') ud.roomSimPoints.agentSpawns.push(rec);
        else if (kk === 'bed') ud.roomSimPoints.beds.push(rec);
        else if (kk === 'desk') ud.roomSimPoints.desks.push(rec);
        else if (kk === 'sofa' || kk === 'coffee_table' || kk === 'rug' || kk === 'plant') ud.roomSimPoints.lounge.push(rec);
      } catch { /* ignore */ }

      // Obstacle sources used by proc:arena only, but harmless for other scenes; keep in sync for selection helpers.
      this._obstacleSources = Array.isArray(this._obstacleSources) ? this._obstacleSources : [];
      this._obstacleSources.push(m);
    }

    // IMPORTANT: FPS collision uses `_obstacleBoxes`, not `_obstacleSources`.
    // The penthouse is a procedural world too, so after rebuilding its geometry we must
    // rebuild the world-space obstacle boxes or the player will walk through walls.
    try { this._rebuildObstacleBoxesFromSources(); } catch { /* ignore */ }

    // If the penthouse is loaded as the active procedural world, (re)populate people.
    try { this._applyRoomSimSpawnMarkerVisibility(); } catch { /* ignore */ }
    try { void this._refreshRoomSimPeople(); } catch { /* ignore */ }

    this._updateSelectionHelper();
    return true;
  }

  _rebuildDriftTrackBuilding(group) {
    const g = group || null;
    if (!g) return false;
    const ud = this._ensureBuildingMeta(g);
    const b = ud?.building || {};
    if (safeTrim(b?.kind) !== 'proc:drift_track') return false;

    // Remove old obstacle meshes from sources before we dispose children.
    if (Array.isArray(this._obstacleSources)) {
      const obs = this._collectObstacleMeshes(g);
      if (obs.length) {
        const kill = new Set(obs.map((m) => m?.uuid).filter(Boolean));
        this._obstacleSources = this._obstacleSources.filter((m) => !kill.has(m?.uuid));
      }
    }

    // Dispose existing children.
    try {
      const kids = Array.isArray(g.children) ? [...g.children] : [];
      for (const c of kids) {
        try { g.remove(c); } catch { /* ignore */ }
        try { disposeThreeObject(c); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    const num = (v, d) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : d;
    };
    const int = (v, d) => {
      const n = Math.floor(Number(v));
      return Number.isFinite(n) ? n : d;
    };

    const padSize = Math.max(80, num(b?.padSize, 260));
    const ringInnerR = Math.max(6, num(b?.ringInnerR, 36));
    const ringOuterR = Math.max(ringInnerR + 2, num(b?.ringOuterR, 62));
    const shoulderInnerW = Math.max(0, num(b?.shoulderInnerW, 6));
    const shoulderOuterW = Math.max(0, num(b?.shoulderOuterW, 6));
    const startLineZ = num(b?.startLineZ, 54);
    const startLineW = Math.max(1, num(b?.startLineW, 12));
    const clipIslandR = Math.max(2.0, num(b?.clipIslandR, 13));
    const clipCones = Math.max(0, Math.min(64, int(b?.clipCones, 12)));
    const clipConeRingR = Math.max(clipIslandR + 2.0, num(b?.clipConeRingR, 18.0));

    const outerBarrier = (b?.outerBarrier && typeof b.outerBarrier === 'object') ? b.outerBarrier : {};
    const innerBarrier = (b?.innerBarrier && typeof b.innerBarrier === 'object') ? b.innerBarrier : {};
    const outerBarrierR = Math.max(ringOuterR + 2.0, num(outerBarrier?.radius, ringOuterR + 6.0));
    const innerBarrierR = Math.max(0.5, num(innerBarrier?.radius, Math.max(0.5, ringInnerR - 6.0)));
    const outerSegs = Math.max(12, Math.min(256, int(outerBarrier?.segments, 72)));
    const innerSegs = Math.max(8, Math.min(256, int(innerBarrier?.segments, 64)));
    const outerThick = Math.max(0.2, num(outerBarrier?.thickness, 1.1));
    const innerThick = Math.max(0.2, num(innerBarrier?.thickness, 1.0));
    const outerH = Math.max(0.2, num(outerBarrier?.height, 1.05));
    const innerH = Math.max(0.2, num(innerBarrier?.height, 0.9));

    const ent = (b?.entrance && typeof b.entrance === 'object') ? b.entrance : {};
    const entLotW = Math.max(10, num(ent?.lotW, 48));
    const entLotD = Math.max(10, num(ent?.lotD, 32));
    const entLotX = num(ent?.lotX, 0);
    const entLotZ = num(ent?.lotZ, 110);
    const entLaneW = Math.max(4, num(ent?.laneW, 12));
    const entLaneD = Math.max(10, num(ent?.laneD, 58));
    const entLaneZ = num(ent?.laneZ, 78);

    const mats = {
      pad: new THREE.MeshStandardMaterial({ color: 0x191d24, roughness: 0.98, metalness: 0.0 }),
      asphalt: new THREE.MeshStandardMaterial({ color: 0x2c313a, roughness: 0.93, metalness: 0.03 }),
      shoulder: new THREE.MeshStandardMaterial({ color: 0x3e444e, roughness: 0.95, metalness: 0.0 }),
      stripe: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0.0, emissive: 0x111111, emissiveIntensity: 0.05 }),
      barrier: new THREE.MeshStandardMaterial({ color: 0xc9d1da, roughness: 0.55, metalness: 0.08 }),
      cone: new THREE.MeshStandardMaterial({ color: 0xff8f42, roughness: 0.7, metalness: 0.0, emissive: 0x311100, emissiveIntensity: 0.4 }),
      base: new THREE.MeshStandardMaterial({ color: 0x1f232a, roughness: 0.85, metalness: 0.05 }),
      island: new THREE.MeshStandardMaterial({ color: 0x2f6a3c, roughness: 0.92, metalness: 0.0 }),
    };

    const addObstacle = (m) => {
      if (!m) return;
      m.userData = m.userData && typeof m.userData === 'object' ? m.userData : {};
      m.userData.isObstacle = true;
      this._obstacleSources = Array.isArray(this._obstacleSources) ? this._obstacleSources : [];
      this._obstacleSources.push(m);
    };

    const addGroundPlane = ({ x = 0, z = 0, w = 10, d = 10, y = 0.01, mat = mats.asphalt, name = '' }) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d, 1, 1), mat);
      if (name) mesh.name = name;
      mesh.rotation.x = -Math.PI * 0.5;
      mesh.position.set(x, y, z);
      mesh.receiveShadow = true;
      g.add(mesh);
      return mesh;
    };
    const addRingSurface = ({ innerR, outerR, y = 0.01, mat = mats.asphalt, segments = 96, name = '' }) => {
      const mesh = new THREE.Mesh(new THREE.RingGeometry(innerR, outerR, Math.max(24, segments)), mat);
      if (name) mesh.name = name;
      mesh.rotation.x = -Math.PI * 0.5;
      mesh.position.set(0, y, 0);
      mesh.receiveShadow = true;
      g.add(mesh);
      return mesh;
    };

    // Base pad (visual only).
    addGroundPlane({ w: padSize, d: padSize, y: 0.0, mat: mats.pad, name: 'drift_pad' });

    // Entrance lot + lane (parking lot entrance).
    addGroundPlane({ x: entLotX, z: entLotZ, w: entLotW, d: entLotD, y: 0.012, mat: mats.asphalt, name: 'drift_entrance_lot' });
    addGroundPlane({ x: entLotX, z: entLaneZ, w: entLaneW, d: entLaneD, y: 0.012, mat: mats.asphalt, name: 'drift_entry_lane' });

    // Main loop (asphalt + shoulders).
    addRingSurface({ innerR: ringInnerR, outerR: ringOuterR, y: 0.014, mat: mats.asphalt, segments: 128, name: 'drift_ring' });
    if (shoulderOuterW > 1e-3) addRingSurface({ innerR: ringOuterR, outerR: ringOuterR + shoulderOuterW, y: 0.012, mat: mats.shoulder, segments: 96, name: 'drift_shoulder_outer' });
    if (shoulderInnerW > 1e-3) addRingSurface({ innerR: Math.max(0.5, ringInnerR - shoulderInnerW), outerR: ringInnerR, y: 0.012, mat: mats.shoulder, segments: 96, name: 'drift_shoulder_inner' });

    // Start stripe.
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(startLineW, 0.03, 0.6), mats.stripe);
    stripe.name = 'drift_start_line';
    stripe.position.set(0, 0.012 + 0.015, startLineZ);
    stripe.receiveShadow = true;
    g.add(stripe);

    // Center clip island (obstacle) + cones.
    const island = new THREE.Mesh(new THREE.CylinderGeometry(clipIslandR, clipIslandR, 0.9, 28), mats.island);
    island.name = 'drift_clip_island';
    island.position.set(0, 0.45, 0);
    island.receiveShadow = true;
    g.add(island);
    addObstacle(island);

    const addCone = (x, z, scale = 1) => {
      const cone = new THREE.Group();
      cone.name = 'drift_cone';
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.14 * scale, 0.34 * scale, 0.62 * scale, 12), mats.cone);
      body.position.y = 0.31 * scale;
      cone.add(body);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.38 * scale, 0.38 * scale, 0.06 * scale, 14), mats.base);
      base.position.y = 0.03 * scale;
      cone.add(base);
      cone.position.set(x, 0, z);
      g.add(cone);
    };
    for (let i = 0; i < clipCones; i++) {
      const t = (i / Math.max(1, clipCones)) * Math.PI * 2;
      const r = clipConeRingR + ((i % 2) ? 1.3 : -1.1);
      addCone(Math.cos(t) * r, Math.sin(t) * r, 1.0);
    }

    // Barrier rings as short oriented blocks (obstacles).
    const addBarrierRing = ({ radius, segments, thickness, height, namePrefix }) => {
      const segLen = ((Math.PI * 2 * radius) / Math.max(8, segments)) * 0.92;
      const geo = new THREE.BoxGeometry(segLen, height, thickness);
      for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        const x = Math.cos(a) * radius;
        const z = Math.sin(a) * radius;
        const m = new THREE.Mesh(geo, mats.barrier);
        m.name = `${namePrefix}_${i}`;
        m.position.set(x, height * 0.5, z);
        m.rotation.y = -a;
        m.castShadow = true;
        m.receiveShadow = true;
        g.add(m);
        addObstacle(m);
      }
    };
    addBarrierRing({ radius: outerBarrierR, segments: outerSegs, thickness: outerThick, height: outerH, namePrefix: 'drift_outer_barrier' });
    addBarrierRing({ radius: innerBarrierR, segments: innerSegs, thickness: innerThick, height: innerH, namePrefix: 'drift_inner_barrier' });

    // Entrance lot guard rails (simple).
    try {
      const h = 0.95;
      const t = 1.0;
      const geoX = new THREE.BoxGeometry(entLotW + 2.0, h, t);
      const geoZ = new THREE.BoxGeometry(t, h, entLotD + 2.0);
      const z0 = entLotZ - entLotD * 0.5 - 0.5;
      const z1 = entLotZ + entLotD * 0.5 + 0.5;
      const x0 = entLotX - entLotW * 0.5 - 0.5;
      const x1 = entLotX + entLotW * 0.5 + 0.5;
      // Back wall
      const back = new THREE.Mesh(geoX, mats.barrier);
      back.name = 'drift_ent_back';
      back.position.set(entLotX, h * 0.5, z1);
      g.add(back);
      addObstacle(back);
      // Side walls (leave a gap at the lane entry on the north side).
      const west = new THREE.Mesh(geoZ, mats.barrier);
      west.name = 'drift_ent_west';
      west.position.set(x0, h * 0.5, entLotZ);
      g.add(west);
      addObstacle(west);
      const east = new THREE.Mesh(geoZ, mats.barrier);
      east.name = 'drift_ent_east';
      east.position.set(x1, h * 0.5, entLotZ);
      g.add(east);
      addObstacle(east);
      // Front wall split around lane.
      const frontSpan = entLotW + 2.0;
      const gap = Math.min(frontSpan * 0.7, Math.max(6.0, entLaneW + 1.6));
      const leftLen = Math.max(0.1, (frontSpan - gap) * 0.5);
      const geoFront = new THREE.BoxGeometry(leftLen, h, t);
      const frontZ = z0;
      const left = new THREE.Mesh(geoFront, mats.barrier);
      left.name = 'drift_ent_front_L';
      left.position.set(entLotX - (gap * 0.5 + leftLen * 0.5), h * 0.5, frontZ);
      g.add(left);
      addObstacle(left);
      const right = new THREE.Mesh(geoFront, mats.barrier);
      right.name = 'drift_ent_front_R';
      right.position.set(entLotX + (gap * 0.5 + leftLen * 0.5), h * 0.5, frontZ);
      g.add(right);
      addObstacle(right);
    } catch { /* ignore */ }

    // Update collision boxes.
    try { this._rebuildObstacleBoxesFromSources(); } catch { /* ignore */ }
    this._updateSelectionHelper();
    return true;
  }

  /* ─────────────────── Characters (avatar + penthouse people) ─────────────────── */
  // Installed via: `sceneAvatarMixin`, `sceneRoomSimMixin`, `sceneResumeWalkerMixin`.

  _setSelection(obj) {
    const o = obj || null;
    this._selection.obj = o;
    this._selection.uuid = o?.uuid || '';
    this._selection.name = safeTrim(o?.name) || safeTrim(o?.type) || '';
    this._updateSelectionHelper();
    try { this._renderBuildingsUi(); } catch { /* ignore */ }
    try { this._renderBuildingEditorUi(); } catch { /* ignore */ }
  }

  _updateSelectionHelper() {
    if (!this._scene) return;
    try { if (this._selectionBox) this._scene.remove(this._selectionBox); } catch { /* ignore */ }
    try { disposeThreeObject(this._selectionBox); } catch { /* ignore */ }
    this._selectionBox = null;
    const o = this._selection?.obj || null;
    if (!o) return;
    try {
      const helper = new THREE.BoxHelper(o, 0x7eb3ff);
      helper.name = 'selection_box';
      this._selectionBox = helper;
      this._scene.add(helper);
    } catch { /* ignore */ }
  }

  _pickSelectionFromEvent(e) {
    if (!this._canvas || !this._camera || !this._ray) return;
    if (!this._colliders || !this._colliders.length) return;
    const rect = this._canvas.getBoundingClientRect();
    const x = (Number(e?.clientX) - rect.left) / Math.max(1, rect.width);
    const y = (Number(e?.clientY) - rect.top) / Math.max(1, rect.height);
    const ndc = new THREE.Vector2(x * 2 - 1, -(y * 2 - 1));
    this._ray.setFromCamera(ndc, this._camera);
    const hits = this._ray.intersectObjects(this._colliders, true) || [];
    if (!hits.length) return;
    let o = hits[0]?.object || null;
    if (!o) return;

    // Prefer selecting a tagged building root if the hit is inside one.
    let cur = o;
    while (cur && cur.parent) {
      if (this._hasProjectTag(cur, 'buildings')) { o = cur; break; }
      if (cur === this._worldRoot) break;
      cur = cur.parent;
    }
    this._setSelection(o);
    if (this._hasProjectTag(o, 'buildings')) {
      this._buildingSel.uuid = o.uuid;
      try { this._renderBuildingEditorUi(); } catch { /* ignore */ }
    }
  }

  _setStatus(s) {
    if (this._ui.statusEl) this._ui.statusEl.textContent = String(s || '');
  }

  _buildGameToolHandoffPayload() {
    const sourceUrl = safeTrim(this._state?.sourceUrl)
      || safeTrim(this._state?.lastGlbUrl)
      || (this._proc?.root ? `proc:${safeTrim(this._proc?.kind || 'arena')}` : '');
    if (!sourceUrl) throw new Error('No scene source is set yet.');

    const unique = new Set();
    const preloadAssets = [];
    const addPreload = (v) => {
      const p = safeTrim(v).replace(/\\/g, '/');
      if (!p) return;
      if (p.startsWith('proc:')) return;
      if (unique.has(p)) return;
      unique.add(p);
      preloadAssets.push(p);
    };
    addPreload(sourceUrl);
    addPreload(this._avatar?.url || '');
    addPreload(this._roomSim?.url || '');
    addPreload(this._resumeWalker?.url || '');
    try { addPreload(localStorage.getItem('devtools.scene.assetUrl') || ''); } catch { /* ignore */ }

    let scenario = null;
    try { scenario = this._buildScenarioSnapshot(); } catch { scenario = null; }
    const mode = String(this._state?.mode || 'fps');
    const inferredGameplay = (mode === 'fps') ? 'fps' : 'exploration';
    return {
      schema: 1,
      kind: 'scene_to_game_handoff',
      createdAt: new Date().toISOString(),
      scene: {
        sourceUrl,
        fallbackSourceUrl: 'proc:arena',
        preloadAssets,
        scenarioName: safeTrim(this._ui?.scenarioName?.value || ''),
        mode,
        gameplayHint: inferredGameplay,
        settings: {
          mode,
          showGrid: !!this._state?.showGrid,
          fly: !!this._state?.fly,
          enableLean: !!this._state?.enableLean,
          autoPlayAfterLoad: !!this._state?.autoPlayAfterLoad,
          speed: Number(this._state?.speed || 6),
          sprint: Number(this._state?.sprint || 11),
        },
      },
      loading: {
        enabled: true,
        title: safeTrim(this._ui?.scenarioName?.value || '') || 'Loading world...',
        subtitle: safeTrim(sourceUrl),
        minMs: 1200,
      },
      start: {
        showMenu: true,
        menuTitle: safeTrim(this._ui?.scenarioName?.value || '') || 'Start Game',
        menuSubtitle: 'Select your character and press Start.',
      },
      runtime: {
        sceneToolImportPath: './js/devtools/tools/scene_tool.js',
      },
      scenarioSnapshot: scenario,
    };
  }

  _sendSceneSettingsToGameTool() {
    const payload = this._buildGameToolHandoffPayload();
    try { localStorage.setItem('devtools.game.inboxJson', JSON.stringify(payload)); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.game.inboxAt', payload.createdAt || new Date().toISOString()); } catch { /* ignore */ }
    this._setStatus('Sent scene settings to Game tool.');
    this._ctx?.toast?.('Scene settings sent to Game tool', 'success', { title: 'Game tool' });
    try { globalThis.__devtools?.setActiveTool?.('game'); } catch { /* ignore */ }
  }

  _savePrefs() {
    try { localStorage.setItem('devtools.scene.sourceUrl', safeTrim(this._state.sourceUrl)); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.scene.lastGlbUrl', safeTrim(this._state.lastGlbUrl)); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.scene.mode', String(this._state.mode || 'fps')); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.scene.showGrid', this._state.showGrid ? '1' : '0'); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.scene.enableLean', this._state.enableLean ? '1' : '0'); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.scene.fly', this._state.fly ? '1' : '0'); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.scene.speed', String(this._state.speed || 6)); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.scene.sprint', String(this._state.sprint || 11)); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.scene.autoPlayAfterLoad', this._state.autoPlayAfterLoad ? '1' : '0'); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.scene.showDebug', this._state.showDebug ? '1' : '0'); } catch { /* ignore */ }

    // Character prefs
    try { localStorage.setItem('devtools.scene.avatarEnabled', this._avatar?.enabled ? '1' : '0'); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.scene.avatarUrl', safeTrim(this._avatar?.url || '')); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.scene.avatarScale', String(this._avatar?.scale ?? 1.0)); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.scene.avatarYOffset', String(this._avatar?.yOffset ?? 0.0)); } catch { /* ignore */ }

    try { localStorage.setItem('devtools.scene.roomSimPeopleEnabled', this._roomSim?.enabled ? '1' : '0'); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.scene.roomSimPeopleUrl', safeTrim(this._roomSim?.url || '')); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.scene.roomSimPeopleScale', String(this._roomSim?.scale ?? 1.0)); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.scene.roomSimPeopleYOffset', String(this._roomSim?.yOffset ?? 0.0)); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.scene.roomSimPeopleMax', String(this._roomSim?.maxPeople ?? 25)); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.scene.roomSimHideSpawns', this._roomSim?.hideSpawnMarkers ? '1' : '0'); } catch { /* ignore */ }

    // Resume Showcase walker prefs
    try { localStorage.setItem('devtools.scene.resumeWalkerEnabled', this._resumeWalker?.enabled ? '1' : '0'); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.scene.resumeWalkerUrl', safeTrim(this._resumeWalker?.url || '')); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.scene.resumeWalkerScale', String(this._resumeWalker?.scale ?? 1.0)); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.scene.resumeWalkerYOffset', String(this._resumeWalker?.yOffset ?? 0.0)); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.scene.resumeWalkerSpeed', String(this._resumeWalker?.speed ?? 1.35)); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.scene.resumeWalkerRadius', String(this._resumeWalker?.radius ?? 5.0)); } catch { /* ignore */ }
    try { localStorage.setItem('devtools.scene.resumeWalkerTextureSourceUrl', safeTrim(this._resumeWalker?.textureSourceUrl || '')); } catch { /* ignore */ }
  }

  _setSourceUrl(url) {
    this._state.sourceUrl = safeTrim(url).replace(/\\/g, '/');
    this._savePrefs();
  }

  async _exportCurrentWorldGlb() {
    const root = this._worldRoot || this._proc?.root || null;
    if (!root) {
      this._setStatus('Nothing to export yet. Load or generate a scene first.');
      return;
    }
    const stem = safeName(
      safeTrim(this._ui?.scenarioName?.value || '')
      || getFileStem(safeTrim(this._state?.sourceUrl || ''))
      || safeTrim(this._proc?.kind || '')
      || 'scene'
    );
    this._setStatus(`Exporting scene GLB: ${stem}.glb`);
    try {
      const exporter = new GLTFExporter();
      const glb = await new Promise((resolve, reject) => {
        try {
          exporter.parse(
            root,
            (result) => {
              if (result instanceof ArrayBuffer) {
                resolve(result);
                return;
              }
              reject(new Error('GLB exporter did not return binary data.'));
            },
            (err) => reject(err || new Error('GLB export failed.')),
            { binary: true, onlyVisible: true, includeCustomExtensions: true },
          );
        } catch (e) {
          reject(e);
        }
      });
      const blob = new Blob([glb], { type: 'model/gltf-binary' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${stem}.glb`;
      document.body.appendChild(a);
      a.click();
      try { a.remove(); } catch { /* ignore */ }
      setTimeout(() => {
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
      }, 1000);
      this._setStatus(`Exported scene GLB: ${stem}.glb`);
      this._ctx?.toast?.(`Exported ${stem}.glb`, 'success', { title: 'Scene export' });
    } catch (e) {
      this._setStatus(`Export failed: ${e?.message || e}`);
      this._ctx?.toast?.(String(e?.message || e || 'Export failed'), 'error', { title: 'Scene export failed' });
    }
  }

  // Resume Showcase project panel + repo cycling helpers are installed via `sceneResumeShowcasePanelMixin`.

  /* ─────────────────── World loading ─────────────────── */

  _clearWorld() {
    if (!this._scene) return;
    try { this._hideResumeProjectPanel(); } catch { /* ignore */ }
    try { this._disposeResumeShowcaseWalker(); } catch { /* ignore */ }
    try { this._disposeResumeWalkerTextureSource(); } catch { /* ignore */ }
    if (this._worldRoot) {
      try { this._scene.remove(this._worldRoot); } catch { /* ignore */ }
      try { disposeThreeObject(this._worldRoot); } catch { /* ignore */ }
    }
    if (this._proc?.root) {
      try { this._scene.remove(this._proc.root); } catch { /* ignore */ }
      try { disposeThreeObject(this._proc.root); } catch { /* ignore */ }
    }
    // Room-sim people are attached to the old world; drop them on clear.
    try { this._disposeRoomSimPeople(); } catch { /* ignore */ }
    try { if (this._selectionBox) this._scene.remove(this._selectionBox); } catch { /* ignore */ }
    try { disposeThreeObject(this._selectionBox); } catch { /* ignore */ }
    this._gltf = null;
    this._worldRoot = null;
    this._proc = { kind: '', root: null };
    this._propsRoot = null;
    this._props = [];
    this._colliders = [];
    this._groundRaycastRoots = null;
    try {
      this._acTrack.bundleUrl = '';
      this._acTrack.atMs = 0;
      this._acTrack.loading = false;
      this._acTrack.surfaceFriction = {};
      this._acTrack.roadFriction = 1.0;
      this._acTrack.groundColliderUrl = '';
      this._acTrack.groundColliderLoading = false;
      const gr = this._acTrack.groundColliderRoot;
      if (gr) {
        try { if (gr.parent) gr.parent.remove(gr); } catch { /* ignore */ }
        try { disposeThreeObject(gr); } catch { /* ignore */ }
      }
      this._acTrack.groundColliderRoot = null;
    } catch { /* ignore */ }
    this._obstacleBoxes = [];
    this._obstacleSources = [];
    try { this._resumeWalkerNav.sources = []; } catch { /* ignore */ }
    try { this._resumeWalkerNav.boxes = []; } catch { /* ignore */ }
    try { this._resumeWalkerNav.bounds = null; } catch { /* ignore */ }
    this._enemies = [];
    try { this._vehicleSystem?.resetForWorldClear?.(); } catch { /* ignore */ }
    this._game.enabled = false;
    this._game.nav.built = false;
    this._game.nav.occ = null;
    this._clearFx();
    this._clearGun();
    this._triggerInside.clear();
    this._triggerFired.clear();
    this._completedGoals.clear();
    this._scenarioSel.waypointName = '';
    this._scenarioSel.triggerId = '';
    this._selection = { obj: null, uuid: '', name: '' };
    this._selectionBox = null;
    this._buildingSel = { uuid: '' };
    try { this._scene.fog = null; } catch { /* ignore */ }
    try { this._scene.background = new THREE.Color(0x06080c); } catch { /* ignore */ }
    try { if (this._renderer) this._renderer.toneMappingExposure = 1.0; } catch { /* ignore */ }
    try { this._resumeShowcase.runtime = null; } catch { /* ignore */ }
    try { this._resumeShowcase.cycleSelection = null; } catch { /* ignore */ }
    try { this._resumeShowcase.showCurrentRepo = null; } catch { /* ignore */ }
  }

  async _loadProcedural(path, { scenario = null } = {}) {
    return proceduralMixin._loadProcedural.call(this, path, { scenario });
  }

  async _loadGlb(url, { scenario = null } = {}) {
    const u = safeTrim(url);
    if (!u) return;
    if (!this._scene || !this._camera) return;

    // Guard: the render loop continues ticking while we await GLTFLoader. Freeze gameplay
    // state so gravity/vehicle sim doesn't drop the player through the void mid-load.
    if (this._loadSeq == null) this._loadSeq = 0;
    const loadSeq = ++this._loadSeq;
    this._worldLoading = true;

    try {
      this._setStatus(`Loading: ${u}`);
      this._ctx?.log?.(`Scene: loading ${u}`);
      this._clearWorld();

      const gltf = await this._loader.loadAsync(u);
      this._gltf = gltf;
      const root = gltf.scene || null;
      if (!root) throw new Error('GLTF missing scene');
      this._worldRoot = root;
      this._scene.add(root);

    // Colliders: raycast against the full scene graph.
    // This is less memory than storing per-mesh collider lists, and keeps behavior
    // consistent for imported scenes that nest meshes under groups.
    this._colliders = [root];
    this._groundRaycastRoots = [root];
    // Imported scenes: by default we do ground-only + raycast height.
    // If the GLB contains explicit collider meshes (via tags/names), we build obstacle AABBs from them.
    this._obstacleBoxes = [];
    this._obstacleSources = [];
    try { this._scanObstacleMeshesFromRoot(root); } catch { /* ignore */ }
    try { this._syncVehicleSimStatics(); } catch { /* ignore */ }
    try { await this._maybeEnableAcTrackDrivingForSceneUrl(u); } catch { /* ignore */ }

    // Spawn near model bounds
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const minY = Number.isFinite(box.min.y) ? box.min.y : 0;
    const approxR = Math.max(1, Math.min(2500, Math.max(size.x, size.z) * 0.35));

    // Default spawn if scenario doesn't override.
    this._spawn = { x: center.x, y: minY, z: center.z + approxR };

    // Apply scenario pose/settings if provided.
    if (scenario && typeof scenario === 'object') {
      try { this._applyScenarioPose(scenario); } catch { /* ignore */ }
    } else {
      this._player.x = this._spawn.x;
      this._player.y = this._spawn.y;
      this._player.z = this._spawn.z;
      this._player.vy = 0;
      // Reset scenario content when loading a raw GLB.
      this._scenarioContent = { waypoints: [], triggers: [], meta: { avatarProfile: '', avatarAction: '' } };
      this._avatar3p.forcedActionKey = '';
      // Preserve current look direction but clear any stale roll/lean state.
      this._applyFpsCameraPose({
        yaw: Number(this._camera?.rotation?.y) || 0,
        pitch: Number(this._camera?.rotation?.x) || 0,
        eyeH: Number(this._player.eyeH) || 1.7,
        syncPosition: true,
      });
    }

    // Recovery: if spawn is off-mesh (or Y is wrong), snap to the nearest ground we can find.
    // This is especially important for imported tracks where authored spawn points can be slightly outside
    // the optimized ground collider.
    try { this._snapPlayerToNearestGroundAfterLoad(); } catch { /* ignore */ }

    // Scenario extras: spawn vehicles + start traffic after ground recovery.
    if (scenario && typeof scenario === 'object') {
      try { await this._applyScenarioVehiclesAndTrafficAfterLoad(scenario, { sceneUrl: u }); } catch { /* ignore */ }
    }

    // Orbit target
    this._orbit?.target?.copy?.(center);

    // Camera placement
    if (this._state.mode === 'orbit') {
      this._camera.position.set(center.x + approxR, center.y + Math.max(2, size.y * 0.25), center.z + approxR);
      this._orbit?.update?.();
    } else {
      // Respect on-foot camera mode (first/third) even before pointer lock.
      try { this._applyPlayerCameraBasePose(this._playerCamMode); } catch { /* ignore */ }
    }

    // Spawn marker
    this._syncSpawnMarker();
    this._renderWaypointsUi();
    this._renderTriggersUi();
    this._rebuildScenarioDebug();
    this._scanTaggedBuildings();
    this._renderBuildingsUi();
    this._renderBuildingEditorUi();

    this._state.lastGlbUrl = u;
    this._savePrefs();
    this._setStatus(`Loaded: ${u}`);

      if (this._state.autoPlayAfterLoad && this._state.mode === 'fps') {
        this._tryPointerLock('auto_play_after_glb_load');
      }
    } finally {
      // Only the latest load may clear the flag.
      if (this._loadSeq === loadSeq) this._worldLoading = false;
    }
  }

  async _applyScenarioVehiclesAndTrafficAfterLoad(sc, { sceneUrl = '' } = {}) {
    const scenario = (sc && typeof sc === 'object') ? sc : null;
    if (!scenario) return;
    const content = (scenario?.content && typeof scenario.content === 'object') ? scenario.content : {};
    let vehicles = Array.isArray(content?.vehicles) ? content.vehicles : [];
    const traffic = (content?.traffic && typeof content.traffic === 'object') ? content.traffic : null;
    if (!vehicles.length && !traffic) return;

    const DEFAULT_350Z_URL = '/webautos/ac__streetcarpack_nissan_350z/stream/ac__streetcarpack_nissan_350z_hi.glb';
    const DEFAULT_350Z_META = '/webautos/ac__streetcarpack_nissan_350z/stream/ac__streetcarpack_nissan_350z_hi.meta.json';

    // Exported AC tracks: try to place spawn in the pits (pit_lane.ai) by default.
    // This runs after the world/ground collider is loaded, so we can snap Y reliably.
    try {
      const st = (scenario?.settings && typeof scenario.settings === 'object') ? scenario.settings : {};
      const spawnInPits = (typeof st.spawnInPits === 'boolean') ? st.spawnInPits : true;
      const modelUrl = safeTrim(sceneUrl || this._state?.sourceUrl || this._state?.lastGlbUrl || '');
      const bundleUrl = safeTrim(this._acTrack?.bundleUrl || '') || this._acTrackBundleUrlFromModelUrl(modelUrl);
      if (spawnInPits && bundleUrl) {
        const br = await fetch(bundleUrl, { cache: 'no-store' });
        if (br.ok) {
          const bundle = await br.json();
          const pitUrl = safeTrim(bundle?.paths?.ai_pit_lane_json || bundle?.paths?.aiPitLaneJson || '');
          const pts = Array.isArray(bundle?.model?.bounds_min) && Array.isArray(bundle?.model?.bounds_max)
            ? { min: bundle.model.bounds_min, max: bundle.model.bounds_max }
            : null;
          const spawn0 = scenario?.spawn && typeof scenario.spawn === 'object' ? scenario.spawn : null;
          const sx0 = Number(spawn0?.x);
          const sz0 = Number(spawn0?.z);
          const spawnLooksDefault = (() => {
            if (!pts) return true; // if we can't tell, prefer pits.
            const min = pts.min, max = pts.max;
            const cx = (Number(min?.[0]) + Number(max?.[0])) * 0.5;
            const cz = (Number(min?.[2]) + Number(max?.[2])) * 0.5;
            if (![cx, cz, sx0, sz0].every(Number.isFinite)) return true;
            // If spawn is very near bounds center, treat as default export spawn.
            return Math.hypot(sx0 - cx, sz0 - cz) < 120;
          })();
          if (pitUrl && spawnLooksDefault) {
            const pr = await fetch(pitUrl, { cache: 'no-store' });
            if (pr.ok) {
              const pj = await pr.json();
              const pitPts = Array.isArray(pj?.points) ? pj.points : [];
              const p0 = pitPts?.[0] || null;
              const px = Number(p0?.x);
              const pz = Number(p0?.z);
              const pyRaw = Number(p0?.y);
              if (Number.isFinite(px) && Number.isFinite(pz)) {
                const gy = this._raycastGroundYAt(px, pz, { originY: 800, far: 5000 });
                const py = (gy != null) ? Number(gy) : (Number.isFinite(pyRaw) ? pyRaw : (Number(this._spawn?.y) || 0));
                this._spawn = { x: px, y: py, z: pz };
                this._player.x = px;
                this._player.y = py;
                this._player.z = pz;
                this._player.vy = 0;
                try { if (this._camera) this._camera.position.set(this._player.x, this._player.y + this._player.eyeH, this._player.z); } catch { /* ignore */ }
                try { this._syncSpawnMarker?.(); } catch { /* ignore */ }
              }
            }
          }
        }
      }
    } catch { /* ignore */ }

    // Common saved-scenario gotchas:
    // - traffic is configured (and even recorded) but the player vehicle wasn't persisted
    // - exported AC track scenarios have driving enabled but no explicit player vehicle
    // If any of those apply and we have no explicit vehicles, spawn a default player car and auto-enter it.
    try {
      const trafficEnabled = traffic ? ((traffic?.enabled == null) ? true : !!traffic.enabled) : false;
      const drivingEnabled = (scenario?.settings && typeof scenario.settings === 'object')
        ? (scenario.settings.drivingEnabled !== false)
        : true;
      const modelUrl = safeTrim(sceneUrl || this._state?.sourceUrl || this._state?.lastGlbUrl || '');
      const isExportedAcTrack = !!this._acTrackBundleUrlFromModelUrl(modelUrl);
      const wantAutoPlayerCar = (traffic && trafficEnabled) || (drivingEnabled && isExportedAcTrack);

      if (wantAutoPlayerCar && (!Array.isArray(vehicles) || vehicles.length === 0)) {
        const vUrl = safeTrim(traffic?.vehicleUrl || '') || DEFAULT_350Z_URL;
        const vMeta = (vUrl === DEFAULT_350Z_URL) ? DEFAULT_350Z_META : '';
        vehicles = [
          {
            role: 'player',
            name: '350Z',
            url: vUrl,
            metaUrl: vMeta,
            place: 'spawn',
            yawDeg: 0,
            scale: 1.0,
            autoEnter: true,
            vehicleConfig: {
              schema: 1,
              source: 'scene_tool_fallback',
              modelUrl: vUrl,
              metaUrl: vMeta,
            },
          },
        ];
        // Keep in-memory scenario content in sync so Ctrl+S will persist it.
        try {
          if (this._scenarioContent && typeof this._scenarioContent === 'object') {
            this._scenarioContent.vehicles = vehicles;
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    // Stop any existing traffic when reloading a scenario.
    try { this._vehicleSystem?.stopTraffic?.(); } catch { /* ignore */ }

    // Spawn requested vehicles (best-effort; UI-free).
    if (vehicles.length && this._vehicleSystem) {
      for (const v of vehicles) {
        const url = safeTrim(v?.url || v?.modelUrl || '');
        if (!url) continue;
        const role = safeTrim(v?.role || '') || ((v?.autoEnter === true) ? 'player' : 'npc');
        // Default behavior: if a vehicle is marked as the player vehicle but autoEnter isn't specified,
        // treat it as "start driving" (matches the SRP scenario expectation).
        const autoEnter = (v?.autoEnter == null) ? (role === 'player') : !!v?.autoEnter;
        const scale = Number(v?.scale) || 1.0;
        const yawDeg = Number(v?.yawDeg) || 0;

        // Where to spawn: default to spawn marker.
        const place = safeTrim(v?.place || 'spawn').toLowerCase();
        const posArr = Array.isArray(v?.pos) ? v.pos : null;
        const posObj = (v?.pos && typeof v.pos === 'object') ? v.pos : null;
        let x = Number.isFinite(Number(posObj?.x)) ? Number(posObj.x) : (posArr ? Number(posArr[0]) : NaN);
        let z = Number.isFinite(Number(posObj?.z)) ? Number(posObj.z) : (posArr ? Number(posArr[2]) : NaN);
        if (!Number.isFinite(x) || !Number.isFinite(z)) {
          if (place === 'player') { x = Number(this._player.x) || 0; z = Number(this._player.z) || 0; }
          else { x = Number(this._spawn.x) || 0; z = Number(this._spawn.z) || 0; }
        }

        const prev = { x: Number(this._player.x) || 0, y: Number(this._player.y) || 0, z: Number(this._player.z) || 0 };
        try {
          // Spawn API only supports 'player'/'spawn' placement, so temporarily relocate the player.
          this._player.x = x;
          this._player.z = z;
          this._player.y = Number(this._spawn.y) || 0;

          const vehicleConfig = (v?.vehicleConfig && typeof v.vehicleConfig === 'object') ? v.vehicleConfig : {
            schema: 1,
            source: 'scenario',
            modelUrl: url,
            metaUrl: safeTrim(v?.metaUrl || ''),
            acBundleUrl: safeTrim(v?.acBundleUrl || ''),
          };
          const out = await this._vehicleSystem.spawnDriveableVehicleFromAssetUrl(url, {
            name: safeTrim(v?.name || ''),
            scale,
            yawDeg,
            place: 'player',
            vehicleConfig,
          });

          if (out?.occ && role === 'npc') {
            try { out.occ.set('driver', 'npc'); } catch { /* ignore */ }
          }

          if (autoEnter && role !== 'npc') {
            try {
              this._player.x = Number(out?.group?.position?.x) || this._player.x;
              this._player.z = Number(out?.group?.position?.z) || this._player.z;
              this._player.y = Number(this._spawn.y) || 0;
              this._player.vy = 0;
            } catch { /* ignore */ }
            try {
              const ok = this._vehicleSystem?.enterVehicleById?.(safeTrim(out?.id || ''), 'driver');
              if (!ok) this._vehicleSystem?.tryEnterVehicle?.();
            } catch { /* ignore */ }
          } else {
            // Restore player position if we just used it as a spawn cursor.
            this._player.x = prev.x;
            this._player.y = prev.y;
            this._player.z = prev.z;
          }
        } catch { /* ignore */ }
      }
    }

    // Start traffic if configured.
    if (traffic && this._vehicleSystem?.startTraffic) {
      const enabled = (traffic?.enabled == null) ? true : !!traffic.enabled;
      if (enabled) {
        let routePoints = [];
        const route = (traffic?.route && typeof traffic.route === 'object') ? traffic.route : { kind: '' };
        const kind = safeTrim(route?.kind || '').toLowerCase();

        if (kind === 'ac_ai_fast_lane' || kind === 'ac_fast_lane' || !kind) {
          try {
            const modelUrl = safeTrim(sceneUrl || this._state?.sourceUrl || this._state?.lastGlbUrl || '');
            const bundleUrl = safeTrim(this._acTrack?.bundleUrl || '') || this._acTrackBundleUrlFromModelUrl(modelUrl);
            if (bundleUrl) {
              const br = await fetch(bundleUrl, { cache: 'no-store' });
              if (br.ok) {
                const bundle = await br.json();
                const aiUrl = safeTrim(bundle?.paths?.ai_fast_lane_json || bundle?.paths?.aiFastLaneJson || '');
                if (aiUrl) {
                  const ar = await fetch(aiUrl, { cache: 'no-store' });
                  if (ar.ok) {
                    const aj = await ar.json();
                    const pts = Array.isArray(aj?.points) ? aj.points : [];
                    // Downsample if extremely dense.
                    const step = (pts.length > 5000) ? Math.ceil(pts.length / 5000) : 1;
                    for (let i = 0; i < pts.length; i += step) {
                      const p = pts[i];
                      const x = Number(p?.x);
                      const y = Number(p?.y);
                      const z = Number(p?.z);
                      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
                      routePoints.push({ x, y: Number.isFinite(y) ? y : 0, z });
                    }
                  }
                }
              }
            }
          } catch { /* ignore */ }
          // Fallback: if the scenario already has recorded points, use them.
          if (!routePoints.length) {
            const pts = Array.isArray(route?.points) ? route.points : [];
            for (const p of pts) {
              const x = Number(p?.x);
              const y = Number(p?.y);
              const z = Number(p?.z);
              if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
              routePoints.push({ x, y: Number.isFinite(y) ? y : 0, z });
            }
          }
        } else if (kind === 'waypoints') {
          const wps = Array.isArray(content?.waypoints) ? content.waypoints : [];
          for (const w of wps) {
            const x = Number(w?.x);
            const y = Number(w?.y);
            const z = Number(w?.z);
            if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
            routePoints.push({ x, y: Number.isFinite(y) ? y : 0, z });
          }
        } else if (kind === 'points') {
          const pts = Array.isArray(route?.points) ? route.points : [];
          for (const p of pts) {
            const x = Number(p?.x);
            const y = Number(p?.y);
            const z = Number(p?.z);
            if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
            routePoints.push({ x, y: Number.isFinite(y) ? y : 0, z });
          }
        }

        const trafficVehicleUrl = safeTrim(traffic?.vehicleUrl || '') || DEFAULT_350Z_URL;
        const count = Math.max(1, Math.min(200, Math.floor(Number(traffic?.count) || 28)));
        const spacingM = Math.max(6, Math.min(140, Number(traffic?.spacingM) || 22));
        const speedKphMin = Math.max(5, Math.min(260, Number(traffic?.speedKphMin) || 70));
        const speedKphMax = Math.max(speedKphMin, Math.min(320, Number(traffic?.speedKphMax) || 115));
        const laneOffsetM = clamp(Number(traffic?.laneOffsetM) || 0, -12, 12);

        if (routePoints.length >= 3) {
          try {
            await this._vehicleSystem.startTraffic({
              routePoints,
              vehicleUrl: trafficVehicleUrl,
              count,
              spacingM,
              speedKphMin,
              speedKphMax,
              laneOffsetM,
            });
          } catch { /* ignore */ }
        } else {
          // If route didn't load, keep it quiet but leave a hint in status.
          try { this._setStatus('Traffic route missing (no AC fast_lane.ai parsed, or routePoints empty).'); } catch { /* ignore */ }
        }
      }
    }
  }

  _raycastGroundYAt(x, z, { originY = 250, far = 2500 } = {}) {
    if (!this._ray) return null;
    const roots = Array.isArray(this._groundRaycastRoots) && this._groundRaycastRoots.length
      ? this._groundRaycastRoots
      : (Array.isArray(this._colliders) ? this._colliders : []);
    // If we have no raycast roots, we cannot reliably infer ground height.
    // Returning null lets callers fall back to scenario spawn/bounds-derived Y.
    if (!roots.length) return null;
    const ox = Number(x) || 0;
    const oz = Number(z) || 0;
    const oy = Number(originY) || 0;
    this._ray.set(new THREE.Vector3(ox, oy, oz), new THREE.Vector3(0, -1, 0));
    this._ray.far = Math.max(1, Number(far) || 2500);
    const hits = this._ray.intersectObjects(roots, true) || [];
    if (!hits.length) return null;
    // Prefer walkable-ish faces (ignore near-vertical hits).
    const pick = hits.find((h) => Number(h?.face?.normal?.y) >= 0.12) || hits[0];
    const py = Number(pick?.point?.y);
    return Number.isFinite(py) ? py : null;
  }

  _snapPlayerToNearestGroundAfterLoad() {
    if (!this._player) return;
    const x0 = Number(this._player.x) || 0;
    const z0 = Number(this._player.z) || 0;
    const y0 = Number(this._player.y) || 0;
    // Cast from well above current position to handle "spawn below ground" and large scenes.
    const originY = Math.max(250, y0 + 20);
    const base = this._raycastGroundYAt(x0, z0, { originY, far: 3500 });
    if (base != null) {
      this._player.y = Number(base) || 0;
      this._player.vy = 0;
      this._player.onGround = true;
      try { this._spawn.y = Number(base) || 0; } catch { /* ignore */ }
      return;
    }

    // Spiral-ish search around the spawn for the nearest patch of ground.
    // This fixes cases where the exported spawn lands slightly off the driveable collider mesh.
    const radii = [2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 80, 110, 150];
    for (const r of radii) {
      const steps = Math.max(8, Math.min(36, Math.floor((Math.PI * 2 * r) / 6)));
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const x = x0 + Math.cos(a) * r;
        const z = z0 + Math.sin(a) * r;
        const gy = this._raycastGroundYAt(x, z, { originY, far: 3500 });
        if (gy == null) continue;
        this._player.x = x;
        this._player.z = z;
        this._player.y = Number(gy) || 0;
        this._player.vy = 0;
        this._player.onGround = true;
        try { this._spawn.x = x; this._spawn.z = z; this._spawn.y = Number(gy) || 0; } catch { /* ignore */ }
        return;
      }
    }
  }

  _scanObstacleMeshesFromRoot(root) {
    // Build obstacle boxes from meshes that are explicitly tagged, or named like colliders.
    // Supported conventions:
    // - userData.isObstacle = true
    // - userData.projectTags includes: "obstacle" or "collider"
    // - name includes: collider|collision|obstacle|blocker|navblock|wallcol|wall...
    const r = root;
    if (!r || !r.traverse) return;
    const out = [];
    const nameLooksLikeCollider = (nm) => {
      const s = String(nm || '').toLowerCase();
      return s.includes('collider') || s.includes('collision') || s.includes('obstacle') || s.includes('blocker') || s.includes('navblock') || s.includes('wallcol');
    };
    const nameLooksLikeWall = (nm) => {
      const s = String(nm || '').toLowerCase();
      if (!s) return false;
      return (
        s.includes('wall') ||
        s.includes('partition') ||
        s.includes('fence') ||
        s.includes('railing')
      );
    };
    const nameLooksLikeFloor = (nm) => {
      const s = String(nm || '').toLowerCase();
      return s.includes('floor') || s.includes('ground') || s.includes('terrain') || s.includes('road') || s.includes('sidewalk');
    };
    r.traverse((o) => {
      if (!o) return;
      const isMesh = !!(o.isMesh || o.isSkinnedMesh);
      if (!isMesh) return;
      const ud = (o.userData && typeof o.userData === 'object') ? o.userData : {};
      const tags = this._getProjectTags(o).map((x) => String(x || '').toLowerCase());
      const tagged = !!ud.isObstacle || tags.some((t) => (t === 'obstacle' || t === 'collider'));
      const named = nameLooksLikeCollider(o.name) || nameLooksLikeWall(o.name);
      if (!tagged && !named) return;
      // Avoid treating floors/ground as obstacles even if they were named like colliders.
      if (!tagged && nameLooksLikeFloor(o.name)) return;

      // Heuristic: avoid boxing very flat "floor" meshes even if misnamed/tagged.
      try {
        const b = new THREE.Box3().setFromObject(o);
        const sx = (b.max.x - b.min.x);
        const sy = (b.max.y - b.min.y);
        const sz = (b.max.z - b.min.z);
        // Increase threshold: many "ground collider" meshes are a thin box ~0.3–0.5m tall.
        if (sy < 0.60 && sx > 2.0 && sz > 2.0) return;
      } catch { /* ignore */ }

      out.push(o);
    });
    if (!out.length) return;
    this._obstacleSources = out;
    this._rebuildObstacleBoxesFromSources();
  }

  _applyFpsCameraPose({
    yaw = 0,
    pitch = 0,
    eyeH = null,
    syncPosition = true,
  } = {}) {
    if (!this._camera || !this._player) return;
    const y = Number.isFinite(Number(yaw)) ? Number(yaw) : 0;
    const p = clamp(Number.isFinite(Number(pitch)) ? Number(pitch) : 0, -1.35, 1.35);
    const h = Number.isFinite(Number(eyeH)) ? Math.max(0.6, Number(eyeH)) : (Number(this._player.eyeH) || 1.7);

    // Normalize camera orientation to FPS conventions before applying yaw/pitch.
    try { this._camera.rotation.order = 'YXZ'; } catch { /* ignore */ }
    try { this._camera.rotation.y = y; } catch { /* ignore */ }
    try { this._camera.rotation.x = p; } catch { /* ignore */ }
    try { this._camera.rotation.z = 0; } catch { /* ignore */ }

    // Keep runtime state in sync so movement/third-person helpers don't inherit stale values.
    try { this._player.eyeH = h; } catch { /* ignore */ }
    try { this._player.yawRad = y; } catch { /* ignore */ }
    try { this._player.vy = Number(this._player.vy) || 0; } catch { /* ignore */ }

    // Reset lean to avoid "tilted/off-center" carryover when switching worlds.
    try {
      if (this._player?.leanQ?.identity) this._player.leanQ.identity();
      this._player.leanT = 0;
    } catch { /* ignore */ }

    if (syncPosition) {
      try {
        this._camera.position.set(
          Number(this._player.x) || 0,
          (Number(this._player.y) || 0) + (Number(this._player.eyeH) || h),
          Number(this._player.z) || 0,
        );
      } catch { /* ignore */ }
    }
  }

  _resetToSpawn() {
    this._player.x = this._spawn.x;
    this._player.y = this._spawn.y;
    this._player.z = this._spawn.z;
    this._player.vy = 0;
    // Keep current look direction, but clear roll so reset is visually stable.
    this._applyFpsCameraPose({
      yaw: Number(this._camera?.rotation?.y) || 0,
      pitch: Number(this._camera?.rotation?.x) || 0,
      eyeH: Number(this._player.eyeH) || 1.7,
      syncPosition: true,
    });
    // Respect on-foot camera mode (first/third) immediately, even if not pointer-locked.
    try { this._applyPlayerCameraBasePose(this._playerCamMode); } catch { /* ignore */ }
    this._syncSpawnMarker();
  }

  /* ─────────────────── Controls / physics ─────────────────── */

  _enableResumeMobileControls() {
    // Only for the exported resume page.
    if (!globalThis.__resumeShowcase) return;
    if (!this._canvas) return;
    if (!this._resumeMobile) return;
    if (this._resumeMobile.enabled) return;
    this._resumeMobile.enabled = true;

    // Ensure the canvas doesn't trigger scroll/zoom.
    try { this._canvas.style.touchAction = 'none'; } catch { /* ignore */ }

    const isTouchLike = (e) => {
      const pt = String(e?.pointerType || '');
      return pt === 'touch' || pt === 'pen';
    };

    const onPointerDown = (e) => {
      if (!isTouchLike(e)) return;
      if (!this._resumeMobile?.enabled) return;
      if (!this._resumeMobile?.touch) return;
      try { e.preventDefault?.(); } catch { /* ignore */ }

      // First gesture: request motion permission on iOS and start listening.
      try { void this._requestResumeTiltPermissionFromGesture(); } catch { /* ignore */ }

      const t = this._resumeMobile.touch;
      // Ignore additional fingers while one is active.
      if (t.active) return;
      t.active = true;
      t.pointerId = Number(e.pointerId) || 0;
      t.x = Number(e.clientX) || 0;
      t.y = Number(e.clientY) || 0;
      t.moved = false;
      t.t0 = performance.now();
      try { this._canvas?.setPointerCapture?.(t.pointerId); } catch { /* ignore */ }
    };

    const onPointerMove = (e) => {
      if (!isTouchLike(e)) return;
      if (!this._resumeMobile?.enabled) return;
      const t = this._resumeMobile.touch;
      if (!t?.active) return;
      if ((Number(e.pointerId) || 0) !== (Number(t.pointerId) || 0)) return;
      try { e.preventDefault?.(); } catch { /* ignore */ }
      const x = Number(e.clientX) || 0;
      const y = Number(e.clientY) || 0;
      const dx = x - (Number(t.x) || 0);
      const dy = y - (Number(t.y) || 0);
      t.x = x;
      t.y = y;
      if (!t.moved) {
        const dist = Math.hypot(dx, dy);
        if (dist >= 6) t.moved = true;
      }
      if (!t.moved) return;
      try { this._applyResumeTouchLookDelta(dx, dy); } catch { /* ignore */ }
    };

    const onPointerUp = (e) => {
      if (!isTouchLike(e)) return;
      if (!this._resumeMobile?.enabled) return;
      const t = this._resumeMobile.touch;
      if (!t?.active) return;
      if ((Number(e.pointerId) || 0) !== (Number(t.pointerId) || 0)) return;
      try { e.preventDefault?.(); } catch { /* ignore */ }

      const heldMs = performance.now() - (Number(t.t0) || 0);
      const wasTap = !t.moved && heldMs >= 0 && heldMs < 260;

      t.active = false;
      t.pointerId = -1;
      t.moved = false;

      if (wasTap) {
        // Tap = interact (same as pressing E near an interactable).
        try { this._injectVirtualKeyTap('KeyE'); } catch { /* ignore */ }
      }
    };

    const onPointerCancel = (e) => {
      if (!isTouchLike(e)) return;
      const t = this._resumeMobile?.touch;
      if (!t?.active) return;
      if ((Number(e.pointerId) || 0) !== (Number(t.pointerId) || 0)) return;
      t.active = false;
      t.pointerId = -1;
      t.moved = false;
    };

    // NOTE: pointer events cover mobile Safari/Chrome well; keep listeners non-passive so we can preventDefault.
    try { this._canvas.addEventListener('pointerdown', onPointerDown, { passive: false }); } catch { /* ignore */ }
    try { this._canvas.addEventListener('pointermove', onPointerMove, { passive: false }); } catch { /* ignore */ }
    try { this._canvas.addEventListener('pointerup', onPointerUp, { passive: false }); } catch { /* ignore */ }
    try { this._canvas.addEventListener('pointercancel', onPointerCancel, { passive: false }); } catch { /* ignore */ }

    this._resumeMobile.handlers.pointerdown = onPointerDown;
    this._resumeMobile.handlers.pointermove = onPointerMove;
    this._resumeMobile.handlers.pointerup = onPointerUp;
    this._resumeMobile.handlers.pointercancel = onPointerCancel;
  }

  _disableResumeMobileControls() {
    const st = this._resumeMobile;
    if (!st?.enabled) return;
    st.enabled = false;

    try {
      const c = this._canvas;
      if (c && st.handlers.pointerdown) c.removeEventListener('pointerdown', st.handlers.pointerdown);
      if (c && st.handlers.pointermove) c.removeEventListener('pointermove', st.handlers.pointermove);
      if (c && st.handlers.pointerup) c.removeEventListener('pointerup', st.handlers.pointerup);
      if (c && st.handlers.pointercancel) c.removeEventListener('pointercancel', st.handlers.pointercancel);
    } catch { /* ignore */ }

    try {
      if (st.tilt.listening && st.handlers.orientation) {
        window.removeEventListener('deviceorientation', st.handlers.orientation);
      }
    } catch { /* ignore */ }

    st.handlers.pointerdown = null;
    st.handlers.pointermove = null;
    st.handlers.pointerup = null;
    st.handlers.pointercancel = null;
    st.handlers.orientation = null;
    st.tilt.listening = false;
    st.tilt.neutral = null;
    st.tilt.moveF = 0;
    st.tilt.moveS = 0;
    try { st.touch.active = false; } catch { /* ignore */ }
  }

  async _requestResumeTiltPermissionFromGesture() {
    const st = this._resumeMobile;
    if (!st?.enabled) return false;
    if (st.tilt.listening) return true;

    // If this environment doesn't support deviceorientation, do nothing.
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return false;
    if (typeof DeviceOrientationEvent === 'undefined') return false;

    // iOS 13+ requires permission from a user gesture.
    try {
      const req = DeviceOrientationEvent?.requestPermission;
      if (typeof req === 'function') {
        const res = await req.call(DeviceOrientationEvent);
        if (String(res || '').toLowerCase() !== 'granted') return false;
      }
    } catch {
      return false;
    }

    const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, Number(x) || 0));
    const deadzone = (x, dz) => (Math.abs(x) < dz ? 0 : x);
    const angleDeg = () => {
      try {
        const a = Number(screen?.orientation?.angle);
        if (Number.isFinite(a)) return a;
      } catch { /* ignore */ }
      // eslint-disable-next-line no-undef
      try { if (typeof window.orientation === 'number') return Number(window.orientation) || 0; } catch { /* ignore */ }
      return 0;
    };

    const onOrient = (e) => {
      if (!st?.enabled) return;
      const beta = clamp(e?.beta, -90, 90);
      const gamma = clamp(e?.gamma, -90, 90);
      st.tilt.beta = beta;
      st.tilt.gamma = gamma;
      if (!st.tilt.neutral) st.tilt.neutral = { beta, gamma };

      const nb = Number(st.tilt.neutral?.beta) || 0;
      const ng = Number(st.tilt.neutral?.gamma) || 0;
      const db = beta - nb;
      const dg = gamma - ng;

      // Map orientation deltas into forward/strafe intent.
      // Calibrated around "neutral" (first permission-granted reading).
      const a = ((angleDeg() % 360) + 360) % 360;
      const tiltFwdRange = 24;  // degrees for full-speed
      const tiltSideRange = 18; // degrees for full-speed

      let f = 0;
      let s = 0;
      if (a === 90) { // landscape left
        f = dg / tiltFwdRange;
        s = db / tiltSideRange;
      } else if (a === 270) { // landscape right
        f = (-dg) / tiltFwdRange;
        s = (-db) / tiltSideRange;
      } else { // portrait-ish
        f = (-db) / tiltFwdRange;
        s = (dg) / tiltSideRange;
      }
      f = deadzone(clamp(f, -1, 1), 0.12);
      s = deadzone(clamp(s, -1, 1), 0.12);
      st.tilt.moveF = f;
      st.tilt.moveS = s;
    };

    st.handlers.orientation = onOrient;
    try { window.addEventListener('deviceorientation', onOrient, { passive: true }); } catch { return false; }
    st.tilt.listening = true;
    return true;
  }

  /* ─────────────────── Assetto track: friction + ground collider ─────────────────── */

  _acTrackBundleUrlFromModelUrl(modelUrl) {
    const u = safeTrim(modelUrl);
    if (!u) return '';
    const nu = normalizeAssetUrl(u);
    if (!nu) return '';
    // Export layout:
    // assets/generated/assetto_corsa/tracks/<track>/<run>/model/<file>.glb
    // assets/generated/assetto_corsa/tracks/<track>/<run>/normalized/track.bundle.json
    const m = nu.match(/^(.*\/assets\/generated\/assetto_corsa\/tracks\/[^/]+\/[^/]+)\/model\/[^/]+\.glb(\?.*)?$/i);
    if (!m) return '';
    return `${m[1]}/normalized/track.bundle.json`;
  }

  async _maybeEnableAcTrackDrivingForSceneUrl(modelUrl) {
    try {
      if (!this._acTrack?.enabled) return;
      const bundleUrl = this._acTrackBundleUrlFromModelUrl(modelUrl);
      if (!bundleUrl) return;
      if (this._acTrack.loading) return;
      const now = Date.now();
      const same = safeTrim(this._acTrack.bundleUrl) === safeTrim(bundleUrl);
      if (same && (now - (Number(this._acTrack.atMs) || 0)) < 60_000) return;

      this._acTrack.loading = true;
      this._acTrack.bundleUrl = bundleUrl;
      this._acTrack.atMs = now;

      const bundleResp = await fetch(bundleUrl, { cache: 'no-store' });
      if (!bundleResp.ok) throw new Error(`Track bundle fetch failed: HTTP ${bundleResp.status}`);
      const bundle = await bundleResp.json();

      const paramsUrl = safeTrim(bundle?.paths?.ac_raw_params_json || '');
      if (paramsUrl) {
        const pr = await fetch(paramsUrl, { cache: 'no-store' });
        if (pr.ok) {
          const pj = await pr.json();
          const entries = Array.isArray(pj?.entries) ? pj.entries : [];
          const norm = (s) => String(s || '').trim().toLowerCase();
          const bySection = new Map(); // section -> { key, friction, valid, pit }
          for (const e of entries) {
            const file = norm(e?.file || '');
            if (!file.endsWith('surfaces.ini') && !file.endsWith('/surfaces.ini')) continue;
            const sec = String(e?.section || '').trim();
            if (!sec) continue;
            const key = norm(e?.key || '');
            const val = String(e?.value ?? '').trim();
            if (!bySection.has(sec)) bySection.set(sec, { key: '', friction: NaN, valid: NaN, pit: NaN });
            const it = bySection.get(sec);
            if (key === 'key') it.key = String(val || '').trim().toUpperCase();
            if (key === 'friction') it.friction = Number(val);
            if (key === 'is_valid_track') it.valid = Number(val);
            if (key === 'is_pitlane') it.pit = Number(val);
          }
          const out = {};
          for (const it of bySection.values()) {
            const k = String(it.key || '').trim().toUpperCase();
            if (!k) continue;
            const f = Number(it.friction);
            if (Number.isFinite(f) && f > 0) out[k] = f;
          }
          this._acTrack.surfaceFriction = out;
          const rf = Number(out.ROAD);
          this._acTrack.roadFriction = (Number.isFinite(rf) && rf > 0) ? rf : 1.0;
        }
      }

      // Optional optimized ground collider GLB.
      const groundUrl = safeTrim(bundle?.paths?.ground_collider_glb || bundle?.paths?.groundColliderGlb || '');
      if (groundUrl && safeTrim(this._acTrack.groundColliderUrl) !== groundUrl) {
        this._acTrack.groundColliderUrl = groundUrl;
        await this._loadAcTrackGroundCollider(groundUrl);
      }
    } catch (e) {
      // Keep this best-effort; SceneTool should still work without track metadata.
      try { this._setStatus(`AC track friction/collider setup skipped: ${e?.message || e}`); } catch { /* ignore */ }
    } finally {
      try { this._acTrack.loading = false; this._acTrack.atMs = Date.now(); } catch { /* ignore */ }
    }
  }

  async _loadAcTrackGroundCollider(url) {
    const u = safeTrim(url);
    if (!u || !this._scene) return;
    if (this._acTrack.groundColliderLoading) return;
    this._acTrack.groundColliderLoading = true;
    try {
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(u);
      const root = gltf?.scene || null;
      if (!root) return;
      root.name = '__ac_ground_collider';
      root.visible = false;
      // Replace prior collider root.
      const prev = this._acTrack.groundColliderRoot;
      if (prev) {
        try { if (prev.parent) prev.parent.remove(prev); } catch { /* ignore */ }
        try { disposeThreeObject(prev); } catch { /* ignore */ }
      }
      this._acTrack.groundColliderRoot = root;
      // Attach under the world so it shares world transforms (usually identity).
      try { (this._worldRoot || this._scene).add(root); } catch { /* ignore */ }
      this._groundRaycastRoots = [root];
    } catch { /* ignore */ }
    finally { this._acTrack.groundColliderLoading = false; }
  }

  _raycastGroundMaterialName(x, z) {
    if (!this._ray) return '';
    const roots = Array.isArray(this._groundRaycastRoots) && this._groundRaycastRoots.length
      ? this._groundRaycastRoots
      : (Array.isArray(this._colliders) ? this._colliders : []);
    if (!roots.length) return '';
    const origin = new THREE.Vector3(Number(x) || 0, 500, Number(z) || 0);
    this._ray.set(origin, new THREE.Vector3(0, -1, 0));
    this._ray.far = 1200;
    const hits = this._ray.intersectObjects(roots, true) || [];
    if (!hits.length) return '';
    // Prefer walkable-ish faces (ignore near-vertical hits).
    const pick = hits.find((h) => Number(h?.face?.normal?.y) >= 0.12) || hits[0];
    const obj = pick?.object || null;
    const mat = obj?.material;
    if (Array.isArray(mat)) {
      const mi = Number.isFinite(Number(pick?.face?.materialIndex)) ? Number(pick.face.materialIndex) : 0;
      return safeTrim(mat?.[mi]?.name || mat?.[0]?.name || '');
    }
    return safeTrim(mat?.name || '');
  }

  _getAcTrackMuMulAt(x, z) {
    const surf = (this._acTrack && typeof this._acTrack === 'object') ? this._acTrack.surfaceFriction : null;
    const roadF = Number(this._acTrack?.roadFriction) || 1.0;
    if (!surf || !Object.keys(surf).length) return 1.0;
    const name = this._raycastGroundMaterialName(x, z);
    const nm = safeTrim(name).toUpperCase();
    if (!nm) return 1.0;
    const direct = Number(surf[nm]);
    if (Number.isFinite(direct) && direct > 0) return direct / Math.max(1e-6, roadF);
    // Fallback: substring match (material names often include the key).
    for (const [k, f] of Object.entries(surf)) {
      const kk = String(k || '').toUpperCase();
      if (!kk) continue;
      if (nm.includes(kk)) {
        const ff = Number(f);
        if (Number.isFinite(ff) && ff > 0) return ff / Math.max(1e-6, roadF);
      }
    }
    return 1.0;
  }

  // Scenario helpers + trigger logic are installed via `sceneScenarioMixin`.

  // Buildings IO is installed via `sceneBuildingsMixin`.
  // Buildings UI/editor is installed via `sceneBuildingsUiMixin`.

  _rebuildObstacleBoxesFromSources() {
    this._obstacleBoxes = buildObstacleBoxesFromSources({
      sources: this._obstacleSources,
      worldRoot: this._worldRoot,
    });
    // Keep vehicle physics static colliders in sync (WASM backend).
    try { this._vehicleSystem?.syncStatics?.(); } catch { /* ignore */ }
  }

  async _initProjectChronoWasm() {
    // Only switch to WASM if it successfully loads.
    const ok = await this._chronoVehWasm.init();
    if (!ok) return;

    this._vehicleSim = this._chronoVehWasm;
    this._vehicleSimKind = 'wasm';
    try { this._ctx?.toast?.('Project Chrono WASM loaded (vehicle physics enabled)', 'success', { title: 'Vehicles' }); } catch { /* ignore */ }

    // Create a fresh Chrono world and re-bind existing vehicles to it.
    try { this._vehicleSim.reset(); } catch { /* ignore */ }
    try { this._syncVehicleSimStatics(); } catch { /* ignore */ }
    try { this._recreateVehicleSimHandles(); } catch { /* ignore */ }
  }

  _syncVehicleSimStatics() {
    if (this._vehicleSimKind !== 'wasm') return;
    const sim = this._vehicleSim;
    if (!sim?.ready) return;
    const boxes = Array.isArray(this._obstacleBoxes) ? this._obstacleBoxes : [];
    // Pack as [minx,miny,minz,maxx,maxy,maxz] in WORLD coordinates (Three.js).
    const out = new Float32Array(boxes.length * 6);
    let n = 0;
    for (const b of boxes) {
      if (!b?.min || !b?.max) continue;
      const i = n * 6;
      out[i + 0] = Number(b.min.x) || 0;
      out[i + 1] = Number(b.min.y) || 0;
      out[i + 2] = Number(b.min.z) || 0;
      out[i + 3] = Number(b.max.x) || 0;
      out[i + 4] = Number(b.max.y) || 0;
      out[i + 5] = Number(b.max.z) || 0;
      n++;
    }
    if (!n) sim.setStaticAabbsWorld(new Float32Array());
    else sim.setStaticAabbsWorld((n === boxes.length) ? out : out.slice(0, n * 6));
  }

  _recreateVehicleSimHandles() {
    const sim = this._vehicleSim;
    if (!sim) return;
    for (const v of (this._vehicles || [])) {
      if (!v?.group) continue;
      const x0 = Number(v.group.position.x) || 0;
      const z0 = Number(v.group.position.z) || 0;
      let h = 0;
      try {
        const yawSim = Number(v?.yawSim);
        const yaw0 = Number.isFinite(yawSim) ? yawSim : (Number(v.yaw) || 0);
        if (this._vehicleSimKind === 'js') {
          const jsOpts = (v?.simCreateOptions?.js && typeof v.simCreateOptions.js === 'object')
            ? v.simCreateOptions.js
            : { radius: Math.max(0.8, Number(v?.radius) || 1.2) };
          h = Number(sim.createVehicle({
            x: x0,
            z: z0,
            yaw: yaw0,
            ...jsOpts,
          })) || 0;
        } else {
          // No placeholders: only allow JSON-defined Chrono vehicles.
          const jsonPath = safeTrim(v?.simCreateOptions?.wasm?.jsonPath || '');
          const tireJsonPath = safeTrim(v?.simCreateOptions?.wasm?.tireJsonPath || '');
          if (jsonPath && typeof sim.createVehicleJson === 'function') {
            h = Number(sim.createVehicleJson({ jsonPath, tireJsonPath, x: x0, z: z0, yaw: yaw0 })) || 0;
          }
        }
      } catch { h = 0; }
      v.simHandle = h;
    }
  }

  // Scenario debug markers are installed via `sceneScenarioMixin`.

  /* ─────────────────── FPS demo gameplay (proc:arena) ─────────────────── */

  _buildHudOverlay(ctx) {
    try { this._hudOverlay?.parentNode?.removeChild(this._hudOverlay); } catch { /* ignore */ }
    this._hudOverlay = null;
    this._hudEls = { root: null, crosshair: null, topLeft: null, msg: null, hit: null, veh: null };

    const root = el('div', { style: {
      position: 'fixed',
      inset: '0',
      // Keep HUD above devtools dock panels (some shells use very high z-index layers).
      zIndex: '9999',
      pointerEvents: 'none',
      fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
      color: 'rgba(234,240,255,0.92)',
    } });

    const crosshair = el('div', { style: {
      position: 'fixed',
      left: '50%',
      top: '50%',
      width: '14px',
      height: '14px',
      transform: 'translate(-50%,-50%)',
      opacity: '0.85',
    } }, [
      el('div', { style: { position: 'absolute', left: '6px', top: '0', width: '2px', height: '14px', background: 'rgba(234,240,255,0.55)' } }),
      el('div', { style: { position: 'absolute', left: '0', top: '6px', width: '14px', height: '2px', background: 'rgba(234,240,255,0.55)' } }),
    ]);

    const topLeft = el('div', { style: {
      position: 'fixed',
      left: '12px',
      top: '12px',
      padding: '10px 12px',
      borderRadius: '8px',
      background: 'rgba(10,13,18,0.65)',
      border: '1px solid rgba(255,255,255,0.10)',
      backdropFilter: 'blur(10px)',
      WebkitBackdropFilter: 'blur(10px)',
      minWidth: '220px',
      whiteSpace: 'pre',
      fontSize: '11px',
      lineHeight: '1.45',
    } }, ['']);

    const msg = el('div', { style: {
      position: 'fixed',
      left: '50%',
      top: '18%',
      transform: 'translateX(-50%)',
      padding: '8px 12px',
      borderRadius: '10px',
      background: 'rgba(10,13,18,0.62)',
      border: '1px solid rgba(255,255,255,0.10)',
      fontSize: '12px',
      opacity: '0',
      transition: 'opacity 120ms ease',
      maxWidth: 'min(720px, calc(100vw - 28px))',
      textAlign: 'center',
      whiteSpace: 'pre-wrap',
    } }, ['']);

    const hit = el('div', { style: {
      position: 'fixed',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%,-50%)',
      width: '22px',
      height: '22px',
      borderRadius: '999px',
      boxShadow: '0 0 0 2px rgba(255,209,102,0.0) inset',
      opacity: '0',
      transition: 'opacity 60ms linear',
      pointerEvents: 'none',
    } });

    // Vehicle HUD (Assetto-style driving stats)
    const vehSpeedVal = el('div', { style: { fontSize: '34px', fontWeight: '700', letterSpacing: '-0.02em', lineHeight: '1.0' } }, ['0']);
    const vehSpeedUnit = el('div', { style: { fontSize: '12px', opacity: '0.85', marginLeft: '6px' } }, ['KPH']);
    const vehGearVal = el('div', { style: {
      marginLeft: 'auto',
      fontSize: '22px',
      fontWeight: '700',
      padding: '4px 10px',
      borderRadius: '10px',
      background: 'rgba(255,255,255,0.08)',
      border: '1px solid rgba(255,255,255,0.12)',
      minWidth: '44px',
      textAlign: 'center',
    } }, ['1']);
    const vehRpmVal = el('div', { style: { fontSize: '12px', opacity: '0.92' } }, ['0 rpm']);
    const vehOdoVal = el('div', { style: { fontSize: '12px', opacity: '0.82' } }, ['0.00 km']);
    const vehRpmBarFill = el('div', { style: { height: '100%', width: '0%', background: 'linear-gradient(90deg, rgba(126,179,255,0.95), rgba(255,90,90,0.95))' } });
    const vehRpmBar = el('div', { style: {
      marginTop: '6px',
      height: '6px',
      borderRadius: '999px',
      overflow: 'hidden',
      background: 'rgba(255,255,255,0.10)',
      border: '1px solid rgba(255,255,255,0.10)',
    } }, [vehRpmBarFill]);
    const vehPedalThrottleFill = el('div', { style: { height: '100%', width: '0%', background: 'rgba(126,179,255,0.92)' } });
    const vehPedalBrakeFill = el('div', { style: { height: '100%', width: '0%', background: 'rgba(255,90,90,0.92)' } });
    const pedalBarStyle = {
      height: '5px',
      borderRadius: '999px',
      overflow: 'hidden',
      background: 'rgba(255,255,255,0.08)',
      border: '1px solid rgba(255,255,255,0.10)',
    };
    const vehPedals = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '8px' } }, [
      el('div', { style: pedalBarStyle }, [vehPedalThrottleFill]),
      el('div', { style: pedalBarStyle }, [vehPedalBrakeFill]),
    ]);
    const vehTagStyle = {
      padding: '2px 8px',
      borderRadius: '999px',
      background: 'rgba(255,255,255,0.06)',
      border: '1px solid rgba(255,255,255,0.12)',
      fontSize: '10px',
      fontWeight: '700',
      letterSpacing: '-0.01em',
      lineHeight: '1.4',
      opacity: '0.92',
    };
    const vehCamTag = el('div', { style: vehTagStyle }, ['CAM 1P']);
    const vehHbTag = el('div', { style: { ...vehTagStyle, opacity: '0.65' } }, ['HB']);
    const vehControlsHint = el('div', { style: { marginLeft: 'auto', fontSize: '10px', opacity: '0.62', whiteSpace: 'nowrap' } }, [
      'W/S throttle+brake · A/D steer · Space HB · V cam · F exit',
    ]);
    const vehMeta = el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' } }, [
      vehCamTag,
      vehHbTag,
      vehControlsHint,
    ]);
    const vehicleHud = el('div', { style: {
      position: 'fixed',
      right: '12px',
      bottom: '12px',
      zIndex: '10000',
      padding: '10px 12px',
      borderRadius: '10px',
      background: 'rgba(10,13,18,0.65)',
      border: '1px solid rgba(255,255,255,0.10)',
      backdropFilter: 'blur(10px)',
      WebkitBackdropFilter: 'blur(10px)',
      minWidth: '250px',
      display: 'none',
      pointerEvents: 'none',
    } }, [
      el('div', { style: { display: 'flex', alignItems: 'baseline', gap: '0px' } }, [
        vehSpeedVal,
        vehSpeedUnit,
        vehGearVal,
      ]),
      el('div', { style: { display: 'flex', gap: '10px', marginTop: '6px', alignItems: 'baseline' } }, [
        vehRpmVal,
        el('div', { style: { marginLeft: 'auto' } }, [vehOdoVal]),
      ]),
      vehRpmBar,
      vehPedals,
      vehMeta,
    ]);

    // Scope overlay (sniper aim)
    const scope = el('div', { style: {
      position: 'fixed',
      inset: '0',
      zIndex: '26',
      pointerEvents: 'none',
      display: 'none',
      background: 'radial-gradient(circle at center, rgba(0,0,0,0) 0 150px, rgba(0,0,0,0.92) 170px)',
    } }, [
      // ring
      el('div', { style: {
        position: 'fixed',
        left: '50%',
        top: '50%',
        width: '340px',
        height: '340px',
        transform: 'translate(-50%,-50%)',
        borderRadius: '999px',
        border: '2px solid rgba(234,240,255,0.35)',
        boxShadow: '0 0 0 1px rgba(0,0,0,0.65) inset',
      } }),
      // reticle vertical
      el('div', { style: {
        position: 'fixed',
        left: '50%',
        top: '50%',
        width: '2px',
        height: '360px',
        transform: 'translate(-50%,-50%)',
        background: 'rgba(234,240,255,0.55)',
      } }),
      // reticle horizontal
      el('div', { style: {
        position: 'fixed',
        left: '50%',
        top: '50%',
        width: '360px',
        height: '2px',
        transform: 'translate(-50%,-50%)',
        background: 'rgba(234,240,255,0.55)',
      } }),
      // center dot
      el('div', { style: {
        position: 'fixed',
        left: '50%',
        top: '50%',
        width: '6px',
        height: '6px',
        transform: 'translate(-50%,-50%)',
        borderRadius: '999px',
        background: 'rgba(255,209,102,0.9)',
        boxShadow: '0 0 12px rgba(255,209,102,0.25)',
      } }),
    ]);

    root.appendChild(crosshair);
    root.appendChild(hit);
    root.appendChild(topLeft);
    root.appendChild(msg);
    root.appendChild(vehicleHud);
    root.appendChild(scope);

    // Mount HUD above the canvas layer (uiRoot sits above canvasHost in the devtools shell).
    // If we mount under canvasHost, the HUD can end up behind dock panels or hidden entirely.
    const hudHost = ctx?.uiRoot || document.getElementById('uiRoot') || ctx?.canvasHost || document.body;
    hudHost.appendChild(root);
    this._hudOverlay = root;
    this._hudEls = {
      root,
      crosshair,
      topLeft,
      msg,
      hit,
      scope,
      veh: {
        root: vehicleHud,
        speedVal: vehSpeedVal,
        gearVal: vehGearVal,
        rpmVal: vehRpmVal,
        odoVal: vehOdoVal,
        rpmBarFill: vehRpmBarFill,
        throttleFill: vehPedalThrottleFill,
        brakeFill: vehPedalBrakeFill,
        camTag: vehCamTag,
        hbTag: vehHbTag,
      },
    };
  }

  _resetGame() {
    const g = this._game;
    if (!g) return;
    g.time = 0;
    g.kills = 0;
    g.missionDone = false;
    g.msg = '';
    g.msgT = 0;
    g.hitT = 0;
    g.hitAlpha = 0;
    g.player.hpMax = 250;
    g.player.hp = g.player.hpMax;
    g.player.dead = false;
    g.player.respawnT = 0;
    g.player.lastHitT = -1e9;
    g.activeWeapon = g.activeWeapon || 'rifle';
    for (const wid of ['rifle', 'sniper']) {
      const w = g.weapons?.[wid];
      if (!w) continue;
      if (wid === 'rifle') { w.ammoInMag = w.magSize; w.reserve = 90; }
      if (wid === 'sniper') { w.ammoInMag = w.magSize; w.reserve = 20; }
      w.fireCooldown = 0;
      w.reloadT = 0;
    }
    g.enemiesAlive = 0;
    this._mouseDown = false;
    this._aimDown = false;
    this._clearFx();
    this._gun.recoil = 0;
    this._gun.recoilKick = 0;
  }

  _showMsg(s, sec = 2.0) {
    const g = this._game;
    if (!g) return;
    g.msg = String(s || '');
    g.msgT = Math.max(0, Number(sec) || 0);
  }

  _onMouseDown(e) {
    const btn = Number(e?.button ?? 0);
    // Right mouse = aim (sniper)
    if (btn === 2) {
      this._aimDown = true;
      try { e?.preventDefault?.(); } catch { /* ignore */ }
      return;
    }

    if (btn !== 0) return;

    // Orbit inspect mode: Shift+Click to select/pick an object for tagging/editing.
    if (this._state.mode === 'orbit' && !!e?.shiftKey) {
      try { this._pickSelectionFromEvent(e); } catch { /* ignore */ }
      try { e?.preventDefault?.(); } catch { /* ignore */ }
      return;
    }

    this._mouseDown = true;
    if (this._state.mode === 'fps' && this._game?.enabled && !this._vehicleSystem?.inVehicle?.()) {
      // Fire immediately on click. Keep this independent from pointer-lock so
      // gameplay still works after UI interactions that temporarily unlock.
      try { this._tryFireWeapon(); } catch { /* ignore */ }
      if (!this._plock?.isLocked) {
        // Convenience: still try to reacquire pointer lock.
        this._tryPointerLock('mousedown');
      }
    } else if (this._state.mode === 'fps' && !this._plock?.isLocked) {
      // Convenience: click locks pointer (Three.js PointerLockControls does this sometimes, but we force the intent)
      this._tryPointerLock('mousedown');
    }
    try { e?.preventDefault?.(); } catch { /* ignore */ }
  }

  _onMouseUp(e) {
    const btn = Number(e?.button ?? 0);
    if (btn === 2) this._aimDown = false;
    if (btn === 0) this._mouseDown = false;
  }

  /* ─────────────────── Vehicles ─────────────────── */

  _spawnDefaultVehicles() {
    if (!this._scene || !this._game?.enabled) return;

    // Clear any legacy vehicles that might already be in the scene.
    // Vehicles are now owned by `SceneVehicleSystem` (Chrono-backed).
    try {
      for (const v of (this._vehicles || [])) {
        try { if (v?.group) this._scene.remove(v.group); } catch { /* ignore */ }
        try { disposeThreeObject(v?.group); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    this._vehicles = [];
    this._vehicleBoxes = [];
    this._vehicleCtx = { inVehicle: false, vehicleId: '', seatId: '', role: '', camMode: 'first', lastVehicleYaw: 0 };

    // Delegate to the unified vehicle system.
    try { void this._vehicleSystem?.spawnDefaultVehicles?.(); } catch { /* ignore */ }
  }

  _makeVehicle({ id, kind, x, y, z, yaw }) {
    if (!this._scene) return null;
    const group = new THREE.Group();
    group.name = `veh_${id}`;
    group.position.set(Number(x) || 0, Number(y) || 0, Number(z) || 0);
    group.rotation.y = Number(yaw) || 0;

    // Slightly more detailed vehicle kit (still cheap): body + cabin + trim + glass + wheels + lights.
    // Forward is local -Z (windshield is at negative Z).
    const paintColor = (kind === 'van') ? 0x6b8bbd : 0x3d506b;
    const bodyMat = (THREE.MeshPhysicalMaterial)
      ? new THREE.MeshPhysicalMaterial({
        color: paintColor,
        roughness: 0.55,
        metalness: 0.05,
        clearcoat: 0.55,
        clearcoatRoughness: 0.28,
      })
      : new THREE.MeshStandardMaterial({ color: paintColor, roughness: 0.65, metalness: 0.05 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x1b2433, roughness: 0.8, metalness: 0.0 });
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x10151f, roughness: 0.95, metalness: 0.0 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x3a465a, roughness: 0.55, metalness: 0.05 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x0d1420, roughness: 0.12, metalness: 0.0, transparent: true, opacity: 0.48 });
    const accentMat = new THREE.MeshStandardMaterial({ color: 0xffd166, roughness: 0.55, metalness: 0.0, emissive: 0x241b05 });
    const headLightMat = new THREE.MeshStandardMaterial({ color: 0xd8f0ff, roughness: 0.15, metalness: 0.0, emissive: 0x9ad0ff, emissiveIntensity: 0.55 });
    const tailLightMat = new THREE.MeshStandardMaterial({ color: 0xff4d4d, roughness: 0.25, metalness: 0.0, emissive: 0xff2a2a, emissiveIntensity: 0.35 });

    const add = (mesh) => { group.add(mesh); return mesh; };
    const addBox = (w, h, d, mat, px, py, pz, name = '', { cast = true, recv = true } = {}) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(px, py, pz);
      if (name) m.name = name;
      m.castShadow = !!cast;
      m.receiveShadow = !!recv;
      return add(m);
    };
    const addWheel = ({ px, pz, radius = 0.36, width = 0.20, name = '' } = {}) => {
      // Pivot lets us spin/steer without fighting the base orientation.
      const pivot = new THREE.Group();
      if (name) pivot.name = name;
      pivot.position.set(px, radius, pz);
      group.add(pivot);

      const tireGeo = new THREE.CylinderGeometry(radius, radius, width, 14, 1);
      const tire = new THREE.Mesh(tireGeo, tireMat);
      tire.name = 'tire';
      try { tire.userData = tire.userData || {}; tire.userData.__tirePlaceholder = true; } catch { /* ignore */ }
      tire.rotation.z = Math.PI * 0.5; // axis along +X
      tire.castShadow = true;
      tire.receiveShadow = true;
      pivot.add(tire);

      const rimGeo = new THREE.CylinderGeometry(radius * 0.62, radius * 0.62, width * 0.85, 12, 1);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      rim.rotation.z = Math.PI * 0.5;
      rim.position.y = 0.001;
      rim.castShadow = true;
      rim.receiveShadow = true;
      pivot.add(rim);

      // Simple hub "cap"
      const capGeo = new THREE.CylinderGeometry(radius * 0.18, radius * 0.18, width * 0.95, 10, 1);
      const cap = new THREE.Mesh(capGeo, trimMat);
      cap.rotation.z = Math.PI * 0.5;
      cap.position.y = 0.002;
      cap.castShadow = true;
      cap.receiveShadow = true;
      pivot.add(cap);

      return pivot;
    };

    if (kind === 'van') {
      // Van: taller cabin, sliding door, chunky bumpers.
      addBox(2.25, 0.58, 4.45, bodyMat, 0, 0.57, 0.05, 'van_base');
      addBox(2.08, 0.92, 3.30, bodyMat, 0, 1.12, 0.10, 'van_shell');
      addBox(2.10, 0.08, 3.10, trimMat, 0, 1.60, 0.15, 'van_roof_trim', { cast: false, recv: true });
      // Hood / front fascia
      addBox(2.05, 0.28, 0.75, bodyMat, 0, 0.95, -1.85, 'van_hood', { cast: true, recv: true });
      addBox(2.28, 0.20, 0.55, trimMat, 0, 0.48, -2.10, 'van_bumper_f');
      addBox(2.28, 0.20, 0.55, trimMat, 0, 0.48, 2.15, 'van_bumper_r');
      // Glass
      addBox(1.72, 0.60, 0.06, glassMat, 0, 1.25, -1.98, 'van_windshield', { cast: false, recv: true });
      addBox(0.07, 0.52, 1.20, glassMat, -1.07, 1.20, -1.00, 'van_glassL', { cast: false, recv: true });
      addBox(0.07, 0.52, 1.20, glassMat, 1.07, 1.20, -1.00, 'van_glassR', { cast: false, recv: true });
      addBox(0.07, 0.52, 1.25, glassMat, -1.07, 1.20, 0.55, 'van_glassL2', { cast: false, recv: true });
      addBox(0.07, 0.52, 1.25, glassMat, 1.07, 1.20, 0.55, 'van_glassR2', { cast: false, recv: true });
      // Sliding door seam + handle
      addBox(0.02, 0.62, 2.00, trimMat, 1.06, 0.95, 0.65, 'van_door_seam', { cast: false, recv: true });
      addBox(0.10, 0.05, 0.05, accentMat, 1.05, 1.06, 0.50, 'van_handle');
      // Lights
      addBox(0.20, 0.14, 0.05, headLightMat, -0.72, 0.78, -2.25, 'van_headL', { cast: false, recv: true });
      addBox(0.20, 0.14, 0.05, headLightMat, 0.72, 0.78, -2.25, 'van_headR', { cast: false, recv: true });
      addBox(0.18, 0.16, 0.05, tailLightMat, -0.88, 0.78, 2.35, 'van_tailL', { cast: false, recv: true });
      addBox(0.18, 0.16, 0.05, tailLightMat, 0.88, 0.78, 2.35, 'van_tailR', { cast: false, recv: true });
      // Mirrors
      addBox(0.14, 0.10, 0.18, trimMat, -1.20, 1.15, -1.25, 'van_mirrorL');
      addBox(0.14, 0.10, 0.18, trimMat, 1.20, 1.15, -1.25, 'van_mirrorR');
    } else {
      // Jeep/pickup-ish: cabin + bed + fenders + light bar + spare.
      addBox(2.05, 0.52, 3.35, bodyMat, 0, 0.58, 0.15, 'jeep_base');
      addBox(1.92, 0.62, 1.45, bodyMat, 0, 1.03, -0.78, 'jeep_cabin');
      addBox(1.86, 0.38, 1.35, bodyMat, 0, 0.92, 1.25, 'jeep_bed');
      // Bed rails
      addBox(1.86, 0.10, 0.08, trimMat, 0, 1.15, 1.92, 'jeep_tailgate_top');
      addBox(0.08, 0.32, 1.20, trimMat, -0.93, 1.00, 1.25, 'jeep_bed_railL', { cast: false, recv: true });
      addBox(0.08, 0.32, 1.20, trimMat, 0.93, 1.00, 1.25, 'jeep_bed_railR', { cast: false, recv: true });
      // Front bumper + grille
      addBox(2.12, 0.22, 0.55, trimMat, 0, 0.46, -1.65, 'jeep_bumper_f');
      addBox(1.30, 0.28, 0.18, trimMat, 0, 0.78, -1.50, 'jeep_grille');
      // Windshield + side glass
      addBox(1.62, 0.50, 0.06, glassMat, 0, 1.15, -1.38, 'jeep_windshield', { cast: false, recv: true });
      addBox(0.06, 0.38, 0.85, glassMat, -0.98, 1.10, -0.75, 'jeep_glassL', { cast: false, recv: true });
      addBox(0.06, 0.38, 0.85, glassMat, 0.98, 1.10, -0.75, 'jeep_glassR', { cast: false, recv: true });
      // Fenders (simple blocks that read as arches)
      addBox(0.28, 0.28, 0.70, trimMat, -1.05, 0.62, -1.18, 'jeep_fender_fl');
      addBox(0.28, 0.28, 0.70, trimMat, 1.05, 0.62, -1.18, 'jeep_fender_fr');
      addBox(0.28, 0.28, 0.70, trimMat, -1.05, 0.62, 1.48, 'jeep_fender_rl');
      addBox(0.28, 0.28, 0.70, trimMat, 1.05, 0.62, 1.48, 'jeep_fender_rr');
      // Roof rack + light bar
      addBox(1.55, 0.06, 1.10, trimMat, 0, 1.42, -0.85, 'jeep_roofrack');
      addBox(1.20, 0.08, 0.12, accentMat, 0, 1.34, -1.55, 'jeep_lightbar', { cast: false, recv: true });
      // Lights + mirrors
      addBox(0.18, 0.14, 0.05, headLightMat, -0.62, 0.74, -1.90, 'jeep_headL', { cast: false, recv: true });
      addBox(0.18, 0.14, 0.05, headLightMat, 0.62, 0.74, -1.90, 'jeep_headR', { cast: false, recv: true });
      addBox(0.16, 0.14, 0.05, tailLightMat, -0.78, 0.74, 2.03, 'jeep_tailL', { cast: false, recv: true });
      addBox(0.16, 0.14, 0.05, tailLightMat, 0.78, 0.74, 2.03, 'jeep_tailR', { cast: false, recv: true });
      addBox(0.12, 0.08, 0.16, trimMat, -1.10, 1.16, -1.05, 'jeep_mirrorL');
      addBox(0.12, 0.08, 0.16, trimMat, 1.10, 1.16, -1.05, 'jeep_mirrorR');
      // Spare tire
      try {
        const spare = addWheel({ px: 0.0, pz: 2.05, radius: 0.33, width: 0.20, name: 'jeep_spare' });
        spare.position.y = 1.05;
        spare.rotation.x = Math.PI * 0.5;
      } catch { /* ignore */ }
    }

    // Wheels (with pivots so we can animate)
    const wheelsAll = [];
    const wheelsFront = [];
    const wR = (kind === 'van') ? 0.36 : 0.37;
    const wW = (kind === 'van') ? 0.21 : 0.20;
    const axleX = (kind === 'van') ? 1.08 : 0.98;
    const zFront = (kind === 'van') ? -1.75 : -1.35;
    const zRear = (kind === 'van') ? 1.70 : 1.40;
    const whFL = addWheel({ px: -axleX, pz: zFront, radius: wR, width: wW, name: `${kind}_wheel_fl` });
    const whFR = addWheel({ px: axleX, pz: zFront, radius: wR, width: wW, name: `${kind}_wheel_fr` });
    const whRL = addWheel({ px: -axleX, pz: zRear, radius: wR, width: wW, name: `${kind}_wheel_rl` });
    const whRR = addWheel({ px: axleX, pz: zRear, radius: wR, width: wW, name: `${kind}_wheel_rr` });
    wheelsAll.push(whFL, whFR, whRL, whRR);
    wheelsFront.push(whFL, whFR);

    // Seats + doors (local positions)
    // Left-hand drive: driver = front-left.
    const seats = [
      { id: 'driver', role: 'driver', localPos: new THREE.Vector3(-0.45, 0.95, -0.55) },
      { id: 'front_pass', role: 'passenger', localPos: new THREE.Vector3(0.45, 0.95, -0.55) },
      { id: 'rear_left', role: 'passenger', localPos: new THREE.Vector3(-0.45, 0.95, 0.60) },
      { id: 'rear_right', role: 'passenger', localPos: new THREE.Vector3(0.45, 0.95, 0.60) },
    ];
    const doors = [
      { id: 'door_driver', seatId: 'driver', localPos: new THREE.Vector3(-1.15, 0.55, -0.55), label: 'Driver door' },
      { id: 'door_front_pass', seatId: 'front_pass', localPos: new THREE.Vector3(1.15, 0.55, -0.55), label: 'Front passenger door' },
      { id: 'door_rear_left', seatId: 'rear_left', localPos: new THREE.Vector3(-1.15, 0.55, 0.60), label: 'Rear left door' },
      { id: 'door_rear_right', seatId: 'rear_right', localPos: new THREE.Vector3(1.15, 0.55, 0.60), label: 'Rear right door' },
    ];

    // Visual door handles (tiny accents)
    try {
      for (const d of doors) {
        const h = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.04, 0.04), accentMat);
        h.position.copy(d.localPos.clone().setY(1.05));
        h.castShadow = false;
        h.receiveShadow = true;
        group.add(h);
      }
    } catch { /* ignore */ }

    // Cheap interior blocks to give windows something to show.
    try {
      const seatMat = new THREE.MeshStandardMaterial({ color: 0x223042, roughness: 0.9, metalness: 0.0 });
      for (const s of seats) {
        const chair = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.42, 0.40), seatMat);
        chair.position.copy(s.localPos.clone().setY(0.75));
        chair.castShadow = false;
        chair.receiveShadow = true;
        group.add(chair);
      }
      // Steering column hint
      const col = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.22, 0.06), trimMat);
      col.position.set(-0.42, 1.02, -0.95);
      col.castShadow = false;
      col.receiveShadow = true;
      group.add(col);
    } catch { /* ignore */ }

    // Add to scene
    this._scene.add(group);

    const occ = new Map();
    for (const s of seats) occ.set(s.id, null);

    return {
      id: String(id || ''),
      kind: String(kind || ''),
      group,
      seats,
      doors,
      occ,
      yaw: Number(yaw) || 0,
      speed: 0,
      steer: 0,
      driveType: 'wheeled',
      radius: (kind === 'van') ? 1.35 : 1.20,
      simHandle: (() => {
        try {
          // Create vehicle in the currently active sim backend.
          // WASM backend: only needs kind + pose. JS backend: accepts richer params.
          const sim = this._vehicleSim;
          if (!sim) return 0;
          const kindId = (safeTrim(kind) === 'van') ? 0 : 0; // currently both map to HMMWV; expand later.
          const base = {
            kind: kindId,
            x: group.position.x,
            z: group.position.z,
            yaw: Number(yaw) || 0,
          };
          // If using JS backend, pass tuning params.
          if (this._vehicleSimKind === 'js') {
            const wheelbase = (kind === 'van') ? 2.8 : 2.55;
            const speedMax = (kind === 'van') ? 16.0 : 18.0;
            return sim.createVehicle({
              ...base,
              radius: (kind === 'van') ? 1.35 : 1.20,
              wheelbase,
              maxSteerRad: 0.48,
              mass: (kind === 'van') ? 1850 : 1450,
              iz: (kind === 'van') ? 2850 : 2050,
              mu: (kind === 'van') ? 1.00 : 1.05,
              engineForceMax: (kind === 'van') ? 8800 : 9800,
              engineBrakeForce: (kind === 'van') ? 1400 : 1200,
              brakeForceMax: (kind === 'van') ? 13000 : 12500,
              rollingResist: (kind === 'van') ? 24.0 : 20.0,
              aeroDrag: (kind === 'van') ? 42.0 : 35.0,
              cornerStiffFront: (kind === 'van') ? 78000 : 90000,
              cornerStiffRear: (kind === 'van') ? 98000 : 110000,
              yawRateMax: 2.6,
              steerRate: (kind === 'van') ? 6.0 : 7.5,
              speedMax,
            });
          }
          return sim.createVehicle(base);
        } catch { /* ignore */ }
        return 0;
      })(),
      parts: {
        wheelsAll,
        wheelsFront,
        wheelRadius: wR,
        wheelWidth: wW,
        wheelRoll: 0,
      },
    };
  }

  _tickVehicles(dt) {
    if (!Array.isArray(this._vehicles) || !this._vehicles.length) return;
    const dts = Math.max(0, Number(dt) || 0);

    // Show hint when near a door (and not inside an interact-gated trigger prompt)
    if (!this._triggerInteractHintActive && !this._vehicleCtx.inVehicle) {
      const near = this._nearestVehicleEnterCandidate();
      if (near && this._ui?.hintEl) {
        const label = safeTrim(near?.door?.label) || (safeTrim(near?.seatId) === 'driver' ? 'Driver seat' : 'Enter');
        this._ui.hintEl.textContent = `Press E: enter (${label})`;
      } else if (this._ui?.hintEl) {
        // Don't stomp other hints (e.g. triggers). If we own the hint, clear it.
        const cur = safeTrim(this._ui.hintEl.textContent || '');
        if (cur.startsWith('Press E: enter')) this._ui.hintEl.textContent = '';
      }
    }

    // Controls → sim
    try { this._vehicleSim?.clearControls?.(); } catch { /* ignore */ }
    const inVeh = !!this._vehicleCtx?.inVehicle;
    const driveInputs = new Map(); // vehicleId -> { throttle, brake, gear, steer }
    // Driving should not require pointer-lock; pointer-lock is mostly for camera mouse-look.
    // If we require lock, entering can feel "broken" when lock is denied by the browser.
    const canDrive = !!this._drivingEnabled && inVeh && this._vehicleCtx.role === 'driver' && this._state.mode === 'fps';
    if (canDrive) {
      const vv = this._vehicles.find((x) => x.id === this._vehicleCtx.vehicleId) || null;
      const isHover = safeTrim(vv?.driveType) === 'hover';
      const forward = (this._keysDown.has('KeyW') || this._keysDown.has('ArrowUp')) ? 1 : 0;
      const back = (this._keysDown.has('KeyS') || this._keysDown.has('ArrowDown')) ? 1 : 0;
      const left = (this._keysDown.has('KeyA') || this._keysDown.has('ArrowLeft')) ? 1 : 0;
      const right = (this._keysDown.has('KeyD') || this._keysDown.has('ArrowRight')) ? 1 : 0;
      if (vv && !vv.simHandle) {
        // Late recovery: if spawn created no sim handle, recreate and retry.
        try { this._recreateVehicleSimHandles(); } catch { /* ignore */ }
      }
      const cur = (vv?.simHandle) ? this._vehicleSim?.getState?.(vv.simHandle) : null;
      const spd = Number(cur?.speed);
      const speedRef = Number.isFinite(spd) ? spd : (Number(vv?.speed) || 0);
      const ctrl = computeVehicleControls({
        driveType: isHover ? 'hover' : 'wheeled',
        forward, back, left, right,
        speedRef,
      });
      const throttle = Number(ctrl.throttle) || 0;
      const brake = Number(ctrl.brake) || 0;
      const gear = Number(ctrl.gear) || 1;
      const steer = Number(ctrl.steer) || 0; // [-1,1] (left positive; matches vehicle sim convention)

      if (vv) driveInputs.set(vv.id, { throttle, brake, gear, steer });
      if (vv?.simHandle) {
        // Apply to backend.
        if (this._vehicleSimKind === 'wasm') {
          if (isHover) {
            const tAbs = Math.abs(Number(throttle) || 0);
            const g = (Number(throttle) < -1e-6) ? -1 : 1;
            try { this._vehicleSim?.setGear?.(vv.simHandle, g); } catch { /* ignore */ }
            this._vehicleSim?.setControls?.(vv.simHandle, tAbs, 0, steer);
          } else {
            try { this._vehicleSim?.setGear?.(vv.simHandle, gear); } catch { /* ignore */ }
            this._vehicleSim?.setControls?.(vv.simHandle, throttle, brake, steer);
          }
        } else {
          // JS backend uses signed throttle for reverse.
          const tSigned = isHover ? (Number(throttle) || 0) : ((gear < 0) ? -throttle : throttle);
          this._vehicleSim?.setControls?.(vv.simHandle, tSigned, brake, steer);
        }
      }
    }

    // Step sim
    try { this._vehicleSim?.step?.(dts); } catch { /* ignore */ }

    // Apply sim → scene transforms and wheel animation
    for (const v of (this._vehicles || [])) {
      if (!v?.group) continue;
      const st = (v?.simHandle) ? this._vehicleSim?.getState?.(v.simHandle) : null;
      let steerRad = 0;
      if (st) {
        const yawRaw = Number(st.yaw) || 0;
        const yawOff = Number(v.yawVisualOffset) || 0;
        v.yawSim = yawRaw;
        v.yaw = yawRaw + yawOff;
        v.speed = Number(st.speed) || 0;
        // Convert to legacy steer signal ([-1,1]) so other UI/debug continues to work.
        steerRad = Number(st.steerRad) || 0;
        v.steer = (Math.abs(steerRad) > 1e-6) ? (steerRad / Math.max(1e-3, 0.48)) : 0;

        v.group.position.x = Number(st.x) || 0;
        v.group.position.z = Number(st.z) || 0;
        v.group.rotation.y = v.yaw;
      } else {
        // Fallback kinematic driving so vehicles remain drivable even if the
        // physics backend fails to provide a state/handle for this vehicle.
        const inp = driveInputs.get(v.id) || { throttle: 0, brake: 0, gear: 1, steer: 0 };
        const thSigned = ((Number(inp.gear) < 0) ? -1 : 1) * (Number(inp.throttle) || 0);
        const br = clamp01(Number(inp.brake) || 0);
        const steerCmd = clamp(Number(inp.steer) || 0, -1, 1);
        v.steer = lerp(Number(v.steer) || 0, steerCmd, 1.0 - Math.exp(-8.0 * dts));
        steerRad = Number(v.steer) * 0.48;

        const prevX = Number(v.group.position.x) || 0;
        const prevZ = Number(v.group.position.z) || 0;
        let speed = Number(v.speed) || 0;
        const isHover = safeTrim(v?.driveType) === 'hover';
        const dragLin = isHover ? (0.9 + br * 4.0) : (1.8 + br * 8.0);
        const accel = (thSigned * (isHover ? 8.5 : 10.5)) - (Math.sign(speed || 0) * dragLin);
        speed += accel * dts;
        if (Math.abs(speed) < 0.04 && Math.abs(thSigned) < 0.04) speed = 0;
        speed = clamp(speed, -8.5, isHover ? 24.0 : 21.0);

        const yawOff = Number(v.yawVisualOffset) || 0;
        let yawSim = Number(v.yawSim);
        if (!Number.isFinite(yawSim)) yawSim = (Number(v.yaw) || Number(v.group.rotation.y) || 0) - yawOff;
        const steerGain = isHover
          ? (0.45 + Math.min(0.45, Math.abs(speed) * 0.06))
          : (0.28 + Math.min(0.35, Math.abs(speed) * 0.045));
        const yawRate = steerRad * steerGain * ((speed >= 0 || isHover) ? 1.0 : -0.75);
        yawSim += yawRate * dts;
        yawSim = Math.atan2(Math.sin(yawSim), Math.cos(yawSim));

        const fwdX = -Math.sin(yawSim);
        const fwdZ = -Math.cos(yawSim);
        let nx = prevX + fwdX * speed * dts;
        let nz = prevZ + fwdZ * speed * dts;
        const rr = Math.max(0.65, Number(v?.radius) || 1.1);
        if (this._collidesWorldAtRadius(nx, 0, nz, rr)) {
          let tx = prevX;
          let tz = prevZ;
          if (!this._collidesWorldAtRadius(nx, 0, prevZ, rr)) tx = nx;
          if (!this._collidesWorldAtRadius(tx, 0, nz, rr)) tz = nz;
          nx = tx;
          nz = tz;
          if (Math.abs(nx - prevX) < 1e-5 && Math.abs(nz - prevZ) < 1e-5) speed *= 0.12;
          else speed *= 0.92;
        }

        v.speed = speed;
        v.yawSim = yawSim;
        v.yaw = yawSim + yawOff;
        v.group.position.x = nx;
        v.group.position.z = nz;
        v.group.rotation.y = v.yaw;
      }

      // Wheel animation
      try {
        const pr = Number(v?.parts?.wheelRadius) || 0.36;
        const wheels = v?.parts?.wheelsAll || null;
        const fronts = v?.parts?.wheelsFront || null;
        const roll = (Math.max(-25, Math.min(25, Number(v.speed) || 0)) * dts) / Math.max(0.05, pr);
        if (Array.isArray(wheels) && wheels.length) {
          for (const w of wheels) { if (w) w.rotation.x += roll; }
        }
        if (Array.isArray(fronts) && fronts.length) {
          for (const w of fronts) { if (w) w.rotation.y = steerRad; }
        }
      } catch { /* ignore */ }

      // Optional imported vehicle animation channels (if the asset includes clips).
      try {
        const va = v?.anim || null;
        const mx = va?.mixer || null;
        if (mx) {
          const speedAbs = Math.abs(Number(v.speed) || 0);
          const steer01 = clamp01(Math.abs(Number(v.steer) || 0));
          const setChannel = (arr, weight, ts) => {
            for (const a of (Array.isArray(arr) ? arr : [])) {
              if (!a) continue;
              try {
                a.enabled = true;
                a.setEffectiveWeight(Math.max(0, Number(weight) || 0));
                a.setEffectiveTimeScale(Number(ts) || 0);
              } catch { /* ignore */ }
            }
          };
          setChannel(va.idle, 1.0, 1.0);
          setChannel(va.drive, clamp01(speedAbs / 3.5), Math.max(0, Math.min(4, speedAbs * 0.22)));
          setChannel(va.wheel, clamp01(speedAbs / 2.0), Math.max(0, Math.min(8, speedAbs * 0.55)));
          setChannel(va.suspension, clamp01(speedAbs / 6.0), Math.max(0, Math.min(3, speedAbs * 0.16)));
          const steerTs = (Number(v.steer) >= 0) ? 1.0 : -1.0;
          setChannel(va.steering, steer01, steer01 > 0.02 ? steerTs : 0.0);
          // Optional vehicle combat channels (e.g., Halo Ghost gun fire).
          // Left click while driving toggles this animation channel.
          const inVehDriver = !!inVeh && this._vehicleCtx?.role === 'driver' && safeTrim(this._vehicleCtx?.vehicleId) === safeTrim(v?.id);
          const fireOn = inVehDriver && !!this._mouseDown;
          setChannel(va.combat, fireOn ? 1.0 : 0.0, fireOn ? 1.0 : 0.0);
          mx.update(dts);
        }
      } catch { /* ignore */ }
    }

    // If seated, keep camera attached to that vehicle seat.
    if (inVeh) {
      const v = this._vehicles.find((x) => x.id === this._vehicleCtx.vehicleId) || null;
      if (v?.group) {
        // Third-person vehicle cam yaw alignment: keep chase offset behind the turning vehicle.
        try {
          if (this._camera && this._vehicleCtx?.camMode === 'third') {
            const last = Number(this._vehicleCtx.lastVehicleYaw);
            if (Number.isFinite(last)) {
              const dy = (Number(v.yaw) || 0) - last;
              if (Number.isFinite(dy) && Math.abs(dy) > 1e-9) this._camera.rotation.y += dy;
            }
          }
        } catch { /* ignore */ }
        this._vehicleCtx.lastVehicleYaw = Number(v.yaw) || 0;
        this._snapCameraToVehicleSeat(v, this._vehicleCtx.seatId);
      }
    }

    // Update dynamic vehicle obstacle boxes (after movement)
    this._vehicleBoxes = [];
    for (const v of (this._vehicles || [])) {
      if (!v?.group) continue;
      try {
        const b = new THREE.Box3().setFromObject(v.group);
        this._vehicleBoxes.push(b);
      } catch { /* ignore */ }
    }
  }

  _collidesWorldAtRadius(x, yFeet, z, r) {
    // Collide against procedural/static obstacles; ignore dynamic vehicle boxes to avoid self-collision loops.
    // (Vehicles can still bump into each other visually; for now we keep it simple.)
    const radius = Math.max(0.05, Number(r) || 1.0);
    const bottom = Number(yFeet) + 0.05;
    const top = Number(yFeet) + 2.0;
    const boxes = Array.isArray(this._obstacleBoxes) ? this._obstacleBoxes : [];
    for (const b of boxes) {
      if (!b) continue;
      const min = b.min, max = b.max;
      if (!(bottom < max.y && top > min.y)) continue;
      const qx = clamp(x, min.x, max.x);
      const qz = clamp(z, min.z, max.z);
      const dx = x - qx;
      const dz = z - qz;
      if ((dx * dx + dz * dz) < (radius * radius)) return true;
    }
    return false;
  }

  _nearestVehicleDoor(maxDist = 1.6) {
    const px = Number(this._player.x);
    const py = Number(this._player.y) + 1.0;
    const pz = Number(this._player.z);
    if (![px, py, pz].every((v) => Number.isFinite(v))) return null;
    const toV3 = (p, fbX = 0, fbY = 0, fbZ = 0) => {
      // Be robust to serialized vectors (arrays / plain {x,y,z}) as well as THREE.Vector3.
      try {
        if (p && typeof p.clone === 'function') return p.clone();
        if (Array.isArray(p) && p.length >= 3) return new THREE.Vector3(Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0);
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) return new THREE.Vector3(Number(p.x), Number(p.y), Number(p.z));
      } catch { /* ignore */ }
      return new THREE.Vector3(fbX, fbY, fbZ);
    };
    let best = null;
    let bestD = Infinity;
    for (const v of (this._vehicles || [])) {
      for (const d of (v?.doors || [])) {
        const wp = toV3(d?.localPos);
        wp.applyEuler(v.group.rotation);
        wp.add(v.group.position);
        const dd = Math.hypot(wp.x - px, wp.z - pz);
        const dynamicMaxDist = Math.max(
          Number(maxDist) || 1.6,
          Math.min(24.0, Math.max(0, Number(v?.radius) || 0) * 0.35),
        );
        if (dd < bestD) { bestD = dd; best = { vehicle: v, door: d, doorWorld: wp, dist: dd, maxDist: dynamicMaxDist }; }
      }
    }
    if (!best) return null;
    if (bestD > (Number(best.maxDist) || Number(maxDist) || 1.6)) return null;
    return best;
  }

  _nearestVehicleEnterCandidate(maxDist = 1.6) {
    // Prefer doors; fallback to vehicle center so "enter to drive" still works
    // even when door anchors are missing/misaligned or blocked by obstacles.
    const px = Number(this._player.x);
    const py = Number(this._player.y) + 1.0;
    const pz = Number(this._player.z);
    if (![px, py, pz].every((v) => Number.isFinite(v))) return null;

    const nearDoor = this._nearestVehicleDoor(maxDist);
    if (nearDoor) {
      return { ...nearDoor, seatId: nearDoor?.door?.seatId || '' };
    }

    let best = null;
    let bestD = Infinity;
    for (const v of (this._vehicles || [])) {
      if (!v?.group) continue;
      const dd = Math.hypot((Number(v.group.position.x) || 0) - px, (Number(v.group.position.z) || 0) - pz);
      const enterDist = Math.max(
        Number(maxDist) || 1.6,
        Math.min(6.0, Math.max(0, Number(v?.radius) || 0) * 0.55),
      );
      if (dd < bestD && dd <= enterDist) {
        bestD = dd;
        best = {
          vehicle: v,
          door: null,
          doorWorld: null,
          dist: dd,
          maxDist: enterDist,
          seatId: 'driver',
        };
      }
    }
    return best;
  }

  _tryEnterVehicle() {
    if (this._vehicleCtx.inVehicle) {
      // QoL: if seated as passenger, allow quick switch to driver seat.
      const v0 = this._vehicles.find((x) => x.id === this._vehicleCtx.vehicleId) || null;
      if (!v0) return false;
      if (this._vehicleCtx.role === 'driver') return false;
      const curSeatId = safeTrim(this._vehicleCtx.seatId);
      const drvSeat = v0.seats.find((s) => s.id === 'driver' && s.role === 'driver') || null;
      if (!drvSeat) return false;
      const drvOcc = v0.occ?.get('driver') || null;
      if (drvOcc && drvOcc !== 'player') {
        this._showMsg('Driver seat occupied', 0.8);
        return false;
      }
      try { if (curSeatId) v0.occ.set(curSeatId, null); } catch { /* ignore */ }
      try { v0.occ.set('driver', 'player'); } catch { /* ignore */ }
      this._vehicleCtx.seatId = 'driver';
      this._vehicleCtx.role = 'driver';
      this._vehicleCtx.lastVehicleYaw = Number(v0.yaw) || 0;
      this._snapCameraToVehicleSeat(v0, 'driver');
      this._showMsg('Driving (F to exit)', 0.8);
      return true;
    }
    const near = this._nearestVehicleEnterCandidate();
    if (!near) return false;
    const v = near.vehicle;
    const seatId = safeTrim(near?.seatId || near?.door?.seatId || '');
    if (!v || !seatId) return false;

    const occ = v.occ?.get(seatId) || null;
    const seat = v.seats.find((s) => s.id === seatId);
    if (!seat) return false;

    // If driver seat is occupied, allow takeover. Prefer swapping NPC to a free passenger seat.
    if (seatId === 'driver' && occ) {
      const free = v.seats.find((s) => s.id !== 'driver' && !v.occ.get(s.id));
      if (free) v.occ.set(free.id, occ);
      v.occ.set('driver', null);
      this._ctx?.toast?.('Took driver seat', 'warning', { title: 'Vehicle' });
    }

    // If seat still occupied, fail.
    if (v.occ.get(seatId)) {
      this._showMsg('Seat occupied', 0.8);
      return false;
    }

    // If entering from Orbit mode, switch to FPS for vehicle controls (restore on exit).
    const prevMode = String(this._state?.mode || 'fps');
    if (prevMode === 'orbit') {
      this._state.mode = 'fps';
      this._savePrefs?.();
      this._syncModeUi?.();
    }

    v.occ.set(seatId, 'player');
    this._vehicleCtx = {
      inVehicle: true,
      vehicleId: v.id,
      seatId,
      role: seat.role,
      camMode: 'first',
      lastVehicleYaw: Number(v.yaw) || 0,
      prevMode,
    };

    // Put player at vehicle (feet) so triggers still work reasonably; camera snaps to seat.
    this._player.x = v.group.position.x;
    this._player.z = v.group.position.z;
    this._player.y = 0;
    this._player.vy = 0;
    this._snapCameraToVehicleSeat(v, seatId);
    this._showMsg(seat.role === 'driver' ? 'Driving (F to exit)' : 'Passenger (F to exit)', 1.0);
    // Entering should "just work" even if the user wasn't already pointer-locked.
    // (Driving controls require lock, and without lock it can feel like nothing happened.)
    try {
      if (this._state.mode === 'fps' && !this._plock?.isLocked) this._tryPointerLock('enter_vehicle');
    } catch { /* ignore */ }
    return true;
  }

  _tryExitVehicle() {
    if (!this._vehicleCtx.inVehicle) return false;
    const v = this._vehicles.find((x) => x.id === this._vehicleCtx.vehicleId);
    if (!v) { this._vehicleCtx = { inVehicle: false, vehicleId: '', seatId: '', role: '', camMode: 'first', lastVehicleYaw: 0, prevMode: 'fps' }; return true; }
    const seatId = this._vehicleCtx.seatId;
    try { if (seatId) v.occ.set(seatId, null); } catch { /* ignore */ }

    // Place player at nearest door position for that seat.
    const door = v.doors.find((d) => d.seatId === seatId) || v.doors[0];
    let out = v.group.position.clone();
    if (door) {
      try {
        if (door?.localPos && typeof door.localPos.clone === 'function') out = door.localPos.clone();
        else if (Array.isArray(door?.localPos) && door.localPos.length >= 3) out = new THREE.Vector3(Number(door.localPos[0]) || 0, Number(door.localPos[1]) || 0, Number(door.localPos[2]) || 0);
        else if (door?.localPos && Number.isFinite(door.localPos.x) && Number.isFinite(door.localPos.y) && Number.isFinite(door.localPos.z)) out = new THREE.Vector3(Number(door.localPos.x), Number(door.localPos.y), Number(door.localPos.z));
      } catch { /* ignore */ }
      out.applyEuler(v.group.rotation);
      out.add(v.group.position);
    }
    // Find a collision-safe dismount point so exiting doesn't trap the player
    // inside the vehicle body or nearby blockers.
    const vehicleCenter = v.group?.position?.clone?.() || new THREE.Vector3(0, 0, 0);
    let outward = new THREE.Vector3(out.x - vehicleCenter.x, 0, out.z - vehicleCenter.z);
    if (outward.lengthSq() < 1e-6) {
      // Fallback to vehicle-right direction. Prefer side by door sign if available.
      const sideSign = Math.sign(Number(door?.localPos?.x) || 0) || 1;
      outward.set(Math.cos((Number(v.yaw) || 0) + (Math.PI * 0.5)) * sideSign, 0, Math.sin((Number(v.yaw) || 0) + (Math.PI * 0.5)) * sideSign);
    }
    outward.normalize();
    const side = new THREE.Vector3(-outward.z, 0, outward.x);
    const safeR = Math.max(0.22, Number(this._player?.radius) || 0.35);
    const candidates = [];
    const pushD = [0.0, 0.45, 0.8, 1.15, 1.5, 1.9, 2.4];
    for (const d of pushD) {
      candidates.push(new THREE.Vector3(out.x + outward.x * d, 0, out.z + outward.z * d));
      if (d >= 0.8) {
        candidates.push(new THREE.Vector3(out.x + outward.x * d + side.x * 0.45, 0, out.z + outward.z * d + side.z * 0.45));
        candidates.push(new THREE.Vector3(out.x + outward.x * d - side.x * 0.45, 0, out.z + outward.z * d - side.z * 0.45));
      }
    }
    // Last-resort: nudge away from the vehicle center.
    candidates.push(new THREE.Vector3(vehicleCenter.x + outward.x * 2.8, 0, vehicleCenter.z + outward.z * 2.8));
    let placed = null;
    for (const c of candidates) {
      if (!Number.isFinite(c.x) || !Number.isFinite(c.z)) continue;
      if (this._collidesAtRadius(c.x, 0, c.z, safeR)) continue;
      placed = c;
      break;
    }
    if (!placed) {
      // Ultimate fallback: try spawn point so the player never remains trapped.
      const sx = Number(this._spawn?.x);
      const sz = Number(this._spawn?.z);
      if (Number.isFinite(sx) && Number.isFinite(sz) && !this._collidesAtRadius(sx, 0, sz, safeR)) {
        placed = new THREE.Vector3(sx, 0, sz);
      } else {
        placed = new THREE.Vector3(out.x, 0, out.z);
      }
    }

    this._player.x = placed.x;
    this._player.z = placed.z;
    this._player.y = 0;
    this._player.vy = 0;
    if (this._camera) this._camera.position.set(this._player.x, this._player.y + this._player.eyeH, this._player.z);

    const restore = String(this._vehicleCtx?.prevMode || 'fps');
    this._vehicleCtx = { inVehicle: false, vehicleId: '', seatId: '', role: '', camMode: 'first', lastVehicleYaw: 0, prevMode: 'fps' };
    if (restore === 'orbit') {
      this._state.mode = 'orbit';
      this._savePrefs?.();
      this._syncModeUi?.();
    }
    this._showMsg('Exited vehicle', 0.6);
    return true;
  }

  _snapCameraToVehicleSeat(v, seatId) {
    if (!this._camera || !v) return;
    const seat = v.seats.find((s) => s.id === seatId) || v.seats[0];
    const mode = (this._vehicleCtx?.camMode === 'third') ? 'third' : 'first';

    if (mode === 'third') {
      // Mouse-controllable chase cam:
      // Don't call lookAt() (it would overwrite pointer-lock mouse rotation).
      // Use the camera's current forward vector as the viewing direction and
      // place the camera so the vehicle sits along that ray.
      try { this._camera.rotation.order = 'YXZ'; } catch { /* ignore */ }
      try { this._camera.rotation.x = clamp(this._camera.rotation.x, -1.15, 0.35); } catch { /* ignore */ }

      const target = v.group.position.clone();
      target.y += 1.25;
      const fwd = new THREE.Vector3();
      this._camera.getWorldDirection(fwd);
      if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, -1);
      fwd.normalize();

      const camDist = 7.2;
      const camLift = 1.1;
      const pos = target.clone().addScaledVector(fwd, -camDist);
      pos.y += camLift;
      this._camera.position.copy(pos);

      // Keep player feet under vehicle for triggers/hints
      this._player.x = v.group.position.x;
      this._player.z = v.group.position.z;
      this._player.y = 0;
      return;
    }

    const useDriverCameraAnchor = (safeTrim(seat?.id) === 'driver') && !!v?.cameraDriverLocal;
    let p = new THREE.Vector3(0, 1.0, 0);
    try {
      if (useDriverCameraAnchor && v?.cameraDriverLocal && typeof v.cameraDriverLocal.clone === 'function') p = v.cameraDriverLocal.clone();
      else if (seat?.localPos && typeof seat.localPos.clone === 'function') p = seat.localPos.clone();
      else if (Array.isArray(seat?.localPos) && seat.localPos.length >= 3) p = new THREE.Vector3(Number(seat.localPos[0]) || 0, Number(seat.localPos[1]) || 0, Number(seat.localPos[2]) || 0);
      else if (seat?.localPos && Number.isFinite(seat.localPos.x) && Number.isFinite(seat.localPos.y) && Number.isFinite(seat.localPos.z)) p = new THREE.Vector3(Number(seat.localPos.x), Number(seat.localPos.y), Number(seat.localPos.z));
    } catch { /* ignore */ }
    p.applyEuler(v.group.rotation);
    p.add(v.group.position);
    // Seat anchors represent base position; authored camera_driver is already eye-level.
    const eyeLift = useDriverCameraAnchor ? 0.02 : 0.55;
    this._camera.position.set(p.x, p.y + eyeLift, p.z);
    // Keep player feet under camera for triggers/hints
    this._player.x = p.x;
    this._player.z = p.z;
    this._player.y = 0;
  }

  // Nav/pathfinding is installed via `sceneNavMixin`.
}

// Install scenario-specific method mixins.
Object.assign(SceneTool.prototype, sceneTickMixin);
Object.assign(SceneTool.prototype, sceneDamageMixin);
Object.assign(SceneTool.prototype, scenePlayerMixin);
Object.assign(SceneTool.prototype, sceneEnemyMixin);
Object.assign(SceneTool.prototype, sceneScenarioMixin);
Object.assign(SceneTool.prototype, sceneNavMixin);
Object.assign(SceneTool.prototype, sceneBuildingsMixin);
Object.assign(SceneTool.prototype, sceneBuildingsUiMixin);
Object.assign(SceneTool.prototype, sceneResumeWalkerMixin);
Object.assign(SceneTool.prototype, sceneResumeShowcasePanelMixin);
Object.assign(SceneTool.prototype, proceduralMixin);
Object.assign(SceneTool.prototype, sceneRoomSimMixin);
Object.assign(SceneTool.prototype, sceneAvatarMixin);
Object.assign(SceneTool.prototype, scenarioDefaultsMixin);

