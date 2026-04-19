import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

function normName(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[-_.:]/g, '');
}

function clipByAliases(clips, aliases) {
  if (!Array.isArray(clips) || clips.length === 0) return null;
  const byNorm = new Map();
  for (const c of clips) {
    if (!c?.name) continue;
    byNorm.set(normName(c.name), c);
  }
  const want = Array.isArray(aliases) ? aliases : [];

  // Exact normalized match first.
  for (const a of want) {
    const hit = byNorm.get(normName(a));
    if (hit) return hit;
  }

  // Fallback: substring match (helps for verbose clip names like "Zombie_Walk_Fwd_Loop").
  for (const a of want) {
    const key = normName(a);
    if (!key) continue;
    for (const [nn, clip] of byNorm.entries()) {
      if (nn.includes(key)) return clip;
    }
  }

  return null;
}

function makeThreeMatrix4FromGlm(m16) {
  const out = new THREE.Matrix4();
  // gl-matrix is column-major, same as THREE.Matrix4.fromArray default convention.
  out.fromArray(m16);
  return out;
}

function computeAutoGroundYOffset(root) {
  if (!root) return 0.0;
  const lower = (s) => String(s || '').trim().toLowerCase();
  const isBackground = (n) => {
    const name = lower(n?.name);
    return !!name && (name === 'background' || name.includes('background'));
  };
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  let has = false;
  try {
    root.traverse?.((n) => {
      if (!n) return;
      if (isBackground(n)) return;
      if (!(n.isMesh || n.isSkinnedMesh)) return;
      try {
        tmp.setFromObject(n);
        if (!Number.isFinite(tmp.min.y)) return;
        if (!has) { box.copy(tmp); has = true; }
        else box.union(tmp);
      } catch { /* ignore */ }
    });
  } catch { /* ignore */ }
  if (!has || !Number.isFinite(box.min.y)) return 0.0;
  return -box.min.y;
}

export class ThreeAvatarLayer {
  constructor({ canvas, gl }) {
    this.canvas = canvas;
    this.gl = gl;

    this.enabled = true;
    this.url = '';
    this.scale = 1.0;
    this.yOffset = 0.0;
    this.loaded = false;
    this.autoGround = true;

    // Public-ish debug/UX info for editor UI.
    this.clipCount = 0;
    this.clipNames = [];
    this.actionKeys = [];

    this._renderer = null;
    this._scene = null;
    this._camera = null;
    this._loader = new GLTFLoader();

    this._gltf = null;
    this._root = null;
    this._autoGroundYOffset = 0.0;
    this._mixer = null;
    this._actions = new Map(); // key -> THREE.AnimationAction
    this._activeKey = '';
    this._pendingAfterOnce = ''; // for jump sequencing
    this._mode = 'locomotion'; // locomotion | once
    this._tmpV3 = new THREE.Vector3();

    // If true, forcibly zero the root bone translation after mixer update.
    this.cancelRootTranslation = true;
    this._rootBone = null;
  }

  _maybeHideBackgroundCards() {
    const root = this._root;
    if (!root) return;
    // Some generated/converted avatar GLBs include an extra mesh called "Background"
    // (typically a billboard plane with a baked image background). It looks like a
    // rectangular backdrop stuck to the character. Hide it by default.
    try {
      root.traverse?.((n) => {
        if (!n) return;
        const name = String(n.name || '').trim().toLowerCase();
        if (!name) return;
        if (name === 'background' || name.includes('background')) {
          try { n.visible = false; } catch { /* ignore */ }
        }
      });
    } catch { /* ignore */ }
  }

