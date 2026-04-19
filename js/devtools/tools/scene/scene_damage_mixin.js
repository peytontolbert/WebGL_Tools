import { clamp01, disposeThreeObject } from './core/scene_utils.js';

export const sceneDamageMixin = {
  _tickEnemyContacts(dt) {
    const g = this._game;
    if (!g?.enabled) return;
    if (!this._camera) return;

    const t = Number(g.time) || 0;
    const enemies = Array.isArray(this._enemies) ? this._enemies : [];
    if (!enemies.length) return;

    // Player contact (only when not in a vehicle)
    const inVehicle = !!this._vehicleSystem?.inVehicle?.();
    const playerAlive = !g.player?.dead;
    const pr = Math.max(0.05, Number(this._player?.radius) || 0.35);
    const px0 = Number(this._player?.x) || 0;
    const pz0 = Number(this._player?.z) || 0;
    const sprintHeld = this._keysDown.has('ShiftLeft') || this._keysDown.has('ShiftRight');
    const pSpd = Math.max(0, Number(this._player?.moveSpeedXZ) || 0);
    const sprintSpd = Math.max(0.1, Number(this._state?.sprint) || 11);

    // Damage tuning (cheap + readable; avoids frame-melting).
    const ramSpeedMin = 7.0;
    const ramCd = 0.25;
    const ramDmgMax = 36;

    let px = px0;
    let pz = pz0;
    let movedPlayer = false;

    if (!inVehicle && playerAlive) {
      for (const en of enemies) {
        if (!en || en.dead || !en.group) continue;
        const ex = Number(en.group.position.x) || 0;
        const ez = Number(en.group.position.z) || 0;
        const er = Math.max(0.05, Number(en.radius) || 0.35);
        const dx = px - ex;
        const dz = pz - ez;
        const dist = Math.hypot(dx, dz);
        const minD = pr + er;
        if (!(dist < minD)) continue;

        // Push player out of the enemy (soft collision so you don't walk through them).
        const nx = (dist > 1e-6) ? (dx / dist) : 1;
        const nz = (dist > 1e-6) ? (dz / dist) : 0;
        const push = (minD - dist) + 0.03;

        // Try resolve without clipping into world.
        const tryX = px + nx * push;
        const tryZ = pz + nz * push;
        const yFeet = Number(this._player?.y) || 0;
        let rx = px;
        let rz = pz;
        if (!this._collidesAt(tryX, yFeet, rz)) rx = tryX;
        if (!this._collidesAt(rx, yFeet, tryZ)) rz = tryZ;

        if (rx !== px || rz !== pz) {
          px = rx;
          pz = rz;
          movedPlayer = true;
        }

        // Ram damage when sprinting fast enough.
        if (sprintHeld && pSpd >= ramSpeedMin) {
          const last = Number(en.lastRamT ?? -1e9);
          if ((t - last) >= ramCd) {
            const a = clamp01((pSpd - ramSpeedMin) / Math.max(0.001, sprintSpd - ramSpeedMin));
            const dmg = Math.max(1, ramDmgMax * a);
            en.lastRamT = t;
            this._damageEnemy(en, dmg);
          }
        }
      }
    }

    if (movedPlayer) {
      this._player.x = px;
      this._player.z = pz;
      // Keep camera in sync for this frame.
      if (this._state.mode === 'fps' && this._plock?.isLocked) {
        this._camera.position.set(this._player.x, this._player.y + this._player.eyeH, this._player.z);
      }
    }

    // Vehicle run-over damage (any moving vehicle, including NPC-driven ones)
    const vehicles = this._vehicleSystem?.getVehicles?.() || [];
    if (!vehicles.length) return;
    for (const v of vehicles) {
      if (!v?.group) continue;
      const vx = Number(v.group.position.x) || 0;
      const vz = Number(v.group.position.z) || 0;
      const vr = Math.max(0.2, Number(v.radius) || 1.2);
      const spd = Math.abs(Number(v.speed) || 0);
      if (spd < 2.2) continue;

      const vehCd = 0.18;
      const vehDmg = Math.min(120, 10 + spd * 6.5);
      for (const en of enemies) {
        if (!en || en.dead || !en.group) continue;
        const ex = Number(en.group.position.x) || 0;
        const ez = Number(en.group.position.z) || 0;
        const er = Math.max(0.05, Number(en.radius) || 0.35);
        const dx = ex - vx;
        const dz = ez - vz;
        const dist = Math.hypot(dx, dz);
        const minD = vr + er + 0.08;
        if (!(dist < minD)) continue;

        const last = Number(en.lastVehT ?? -1e9);
        if ((t - last) >= vehCd) {
          en.lastVehT = t;
          this._damageEnemy(en, vehDmg);
        }

        // Nudge enemy away so they don't get stuck inside the vehicle.
        const nx = (dist > 1e-6) ? (dx / dist) : 1;
        const nz = (dist > 1e-6) ? (dz / dist) : 0;
        const push = (minD - dist) + 0.06;
        const tryX = ex + nx * push;
        const tryZ = ez + nz * push;
        let rx = ex;
        let rz = ez;
        if (!this._collidesAtRadius(tryX, 0, rz, er)) rx = tryX;
        if (!this._collidesAtRadius(rx, 0, tryZ, er)) rz = tryZ;
        en.group.position.x = rx;
        en.group.position.z = rz;
      }
    }
  },

  _damageEnemy(en, dmg) {
    const g = this._game;
    if (!en || en.dead) return;
    en.hp = Math.max(0, (Number(en.hp) || 0) - Math.max(0, Number(dmg) || 0));
    en.lastHitT = g?.time || 0;
    if (en.hp <= 0) {
      en.dead = true;
      try { this._scene?.remove?.(en.group); } catch { /* ignore */ }
      try { disposeThreeObject(en.group); } catch { /* ignore */ }
      if (g) g.kills += 1;
      try { this._ctx?.toast?.('Target down', 'success', { title: 'Scene' }); } catch { /* ignore */ }
    } else {
      // Alert enemy
      en.alert = 2.0;
    }
  },

  _damagePlayer(dmg) {
    const g = this._game;
    if (!g?.enabled) return;
    if (g.player.dead) return;
    // Prevent "instant melt" when several enemies hit the same frame.
    const cd = Math.max(0, Number(g.player.hitCooldownSec) || 0);
    if (cd > 1e-6 && (Number(g.time) - Number(g.player.lastHitT)) < cd) return;
    g.player.hp = Math.max(0, (Number(g.player.hp) || 0) - Math.max(0, Number(dmg) || 0));
    g.player.lastHitT = g.time;
    if (g.player.hp <= 0) {
      g.player.dead = true;
      g.player.respawnT = 2.0;
      this._showMsg('You died', 1.6);
      try { this._ctx?.toast?.('You died', 'error', { title: 'Scene' }); } catch { /* ignore */ }
    }
  },
};

