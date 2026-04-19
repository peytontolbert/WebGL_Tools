import * as THREE from 'three';

import {
  buildObstacleBoxesFromSources,
  filterResumeShowcaseColliderSources,
} from '../../../../shared/collision_world.js';
import { DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS } from '../../../../shared/room_sim_penthouse_defaults.js';

import {
  SCENE_DRIFT_TRACK_BUILDING_ASSET_PATH,
  SCENE_PENTHOUSE_BUILDING_ASSET_PATH,
} from '../scene_presets.js';

import { safeTrim, lerp } from '../core/scene_utils.js';

export const proceduralMixin = {
  async _loadProcedural(path, { scenario = null } = {}) {
    const p = safeTrim(path);
    const kind = p.toLowerCase().startsWith('proc:') ? safeTrim(p.slice('proc:'.length)).toLowerCase() : '';
    if (!kind) { this._setStatus('Unknown procedural kind. Try proc:arena, proc:drift_track, proc:resume_showcase, or proc:penthouse_room_sim'); return; }
    if (!this._scene || !this._camera) return;

    this._setStatus(`Generating: ${p}`);
    this._ctx?.log?.(`Scene: generating ${p}`);
    this._clearWorld();

    // Generate root
    const root = new THREE.Group();
    root.name = `procedural_${kind}`;
    this._obstacleSources = [];
    let spawnWasSet = false;
    /** @type {{ yaw?: number, pitch?: number, eyeH?: number }|null} */
    let defaultView = null;

    const mats = {
      floor: new THREE.MeshStandardMaterial({ color: 0x0d1420, roughness: 0.95, metalness: 0.0 }),
      wall: new THREE.MeshStandardMaterial({ color: 0x3d506b, roughness: 0.85, metalness: 0.0 }),
      prop: new THREE.MeshStandardMaterial({ color: 0x6b8bbd, roughness: 0.7, metalness: 0.0 }),
      accent: new THREE.MeshStandardMaterial({ color: 0xffd166, roughness: 0.65, metalness: 0.0, emissive: 0x241b05 }),
    };

    const _hashStr = (s) => {
      // Fast-ish deterministic hash for procedural styling.
      const str = String(s ?? '');
      let h = 2166136261 >>> 0; // FNV-1a
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return h >>> 0;
    };
    const _mulberry32 = (a) => {
      let t = (a >>> 0) || 0x12345678;
      return () => {
        t += 0x6D2B79F5;
        let x = t;
        x = Math.imul(x ^ (x >>> 15), x | 1);
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
      };
    };

    const _facadeTexCache = new Map(); // key -> CanvasTexture
    const _makeFacadeTexture = ({ seed = 1, variant = 'concrete', size = 128 } = {}) => {
      const key = `${seed}|${variant}|${size}`;
      const cached = _facadeTexCache.get(key);
      if (cached) return cached;

      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return null;

      const rng = _mulberry32((seed >>> 0) ^ _hashStr(variant));
      const base = (variant === 'brick') ? '#5a3b2f' : '#5a6372';
      const grime = (variant === 'brick') ? '#2a1a16' : '#131922';
      const line = (variant === 'brick') ? 'rgba(20,10,8,0.45)' : 'rgba(8,12,18,0.35)';
      const highlight = (variant === 'brick') ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.05)';

      ctx.fillStyle = base;
      ctx.fillRect(0, 0, size, size);

      // Subtle noise / grime.
      for (let i = 0; i < 2400; i++) {
        const x = (rng() * size) | 0;
        const y = (rng() * size) | 0;
        const a = 0.03 + rng() * 0.06;
        ctx.fillStyle = `rgba(0,0,0,${a.toFixed(3)})`;
        ctx.fillRect(x, y, 1, 1);
      }

      // Horizontal banding (reads as floors / concrete pours).
      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      for (let y = 0; y < size; y += (variant === 'brick' ? 10 : 12)) {
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(size, y + 0.5);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Simple "windows" pattern baked into the albedo (still cheap).
      const cols = 6;
      const rows = 6;
      const padX = 8;
      const padY = 10;
      const cellW = (size - padX * 2) / cols;
      const cellH = (size - padY * 2) / rows;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const x0 = padX + i * cellW;
          const y0 = padY + j * cellH;
          const wx = x0 + cellW * (0.18 + rng() * 0.04);
          const wy = y0 + cellH * (0.18 + rng() * 0.05);
          const ww = cellW * (0.62 + rng() * 0.02);
          const wh = cellH * (0.55 + rng() * 0.05);
          const lit = rng() < 0.22;
          ctx.fillStyle = lit ? 'rgba(180,210,255,0.16)' : 'rgba(30,40,55,0.16)';
          ctx.fillRect(wx, wy, ww, wh);
          ctx.strokeStyle = highlight;
          ctx.strokeRect(wx + 0.5, wy + 0.5, ww - 1, wh - 1);
        }
      }

      // Edge darkening.
      ctx.fillStyle = grime;
      ctx.globalAlpha = 0.12;
      ctx.fillRect(0, 0, size, 4);
      ctx.fillRect(0, size - 4, size, 4);
      ctx.fillRect(0, 0, 4, size);
      ctx.fillRect(size - 4, 0, 4, size);
      ctx.globalAlpha = 1;

      const tex = new THREE.CanvasTexture(canvas);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      _facadeTexCache.set(key, tex);
      return tex;
    };

    const _makeFacadeMaterial = ({ seed = 1, variant = 'concrete', tint = 0xffffff } = {}) => {
      const tex = _makeFacadeTexture({ seed, variant, size: 128 });
      const mat = new THREE.MeshStandardMaterial({
        color: Number(tint) || 0xffffff,
        roughness: (variant === 'brick') ? 0.92 : 0.88,
        metalness: 0.0,
        map: tex || null,
      });
      if (mat.map) {
        mat.map.repeat.set(1.6, 1.2);
      }
      return mat;
    };

    const addBox = ({ x, y, z, w, h, d, mat, name = '', collider = true, visible = true, castShadow = false, receiveShadow = true, parent = root }) => {
      const geo = new THREE.BoxGeometry(w, h, d);
      const m = new THREE.Mesh(geo, mat || mats.wall);
      if (name) m.name = name;
      m.position.set(x, y + h * 0.5, z);
      m.castShadow = !!castShadow;
      m.receiveShadow = !!receiveShadow;
      m.visible = (typeof visible === 'boolean') ? visible : !!visible;
      parent.add(m);
      if (collider) {
        m.userData = m.userData && typeof m.userData === 'object' ? m.userData : {};
        m.userData.isObstacle = true;
        this._obstacleSources.push(m);
      }
      return m;
    };

    const addFloor = ({ w, d, y = 0, mat, parent = root }) => {
      const geo = new THREE.PlaneGeometry(w, d, 1, 1);
      const m = new THREE.Mesh(geo, mat || mats.floor);
      m.rotation.x = -Math.PI * 0.5;
      m.position.set(0, y, 0);
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };

    if (kind === 'arena') {
      // CoD-ish blockout: open yard + 2 small buildings with rooms + cover (all axis-aligned boxes).
      const floorW = 78;
      const floorD = 78;
      addFloor({ w: floorW, d: floorD });

      const wallH = 4.2;
      const t = 0.8;

      const addWallX = ({ x0, x1, z, y = 0, h = wallH, thick = t, doorAt = null, doorW = 2.2, doorWCollide = null, mat = mats.wall, name = '', parent = root }) => {
        const len = Math.abs(x1 - x0);
        const cx = (x0 + x1) * 0.5;
        const zc = z;
        if (!doorAt) {
          addBox({ x: cx, y, z: zc, w: len, h, d: thick, mat, name, parent });
          return;
        }
        const da = Number(doorAt.x);
        const dw = Math.max(0.8, Number(doorWCollide ?? doorW) || 2.2);
        const left0 = x0;
        const left1 = da - dw * 0.5;
        const right0 = da + dw * 0.5;
        const right1 = x1;
        if (left1 - left0 > 0.2) addBox({ x: (left0 + left1) * 0.5, y, z: zc, w: (left1 - left0), h, d: thick, mat, name: name ? `${name}_L` : '', parent });
        if (right1 - right0 > 0.2) addBox({ x: (right0 + right1) * 0.5, y, z: zc, w: (right1 - right0), h, d: thick, mat, name: name ? `${name}_R` : '', parent });
      };

      const addWallZ = ({ z0, z1, x, y = 0, h = wallH, thick = t, doorAt = null, doorW = 2.2, doorWCollide = null, mat = mats.wall, name = '', parent = root }) => {
        const len = Math.abs(z1 - z0);
        const cz = (z0 + z1) * 0.5;
        const xc = x;
        if (!doorAt) {
          addBox({ x: xc, y, z: cz, w: thick, h, d: len, mat, name, parent });
          return;
        }
        const da = Number(doorAt.z);
        const dw = Math.max(0.8, Number(doorWCollide ?? doorW) || 2.2);
        const bot0 = z0;
        const bot1 = da - dw * 0.5;
        const top0 = da + dw * 0.5;
        const top1 = z1;
        if (bot1 - bot0 > 0.2) addBox({ x: xc, y, z: (bot0 + bot1) * 0.5, w: thick, h, d: (bot1 - bot0), mat, name: name ? `${name}_B` : '', parent });
        if (top1 - top0 > 0.2) addBox({ x: xc, y, z: (top0 + top1) * 0.5, w: thick, h, d: (top1 - top0), mat, name: name ? `${name}_T` : '', parent });
      };

      const addBuilding = ({ cx: worldCx, cz: worldCz, w, d, door = 'south', doorW = 2.4, wallMat = mats.wall, innerMat = mats.prop, roomWallT = 0.55, roomWallH = 3.2, name = 'bldg' }) => {
        // Wrap each building in a tagged group so devtools can select/edit it as one unit.
        const b = new THREE.Group();
        b.name = name;
        b.position.set(Number(worldCx) || 0, 0, Number(worldCz) || 0);
        b.userData = b.userData && typeof b.userData === 'object' ? b.userData : {};
        b.userData.projectTags = Array.isArray(b.userData.projectTags) ? b.userData.projectTags : ['buildings'];
        if (!Array.isArray(b.userData.projectTags)) b.userData.projectTags = ['buildings'];
        if (!b.userData.projectTags.some((x) => safeTrim(x).toLowerCase() === 'buildings')) b.userData.projectTags.push('buildings');
        b.userData.building = { kind: 'proc:arena', door, doorW, w, d };
        root.add(b);

        const cx = 0;
        const cz = 0;
        const x0 = cx - w * 0.5;
        const x1 = cx + w * 0.5;
        const z0 = cz - d * 0.5;
        const z1 = cz + d * 0.5;

        // Slightly richer per-building materials (still lightweight).
        const seed = _hashStr(name);
        const rng = _mulberry32(seed);
        const variant = (rng() < 0.45) ? 'brick' : 'concrete';
        const outerWallMat = (wallMat === mats.wall) ? _makeFacadeMaterial({
          seed,
          variant,
          tint: (variant === 'brick') ? 0xb07a66 : 0x9fb2c8,
        }) : wallMat;
        const trimMat = new THREE.MeshStandardMaterial({ color: 0x1a2230, roughness: 0.78, metalness: 0.02 });
        const roofMat = new THREE.MeshStandardMaterial({ color: 0x10151f, roughness: 0.92, metalness: 0.0 });

        // Outer shell with one door opening.
        // Keep collision opening close to visuals; use a tiny extra "skin" only.
        const doorWCollide = doorW + 0.14;
        addWallX({ x0, x1, z: z0, mat: outerWallMat, name: `${name}_north`, doorAt: (door === 'north') ? { x: cx } : null, doorW, doorWCollide, parent: b });
        addWallX({ x0, x1, z: z1, mat: outerWallMat, name: `${name}_south`, doorAt: (door === 'south') ? { x: cx } : null, doorW, doorWCollide, parent: b });
        addWallZ({ z0, z1, x: x0, mat: outerWallMat, name: `${name}_west`, doorAt: (door === 'west') ? { z: cz } : null, doorW, doorWCollide, parent: b });
        addWallZ({ z0, z1, x: x1, mat: outerWallMat, name: `${name}_east`, doorAt: (door === 'east') ? { z: cz } : null, doorW, doorWCollide, parent: b });

        // Door lintel so the doorway isn't "full-height".
        const doorH = 2.35;
        const lintelH = Math.max(0.75, wallH - doorH);
        const seamCover = 0.08; // small overlap to hide tiny seams at the opening edges
        // Make lintel visual-only: our collider system is 2.5D (no head/ceiling collision),
        // and a collidable lintel can cause "sticky" doorways when jumping.
        if (door === 'south') addBox({ x: cx, y: doorH, z: z1, w: doorW + seamCover, h: lintelH, d: t, mat: outerWallMat, name: `${name}_door_lintel`, collider: false, parent: b });
        if (door === 'north') addBox({ x: cx, y: doorH, z: z0, w: doorW + seamCover, h: lintelH, d: t, mat: outerWallMat, name: `${name}_door_lintel`, collider: false, parent: b });
        if (door === 'west') addBox({ x: x0, y: doorH, z: cz, w: t, h: lintelH, d: doorW + seamCover, mat: outerWallMat, name: `${name}_door_lintel`, collider: false, parent: b });
        if (door === 'east') addBox({ x: x1, y: doorH, z: cz, w: t, h: lintelH, d: doorW + seamCover, mat: outerWallMat, name: `${name}_door_lintel`, collider: false, parent: b });

        // Roof cap / parapet (non-collider, just visual).
        addBox({ x: cx, y: wallH, z: cz, w: w + 0.7, h: 0.35, d: d + 0.7, mat: roofMat, name: `${name}_roof`, collider: false, receiveShadow: true, parent: b });

        // Mid-band trim that helps the buildings read at FPS distances (non-collider).
        const bandY = 1.15;
        const bandH = 0.16;
        const bandOut = t * 0.6 + 0.06;
        const _addTrimStripX = ({ z, outwardSign, wallId, isDoorWall }) => {
          // Strip runs along X at a fixed Z.
          const zc = z + outwardSign * bandOut;
          const depth = 0.12;
          if (!isDoorWall) {
            addBox({ x: cx, y: bandY, z: zc, w: w + 0.35, h: bandH, d: depth, mat: trimMat, name: `${name}_trim_${wallId}`, collider: false, receiveShadow: true, parent: b });
            return;
          }
          // Split around the door opening so it doesn't "slice" the doorway.
          const gapPad = 0.14;
          const left0 = x0;
          const left1 = cx - doorW * 0.5 - gapPad;
          const right0 = cx + doorW * 0.5 + gapPad;
          const right1 = x1;
          if (left1 - left0 > 0.35) addBox({ x: (left0 + left1) * 0.5, y: bandY, z: zc, w: (left1 - left0) + 0.06, h: bandH, d: depth, mat: trimMat, name: `${name}_trim_${wallId}_L`, collider: false, receiveShadow: true, parent: b });
          if (right1 - right0 > 0.35) addBox({ x: (right0 + right1) * 0.5, y: bandY, z: zc, w: (right1 - right0) + 0.06, h: bandH, d: depth, mat: trimMat, name: `${name}_trim_${wallId}_R`, collider: false, receiveShadow: true, parent: b });
        };
        const _addTrimStripZ = ({ x, outwardSign, wallId, isDoorWall }) => {
          // Strip runs along Z at a fixed X.
          const xc = x + outwardSign * bandOut;
          const width = 0.12;
          if (!isDoorWall) {
            addBox({ x: xc, y: bandY, z: cz, w: width, h: bandH, d: d + 0.35, mat: trimMat, name: `${name}_trim_${wallId}`, collider: false, receiveShadow: true, parent: b });
            return;
          }
          const gapPad = 0.14;
          const bot0 = z0;
          const bot1 = cz - doorW * 0.5 - gapPad;
          const top0 = cz + doorW * 0.5 + gapPad;
          const top1 = z1;
          if (bot1 - bot0 > 0.35) addBox({ x: xc, y: bandY, z: (bot0 + bot1) * 0.5, w: width, h: bandH, d: (bot1 - bot0) + 0.06, mat: trimMat, name: `${name}_trim_${wallId}_B`, collider: false, receiveShadow: true, parent: b });
          if (top1 - top0 > 0.35) addBox({ x: xc, y: bandY, z: (top0 + top1) * 0.5, w: width, h: bandH, d: (top1 - top0) + 0.06, mat: trimMat, name: `${name}_trim_${wallId}_T`, collider: false, receiveShadow: true, parent: b });
        };

        _addTrimStripX({ z: z0, outwardSign: -1, wallId: 'n', isDoorWall: (door === 'north') });
        _addTrimStripX({ z: z1, outwardSign: 1, wallId: 's', isDoorWall: (door === 'south') });
        _addTrimStripZ({ x: x0, outwardSign: -1, wallId: 'w', isDoorWall: (door === 'west') });
        _addTrimStripZ({ x: x1, outwardSign: 1, wallId: 'e', isDoorWall: (door === 'east') });

        // Door frame + threshold (purely visual, hides small gaps/seams).
        try {
          const frameMat = new THREE.MeshStandardMaterial({ color: 0x0f141d, roughness: 0.72, metalness: 0.04 });
          const frameT = 0.10;
          const frameD = 0.14;
          const framePad = 0.02;
          const headerH = frameT;

          const addFrameSouthNorth = (isSouth) => {
            const wallOuterZ = (isSouth ? (z1 + t * 0.5) : (z0 - t * 0.5));
            const zf = wallOuterZ + (isSouth ? 1 : -1) * (frameD * 0.5 + framePad);
            const sideX = doorW * 0.5 + frameT * 0.5;
            // Posts
            addBox({ x: cx - sideX, y: 0, z: zf, w: frameT, h: doorH, d: frameD, mat: frameMat, name: `${name}_door_frame_postL`, collider: false, receiveShadow: true, parent: b });
            addBox({ x: cx + sideX, y: 0, z: zf, w: frameT, h: doorH, d: frameD, mat: frameMat, name: `${name}_door_frame_postR`, collider: false, receiveShadow: true, parent: b });
            // Header
            addBox({ x: cx, y: doorH - headerH, z: zf, w: doorW + frameT * 2.2, h: headerH, d: frameD, mat: frameMat, name: `${name}_door_frame_header`, collider: false, receiveShadow: true, parent: b });
            // Threshold step
            addBox({ x: cx, y: 0, z: zf + (isSouth ? -1 : 1) * 0.18, w: doorW + 0.2, h: 0.06, d: 0.36, mat: frameMat, name: `${name}_door_threshold`, collider: false, receiveShadow: true, parent: b });
          };

          const addFrameWestEast = (isEast) => {
            const wallOuterX = (isEast ? (x1 + t * 0.5) : (x0 - t * 0.5));
            const xf = wallOuterX + (isEast ? 1 : -1) * (frameD * 0.5 + framePad);
            const sideZ = doorW * 0.5 + frameT * 0.5;
            addBox({ x: xf, y: 0, z: cz - sideZ, w: frameD, h: doorH, d: frameT, mat: frameMat, name: `${name}_door_frame_postL`, collider: false, receiveShadow: true, parent: b });
            addBox({ x: xf, y: 0, z: cz + sideZ, w: frameD, h: doorH, d: frameT, mat: frameMat, name: `${name}_door_frame_postR`, collider: false, receiveShadow: true, parent: b });
            addBox({ x: xf, y: doorH - headerH, z: cz, w: frameD, h: headerH, d: doorW + frameT * 2.2, mat: frameMat, name: `${name}_door_frame_header`, collider: false, receiveShadow: true, parent: b });
            addBox({ x: xf + (isEast ? -1 : 1) * 0.18, y: 0, z: cz, w: 0.36, h: 0.06, d: doorW + 0.2, mat: frameMat, name: `${name}_door_threshold`, collider: false, receiveShadow: true, parent: b });
          };

          if (door === 'south') addFrameSouthNorth(true);
          if (door === 'north') addFrameSouthNorth(false);
          if (door === 'west') addFrameWestEast(false);
          if (door === 'east') addFrameWestEast(true);
        } catch { /* ignore */ }

        // Corner pilasters (hide seams, add depth; non-collider).
        try {
          const pilMat = new THREE.MeshStandardMaterial({ color: 0x121a26, roughness: 0.82, metalness: 0.02 });
          const p = 0.18;
          const out = t * 0.5 + 0.06;
          const corners = [
            { x: x0 - out, z: z0 - out, name: 'nw' },
            { x: x1 + out, z: z0 - out, name: 'ne' },
            { x: x0 - out, z: z1 + out, name: 'sw' },
            { x: x1 + out, z: z1 + out, name: 'se' },
          ];
          for (const c of corners) {
            addBox({ x: c.x, y: 0, z: c.z, w: p, h: wallH, d: p, mat: pilMat, name: `${name}_pil_${c.name}`, collider: false, receiveShadow: true, parent: b });
          }
        } catch { /* ignore */ }

        // Window cards (instanced planes, very cheap draw-call-wise).
        try {
          const winGeo = new THREE.PlaneGeometry(1, 1, 1, 1);
          const winMat = new THREE.MeshStandardMaterial({
            color: 0x0c111a,
            roughness: 0.22,
            metalness: 0.0,
            emissive: 0x18263a,
            emissiveIntensity: 0.35,
            transparent: true,
            opacity: 0.85,
          });
          winMat.depthWrite = false;
          const maxInst = 220;
          const wins = new THREE.InstancedMesh(winGeo, winMat, maxInst);
          wins.name = `${name}_windows`;
          wins.frustumCulled = true;
          b.add(wins);
          let wi = 0;
          const o = new THREE.Object3D();

          const addWin = (x, y, z, ry, sx, sy) => {
            if (wi >= maxInst) return;
            o.position.set(x, y, z);
            o.rotation.set(0, ry, 0);
            o.scale.set(sx, sy, 1);
            o.updateMatrix();
            wins.setMatrixAt(wi, o.matrix);
            wi++;
          };

          const placeWallWindowsX = ({ z, outwardZ, ry, isDoorWall }) => {
            const margin = 1.4;
            const start = x0 + margin;
            const end = x1 - margin;
            const span = Math.max(0.01, end - start);
            const n = Math.max(2, Math.floor(span / 3.1));
            const ww = Math.min(1.55, (span / n) * 0.70);
            const wh = 0.92;
            const rows = (wallH >= 4.0) ? 2 : 1;
            for (let r = 0; r < rows; r++) {
              const wy = (r === 0) ? 1.55 : 2.75;
              for (let i = 0; i < n; i++) {
                const x = lerp(start, end, (i + 0.5) / n);
                if (isDoorWall && Math.abs(x - cx) < doorW * 0.55 && wy < (doorH + 0.25)) continue;
                addWin(x, wy, z + outwardZ, ry, ww, wh);
              }
            }
          };

          const placeWallWindowsZ = ({ x, outwardX, ry, isDoorWall }) => {
            const margin = 1.4;
            const start = z0 + margin;
            const end = z1 - margin;
            const span = Math.max(0.01, end - start);
            const n = Math.max(2, Math.floor(span / 3.1));
            const ww = Math.min(1.55, (span / n) * 0.70);
            const wh = 0.92;
            const rows = (wallH >= 4.0) ? 2 : 1;
            for (let r = 0; r < rows; r++) {
              const wy = (r === 0) ? 1.55 : 2.75;
              for (let i = 0; i < n; i++) {
                const zc = lerp(start, end, (i + 0.5) / n);
                if (isDoorWall && Math.abs(zc - cz) < doorW * 0.55 && wy < (doorH + 0.25)) continue;
                // For west/east walls, we treat "ww" as width along Z.
                addWin(x + outwardX, wy, zc, ry, ww, wh);
              }
            }
          };

          const winOut = t * 0.55 + 0.08;
          placeWallWindowsX({ z: z0, outwardZ: -winOut, ry: Math.PI, isDoorWall: (door === 'north') });
          placeWallWindowsX({ z: z1, outwardZ: winOut, ry: 0, isDoorWall: (door === 'south') });
          placeWallWindowsZ({ x: x0, outwardX: -winOut, ry: -Math.PI * 0.5, isDoorWall: (door === 'west') });
          placeWallWindowsZ({ x: x1, outwardX: winOut, ry: Math.PI * 0.5, isDoorWall: (door === 'east') });

          wins.count = wi;
          wins.instanceMatrix.needsUpdate = true;
        } catch { /* ignore */ }

        // Interior: one cross-wall + one side room to create "open rooms"
        // Cross wall (with a gap) — like a hallway.
        const midX = cx + w * 0.10;
        const gapZ = cz;
        addWallZ({
          z0: z0 + 1.2, z1: z1 - 1.2,
          x: midX,
          h: roomWallH,
          thick: roomWallT,
          doorAt: { z: gapZ },
          doorW: 2.2,
          mat: innerMat,
          name: `${name}_innerA`,
          parent: b,
        });
        // Short wall to make a corner.
        addWallX({
          x0: x0 + 1.2, x1: midX - 1.0,
          z: cz - d * 0.15,
          h: roomWallH,
          thick: roomWallT,
          mat: innerMat,
          name: `${name}_innerB`,
          parent: b,
        });

        // Props inside: tables/crates
        addBox({ x: cx - 1.8, y: 0, z: cz - 1.2, w: 2.2, h: 0.9, d: 1.4, mat: mats.prop, name: `${name}_table`, parent: b });
        addBox({ x: cx + 2.2, y: 0, z: cz + 1.6, w: 1.2, h: 1.2, d: 1.2, mat: mats.accent, name: `${name}_crate`, parent: b });

        // “Ceiling lights” (emissive props + point lights) — helps rooms read.
        try {
          const lampGeo = new THREE.BoxGeometry(0.9, 0.12, 0.25);
          const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2c0, emissiveIntensity: 1.0, roughness: 0.25, metalness: 0.0 });
          for (const dz of [-d * 0.20, d * 0.18]) {
            const lamp = new THREE.Mesh(lampGeo, lampMat);
            lamp.position.set(cx, 3.2, cz + dz);
            b.add(lamp);
            const pl = new THREE.PointLight(0xfff2c0, 1.0, 12, 2);
            pl.position.set(cx, 3.0, cz + dz);
            b.add(pl);
          }
        } catch { /* ignore */ }
      };

      // Perimeter walls (big play space)
      const halfW = floorW * 0.5;
      const halfD = floorD * 0.5;
      addBox({ x: 0, y: 0, z: -halfD + t * 0.5, w: floorW, h: wallH, d: t, mat: mats.wall, name: 'perim_n' });
      addBox({ x: 0, y: 0, z: halfD - t * 0.5, w: floorW, h: wallH, d: t, mat: mats.wall, name: 'perim_s' });
      addBox({ x: -halfW + t * 0.5, y: 0, z: 0, w: t, h: wallH, d: floorD, mat: mats.wall, name: 'perim_w' });
      addBox({ x: halfW - t * 0.5, y: 0, z: 0, w: t, h: wallH, d: floorD, mat: mats.wall, name: 'perim_e' });

      // Buildings
      addBuilding({ cx: -16, cz: -6, w: 18, d: 14, door: 'south', name: 'bldg_alpha', wallMat: mats.wall, innerMat: mats.prop });
      addBuilding({ cx: 18, cz: 10, w: 20, d: 16, door: 'west', name: 'bldg_bravo', wallMat: mats.wall, innerMat: mats.prop });

      // Exterior cover blocks in yard
      addBox({ x: -4, y: 0, z: 14, w: 5.0, h: 1.6, d: 2.2, mat: mats.prop, name: 'cover_long' });
      addBox({ x: 8, y: 0, z: -12, w: 2.2, h: 1.2, d: 2.2, mat: mats.prop, name: 'cover_square' });
      addBox({ x: 0, y: 0, z: -22, w: 6.0, h: 1.4, d: 2.0, mat: mats.prop, name: 'cover_mid' });
      addBox({ x: 26, y: 0, z: -18, w: 2.0, h: 2.8, d: 2.0, mat: mats.accent, name: 'pillarA' });
      addBox({ x: -28, y: 0, z: 22, w: 2.0, h: 2.8, d: 2.0, mat: mats.accent, name: 'pillarB' });

      // A couple of streetlight-ish poles (visual landmarks)
      try {
        const poleMat = new THREE.MeshStandardMaterial({ color: 0x223046, roughness: 0.8, metalness: 0.0 });
        const poleGeo = new THREE.CylinderGeometry(0.10, 0.10, 4.8, 10, 1);
        const headGeo = new THREE.BoxGeometry(0.7, 0.25, 0.35);
        const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xdde8ff, emissiveIntensity: 0.6, roughness: 0.3, metalness: 0.0 });
        for (const p of [{ x: -10, z: 28 }, { x: 14, z: -28 }]) {
          const pole = new THREE.Mesh(poleGeo, poleMat);
          pole.position.set(p.x, 2.4, p.z);
          root.add(pole);
          const head = new THREE.Mesh(headGeo, headMat);
          head.position.set(p.x, 4.8, p.z);
          root.add(head);
          const pl = new THREE.PointLight(0xdde8ff, 0.9, 16, 2);
          pl.position.set(p.x, 4.4, p.z);
          root.add(pl);
        }
      } catch { /* ignore */ }
      // Arena defaults (if not overridden by a scenario)
      this._spawn = { x: 0, y: 0, z: 18 };
      spawnWasSet = true;
      defaultView = { yaw: Math.PI, pitch: -0.05, eyeH: 1.7 };
    } else if (kind === 'drift_track') {
      // Drift track is authored as a building JSON asset (like penthouse).
      try {
        this._scene.fog = new THREE.FogExp2(0x0a0f16, 0.0045);
        this._scene.background = new THREE.Color(0x0a0f16);
      } catch { /* ignore */ }

      const assetPath = safeTrim(scenario?.proc?.buildingAssetPath) || SCENE_DRIFT_TRACK_BUILDING_ASSET_PATH;
      let buildingMeta = null;
      try {
        const resp = await fetch('/' + assetPath.replace(/^\/+/, ''));
        const j = await resp.json().catch(() => null);
        buildingMeta = (j && typeof j === 'object') ? (j.building || null) : null;
      } catch { /* ignore */ }
      if (!buildingMeta || typeof buildingMeta !== 'object') {
        // Minimal fallback so generation still works if the asset is missing.
        buildingMeta = { kind: 'proc:drift_track' };
      }

      const bt = new THREE.Group();
      bt.name = 'blg_drift_track';
      bt.position.set(0, 0, 0);
      bt.userData = bt.userData && typeof bt.userData === 'object' ? bt.userData : {};
      bt.userData.projectTags = Array.isArray(bt.userData.projectTags) ? bt.userData.projectTags : ['buildings'];
      if (!bt.userData.projectTags.some((x) => safeTrim(x).toLowerCase() === 'buildings')) bt.userData.projectTags.push('buildings');
      bt.userData.buildingAssetPath = assetPath;
      bt.userData.building = { ...buildingMeta, kind: 'proc:drift_track' };
      root.add(bt);
      try { this._rebuildDriftTrackBuilding(bt); } catch { /* ignore */ }

      this._spawn = { x: 0, y: 0, z: 110 };
      spawnWasSet = true;
      defaultView = { yaw: Math.PI, pitch: -0.06, eyeH: 1.7 };
    } else if (kind === 'resume_showcase') {
      // Indoor sci-fi lab showcase with a central repository presentation platform.
      try {
        this._scene.fog = new THREE.FogExp2(0x050913, 0.012);
        this._scene.background = new THREE.Color(0x03060d);
        if (this._renderer) this._renderer.toneMappingExposure = 1.18;
      } catch { /* ignore */ }

      const MAX_RESUME_POINT_LIGHTS = 24;
      let resumePointLightCount = 0;
      const tryAddResumePointLight = (parent, light) => {
        if (!parent?.add || !light) return false;
        if (resumePointLightCount >= MAX_RESUME_POINT_LIGHTS) return false;
        parent.add(light);
        resumePointLightCount++;
        return true;
      };
      const tryAddResumeSpotLight = (parent, light) => {
        if (!parent?.add || !light) return false;
        if (resumePointLightCount >= MAX_RESUME_POINT_LIGHTS) return false;
        parent.add(light);
        resumePointLightCount++;
        return true;
      };

      const makeLabFloorTexture = ({ seed = 1, size = 512 } = {}) => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const cx = canvas.getContext('2d');
        if (!cx) return null;
        const rng = _mulberry32(0xabc100 + seed);
        cx.fillStyle = '#0b1322';
        cx.fillRect(0, 0, size, size);
        cx.strokeStyle = 'rgba(92,130,190,0.28)';
        cx.lineWidth = 2;
        for (let i = 0; i <= 8; i++) {
          const p = (size / 8) * i;
          cx.beginPath(); cx.moveTo(p, 0); cx.lineTo(p, size); cx.stroke();
          cx.beginPath(); cx.moveTo(0, p); cx.lineTo(size, p); cx.stroke();
        }
        for (let i = 0; i < 2200; i++) {
          const x = (rng() * size) | 0;
          const y = (rng() * size) | 0;
          const a = 0.015 + rng() * 0.04;
          cx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
          cx.fillRect(x, y, 1, 1);
        }
        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        return tex;
      };
      const makeLabWallTexture = ({ seed = 1, size = 512 } = {}) => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const cx = canvas.getContext('2d');
        if (!cx) return null;
        const rng = _mulberry32(0x90ff10 + seed);
        cx.fillStyle = '#101a2a';
        cx.fillRect(0, 0, size, size);
        const panel = size / 6;
        for (let gy = 0; gy < 6; gy++) {
          for (let gx = 0; gx < 6; gx++) {
            const x = gx * panel;
            const y = gy * panel;
            const t = (gx + gy) % 2 === 0 ? 0.06 : 0.11;
            cx.fillStyle = `rgba(28,43,66,${t.toFixed(3)})`;
            cx.fillRect(x + 2, y + 2, panel - 4, panel - 4);
            cx.strokeStyle = 'rgba(118,156,208,0.22)';
            cx.lineWidth = 1.5;
            cx.strokeRect(x + 3, y + 3, panel - 6, panel - 6);
            if (rng() > 0.55) {
              const px = x + panel * (0.2 + rng() * 0.55);
              const py = y + panel * (0.2 + rng() * 0.55);
              const pw = panel * (0.2 + rng() * 0.38);
              const ph = panel * (0.05 + rng() * 0.13);
              cx.fillStyle = `rgba(74,124,198,${(0.08 + rng() * 0.12).toFixed(3)})`;
              cx.fillRect(px, py, pw, ph);
            }
          }
        }
        for (let i = 0; i < 1800; i++) {
          const x = (rng() * size) | 0;
          const y = (rng() * size) | 0;
          const a = 0.015 + rng() * 0.045;
          cx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
          cx.fillRect(x, y, 1, 1);
        }
        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        return tex;
      };
      const makeLabSurfaceHeightTexture = ({ seed = 1, size = 512, panelSize = 8 } = {}) => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const cx = canvas.getContext('2d');
        if (!cx) return null;
        const rng = _mulberry32(0x6c0a00 + seed);
        cx.fillStyle = '#787878';
        cx.fillRect(0, 0, size, size);
        const step = Math.max(24, Math.floor(size / Math.max(2, panelSize)));
        for (let y = 0; y < size; y += step) {
          for (let x = 0; x < size; x += step) {
            const inset = 2 + ((rng() * 4) | 0);
            const w = Math.max(3, step - inset * 2);
            const h = Math.max(3, step - inset * 2);
            const lift = 110 + ((rng() * 36) | 0);
            cx.fillStyle = `rgb(${lift},${lift},${lift})`;
            cx.fillRect(x + inset, y + inset, w, h);
            const groove = 80 + ((rng() * 20) | 0);
            cx.strokeStyle = `rgb(${groove},${groove},${groove})`;
            cx.lineWidth = 1;
            cx.strokeRect(x + inset, y + inset, w, h);
          }
        }
        for (let i = 0; i < 3200; i++) {
          const x = (rng() * size) | 0;
          const y = (rng() * size) | 0;
          const n = 96 + ((rng() * 48) | 0);
          cx.fillStyle = `rgb(${n},${n},${n})`;
          cx.fillRect(x, y, 1, 1);
        }
        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.needsUpdate = true;
        return tex;
      };
      const makeLabEmissiveCircuitTexture = ({ seed = 1, size = 512 } = {}) => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const cx = canvas.getContext('2d');
        if (!cx) return null;
        const rng = _mulberry32(0x77aa00 + seed);
        cx.fillStyle = '#000000';
        cx.fillRect(0, 0, size, size);
        cx.strokeStyle = 'rgba(120,215,255,0.22)';
        cx.lineWidth = 2;
        for (let row = 0; row < 11; row++) {
          const y = (size / 11) * row + size / 22;
          cx.beginPath();
          cx.moveTo(0, y);
          let x = 0;
          while (x < size) {
            const seg = 18 + ((rng() * 54) | 0);
            cx.lineTo(Math.min(size, x + seg), y);
            x += seg + (8 + ((rng() * 26) | 0));
            if (x < size) cx.moveTo(x, y);
          }
          cx.stroke();
        }
        cx.fillStyle = 'rgba(160,232,255,0.34)';
        for (let i = 0; i < 140; i++) {
          const x = (rng() * size) | 0;
          const y = (rng() * size) | 0;
          cx.fillRect(x, y, 2, 2);
        }
        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        return tex;
      };
      const _applyLabTexOpts = (tex, repeatX, repeatY, isColor = true) => {
        if (!tex) return null;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        if (Number.isFinite(repeatX) && Number.isFinite(repeatY)) tex.repeat.set(repeatX, repeatY);
        if (isColor) tex.colorSpace = THREE.SRGBColorSpace;
        try {
          const maxAniso = Math.max(1, Number(this._renderer?.capabilities?.getMaxAnisotropy?.()) || 1);
          tex.anisotropy = Math.min(8, maxAniso);
        } catch { /* ignore */ }
        tex.needsUpdate = true;
        return tex;
      };

      const floorTex = makeLabFloorTexture({ seed: 7 });
      const floorBumpTex = makeLabSurfaceHeightTexture({ seed: 19, panelSize: 10 });
      const wallTex = makeLabWallTexture({ seed: 11 });
      const wallBumpTex = makeLabSurfaceHeightTexture({ seed: 31, panelSize: 7 });
      const wallEmissiveTex = makeLabEmissiveCircuitTexture({ seed: 23 });
      _applyLabTexOpts(floorTex, 4, 4, true);
      _applyLabTexOpts(floorBumpTex, 4, 4, false);
      _applyLabTexOpts(wallTex, 2.5, 2.0, true);
      _applyLabTexOpts(wallBumpTex, 2.5, 2.0, false);
      _applyLabTexOpts(wallEmissiveTex, 3.0, 2.4, true);
      const floorMat = new THREE.MeshStandardMaterial({
        color: 0x0a1323,
        roughness: 0.23,
        metalness: 0.34,
        map: floorTex || null,
        bumpMap: floorBumpTex || null,
        bumpScale: 0.08,
        emissive: 0x03070f,
        emissiveIntensity: 0.18,
      });
      const wallMat = new THREE.MeshStandardMaterial({
        color: 0x101a2d,
        roughness: 0.43,
        metalness: 0.39,
        map: wallTex || null,
        bumpMap: wallBumpTex || null,
        bumpScale: 0.12,
        emissive: 0x0a1729,
        emissiveMap: wallEmissiveTex || null,
        emissiveIntensity: 0.42,
      });
      const panelMat = new THREE.MeshStandardMaterial({ color: 0x19263c, roughness: 0.44, metalness: 0.28 });
      const trimMat = new THREE.MeshStandardMaterial({ color: 0x8fdde8, roughness: 0.07, metalness: 0.06, emissive: 0x22c4df, emissiveIntensity: 1.42 });
      const trimRedMat = new THREE.MeshStandardMaterial({ color: 0xd68a98, roughness: 0.07, metalness: 0.06, emissive: 0xd61f40, emissiveIntensity: 1.24 });
      const trimVioletMat = new THREE.MeshStandardMaterial({ color: 0xd6c8ff, roughness: 0.08, metalness: 0.06, emissive: 0x8f63ff, emissiveIntensity: 1.15 });
      const trimAmberMat = new THREE.MeshStandardMaterial({ color: 0xffd2a1, roughness: 0.12, metalness: 0.08, emissive: 0xff9654, emissiveIntensity: 0.95 });
      const hazardMat = new THREE.MeshStandardMaterial({ color: 0xffcb7f, roughness: 0.24, metalness: 0.14, emissive: 0x7d4a11, emissiveIntensity: 0.66 });
      const grateMat = new THREE.MeshStandardMaterial({ color: 0x1f2b40, roughness: 0.66, metalness: 0.25, emissive: 0x081120, emissiveIntensity: 0.35 });
      const resumeUser = safeTrim(scenario?.proc?.githubUser) || safeTrim(this._resumeShowcase?.githubUser) || 'peytontolbert';
      let showcaseRepos = [];
      try { showcaseRepos = await this._fetchResumeGithubRepos(resumeUser); } catch { /* ignore */ }
      const allRepos = Array.isArray(showcaseRepos) ? showcaseRepos.slice(0, 160) : [];
      if (!allRepos.length) allRepos.push({ name: 'webgl-game', description: 'Portfolio world', repoUrl: `https://github.com/${resumeUser}/webgl-game`, demoUrl: '', language: 'JavaScript', stars: 0 });

      // Gallery layout + room height sizing (5 repos per row; room grows taller as rows increase).
      const repoCols = 5;
      const repoXStep = 6.4;
      const repoYBase = 2.0;
      const repoYStep = 1.2;
      const repoCardH = 0.9;
      const repoBobAmp = 0.08;
      const repoPulseScaleMax = 1.18;
      const repoRows = Math.max(1, Math.ceil(allRepos.length / repoCols));
      const repoTopY = repoYBase + ((repoRows - 1) * repoYStep) + (repoCardH * 0.5 * repoPulseScaleMax) + repoBobAmp;
      const labWallH = Math.max(13.0, repoTopY + 1.4);
      const labCeilingY = labWallH - 0.2;
      const ceilingTrimY = labCeilingY - 0.25;

      const addTube = ({ x = 0, y = 0, z = 0, w = 0.2, h = 0.12, d = 2.0, mat = trimMat, c = 0x68dbff, i = 0.32, r = 4.5, name = 'tube', parent = root, addLight = true } = {}) => {
        addBox({ x, y, z, w, h, d, mat, collider: false, name, parent });
        try {
          if (!addLight) return;
          const pl = new THREE.PointLight(c, i, r, 2);
          pl.position.set(x, y + 0.06, z);
          tryAddResumePointLight(parent, pl);
        } catch { /* ignore */ }
      };
      const addCableBundle = ({ x0 = 0, z0 = 0, x1 = 0, z1 = 0, y = 10.8, drops = 3, color = 0x25344c } = {}) => {
        for (let i = 0; i < drops; i++) {
          try {
            const off = (i - (drops - 1) * 0.5) * 0.16;
            const p0 = new THREE.Vector3(x0 + off, y, z0 - off);
            const p1 = new THREE.Vector3((x0 + x1) * 0.5 + off * 0.4, y - 0.9 - Math.abs(off), (z0 + z1) * 0.5 - off * 0.4);
            const p2 = new THREE.Vector3(x1 + off, y, z1 - off);
            const curve = new THREE.QuadraticBezierCurve3(p0, p1, p2);
            const cable = new THREE.Mesh(
              new THREE.TubeGeometry(curve, 24, 0.045, 8, false),
              new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.06 }),
            );
            root.add(cable);
          } catch { /* ignore */ }
        }
      };
      const addDustMotes = ({ count = 550, minX = -29, maxX = 29, minZ = -29, maxZ = 29, minY = 1.5, maxY = 11.5 } = {}) => {
        try {
          const pos = new Float32Array(count * 3);
          for (let i = 0; i < count; i++) {
            pos[i * 3 + 0] = minX + Math.random() * (maxX - minX);
            pos[i * 3 + 1] = minY + Math.random() * (maxY - minY);
            pos[i * 3 + 2] = minZ + Math.random() * (maxZ - minZ);
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
          const mat = new THREE.PointsMaterial({
            color: 0x9fd8ff,
            size: 0.03,
            transparent: true,
            opacity: 0.22,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          });
          const points = new THREE.Points(geo, mat);
          points.onBeforeRender = () => {
            const tNow = performance.now() * 0.0003;
            points.rotation.y = tNow;
          };
          root.add(points);
        } catch { /* ignore */ }
      };
      const addScanBeam = ({ yTop = 10.7, yBottom = 1.04, radiusTop = 0.22, radiusBottom = 1.52 } = {}) => {
        try {
          const beamGroup = new THREE.Group();
          const beamH = Math.max(0.2, yTop - yBottom);
          const beamY = (yTop + yBottom) * 0.5;
          const BEAM_TAU = 6.28318530718;

          const makeBeamShader = ({
            color = new THREE.Color(0xf1f8ff),
            opacity = 0.24,
            fresnel = 1.8,
            bandStrength = 0.2,
            speed = 1.0,
            bloom = 0.0,
          } = {}) => new THREE.ShaderMaterial({
            uniforms: {
              uTime: { value: 0 },
              uColor: { value: color },
              uOpacity: { value: opacity },
              uFresnel: { value: fresnel },
              uBandStrength: { value: bandStrength },
              uSpeed: { value: speed },
              uBloom: { value: bloom },
            },
            vertexShader: `
              varying vec2 vUv;
              varying vec3 vNormalW;
              varying vec3 vViewDirW;
              void main() {
                vUv = uv;
                vec4 worldPos = modelMatrix * vec4(position, 1.0);
                vec3 worldNormal = normalize(mat3(modelMatrix) * normal);
                vNormalW = worldNormal;
                vViewDirW = normalize(cameraPosition - worldPos.xyz);
                gl_Position = projectionMatrix * viewMatrix * worldPos;
              }
            `,
            fragmentShader: `
              uniform float uTime;
              uniform vec3 uColor;
              uniform float uOpacity;
              uniform float uFresnel;
              uniform float uBandStrength;
              uniform float uSpeed;
              uniform float uBloom;
              varying vec2 vUv;
              varying vec3 vNormalW;
              varying vec3 vViewDirW;

              void main() {
                float y = clamp(vUv.y, 0.0, 1.0);
                float edge = pow(1.0 - abs(vUv.x - 0.5) * 2.0, 1.45);
                float fres = pow(1.0 - max(dot(normalize(vNormalW), normalize(vViewDirW)), 0.0), uFresnel);
                float angular = 0.72 + 0.28 * sin((vUv.x * ${BEAM_TAU} * 22.0) + (uTime * (0.9 + uSpeed * 0.35)));
                float angular2 = 0.72 + 0.28 * sin((vUv.x * ${BEAM_TAU} * 37.0) - (uTime * (1.2 + uSpeed * 0.22)));

                float sweepA = sin((y * 17.0) - (uTime * (2.2 + uSpeed)));
                float sweepB = sin((y * 23.0) + (uTime * (1.6 + uSpeed * 0.6)));
                float bands = (0.5 + 0.5 * sweepA) * (0.4 + 0.6 * (0.5 + 0.5 * sweepB));
                bands = mix(1.0, bands, clamp(uBandStrength, 0.0, 1.0));
                bands *= mix(1.0, angular * angular2, clamp(uBandStrength, 0.0, 1.0));

                float verticalFade = smoothstep(0.0, 0.12, y) * (1.0 - smoothstep(0.82, 1.0, y));
                // Slight readability notch around repo-screen height to reduce washout.
                float readabilityNotch = 1.0 - (0.34 * exp(-pow((y - 0.42) / 0.11, 2.0)));
                float pulse = 0.78 + 0.22 * sin(uTime * 2.6 + y * 6.0 + vUv.x * ${BEAM_TAU} * 2.0);

                float alpha = uOpacity * edge * verticalFade * readabilityNotch * (0.55 + 0.75 * fres) * (0.75 + 0.55 * bands) * pulse;
                vec3 col = uColor * (0.7 + fres * (0.9 + uBloom));
                gl_FragColor = vec4(col, alpha);
              }
            `,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
          });

          const outerBeam = new THREE.Mesh(
            new THREE.CylinderGeometry(radiusTop, radiusBottom, beamH, 128, 2, true),
            makeBeamShader({
              color: new THREE.Color(0xf0f7ff),
              opacity: 0.14,
              fresnel: 1.65,
              bandStrength: 0.36,
              speed: 1.18,
              bloom: 0.3,
            }),
          );
          outerBeam.position.set(0, beamY, 0);
          beamGroup.add(outerBeam);

          const midBeam = new THREE.Mesh(
            new THREE.CylinderGeometry(radiusTop * 0.73, radiusBottom * 0.68, beamH * 0.99, 112, 2, true),
            makeBeamShader({
              color: new THREE.Color(0xf6fbff),
              opacity: 0.18,
              fresnel: 1.95,
              bandStrength: 0.28,
              speed: 1.44,
              bloom: 0.56,
            }),
          );
          midBeam.position.set(0, beamY, 0);
          beamGroup.add(midBeam);

          const coreBeam = new THREE.Mesh(
            new THREE.CylinderGeometry(radiusTop * 0.48, radiusBottom * 0.44, beamH * 0.98, 96, 2, true),
            makeBeamShader({
              color: new THREE.Color(0xffffff),
              opacity: 0.24,
              fresnel: 2.35,
              bandStrength: 0.2,
              speed: 1.9,
              bloom: 0.95,
            }),
          );
          coreBeam.position.set(0, beamY, 0);
          beamGroup.add(coreBeam);

          const hotCore = new THREE.Mesh(
            new THREE.CylinderGeometry(radiusTop * 0.17, radiusBottom * 0.13, beamH * 0.92, 72, 1, true),
            makeBeamShader({
              color: new THREE.Color(0xffffff),
              opacity: 0.1,
              fresnel: 2.7,
              bandStrength: 0.08,
              speed: 2.2,
              bloom: 1.05,
            }),
          );
          hotCore.position.set(0, beamY, 0);
          beamGroup.add(hotCore);

          const baseHalo = new THREE.Mesh(
            new THREE.RingGeometry(radiusBottom * 0.74, radiusBottom * 2.45, 96),
            new THREE.MeshBasicMaterial({
              color: 0xeaf5ff,
              transparent: true,
              opacity: 0.17,
              depthWrite: false,
              side: THREE.DoubleSide,
              blending: THREE.AdditiveBlending,
            }),
          );
          baseHalo.position.set(0, yBottom + 0.025, 0);
          baseHalo.rotation.x = -Math.PI * 0.5;
          beamGroup.add(baseHalo);

          const sparkleCount = 120;
          const sparkleGeo = new THREE.BufferGeometry();
          const sparklePos = new Float32Array(sparkleCount * 3);
          const sparkleSeeds = new Float32Array(sparkleCount);
          for (let i = 0; i < sparkleCount; i++) {
            sparklePos[i * 3 + 0] = (Math.random() - 0.5) * radiusBottom * 2.2;
            sparklePos[i * 3 + 1] = yBottom + Math.random() * beamH;
            sparklePos[i * 3 + 2] = (Math.random() - 0.5) * radiusBottom * 2.2;
            sparkleSeeds[i] = Math.random();
          }
          sparkleGeo.setAttribute('position', new THREE.BufferAttribute(sparklePos, 3));
          const sparkleMat = new THREE.PointsMaterial({
            color: 0xf6fbff,
            size: 0.045,
            transparent: true,
            opacity: 0.26,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          });
          const sparkles = new THREE.Points(sparkleGeo, sparkleMat);
          beamGroup.add(sparkles);

          beamGroup.onBeforeRender = () => {
            const tNow = performance.now() * 0.001;
            const pulse = 0.89 + 0.11 * Math.sin(tNow * 2.0);
            beamGroup.rotation.y = Math.sin(tNow * 0.62) * 0.12;
            beamGroup.rotation.x = Math.sin(tNow * 0.58) * 0.012;
            beamGroup.rotation.z = Math.cos(tNow * 0.51) * 0.012;
            beamGroup.position.x = Math.sin(tNow * 0.78) * 0.055;
            beamGroup.position.z = Math.cos(tNow * 0.74) * 0.055;
            outerBeam.material.uniforms.uTime.value = tNow;
            outerBeam.material.uniforms.uOpacity.value = 0.12 * pulse;
            midBeam.material.uniforms.uTime.value = tNow * 1.09;
            midBeam.material.uniforms.uOpacity.value = 0.16 * (0.93 + 0.07 * Math.sin(tNow * 2.3 + 0.18));
            coreBeam.material.uniforms.uTime.value = tNow * 1.23;
            coreBeam.material.uniforms.uOpacity.value = 0.2 * (0.92 + 0.08 * Math.sin(tNow * 2.85 + 0.5));
            hotCore.material.uniforms.uTime.value = tNow * 1.55;
            hotCore.material.uniforms.uOpacity.value = 0.08 * (0.88 + 0.12 * Math.sin(tNow * 3.9 + 0.8));
            baseHalo.material.opacity = 0.13 + 0.08 * (0.5 + 0.5 * Math.sin(tNow * 2.4));
            baseHalo.scale.setScalar(0.96 + 0.09 * (0.5 + 0.5 * Math.sin(tNow * 1.85)));
            const p = sparkles.geometry?.attributes?.position;
            if (p?.array) {
              const arr = p.array;
              for (let i = 0; i < sparkleCount; i++) {
                const seed = sparkleSeeds[i];
                const rise = (tNow * (0.85 + seed * 1.3) + seed * 6.0) % beamH;
                const r = (radiusBottom * 0.2) + (radiusTop * (0.2 + 0.62 * (rise / beamH)));
                const a = (seed * BEAM_TAU * 5.0) + (tNow * (0.6 + seed));
                arr[i * 3 + 0] = Math.cos(a) * r * (0.08 + seed * 0.12);
                arr[i * 3 + 1] = yBottom + rise;
                arr[i * 3 + 2] = Math.sin(a) * r * (0.08 + seed * 0.12);
              }
              p.needsUpdate = true;
            }
            sparkleMat.opacity = 0.14 + 0.11 * (0.5 + 0.5 * Math.sin(tNow * 2.0));
          };
          root.add(beamGroup);
        } catch { /* ignore */ }
      };
      const addStarCeilingWindow = ({ y = 10.0, w = 62.0, d = 62.0, border = 0.0 } = {}) => {
        try {
          const frameMat = new THREE.MeshStandardMaterial({
            color: 0x1a2538,
            roughness: 0.52,
            metalness: 0.32,
            emissive: 0x0a1426,
            emissiveIntensity: 0.36,
          });
          if (border > 0.0) {
            addBox({ x: 0, y: y + 0.03, z: -((d * 0.5) + (border * 0.5)), w: w + border * 2.0, h: 0.12, d: border, mat: frameMat, collider: false, name: 'ceiling_starframe_n' });
            addBox({ x: 0, y: y + 0.03, z: (d * 0.5) + (border * 0.5), w: w + border * 2.0, h: 0.12, d: border, mat: frameMat, collider: false, name: 'ceiling_starframe_s' });
            addBox({ x: -((w * 0.5) + (border * 0.5)), y: y + 0.03, z: 0, w: border, h: 0.12, d: d, mat: frameMat, collider: false, name: 'ceiling_starframe_w' });
            addBox({ x: (w * 0.5) + (border * 0.5), y: y + 0.03, z: 0, w: border, h: 0.12, d: d, mat: frameMat, collider: false, name: 'ceiling_starframe_e' });
          }

          const starMat = new THREE.ShaderMaterial({
            uniforms: {
              uTime: { value: 0 },
            },
            vertexShader: `
              varying vec2 vUv;
              varying vec3 vNormalW;
              varying vec3 vViewDirW;
              void main() {
                vUv = uv;
                vec4 worldPos = modelMatrix * vec4(position, 1.0);
                vNormalW = normalize(mat3(modelMatrix) * normal);
                vViewDirW = normalize(cameraPosition - worldPos.xyz);
                gl_Position = projectionMatrix * viewMatrix * worldPos;
              }
            `,
            fragmentShader: `
              uniform float uTime;
              varying vec2 vUv;
              varying vec3 vNormalW;
              varying vec3 vViewDirW;

              float hash21(vec2 p) {
                p = fract(p * vec2(123.34, 456.21));
                p += dot(p, p + 45.32);
                return fract(p.x * p.y);
              }

              float starField(vec2 uv, float scale, float density, float t) {
                vec2 p = uv * scale;
                vec2 id = floor(p);
                vec2 gv = fract(p) - 0.5;
                float n = hash21(id);
                float n2 = hash21(id + 13.7);
                float mask = step(1.0 - density, n);
                vec2 ofs = vec2(n - 0.5, n2 - 0.5) * 0.72;
                float d = length(gv - ofs);
                float core = smoothstep(0.05, 0.0, d);
                float halo = smoothstep(0.18, 0.0, d) * 0.28;
                float twinkle = 0.72 + 0.28 * sin((t * (1.1 + n * 2.1)) + (n * 31.4));
                return (core + halo) * mask * twinkle;
              }

              void main() {
                vec2 uv = vUv;
                vec2 p = uv * 2.0 - 1.0;

                float drift = uTime * 0.004;
                float s1 = starField(uv + vec2(drift * 0.4, 0.0), 95.0, 0.045, uTime);
                float s2 = starField(uv + vec2(-drift * 0.8, drift * 0.2), 62.0, 0.06, uTime * 1.2);
                float s3 = starField(uv + vec2(drift * 1.3, -drift * 0.7), 38.0, 0.085, uTime * 1.5);
                float stars = s1 * 0.8 + s2 * 1.0 + s3 * 1.25;

                float galBand = exp(-pow((p.y * 0.75) + sin(p.x * 2.8) * 0.12, 2.0) * 5.0);
                float haze = 0.08 * galBand;
                vec3 spaceBase = mix(vec3(0.01, 0.018, 0.04), vec3(0.025, 0.04, 0.08), 1.0 - clamp(length(p) * 0.75, 0.0, 1.0));
                vec3 galaxy = vec3(0.08, 0.1, 0.18) * haze + vec3(0.05, 0.08, 0.14) * (haze * 0.7);

                vec3 starCol = vec3(0.92, 0.97, 1.0) * stars;
                float warmTint = smoothstep(0.58, 1.0, fract(stars * 7.0));
                starCol += vec3(0.18, 0.08, 0.02) * stars * 0.2 * warmTint;

                float fres = pow(1.0 - max(dot(normalize(vNormalW), normalize(vViewDirW)), 0.0), 2.3);
                vec3 glassSheen = vec3(0.08, 0.14, 0.24) * fres * 0.35;

                vec3 col = spaceBase + galaxy + starCol + glassSheen;
                gl_FragColor = vec4(col, 1.0);
              }
            `,
            side: THREE.DoubleSide,
          });

          const starPlane = new THREE.Mesh(new THREE.PlaneGeometry(w, d, 1, 1), starMat);
          starPlane.rotation.x = -Math.PI * 0.5;
          starPlane.position.set(0, y, 0);
          starPlane.onBeforeRender = () => {
            starMat.uniforms.uTime.value = performance.now() * 0.001;
          };
          root.add(starPlane);

          // Subtle pane reflection to sell the "glass to space" look.
          const glassPane = new THREE.Mesh(
            new THREE.PlaneGeometry(w, d, 1, 1),
            new THREE.MeshPhysicalMaterial({
              color: 0x9fc7ff,
              transparent: true,
              opacity: 0.06,
              roughness: 0.08,
              metalness: 0.0,
              transmission: 0.92,
              thickness: 0.2,
              clearcoat: 0.9,
              clearcoatRoughness: 0.12,
              depthWrite: false,
              side: THREE.DoubleSide,
            }),
          );
          glassPane.rotation.x = -Math.PI * 0.5;
          glassPane.position.set(0, y - 0.018, 0);
          root.add(glassPane);
        } catch { /* ignore */ }
      };

      addFloor({ w: 64, d: 64, mat: floorMat });
      addBox({ x: 0, y: 0, z: -31.5, w: 64, h: labWallH, d: 1.0, mat: wallMat, name: 'lab_wall_n' });
      addBox({ x: 0, y: 0, z: 31.5, w: 64, h: labWallH, d: 1.0, mat: wallMat, name: 'lab_wall_s' });
      addBox({ x: -31.5, y: 0, z: 0, w: 1.0, h: labWallH, d: 64, mat: wallMat, name: 'lab_wall_w' });
      addBox({ x: 31.5, y: 0, z: 0, w: 1.0, h: labWallH, d: 64, mat: wallMat, name: 'lab_wall_e' });
      addBox({ x: 0, y: labCeilingY, z: 0, w: 64, h: 0.6, d: 64, mat: wallMat, name: 'lab_ceiling', collider: false });
      addStarCeilingWindow({ y: labCeilingY - 0.29, w: 62.0, d: 62.0, border: 0.0 });
      addTube({ x: 0, y: ceilingTrimY, z: -30.9, w: 62.5, d: 0.24, mat: trimMat, c: 0x2cc6e8, i: 0.48, r: 7.4, name: 'ceiling_trim_n' });
      addTube({ x: 0, y: ceilingTrimY, z: 30.9, w: 62.5, d: 0.24, mat: trimRedMat, c: 0xe12e52, i: 0.48, r: 7.4, name: 'ceiling_trim_s' });
      addTube({ x: -30.9, y: ceilingTrimY, z: 0, w: 0.24, d: 62.5, mat: trimRedMat, c: 0xe12e52, i: 0.48, r: 7.4, name: 'ceiling_trim_w', addLight: false });
      addTube({ x: 30.9, y: ceilingTrimY, z: 0, w: 0.24, d: 62.5, mat: trimMat, c: 0x2cc6e8, i: 0.48, r: 7.4, name: 'ceiling_trim_e', addLight: false });
      // Floor neon underglow removed per art direction.
      for (let i = -2; i <= 2; i++) {
        const y = 2.0 + i * 2.15;
        addTube({ x: -30.82, y, z: 0, w: 0.08, d: 61.8, mat: trimRedMat, c: 0xe12e52, i: 0.2, r: 4.6, name: 'wall_neon_w', addLight: false });
        addTube({ x: 30.82, y, z: 0, w: 0.08, d: 61.8, mat: trimMat, c: 0x27c1e3, i: 0.2, r: 4.6, name: 'wall_neon_e', addLight: false });
      }
      // Wall paneling and trim break up large black planes.
      for (let i = -3; i <= 3; i++) {
        const x = i * 8.6;
      }
      for (let i = -3; i <= 3; i++) {
        const z = i * 8.6;
        addBox({ x: -30.86, y: 0.18, z, w: 0.1, h: labWallH - 0.65, d: 0.22, mat: panelMat, collider: false, name: 'wall_panel_w_col' });
        addBox({ x: 30.86, y: 0.18, z, w: 0.1, h: labWallH - 0.65, d: 0.22, mat: panelMat, collider: false, name: 'wall_panel_e_col' });
      }
      for (const y of [2.2, 5.7, 8.9]) {
        addBox({ x: -30.82, y, z: 0, w: 0.14, h: 0.14, d: 61.6, mat: grateMat, collider: false, name: 'wall_band_w' });
        addBox({ x: 30.82, y, z: 0, w: 0.14, h: 0.14, d: 61.6, mat: grateMat, collider: false, name: 'wall_band_e' });
      }
      // Floor lane lights removed per art direction (and to avoid “random blocks” on the ground).

      // Central presentation platform + overhead ring scanner.
      const platformGlowMats = [];
      const platformLights = [];
      const platformMotionLights = [];
      const stageBaseMat = new THREE.MeshStandardMaterial({ color: 0x233247, roughness: 0.36, metalness: 0.35 });
      const stageGlowMat = new THREE.MeshStandardMaterial({ color: 0xbbefff, roughness: 0.1, metalness: 0.06, emissive: 0x46ccff, emissiveIntensity: 1.05 });
      platformGlowMats.push(stageGlowMat);
      const stageBase = new THREE.Mesh(new THREE.CylinderGeometry(4.8, 5.4, 1.25, 56, 1), stageBaseMat);
      stageBase.position.set(0, 0.62, 0);
      stageBase.castShadow = true;
      stageBase.receiveShadow = true;
      root.add(stageBase);
      // Collider-only box (keep it invisible so it doesn’t read as a stray block).
      addBox({ x: 0, y: 0, z: 0, w: 8.2, h: 1.3, d: 8.2, mat: stageBaseMat, name: 'lab_platform_collider', visible: false });
      const stageInner = new THREE.Mesh(new THREE.CylinderGeometry(2.9, 3.2, 0.35, 52, 1), stageGlowMat);
      stageInner.position.set(0, 1.08, 0);
      stageInner.receiveShadow = true;
      root.add(stageInner);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2.0;
        const x = Math.cos(a) * 5.6;
        const z = Math.sin(a) * 5.6;
        const isX = Math.abs(Math.cos(a)) > Math.abs(Math.sin(a));
        addTube({
          x: x * 0.6,
          y: 0.34,
          z: z * 0.6,
          w: isX ? 9.8 : 0.34,
          d: isX ? 0.34 : 9.8,
          mat: (i % 2 === 0) ? trimMat : trimRedMat,
          c: (i % 2 === 0) ? 0x2cc6e8 : 0xe12e52,
          i: 0.38,
          r: 6.4,
          name: 'power_tube',
        });
      }

      const ringFlowMat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uGlow: { value: 1.0 },
        },
        vertexShader: `
          varying vec2 vUv;
          varying vec3 vNormalW;
          varying vec3 vViewDirW;
          void main() {
            vUv = uv;
            vec4 worldPos = modelMatrix * vec4(position, 1.0);
            vec3 worldNormal = normalize(mat3(modelMatrix) * normal);
            vNormalW = worldNormal;
            vViewDirW = normalize(cameraPosition - worldPos.xyz);
            gl_Position = projectionMatrix * viewMatrix * worldPos;
          }
        `,
        fragmentShader: `
          uniform float uTime;
          uniform float uGlow;
          varying vec2 vUv;
          varying vec3 vNormalW;
          varying vec3 vViewDirW;

          vec3 palette(float t) {
            vec3 a = vec3(0.54, 0.28, 0.72);
            vec3 b = vec3(0.38, 0.45, 0.28);
            vec3 c = vec3(1.0, 1.0, 1.0);
            vec3 d = vec3(0.05, 0.33, 0.67);
            return a + b * cos(6.28318 * (c * t + d));
          }

          void main() {
            float flow = fract(vUv.x * 2.9 - uTime * 0.24);
            float flow2 = fract(vUv.x * 4.6 + uTime * 0.33 + vUv.y * 0.7);
            float scan = smoothstep(0.08, 0.45, flow) * (1.0 - smoothstep(0.55, 0.95, flow));
            float stripe = smoothstep(0.30, 1.0, sin((vUv.x * 90.0) - (uTime * 3.8)));
            float fres = pow(1.0 - max(dot(normalize(vNormalW), normalize(vViewDirW)), 0.0), 1.7);
            vec3 colA = palette(flow + uTime * 0.06);
            vec3 colB = palette(flow2 + 0.37);
            vec3 neon = mix(colA, colB, 0.48 + 0.35 * stripe);
            float alpha = (0.42 + 0.42 * scan + 0.28 * stripe + fres * 0.55) * (0.7 + uGlow * 0.5);
            gl_FragColor = vec4(neon * (0.6 + fres * 0.9 + scan * 0.55), alpha);
          }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const overheadRing = null;
      try {
        const pl = new THREE.PointLight(0x93e4ff, 1.25, 28, 2);
        pl.position.set(0, 10.8, 0);
        pl.userData = { ...(pl.userData || {}), baseIntensity: 1.25, repoReactive: false };
        if (tryAddResumePointLight(root, pl)) platformLights.push(pl);
      } catch { /* ignore */ }
      addScanBeam();
      try {
        const holoOrb = new THREE.Mesh(
          new THREE.TorusGeometry(1.9, 0.07, 16, 70),
          new THREE.MeshBasicMaterial({ color: 0x8de3ff, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending }),
        );
        holoOrb.position.set(0, 2.65, 0);
        holoOrb.onBeforeRender = () => {
          const tNow = performance.now() * 0.001;
          holoOrb.rotation.x = tNow * 1.15;
          holoOrb.rotation.y = tNow * 0.95;
          holoOrb.material.opacity = 0.32 + 0.35 * (0.5 + 0.5 * Math.sin(tNow * 2.2));
        };
        root.add(holoOrb);
      } catch { /* ignore */ }

      // Cinematic lighting rig (key/fill/rim) around the presentation stage.
      try {
        const keyTarget = new THREE.Object3D();
        keyTarget.position.set(0, 1.5, 0);
        root.add(keyTarget);
        const key = new THREE.SpotLight(0xcbe8ff, 1.7, 62, Math.PI * 0.18, 0.52, 1.08);
        key.position.set(0, 15.6, 12.2);
        key.target = keyTarget;
        key.castShadow = true;
        key.shadow.mapSize.set(2048, 2048);
        key.shadow.bias = -0.00006;
        key.shadow.normalBias = 0.018;
        key.shadow.radius = 3.2;
        key.userData = { ...(key.userData || {}), baseIntensity: 1.7, repoReactive: false };
        if (tryAddResumeSpotLight(root, key)) {
          platformLights.push(key);
          platformMotionLights.push({
            light: key,
            target: keyTarget,
            pos: key.position.clone(),
            targetBase: keyTarget.position.clone(),
            speed: 0.38,
            phase: 0.0,
            swayX: 1.35,
            swayZ: 0.92,
            bobY: 0.28,
            targetX: 0.34,
            targetZ: 0.26,
            intensitySwing: 0.12,
          });
        }
        const fillTarget = new THREE.Object3D();
        fillTarget.position.set(0.15, 1.45, 0.1);
        root.add(fillTarget);
        const fill = new THREE.SpotLight(0x8bc8ff, 1.05, 54, Math.PI * 0.28, 0.62, 1.25);
        fill.position.set(9.8, 10.8, 8.8);
        fill.target = fillTarget;
        fill.userData = { ...(fill.userData || {}), baseIntensity: 1.05, repoReactive: false };
        if (tryAddResumeSpotLight(root, fill)) {
          platformLights.push(fill);
          platformMotionLights.push({
            light: fill,
            target: fillTarget,
            pos: fill.position.clone(),
            targetBase: fillTarget.position.clone(),
            speed: 0.31,
            phase: 1.27,
            swayX: 0.8,
            swayZ: 0.55,
            bobY: 0.18,
            targetX: 0.21,
            targetZ: 0.18,
            intensitySwing: 0.08,
          });
        }
        const rimTarget = new THREE.Object3D();
        rimTarget.position.set(-0.2, 1.6, -0.08);
        root.add(rimTarget);
        const rim = new THREE.SpotLight(0xff8fa3, 0.86, 52, Math.PI * 0.24, 0.58, 1.28);
        rim.position.set(-12.2, 10.6, -10.0);
        rim.target = rimTarget;
        rim.userData = { ...(rim.userData || {}), baseIntensity: 0.86, repoReactive: false };
        if (tryAddResumeSpotLight(root, rim)) {
          platformLights.push(rim);
          platformMotionLights.push({
            light: rim,
            target: rimTarget,
            pos: rim.position.clone(),
            targetBase: rimTarget.position.clone(),
            speed: 0.27,
            phase: 2.3,
            swayX: 0.72,
            swayZ: 0.62,
            bobY: 0.14,
            targetX: 0.2,
            targetZ: 0.22,
            intensitySwing: 0.06,
          });
        }
      } catch { /* ignore */ }

      // Repository presentation pedestal + screen.
      addBox({ x: 0, y: 1.15, z: 0, w: 1.6, h: 1.9, d: 1.6, mat: panelMat, collider: false, castShadow: true, receiveShadow: true, name: 'repo_pedestal' });
      const screenCanvas = document.createElement('canvas');
      screenCanvas.width = 1024;
      screenCanvas.height = 512;
      const screenCtx = screenCanvas.getContext('2d');
      const screenTex = new THREE.CanvasTexture(screenCanvas);
      screenTex.colorSpace = THREE.SRGBColorSpace;
      const screenMat = new THREE.MeshBasicMaterial({ map: screenTex, transparent: false, side: THREE.DoubleSide, depthWrite: true });
      const repoScreen = new THREE.Mesh(new THREE.PlaneGeometry(5.6, 2.6), screenMat);
      repoScreen.position.set(0, 4.6, -1.25);
      repoScreen.lookAt(0, 4.6, 8.0);
      repoScreen.renderOrder = 4;
      root.add(repoScreen);
      addTube({ x: 0, y: 3.2, z: -1.18, w: 5.9, d: 0.18, mat: trimMat, c: 0x2cc6e8, i: 0.32, r: 6.5, name: 'repo_screen_bar' });
      repoScreen.onBeforeRender = () => {
        const rt = this._resumeShowcase?.runtime;
        const tNow = performance.now() * 0.001;
        const fx = Math.max(0, Number(rt?.fxKick || 0));
        if (rt) rt.fxKick = Math.max(0, fx * 0.92 - 0.02);
        const wobble = 1.0 + Math.sin(tNow * 2.5) * 0.02;
        const pop = 1.0 + fx * 0.18;
        repoScreen.scale.set(wobble * pop, wobble * pop, 1);
      };
      const makeShowcaseChipMaterial = ({ title, subtitle = 'repository' } = {}) => {
        const c = document.createElement('canvas');
        c.width = 512;
        c.height = 160;
        const cx = c.getContext('2d');
        if (!cx) return new THREE.MeshBasicMaterial({ color: 0x8fd8ff, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false });
        const nm = safeTrim(title) || 'Card';
        const sub = safeTrim(subtitle) || 'repository';
        const grad = cx.createLinearGradient(0, 0, c.width, c.height);
        grad.addColorStop(0, 'rgba(8,18,36,0.95)');
        grad.addColorStop(1, 'rgba(20,34,58,0.95)');
        cx.fillStyle = grad;
        cx.fillRect(0, 0, c.width, c.height);
        cx.strokeStyle = 'rgba(125,227,255,0.95)';
        cx.lineWidth = 6;
        cx.strokeRect(10, 10, c.width - 20, c.height - 20);
        cx.fillStyle = '#96eaff';
        cx.font = '700 36px system-ui, sans-serif';
        cx.textAlign = 'center';
        cx.textBaseline = 'middle';
        cx.fillText(nm.length > 24 ? `${nm.slice(0, 21)}...` : nm, c.width * 0.5, c.height * 0.44);
        cx.fillStyle = '#b9ccff';
        cx.font = '500 19px system-ui, sans-serif';
        cx.fillText(sub.length > 44 ? `${sub.slice(0, 41)}...` : sub, c.width * 0.5, c.height * 0.72);
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        return new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false });
      };
      const makeRepoChipMaterial = (repo, idx) => {
        const nm = safeTrim(repo?.name) || `Repo ${idx + 1}`;
        const lang = safeTrim(repo?.language);
        const stars = Number(repo?.stars || 0);
        const subtitle = [lang, `stars ${stars}`].filter(Boolean).join(' • ') || 'repository';
        return makeShowcaseChipMaterial({ title: nm, subtitle });
      };

      // Keep room shell simple (4 room walls + floor + ceiling only).
      // Foreground floating wall UI layer (integrated, scanline-like holograms).
      const mkHoloDisplay = (label, tint = 0x6adfff, x = 0, y = 8.8) => {
        try {
          const c = document.createElement('canvas');
          c.width = 640;
          c.height = 240;
          const cx = c.getContext('2d');
          if (!cx) return;
          const tex = new THREE.CanvasTexture(c);
          tex.colorSpace = THREE.SRGBColorSpace;
          const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.72, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
          const m = new THREE.Mesh(new THREE.PlaneGeometry(5.8, 2.0), mat);
          m.position.set(x, y, -27.62);
          m.onBeforeRender = () => {
            const tNow = performance.now() * 0.001;
            cx.clearRect(0, 0, c.width, c.height);
            cx.fillStyle = 'rgba(12,18,32,0.18)';
            cx.fillRect(0, 0, c.width, c.height);
            cx.strokeStyle = `#${(tint >>> 0).toString(16).padStart(6, '0')}`;
            cx.lineWidth = 4;
            cx.strokeRect(8, 8, c.width - 16, c.height - 16);
            cx.fillStyle = 'rgba(150,232,255,0.92)';
            cx.font = '700 46px system-ui, sans-serif';
            cx.fillText(label, 24, 58);
            cx.strokeStyle = 'rgba(140,220,255,0.55)';
            for (let i = 0; i < 6; i++) {
              const yy = 96 + i * 22;
              cx.beginPath();
              cx.moveTo(20, yy);
              cx.lineTo(620, yy + Math.sin((tNow * 3.2) + i * 0.9) * 7);
              cx.stroke();
            }
            // Micro glitch band.
            if (Math.sin(tNow * 6.2 + x * 0.2) > 0.94) {
              cx.fillStyle = 'rgba(255,255,255,0.12)';
              cx.fillRect(0, 112 + (Math.sin(tNow * 32.0) * 18), c.width, 6);
            }
            tex.needsUpdate = true;
            m.position.z = -27.62 + Math.sin(tNow * 1.35 + x * 0.12) * 0.06;
          };
          root.add(m);
        } catch { /* ignore */ }
      };
      // Side columns only: keep holograms off the repo grid.
      mkHoloDisplay('REPO MATRIX', 0x6adfff, -24.8, 9.5);
      mkHoloDisplay('SYSTEM TELEMETRY', 0xdf3555, 24.8, 8.8);
      const mkTokyoNeonSign = (label, x = 0, y = 7.0, z = -27.5, tintA = '#43d3ee', tintB = '#de3556') => {
        try {
          const c = document.createElement('canvas');
          c.width = 640;
          c.height = 220;
          const cx = c.getContext('2d');
          if (!cx) return;
          const tex = new THREE.CanvasTexture(c);
          tex.colorSpace = THREE.SRGBColorSpace;
          const mat = new THREE.MeshBasicMaterial({
            map: tex,
            transparent: true,
            opacity: 0.88,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
          });
          const panel = new THREE.Mesh(new THREE.PlaneGeometry(4.9, 1.65), mat);
          panel.position.set(x, y, z);
          panel.onBeforeRender = () => {
            const tNow = performance.now() * 0.001;
            cx.clearRect(0, 0, c.width, c.height);
            const grad = cx.createLinearGradient(0, 0, c.width, c.height);
            grad.addColorStop(0, 'rgba(8,18,36,0.62)');
            grad.addColorStop(1, 'rgba(20,10,38,0.62)');
            cx.fillStyle = grad;
            cx.fillRect(0, 0, c.width, c.height);
            cx.strokeStyle = tintA;
            cx.lineWidth = 5;
            cx.strokeRect(10, 10, c.width - 20, c.height - 20);
            cx.strokeStyle = tintB;
            cx.lineWidth = 2;
            cx.strokeRect(20, 20, c.width - 40, c.height - 40);
            cx.fillStyle = tintA;
            cx.font = '700 54px system-ui, sans-serif';
            cx.textAlign = 'center';
            cx.textBaseline = 'middle';
            cx.shadowColor = tintB;
            cx.shadowBlur = 24 + (Math.sin(tNow * 4.0 + x * 0.2) * 10);
            cx.fillText(label, c.width * 0.5, c.height * 0.5);
            cx.shadowBlur = 0;
            tex.needsUpdate = true;
            panel.position.z = z + Math.sin(tNow * 1.5 + x * 0.1) * 0.08;
          };
          root.add(panel);
        } catch { /* ignore */ }
      };

      // Left control monitor cluster.
      const makeMonitorMat = (title) => {
        const c = document.createElement('canvas');
        c.width = 640;
        c.height = 384;
        const cx = c.getContext('2d');
        if (!cx) return { mat: new THREE.MeshBasicMaterial({ color: 0x6bd8ff }), tex: null, ctx: null, canvas: null, title };
        cx.fillStyle = 'rgba(8,18,32,0.95)';
        cx.fillRect(0, 0, c.width, c.height);
        cx.strokeStyle = '#59d7ff';
        cx.lineWidth = 6;
        cx.strokeRect(8, 8, c.width - 16, c.height - 16);
        cx.fillStyle = '#7ae8ff';
        cx.font = '700 42px system-ui, sans-serif';
        cx.fillText(title, 28, 56);
        cx.strokeStyle = 'rgba(99,226,255,0.65)';
        for (let i = 0; i < 6; i++) {
          cx.beginPath();
          cx.moveTo(28, 100 + i * 40);
          cx.lineTo(612, 100 + i * 40 + (Math.sin(i * 1.7) * 18));
          cx.stroke();
        }
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        return {
          mat: new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true, depthWrite: false }),
          tex,
          ctx: cx,
          canvas: c,
          title,
        };
      };
      for (const m of [
        { x: -25.8, y: 3.1, z: -7.2, t: 'RADAR' },
        { x: -25.8, y: 5.7, z: -3.2, t: 'DIAGNOSTICS' },
        { x: -25.8, y: 3.3, z: 1.1, t: 'DATA FEED' },
      ]) {
        const mm = makeMonitorMat(m.t);
        const mon = new THREE.Mesh(new THREE.PlaneGeometry(4.8, 2.6), mm.mat);
        mon.position.set(m.x, m.y, m.z);
        mon.rotation.y = Math.PI * 0.5;
        if (mm?.ctx && mm?.tex && mm?.canvas) {
          mon.userData.__tLab = 0;
          mon.onBeforeRender = () => {
            const tNow = performance.now() * 0.001;
            if ((tNow - (mon.userData.__tLab || 0)) < 0.08) return;
            mon.userData.__tLab = tNow;
            const cx = mm.ctx;
            const cw = mm.canvas.width;
            const ch = mm.canvas.height;
            cx.fillStyle = 'rgba(8,18,32,0.33)';
            cx.fillRect(0, 0, cw, ch);
            cx.fillStyle = '#7ae8ff';
            cx.font = '700 42px system-ui, sans-serif';
            cx.fillText(mm.title, 28, 56);
            cx.strokeStyle = 'rgba(99,226,255,0.68)';
            for (let i = 0; i < 5; i++) {
              const yy = 98 + i * 48;
              cx.beginPath();
              cx.moveTo(28, yy);
              cx.lineTo(612, yy + Math.sin((tNow * 2.0) + i * 1.2) * 20);
              cx.stroke();
            }
            mm.tex.needsUpdate = true;
          };
        }
        root.add(mon);
      }

      // Control consoles for cycling/opening repositories.
      for (const c of [
        { x: -4.8, z: 9.4, label: 'PREV [', mat: trimRedMat, col: 0xe12e52 },
        { x: 0.0, z: 9.4, label: 'OPEN E', mat: trimMat, col: 0x2cc6e8 },
        { x: 4.8, z: 9.4, label: 'NEXT ]', mat: trimMat, col: 0x2cc6e8 },
      ]) {
        addBox({ x: c.x, y: 0, z: c.z, w: 2.3, h: 1.5, d: 1.8, mat: panelMat, collider: false, name: 'control_console' });
        addTube({ x: c.x, y: 1.58, z: c.z, w: 1.9, d: 0.16, mat: c.mat, c: c.col, i: 0.36, r: 4.2, name: 'console_led' });
        const cc = document.createElement('canvas');
        cc.width = 512;
        cc.height = 128;
        const cx = cc.getContext('2d');
        if (cx) {
          cx.fillStyle = 'rgba(8,18,32,0.94)'; cx.fillRect(0, 0, cc.width, cc.height);
          cx.fillStyle = '#a6ecff'; cx.font = '700 56px system-ui, sans-serif'; cx.textAlign = 'center'; cx.textBaseline = 'middle';
          cx.fillText(c.label, cc.width * 0.5, cc.height * 0.5);
          const tex = new THREE.CanvasTexture(cc); tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
          const label = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.45), new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
          label.position.set(c.x, 1.98, c.z + 0.02);
          label.rotation.x = -Math.PI * 0.18;
          root.add(label);
        }
      }

      const galleryCards = [];
      try {
        // Fixed 5-column gallery; grow upward with additional rows.
        const wallZ = -30.86;
        const cols = repoCols;
        const xStep = repoXStep;
        const yBase = repoYBase;
        const yStep = repoYStep;
        const xStart = -((cols - 1) * xStep) * 0.5;
        for (let i = 0; i < allRepos.length; i++) {
          const row = (i / cols) | 0;
          const col = i % cols;
          const x = xStart + col * xStep;
          const y = yBase + row * yStep;
          const z = wallZ;
          const card = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 0.9), makeRepoChipMaterial(allRepos[i], i));
          card.position.set(x, y, z);
          card.rotation.y = 0;
          card.userData.repoIndex = i;
          card.userData.baseY = y;
          card.userData.phase = (i * 0.37) % (Math.PI * 2.0);
          card.onBeforeRender = () => {
            const rt = this._resumeShowcase?.runtime;
            if (!rt) return;
            const tNow = performance.now() * 0.001;
            const active = Number(rt.activeIndex) || 0;
            const myIdx = Number(card.userData.repoIndex);
            const isActive = myIdx === active;
            const fx = Math.max(0, Number(rt.fxKick || 0));
            const activeBoost = isActive ? 1.12 : 1.0;
            const focusBoost = (rt.fxFocusIndex === myIdx) ? (1.0 + fx * 0.65) : 1.0;
            card.visible = true;
            const pulse = 0.94 + 0.06 * (0.5 + 0.5 * Math.sin(tNow * 2.0 + Number(card.userData.phase || 0)));
            const s = pulse * focusBoost * activeBoost;
            card.scale.set(s, s, s);
            card.position.y = Number(card.userData.baseY || y) + Math.sin(tNow * 1.6 + Number(card.userData.phase || 0)) * 0.08;
          };
          root.add(card);
          galleryCards.push(card);
        }
      } catch { /* ignore */ }
      try {
        const websiteCards = [
          { name: 'Trained LLM', subtitle: 'huggingface.co', x: -13.0, z: 30.86, triggerZ: 27.8 },
          { name: 'Calisthenics App', subtitle: 'calicombos.com', x: -7.8, z: 30.86, triggerZ: 27.8 },
          { name: 'Agentic DEX', subtitle: 'dex.swarms.world', x: -2.6, z: 30.86, triggerZ: 27.8 },
          { name: 'MCP Search Tool', subtitle: 'mcpsearchtool.com', x: 2.6, z: 30.86, triggerZ: 27.8 },
          { name: 'CreateNow', subtitle: 'createnow.xyz', x: 7.8, z: 30.86, triggerZ: 27.8 },
          { name: 'Bddy', subtitle: 'bddy.io', x: 13.0, z: 30.86, triggerZ: 27.8 },
        ];
        for (let i = 0; i < websiteCards.length; i += 1) {
          const card = websiteCards[i];
          const mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(2.8, 0.9),
            makeShowcaseChipMaterial({ title: card.name, subtitle: card.subtitle }),
          );
          mesh.position.set(Number(card.x) || 0, 1.9, Number(card.z) || 30.86);
          mesh.rotation.y = Math.PI;
          mesh.userData.baseY = 1.9;
          mesh.userData.phase = (i * 0.42) % (Math.PI * 2.0);
          mesh.onBeforeRender = () => {
            const tNow = performance.now() * 0.001;
            const pulse = 0.96 + 0.06 * (0.5 + 0.5 * Math.sin(tNow * 2.0 + Number(mesh.userData.phase || 0)));
            const s = pulse;
            mesh.scale.set(s, s, s);
            mesh.position.y = Number(mesh.userData.baseY || 1.9) + Math.sin(tNow * 1.6 + Number(mesh.userData.phase || 0)) * 0.06;
          };
          root.add(mesh);
          addTube({
            x: Number(card.x) || 0,
            y: 1.15,
            z: Number(card.triggerZ) || 27.8,
            w: 1.85,
            h: 0.08,
            d: 0.12,
            mat: trimVioletMat,
            c: 0x9f76ff,
            i: 0.2,
            r: 2.6,
            name: 'website_card_led',
          });
        }
      } catch { /* ignore */ }

      this._resumeShowcase.runtime = {
        repos: allRepos,
        activeIndex: 0,
        screenCanvas,
        screenCtx,
        screenTex,
        repoScreen,
        galleryCards,
        fxKick: 0,
        fxFocusIndex: -1,
        platformGlowMats,
        platformLights,
        platformMotionLights,
        ringFlowMat,
      };
      this._resumeShowcase.cycleSelection = (dir) => this._cycleResumeShowcaseSelection(dir);
      this._resumeShowcase.showCurrentRepo = () => this._showCurrentResumeShowcaseRepo();
      this._refreshResumeShowcaseSelection({ showMsg: false, openPanel: false });
      this._showMsg('Lab controls: E on PREV / OPEN / NEXT • [ ] cycle • Enter opens • gallery sync active', 6.0);
      addDustMotes();
      addCableBundle({ x0: -28.8, z0: -28.5, x1: 28.8, z1: -28.5, y: 10.9, drops: 4, color: 0x263851 });
      addCableBundle({ x0: -26.4, z0: -8.0, x1: -26.4, z1: 7.0, y: 10.4, drops: 3, color: 0x2a3c55 });

      // Gentle animation to make the scanner ring feel alive.
      const animatePlatformLights = () => {
        const tNow = performance.now() * 0.001;
        ringFlowMat.uniforms.uTime.value = tNow;
        ringFlowMat.uniforms.uGlow.value = 0.9 + 0.2 * (0.5 + 0.5 * Math.sin(tNow * 2.4));
        for (const cfg of platformMotionLights) {
          const light = cfg?.light;
          const target = cfg?.target;
          if (!light || !cfg?.pos || !cfg?.targetBase || !target) continue;
          const tt = tNow * Number(cfg.speed || 0.35) + Number(cfg.phase || 0);
          light.position.x = cfg.pos.x + Math.sin(tt) * Number(cfg.swayX || 0);
          light.position.z = cfg.pos.z + Math.cos(tt * 0.9) * Number(cfg.swayZ || 0);
          light.position.y = cfg.pos.y + Math.sin(tt * 1.35) * Number(cfg.bobY || 0);
          target.position.x = cfg.targetBase.x + Math.sin(tt * 0.72) * Number(cfg.targetX || 0);
          target.position.z = cfg.targetBase.z + Math.cos(tt * 0.78) * Number(cfg.targetZ || 0);
          const baseI = Number(light.userData?.baseIntensity || light.intensity || 1);
          const swing = Number(cfg.intensitySwing || 0.08);
          light.intensity = baseI * (1.0 + swing * Math.sin(tt * 1.4 + 0.2));
        }
      };
      if (overheadRing) {
        overheadRing.onBeforeRender = () => {
          const tNow = performance.now() * 0.001;
          overheadRing.rotation.z = Math.sin(tNow * 0.35) * 0.07;
          animatePlatformLights();
        };
      }
      stageInner.onBeforeRender = () => {
        const tNow = performance.now() * 0.001;
        stageInner.material.emissiveIntensity = 0.84 + 0.45 * (0.5 + 0.5 * Math.sin(tNow * 2.2));
        trimMat.emissiveIntensity = 1.2 + 0.55 * (0.5 + 0.5 * Math.sin(tNow * 1.95));
        trimRedMat.emissiveIntensity = 1.02 + 0.5 * (0.5 + 0.5 * Math.sin(tNow * 2.3 + 0.8));
        trimVioletMat.emissiveIntensity = 0.95 + 0.42 * (0.5 + 0.5 * Math.sin(tNow * 1.7 + 1.2));
        trimAmberMat.emissiveIntensity = 0.72 + 0.3 * (0.5 + 0.5 * Math.sin(tNow * 2.9 + 0.2));
        wallMat.emissiveIntensity = 0.22 + 0.2 * (0.5 + 0.5 * Math.sin(tNow * 0.9));
        if (!overheadRing) animatePlatformLights();
      };

      this._spawn = { x: 0, y: 0, z: 20 };
      spawnWasSet = true;
      defaultView = { yaw: 0, pitch: -0.04, eyeH: 1.7 };
    } else if (kind === 'penthouse_room_sim') {
      // Data-driven penthouse: load params from building JSON (editable in Buildings tool),
      // optionally overridden by the saved scenario.
      const assetPath = safeTrim(scenario?.proc?.buildingAssetPath) || SCENE_PENTHOUSE_BUILDING_ASSET_PATH;
      let buildingMeta = null;
      try {
        const resp = await fetch('/' + assetPath.replace(/^\/+/, ''));
        const j = await resp.json().catch(() => null);
        buildingMeta = (j && typeof j === 'object') ? (j.building || null) : null;
      } catch { /* ignore */ }
      if (!buildingMeta || typeof buildingMeta !== 'object') {
        buildingMeta = DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS;
      }

      const b = new THREE.Group();
      b.name = 'blg_room_sim_penthouse';
      b.position.set(0, 0, 0);
      b.userData = b.userData && typeof b.userData === 'object' ? b.userData : {};
      b.userData.projectTags = Array.isArray(b.userData.projectTags) ? b.userData.projectTags : ['buildings'];
      if (!b.userData.projectTags.some((x) => safeTrim(x).toLowerCase() === 'buildings')) b.userData.projectTags.push('buildings');
      b.userData.buildingAssetPath = assetPath;
      b.userData.building = { ...buildingMeta, kind: 'proc:penthouse_room_sim' };
      root.add(b);

      try { this._rebuildRoomSimPenthouseBuilding(b); } catch { /* ignore */ }

      // Default spawn (can be overridden by scenario pose).
      this._spawn = { x: 8, y: 0, z: 0 };
      spawnWasSet = true;
      defaultView = { yaw: Math.PI * 0.5, pitch: -0.05, eyeH: 1.7 };
    } else {
      addFloor({ w: 40, d: 40 });
    }

    this._scene.add(root);
    this._proc = { kind, root };
    this._worldRoot = root;
    this._colliders = [root];
    if (kind === 'resume_showcase') {
      // Capture a "raw" obstacle set (includes center platform collider) for the autonomous walker.
      // Player collision in resume_showcase is intentionally wall-only (filtered below).
      try {
        this._resumeWalkerNav.sources = Array.isArray(this._obstacleSources) ? this._obstacleSources.slice() : [];
        this._resumeWalkerNav.boxes = buildObstacleBoxesFromSources({ sources: this._resumeWalkerNav.sources, worldRoot: root });
        const boxes = Array.isArray(this._resumeWalkerNav.boxes) ? this._resumeWalkerNav.boxes : [];
        if (boxes.length) {
          let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
          for (const b of boxes) {
            if (!b?.min || !b?.max) continue;
            const x0 = Number(b.min.x); const x1 = Number(b.max.x);
            const z0 = Number(b.min.z); const z1 = Number(b.max.z);
            if (!Number.isFinite(x0) || !Number.isFinite(x1) || !Number.isFinite(z0) || !Number.isFinite(z1)) continue;
            if (x0 < minX) minX = x0;
            if (x1 > maxX) maxX = x1;
            if (z0 < minZ) minZ = z0;
            if (z1 > maxZ) maxZ = z1;
          }
          if (Number.isFinite(minX) && Number.isFinite(maxX) && Number.isFinite(minZ) && Number.isFinite(maxZ)) {
            this._resumeWalkerNav.bounds = { minX, maxX, minZ, maxZ };
          } else {
            this._resumeWalkerNav.bounds = null;
          }
        } else {
          this._resumeWalkerNav.bounds = null;
        }
      } catch { /* ignore */ }
      this._obstacleSources = filterResumeShowcaseColliderSources(this._obstacleSources);
    }
    try { this._rebuildObstacleBoxesFromSources(); } catch { /* ignore */ }

    // Default spawn if the generator didn't choose one.
    if (!spawnWasSet) this._spawn = { x: 0, y: 0, z: 18 };
    // Resume export UX: spawn near the first interact trigger so "Press E" works immediately
    // (and users don't need to load a saved scenario just to get interactions).
    try {
      const isResumeExport = !!globalThis.__resumeShowcase;
      if (isResumeExport && kind === 'resume_showcase' && !scenario) {
        this._spawn = { x: 0, y: 0, z: 9.4 };
      }
    } catch { /* ignore */ }

    // Apply scenario pose/settings if provided.
    if (scenario && typeof scenario === 'object') {
      try { this._applyScenarioPose(scenario); } catch { /* ignore */ }
      // Resume showcase: never spawn on top of the center platform.
      try {
        if (kind === 'resume_showcase') {
          // Force floor Y (the showroom floor is y=0).
          this._spawn.y = 0;
          this._player.y = 0;
          // If a saved scenario put spawn near the stage, push it back to the entry.
          const px = Number(this._player.x) || 0;
          const pz = Number(this._player.z) || 0;
          if (Math.hypot(px, pz) < 9.0) {
            this._spawn.x = 0; this._spawn.y = 0; this._spawn.z = 20;
            this._player.x = this._spawn.x;
            this._player.y = this._spawn.y;
            this._player.z = this._spawn.z;
            this._player.vy = 0;
          }
        }
      } catch { /* ignore */ }
    } else {
      this._player.x = this._spawn.x;
      this._player.y = this._spawn.y;
      this._player.z = this._spawn.z;
      this._player.vy = 0;
      this._scenarioContent = { waypoints: [], triggers: [], meta: { avatarProfile: '', avatarAction: '' } };
      this._avatar3p.forcedActionKey = '';
      // When generating procedurally (no scenario), reset view so you don't inherit a weird camera rotation.
      this._applyFpsCameraPose({
        yaw: Number.isFinite(Number(defaultView?.yaw)) ? Number(defaultView.yaw) : 0,
        pitch: Number.isFinite(Number(defaultView?.pitch)) ? Number(defaultView.pitch) : 0,
        eyeH: Number.isFinite(Number(defaultView?.eyeH)) ? Number(defaultView.eyeH) : (Number(this._player.eyeH) || 1.7),
        syncPosition: true,
      });
    }
    if (kind === 'resume_showcase') {
      try { await this._seedResumeShowcaseContent({ scenario }); } catch { /* ignore */ }
      // Hard guarantee: resume showcase needs interact triggers. If seeding failed (and got swallowed),
      // ensure we still have a working set of triggers.
      try {
        const trigs = Array.isArray(this._scenarioContent?.triggers) ? this._scenarioContent.triggers : [];
        if (!trigs.length) await this._seedResumeShowcaseContent({ scenario: null });
      } catch { /* ignore */ }
    }
    if (kind === 'resume_showcase') {
      try { void this._loadResumeShowcaseWalker({ force: true }); } catch { /* ignore */ }
    }

    // Orbit target
    this._orbit?.target?.set?.(0, 1, 0);

    // Camera placement
    if (this._state.mode === 'orbit') {
      this._camera.position.set(18, 12, 18);
      this._orbit?.update?.();
    } else {
      // Respect on-foot camera mode (first/third) even before pointer lock.
      try { this._applyPlayerCameraBasePose(this._playerCamMode); } catch { /* ignore */ }
    }

    this._syncSpawnMarker();
    this._renderWaypointsUi();
    this._renderTriggersUi();
    this._rebuildScenarioDebug();
    this._scanTaggedBuildings();
    this._renderBuildingsUi();
    this._renderBuildingEditorUi();

    // Enable combat demo gameplay only for arena.
    this._game.enabled = (kind === 'arena');
    if (this._game.enabled) {
      this._resetGame();
      this._buildNavGrid();
      this._spawnDefaultEnemies();
      this._spawnDefaultVehicles();
      this._showMsg('Mission: eliminate all targets');
      this._ensureGunRig();
    }

    this._setStatus(`Generated: ${p}`);
    if (this._state.autoPlayAfterLoad && this._state.mode === 'fps') {
      this._tryPointerLock('auto_play_after_procedural_load');
    }
  },
};