  async init() {
    // Share the existing WebGL2 context with three.js.
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      context: this.gl,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    renderer.autoClear = false;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    this._renderer = renderer;

    const scene = new THREE.Scene();
    this._scene = scene;

    // Simple lighting: avatar should read well on the map.
    scene.add(new THREE.HemisphereLight(0xdde8ff, 0x1a2230, 0.90));
    const dir = new THREE.DirectionalLight(0xffffff, 1.05);
    dir.position.set(6, 10, 4);
    scene.add(dir);

    const cam = new THREE.PerspectiveCamera(55, 1, 0.05, 50000);
    cam.matrixAutoUpdate = false;
    this._camera = cam;
  }

  async load(url) {
    const u = String(url || '').trim();
    this.url = u;
    this._disposeLoaded();
    if (!u) return;

    const gltf = await this._loader.loadAsync(u);
    this._gltf = gltf;
    this._root = gltf.scene || null;
    if (!this._root) return;

    // Ensure consistent render.
    this._root.traverse?.((n) => {
      if (!n) return;
      // Enable frustum culling (default true) but keep casts shadow off (no shadows in renderer).
      try { n.frustumCulled = true; } catch { /* ignore */ }
    });

    this._maybeHideBackgroundCards();

    this._scene.add(this._root);
    this.loaded = true;

    // Auto-ground so the character stands on terrain even if its origin is centered.
    try {
      this._autoGroundYOffset = this.autoGround ? (Number(computeAutoGroundYOffset(this._root)) || 0.0) : 0.0;
    } catch { this._autoGroundYOffset = 0.0; }

    // Build mixer + actions.
    const clips = Array.isArray(gltf.animations) ? gltf.animations : [];
    this.clipCount = clips.length;
    this.clipNames = clips.map((c) => String(c?.name || '').trim()).filter(Boolean);
    this._mixer = new THREE.AnimationMixer(this._root);
    this._mixer.addEventListener('finished', (e) => {
      // When a LoopOnce clip finishes, return to locomotion (or jump_air if queued).
      try { this._mode = 'locomotion'; } catch { /* ignore */ }
      try {
        const a = e?.action;
        const n = String(a?.getClip?.()?.name || '');
        if (n) {
          // Best-effort: clear weights so we don't "stick" with clampWhenFinished.
          for (const k of ['jump_start', 'jump_land']) {
            const aa = this._actions.get(k);
            if (aa && aa.getClip?.()?.name === n) this._setWeight(k, 0.0, 1.0);
          }
        }
      } catch { /* ignore */ }
      const next = String(this._pendingAfterOnce || '').trim();
      if (next) {
        this._pendingAfterOnce = '';
        this._setAction(next, { fade: 0.08 });
        this._setWeight(next, 1.0, 1.0);
      }
    });

    // Canonical action keys.
    const want = {
      idle: ['idle', 'stand', 'rest'],
      walk_fwd: ['walkfwd', 'walkforward', 'walk_forward', 'walk'],
      walk_back: ['walkback', 'walkbackward', 'walk_backward'],
      walk_left: ['walkleft', 'walk_left', 'strafeleft', 'strafe_left'],
      walk_right: ['walkright', 'walk_right', 'straferight', 'strafe_right'],
      run_fwd: ['runfwd', 'runforward', 'run_forward', 'run'],
      run_back: ['runback', 'runbackward', 'run_backward'],
      run_left: ['runleft', 'run_left', 'strafeleft_run', 'runstrafeleft'],
      run_right: ['runright', 'run_right', 'straferight_run', 'runstraferight'],
      jump_start: ['jumpstart', 'jump_start', 'jump_takeoff', 'takeoff', 'jump'],
      jump_air: ['jumpair', 'jump_air', 'inair', 'air', 'fall'],
      jump_land: ['jumpland', 'jump_land', 'land', 'landing'],
    };

    const keyToClip = new Map();
    for (const [k, aliases] of Object.entries(want)) {
      const clip = clipByAliases(clips, aliases);
      if (clip) keyToClip.set(k, clip);
    }

    // If we only have a generic walk/run/jump, map it to forward.
    if (!keyToClip.has('walk_fwd')) {
      const anyWalk = clipByAliases(clips, ['walk']);
      if (anyWalk) keyToClip.set('walk_fwd', anyWalk);
    }
    if (!keyToClip.has('run_fwd')) {
      const anyRun = clipByAliases(clips, ['run']);
      if (anyRun) keyToClip.set('run_fwd', anyRun);
    }

    for (const [k, clip] of keyToClip.entries()) {
      const a = this._mixer.clipAction(clip);
      a.enabled = true;
      a.setEffectiveWeight(0.0);
      a.setEffectiveTimeScale(1.0);
      a.stop();
      // Jump clips default to once; locomotion loops.
      if (k === 'jump_air') {
        // Air loop: keep cycling while airborne.
        a.setLoop(THREE.LoopRepeat, Infinity);
        a.clampWhenFinished = false;
      } else if (k.startsWith('jump_')) {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      } else {
        a.setLoop(THREE.LoopRepeat, Infinity);
      }
      this._actions.set(k, a);
    }
    this.actionKeys = Array.from(this._actions.keys());

    // Pick root bone for translation cancellation.
    this._rootBone = null;
    try {
      this._root.traverse?.((n) => {
        if (this._rootBone) return;
        const sk = /** @type {any} */ (n);
        const bones = sk?.skeleton?.bones;
        if (!Array.isArray(bones) || bones.length === 0) return;
        const lower = (x) => String(x || '').trim().toLowerCase();
        const prefer = ['root', 'hip', 'hips', 'pelvis', 'mixamorig:hips', 'mixamorighips'];
        for (const p of prefer) {
          const hit = bones.find((b) => lower(b?.name) === p);
          if (hit) { this._rootBone = hit; return; }
        }
        this._rootBone = bones[0] || null;
      });
    } catch { /* ignore */ }

    // Start idle if present, otherwise first available action.
    // Start idle if present.
    if (this._actions.has('idle')) {
      try {
        const a = this._actions.get('idle');
        a.reset();
        a.enabled = true;
        a.setEffectiveWeight(1.0);
        a.play();
        this._activeKey = 'idle';
      } catch { /* ignore */ }
    }
  }

