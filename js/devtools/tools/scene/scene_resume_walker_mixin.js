import * as THREE from 'three';

import {
  safeTrim,
  normalizeAssetUrl,
  resumeAssetCandidates,
  disposeThreeObject,
} from './core/scene_utils.js';

import { clipByAliases, computeAutoGroundYOffset } from './characters/character_anim_utils.js';

import { collidesCircleAgainstBoxes } from '../../../shared/collision_world.js';

export const sceneResumeWalkerMixin = {
  _hideBackgroundCards(root) {
    // Some character GLBs include an extra mesh called "Background" (often a billboard
    // plane with a baked image background). It looks like a rectangle stuck to the
    // model. Hide it in devtools previews.
    if (!root) return;
    try {
      root.traverse?.((n) => {
        const name = safeTrim(n?.name).toLowerCase();
        if (!name) return;
        if (name === 'background' || name.includes('background')) {
          try { n.visible = false; } catch { /* ignore */ }
        }
      });
    } catch { /* ignore */ }
  },

  _applyMaterialMapsToRoot(root, srcMat) {
    if (!root || !srcMat) return false;
    let applied = false;
    const copyMaps = (dstMat, srcMat0) => {
      if (!dstMat || !srcMat0) return;
      try {
        for (const k of ['map', 'normalMap', 'metalnessMap', 'roughnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) {
          if (srcMat0[k]) dstMat[k] = srcMat0[k];
        }
        // Copy a few common factors so the texture doesn't look "washed" or black.
        if (srcMat0.color && dstMat.color) dstMat.color.copy(srcMat0.color);
        if (srcMat0.emissive && dstMat.emissive) dstMat.emissive.copy(srcMat0.emissive);
        if (Number.isFinite(srcMat0.emissiveIntensity)) dstMat.emissiveIntensity = srcMat0.emissiveIntensity;
        if (Number.isFinite(srcMat0.metalness)) dstMat.metalness = srcMat0.metalness;
        if (Number.isFinite(srcMat0.roughness)) dstMat.roughness = srcMat0.roughness;
        if (Number.isFinite(srcMat0.opacity)) dstMat.opacity = srcMat0.opacity;
        if (typeof srcMat0.transparent === 'boolean') dstMat.transparent = srcMat0.transparent;
        if (Number.isFinite(srcMat0.alphaTest)) dstMat.alphaTest = srcMat0.alphaTest;
        dstMat.needsUpdate = true;
        applied = true;
      } catch { /* ignore */ }
    };

    try {
      root.traverse?.((n) => {
        if (!n || !(n.isSkinnedMesh || n.isMesh)) return;
        const mat = n.material;
        if (Array.isArray(mat)) {
          for (const m of mat) copyMaps(m, srcMat);
        } else {
          copyMaps(mat, srcMat);
        }
      });
    } catch { /* ignore */ }
    return applied;
  },

  _disposeResumeShowcaseWalker() {
    const st = this._resumeWalker3d;
    if (!st) return;
    try { if (st.root && this._scene) this._scene.remove(st.root); } catch { /* ignore */ }
    try { disposeThreeObject(st.root); } catch { /* ignore */ }
    st.gltf = null;
    st.root = null;
    st.mixer = null;
    st.actions?.clear?.();
    st.clipNames = [];
    st.rootBone = null;
    st.loadedUrl = '';
    st.loading = false;
    st.autoGroundYOffset = 0.0;
    st.angle = 0.0;
    st.mode = 'idle';
    st.modeT = 0.0;
    st.texturesApplied = false;
  },

  _disposeResumeWalkerTextureSource() {
    const st = this._resumeWalkerTexSrc;
    if (!st) return;
    try { disposeThreeObject(st.root); } catch { /* ignore */ }
    st.gltf = null;
    st.root = null;
    st.material = null;
    st.loadedUrl = '';
    st.loading = false;
  },

  async _loadResumeWalkerTextureSource({ force = false } = {}) {
    const cfg = this._resumeWalker;
    const st = this._resumeWalkerTexSrc;
    if (!cfg || !st) return;
    const raw = safeTrim(cfg.textureSourceUrl || '').replace(/\\/g, '/');
    if (!raw) return;
    const isResumeExport = !!globalThis.__resumeShowcase;
    const rawCandidates = isResumeExport ? resumeAssetCandidates(raw) : [raw];
    const urlCandidates = rawCandidates.map((r) => normalizeAssetUrl(r)).filter(Boolean);
    const url = urlCandidates[0] || '';
    if (!url) return;
    if (!force && st.root) {
      const cur = safeTrim(st.loadedUrl || '');
      if (cur && urlCandidates.includes(cur)) return;
    }
    if (st.loading) return;
    st.loading = true;
    try {
      this._disposeResumeWalkerTextureSource();
      st.loading = true;
      let gltf = null;
      let pickedUrl = url;
      for (const u of urlCandidates) {
        try {
          pickedUrl = u;
          gltf = await st.loader.loadAsync(u);
          break;
        } catch { /* try next */ }
      }
      if (!gltf) throw new Error('Resume texture source GLTF load failed');
      st.gltf = gltf;
      st.root = gltf.scene || null;
      st.loadedUrl = pickedUrl;

      // Pick a representative source material (prefer a textured skinned mesh).
      st.material = null;
      try {
        st.root?.traverse?.((n) => {
          if (st.material) return;
          if (!n || !(n.isSkinnedMesh || n.isMesh)) return;
          const mat = n.material;
          const mats = Array.isArray(mat) ? mat : (mat ? [mat] : []);
          for (const m of mats) {
            if (!m) continue;
            if (m.map || m.emissiveMap || m.normalMap) { st.material = m; return; }
          }
        });
      } catch { /* ignore */ }
    } catch {
      try { this._disposeResumeWalkerTextureSource(); } catch { /* ignore */ }
    } finally {
      st.loading = false;
    }
  },

  _applyResumeWalkerTextures() {
    const cfg = this._resumeWalker;
    const src = this._resumeWalkerTexSrc;
    const dst = this._resumeWalker3d;
    if (!cfg || !src || !dst) return;
    if (!dst.root) return;
    if (!safeTrim(cfg.textureSourceUrl || '')) return;
    const srcMat = src.material;
    if (!srcMat) return;
    const ok = this._applyMaterialMapsToRoot(dst.root, srcMat);
    if (ok) dst.texturesApplied = true;
  },

  async _loadResumeShowcaseWalker({ force = false } = {}) {
    const st = this._resumeWalker3d;
    const cfg = this._resumeWalker;
    if (!st || !cfg || !this._scene) return;
    if (!cfg.enabled) return;
    const raw = safeTrim(cfg.url || '').replace(/\\/g, '/');
    if (!raw) return;
    const isResumeExport = !!globalThis.__resumeShowcase;
    const rawCandidates = isResumeExport ? resumeAssetCandidates(raw) : [raw];
    const urlCandidates = rawCandidates.map((r) => normalizeAssetUrl(r)).filter(Boolean);
    const url = urlCandidates[0] || '';
    if (!url) return;

    if (!force && st.root) {
      const cur = safeTrim(st.loadedUrl || '');
      if (cur && urlCandidates.includes(cur)) return;
    }
    if (st.loading) return;
    st.loading = true;
    try {
      this._disposeResumeShowcaseWalker();
      st.loading = true;

      let gltf = null;
      let pickedUrl = url;
      for (const u of urlCandidates) {
        try {
          pickedUrl = u;
          gltf = await st.loader.loadAsync(u);
          break;
        } catch { /* try next */ }
      }
      if (!gltf) throw new Error('Resume walker GLTF load failed');
      st.gltf = gltf;
      const root = gltf.scene || null;
      if (!root) throw new Error('GLTF missing scene');
      st.root = root;
      st.loadedUrl = pickedUrl;

      try { root.traverse?.((n) => { try { n.frustumCulled = true; } catch { /* ignore */ } }); } catch { /* ignore */ }
      this._hideBackgroundCards(root);

      // Best-effort texture fixups for some exported GLBs (helps when colors look “missing”).
      try {
        root.traverse?.((n) => {
          if (!n || !(n.isMesh || n.isSkinnedMesh)) return;
          const mat = n.material;
          const mats = Array.isArray(mat) ? mat : (mat ? [mat] : []);
          for (const m of mats) {
            if (!m) continue;
            try {
              if (m.map && m.map.isTexture) { m.map.colorSpace = THREE.SRGBColorSpace; m.map.needsUpdate = true; }
              if (m.emissiveMap && m.emissiveMap.isTexture) { m.emissiveMap.colorSpace = THREE.SRGBColorSpace; m.emissiveMap.needsUpdate = true; }
              for (const k of ['normalMap', 'metalnessMap', 'roughnessMap', 'aoMap']) {
                const t = m[k];
                if (t && t.isTexture) { t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true; }
              }
              m.needsUpdate = true;
            } catch { /* ignore */ }
          }
        });
      } catch { /* ignore */ }

      st.autoGroundYOffset = Number(computeAutoGroundYOffset(root)) || 0.0;
      this._scene.add(root);

      const clips = Array.isArray(gltf.animations) ? gltf.animations : [];
      st.clipNames = clips.map((c) => safeTrim(c?.name)).filter(Boolean);
      st.actions = new Map();
      st.mixer = new THREE.AnimationMixer(root);
      if (!clips.length) this._setStatus('Resume walker: 0 animation clips. Use a locomotion pack GLB with idle/walk.');

      // Map clips to canonical keys.
      const want = {
        idle: ['idle', 'stand', 'rest'],
        walk_fwd: ['walk_fwd', 'walkfwd', 'walkforward', 'walk_forward', 'walk'],
        run_fwd: ['run_fwd', 'runfwd', 'runforward', 'run_forward', 'run'],
      };
      const keyToClip = new Map();
      for (const [k, aliases] of Object.entries(want)) {
        const clip = clipByAliases(clips, aliases);
        if (clip) keyToClip.set(k, clip);
      }
      for (const [k, clip] of keyToClip.entries()) {
        const a = st.mixer.clipAction(clip);
        a.enabled = true;
        a.setLoop(THREE.LoopRepeat, Infinity);
        a.clampWhenFinished = false;
        a.setEffectiveWeight(0.0);
        a.setEffectiveTimeScale(1.0);
        a.play();
        st.actions.set(k, a);
      }

      // Root bone for translation cancellation.
      st.rootBone = null;
      try {
        root.traverse?.((n) => {
          if (st.rootBone) return;
          const sk = /** @type {any} */ (n);
          const bones = sk?.skeleton?.bones;
          if (!Array.isArray(bones) || bones.length === 0) return;
          const lower = (x) => safeTrim(x).toLowerCase();
          const prefer = ['root', 'hips', 'pelvis', 'mixamorig:hips', 'mixamorighips'];
          for (const p of prefer) {
            const hit = bones.find((b) => lower(b?.name) === p);
            if (hit) { st.rootBone = hit; return; }
          }
          st.rootBone = bones[0] || null;
        });
      } catch { /* ignore */ }

      // Start idle by default if present.
      try {
        if (st.actions.has('idle')) st.actions.get('idle').setEffectiveWeight(1.0);
        else if (st.actions.has('walk_fwd')) st.actions.get('walk_fwd').setEffectiveWeight(1.0);
      } catch { /* ignore */ }

      // Reset behavior state.
      st.angle = 0.0;
      st.mode = 'idle';
      st.modeT = 0.0;
      st.texturesApplied = false;

      // Auto-apply textures from the configured source GLB (best-effort).
      try {
        await this._loadResumeWalkerTextureSource({ force: false });
        this._applyResumeWalkerTextures();
      } catch { /* ignore */ }
    } catch (e) {
      this._setStatus(`Resume walker load failed: ${e?.message || e}`);
      try { this._disposeResumeShowcaseWalker(); } catch { /* ignore */ }
    } finally {
      st.loading = false;
    }
  },

  _tickResumeShowcaseWalker(dt) {
    const st = this._resumeWalker3d;
    const cfg = this._resumeWalker;
    if (!st || !cfg) return;

    const inResume = safeTrim(this._proc?.kind).toLowerCase() === 'resume_showcase';
    if (!!cfg.enabled && !!safeTrim(cfg.url)) {
      const raw = safeTrim(cfg.url || '').replace(/\\/g, '/');
      const isResumeExport = !!globalThis.__resumeShowcase;
      const rawCandidates = isResumeExport ? resumeAssetCandidates(raw) : [raw];
      const urlCandidates = rawCandidates.map((r) => normalizeAssetUrl(r)).filter(Boolean);
      const curUrl = safeTrim(st.loadedUrl || '');
      const matches = curUrl && urlCandidates.includes(curUrl);
      if (inResume && ((!st.root || !matches) && !st.loading)) void this._loadResumeShowcaseWalker({ force: true });
    }

    if (!st.root) return;
    const show = inResume && !!cfg.enabled;
    try { st.root.visible = show; } catch { /* ignore */ }
    if (!show) return;

    // Ensure textures are applied (best-effort) when entering the showcase.
    if (!st.texturesApplied) {
      try {
        const srcUrl = safeTrim(cfg.textureSourceUrl || '');
        if (srcUrl) {
          const rawSrc = srcUrl.replace(/\\/g, '/');
          const isResumeExport = !!globalThis.__resumeShowcase;
          const rawCandidates = isResumeExport ? resumeAssetCandidates(rawSrc) : [rawSrc];
          const urlCandidates = rawCandidates.map((r) => normalizeAssetUrl(r)).filter(Boolean);
          const curSrc = safeTrim(this._resumeWalkerTexSrc?.loadedUrl || '');
          const matches = curSrc && urlCandidates.includes(curSrc);
          if (!matches && !this._resumeWalkerTexSrc?.loading) void this._loadResumeWalkerTextureSource({ force: true });
        }
      } catch { /* ignore */ }
      try { this._applyResumeWalkerTextures(); } catch { /* ignore */ }
    }

    const delta = Math.max(0.0, Math.min(0.05, Number(dt) || 0.0));

    // Walk/idle cycle.
    st.modeT = (Number(st.modeT) || 0) + delta;
    const walkSec = Math.max(0.2, Number(cfg.walkSec) || 7.5);
    const idleSec = Math.max(0.2, Number(cfg.idleSec) || 2.2);
    if (st.mode === 'walk' && st.modeT > walkSec) { st.mode = 'idle'; st.modeT = 0; }
    else if (st.mode !== 'walk' && st.modeT > idleSec) { st.mode = 'walk'; st.modeT = 0; }

    const moving = st.mode === 'walk';
    const speed = moving ? Math.max(0.05, Number(cfg.speed) || 1.35) : 0.0;
    const radiusRaw = Math.max(0.25, Number(cfg.radius) || 5.0);
    const centerX = Number(cfg.centerX) || 0.0;
    const centerZ = Number(cfg.centerZ) || 0.0;

    // Resume showcase navigation helpers (includes the center platform collider).
    const navBoxes = (inResume && Array.isArray(this._resumeWalkerNav?.boxes) && this._resumeWalkerNav.boxes.length)
      ? this._resumeWalkerNav.boxes
      : null;
    const navBounds = (inResume && this._resumeWalkerNav?.bounds) ? this._resumeWalkerNav.bounds : null;

    // Walker footprint (used for wall spacing + avoidance).
    const sc = Math.max(0.01, Number(cfg.scale) || 1.0);
    const walkerRadius = Math.max(0.22, 0.18 * sc);
    const walkerHeight = Math.max(1.2, 1.55 * sc);

    if (moving) {
      // For resume_showcase we want a near-wall loop; radius is overridden below.
      const rForStep = inResume ? 24.0 : radiusRaw;
      st.angle = (Number(st.angle) || 0) + (speed * delta) / Math.max(1e-6, rForStep);
    }
    let useA = Number(st.angle) || 0;
    const useCenterX = inResume ? 0.0 : centerX;
    const useCenterZ = inResume ? 0.0 : centerZ;

    let useR = inResume ? 24.0 : radiusRaw;
    if (inResume) {
      // Force a near-wall ring (ignore saved UI prefs).
      const b = navBounds || { minX: -31.5, maxX: 31.5, minZ: -31.5, maxZ: 31.5 };
      const wallPad = walkerRadius + 0.85;
      const rMax = Math.max(
        10.0,
        Math.min(
          Math.abs((Number(b.maxX) || 31.5) - useCenterX) - wallPad,
          Math.abs(useCenterX - (Number(b.minX) || -31.5)) - wallPad,
          Math.abs((Number(b.maxZ) || 31.5) - useCenterZ) - wallPad,
          Math.abs(useCenterZ - (Number(b.minZ) || -31.5)) - wallPad,
        ),
      );
      useR = rMax;
    }

    let x = useCenterX + Math.sin(useA) * useR;
    let z = useCenterZ + Math.cos(useA) * useR;

    // If the intended point collides, search forward along the ring until clear.
    if (inResume && navBoxes) {
      const margin = walkerRadius + 0.35;
      const b = navBounds || { minX: -31.5, maxX: 31.5, minZ: -31.5, maxZ: 31.5 };
      const inside = (xx, zz) => (
        Number.isFinite(xx) && Number.isFinite(zz)
        && xx > (Number(b.minX) + margin) && xx < (Number(b.maxX) - margin)
        && zz > (Number(b.minZ) + margin) && zz < (Number(b.maxZ) - margin)
      );
      const collides = (xx, zz) => collidesCircleAgainstBoxes({
        x: xx,
        z: zz,
        yFeet: 0.0,
        radius: walkerRadius,
        height: walkerHeight,
        staticBoxes: navBoxes,
      });
      const baseOk = inside(x, z) && !collides(x, z);
      if (!baseOk) {
        const angleStep = 0.08; // ~4.5 degrees
        let found = false;
        for (let si = 1; si <= 32 && !found; si++) { // search forward around the ring
          const aa = useA + angleStep * si;
          const xx = useCenterX + Math.sin(aa) * useR;
          const zz = useCenterZ + Math.cos(aa) * useR;
          if (!inside(xx, zz)) continue;
          if (collides(xx, zz)) continue;
          useA = aa;
          x = xx;
          z = zz;
          found = true;
          break;
        }
        if (found) st.angle = useA;
      }
    }

    const dx = Math.cos(useA);
    const dz = -Math.sin(useA);
    const yaw = Math.atan2(-dx, -dz) + (Number(cfg.yawOffsetRad) || 0); // mesh forward is typically -Z

    // Ground-follow.
    let gy = 0;
    if (inResume) {
      // Showroom floor is y=0; don’t raycast onto the platform/props.
      gy = 0;
    } else {
      try { gy = Number(this._findGroundY(x, 3.0, z)) || 0; } catch { gy = 0; }
    }
    const y = gy + (Number(cfg.yOffset) || 0.0) + (Number(st.autoGroundYOffset) || 0.0);

    try { st.root.scale.set(sc, sc, sc); } catch { /* ignore */ }
    try { st.root.position.set(x, y, z); } catch { /* ignore */ }
    try { st.root.rotation.set(0, yaw, 0); } catch { /* ignore */ }

    // Locomotion blend: idle <-> walk.
    const wWalk = moving ? 1.0 : 0.0;
    const wIdle = moving ? 0.0 : 1.0;
    const walkRef = Math.max(0.1, Number(cfg.speed) || 1.35);
    const walkScale = moving ? Math.max(0.2, Math.min(2.2, speed / walkRef)) : 1.0;
    try { if (st.actions?.has?.('idle')) st.actions.get('idle').setEffectiveWeight(wIdle); } catch { /* ignore */ }
    try { if (st.actions?.has?.('walk_fwd')) { const act = st.actions.get('walk_fwd'); act.setEffectiveWeight(wWalk); act.setEffectiveTimeScale(walkScale); } } catch { /* ignore */ }
    // If the pack only has "run", let it stand in for walking.
    try {
      if (!st.actions?.has?.('walk_fwd') && st.actions?.has?.('run_fwd')) {
        const act = st.actions.get('run_fwd');
        act.setEffectiveWeight(wWalk);
        act.setEffectiveTimeScale(walkScale);
      }
    } catch { /* ignore */ }

    try { st.mixer?.update?.(Math.max(0.0, Math.min(0.25, delta))); } catch { /* ignore */ }
    if (st.cancelRootTranslation && st.rootBone) {
      try { st.rootBone.position.set(0, 0, 0); } catch { /* ignore */ }
    }
  },
};

