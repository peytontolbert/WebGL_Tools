import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

function safeTrim(s) {
  return String(s ?? '').trim();
}

function degToRad(deg) {
  return (Number(deg) || 0) * (Math.PI / 180);
}

function makeThreeMatrix4FromGlm(m16) {
  const out = new THREE.Matrix4();
  // gl-matrix is column-major, same as THREE.Matrix4.fromArray default convention.
  out.fromArray(m16);
  return out;
}

function metaUrlForModelUrl(modelUrl) {
  const u = safeTrim(modelUrl);
  if (!u) return '';
  // Common convention: <name>.glb -> <name>.meta.json
  const low = u.toLowerCase();
  if (low.endsWith('.meta.json')) return u;
  if (low.endsWith('.glb')) return u.slice(0, -4) + '.meta.json';
  if (low.endsWith('.gltf')) return u.slice(0, -5) + '.meta.json';
  return u + '.meta.json';
}

function anchorPos(a) {
  const p = Array.isArray(a?.pos) ? a.pos : null;
  if (!p || p.length < 3) return new THREE.Vector3(0, 0, 0);
  return new THREE.Vector3(Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0);
}

function anchorQuat(a) {
  const q = Array.isArray(a?.quat) ? a.quat : null;
  if (!q || q.length < 4) return new THREE.Quaternion(0, 0, 0, 1);
  const x = Number(q[0]) || 0;
  const y = Number(q[1]) || 0;
  const z = Number(q[2]) || 0;
  const w = Number(q[3]);
  return new THREE.Quaternion(x, y, z, Number.isFinite(w) ? w : 1);
}

function computeAutoGroundYOffset(root) {
  if (!root) return 0.0;
  const box = new THREE.Box3();
  try { box.setFromObject(root); } catch { return 0.0; }
  if (!Number.isFinite(box.min.y)) return 0.0;
  // Offset needed to bring minY to 0.
  return -box.min.y;
}

/**
 * Minimal "overlay" model layer rendered via three.js on the same WebGL context.
 * Intended for quick visualization/testing of GLB/GLTF assets in the runtime scene.
 */
export class ThreeModelLayer {
  constructor({ canvas, gl }) {
    this.canvas = canvas;
    this.gl = gl;

    this.enabled = true;
    this.url = '';
    this.scale = 1.0;
    this.yOffset = 0.0;
    this.loaded = false;
    this.autoGround = true;

    this._renderer = null;
    this._scene = null;
    this._camera = null;
    this._loader = new GLTFLoader();

    this._gltf = null;
    this._root = null;
    this._autoGroundYOffset = 0.0;

    // Vehicle wheel/tire attachments (optional).
    // Assumes sibling <model>.meta.json with anchors.wheel_lf/rf/lr/rr and wheelScale values.
    this.wheelsEnabled = true;
    this.wheelModelUrl = ''; // if empty, falls back to localStorage or DEFAULT_WHEEL_MODEL_URL
    this.wheelUseMetaScale = true;
    this.wheelFrontScaleMul = 1.0;
    this.wheelRearScaleMul = 1.0;
    // Optional manual rotation tweak (applied after meta quat).
    this.wheelRotXDeg = 0;
    this.wheelRotYDeg = 0;
    this.wheelRotZDeg = 0;

    this._wheelLoader = new GLTFLoader();
    this._wheelAsset = null; // { url, gltf, root, alignQ, outerRadius, width }
    /** @type {THREE.Group|null} */
    this._wheelsGroup = null;
    this._wheelInst = new Map(); // key -> Object3D
    this._wheelMeta = { radiusFront: 0, radiusRear: 0 };
    this._wheelPrevPose = null; // { x, y, yawRad }
    this._loadGen = 0;
  }

  async init() {
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

    // Simple lighting so models read well.
    scene.add(new THREE.HemisphereLight(0xdde8ff, 0x1a2230, 0.90));
    const dir = new THREE.DirectionalLight(0xffffff, 1.05);
    dir.position.set(6, 10, 4);
    scene.add(dir);

    const cam = new THREE.PerspectiveCamera(55, 1, 0.05, 50000);
    cam.matrixAutoUpdate = false;
    this._camera = cam;
  }