  _disposeLoaded() {
    if (this._root) {
      try { this._scene?.remove(this._root); } catch { /* ignore */ }
      try {
        this._root.traverse?.((n) => {
          if (!n) return;
          if (n.geometry) { try { n.geometry.dispose?.(); } catch { /* ignore */ } }
          const mat = n.material;
          const mats = Array.isArray(mat) ? mat : (mat ? [mat] : []);
          for (const m of mats) {
            if (!m) continue;
            for (const k of ['map', 'normalMap', 'metalnessMap', 'roughnessMap', 'emissiveMap', 'aoMap']) {
              const t = m[k];
              if (t && t.isTexture) { try { t.dispose?.(); } catch { /* ignore */ } }
            }
            try { m.dispose?.(); } catch { /* ignore */ }
          }
        });
      } catch { /* ignore */ }
    }
    this._gltf = null;
    this._root = null;
    this._autoGroundYOffset = 0.0;
    this._mixer = null;
    this._actions.clear();
    this._activeKey = '';
    this._pendingAfterOnce = '';
    this._mode = 'locomotion';
    this._rootBone = null;
    this.clipCount = 0;
    this.clipNames = [];
    this.actionKeys = [];
    this.loaded = false;
  }

  _setAction(key, { fade = 0.12, immediate = false } = {}) {
    const k = String(key || '').trim();
    const next = this._actions.get(k);
    if (!next) return;
    if (k === this._activeKey && next.isRunning()) return;

    const prevKey = this._activeKey;
    const prev = prevKey ? this._actions.get(prevKey) : null;
    this._activeKey = k;

    try {
      next.reset();
      next.enabled = true;
      next.play();
    } catch { /* ignore */ }

    if (prev && prev !== next) {
      try {
        if (immediate) {
          prev.stop();
        } else {
          prev.crossFadeTo(next, Math.max(0.001, Number(fade) || 0.12), false);
        }
      } catch { /* ignore */ }
    }
  }

