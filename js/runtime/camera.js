import { mat4, vec3 } from 'gl-matrix';

export class Camera {
  constructor() {
    this.fovDeg = 55;
    this.near = 0.05;
    this.far = 50000;

    this.position = vec3.fromValues(0, 40, 70);
    this.target = vec3.fromValues(0, 0, 0);
    this.up = vec3.fromValues(0, 1, 0);

    this.view = mat4.create();
    this.proj = mat4.create();
    this.viewProj = mat4.create();

    this.aspect = 1;
    // Default orbit orientation should be axis-aligned (not diagonally "beauty framed").
    // Yaw=0 means the camera sits on -Z looking toward +Z (given _applyOrbit()).
    this._yaw = 0;
    // Spawn level by default (no initial downward tilt).
    this._pitch = 0;
    this._dist = 80;

    this.moveSpeed = 35;
    this.rotateSpeed = 0.003;
    this.zoomSpeed = 0.0012;

    this._dragging = false;
    this._last = null;
    this._keys = new Set();
    this._flatten = true;
    // Editor integration: some tools want LMB to be "paint/select" instead of orbit.
    // RMB orbit remains available.
    this.allowOrbitLmb = true;

    // Make the *initial* camera pose match the orbit parameters.
    // Otherwise the view can appear "wrong/tilted" until the first orbit input calls `_applyOrbit()`.
    this._applyOrbit();
    this.updateMatrices();
  }

  _updateClipPlanesFromDistance() {
    // Keep near plane small enough that looking along the ground doesn't "slice" half the view
    // after a zoom-to-fit on a large AABB. We still let near grow a bit with distance to retain
    // some depth precision, but we cap it to avoid the cutoff artifact.
    // IMPORTANT:
    // - In editor orbit mode, `_dist` is authoritative.
    // - In gameplay mode, the camera is driven by PlayerController (position/target),
    //   and `_dist` may be stale. Use the actual position↔target distance.
    const dd = vec3.distance(this.position, this.target);
    const d = Math.max(1e-3, Number.isFinite(dd) ? dd : (Number(this._dist) || 0));

    // Far should comfortably cover what you're looking at; cap it to reduce depth precision loss.
    const far = Math.min(2_000_000, Math.max(1000, d * 60));

    // Near grows slowly with distance, but is capped so we don't clip nearby ground/geometry.
    const near = Math.max(0.02, Math.min(2.0, d * 0.0005));

    this.far = far;
    // Ensure near is valid relative to far.
    this.near = Math.min(near, Math.max(0.01, far * 0.25));
  }

  setAspect(w, h) {
    this.aspect = Math.max(1e-6, w / Math.max(1e-6, h));
    this.updateMatrices();
  }

  frameAABB(min, max) {
    const cx = (min[0] + max[0]) * 0.5;
    const cy = (min[1] + max[1]) * 0.5;
    const cz = (min[2] + max[2]) * 0.5;
    const dx = (max[0] - min[0]);
    const dy = (max[1] - min[1]);
    const dz = (max[2] - min[2]);
    const radius = Math.max(1, Math.sqrt(dx*dx + dy*dy + dz*dz) * 0.6);

    vec3.set(this.target, cx, cy, cz);
    this._dist = Math.max(10, radius * 2.0);
    // Keep framing "straight" by default (axis-aligned yaw).
    this._yaw = 0;
    // Frame level by default (no initial downward tilt).
    this._pitch = 0;
    this._applyOrbit();
    this.updateMatrices();
  }

  attach(canvas) {
    canvas.tabIndex = 0;
    canvas.style.outline = 'none';

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      if (e.button === 0 && !this.allowOrbitLmb) return;
      this._dragging = true;
      this._last = { x: e.clientX, y: e.clientY, btn: e.button };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointerup', (e) => {
      this._dragging = false;
      this._last = null;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this._dragging || !this._last) return;
      const dx = e.clientX - this._last.x;
      const dy = e.clientY - this._last.y;
      this._last.x = e.clientX;
      this._last.y = e.clientY;