  _disposeLoaded() {
    this.loaded = false;
    this.url = '';
    try { if (this._root) this._scene?.remove?.(this._root); } catch { /* ignore */ }
    try {
      this._root?.traverse?.((n) => {
        if (!n) return;
        const any = /** @type {any} */ (n);
        // Some attached sub-assets (e.g. wheel instances) are shared/cached and should not be disposed here.
        if (any?.userData?.__skipDispose) return;
        try { any.geometry?.dispose?.(); } catch { /* ignore */ }
        const m = any.material;
        if (Array.isArray(m)) {
          for (const mm of m) {
            if (!mm) continue;
            if (mm?.userData?.__skipDispose) continue;
            try { mm.map?.dispose?.(); } catch { /* ignore */ }
            try { mm.normalMap?.dispose?.(); } catch { /* ignore */ }
            try { mm.roughnessMap?.dispose?.(); } catch { /* ignore */ }
            try { mm.metalnessMap?.dispose?.(); } catch { /* ignore */ }
            try { mm.emissiveMap?.dispose?.(); } catch { /* ignore */ }
            try { mm.dispose?.(); } catch { /* ignore */ }
          }
        } else if (m) {
          if (m?.userData?.__skipDispose) return;
          try { m.map?.dispose?.(); } catch { /* ignore */ }
          try { m.normalMap?.dispose?.(); } catch { /* ignore */ }
          try { m.roughnessMap?.dispose?.(); } catch { /* ignore */ }
          try { m.metalnessMap?.dispose?.(); } catch { /* ignore */ }
          try { m.emissiveMap?.dispose?.(); } catch { /* ignore */ }
          try { m.dispose?.(); } catch { /* ignore */ }
        }
      });
    } catch { /* ignore */ }
    this._gltf = null;
    this._root = null;
    this._autoGroundYOffset = 0.0;
    this._wheelsGroup = null;
  }

