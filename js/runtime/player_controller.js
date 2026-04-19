import { vec3 } from 'gl-matrix';

export class PlayerController {
  constructor({ getHeightAtXY }) {
    this.getHeightAtXY = getHeightAtXY;
    this.enabled = false;
    this.viewMode = 'third'; // 'third' | 'first'

    // Map/data-space: x,y on ground plane; z is up.
    this.pos = { x: 0, y: 0, z: 0 };
    this.eyeHeight = 1.2;

    // Simple vertical physics + ground collision (terrain).
    // Units are meters; gravity is in m/s^2.
    this.standingOffset = 0.05; // keep feet slightly above terrain to avoid visual "sinking"
    this.gravity = 28.0;
    this._vz = 0.0;
    this._onGround = false;
    this.maxSnapDown = 0.75; // if ground drops less than this, stick to it (prevents tiny "floating")

    // Jump (simple impulse).
    this.jumpSpeed = 11.5;
    this._jumpCooldownSec = 0.0;
    this.jumpCooldownSec = 0.12;
    this.justJumped = false;
    this.justLanded = false;

    // Follow camera tuning (world-space: Y up)
    this.camDist = 10.0;
    this.camHeight = 4.5;
    this.camSide = 0.0; // over-shoulder offset (meters). 0 = centered
    this._camSideTarget = 0.0;
    this.yawRad = 0.0;
    // Spawn level by default (no initial downward tilt).
    this.pitchRad = 0.0;
    this._tmpForward = vec3.create();
    this._tmpRight = vec3.create();
    this._tmpUp = vec3.fromValues(0, 1, 0);

    // Movement feel (inertia) — closer to Third-Person-MC than instant velocity
    this._vel = { x: 0, y: 0 }; // x/z-plane velocity in "data space" (x,y)
    this.walkSpeed = 10.0;
    this.runSpeed = 18.0;
    this.accel = 42.0; // higher = snappier
    this.decel = 28.0; // higher = stops faster

    // Gameplay locomotion state (used by animation).
    this.hasMoveInput = false;
    this.moveDir = { x: 0.0, y: 0.0 }; // normalized dir in data space (x,y) derived from yaw + input
    this.running = false;

    // Camera rig smoothing + juice
    this.enableCameraSmoothing = true;
    this.cameraSmoothPos = 18.0; // higher = less lag (position)
    this.cameraSmoothTarget = 26.0; // higher = less lag (look-at)
    this.enableBobbing = true;
    this.bobPhase = 0.0;
    this.bobFreq = 1.8; // scales with speed
    this.bobAmpY = 0.06;
    this.bobAmpX = 0.03;
    this.enableDynamicFov = true;
    this.baseFov = 55.0;
    this.maxFov = 78.0;
    this.fovSpeedThreshold = 18.0; // reach maxFov around run speed
    this.fovSmooth = 10.0;

    this._smoothedCamPos = vec3.clone(vec3.fromValues(0, 40, 70));
    this._smoothedCamTarget = vec3.clone(vec3.fromValues(0, 0, 0));
    this._smoothedFov = this.baseFov;
    this._cameraRigInitialized = false;

    // Indoor collision (optional): populated by EditorApp from `room_wall` instances.
    /** @type {{ cx:number, cy:number, hx:number, hy:number, yawRad:number }[]} */
    this._wallColliders = [];
    /** @type {{ cx:number, cy:number, hx:number, hy:number, yawRad:number }[]} */
    this._objectColliders = [];
    this.colliderRadius = 0.45; // meters (rough shoulder width)
    this._maxWallResolveIters = 3;

    // No-clip: when enabled, collision resolution is bypassed (off by default).
    this.noClip = false;

    // Optional world bounds clamp (keeps player from leaving the map even if
    // walls/colliders are missing or a reconciliation step pushes us out).
    /** @type {{ minX:number, maxX:number, minY:number, maxY:number }|null} */
    this._worldBounds = null;

    // Simple interaction lock (sit/lay/watch): freezes locomotion at an anchor.
    this._interaction = { active: false, mode: '', anchorX: 0, anchorY: 0, anchorZ: null, yawRad: null };
  }