  _ensureActionPlaying(key) {
    const a = this._actions.get(key);
    if (!a) return null;
    try {
      if (!a.isRunning()) {
        a.enabled = true;
        a.play();
      }
    } catch { /* ignore */ }
    return a;
  }

  _setWeight(key, w, timeScale = 1.0) {
    const a = this._ensureActionPlaying(key);
    if (!a) return;
    try { a.setEffectiveWeight(Math.max(0.0, Number(w) || 0.0)); } catch { /* ignore */ }
    try { a.setEffectiveTimeScale(Math.max(0.0, Number(timeScale) || 0.0)); } catch { /* ignore */ }
  }

  _zeroLocomotionWeights() {
    for (const k of ['idle', 'walk_fwd', 'walk_back', 'walk_left', 'walk_right', 'run_fwd', 'run_back', 'run_left', 'run_right']) {
      this._setWeight(k, 0.0, 1.0);
    }
  }

  _syncCameraFromAppCamera(appCamera) {
    const cam = this._camera;
    if (!cam || !appCamera?.view || !appCamera?.proj) return;

    try {
      cam.projectionMatrix.copy(makeThreeMatrix4FromGlm(appCamera.proj));
      cam.matrixWorldInverse.copy(makeThreeMatrix4FromGlm(appCamera.view));
      cam.matrixWorld.copy(cam.matrixWorldInverse).invert();
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    } catch { /* ignore */ }
  }

