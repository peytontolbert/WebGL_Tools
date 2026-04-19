import { el, clear } from '../../../ui/dom.js';
import * as THREE from 'three';

import { SCENE_ASSET_LOCATIONS } from './scene_presets.js';

import { safeTrim, normQuery, disposeThreeObject } from './core/scene_utils.js';

export const sceneBuildingsUiMixin = {
  _ensureBuildingMeta(group) {
    if (!group) return null;
    if (!group.userData || typeof group.userData !== 'object') group.userData = {};
    if (!group.userData.building || typeof group.userData.building !== 'object') group.userData.building = {};
    if (!group.userData.ai || typeof group.userData.ai !== 'object') group.userData.ai = {};
    return group.userData;
  },

  _duplicateBuilding(group) {
    const src = group || null;
    if (!src || !src.parent) return null;
    const dup = src.clone(true);
    dup.name = this._uniqueBuildingName(safeTrim(src?.name) || 'building', { excludeUuid: '' });
    dup.position.x += 1.0;
    dup.position.z += 1.0;

    // Try to deep copy userData (clone() is shallow-ish).
    try {
      dup.userData = JSON.parse(JSON.stringify(src.userData || {}));
    } catch {
      dup.userData = Object.assign({}, src.userData || {});
    }
    this._addProjectTag(dup, 'buildings');

    src.parent.add(dup);

    if (safeTrim(this._proc?.kind) === 'arena') {
      const obs = this._collectObstacleMeshes(dup);
      if (obs.length) {
        this._obstacleSources = Array.isArray(this._obstacleSources) ? this._obstacleSources : [];
        for (const m of obs) this._obstacleSources.push(m);
        this._rebuildObstacleBoxesFromSources();
        try { this._buildNavGrid(); } catch { /* ignore */ }
      }
    }

    this._scanTaggedBuildings();
    this._buildingSel.uuid = dup.uuid;
    this._setSelection(dup);
    this._renderBuildingsUi();
    this._renderBuildingEditorUi();
    return dup;
  },

  _deleteBuilding(group) {
    const o = group || null;
    if (!o || !o.parent) return false;

    // Remove any obstacle meshes contributed by this object.
    if (safeTrim(this._proc?.kind) === 'arena') {
      const obs = this._collectObstacleMeshes(o);
      if (obs.length && Array.isArray(this._obstacleSources)) {
        const keep = new Set(obs.map((m) => m?.uuid).filter(Boolean));
        this._obstacleSources = this._obstacleSources.filter((m) => !keep.has(m?.uuid));
      }
    }

    try { o.parent.remove(o); } catch { /* ignore */ }
    try { disposeThreeObject(o); } catch { /* ignore */ }

    if (safeTrim(this._proc?.kind) === 'arena') {
      this._rebuildObstacleBoxesFromSources();
      try { this._buildNavGrid(); } catch { /* ignore */ }
    }

    this._scanTaggedBuildings();
    this._buildingSel.uuid = '';
    this._setSelection(null);
    this._renderBuildingsUi();
    this._renderBuildingEditorUi();
    return true;
  },

  _renderBuildingsUi() {
    const host = this._ui.buildingsHost;
    if (!host) return;
    clear(host);

    const sel = this._selection?.obj || null;
    const lines = [];
    if (sel) {
      const tags = this._getProjectTags(sel);
      lines.push(`Selection: ${safeTrim(sel?.name) || '(unnamed)'}  (${sel.type || 'Object3D'})`);
      lines.push(`UUID: ${String(sel.uuid || '').slice(0, 12)}…`);
      lines.push(`Tags: ${tags.length ? tags.join(', ') : '(none)'}`);
    } else {
      lines.push('Selection: (none)');
      lines.push('Tip: switch to Orbit mode and Shift+Click an object to select it.');
    }
    try { if (this._ui.selectionInfoEl) this._ui.selectionInfoEl.textContent = lines.join('\n'); } catch { /* ignore */ }

    const items = Array.isArray(this._taggedBuildings) ? this._taggedBuildings : [];
    const q = normQuery(this._buildings?.filter || '');
    const match = (o) => {
      if (!q) return true;
      const nm = safeTrim(o?.name).toLowerCase();
      const id = String(o?.uuid || '').toLowerCase();
      return nm.includes(q) || id.includes(q);
    };

    if (!items.length) {
      host.appendChild(el('div', { class: 'muted' }, ['(no objects tagged as buildings)']));
      return;
    }

    const frag = document.createDocumentFragment();
    let shown = 0;
    for (const o of items) {
      if (!match(o)) continue;
      shown++;
      const nm = safeTrim(o?.name) || '(unnamed)';
      const isSel = (safeTrim(this._buildingSel?.uuid) && o?.uuid === this._buildingSel.uuid);
      frag.appendChild(el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '4px 0' } }, [
        el('button', {
          class: isSel ? 'toolBtn primary' : 'toolBtn',
          style: { flex: '1', padding: '4px 6px', textAlign: 'left' },
          onclick: () => {
            this._buildingSel.uuid = o?.uuid || '';
            this._setSelection(o);
            this._renderBuildingEditorUi();
          },
          title: `${nm}\n${o?.uuid || ''}`,
        }, [nm]),
        el('button', {
          onclick: () => {
            const wp = new THREE.Vector3();
            try { o.getWorldPosition(wp); } catch { /* ignore */ }
            this._teleportToPoint(wp.x, wp.y, wp.z + 2.0);
          },
          title: 'Teleport near this building',
        }, ['Go']),
      ]));
    }
    if (!shown) {
      host.appendChild(el('div', { class: 'muted' }, ['(no buildings match filter)']));
      return;
    }
    host.appendChild(frag);
  },

  _renderBuildingEditorUi() {
    const host = this._ui.buildingEditorHost;
    if (!host) return;
    clear(host);

    const items = Array.isArray(this._taggedBuildings) ? this._taggedBuildings : [];
    const uuid = safeTrim(this._buildingSel?.uuid);
    const o = uuid ? (items.find((x) => x?.uuid === uuid) || null) : null;
    if (!o) {
      host.appendChild(el('div', { class: 'muted' }, ['Select a tagged building from the list to edit.']));
      return;
    }

    const ud = this._ensureBuildingMeta(o) || {};
    const bmeta = ud?.building || {};
    const kind = safeTrim(bmeta?.kind) || (safeTrim(this._proc?.kind) === 'arena' ? 'proc:arena' : 'unknown');

    // Transform editor (LOCAL position + yaw + uniform scale)
    const pos = o?.position?.clone?.() || new THREE.Vector3();
    const rotY = Number(o?.rotation?.y) || 0;
    const scl = o?.scale?.clone?.() || new THREE.Vector3(1, 1, 1);

    const nameInput = el('input', {
      value: safeTrim(o?.name),
      placeholder: 'name',
      onchange: (e) => {
        o.name = safeTrim(e.target.value);
        this._scanTaggedBuildings();
        this._renderBuildingsUi();
      },
    });

    const xInput = el('input', { value: String(pos.x.toFixed(3)), style: { width: '90px' } });
    const yInput = el('input', { value: String(pos.y.toFixed(3)), style: { width: '90px' } });
    const zInput = el('input', { value: String(pos.z.toFixed(3)), style: { width: '90px' } });
    const yawDeg = (rotY * 180 / Math.PI);
    const yawInput = el('input', { value: String(yawDeg.toFixed(1)), style: { width: '90px' }, title: 'Rotation around Y axis (degrees)' });
    const scaleInput = el('input', { value: String(((scl.x + scl.y + scl.z) / 3).toFixed(3)), style: { width: '90px' }, title: 'Uniform scale' });

    const applyTransform = () => {
      const nx = Number(xInput.value), ny = Number(yInput.value), nz = Number(zInput.value);
      const nyaw = Number(yawInput.value);
      const ns = Number(scaleInput.value);
      if (![nx, ny, nz].every(Number.isFinite)) return;
      try { o.position.set(nx, ny, nz); } catch { /* ignore */ }
      if (Number.isFinite(nyaw)) {
        try { o.rotation.y = (nyaw * Math.PI / 180); } catch { /* ignore */ }
      }
      if (Number.isFinite(ns) && ns > 1e-5) {
        try { o.scale.set(ns, ns, ns); } catch { /* ignore */ }
      }

      // Collision depends on obstacle boxes (for all FPS procedural scenes, including penthouse).
      try { this._rebuildObstacleBoxesFromSources(); } catch { /* ignore */ }
      // Nav grid is only used by the arena demo.
      if (safeTrim(this._proc?.kind) === 'arena') {
        try { this._buildNavGrid(); } catch { /* ignore */ }
      }
      this._updateSelectionHelper();
    };

    // Building geometry editor
    const wInput = el('input', { value: String(Number(bmeta?.w ?? 14) || 14), style: { width: '90px' }, title: 'Width (X) in meters' });
    const dInput = el('input', { value: String(Number(bmeta?.d ?? 12) || 12), style: { width: '90px' }, title: 'Depth (Z) in meters' });
    const hInput = el('input', { value: String(Number(bmeta?.h ?? 7) || 7), style: { width: '90px' }, title: 'Height (Y) in meters' });
    const doorSel = el('select', { value: String(bmeta?.door || 'south') }, [
      el('option', { value: 'north' }, ['north']),
      el('option', { value: 'south' }, ['south']),
      el('option', { value: 'west' }, ['west']),
      el('option', { value: 'east' }, ['east']),
    ]);
    const doorWInput = el('input', { value: String(Number(bmeta?.doorW ?? 2.4) || 2.4), style: { width: '90px' }, title: 'Door width (meters)' });

    const applyDims = () => {
      const ww = Math.max(0.5, Number(wInput.value) || 0);
      const dd = Math.max(0.5, Number(dInput.value) || 0);
      const hh = Math.max(0.5, Number(hInput.value) || 0);
      ud.building.w = ww;
      ud.building.d = dd;
      ud.building.h = hh;
      ud.building.door = safeTrim(doorSel.value || ud.building.door || 'south') || 'south';
      ud.building.doorW = Math.max(0.8, Number(doorWInput.value) || 0);
      if (safeTrim(ud.building.kind) === 'primitive_box') this._rebuildPrimitiveBoxBuilding(o);
      if (safeTrim(ud.building.kind) === 'proc:arena') this._rebuildArenaBuilding(o);
      if (safeTrim(ud.building.kind) === 'proc:penthouse_room_sim') this._rebuildRoomSimPenthouseBuilding(o);
      if (safeTrim(ud.building.kind) === 'proc:drift_track') this._rebuildDriftTrackBuilding(o);
    };

    // Room-sim penthouse params editor
    const rsRows = el('input', { value: String(Number(bmeta?.rows ?? 5) || 5), style: { width: '90px' }, title: 'Bedroom rows' });
    const rsCols = el('input', { value: String(Number(bmeta?.cols ?? 5) || 5), style: { width: '90px' }, title: 'Bedroom cols' });
    const rsRoomW = el('input', { value: String(Number(bmeta?.roomW ?? 6.0) || 6.0), style: { width: '90px' }, title: 'Room width (m)' });
    const rsRoomD = el('input', { value: String(Number(bmeta?.roomD ?? 6.0) || 6.0), style: { width: '90px' }, title: 'Room depth (m)' });
    const rsCorrD = el('input', { value: String(Number(bmeta?.corridorD ?? 3.2) || 3.2), style: { width: '90px' }, title: 'Corridor width (m)' });
    const rsHallW = el('input', { value: String(Number(bmeta?.hallW ?? 46.0) || 46.0), style: { width: '90px' }, title: 'Work hall width (m)' });
    const rsWallT = el('input', { value: String(Number(bmeta?.wallT ?? 0.25) || 0.25), style: { width: '90px' }, title: 'Wall thickness (m)' });
    const rsWallH = el('input', { value: String(Number(bmeta?.wallH ?? 3.1) || 3.1), style: { width: '90px' }, title: 'Wall height (m)' });
    const rsDoorW = el('input', { value: String(Number(bmeta?.doorW ?? 0.95) || 0.95), style: { width: '90px' }, title: 'Bedroom door width (m)' });
    const rsHallDoorW = el('input', { value: String(Number(bmeta?.hallDoorW ?? 4.5) || 4.5), style: { width: '90px' }, title: 'Hall opening width (m)' });
    const rsDeskRows = el('input', { value: String(Number(bmeta?.deskRows ?? 5) || 5), style: { width: '90px' }, title: 'Desk rows' });
    const rsDeskCols = el('input', { value: String(Number(bmeta?.deskCols ?? 5) || 5), style: { width: '90px' }, title: 'Desk cols' });
    const rsDeskPadX = el('input', { value: String(Number(bmeta?.deskPadX ?? 4.0) || 4.0), style: { width: '90px' }, title: 'Desk spacing X (m)' });
    const rsDeskPadY = el('input', { value: String(Number(bmeta?.deskPadY ?? 3.6) || 3.6), style: { width: '90px' }, title: 'Desk spacing Y (m)' });

    const applyRoomSim = () => {
      ud.building.kind = 'proc:penthouse_room_sim';
      ud.building.rows = Math.max(1, Math.floor(Number(rsRows.value) || 5));
      ud.building.cols = Math.max(1, Math.floor(Number(rsCols.value) || 5));
      ud.building.roomW = Math.max(3.2, Number(rsRoomW.value) || 6.0);
      ud.building.roomD = Math.max(3.2, Number(rsRoomD.value) || 6.0);
      ud.building.corridorD = Math.max(2.2, Number(rsCorrD.value) || 3.2);
      ud.building.hallW = Math.max(18.0, Number(rsHallW.value) || 46.0);
      ud.building.wallT = Math.max(0.12, Number(rsWallT.value) || 0.25);
      ud.building.wallH = Math.max(2.2, Number(rsWallH.value) || 3.1);
      ud.building.doorW = Math.max(0.75, Number(rsDoorW.value) || 0.95);
      ud.building.hallDoorW = Math.max(2.0, Number(rsHallDoorW.value) || 4.5);
      ud.building.deskRows = Math.max(1, Math.floor(Number(rsDeskRows.value) || 5));
      ud.building.deskCols = Math.max(1, Math.floor(Number(rsDeskCols.value) || 5));
      ud.building.deskPadX = Math.max(2.4, Number(rsDeskPadX.value) || 4.0);
      ud.building.deskPadY = Math.max(2.4, Number(rsDeskPadY.value) || 3.6);
      this._rebuildRoomSimPenthouseBuilding(o);
    };

    // AI metadata (stored on userData.ai)
    const ai = ud.ai || (ud.ai = {});
    const aiPrompt = el('textarea', { rows: 4, value: String(ai.prompt || ''), placeholder: 'AI prompt for this building…' });
    const aiNameHint = el('input', { value: String(ai.nameHint || ''), placeholder: 'name hint (e.g. ai_city_building_01)' });
    const aiTargetDir = el('input', { value: String(ai.targetDir || SCENE_ASSET_LOCATIONS.aiCityBuildings), placeholder: 'target dir (under assets/)' });
    const aiFormats = el('input', { value: String((Array.isArray(ai.desiredFormats) ? ai.desiredFormats : ['.glb', '.bin', '.ktx2']).join(',')), placeholder: '.glb,.bin,.ktx2' });

    const applyAi = () => {
      ai.prompt = safeTrim(aiPrompt.value);
      ai.nameHint = safeTrim(aiNameHint.value) || safeTrim(o?.name);
      ai.targetDir = safeTrim(aiTargetDir.value) || SCENE_ASSET_LOCATIONS.aiCityBuildings;
      ai.desiredFormats = String(aiFormats.value || '')
        .split(',')
        .map((s) => safeTrim(s))
        .filter(Boolean);
    };

    const copyJsonBtn = el('button', {
      onclick: async () => {
        applyAi();
        const payload = {
          kind: 'building',
          uuid: o.uuid,
          name: safeTrim(o.name),
          tags: this._getProjectTags(o),
          transform: {
            pos: [Number(o.position.x) || 0, Number(o.position.y) || 0, Number(o.position.z) || 0],
            yawDeg: Number(o.rotation.y) * 180 / Math.PI,
            scale: Number(o.scale.x) || 1,
          },
          building: ud.building || {},
          ai: ud.ai || {},
        };
        try { await navigator.clipboard.writeText(JSON.stringify(payload, null, 2)); } catch { /* ignore */ }
        this._setStatus('Copied building JSON to clipboard.');
      },
      title: 'Copies building+AI metadata JSON to clipboard',
    }, ['Copy JSON']);

    const dupBtn = el('button', {
      onclick: () => { this._duplicateBuilding(o); this._setStatus('Duplicated building.'); },
      title: 'Duplicates this building',
    }, ['Duplicate']);

    const delBtn = el('button', {
      class: 'danger',
      onclick: () => {
        try {
          const ok = confirm('Delete this building from the scene?');
          if (!ok) return;
        } catch { /* ignore */ }
        this._deleteBuilding(o);
        this._setStatus('Deleted building.');
      },
      title: 'Deletes this building',
    }, ['Delete']);

    const frameBtn = el('button', {
      onclick: () => {
        if (!this._orbit || !this._camera) return;
        const wp = new THREE.Vector3();
        const box = new THREE.Box3();
        try { box.setFromObject(o); } catch { /* ignore */ }
        try { box.getCenter(wp); } catch { /* ignore */ }
        try { this._orbit.target.copy(wp); } catch { /* ignore */ }
        // Pull camera back a bit based on bounds.
        const size = new THREE.Vector3();
        try { box.getSize(size); } catch { /* ignore */ }
        const r = Math.max(3, Math.min(150, Math.max(size.x, size.y, size.z) * 1.2));
        try { this._camera.position.set(wp.x + r, wp.y + r * 0.6, wp.z + r); } catch { /* ignore */ }
        try { this._orbit.update(); } catch { /* ignore */ }
      },
      title: 'Frames this building in Orbit mode',
    }, ['Frame']);

    host.appendChild(el('div', { class: 'card', style: { marginTop: '8px' } }, [
      el('div', { class: 'dockTitle' }, ['Building editor']),
      el('div', { class: 'muted', style: { marginTop: '4px', fontSize: '10px' } }, [
        `Kind: ${kind || 'unknown'} · Tagged: projectTags=[buildings] · UUID ${String(o.uuid || '').slice(0, 12)}…`,
      ]),
      el('div', { style: { marginTop: '8px' } }, [el('div', { class: 'fieldLabel' }, ['Name']), nameInput]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
        copyJsonBtn,
        dupBtn,
        delBtn,
        el('div', { style: { flex: '1' } }),
        frameBtn,
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
        el('div', {}, [el('div', { class: 'fieldLabel' }, ['X']), xInput]),
        el('div', {}, [el('div', { class: 'fieldLabel' }, ['Y']), yInput]),
        el('div', {}, [el('div', { class: 'fieldLabel' }, ['Z']), zInput]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
        el('div', {}, [el('div', { class: 'fieldLabel' }, ['Yaw (deg)']), yawInput]),
        el('div', {}, [el('div', { class: 'fieldLabel' }, ['Scale']), scaleInput]),
        el('button', { class: 'primary', onclick: applyTransform }, ['Apply']),
      ]),

      (safeTrim(ud?.building?.kind) === 'primitive_box' || safeTrim(ud?.building?.kind) === 'proc:arena')
        ? el('div', { style: { marginTop: '10px' } }, [
          el('div', { style: { fontWeight: '600', fontSize: '11px' } }, [
            safeTrim(ud?.building?.kind) === 'proc:arena' ? 'Arena building geometry' : 'Primitive (box) geometry',
          ]),
          el('div', { class: 'row', style: { marginTop: '6px', gap: '8px', flexWrap: 'wrap' } }, [
            el('div', {}, [el('div', { class: 'fieldLabel' }, ['W']), wInput]),
            el('div', {}, [el('div', { class: 'fieldLabel' }, ['D']), dInput]),
            el('div', {}, [el('div', { class: 'fieldLabel' }, ['H']), hInput]),
            (safeTrim(ud?.building?.kind) === 'proc:arena')
              ? el('div', {}, [el('div', { class: 'fieldLabel' }, ['Door']), doorSel])
              : el('div', { style: { display: 'none' } }, ['']),
            (safeTrim(ud?.building?.kind) === 'proc:arena')
              ? el('div', {}, [el('div', { class: 'fieldLabel' }, ['DoorW']), doorWInput])
              : el('div', { style: { display: 'none' } }, ['']),
            el('button', { class: 'primary', onclick: applyDims }, ['Apply dims']),
          ]),
        ])
        : (safeTrim(ud?.building?.kind) === 'proc:penthouse_room_sim')
          ? el('div', { style: { marginTop: '10px' } }, [
            el('div', { style: { fontWeight: '600', fontSize: '11px' } }, ['Room Sim penthouse geometry']),
            el('div', { class: 'muted', style: { marginTop: '4px', fontSize: '10px' } }, [
              'Parametric layout (beds/doors/desks). Edit params and re-generate.',
            ]),
            el('div', { class: 'row', style: { marginTop: '6px', gap: '8px', flexWrap: 'wrap' } }, [
              el('div', {}, [el('div', { class: 'fieldLabel' }, ['Rows']), rsRows]),
              el('div', {}, [el('div', { class: 'fieldLabel' }, ['Cols']), rsCols]),
              el('div', {}, [el('div', { class: 'fieldLabel' }, ['RoomW']), rsRoomW]),
              el('div', {}, [el('div', { class: 'fieldLabel' }, ['RoomD']), rsRoomD]),
            ]),
            el('div', { class: 'row', style: { marginTop: '6px', gap: '8px', flexWrap: 'wrap' } }, [
              el('div', {}, [el('div', { class: 'fieldLabel' }, ['CorridorD']), rsCorrD]),
              el('div', {}, [el('div', { class: 'fieldLabel' }, ['HallW']), rsHallW]),
              el('div', {}, [el('div', { class: 'fieldLabel' }, ['WallT']), rsWallT]),
              el('div', {}, [el('div', { class: 'fieldLabel' }, ['WallH']), rsWallH]),
            ]),
            el('div', { class: 'row', style: { marginTop: '6px', gap: '8px', flexWrap: 'wrap' } }, [
              el('div', {}, [el('div', { class: 'fieldLabel' }, ['DoorW']), rsDoorW]),
              el('div', {}, [el('div', { class: 'fieldLabel' }, ['HallDoorW']), rsHallDoorW]),
              el('div', {}, [el('div', { class: 'fieldLabel' }, ['DeskRows']), rsDeskRows]),
              el('div', {}, [el('div', { class: 'fieldLabel' }, ['DeskCols']), rsDeskCols]),
            ]),
            el('div', { class: 'row', style: { marginTop: '6px', gap: '8px', flexWrap: 'wrap' } }, [
              el('div', {}, [el('div', { class: 'fieldLabel' }, ['DeskPadX']), rsDeskPadX]),
              el('div', {}, [el('div', { class: 'fieldLabel' }, ['DeskPadY']), rsDeskPadY]),
              el('button', { class: 'primary', onclick: applyRoomSim }, ['Regenerate']),
            ]),
          ])
          : el('div', { class: 'muted', style: { marginTop: '10px', fontSize: '10px' } }, [
            'Geometry editing is available for primitive_box, proc:arena, and proc:penthouse_room_sim buildings. (Other building kinds can still be moved/rotated/scaled and have AI metadata.)',
          ]),

      el('div', { style: { marginTop: '10px' } }, [
        el('div', { style: { fontWeight: '600', fontSize: '11px' } }, ['AI metadata (userData.ai)']),
        el('div', { class: 'muted', style: { marginTop: '4px', fontSize: '10px' } }, [
          'This is stored on the building group so your AI pipeline can generate/replace assets later.',
        ]),
        el('div', { class: 'row', style: { marginTop: '6px', gap: '8px', flexWrap: 'wrap' } }, [
          el('div', { style: { flex: '1 1 220px' } }, [el('div', { class: 'fieldLabel' }, ['Name hint']), aiNameHint]),
          el('div', { style: { flex: '2 1 260px' } }, [el('div', { class: 'fieldLabel' }, ['Target dir']), aiTargetDir]),
        ]),
        el('div', { style: { marginTop: '6px' } }, [el('div', { class: 'fieldLabel' }, ['Desired formats (csv)']), aiFormats]),
        el('div', { style: { marginTop: '6px' } }, [el('div', { class: 'fieldLabel' }, ['Prompt']), aiPrompt]),
        el('div', { class: 'row', style: { marginTop: '6px', gap: '8px', flexWrap: 'wrap' } }, [
          el('button', { class: 'primary', onclick: () => { applyAi(); this._setStatus('AI metadata updated.'); } }, ['Apply AI']),
          el('button', {
            onclick: async () => {
              applyAi();
              try { await navigator.clipboard.writeText(String(ai.prompt || '')); } catch { /* ignore */ }
              this._setStatus('Copied AI prompt to clipboard.');
            },
          }, ['Copy prompt']),
        ]),
      ]),
    ]));
  },
};