  /**
   * Snap the gameplay camera rig immediately (no smoothing).
   * This is useful right after spawn / mode switches to avoid a 1+ frame mismatch
   * where the renderer uses the old editor/orbit view matrix.
   * @param {import('./camera.js').Camera} camera
   */
  snapCamera(camera) {
    if (!camera) return;
    // Ensure a valid up vector (roll should always be 0 in our lookAt camera).
    try {
      if (camera.up && camera.up.length >= 3) {
        camera.up[0] = 0; camera.up[1] = 1; camera.up[2] = 0;
      }
    } catch { /* ignore */ }

    // world space mapping: world.x = data.x, world.z = data.y, world.y = data.z
    const tx = Number(this.pos?.x) || 0;
    const tz = Number(this.pos?.y) || 0;
    const ty = (Number(this.pos?.z) || 0) + (Number(this.eyeHeight) || 0);

    const cp = Math.cos(Number(this.pitchRad) || 0);
    const sp = Math.sin(Number(this.pitchRad) || 0);
    const cy = Math.cos(Number(this.yawRad) || 0);
    const sy = Math.sin(Number(this.yawRad) || 0);
    const lookX = sy * cp;
    const lookY = sp;
    const lookZ = cy * cp;

    const desiredTarget = vec3.create();
    const desiredPos = vec3.create();

    if (this.viewMode === 'first') {
      vec3.set(desiredPos, tx, ty, tz);
      vec3.set(desiredTarget, tx + lookX * 10.0, ty + lookY * 10.0, tz + lookZ * 10.0);
      this._cameraRigInitialized = false;
      this._applyCameraRig(0, camera, desiredPos, desiredTarget, /* isThirdPerson */ false);
      return;
    }

    // Third-person: over-shoulder offset along "right" vector derived from yaw.
    const rightX = cy;
    const rightZ = -sy;
    const side = (Number(this.camSide) || 0);
    const sideX = rightX * side;
    const sideZ = rightZ * side;

    vec3.set(
      desiredPos,
      tx - lookX * (Number(this.camDist) || 0) + sideX,
      ty + (Number(this.camHeight) || 0),
      tz - lookZ * (Number(this.camDist) || 0) + sideZ,
    );
    // Match the runtime third-person behavior: aim forward at camera height (level when pitchRad=0).
    vec3.set(
      desiredTarget,
      tx + lookX * 10.0,
      (ty + (Number(this.camHeight) || 0)) + lookY * 10.0,
      tz + lookZ * 10.0,
    );

    this._cameraRigInitialized = false;
    this._applyCameraRig(0, camera, desiredPos, desiredTarget, /* isThirdPerson */ true);
  }

  /**
   * @param {{ cx:number, cy:number, hx:number, hy:number, yawRad:number }[]} colliders
   */
  setWallColliders(colliders) {
    this._wallColliders = Array.isArray(colliders) ? colliders : [];
  }

  /**
   * @param {{ cx:number, cy:number, hx:number, hy:number, yawRad:number }[]} colliders
   */
  setObjectColliders(colliders) {
    this._objectColliders = Array.isArray(colliders) ? colliders : [];
  }

  setNoClip(v) {
    this.noClip = !!v;
  }

  toggleNoClip() {
    this.noClip = !this.noClip;
    return this.noClip;
  }

