import { safeTrim, resizeCanvasToDisplaySize } from './core/scene_utils.js';

export const sceneTickMixin = {
  tick(dt) {
    if (!this._renderer || !this._scene || !this._camera || !this._canvas) return;

    const { dpr, w, h } = resizeCanvasToDisplaySize(this._canvas, 2.0);
    this._renderer.setPixelRatio(dpr);
    this._renderer.setSize(w / dpr, h / dpr, false);
    this._camera.aspect = Math.max(1e-6, w / Math.max(1e-6, h));
    this._camera.updateProjectionMatrix();

    const delta = Math.max(0, Math.min(0.05, Number(dt) || 0));

    // If we're awaiting a GLB load, prevent simulation from advancing (gravity / vehicle sim).
    // Render still runs so the UI remains responsive.
    if (this._worldLoading) {
      try { if (this._player) this._player.vy = 0; } catch { /* ignore */ }
      this._renderer.render(this._scene, this._camera);
      return;
    }
    // Resume export: ensure triggers exist (interactions shouldn't depend on saved scenarios).
    try {
      if (globalThis.__resumeShowcase && !this._resumeSeed?.done) {
        const inResume = safeTrim(this._proc?.kind).toLowerCase() === 'resume_showcase';
        if (inResume) {
          const trigs = Array.isArray(this._scenarioContent?.triggers) ? this._scenarioContent.triggers : [];
          if (!trigs.length) {
            const t = performance.now() * 0.001;
            const last = Number(this._resumeSeed?.lastTrySec) || 0;
            if ((t - last) > 0.20) {
              this._resumeSeed.lastTrySec = t;
              void this._seedResumeShowcaseContent({ scenario: null }).then(() => {
                const after = Array.isArray(this._scenarioContent?.triggers) ? this._scenarioContent.triggers : [];
                if (after.length) this._resumeSeed.done = true;
              }).catch(() => { /* ignore */ });
            }
          } else {
            this._resumeSeed.done = true;
          }
        }
      }
    } catch { /* ignore */ }
    // If the user hits Esc to unlock pointer-lock, we stop ticking FPS camera updates;
    // make sure any lean roll/offset doesn't "stick" visually.
    try {
      const locked = !!this._plock?.isLocked;
      if (this._wasPointerLocked && !locked) this._clearPlayerLean();
      this._wasPointerLocked = locked;
    } catch { /* ignore */ }
    this._tickPlayer(delta);
    this._tickTriggers();
    this._vehicleSystem?.tick?.(delta);
    this._tickGame(delta);
    this._tickCharacters(delta);
    this._keysPressed.clear();

    if (this._state.mode === 'orbit') {
      this._orbit?.update?.();
    }

    // Keep selection helper up to date.
    try { this._selectionBox?.update?.(); } catch { /* ignore */ }

    this._renderer.render(this._scene, this._camera);
  },

  _tickGame(dt) {
    const g = this._game;
    if (!g) return;
    g.time += Math.max(0, Number(dt) || 0);

    // Toggle visibility (only meaningful for procedural arena demo).
    if (this._hudEls?.root) {
      const show = !!g.enabled || !!this._vehicleSystem?.inVehicle?.();
      this._hudEls.root.style.display = show ? 'block' : 'none';
    }
    if (!g.enabled) return;

    // Message timer
    if (g.msgT > 0) g.msgT = Math.max(0, g.msgT - dt);
    if (this._hudEls?.msg) {
      this._hudEls.msg.textContent = g.msgT > 0 ? String(g.msg || '') : '';
      this._hudEls.msg.style.opacity = g.msgT > 0 ? '1' : '0';
    }

    // Hit marker flash
    if (g.hitT > 0) g.hitT = Math.max(0, g.hitT - dt);
    g.hitAlpha = g.hitT > 0 ? Math.min(1, g.hitT / 0.12) : 0;
    if (this._hudEls?.hit) {
      this._hudEls.hit.style.opacity = String(g.hitAlpha > 0 ? 1 : 0);
      this._hudEls.hit.style.boxShadow = `0 0 0 2px rgba(255,209,102,${(0.85 * g.hitAlpha).toFixed(3)}) inset`;
    }

    // Respawn loop
    if (g.player.dead) {
      g.player.respawnT = Math.max(0, g.player.respawnT - dt);
      if (g.player.respawnT <= 1e-6) {
        g.player.dead = false;
        g.player.hp = g.player.hpMax;
        this._resetToSpawn();
        this._showMsg('Respawned', 1.2);
        try { this._ctx?.toast?.('Respawned', 'info', { title: 'Scene' }); } catch { /* ignore */ }
      }
      this._renderHudText();
      return;
    }

    // Aim/scope (sniper)
    this._tickScope(dt);

    // Reload
    const w0 = this._weapon();
    if (w0.reloadT > 0) {
      w0.reloadT = Math.max(0, w0.reloadT - dt);
      if (w0.reloadT <= 1e-6) {
        const need = Math.max(0, w0.magSize - w0.ammoInMag);
        const take = Math.min(need, Math.max(0, w0.reserve));
        w0.ammoInMag += take;
        w0.reserve -= take;
        this._showMsg('Reloaded', 0.6);
      }
    }

    // Fire cooldown
    if (w0.fireCooldown > 0) w0.fireCooldown = Math.max(0, w0.fireCooldown - dt);

    // Manual reload
    if (this._keysPressed.has('KeyR')) this._startReload();

    // Auto fire
    const canShoot = (this._state.mode === 'fps') && !this._vehicleSystem?.inVehicle?.() && (!!this._plock?.isLocked || this._mouseDown);
    if (canShoot && this._mouseDown && w0.auto) {
      this._tryFireWeapon();
    }

    // AI
    this._tickEnemies(dt);
    this._tickEnemyContacts(dt);
    this._tickFx(dt);
    this._tickGun(dt);

    // Win condition: no enemies alive
    const alive = this._enemies.filter((e) => !e.dead).length;
    g.enemiesAlive = alive;
    const goals = Array.isArray(this._scenarioContent?.triggers) ? this._scenarioContent.triggers.filter((t) => safeTrim(t?.type) === 'goal') : [];
    const goalDone = (goals || []).filter((t) => this._completedGoals.has(safeTrim(t?.id) || safeTrim(t?.name) || '')).length;
    const goalsComplete = (goals.length <= 0) ? true : (goalDone >= goals.length);
    if (!g.missionDone && alive === 0 && goalsComplete) {
      g.missionDone = true;
      this._showMsg('Mission complete.', 3.0);
      try { this._ctx?.toast?.('Mission complete', 'success', { title: 'Scene' }); } catch { /* ignore */ }
    } else if (!g.missionDone && alive === 0 && !goalsComplete && goals.length > 0) {
      // Keep a gentle reminder if you cleared targets before finishing objectives.
      this._showMsg(`Targets eliminated. Complete objectives: ${goalDone}/${goals.length}`, 2.5);
    }

    this._renderHudText();
  },

  _tickScope(dt) {
    const g = this._game;
    if (!g?.enabled || !this._camera) return;
    const w = this._weapon();
    const isSniper = safeTrim(w?.id) === 'sniper';
    const inVeh = !!this._vehicleSystem?.inVehicle?.();
    const wantScope = !inVeh && isSniper && !!this._aimDown && !!this._plock?.isLocked && this._state.mode === 'fps';
    // Show/hide HUD layers
    if (this._hudEls?.scope) this._hudEls.scope.style.display = wantScope ? 'block' : 'none';
    if (this._hudEls?.crosshair) this._hudEls.crosshair.style.display = (wantScope || inVeh) ? 'none' : 'block';

    const targetFov = wantScope ? Math.max(8, Math.min(60, Number(w.zoomFov) || 22)) : (Number(this._baseFov) || 70);
    if (Math.abs((Number(this._camera.fov) || 70) - targetFov) > 0.05) {
      // Smooth a bit to avoid instant pop.
      const cur = Number(this._camera.fov) || 70;
      const a = 1.0 - Math.exp(-18.0 * Math.max(0, Number(dt) || 0));
      this._camera.fov = cur + (targetFov - cur) * a;
      try { this._camera.updateProjectionMatrix(); } catch { /* ignore */ }
    }
  },

  _renderHudText() {
    const g = this._game;
    const el0 = this._hudEls?.topLeft;
    if (!g || !el0) return;
    const hp = Math.max(0, Math.floor(Number(g.player.hp) || 0));
    const hpMax = Math.max(1, Math.floor(Number(g.player.hpMax) || 100));
    const w = this._weapon();
    const reload = (w.reloadT > 0) ? ` (reloading ${(w.reloadT).toFixed(1)}s)` : '';
    const locked = this._plock?.isLocked ? '1' : '0';
    const goals = Array.isArray(this._scenarioContent?.triggers) ? this._scenarioContent.triggers.filter((t) => safeTrim(t?.type) === 'goal') : [];
    const goalDone = (goals || []).filter((t) => this._completedGoals.has(safeTrim(t?.id) || safeTrim(t?.name) || '')).length;
    const goalLine = goals.length ? `Objectives: ${goalDone}/${goals.length}\n` : '';
    const v = this._vehicleSystem?.getVehicleCtx?.() || null;
    const vehLine = v?.inVehicle ? `Vehicle: ${v.vehicleId} (${v.role})\n` : '';
    el0.textContent =
      `HP: ${hp}/${hpMax}\n` +
      `Weapon: ${w.name}\n` +
      `Ammo: ${w.ammoInMag}/${w.reserve}${reload}\n` +
      vehLine +
      `Kills: ${g.kills}\n` +
      `Enemies: ${g.enemiesAlive}\n` +
      goalLine +
      `Locked: ${locked}  (1/2 switch · RMB scope · R reload · E enter · F exit)`;
  },
};

