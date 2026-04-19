import { el, clear, clamp } from '../../ui/dom.js';
import { SceneTool } from './scene_tool.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createAssetPicker } from '../components/ui_components.js';

function safeTrim(s) { return String(s ?? '').trim(); }

function resizeCanvasToDisplaySize(canvasEl, maxDpr = 2.0) {
  const dpr = Math.min(maxDpr, window.devicePixelRatio || 1);
  const rect = canvasEl.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (canvasEl.width !== w || canvasEl.height !== h) {
    canvasEl.width = w;
    canvasEl.height = h;
    return { changed: true, dpr, w, h };
  }
  return { changed: false, dpr, w: canvasEl.width, h: canvasEl.height };
}

export class ForgeTool extends SceneTool {
  constructor() {
    super();
    this.id = 'forge';
    this.label = 'Forge';

    this._state.mode = 'orbit';
    this._state.autoPlayAfterLoad = false;
    this._state.showGrid = true;

    this._forge = {
      terrainSize: 120,
      terrainResolution: 65, // 65x65 verts
      maxTerrainHeight: 28,
      terrainColor: 0x2a313f,
      brushMode: 'raise', // raise | lower | flatten | smooth
      brushRadius: 4.0,
      brushStrength: 1.4,
      flattenTarget: 0.0,
      sculptEnabled: true,
      heights: null,
      terrainMesh: null,
      terrainMat: null,
      terrainGeom: null,
      brushRing: null,
      placePreview: null,
      activeStroke: false,
      propUrl: '',
      propScale: 1.0,
      propYaw: 0.0,
      cameraMode: 'fly', // fly | orbit
      cameraSpeed: 18.0,
      cameraFastMul: 3.0,
      cameraSlowMul: 0.35,
      lookSensitivity: 0.0024,
      focusLayout: true,
      focusHidePanel: true,
      actionMode: 'select', // select | sculpt | place_block | place_wall | place_ceiling | place_floor | place_prop
      snapEnabled: true,
      snapSize: 1.0,
      previewEnabled: true,
      quickTerrainPreset: 'medium', // small | medium | large
      quickLayoutPreset: 'arena', // arena | corridor | outpost
    };
    this._forgeBulkPlacing = false;

    this._raycaster = new THREE.Raycaster();
    this._mouseNdc = new THREE.Vector2();
    this._forgeStatus = '';
    this._forgeMouseMoveHandler = (e) => this._onForgeMouseMove(e);
    this._forgeKeyDownHandler = (e) => this._onForgeKeyDown(e);
    this._forgeKeyUpHandler = (e) => this._onForgeKeyUp(e);
    this._forgeWindowBlurHandler = () => this._onForgeBlur();
    this._forgeCam = {
      keys: new Set(),
      lookActive: false,
      yaw: 0,
      pitch: -0.3,
      savedDockVisibility: null,
    };
    this._forgeHud = {
      root: null,
      modeChip: null,
      statusChip: null,
      cursorChip: null,
      quickMenu: null,
      quickOpen: false,
    };

    this._prefsKey = 'devtools.forge.state';
    this._snapshotDraftKey = 'devtools.forge.snapshotDraftJson';
    this._loadForgePrefs();
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;

    this._canvas = document.createElement('canvas');
    this._canvas.style.width = '100%';
    this._canvas.style.height = '100%';
    ctx.canvasHost.appendChild(this._canvas);

    const renderer = new THREE.WebGLRenderer({
      canvas: this._canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    renderer.setClearColor(new THREE.Color(0x06080c), 1.0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this._renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x06080c);
    this._scene = scene;

    const camera = new THREE.PerspectiveCamera(70, 1, 0.03, 200000);
    camera.position.set(26, 20, 26);
    this._camera = camera;
    try { scene.add(camera); } catch { /* ignore */ }

    this._orbit = new OrbitControls(camera, this._canvas);
    this._orbit.enableDamping = true;
    this._orbit.dampingFactor = 0.07;
    this._orbit.enablePan = false;
    // Keep LMB reserved for Forge actions; rotate camera with MMB in orbit mode.
    this._orbit.mouseButtons.LEFT = THREE.MOUSE.PAN;
    this._orbit.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
    this._orbit.mouseButtons.RIGHT = THREE.MOUSE.DOLLY;
    this._orbit.target.set(0, 0.5, 0);
    this._syncForgeCameraPoseFromCamera();
    this._syncForgeCameraModeUi();

    // No pointer lock / shooter HUD in Forge.
    this._plock = null;
    try { this._hudOverlay?.parentNode?.removeChild(this._hudOverlay); } catch { /* ignore */ }
    this._hudOverlay = null;
    this._hudEls = { root: null, crosshair: null, topLeft: null, msg: null, hit: null };
    try { this._clearGun(); } catch { /* ignore */ }
    try { if (this._game) this._game.enabled = false; } catch { /* ignore */ }

    scene.add(new THREE.HemisphereLight(0xdde8ff, 0x171e2b, 0.9));
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(6, 10, 4);
    scene.add(dir);

    this._grid = new THREE.GridHelper(220, 220, 0x3a4a64, 0x223046);
    this._grid.material.opacity = 0.55;
    this._grid.material.transparent = true;
    this._grid.visible = !!this._state.showGrid;
    scene.add(this._grid);
    scene.add(new THREE.AxesHelper(1.0));

    this._buildUi();
    this._buildForgeViewerHud();
    this._setForgeActionMode(this._forge?.actionMode || 'select');
    this._createOrRebuildForgeWorld({ resetHeights: true });
    this._applyForgeViewportFocusIfNeeded();
    try {
      this._ctx?.toast?.('Forge immersive mode: Ctrl+B sidebar, Ctrl+\\ panel, Ctrl+J console', 'info', { title: 'Forge camera + layout' });
    } catch { /* ignore */ }

    try {
      this._canvas.addEventListener('mousedown', this._handlers.mousedown);
      window.addEventListener('mouseup', this._handlers.mouseup);
      window.addEventListener('keydown', this._forgeKeyDownHandler);
      window.addEventListener('keyup', this._forgeKeyUpHandler);
      window.addEventListener('blur', this._forgeWindowBlurHandler);
      this._canvas.addEventListener('mousemove', this._forgeMouseMoveHandler);
      this._canvas.addEventListener('contextmenu', (e) => { try { e.preventDefault(); } catch { /* ignore */ } });
    } catch { /* ignore */ }
  }

  async unmount() {
    try { window.removeEventListener('mouseup', this._handlers.mouseup); } catch { /* ignore */ }
    try { window.removeEventListener('keydown', this._forgeKeyDownHandler); } catch { /* ignore */ }
    try { window.removeEventListener('keyup', this._forgeKeyUpHandler); } catch { /* ignore */ }
    try { window.removeEventListener('blur', this._forgeWindowBlurHandler); } catch { /* ignore */ }
    try { this._canvas?.removeEventListener?.('mousedown', this._handlers.mousedown); } catch { /* ignore */ }
    try { this._canvas?.removeEventListener?.('mousemove', this._forgeMouseMoveHandler); } catch { /* ignore */ }
    try { this._orbit?.dispose?.(); } catch { /* ignore */ }
    try { this._renderer?.dispose?.(); } catch { /* ignore */ }
    try { this._clearWorld(); } catch { /* ignore */ }

    this._disposeTerrain();
    this._destroyForgeViewerHud();
    this._restoreForgeViewportLayout();

    this._orbit = null;
    this._renderer = null;
    this._scene = null;
    this._camera = null;
    this._ctx = null;
    this._root = null;

    if (this._canvas?.parentNode) this._canvas.parentNode.removeChild(this._canvas);
    this._canvas = null;
  }

  tick(dt = 1 / 60) {
    if (!this._renderer || !this._scene || !this._camera || !this._canvas) return;
    const { dpr, w, h } = resizeCanvasToDisplaySize(this._canvas, 2.0);
    this._renderer.setPixelRatio(dpr);
    this._renderer.setSize(w / dpr, h / dpr, false);
    this._camera.aspect = Math.max(1e-6, w / Math.max(1e-6, h));
    this._camera.updateProjectionMatrix();

    this._tickForgeCamera(dt);
    if (safeTrim(this._forge?.cameraMode) === 'orbit') this._orbit?.update?.();
    try { this._selectionBox?.update?.(); } catch { /* ignore */ }

    this._renderer.render(this._scene, this._camera);
  }

  _buildUi() {
    const host = this._root;
    if (!host) return;
    clear(host);

    const st = this._forge;
    host.appendChild(el('div', { class: 'panelSubtitle' }, [
      'Viewer-first Forge workflow: right-click quick menu, bottom action bar, and left-click executes the active build mode.',
    ]));

    const terrainPresetSel = el('select', {
      value: String(st.quickTerrainPreset || 'medium'),
      onchange: (e) => { st.quickTerrainPreset = safeTrim(e.target.value) || 'medium'; this._saveForgePrefs(); },
    }, [
      el('option', { value: 'small' }, ['Small map (96m / fast)']),
      el('option', { value: 'medium' }, ['Medium map (140m / balanced)']),
      el('option', { value: 'large' }, ['Large map (220m / detailed)']),
    ]);
    const layoutPresetSel = el('select', {
      value: String(st.quickLayoutPreset || 'arena'),
      onchange: (e) => { st.quickLayoutPreset = safeTrim(e.target.value) || 'arena'; this._saveForgePrefs(); },
    }, [
      el('option', { value: 'arena' }, ['Arena shell']),
      el('option', { value: 'corridor' }, ['Corridor lane']),
      el('option', { value: 'outpost' }, ['Outpost starter']),
    ]);
    const quickNewMapBtn = el('button', {
      class: 'primary',
      onclick: () => {
        this._startForgeFromPreset({
          terrainPreset: safeTrim(terrainPresetSel.value) || 'medium',
          layoutPreset: null,
        });
      },
      title: 'Reset terrain and clear current blocks/props',
    }, ['1) New map']);
    const quickApplyLayoutBtn = el('button', {
      onclick: () => {
        this._startForgeFromPreset({
          terrainPreset: safeTrim(terrainPresetSel.value) || 'medium',
          layoutPreset: safeTrim(layoutPresetSel.value) || 'arena',
        });
      },
      title: 'Create a starter layout you can edit',
    }, ['2) Add starter layout']);
    const quickSculptBtn = el('button', {
      onclick: () => {
        st.sculptEnabled = true;
        if (!safeTrim(st.brushMode)) st.brushMode = 'raise';
        this._setForgeActionMode('sculpt');
        this._setStatus('Sculpt mode ready. Left-click + drag to shape terrain.');
      },
      title: 'Enable sculpt mode and terrain brush',
    }, ['3) Sculpt terrain']);
    const quickBuildBtn = el('button', {
      onclick: () => {
        this._setForgeActionMode('place_wall');
        this._setStatus('Wall placement ready. Left-click terrain to build.');
      },
      title: 'Switch to wall placement mode',
    }, ['4) Build structures']);
    const quickPlayBtn = el('button', {
      onclick: () => { void this._handoffToSceneTool(); },
      title: 'Playtest this Forge map in Scene Tool',
    }, ['5) Playtest']);
    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Quick Start']),
      el('div', { class: 'muted', style: { marginTop: '4px' } }, ['Generate a useful map in under a minute with these steps.']),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'fieldLabel' }, ['Map size preset']), terrainPresetSel]),
        el('div', {}, [el('div', { class: 'fieldLabel' }, ['Starter layout']), layoutPresetSel]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } }, [quickNewMapBtn, quickApplyLayoutBtn, quickSculptBtn, quickBuildBtn, quickPlayBtn]),
      el('div', { class: 'muted', style: { marginTop: '8px', fontSize: '10px', whiteSpace: 'pre-line' } }, [
        'Pro tip: number keys 1-7 switch build modes, RMB opens quick menu, Tab toggles advanced panel.',
      ]),
    ]));

    const statusEl = el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, ['']);
    this._ui.statusEl = statusEl;

    const cameraModeSel = el('select', {
      value: String(st.cameraMode || 'fly'),
      onchange: (e) => {
        st.cameraMode = safeTrim(e.target.value) || 'fly';
        this._syncForgeCameraModeUi();
        this._saveForgePrefs();
      },
    }, [
      el('option', { value: 'fly' }, ['Freecam (WASD)']),
      el('option', { value: 'orbit' }, ['Orbit']),
    ]);
    const cameraSpeedInput = el('input', {
      value: String(st.cameraSpeed),
      oninput: (e) => { st.cameraSpeed = clamp(Number(e.target.value) || 18, 0.5, 120); this._saveForgePrefs(); },
      title: 'Freecam move speed',
    });
    const lookSensInput = el('input', {
      value: String(st.lookSensitivity),
      oninput: (e) => { st.lookSensitivity = clamp(Number(e.target.value) || 0.0024, 0.0003, 0.015); this._saveForgePrefs(); },
      title: 'Mouse look sensitivity',
    });
    const focusLayoutChk = el('input', {
      type: 'checkbox',
      checked: !!st.focusLayout,
      onchange: (e) => {
        st.focusLayout = !!e.target.checked;
        if (st.focusLayout) this._applyForgeViewportFocusIfNeeded({ force: true });
        else this._restoreForgeViewportLayout();
        this._saveForgePrefs();
      },
    });
    const focusHidePanelChk = el('input', {
      type: 'checkbox',
      checked: !!st.focusHidePanel,
      onchange: (e) => {
        st.focusHidePanel = !!e.target.checked;
        if (st.focusLayout) this._applyForgeViewportFocusIfNeeded({ force: true });
        this._saveForgePrefs();
      },
    });
    const focusNowBtn = el('button', {
      onclick: () => this._applyForgeViewportFocusIfNeeded({ force: true }),
      title: 'Hide sidebar + console for a larger viewport',
    }, ['Focus viewport']);
    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Camera']),
      el('div', { class: 'muted', style: { marginTop: '4px', whiteSpace: 'pre-line' } }, [
        'Freecam: hold MMB to look, WASD move, Q/E down/up, Shift fast, Ctrl slow.\nRMB opens the quick menu at cursor.',
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'fieldLabel' }, ['Mode']), cameraModeSel]),
        el('div', {}, [el('div', { class: 'fieldLabel' }, ['Speed']), cameraSpeedInput]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'fieldLabel' }, ['Look Sens']), lookSensInput]),
        el('div', {}, [
          el('div', { class: 'fieldLabel' }, ['Layout Focus']),
          el('label', { class: 'layerToggle' }, [focusLayoutChk, el('span', { class: 'layerName' }, ['Auto hide side docks'])]),
        ]),
      ]),
      el('div', { class: 'row', style: { marginTop: '6px' } }, [
        el('div', {}, [
          el('label', { class: 'layerToggle' }, [focusHidePanelChk, el('span', { class: 'layerName' }, ['Immersive: hide right panel too'])]),
        ]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [focusNowBtn]),
    ]));

    const sculptToggle = el('input', {
      type: 'checkbox',
      checked: !!st.sculptEnabled,
      onchange: (e) => { st.sculptEnabled = !!e.target.checked; this._saveForgePrefs(); },
    });
    const brushMode = el('select', {
      value: String(st.brushMode || 'raise'),
      onchange: (e) => { st.brushMode = safeTrim(e.target.value) || 'raise'; this._saveForgePrefs(); },
    }, [
      el('option', { value: 'raise' }, ['Raise']),
      el('option', { value: 'lower' }, ['Lower']),
      el('option', { value: 'flatten' }, ['Flatten']),
      el('option', { value: 'smooth' }, ['Smooth']),
    ]);
    const brushRadius = el('input', {
      value: String(st.brushRadius),
      oninput: (e) => { st.brushRadius = clamp(Number(e.target.value) || 4, 0.5, 30); this._saveForgePrefs(); },
      title: 'Brush radius (meters)',
    });
    const brushStrength = el('input', {
      value: String(st.brushStrength),
      oninput: (e) => { st.brushStrength = clamp(Number(e.target.value) || 1.4, 0.05, 8); this._saveForgePrefs(); },
      title: 'Brush strength',
    });
    const flattenTarget = el('input', {
      value: String(st.flattenTarget),
      oninput: (e) => { st.flattenTarget = Number(e.target.value) || 0; this._saveForgePrefs(); },
      title: 'Flatten target height',
    });

    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Terrain Sculpt']),
      el('div', { class: 'muted', style: { marginTop: '4px', fontSize: '10px', whiteSpace: 'pre-line' } }, [
        'LMB sculpts terrain while Sculpt is enabled.\nShift+Click selects placed blocks.\nDisable Sculpt to use selection/editing without terrain paint.',
      ]),
      el('label', { class: 'layerToggle', style: { marginTop: '8px' } }, [
        sculptToggle,
        el('span', { class: 'layerName' }, ['Enable sculpt brush']),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'fieldLabel' }, ['Mode']), brushMode]),
        el('div', {}, [el('div', { class: 'fieldLabel' }, ['Radius']), brushRadius]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'fieldLabel' }, ['Strength']), brushStrength]),
        el('div', {}, [el('div', { class: 'fieldLabel' }, ['Flatten Y']), flattenTarget]),
      ]),
    ]));

    const terrainSize = el('input', {
      value: String(st.terrainSize),
      oninput: (e) => { st.terrainSize = clamp(Number(e.target.value) || 120, 24, 500); this._saveForgePrefs(); },
    });
    const terrainRes = el('input', {
      value: String(st.terrainResolution),
      oninput: (e) => {
        const n = Math.max(17, Math.min(129, Math.floor(Number(e.target.value) || 65)));
        st.terrainResolution = (n % 2 === 0) ? (n + 1) : n;
        this._saveForgePrefs();
      },
    });
    const terrainRebuildBtn = el('button', {
      onclick: () => {
        this._createOrRebuildForgeWorld({ resetHeights: true });
        this._setStatus('Rebuilt Forge terrain.');
      },
    }, ['Rebuild terrain']);
    const terrainFlattenBtn = el('button', {
      onclick: () => {
        this._flattenTerrainTo(Number(flattenTarget.value) || 0);
        this._setStatus('Flattened terrain.');
      },
    }, ['Flatten all']);
    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Terrain Setup']),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'fieldLabel' }, ['Size (m)']), terrainSize]),
        el('div', {}, [el('div', { class: 'fieldLabel' }, ['Resolution']), terrainRes]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [terrainRebuildBtn, terrainFlattenBtn]),
    ]));

    const spawnBlock = el('button', { class: 'primary', onclick: () => this._spawnForgePrimitive('block') }, ['Block']);
    const spawnWall = el('button', { onclick: () => this._spawnForgePrimitive('wall') }, ['Wall']);
    const spawnCeil = el('button', { onclick: () => this._spawnForgePrimitive('ceiling') }, ['Ceiling']);
    const spawnFloor = el('button', { onclick: () => this._spawnForgePrimitive('floor') }, ['Floor']);
    const dupSel = el('button', {
      onclick: () => {
        const o = this._selection?.obj || null;
        if (!o) return;
        this._duplicateBuilding(o);
        this._setStatus('Duplicated selected block.');
      },
    }, ['Duplicate sel']);
    const delSel = el('button', {
      class: 'danger',
      onclick: () => {
        const o = this._selection?.obj || null;
        if (!o) return;
        this._deleteBuilding(o);
        this._setStatus('Deleted selected block.');
      },
    }, ['Delete sel']);
    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Forge Pieces']),
      el('div', { class: 'muted', style: { marginTop: '4px' } }, ['Spawn around camera target, then use editor below for precise transforms.']),
      el('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } }, [spawnBlock, spawnWall, spawnCeil, spawnFloor]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [dupSel, delSel]),
    ]));

    this._ui.actionHintEl = el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-line', fontSize: '10px' } }, ['']);
    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Mode Help']),
      this._ui.actionHintEl,
    ]));

    const propUrlInput = el('input', {
      value: String(st.propUrl || ''),
      placeholder: 'assets/... .glb',
      oninput: (e) => { st.propUrl = safeTrim(e.target.value); this._saveForgePrefs(); },
    });
    const propScaleInput = el('input', {
      value: String(st.propScale || 1.0),
      oninput: (e) => { st.propScale = Math.max(0.001, Number(e.target.value) || 1.0); this._saveForgePrefs(); },
    });
    const propYawInput = el('input', {
      value: String(st.propYaw || 0),
      oninput: (e) => { st.propYaw = Number(e.target.value) || 0; this._saveForgePrefs(); },
    });
    const spawnPropBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        const u = safeTrim(propUrlInput.value);
        if (!u) return;
        try {
          this._setPlayerNearOrbitTarget();
          await this._spawnPropFromUrl(u, {
            scale: Number(propScaleInput.value) || 1.0,
            yawDeg: Number(propYawInput.value) || 0,
            place: 'player',
          });
          this._setStatus('Spawned prop at camera target.');
        } catch (e) {
          this._setStatus(`Prop spawn failed: ${e?.message || e}`);
        }
      },
    }, ['Spawn prop']);
    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Props / Objects']),
      el('div', { class: 'formGroup' }, [
        el('div', { class: 'formLabel' }, ['GLB URL']),
        propUrlInput,
      ]),
      el('div', { class: 'formRow', style: { marginTop: '8px' } }, [
        el('div', {}, [el('div', { class: 'formLabel' }, ['Scale']), propScaleInput]),
        el('div', {}, [el('div', { class: 'formLabel' }, ['Yaw']), propYawInput]),
      ]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [spawnPropBtn]),
    ]));
    host.appendChild(createAssetPicker({
      ctx: this._ctx,
      title: 'Find Prop Asset',
      ext: '.glb,.gltf',
      placeholder: 'Search props…',
      onPick: (p) => {
        st.propUrl = p;
        propUrlInput.value = p;
        this._saveForgePrefs();
      },
    }));

    this._ui.buildingsHost = el('div', { class: 'scrollArea', style: { height: '120px', marginTop: '8px' } }, ['']);
    this._ui.buildingEditorHost = el('div', { style: { marginTop: '8px' } }, ['']);
    this._ui.selectionInfoEl = el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-line', fontSize: '10px' } }, ['']);
    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Placed Blocks']),
      this._ui.selectionInfoEl,
      this._ui.buildingsHost,
      this._ui.buildingEditorHost,
    ]));

    const openSceneToolBtn = el('button', {
      class: 'primary',
      onclick: async () => { await this._handoffToSceneTool(); },
      title: 'Send this Forge map to Scene Tool for FPS playtest.',
    }, ['Play in Scene Tool']);
    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Handoff']),
      el('div', { class: 'muted', style: { marginTop: '4px' } }, ['Transfers terrain + blocks + props into Scene Tool using inbox payload.']),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [openSceneToolBtn]),
      statusEl,
    ]));

    const snapshotDraftRaw = (() => {
      try { return String(localStorage.getItem(this._snapshotDraftKey) || ''); } catch { return ''; }
    })();
    const snapshotTa = el('textarea', {
      rows: '10',
      placeholder: 'Paste Forge snapshot JSON here, then click Apply snapshot.',
      value: snapshotDraftRaw,
      oninput: (e) => {
        try { localStorage.setItem(this._snapshotDraftKey, String(e.target.value || '')); } catch { /* ignore */ }
      },
    });
    const snapshotFillBtn = el('button', {
      onclick: () => {
        const payload = this._buildForgePayload();
        const txt = JSON.stringify(payload, null, 2);
        snapshotTa.value = txt;
        try { localStorage.setItem(this._snapshotDraftKey, txt); } catch { /* ignore */ }
        this._setStatus('Snapshot JSON prepared in text area.');
      },
      title: 'Serialize current Forge world to JSON text',
    }, ['Fill from current map']);
    const snapshotCopyBtn = el('button', {
      onclick: async () => {
        const payload = this._buildForgePayload();
        const txt = JSON.stringify(payload, null, 2);
        snapshotTa.value = txt;
        try { localStorage.setItem(this._snapshotDraftKey, txt); } catch { /* ignore */ }
        try {
          await navigator.clipboard.writeText(txt);
          this._setStatus('Forge snapshot copied to clipboard.');
          this._ctx?.toast?.('Forge snapshot copied', 'success', { title: 'Forge' });
        } catch {
          this._setStatus('Clipboard blocked. Snapshot is still available in text area.');
          this._ctx?.toast?.('Clipboard unavailable, copy from text area', 'warning', { title: 'Forge' });
        }
      },
      title: 'Copy current map snapshot JSON',
    }, ['Copy snapshot']);
    const snapshotApplyBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        const raw = String(snapshotTa.value || '').trim();
        if (!raw) {
          this._ctx?.toast?.('Paste snapshot JSON first', 'warning', { title: 'Forge' });
          return;
        }
        try {
          const j = JSON.parse(raw);
          await this._applyForgeSnapshot(j);
          this._ctx?.toast?.('Snapshot applied', 'success', { title: 'Forge' });
        } catch (e) {
          const msg = String(e?.message || e || 'Invalid snapshot JSON');
          this._setStatus(`Snapshot import failed: ${msg}`);
          this._ctx?.toast?.(msg, 'error', { title: 'Forge snapshot failed' });
        }
      },
      title: 'Replace current map with snapshot content',
    }, ['Apply snapshot']);
    const resetMapBtn = el('button', {
      class: 'danger',
      onclick: () => {
        const ok = globalThis.confirm?.('Reset Forge map? This clears terrain edits, blocks, and props.');
        if (!ok) return;
        this._startForgeFromPreset({
          terrainPreset: safeTrim(st.quickTerrainPreset) || 'medium',
          layoutPreset: null,
        });
      },
      title: 'Clear current map and create a fresh map',
    }, ['Reset map']);
    this._ui.worldSummaryEl = el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-line', fontSize: '10px' } }, ['']);
    host.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'dockTitle' }, ['Map Management']),
      el('div', { class: 'muted', style: { marginTop: '4px' } }, ['Use snapshots to save/share worlds and recover from mistakes.']),
      this._ui.worldSummaryEl,
      el('div', { class: 'formGroup', style: { marginTop: '8px' } }, [snapshotTa]),
      el('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } }, [snapshotFillBtn, snapshotCopyBtn, snapshotApplyBtn, resetMapBtn]),
    ]));

    this._scanTaggedBuildings();
    this._renderBuildingsUi();
    this._renderBuildingEditorUi();
    this._refreshForgeActionHintUi();
    this._refreshForgeWorldSummaryUi();
  }

  _forgeModeLabel(mode = '') {
    const m = safeTrim(mode);
    if (m === 'select') return 'Select';
    if (m === 'sculpt') return 'Sculpt';
    if (m === 'place_block') return 'Place Block';
    if (m === 'place_wall') return 'Place Wall';
    if (m === 'place_ceiling') return 'Place Ceiling';
    if (m === 'place_floor') return 'Place Floor';
    if (m === 'place_prop') return 'Place Prop';
    return 'Select';
  }

  _forgeModeHelpText(mode = '') {
    const m = safeTrim(mode);
    if (m === 'select') return 'Select mode: click an object to edit it.\nShift+Click also forces selection while in other modes.';
    if (m === 'sculpt') return 'Sculpt mode: LMB paints terrain.\nUse Raise/Lower/Flatten/Smooth and tune Radius + Strength.';
    if (m === 'place_block') return 'Block mode: click terrain to place 4x4x4 blocks.';
    if (m === 'place_wall') return 'Wall mode: click terrain to place wall segments.\nUse snap for clean grid alignment.';
    if (m === 'place_ceiling') return 'Ceiling mode: click to place overhead slabs.';
    if (m === 'place_floor') return 'Floor mode: click to place floor slabs quickly.';
    if (m === 'place_prop') return 'Prop mode: set a GLB URL, then click terrain to place props.';
    return 'Pick a mode to see placement help.';
  }

  _refreshForgeActionHintUi() {
    if (!this._ui?.actionHintEl) return;
    this._ui.actionHintEl.textContent = this._forgeModeHelpText(this._forge?.actionMode);
  }

  _applyForgeTerrainPreset(presetId = 'medium') {
    const id = safeTrim(presetId) || 'medium';
    const st = this._forge;
    if (id === 'small') {
      st.terrainSize = 96;
      st.terrainResolution = 49;
      return 'Small';
    }
    if (id === 'large') {
      st.terrainSize = 220;
      st.terrainResolution = 97;
      return 'Large';
    }
    st.terrainSize = 140;
    st.terrainResolution = 65;
    return 'Medium';
  }

  _buildStarterLayout(layoutId = 'arena') {
    const id = safeTrim(layoutId) || 'arena';
    const placeWall = (x, z, yaw = 0) => {
      const w = this._spawnForgePrimitiveAt('wall', x, z, null);
      if (w?.rotation) w.rotation.y = Number(yaw) || 0;
    };

    this._forgeBulkPlacing = true;
    try {
      if (id === 'corridor') {
        for (let i = -3; i <= 3; i++) this._spawnForgePrimitiveAt('floor', 0, i * 8, null);
        for (let i = -3; i <= 3; i++) {
          placeWall(-8, i * 8, Math.PI * 0.5);
          placeWall(8, i * 8, Math.PI * 0.5);
        }
        placeWall(0, -28, 0);
        placeWall(0, 28, 0);
        return 'Corridor lane';
      }
      if (id === 'outpost') {
        this._spawnForgePrimitiveAt('floor', 0, 0, null);
        this._spawnForgePrimitiveAt('floor', 8, 0, null);
        this._spawnForgePrimitiveAt('floor', -8, 0, null);
        this._spawnForgePrimitiveAt('floor', 0, 8, null);
        this._spawnForgePrimitiveAt('floor', 0, -8, null);
        placeWall(0, 12, 0);
        placeWall(0, -12, 0);
        placeWall(12, 0, Math.PI * 0.5);
        placeWall(-12, 0, Math.PI * 0.5);
        const corners = [
          [12, 12],
          [12, -12],
          [-12, 12],
          [-12, -12],
        ];
        for (const [x, z] of corners) this._spawnForgePrimitiveAt('block', x, z, null);
        return 'Outpost starter';
      }

      // Default arena shell.
      for (let x = -8; x <= 8; x += 8) {
        for (let z = -8; z <= 8; z += 8) this._spawnForgePrimitiveAt('floor', x, z, null);
      }
      for (let x = -8; x <= 8; x += 8) {
        placeWall(x, -16, 0);
        placeWall(x, 16, 0);
      }
      for (let z = -8; z <= 8; z += 8) {
        placeWall(-16, z, Math.PI * 0.5);
        placeWall(16, z, Math.PI * 0.5);
      }
      return 'Arena shell';
    } finally {
      this._forgeBulkPlacing = false;
      this._scanTaggedBuildings();
      this._renderBuildingsUi();
      this._renderBuildingEditorUi();
    }
  }

  _startForgeFromPreset({ terrainPreset = 'medium', layoutPreset = null } = {}) {
    const st = this._forge;
    const terrainLabel = this._applyForgeTerrainPreset(terrainPreset);
    st.quickTerrainPreset = safeTrim(terrainPreset) || st.quickTerrainPreset || 'medium';
    if (layoutPreset) st.quickLayoutPreset = safeTrim(layoutPreset) || st.quickLayoutPreset || 'arena';
    this._createOrRebuildForgeWorld({ resetHeights: true });
    this._setForgeActionMode('select');

    let layoutLabel = '';
    if (layoutPreset) layoutLabel = this._buildStarterLayout(layoutPreset);
    this._saveForgePrefs();
    if (layoutLabel) this._setStatus(`Created ${terrainLabel} map with ${layoutLabel} template.`);
    else this._setStatus(`Created fresh ${terrainLabel} map.`);
    this._refreshForgeWorldSummaryUi();
  }

  _refreshForgeWorldSummaryUi() {
    const host = this._ui?.worldSummaryEl;
    if (!host) return;
    let blockCount = 0;
    try {
      this._scanTaggedBuildings();
      const arr = this._exportAllBuildingsPayload();
      blockCount = Array.isArray(arr) ? arr.length : 0;
    } catch { /* ignore */ }
    const propCount = Array.isArray(this._props) ? this._props.length : 0;
    const st = this._forge || {};
    const terrainSize = Math.round(Number(st.terrainSize) || 120);
    const terrainRes = Math.round(Number(st.terrainResolution) || 65);
    host.textContent = `World stats\nTerrain: ${terrainSize}m @ ${terrainRes}x${terrainRes}\nBlocks: ${blockCount}\nProps: ${propCount}`;
  }

  async _applyForgeSnapshot(input) {
    const root = (input && typeof input === 'object') ? input : {};
    const payload = (safeTrim(root?.kind) === 'forge_world' && root?.payload && typeof root.payload === 'object')
      ? root.payload
      : root;
    if (!payload || typeof payload !== 'object') throw new Error('Snapshot payload is missing.');

    const terrain = (payload.terrain && typeof payload.terrain === 'object') ? payload.terrain : {};
    const blocks = Array.isArray(payload.blocks) ? payload.blocks.slice(0, 5000) : [];
    const props = Array.isArray(payload.props) ? payload.props.slice(0, 2000) : [];
    const spawn = (payload.spawn && typeof payload.spawn === 'object') ? payload.spawn : {};
    const st = this._forge;

    const n0 = Math.max(17, Math.min(129, Math.floor(Number(terrain.resolution) || Number(st.terrainResolution) || 65)));
    const n = (n0 % 2 === 0) ? (n0 + 1) : n0;
    const size = clamp(Number(terrain.size) || Number(st.terrainSize) || 120, 24, 500);
    const want = n * n;
    const heightsIn = Array.isArray(terrain.heights) ? terrain.heights : [];
    const heights = new Float32Array(want);
    const hMin = -Math.abs(Number(st.maxTerrainHeight) || 28);
    const hMax = Math.abs(Number(st.maxTerrainHeight) || 28);
    for (let i = 0; i < want; i++) heights[i] = clamp(Number(heightsIn[i]) || 0, hMin, hMax);

    st.terrainSize = size;
    st.terrainResolution = n;
    st.terrainColor = Number(terrain.color) || st.terrainColor || 0x2a313f;
    st.heights = heights;
    this._createOrRebuildForgeWorld({ resetHeights: false });

    for (const rec of blocks) {
      const t = rec?.transform && typeof rec.transform === 'object' ? rec.transform : {};
      const b = rec?.building && typeof rec.building === 'object' ? rec.building : {};
      const g = this._createPrimitiveBuildingAt({
        name: safeTrim(rec?.name) || 'forge_block',
        w: Math.max(0.5, Number(b?.w) || 4),
        d: Math.max(0.5, Number(b?.d) || 4),
        h: Math.max(0.5, Number(b?.h) || 4),
        x: Number(Array.isArray(t?.pos) ? t.pos[0] : 0) || 0,
        z: Number(Array.isArray(t?.pos) ? t.pos[2] : 0) || 0,
      });
      if (!g) continue;
      try { g.position.y = Number(Array.isArray(t?.pos) ? t.pos[1] : 0) || 0; } catch { /* ignore */ }
      try { g.rotation.y = (Number(t?.yawDeg) || 0) * Math.PI / 180; } catch { /* ignore */ }
      try {
        const s = Math.max(1e-4, Number(t?.scale) || 1);
        g.scale.set(s, s, s);
      } catch { /* ignore */ }
    }

    for (const p of props) {
      const u = safeTrim(p?.url || '');
      if (!u) continue;
      try {
        this._player.x = Number(Array.isArray(p?.pos) ? p.pos[0] : 0) || 0;
        this._player.y = Number(Array.isArray(p?.pos) ? p.pos[1] : 0) || 0;
        this._player.z = Number(Array.isArray(p?.pos) ? p.pos[2] : 0) || 0;
        await this._spawnPropFromUrl(u, {
          name: safeTrim(p?.name || ''),
          scale: Math.max(0.001, Number(p?.scale) || 1),
          yawDeg: Number(p?.yawDeg) || 0,
          place: 'player',
        });
      } catch { /* ignore */ }
    }

    this._spawn = {
      x: Number(spawn?.x) || 0,
      y: Number(spawn?.y) || 0,
      z: Number(spawn?.z) || 0,
    };
    this._setForgeActionMode('select');
    this._scanTaggedBuildings();
    this._renderBuildingsUi();
    this._renderBuildingEditorUi();
    this._refreshForgeWorldSummaryUi();
    this._saveForgePrefs();
    this._setStatus(`Imported snapshot (${blocks.length} blocks, ${props.length} props).`);
  }

  _buildForgeViewerHud() {
    if (!this._ctx?.canvasHost) return;
    this._destroyForgeViewerHud();

    const wrap = el('div', {
      style: {
        position: 'absolute',
        inset: '0',
        pointerEvents: 'none',
        zIndex: '25',
      },
    });
    const topChips = el('div', {
      style: {
        position: 'absolute',
        top: '12px',
        left: '12px',
        display: 'flex',
        gap: '8px',
        alignItems: 'center',
      },
    });
    const chipStyle = {
      pointerEvents: 'auto',
      fontSize: '11px',
      color: 'rgba(230,239,255,0.95)',
      background: 'rgba(8,12,20,0.72)',
      border: '1px solid rgba(140,174,255,0.25)',
      borderRadius: '8px',
      padding: '4px 8px',
      backdropFilter: 'blur(6px)',
      maxWidth: '38vw',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    };
    const modeChip = el('div', { style: chipStyle }, [`Mode: ${this._forgeModeLabel(this._forge?.actionMode)}`]);
    const statusChip = el('div', {
      style: {
        ...chipStyle,
        border: '1px solid rgba(255,255,255,0.18)',
        color: 'rgba(208,220,246,0.95)',
      },
    }, ['Ready']);
    const cursorChip = el('div', {
      style: {
        ...chipStyle,
        border: '1px solid rgba(255,255,255,0.12)',
        color: 'rgba(190,210,240,0.90)',
      },
    }, ['Cursor: --, --, --']);
    topChips.appendChild(modeChip);
    topChips.appendChild(statusChip);
    topChips.appendChild(cursorChip);

    const bar = el('div', {
      style: {
        position: 'absolute',
        left: '50%',
        bottom: '12px',
        transform: 'translateX(-50%)',
        display: 'flex',
        gap: '6px',
        flexWrap: 'wrap',
        justifyContent: 'center',
        maxWidth: '92vw',
        pointerEvents: 'auto',
        padding: '8px',
        borderRadius: '12px',
        background: 'rgba(8,12,20,0.70)',
        border: '1px solid rgba(255,255,255,0.14)',
        backdropFilter: 'blur(8px)',
      },
    });

    const mkBtn = (label, title, onClick) => el('button', {
      style: {
        fontSize: '11px',
        padding: '6px 8px',
        minHeight: '30px',
        whiteSpace: 'nowrap',
      },
      title,
      onclick: onClick,
    }, [label]);

    bar.appendChild(mkBtn('1 Select', 'Select objects', () => this._setForgeActionMode('select')));
    bar.appendChild(mkBtn('2 Sculpt', 'Terrain sculpt mode', () => this._setForgeActionMode('sculpt')));
    bar.appendChild(mkBtn('3 Block', 'Place block', () => this._setForgeActionMode('place_block')));
    bar.appendChild(mkBtn('4 Wall', 'Place wall', () => this._setForgeActionMode('place_wall')));
    bar.appendChild(mkBtn('5 Ceiling', 'Place ceiling', () => this._setForgeActionMode('place_ceiling')));
    bar.appendChild(mkBtn('6 Floor', 'Place floor', () => this._setForgeActionMode('place_floor')));
    bar.appendChild(mkBtn('7 Prop', 'Place prop asset', () => this._setForgeActionMode('place_prop')));
    bar.appendChild(mkBtn('Snap', 'Toggle grid snap', () => {
      this._forge.snapEnabled = !this._forge.snapEnabled;
      this._setStatus(`Snap ${this._forge.snapEnabled ? 'ON' : 'OFF'}`);
      this._saveForgePrefs();
      this._updateForgeHudChips();
    }));
    bar.appendChild(mkBtn('Snap+', 'Increase snap size', () => {
      this._forge.snapSize = Math.min(16, Number(this._forge.snapSize || 1) * 2);
      this._setStatus(`Snap size: ${this._forge.snapSize.toFixed(2)}m`);
      this._saveForgePrefs();
      this._updateForgeHudChips();
    }));
    bar.appendChild(mkBtn('Snap-', 'Decrease snap size', () => {
      this._forge.snapSize = Math.max(0.125, Number(this._forge.snapSize || 1) * 0.5);
      this._setStatus(`Snap size: ${this._forge.snapSize.toFixed(3)}m`);
      this._saveForgePrefs();
      this._updateForgeHudChips();
    }));
    bar.appendChild(mkBtn('Play', 'Open in Scene Tool', () => { void this._handoffToSceneTool(); }));
    bar.appendChild(mkBtn('Panel', 'Toggle advanced right panel', () => this._toggleForgePanelDock()));

    const quickMenu = el('div', {
      style: {
        position: 'absolute',
        display: 'none',
        pointerEvents: 'auto',
        minWidth: '220px',
        background: 'rgba(10,14,22,0.96)',
        border: '1px solid rgba(140,174,255,0.28)',
        borderRadius: '10px',
        padding: '8px',
        boxShadow: '0 12px 32px rgba(0,0,0,0.42)',
        backdropFilter: 'blur(10px)',
      },
    });
    const mkMenuBtn = (label, onClick) => {
      quickMenu.appendChild(el('button', {
        style: {
          width: '100%',
          textAlign: 'left',
          marginTop: '4px',
          fontSize: '11px',
          padding: '6px 8px',
        },
        onclick: () => { onClick?.(); this._closeForgeQuickMenu(); },
      }, [label]));
    };
    quickMenu.appendChild(el('div', {
      style: {
        fontSize: '10px',
        opacity: '0.78',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        marginBottom: '4px',
      },
    }, ['Forge Quick Menu']));
    mkMenuBtn('Select mode', () => this._setForgeActionMode('select'));
    mkMenuBtn('Sculpt mode', () => this._setForgeActionMode('sculpt'));
    mkMenuBtn('Place block', () => this._setForgeActionMode('place_block'));
    mkMenuBtn('Place wall', () => this._setForgeActionMode('place_wall'));
    mkMenuBtn('Place ceiling', () => this._setForgeActionMode('place_ceiling'));
    mkMenuBtn('Place floor', () => this._setForgeActionMode('place_floor'));
    mkMenuBtn('Place prop', () => this._setForgeActionMode('place_prop'));
    mkMenuBtn(`Snap: ${this._forge.snapEnabled ? 'ON' : 'OFF'}`, () => {
      this._forge.snapEnabled = !this._forge.snapEnabled;
      this._setStatus(`Snap ${this._forge.snapEnabled ? 'ON' : 'OFF'}`);
      this._saveForgePrefs();
      this._updateForgeHudChips();
    });
    mkMenuBtn(`Snap size x2 (${(Number(this._forge.snapSize) || 1).toFixed(2)}m)`, () => {
      this._forge.snapSize = Math.min(16, Number(this._forge.snapSize || 1) * 2);
      this._setStatus(`Snap size: ${this._forge.snapSize.toFixed(2)}m`);
      this._saveForgePrefs();
      this._updateForgeHudChips();
    });
    mkMenuBtn('Focus viewport', () => this._applyForgeViewportFocusIfNeeded({ force: true }));
    mkMenuBtn('Toggle advanced panel', () => this._toggleForgePanelDock());
    mkMenuBtn('Play in Scene Tool', () => { void this._handoffToSceneTool(); });

    wrap.appendChild(topChips);
    wrap.appendChild(bar);
    wrap.appendChild(quickMenu);
    this._ctx.canvasHost.appendChild(wrap);

    this._forgeHud.root = wrap;
    this._forgeHud.modeChip = modeChip;
    this._forgeHud.statusChip = statusChip;
    this._forgeHud.cursorChip = cursorChip;
    this._forgeHud.quickMenu = quickMenu;
    this._forgeHud.quickOpen = false;
    this._updateForgeHudChips();
  }

  _destroyForgeViewerHud() {
    const root = this._forgeHud?.root;
    if (root?.parentNode) root.parentNode.removeChild(root);
    this._forgeHud.root = null;
    this._forgeHud.modeChip = null;
    this._forgeHud.statusChip = null;
    this._forgeHud.cursorChip = null;
    this._forgeHud.quickMenu = null;
    this._forgeHud.quickOpen = false;
  }

  _setForgeActionMode(mode) {
    const m = safeTrim(mode);
    const allowed = new Set(['select', 'sculpt', 'place_block', 'place_wall', 'place_ceiling', 'place_floor', 'place_prop']);
    this._forge.actionMode = allowed.has(m) ? m : 'select';
    if (this._forge.actionMode !== 'sculpt') this._forge.activeStroke = false;
    this._updatePlacementPreviewFromHit(null);
    this._updateForgeHudChips();
    this._refreshForgeActionHintUi();
    this._saveForgePrefs();
  }

  _updateForgeHudChips() {
    if (this._forgeHud?.modeChip) {
      const snap = this._forge?.snapEnabled ? `snap ${Number(this._forge?.snapSize || 1).toFixed(2)}m` : 'snap off';
      this._forgeHud.modeChip.textContent = `Mode: ${this._forgeModeLabel(this._forge?.actionMode)} · ${snap}`;
    }
    if (this._forgeHud?.statusChip && this._forgeStatus) this._forgeHud.statusChip.textContent = String(this._forgeStatus);
  }

  _openForgeQuickMenu(clientX, clientY) {
    const menu = this._forgeHud?.quickMenu;
    if (!menu || !this._ctx?.canvasHost) return;
    const rect = this._ctx.canvasHost.getBoundingClientRect();
    const x = clamp(Number(clientX) - rect.left, 8, rect.width - 228);
    const y = clamp(Number(clientY) - rect.top, 8, rect.height - 280);
    menu.style.left = `${Math.floor(x)}px`;
    menu.style.top = `${Math.floor(y)}px`;
    menu.style.display = 'block';
    this._forgeHud.quickOpen = true;
  }

  _closeForgeQuickMenu() {
    const menu = this._forgeHud?.quickMenu;
    if (!menu) return;
    menu.style.display = 'none';
    this._forgeHud.quickOpen = false;
  }

  _toggleForgePanelDock() {
    const app = globalThis.__devtools;
    if (!app || !app._dockVisibility) return;
    app._dockVisibility.panel = !app._dockVisibility.panel;
    try { app._applyDockVisibility?.(); } catch { /* ignore */ }
    try { app._saveDockVisibility?.(); } catch { /* ignore */ }
    try { app._renderTopBar?.(); } catch { /* ignore */ }
  }

  _snapValue(v, step = 1) {
    const s = Math.max(1e-6, Number(step) || 1);
    return Math.round((Number(v) || 0) / s) * s;
  }

  _snapWorldXZ(x, z) {
    const px = Number(x) || 0;
    const pz = Number(z) || 0;
    if (!this._forge?.snapEnabled) return { x: px, z: pz };
    const s = Math.max(1e-6, Number(this._forge?.snapSize) || 1);
    return { x: this._snapValue(px, s), z: this._snapValue(pz, s) };
  }

  _ensurePlacePreview() {
    const st = this._forge;
    if (!this._scene) return null;
    if (st.placePreview) return st.placePreview;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({
        color: 0x8ac5ff,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      }),
    );
    mesh.visible = false;
    this._scene.add(mesh);
    st.placePreview = mesh;
    return mesh;
  }

  _previewSpecForActionMode(mode) {
    const m = safeTrim(mode);
    if (m === 'place_block') return { kind: 'block', w: 4, d: 4, h: 4, yOff: 0 };
    if (m === 'place_wall') return { kind: 'wall', w: 8, d: 0.6, h: 3.2, yOff: 0 };
    if (m === 'place_ceiling') return { kind: 'ceiling', w: 8, d: 8, h: 0.45, yOff: 3.2 };
    if (m === 'place_floor') return { kind: 'floor', w: 8, d: 8, h: 0.45, yOff: 0.22 };
    return null;
  }

  _updatePlacementPreviewFromHit(hit) {
    const st = this._forge;
    const mesh = this._ensurePlacePreview();
    if (!mesh) return;
    const mode = safeTrim(st?.actionMode);
    const spec = this._previewSpecForActionMode(mode);
    if (!st?.previewEnabled || !spec || !hit) {
      mesh.visible = false;
      return;
    }
    const snapped = this._snapWorldXZ(hit.point.x, hit.point.z);
    const y = Number(hit.point.y) + Number(spec.yOff || 0);
    mesh.visible = true;
    mesh.scale.set(Number(spec.w) || 1, Number(spec.h) || 1, Number(spec.d) || 1);
    mesh.position.set(Number(snapped.x) || 0, Number(y) || 0, Number(snapped.z) || 0);
  }

  _spawnForgePrimitiveAt(kind = 'block', x = 0, z = 0, y = null) {
    const snapped = this._snapWorldXZ(x, z);
    const px = Number(snapped.x) || 0;
    const pz = Number(snapped.z) || 0;
    const groundY = Number(this._findGroundY(px, 30, pz) ?? 0);
    let w = 4; let d = 4; let h = 4; let yOut = Number.isFinite(Number(y)) ? Number(y) : groundY;
    let name = 'forge_block';
    if (kind === 'wall') { w = 8; d = 0.6; h = 3.2; name = 'forge_wall'; }
    else if (kind === 'ceiling') { w = 8; d = 8; h = 0.45; yOut = Number.isFinite(Number(y)) ? Number(y) : (groundY + 3.2); name = 'forge_ceiling'; }
    else if (kind === 'floor') { w = 8; d = 8; h = 0.45; yOut = Number.isFinite(Number(y)) ? Number(y) : (groundY + 0.22); name = 'forge_floor'; }

    const g = this._createPrimitiveBuildingAt({ name, w, d, h, x: px, z: pz });
    if (!g) return null;
    try { g.position.y = yOut; } catch { /* ignore */ }
    this._scanTaggedBuildings();
    this._renderBuildingsUi();
    this._renderBuildingEditorUi();
    if (!this._forgeBulkPlacing) this._setStatus(`Spawned ${kind}.`);
    return g;
  }

  _doForgeActionFromLeftClick(e) {
    const mode = safeTrim(this._forge?.actionMode) || 'select';
    const hit = this._terrainHitFromEvent(e);
    if (mode === 'select') {
      try { this._pickSelectionFromEvent(e); } catch { /* ignore */ }
      try { this._renderBuildingsUi(); } catch { /* ignore */ }
      try { this._renderBuildingEditorUi(); } catch { /* ignore */ }
      return;
    }
    if (mode === 'sculpt') {
      if (!this._forge.sculptEnabled || !hit) return;
      this._forge.activeStroke = true;
      if (safeTrim(this._forge.brushMode) === 'flatten') this._forge.flattenTarget = Number(hit.point.y) || 0;
      this._sculptAtHit(hit);
      return;
    }
    if (!hit) return;
    if (mode === 'place_block') { this._spawnForgePrimitiveAt('block', hit.point.x, hit.point.z, hit.point.y); return; }
    if (mode === 'place_wall') { this._spawnForgePrimitiveAt('wall', hit.point.x, hit.point.z, hit.point.y); return; }
    if (mode === 'place_ceiling') { this._spawnForgePrimitiveAt('ceiling', hit.point.x, hit.point.z, hit.point.y + 3.2); return; }
    if (mode === 'place_floor') { this._spawnForgePrimitiveAt('floor', hit.point.x, hit.point.z, hit.point.y + 0.22); return; }
    if (mode === 'place_prop') {
      const u = safeTrim(this._forge?.propUrl || '');
      if (!u) {
        this._setStatus('Set a prop URL first (advanced panel), then place prop.');
        return;
      }
      this._player.x = Number(hit.point.x) || 0;
      const snapped = this._snapWorldXZ(hit.point.x, hit.point.z);
      this._player.x = Number(snapped.x) || 0;
      this._player.z = Number(snapped.z) || 0;
      this._player.y = Number(hit.point.y) || 0;
      void this._spawnPropFromUrl(u, {
        scale: Number(this._forge?.propScale) || 1.0,
        yawDeg: Number(this._forge?.propYaw) || 0,
        place: 'player',
      }).then(() => this._setStatus('Spawned prop.')).catch((err) => this._setStatus(`Prop spawn failed: ${err?.message || err}`));
    }
  }

  _createOrRebuildForgeWorld({ resetHeights = false } = {}) {
    const st = this._forge;
    this._createBlankGroundScene({
      groundSize: Number(st.terrainSize) || 120,
      addPerimeterWalls: false,
      includePhysics: false,
      includeCollision: true,
      includeLocomotion: false,
      includeWeapons: false,
      includeInteractions: true,
      includeEnemies: false,
      includeVehicles: false,
      mapStartMode: 'flat',
      worldName: 'Forge',
      worldTheme: 'neutral',
      addStarterWaypoints: false,
      addStarterGoalTrigger: false,
    });
    this._state.mode = 'orbit';
    this._syncModeUi();

    try {
      const base = this._worldRoot?.getObjectByName?.('ground_base');
      if (base) base.visible = false;
    } catch { /* ignore */ }

    const n = Math.max(17, Math.min(129, Math.floor(Number(st.terrainResolution) || 65)));
    st.terrainResolution = (n % 2 === 0) ? (n + 1) : n;
    const vcount = st.terrainResolution * st.terrainResolution;
    if (resetHeights || !(st.heights instanceof Float32Array) || st.heights.length !== vcount) {
      st.heights = new Float32Array(vcount);
    }

    this._disposeTerrain();

    const geo = new THREE.PlaneGeometry(Number(st.terrainSize) || 120, Number(st.terrainSize) || 120, st.terrainResolution - 1, st.terrainResolution - 1);
    geo.rotateX(-Math.PI * 0.5);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, Number(st.heights[i]) || 0);
    pos.needsUpdate = true;
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: Number(st.terrainColor) || 0x2a313f,
      roughness: 0.95,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'forge_terrain';
    mesh.receiveShadow = true;
    mesh.userData = mesh.userData || {};
    mesh.userData.isForgeTerrain = true;

    this._worldRoot?.add?.(mesh);
    this._colliders = [this._worldRoot];

    st.terrainGeom = geo;
    st.terrainMat = mat;
    st.terrainMesh = mesh;

    this._ensureBrushRing();
    this._saveForgePrefs();
  }

  _disposeTerrain() {
    const st = this._forge;
    try { if (st.placePreview?.parent) st.placePreview.parent.remove(st.placePreview); } catch { /* ignore */ }
    try { st.placePreview?.geometry?.dispose?.(); } catch { /* ignore */ }
    try { st.placePreview?.material?.dispose?.(); } catch { /* ignore */ }
    st.placePreview = null;
    try { if (st.brushRing?.parent) st.brushRing.parent.remove(st.brushRing); } catch { /* ignore */ }
    try { st.brushRing?.geometry?.dispose?.(); } catch { /* ignore */ }
    try { st.brushRing?.material?.dispose?.(); } catch { /* ignore */ }
    st.brushRing = null;
    try { if (st.terrainMesh?.parent) st.terrainMesh.parent.remove(st.terrainMesh); } catch { /* ignore */ }
    try { st.terrainGeom?.dispose?.(); } catch { /* ignore */ }
    try { st.terrainMat?.dispose?.(); } catch { /* ignore */ }
    st.terrainMesh = null;
    st.terrainGeom = null;
    st.terrainMat = null;
  }

  _ensureBrushRing() {
    const st = this._forge;
    if (!this._scene) return;
    if (st.brushRing) {
      try { st.brushRing.geometry?.dispose?.(); } catch { /* ignore */ }
      st.brushRing.geometry = new THREE.RingGeometry(Math.max(0.1, st.brushRadius - 0.08), st.brushRadius, 48, 1);
      return;
    }
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(Math.max(0.1, st.brushRadius - 0.08), st.brushRadius, 48, 1),
      new THREE.MeshBasicMaterial({ color: 0x80b3ff, side: THREE.DoubleSide, transparent: true, opacity: 0.75 }),
    );
    ring.rotation.x = -Math.PI * 0.5;
    ring.visible = false;
    st.brushRing = ring;
    this._scene.add(ring);
  }

  _flattenTerrainTo(y0 = 0) {
    const st = this._forge;
    if (!(st.heights instanceof Float32Array)) return;
    for (let i = 0; i < st.heights.length; i++) st.heights[i] = Number(y0) || 0;
    this._applyTerrainHeightsToMesh();
  }

  _applyTerrainHeightsToMesh() {
    const st = this._forge;
    if (!st.terrainGeom || !(st.heights instanceof Float32Array)) return;
    const pos = st.terrainGeom.attributes.position;
    for (let i = 0; i < pos.count && i < st.heights.length; i++) pos.setY(i, Number(st.heights[i]) || 0);
    pos.needsUpdate = true;
    st.terrainGeom.computeVertexNormals();
  }

  _onMouseDown(e) {
    const btn = Number(e?.button ?? 0);
    if (btn === 2) {
      this._openForgeQuickMenu(Number(e?.clientX) || 0, Number(e?.clientY) || 0);
      try { e.preventDefault?.(); } catch { /* ignore */ }
      return;
    }
    if (btn === 1) {
      if (safeTrim(this._forge?.cameraMode) === 'fly') {
        this._forgeCam.lookActive = true;
        this._syncForgeCameraPoseFromCamera();
      }
      try { e.preventDefault?.(); } catch { /* ignore */ }
      return;
    }
    if (btn !== 0) return;

    if (this._forgeHud?.quickOpen) this._closeForgeQuickMenu();
    if (e?.shiftKey) {
      try { this._pickSelectionFromEvent(e); } catch { /* ignore */ }
      try { this._renderBuildingsUi(); } catch { /* ignore */ }
      try { this._renderBuildingEditorUi(); } catch { /* ignore */ }
      return;
    }
    this._doForgeActionFromLeftClick(e);
    try { e.preventDefault?.(); } catch { /* ignore */ }
  }

  _onMouseUp() {
    this._forgeCam.lookActive = false;
    this._forge.activeStroke = false;
  }

  _onForgeMouseMove(e) {
    if (this._forgeCam.lookActive && safeTrim(this._forge?.cameraMode) === 'fly') {
      const sens = Number(this._forge?.lookSensitivity) || 0.0024;
      this._forgeCam.yaw -= Number(e?.movementX || 0) * sens;
      this._forgeCam.pitch = clamp(this._forgeCam.pitch - Number(e?.movementY || 0) * sens, -1.45, 1.45);
      this._camera?.quaternion?.setFromEuler?.(new THREE.Euler(this._forgeCam.pitch, this._forgeCam.yaw, 0, 'YXZ'));
      return;
    }

    const hit = this._terrainHitFromEvent(e);
    if (this._forgeHud?.cursorChip) {
      if (hit?.point) {
        const p = hit.point;
        this._forgeHud.cursorChip.textContent = `Cursor: ${Number(p.x).toFixed(2)}, ${Number(p.y).toFixed(2)}, ${Number(p.z).toFixed(2)}`;
      } else {
        this._forgeHud.cursorChip.textContent = 'Cursor: --, --, --';
      }
    }
    this._updatePlacementPreviewFromHit(hit);
    const ring = this._forge.brushRing;
    if (ring) {
      if (hit && this._forge.sculptEnabled) {
        ring.visible = true;
        ring.position.copy(hit.point);
        ring.position.y += 0.03;
      } else {
        ring.visible = false;
      }
    }
    if ((safeTrim(this._forge?.actionMode) === 'sculpt') && this._forge.activeStroke && hit) this._sculptAtHit(hit);
  }

  _terrainHitFromEvent(e) {
    const mesh = this._forge.terrainMesh;
    if (!mesh || !this._camera || !this._canvas) return null;
    const rect = this._canvas.getBoundingClientRect();
    const x = ((Number(e.clientX) - rect.left) / Math.max(1e-6, rect.width)) * 2 - 1;
    const y = -(((Number(e.clientY) - rect.top) / Math.max(1e-6, rect.height)) * 2 - 1);
    this._mouseNdc.set(x, y);
    this._raycaster.setFromCamera(this._mouseNdc, this._camera);
    const hits = this._raycaster.intersectObject(mesh, false);
    return hits.length ? hits[0] : null;
  }

  _sculptAtHit(hit) {
    const st = this._forge;
    const res = Number(st.terrainResolution) || 65;
    const size = Number(st.terrainSize) || 120;
    if (!(st.heights instanceof Float32Array) || st.heights.length !== res * res) return;

    const lx = hit.point.x + size * 0.5;
    const lz = hit.point.z + size * 0.5;
    const gx = clamp(lx / size, 0, 1) * (res - 1);
    const gz = clamp(lz / size, 0, 1) * (res - 1);
    const rCells = Math.max(1, (Number(st.brushRadius) || 1) / (size / (res - 1)));
    const iMin = Math.max(0, Math.floor(gx - rCells));
    const iMax = Math.min(res - 1, Math.ceil(gx + rCells));
    const jMin = Math.max(0, Math.floor(gz - rCells));
    const jMax = Math.min(res - 1, Math.ceil(gz + rCells));

    const mode = safeTrim(st.brushMode) || 'raise';
    const sign = (mode === 'lower') ? -1 : 1;
    const strength = Number(st.brushStrength) || 1;
    const dt = 0.12;
    const copy = (mode === 'smooth') ? st.heights.slice() : null;

    for (let j = jMin; j <= jMax; j++) {
      for (let i = iMin; i <= iMax; i++) {
        const dx = i - gx;
        const dz = j - gz;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > rCells) continue;
        const fall = 1.0 - (d / Math.max(1e-6, rCells));
        const idx = j * res + i;
        let y0 = Number(st.heights[idx]) || 0;
        if (mode === 'raise' || mode === 'lower') {
          y0 += sign * strength * fall * dt;
        } else if (mode === 'flatten') {
          const t = clamp(strength * 0.35 * fall * dt * 3.0, 0, 1);
          y0 = y0 + (Number(st.flattenTarget) - y0) * t;
        } else if (mode === 'smooth') {
          let sum = 0; let cnt = 0;
          for (let oj = -1; oj <= 1; oj++) {
            for (let oi = -1; oi <= 1; oi++) {
              const ii = i + oi; const jj = j + oj;
              if (ii < 0 || jj < 0 || ii >= res || jj >= res) continue;
              sum += Number(copy[jj * res + ii]) || 0;
              cnt++;
            }
          }
          const avg = cnt > 0 ? (sum / cnt) : y0;
          const t = clamp(strength * 0.30 * fall * dt * 3.0, 0, 1);
          y0 = y0 + (avg - y0) * t;
        }
        st.heights[idx] = clamp(y0, -Number(st.maxTerrainHeight) || -28, Number(st.maxTerrainHeight) || 28);
      }
    }

    this._applyTerrainHeightsToMesh();
  }

  _setPlayerNearOrbitTarget() {
    const t = this._orbit?.target;
    if (!t) return;
    this._player.x = Number(t.x) || 0;
    this._player.z = Number(t.z) || 0;
    this._player.y = (this._findGroundY(this._player.x, 20, this._player.z) ?? 0) + 1.6;
  }

  _spawnForgePrimitive(kind = 'block') {
    const t = this._orbit?.target || new THREE.Vector3();
    this._spawnForgePrimitiveAt(kind, Number(t.x) || 0, Number(t.z) || 0, null);
  }

  async _handoffToSceneTool() {
    try {
      const payload = this._buildForgePayload();
      localStorage.setItem('devtools.scene.inbox', JSON.stringify(payload));
      this._setStatus('Sent Forge map to Scene Tool.');
      this._ctx?.toast?.('Forge map sent to Scene Tool', 'success');
      try { await globalThis.__devtools?.setActiveTool?.('scene'); } catch { /* ignore */ }
    } catch (e) {
      this._setStatus(`Handoff failed: ${e?.message || e}`);
      this._ctx?.toast?.(String(e?.message || e || 'Forge handoff failed'), 'error', { title: 'Forge' });
    }
  }

  _buildForgePayload() {
    const st = this._forge;
    this._scanTaggedBuildings();
    const buildings = this._exportAllBuildingsPayload();
    const props = Array.isArray(this._props) ? this._props.map((p) => ({
      url: safeTrim(p?.url || ''),
      name: safeTrim(p?.root?.name || ''),
      scale: Number(p?.root?.scale?.x) || 1,
      yawDeg: (Number(p?.root?.rotation?.y) || 0) * 180 / Math.PI,
      pos: [
        Number(p?.root?.position?.x) || 0,
        Number(p?.root?.position?.y) || 0,
        Number(p?.root?.position?.z) || 0,
      ],
    })) : [];

    return {
      schema: 1,
      kind: 'forge_world',
      source: 'forge_tool',
      payload: {
        terrain: {
          size: Number(st.terrainSize) || 120,
          resolution: Number(st.terrainResolution) || 65,
          color: Number(st.terrainColor) || 0x2a313f,
          heights: Array.from(st.heights || []),
        },
        blocks: buildings,
        props,
        spawn: {
          x: Number(this._spawn?.x) || 0,
          y: Number(this._spawn?.y) || 0,
          z: Number(this._spawn?.z) || 0,
        },
      },
    };
  }

  _setStatus(s) {
    this._forgeStatus = String(s || '');
    if (this._ui?.statusEl) this._ui.statusEl.textContent = this._forgeStatus;
    this._updateForgeHudChips();
    this._refreshForgeWorldSummaryUi();
    try { this._ctx?.log?.(`[Forge] ${this._forgeStatus}`); } catch { /* ignore */ }
  }

  _saveForgePrefs() {
    const st = this._forge;
    const j = {
      terrainSize: Number(st.terrainSize) || 120,
      terrainResolution: Number(st.terrainResolution) || 65,
      brushMode: safeTrim(st.brushMode) || 'raise',
      brushRadius: Number(st.brushRadius) || 4,
      brushStrength: Number(st.brushStrength) || 1.4,
      flattenTarget: Number(st.flattenTarget) || 0,
      sculptEnabled: !!st.sculptEnabled,
      propUrl: safeTrim(st.propUrl || ''),
      propScale: Number(st.propScale) || 1,
      propYaw: Number(st.propYaw) || 0,
      cameraMode: safeTrim(st.cameraMode) || 'fly',
      cameraSpeed: Number(st.cameraSpeed) || 18,
      lookSensitivity: Number(st.lookSensitivity) || 0.0024,
      focusLayout: !!st.focusLayout,
      focusHidePanel: !!st.focusHidePanel,
      actionMode: safeTrim(st.actionMode) || 'select',
      snapEnabled: !!st.snapEnabled,
      snapSize: Number(st.snapSize) || 1,
      previewEnabled: !!st.previewEnabled,
      quickTerrainPreset: safeTrim(st.quickTerrainPreset) || 'medium',
      quickLayoutPreset: safeTrim(st.quickLayoutPreset) || 'arena',
    };
    try { localStorage.setItem(this._prefsKey, JSON.stringify(j)); } catch { /* ignore */ }
  }

  _loadForgePrefs() {
    try {
      const raw = localStorage.getItem(this._prefsKey);
      const j = raw ? JSON.parse(raw) : null;
      if (!j || typeof j !== 'object') return;
      const st = this._forge;
      st.terrainSize = clamp(Number(j.terrainSize) || st.terrainSize, 24, 500);
      const res = Math.max(17, Math.min(129, Math.floor(Number(j.terrainResolution) || st.terrainResolution)));
      st.terrainResolution = (res % 2 === 0) ? (res + 1) : res;
      st.brushMode = safeTrim(j.brushMode) || st.brushMode;
      st.brushRadius = clamp(Number(j.brushRadius) || st.brushRadius, 0.5, 30);
      st.brushStrength = clamp(Number(j.brushStrength) || st.brushStrength, 0.05, 8);
      st.flattenTarget = Number(j.flattenTarget) || 0;
      st.sculptEnabled = !!j.sculptEnabled;
      st.propUrl = safeTrim(j.propUrl || '');
      st.propScale = Math.max(0.001, Number(j.propScale) || 1);
      st.propYaw = Number(j.propYaw) || 0;
      st.cameraMode = safeTrim(j.cameraMode) || st.cameraMode || 'fly';
      st.cameraSpeed = clamp(Number(j.cameraSpeed) || st.cameraSpeed || 18, 0.5, 120);
      st.lookSensitivity = clamp(Number(j.lookSensitivity) || st.lookSensitivity || 0.0024, 0.0003, 0.015);
      st.focusLayout = (j.focusLayout === undefined) ? st.focusLayout : !!j.focusLayout;
      st.focusHidePanel = (j.focusHidePanel === undefined) ? st.focusHidePanel : !!j.focusHidePanel;
      st.actionMode = safeTrim(j.actionMode) || st.actionMode || 'select';
      st.snapEnabled = (j.snapEnabled === undefined) ? st.snapEnabled : !!j.snapEnabled;
      st.snapSize = clamp(Number(j.snapSize) || st.snapSize || 1, 0.125, 16);
      st.previewEnabled = (j.previewEnabled === undefined) ? st.previewEnabled : !!j.previewEnabled;
      st.quickTerrainPreset = safeTrim(j.quickTerrainPreset) || st.quickTerrainPreset || 'medium';
      st.quickLayoutPreset = safeTrim(j.quickLayoutPreset) || st.quickLayoutPreset || 'arena';
    } catch { /* ignore */ }
  }

  _syncForgeCameraPoseFromCamera() {
    const c = this._camera;
    if (!c) return;
    const e = new THREE.Euler().setFromQuaternion(c.quaternion, 'YXZ');
    this._forgeCam.yaw = Number(e.y) || 0;
    this._forgeCam.pitch = clamp(Number(e.x) || 0, -1.45, 1.45);
  }

  _syncForgeCameraModeUi() {
    const mode = safeTrim(this._forge?.cameraMode) || 'fly';
    if (this._orbit) this._orbit.enabled = (mode === 'orbit');
  }

  _tickForgeCamera(dt) {
    if (!this._camera) return;
    const mode = safeTrim(this._forge?.cameraMode) || 'fly';
    if (mode !== 'fly') return;
    const keys = this._forgeCam.keys;
    if (!keys.size) return;

    const fwd = new THREE.Vector3();
    this._camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, -1);
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const move = new THREE.Vector3();

    if (keys.has('w')) move.add(fwd);
    if (keys.has('s')) move.sub(fwd);
    if (keys.has('a')) move.sub(right);
    if (keys.has('d')) move.add(right);
    if (keys.has('q')) move.y -= 1;
    if (keys.has('e')) move.y += 1;
    if (move.lengthSq() < 1e-8) return;

    move.normalize();
    let spd = Math.max(0.5, Number(this._forge?.cameraSpeed) || 18);
    if (keys.has('shift')) spd *= Math.max(1, Number(this._forge?.cameraFastMul) || 3);
    if (keys.has('control')) spd *= clamp(Number(this._forge?.cameraSlowMul) || 0.35, 0.05, 1);
    move.multiplyScalar(spd * Math.max(0, Number(dt) || (1 / 60)));
    this._camera.position.add(move);
    if (this._orbit?.target) this._orbit.target.add(move);
  }

  _getSelectedEditableObject() {
    const o = this._selection?.obj || null;
    if (!o) return null;
    if (!this._hasProjectTag?.(o, 'buildings')) return null;
    return o;
  }

  _afterSelectedTransformChanged() {
    try { this._rebuildObstacleBoxesFromSources?.(); } catch { /* ignore */ }
    try { this._updateSelectionHelper?.(); } catch { /* ignore */ }
    try { this._scanTaggedBuildings?.(); } catch { /* ignore */ }
    try { this._renderBuildingsUi?.(); } catch { /* ignore */ }
    try { this._renderBuildingEditorUi?.(); } catch { /* ignore */ }
  }

  _nudgeSelected(dx = 0, dy = 0, dz = 0) {
    const o = this._getSelectedEditableObject();
    if (!o) return false;
    const step = Math.max(0.01, Number(this._forge?.snapEnabled ? (this._forge?.snapSize || 1) : 0.25) || 0.25);
    o.position.x = Number(o.position.x) + (Number(dx) || 0) * step;
    o.position.y = Number(o.position.y) + (Number(dy) || 0) * step;
    o.position.z = Number(o.position.z) + (Number(dz) || 0) * step;
    this._afterSelectedTransformChanged();
    this._setStatus(`Moved ${safeTrim(o?.name) || 'selection'} by ${step.toFixed(2)}m`);
    return true;
  }

  _rotateSelectedYaw(dir = 1) {
    const o = this._getSelectedEditableObject();
    if (!o) return false;
    const deg = this._forge?.snapEnabled ? 15 : 5;
    o.rotation.y += (Number(dir) >= 0 ? 1 : -1) * (deg * Math.PI / 180);
    this._afterSelectedTransformChanged();
    this._setStatus(`Rotated ${safeTrim(o?.name) || 'selection'} ${deg}°`);
    return true;
  }

  _scaleSelectedBy(mul = 1.0) {
    const o = this._getSelectedEditableObject();
    if (!o) return false;
    const m = clamp(Number(mul) || 1, 0.6, 1.6);
    const s = Math.max(0.05, Number(o.scale.x) * m);
    o.scale.set(s, s, s);
    this._afterSelectedTransformChanged();
    this._setStatus(`Scaled ${safeTrim(o?.name) || 'selection'} to ${s.toFixed(2)}`);
    return true;
  }

  _onForgeKeyDown(e) {
    const tag = String(e?.target?.tagName || '').toLowerCase();
    const isTyping = !!(e?.target?.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select');
    if (isTyping) return;
    const k = safeTrim(e?.key).toLowerCase();
    if (!k) return;
    if (k === 'escape') {
      this._closeForgeQuickMenu();
      this._forge.activeStroke = false;
      this._forgeCam.lookActive = false;
      return;
    }
    if (k === '1') { this._setForgeActionMode('select'); return; }
    if (k === '2') { this._setForgeActionMode('sculpt'); return; }
    if (k === '3') { this._setForgeActionMode('place_block'); return; }
    if (k === '4') { this._setForgeActionMode('place_wall'); return; }
    if (k === '5') { this._setForgeActionMode('place_ceiling'); return; }
    if (k === '6') { this._setForgeActionMode('place_floor'); return; }
    if (k === '7') { this._setForgeActionMode('place_prop'); return; }
    if (k === '8') {
      this._forge.snapEnabled = !this._forge.snapEnabled;
      this._setStatus(`Snap ${this._forge.snapEnabled ? 'ON' : 'OFF'}`);
      this._saveForgePrefs();
      this._updateForgeHudChips();
      return;
    }
    if (k === '9') {
      this._forge.snapSize = Math.max(0.125, Number(this._forge.snapSize || 1) * 0.5);
      this._setStatus(`Snap size: ${this._forge.snapSize.toFixed(3)}m`);
      this._saveForgePrefs();
      this._updateForgeHudChips();
      return;
    }
    if (k === '0') {
      this._forge.snapSize = Math.min(16, Number(this._forge.snapSize || 1) * 2);
      this._setStatus(`Snap size: ${this._forge.snapSize.toFixed(2)}m`);
      this._saveForgePrefs();
      this._updateForgeHudChips();
      return;
    }
    if (k === 'x') {
      const o = this._getSelectedEditableObject();
      if (o) {
        this._deleteBuilding(o);
        this._setStatus('Deleted selected object.');
      }
      return;
    }
    if (k === 'c') {
      const o = this._getSelectedEditableObject();
      if (o) {
        this._duplicateBuilding(o);
        this._setStatus('Duplicated selected object.');
      }
      return;
    }
    if (k === '[') {
      this._forge.brushRadius = Math.max(0.5, Number(this._forge.brushRadius || 4) * 0.85);
      this._ensureBrushRing();
      this._setStatus(`Brush radius: ${this._forge.brushRadius.toFixed(2)}`);
      this._saveForgePrefs();
      return;
    }
    if (k === ']') {
      this._forge.brushRadius = Math.min(30, Number(this._forge.brushRadius || 4) * 1.15);
      this._ensureBrushRing();
      this._setStatus(`Brush radius: ${this._forge.brushRadius.toFixed(2)}`);
      this._saveForgePrefs();
      return;
    }
    if (k === 'arrowup') { if (this._nudgeSelected(0, 0, -1)) { try { e.preventDefault?.(); } catch {} } return; }
    if (k === 'arrowdown') { if (this._nudgeSelected(0, 0, 1)) { try { e.preventDefault?.(); } catch {} } return; }
    if (k === 'arrowleft') { if (this._nudgeSelected(-1, 0, 0)) { try { e.preventDefault?.(); } catch {} } return; }
    if (k === 'arrowright') { if (this._nudgeSelected(1, 0, 0)) { try { e.preventDefault?.(); } catch {} } return; }
    if (k === 'pageup') { if (this._nudgeSelected(0, 1, 0)) { try { e.preventDefault?.(); } catch {} } return; }
    if (k === 'pagedown') { if (this._nudgeSelected(0, -1, 0)) { try { e.preventDefault?.(); } catch {} } return; }
    if (k === ',') { this._rotateSelectedYaw(-1); return; }
    if (k === '.') { this._rotateSelectedYaw(1); return; }
    if (k === '-') { this._scaleSelectedBy(0.94); return; }
    if (k === '=' || k === '+') { this._scaleSelectedBy(1.06); return; }
    if (k === 'g') {
      this._state.showGrid = !this._state.showGrid;
      if (this._grid) this._grid.visible = !!this._state.showGrid;
      return;
    }
    if (k === 'f') {
      this._applyForgeViewportFocusIfNeeded({ force: true });
      return;
    }
    if (k === 'tab') {
      try { e.preventDefault?.(); } catch { /* ignore */ }
      this._toggleForgePanelDock();
      return;
    }
    if (['w', 'a', 's', 'd', 'q', 'e', 'shift', 'control'].includes(k)) {
      this._forgeCam.keys.add(k);
      try { e.preventDefault?.(); } catch { /* ignore */ }
    }
  }

  _onForgeKeyUp(e) {
    const k = safeTrim(e?.key).toLowerCase();
    if (!k) return;
    this._forgeCam.keys.delete(k);
  }

  _onForgeBlur() {
    this._forgeCam.keys.clear();
    this._forgeCam.lookActive = false;
    this._forge.activeStroke = false;
    this._closeForgeQuickMenu();
  }

  _applyForgeViewportFocusIfNeeded({ force = false } = {}) {
    const st = this._forge;
    if (!force && !st?.focusLayout) return;
    const app = globalThis.__devtools;
    if (!app || !app._dockVisibility) return;

    if (!this._forgeCam.savedDockVisibility) {
      this._forgeCam.savedDockVisibility = {
        sidebar: !!app._dockVisibility.sidebar,
        panel: !!app._dockVisibility.panel,
        console: !!app._dockVisibility.console,
      };
    }
    app._dockVisibility.sidebar = false;
    app._dockVisibility.console = false;
    app._dockVisibility.panel = !!(!st?.focusHidePanel);
    try { app._applyDockVisibility?.(); } catch { /* ignore */ }
    try { app._saveDockVisibility?.(); } catch { /* ignore */ }
    try { app._renderTopBar?.(); } catch { /* ignore */ }
  }

  _restoreForgeViewportLayout() {
    const app = globalThis.__devtools;
    const prev = this._forgeCam.savedDockVisibility;
    if (!app || !app._dockVisibility || !prev) return;
    app._dockVisibility.sidebar = !!prev.sidebar;
    app._dockVisibility.panel = !!prev.panel;
    app._dockVisibility.console = !!prev.console;
    try { app._applyDockVisibility?.(); } catch { /* ignore */ }
    try { app._saveDockVisibility?.(); } catch { /* ignore */ }
    try { app._renderTopBar?.(); } catch { /* ignore */ }
    this._forgeCam.savedDockVisibility = null;
  }
}

