import { clamp } from '../../../ui/dom.js';
import * as THREE from 'three';

import { collidesCircleAgainstBoxes } from '../../../shared/collision_world.js';

import {
  safeTrim,
  lerp,
  clamp01,
  disposeThreeObject,
} from './core/scene_utils.js';

export const scenePlayerMixin = {
  _applyResumeTouchLookDelta(dx, dy) {
    if (!this._camera) return;
    // Do not fight pointer-lock rotation when it is active.
    if (this._plock?.isLocked) return;
    // Only meaningful in FPS mode (resume showcase).
    if (this._state?.mode !== 'fps') return;

    const cam = this._camera;
    const s = 0.0036; // tuned for touch deltas (pixels)
    try { cam.rotation.order = 'YXZ'; } catch { /* ignore */ }
    try { cam.rotation.z = 0; } catch { /* ignore */ }

    // Drag right => look right (yaw negative in three.js default conventions).
    cam.rotation.y += -(Number(dx) || 0) * s;
    // Drag down => look down.
    cam.rotation.x += (Number(dy) || 0) * s;

    // Clamp pitch similar to pointer-lock controls (avoid flipping).
    const lim = Math.PI * 0.49;
    cam.rotation.x = Math.max(-lim, Math.min(lim, cam.rotation.x));
  },

  _injectVirtualKeyTap(code) {
    const k = String(code || '').trim();
    if (!k) return;
    // Route through the existing key pipeline so interactions behave identically.
    this._onKeyDown({ code: k, key: k, preventDefault() {}, ctrlKey: false, metaKey: false });
    // Release quickly so it doesn't act like a held key.
    this._onKeyUp({ code: k, key: k });
  },

  _onKeyDown(e) {
    if (!e) return;
    const k = String(e.code || e.key || '');
    if (!k) return;
    if ((k === 'Escape' || k === 'Esc') && this._resumeShowcase?.panelRoot && this._resumeShowcase.panelRoot.style.display !== 'none') {
      try { e.preventDefault(); } catch { /* ignore */ }
      this._hideResumeProjectPanel();
      return;
    }

    // Editor hotkeys (avoid interfering with pointer-lock play).
    try {
      const isCtrl = !!(e.ctrlKey || e.metaKey);
      const isLocked = !!this._plock?.isLocked;
      const a = document.activeElement;
      const typing = !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable));
      if (!isLocked && isCtrl && k === 'KeyS' && !typing) {
        e.preventDefault();
        this._saveScenarioFromUi();
        this._ctx?.toast?.('Scenario saved', 'success', { title: 'Scene' });
        return;
      }
    } catch { /* ignore */ }

    this._keysDown.add(k);
    this._keysPressed.add(k);

    // Resume showcase controls: cycle repositories from the central platform.
    try {
      const a = document.activeElement;
      const typing = !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable));
      const inResume = safeTrim(this._proc?.kind).toLowerCase() === 'resume_showcase';
      // In the exported resume build, the devtools UI is hidden but still exists.
      // If any hidden <input> retains focus, it can silently disable these hotkeys.
      const allowResumeHotkeys = (!typing) || !!globalThis.__resumeShowcase;
      if (allowResumeHotkeys && inResume) {
        if (k === 'BracketLeft' || k === 'Comma') {
          e.preventDefault?.();
          if (typeof this._resumeShowcase?.cycleSelection === 'function') this._resumeShowcase.cycleSelection(-1);
          else this._cycleResumeShowcaseSelection(-1);
          return;
        }
        if (k === 'BracketRight' || k === 'Period') {
          e.preventDefault?.();
          if (typeof this._resumeShowcase?.cycleSelection === 'function') this._resumeShowcase.cycleSelection(1);
          else this._cycleResumeShowcaseSelection(1);
          return;
        }
        if (k === 'Enter' || k === 'KeyO') {
          e.preventDefault?.();
          if (typeof this._resumeShowcase?.showCurrentRepo === 'function') this._resumeShowcase.showCurrentRepo();
          else this._showCurrentResumeShowcaseRepo();
          return;
        }
      }
    } catch { /* ignore */ }

    // Vehicle interaction should happen on the key event (user gesture),
    // not only in the simulation tick. This avoids pointer-lock gating issues.
    try {
      const a = document.activeElement;
      const typing = !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable));
      const allowInteractHotkey = (!typing) || !!globalThis.__resumeShowcase;
      if (allowInteractHotkey) {
        const keyLower = String(e?.key || '').toLowerCase();
        const isInteract = (k === 'KeyE') || (keyLower === 'e') || (k === 'e') || (k === 'E');
        if (isInteract) {
          // Single interaction pipeline: scenario triggers first, vehicles second.
          const handled = this._tryInteractAtPlayer();
          if (!handled) this._vehicleSystem?.tryEnterVehicle?.();
          try { e.preventDefault?.(); } catch { /* ignore */ }
          return;
        }
        if (k === 'KeyF') {
          this._vehicleSystem?.tryExitVehicle?.();
        }
      }
    } catch { /* ignore */ }

    // Weapon switching (FPS demo)
    // Resume export: keep showcase focused; shooting/gameplay isn't enabled there.
    if (!globalThis.__resumeShowcase) {
      if (k === 'Digit1') this._setWeapon('rifle');
      if (k === 'Digit2') this._setWeapon('sniper');
    }

    // Vehicle camera toggle (when seated)
    if (k === 'KeyV') {
      if (this._vehicleSystem?.inVehicle?.()) {
        this._vehicleSystem?.toggleVehicleCamera?.();
      } else {
        this._playerCamMode = (this._playerCamMode === 'third') ? 'first' : 'third';
        // Clear any lingering lean roll/offset when switching modes.
        try { this._clearPlayerLean(); } catch { /* ignore */ }
        this._showMsg(this._playerCamMode === 'third' ? 'Cam: third-person' : 'Cam: first-person', 0.8);
      }
    }

    // Quick convenience: when in FPS mode but not locked, Space should try to lock.
    if (k === 'Space' && this._state.mode === 'fps' && !this._plock?.isLocked) {
      this._tryPointerLock('space_key');
    }
  },

  _onKeyUp(e) {
    if (!e) return;
    const k = String(e.code || e.key || '');
    if (!k) return;
    this._keysDown.delete(k);
  },

  _getPointerLockDoc() {
    return this._canvas?.ownerDocument || document;
  },

  _canAttemptPointerLock() {
    if (!this._plock) return false;
    const doc = this._getPointerLockDoc();
    const target = this._pointerLockTarget || this._canvas;
    if (!doc || !target) return false;
    if (!target.isConnected) return false;
    if (doc.visibilityState && doc.visibilityState !== 'visible') return false;
    if (typeof doc.hasFocus === 'function' && !doc.hasFocus()) return false;
    return true;
  },

  _tryPointerLock(reason = '') {
    if (this._plock?.isLocked) return true;
    if (!this._canAttemptPointerLock()) return false;
    const why = String(reason || '');
    // Browsers require a trusted user gesture for Pointer Lock requests.
    // Auto-play scene loading paths are not gesture-triggered and will reject.
    if (why.startsWith('auto_play_')) return false;
    try { this._pointerLockTarget?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
    try {
      const maybePromise = this._plock?.lock?.();
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(() => {
          if (why) {
            try { this._ctx?.log?.(`Scene: pointer lock rejected (${why})`); } catch { /* ignore */ }
          }
        });
      }
      return true;
    } catch {
      if (why) {
        try { this._ctx?.log?.(`Scene: pointer lock failed (${why})`); } catch { /* ignore */ }
      }
      return false;
    }
  },

  _applyPlayerCameraBasePose(camMode) {
    if (!this._camera) return;
    const mode = (camMode === 'third') ? 'third' : 'first';
    if (mode === 'third') {
      // Mouse-controllable chase cam (same idea as vehicle chase cam):
      // Don't call lookAt() (it would overwrite pointer-lock mouse rotation).
      // Place the camera behind the player along the current view ray.
      try { this._camera.rotation.order = 'YXZ'; } catch { /* ignore */ }
      try { this._camera.rotation.x = clamp(this._camera.rotation.x, -1.15, 0.55); } catch { /* ignore */ }

      const target = this._tmpChaseTarget.set(this._player.x, this._player.y + this._player.eyeH, this._player.z);
      const fwd = this._tmpChaseFwd.set(0, 0, 0);
      // Use yaw-only forward for the chase offset so pitch doesn't "orbit" the camera weirdly.
      try { this._camera.getWorldDirection(fwd); } catch { /* ignore */ }
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, -1);
      fwd.normalize();

      const camDist = Math.max(1.0, Number(this._playerChaseCam?.dist) || 6.5);
      const camLift = Math.max(0.0, Number(this._playerChaseCam?.lift) || 1.15);

      // Basic camera collision: if the segment from player->camera is blocked, pull camera in.
      let distOk = camDist;
      try {
        const testBlocked = (d) => this._segmentBlocked(
          target.x, target.y, target.z,
          target.x - fwd.x * d, target.y - fwd.y * d + camLift, target.z - fwd.z * d,
        );
        if (testBlocked(camDist)) {
          let lo = 0.3;
          let hi = camDist;
          for (let i = 0; i < 8; i++) {
            const mid = (lo + hi) * 0.5;
            if (testBlocked(mid)) hi = mid;
            else lo = mid;
          }
          distOk = lo;
        }
      } catch { /* ignore */ }

      const pos = this._tmpChasePos.copy(target).addScaledVector(fwd, -distOk);
      pos.y += camLift;
      // Keep camera above ground a bit (prevents hard ground clipping when looking down).
      try {
        const gy = this._findGroundY(pos.x, pos.y, pos.z);
        if (gy != null) pos.y = Math.max(pos.y, Number(gy) + 0.25);
      } catch { /* ignore */ }
      this._camera.position.copy(pos);

      // Update player visual in third-person.
      try {
        const pv = this._playerViz?.group;
        if (pv) {
          // Keep proxy updated for muzzle/world-space helpers, even if we hide it in favor of a skinned avatar.
          const inVehicle = !!this._vehicleSystem?.inVehicle?.();
          const hasAvatar = !!(this._avatar?.enabled && this._avatar3p?.root);
          pv.visible = !inVehicle && !hasAvatar;
          pv.position.set(this._player.x, this._player.y, this._player.z);
          // Face the camera forward direction (mesh forward is -Z).
          const yaw = Math.atan2(-fwd.x, -fwd.z);
          this._player.yawRad = yaw;
          pv.rotation.set(0, yaw, 0);
        }
      } catch { /* ignore */ }
    } else {
      // First-person: camera at eye.
      this._camera.position.set(this._player.x, this._player.y + this._player.eyeH, this._player.z);
      try { if (this._playerViz?.group) this._playerViz.group.visible = false; } catch { /* ignore */ }
    }
  },

  _clearPlayerLean() {
    // Remove any previously applied lean (roll + sideways offset) so the camera doesn't stay tilted/off-center.
    if (!this._camera || !this._player) return;
    try {
      const leanNow = clamp(Number(this._player.leanT) || 0, -1, 1);

      // 1) Unapply roll via stored quaternion.
      const prevLeanQ = this._player?.leanQ;
      if (prevLeanQ && prevLeanQ.isQuaternion) {
        this._tmpQ1.copy(prevLeanQ).invert();
        this._camera.quaternion.premultiply(this._tmpQ1);
      }

      // 2) Unapply positional offset (approx; ignores collision-limited frac but fixes the common "stuck off-center" case).
      if (Math.abs(leanNow) > 1e-4) {
        const fwd = this._tmpV3.set(0, 0, 0);
        try { this._camera.getWorldDirection(fwd); } catch { /* ignore */ }
        const fwdYaw = this._tmpV3c.copy(fwd);
        fwdYaw.y = 0;
        if (fwdYaw.lengthSq() > 1e-8) fwdYaw.normalize();
        const right = this._tmpV3b.crossVectors(fwdYaw, this._upV3);
        if (right.lengthSq() > 1e-8) right.normalize();

        const camMode = (this._playerCamMode === 'third') ? 'third' : 'first';
        const third = (camMode === 'third');
        const sideMag = third ? 0.85 : 0.34;
        const downMag = third ? 0.06 : 0.04;
        const side = sideMag * leanNow;
        const down = downMag * Math.abs(leanNow);
        this._camera.position.x -= right.x * side;
        this._camera.position.z -= right.z * side;
        this._camera.position.y += down;
      }

      // 3) Reset stored lean state.
      try { this._player.leanT = 0; } catch { /* ignore */ }
      try { this._player.leanQ.identity(); } catch { /* ignore */ }
      // Force level roll (PointerLockControls is yaw/pitch only; roll should never persist).
      try { this._camera.rotation.order = 'YXZ'; } catch { /* ignore */ }
      try { this._camera.rotation.z = 0; } catch { /* ignore */ }
    } catch { /* ignore */ }
  },

  _tickPlayer(dt) {
    if (!this._camera) return;
    if (this._state.mode !== 'fps') return;
    // When not pointer-locked (e.g. initial load before user gesture), we still want the
    // camera to reflect the current spawn/player pose. Otherwise it can look "off" until
    // the first movement/mouse-look tick happens.
    if (!this._plock?.isLocked) {
      try { this._applyPlayerCameraBasePose(this._playerCamMode); } catch { /* ignore */ }
      // Resume export: still allow WASD movement even if pointer-lock is blocked/denied.
      if (!globalThis.__resumeShowcase) return;
    }
    // When in a vehicle, player locomotion is disabled (camera is driven by vehicle tick).
    if (this._vehicleSystem?.inVehicle?.()) return;

    const xBefore = Number(this._player.x) || 0;
    const zBefore = Number(this._player.z) || 0;

    // Crouch + lean (model-free, camera-only for lean).
    const crouchHeld = this._keysDown.has('ControlLeft') || this._keysDown.has('ControlRight');
    const crouchA = 1.0 - Math.exp(-12.0 * Math.max(0, Number(dt) || 0));
    this._player.crouchT = lerp(Number(this._player.crouchT) || 0, crouchHeld ? 1 : 0, crouchA);
    const standEyeH = Math.max(0.8, Number(this._player.standEyeH) || 1.7);
    const crouchEyeH = Math.max(0.6, Math.min(standEyeH, Number(this._player.crouchEyeH) || 1.12));
    this._player.eyeH = lerp(standEyeH, crouchEyeH, clamp01(this._player.crouchT));

    // Lean keys are Q/E, but E is also "interact". Keep it behind a toggle to avoid accidental camera roll/offset.
    const leanEnabled = !!this._state.enableLean;
    let wantLean = 0;
    if (leanEnabled) {
      const eDown = this._keysDown.has('KeyE');
      const ePressed = this._keysPressed.has('KeyE');
      const nearVehicleDoor = !this._vehicleSystem?.inVehicle?.() && !this._triggerInteractHintActive && !!this._vehicleSystem?.nearestVehicleDoor?.(1.6);
      const canLeanE = eDown && !ePressed && !this._triggerInteractHintActive && !nearVehicleDoor;
      wantLean = (canLeanE ? 1 : 0) + (this._keysDown.has('KeyQ') ? -1 : 0);
    }
    const leanA = 1.0 - Math.exp(-16.0 * Math.max(0, Number(dt) || 0));
    this._player.leanT = lerp(Number(this._player.leanT) || 0, clamp(Number(wantLean) || 0, -1, 1), leanA);

    const fly = !!this._state.fly;
    const sprintHeld = this._keysDown.has('ShiftLeft') || this._keysDown.has('ShiftRight');
    const crouched = (Number(this._player.crouchT) || 0) > 0.55;
    const baseSpeed = sprintHeld && !crouched ? this._state.sprint : this._state.speed;
    const speed = (crouched ? (Number(baseSpeed) * 0.55) : Number(baseSpeed)) || 0;
    const mv = new THREE.Vector3(0, 0, 0);

    let forward = (this._keysDown.has('KeyW') || this._keysDown.has('ArrowUp')) ? 1 : 0;
    let back = (this._keysDown.has('KeyS') || this._keysDown.has('ArrowDown')) ? 1 : 0;
    let left = (this._keysDown.has('KeyA') || this._keysDown.has('ArrowLeft')) ? 1 : 0;
    let right = (this._keysDown.has('KeyD') || this._keysDown.has('ArrowRight')) ? 1 : 0;

    // Resume export: allow tilt-to-move as a virtual input source.
    try {
      const st = this._resumeMobile;
      if (globalThis.__resumeShowcase && !globalThis.__resumeDisableTilt && st?.enabled && st?.tilt?.listening) {
        const vf = Number(st.tilt.moveF) || 0;
        const vs = Number(st.tilt.moveS) || 0;
        if (vf > 0.25) forward = 1;
        else if (vf < -0.25) back = 1;
        if (vs > 0.25) right = 1;
        else if (vs < -0.25) left = 1;
      }
    } catch { /* ignore */ }

    const dir = new THREE.Vector3();
    this._camera.getWorldDirection(dir);
    dir.y = 0;
    if (dir.lengthSq() > 1e-8) dir.normalize();
    const strafe = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();

    const f = forward - back;
    const s = right - left;
    if (f) mv.addScaledVector(dir, f);
    if (s) mv.addScaledVector(strafe, s);

    if (mv.lengthSq() > 1e-8) mv.normalize().multiplyScalar(Math.max(0, speed) * dt);

    // Apply simple wall collision against known obstacle boxes (procedural scenes).
    // Use small sub-steps to reduce "corner trapping" / snapping in doorways.
    const dist = Math.sqrt(mv.x * mv.x + mv.z * mv.z);
    const stepMax = 0.35;
    const steps = Math.max(1, Math.min(10, Math.ceil(dist / stepMax)));
    const sx = mv.x / steps;
    const sz = mv.z / steps;
    for (let i = 0; i < steps; i++) {
      const x0 = this._player.x;
      const z0 = this._player.z;
      const tryX = x0 + sx;
      const tryZ = z0 + sz;
      if (!this._collidesAt(tryX, this._player.y, z0)) this._player.x = tryX;
      if (!this._collidesAt(this._player.x, this._player.y, tryZ)) this._player.z = tryZ;
    }

    if (fly) {
      const up = this._keysDown.has('Space') ? 1 : 0;
      const down = (this._keysDown.has('ShiftLeft') || this._keysDown.has('ShiftRight')) ? 1 : 0;
      const vy = (up - down) * Math.max(0, speed) * dt;
      this._player.y += vy;
      this._player.vy = 0;
      this._player.onGround = false;
    } else {
      // Jump
      if (this._keysDown.has('Space') && this._player.onGround) {
        this._player.vy = Math.max(0.1, Number(this._state.jumpV) || 7.5);
        this._player.onGround = false;
      }

      // Gravity
      const g = Math.max(0, Number(this._state.gravity) || 25);
      this._player.vy -= g * dt;
      this._player.y += this._player.vy * dt;

      // Ground snap
      const groundY = this._findGroundY(this._player.x, this._player.y, this._player.z);
      if (groundY != null) {
        const feet = this._player.y;
        if (feet < groundY) {
          this._player.y = groundY;
          this._player.vy = 0;
          this._player.onGround = true;
        } else {
          // Consider "on ground" if very close.
          this._player.onGround = Math.abs(feet - groundY) < 0.06 && this._player.vy <= 0;
        }
      } else {
        this._player.onGround = false;
      }
    }

    // Unapply previous lean so it doesn't accumulate into a full spin.
    // (Pointer-lock updates yaw/pitch into the camera; we treat lean as an extra world rotation.)
    try {
      const prevLeanQ = this._player?.leanQ;
      if (prevLeanQ && prevLeanQ.isQuaternion) {
        this._tmpQ1.copy(prevLeanQ).invert();
        this._camera.quaternion.premultiply(this._tmpQ1);
      }
      try { this._player.leanQ.identity(); } catch { /* ignore */ }
      // Hard clamp: roll should never persist outside active lean.
      try { this._camera.rotation.order = 'YXZ'; } catch { /* ignore */ }
      try { this._camera.rotation.z = 0; } catch { /* ignore */ }
    } catch { /* ignore */ }

    const camMode = (this._playerCamMode === 'third') ? 'third' : 'first';
    if (camMode === 'third') {
      // Mouse-controllable chase cam (same idea as vehicle chase cam):
      // Don't call lookAt() (it would overwrite pointer-lock mouse rotation).
      // Place the camera behind the player along the current view ray.
      try { this._camera.rotation.order = 'YXZ'; } catch { /* ignore */ }
      try { this._camera.rotation.x = clamp(this._camera.rotation.x, -1.15, 0.55); } catch { /* ignore */ }

      const target = this._tmpChaseTarget.set(this._player.x, this._player.y + this._player.eyeH, this._player.z);
      const fwd = this._tmpChaseFwd.set(0, 0, 0);
      // Use yaw-only forward for the chase offset so pitch doesn't "orbit" the camera weirdly.
      try { this._camera.getWorldDirection(fwd); } catch { /* ignore */ }
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, -1);
      fwd.normalize();

      const camDist = Math.max(1.0, Number(this._playerChaseCam?.dist) || 6.5);
      const camLift = Math.max(0.0, Number(this._playerChaseCam?.lift) || 1.15);

      // Basic camera collision: if the segment from player->camera is blocked, pull camera in.
      let distOk = camDist;
      try {
        const testBlocked = (d) => this._segmentBlocked(
          target.x, target.y, target.z,
          target.x - fwd.x * d, target.y - fwd.y * d + camLift, target.z - fwd.z * d,
        );
        if (testBlocked(camDist)) {
          let lo = 0.3;
          let hi = camDist;
          for (let i = 0; i < 8; i++) {
            const mid = (lo + hi) * 0.5;
            if (testBlocked(mid)) hi = mid;
            else lo = mid;
          }
          distOk = lo;
        }
      } catch { /* ignore */ }

      const pos = this._tmpChasePos.copy(target).addScaledVector(fwd, -distOk);
      pos.y += camLift;
      // Keep camera above ground a bit (prevents hard ground clipping when looking down).
      try {
        const gy = this._findGroundY(pos.x, pos.y, pos.z);
        if (gy != null) pos.y = Math.max(pos.y, Number(gy) + 0.25);
      } catch { /* ignore */ }
      this._camera.position.copy(pos);

      // Update player visual in third-person.
      try {
        const pv = this._playerViz?.group;
        if (pv) {
          // Keep proxy updated for muzzle/world-space helpers, even if we hide it in favor of a skinned avatar.
          const inVehicle = !!this._vehicleSystem?.inVehicle?.();
          const hasAvatar = !!(this._avatar?.enabled && this._avatar3p?.root);
          pv.visible = !inVehicle && !hasAvatar;
          pv.position.set(this._player.x, this._player.y, this._player.z);
          // Face the camera forward direction (mesh forward is -Z).
          const yaw = Math.atan2(-fwd.x, -fwd.z);
          this._player.yawRad = yaw;
          pv.rotation.set(0, yaw, 0);
        }
      } catch { /* ignore */ }
    } else {
      // First-person: camera at eye.
      this._camera.position.set(this._player.x, this._player.y + this._player.eyeH, this._player.z);
      try { if (this._playerViz?.group) this._playerViz.group.visible = false; } catch { /* ignore */ }
    }

    // Apply lean to camera (side offset + roll) in BOTH first and third person.
    // NOTE: The "right" vector must be computed as (forward × up) (not up × forward),
    // otherwise Q/E lean feels inverted.
    try {
      const lean = clamp(Number(this._player.leanT) || 0, -1, 1);
      if (Math.abs(lean) > 1e-4) {
        const baseX = Number(this._camera.position.x) || 0;
        const baseY = Number(this._camera.position.y) || 0;
        const baseZ = Number(this._camera.position.z) || 0;

        // Forward axis for roll should include pitch.
        const fwdRoll = this._tmpV3.set(0, 0, 0);
        this._camera.getWorldDirection(fwdRoll);
        if (fwdRoll.lengthSq() > 1e-8) fwdRoll.normalize();

        // For sideways lean offset, use yaw-only forward.
        const fwdYaw = this._tmpV3c.copy(fwdRoll);
        fwdYaw.y = 0;
        if (fwdYaw.lengthSq() > 1e-8) fwdYaw.normalize();

        // Right-handed basis: right = forward × up.
        const right = this._tmpV3b.crossVectors(fwdYaw, this._upV3).normalize();

        const third = (camMode === 'third');
        const sideMag = third ? 0.85 : 0.34;
        const downMag = third ? 0.06 : 0.04;
        const side = sideMag * lean;
        const down = downMag * Math.abs(lean);
        const yFeet = Number(this._player?.y) || 0;

        // Instead of snapping lean on/off when colliding, find the max safe lean fraction.
        let frac = 1.0;
        const testPos = (k) => {
          const x = baseX + right.x * side * k;
          const z = baseZ + right.z * side * k;
          const y = baseY - down * k;
          return { x, y, z };
        };

        // Quick reject at full lean.
        const pFull = testPos(1.0);
        if (this._collidesAtRadius(pFull.x, yFeet, pFull.z, 0.08)) {
          let lo = 0.0;
          let hi = 1.0;
          for (let i = 0; i < 7; i++) {
            const mid = (lo + hi) * 0.5;
            const p = testPos(mid);
            if (this._collidesAtRadius(p.x, yFeet, p.z, 0.08)) hi = mid;
            else lo = mid;
          }
          frac = lo;
        }

        const p = testPos(frac);
        this._camera.position.set(p.x, p.y, p.z);

        // Apply roll via quaternion (avoids Euler gimbal / upside-down flips).
        const roll = -lean * 0.11 * frac;
        if (Math.abs(roll) > 1e-6) {
          const q = this._tmpQ1.setFromAxisAngle(fwdRoll, roll);
          this._camera.quaternion.premultiply(q);
          try { this._player.leanQ.copy(q); } catch { /* ignore */ }
        } else {
          try { this._player.leanQ.identity(); } catch { /* ignore */ }
        }
      } else {
        // No lean: keep stored leanQ as identity (already cleared above), but be explicit.
        try { this._player.leanQ.identity(); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    // Store planar movement for contact damage / collision responses.
    const xAfter = Number(this._player.x) || 0;
    const zAfter = Number(this._player.z) || 0;
    const dx = xAfter - xBefore;
    const dz = zAfter - zBefore;
    const d = Math.hypot(dx, dz);
    const invDt = (Number(dt) > 1e-6) ? (1.0 / Number(dt)) : 0;
    this._player.moveDx = dx;
    this._player.moveDz = dz;
    this._player.moveSpeedXZ = d * invDt;
  },

  _collidesAt(x, yFeet, z) {
    return collidesCircleAgainstBoxes({
      x,
      z,
      yFeet,
      radius: Math.max(0.05, Number(this._player?.radius) || 0.35),
      height: Math.max(0.5, Number(this._player?.eyeH) || 1.7),
      staticBoxes: this._obstacleBoxes,
      dynamicBoxes: this._vehicleSystem?.getVehicleBoxes?.() || [],
    });
  },

  _findGroundY(x, y, z) {
    if (!this._colliders || !this._colliders.length) return 0; // fallback plane at y=0
    const yy = Number(y) || 0;

    // NOTE: This is intentionally cast from *near the player's feet* first.
    // Many imported scenes include roof/ceiling meshes in the collider list; if we cast from above the roof,
    // the first hit can be the roof, and our "below ground" correction will snap the player onto it.
    const castDown = (originY, far = 30) => {
      const origin = new THREE.Vector3(Number(x) || 0, Number(originY) || 0, Number(z) || 0);
      this._ray.set(origin, new THREE.Vector3(0, -1, 0));
      this._ray.far = Math.max(1, Number(far) || 30);
      // We store either [worldRoot] or a small list of roots; recursive raycast.
      const roots = Array.isArray(this._groundRaycastRoots) && this._groundRaycastRoots.length
        ? this._groundRaycastRoots
        : this._colliders;
      const hits = this._ray.intersectObjects(roots, true);
      if (!hits || !hits.length) return null;

      // Prefer "walkable-ish" faces (ignore near-vertical hits).
      for (const h of hits) {
        const py = Number(h?.point?.y);
        if (!Number.isFinite(py)) continue;
        const ny = Number(h?.face?.normal?.y);
        if (Number.isFinite(ny) && ny < 0.12) continue;
        return py;
      }

      const py0 = Number(hits[0]?.point?.y);
      return Number.isFinite(py0) ? py0 : null;
    };

    // 1) Normal case: find ground under feet (avoids snapping to roofs).
    const g0 = castDown(yy + 0.6);
    if (g0 != null) return g0;

    // 2) Recovery case: if the player is embedded slightly, cast from higher.
    const g1 = castDown(yy + 2.5);
    if (g1 != null) return g1;

    // 3) Long-range recovery: handle large imported scenes where the player's Y can start far below
    // the world (common with AC tracks before a spawn snap runs).
    return castDown(Math.max(250, yy + 20), 3500);
  },

  _startReload() {
    const g = this._game;
    if (!g?.enabled) return;
    const w = this._weapon();
    if (w.reloadT > 0) return;
    if (w.ammoInMag >= w.magSize) return;
    if (w.reserve <= 0) { this._showMsg('No reserve ammo', 0.8); return; }
    w.reloadT = Math.max(0.1, Number(w.reloadSec) || 1.2);
    this._showMsg('Reloading…', 0.8);
  },

  _tryFireWeapon() {
    const g = this._game;
    if (!g?.enabled) return false;
    if (this._state?.mode !== 'fps') return false;
    if (this._vehicleCtx?.inVehicle) return false;
    const w = this._weapon();
    if (w.reloadT > 0) return false;
    if (w.fireCooldown > 1e-6) return false;
    if (w.ammoInMag <= 0) {
      this._startReload();
      return false;
    }
    if (!this._camera) return false;

    w.ammoInMag -= 1;
    w.fireCooldown = 1.0 / Math.max(1e-3, Number(w.fireRate) || 10.0);
    this._gun.recoilKick = 1.0;

    // Hitscan ray from camera with small spread.
    const origin = this._camera.position.clone();
    const dir = new THREE.Vector3();
    this._camera.getWorldDirection(dir);
    const spr = Math.max(0, Number(w.spreadRad) || 0);
    if (spr > 1e-6) {
      // Random disk offset in camera space
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * spr;
      const sx = Math.cos(a) * r;
      const sy = Math.sin(a) * r;
      // Build camera right/up
      const up = new THREE.Vector3(0, 1, 0);
      const right = new THREE.Vector3().crossVectors(dir, up).normalize();
      const camUp = new THREE.Vector3().crossVectors(right, dir).normalize();
      dir.addScaledVector(right, sx).addScaledVector(camUp, sy).normalize();
    }

    // Configure raycaster once, then intersect enemies + world.
    this._ray.set(origin, dir);
    this._ray.far = Math.max(1, Number(w.range) || 120);

    let best = null;
    let bestDist = Infinity;
    for (const en of this._enemies) {
      if (!en || en.dead) continue;
      const hits = this._ray.intersectObjects(en.hitMeshes || [], true);
      if (!hits || !hits.length) continue;
      const h = hits[0];
      if (h && Number.isFinite(h.distance) && h.distance < bestDist) {
        bestDist = h.distance;
        best = { enemy: en, hit: h };
      }
    }

    // World hit (procedural meshes / imported GLB colliders)
    let worldHit = null;
    let worldDist = Infinity;
    try {
      const hits = this._ray.intersectObjects(this._colliders || [], true);
      if (hits && hits.length) {
        worldHit = hits[0] || null;
        worldDist = Number(worldHit?.distance);
      }
    } catch { /* ignore */ }

    const enemyWins = best && Number.isFinite(bestDist) && (!Number.isFinite(worldDist) || bestDist <= worldDist);
    const hitPoint = enemyWins
      ? (best.hit?.point ? best.hit.point.clone() : origin.clone().addScaledVector(dir, bestDist))
      : (worldHit?.point ? worldHit.point.clone() : origin.clone().addScaledVector(dir, this._ray.far));

    // Visual bullets/tracer from muzzle to hitPoint.
    const onFootThird = !this._vehicleSystem?.inVehicle?.() && this._playerCamMode === 'third';
    const muzzle = (onFootThird ? this._getPlayerMuzzleWorldPos() : this._getMuzzleWorldPos()) || origin;
    this._spawnTracer(muzzle, hitPoint, 0x9ad0ff, 0.06);
    this._spawnBullet(muzzle, hitPoint, 0x9ad0ff);
    this._spawnMuzzleFlash(muzzle, 0x9ad0ff);

    if (best) {
      if (enemyWins) {
        const head = (best.enemy?.headMesh && best.hit?.object === best.enemy.headMesh) || (String(best.hit?.object?.name || '').includes('head'));
        const mul = head ? Math.max(1.0, Number(w.headshotMul) || 2.0) : 1.0;
        this._damageEnemy(best.enemy, (Number(w.damage) || 20) * mul);
        if (head) this._showMsg('Headshot!', 0.4);
      }
      g.hitT = 0.12;
    }

    // Dry fire feedback
    if (w.ammoInMag === 0 && w.reserve > 0) {
      this._startReload();
    }
    return true;
  },

  _weapon() {
    const g = this._game;
    const id = safeTrim(g?.activeWeapon) || 'rifle';
    const w = g?.weapons?.[id] || g?.weapons?.rifle || null;
    return w;
  },

  _setWeapon(id) {
    const g = this._game;
    // Resume export: weapon switching is not part of the showcase experience.
    if (globalThis.__resumeShowcase) return;
    // If gameplay isn't enabled, don't spawn a gun rig (prevents "equip but can't shoot").
    if (!g?.enabled) return;
    const wid = (String(id || '').toLowerCase() === 'sniper') ? 'sniper' : 'rifle';
    if (!g?.weapons?.[wid]) return;
    if (g.activeWeapon === wid) return;
    g.activeWeapon = wid;
    this._aimDown = false;
    this._clearGun();
    this._ensureGunRig();
    this._showMsg(`Weapon: ${g.weapons[wid].name}`, 0.6);
  },

  _clearFx() {
    try {
      for (const b of (this._fx?.bullets || [])) {
        try { b.mesh?.parentNode; } catch { /* ignore */ }
        try { b.mesh?.parent?.remove?.(b.mesh); } catch { /* ignore */ }
        try { disposeThreeObject(b.mesh); } catch { /* ignore */ }
      }
      for (const t of (this._fx?.tracers || [])) {
        try { t.line?.parent?.remove?.(t.line); } catch { /* ignore */ }
        try { disposeThreeObject(t.line); } catch { /* ignore */ }
      }
      for (const f of (this._fx?.flashes || [])) {
        try { f.mesh?.parent?.remove?.(f.mesh); } catch { /* ignore */ }
        try { disposeThreeObject(f.mesh); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    this._fx = { bullets: [], tracers: [], flashes: [] };
  },

  _spawnBullet(from, to, color = 0x9ad0ff) {
    if (!this._game?.viz?.showPlayerShots && color === 0x9ad0ff) return;
    if (!this._game?.viz?.showEnemyShots && color === 0xff9b7a) return;
    if (!this._scene) return;
    const p0 = from?.clone ? from.clone() : new THREE.Vector3();
    const p1 = to?.clone ? to.clone() : new THREE.Vector3();
    const dir = new THREE.Vector3().subVectors(p1, p0);
    const dist = Math.max(0.001, dir.length());
    dir.normalize();
    const speed = Math.max(10, Number(this._game?.weapon?.bulletSpeed) || 70);
    const ttl = Math.min(1.2, dist / speed + 0.12);
    const geo = new THREE.SphereGeometry(0.045, 8, 6);
    const mat = new THREE.MeshStandardMaterial({ color: Number(color) || 0xffffff, emissive: Number(color) || 0xffffff, emissiveIntensity: 0.55, roughness: 0.4, metalness: 0.0 });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(p0);
    this._scene.add(m);
    this._fx.bullets.push({ mesh: m, v: dir.multiplyScalar(speed), ttl, hitPoint: p1 });
  },

  _spawnTracer(from, to, color = 0x9ad0ff, width = 0.05) {
    if (!this._game?.viz?.showPlayerShots && color === 0x9ad0ff) return;
    if (!this._game?.viz?.showEnemyShots && color === 0xff9b7a) return;
    if (!this._scene) return;
    const p0 = from?.clone ? from.clone() : new THREE.Vector3();
    const p1 = to?.clone ? to.clone() : new THREE.Vector3();
    const geo = new THREE.BufferGeometry().setFromPoints([p0, p1]);
    const mat = new THREE.LineBasicMaterial({ color: Number(color) || 0xffffff, transparent: true, opacity: 0.85 });
    const line = new THREE.Line(geo, mat);
    this._scene.add(line);
    this._fx.tracers.push({ line, ttl: 0.07 });
  },

  _spawnMuzzleFlash(pos, color = 0x9ad0ff) {
    if (!this._game?.viz?.showPlayerShots && color === 0x9ad0ff) return;
    if (!this._game?.viz?.showEnemyShots && color === 0xff9b7a) return;
    if (!this._scene) return;
    const p = pos?.clone ? pos.clone() : new THREE.Vector3();
    const geo = new THREE.SphereGeometry(0.12, 10, 8);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: Number(color) || 0xffffff, emissiveIntensity: 1.2, roughness: 0.2, metalness: 0.0, transparent: true, opacity: 0.85 });
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(p);
    this._scene.add(m);
    this._fx.flashes.push({ mesh: m, ttl: 0.06 });
  },

  _tickFx(dt) {
    if (!this._scene || !this._fx) return;
    // bullets
    for (let i = this._fx.bullets.length - 1; i >= 0; i--) {
      const b = this._fx.bullets[i];
      if (!b?.mesh) { this._fx.bullets.splice(i, 1); continue; }
      b.ttl = (Number(b.ttl) || 0) - dt;
      if (b.ttl <= 0) {
        try { this._scene.remove(b.mesh); } catch { /* ignore */ }
        try { disposeThreeObject(b.mesh); } catch { /* ignore */ }
        this._fx.bullets.splice(i, 1);
        continue;
      }
      try {
        b.mesh.position.addScaledVector(b.v, dt);
        // If we reached (or passed) target point, kill early.
        if (b.hitPoint) {
          const d = b.mesh.position.distanceTo(b.hitPoint);
          if (d < 0.20) {
            b.ttl = 0;
          }
        }
      } catch { /* ignore */ }
    }
    // tracers fade
    for (let i = this._fx.tracers.length - 1; i >= 0; i--) {
      const t = this._fx.tracers[i];
      t.ttl = (Number(t.ttl) || 0) - dt;
      const a = Math.max(0, Math.min(1, (t.ttl / 0.07)));
      try { if (t.line?.material) t.line.material.opacity = a * 0.85; } catch { /* ignore */ }
      if (t.ttl <= 0) {
        try { this._scene.remove(t.line); } catch { /* ignore */ }
        try { disposeThreeObject(t.line); } catch { /* ignore */ }
        this._fx.tracers.splice(i, 1);
      }
    }
    // flashes
    for (let i = this._fx.flashes.length - 1; i >= 0; i--) {
      const f = this._fx.flashes[i];
      f.ttl = (Number(f.ttl) || 0) - dt;
      const a = Math.max(0, Math.min(1, (f.ttl / 0.06)));
      try { if (f.mesh?.material) f.mesh.material.opacity = a * 0.85; } catch { /* ignore */ }
      if (f.ttl <= 0) {
        try { this._scene.remove(f.mesh); } catch { /* ignore */ }
        try { disposeThreeObject(f.mesh); } catch { /* ignore */ }
        this._fx.flashes.splice(i, 1);
      }
    }
  },

  _clearGun() {
    try {
      if (this._gun?.group?.parent) this._gun.group.parent.remove(this._gun.group);
      disposeThreeObject(this._gun?.group);
    } catch { /* ignore */ }
    this._gun = { group: null, muzzle: null, recoil: 0, recoilKick: 0, sway: 0 };
  },

  _ensureGunRig() {
    if (!this._camera || !this._scene) return;
    if (this._game?.viz && !this._game.viz.showGun) return;
    const kind = safeTrim(this._weapon()?.id) || 'rifle';
    if (this._gun?.group && this._gun?.kind === kind) return;
    if (this._gun?.group && this._gun?.kind !== kind) this._clearGun();

    const g = new THREE.Group();
    g.name = `fp_gun_${kind}`;
    g.position.set(0.38, -0.32, -0.72);
    g.rotation.set(0.03, -0.05, 0.02);

    const dark = new THREE.MeshStandardMaterial({ color: 0x1b2433, roughness: 0.7, metalness: 0.0 });
    const mid = new THREE.MeshStandardMaterial({ color: 0x3d506b, roughness: 0.65, metalness: 0.0 });
    const accent = new THREE.MeshStandardMaterial({ color: 0x7eb3ff, roughness: 0.5, metalness: 0.0, emissive: 0x173050 });

    if (kind === 'sniper') {
      // Sniper base
      const recv = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.12, 0.46), mid);
      recv.position.set(0.02, -0.02, 0.08);
      g.add(recv);
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.020, 0.020, 0.78, 10, 1), dark);
      bar.rotation.x = Math.PI * 0.5;
      bar.position.set(0.02, -0.02, -0.32);
      g.add(bar);
      const tip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.08), accent);
      tip.position.set(0.02, -0.02, -0.72);
      g.add(tip);
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 0.26), dark);
      stock.position.set(-0.12, -0.02, 0.34);
      g.add(stock);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.08), dark);
      grip.position.set(-0.05, -0.12, 0.10);
      grip.rotation.x = -0.25;
      g.add(grip);
      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.10), mid);
      mag.position.set(0.04, -0.14, 0.08);
      mag.rotation.x = 0.08;
      g.add(mag);
      // Scope
      const scopeTube = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.34, 12, 1), dark);
      scopeTube.rotation.x = Math.PI * 0.5;
      scopeTube.position.set(0.02, 0.07, -0.02);
      g.add(scopeTube);
      const scopeEye = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.08, 12, 1), mid);
      scopeEye.rotation.x = Math.PI * 0.5;
      scopeEye.position.set(0.02, 0.07, 0.16);
      g.add(scopeEye);
      const scopeFront = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.08, 12, 1), mid);
      scopeFront.rotation.x = Math.PI * 0.5;
      scopeFront.position.set(0.02, 0.07, -0.20);
      g.add(scopeFront);
    } else {
      // Rifle
      const recv = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.12, 0.38), mid);
      recv.position.set(0.02, -0.02, 0.06);
      g.add(recv);
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.48, 10, 1), dark);
      bar.rotation.x = Math.PI * 0.5;
      bar.position.set(0.02, -0.02, -0.20);
      g.add(bar);
      const tip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.06), accent);
      tip.position.set(0.02, -0.02, -0.46);
      g.add(tip);
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.12, 0.22), dark);
      stock.position.set(-0.11, -0.02, 0.26);
      g.add(stock);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.08), dark);
      grip.position.set(-0.05, -0.12, 0.08);
      grip.rotation.x = -0.25;
      g.add(grip);
      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.09), mid);
      mag.position.set(0.03, -0.15, 0.05);
      mag.rotation.x = 0.12;
      g.add(mag);
    }

    // Muzzle helper (in gun local space)
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0.02, -0.02, (kind === 'sniper') ? -0.80 : -0.52);
    g.add(muzzle);

    this._camera.add(g);
    this._gun = { kind, group: g, muzzle, recoil: 0, recoilKick: 0, sway: 0 };
  },

  _getMuzzleWorldPos() {
    try {
      if (!this._gun?.muzzle) return null;
      const p = new THREE.Vector3();
      this._gun.muzzle.getWorldPosition(p);
      return p;
    } catch {
      return null;
    }
  },

  _getPlayerMuzzleWorldPos() {
    try {
      const m = this._playerViz?.muzzle;
      if (!m) return null;
      const p = new THREE.Vector3();
      m.getWorldPosition(p);
      return p;
    } catch {
      return null;
    }
  },

  _tickGun(dt) {
    if (!this._game?.enabled) return;
    if (this._game?.viz && !this._game.viz.showGun) return;
    // Hide first-person gun when using a third-person camera.
    const vctx = this._vehicleSystem?.getVehicleCtx?.() || null;
    if ((vctx?.inVehicle && vctx?.camMode === 'third') || (!vctx?.inVehicle && this._playerCamMode === 'third')) {
      if (this._gun?.group) this._clearGun();
      return;
    }
    this._ensureGunRig();
    const g = this._gun?.group;
    if (!g) return;

    // Recoil decay
    this._gun.recoilKick = Math.max(0, (Number(this._gun.recoilKick) || 0) - dt * 10.0);
    this._gun.recoil = lerp(Number(this._gun.recoil) || 0, 0, 1.0 - Math.exp(-14.0 * dt));

    const kick = (Number(this._gun.recoilKick) || 0);
    // Weapon sway based on movement
    const moving = (this._keysDown.has('KeyW') || this._keysDown.has('KeyA') || this._keysDown.has('KeyS') || this._keysDown.has('KeyD'));
    this._gun.sway = lerp(Number(this._gun.sway) || 0, moving ? 1 : 0, 1.0 - Math.exp(-8.0 * dt));

    // Apply transforms (local to camera)
    const sway = (Number(this._gun.sway) || 0);
    const t = (this._game.time || 0);
    g.position.x = 0.38 + Math.sin(t * 8.0) * 0.004 * sway;
    g.position.y = -0.32 + Math.sin(t * 16.0) * 0.003 * sway;
    g.position.z = -0.72 + kick * 0.05;
    g.rotation.x = 0.03 - kick * 0.10 + Math.sin(t * 10.0) * 0.004 * sway;
    g.rotation.y = -0.05 + Math.sin(t * 7.0) * 0.004 * sway;
  },
};