  tickAndRender({ dtSec, appCamera, player }) {
    if (!this.enabled) return;
    if (!this._renderer || !this._scene || !this._camera) return;
    if (!this._root || !this._mixer) return;
    if (!player?.enabled) return;

    // Drive animation selection / blending.
    const onGround = !!player.onGround;
    const speed = Math.max(0.0, Number(player.planarSpeed) || 0.0);
    const hasMove = !!player.hasMoveInput && speed > 0.25;
    const walkSpeed = Math.max(0.01, Number(player.walkSpeed) || 10.0);
    const runSpeed = Math.max(walkSpeed + 0.01, Number(player.runSpeed) || 18.0);
    const wantsRun = !!player.running;

    // Jump sequencing uses once clips if available.
    if (!onGround) {
      if (player.justJumped && this._actions.has('jump_start')) {
        this._mode = 'once';
        this._pendingAfterOnce = this._actions.has('jump_air') ? 'jump_air' : '';
        this._zeroLocomotionWeights();
        this._setAction('jump_start', { fade: 0.06 });
        this._setWeight('jump_start', 1.0, 1.0);
      } else if (this._actions.has('jump_air')) {
        this._mode = 'locomotion';
        this._zeroLocomotionWeights();
        this._setAction('jump_air', { fade: 0.08 });
        this._setWeight('jump_air', 1.0, 1.0);
      } else {
        // No airborne clips: fall back to locomotion blend.
        this._mode = 'locomotion';
      }
    } else if (player.justLanded && this._actions.has('jump_land')) {
      this._mode = 'once';
      this._pendingAfterOnce = ''; // computed by locomotion blend below once finished
      this._zeroLocomotionWeights();
      this._setAction('jump_land', { fade: 0.06 });
      this._setWeight('jump_land', 1.0, 1.0);
    } else {
      // Ground locomotion blending below.
      if (this._mode !== 'once') this._mode = 'locomotion';
    }

    // If we're not in a "once" clip, blend locomotion (idle + directional walk/run).
    if (this._mode !== 'once' && onGround) {
      const mx = Number(player.moveDir?.x) || 0.0; // world X
      const mz = Number(player.moveDir?.y) || 0.0; // world Z
      const yaw = Number(player.yawRad) || 0.0;
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      const rx = fz, rz = -fx;
      let fwd = (mx * fx) + (mz * fz);
      let right = (mx * rx) + (mz * rz);
      const mag = Math.hypot(fwd, right);
      if (mag > 1e-6) { fwd /= mag; right /= mag; }
      const wF = Math.max(0.0, fwd);
      const wB = Math.max(0.0, -fwd);
      const wR = Math.max(0.0, right);
      const wL = Math.max(0.0, -right);
      const sum = wF + wB + wR + wL;
      const dir = (sum > 1e-6)
        ? { fwd: wF / sum, back: wB / sum, right: wR / sum, left: wL / sum }
        : { fwd: 0, back: 0, right: 0, left: 0 };

      // Blend run vs walk by speed when running; otherwise pure walk.
      const runBlend = wantsRun ? Math.max(0.0, Math.min(1.0, (speed - walkSpeed * 0.6) / Math.max(1e-6, (runSpeed - walkSpeed * 0.6)))) : 0.0;
      let walkBlend = 1.0 - runBlend;

      // If run clips are missing, fold their weight into walk.
      const hasAnyRun = ['run_fwd', 'run_back', 'run_left', 'run_right'].some((k) => this._actions.has(k));
      if (!hasAnyRun) { walkBlend = 1.0; }

      // Time scaling so feet roughly match ground speed.
      const walkScale = Math.max(0.2, Math.min(2.2, speed / walkSpeed));
      const runScale = Math.max(0.2, Math.min(2.2, speed / runSpeed));

      const moving = !!hasMove && (sum > 1e-6);
      this._setWeight('idle', moving ? 0.0 : 1.0, 1.0);

      const wWalk = moving ? walkBlend : 0.0;
      const wRun = moving ? (hasAnyRun ? runBlend : 0.0) : 0.0;

      this._setWeight('walk_fwd', wWalk * dir.fwd, walkScale);
      this._setWeight('walk_back', wWalk * dir.back, walkScale);
      this._setWeight('walk_left', wWalk * dir.left, walkScale);
      this._setWeight('walk_right', wWalk * dir.right, walkScale);

      this._setWeight('run_fwd', wRun * dir.fwd, runScale);
      this._setWeight('run_back', wRun * dir.back, runScale);
      this._setWeight('run_left', wRun * dir.left, runScale);
      this._setWeight('run_right', wRun * dir.right, runScale);
    }

    // Update mixer.
    const dt = Math.max(0.0, Math.min(0.25, Number(dtSec) || 0.0));
    try { this._mixer.update(dt); } catch { /* ignore */ }

    // Cancel unwanted root translation for in-place clips.
    if (this.cancelRootTranslation && this._rootBone) {
      // Preserve vertical (Y) so idle breathing / bounce stays intact.
      try {
        this._rootBone.position.x = 0;
        this._rootBone.position.z = 0;
      } catch { /* ignore */ }
    }

    // Sync avatar transform to player.
    const p = player.pos || { x: 0, y: 0, z: 0 };
    const yaw = Number(player.yawRad) || 0.0;
    const sc = Number(this.scale) || 1.0;
    const gy = (Number(this._autoGroundYOffset) || 0.0) * sc;
    this._root.position.set(
      Number(p.x) || 0.0,
      (Number(p.z) || 0.0) + (Number(this.yOffset) || 0.0) + gy,
      Number(p.y) || 0.0
    );
    this._root.rotation.set(0, yaw, 0);
    this._root.scale.set(sc, sc, sc);

    // Sync camera matrices from app camera.
    this._syncCameraFromAppCamera(appCamera);

    // Render avatar on top of existing world (no clears).
    try {
      // Ensure three has a clean-ish state baseline.
      this._renderer.resetState?.();
    } catch { /* ignore */ }
    try {
      this._renderer.render(this._scene, this._camera);
    } catch { /* ignore */ }
  }

  dispose() {
    this._disposeLoaded();
    try { this._renderer?.dispose?.(); } catch { /* ignore */ }
    this._renderer = null;
    this._scene = null;
    this._camera = null;
  }
}