      // LMB: orbit; RMB: orbit (same) for now.
      this._yaw += dx * this.rotateSpeed;
      this._pitch += -dy * this.rotateSpeed;
      const lim = Math.PI * 0.49;
      this._pitch = Math.max(-lim, Math.min(lim, this._pitch));
      this._applyOrbit();
      this.updateMatrices();
    });
    canvas.addEventListener('wheel', (e) => {
      const d = Number(e.deltaY) || 0;
      const exp = Math.max(-0.25, Math.min(0.25, d * this.zoomSpeed));
      this._dist = Math.max(2.0, Math.min(200000, this._dist * Math.exp(exp)));
      this._applyOrbit();
      this.updateMatrices();
    }, { passive: true });

    window.addEventListener('keydown', (e) => { this._keys.add(e.code); });
    window.addEventListener('keyup', (e) => { this._keys.delete(e.code); });
  }

  setAllowOrbitLmb(v) {
    this.allowOrbitLmb = !!v;
  }

  tick(dt) {
    // IMPORTANT: don't clamp to 50ms (20 FPS) — that causes "slow motion" navigation when the
    // renderer is heavy. Instead, only cap very large deltas to avoid huge jumps after tab
    // switches / debugger pauses.
    const t = Math.max(0, Math.min(0.25, Number(dt) || 0));
    if (!t) return;
    const forward = vec3.create();
    vec3.subtract(forward, this.target, this.position);
    forward[1] = this._flatten ? 0 : forward[1];
    if (vec3.length(forward) > 1e-6) vec3.normalize(forward, forward);
    const right = vec3.create();
    vec3.cross(right, forward, this.up);
    if (vec3.length(right) > 1e-6) vec3.normalize(right, right);

    const v = vec3.create();
    const speed = this.moveSpeed * t * Math.max(0.25, Math.min(30, this._dist * 0.02));
    const add = (dir, s) => { vec3.scaleAndAdd(v, v, dir, s); };

    if (this._keys.has('KeyW')) add(forward, speed);
    if (this._keys.has('KeyS')) add(forward, -speed);
    if (this._keys.has('KeyA')) add(right, -speed);
    if (this._keys.has('KeyD')) add(right, speed);
    if (this._keys.has('KeyQ')) add(this.up, speed);
    if (this._keys.has('KeyE')) add(this.up, -speed);

    if (vec3.length(v) > 1e-6) {
      vec3.add(this.position, this.position, v);
      vec3.add(this.target, this.target, v);
      this.updateMatrices();
    }
  }

  _applyOrbit() {
    const cp = Math.cos(this._pitch);
    const sp = Math.sin(this._pitch);
    const cy = Math.cos(this._yaw);
    const sy = Math.sin(this._yaw);
    const dir = vec3.fromValues(sy * cp, sp, cy * cp);
    vec3.normalize(dir, dir);
    vec3.scaleAndAdd(this.position, this.target, dir, -this._dist);
  }

  updateMatrices() {
    this._updateClipPlanesFromDistance();
    // gl-matrix `lookAt` becomes numerically unstable when forward is nearly parallel
    // to the provided up vector (or when position ~= target). That can show up as an
    // initial "rolled/tilted" view that corrects itself after the first camera move.
    // Guard against that by ensuring a non-degenerate forward and choosing a safe up.
    const px = Number(this.position?.[0]) || 0;
    const py = Number(this.position?.[1]) || 0;
    const pz = Number(this.position?.[2]) || 0;
    let fx = (Number(this.target?.[0]) || 0) - px;
    let fy = (Number(this.target?.[1]) || 0) - py;
    let fz = (Number(this.target?.[2]) || 0) - pz;
    let fl = Math.hypot(fx, fy, fz);
    if (!(fl > 1e-8)) {
      // If target is invalid/too close, look forward along +Z.
      fx = 0; fy = 0; fz = 1;
      fl = 1;
      try {
        this.target[0] = px + fx;
        this.target[1] = py + fy;
        this.target[2] = pz + fz;
      } catch { /* ignore */ }
    } else {
      fx /= fl; fy /= fl; fz /= fl;
    }

    // Normalize current up; default to world-up.
    let ux = Number(this.up?.[0]); let uy = Number(this.up?.[1]); let uz = Number(this.up?.[2]);
    if (!Number.isFinite(ux) || !Number.isFinite(uy) || !Number.isFinite(uz)) { ux = 0; uy = 1; uz = 0; }
    const ul = Math.hypot(ux, uy, uz);
    if (!(ul > 1e-8)) { ux = 0; uy = 1; uz = 0; }
    else { ux /= ul; uy /= ul; uz /= ul; }

    // If forward ~ parallel to up, pick a different up axis to avoid roll/NaNs.
    const dot = fx * ux + fy * uy + fz * uz;
    if (Math.abs(dot) > 0.999) {
      // Pick an up that isn't parallel to forward.
      if (Math.abs(fz) < 0.9) { ux = 0; uy = 0; uz = 1; }
      else { ux = 1; uy = 0; uz = 0; }
    }

    mat4.lookAt(this.view, this.position, this.target, [ux, uy, uz]);
    mat4.perspective(this.proj, (this.fovDeg * Math.PI) / 180, this.aspect, this.near, this.far);
    mat4.multiply(this.viewProj, this.proj, this.view);
  }
}


