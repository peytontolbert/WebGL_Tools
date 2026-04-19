import * as THREE from 'three';

import {
  safeTrim,
  clamp01,
  extOf,
  isCharacterProfileAssetPath,
  isGlTfExt,
  isUsdExt,
  disposeThreeObject,
  normalizeAssetUrl,
  resumeAssetCandidates,
} from './core/scene_utils.js';

import {
  clipByAliases,
  buildCharacterActionAliases,
  computeAutoGroundYOffset,
} from './characters/character_anim_utils.js';

export const sceneAvatarMixin = {
  _disposeThirdPersonAvatar() {
    const st = this._avatar3p;
    if (!st) return;
    try { if (st.root && this._scene) this._scene.remove(st.root); } catch { /* ignore */ }
    try { disposeThreeObject(st.root); } catch { /* ignore */ }
    st.gltf = null;
    st.root = null;
    st.mixer = null;
    st.actions?.clear?.();
    st.activeKey = '';
    st.clipNames = [];
    st.actionAliases = buildCharacterActionAliases();
    st.rootBone = null;
    st.loadedUrl = '';
    st.sourceUrl = '';
    st.loading = false;
    st.autoGroundYOffset = 0.0;
    st.texturesApplied = false;
    st.texturesApplyRequested = false;
    st.jumpState = 'grounded';
    st.jumpStateT = 0.0;
    st.wasOnGround = true;
    st.lastTurnSign = 0;
  },

  async _resolveAvatarCharacterSource(rawUrl) {
    const raw = safeTrim(rawUrl).replace(/\\/g, '/');
    const isResumeExport = !!globalThis.__resumeShowcase;
    const rawCandidates = isResumeExport ? resumeAssetCandidates(raw) : [raw];
    const initialCandidates = rawCandidates.map((r) => normalizeAssetUrl(r)).filter(Boolean);
    const ext = extOf(raw);
    if (ext !== '.json' || !isCharacterProfileAssetPath(raw)) {
      throw new Error('Characters must use saved character manifests or locomotion profiles (.json). Import plain models through Assets as props.');
    }

    const fetchJsonFromCandidates = async (candidates) => {
      let lastErr = null;
      for (const u of candidates) {
        try {
          const resp = await fetch(u, { cache: 'no-cache' });
          if (!resp.ok) { lastErr = new Error(`HTTP ${resp.status}`); continue; }
          const j = await resp.json();
          if (j && typeof j === 'object') return { ok: true, url: u, data: j };
        } catch (e) {
          lastErr = e;
        }
      }
      return { ok: false, error: lastErr || new Error('json fetch failed') };
    };
    const resolveRelativeTo = (baseUrl, relPath) => {
      const rel = safeTrim(relPath);
      if (!rel) return '';
      const n = normalizeAssetUrl(rel);
      if (n) return n;
      try { return new URL(rel, baseUrl).toString(); } catch { return rel; }
    };

    const root = await fetchJsonFromCandidates(initialCandidates);
    if (!root?.ok) throw new Error(`Avatar JSON load failed: ${root?.error?.message || root?.error || 'unknown error'}`);
    const doc = root.data || {};
    const docKind = safeTrim(doc?.kind || '');

    if (docKind === 'character_locomotion_profile') {
      const directModel = safeTrim(doc?.model || '');
      const modelUrl = resolveRelativeTo(root.url, directModel);
      const slots = (doc?.slots && typeof doc.slots === 'object') ? doc.slots : null;
      if (!modelUrl) throw new Error('Locomotion profile is missing model path');
      if (!slots) throw new Error('Locomotion profile is missing slots data');
      return {
        sourceUrl: root.url,
        modelCandidates: [modelUrl].filter(Boolean),
        profileData: doc,
      };
    }

    const modelRaw = safeTrim(doc?.model || '');
    const resolvedModel = resolveRelativeTo(root.url, modelRaw);

    const profileRaw = safeTrim(doc?.locomotion?.profile || '');
    const inlineLoco = (doc?.locomotion && typeof doc.locomotion === 'object') ? doc.locomotion : null;
    const fallbackProfile = safeTrim(root.url).endsWith('/character_manifest.json')
      ? `${safeTrim(root.url).slice(0, -'character_manifest.json'.length)}locomotion_profile.json`
      : '';
    const profileCandidate = resolveRelativeTo(root.url, profileRaw || fallbackProfile);
    let profileData = null;
    if (profileCandidate) {
      try {
        const loaded = await fetchJsonFromCandidates([profileCandidate]);
        if (loaded?.ok) profileData = loaded.data;
      } catch { /* optional */ }
    }
    if (!profileData && inlineLoco && (inlineLoco.actions || inlineLoco.slots)) {
      profileData = {
        kind: 'character_locomotion_profile',
        character: safeTrim(doc?.character || ''),
        model: resolvedModel,
        actions: inlineLoco.actions || {},
        slots: inlineLoco.slots || {},
      };
    }
    if (!resolvedModel) throw new Error('Character manifest is missing model path');
    if (!profileData || typeof profileData !== 'object') {
      throw new Error('Character manifest has no locomotion profile; publish from Character tool first.');
    }
    return {
      sourceUrl: root.url,
      modelCandidates: [resolvedModel].filter(Boolean),
      profileData,
    };
  },

  _routeModelToPropAsset(rawModelUrl, reason = '') {
    const raw = safeTrim(rawModelUrl).replace(/\\/g, '/');
    if (!raw) return false;
    const ext = extOf(raw);
    const modelLike = isGlTfExt(ext) || isUsdExt(ext) || ext === '.fbx';
    if (!modelLike) return false;
    const u = normalizeAssetUrl(raw);
    if (!u) return false;
    try {
      if (this._ui?.propUrlInput) this._ui.propUrlInput.value = u;
    } catch { /* ignore */ }
    try {
      localStorage.setItem('devtools.scene.assetUrl', u);
      localStorage.setItem('devtools.scene.propUrl', u);
    } catch { /* ignore */ }
    const tail = safeTrim(reason) ? ` (${safeTrim(reason)})` : '';
    this._setStatus(`Imported as prop, not character: ${u}${tail}`);
    try {
      this._ctx?.toast?.('Model routed to Assets as prop. Characters in Scene use saved locomotion profiles only.', 'success', { title: 'Characters' });
    } catch { /* ignore */ }
    try {
      if (this._avatar) {
        this._avatar.enabled = false;
        this._savePrefs();
      }
    } catch { /* ignore */ }
    return true;
  },

  async _listPlayableCharacterManifestPaths() {
    const out = [];
    try {
      const resp = await fetch('/__devtools_character_manifests');
      const j = await resp.json().catch(() => null);
      if (j?.ok && Array.isArray(j?.items)) {
        for (const it of j.items) {
          const p = safeTrim(it?.path || '');
          if (p && p.endsWith('/character_manifest.json')) out.push(p);
        }
      }
    } catch { /* ignore */ }
    if (!out.length) {
      let items = [];
      try { items = await this._ctx?.assetIndex?.({ query: 'character_manifest', ext: '.json' }); } catch { items = []; }
      for (const it of (Array.isArray(items) ? items : [])) {
        const p = safeTrim(it?.path || '');
        if (p && p.endsWith('/character_manifest.json')) out.push(p);
      }
    }
    const unique = Array.from(new Set(out)).sort((a, b) => a.localeCompare(b));
    const playable = [];
    for (const rel of unique) {
      try {
        const u = normalizeAssetUrl(rel);
        if (!u) continue;
        const resp = await fetch(u, { cache: 'no-cache' });
        if (!resp.ok) continue;
        const j = await resp.json();
        const loco = (j?.locomotion && typeof j.locomotion === 'object') ? j.locomotion : null;
        if (!loco) continue;
        const hasProfile = !!safeTrim(loco?.profile || '');
        const hasInline = !!(loco?.actions || loco?.slots);
        if (hasProfile || hasInline) playable.push(rel);
      } catch { /* ignore */ }
    }
    return playable;
  },

  async _loadThirdPersonAvatar({ force = false } = {}) {
    const st = this._avatar3p;
    if (!st || !this._scene) return;
    if (!this._avatar?.enabled) return;
    const raw = safeTrim(this._avatar?.url || '').replace(/\\/g, '/');
    if (!raw) return;
    let resolved = null;
    try {
      resolved = await this._resolveAvatarCharacterSource(raw);
    } catch (e) {
      const routed = this._routeModelToPropAsset(raw, 'character avatars require saved profile JSON');
      if (!routed) this._setStatus(`Avatar resolve failed: ${e?.message || e}`);
      return;
    }
    const urlCandidates = Array.isArray(resolved?.modelCandidates) ? resolved.modelCandidates.filter(Boolean) : [];
    const url = urlCandidates[0] || '';
    if (!url) return;

    if (!force && st.root) {
      const cur = safeTrim(st.loadedUrl || '');
      const sameModel = cur && urlCandidates.includes(cur);
      const sameSource = safeTrim(st.sourceUrl || '') === safeTrim(resolved?.sourceUrl || '');
      if (sameModel && sameSource) return;
    }
    if (st.loading) return;
    st.loading = true;
    try {
      this._disposeThirdPersonAvatar();
      st.loading = true;

      let gltf = null;
      let pickedUrl = url;
      let lastErr = null;
      for (const u of urlCandidates) {
        try {
          pickedUrl = u;
          gltf = await st.loader.loadAsync(u);
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!gltf) throw lastErr || new Error('Avatar GLTF load failed');
      st.gltf = gltf;
      const root = gltf.scene || null;
      if (!root) throw new Error('GLTF missing scene');
      st.root = root;
      st.loadedUrl = pickedUrl;
      st.sourceUrl = safeTrim(resolved?.sourceUrl || pickedUrl);

      // Best-effort: keep render stable.
      try {
        root.traverse?.((n) => { try { n.frustumCulled = true; } catch { /* ignore */ } });
      } catch { /* ignore */ }

      // Hide "Background" cards if present.
      this._hideBackgroundCards(root);

      // Auto-ground so feet land on the floor.
      try { st.autoGroundYOffset = Number(computeAutoGroundYOffset(root)) || 0.0; } catch { st.autoGroundYOffset = 0.0; }

      this._scene.add(root);
      root.visible = false; // only shown in third-person on-foot

      // Apply the same texture source used by the Resume walker (best-effort).
      st.texturesApplied = false;
      try {
        await this._loadResumeWalkerTextureSource({ force: false });
        const ok = this._applyMaterialMapsToRoot(root, this._resumeWalkerTexSrc?.material || null);
        st.texturesApplied = !!ok;
      } catch { /* ignore */ }

      const clips = Array.isArray(gltf.animations) ? gltf.animations : [];
      st.clipNames = clips.map((c) => safeTrim(c?.name)).filter(Boolean);
      st.actions = new Map();
      st.mixer = new THREE.AnimationMixer(root);
      st.actionAliases = buildCharacterActionAliases(resolved?.profileData || null);
      if (!clips.length) {
        this._setStatus('Avatar has 0 clips. Re-publish the character locomotion profile from Character tool.');
      }

      // Map clips to canonical keys.
      const want = st.actionAliases || buildCharacterActionAliases();
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
        if (st.actions.has('idle')) {
          st.actions.get('idle').setEffectiveWeight(1.0);
          st.activeKey = 'idle';
        } else if (st.actions.size) {
          const k = Array.from(st.actions.keys())[0];
          st.actions.get(k).setEffectiveWeight(1.0);
          st.activeKey = k;
        }
      } catch { /* ignore */ }
      st.jumpState = 'grounded';
      st.jumpStateT = 0.0;
      st.wasOnGround = !!this._player?.onGround;
      st.lastTurnSign = 0;
    } catch (e) {
      this._setStatus(`Avatar load failed: ${e?.message || e}`);
      try { this._disposeThirdPersonAvatar(); } catch { /* ignore */ }
    } finally {
      st.loading = false;
    }
  },

  _tickThirdPersonAvatar(dt) {
    const st = this._avatar3p;
    const cfg = this._avatar;
    if (!st || !cfg) return;

    // In the Resume Showcase, force the player avatar to match the resume walker.
    // This avoids mismatches caused by old localStorage prefs or manual overrides.
    const inResumeShowcase = safeTrim(this._proc?.kind).toLowerCase() === 'resume_showcase';
    if (inResumeShowcase) {
      try {
        const rw = this._resumeWalker || null;
        if (rw) {
          cfg.url = safeTrim(rw.url || cfg.url);
          cfg.scale = Number.isFinite(Number(rw.scale)) ? Number(rw.scale) : cfg.scale;
          cfg.yOffset = Number.isFinite(Number(rw.yOffset)) ? Number(rw.yOffset) : cfg.yOffset;
          cfg.yawOffsetRad = Number.isFinite(Number(rw.yawOffsetRad)) ? Number(rw.yawOffsetRad) : (cfg.yawOffsetRad || 0);
        }
      } catch { /* ignore */ }
    }

    // Preload avatar even in first-person so switching to third-person doesn't hitch.
    // Still only *shows* the avatar in third-person on-foot.
    if (!!cfg.enabled && !!safeTrim(cfg.url)) {
      const raw = safeTrim(cfg.url || '').replace(/\\/g, '/');
      const isResumeExport = !!globalThis.__resumeShowcase;
      const rawCandidates = isResumeExport ? resumeAssetCandidates(raw) : [raw];
      const urlCandidates = rawCandidates.map((r) => normalizeAssetUrl(r)).filter(Boolean);
      const curUrl = safeTrim(st.loadedUrl || '');
      const matches = curUrl && urlCandidates.includes(curUrl);
      if ((!st.root || !matches) && !st.loading) void this._loadThirdPersonAvatar({ force: true });
    }
    if (!st.root) return;

    const onFootThird = (this._playerCamMode === 'third') && !this._vehicleSystem?.inVehicle?.();
    const show = !!cfg.enabled && onFootThird;
    try { st.root.visible = show; } catch { /* ignore */ }
    if (!show) return;

    // Ensure player avatar gets the same textures as the walker (best-effort).
    if (!st.texturesApplied && !st.texturesApplyRequested) {
      st.texturesApplyRequested = true;
      try {
        void this._loadResumeWalkerTextureSource({ force: false })
          .then(() => {
            try {
              const ok = this._applyMaterialMapsToRoot(st.root, this._resumeWalkerTexSrc?.material || null);
              if (ok) st.texturesApplied = true;
            } catch { /* ignore */ }
          })
          .finally(() => { try { st.texturesApplyRequested = false; } catch { /* ignore */ } });
      } catch { st.texturesApplyRequested = false; }
    }

    // Pose on player.
    try {
      const sc = Math.max(0.01, Number(cfg.scale) || 1.0);
      st.root.scale.set(sc, sc, sc);
      st.root.position.set(
        Number(this._player.x) || 0,
        (Number(this._player.y) || 0) + (Number(cfg.yOffset) || 0) + (Number(st.autoGroundYOffset) || 0),
        Number(this._player.z) || 0,
      );
      st.root.rotation.set(0, (Number(this._player.yawRad) || 0) + (Number(cfg.yawOffsetRad) || 0), 0);
    } catch { /* ignore */ }

    const forcedKey = this._sanitizeCharacterActionKey(st.forcedActionKey || '');
    if (forcedKey) {
      let foundForced = false;
      for (const [k, action] of (st.actions?.entries?.() || [])) {
        const on = (k === forcedKey);
        try { action?.setEffectiveWeight?.(on ? 1.0 : 0.0); } catch { /* ignore */ }
        if (on) {
          foundForced = true;
          st.activeKey = k;
          try { action?.setEffectiveTimeScale?.(1.0); } catch { /* ignore */ }
        }
      }
      if (foundForced) {
        const delta = Math.max(0.0, Math.min(0.25, Number(dt) || 0.0));
        try { st.mixer?.update?.(delta); } catch { /* ignore */ }
        if (st.cancelRootTranslation && st.rootBone) {
          try { st.rootBone.position.set(0, 0, 0); } catch { /* ignore */ }
        }
        return;
      }
      // Invalid/stale forced key: clear and resume normal locomotion blending.
      st.forcedActionKey = '';
    }

    // Locomotion blend: idle/walk/run with optional turn + jump phases.
    const speed = Math.max(0, Number(this._player?.moveSpeedXZ) || 0);
    const walkRef = Math.max(0.1, Number(this._state?.speed) || 6);
    const runRef = Math.max(walkRef + 0.01, Number(this._state?.sprint) || (walkRef * 1.6));
    const moving = speed > 0.15;
    const onGround = !!this._player?.onGround;
    const vy = Number(this._player?.vy) || 0;
    st.jumpStateT = Math.max(0, Number(st.jumpStateT) || 0) + Math.max(0, Number(dt) || 0);
    if (!st.wasOnGround && onGround) {
      st.jumpState = st.actions?.has?.('jump_land') ? 'land' : 'grounded';
      st.jumpStateT = 0.0;
    } else if (st.wasOnGround && !onGround) {
      st.jumpState = st.actions?.has?.('jump_start') ? 'start' : (st.actions?.has?.('jump_air') ? 'air' : 'grounded');
      st.jumpStateT = 0.0;
    } else if (!onGround && st.jumpState === 'start' && (st.jumpStateT > 0.2 || vy <= 0)) {
      st.jumpState = st.actions?.has?.('jump_air') ? 'air' : 'start';
      st.jumpStateT = 0.0;
    } else if (onGround && st.jumpState === 'land' && st.jumpStateT > 0.22) {
      st.jumpState = 'grounded';
      st.jumpStateT = 0.0;
    } else if (onGround && st.jumpState === 'start' && st.jumpStateT > 0.26) {
      st.jumpState = 'grounded';
      st.jumpStateT = 0.0;
    }
    st.wasOnGround = onGround;

    const jumpActive = st.jumpState === 'start' || st.jumpState === 'air' || st.jumpState === 'land';
    const wJumpStart = jumpActive && st.jumpState === 'start' ? 1.0 : 0.0;
    const wJumpAir = jumpActive && st.jumpState === 'air' ? 1.0 : 0.0;
    const wJumpLand = jumpActive && st.jumpState === 'land' ? 1.0 : 0.0;

    const turnLeftHeld = this._keysDown?.has?.('KeyA') || this._keysDown?.has?.('ArrowLeft');
    const turnRightHeld = this._keysDown?.has?.('KeyD') || this._keysDown?.has?.('ArrowRight');
    const turningInPlace = !moving && onGround && !jumpActive && (turnLeftHeld || turnRightHeld);
    const wTurnLeft = (turningInPlace && !!turnLeftHeld && st.actions?.has?.('turn_left')) ? 1.0 : 0.0;
    const wTurnRight = (turningInPlace && !!turnRightHeld && st.actions?.has?.('turn_right')) ? 1.0 : 0.0;

    const runBlend = moving ? clamp01((speed - walkRef * 0.85) / Math.max(1e-6, (runRef - walkRef * 0.85))) : 0.0;
    const hasRun = st.actions?.has?.('run_fwd');
    const wRun = (!jumpActive && moving && hasRun) ? runBlend : 0.0;
    const wWalk = (!jumpActive && moving) ? (1.0 - wRun) : 0.0;
    const wIdle = (!jumpActive && !moving && !turningInPlace) ? 1.0 : 0.0;
    const walkScale = Math.max(0.2, Math.min(2.2, speed / walkRef));
    const runScale = Math.max(0.2, Math.min(2.2, speed / runRef));
    try { if (st.actions?.has?.('idle')) st.actions.get('idle').setEffectiveWeight(wIdle); } catch { /* ignore */ }
    try { if (st.actions?.has?.('walk_fwd')) { const a = st.actions.get('walk_fwd'); a.setEffectiveWeight(wWalk); a.setEffectiveTimeScale(walkScale); } } catch { /* ignore */ }
    try { if (hasRun) { const a = st.actions.get('run_fwd'); a.setEffectiveWeight(wRun); a.setEffectiveTimeScale(runScale); } } catch { /* ignore */ }
    try { if (st.actions?.has?.('turn_left')) st.actions.get('turn_left').setEffectiveWeight(wTurnLeft); } catch { /* ignore */ }
    try { if (st.actions?.has?.('turn_right')) st.actions.get('turn_right').setEffectiveWeight(wTurnRight); } catch { /* ignore */ }
    try { if (st.actions?.has?.('jump_start')) st.actions.get('jump_start').setEffectiveWeight(wJumpStart); } catch { /* ignore */ }
    try { if (st.actions?.has?.('jump_air')) st.actions.get('jump_air').setEffectiveWeight(wJumpAir); } catch { /* ignore */ }
    try { if (st.actions?.has?.('jump_land')) st.actions.get('jump_land').setEffectiveWeight(wJumpLand); } catch { /* ignore */ }

    // Mixer update.
    const delta = Math.max(0.0, Math.min(0.25, Number(dt) || 0.0));
    try { st.mixer?.update?.(delta); } catch { /* ignore */ }
    if (st.cancelRootTranslation && st.rootBone) {
      try { st.rootBone.position.set(0, 0, 0); } catch { /* ignore */ }
    }
  },

  _tickCharacters(dt) {
    try { this._tickThirdPersonAvatar(dt); } catch { /* ignore */ }
    try { this._tickRoomSimPeople(dt); } catch { /* ignore */ }
    try { this._tickResumeShowcaseWalker(dt); } catch { /* ignore */ }
  },
};

