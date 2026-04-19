// Project Chrono (C++) vehicle physics in WebAssembly.
//
// This wrapper expects an Emscripten build output placed under:
//   /public/chrono/chrono_vehicle_module.js
//   /public/chrono/chrono_vehicle_module.wasm
//   (optional) .data bundle, if your build preloads assets
//
// The module must export the C API defined in tools/chrono_wasm/src/chrono_vehicle_bridge.cpp
// (functions prefixed cv_*).

function clamp(x, a, b) {
  x = Number(x) || 0;
  return Math.max(a, Math.min(b, x));
}

function clamp01(x) {
  return clamp(x, 0, 1);
}

function baseUrl() {
  // Works with Vite base:'./' and devtools/index.html served from subpaths.
  return String(document?.baseURI || window.location.href || '');
}

function chronoPublicDirUrl() {
  return new URL('./chrono/', baseUrl()).toString();
}

function errToString(e) {
  try {
    const stack = (e && typeof e === 'object' && 'stack' in e) ? String(e.stack || '') : '';
    if (stack.trim()) return stack;
  } catch { /* ignore */ }
  try {
    const msg = (e && typeof e === 'object' && 'message' in e) ? String(e.message || '') : '';
    if (msg.trim()) return msg;
  } catch { /* ignore */ }
  try { return String(e); } catch { return ''; }
}

function isFiniteSpindlePacket4(packet) {
  if (!Array.isArray(packet) || packet.length < 4) return false;
  for (let i = 0; i < 4; i++) {
    const s = packet[i];
    if (!s || typeof s !== 'object') return false;
    const nums = [
      s?.pos?.x, s?.pos?.y, s?.pos?.z,
      s?.quat?.x, s?.quat?.y, s?.quat?.z, s?.quat?.w,
      s?.vel?.x, s?.vel?.y, s?.vel?.z,
      s?.angVel?.x, s?.angVel?.y, s?.angVel?.z,
    ];
    if (!nums.every((v) => Number.isFinite(Number(v)))) return false;
  }
  return true;
}

function cloneSpindlePacket4(packet) {
  if (!Array.isArray(packet) || packet.length < 4) return null;
  return packet.slice(0, 4).map((s, i) => ({
    name: String(s?.name || ['FL', 'FR', 'RL', 'RR'][i] || ''),
    pos: { x: Number(s?.pos?.x), y: Number(s?.pos?.y), z: Number(s?.pos?.z) },
    quat: { x: Number(s?.quat?.x), y: Number(s?.quat?.y), z: Number(s?.quat?.z), w: Number(s?.quat?.w) },
    vel: { x: Number(s?.vel?.x), y: Number(s?.vel?.y), z: Number(s?.vel?.z) },
    angVel: { x: Number(s?.angVel?.x), y: Number(s?.angVel?.y), z: Number(s?.angVel?.z) },
  }));
}

function isPlausibleSpindleGeometry4(packet) {
  if (!Array.isArray(packet) || packet.length < 4) return false;
  const p = packet.map((s) => ({
    x: Number(s?.pos?.x),
    y: Number(s?.pos?.y),
    z: Number(s?.pos?.z),
  }));
  if (!p.every((v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z))) return false;
  const dist2d = (a, b) => Math.hypot((a.x - b.x), (a.z - b.z));
  const front = { x: 0.5 * (p[0].x + p[1].x), z: 0.5 * (p[0].z + p[1].z) };
  const rear = { x: 0.5 * (p[2].x + p[3].x), z: 0.5 * (p[2].z + p[3].z) };
  const wb = dist2d(front, rear);
  const tf = dist2d(p[0], p[1]);
  const tr = dist2d(p[2], p[3]);
  // Keep broad-but-useful limits; reject diagonal/wrong-axle pairings.
  return (
    wb > 1.2 && wb < 5.0
    && tf > 0.7 && tf < 2.8
    && tr > 0.7 && tr < 2.8
  );
}

async function urlExists(url) {
  const u = String(url || '').trim();
  if (!u) return false;
  try {
    // Some dev servers/middleware don't implement HEAD reliably; fall back to GET.
    try {
      const r = await fetch(u, { method: 'HEAD', cache: 'no-store' });
      if (r?.ok) return true;
    } catch { /* fall through */ }
    const r2 = await fetch(u, { method: 'GET', cache: 'no-store' });
    try { await r2?.body?.cancel?.(); } catch { /* ignore */ }
    return !!r2?.ok;
  } catch {
    return false;
  }
}

export class ProjectChronoWasmVehicleSim {
  constructor() {
    this._initErr = '';
    this._initState = 'idle'; // 'idle' | 'loading' | 'ready' | 'failed'
    this._initPromise = null;

    this._mod = null;
    this._api = null;
    this._world = 0;

    // Scratch buffers in WASM heap to avoid per-frame malloc/free churn.
    this._statePtr = 0;
    this._stateBytes = 0;
    this._stateExPtr = 0;
    this._stateExBytes = 0;
    this._wheelPtr = 0;
    this._wheelBytes = 0;

    this._dynPtr = 0;
    this._dynBytes = 0;
    this._spindlePtr = 0;
    this._spindleBytes = 0;
    this._spindleStatusPtr = 0;
    this._spindleStatusBytes = 0;
    this._spindleDiagPtr = 0;
    this._spindleDiagBytes = 0;
    this._proxyDiagPtr = 0;
    this._proxyDiagBytes = 0;
    this._tirePtr = 0;
    this._tireBytes = 0;
    this._ptrainPtr = 0;
    this._ptrainBytes = 0;

    // Last known-good spindle packets keyed by vehicle handle.
    this._lastGoodSpindles4 = new Map();
  }

  get ready() {
    return !!this._mod && !!this._api && !!this._world;
  }

  get initError() {
    return String(this._initErr || '');
  }

  getBridgeDiagVersion() {
    try {
      if (typeof this._api?.getBridgeDiagVersion !== 'function') return 0;
      return Math.trunc(Number(this._api.getBridgeDiagVersion()) || 0);
    } catch {
      return 0;
    }
  }

