import { el, clear, clamp } from '../../../ui/dom.js';
import * as THREE from 'three';

import {
  safeTrim,
  normQuery,
  getFileStem,
  extOf,
  isGlTfExt,
  isProceduralPath,
  isCharacterProfileAssetPath,
  disposeThreeObject,
} from './core/scene_utils.js';

import { CHARACTER_ACTION_KEYS } from './characters/character_anim_utils.js';

export const sceneScenarioMixin = {
  async _loadSavedScenarioByIndex(idxRaw) {
    const idx = Number(idxRaw);
    if (!Number.isFinite(idx) || idx < 0) return;
    const list = this._loadScenarioList();
    const sc = list[idx];
    if (!sc) return;
    const p = safeTrim(sc?.path);
    if (!p) return;
    this._pendingScenario = sc;
    this._setSourceUrl(p);
    if (isProceduralPath(p)) {
      await this._loadProcedural(p, { scenario: sc });
      return;
    }
    const ext = extOf(p);
    if (isGlTfExt(ext)) {
      await this._loadGlb(p, { scenario: sc });
      return;
    }
    this._setStatus('Scenario path is not GLB/GLTF. Use Convert then Load (or use proc:arena).');
  },

  _loadScenarioList() {
    try {
      const raw = String(localStorage.getItem('devtools.scene.scenarios') || '').trim();
      const j = raw ? JSON.parse(raw) : [];
      return Array.isArray(j) ? j : [];
    } catch {
      return [];
    }
  },

  _saveScenarioList(list) {
    try { localStorage.setItem('devtools.scene.scenarios', JSON.stringify(Array.isArray(list) ? list : [])); } catch { /* ignore */ }
  },

  _saveScenarioFromUi() {
    const sc = this._buildScenarioSnapshot();
    const list = this._loadScenarioList();
    // Replace by name if present; otherwise prepend.
    const name = safeTrim(sc?.name);
    const next = list.filter((x) => safeTrim(x?.name) !== name);
    next.unshift(sc);
    this._saveScenarioList(next.slice(0, 50));
    this._setStatus(`Saved scenario: ${name}`);
  },

  _sanitizeCharacterActionKey(raw) {
    const key = safeTrim(raw).toLowerCase();
    if (!key) return '';
    return CHARACTER_ACTION_KEYS.includes(key) ? key : '';
  },

  _readScenarioMeta(content = null) {
    const src = (content && typeof content === 'object') ? content : this._scenarioContent;
    const meta = (src?.meta && typeof src.meta === 'object') ? src.meta : {};
    const avatarProfile = safeTrim(meta?.avatarProfile || '');
    const avatarAction = this._sanitizeCharacterActionKey(meta?.avatarAction);
    return { avatarProfile, avatarAction };
  },

  _setScenarioMeta(nextMeta, { applyNow = false } = {}) {
    const cur = this._readScenarioMeta(this._scenarioContent);
    const incoming = (nextMeta && typeof nextMeta === 'object') ? nextMeta : {};
    const avatarProfile = Object.prototype.hasOwnProperty.call(incoming, 'avatarProfile')
      ? safeTrim(incoming.avatarProfile || '')
      : cur.avatarProfile;
    const avatarAction = Object.prototype.hasOwnProperty.call(incoming, 'avatarAction')
      ? this._sanitizeCharacterActionKey(incoming.avatarAction)
      : cur.avatarAction;
    const merged = { avatarProfile, avatarAction };
    if (!this._scenarioContent || typeof this._scenarioContent !== 'object') this._scenarioContent = { waypoints: [], triggers: [], meta: merged };
    else this._scenarioContent.meta = merged;
    if (applyNow) this._applyScenarioMeta(merged);
    return merged;
  },

  _applyScenarioMeta(meta) {
    const m = (meta && typeof meta === 'object') ? meta : this._readScenarioMeta(this._scenarioContent);
    const profile = safeTrim(m?.avatarProfile || '');
    const action = this._sanitizeCharacterActionKey(m?.avatarAction);
    if (profile) {
      if (isCharacterProfileAssetPath(profile)) {
        this._avatar.enabled = true;
        this._avatar.url = profile;
        this._savePrefs();
        try { void this._loadThirdPersonAvatar({ force: true }); } catch { /* ignore */ }
      } else {
        this._setStatus(`Scenario character ignored (not a saved profile JSON): ${profile}`);
      }
    }
    this._avatar3p.forcedActionKey = action || '';
  },

  _buildScenarioSnapshot() {
    let path = safeTrim(this._state.sourceUrl);
    if (!path && this._proc?.root) path = `proc:${safeTrim(this._proc.kind) || 'arena'}`;
    if (!path) throw new Error('Missing scene path');
    const name = safeTrim(this._ui.scenarioName?.value || '') || getFileStem(path);

    const spawn = { x: this._spawn.x, y: this._spawn.y, z: this._spawn.z };
    const cam = this._camera;
    const yaw = cam ? Number(cam.rotation?.y || 0) : 0;
    const pitch = cam ? Number(cam.rotation?.x || 0) : 0;

    const waypoints = Array.isArray(this._scenarioContent?.waypoints) ? this._scenarioContent.waypoints : [];
    const triggers = Array.isArray(this._scenarioContent?.triggers) ? this._scenarioContent.triggers : [];
    const vehicles = Array.isArray(this._scenarioContent?.vehicles) ? this._scenarioContent.vehicles : [];
    const traffic = (this._scenarioContent?.traffic && typeof this._scenarioContent.traffic === 'object') ? this._scenarioContent.traffic : null;

    const content = {
      waypoints,
      triggers,
      meta: this._readScenarioMeta(this._scenarioContent),
      ...(vehicles.length ? { vehicles } : {}),
      ...(traffic ? { traffic } : {}),
    };

    return {
      schema: 1,
      name,
      path,
      spawn,
      view: { yaw, pitch, eyeH: Number(this._player.eyeH || 1.7) },
      settings: {
        mode: String(this._state.mode || 'fps'),
        showGrid: !!this._state.showGrid,
        fly: !!this._state.fly,
        speed: Number(this._state.speed || 6),
        sprint: Number(this._state.sprint || 11),
      },
      content,
    };
  },

  _importScenario(sc) {
    this._importScenarioWithOptions(sc, { prepend: true, source: '' });
  },

  _importScenarioWithOptions(sc, { prepend = true, source = '', maxKeep = 80 } = {}) {
    if (!sc || typeof sc !== 'object') throw new Error('Scenario must be an object');
    const name = safeTrim(sc?.name);
    const rawPath = safeTrim(sc?.path).replace(/\\/g, '/');
    let path = rawPath;
    if (!name || !path) throw new Error('Scenario requires name + path');
    // Normalize asset paths so saved scenarios are stable when reloading later.
    // Exporters sometimes emit repo-relative paths like "assets/.../model.glb" (no leading slash).
    const isHttp = /^https?:\/\//i.test(path);
    if (!isHttp && !isProceduralPath(path) && !path.startsWith('/')) path = `/${path.replace(/^\/+/, '')}`;
    const list = this._loadScenarioList();
    const srcTag = safeTrim(source);
    const tagKey = '__devtoolsSource';

    const existing = list.find((x) => safeTrim(x?.name) === name) || null;
    const existingIsExported = safeTrim(existing?.[tagKey]) === 'exported_track';
    const incomingIsExported = srcTag === 'exported_track';
    // If a user saved a scenario with the same name, don't overwrite it with auto-imported exports.
    if (existing && !existingIsExported && incomingIsExported) return;

    const next = list.filter((x) => safeTrim(x?.name) !== name);
    const item = { ...sc, schema: Number(sc?.schema) || 1, name, path, ...(srcTag ? { [tagKey]: srcTag } : {}) };
    if (prepend) next.unshift(item);
    else next.push(item);

    const cap = Math.max(10, Math.min(300, Math.floor(Number(maxKeep) || 80)));
    // Prefer to evict auto-imported exported tracks first, so we don't clobber the user's saved scenarios.
    while (next.length > cap) {
      const idx = next.findIndex((x) => safeTrim(x?.[tagKey]) === 'exported_track');
      if (idx >= 0) next.splice(idx, 1);
      else next.pop();
    }
    this._saveScenarioList(next);
  },

  _deleteScenarioAt(idx) {
    const list = this._loadScenarioList();
    const i = Math.floor(Number(idx));
    if (!Number.isFinite(i) || i < 0 || i >= list.length) return;
    list.splice(i, 1);
    this._saveScenarioList(list);
  },

  _applyScenarioPose(sc) {
    // Apply settings
    const st = sc?.settings && typeof sc.settings === 'object' ? sc.settings : {};
    if (typeof st.mode === 'string') this._state.mode = (st.mode === 'orbit') ? 'orbit' : 'fps';
    if (typeof st.showGrid === 'boolean') this._state.showGrid = st.showGrid;
    if (typeof st.enableLean === 'boolean') this._state.enableLean = st.enableLean;
    if (typeof st.fly === 'boolean') this._state.fly = st.fly;
    if (Number.isFinite(Number(st.speed))) this._state.speed = Math.max(0.1, Number(st.speed));
    if (Number.isFinite(Number(st.sprint))) this._state.sprint = Math.max(0.1, Number(st.sprint));
    if (typeof st.drivingEnabled === 'boolean') {
      // Driving enablement is owned by the vehicle system; keep a copy on the tool for older codepaths.
      this._drivingEnabled = st.drivingEnabled;
      try { this._vehicleSystem?.setDrivingEnabled?.(!!st.drivingEnabled); } catch { /* ignore */ }
    }

    if (this._grid) this._grid.visible = !!this._state.showGrid;
    try { if (this._ui.gridChk) this._ui.gridChk.checked = !!this._state.showGrid; } catch { /* ignore */ }
    try { if (this._ui.leanChk) this._ui.leanChk.checked = !!this._state.enableLean; } catch { /* ignore */ }
    try { if (this._ui.flyChk) this._ui.flyChk.checked = !!this._state.fly; } catch { /* ignore */ }
    try { if (this._ui.speedInput) this._ui.speedInput.value = String(this._state.speed); } catch { /* ignore */ }
    this._syncModeUi();

    // Spawn
    const sp = sc?.spawn && typeof sc.spawn === 'object' ? sc.spawn : null;
    if (sp && [sp.x, sp.y, sp.z].every((v) => Number.isFinite(Number(v)))) {
      this._spawn = { x: Number(sp.x), y: Number(sp.y), z: Number(sp.z) };
    }
    this._player.x = this._spawn.x;
    this._player.y = this._spawn.y;
    this._player.z = this._spawn.z;
    this._player.vy = 0;

    // View (FPS only)
    const v = sc?.view && typeof sc.view === 'object' ? sc.view : {};
    if (Number.isFinite(Number(v.eyeH))) this._player.eyeH = Math.max(0.5, Math.min(3.0, Number(v.eyeH)));
    if (this._camera) {
      // PointerLockControls expects YXZ order for fps-style camera.
      try { this._camera.rotation.order = 'YXZ'; } catch { /* ignore */ }
      const yaw = Number.isFinite(Number(v.yaw)) ? Number(v.yaw) : 0;
      const pitch = Number.isFinite(Number(v.pitch)) ? Number(v.pitch) : 0;
      this._camera.rotation.y = yaw;
      this._camera.rotation.x = clamp(pitch, -1.55, 1.55);
      this._camera.position.set(this._player.x, this._player.y + this._player.eyeH, this._player.z);
    }
    // If on-foot third-person is enabled, apply chase placement immediately so the
    // initial camera isn't stale until the first pointer-locked movement tick.
    try { if (this._state.mode === 'fps') this._applyPlayerCameraBasePose(this._playerCamMode); } catch { /* ignore */ }

    // Content
    const c = sc?.content && typeof sc.content === 'object' ? sc.content : {};
    const waypoints = Array.isArray(c?.waypoints) ? c.waypoints : [];
    const triggers = Array.isArray(c?.triggers) ? c.triggers : [];
    const vehicles = Array.isArray(c?.vehicles) ? c.vehicles : [];
    const traffic = (c?.traffic && typeof c.traffic === 'object') ? c.traffic : null;
    const meta = this._readScenarioMeta(c);
    this._scenarioContent = { waypoints, triggers, meta, vehicles, traffic };
    this._applyScenarioMeta(meta);
    this._triggerInside.clear();
    this._renderWaypointsUi();
    this._renderTriggersUi();
    this._rebuildScenarioDebug();
  },

  _setSpawnFromCurrent() {
    if (!this._camera) return;
    // Spawn at the player's feet under the camera.
    this._spawn = {
      x: Number(this._player.x),
      y: Number(this._player.y),
      z: Number(this._player.z),
    };
    this._syncSpawnMarker();
  },

  _syncSpawnMarker() {
    const m = this._spawnMarker;
    if (!m) return;
    m.position.set(this._spawn.x, this._spawn.y + 0.18, this._spawn.z);
    m.visible = true;
  },

  _parseSizeCsv(s, fallback = [3, 2, 3]) {
    const raw = String(s || '').trim();
    const parts = raw.split(',').map((x) => Number(String(x || '').trim()));
    const out = (parts.length >= 3 && parts.slice(0, 3).every((v) => Number.isFinite(v) && v > 0))
      ? parts.slice(0, 3)
      : fallback;
    return { x: out[0], y: out[1], z: out[2] };
  },

  _makeId() {
    try { return crypto?.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2); } catch { return String(Math.random()).slice(2); }
  },

  _uniqueWaypointName(baseName, { excludeName = '' } = {}) {
    const base = safeTrim(baseName) || 'Waypoint';
    const wps = Array.isArray(this._scenarioContent.waypoints) ? this._scenarioContent.waypoints : [];
    const used = new Set(
      wps.map((w) => safeTrim(w?.name)).filter(Boolean).filter((n) => n !== safeTrim(excludeName)),
    );
    if (!used.has(base)) return base;
    let i = 2;
    while (used.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  },

  _uniqueTriggerName(baseName, { excludeId = '' } = {}) {
    const base = safeTrim(baseName) || 'Trigger';
    const trigs = Array.isArray(this._scenarioContent.triggers) ? this._scenarioContent.triggers : [];
    const used = new Set(
      trigs
        .filter((t) => safeTrim(t?.id) !== safeTrim(excludeId))
        .map((t) => safeTrim(t?.name))
        .filter(Boolean),
    );
    if (!used.has(base)) return base;
    let i = 2;
    while (used.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  },

  _addWaypointFromCurrent(name) {
    const nm = this._uniqueWaypointName(safeTrim(name) || `Waypoint ${this._scenarioContent.waypoints.length + 1}`);
    const wp = { name: nm, x: Number(this._player.x), y: Number(this._player.y), z: Number(this._player.z) };
    this._scenarioContent.waypoints = Array.isArray(this._scenarioContent.waypoints) ? this._scenarioContent.waypoints : [];
    this._scenarioContent.waypoints.push(wp);
  },

  _teleportToWaypoint(name) {
    const nm = safeTrim(name);
    const wps = Array.isArray(this._scenarioContent.waypoints) ? this._scenarioContent.waypoints : [];
    const wp = wps.find((w) => safeTrim(w?.name) === nm);
    if (!wp) return false;
    this._player.x = Number(wp.x) || 0;
    this._player.y = Number(wp.y) || 0;
    this._player.z = Number(wp.z) || 0;
    this._player.vy = 0;
    if (this._camera) this._camera.position.set(this._player.x, this._player.y + this._player.eyeH, this._player.z);
    return true;
  },

  _teleportToPoint(x, y, z) {
    const px = Number(x), py = Number(y), pz = Number(z);
    if (![px, py, pz].every(Number.isFinite)) return false;
    this._player.x = px;
    this._player.y = py;
    this._player.z = pz;
    this._player.vy = 0;
    if (this._state.mode === 'orbit') {
      try { this._orbit?.target?.set?.(px, py + 1.0, pz); } catch { /* ignore */ }
      try { this._orbit?.update?.(); } catch { /* ignore */ }
    } else {
      if (this._camera) this._camera.position.set(this._player.x, this._player.y + this._player.eyeH, this._player.z);
    }
    return true;
  },

  _addTriggerAtCurrent({ name, type, once, message, targetWaypoint, requireInteract, prompt, size, action, avatarProfile, avatarAction }) {
    const trig = {
      id: crypto?.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2),
      name: safeTrim(name) || `Trigger ${this._scenarioContent.triggers.length + 1}`,
      type: (type === 'teleport') ? 'teleport' : (type === 'goal') ? 'goal' : 'message',
      once: !!once,
      requireInteract: !!requireInteract,
      prompt: safeTrim(prompt),
      center: { x: Number(this._player.x), y: Number(this._player.y) + 1.0, z: Number(this._player.z) },
      size: size && typeof size === 'object' ? size : { x: 3, y: 2, z: 3 },
    };
    if (trig.type === 'message') {
      trig.message = safeTrim(message) || 'Hello!';
      const actionKey = safeTrim(action).toLowerCase();
      if (actionKey) trig.action = actionKey;
      const profile = safeTrim(avatarProfile || '');
      if (profile) trig.avatarProfile = profile;
      const forced = this._sanitizeCharacterActionKey(avatarAction);
      if (forced) trig.avatarAction = forced;
    }
    if (trig.type === 'teleport') trig.targetWaypoint = safeTrim(targetWaypoint) || '';
    if (trig.type === 'goal') trig.goal = true;
    this._scenarioContent.triggers = Array.isArray(this._scenarioContent.triggers) ? this._scenarioContent.triggers : [];
    this._scenarioContent.triggers.push(trig);
  },

  _isPlayerInsideTrigger(t) {
    const c = t?.center || {};
    const sz = t?.size || {};
    const cx = Number(c.x), cy = Number(c.y), cz = Number(c.z);
    const sx = Math.max(0.01, Number(sz.x) || 0), sy = Math.max(0.01, Number(sz.y) || 0), sz0 = Math.max(0.01, Number(sz.z) || 0);
    const px = Number(this._player.x);
    const py = Number(this._player.y) + 1.0;
    const pz = Number(this._player.z);
    if (![cx, cy, cz, sx, sy, sz0, px, py, pz].every((v) => Number.isFinite(v))) return false;
    return (Math.abs(px - cx) <= sx * 0.5) && (Math.abs(py - cy) <= sy * 0.5) && (Math.abs(pz - cz) <= sz0 * 0.5);
  },

  _fireScenarioTrigger(t, id) {
    const once = !!t?.once;
    const type = safeTrim(t?.type);
    if (type === 'teleport') {
      const target = safeTrim(t?.targetWaypoint);
      const ok = target ? this._teleportToWaypoint(target) : false;
      if (ok) this._ctx?.toast?.(`Teleport → ${target}`, 'info', { title: 'Scene' });
      else this._ctx?.toast?.(`Teleport failed (missing waypoint: ${target || '?'})`, 'warning', { title: 'Scene' });
    } else if (type === 'goal') {
      if (!this._completedGoals.has(id)) {
        this._completedGoals.add(id);
        this._ctx?.toast?.(`Goal reached: ${safeTrim(t?.name) || 'Goal'}`, 'success', { title: 'Scene' });
        this._renderObjectivesUi();
      }
    } else {
      const action = safeTrim(t?.action).toLowerCase();
      if (action === 'resume_repo_open') {
        if (typeof this._resumeShowcase?.showCurrentRepo === 'function') this._resumeShowcase.showCurrentRepo();
        else this._showCurrentResumeShowcaseRepo();
        const msg = safeTrim(t?.message) || 'Repository opened';
        this._ctx?.toast?.(msg, 'info', { title: 'Project' });
      } else if (action === 'avatar_set_profile') {
        const profile = safeTrim(t?.avatarProfile || '');
        if (!profile) {
          this._ctx?.toast?.('Avatar set-profile trigger is missing avatarProfile.', 'warning', { title: 'Scene' });
        } else if (!isCharacterProfileAssetPath(profile)) {
          this._ctx?.toast?.('Avatar profile must be a saved character profile/manifest JSON.', 'warning', { title: 'Scene' });
        } else {
          this._avatar.enabled = true;
          this._avatar.url = profile;
          this._savePrefs();
          this._avatar3p.forcedActionKey = '';
          try { void this._loadThirdPersonAvatar({ force: true }); } catch { /* ignore */ }
          const msg = safeTrim(t?.message) || `Switched character: ${profile}`;
          this._ctx?.toast?.(msg, 'info', { title: 'Character' });
        }
      } else if (action === 'avatar_set_action') {
        const key = this._sanitizeCharacterActionKey(t?.avatarAction);
        if (!key) {
          this._ctx?.toast?.('Avatar set-action trigger has no valid avatarAction key.', 'warning', { title: 'Scene' });
        } else {
          this._avatar3p.forcedActionKey = key;
          const msg = safeTrim(t?.message) || `Character action: ${key}`;
          this._ctx?.toast?.(msg, 'info', { title: 'Character' });
        }
      } else if (action === 'avatar_clear_action') {
        this._avatar3p.forcedActionKey = '';
        const msg = safeTrim(t?.message) || 'Character action lock cleared.';
        this._ctx?.toast?.(msg, 'info', { title: 'Character' });
      } else if (action === 'project_panel') {
        this._showResumeProjectPanel({
          title: safeTrim(t?.panelTitle) || safeTrim(t?.name) || 'Project',
          meta: safeTrim(t?.panelMeta),
          description: safeTrim(t?.panelBody) || safeTrim(t?.message),
          repoUrl: safeTrim(t?.repoUrl),
          demoUrl: safeTrim(t?.demoUrl),
          embedUrl: safeTrim(t?.embedUrl),
        });
        const msg = safeTrim(t?.message) || safeTrim(t?.name) || 'Project opened';
        this._ctx?.toast?.(msg, 'info', { title: 'Project' });
      } else if (action === 'resume_repo_prev') {
        if (typeof this._resumeShowcase?.cycleSelection === 'function') this._resumeShowcase.cycleSelection(-1);
        else this._cycleResumeShowcaseSelection(-1);
      } else if (action === 'resume_repo_next') {
        if (typeof this._resumeShowcase?.cycleSelection === 'function') this._resumeShowcase.cycleSelection(1);
        else this._cycleResumeShowcaseSelection(1);
      } else {
        const msg = safeTrim(t?.message) || safeTrim(t?.name) || 'Trigger';
        this._ctx?.toast?.(msg, 'info', { title: 'Scene' });
      }
    }

    if (once) this._triggerFired.add(id);
    if (once) this._triggerInside.set(id, true);
  },

  _tryInteractAtPlayer() {
    // Resume export robustness: if something wiped triggers, reseed on-demand.
    try {
      const inResume = safeTrim(this._proc?.kind).toLowerCase() === 'resume_showcase';
      const tr0 = Array.isArray(this._scenarioContent?.triggers) ? this._scenarioContent.triggers : [];
      if (inResume && !tr0.length) this._seedResumeShowcaseContent({ scenario: null });
    } catch { /* ignore */ }
    const trigs = Array.isArray(this._scenarioContent?.triggers) ? this._scenarioContent.triggers : [];
    if (!trigs.length) return false;
    for (const t of trigs) {
      const id = safeTrim(t?.id) || safeTrim(t?.name) || '';
      if (!id) continue;
      if (!t?.requireInteract) continue;
      if (this._triggerFired.has(id) && !!t?.once) continue;
      if (!this._isPlayerInsideTrigger(t)) continue;
      this._fireScenarioTrigger(t, id);
      return true;
    }
    return false;
  },

  _tickTriggers() {
    // Trigger logic is tied to the player position (not camera controls).
    // Resume export robustness: ensure the resume trigger set exists even if some code path cleared it.
    try {
      const inResume = safeTrim(this._proc?.kind).toLowerCase() === 'resume_showcase';
      const tr0 = Array.isArray(this._scenarioContent?.triggers) ? this._scenarioContent.triggers : [];
      if (inResume && !tr0.length) this._seedResumeShowcaseContent({ scenario: null });
    } catch { /* ignore */ }
    const trigs = Array.isArray(this._scenarioContent.triggers) ? this._scenarioContent.triggers : [];
    this._triggerInteractHintActive = false;
    if (!trigs.length) {
      if (this._ui.hintEl) this._ui.hintEl.textContent = '';
      return;
    }

    let hint = '';
    for (const t of trigs) {
      const id = safeTrim(t?.id) || safeTrim(t?.name) || '';
      if (!id) continue;
      const inside = this._isPlayerInsideTrigger(t);
      const was = !!this._triggerInside.get(id);
      const once = !!t?.once;
      const alreadyFired = this._triggerFired.has(id);

      const requireInteract = !!t?.requireInteract;
      const prompt = safeTrim(t?.prompt) || (safeTrim(t?.type) === 'message' ? 'Read' : 'Use');
      if (inside && requireInteract && (!once || !alreadyFired) && !hint) {
        hint = `Press E: ${prompt}`;
        this._triggerInteractHintActive = true;
      }

      const fireOnEnter = inside && !was && !requireInteract && (!once || !alreadyFired);
      if (fireOnEnter) this._fireScenarioTrigger(t, id);

      this._triggerInside.set(id, inside);
    }

    if (this._ui.hintEl) this._ui.hintEl.textContent = hint;
  },

  _renderWaypointsUi() {
    const host = this._ui.waypointsHost;
    const sel = this._ui.trigTargetSel;
    if (!host) return;
    clear(host);
    const wps = Array.isArray(this._scenarioContent.waypoints) ? this._scenarioContent.waypoints : [];
    if (sel) {
      clear(sel);
      sel.appendChild(el('option', { value: '' }, ['(teleport target waypoint)']));
      for (const w of wps) {
        const nm = safeTrim(w?.name);
        if (nm) sel.appendChild(el('option', { value: nm }, [nm]));
      }
    }
    const q = normQuery(this._scenarioUi?.wpFilter || '');
    const matchWp = (w) => {
      if (!q) return true;
      return safeTrim(w?.name).toLowerCase().includes(q);
    };

    if (!wps.length) {
      host.appendChild(el('div', { class: 'muted' }, ['(no waypoints yet)']));
      return;
    }
    const frag = document.createDocumentFragment();
    let shown = 0;
    for (let i = 0; i < wps.length; i++) {
      const w = wps[i];
      if (!matchWp(w)) continue;
      shown++;
      const nm = safeTrim(w?.name) || `Waypoint ${i + 1}`;
      frag.appendChild(el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '4px 0' } }, [
        el('button', {
          class: 'toolBtn',
          style: { flex: '1', padding: '4px 6px', textAlign: 'left' },
          onclick: () => { this._teleportToWaypoint(nm); },
          title: `${nm}  (${Number(w?.x || 0).toFixed(2)}, ${Number(w?.y || 0).toFixed(2)}, ${Number(w?.z || 0).toFixed(2)})`,
        }, [nm]),
        el('button', {
          onclick: async () => { try { await navigator.clipboard.writeText(JSON.stringify(w, null, 2)); } catch { /* ignore */ } },
          title: 'Copy waypoint JSON',
        }, ['Copy']),
        el('button', {
          class: 'danger',
          onclick: () => {
            wps.splice(i, 1);
            this._scenarioContent.waypoints = wps;
            this._renderWaypointsUi();
            this._renderTriggersUi();
            this._rebuildScenarioDebug();
          },
          title: 'Delete waypoint',
        }, ['Del']),
      ]));
    }
    if (!shown) {
      host.appendChild(el('div', { class: 'muted' }, ['(no waypoints match filter)']));
      return;
    }
    host.appendChild(frag);
  },

  _renderTriggersUi() {
    const host = this._ui.triggersHost;
    if (!host) return;
    clear(host);
    const trigs = Array.isArray(this._scenarioContent.triggers) ? this._scenarioContent.triggers : [];
    const q = normQuery(this._scenarioUi?.trigFilter || '');
    const matchTrig = (t) => {
      if (!q) return true;
      const nm = safeTrim(t?.name).toLowerCase();
      const type = safeTrim(t?.type).toLowerCase();
      const msg = safeTrim(t?.message).toLowerCase();
      const target = safeTrim(t?.targetWaypoint).toLowerCase();
      const action = safeTrim(t?.action).toLowerCase();
      const actor = safeTrim(t?.avatarProfile).toLowerCase();
      const actionKey = safeTrim(t?.avatarAction).toLowerCase();
      return (nm.includes(q) || type.includes(q) || msg.includes(q) || target.includes(q) || action.includes(q) || actor.includes(q) || actionKey.includes(q));
    };

    if (!trigs.length) {
      host.appendChild(el('div', { class: 'muted' }, ['(no triggers yet)']));
      return;
    }
    const frag = document.createDocumentFragment();
    let shown = 0;
    for (let i = 0; i < trigs.length; i++) {
      const t = trigs[i];
      if (!matchTrig(t)) continue;
      shown++;
      const nm = safeTrim(t?.name) || `Trigger ${i + 1}`;
      const type = safeTrim(t?.type) || 'message';
      const action = safeTrim(t?.action) || '';
      const actionSuffix = action ? ` · action: ${action}` : '';
      const actionDetail = (action === 'avatar_set_profile')
        ? (safeTrim(t?.avatarProfile) ? ` (${safeTrim(t?.avatarProfile)})` : ' (missing avatarProfile)')
        : (action === 'avatar_set_action')
          ? (safeTrim(t?.avatarAction) ? ` (${safeTrim(t?.avatarAction)})` : ' (missing avatarAction)')
          : '';
      const badge = (type === 'teleport') ? `teleport → ${safeTrim(t?.targetWaypoint) || '?'}`
        : (type === 'goal') ? 'goal'
        : `message${actionSuffix}${actionDetail}`;
      frag.appendChild(el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '4px 0' } }, [
        el('div', { style: { flex: '1' } }, [
          el('div', { style: { fontWeight: '600', fontSize: '11px' } }, [nm]),
          el('div', { class: 'muted', style: { fontSize: '10px', marginTop: '1px' } }, [badge]),
        ]),
        el('button', {
          onclick: async () => { try { await navigator.clipboard.writeText(JSON.stringify(t, null, 2)); } catch { /* ignore */ } },
          title: 'Copy trigger JSON',
        }, ['Copy']),
        el('button', {
          class: 'danger',
          onclick: () => {
            trigs.splice(i, 1);
            this._scenarioContent.triggers = trigs;
            this._renderTriggersUi();
            this._renderObjectivesUi();
            this._rebuildScenarioDebug();
          },
          title: 'Delete trigger',
        }, ['Del']),
      ]));
    }
    if (!shown) {
      host.appendChild(el('div', { class: 'muted' }, ['(no triggers match filter)']));
      return;
    }
    host.appendChild(frag);
  },

  _renderObjectivesUi() {
    const host = this._ui.objectivesHost;
    if (!host) return;
    clear(host);
    const trigs = Array.isArray(this._scenarioContent.triggers) ? this._scenarioContent.triggers : [];
    const goals = trigs.filter((t) => safeTrim(t?.type) === 'goal');
    if (!goals.length) {
      host.appendChild(el('div', { class: 'muted' }, ['(no goal triggers)']));
      return;
    }
    let done = 0;
    for (const g of goals) {
      const id = safeTrim(g?.id) || safeTrim(g?.name) || '';
      const nm = safeTrim(g?.name) || 'Goal';
      const ok = id && this._completedGoals.has(id);
      if (ok) done++;
      host.appendChild(el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '3px 0' } }, [
        el('span', { class: 'muted', style: { width: '16px', textAlign: 'center' } }, [ok ? '✓' : '·']),
        el('div', { style: { flex: '1', fontSize: '11px', opacity: ok ? '0.75' : '1' } }, [nm]),
      ]));
    }
    host.appendChild(el('div', { class: 'muted', style: { marginTop: '6px', fontSize: '10px' } }, [`${done}/${goals.length} complete`]));
  },

  _rebuildScenarioDebug() {
    const g = this._debugGroup;
    if (!g) return;
    const keep = this._spawnMarker;
    if (!this._debugMarkers || typeof this._debugMarkers !== 'object') {
      this._debugMarkers = { wp: new Map(), trig: new Map() };
    }

    // Debug off: remove pooled markers but keep spawn marker.
    if (!this._state.showDebug) {
      for (const m of (this._debugMarkers.wp?.values?.() || [])) {
        try { g.remove(m); } catch { /* ignore */ }
        try { disposeThreeObject(m); } catch { /* ignore */ }
      }
      for (const rec of (this._debugMarkers.trig?.values?.() || [])) {
        const line = rec?.line;
        try { if (line) g.remove(line); } catch { /* ignore */ }
        try { disposeThreeObject(line); } catch { /* ignore */ }
      }
      this._debugMarkers.wp = new Map();
      this._debugMarkers.trig = new Map();
      try { if (keep && keep.parent !== g) g.add(keep); } catch { /* ignore */ }
      return;
    }

    const selWp = safeTrim(this._scenarioSel?.waypointName);
    const selTrig = safeTrim(this._scenarioSel?.triggerId);

    try { if (keep && keep.parent !== g) g.add(keep); } catch { /* ignore */ }

    // Waypoint markers (pooled)
    const wps = Array.isArray(this._scenarioContent.waypoints) ? this._scenarioContent.waypoints : [];
    const usedWp = new Set();
    for (let i = 0; i < wps.length; i++) {
      const w = wps[i];
      const id = safeTrim(w?.name) || `wp:${i}`;
      const x = Number(w?.x), y = Number(w?.y), z = Number(w?.z);
      if (!id || ![x, y, z].every((v) => Number.isFinite(v))) continue;
      usedWp.add(id);
      let m = this._debugMarkers.wp.get(id);
      if (!m) {
        try {
          const geo = new THREE.SphereGeometry(0.12, 12, 10);
          const mat = new THREE.MeshStandardMaterial({ color: 0x5bda8a, emissive: 0x102818, roughness: 0.45, metalness: 0.0 });
          m = new THREE.Mesh(geo, mat);
          this._debugMarkers.wp.set(id, m);
          g.add(m);
        } catch { /* ignore */ }
      }
      if (m) {
        try { m.position.set(x, y + 0.15, z); } catch { /* ignore */ }
        const isSel = id && id === selWp;
        try {
          // highlight selection
          m.material.color?.setHex?.(isSel ? 0x7eb3ff : 0x5bda8a);
          m.material.emissive?.setHex?.(isSel ? 0x173050 : 0x102818);
        } catch { /* ignore */ }
        try { if (m.parent !== g) g.add(m); } catch { /* ignore */ }
      }
    }
    for (const [id, m] of this._debugMarkers.wp.entries()) {
      if (usedWp.has(id)) continue;
      try { g.remove(m); } catch { /* ignore */ }
      try { disposeThreeObject(m); } catch { /* ignore */ }
      this._debugMarkers.wp.delete(id);
    }

    // Trigger boxes (wireframe edges) (pooled)
    const trigs = Array.isArray(this._scenarioContent.triggers) ? this._scenarioContent.triggers : [];
    const usedTr = new Set();
    for (let i = 0; i < trigs.length; i++) {
      const t = trigs[i];
      const action = safeTrim(t?.action).toLowerCase();
      const inResumeShowcase = safeTrim(this._proc?.kind).toLowerCase() === 'resume_showcase';
      const isResumeRepoTrigger =
        action === 'resume_repo_open' ||
        action === 'resume_repo_prev' ||
        action === 'resume_repo_next';
      const isResumeWebsiteTrigger = action === 'project_panel';
      const isResumeInteractTrigger = inResumeShowcase && !!t?.requireInteract;
      if (isResumeRepoTrigger || isResumeWebsiteTrigger || isResumeInteractTrigger) continue; // Hide resume interaction trigger debug boxes.
      if (!safeTrim(t?.id)) t.id = this._makeId();
      const id = safeTrim(t?.id) || safeTrim(t?.name) || `tr:${i}`;
      const c = t?.center || {};
      const sz = t?.size || {};
      const cx = Number(c.x), cy = Number(c.y), cz = Number(c.z);
      const sx = Number(sz.x), sy = Number(sz.y), sz0 = Number(sz.z);
      if (!id || ![cx, cy, cz, sx, sy, sz0].every((v) => Number.isFinite(v) && v > 0)) continue;
      usedTr.add(id);

      const type = safeTrim(t?.type);
      const baseCol = isResumeRepoTrigger
        ? 0x69dbff
        : (type === 'teleport')
          ? 0x7eb3ff
          : (type === 'goal')
            ? 0x5bda8a
            : 0xffd166;
      const col = (id === selTrig) ? 0xffffff : baseCol;
      const sizeKey = `${sx.toFixed(4)},${sy.toFixed(4)},${sz0.toFixed(4)}`;

      let rec = this._debugMarkers.trig.get(id);
      if (!rec) {
        rec = { line: null, sizeKey: '', col: 0 };
        this._debugMarkers.trig.set(id, rec);
      }

      if (!rec.line) {
        try {
          const geo = new THREE.BoxGeometry(sx, sy, sz0);
          const edges = new THREE.EdgesGeometry(geo);
          const mat = new THREE.LineBasicMaterial({ color: col });
          const line = new THREE.LineSegments(edges, mat);
          rec.line = line;
          rec.sizeKey = sizeKey;
          rec.col = col;
          g.add(line);
        } catch { /* ignore */ }
      } else {
        if (rec.sizeKey !== sizeKey) {
          try {
            const geo = new THREE.BoxGeometry(sx, sy, sz0);
            const edges = new THREE.EdgesGeometry(geo);
            try { rec.line.geometry?.dispose?.(); } catch { /* ignore */ }
            rec.line.geometry = edges;
            rec.sizeKey = sizeKey;
          } catch { /* ignore */ }
        }
        if (rec.col !== col) {
          try { rec.line.material.color?.setHex?.(col); } catch { /* ignore */ }
          rec.col = col;
        }
      }

      if (rec.line) {
        try { rec.line.position.set(cx, cy, cz); } catch { /* ignore */ }
        try { if (rec.line.parent !== g) g.add(rec.line); } catch { /* ignore */ }
      }
    }
    for (const [id, rec] of this._debugMarkers.trig.entries()) {
      if (usedTr.has(id)) continue;
      const line = rec?.line;
      try { if (line) g.remove(line); } catch { /* ignore */ }
      try { disposeThreeObject(line); } catch { /* ignore */ }
      this._debugMarkers.trig.delete(id);
    }
  },
};