  _disposeWheelAsset() {
    const root = this._wheelAsset?.root || null;
    if (!root) { this._wheelAsset = null; return; }
    try {
      root.traverse?.((n) => {
        const any = /** @type {any} */ (n);
        try { any.geometry?.dispose?.(); } catch { /* ignore */ }
        const mat = any.material;
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
    } catch { /* ignore */ }
    this._wheelAsset = null;
  }

  async _ensureWheelAssetLoaded(url) {
    const u = safeTrim(url);
    if (!u) return null;
    if (this._wheelAsset && this._wheelAsset.url === u && this._wheelAsset.root) return this._wheelAsset;

    // Dispose old cache.
    try { this._disposeWheelAsset(); } catch { /* ignore */ }

    const gltf = await this._wheelLoader.loadAsync(u);
    const root = gltf?.scene || null;
    if (!root) return null;

    // Compute an "alignment" quaternion so the tyre width axis aligns with +X (our roll axis).
    // Heuristic: width axis is the smallest AABB dimension.
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    box.getSize(size);
    const dims = [Math.abs(size.x), Math.abs(size.y), Math.abs(size.z)];
    const minDim = Math.min(dims[0], dims[1], dims[2]);
    const widthAxis = (dims[0] === minDim) ? 0 : (dims[1] === minDim) ? 1 : 2;
    const widthVec = (widthAxis === 0) ? new THREE.Vector3(1, 0, 0) : (widthAxis === 1) ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    const alignQ = new THREE.Quaternion().setFromUnitVectors(widthVec, new THREE.Vector3(1, 0, 0));
    const outerRadius = 0.5 * Math.max(dims[0], dims[1], dims[2], 1e-6);
    const width = minDim;

    // Mark cached materials as "skipDispose" so disposing the vehicle doesn't destroy the cache.
    try {
      root.traverse?.((n) => {
        const any = /** @type {any} */ (n);
        const mat = any.material;
        if (Array.isArray(mat)) for (const m of mat) { if (m) { m.userData = m.userData || {}; m.userData.__skipDispose = true; } }
        else if (mat) { mat.userData = mat.userData || {}; mat.userData.__skipDispose = true; }
      });
    } catch { /* ignore */ }

    this._wheelAsset = { url: u, gltf, root, alignQ, outerRadius, width };
    return this._wheelAsset;
  }

  _clearWheels() {
    if (this._wheelsGroup && this._root) {
      try { this._root.remove(this._wheelsGroup); } catch { /* ignore */ }
    }
    this._wheelsGroup = null;
    this._wheelInst = new Map();
    this._wheelMeta = { radiusFront: 0, radiusRear: 0 };
    this._wheelPrevPose = null;
  }

  _ensureWheelsGroup() {
    if (!this._root) return null;
    if (this._wheelsGroup) return this._wheelsGroup;
    const g = new THREE.Group();
    g.name = 'ThreeModelLayer_Wheels';
    this._root.add(g);
    this._wheelsGroup = g;
    return g;
  }

  async _maybeAttachWheelsForModelUrl(modelUrl, gen) {
    if (!this.wheelsEnabled) { this._clearWheels(); return; }
    if (!this._root) return;

    const metaUrl = metaUrlForModelUrl(modelUrl);
    if (!metaUrl) { this._clearWheels(); return; }

    // Resolve wheel asset URL preference: explicit -> localStorage -> default.
    const DEFAULT_WHEEL_MODEL_URL = '/external/polyhaven/old_tyre_2k/old_tyre_2k.gltf';
    let wheelUrl = safeTrim(this.wheelModelUrl);
    if (!wheelUrl) {
      try { wheelUrl = safeTrim(localStorage.getItem('gameplay.tireUrl') || ''); } catch { /* ignore */ }
    }
    if (!wheelUrl) wheelUrl = DEFAULT_WHEEL_MODEL_URL;

    // Optional localStorage overrides for quick tweaking without code changes.
    // (These are intentionally best-effort and safe to ignore.)
    const parseBool = (v, fallback) => {
      const s = safeTrim(v).toLowerCase();
      if (!s) return fallback;
      return (s === '1' || s === 'true' || s === 'yes' || s === 'on');
    };
    const parseNum = (v, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    let useMetaScale = this.wheelUseMetaScale;
    let frontMul = this.wheelFrontScaleMul;
    let rearMul = this.wheelRearScaleMul;
    let rotXDeg = this.wheelRotXDeg;
    let rotYDeg = this.wheelRotYDeg;
    let rotZDeg = this.wheelRotZDeg;
    try { useMetaScale = parseBool(localStorage.getItem('gameplay.tireUseMetaScale'), useMetaScale); } catch { /* ignore */ }
    try { frontMul = parseNum(localStorage.getItem('gameplay.tireFrontMul'), frontMul); } catch { /* ignore */ }
    try { rearMul = parseNum(localStorage.getItem('gameplay.tireRearMul'), rearMul); } catch { /* ignore */ }
    try { rotXDeg = parseNum(localStorage.getItem('gameplay.tireRotXDeg'), rotXDeg); } catch { /* ignore */ }
    try { rotYDeg = parseNum(localStorage.getItem('gameplay.tireRotYDeg'), rotYDeg); } catch { /* ignore */ }
    try { rotZDeg = parseNum(localStorage.getItem('gameplay.tireRotZDeg'), rotZDeg); } catch { /* ignore */ }

    // Fetch meta.json (best-effort).
    let meta = null;
    try {
      const resp = await fetch(metaUrl, { cache: 'no-store' });
      if (resp.ok) meta = await resp.json();
    } catch { /* ignore */ }

    // Abort if a new load started.
    if (gen !== this._loadGen) return;
    if (!this._root) return;

    const anchors = (meta?.anchors && typeof meta.anchors === 'object') ? meta.anchors : null;
    const hasWheelAnchors = anchors && ['wheel_lf', 'wheel_rf', 'wheel_lr', 'wheel_rr'].every((k) => !!anchors[k]);
    if (!hasWheelAnchors) { this._clearWheels(); return; }

    const asset = await this._ensureWheelAssetLoaded(wheelUrl);
    if (gen !== this._loadGen) return;
    if (!asset || !asset.root) { this._clearWheels(); return; }

    const g = this._ensureWheelsGroup();
    if (!g) return;
    while (g.children.length) g.remove(g.children[g.children.length - 1]);
    this._wheelInst = new Map();
    this._wheelPrevPose = null;

    const frontR = Number(meta?.wheelScale);
    const rearR = Number(meta?.wheelScaleRear);
    const fr = Number.isFinite(frontR) ? frontR : 0.30;
    const rr = Number.isFinite(rearR) ? rearR : fr;
    this._wheelMeta = { radiusFront: fr, radiusRear: rr };
    const frontW = Number(meta?.wheelWidth);
    const rearW = Number(meta?.wheelWidthRear);
    const fw = Number.isFinite(frontW) ? frontW : 0;
    const rw = Number.isFinite(rearW) ? rearW : fw;

    const rotOffQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      degToRad(rotXDeg),
      degToRad(rotYDeg),
      degToRad(rotZDeg),
    ));

    const keys = ['wheel_lf', 'wheel_rf', 'wheel_lr', 'wheel_rr'];
    for (const k of keys) {
      const a = anchors?.[k] || null;
      if (!a) continue;
      const p = anchorPos(a);
      const q = anchorQuat(a);
      const isFront = k.includes('_f');
      const baseRadius = isFront ? fr : rr;
      const mul = isFront ? (Number(frontMul) || 1.0) : (Number(rearMul) || 1.0);

      // For now we interpret meta wheelScale as radius (meters). When disabled, treat it as 1.0.
      const desiredRadius = (useMetaScale ? baseRadius : 1.0) * mul;
      const modelOuterRadius = Math.max(1e-6, Number(asset.outerRadius) || 1.0);
      const s = Math.max(1e-6, desiredRadius / modelOuterRadius);
      const desiredWidth = isFront ? fw : rw;
      const modelWidth = Math.max(0, Number(asset.width) || 0);
      const wMul = (() => {
        if (!(desiredWidth > 0) || !(modelWidth > 0)) return 1.0;
        const curW = modelWidth * s;
        if (!(curW > 1e-6)) return 1.0;
        const raw = desiredWidth / curW;
        return Math.max(0.4, Math.min(3.0, raw));
      })();

      // Instance wheel asset at anchor.
      const inst = /** @type {THREE.Object3D} */ (asset.root.clone(true));
      // Mark all instance nodes as skipDispose (they share cached textures/materials).
      inst.traverse?.((n) => { try { n.userData = n.userData || {}; n.userData.__skipDispose = true; } catch { /* ignore */ } });
      inst.position.copy(p);
      // Compose: align (model) -> manual rot -> meta anchor
      inst.quaternion.copy(q.clone().multiply(rotOffQ).multiply(asset.alignQ || new THREE.Quaternion()));
      inst.scale.setScalar(s);
      inst.scale.x *= wMul;
      g.add(inst);
      try { this._wheelInst.set(k, inst); } catch { /* ignore */ }
    }
  }

  async load(url) {
    const u = String(url || '').trim();
    this._disposeLoaded();
    this.url = u;
    if (!u) return;

    const gltf = await this._loader.loadAsync(u);
    this._gltf = gltf;
    this._root = gltf.scene || null;
    if (!this._root) return;

    // Auto-ground offset so the model is visible on terrain even if its origin is centered.
    try {
      this._autoGroundYOffset = this.autoGround ? (Number(computeAutoGroundYOffset(this._root)) || 0.0) : 0.0;
    } catch { this._autoGroundYOffset = 0.0; }

    // Ensure consistent render behavior.
    this._root.traverse?.((n) => {
      if (!n) return;
      try { n.frustumCulled = true; } catch { /* ignore */ }
    });

    this._scene.add(this._root);
    this.loaded = true;

    // Attach wheels/tires (best-effort, non-fatal).
    const gen = ++this._loadGen;
    void this._maybeAttachWheelsForModelUrl(u, gen);
  }

  _tickWheelAnimation(pose, dtSec) {
    if (!this._wheelInst || this._wheelInst.size === 0) return;
    const dts = Number(dtSec) || 0;
    if (!(dts > 0)) return;
    if (!pose) { this._wheelPrevPose = null; return; }

    const x = Number(pose.x) || 0;
    const y = Number(pose.y) || 0;
    const yaw = Number(pose.yawRad) || 0;
    const prev = this._wheelPrevPose;
    this._wheelPrevPose = { x, y, yawRad: yaw };
    if (!prev) return;

    const dx = x - (Number(prev.x) || 0);
    const dy = y - (Number(prev.y) || 0);
    const dist = Math.hypot(dx, dy);
    if (!(dist > 1e-6)) return;

    // Convention: forward is local -Z, so ground-plane forward is (-sin(yaw), -cos(yaw)).
    const fx = -Math.sin(yaw);
    const fy = -Math.cos(yaw);
    const sgn = ((dx * fx + dy * fy) >= 0) ? 1 : -1;

    const rF = Number(this._wheelMeta?.radiusFront) || 0;
    const rR = Number(this._wheelMeta?.radiusRear) || 0;
    const frontRadius = (rF > 0.05) ? rF : 0.33;
    const rearRadius = (rR > 0.05) ? rR : frontRadius;
    const rollF = (sgn * dist) / Math.max(0.05, frontRadius);
    const rollR = (sgn * dist) / Math.max(0.05, rearRadius);

    const lf = this._wheelInst.get('wheel_lf') || null;
    const rf = this._wheelInst.get('wheel_rf') || null;
    const lr = this._wheelInst.get('wheel_lr') || null;
    const rr = this._wheelInst.get('wheel_rr') || null;
    try { if (lf) lf.rotateX(rollF); } catch { /* ignore */ }
    try { if (rf) rf.rotateX(rollF); } catch { /* ignore */ }
    try { if (lr) lr.rotateX(rollR); } catch { /* ignore */ }
    try { if (rr) rr.rotateX(rollR); } catch { /* ignore */ }
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

  /**
   * pose is in app coordinates: x,y on ground plane, z is up (meters).
   */
  tickAndRender({ appCamera, pose, dtSec = 0 }) {
    if (!this.enabled) return;
    if (!this.loaded) return;
    if (!this._renderer || !this._scene || !this._camera) return;
    if (!this._root) return;

    // Pose -> three transform (engine uses z-up; three is y-up).
    const p = pose || { x: 0, y: 0, z: 0, yawRad: 0 };
    const x = Number(p.x) || 0.0;
    const y = Number(p.y) || 0.0;
    const yaw = Number(p.yawRad) || 0.0;
    const sc = Number(this.scale) || 1.0;
    this._root.scale.set(sc, sc, sc);
    const z = (Number(p.z) || 0.0) + (Number(this.yOffset) || 0.0) + (Number(this._autoGroundYOffset) || 0.0) * sc;
    this._root.position.set(x, z, y);
    this._root.rotation.set(0, yaw, 0);

    this._syncCameraFromAppCamera(appCamera);
    try { this._tickWheelAnimation(p, dtSec); } catch { /* ignore */ }

    // Render on top of existing world (no clears).
    try { this._renderer.resetState?.(); } catch { /* ignore */ }
    try { this._renderer.render(this._scene, this._camera); } catch { /* ignore */ }
  }

  dispose() {
    this._disposeLoaded();
    this._disposeWheelAsset();
    try { this._renderer?.dispose?.(); } catch { /* ignore */ }
    this._renderer = null;
    this._scene = null;
    this._camera = null;
  }
}

