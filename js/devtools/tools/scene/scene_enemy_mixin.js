import * as THREE from 'three';

import { collidesCircleAgainstBoxes } from '../../../shared/collision_world.js';

import {
  safeTrim,
  lerp,
  clamp01,
  disposeThreeObject,
} from './core/scene_utils.js';

export const sceneEnemyMixin = {
  _spawnDefaultEnemies() {
    if (!this._scene || !this._game?.enabled) return;
    // Clear old enemies
    for (const en of (this._enemies || [])) {
      try { this._scene.remove(en.group); } catch { /* ignore */ }
      try { disposeThreeObject(en.group); } catch { /* ignore */ }
    }
    this._enemies = [];

    const spawnPtsBase = [
      { x: -28, z: -26 }, { x: 28, z: -26 }, { x: -28, z: 26 }, { x: 28, z: 26 },
      { x: -18, z: -8 }, { x: 18, z: 8 }, { x: 0, z: -18 }, { x: 0, z: 18 },
      { x: -10, z: 0 }, { x: 10, z: 0 },
    ];
    const targetN = Math.max(0, Math.min(80, Math.floor(Number(this._game?.enemy?.countTarget) || 6)));
    const spawnPts = spawnPtsBase.slice(0, Math.min(targetN, spawnPtsBase.length));
    // If we need more than the curated list, sprinkle random points (avoid obstacles).
    if (targetN > spawnPts.length) {
      const nav = this._game?.nav || {};
      let tries = 0;
      while (spawnPts.length < targetN && tries++ < 600) {
        const rx = lerp(Number(nav.minX || -30) + 2, Number(nav.maxX || 30) - 2, Math.random());
        const rz = lerp(Number(nav.minZ || -30) + 2, Number(nav.maxZ || 30) - 2, Math.random());
        if (Math.hypot(rx - this._spawn.x, rz - this._spawn.z) < 8) continue;
        if (this._collidesWorldAtRadius(rx, 0, rz, 0.9)) continue;
        spawnPts.push({ x: rx, z: rz });
      }
    }

    const wps = Array.isArray(this._scenarioContent?.waypoints) ? this._scenarioContent.waypoints : [];
    const patrol = wps.filter((w) => Number.isFinite(Number(w?.x)) && Number.isFinite(Number(w?.z)));

    for (let i = 0; i < spawnPts.length; i++) {
      const sp = spawnPts[i];
      const en = this._makeEnemy({
        id: `enemy_${i + 1}`,
        x: sp.x,
        y: 0,
        z: sp.z,
        patrol: patrol.length >= 2 ? patrol.map((w) => ({ x: Number(w.x), z: Number(w.z) })) : null,
      });
      if (en) this._enemies.push(en);
    }
    this._game.enemiesAlive = this._enemies.length;
  },

  _makeEnemy({ id, x, y, z, patrol }) {
    if (!this._scene) return null;
    const group = new THREE.Group();
    group.name = String(id || 'enemy');
    group.position.set(Number(x) || 0, Number(y) || 0, Number(z) || 0);

    // Slight color variation per enemy
    const hue = (Math.random() * 0.10) - 0.05;
    const bodyMat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(0.02 + hue, 0.65, 0.55), roughness: 0.78, metalness: 0.0, emissive: 0x200606 });
    const clothMat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(0.58 + hue, 0.28, 0.35), roughness: 0.85, metalness: 0.0 });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xffd166, roughness: 0.65, metalness: 0.0, emissive: 0x241b05 });
    const gearMat = new THREE.MeshStandardMaterial({ color: 0x1b2433, roughness: 0.7, metalness: 0.0 });

    // Low-poly humanoid (still primitive-based)
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.50, 0.70, 0.26), bodyMat);
    torso.position.set(0, 1.05, 0);
    torso.name = 'enemy_torso';
    group.add(torso);

    const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.28, 0.22), clothMat);
    pelvis.position.set(0, 0.62, 0);
    pelvis.name = 'enemy_pelvis';
    group.add(pelvis);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.26), skinMat);
    head.position.set(0, 1.50, 0.02);
    head.name = 'enemy_head';
    group.add(head);

    const helmet = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.14, 0.30), gearMat);
    helmet.position.set(0, 1.62, 0.02);
    helmet.name = 'enemy_helmet';
    group.add(helmet);

    const backpack = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.40, 0.14), gearMat);
    backpack.position.set(0, 1.05, -0.20);
    backpack.name = 'enemy_pack';
    group.add(backpack);

    // Limbs use pivot groups so we can rotate them (walk cycle) without external animations.
    const mkLimbPivot = ({ w, h, d, mat, px, py, pz, pivotName, meshName }) => {
      const pivot = new THREE.Group();
      pivot.name = pivotName;
      pivot.position.set(px, py, pz);
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      // Place mesh so pivot is at the TOP of the limb (hip/shoulder).
      m.position.set(0, -h * 0.5, 0);
      m.name = meshName;
      pivot.add(m);
      group.add(pivot);
      return { pivot, mesh: m };
    };

    // Hip height is ~0.60 (top of the old centered leg at y=0.30, h=0.60).
    const legL = mkLimbPivot({ w: 0.16, h: 0.60, d: 0.18, mat: clothMat, px: -0.14, py: 0.60, pz: 0.02, pivotName: 'enemy_legL_pivot', meshName: 'enemy_legL' });
    const legR = mkLimbPivot({ w: 0.16, h: 0.60, d: 0.18, mat: clothMat, px: 0.14, py: 0.60, pz: 0.02, pivotName: 'enemy_legR_pivot', meshName: 'enemy_legR' });
    // Shoulder height is ~1.30 (top of the old centered arm at y=1.05, h=0.50).
    const armL = mkLimbPivot({ w: 0.14, h: 0.50, d: 0.14, mat: clothMat, px: -0.40, py: 1.30, pz: 0.02, pivotName: 'enemy_armL_pivot', meshName: 'enemy_armL' });
    const armR = mkLimbPivot({ w: 0.14, h: 0.50, d: 0.14, mat: clothMat, px: 0.40, py: 1.30, pz: 0.02, pivotName: 'enemy_armR_pivot', meshName: 'enemy_armR' });

    // Simple low-poly gun in right hand with a muzzle point (for visible bullets)
    const gun = new THREE.Group();
    // Parent to right arm so it participates in the walk/combat pose.
    // Place near hand (arm mesh extends downward from shoulder pivot).
    gun.position.set(-0.18, -0.40, 0.18);
    gun.rotation.y = Math.PI;
    const gunBody = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.08, 0.28), gearMat);
    gunBody.position.set(0, 0, 0.04);
    gun.add(gunBody);
    const gunBar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.24), gearMat);
    gunBar.position.set(0, 0.00, -0.16);
    gun.add(gunBar);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.00, -0.30);
    gun.add(muzzle);
    armR.pivot.add(gun);
    this._scene.add(group);

    return {
      id: String(id || ''),
      group,
      hitMeshes: [torso, pelvis, head, helmet, backpack, legL.mesh, legR.mesh, armL.mesh, armR.mesh],
      headMesh: head,
      muzzleObj: muzzle,
      // Limb pivots for procedural animation.
      limb: { legL: legL.pivot, legR: legR.pivot, armL: armL.pivot, armR: armR.pivot },
      hp: 100,
      hpMax: 100,
      dead: false,
      state: 'patrol',
      speed: 2.8,
      chaseSpeed: 4.2,
      shootCd: 0,
      alert: 0,
      lastHitT: 0,
      radius: 0.35,
      eyeH: 1.45,
      // Walk-cycle params (model-free procedural animation).
      baseY: Number(y) || 0,
      animPhase: Math.random() * Math.PI * 2,
      patrol: Array.isArray(patrol) ? patrol : null,
      patrolIdx: 0,
      path: [],
      pathIdx: 0,
      target: { x: Number(x) || 0, z: Number(z) || 0 },
    };
  },

  _tickEnemies(dt) {
    const g = this._game;
    if (!g?.enabled) return;
    const px = Number(this._player.x);
    const py = Number(this._player.y) + Number(this._player.eyeH || 1.7);
    const pz = Number(this._player.z);
    if (![px, py, pz].every((v) => Number.isFinite(v))) return;

    for (const en of this._enemies) {
      if (!en || en.dead) continue;
      const ex = Number(en.group.position.x);
      const ez = Number(en.group.position.z);
      const ey = Number(en.group.position.y) + Number(en.eyeH || 1.45);
      const dx = px - ex;
      const dz = pz - ez;
      const dist = Math.hypot(dx, dz);

      // Cooldowns
      en.shootCd = Math.max(0, (Number(en.shootCd) || 0) - dt);
      en.alert = Math.max(0, (Number(en.alert) || 0) - dt);

      // Vision + LoS
      const see = dist <= g.enemy.seeDist;
      const los = see ? !this._segmentBlocked(ex, ey, ez, px, py, pz) : false;

      const behavior = safeTrim(g?.enemy?.behavior) || 'attack';
      const isAttack = behavior === 'attack';
      const isPatrol = behavior === 'patrol';
      const isSim = behavior === 'sim';

      // State transitions
      const lowHp = (Number(en.hp) || 0) <= 35;
      if (los && dist <= g.enemy.seeDist) en.alert = 2.0;

      if (isAttack) {
        if (en.state !== 'chase' && en.state !== 'cover') {
          if (los && dist <= g.enemy.seeDist) en.state = 'chase';
        }
        if (lowHp && en.alert > 0.2) en.state = 'cover';
        if (en.state === 'cover' && !lowHp) en.state = 'chase';
      } else if (isPatrol) {
        // Patrol mode: never chase; if shot/alerted and low HP, try to find cover.
        if (lowHp && en.alert > 0.2) en.state = 'cover';
        else en.state = 'patrol';
      } else if (isSim) {
        // Sim mode: always patrol/roam, no combat.
        en.state = 'patrol';
      }

      // Decide movement target
      let tx = ex;
      let tz = ez;
      if (en.state === 'chase') {
        tx = px;
        tz = pz;
      } else if (en.state === 'cover') {
        const cp = this._pickCoverPoint(ex, ez, px, pz);
        if (cp) { tx = cp.x; tz = cp.z; }
        else { en.state = 'chase'; tx = px; tz = pz; }
      } else {
        // patrol
        if (en.patrol && en.patrol.length >= 2) {
          const p = en.patrol[en.patrolIdx % en.patrol.length];
          tx = Number(p.x) || ex;
          tz = Number(p.z) || ez;
          const pd = Math.hypot(tx - ex, tz - ez);
          if (pd < 0.8) en.patrolIdx = (en.patrolIdx + 1) % en.patrol.length;
        } else {
          // lazy roam in-place
          if (!en.roamT) en.roamT = 0;
          en.roamT = Math.max(0, en.roamT - dt);
          if (en.roamT <= 1e-6) {
            en.roamT = 2.5 + Math.random() * 2.5;
            tx = lerp(g.nav.minX + 2, g.nav.maxX - 2, Math.random());
            tz = lerp(g.nav.minZ + 2, g.nav.maxZ - 2, Math.random());
            en.target = { x: tx, z: tz };
          } else {
            tx = en.target?.x ?? ex;
            tz = en.target?.z ?? ez;
          }
        }
      }

      // Pathfind occasionally (cheap throttling)
      en.pathT = Math.max(0, (Number(en.pathT) || 0) - dt);
      const wantsPath = dist > 2.0;
      if (g.nav.built && wantsPath && en.pathT <= 1e-6) {
        en.pathT = 0.6 + Math.random() * 0.4;
        const path = this._navFindPath(ex, ez, tx, tz);
        en.path = Array.isArray(path) ? path : [];
        en.pathIdx = 0;
      }

      // Follow path / direct
      let gx = tx;
      let gz = tz;
      if (en.path && en.path.length) {
        const node = en.path[Math.min(en.pathIdx, en.path.length - 1)];
        gx = node.x;
        gz = node.z;
        if (Math.hypot(gx - ex, gz - ez) < 0.6 && en.pathIdx < en.path.length - 1) en.pathIdx++;
      }

      const spd = (en.state === 'chase') ? en.chaseSpeed : (en.state === 'cover') ? (en.chaseSpeed * 0.95) : en.speed;
      const mdx = gx - ex;
      const mdz = gz - ez;
      const ml = Math.hypot(mdx, mdz);
      const prevX = ex;
      const prevZ = ez;
      if (ml > 1e-4) {
        const step = Math.min(ml, spd * dt);
        const vx = (mdx / ml) * step;
        const vz = (mdz / ml) * step;
        const nx = ex + vx;
        const nz = ez + vz;
        // Avoid obstacles
        if (!this._collidesAtRadius(nx, 0, ez, en.radius)) en.group.position.x = nx;
        if (!this._collidesAtRadius(en.group.position.x, 0, nz, en.radius)) en.group.position.z = nz;
      }

      // Procedural "model-free" walk cycle: animate limb pivots when moving.
      // This gives walking motion without needing a skinned GLB.
      try {
        const curX = Number(en.group.position.x);
        const curZ = Number(en.group.position.z);
        const spdNow = (dt > 1e-6) ? (Math.hypot(curX - prevX, curZ - prevZ) / dt) : 0;
        const stride = clamp01(spdNow / Math.max(0.001, Number(en.chaseSpeed) || 4.2));
        const moving = spdNow > 0.25;
        const t = Number(g.time) || 0;
        const ph0 = Number(en.animPhase) || 0;
        // Step rate increases with speed; tuned for the default enemy speeds.
        const stepHz = 0.85 + spdNow * 0.33;
        const ph = (t * stepHz * Math.PI * 2.0) + ph0;
        const s = Math.sin(ph);
        const c = Math.cos(ph);

        const limb = en.limb || {};
        const legL = limb.legL;
        const legR = limb.legR;
        const armL = limb.armL;
        const armR = limb.armR;
        const combat = (safeTrim(g?.enemy?.behavior) === 'attack' && Number(en.alert) > 0.1) ? 1.0 : 0.0;
        const swingMul = moving ? (1.0 - 0.65 * combat) : 0.0;

        // Legs swing opposite. Arms swing opposite to legs, but damp in combat.
        const legSwing = swingMul * (0.85 * stride);
        const armSwing = swingMul * (0.55 * stride);

        if (legL) {
          legL.rotation.x = s * legSwing;
          legL.rotation.z = c * (0.10 * stride) * swingMul;
        }
        if (legR) {
          legR.rotation.x = -s * legSwing;
          legR.rotation.z = -c * (0.10 * stride) * swingMul;
        }
        if (armL) {
          // Slightly back when walking; small idle breathing when stopped.
          armL.rotation.x = (-s * armSwing) + (moving ? 0.15 : (Math.sin(t * 1.3 + ph0) * 0.06));
        }
        if (armR) {
          // In combat, keep gun arm a bit forward/up. Otherwise swing.
          const combatPose = combat ? -0.55 : 0.10;
          armR.rotation.x = (s * armSwing) + combatPose;
        }

        // Body bob (subtle) to sell steps. Keep baseY stable.
        const baseY = Number(en.baseY) || 0;
        en.group.position.y = baseY + (moving ? (Math.abs(s) * 0.04 * stride) : (Math.sin(t * 1.0 + ph0) * 0.01));
      } catch { /* ignore */ }

      // Face player when alerted (purely cosmetic)
      if (en.alert > 0.1) {
        const ang = Math.atan2(px - en.group.position.x, pz - en.group.position.z);
        en.group.rotation.y = ang;
      }

      // Enemy shooting (attack mode only)
      const inRange = dist <= g.enemy.range;
      if (isAttack && en.alert > 0.1 && los && inRange && en.shootCd <= 1e-6) {
        en.shootCd = 1.0 / Math.max(0.1, Number(g.enemy.fireRate) || 2.0);
        // Simple aim error scales with distance
        const aes = Math.max(0.2, Number(g.enemy.aimErrorScale) || 1.0);
        const err = (clamp01(dist / g.enemy.range) * 0.08 + 0.01) * aes;
        const hitChance = clamp01(1.0 - err);
        const from = new THREE.Vector3(ex, ey, ez);
        try { en.muzzleObj?.getWorldPosition?.(from); } catch { /* ignore */ }
        const to = new THREE.Vector3(px, py, pz);
        // Misses get a visible offset so you can see shots.
        const miss = (Math.random() >= hitChance);
        if (miss) {
          const a = Math.random() * Math.PI * 2;
          const r = (0.6 + Math.random() * 1.4) * (err * 10);
          to.x += Math.cos(a) * r;
          to.z += Math.sin(a) * r;
          to.y += (Math.random() - 0.5) * r * 0.25;
        }
        this._spawnTracer(from, to, 0xff9b7a, 0.05);
        this._spawnBullet(from, to, 0xff9b7a);
        this._spawnMuzzleFlash(from, 0xff9b7a);
        if (!miss) this._damagePlayer(g.enemy.dmg);
      }
    }
  },

  _segmentBlocked(x0, y0, z0, x1, y1, z1) {
    const boxes = Array.isArray(this._obstacleBoxes) ? this._obstacleBoxes : [];
    const vboxes = this._vehicleSystem?.getVehicleBoxes?.() || [];
    if (!boxes.length && !vboxes.length) return false;
    const p0 = this._tmpV3.set(x0, y0, z0);
    const p1 = this._tmpV3b.set(x1, y1, z1);
    const testBox = (b0) => {
      if (!b0) return false;
      const b = b0.clone().expandByScalar(0.02);
      return this._segmentIntersectsBox(p0, p1, b);
    };
    for (const b0 of boxes) {
      if (testBox(b0)) return true;
    }
    for (const b0 of vboxes) {
      if (testBox(b0)) return true;
    }
    return false;
  },

  _segmentIntersectsBox(p0, p1, box) {
    // Slab method in 3D for segment [p0, p1]
    const dir = new THREE.Vector3().subVectors(p1, p0);
    let tmin = 0;
    let tmax = 1;
    for (const axis of ['x', 'y', 'z']) {
      const o = p0[axis];
      const d = dir[axis];
      const min = box.min[axis];
      const max = box.max[axis];
      if (Math.abs(d) < 1e-8) {
        if (o < min || o > max) return false;
        continue;
      }
      const inv = 1.0 / d;
      let t1 = (min - o) * inv;
      let t2 = (max - o) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
    return true;
  },

  _collidesAtRadius(x, yFeet, z, r) {
    return collidesCircleAgainstBoxes({
      x,
      z,
      yFeet,
      radius: Math.max(0.05, Number(r) || 0.35),
      height: Math.max(0.5, Number(this._player?.eyeH) || 1.7),
      staticBoxes: this._obstacleBoxes,
      dynamicBoxes: this._vehicleSystem?.getVehicleBoxes?.() || [],
    });
  },

  _pickCoverPoint(ex, ez, px, pz) {
    // Sample simple cover points around obstacles and pick one that breaks LoS.
    const boxes = Array.isArray(this._obstacleBoxes) ? this._obstacleBoxes : [];
    if (!boxes.length) return null;
    const cand = [];
    for (const b0 of boxes) {
      if (!b0) continue;
      const b = b0;
      const cx = (b.min.x + b.max.x) * 0.5;
      const cz = (b.min.z + b.max.z) * 0.5;
      const sx = (b.max.x - b.min.x) * 0.5;
      const sz = (b.max.z - b.min.z) * 0.5;
      const off = 1.6;
      cand.push({ x: cx + sx + off, z: cz });
      cand.push({ x: cx - sx - off, z: cz });
      cand.push({ x: cx, z: cz + sz + off });
      cand.push({ x: cx, z: cz - sz - off });
    }
    let best = null;
    let bestScore = Infinity;
    for (const c of cand) {
      const x = c.x, z = c.z;
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      if (this._collidesAtRadius(x, 0, z, 0.35)) continue;
      // Prefer nearby
      const d = Math.hypot(x - ex, z - ez);
      if (d > 18) continue;
      // Must block LoS from cover to player (approx at eye height)
      const blocked = this._segmentBlocked(x, 1.45, z, px, 1.7, pz);
      if (!blocked) continue;
      if (d < bestScore) { bestScore = d; best = { x, z }; }
    }
    return best;
  },
};

