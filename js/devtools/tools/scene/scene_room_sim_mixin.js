import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

import { safeTrim, disposeThreeObject } from './core/scene_utils.js';

import { clipByAliases } from './characters/character_anim_utils.js';

export const sceneRoomSimMixin = {
  _disposeRoomSimPeople() {
    const st = this._roomSimPeople;
    if (!st) return;
    try { if (st.group && st.group.parent) st.group.parent.remove(st.group); } catch { /* ignore */ }
    try { disposeThreeObject(st.group); } catch { /* ignore */ }
    try { disposeThreeObject(st.templateRoot); } catch { /* ignore */ }
    st.group = null;
    st.templateUrl = '';
    st.templateGltf = null;
    st.templateRoot = null;
    st.templateClips = [];
    st.loading = false;
    st.people = [];
  },

  _findPenthouseBuildingGroup() {
    const root = this._worldRoot;
    if (!root) return null;
    let hit = null;
    try {
      root.traverse?.((o) => {
        if (hit) return;
        const ud = o?.userData;
        const kind = safeTrim(ud?.building?.kind);
        if (kind === 'proc:penthouse_room_sim') hit = o;
        else if (safeTrim(o?.name) === 'blg_room_sim_penthouse') hit = o;
      });
    } catch { /* ignore */ }
    return hit;
  },

  _applyRoomSimSpawnMarkerVisibility() {
    const pent = this._findPenthouseBuildingGroup();
    if (!pent) return;
    const hide = !!this._roomSim?.enabled && !!this._roomSim?.hideSpawnMarkers;
    try {
      pent.traverse?.((o) => {
        const kk = safeTrim(o?.userData?.partKind);
        if (kk === 'agent_spawn') {
          try { o.visible = !hide; } catch { /* ignore */ }
        }
      });
    } catch { /* ignore */ }
  },

  async _ensureRoomSimTemplateLoaded({ force = false } = {}) {
    const st = this._roomSimPeople;
    if (!st) return false;
    const raw = safeTrim(this._roomSim?.url || '').replace(/\\/g, '/');
    if (!raw) return false;
    const url = (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('/')) ? raw : ('/' + raw.replace(/^\/+/, ''));
    if (!force && st.templateRoot && safeTrim(st.templateUrl) === url) return true;
    if (st.loading) return false;
    st.loading = true;
    try {
      // Dispose existing template + people.
      this._disposeRoomSimPeople();
      st.loading = true;
      st.templateUrl = url;
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(url);
      const root = gltf.scene || null;
      if (!root) throw new Error('GLTF missing scene');
      st.templateGltf = gltf;
      st.templateRoot = root;
      st.templateClips = Array.isArray(gltf.animations) ? gltf.animations : [];
      // Hide "Background" cards so the penthouse people don't have backdrops.
      this._hideBackgroundCards(root);
      return true;
    } catch (e) {
      this._setStatus(`Penthouse people load failed: ${e?.message || e}`);
      try { this._disposeRoomSimPeople(); } catch { /* ignore */ }
      return false;
    } finally {
      st.loading = false;
    }
  },

  async _refreshRoomSimPeople({ force = false } = {}) {
    // Only relevant for the penthouse procedural world.
    if (safeTrim(this._proc?.kind) !== 'penthouse_room_sim') {
      if (this._roomSimPeople?.group) this._disposeRoomSimPeople();
      return;
    }

    const pent = this._findPenthouseBuildingGroup();
    if (!pent) return;
    const ud = pent?.userData || {};
    const pts = ud?.roomSimPoints || null;
    const chairs = Array.isArray(pts?.chairs) ? pts.chairs : [];
    const spawns = Array.isArray(pts?.agentSpawns) ? pts.agentSpawns : [];
    const anchors = chairs.length ? chairs : spawns;

    if (!this._roomSim?.enabled) {
      this._applyRoomSimSpawnMarkerVisibility();
      if (this._roomSimPeople?.group) this._disposeRoomSimPeople();
      return;
    }

    const ok = await this._ensureRoomSimTemplateLoaded({ force });
    if (!ok) return;

    const st = this._roomSimPeople;
    const templateRoot = st.templateRoot;
    const clips = Array.isArray(st.templateClips) ? st.templateClips : [];
    if (!templateRoot) return;

    // Create group parented to the penthouse building.
    if (!st.group) {
      st.group = new THREE.Group();
      st.group.name = 'roomSim_people';
      pent.add(st.group);
    } else {
      // Clear old instances.
      try {
        const kids = Array.isArray(st.group.children) ? [...st.group.children] : [];
        for (const c of kids) {
          try { st.group.remove(c); } catch { /* ignore */ }
          try { disposeThreeObject(c); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
    st.people = [];

    const max = Math.max(0, Math.min(60, Math.floor(Number(this._roomSim?.maxPeople) || 0)));
    const count = Math.max(0, Math.min(max || 0, anchors.length));
    if (!count) {
      this._applyRoomSimSpawnMarkerVisibility();
      return;
    }

    const want = {
      idle: ['idle', 'stand', 'rest'],
      walk_fwd: ['walk_fwd', 'walkfwd', 'walkforward', 'walk_forward', 'walk'],
    };

    for (let i = 0; i < count; i++) {
      const a = anchors[i % anchors.length];
      const x = Number(a?.x) || 0;
      const z = Number(a?.z) || 0;
      const yaw = (Number(a?.yawDeg) || 0) * Math.PI / 180;

      const clone = SkeletonUtils.clone(templateRoot);
      clone.name = `roomSim_person_${i}`;
      st.group.add(clone);

      // Mixer + actions per clone.
      const mixer = new THREE.AnimationMixer(clone);
      const actions = new Map();
      const keyToClip = new Map();
      for (const [k, aliases] of Object.entries(want)) {
        const clip = clipByAliases(clips, aliases);
        if (clip) keyToClip.set(k, clip);
      }
      for (const [k, clip] of keyToClip.entries()) {
        const ac = mixer.clipAction(clip);
        ac.enabled = true;
        ac.setLoop(THREE.LoopRepeat, Infinity);
        ac.setEffectiveWeight(0.0);
        ac.setEffectiveTimeScale(1.0);
        ac.play();
        actions.set(k, ac);
      }

      // Root bone (optional, to pin in-place clips).
      let rootBone = null;
      try {
        clone.traverse?.((n) => {
          if (rootBone) return;
          const sk = /** @type {any} */ (n);
          const bones = sk?.skeleton?.bones;
          if (!Array.isArray(bones) || bones.length === 0) return;
          const lower = (s) => safeTrim(s).toLowerCase();
          const prefer = ['root', 'hips', 'pelvis', 'mixamorig:hips', 'mixamorighips'];
          for (const p of prefer) {
            const hit = bones.find((b) => lower(b?.name) === p);
            if (hit) { rootBone = hit; return; }
          }
          rootBone = bones[0] || null;
        });
      } catch { /* ignore */ }

      // Place on ground.
      let gy = 0;
      try {
        const hit = this._findGroundY(x, 3.0, z);
        if (hit != null) gy = Number(hit) || 0;
      } catch { /* ignore */ }
      clone.position.set(x, gy + (Number(this._roomSim?.yOffset) || 0), z);
      clone.rotation.set(0, yaw, 0);
      const sc = Math.max(0.01, Number(this._roomSim?.scale) || 1.0);
      clone.scale.set(sc, sc, sc);

      // Default idle pose.
      try {
        if (actions.has('idle')) actions.get('idle').setEffectiveWeight(1.0);
        else if (actions.size) actions.get(Array.from(actions.keys())[0]).setEffectiveWeight(1.0);
      } catch { /* ignore */ }

      st.people.push({
        root: clone,
        mixer,
        actions,
        rootBone,
        cancelRootTranslation: true,
      });
    }

    this._applyRoomSimSpawnMarkerVisibility();
  },

  _tickRoomSimPeople(dt) {
    const st = this._roomSimPeople;
    if (!st || !this._roomSim?.enabled) return;
    if (safeTrim(this._proc?.kind) !== 'penthouse_room_sim') return;
    const people = Array.isArray(st.people) ? st.people : [];
    if (!people.length) return;
    const delta = Math.max(0.0, Math.min(0.25, Number(dt) || 0.0));
    for (const p of people) {
      if (!p?.root || !p?.mixer) continue;
      try { p.mixer.update(delta); } catch { /* ignore */ }
      if (p.cancelRootTranslation && p.rootBone) {
        try { p.rootBone.position.set(0, 0, 0); } catch { /* ignore */ }
      }
    }
  },
};