  async init() {
    // De-duplicate concurrent init calls. Without this, a background init can mark the sim as
    // "inited" while still loading, causing later callers to see `ready=false` with no error.
    if (this._initState === 'ready') return true;
    if (this._initState === 'failed') return false;
    if (this._initPromise) return await this._initPromise;

    this._initErr = '';
    this._initState = 'loading';
    this._initPromise = (async () => {
      try {
        // Reset state in case of partial previous attempts.
        this._mod = null;
        this._api = null;
        this._world = 0;

        // Always load from /public/chrono/ (served at /chrono/...). In dev, Vite middleware may
        // supply missing files (e.g. chrono_vehicle_module.wasm) from build outputs.
        const moduleDir = chronoPublicDirUrl();
        const isDev = !!(typeof import.meta !== 'undefined' && import.meta?.env && import.meta.env.DEV);
        const bust = isDev ? `?v=${Date.now()}` : '';
        const moduleJsUrl = new URL(`chrono_vehicle_module.js${bust}`, moduleDir).toString();
        const wasmUrl = new URL(`chrono_vehicle_module.wasm${bust}`, moduleDir).toString();

        // Optional preflight so we can give a helpful error if the .wasm truly isn't served.
        const wasmOk = await urlExists(wasmUrl);
        if (!wasmOk) {
          this._initErr = `Chrono WASM binary not reachable at ${wasmUrl}. If you're in dev, ensure the Vite chrono middleware is active; otherwise run tools/chrono_wasm/build_chrono_vehicle_wasm.sh to generate public/chrono outputs.`;
          this._initState = 'failed';
          return false;
        }

        // Emscripten ES module factory is the default export.
        let modFactory = null;
        try {
          modFactory = (await import(/* @vite-ignore */ moduleJsUrl))?.default;
        } catch (e) {
          this._initErr = `Failed to import Chrono module JS at ${moduleJsUrl}\n${errToString(e)}`;
          this._initState = 'failed';
          return false;
        }
        if (typeof modFactory !== 'function') {
          this._initErr = `Chrono module factory not found at ${moduleJsUrl}`;
          this._initState = 'failed';
          return false;
        }

        // Instantiate module. locateFile makes the .wasm/.data resolve next to the selected .js.
        let mod = null;
        try {
          mod = await modFactory({
            locateFile: (p) => {
              const s = String(p || '');
              if (isDev && (s.endsWith('.wasm') || s.endsWith('.data') || s.endsWith('.worker.js'))) {
                return new URL(`${s}${bust}`, moduleDir).toString();
              }
              return new URL(s, moduleDir).toString();
            },
            noInitialRun: true,
          });
        } catch (e) {
          this._initErr = `Failed to instantiate Chrono module (WASM)\n${errToString(e)}`;
          this._initState = 'failed';
          return false;
        }
        this._mod = mod;

        const cwrap = mod?.cwrap?.bind(mod);
        if (typeof cwrap !== 'function') {
          this._initErr = 'Chrono WASM module missing cwrap()';
          this._initState = 'failed';
          return false;
        }

        // Bind API.
        this._api = {
          createWorld: cwrap('cv_create_world', 'number', []),
          destroyWorld: cwrap('cv_destroy_world', null, ['number']),
          destroyVehicle: (() => {
            try { return cwrap('cv_destroy_vehicle', null, ['number', 'number']); } catch { return null; }
          })(),
          stepWorld: cwrap('cv_step_world', null, ['number', 'number']),
          setWorldFriction: cwrap('cv_set_world_friction', null, ['number', 'number']),
          setSpawnWorldY: (() => {
            try { return cwrap('cv_set_spawn_world_y', null, ['number', 'number']); } catch { return null; }
          })(),
          // terrain backends
          setTerrainFlatRigid: (() => {
            try { return cwrap('cv_set_terrain_flat_rigid', null, ['number', 'number', 'number', 'number', 'number']); } catch { return null; }
          })(),
          setTerrainMeshObj: (() => {
            try { return cwrap('cv_set_terrain_mesh_obj', 'number', ['number', 'string', 'number', 'number', 'number', 'number', 'number', 'number', 'number']); } catch { return null; }
          })(),
          setTerrainHeightmapBmp: (() => {
            try { return cwrap('cv_set_terrain_heightmap_bmp', 'number', ['number', 'string', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number']); } catch { return null; }
          })(),
          setTerrainHeightfield: (() => {
            try { return cwrap('cv_set_terrain_heightfield', 'number', ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number']); } catch { return null; }
          })(),
          // statics
          clearStatics: cwrap('cv_clear_statics', null, ['number']),
          addStaticBoxAabbWorld: cwrap('cv_add_static_aabb_world', null, ['number', 'number', 'number', 'number', 'number', 'number', 'number']),
          addStaticTriMeshWorld: (() => {
            try { return cwrap('cv_add_static_trimesh_world', 'number', ['number', 'number', 'number', 'number', 'number', 'number', 'number']); } catch { return null; }
          })(),
          // vehicles
          createVehicle: cwrap('cv_create_vehicle', 'number', ['number', 'number', 'number', 'number', 'number']),
          createVehicleJson: cwrap('cv_create_vehicle_json', 'number', ['number', 'string', 'number', 'number', 'number']),
          createVehicleJsonEx: (() => {
            try { return cwrap('cv_create_vehicle_json_ex', 'number', ['number', 'string', 'string', 'number', 'number', 'number']); } catch { return null; }
          })(),
          setInputs: cwrap('cv_set_inputs', null, ['number', 'number', 'number', 'number', 'number']),
          setInputsEx: (() => {
            try { return cwrap('cv_set_inputs_ex', null, ['number', 'number', 'number', 'number', 'number', 'number']); } catch { return null; }
          })(),
          setGear: cwrap('cv_set_gear', null, ['number', 'number', 'number']),
          setGearIndex: (() => {
            try { return cwrap('cv_set_gear_index', null, ['number', 'number', 'number']); } catch { return null; }
          })(),
          setShiftMode: (() => {
            try { return cwrap('cv_set_shift_mode', null, ['number', 'number', 'number']); } catch { return null; }
          })(),
          setDriveMode: (() => {
            try { return cwrap('cv_set_drive_mode', null, ['number', 'number', 'number']); } catch { return null; }
          })(),
          setBrake4: (() => {
            try { return cwrap('cv_set_brake4', null, ['number', 'number', 'number', 'number', 'number', 'number']); } catch { return null; }
          })(),
          clearBrake4: (() => {
            try { return cwrap('cv_clear_brake4', null, ['number', 'number']); } catch { return null; }
          })(),
          setWheelMu4: (() => {
            try { return cwrap('cv_set_wheel_mu4', null, ['number', 'number', 'number', 'number', 'number', 'number']); } catch { return null; }
          })(),
          clearWheelMu4: (() => {
            try { return cwrap('cv_clear_wheel_mu4', null, ['number', 'number']); } catch { return null; }
          })(),
          setVehicleTuningBasic: cwrap('cv_set_vehicle_tuning_basic', null, ['number', 'number', 'number', 'number', 'number', 'number', 'number']),
          setVehicleChassisMassInertia: cwrap('cv_set_vehicle_chassis_mass_inertia', null, ['number', 'number', 'number', 'number', 'number', 'number']),
          setVehicleChassisComRef: (() => {
            try { return cwrap('cv_set_vehicle_chassis_com_ref', null, ['number', 'number', 'number', 'number', 'number']); } catch { return null; }
          })(),
          setVehiclePowertrainSimpleMap: cwrap('cv_set_vehicle_powertrain_simplemap', null, ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number']),
          // extra toggles
          setParkingBrake: cwrap('cv_set_parking_brake', null, ['number', 'number', 'number']),
          enableBrakeLocking: cwrap('cv_enable_brake_locking', null, ['number', 'number', 'number']),
          lockAxleDiff: cwrap('cv_lock_axle_diff', null, ['number', 'number', 'number', 'number']),
          lockCentralDiff: cwrap('cv_lock_central_diff', null, ['number', 'number', 'number', 'number']),
          disconnectDriveline: cwrap('cv_disconnect_driveline', null, ['number', 'number']),
          getBridgeDiagVersion: (() => {
            try { return cwrap('cv_get_bridge_diag_version', 'number', []); } catch { return null; }
          })(),
          getDriveProxyDiag: (() => {
            try { return cwrap('cv_get_drive_proxy_diag', 'number', ['number', 'number', 'number']); } catch { return null; }
          })(),
          getState: cwrap('cv_get_state', 'number', ['number', 'number', 'number']),
          getStateEx: (() => {
            try { return cwrap('cv_get_state_ex', 'number', ['number', 'number', 'number']); } catch { return null; }
          })(),
          getVehicleDynamics: cwrap('cv_get_vehicle_dynamics', 'number', ['number', 'number', 'number']),
          getSpindles4: cwrap('cv_get_spindles4', 'number', ['number', 'number', 'number']),
          getSpindles4Status: (() => {
            try { return cwrap('cv_get_spindles4_status', 'number', ['number', 'number', 'number']); } catch { return null; }
          })(),
          getSpindles4Diag: (() => {
            try { return cwrap('cv_get_spindles4_diag', 'number', ['number', 'number', 'number']); } catch { return null; }
          })(),
          getTireState: cwrap('cv_get_tire_state', 'number', ['number', 'number', 'number', 'number', 'number']),
          getTireSlips4: (() => {
            try { return cwrap('cv_get_tire_slips4', 'number', ['number', 'number', 'number']); } catch { return null; }
          })(),
          getPowertrainState: cwrap('cv_get_powertrain_state', 'number', ['number', 'number', 'number']),
          getWheelState: cwrap('cv_get_wheel_state', 'number', ['number', 'number', 'number']),
        };

        // Some Emscripten builds do not export HEAP views onto Module. Ensure we have at least one
        // supported way to read/write memory for state buffers.
        const haveHeap = !!(mod && mod.HEAPF32 && mod.HEAPF32.buffer);
        const haveGetValue = (typeof mod?.getValue === 'function');
        if (!haveHeap && !haveGetValue) {
          this._initErr = 'Chrono WASM module loaded, but it does not expose HEAP views or getValue(). If you built with a newer Emscripten, rebuild with -sLEGACY_RUNTIME=1 and -sEXPORTED_RUNTIME_METHODS=[\'cwrap\',\'ccall\',\'getValue\',\'setValue\'] (see tools/chrono_wasm/build_chrono_vehicle_wasm.sh).';
          this._initState = 'failed';
          return false;
        }

        this._world = Number(this._api.createWorld()) || 0;
        if (!this._world) {
          this._initErr = 'cv_create_world() failed';
          this._initState = 'failed';
          return false;
        }

        this._initState = 'ready';
        return true;
      } catch (e) {
        const msg = errToString(e) || 'Failed to init Project Chrono WASM';
        this._initErr = msg;
        this._initState = 'failed';
        return false;
      } finally {
        if (!String(this._initErr || '').trim() && this._initState === 'failed') {
          this._initErr = 'Failed to init Project Chrono WASM (no error details). Check the browser console/network panel.';
        }
        this._initPromise = null;
      }
    })();

    return await this._initPromise;
  }

  reset() {
    if (!this._api || !this._mod) return;
    try {
      if (this._world) this._api.destroyWorld(this._world);
    } catch { /* ignore */ }
    try {
      this._world = Number(this._api.createWorld()) || 0;
    } catch { /* ignore */ }
    try { this._lastGoodSpindles4.clear(); } catch { /* ignore */ }
  }

  setSpawnWorldY(yWorld) {
    if (!this.ready) return;
    const y = Number(yWorld);
    if (!Number.isFinite(y)) return;
    try { this._api?.setSpawnWorldY?.(this._world, y); } catch { /* ignore */ }
  }

  _ensureScratchPtr(kind, bytes) {
    const mod = this._mod;
    if (!mod) return 0;
    const b = Math.max(0, Number(bytes) || 0);
    if (!(b > 0)) return 0;
    if (kind === 'state') {
      if (this._statePtr && (Number(this._stateBytes) || 0) >= b) return this._statePtr;
      try { if (this._statePtr) mod._free(this._statePtr); } catch { /* ignore */ }
      try {
        this._statePtr = mod._malloc(b);
        this._stateBytes = b;
      } catch { this._statePtr = 0; this._stateBytes = 0; }
      return this._statePtr;
    }
    if (kind === 'stateEx') {
      if (this._stateExPtr && (Number(this._stateExBytes) || 0) >= b) return this._stateExPtr;
      try { if (this._stateExPtr) mod._free(this._stateExPtr); } catch { /* ignore */ }
      try {
        this._stateExPtr = mod._malloc(b);
        this._stateExBytes = b;
      } catch { this._stateExPtr = 0; this._stateExBytes = 0; }
      return this._stateExPtr;
    }
    if (kind === 'wheel') {
      if (this._wheelPtr && (Number(this._wheelBytes) || 0) >= b) return this._wheelPtr;
      try { if (this._wheelPtr) mod._free(this._wheelPtr); } catch { /* ignore */ }
      try {
        this._wheelPtr = mod._malloc(b);
        this._wheelBytes = b;
      } catch { this._wheelPtr = 0; this._wheelBytes = 0; }
      return this._wheelPtr;
    }
    if (kind === 'dyn') {
      if (this._dynPtr && (Number(this._dynBytes) || 0) >= b) return this._dynPtr;
      try { if (this._dynPtr) mod._free(this._dynPtr); } catch { /* ignore */ }
      try {
        this._dynPtr = mod._malloc(b);
        this._dynBytes = b;
      } catch { this._dynPtr = 0; this._dynBytes = 0; }
      return this._dynPtr;
    }
    if (kind === 'spindle') {
      if (this._spindlePtr && (Number(this._spindleBytes) || 0) >= b) return this._spindlePtr;
      try { if (this._spindlePtr) mod._free(this._spindlePtr); } catch { /* ignore */ }
      try {
        this._spindlePtr = mod._malloc(b);
        this._spindleBytes = b;
      } catch { this._spindlePtr = 0; this._spindleBytes = 0; }
      return this._spindlePtr;
    }
    if (kind === 'spindle_status') {
      if (this._spindleStatusPtr && (Number(this._spindleStatusBytes) || 0) >= b) return this._spindleStatusPtr;
      try { if (this._spindleStatusPtr) mod._free(this._spindleStatusPtr); } catch { /* ignore */ }
      try {
        this._spindleStatusPtr = mod._malloc(b);
        this._spindleStatusBytes = b;
      } catch { this._spindleStatusPtr = 0; this._spindleStatusBytes = 0; }
      return this._spindleStatusPtr;
    }
    if (kind === 'spindle_diag') {
      if (this._spindleDiagPtr && (Number(this._spindleDiagBytes) || 0) >= b) return this._spindleDiagPtr;
      try { if (this._spindleDiagPtr) mod._free(this._spindleDiagPtr); } catch { /* ignore */ }
      try {
        this._spindleDiagPtr = mod._malloc(b);
        this._spindleDiagBytes = b;
      } catch { this._spindleDiagPtr = 0; this._spindleDiagBytes = 0; }
      return this._spindleDiagPtr;
    }
    if (kind === 'proxy_diag') {
      if (this._proxyDiagPtr && (Number(this._proxyDiagBytes) || 0) >= b) return this._proxyDiagPtr;
      try { if (this._proxyDiagPtr) mod._free(this._proxyDiagPtr); } catch { /* ignore */ }
      try {
        this._proxyDiagPtr = mod._malloc(b);
        this._proxyDiagBytes = b;
      } catch { this._proxyDiagPtr = 0; this._proxyDiagBytes = 0; }
      return this._proxyDiagPtr;
    }
    if (kind === 'tire') {
      if (this._tirePtr && (Number(this._tireBytes) || 0) >= b) return this._tirePtr;
      try { if (this._tirePtr) mod._free(this._tirePtr); } catch { /* ignore */ }
      try {
        this._tirePtr = mod._malloc(b);
        this._tireBytes = b;
      } catch { this._tirePtr = 0; this._tireBytes = 0; }
      return this._tirePtr;
    }
    if (kind === 'ptrain') {
      if (this._ptrainPtr && (Number(this._ptrainBytes) || 0) >= b) return this._ptrainPtr;
      try { if (this._ptrainPtr) mod._free(this._ptrainPtr); } catch { /* ignore */ }
      try {
        this._ptrainPtr = mod._malloc(b);
        this._ptrainBytes = b;
      } catch { this._ptrainPtr = 0; this._ptrainBytes = 0; }
      return this._ptrainPtr;
    }
    return 0;
  }

  _readF32(ptr, i = 0) {
    const mod = this._mod;
    if (!mod) return 0;
    const p = (Number(ptr) || 0) + (Number(i) || 0) * 4;
    try {
      if (mod.HEAPF32 && mod.HEAPF32.buffer) {
        return Number(new Float32Array(mod.HEAPF32.buffer, p, 1)[0]) || 0;
      }
    } catch { /* ignore */ }
    try {
      if (typeof mod.getValue === 'function') {
        return Number(mod.getValue(p, 'float')) || 0;
      }
    } catch { /* ignore */ }
    return 0;
  }

  _writeF32Array(ptr, arr) {
    const mod = this._mod;
    if (!mod) return false;
    const p0 = Number(ptr) || 0;
    const a = Array.isArray(arr) ? arr : Array.from(arr || []);
    const n = a.length;
    if (!p0 || !n) return false;
    try {
      if (mod.HEAPF32 && mod.HEAPF32.buffer) {
        new Float32Array(mod.HEAPF32.buffer, p0, n).set(Float32Array.from(a.map((x) => Number(x) || 0)));
        return true;
      }
    } catch { /* ignore */ }
    try {
      if (typeof mod.setValue === 'function') {
        for (let i = 0; i < n; i++) mod.setValue(p0 + i * 4, Number(a[i]) || 0, 'float');
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  _writeU32Array(ptr, arr) {
    const mod = this._mod;
    if (!mod) return false;
    const p0 = Number(ptr) || 0;
    const a = (arr instanceof Uint32Array) ? arr : new Uint32Array(arr || []);
    const n = a.length;
    if (!p0 || !n) return false;
    try {
      if (mod.HEAPU32 && mod.HEAPU32.buffer) {
        new Uint32Array(mod.HEAPU32.buffer, p0, n).set(a);
        return true;
      }
    } catch { /* ignore */ }
    try {
      if (typeof mod.setValue === 'function') {
        for (let i = 0; i < n; i++) mod.setValue(p0 + i * 4, Number(a[i]) >>> 0, 'i32');
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  setWorldFriction(mu) {
    if (!this.ready) return;
    const m = Math.max(0.05, Math.min(4.0, Number(mu) || 0));
    try { this._api.setWorldFriction(this._world, m); } catch { /* ignore */ }
  }

  /**
   * Replace terrain with a flat rigid patch.
   * @param {{sizeX?:number, sizeZ?:number, y?:number, friction?:number}} params
   */
  setTerrainFlatRigid(params = {}) {
    if (!this.ready) return false;
    const fn = this._api?.setTerrainFlatRigid;
    if (typeof fn !== 'function') return false;
    const sizeX = Number(params.sizeX) || 500;
    const sizeZ = Number(params.sizeZ) || 500;
    const y = Number(params.y) || 0;
    const mu = Number(params.friction) || 1.0;
    try {
      fn(this._world, sizeX, sizeZ, y, mu);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Replace terrain with a RigidTerrain OBJ mesh patch.
   * The OBJ must exist in the Emscripten FS (use writeFile()).
   * @param {{objPath?:string, x?:number, y?:number, z?:number, yaw?:number, friction?:number, connectedMesh?:boolean, sweepSphereRadius?:number}} params
   */
  setTerrainMeshObj(params = {}) {
    if (!this.ready) return false;
    const fn = this._api?.setTerrainMeshObj;
    if (typeof fn !== 'function') return false;
    const p = String(params.objPath || '').trim();
    if (!p) return false;
    const x = Number(params.x) || 0;
    const y = Number(params.y) || 0;
    const z = Number(params.z) || 0;
    const yaw = Number(params.yaw) || 0;
    const mu = Number(params.friction) || 1.0;
    const connected = (params.connectedMesh !== false) ? 1 : 0;
    const sweep = Math.max(0, Number(params.sweepSphereRadius) || 0);
    try {
      return (Number(fn(this._world, p, x, y, z, yaw, mu, connected, sweep)) || 0) ? true : false;
    } catch {
      return false;
    }
  }

  /**
   * Replace terrain with a RigidTerrain BMP heightmap patch.
   * The BMP must exist in the Emscripten FS (use writeFile()).
   * @param {{bmpPath?:string, sizeX?:number, sizeZ?:number, hMin?:number, hMax?:number, x?:number, y?:number, z?:number, yaw?:number, friction?:number, connectedMesh?:boolean, sweepSphereRadius?:number}} params
   */
  setTerrainHeightmapBmp(params = {}) {
    if (!this.ready) return false;
    const fn = this._api?.setTerrainHeightmapBmp;
    if (typeof fn !== 'function') return false;
    const p = String(params.bmpPath || '').trim();
    if (!p) return false;
    const sizeX = Number(params.sizeX) || 200;
    const sizeZ = Number(params.sizeZ) || 200;
    const hMin = Number(params.hMin) || 0;
    const hMax = Number(params.hMax) || 5;
    const x = Number(params.x) || 0;
    const y = Number(params.y) || 0;
    const z = Number(params.z) || 0;
    const yaw = Number(params.yaw) || 0;
    const mu = Number(params.friction) || 1.0;
    const connected = (params.connectedMesh !== false) ? 1 : 0;
    const sweep = Math.max(0, Number(params.sweepSphereRadius) || 0);
    try {
      return (Number(fn(this._world, p, sizeX, sizeZ, hMin, hMax, x, y, z, yaw, mu, connected, sweep)) || 0) ? true : false;
    } catch {
      return false;
    }
  }

  /**
   * Replace terrain with a sampled heightfield (fast) + static collision mesh.
   * heights is row-major with X fastest: heights[ix + iz*nx]
   * @param {{nx:number, nz:number, heights:Float32Array|number[], sizeX:number, sizeZ:number, centerX?:number, centerY?:number, centerZ?:number, heightScale?:number, friction?:number, sweepSphereRadius?:number}} params
   */
  setTerrainHeightfield(params = {}) {
    if (!this.ready) return false;
    const fn = this._api?.setTerrainHeightfield;
    if (typeof fn !== 'function') return false;
    const mod = this._mod;
    if (!mod) return false;
    const nx = Math.max(0, Math.floor(Number(params.nx) || 0));
    const nz = Math.max(0, Math.floor(Number(params.nz) || 0));
    const n = nx * nz;
    if (!(nx >= 2 && nz >= 2 && n > 0)) return false;
    const sizeX = Number(params.sizeX) || 0;
    const sizeZ = Number(params.sizeZ) || 0;
    if (!(sizeX > 0 && sizeZ > 0)) return false;
    const cx = Number(params.centerX) || 0;
    const cy = Number(params.centerY) || 0;
    const cz = Number(params.centerZ) || 0;
    const heightScale = Number(params.heightScale);
    const hs = Number.isFinite(heightScale) ? heightScale : 1.0;
    const mu = Number(params.friction) || 1.0;
    const sweep = Math.max(0, Number(params.sweepSphereRadius) || 0);

    const hIn = (params.heights instanceof Float32Array) ? params.heights : new Float32Array(params.heights || []);
    if (hIn.length < n) return false;
    let ptrH = 0;
    try {
      ptrH = mod._malloc(n * 4);
      if (!ptrH) throw new Error('malloc failed');
      this._writeF32Array(ptrH, hIn.subarray(0, n));
      const ok = Number(fn(this._world, nx, nz, ptrH, sizeX, sizeZ, cx, cy, cz, hs, mu, sweep)) || 0;
      return ok ? true : false;
    } catch {
      return false;
    } finally {
      try { if (ptrH) mod._free(ptrH); } catch { /* ignore */ }
    }
  }

  /**
   * Provide static environment colliders as axis-aligned boxes in WORLD coordinates.
   * @param {Float32Array|number[]} aabbs packed as [minx,miny,minz,maxx,maxy,maxz] * N
   */
  setStaticAabbsWorld(aabbs) {
    if (!this.ready) return;
    const arr = (aabbs instanceof Float32Array) ? aabbs : new Float32Array(aabbs || []);
    const n = Math.floor(arr.length / 6);
    try { this._api.clearStatics(this._world); } catch { /* ignore */ }
    for (let i = 0; i < n; i++) {
      const o = i * 6;
      const minx = arr[o + 0], miny = arr[o + 1], minz = arr[o + 2];
      const maxx = arr[o + 3], maxy = arr[o + 4], maxz = arr[o + 5];
      // Skip degenerate.
      if (!Number.isFinite(minx + miny + minz + maxx + maxy + maxz)) continue;
      if (!(maxx > minx && maxy > miny && maxz > minz)) continue;
      try { this._api.addStaticBoxAabbWorld(this._world, minx, miny, minz, maxx, maxy, maxz); } catch { /* ignore */ }
    }
  }

  /**
   * Add a static triangle mesh collider (world-space vertices).
   * @param {{vertices:Float32Array|number[], indices:Uint32Array|number[], friction?:number, sweepSphereRadius?:number}} params
   */
  addStaticTriMeshWorld(params = {}) {
    if (!this.ready) return false;
    const fn = this._api?.addStaticTriMeshWorld;
    if (typeof fn !== 'function') return false;
    const mod = this._mod;
    if (!mod) return false;
    const verts = (params.vertices instanceof Float32Array) ? params.vertices : new Float32Array(params.vertices || []);
    const idx = (params.indices instanceof Uint32Array) ? params.indices : new Uint32Array(params.indices || []);
    const nVerts = Math.floor(verts.length / 3);
    const nTris = Math.floor(idx.length / 3);
    if (!(nVerts >= 3 && nTris >= 1)) return false;
    const mu = Number(params.friction) || 1.0;
    const sweep = Math.max(0, Number(params.sweepSphereRadius) || 0);

    let ptrV = 0;
    let ptrI = 0;
    try {
      ptrV = mod._malloc(nVerts * 3 * 4);
      ptrI = mod._malloc(nTris * 3 * 4);
      if (!ptrV || !ptrI) throw new Error('malloc failed');
      this._writeF32Array(ptrV, verts.subarray(0, nVerts * 3));
      this._writeU32Array(ptrI, idx.subarray(0, nTris * 3));
      const ok = Number(fn(this._world, nVerts, ptrV, nTris, ptrI, mu, sweep)) || 0;
      return ok ? true : false;
    } catch {
      return false;
    } finally {
      try { if (ptrV) mod._free(ptrV); } catch { /* ignore */ }
      try { if (ptrI) mod._free(ptrI); } catch { /* ignore */ }
    }
  }

  /**
   * @param {{x?:number,z?:number,yaw?:number, kind?:number}} params
   */
  createVehicle(params = {}) {
    if (!this.ready) return 0;
    const kind = Math.floor(Number(params.kind) || 0);
    const x = Number(params.x) || 0;
    const z = Number(params.z) || 0;
    const yaw = Number(params.yaw) || 0;
    try {
      return Number(this._api.createVehicle(this._world, kind, x, z, yaw)) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Create a JSON-defined vehicle.
   * @param {{jsonPath?:string, tireJsonPath?:string, x?:number, z?:number, yaw?:number}} params
   */
  createVehicleJson(params = {}) {
    if (!this.ready) return 0;
    const p = String(params.jsonPath || '').trim();
    if (!p) return 0;
    const tireP = String(params.tireJsonPath || '').trim();
    const x = Number(params.x) || 0;
    const z = Number(params.z) || 0;
    const yaw = Number(params.yaw) || 0;
    try {
      const ex = this._api?.createVehicleJsonEx;
      if (tireP && typeof ex === 'function') {
        return Number(ex(this._world, p, tireP, x, z, yaw)) || 0;
      }
      // Strict mode: if caller requested explicit tire JSON but EX API is unavailable, fail hard.
      if (tireP) return 0;
      return Number(this._api.createVehicleJson(this._world, p, x, z, yaw)) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Write a file into the module filesystem (for JSON vehicle specs).
   * @param {string} path absolute FS path (e.g. /tmp/veh.json)
   * @param {string|Uint8Array} content
   */
  writeFile(path, content) {
    if (!this.ready) return false;
    const mod = this._mod;
    const p = String(path || '').trim();
    if (!mod || !p || p[0] !== '/') return false;
    try {
      // Some Emscripten builds do not expose `Module.FS`, only individual runtime methods
      // like FS_createDataFile/FS_createPath. Support both.
      const FS = mod.FS || null;
      const dir = p.split('/').slice(0, -1).join('/') || '/';
      const file = p.split('/').slice(-1)[0] || '';
      if (!file) return false;

      if (FS && typeof FS.writeFile === 'function') {
        try {
          if (typeof FS.mkdirTree === 'function') FS.mkdirTree(dir);
        } catch { /* ignore */ }
        FS.writeFile(p, content);
        return true;
      }

      const mkPath = (typeof mod.FS_createPath === 'function') ? mod.FS_createPath.bind(mod) : null;
      const mkFile = (typeof mod.FS_createDataFile === 'function') ? mod.FS_createDataFile.bind(mod) : null;
      if (!mkPath || !mkFile) return false;

      // Ensure parent directory exists.
      try {
        const relDir = (dir === '/') ? '' : String(dir).replace(/^\/+/, '');
        if (relDir) mkPath('/', relDir, true, true);
      } catch { /* ignore */ }

      // Overwrite if present (best-effort).
      try {
        if (typeof mod.FS_unlink === 'function') mod.FS_unlink(p);
      } catch { /* ignore */ }

      let data = content;
      if (!(data instanceof Uint8Array)) {
        const enc = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
        data = enc ? enc.encode(String(content ?? '')) : String(content ?? '');
      }

      try {
        // parent path can be a string (e.g. "/tmp"), name is filename.
        mkFile(dir, file, data, true, true, true);
        return true;
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }

  clearControls() {
    // no-op: we always set inputs per driven vehicle
  }

  setControls(handle, throttle, brake, steer) {
    if (!this.ready) return;
    const h = Number(handle) || 0;
    if (!h) return;
    // Chrono expects throttle [0,1], braking [0,1], steering [-1,1].
    const s = clamp(Number(steer) || 0, -1, 1);
    const t = clamp01(Number(throttle) || 0);
    const b = clamp01(Number(brake) || 0);
    try { this._api.setInputs(this._world, h, s, t, b); } catch { /* ignore */ }
  }

  setControlsEx(handle, throttle, brake, steer, clutch) {
    if (!this.ready) return;
    const h = Number(handle) || 0;
    if (!h) return;
    const s = clamp(Number(steer) || 0, -1, 1);
    const t = clamp01(Number(throttle) || 0);
    const b = clamp01(Number(brake) || 0);
    // Chrono clutch input uses 0=engaged (coupled), 1=disengaged.
    // Default to engaged when caller omits clutch.
    const cRaw = Number(clutch);
    const c = Number.isFinite(cRaw) ? clamp01(cRaw) : 0;
    const fn = this._api?.setInputsEx;
    try {
      if (typeof fn === 'function') fn(this._world, h, s, t, b, c);
      else this._api.setInputs(this._world, h, s, t, b);
    } catch { /* ignore */ }
  }

  /**
   * Set transmission gear.
   * Convention: 1 = forward (drive), 0 = neutral, -1 = reverse.
   */
  setGear(handle, gear) {
    if (!this.ready) return;
    const h = Number(handle) || 0;
    if (!h) return;
    const g = Math.max(-1, Math.min(1, Math.floor(Number(gear) || 0)));
    try { this._api.setGear(this._world, h, g); } catch { /* ignore */ }
  }

  setGearIndex(handle, gearIndex) {
    if (!this.ready) return;
    const h = Number(handle) || 0;
    if (!h) return;
    const g = Math.floor(Number(gearIndex) || 0);
    const fn = this._api?.setGearIndex;
    if (typeof fn !== 'function') return;
    try { fn(this._world, h, g); } catch { /* ignore */ }
  }

  setShiftMode(handle, manual) {
    if (!this.ready) return;
    const h = Number(handle) || 0;
    if (!h) return;
    const fn = this._api?.setShiftMode;
    if (typeof fn !== 'function') return;
    try { fn(this._world, h, manual ? 1 : 0); } catch { /* ignore */ }
  }

  setDriveMode(handle, mode) {
    if (!this.ready) return;
    const h = Number(handle) || 0;
    if (!h) return;
    const m = Math.max(-1, Math.min(1, Math.floor(Number(mode) || 0)));
    const fn = this._api?.setDriveMode;
    if (typeof fn !== 'function') return;
    try { fn(this._world, h, m); } catch { /* ignore */ }
  }

  setBrakePerWheel(handle, fl, fr, rl, rr) {
    if (!this.ready) return;
    const h = Number(handle) || 0;
    if (!h) return;
    const fn = this._api?.setBrake4;
    if (typeof fn !== 'function') return;
    try { fn(this._world, h, clamp01(fl), clamp01(fr), clamp01(rl), clamp01(rr)); } catch { /* ignore */ }
  }

  clearBrakePerWheel(handle) {
    if (!this.ready) return;
    const h = Number(handle) || 0;
    if (!h) return;
    const fn = this._api?.clearBrake4;
    if (typeof fn !== 'function') return;
    try { fn(this._world, h); } catch { /* ignore */ }
  }

  setWheelFrictionMuPerWheel(handle, fl, fr, rl, rr) {
    if (!this.ready) return;
    const h = Number(handle) || 0;
    if (!h) return;
    const fn = this._api?.setWheelMu4;
    if (typeof fn !== 'function') return;
    const clampMu = (x) => Math.max(0.05, Math.min(4.0, Number(x) || 0));
    try { fn(this._world, h, clampMu(fl), clampMu(fr), clampMu(rl), clampMu(rr)); } catch { /* ignore */ }
  }

  clearWheelFrictionMuPerWheel(handle) {
    if (!this.ready) return;
    const h = Number(handle) || 0;
    if (!h) return;
    const fn = this._api?.clearWheelMu4;
    if (typeof fn !== 'function') return;
    try { fn(this._world, h); } catch { /* ignore */ }
  }

  getTireSlips4(handle) {
    if (!this.ready) return null;
    const h = Number(handle) || 0;
    if (!h) return null;
    const fn = this._api?.getTireSlips4;
    if (typeof fn !== 'function') return null;
    const nFloats = 8;
    const bytes = nFloats * 4;
    try {
      const ptr = this._ensureScratchPtr('tire', bytes);
      if (!ptr) return null;
      const ok = Number(fn(this._world, h, ptr)) || 0;
      if (!ok) return null;
      const wheels = ['FL', 'FR', 'RL', 'RR'];
      /** @type {Record<string, {slipAngle:number,longSlip:number}>} */
      const out = {};
      for (let i = 0; i < 4; i++) {
        const base = i * 2;
        out[wheels[i]] = { slipAngle: this._readF32(ptr, base + 0), longSlip: this._readF32(ptr, base + 1) };
      }
      return out;
    } catch {
      return null;
    }
  }

  destroyVehicle(handle) {
    if (!this.ready) return;
    const h = Number(handle) || 0;
    if (!h) return;
    const fn = this._api?.destroyVehicle;
    if (typeof fn !== 'function') return;
    try { fn(this._world, h); } catch { /* ignore */ }
    try { this._lastGoodSpindles4.delete(h); } catch { /* ignore */ }
  }

  setVehicleTuningBasic(handle, {
    maxSteerRad = 0.48,
    throttleScale = 1.0,
    brakeScale = 1.0,
    diffLockPower = 0.0,
    diffLockCoast = 0.0,
  } = {}) {
    if (!this.ready) return;
    const h = Number(handle) || 0;
    if (!h) return;
    try {
      this._api.setVehicleTuningBasic(
        this._world,
        h,
        Number(maxSteerRad) || 0.48,
        Number(throttleScale) || 1.0,
        Number(brakeScale) || 1.0,
        Number(diffLockPower) || 0.0,
        Number(diffLockCoast) || 0.0,
      );
    } catch { /* ignore */ }
  }

  setVehicleChassisMassInertia(handle, { massKg = 0, ixx = 0, iyy = 0, izz = 0 } = {}) {
    if (!this.ready) return;
    const h = Number(handle) || 0;
    if (!h) return;
    try {
      this._api.setVehicleChassisMassInertia(
        this._world,
        h,
        Number(massKg) || 0,
        Number(ixx) || 0,
        Number(iyy) || 0,
        Number(izz) || 0,
      );
    } catch { /* ignore */ }
  }

  setVehicleChassisComRef(handle, { x = 0, y = 0, z = 0 } = {}) {
    if (!this.ready) return;
    const h = Number(handle) || 0;
    if (!h) return;
    const fn = this._api?.setVehicleChassisComRef;
    if (typeof fn !== 'function') return;
    try {
      fn(
        this._world,
        h,
        Number(x) || 0,
        Number(y) || 0,
        Number(z) || 0,
      );
    } catch { /* ignore */ }
  }

  setVehiclePowertrainSimpleMap(handle, {
    maxRpm = 6500,
    rpms = [],
    torquesNm = [],
    coastTorqueNm = -30,
    finalRatio = 4.1,
    reverseGear = 3.2,
    forwardGears = [],
  } = {}) {
    if (!this.ready) return;
    const h = Number(handle) || 0;
    if (!h) return;
    const mod = this._mod;
    if (!mod) return;

    const rpmArr = Array.isArray(rpms) ? rpms.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0) : [];
    const tqArr = Array.isArray(torquesNm) ? torquesNm.map((x) => Number(x)).filter((x) => Number.isFinite(x)) : [];
    const nPts = Math.max(0, Math.min(rpmArr.length, tqArr.length, 512));
    const gears = Array.isArray(forwardGears) ? forwardGears.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0).slice(0, 12) : [];
    const nG = gears.length;

    let ptrRpm = 0;
    let ptrTq = 0;
    let ptrG = 0;
    try {
      if (nPts > 0) {
        ptrRpm = mod._malloc(nPts * 4);
        ptrTq = mod._malloc(nPts * 4);
        if (!ptrRpm || !ptrTq) throw new Error('malloc failed');
        this._writeF32Array(ptrRpm, rpmArr.slice(0, nPts));
        this._writeF32Array(ptrTq, tqArr.slice(0, nPts));
      }
      if (nG > 0) {
        ptrG = mod._malloc(nG * 4);
        if (!ptrG) throw new Error('malloc failed');
        this._writeF32Array(ptrG, gears);
      }
      this._api.setVehiclePowertrainSimpleMap(
        this._world,
        h,
        Number(maxRpm) || 0,
        nPts,
        ptrRpm,
        ptrTq,
        Number(coastTorqueNm) || -30,
        Number(finalRatio) || 0,
        Number(reverseGear) || 0,
        nG,
        ptrG,
      );
    } catch { /* ignore */ }
    finally {
      try { if (ptrRpm) mod._free(ptrRpm); } catch { /* ignore */ }
      try { if (ptrTq) mod._free(ptrTq); } catch { /* ignore */ }
      try { if (ptrG) mod._free(ptrG); } catch { /* ignore */ }
    }
  }

  getWheelState(handle) {
    if (!this.ready) return null;
    const h = Number(handle) || 0;
    if (!h) return null;
    const nFloats = 17;
    const bytes = nFloats * 4;
    try {
      const ptr = this._ensureScratchPtr('wheel', bytes);
      if (!ptr) return null;
      const ok = Number(this._api.getWheelState(this._world, h, ptr)) || 0;
      if (!ok) return null;
      return {
        steerFL: this._readF32(ptr, 0),
        steerFR: this._readF32(ptr, 1),
        omegaFL: this._readF32(ptr, 2),
        omegaFR: this._readF32(ptr, 3),
        omegaRL: this._readF32(ptr, 4),
        omegaRR: this._readF32(ptr, 5),
        // Powertrain/transmission debug (see chrono_vehicle_bridge.cpp layout).
        gear: this._readF32(ptr, 6),
        driveshaftTorqueNm: this._readF32(ptr, 7),
        motorshaftRpm: this._readF32(ptr, 8),
        hasTransmission: this._readF32(ptr, 9) > 0.5,
        inputThrottleBridge: this._readF32(ptr, 10),
        inputBrakeBridge: this._readF32(ptr, 11),
        inputClutchBridge: this._readF32(ptr, 12),
        ptrainInertFrames: this._readF32(ptr, 13),
        ptrainBootstrapEvents: this._readF32(ptr, 14),
        chassisIsFixedBridge: this._readF32(ptr, 15) > 0.5,
        chassisMassBridgeKg: this._readF32(ptr, 16),
      };
    } catch {
      return null;
    }
  }

  setParkingBrake(handle, on) {
    if (!this.ready) return;
    const h = Number(handle) || 0;
    if (!h) return;
    try { this._api.setParkingBrake(this._world, h, on ? 1 : 0); } catch { /* ignore */ }
  }

  enableBrakeLocking(handle, on) {
    if (!this.ready) return;
    const h = Number(handle) || 0;
    if (!h) return;
    try { this._api.enableBrakeLocking(this._world, h, on ? 1 : 0); } catch { /* ignore */ }
  }

  lockAxleDiff(handle, axle, lock) {
    if (!this.ready) return;
    const h = Number(handle) || 0;
    if (!h) return;
    try { this._api.lockAxleDiff(this._world, h, Number(axle) || 0, lock ? 1 : 0); } catch { /* ignore */ }
  }

  lockCentralDiff(handle, which, lock) {
    if (!this.ready) return;
    const h = Number(handle) || 0;
    if (!h) return;
    try { this._api.lockCentralDiff(this._world, h, Number(which) || 0, lock ? 1 : 0); } catch { /* ignore */ }
  }

  disconnectDriveline(handle) {
    if (!this.ready) return;
    const h = Number(handle) || 0;
    if (!h) return;
    try { this._api.disconnectDriveline(this._world, h); } catch { /* ignore */ }
  }

  getVehicleDynamics(handle) {
    if (!this.ready) return null;
    const h = Number(handle) || 0;
    if (!h) return null;
    const nFloats = 7;
    const bytes = nFloats * 4;
    try {
      const ptr = this._ensureScratchPtr('dyn', bytes);
      if (!ptr) return null;
      const ok = Number(this._api.getVehicleDynamics(this._world, h, ptr)) || 0;
      if (!ok) return null;
      return {
        roll: this._readF32(ptr, 0),
        pitch: this._readF32(ptr, 1),
        slipAngle: this._readF32(ptr, 2),
        rollRate: this._readF32(ptr, 3),
        pitchRate: this._readF32(ptr, 4),
        yawRate: this._readF32(ptr, 5),
        turnRate: this._readF32(ptr, 6),
      };
    } catch {
      return null;
    }
  }

  getSpindles4(handle) {
    if (!this.ready) return null;
    const h = Number(handle) || 0;
    if (!h) return null;
    const nFloats = 52;
    const bytes = nFloats * 4;
    try {
      const ptr = this._ensureScratchPtr('spindle', bytes);
      if (!ptr) return null;
      const ok = Number(this._api.getSpindles4(this._world, h, ptr)) || 0;
      if (!ok) {
        const cached = this._lastGoodSpindles4.get(h);
        return cached ? cloneSpindlePacket4(cached) : null;
      }
      const wheels = ['FL', 'FR', 'RL', 'RR'];
      /** @type {{name:string, pos:{x:number,y:number,z:number}, quat:{x:number,y:number,z:number,w:number}, vel:{x:number,y:number,z:number}, angVel:{x:number,y:number,z:number}}[]} */
      const out = [];
      for (let i = 0; i < 4; i++) {
        const base = i * 13;
        out.push({
          name: wheels[i],
          pos: { x: this._readF32(ptr, base + 0), y: this._readF32(ptr, base + 1), z: this._readF32(ptr, base + 2) },
          quat: { x: this._readF32(ptr, base + 3), y: this._readF32(ptr, base + 4), z: this._readF32(ptr, base + 5), w: this._readF32(ptr, base + 6) },
          vel: { x: this._readF32(ptr, base + 7), y: this._readF32(ptr, base + 8), z: this._readF32(ptr, base + 9) },
          angVel: { x: this._readF32(ptr, base + 10), y: this._readF32(ptr, base + 11), z: this._readF32(ptr, base + 12) },
        });
      }
      if (isFiniteSpindlePacket4(out) && isPlausibleSpindleGeometry4(out)) {
        this._lastGoodSpindles4.set(h, out);
        return out;
      }
      const cached = this._lastGoodSpindles4.get(h);
      return cached ? cloneSpindlePacket4(cached) : null;
    } catch {
      const cached = this._lastGoodSpindles4.get(h);
      return cached ? cloneSpindlePacket4(cached) : null;
    }
  }

  getSpindles4RawWithStatus(handle) {
    if (!this.ready) return { apiOk: false, packet: null, finite: false, plausible: false };
    const h = Number(handle) || 0;
    if (!h) return { apiOk: false, packet: null, finite: false, plausible: false };
    const nFloats = 52;
    const bytes = nFloats * 4;
    try {
      const ptr = this._ensureScratchPtr('spindle', bytes);
      if (!ptr) return { apiOk: false, packet: null, finite: false, plausible: false };
      const ok = Number(this._api.getSpindles4(this._world, h, ptr)) || 0;
      if (!ok) return { apiOk: false, packet: null, finite: false, plausible: false };
      const wheels = ['FL', 'FR', 'RL', 'RR'];
      const out = [];
      for (let i = 0; i < 4; i++) {
        const base = i * 13;
        out.push({
          name: wheels[i],
          pos: { x: this._readF32(ptr, base + 0), y: this._readF32(ptr, base + 1), z: this._readF32(ptr, base + 2) },
          quat: { x: this._readF32(ptr, base + 3), y: this._readF32(ptr, base + 4), z: this._readF32(ptr, base + 5), w: this._readF32(ptr, base + 6) },
          vel: { x: this._readF32(ptr, base + 7), y: this._readF32(ptr, base + 8), z: this._readF32(ptr, base + 9) },
          angVel: { x: this._readF32(ptr, base + 10), y: this._readF32(ptr, base + 11), z: this._readF32(ptr, base + 12) },
        });
      }
      const finite = isFiniteSpindlePacket4(out);
      const plausible = finite && isPlausibleSpindleGeometry4(out);
      return { apiOk: true, packet: out, finite, plausible };
    } catch {
      return { apiOk: false, packet: null, finite: false, plausible: false };
    }
  }

  getSpindles4Status(handle) {
    if (!this.ready) return null;
    const h = Number(handle) || 0;
    if (!h) return null;
    const nFloats = 13;
    const bytes = nFloats * 4;
    try {
      if (typeof this._api?.getSpindles4Status !== 'function') return null;
      const ptr = this._ensureScratchPtr('spindle_status', bytes);
      if (!ptr) return null;
      const ok = Number(this._api.getSpindles4Status(this._world, h, ptr)) || 0;
      if (!ok) return null;
      return {
        reason: this._readF32(ptr, 0),
        allWheelsOk: this._readF32(ptr, 1) > 0.5,
        sanePacket: this._readF32(ptr, 2) > 0.5,
        wb: this._readF32(ptr, 3),
        tf: this._readF32(ptr, 4),
        tr: this._readF32(ptr, 5),
        maxPos: this._readF32(ptr, 6),
        maxVel: this._readF32(ptr, 7),
        maxAng: this._readF32(ptr, 8),
        failWheel: this._readF32(ptr, 9),
        failStage: this._readF32(ptr, 10),
        directOkMask: this._readF32(ptr, 11),
        fallbackOkMask: this._readF32(ptr, 12),
      };
    } catch {
      return null;
    }
  }

  getSpindles4Diag(handle) {
    if (!this.ready) return null;
    const h = Number(handle) || 0;
    if (!h) return null;
    const nFloats = 35;
    const bytes = nFloats * 4;
    try {
      if (typeof this._api?.getSpindles4Diag !== 'function') return null;
      const ptr = this._ensureScratchPtr('spindle_diag', bytes);
      if (!ptr) return null;
      const ok = Number(this._api.getSpindles4Diag(this._world, h, ptr)) || 0;
      if (!ok) return null;
      return {
        axleCount: this._readF32(ptr, 0),
        spawnExpectedWheelMask: this._readF32(ptr, 1),
        spawnExpectedTireMask: this._readF32(ptr, 2),
        wheelPtrMask: this._readF32(ptr, 3),
        wheelStateFiniteMask: this._readF32(ptr, 4),
        fallbackAttemptMask: this._readF32(ptr, 5),
        directOkMask: this._readF32(ptr, 6),
        fallbackOkMask: this._readF32(ptr, 7),
        failWheel: this._readF32(ptr, 8),
        failStage: this._readF32(ptr, 9),
        wsPosFiniteMask: this._readF32(ptr, 10),
        wsRotFiniteMask: this._readF32(ptr, 11),
        wsLinFiniteMask: this._readF32(ptr, 12),
        wsAngFiniteMask: this._readF32(ptr, 13),
        wsExceptionMask: this._readF32(ptr, 14),
        directPosFiniteMask: this._readF32(ptr, 15),
        directRotFiniteMask: this._readF32(ptr, 16),
        directLinFiniteMask: this._readF32(ptr, 17),
        directAngFiniteMask: this._readF32(ptr, 18),
        directExceptionMask: this._readF32(ptr, 19),
        spindleBodyAttemptMask: this._readF32(ptr, 20),
        spindleBodyPosFiniteMask: this._readF32(ptr, 21),
        spindleBodyRotFiniteMask: this._readF32(ptr, 22),
        spindleBodyLinFiniteMask: this._readF32(ptr, 23),
        spindleBodyAngFiniteMask: this._readF32(ptr, 24),
        spindleBodyExceptionMask: this._readF32(ptr, 25),
        healEventsTotal: this._readF32(ptr, 26),
        healEventsPre: this._readF32(ptr, 27),
        healEventsPost: this._readF32(ptr, 28),
        healLastStage: this._readF32(ptr, 29),
        healLastWheelMask: this._readF32(ptr, 30),
        healPosEvents: this._readF32(ptr, 31),
        healRotEvents: this._readF32(ptr, 32),
        healLinEvents: this._readF32(ptr, 33),
        healAngEvents: this._readF32(ptr, 34),
      };
    } catch {
      return null;
    }
  }

  getDriveProxyDiag(handle) {
    if (!this.ready) return null;
    const h = Number(handle) || 0;
    if (!h) return null;
    const nFloats = 15;
    const bytes = nFloats * 4;
    try {
      if (typeof this._api?.getDriveProxyDiag !== 'function') return null;
      const ptr = this._ensureScratchPtr('proxy_diag', bytes);
      if (!ptr) return null;
      const ok = Number(this._api.getDriveProxyDiag(this._world, h, ptr)) || 0;
      if (!ok) return null;
      return {
        active: this._readF32(ptr, 0) > 0.5,
        speed: this._readF32(ptr, 1),
        yawRate: this._readF32(ptr, 2),
        lastTime: this._readF32(ptr, 3),
        stateCalls: this._readF32(ptr, 4),
        stateOk: this._readF32(ptr, 5),
        stateExCalls: this._readF32(ptr, 6),
        stateExOk: this._readF32(ptr, 7),
        wheelCalls: this._readF32(ptr, 8),
        wheelOk: this._readF32(ptr, 9),
        powertrainCalls: this._readF32(ptr, 10),
        powertrainOk: this._readF32(ptr, 11),
        proxyPosChrono: {
          x: this._readF32(ptr, 12),
          y: this._readF32(ptr, 13),
          z: this._readF32(ptr, 14),
        },
      };
    } catch {
      return null;
    }
  }

  getTireState(handle, axle, side) {
    if (!this.ready) return null;
    const h = Number(handle) || 0;
    if (!h) return null;
    const ax = Number(axle) || 0;
    const sd = Number(side) || 0; // 0=left, 1=right
    const nFloats = 15;
    const bytes = nFloats * 4;
    try {
      const ptr = this._ensureScratchPtr('tire', bytes);
      if (!ptr) return null;
      const ok = Number(this._api.getTireState(this._world, h, ax, sd, ptr)) || 0;
      if (!ok) return null;
      return {
        slipAngle: this._readF32(ptr, 0),
        longSlip: this._readF32(ptr, 1),
        camber: this._readF32(ptr, 2),
        force: { x: this._readF32(ptr, 3), y: this._readF32(ptr, 4), z: this._readF32(ptr, 5) },
        moment: { x: this._readF32(ptr, 6), y: this._readF32(ptr, 7), z: this._readF32(ptr, 8) },
        point: { x: this._readF32(ptr, 9), y: this._readF32(ptr, 10), z: this._readF32(ptr, 11) },
        normal: { x: this._readF32(ptr, 12), y: this._readF32(ptr, 13), z: this._readF32(ptr, 14) },
      };
    } catch {
      return null;
    }
  }

  getPowertrainState(handle) {
    if (!this.ready) return null;
    const h = Number(handle) || 0;
    if (!h) return null;
    const nFloats = 16;
    const bytes = nFloats * 4;
    try {
      const ptr = this._ensureScratchPtr('ptrain', bytes);
      if (!ptr) return null;
      const ok = Number(this._api.getPowertrainState(this._world, h, ptr)) || 0;
      if (!ok) return null;
      return {
        hasEngine: this._readF32(ptr, 0) > 0.5,
        engineRpm: this._readF32(ptr, 1),
        engineTorqueNm: this._readF32(ptr, 2),
        hasTransmission: this._readF32(ptr, 3) > 0.5,
        transType: this._readF32(ptr, 4), // -1 unknown, 0 auto, 1 manual
        gear: this._readF32(ptr, 5),
        maxGear: this._readF32(ptr, 6),
        driveMode: this._readF32(ptr, 7), // -1/0/1
        shiftMode: this._readF32(ptr, 8), // 0/1
        motorshaftRpm: this._readF32(ptr, 9),
        driveshaftTorqueNm: this._readF32(ptr, 10),
        hasTorqueConverter: this._readF32(ptr, 11) > 0.5,
        tcSlip: this._readF32(ptr, 12),
        tcInputTorqueNm: this._readF32(ptr, 13),
        tcOutputTorqueNm: this._readF32(ptr, 14),
        tcOutputSpeedRpm: this._readF32(ptr, 15),
      };
    } catch {
      return null;
    }
  }

  step(dt) {
    if (!this.ready) return;
    const dts = Math.max(0, Number(dt) || 0);
    if (!(dts > 0)) return;
    try { this._api.stepWorld(this._world, dts); } catch { /* ignore */ }
  }

  /**
   * Returns a compact state: {x,z,yaw,speed,steerRad}
   * If available, uses cv_get_state_ex and also includes {y,vy,qx,qy,qz,qw}.
   * @returns {{x:number,y?:number,z:number,yaw:number,vx:number,vy?:number,vz:number,speed:number,steerRad:number,yawRate:number,qx?:number,qy?:number,qz?:number,qw?:number}|null}
   */
  getState(handle) {
    if (!this.ready) return null;
    const h = Number(handle) || 0;
    if (!h) return null;

    const readBasic = () => {
      // struct of 8 floats: x,z,yaw,vx,vz,speed,steerRad,yawRate
      const nFloats = 8;
      const bytes = nFloats * 4;
      try {
        const ptr = this._ensureScratchPtr('state', bytes);
        if (!ptr) return null;
        const ok = Number(this._api.getState(this._world, h, ptr)) || 0;
        if (!ok) return null;
        return {
          x: this._readF32(ptr, 0),
          z: this._readF32(ptr, 1),
          yaw: this._readF32(ptr, 2),
          vx: this._readF32(ptr, 3),
          vz: this._readF32(ptr, 4),
          speed: this._readF32(ptr, 5),
          steerRad: this._readF32(ptr, 6),
          yawRate: this._readF32(ptr, 7),
        };
      } catch {
        return null;
      }
    };

    // Extended state: x,y,z,yaw,vx,vy,vz,speed,steerRad,yawRate,q(xyzw)
    if (this._api?.getStateEx) {
      const nFloats = 14;
      const bytes = nFloats * 4;
      try {
        const ptr = this._ensureScratchPtr('stateEx', bytes);
        if (!ptr) return null;
        const ok = Number(this._api.getStateEx(this._world, h, ptr)) || 0;
        if (!ok) return null;
        const ex = {
          x: this._readF32(ptr, 0),
          y: this._readF32(ptr, 1),
          z: this._readF32(ptr, 2),
          yaw: this._readF32(ptr, 3),
          vx: this._readF32(ptr, 4),
          vy: this._readF32(ptr, 5),
          vz: this._readF32(ptr, 6),
          speed: this._readF32(ptr, 7),
          steerRad: this._readF32(ptr, 8),
          yawRate: this._readF32(ptr, 9),
          qx: this._readF32(ptr, 10),
          qy: this._readF32(ptr, 11),
          qz: this._readF32(ptr, 12),
          qw: this._readF32(ptr, 13),
        };
        const finite =
          Number.isFinite(ex.x) && Number.isFinite(ex.y) && Number.isFinite(ex.z)
          && Number.isFinite(ex.yaw)
          && Number.isFinite(ex.vx) && Number.isFinite(ex.vy) && Number.isFinite(ex.vz)
          && Number.isFinite(ex.speed)
          && Number.isFinite(ex.steerRad)
          && Number.isFinite(ex.yawRate);
        const sane = Math.abs(ex.y) < 1e3 && Math.abs(ex.vy) < 1e3;
        if (finite && sane) return ex;
        // If stateEx looks corrupted, fall back to the basic state.
        return readBasic();
      } catch { /* ignore */ }
    }

    return readBasic();
  }
}