  /**
   * Optional: constrain player center to a map AABB in data-space.
   * @param {{minX:number,maxX:number,minY:number,maxY:number}|null} bounds
   */
  setWorldBounds(bounds) {
    const b = bounds && typeof bounds === 'object' ? bounds : null;
    const minX = Number(b?.minX);
    const maxX = Number(b?.maxX);
    const minY = Number(b?.minY);
    const maxY = Number(b?.maxY);
    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
      this._worldBounds = null;
      return;
    }
    this._worldBounds = { minX, maxX, minY, maxY };
  }

  _applyWorldBounds() {
    if (this.noClip) return;
    const b = this._worldBounds;
    if (!b) return;
    const r = Math.max(0.01, (Number(this.colliderRadius) || 0.45) + 0.02);
    const minX = Math.min(b.minX, b.maxX) + r;
    const maxX = Math.max(b.minX, b.maxX) - r;
    const minY = Math.min(b.minY, b.maxY) + r;
    const maxY = Math.max(b.minY, b.maxY) - r;
    if (!(minX <= maxX && minY <= maxY)) return;

    const px0 = Number(this.pos.x) || 0;
    const py0 = Number(this.pos.y) || 0;
    const px1 = Math.max(minX, Math.min(maxX, px0));
    const py1 = Math.max(minY, Math.min(maxY, py0));
    if (px1 !== px0) this._vel.x = 0.0;
    if (py1 !== py0) this._vel.y = 0.0;
    this.pos.x = px1;
    this.pos.y = py1;
  }

  /**
   * Freeze locomotion at a given anchor. Camera look remains enabled.
   * @param {{ mode: 'sit'|'lay'|'watch', x:number, y:number, z?:number|null, yawRad?:number|null }} st
   */
  beginInteraction(st) {
    const mode = String(st?.mode || '');
    this._interaction.active = true;
    this._interaction.mode = (mode === 'lay' || mode === 'watch') ? mode : 'sit';
    this._interaction.anchorX = Number(st?.x) || 0;
    this._interaction.anchorY = Number(st?.y) || 0;
    this._interaction.anchorZ = (st && (st.z === 0 || Number.isFinite(Number(st.z)))) ? Number(st.z) : null;
    this._interaction.yawRad = (st && (st.yawRad === 0 || Number.isFinite(Number(st.yawRad)))) ? Number(st.yawRad) : null;

    // Snap immediately (prevents one-frame drift).
    this.pos.x = this._interaction.anchorX;
    this.pos.y = this._interaction.anchorY;
    if (this._interaction.anchorZ !== null) this.pos.z = this._interaction.anchorZ;
    if (this._interaction.yawRad !== null) this.yawRad = this._interaction.yawRad;
    this._vel.x = 0;
    this._vel.y = 0;
    this.hasMoveInput = false;
    this.running = false;

    // Make the anchor collision-safe and stable.
    try {
      this._applyWallCollision();
      this._interaction.anchorX = Number(this.pos.x) || this._interaction.anchorX;
      this._interaction.anchorY = Number(this.pos.y) || this._interaction.anchorY;
    } catch { /* ignore */ }
  }

  endInteraction() {
    this._interaction.active = false;
    this._interaction.mode = '';
    this._interaction.anchorZ = null;
    this._interaction.yawRad = null;
  }

  isInteracting() {
    return !!this._interaction?.active;
  }

  spawnAt(x, y) {
    this.pos.x = Number(x) || 0;
    this.pos.y = Number(y) || 0;
    this._vz = 0;
    this._onGround = false;
    this._jumpCooldownSec = 0.0;
    this.justJumped = false;
    this.justLanded = false;
    this._groundSnap();
    // Ensure spawns can't start inside walls (unless no-clip is explicitly enabled).
    try { if (!this.noClip) this._applyWallCollision(); } catch { /* ignore */ }
    // Reset gameplay feel state so entering gameplay doesn't inherit old smoothing/velocity.
    this._vel.x = 0;
    this._vel.y = 0;
    this.bobPhase = 0;
    this.camSide = 0;
    this._camSideTarget = 0;
    this._smoothedFov = this.baseFov;
    this._cameraRigInitialized = false;
    this.enabled = true;
  }

  setViewMode(mode) {
    const m = String(mode || '').toLowerCase();
    this.viewMode = (m === 'first') ? 'first' : 'third';
  }

  toggleViewMode() {
    this.viewMode = (this.viewMode === 'first') ? 'third' : 'first';
  }

  toggleCameraSide() {
    // Only meaningful in third person.
    const mag = Math.max(0.0, Math.abs(this.camSide) || 2.0);
    const curSign = Math.sign(this._camSideTarget || this.camSide || 1) || 1;
    this._camSideTarget = -curSign * mag;
  }

  look(deltaX, deltaY) {
    const dx = Number(deltaX) || 0;
    const dy = Number(deltaY) || 0;
    // Tuned for pointermove deltas (pixels).
    const s = 0.0032;
    // Mouse-look: flip deltas to fix inverted feel.
    this.yawRad += -dx * s;
    this.pitchRad += dy * s;
    const lim = Math.PI * 0.49;
    this.pitchRad = Math.max(-lim, Math.min(lim, this.pitchRad));
  }

  _terrainHeightAtFeet() {
    const hz = this.getHeightAtXY ? this.getHeightAtXY(this.pos.x, this.pos.y) : 0;
    if (!Number.isFinite(hz)) return null;
    return hz + (Number(this.standingOffset) || 0);
  }

  _groundSnap() {
    const g = this._terrainHeightAtFeet();
    if (typeof g !== 'number') return;
    this.pos.z = g;
    this._vz = 0;
    this._onGround = true;
  }

  _applyGroundCollision(dt) {
    const t = Math.max(0, Math.min(0.05, Number(dt) || 0));
    const g = this._terrainHeightAtFeet();
    if (typeof g !== 'number') return;

    // If the terrain rose into us (or we just moved uphill), always snap up onto it.
    if (this.pos.z <= g) {
      this.pos.z = g;
      this._vz = 0;
      this._onGround = true;
      return;
    }

    // Stick to ground for small step-downs (feels like walking on terrain, not hovering).
    if (this._onGround) {
      const dz = this.pos.z - g;
      if (dz <= (Number(this.maxSnapDown) || 0)) {
        this.pos.z = g;
        this._vz = 0;
        this._onGround = true;
        return;
      }
      // Big drop: start falling.
      this._onGround = false;
    }

    // Airborne: integrate gravity, then collide with ground.
    this._vz -= (Number(this.gravity) || 0) * t;
    this.pos.z += this._vz * t;
    if (this.pos.z <= g) {
      this.pos.z = g;
      this._vz = 0;
      this._onGround = true;
    }
  }

  _applyWallCollision() {
    if (this.noClip) return;
    // Resolve player (circle) against oriented boxes on the X/Y plane by using the
    // Minkowski sum trick: expand the box by player radius and push the center out.
    const colsA = Array.isArray(this._wallColliders) ? this._wallColliders : [];
    const colsB = Array.isArray(this._objectColliders) ? this._objectColliders : [];
    if (colsA.length === 0 && colsB.length === 0) return;
    const cols = (colsB.length > 0) ? colsA.concat(colsB) : colsA;

    // Add a tiny "skin" so we don't numerically slip through seams.
    const r = Math.max(0.01, (Number(this.colliderRadius) || 0.45) + 0.03);
    const maxIters = Math.max(1, Math.min(8, Number(this._maxWallResolveIters) || 3));

    try { globalThis.__debugCollisionCalls = (Number(globalThis.__debugCollisionCalls) || 0) + 1; } catch { /* ignore */ }
    let overlapsThisCall = 0;
    for (let iter = 0; iter < maxIters; iter++) {
      let moved = false;
      for (let i = 0; i < cols.length; i++) {
        const c0 = cols[i];
        if (!c0) continue;
        const cx = Number(c0.cx) || 0;
        const cy = Number(c0.cy) || 0;
        const hx = Math.max(0, Number(c0.hx) || 0);
        const hy = Math.max(0, Number(c0.hy) || 0);
        if (!(hx > 1e-6 && hy > 1e-6)) continue;

        const yaw = Number(c0.yawRad) || 0;
        const co = Math.cos(yaw);
        const si = Math.sin(yaw);

        // Player center relative to collider center (world/data space).
        const dx = (Number(this.pos.x) || 0) - cx;
        const dy = (Number(this.pos.y) || 0) - cy;

        // Rotate into collider local space (inverse yaw).
        const lx = co * dx + si * dy;
        const ly = -si * dx + co * dy;

        // Expanded AABB (local space) to account for player radius.
        const ex = hx + r;
        const ey = hy + r;

        if (Math.abs(lx) > ex || Math.abs(ly) > ey) continue; // no overlap
        overlapsThisCall++;

        // Push out along the minimum penetration axis.
        const penX = ex - Math.abs(lx);
        const penY = ey - Math.abs(ly);
        let dlx = 0;
        let dly = 0;
        if (penX < penY) {
          const sgn = (lx < 0) ? -1 : 1;
          dlx = sgn * penX;
        } else {
          const sgn = (ly < 0) ? -1 : 1;
          dly = sgn * penY;
        }

        // Rotate delta back to world space and apply.
        const wx = co * dlx - si * dly;
        const wy = si * dlx + co * dly;
        this.pos.x += wx;
        this.pos.y += wy;
        moved = true;
      }
      if (!moved) break;
    }
    try { globalThis.__debugCollisionOverlaps = overlapsThisCall; } catch { /* ignore */ }
  }

  tick(dt, camera, keys) {
    if (!this.enabled) return;
    // Use a bounded substep loop instead of clamping dt to 50ms.
    // Clamping dt makes movement feel like "slow motion" when FPS drops under load.
    const dtSec = Math.max(0, Math.min(0.25, Number(dt) || 0));
    if (!dtSec) return;

    this.justJumped = false;
    this.justLanded = false;
    const wasOnGround = !!this._onGround;
    this._jumpCooldownSec = Math.max(0.0, (Number(this._jumpCooldownSec) || 0.0) - dtSec);

    // Forward from yaw (XZ plane). We keep movement on the ground plane.
    const f = this._tmpForward;
    f[0] = Math.sin(this.yawRad);
    f[1] = 0;
    f[2] = Math.cos(this.yawRad);

    // Right = forward x up
    const r = this._tmpRight;
    r[0] = f[2]; r[1] = 0; r[2] = -f[0];

    const interactionActive = !!this._interaction?.active;

    // Input to desired move dir (in world axes: forward/right are derived from yaw).
    let mx = 0;
    let mz = 0;
    if (!interactionActive) {
      if (keys.has('KeyW')) { mx += f[0]; mz += f[2]; }
      if (keys.has('KeyS')) { mx -= f[0]; mz -= f[2]; }
      if (keys.has('KeyD')) { mx += r[0]; mz += r[2]; }
      if (keys.has('KeyA')) { mx -= r[0]; mz -= r[2]; }
    }

    const ml = Math.hypot(mx, mz);
    const run = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const speed = run ? this.runSpeed : this.walkSpeed;
    const hasMove = ml > 1e-6;
    if (hasMove) { mx /= ml; mz /= ml; }

    // Store for animation/locomotion consumers.
    this.hasMoveInput = hasMove;
    this.running = !!run;
    this.moveDir.x = hasMove ? mx : 0.0;
    this.moveDir.y = hasMove ? mz : 0.0;

    // Jump (only if on ground).
    if (!interactionActive && this._onGround && this._jumpCooldownSec <= 1e-6 && keys.has('Space')) {
      this._vz = Number(this.jumpSpeed) || 0.0;
      this._onGround = false;
      this._jumpCooldownSec = Math.max(0.0, Number(this.jumpCooldownSec) || 0.0);
      this.justJumped = true;
    }

    if (interactionActive) {
      // Interaction mode: keep the player at an anchor, but DO NOT override collision every frame.
      // Instead: snap to anchor, resolve collision once, then update the anchor to the collision-safe point.
      this._vel.x = 0;
      this._vel.y = 0;
      this.pos.x = Number(this._interaction.anchorX) || 0;
      this.pos.y = Number(this._interaction.anchorY) || 0;
      if (this._interaction.anchorZ !== null) this.pos.z = Number(this._interaction.anchorZ) || this.pos.z;
      if (this._interaction.yawRad !== null) this.yawRad = Number(this._interaction.yawRad) || this.yawRad;
      this._applyWallCollision();
      this._applyWorldBounds();
      this._applyGroundCollision(dtSec);
      this._interaction.anchorX = Number(this.pos.x) || this._interaction.anchorX;
      this._interaction.anchorY = Number(this.pos.y) || this._interaction.anchorY;
      this.hasMoveInput = false;
      this.running = false;
      this.moveDir.x = 0.0;
      this.moveDir.y = 0.0;
    } else {
      // Velocity approach (accel/decel), integrated via substeps for stability.
      const targetVx = hasMove ? (mx * speed) : 0.0;
      const targetVy = hasMove ? (mz * speed) : 0.0;
      const k = (hasMove ? this.accel : this.decel);

      let remaining = dtSec;
      // IMPORTANT: avoid "tunneling" through thin walls.
      // Walls are often ~0.25m thick; at run speed 18m/s, a 50ms step moves ~0.9m.
      // We dynamically choose substeps so planar displacement stays small.
      const maxStep = 0.05; // upper bound on step time
      const maxSubSteps = 20; // simulate up to 1s worst case; remaining is still bounded by dtSec<=0.25
      let steps = 0;
      while (remaining > 1e-8 && steps < maxSubSteps) {
        // Target <= ~0.18m planar displacement per substep (safe vs 0.25m walls).
        // Use the larger of current speed and target speed; otherwise, the *first* step of a run
        // can accelerate to near-target within a big timestep and tunnel through walls.
        const spdNow = Math.max(0, Math.hypot(this._vel.x, this._vel.y));
        const spdTarget = Math.max(0, Math.hypot(targetVx, targetVy));
        const spdRef = Math.max(1e-6, spdNow, spdTarget);
        const targetStep = Math.max(0.008, Math.min(maxStep, 0.18 / spdRef));
        const t = Math.min(targetStep, remaining);
        const a = 1.0 - Math.exp(-k * t);
        this._vel.x += (targetVx - this._vel.x) * a;
        this._vel.y += (targetVy - this._vel.y) * a;

        this.pos.x += this._vel.x * t;
        this.pos.y += this._vel.y * t;
        this._applyWallCollision();
        this._applyWorldBounds();
        this._applyGroundCollision(t);

        remaining -= t;
        steps++;
      }
    }

    if (!wasOnGround && this._onGround) this.justLanded = true;

    // Update follow camera:
    // world space mapping: world.x = data.x, world.z = data.y, world.y = data.z
    const tx = this.pos.x;
    const tz = this.pos.y;
    const ty = this.pos.z + this.eyeHeight;

    // Look direction for camera (includes pitch for first-person aim).
    const cp = Math.cos(this.pitchRad);
    const sp = Math.sin(this.pitchRad);
    const cy = Math.cos(this.yawRad);
    const sy = Math.sin(this.yawRad);
    const lookX = sy * cp;
    const lookY = sp;
    const lookZ = cy * cp;

    // Smooth over-shoulder offset for third-person camera (like MC "toggle side").
    {
      const sideTarget = (this.viewMode === 'third') ? this._camSideTarget : 0.0;
      const camDt = Math.min(0.10, dtSec);
      const sideLerp = 1.0 - Math.exp(-10.0 * camDt);
      this.camSide += (sideTarget - this.camSide) * sideLerp;
    }

    if (this.viewMode === 'first') {
      const desiredPos = vec3.fromValues(tx, ty, tz);
      const desiredTarget = vec3.fromValues(
        tx + lookX * 10.0,
        ty + lookY * 10.0,
        tz + lookZ * 10.0,
      );
      const camDt = Math.min(0.10, dtSec);
      this._applyCameraRig(camDt, camera, desiredPos, desiredTarget, /* isThird */ false);
    } else {
      // Over-shoulder: shift camera along "right" vector.
      const sideX = r[0] * this.camSide;
      const sideZ = r[2] * this.camSide;
      const desiredPos = vec3.fromValues(
        tx - lookX * this.camDist + sideX,
        ty + this.camHeight,
        tz - lookZ * this.camDist + sideZ,
      );
      // IMPORTANT:
      // Looking at the player (target.y=ty) while the camera is above them (pos.y=ty+camHeight)
      // forces a downward pitch even when `pitchRad` is 0. If you want a level spawn/horizon,
      // target a point *in front* of the player at the camera height.
      const desiredTarget = vec3.fromValues(
        tx + lookX * 10.0,
        (ty + this.camHeight) + lookY * 10.0,
        tz + lookZ * 10.0,
      );
      const camDt = Math.min(0.10, dtSec);
      this._applyCameraRig(camDt, camera, desiredPos, desiredTarget, /* isThird */ true);
    }
  }

  _applyCameraRig(dt, camera, desiredPos, desiredTarget, isThirdPerson) {
    // First frame after spawn/enable: snap smoothing state to desired values to avoid "camera fly-in".
    if (!this._cameraRigInitialized) {
      vec3.copy(this._smoothedCamPos, desiredPos);
      vec3.copy(this._smoothedCamTarget, desiredTarget);
      vec3.copy(camera.position, desiredPos);
      vec3.copy(camera.target, desiredTarget);
      this._smoothedFov = this.baseFov;
      camera.fovDeg = this._smoothedFov;
      this._cameraRigInitialized = true;
      camera.updateMatrices();
      return;
    }

    // 1) Optional camera smoothing (position + lookAt independently).
    if (!this.enableCameraSmoothing) {
      vec3.copy(camera.position, desiredPos);
      vec3.copy(camera.target, desiredTarget);
    } else {
      const ap = 1.0 - Math.exp(-this.cameraSmoothPos * dt);
      const at = 1.0 - Math.exp(-this.cameraSmoothTarget * dt);
      vec3.lerp(this._smoothedCamPos, this._smoothedCamPos, desiredPos, ap);
      vec3.lerp(this._smoothedCamTarget, this._smoothedCamTarget, desiredTarget, at);
      vec3.copy(camera.position, this._smoothedCamPos);
      vec3.copy(camera.target, this._smoothedCamTarget);
    }

    // 2) Bobbing (small offsets) — applied last so it feels like camera inertia.
    if (this.enableBobbing) {
      const spd = Math.hypot(this._vel.x, this._vel.y);
      if (spd > 0.5) {
        // Speed-scaled phase advance.
        this.bobPhase += dt * (this.bobFreq * Math.max(0.5, spd / this.walkSpeed)) * Math.PI * 2.0;
        const ox = Math.sin(this.bobPhase * 0.5) * this.bobAmpX;
        const oy = Math.sin(this.bobPhase) * this.bobAmpY;
        camera.position[0] += ox;
        camera.position[1] += oy;
        // Keep target mostly stable in third-person; in FP it helps "breathing".
        if (!isThirdPerson) {
          camera.target[1] += oy * 0.65;
        }
      } else {
        // Light idle breathing.
        this.bobPhase += dt * 0.7 * Math.PI * 2.0;
        const oy = Math.sin(this.bobPhase) * (this.bobAmpY * 0.25);
        camera.position[1] += oy;
      }
    }

    // 3) Dynamic FOV (speed feeling). Smooth so it doesn't pop.
    if (this.enableDynamicFov) {
      const spd = Math.hypot(this._vel.x, this._vel.y);
      const r = Math.max(0, Math.min(1, spd / Math.max(1e-6, this.fovSpeedThreshold)));
      const targetFov = this.baseFov + (this.maxFov - this.baseFov) * r;
      const af = 1.0 - Math.exp(-this.fovSmooth * dt);
      this._smoothedFov += (targetFov - this._smoothedFov) * af;
      camera.fovDeg = this._smoothedFov;
    } else {
      camera.fovDeg = this.baseFov;
    }

    camera.updateMatrices();
  }

  get onGround() {
    return !!this._onGround;
  }

  get planarSpeed() {
    return Math.hypot(Number(this._vel?.x) || 0.0, Number(this._vel?.y) || 0.0);
  }
}


