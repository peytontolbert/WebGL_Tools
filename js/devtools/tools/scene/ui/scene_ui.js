import { el, clear, clamp } from '../../../../ui/dom.js';
import { createAssetPicker, createJobRunner, createJsonTextAreaCard } from '../../../components/ui_components.js';

import {
  safeTrim,
  debounce,
  extOf,
  isCharacterProfileAssetPath,
  isGlTfExt,
  isConvertibleSceneExt,
  isProceduralPath,
  safeName,
  getFileStem,
  normalizeAssetUrl,
} from '../core/scene_utils.js';

import { SCENE_ASSET_LOCATIONS } from '../scene_presets.js';
import { CHARACTER_ACTION_KEYS } from '../characters/character_anim_utils.js';

export function sceneTool_buildUi() {
  const host = this._root;
  if (!host) return;
  clear(host);

  const detailsCard = (title, { open = true, hint = '' } = {}, children = []) => el('details', { class: 'card', open: !!open }, [
    el('summary', {}, [
      el('div', { class: 'dockTitle' }, [String(title || 'Section')]),
      hint ? el('div', { class: 'muted', style: { marginLeft: 'auto', textAlign: 'right' } }, [String(hint)]) : el('div', {}),
    ]),
    el('div', { class: 'cardBody' }, children),
  ]);
  const menuGroup = (title, { open = false, hint = '' } = {}, children = []) => el('details', { open: !!open, style: { marginTop: '8px' } }, [
    el('summary', {}, [
      el('div', { class: 'fieldLabel' }, [String(title || 'Menu')]),
      hint ? el('div', { class: 'muted', style: { marginLeft: 'auto', textAlign: 'right', fontSize: '10px' } }, [String(hint)]) : el('div', {}),
    ]),
    el('div', { style: { marginTop: '8px' } }, children),
  ]);
  const uiModeKey = 'devtools.scene.uiMode';
  const readUiMode = () => {
    try {
      const raw = String(localStorage.getItem(uiModeKey) || '').trim().toLowerCase();
      if (raw === 'create' || raw === 'edit' || raw === 'all') return raw;
    } catch { /* ignore */ }
    return 'create';
  };
  const saveUiMode = (mode) => {
    try { localStorage.setItem(uiModeKey, String(mode || 'create')); } catch { /* ignore */ }
  };
  let uiMode = readUiMode();
  const createToolsHost = el('div', { style: { marginTop: '8px' } }, []);
  const editToolsHost = el('div', { style: { marginTop: '8px' } }, []);
  let createModeBtn = null;
  let editModeBtn = null;
  let allModeBtn = null;
  const applyUiMode = () => {
    const m = (uiMode === 'edit' || uiMode === 'all') ? uiMode : 'create';
    uiMode = m;
    const showCreate = (m === 'create' || m === 'all');
    const showEdit = (m === 'edit' || m === 'all');
    if (createToolsHost) createToolsHost.style.display = showCreate ? '' : 'none';
    if (editToolsHost) editToolsHost.style.display = showEdit ? '' : 'none';
    if (createModeBtn) createModeBtn.className = (m === 'create') ? 'primary' : '';
    if (editModeBtn) editModeBtn.className = (m === 'edit') ? 'primary' : '';
    if (allModeBtn) allModeBtn.className = (m === 'all') ? 'primary' : '';
  };

  host.appendChild(el('div', { class: 'panelSubtitle' }, [
    'Load a GLB/GLTF scene, or use a procedural scene like proc:arena / proc:drift_track / proc:resume_showcase. For Omniverse/OpenUSD scenes (USD/FBX), convert → GLB, then play.',
  ]));
  createModeBtn = el('button', {
    onclick: () => {
      uiMode = 'create';
      saveUiMode(uiMode);
      applyUiMode();
      this._openCreateSceneModal();
    },
    title: 'Open Easy World Builder wizard',
  }, ['Create world']);
  editModeBtn = el('button', {
    onclick: () => {
      uiMode = 'edit';
      saveUiMode(uiMode);
      applyUiMode();
    },
    title: 'Show scene editing tools (content/buildings/props/characters)',
  }, ['Edit scene']);
  allModeBtn = el('button', {
    onclick: () => {
      uiMode = 'all';
      saveUiMode(uiMode);
      applyUiMode();
    },
    title: 'Show all tools',
  }, ['All tools']);
  host.appendChild(el('div', { class: 'card', style: { marginTop: '8px' } }, [
    el('div', { class: 'dockTitle' }, ['Workflow']),
    el('div', { class: 'muted', style: { marginTop: '4px', fontSize: '11px', lineHeight: '1.35' } }, [
      'Create world opens a guided world-builder wizard. Edit scene focuses on content authoring for the current world.',
    ]),
    el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
      createModeBtn,
      editModeBtn,
      allModeBtn,
    ]),
  ]));

  // --- Vehicle presets (spawn driveable vehicles into the current scene) ---
  const vehiclePresetKey = 'devtools.scene.vehiclePresetId';
  const vehicleScaleKey = 'devtools.scene.vehicleScale';
  const vehicleYawKey = 'devtools.scene.vehicleYawDeg';
  const vehiclePresets = this._getVehiclePresetCatalog();
  const getPresetById = (id) => vehiclePresets.find((p) => safeTrim(p?.id) === safeTrim(id)) || null;
  const vehicleScaleStorageKeyFor = (presetId) => `devtools.scene.vehicleScale.${safeTrim(presetId) || 'default'}`;
  const readVehicleScaleForPreset = (presetId) => {
    const p = getPresetById(presetId);
    const rec = Number(p?.recommendedScale);
    const recScale = Number.isFinite(rec) && rec > 0 ? rec : 1.0;
    try {
      const v = String(localStorage.getItem(vehicleScaleStorageKeyFor(presetId)) || '').trim();
      if (v) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return n;
      }
    } catch { /* ignore */ }
    if (Number.isFinite(rec) && rec > 0) return recScale;
    try {
      // Back-compat for older global key.
      const v = String(localStorage.getItem(vehicleScaleKey) || '').trim();
      if (v) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return n;
      }
    } catch { /* ignore */ }
    return recScale;
  };
  const initialVehiclePresetId = (() => {
    try {
      const saved = String(localStorage.getItem(vehiclePresetKey) || '').trim();
      if (saved && vehiclePresets.some((p) => safeTrim(p?.id) === saved)) return saved;
    } catch { /* ignore */ }
    return safeTrim(vehiclePresets?.[0]?.id || '');
  })();
  const vehiclePresetSel = el('select', {}, []);
  const vehicleInfo = el('div', { class: 'muted', style: { marginTop: '6px', fontSize: '10px', whiteSpace: 'pre-wrap' } }, ['']);
  const vehiclePresetStatusEl = el('div', { class: 'muted', style: { marginTop: '6px', fontSize: '10px', whiteSpace: 'pre-wrap' } }, ['']);
  for (const p of vehiclePresets) {
    const pid = safeTrim(p?.id);
    if (!pid) continue;
    vehiclePresetSel.appendChild(el('option', { value: pid }, [safeTrim(p?.label) || pid]));
  }
  if (initialVehiclePresetId) vehiclePresetSel.value = initialVehiclePresetId;
  const vehicleScaleInput = el('input', {
    value: String(readVehicleScaleForPreset(initialVehiclePresetId)),
    style: { width: '90px' },
    title: 'Uniform scale',
    onchange: (e) => {
      const n = Math.max(0.001, Number(e.target.value) || 1.0);
      try { e.target.value = String(n); } catch { /* ignore */ }
      try {
        const pid = safeTrim(vehiclePresetSel?.value || '');
        localStorage.setItem(vehicleScaleStorageKeyFor(pid), String(n));
        localStorage.setItem(vehicleScaleKey, String(n));
      } catch { /* ignore */ }
    },
  });
  const vehicleYawInput = el('input', {
    value: (() => { try { return String(localStorage.getItem(vehicleYawKey) || '0'); } catch { return '0'; } })(),
    style: { width: '90px' },
    title: 'Yaw (degrees)',
    onchange: (e) => { try { localStorage.setItem(vehicleYawKey, String(Number(e.target.value) || 0)); } catch { /* ignore */ } },
  });
  this._ui.vehiclePresetSel = vehiclePresetSel;
  this._ui.vehiclePresetInfo = vehicleInfo;
  this._ui.vehicleScaleInput = vehicleScaleInput;
  this._ui.vehicleYawInput = vehicleYawInput;
  this._ui.vehiclePresetStatusEl = vehiclePresetStatusEl;

  const refreshVehiclePresetsBtn = el('button', {
    class: '',
    onclick: async () => {
      try {
        refreshVehiclePresetsBtn.disabled = true;
        await this._refreshVehiclePresetsFromWebautos();
      } catch { /* ignore */ }
    },
    title: 'Scan webautos/ and add them to this preset dropdown',
  }, ['Refresh webautos presets']);
  this._ui.vehiclePresetRefreshBtn = refreshVehiclePresetsBtn;

  const refreshVehicleInfo = async () => {
    const pid = safeTrim(vehiclePresetSel.value);
    if (!pid) {
      vehicleInfo.textContent = '(No vehicle preset selected)';
      return;
    }
    try {
      const resolved = await this._resolveVehiclePresetSelection(pid);
      if (!resolved) {
        vehicleInfo.textContent = 'Preset not found.';
        return;
      }
      const src = safeTrim(resolved?.preset?.source || '');
      const model = safeTrim(resolved?.modelUrl || resolved?.vehicleConfig?.modelUrl || '');
      const metaUrl = safeTrim(resolved?.vehicleConfig?.metaUrl || '');
      const clipCount = Array.isArray(resolved?.vehicleConfig?.animationClipNames) ? resolved.vehicleConfig.animationClipNames.length : 0;
      const recScale = Number(resolved?.preset?.recommendedScale);
      vehicleInfo.textContent = [
        `Model: ${model || '(missing)'}`,
        Number.isFinite(recScale) && recScale > 0 ? `Recommended scale: ${recScale}` : '',
        `Meta: ${metaUrl || '(auto)'}`,
        `Animation clips: ${clipCount}`,
        src ? `Source: ${src}` : '',
      ].filter(Boolean).join('\n');
    } catch (e) {
      vehicleInfo.textContent = `Failed to load preset: ${e?.message || e}`;
    }
  };
  vehiclePresetSel.onchange = () => {
    const pid = safeTrim(vehiclePresetSel.value || '');
    try { localStorage.setItem(vehiclePresetKey, String(pid || '')); } catch { /* ignore */ }
    try { vehicleScaleInput.value = String(readVehicleScaleForPreset(pid)); } catch { /* ignore */ }
    void refreshVehicleInfo();
  };

  const spawnPresetVehicleAtPlayerBtn = el('button', {
    class: 'primary',
    onclick: async () => {
      try {
        const pid = safeTrim(vehiclePresetSel.value);
        if (!pid) throw new Error('Pick a vehicle preset first.');
        const resolved = await this._resolveVehiclePresetSelection(pid);
        if (!resolved?.modelUrl) throw new Error('Selected preset has no model URL.');
        const sc = Math.max(0.001, Number(vehicleScaleInput.value) || 1.0);
        const yawDeg = Number(vehicleYawInput.value) || 0;
        const out = await this._spawnDriveableVehicleFromAssetUrl(resolved.modelUrl, {
          name: safeTrim(resolved?.preset?.label) || safeTrim(resolved?.preset?.id) || 'vehicle',
          scale: sc,
          yawDeg,
          place: 'player',
          vehicleConfig: resolved.vehicleConfig || null,
        });
        if (!out) {
          const spawnErr = safeTrim(this._vehicleSystem?._lastVehicleSpawnError || '');
          if (spawnErr) throw new Error(spawnErr);
          const wasmErr = safeTrim(this._vehicleSystem?._chronoVehWasm?.initError || '');
          if (!this._vehicleSystem?._chronoVehWasm?.ready && wasmErr) throw new Error(`Vehicle sim unavailable: ${wasmErr}`);
          throw new Error('Vehicle sim unavailable or model failed to load.');
        }
        // QoL: if you spawned at the player, immediately enter the driver seat so WASD works.
        try {
          const ok = this._vehicleSystem?.enterVehicleById?.(safeTrim(out?.id || ''), 'driver');
          if (!ok) this._vehicleSystem?.tryEnterVehicle?.();
        } catch { /* ignore */ }
        this._setStatus(`Spawned vehicle preset @ player: ${safeTrim(resolved?.preset?.label) || pid}`);
        this._ctx?.toast?.('Driveable vehicle spawned', 'success', { title: 'Vehicles' });
        void this._renderPropsUi();
      } catch (e) {
        this._ctx?.toast?.(`Vehicle spawn failed: ${e?.message || e}`, 'error', { title: 'Vehicles' });
      }
    },
    title: 'Spawn selected preset as a driveable vehicle at the player position',
  }, ['Spawn selected @ player']);

  const spawnPresetVehicleAtSpawnBtn = el('button', {
    onclick: async () => {
      try {
        const pid = safeTrim(vehiclePresetSel.value);
        if (!pid) throw new Error('Pick a vehicle preset first.');
        const resolved = await this._resolveVehiclePresetSelection(pid);
        if (!resolved?.modelUrl) throw new Error('Selected preset has no model URL.');
        const sc = Math.max(0.001, Number(vehicleScaleInput.value) || 1.0);
        const yawDeg = Number(vehicleYawInput.value) || 0;
        const out = await this._spawnDriveableVehicleFromAssetUrl(resolved.modelUrl, {
          name: safeTrim(resolved?.preset?.label) || safeTrim(resolved?.preset?.id) || 'vehicle',
          scale: sc,
          yawDeg,
          place: 'spawn',
          vehicleConfig: resolved.vehicleConfig || null,
        });
        if (!out) {
          const spawnErr = safeTrim(this._vehicleSystem?._lastVehicleSpawnError || '');
          if (spawnErr) throw new Error(spawnErr);
          const wasmErr = safeTrim(this._vehicleSystem?._chronoVehWasm?.initError || '');
          if (!this._vehicleSystem?._chronoVehWasm?.ready && wasmErr) throw new Error(`Vehicle sim unavailable: ${wasmErr}`);
          throw new Error('Vehicle sim unavailable or model failed to load.');
        }
        this._setStatus(`Spawned vehicle preset @ spawn: ${safeTrim(resolved?.preset?.label) || pid}`);
        this._ctx?.toast?.('Driveable vehicle spawned', 'success', { title: 'Vehicles' });
        void this._renderPropsUi();
      } catch (e) {
        this._ctx?.toast?.(`Vehicle spawn failed: ${e?.message || e}`, 'error', { title: 'Vehicles' });
      }
    },
    title: 'Spawn selected preset as a driveable vehicle at the spawn marker',
  }, ['Spawn selected @ spawn']);

  const usePresetInAssetUrlBtn = el('button', {
    onclick: async () => {
      try {
        const pid = safeTrim(vehiclePresetSel.value);
        if (!pid) throw new Error('Pick a vehicle preset first.');
        const resolved = await this._resolveVehiclePresetSelection(pid);
        const u = normalizeAssetUrl(resolved?.modelUrl || '');
        if (!u) throw new Error('Selected preset has no model URL.');
        if (this._ui?.propUrlInput) this._ui.propUrlInput.value = u;
        try {
          localStorage.setItem('devtools.scene.assetUrl', u);
          localStorage.setItem('devtools.scene.propUrl', u);
        } catch { /* ignore */ }
        this._setStatus(`Loaded preset URL into asset field: ${u}`);
      } catch (e) {
        this._ctx?.toast?.(`Load URL failed: ${e?.message || e}`, 'error', { title: 'Vehicles' });
      }
    },
    title: 'Copy selected preset model URL into the Assets and vehicles URL field',
  }, ['Use selected URL in asset spawner']);

  host.appendChild(detailsCard('Vehicles', { open: true, hint: 'preset driveable vehicles' }, [
    el('div', { class: 'muted', style: { fontSize: '10px' } }, [
      'Select a vehicle preset with authored data, then spawn it into the current scene as a driveable vehicle.',
    ]),
    el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, [
      el('div', { style: { flex: '1 1 280px' } }, [el('div', { class: 'fieldLabel' }, ['Vehicle preset']), vehiclePresetSel]),
      el('div', { class: 'row', style: { gap: '6px', alignItems: 'center' } }, [
        el('span', { class: 'muted' }, ['Scale']), vehicleScaleInput,
        el('span', { class: 'muted' }, ['Yaw°']), vehicleYawInput,
      ]),
    ]),
    el('div', { class: 'row', style: { marginTop: '6px', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, [
      refreshVehiclePresetsBtn,
      vehiclePresetStatusEl,
    ]),
    vehicleInfo,
    el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
      spawnPresetVehicleAtPlayerBtn,
      spawnPresetVehicleAtSpawnBtn,
      usePresetInAssetUrlBtn,
    ]),
  ]));
  void refreshVehicleInfo();
  try { vehiclePresetStatusEl.textContent = safeTrim(this._vehiclePresetsDynStatus || ''); } catch { /* ignore */ }
  // Auto-load webautos presets once per session (non-blocking).
  if (!this._vehiclePresetsDynAutoRequested) {
    this._vehiclePresetsDynAutoRequested = true;
    void this._refreshVehiclePresetsFromWebautos();
  }

  // --- Scenario list (localStorage) ---
  // Value is an index into the stored array (stable even if multiple scenarios share a path).
  const scenarioSel = el('select', {}, [el('option', { value: '' }, ['(saved scenarios)'])]);
  const scenarioName = el('input', { value: '', placeholder: 'scenario name (optional)' });
  this._ui.scenarioSel = scenarioSel;
  this._ui.scenarioName = scenarioName;

  const refreshScenarios = () => {
    const cur = String(scenarioSel.value || '');
    while (scenarioSel.childNodes.length > 1) scenarioSel.removeChild(scenarioSel.lastChild);
    // Ensure the built-in FPS demo exists so it shows up for everyone.
    this._ensureDefaultFpsArenaScenario();
    // Ensure the built-in Drift Track demo exists so it shows up for everyone.
    this._ensureDefaultDriftTrackScenario();
    // Ensure the built-in Penthouse demo exists so it shows up for everyone.
    this._ensureDefaultPenthouseScenario();
    // Ensure the built-in Resume Showcase demo exists so it shows up for everyone.
    this._ensureDefaultResumeShowcaseScenario();
    const list = this._loadScenarioList();
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const name = safeTrim(it?.name);
      const path = safeTrim(it?.path);
      if (!name || !path) continue;
      scenarioSel.appendChild(el('option', { value: String(i) }, [name]));
    }
    scenarioSel.value = cur;
  };
  refreshScenarios();

  scenarioSel.onchange = async (e) => {
    const idx = Number(e.target.value);
    if (!Number.isFinite(idx) || idx < 0) return;
    const list = this._loadScenarioList();
    const sc = list[idx];
    if (!sc) return;
    const p = safeTrim(sc?.path);
    if (!p) return;

    // Remember: scenario can include spawn + camera orientation; apply after load.
    this._pendingScenario = sc;
    this._setSourceUrl(p);
    if (isProceduralPath(p)) {
      await this._loadProcedural(p, { scenario: sc });
      return;
    }
    const ext = extOf(p);
    if (isGlTfExt(ext)) { await this._loadGlb(p, { scenario: sc }); return; }
    this._setStatus('Scenario path is not GLB/GLTF. Use Convert then Load (or use proc:arena).');
  };

  // --- Source input ---
  const sourceInput = el('input', {
    value: this._state.sourceUrl,
    placeholder: `${SCENE_ASSET_LOCATIONS.generatedScenes}scene.glb  (or USD/FBX path to convert)`,
    oninput: (e) => this._setSourceUrl(String(e.target.value || '')),
  });
  this._ui.sourceInput = sourceInput;

  const loadBtn = el('button', {
    class: 'primary',
    onclick: async () => {
      const p = safeTrim(this._state.sourceUrl);
      if (!p) return;
      if (isProceduralPath(p)) {
        await this._loadProcedural(p);
        return;
      }
      const ext = extOf(p);
      if (!isGlTfExt(ext)) {
        this._setStatus('Load expects .glb/.gltf. For USD/FBX, use Convert first. (Or use proc:arena)');
        return;
      }
      await this._loadGlb(p);
    },
  }, ['Load']);

  const resetBtn = el('button', { onclick: () => this._resetToSpawn() }, ['Reset spawn']);
  const setSpawnBtn = el('button', {
    onclick: () => {
      this._setSpawnFromCurrent();
      this._setStatus('Spawn updated (from current position).');
    },
    title: 'Set spawn to current player position',
  }, ['Set spawn here']);

  const playBtn = el('button', {
    class: 'primary',
    title: 'Click to lock pointer and enable WASD + mouse look',
    onclick: () => {
      this._state.mode = 'fps';
      this._savePrefs();
      this._tryPointerLock('play_button');
      this._syncModeUi();
    },
  }, ['Play (pointer lock)']);

  const modeSel = el('select', { value: this._state.mode }, [
    el('option', { value: 'fps' }, ['FPS (WASD)']),
    el('option', { value: 'orbit' }, ['Orbit (inspect)']),
  ]);
  this._ui.modeSel = modeSel;
  modeSel.onchange = (e) => {
    this._state.mode = String(e.target.value || 'fps') === 'orbit' ? 'orbit' : 'fps';
    this._savePrefs();
    if (this._state.mode === 'orbit') {
      try { this._plock?.unlock?.(); } catch { /* ignore */ }
      // Don't leave the camera rolled/off-center after exiting FPS.
      try { this._clearPlayerLean(); } catch { /* ignore */ }
    }
    this._syncModeUi();
  };

  const gridChk = el('input', {
    type: 'checkbox',
    checked: !!this._state.showGrid,
    onchange: (e) => {
      this._state.showGrid = !!e.target.checked;
      if (this._grid) this._grid.visible = !!this._state.showGrid;
      this._savePrefs();
    },
  });
  this._ui.gridChk = gridChk;

  const leanChk = el('input', {
    type: 'checkbox',
    checked: !!this._state.enableLean,
    onchange: (e) => {
      this._state.enableLean = !!e.target.checked;
      if (!this._state.enableLean) {
        try { this._clearPlayerLean(); } catch { /* ignore */ }
      }
      this._savePrefs();
    },
    title: 'Enable Q/E lean (adds sideways offset + roll). Disable if the camera feels tilted/off-center.',
  });
  this._ui.leanChk = leanChk;

  const flyChk = el('input', {
    type: 'checkbox',
    checked: !!this._state.fly,
    onchange: (e) => {
      this._state.fly = !!e.target.checked;
      this._savePrefs();
    },
    title: 'Fly mode (no gravity). Space/Shift move up/down.',
  });
  this._ui.flyChk = flyChk;

  const speedInput = el('input', {
    value: String(this._state.speed),
    style: { width: '70px' },
    title: 'Walk speed',
    onchange: (e) => {
      this._state.speed = Math.max(0.1, Number(e.target.value) || 6);
      this._savePrefs();
    },
  });
  this._ui.speedInput = speedInput;

  const autoPlayChk = el('input', {
    type: 'checkbox',
    checked: !!this._state.autoPlayAfterLoad,
    onchange: (e) => {
      this._state.autoPlayAfterLoad = !!e.target.checked;
      this._savePrefs();
    },
    title: 'After converting or loading, automatically enter pointer-lock play mode.',
  });
  this._ui.autoPlayChk = autoPlayChk;

  const debugChk = el('input', {
    type: 'checkbox',
    checked: !!this._state.showDebug,
    onchange: (e) => {
      this._state.showDebug = !!e.target.checked;
      if (this._debugGroup) this._debugGroup.visible = !!this._state.showDebug;
      if (this._state.showDebug) this._rebuildScenarioDebug();
      this._savePrefs();
    },
    title: 'Show waypoint/trigger debug markers',
  });
  this._ui.debugChk = debugChk;

  const statusEl = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
  this._ui.statusEl = statusEl;

  const hintEl = el('div', { class: 'muted', style: { marginTop: '6px', fontSize: '11px', whiteSpace: 'pre-wrap' } }, ['']);
  this._ui.hintEl = hintEl;

  const exportBtn = el('button', {
    onclick: async () => {
      const sc = this._buildScenarioSnapshot();
      try {
        await navigator.clipboard.writeText(JSON.stringify(sc, null, 2));
        this._setStatus('Scenario JSON copied to clipboard.');
        this._ctx?.toast?.('Scenario JSON copied', 'success');
      } catch (e) {
        this._setStatus('Copy failed.');
        this._ctx?.toast?.(String(e?.message || e || 'Copy failed'), 'error', { title: 'Copy failed' });
      }
    },
    title: 'Copy a JSON snapshot (path + spawn + camera + settings)',
  }, ['Copy JSON']);
  const exportGlbBtn = el('button', {
    onclick: async () => {
      await this._exportCurrentWorldGlb();
    },
    title: 'Export the currently loaded scene world as a .glb file',
  }, ['Export scene GLB']);
  const sendToGameToolBtn = el('button', {
    class: 'primary',
    onclick: () => {
      try {
        this._sendSceneSettingsToGameTool();
      } catch (e) {
        this._setStatus(`Game handoff failed: ${e?.message || e}`);
        this._ctx?.toast?.(String(e?.message || e || 'Handoff failed'), 'error', { title: 'Game tool' });
      }
    },
    title: 'Send scene/start/runtime settings to Game tool and open it',
  }, ['Send to Game tool']);

  const importCard = createJsonTextAreaCard({
    ctx: this._ctx,
    title: 'Import scenario JSON',
    storageKey: 'devtools.scene.importScenarioJson',
    placeholder: 'Paste scenario JSON snapshot…',
    onApply: (sc) => {
      this._importScenario(sc);
      refreshScenarios();
      this._setStatus('Imported scenario JSON.');
    },
    applyLabel: 'Import JSON',
    copyLabel: 'Copy text',
  });

  const importBtn = el('button', {
    onclick: () => {
      try { importCard.open = true; } catch { /* ignore */ }
      try { importCard.scrollIntoView?.({ block: 'nearest' }); } catch { /* ignore */ }
    },
    title: 'Import a scenario JSON snapshot into saved scenarios',
  }, ['Import JSON…']);

  const deleteBtn = el('button', {
    class: 'danger',
    onclick: () => {
      const v = String(this._ui.scenarioSel?.value || '').trim();
      const idx = Number(v);
      if (!Number.isFinite(idx) || idx < 0) return;
      this._deleteScenarioAt(idx);
      refreshScenarios();
      try { if (this._ui.scenarioSel) this._ui.scenarioSel.value = ''; } catch { /* ignore */ }
      this._setStatus('Deleted scenario.');
    },
    title: 'Delete the currently selected saved scenario',
  }, ['Delete']);
  const newSceneBtn = el('button', {
    class: 'primary',
    onclick: () => this._openCreateSceneModal(),
    title: 'Open Easy World Builder wizard',
  }, ['+ Easy world builder']);

  const openBuildingsToolBtn = el('button', {
    onclick: () => {
      // Buildings tool is NOT a full scene editor. Hand off a lightweight "index" of buildings
      // (names + metadata) so it can work on project buildings without loading the whole scene.
      try {
        const payload = { schema: 1, kind: 'building_list', buildings: this._exportAllBuildingsPayload() };
        localStorage.setItem('devtools.buildings.sceneBuildingsJson', JSON.stringify(payload));
        localStorage.setItem('devtools.buildings.sceneBuildingsSelectedUuid', safeTrim(this._buildingSel?.uuid || ''));
        localStorage.setItem('devtools.buildings.sceneBuildingsTime', new Date().toISOString());
      } catch { /* ignore */ }
      try { globalThis.__devtools?.setActiveTool?.('buildings'); } catch { /* ignore */ }
    },
    title: 'Open the Buildings tool (project buildings workspace)',
  }, ['Open Buildings tool']);

  const sendBuildingBtn = el('button', {
    class: 'primary',
    onclick: () => {
      try {
        this._scanTaggedBuildings();
        const items = Array.isArray(this._taggedBuildings) ? this._taggedBuildings : [];
        const uuid = safeTrim(this._buildingSel?.uuid || '');
        const o = items.find((x) => safeTrim(x?.uuid) === uuid) || null;
        if (!o) throw new Error('No building selected (select one in Buildings list)');
        const rec = this._exportBuildingRecord(o);
        const payload = { schema: 1, kind: 'buildings_inbox', buildings: [rec] };
        localStorage.setItem('devtools.buildings.inboxJson', JSON.stringify(payload));
        // Also update the lightweight scene buildings index for the Buildings tool UI.
        try {
          const lib = { schema: 1, kind: 'building_list', buildings: this._exportAllBuildingsPayload() };
          localStorage.setItem('devtools.buildings.sceneBuildingsJson', JSON.stringify(lib));
          localStorage.setItem('devtools.buildings.sceneBuildingsSelectedUuid', uuid);
          localStorage.setItem('devtools.buildings.sceneBuildingsTime', new Date().toISOString());
        } catch { /* ignore */ }
        this._ctx?.toast?.(`Sent building → Buildings tool: ${safeTrim(o?.name) || uuid}`, 'success', { title: 'Buildings' });
        try { globalThis.__devtools?.setActiveTool?.('buildings'); } catch { /* ignore */ }
      } catch (e) {
        this._ctx?.toast?.(`Send failed: ${e?.message || e}`, 'error', { title: 'Buildings' });
      }
    },
    title: 'Sends the selected building to the Buildings tool (no file saving required)',
  }, ['Send selected building → Buildings tool']);

  host.appendChild(detailsCard('Scene', { open: true, hint: 'quick start' }, [
    el('div', { class: 'row', style: { marginTop: '2px', gap: '8px', flexWrap: 'wrap' } }, [
      newSceneBtn,
      loadBtn,
      playBtn,
      resetBtn,
      setSpawnBtn,
      el('div', { style: { flex: '1' } }),
      el('div', {}, [el('div', { class: 'fieldLabel' }, ['Mode']), modeSel]),
    ]),
    menuGroup('Saved scenarios', { open: true }, [
      el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, [
        el('div', { style: { flex: '1 1 220px' } }, [el('div', { class: 'fieldLabel' }, ['Saved']), scenarioSel]),
        el('div', { style: { flex: '1 1 220px' } }, [el('div', { class: 'fieldLabel' }, ['Name']), scenarioName]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
        el('button', { onclick: () => { this._saveScenarioFromUi(); refreshScenarios(); } }, ['Save scenario']),
        exportBtn,
        exportGlbBtn,
        sendToGameToolBtn,
        importBtn,
        deleteBtn,
      ]),
      importCard,
    ]),
    menuGroup('Scene source', { open: true, hint: 'GLB/GLTF or USD/FBX' }, [
      el('div', { class: 'fieldLabel' }, ['Scene path']),
      sourceInput,
    ]),
    menuGroup('Build your full scene', { open: true, hint: 'guided follow-through' }, [
      el('div', { class: 'muted', style: { fontSize: '10px', lineHeight: '1.4' } }, [
        '1) Move to a good start position and set spawn. 2) Add waypoints/objectives. 3) Build with props/buildings. 4) Save scenario and playtest.',
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
        el('button', {
          onclick: () => {
            this._setSpawnFromCurrent();
            this._setStatus('Spawn updated from current position.');
          },
        }, ['1. Set spawn']),
        el('button', {
          onclick: () => {
            this._addWaypointFromCurrent('Waypoint');
            this._renderWaypointsUi();
            this._rebuildScenarioDebug();
            this._setStatus('Added waypoint at player position.');
          },
        }, ['2. Add waypoint']),
        el('button', {
          onclick: () => {
            this._addTriggerAtCurrent({
              name: 'Objective',
              type: 'goal',
              once: true,
              requireInteract: true,
              prompt: 'Complete objective',
              size: { x: 4, y: 2, z: 4 },
            });
            this._renderTriggersUi();
            this._renderObjectivesUi();
            this._rebuildScenarioDebug();
            this._setStatus('Added objective trigger at player position.');
          },
        }, ['3. Add objective']),
        el('button', {
          onclick: () => {
            this._saveScenarioFromUi();
            refreshScenarios();
          },
        }, ['4. Save scenario']),
        el('button', {
          class: 'primary',
          onclick: () => {
            this._state.mode = 'fps';
            this._savePrefs();
            this._tryPointerLock('world_builder_playtest');
            this._syncModeUi();
          },
        }, ['5. Playtest']),
      ]),
    ]),
    menuGroup('View & movement', { open: false }, [
      el('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } }, [
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [gridChk, el('span', { class: 'muted' }, ['Grid'])]),
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [leanChk, el('span', { class: 'muted' }, ['Lean'])]),
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [flyChk, el('span', { class: 'muted' }, ['Fly'])]),
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [autoPlayChk, el('span', { class: 'muted' }, ['Auto-play'])]),
        el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [debugChk, el('span', { class: 'muted' }, ['Debug'])]),
        el('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
          el('span', { class: 'muted' }, ['Speed']),
          speedInput,
          el('span', { class: 'muted', style: { fontSize: '10px' } }, ['(Shift=sprint)']),
        ]),
      ]),
      el('div', { class: 'muted', style: { marginTop: '8px', fontSize: '10px' } }, [
        'Controls: WASD move · mouse look (pointer lock) · Shift sprint · Ctrl crouch · (optional) Q/E lean · Space jump (or up in fly) · E interact · Esc unlock.',
      ]),
    ]),
    menuGroup('Buildings handoff', { open: false }, [
      el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, [
        sendBuildingBtn,
        openBuildingsToolBtn,
      ]),
      el('div', { class: 'muted', style: { marginTop: '6px', fontSize: '10px' } }, ['(Buildings tool edits buildings only; no scene loading)']),
    ]),
    statusEl,
    hintEl,
  ]));

  createToolsHost.appendChild(detailsCard('Procedural (no model)', { open: false, hint: 'proc:arena · proc:drift_track · proc:resume_showcase · proc:penthouse_room_sim' }, [
    el('div', { class: 'muted', style: { marginTop: '2px', fontSize: '10px' } }, [
      'Use ', el('span', { style: { fontFamily: 'monospace' } }, ['proc:arena']), ' for the FPS sandbox, or ',
      el('span', { style: { fontFamily: 'monospace' } }, ['proc:drift_track']), ' for a vehicle drift loop, or ',
      el('span', { style: { fontFamily: 'monospace' } }, ['proc:resume_showcase']), ' for a playable resume world, or ',
      el('span', { style: { fontFamily: 'monospace' } }, ['proc:penthouse_room_sim']), ' for the room-sim penthouse (25 bedrooms + 25 desks).',
    ]),
    el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
      el('button', {
        class: 'primary',
        onclick: async () => {
          this._setSourceUrl('proc:arena');
          try { if (this._ui.sourceInput) this._ui.sourceInput.value = 'proc:arena'; } catch { /* ignore */ }
          await this._loadProcedural('proc:arena');
        },
        title: 'Generate a low-poly arena scene (no external assets).',
      }, ['Generate arena']),
      el('button', {
        class: '',
        onclick: async () => {
          this._setSourceUrl('proc:drift_track');
          try { if (this._ui.sourceInput) this._ui.sourceInput.value = 'proc:drift_track'; } catch { /* ignore */ }
          await this._loadProcedural('proc:drift_track');
        },
        title: 'Generate a procedural drift loop with barriers and clipping points.',
      }, ['Generate drift track']),
      el('button', {
        class: '',
        onclick: async () => {
          this._setSourceUrl('proc:penthouse_room_sim');
          try { if (this._ui.sourceInput) this._ui.sourceInput.value = 'proc:penthouse_room_sim'; } catch { /* ignore */ }
          await this._loadProcedural('proc:penthouse_room_sim');
        },
        title: 'Generate the room-sim penthouse from project building params.',
      }, ['Generate penthouse']),
      el('button', {
        class: '',
        onclick: async () => {
          this._setSourceUrl('proc:resume_showcase');
          try { if (this._ui.sourceInput) this._ui.sourceInput.value = 'proc:resume_showcase'; } catch { /* ignore */ }
          await this._loadProcedural('proc:resume_showcase');
        },
        title: 'Generate a cinematic, playable showcase environment for portfolio/resume demos.',
      }, ['Generate resume showcase']),
      el('button', {
        onclick: () => {
          this._ensureDefaultFpsArenaScenario({ forceToast: true });
          try { scenarioSel.value = ''; } catch { /* ignore */ }
          refreshScenarios();
          this._setStatus('Saved scenario updated: FPS Arena (model-free). Use the Saved dropdown to load it.');
        },
        title: 'Updates/creates the saved FPS scenario to match the latest proc:arena layout',
      }, ['Update saved FPS scenario']),
      el('button', {
        onclick: () => {
          this._ensureDefaultDriftTrackScenario({ forceToast: true });
          try { scenarioSel.value = ''; } catch { /* ignore */ }
          refreshScenarios();
          this._setStatus('Saved scenario updated: Drift Track (Driveable). Use the Saved dropdown to load it.');
        },
        title: 'Updates/creates the saved drift scenario to match the latest proc:drift_track layout',
      }, ['Update saved Drift scenario']),
      el('button', {
        onclick: () => {
          this._ensureDefaultResumeShowcaseScenario({ forceToast: true });
          try { scenarioSel.value = ''; } catch { /* ignore */ }
          refreshScenarios();
          this._setStatus('Saved scenario updated: Resume Showcase (Playable). Use the Saved dropdown to load it.');
        },
        title: 'Updates/creates the saved resume showcase scenario to match the latest proc:resume_showcase layout',
      }, ['Update saved Resume scenario']),
      el('button', {
        onclick: () => {
          this._ensureDefaultPenthouseScenario({ forceToast: true });
          try { scenarioSel.value = ''; } catch { /* ignore */ }
          refreshScenarios();
          this._setStatus('Saved scenario updated: Penthouse (Room Sim). Use the Saved dropdown to load it.');
        },
        title: 'Updates/creates the saved penthouse scenario to point at the latest building params asset.',
      }, ['Update saved Penthouse scenario']),
      el('button', {
        onclick: () => {
          this._resetGame();
          this._setStatus('Reset gameplay state.');
        },
        title: 'Resets HP/ammo/kills/enemies for the current scene',
      }, ['Reset game']),
      el('button', {
        class: 'danger',
        onclick: () => {
          this._clearWorld();
          this._setStatus('Cleared scene.');
        },
      }, ['Clear']),
    ]),
  ]));

  // Characters (saved playable profiles + room-sim people)
  const avatarEnabledChk = el('input', {
    type: 'checkbox',
    checked: this._avatar?.enabled !== false,
    onchange: (e) => {
      this._avatar.enabled = !!e.target.checked;
      this._savePrefs();
    },
    title: 'When enabled, third-person view shows a skinned avatar (instead of the capsule).',
  });
  const avatarUrlInput = el('input', {
    value: safeTrim(this._avatar?.url || ''),
    placeholder: 'Saved character manifest/profile JSON URL',
    onchange: (e) => {
      const next = safeTrim(e.target.value || '');
      if (next && !isCharacterProfileAssetPath(next)) {
        this._routeModelToPropAsset(next, 'avatar expects saved character profile');
        try { avatarUrlInput.value = safeTrim(this._avatar?.url || ''); } catch { /* ignore */ }
        return;
      }
      this._avatar.url = next;
      this._savePrefs();
    },
  });
  const avatarProfilesSel = el('select', {}, [
    el('option', { value: '' }, ['(saved playable characters)']),
  ]);
  const refreshAvatarProfiles = async () => {
    const current = safeTrim(avatarProfilesSel.value);
    clear(avatarProfilesSel);
    avatarProfilesSel.appendChild(el('option', { value: '' }, ['(saved playable characters)']));
    let items = [];
    try { items = await this._listPlayableCharacterManifestPaths(); } catch { items = []; }
    for (const p of items) avatarProfilesSel.appendChild(el('option', { value: p }, [p]));
    const target = current || safeTrim(this._avatar?.url || '');
    if (target && items.includes(target)) avatarProfilesSel.value = target;
  };
  const refreshAvatarProfilesBtn = el('button', {
    onclick: async () => {
      await refreshAvatarProfiles();
      this._setStatus('Refreshed saved playable character list.');
    },
    title: 'Refresh saved character manifests that include locomotion profile data',
  }, ['Refresh saved characters']);
  const useSavedAvatarBtn = el('button', {
    class: 'primary',
    onclick: async () => {
      const p = safeTrim(avatarProfilesSel.value);
      if (!p) return;
      this._avatar.url = p;
      try { avatarUrlInput.value = p; } catch { /* ignore */ }
      this._savePrefs();
      try { await this._loadThirdPersonAvatar({ force: true }); } catch { /* ignore */ }
    },
    title: 'Use selected saved character profile for third-person avatar',
  }, ['Use saved character']);
  void refreshAvatarProfiles();
  const avatarScaleInput = el('input', {
    value: String(this._avatar?.scale ?? 1.0),
    style: { width: '70px' },
    onchange: (e) => { this._avatar.scale = Math.max(0.01, Number(e.target.value) || 1.0); this._savePrefs(); },
    title: 'Avatar scale',
  });
  const avatarYOffsetInput = el('input', {
    value: String(this._avatar?.yOffset ?? 0.0),
    style: { width: '70px' },
    onchange: (e) => { this._avatar.yOffset = Number(e.target.value) || 0.0; this._savePrefs(); },
    title: 'Avatar vertical offset (meters)',
  });
  const avatarReloadBtn = el('button', {
    onclick: async () => { try { await this._loadThirdPersonAvatar({ force: true }); } catch { /* ignore */ } },
    title: 'Reload avatar now',
  }, ['Reload avatar']);
  const scenarioMeta = this._readScenarioMeta(this._scenarioContent);
  const scenarioAvatarSel = el('select', {}, [el('option', { value: '' }, ['(no scenario character override)'])]);
  const scenarioActionSel = el('select', {}, [
    el('option', { value: '' }, ['(no forced character action)']),
    ...CHARACTER_ACTION_KEYS.map((k) => el('option', { value: k }, [k])),
  ]);
  scenarioActionSel.value = scenarioMeta.avatarAction || '';
  const refreshScenarioAvatarSel = async () => {
    const cur = safeTrim(scenarioAvatarSel.value || scenarioMeta.avatarProfile || '');
    clear(scenarioAvatarSel);
    scenarioAvatarSel.appendChild(el('option', { value: '' }, ['(no scenario character override)']));
    let items = [];
    try { items = await this._listPlayableCharacterManifestPaths(); } catch { items = []; }
    for (const p of items) scenarioAvatarSel.appendChild(el('option', { value: p }, [p]));
    const target = cur || safeTrim(scenarioMeta.avatarProfile || '');
    if (target && items.includes(target)) scenarioAvatarSel.value = target;
  };
  const applyScenarioCastNowBtn = el('button', {
    onclick: () => {
      const profile = safeTrim(scenarioAvatarSel.value);
      const action = this._sanitizeCharacterActionKey(scenarioActionSel.value);
      this._setScenarioMeta({ avatarProfile: profile, avatarAction: action }, { applyNow: true });
      this._setStatus(`Applied scenario cast now: ${profile || '(no character override)'}${action ? ` · action=${action}` : ''}`);
    },
    title: 'Applies selected scenario character/action to the current scene immediately',
  }, ['Apply cast now']);
  const saveScenarioCastDefaultsBtn = el('button', {
    class: 'primary',
    onclick: () => {
      const profile = safeTrim(scenarioAvatarSel.value);
      const action = this._sanitizeCharacterActionKey(scenarioActionSel.value);
      this._setScenarioMeta({ avatarProfile: profile, avatarAction: action }, { applyNow: false });
      this._setStatus(`Saved scenario cast defaults${profile ? `: ${profile}` : ''}${action ? ` · action=${action}` : ''} (remember to Save scenario).`);
    },
    title: 'Stores selected character/action in scenario JSON when you save scenario',
  }, ['Use as scenario defaults']);
  const clearScenarioCastDefaultsBtn = el('button', {
    onclick: () => {
      this._setScenarioMeta({ avatarProfile: '', avatarAction: '' }, { applyNow: false });
      try { scenarioAvatarSel.value = ''; } catch { /* ignore */ }
      try { scenarioActionSel.value = ''; } catch { /* ignore */ }
      this._setStatus('Cleared scenario character/action defaults (remember to Save scenario).');
    },
    title: 'Clears scenario-level character and action defaults',
  }, ['Clear defaults']);
  const refreshScenarioCastBtn = el('button', {
    onclick: async () => {
      await refreshScenarioAvatarSel();
      this._setStatus('Refreshed scenario character options.');
    },
    title: 'Refresh list of saved playable characters for scenario defaults',
  }, ['Refresh scenario characters']);
  void refreshScenarioAvatarSel();

  const peopleEnabledChk = el('input', {
    type: 'checkbox',
    checked: this._roomSim?.enabled !== false,
    onchange: (e) => { this._roomSim.enabled = !!e.target.checked; this._savePrefs(); try { void this._refreshRoomSimPeople(); } catch { /* ignore */ } },
    title: 'Populate the penthouse with people (uses chair/spawn markers).',
  });
  const peopleUrlInput = el('input', {
    value: safeTrim(this._roomSim?.url || ''),
    placeholder: 'People GLB URL (defaults to Debra locomotion pack)',
    onchange: (e) => { this._roomSim.url = safeTrim(e.target.value || ''); this._savePrefs(); try { void this._refreshRoomSimPeople({ force: true }); } catch { /* ignore */ } },
  });
  const peopleMaxInput = el('input', {
    value: String(this._roomSim?.maxPeople ?? 25),
    style: { width: '70px' },
    onchange: (e) => { this._roomSim.maxPeople = Math.max(0, Math.min(60, Math.floor(Number(e.target.value) || 0))); this._savePrefs(); try { void this._refreshRoomSimPeople(); } catch { /* ignore */ } },
    title: 'Max people (penthouse only)',
  });
  const peopleHideSpawnsChk = el('input', {
    type: 'checkbox',
    checked: !!this._roomSim?.hideSpawnMarkers,
    onchange: (e) => { this._roomSim.hideSpawnMarkers = !!e.target.checked; this._savePrefs(); try { this._applyRoomSimSpawnMarkerVisibility(); } catch { /* ignore */ } },
    title: 'Hide green spawn markers when people are enabled',
  });
  const peopleScaleInput = el('input', {
    value: String(this._roomSim?.scale ?? 1.0),
    style: { width: '70px' },
    onchange: (e) => { this._roomSim.scale = Math.max(0.01, Number(e.target.value) || 1.0); this._savePrefs(); try { void this._refreshRoomSimPeople(); } catch { /* ignore */ } },
    title: 'People scale',
  });
  const peopleYOffsetInput = el('input', {
    value: String(this._roomSim?.yOffset ?? 0.0),
    style: { width: '70px' },
    onchange: (e) => { this._roomSim.yOffset = Number(e.target.value) || 0.0; this._savePrefs(); try { void this._refreshRoomSimPeople(); } catch { /* ignore */ } },
    title: 'People vertical offset',
  });
  const peopleRebuildBtn = el('button', {
    onclick: () => { try { void this._refreshRoomSimPeople({ force: true }); } catch { /* ignore */ } },
    title: 'Rebuild people for penthouse (if loaded)',
  }, ['Rebuild penthouse people']);

  // Resume Showcase walker (autonomous animated character in proc:resume_showcase).
  const resumeWalkerEnabledChk = el('input', {
    type: 'checkbox',
    checked: this._resumeWalker?.enabled !== false,
    onchange: (e) => { this._resumeWalker.enabled = !!e.target.checked; this._savePrefs(); },
    title: 'Spawns an autonomous animated character in proc:resume_showcase (walk loop + idle).',
  });
  const resumeWalkerUrlInput = el('input', {
    value: safeTrim(this._resumeWalker?.url || ''),
    placeholder: 'GLB URL (default: exported-model.glb)',
    onchange: (e) => { this._resumeWalker.url = safeTrim(e.target.value || ''); this._savePrefs(); },
  });
  const resumeWalkerScaleInput = el('input', {
    value: String(this._resumeWalker?.scale ?? 1.0),
    style: { width: '70px' },
    onchange: (e) => { this._resumeWalker.scale = Math.max(0.01, Number(e.target.value) || 1.0); this._savePrefs(); },
    title: 'Walker scale',
  });
  const resumeWalkerYOffsetInput = el('input', {
    value: String(this._resumeWalker?.yOffset ?? 0.0),
    style: { width: '70px' },
    onchange: (e) => { this._resumeWalker.yOffset = Number(e.target.value) || 0.0; this._savePrefs(); },
    title: 'Walker vertical offset (meters)',
  });
  const resumeWalkerSpeedInput = el('input', {
    value: String(this._resumeWalker?.speed ?? 1.35),
    style: { width: '70px' },
    onchange: (e) => { this._resumeWalker.speed = Math.max(0.05, Number(e.target.value) || 1.35); this._savePrefs(); },
    title: 'Walker speed (m/s)',
  });
  const resumeWalkerRadiusInput = el('input', {
    value: String(this._resumeWalker?.radius ?? 5.0),
    style: { width: '70px' },
    onchange: (e) => { this._resumeWalker.radius = Math.max(0.25, Number(e.target.value) || 5.0); this._savePrefs(); },
    title: 'Walker loop radius (meters)',
  });
  const resumeWalkerTexSrcInput = el('input', {
    value: safeTrim(this._resumeWalker?.textureSourceUrl || ''),
    placeholder: 'Texture source GLB (default: outputs/new_tpose_trellis.glb)',
    onchange: (e) => { this._resumeWalker.textureSourceUrl = safeTrim(e.target.value || ''); this._savePrefs(); },
    title: 'Loads textures/materials from this GLB and applies them onto the animated walker.',
  });
  const resumeWalkerReloadTexBtn = el('button', {
    onclick: async () => {
      try {
        await this._loadResumeWalkerTextureSource({ force: true });
        this._applyResumeWalkerTextures();
      } catch { /* ignore */ }
    },
    title: 'Reload texture source and apply to walker',
  }, ['Reload textures']);
  const resumeWalkerReloadBtn = el('button', {
    onclick: async () => { try { await this._loadResumeShowcaseWalker({ force: true }); } catch { /* ignore */ } },
    title: 'Reload walker now',
  }, ['Reload walker']);

  editToolsHost.appendChild(detailsCard('Characters', { open: false, hint: 'saved profiles / 25 people' }, [
    el('div', { class: 'muted', style: { fontSize: '10px' } }, [
      'Third-person avatar uses saved character locomotion profiles. The penthouse demo can also populate 25 characters onto chairs/spawn markers.',
    ]),
    el('div', { class: 'row', style: { marginTop: '8px', gap: '10px', flexWrap: 'wrap', alignItems: 'center' } }, [
      el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [avatarEnabledChk, el('span', { class: 'muted' }, ['Third-person avatar'])]),
      el('div', { style: { flex: '1 1 260px' } }, [el('div', { class: 'fieldLabel' }, ['Avatar asset']), avatarUrlInput]),
      el('div', { class: 'row', style: { gap: '6px', alignItems: 'center' } }, [
        el('span', { class: 'muted' }, ['Scale']), avatarScaleInput,
        el('span', { class: 'muted' }, ['Y off']), avatarYOffsetInput,
      ]),
      avatarReloadBtn,
    ]),
    el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, [
      el('div', { style: { flex: '1 1 360px' } }, [el('div', { class: 'fieldLabel' }, ['Saved character profiles']), avatarProfilesSel]),
      useSavedAvatarBtn,
      refreshAvatarProfilesBtn,
    ]),
    el('div', { style: { marginTop: '10px', fontWeight: '600', fontSize: '11px' } }, ['Scenario cast defaults']),
    el('div', { class: 'muted', style: { marginTop: '4px', fontSize: '10px' } }, [
      'Choose a character profile + optional forced action that should apply when this scenario is loaded.',
    ]),
    el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, [
      el('div', { style: { flex: '1 1 360px' } }, [el('div', { class: 'fieldLabel' }, ['Scenario character']), scenarioAvatarSel]),
      refreshScenarioCastBtn,
    ]),
    el('div', { class: 'row', style: { marginTop: '6px', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, [
      el('div', { style: { flex: '1 1 260px' } }, [el('div', { class: 'fieldLabel' }, ['Scenario action']), scenarioActionSel]),
      applyScenarioCastNowBtn,
      saveScenarioCastDefaultsBtn,
      clearScenarioCastDefaultsBtn,
    ]),
    el('div', { class: 'muted', style: { marginTop: '6px', fontSize: '10px' } }, [
      'Only saved character manifests/locomotion profiles are treated as characters. GLB/FBX/USD model URLs are routed to Assets as props.',
    ]),
    el('div', { class: 'row', style: { marginTop: '10px', gap: '10px', flexWrap: 'wrap', alignItems: 'center' } }, [
      el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [peopleEnabledChk, el('span', { class: 'muted' }, ['Penthouse people'])]),
      el('div', { style: { flex: '1 1 260px' } }, [el('div', { class: 'fieldLabel' }, ['People GLB']), peopleUrlInput]),
      el('div', { class: 'row', style: { gap: '6px', alignItems: 'center' } }, [
        el('span', { class: 'muted' }, ['Max']), peopleMaxInput,
        el('span', { class: 'muted' }, ['Scale']), peopleScaleInput,
        el('span', { class: 'muted' }, ['Y off']), peopleYOffsetInput,
      ]),
      el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [peopleHideSpawnsChk, el('span', { class: 'muted' }, ['Hide spawns'])]),
      peopleRebuildBtn,
    ]),
    el('div', { class: 'row', style: { marginTop: '10px', gap: '10px', flexWrap: 'wrap', alignItems: 'center' } }, [
      el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [resumeWalkerEnabledChk, el('span', { class: 'muted' }, ['Resume walker'])]),
      el('div', { style: { flex: '1 1 260px' } }, [el('div', { class: 'fieldLabel' }, ['Walker GLB']), resumeWalkerUrlInput]),
      el('div', { style: { flex: '1 1 260px' } }, [el('div', { class: 'fieldLabel' }, ['Texture source GLB']), resumeWalkerTexSrcInput]),
      el('div', { class: 'row', style: { gap: '6px', alignItems: 'center' } }, [
        el('span', { class: 'muted' }, ['Speed']), resumeWalkerSpeedInput,
        el('span', { class: 'muted' }, ['Radius']), resumeWalkerRadiusInput,
        el('span', { class: 'muted' }, ['Scale']), resumeWalkerScaleInput,
        el('span', { class: 'muted' }, ['Y off']), resumeWalkerYOffsetInput,
      ]),
      resumeWalkerReloadTexBtn,
      resumeWalkerReloadBtn,
    ]),
  ]));

  // Gameplay tuning (only meaningful for proc:arena but safe to show always)
  editToolsHost.appendChild(detailsCard('Gameplay (proc:arena)', { open: false, hint: 'tuning' }, [
    el('div', { class: 'muted', style: { fontSize: '10px' } }, [
      'These controls tune the built-in FPS demo (HP, enemy difficulty, and visuals).',
    ]),
    el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
      el('div', { style: { flex: '1 1 140px' } }, [
        el('div', { class: 'fieldLabel' }, ['Weapon']),
        el('div', { class: 'row', style: { gap: '6px' } }, [
          el('button', { class: (this._game.activeWeapon === 'rifle') ? 'primary' : '', onclick: () => this._setWeapon('rifle') }, ['Rifle (1)']),
          el('button', { class: (this._game.activeWeapon === 'sniper') ? 'primary' : '', onclick: () => this._setWeapon('sniper') }, ['Sniper (2)']),
        ]),
      ]),
      el('div', { style: { flex: '1 1 140px' } }, [
        el('div', { class: 'fieldLabel' }, ['Player HP']),
        el('input', {
          value: String(this._game?.player?.hpMax ?? 250),
          onchange: (e) => {
            const v = Math.max(50, Math.min(9999, Number(e.target.value) || 250));
            this._game.player.hpMax = v;
            this._game.player.hp = Math.min(this._game.player.hp, v);
          },
        }),
      ]),
      el('div', { style: { flex: '1 1 140px' } }, [
        el('div', { class: 'fieldLabel' }, ['Hit cooldown (s)']),
        el('input', {
          value: String(this._game?.player?.hitCooldownSec ?? 0.12),
          onchange: (e) => { this._game.player.hitCooldownSec = Math.max(0, Math.min(1.0, Number(e.target.value) || 0)); },
        }),
      ]),
      el('button', { onclick: () => { this._game.player.hp = this._game.player.hpMax; this._setStatus('Healed to full.'); } }, ['Full heal']),
      el('button', { onclick: () => { const w = this._weapon(); w.ammoInMag = w.magSize; w.reserve = 999; this._setStatus('Ammo refilled.'); } }, ['Refill ammo']),
      el('button', { onclick: () => { this._spawnDefaultEnemies(); this._setStatus('Enemies respawned.'); } }, ['Respawn enemies']),
      el('button', { onclick: () => { this._spawnDefaultVehicles(); this._setStatus('Vehicles respawned.'); } }, ['Respawn vehicles']),
    ]),
    el('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } }, [
      el('div', { style: { flex: '1 1 140px' } }, [
        el('div', { class: 'fieldLabel' }, ['Enemy dmg']),
        el('input', { value: String(this._game?.enemy?.dmg ?? 7), onchange: (e) => { this._game.enemy.dmg = Math.max(1, Math.min(50, Number(e.target.value) || 7)); } }),
      ]),
      el('div', { style: { flex: '1 1 140px' } }, [
        el('div', { class: 'fieldLabel' }, ['Enemy fireRate']),
        el('input', { value: String(this._game?.enemy?.fireRate ?? 2.4), onchange: (e) => { this._game.enemy.fireRate = Math.max(0.2, Math.min(10, Number(e.target.value) || 2.4)); } }),
      ]),
      el('div', { style: { flex: '1 1 140px' } }, [
        el('div', { class: 'fieldLabel' }, ['Enemy range']),
        el('input', { value: String(this._game?.enemy?.range ?? 55), onchange: (e) => { this._game.enemy.range = Math.max(5, Math.min(200, Number(e.target.value) || 55)); } }),
      ]),
      el('div', { style: { flex: '1 1 140px' } }, [
        el('div', { class: 'fieldLabel' }, ['Enemy accuracy (lower = harder)']),
        el('input', { value: String(this._game?.enemy?.aimErrorScale ?? 2.2), onchange: (e) => { this._game.enemy.aimErrorScale = Math.max(0.4, Math.min(6.0, Number(e.target.value) || 2.2)); } }),
      ]),
      el('div', { style: { flex: '1 1 140px' } }, [
        el('div', { class: 'fieldLabel' }, ['Enemy count']),
        el('input', {
          value: String(this._game?.enemy?.countTarget ?? 6),
          onchange: (e) => {
            const v = Math.max(0, Math.min(80, Math.floor(Number(e.target.value) || 0)));
            this._game.enemy.countTarget = v;
            try { localStorage.setItem('devtools.scene.fps.enemyCount', String(v)); } catch { /* ignore */ }
          },
          title: 'Click “Respawn enemies” to apply',
        }),
      ]),
      el('div', { style: { flex: '1 1 180px' } }, [
        el('div', { class: 'fieldLabel' }, ['Enemy behavior']),
        el('select', {
          value: String(this._game?.enemy?.behavior || 'attack'),
          onchange: (e) => {
            const v = String(e.target.value || 'attack');
            const b = (v === 'patrol' || v === 'sim') ? v : 'attack';
            this._game.enemy.behavior = b;
            try { localStorage.setItem('devtools.scene.fps.enemyBehavior', b); } catch { /* ignore */ }
            this._showMsg(`Enemy behavior: ${b}`, 0.8);
          },
          title: 'attack: chase+shoot · patrol: roam/cover when hit · sim: roam only',
        }, [
          el('option', { value: 'attack' }, ['Attack']),
          el('option', { value: 'patrol' }, ['Patrol']),
          el('option', { value: 'sim' }, ['Sim']),
        ]),
      ]),
    ]),
    el('div', { class: 'row', style: { marginTop: '10px', gap: '10px', flexWrap: 'wrap' } }, [
      el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
        el('input', { type: 'checkbox', checked: !!this._game?.viz?.showGun, onchange: (e) => { this._game.viz.showGun = !!e.target.checked; if (!this._game.viz.showGun) this._clearGun(); } }),
        el('span', { class: 'muted' }, ['Show gun']),
      ]),
      el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
        el('input', { type: 'checkbox', checked: !!this._game?.viz?.showPlayerShots, onchange: (e) => { this._game.viz.showPlayerShots = !!e.target.checked; } }),
        el('span', { class: 'muted' }, ['Player bullets/tracers']),
      ]),
      el('label', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, [
        el('input', { type: 'checkbox', checked: !!this._game?.viz?.showEnemyShots, onchange: (e) => { this._game.viz.showEnemyShots = !!e.target.checked; } }),
        el('span', { class: 'muted' }, ['Enemy bullets/tracers']),
      ]),
    ]),
  ]));

  // Add GLB assets/vehicles into the current world (does not replace the scene).
  const inbox = this._readSceneInbox?.() || null;
  const inboxUrl = (safeTrim(inbox?.kind) === 'spawn_prop' || safeTrim(inbox?.kind) === 'spawn_vehicle_asset')
    ? safeTrim(inbox?.url || '')
    : '';
  const lastAssetUrl = (() => {
    try {
      return String(localStorage.getItem('devtools.scene.assetUrl') || localStorage.getItem('devtools.scene.propUrl') || '');
    } catch {
      return '';
    }
  })();
  const propUrlInput = el('input', {
    value: normalizeAssetUrl(inboxUrl || lastAssetUrl || ''),
    placeholder: 'GLB/GLTF URL (e.g. /webautos/Abarth_124/stream/124spider_hi.glb)',
    onchange: (e) => {
      const v = normalizeAssetUrl(String(e.target.value || ''));
      try { e.target.value = v; } catch { /* ignore */ }
      try { localStorage.setItem('devtools.scene.assetUrl', v); } catch { /* ignore */ }
      // Back-compat with old key.
      try { localStorage.setItem('devtools.scene.propUrl', v); } catch { /* ignore */ }
    },
  });
  const propScaleInput = el('input', {
    value: (() => { try { return String(localStorage.getItem('devtools.scene.propScale') || '1.0'); } catch { return '1.0'; } })(),
    style: { width: '90px' },
    title: 'Uniform scale',
    onchange: (e) => { try { localStorage.setItem('devtools.scene.propScale', String(Number(e.target.value) || 1.0)); } catch { /* ignore */ } },
  });
  const propYawInput = el('input', {
    value: (() => { try { return String(localStorage.getItem('devtools.scene.propYawDeg') || '0'); } catch { return '0'; } })(),
    style: { width: '90px' },
    title: 'Yaw (degrees)',
    onchange: (e) => { try { localStorage.setItem('devtools.scene.propYawDeg', String(Number(e.target.value) || 0)); } catch { /* ignore */ } },
  });
  this._ui.propUrlInput = propUrlInput;
  this._ui.propScaleInput = propScaleInput;
  this._ui.propYawInput = propYawInput;

  const spawnPropAtPlayerBtn = el('button', {
    onclick: async () => {
      try {
        const u = safeTrim(this._ui?.propUrlInput?.value || '');
        if (!u) return;
        const sc = Math.max(0.001, Number(this._ui?.propScaleInput?.value) || 1.0);
        const yawDeg = Number(this._ui?.propYawInput?.value) || 0;
        await this._spawnPropFromUrl(u, { scale: sc, yawDeg, place: 'player' });
        this._setStatus('Spawned prop at player.');
        this._ctx?.toast?.('Prop spawned', 'success', { title: 'Props' });
      } catch (e) {
        this._ctx?.toast?.(`Spawn failed: ${e?.message || e}`, 'error', { title: 'Props' });
      }
    },
    title: 'Loads the GLB/GLTF and places it at the player position (snapped to ground)',
  }, ['Spawn @ player']);

  const spawnPropAtSpawnBtn = el('button', {
    onclick: async () => {
      try {
        const u = safeTrim(this._ui?.propUrlInput?.value || '');
        if (!u) return;
        const sc = Math.max(0.001, Number(this._ui?.propScaleInput?.value) || 1.0);
        const yawDeg = Number(this._ui?.propYawInput?.value) || 0;
        await this._spawnPropFromUrl(u, { scale: sc, yawDeg, place: 'spawn' });
        this._setStatus('Spawned prop at spawn marker.');
        this._ctx?.toast?.('Prop spawned', 'success', { title: 'Props' });
      } catch (e) {
        this._ctx?.toast?.(`Spawn failed: ${e?.message || e}`, 'error', { title: 'Props' });
      }
    },
    title: 'Loads the GLB/GLTF and places it at the spawn marker (snapped to ground)',
  }, ['Spawn @ spawn']);

  const spawnVehicleAtPlayerBtn = el('button', {
    class: 'primary',
    onclick: async () => {
      try {
        const u = safeTrim(this._ui?.propUrlInput?.value || '');
        if (!u) return;
        const sc = Math.max(0.001, Number(this._ui?.propScaleInput?.value) || 1.0);
        const yawDeg = Number(this._ui?.propYawInput?.value) || 0;
        const inboxCfg = (safeTrim(inbox?.kind) === 'spawn_vehicle_asset' && safeTrim(inbox?.url))
          ? (inbox?.vehicleConfig && typeof inbox.vehicleConfig === 'object' ? inbox.vehicleConfig : null)
          : null;
        const out = await this._spawnDriveableVehicleFromAssetUrl(u, { scale: sc, yawDeg, place: 'player', vehicleConfig: inboxCfg });
        if (!out) {
          const spawnErr = safeTrim(this._vehicleSystem?._lastVehicleSpawnError || '');
          if (spawnErr) throw new Error(spawnErr);
          const wasmErr = safeTrim(this._vehicleSystem?._chronoVehWasm?.initError || '');
          if (!this._vehicleSystem?._chronoVehWasm?.ready && wasmErr) throw new Error(`Vehicle sim unavailable: ${wasmErr}`);
          throw new Error('Vehicle sim unavailable or model failed to load.');
        }
        this._setStatus('Spawned driveable vehicle at player.');
        this._ctx?.toast?.('Driveable vehicle spawned', 'success', { title: 'Vehicles' });
      } catch (e) {
        this._ctx?.toast?.(`Vehicle spawn failed: ${e?.message || e}`, 'error', { title: 'Vehicles' });
      }
    },
    title: 'Loads the GLB/GLTF and spawns it as a driveable vehicle at the player position',
  }, ['Spawn vehicle @ player']);

  const spawnVehicleAtSpawnBtn = el('button', {
    onclick: async () => {
      try {
        const u = safeTrim(this._ui?.propUrlInput?.value || '');
        if (!u) return;
        const sc = Math.max(0.001, Number(this._ui?.propScaleInput?.value) || 1.0);
        const yawDeg = Number(this._ui?.propYawInput?.value) || 0;
        const inboxCfg = (safeTrim(inbox?.kind) === 'spawn_vehicle_asset' && safeTrim(inbox?.url))
          ? (inbox?.vehicleConfig && typeof inbox.vehicleConfig === 'object' ? inbox.vehicleConfig : null)
          : null;
        const out = await this._spawnDriveableVehicleFromAssetUrl(u, { scale: sc, yawDeg, place: 'spawn', vehicleConfig: inboxCfg });
        if (!out) {
          const spawnErr = safeTrim(this._vehicleSystem?._lastVehicleSpawnError || '');
          if (spawnErr) throw new Error(spawnErr);
          const wasmErr = safeTrim(this._vehicleSystem?._chronoVehWasm?.initError || '');
          if (!this._vehicleSystem?._chronoVehWasm?.ready && wasmErr) throw new Error(`Vehicle sim unavailable: ${wasmErr}`);
          throw new Error('Vehicle sim unavailable or model failed to load.');
        }
        this._setStatus('Spawned driveable vehicle at spawn marker.');
        this._ctx?.toast?.('Driveable vehicle spawned', 'success', { title: 'Vehicles' });
      } catch (e) {
        this._ctx?.toast?.(`Vehicle spawn failed: ${e?.message || e}`, 'error', { title: 'Vehicles' });
      }
    },
    title: 'Loads the GLB/GLTF and spawns it as a driveable vehicle at the spawn marker',
  }, ['Spawn vehicle @ spawn']);

  const clearPropsBtn = el('button', {
    class: 'danger',
    onclick: () => { this._clearAllProps(); this._setStatus('Cleared spawned props.'); },
    title: 'Deletes all spawned props (does not affect the base scene)',
  }, ['Clear props']);

  const propsHost = el('div', { style: { marginTop: '8px' } }, []);
  this._ui.propsHost = propsHost;

  editToolsHost.appendChild(detailsCard('Assets and vehicles (spawn GLBs into current world)', { open: true, hint: 'import webautos into scenes' }, [
    el('div', { class: 'muted', style: { fontSize: '10px' } }, [
      'Use this to add a vehicle or prop to your current scene. Vehicle spawn is driveable; prop spawn is static.',
    ]),
    el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, [
      el('div', { style: { flex: '1 1 360px' } }, [el('div', { class: 'fieldLabel' }, ['Vehicle / Asset URL']), propUrlInput]),
      el('div', { class: 'row', style: { gap: '6px', alignItems: 'center' } }, [
        el('span', { class: 'muted' }, ['Scale']), propScaleInput,
        el('span', { class: 'muted' }, ['Yaw°']), propYawInput,
      ]),
    ]),
    el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
      spawnVehicleAtPlayerBtn,
      spawnVehicleAtSpawnBtn,
      spawnPropAtPlayerBtn,
      spawnPropAtSpawnBtn,
      clearPropsBtn,
    ]),
    propsHost,
  ]));

  // --- Scenario content: waypoints + triggers ---
  const wpNameInput = el('input', { value: '', placeholder: 'waypoint name (e.g. Lobby)' });
  this._ui.wpNameInput = wpNameInput;
  const addWpBtn = el('button', {
    onclick: () => {
      const name = safeTrim(this._ui.wpNameInput?.value || '') || `Waypoint ${this._scenarioContent.waypoints.length + 1}`;
      this._addWaypointFromCurrent(name);
      let createdName = name;
      try {
        const wps = Array.isArray(this._scenarioContent.waypoints) ? this._scenarioContent.waypoints : [];
        const last = wps.length ? safeTrim(wps[wps.length - 1]?.name) : '';
        if (last) this._scenarioSel.waypointName = last;
        this._scenarioSel.triggerId = '';
        if (last) createdName = last;
      } catch { /* ignore */ }
      this._renderWaypointsUi();
      this._renderTriggersUi(); // update teleport target list
      this._rebuildScenarioDebug();
      this._setStatus(`Added waypoint: ${createdName} (remember to Save scenario).`);
    },
  }, ['Add waypoint (here)']);

  const trigNameInput = el('input', { value: '', placeholder: 'trigger name (optional)' });
  const trigMsgInput = el('input', { value: 'Hello!', placeholder: 'message (for message trigger)' });
  const trigSizeInput = el('input', { value: '3,2,3', style: { width: '90px' }, title: 'sizeX,sizeY,sizeZ (meters)' });
  const trigOnceChk = el('input', { type: 'checkbox', checked: true, title: 'Fire once per load' });
  const trigInteractChk = el('input', { type: 'checkbox', checked: false, title: 'Require pressing E to trigger' });
  const trigPromptInput = el('input', { value: 'Use', placeholder: 'prompt (e.g. Use / Open / Read)', title: 'Shown as “Press E: <prompt>” when inside' });
  const trigTargetSel = el('select', {}, [el('option', { value: '' }, ['(teleport target waypoint)'])]);
  const trigActionSel = el('select', {}, [
    el('option', { value: '' }, ['(no message action)']),
    el('option', { value: 'avatar_set_profile' }, ['Set character profile']),
    el('option', { value: 'avatar_set_action' }, ['Set character action']),
    el('option', { value: 'avatar_clear_action' }, ['Clear forced character action']),
  ]);
  const trigAvatarProfileInput = el('input', {
    value: '',
    placeholder: 'character profile json (for Set character profile action)',
  });
  const trigAvatarActionSel = el('select', {}, [
    el('option', { value: '' }, ['(select character action key)']),
    ...CHARACTER_ACTION_KEYS.map((k) => el('option', { value: k }, [k])),
  ]);
  this._ui.trigNameInput = trigNameInput;
  this._ui.trigMsgInput = trigMsgInput;
  this._ui.trigSizeInput = trigSizeInput;
  this._ui.trigOnceChk = trigOnceChk;
  this._ui.trigTargetSel = trigTargetSel;
  this._ui.trigInteractChk = trigInteractChk;
  this._ui.trigPromptInput = trigPromptInput;

  const addMsgTrigBtn = el('button', {
    onclick: () => {
      const name = safeTrim(trigNameInput.value) || `Message ${this._scenarioContent.triggers.length + 1}`;
      const msg = safeTrim(trigMsgInput.value) || 'Hello!';
      const size = this._parseSizeCsv(trigSizeInput.value, [3, 2, 3]);
      const action = safeTrim(trigActionSel.value).toLowerCase();
      const avatarProfile = safeTrim(trigAvatarProfileInput.value);
      const avatarAction = this._sanitizeCharacterActionKey(trigAvatarActionSel.value);
      this._addTriggerAtCurrent({
        name,
        type: 'message',
        once: !!trigOnceChk.checked,
        message: msg,
        requireInteract: !!trigInteractChk.checked,
        prompt: safeTrim(trigPromptInput.value) || 'Read',
        size,
        action,
        avatarProfile,
        avatarAction,
      });
      try {
        const trigs = Array.isArray(this._scenarioContent.triggers) ? this._scenarioContent.triggers : [];
        const last = trigs.length ? safeTrim(trigs[trigs.length - 1]?.id) : '';
        if (last) this._scenarioSel.triggerId = last;
        this._scenarioSel.waypointName = '';
      } catch { /* ignore */ }
      this._renderTriggersUi();
      this._rebuildScenarioDebug();
      this._setStatus(`Added message trigger${action ? ` (${action})` : ''}: ${name} (remember to Save scenario).`);
    },
  }, ['Add message trigger (here)']);

  const addTpTrigBtn = el('button', {
    onclick: () => {
      const target = safeTrim(trigTargetSel.value);
      if (!target) { this._setStatus('Pick a waypoint target first.'); return; }
      const name = safeTrim(trigNameInput.value) || `Teleport ${this._scenarioContent.triggers.length + 1}`;
      const size = this._parseSizeCsv(trigSizeInput.value, [3, 2, 3]);
      this._addTriggerAtCurrent({
        name,
        type: 'teleport',
        once: !!trigOnceChk.checked,
        targetWaypoint: target,
        requireInteract: !!trigInteractChk.checked,
        prompt: safeTrim(trigPromptInput.value) || 'Use',
        size,
      });
      try {
        const trigs = Array.isArray(this._scenarioContent.triggers) ? this._scenarioContent.triggers : [];
        const last = trigs.length ? safeTrim(trigs[trigs.length - 1]?.id) : '';
        if (last) this._scenarioSel.triggerId = last;
        this._scenarioSel.waypointName = '';
      } catch { /* ignore */ }
      this._renderTriggersUi();
      this._rebuildScenarioDebug();
      this._setStatus(`Added teleport trigger: ${name} → ${target} (remember to Save scenario).`);
    },
  }, ['Add teleport trigger (here)']);

  const addGoalTrigBtn = el('button', {
    onclick: () => {
      const name = safeTrim(trigNameInput.value) || `Goal ${this._scenarioContent.triggers.length + 1}`;
      const size = this._parseSizeCsv(trigSizeInput.value, [4, 2, 4]);
      this._addTriggerAtCurrent({
        name,
        type: 'goal',
        once: true,
        requireInteract: !!trigInteractChk.checked,
        prompt: safeTrim(trigPromptInput.value) || 'Complete',
        size,
      });
      try {
        const trigs = Array.isArray(this._scenarioContent.triggers) ? this._scenarioContent.triggers : [];
        const last = trigs.length ? safeTrim(trigs[trigs.length - 1]?.id) : '';
        if (last) this._scenarioSel.triggerId = last;
        this._scenarioSel.waypointName = '';
      } catch { /* ignore */ }
      this._renderTriggersUi();
      this._renderObjectivesUi();
      this._rebuildScenarioDebug();
      this._setStatus(`Added goal trigger: ${name} (remember to Save scenario).`);
    },
    title: 'Adds an objective zone; entering it completes the goal (and can be interact-gated)',
  }, ['Add goal trigger (here)']);

  // Filters + editors
  const wpFilterInput = el('input', {
    value: String(this._scenarioUi?.wpFilter || ''),
    placeholder: 'filter waypoints…',
    oninput: (() => {
      const apply = debounce((v) => {
        this._scenarioUi.wpFilter = String(v || '');
        this._renderWaypointsUi();
      }, 120);
      return (e) => apply(String(e.target?.value || ''));
    })(),
  });
  this._ui.wpFilterInput = wpFilterInput;

  const trigFilterInput = el('input', {
    value: String(this._scenarioUi?.trigFilter || ''),
    placeholder: 'filter triggers…',
    oninput: (() => {
      const apply = debounce((v) => {
        this._scenarioUi.trigFilter = String(v || '');
        this._renderTriggersUi();
      }, 120);
      return (e) => apply(String(e.target?.value || ''));
    })(),
  });
  this._ui.trigFilterInput = trigFilterInput;

  const waypointsHost = el('div', { class: 'scrollArea', style: { height: '150px', marginTop: '8px' } }, ['(no waypoints)']);
  const triggersHost = el('div', { class: 'scrollArea', style: { height: '180px', marginTop: '8px' } }, ['(no triggers)']);
  const objectivesHost = el('div', { class: 'scrollArea', style: { height: '120px', marginTop: '8px' } }, ['(no objectives)']);
  this._ui.waypointsHost = waypointsHost;
  this._ui.triggersHost = triggersHost;
  this._ui.objectivesHost = objectivesHost;

  const waypointEditorHost = el('div', { style: { marginTop: '8px' } }, ['']);
  const triggerEditorHost = el('div', { style: { marginTop: '8px' } }, ['']);
  this._ui.waypointEditorHost = waypointEditorHost;
  this._ui.triggerEditorHost = triggerEditorHost;

  const resetProgressBtn = el('button', {
    onclick: () => {
      this._completedGoals.clear();
      this._triggerFired.clear();
      this._triggerInside.clear();
      this._renderObjectivesUi();
      this._setStatus('Progress reset (goals/triggers).');
    },
    title: 'Clears runtime progress; does not modify scenario JSON.',
  }, ['Reset progress']);

  editToolsHost.appendChild(detailsCard('Scenario content', { open: false, hint: 'waypoints · triggers' }, [
    el('div', { class: 'muted', style: { marginTop: '2px' } }, [
      'Waypoints and trigger volumes are saved into the scenario JSON (Copy JSON / Save scenario).',
    ]),
    el('div', { style: { marginTop: '10px', fontWeight: '600', fontSize: '11px' } }, ['Waypoints']),
    el('div', { class: 'row', style: { marginTop: '6px', gap: '8px', flexWrap: 'wrap' } }, [
      el('div', { style: { flex: '2 1 220px' } }, [el('div', { class: 'fieldLabel' }, ['Name']), wpNameInput]),
      addWpBtn,
    ]),
    el('div', { class: 'row', style: { marginTop: '6px', gap: '8px', flexWrap: 'wrap' } }, [
      el('div', { style: { flex: '2 1 220px' } }, [el('div', { class: 'fieldLabel' }, ['Filter']), wpFilterInput]),
      el('button', {
        onclick: () => {
          this._scenarioUi.wpFilter = '';
          try { wpFilterInput.value = ''; } catch { /* ignore */ }
          this._renderWaypointsUi();
        },
        title: 'Clear waypoint filter',
      }, ['Clear']),
    ]),
    waypointsHost,
    waypointEditorHost,

    el('div', { style: { marginTop: '12px', fontWeight: '600', fontSize: '11px' } }, ['Triggers']),
    el('div', { class: 'row', style: { marginTop: '6px', gap: '8px', flexWrap: 'wrap' } }, [
      el('div', { style: { flex: '2 1 220px' } }, [el('div', { class: 'fieldLabel' }, ['Name']), trigNameInput]),
      el('div', { style: { flex: '2 1 220px' } }, [el('div', { class: 'fieldLabel' }, ['Size (x,y,z)']), trigSizeInput]),
      el('label', { class: 'row', style: { gap: '8px', alignItems: 'center', flex: '0 0 auto', marginTop: '14px' } }, [
        trigOnceChk, el('span', { class: 'muted' }, ['Once']),
      ]),
      el('label', { class: 'row', style: { gap: '8px', alignItems: 'center', flex: '0 0 auto', marginTop: '14px' } }, [
        trigInteractChk, el('span', { class: 'muted' }, ['Interact (E)']),
      ]),
    ]),
    el('div', { class: 'row', style: { marginTop: '6px', gap: '8px', flexWrap: 'wrap' } }, [
      el('div', { style: { flex: '2 1 240px' } }, [el('div', { class: 'fieldLabel' }, ['Prompt']), trigPromptInput]),
    ]),
    el('div', { class: 'row', style: { marginTop: '6px', gap: '8px', flexWrap: 'wrap' } }, [
      el('div', { style: { flex: '2 1 240px' } }, [el('div', { class: 'fieldLabel' }, ['Message']), trigMsgInput]),
      addMsgTrigBtn,
    ]),
    el('div', { class: 'row', style: { marginTop: '6px', gap: '8px', flexWrap: 'wrap' } }, [
      el('div', { style: { flex: '2 1 240px' } }, [el('div', { class: 'fieldLabel' }, ['Message action']), trigActionSel]),
    ]),
    el('div', { class: 'row', style: { marginTop: '6px', gap: '8px', flexWrap: 'wrap' } }, [
      el('div', { style: { flex: '2 1 240px' } }, [el('div', { class: 'fieldLabel' }, ['Action character profile']), trigAvatarProfileInput]),
      el('div', { style: { flex: '1 1 220px' } }, [el('div', { class: 'fieldLabel' }, ['Action character key']), trigAvatarActionSel]),
    ]),
    el('div', { class: 'row', style: { marginTop: '6px', gap: '8px', flexWrap: 'wrap' } }, [
      el('div', { style: { flex: '2 1 240px' } }, [el('div', { class: 'fieldLabel' }, ['Teleport target']), trigTargetSel]),
      addTpTrigBtn,
    ]),
    el('div', { class: 'row', style: { marginTop: '6px', gap: '8px', flexWrap: 'wrap' } }, [
      addGoalTrigBtn,
      resetProgressBtn,
    ]),
    el('div', { style: { marginTop: '10px', fontWeight: '600', fontSize: '11px' } }, ['Objectives (goals)']),
    objectivesHost,
    el('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } }, [
      el('div', { style: { flex: '2 1 220px' } }, [el('div', { class: 'fieldLabel' }, ['Filter']), trigFilterInput]),
      el('button', {
        onclick: () => {
          this._scenarioUi.trigFilter = '';
          try { trigFilterInput.value = ''; } catch { /* ignore */ }
          this._renderTriggersUi();
        },
        title: 'Clear trigger filter',
      }, ['Clear']),
    ]),
    triggersHost,
    triggerEditorHost,
  ]));

  // --- Buildings (project tagged) ---
  const buildingFilterInput = el('input', {
    value: String(this._buildings?.filter || ''),
    placeholder: 'filter buildings…',
    oninput: (() => {
      const apply = debounce((v) => {
        this._buildings.filter = String(v || '');
        this._renderBuildingsUi();
      }, 120);
      return (e) => apply(String(e.target?.value || ''));
    })(),
    title: 'Matches by object name/uuid',
  });
  this._ui.buildingFilterInput = buildingFilterInput;

  const selectionInfoEl = el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-line', fontSize: '10px' } }, ['']);
  this._ui.selectionInfoEl = selectionInfoEl;

  const buildingsHost = el('div', { class: 'scrollArea', style: { height: '150px', marginTop: '8px' } }, ['(no tagged buildings)']);
  const buildingEditorHost = el('div', { style: { marginTop: '8px' } }, ['']);
  this._ui.buildingsHost = buildingsHost;
  this._ui.buildingEditorHost = buildingEditorHost;

  const copySelBtn = el('button', {
    onclick: async () => {
      try {
        this._scanTaggedBuildings();
        const items = Array.isArray(this._taggedBuildings) ? this._taggedBuildings : [];
        const uuid = safeTrim(this._buildingSel?.uuid || '');
        const o = items.find((x) => safeTrim(x?.uuid) === uuid) || null;
        if (!o) { this._setStatus('No building selected.'); return; }
        const rec = this._exportBuildingRecord(o);
        try { await navigator.clipboard.writeText(JSON.stringify(rec, null, 2)); } catch { /* ignore */ }
        this._setStatus('Copied selected building JSON to clipboard.');
      } catch (e) {
        this._setStatus(`Copy failed: ${e?.message || e}`);
      }
    },
    title: 'Copies the selected building JSON record to clipboard',
  }, ['Copy selected JSON']);

  const saveSelBtn = el('button', {
    class: 'primary',
    onclick: async () => {
      try {
        this._scanTaggedBuildings();
        const items = Array.isArray(this._taggedBuildings) ? this._taggedBuildings : [];
        const uuid = safeTrim(this._buildingSel?.uuid || '');
        const o = items.find((x) => safeTrim(x?.uuid) === uuid) || null;
        if (!o) { this._setStatus('No building selected.'); return; }
        const j = await this._saveBuildingAssetToAssets({ obj: o, overwrite: true });
        this._setStatus(`Saved building → ${String(j?.relPath || '')}`);
        this._ctx?.toast?.(`Saved building: ${String(j?.relPath || '')}`, 'success', { title: 'Buildings' });
      } catch (e) {
        this._setStatus(`Save failed: ${e?.message || e}`);
        this._ctx?.toast?.(`Save failed: ${e?.message || e}`, 'error', { title: 'Buildings' });
      }
    },
    title: 'Saves/overwrites the selected building JSON asset (or creates a new one if it has no asset path yet).',
  }, ['Save selected → assets']);

  const saveAllBtn = el('button', {
    onclick: async () => {
      try {
        const out = await this._saveAllBuildingsAsAssets({ overwriteExisting: true });
        this._setStatus(`Saved ${out.count} building assets.`);
        this._ctx?.toast?.(`Saved ${out.count} building assets`, 'success', { title: 'Buildings' });
      } catch (e) {
        this._setStatus(`Save-all failed: ${e?.message || e}`);
        this._ctx?.toast?.(`Save-all failed: ${e?.message || e}`, 'error', { title: 'Buildings' });
      }
    },
    title: `Saves all tagged buildings as individual JSON assets under ${SCENE_ASSET_LOCATIONS.buildings}`,
  }, ['Save all → assets']);

  const copyAllBtn = el('button', {
    onclick: async () => {
      const payload = this._exportAllBuildingsPayload();
      try { await navigator.clipboard.writeText(JSON.stringify(payload, null, 2)); } catch { /* ignore */ }
      this._setStatus(`Copied ${payload.length} buildings JSON to clipboard.`);
    },
    title: 'Copies an array of all tagged buildings to clipboard',
  }, ['Copy all JSON']);

  const scanBtn = el('button', {
    onclick: () => {
      this._scanTaggedBuildings();
      this._renderBuildingsUi();
      this._renderBuildingEditorUi();
      this._setStatus('Scanned tagged buildings.');
    },
    title: 'Re-scan the scene for objects tagged projectTags=["buildings"]',
  }, ['Scan']);

  const createPrimBtn = el('button', {
    class: 'primary',
    onclick: () => {
      // Defaults are tuned for quick blockout; refine in the Building editor.
      this._createPrimitiveBuildingAtPlayer({ name: 'building', w: 14, d: 12, h: 7 });
      this._setStatus('Created primitive building at player.');
    },
    title: 'Creates a new tagged building (primitive box) at the player position.',
  }, ['Create building (primitive)']);

  const tagSelBtn = el('button', {
    onclick: () => {
      const o = this._selection?.obj || null;
      if (!o) { this._setStatus('No selection. Shift+Click an object in Orbit mode to select it.'); return; }
      this._addProjectTag(o, 'buildings');
      this._scanTaggedBuildings();
      this._buildingSel.uuid = o.uuid;
      this._renderBuildingsUi();
      this._renderBuildingEditorUi();
      this._setStatus(`Tagged as building: ${safeTrim(o?.name) || o?.uuid || '(unnamed)'}`);
    },
    title: 'Tags the currently selected object as a building. Use Orbit mode + Shift+Click to select.',
  }, ['Tag selection as building']);

  editToolsHost.appendChild(detailsCard('Buildings', { open: false, hint: 'projectTags: buildings' }, [
    el('div', { class: 'muted', style: { fontSize: '10px' } }, [
      'Orbit mode: Shift+Click to select objects. Tag a building root with projectTags=[buildings], then edit transform below.',
    ]),
    el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [
      scanBtn,
      createPrimBtn,
      tagSelBtn,
      copySelBtn,
      copyAllBtn,
      saveSelBtn,
      saveAllBtn,
      el('div', { style: { flex: '1' } }),
      el('div', { style: { flex: '1 1 220px' } }, [el('div', { class: 'fieldLabel' }, ['Filter']), buildingFilterInput]),
    ]),
    selectionInfoEl,
    buildingsHost,
    buildingEditorHost,
  ]));

  // --- Convert (USD/FBX → GLB) ---
  const outNameInput = el('input', {
    value: this._state.outName,
    placeholder: 'output name (optional)',
    oninput: (e) => { this._state.outName = safeTrim(e.target.value); },
  });
  this._ui.outNameInput = outNameInput;

  const runnerSel = el('select', { value: this._state.runner }, [
    el('option', { value: 'conda_trellis' }, ['conda run -n trellis']),
    el('option', { value: 'python3' }, ['python3 (current env)']),
  ]);
  this._ui.runnerSel = runnerSel;
  runnerSel.onchange = (e) => {
    this._state.runner = String(e.target.value || 'conda_trellis');
    this._savePrefs();
  };

  const conv = createJobRunner({
    ctx: this._ctx,
    label: 'Convert (USD/FBX → GLB)',
    startLabel: 'Convert',
    killLabel: 'Kill',
    logHeight: '160px',
    onStart: async () => {
      const inPath = safeTrim(this._state.sourceUrl);
      if (!inPath) throw new Error('Missing input path');
      const ext = extOf(inPath);
      if (!isConvertibleSceneExt(ext)) throw new Error('Input must be USD/USDC/USDA/USDZ or FBX');

      const base = safeName(this._state.outName || `${getFileStem(inPath)}_scene`);
      const runner = String(this._state.runner || 'conda_trellis');

      const resp = await fetch('/__devtools_convert_start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runner, inPath, outName: base }),
      });
      const j = await resp.json();
      if (!j?.ok) throw new Error(String(j?.error || 'convert start failed'));
      return { id: String(j?.id || ''), outGlb: String(j?.outGlb || '') };
    },
    onPoll: async (id) => {
      const resp = await fetch(`/__devtools_convert_job?id=${encodeURIComponent(String(id || ''))}`);
      const j = await resp.json();
      if (!j?.ok) throw new Error(String(j?.error || 'poll failed'));
      return j;
    },
    onKill: async (id) => {
      await fetch('/__devtools_convert_kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
    },
    onDone: async (job) => {
      const out = safeTrim(job?.outGlb || '');
      if (String(job?.status || '') === 'done' && out) {
        this._ctx?.log?.(`Scene: converted → ${out}`);
        this._setSourceUrl(out);
        try { if (this._ui.sourceInput) this._ui.sourceInput.value = out; } catch { /* ignore */ }
        await this._loadGlb(out);
        if (this._state.autoPlayAfterLoad) {
          this._state.mode = 'fps';
          this._savePrefs();
          this._tryPointerLock('auto_play_after_convert');
          this._syncModeUi();
        }
      }
    },
  });

  createToolsHost.appendChild(detailsCard('Convert & asset browser', { open: false, hint: 'USD/FBX -> GLB' }, [
    el('div', { class: 'row', style: { marginTop: '2px', gap: '8px' } }, [
      el('div', { style: { flex: '2' } }, [el('div', { class: 'fieldLabel' }, ['Runner']), runnerSel]),
      el('div', { style: { flex: '2' } }, [el('div', { class: 'fieldLabel' }, ['Output name']), outNameInput]),
    ]),
    el('div', { class: 'muted', style: { marginTop: '8px', fontSize: '10px' } }, [
      'Tip: Omniverse USD scenes must be converted to GLB before the browser can render them.',
    ]),
    conv.element,
    createAssetPicker({
      ctx: this._ctx,
      title: 'Find scene assets (GLB/GLTF/USD/FBX)',
      ext: '.glb,.gltf,.usd,.usda,.usdc,.usdz,.fbx',
      placeholder: 'Search (e.g. city, tower, restaurant, character)',
      onPick: (p) => {
        this._setSourceUrl(p);
        try { if (this._ui.sourceInput) this._ui.sourceInput.value = p; } catch { /* ignore */ }
        this._setStatus('Picked asset. Load GLB, or Convert if USD/FBX.');
      },
    }),
  ]));

  host.appendChild(createToolsHost);
  host.appendChild(editToolsHost);
  applyUiMode();

  this._syncModeUi();
  this._renderWaypointsUi();
  this._renderTriggersUi();
  this._renderObjectivesUi();
  this._scanTaggedBuildings();
  this._renderBuildingsUi();
  this._renderBuildingEditorUi();
  this._rebuildScenarioDebug();
  this._renderPropsUi();
}

export function sceneTool_syncModeUi() {
  if (this._orbit) this._orbit.enabled = (this._state.mode === 'orbit');
  if (this._ui.modeSel) this._ui.modeSel.value = (this._state.mode === 'orbit') ? 'orbit' : 'fps';
}

