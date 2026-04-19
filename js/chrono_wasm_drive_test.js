import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { ProjectChronoWasmVehicleSim } from './runtime/project_chrono_wasm_vehicle_sim.js';

const CAR_ASSET_REV = '2026-03-02-350z-hpoff-trackfix';
const CAR_URL = `/webautos/ac__streetcarpack_nissan_350z/stream/ac__streetcarpack_nissan_350z_hi.glb?rev=${encodeURIComponent(CAR_ASSET_REV)}`;
const CAR_META_URL = `/webautos/ac__streetcarpack_nissan_350z/stream/ac__streetcarpack_nissan_350z_hi.meta.json?rev=${encodeURIComponent(CAR_ASSET_REV)}`;
const STRICT_CAR_ID = 'streetcarpack_nissan_350z';
const SPAWN_BRAKE_HOLD_SEC = 0.9;
const IDLE_BRAKE_DAMP_SPEED_MPS = 1.0;
// Keep idle brake damping off by default. For this 350Z Chrono path, continuous light brake at near-zero speed
// can drive wheel/spindle translational channels non-finite in the solver/tire stack.
const IDLE_BRAKE_DAMP_AMOUNT = 0.0;
const GEOM_TRACE_MAX_FRAMES = 420;
const RAW_SPINDLE_BAD_FRAME_LIMIT = 45;
const SPINDLE_GEOM_LIMITS = Object.freeze({
  wheelbaseMin: 1.4,
  wheelbaseMax: 4.2,
  trackMin: 0.7,
  trackMax: 2.6,
});
const GEOM_MISMATCH_LIMITS = Object.freeze({
  wheelbaseAbs: 0.12,
  trackAbs: 0.12,
  frames: 8,
  clearFrames: 45,
  settleSecAfterHold: 0.35,
});
const MESH_FRAME_MISMATCH_LIMITS = Object.freeze({
  posWarnMeters: 0.10,
  posLatchMeters: 0.18,
  frames: 10,
});
const DRIVE_INERT_RECOVERY = Object.freeze({
  fallbackOnSec: 0.22,
  fallbackReleaseSec: 0.45,
  fallbackReleaseSpeedMps: 0.65,
  fallbackReleaseOmega: 2.0,
  rescueSec: 0.35,
  reassertSec: 0.70,
  respawnSec: 1.35,
});
const STRICT_DEBUG_NATIVE_ONLY = true;
const STRICT_CHRONO_MODE = true;
const DRIVE_TUNING = Object.freeze({
  maxSteerRad: 0.58,
  throttleScale: 1.35,
  brakeScale: 0.90,
  diffLockPower: 0.0,
  diffLockCoast: 0.0,
  powertrain: Object.freeze({
    maxRpm: 6800,
    rpms: Object.freeze([-10, 0, 800, 1500, 2200, 3200, 4200, 5200, 6200, 6800]),
    torquesNm: Object.freeze([250, 250, 250, 285, 305, 325, 318, 300, 270, 240]),
    coastTorqueNm: -35,
    finalRatio: 4.08,
    reverseGear: 3.36,
    forwardGears: Object.freeze([3.79, 2.32, 1.62, 1.27, 1.00, 0.79]),
  }),
});
const SIM_DEBUG_CONFIG = Object.freeze({
  visual: Object.freeze({
    useMetaYawOffset: true,
    meshLocalYawOffsetRad: 0,
    meshLocalOffset: Object.freeze({ x: 0, y: 0, z: 0 }),
    meshScale: 1.0,
    wheelAxisFixRad: Math.PI * 0.5,
    wheelMarkerFollowSpindleOrientation: true,
    // Keep disabled by default: center-to-center Y alignment can over-lift meshes
    // whose authored wheel-center reference differs from rendered wheel geometry.
    autoAlignMeshToSpindles: false,
  }),
  world: Object.freeze({
    spawnWorldY: 1.2,
    frictionMu: 1.0,
    staticsOn: false,
  }),
  sim: Object.freeze({
    fixedStep: 1 / 120,
    maxSubstepsPerFrame: 10,
    // Keep authored JSON powertrain/driveline as authority by default.
    // The exported transmission_simple_map.json already stores Chrono-native gear-box ratios.
    // Re-injecting through our runtime simple-map converter can double-transform ratios.
    enableAuthoredSimpleMapInjection: false,
    // Prefer simple controls for automatic-transmission paths; avoids clutch-semantic ambiguity.
    preferControlsEx: false,
    // Disable clutch auto-flip; for this automatic path it can disengage torque permanently.
    enableClutchAutoFlip: false,
    // Keep inert-respawn off in the interactive drive harness; use manual R reset instead.
    enableInertAutoRespawn: false,
  }),
  pose: Object.freeze({
    preferStateEx: true,
    useStateExY: true,
    spindleMaxAbs: 1e5,
  }),
});

function getMeshYawOffset(meta, cfg) {
  const metaYaw = Number(meta?.modelYawOffsetRad) || 0;
  const useMetaYaw = !!cfg?.visual?.useMetaYawOffset;
  const extraYaw = Number(cfg?.visual?.meshLocalYawOffsetRad) || 0;
  return (useMetaYaw ? metaYaw : 0) + extraYaw;
}

function applySkinCalibration(carRoot, carRootBaseQuat, meshYawOffsetRad, cfg) {
  const o = cfg?.visual?.meshLocalOffset || { x: 0, y: 0, z: 0 };
  const sx = Number(cfg?.visual?.meshScale);
  const scale = Number.isFinite(sx) && sx > 0 ? sx : 1.0;
  const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), meshYawOffsetRad);
  carRoot.quaternion.copy(carRootBaseQuat).multiply(qYaw);
  carRoot.position.set(Number(o.x) || 0, Number(o.y) || 0, Number(o.z) || 0);
  carRoot.scale.setScalar(scale);
  carRoot.updateMatrix();
  carRoot.matrixWorldNeedsUpdate = true;
}

function clamp(x, a, b) {
  const n = Number(x) || 0;
  return Math.max(a, Math.min(b, n));
}

function safeTrim(s) { return String(s ?? '').trim(); }

function fmt(n, digits = 2) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '—';
  return x.toFixed(digits);
}

function fmtPosXZ(p, digits = 3) {
  if (!p) return '(—, —)';
  const x = Number(p.x);
  const z = Number(p.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return '(—, —)';
  return `(${x.toFixed(digits)}, ${z.toFixed(digits)})`;
}

function nowSec() { return performance.now() * 0.001; }

async function fetchJson(url) {
  const u = safeTrim(url);
  if (!u) return null;
  try {
    const resp = await fetch(u, { cache: 'no-store' });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

async function fetchText(url) {
  const u = safeTrim(url);
  if (!u) return '';
  try {
    const resp = await fetch(u, { cache: 'no-store' });
    if (!resp.ok) return '';
    return await resp.text();
  } catch {
    return '';
  }
}

function resolveChronoUrl(baseUrl, relOrAbsUrl) {
  const rel = safeTrim(relOrAbsUrl);
  if (!rel) return '';
  // Accept already-absolute URLs and root-relative app URLs.
  if (/^(?:[a-z]+:)?\/\//i.test(rel) || rel.startsWith('/')) return rel;
  const base = safeTrim(baseUrl);
  const win = (typeof window !== 'undefined') ? window : null;
  const origin = safeTrim(win?.location?.origin);
  const href = safeTrim(win?.location?.href);
  const absBase = (() => {
    if (!base) return href || origin || '';
    if (/^(?:[a-z]+:)?\/\//i.test(base)) return base;
    if (base.startsWith('/')) return origin ? `${origin}${base}` : base;
    try { return href ? new URL(base, href).toString() : base; } catch { return base; }
  })();
  try { return new URL(rel, absBase).toString(); } catch { return ''; }
}

function setDriveMode(sim, handle, mode) {
  const h = Number(handle) || 0;
  if (!h) return;
  const m = Math.sign(Number(mode) || 0);
  // Prefer explicit drive-mode control for automatic transmissions.
  try { sim.setShiftMode?.(h, false); } catch { /* ignore */ }
  try { sim.setDriveMode?.(h, m); } catch { /* ignore */ }
  if (!STRICT_DEBUG_NATIVE_ONLY) {
    // Compatibility fallback for older bridges without dedicated drive-mode handling.
    try { sim.setGear?.(h, m); } catch { /* ignore */ }
  }
}

function isManualTransmissionTemplateName(name) {
  return /ManualTransmission/i.test(safeTrim(name));
}

function getTransmissionControlMode(chronoSpec, powertrainState = null) {
  const ptType = Math.trunc(Number(powertrainState?.transType));
  if (ptType === 1) return 'manual';
  if (ptType === 0) return 'automatic';
  return isManualTransmissionTemplateName(chronoSpec?.powertrain?.transType) ? 'manual' : 'automatic';
}

function setManualGearIndex(sim, handle, gearIndex) {
  const h = Number(handle) || 0;
  if (!h) return;
  const g = Math.trunc(Number(gearIndex) || 0);
  try { sim.setGearIndex?.(h, g); } catch { /* ignore */ }
  if (!STRICT_DEBUG_NATIVE_ONLY) {
    try { sim.setGear?.(h, g); } catch { /* ignore */ }
  }
}

function primeVehicleTransmission(sim, handle, controlMode, manualGearIndex = 1) {
  const h = Number(handle) || 0;
  if (!h) return;
  if (controlMode === 'manual') {
    setManualGearIndex(sim, h, manualGearIndex);
    return;
  }
  setDriveMode(sim, h, manualGearIndex < 0 ? -1 : 1);
}

function applyVehicleDriveTuning(sim, handle, controlMode = 'automatic', manualGearIndex = 1) {
  const h = Number(handle) || 0;
  if (!h) return;
  try {
    sim.setVehicleTuningBasic?.(h, {
      maxSteerRad: DRIVE_TUNING.maxSteerRad,
      throttleScale: DRIVE_TUNING.throttleScale,
      brakeScale: DRIVE_TUNING.brakeScale,
      diffLockPower: DRIVE_TUNING.diffLockPower,
      diffLockCoast: DRIVE_TUNING.diffLockCoast,
    });
  } catch { /* ignore */ }
  // Keep the authored vehicle powertrain/driveline from JSON as the source of truth.
  // Overriding with a generic simple-map can pin engine/driveline at zero on some exports.
  try { sim.enableBrakeLocking?.(h, false); } catch { /* ignore */ }
  try { sim.clearBrakePerWheel?.(h); } catch { /* ignore */ }
  // Some JSON packs can spawn with parking brake engaged; force a known released state.
  try { sim.setParkingBrake?.(h, false); } catch { /* ignore */ }
  try { primeVehicleTransmission(sim, h, controlMode, manualGearIndex); } catch { /* ignore */ }
}

const CHRONO_TEST_API_METHODS = Object.freeze([
  'setSpawnWorldY',
  'setWorldFriction',
  'setTerrainFlatRigid',
  'setTerrainMeshObj',
  'setTerrainHeightmapBmp',
  'setTerrainHeightfield',
  'setStaticAabbsWorld',
  'addStaticTriMeshWorld',
  'createVehicle',
  'createVehicleJson',
  'destroyVehicle',
  'setControls',
  'setControlsEx',
  'setGear',
  'setGearIndex',
  'setShiftMode',
  'setDriveMode',
  'setBrakePerWheel',
  'clearBrakePerWheel',
  'setWheelFrictionMuPerWheel',
  'clearWheelFrictionMuPerWheel',
  'setVehicleTuningBasic',
  'setVehicleChassisMassInertia',
  'setVehicleChassisComRef',
  'setVehiclePowertrainSimpleMap',
  'step',
  'getState',
  'getVehicleDynamics',
  'getSpindles4',
  'getSpindles4RawWithStatus',
  'getSpindles4Status',
  'getSpindles4Diag',
  'getTireState',
  'getTireSlips4',
  'getPowertrainState',
  'getWheelState',
  'setParkingBrake',
  'enableBrakeLocking',
  'lockAxleDiff',
  'lockCentralDiff',
  'disconnectDriveline',
  'getBridgeDiagVersion',
  'getDriveProxyDiag',
  'writeFile',
]);

const CHRONO_TEST_API_USED_METHODS = Object.freeze([
  'setSpawnWorldY',
  'setWorldFriction',
  'setStaticAabbsWorld',
  'createVehicleJson',
  'destroyVehicle',
  'setControls',
  'setControlsEx',
  'setGear',
  'setGearIndex',
  'setShiftMode',
  'setDriveMode',
  'clearBrakePerWheel',
  'setVehicleTuningBasic',
  'step',
  'getState',
  'getVehicleDynamics',
  'getSpindles4',
  'getSpindles4RawWithStatus',
  'getSpindles4Status',
  'getSpindles4Diag',
  'getTireState',
  'getTireSlips4',
  'getPowertrainState',
  'getWheelState',
  'setParkingBrake',
  'enableBrakeLocking',
  'getBridgeDiagVersion',
  'getDriveProxyDiag',
  'writeFile',
]);

function getChronoTestApiCoverage(sim) {
  const methods = CHRONO_TEST_API_METHODS.slice();
  const available = methods.filter((name) => typeof sim?.[name] === 'function');
  const missing = methods.filter((name) => typeof sim?.[name] !== 'function');
  const used = CHRONO_TEST_API_USED_METHODS.filter((name) => typeof sim?.[name] === 'function');
  const unused = methods.filter((name) => typeof sim?.[name] === 'function' && !CHRONO_TEST_API_USED_METHODS.includes(name));
  return {
    total: methods.length,
    availableCount: available.length,
    missingCount: missing.length,
    usedCount: used.length,
    unusedCount: unused.length,
    available,
    missing,
    used,
    unused,
  };
}

async function loadChronoVehicleSpecIntoFs(sim, manifestUrl) {
  const mUrl = safeTrim(manifestUrl);
  if (!mUrl) return null;
  const manifest = await fetchJson(mUrl);
  if (!manifest || typeof manifest !== 'object') return null;
  const carId = safeTrim(manifest?.carId);
  const mode = safeTrim(manifest?.mode);
  if (carId !== STRICT_CAR_ID || mode !== 'full_native_v1') return null;
  const fsRoot = '/data/vehicle';
  const dataFilesRaw = Array.isArray(manifest?.dataFiles) ? manifest.dataFiles : [];
  const dataFiles = dataFilesRaw
    .map((rec) => (rec && typeof rec === 'object') ? rec : null)
    .filter(Boolean)
    .sort((a, b) => safeTrim(a?.fsRel || a?.rel).localeCompare(safeTrim(b?.fsRel || b?.rel)));
  const textByFsRel = new Map();
  let wroteAny = false;
  for (const rec of dataFiles) {
    if (!rec || typeof rec !== 'object') continue;
    const fsRel = safeTrim(rec.fsRel || rec.fsPath || rec.path || rec.key);
    const srcRel = safeTrim(rec.rel || rec.path || '');
    const srcAbs = safeTrim(rec.url || rec.fileUrl || rec.href || '');
    if (!fsRel || (!srcRel && !srcAbs)) continue;
    if (fsRel.startsWith('/') || fsRel.includes('..')) continue;
    let txt = '';
    if (srcRel) {
      const uRel = resolveChronoUrl(mUrl, srcRel);
      if (uRel) txt = await fetchText(uRel);
    }
    if (!txt && srcAbs) {
      const uAbs = resolveChronoUrl(mUrl, srcAbs);
      if (uAbs) txt = await fetchText(uAbs);
    }
    if (!txt) continue;
    const abs = `${fsRoot}/${fsRel}`.replace(/\/+/g, '/');
    try {
      if (sim.writeFile(abs, txt)) {
        wroteAny = true;
        textByFsRel.set(fsRel, txt);
      }
    } catch { /* ignore */ }
  }
  const vehicleFsRel = safeTrim(manifest?.vehicleFsRel || manifest?.vehiclePath || '');
  const tireFsRel = safeTrim(manifest?.tireFsRel || manifest?.tirePath || manifest?.tireJsonRel || '');
  if (!wroteAny || !vehicleFsRel || vehicleFsRel.startsWith('/') || vehicleFsRel.includes('..')) return null;
  if (!vehicleFsRel.startsWith(`${STRICT_CAR_ID}/`)) return null;
  if (!tireFsRel || tireFsRel.startsWith('/') || tireFsRel.includes('..') || !tireFsRel.startsWith(`${STRICT_CAR_ID}/`)) return null;

  const parseLocalJson = (fsRel) => {
    const txt = textByFsRel.get(fsRel);
    if (!txt) return null;
    try { return JSON.parse(txt); } catch { return null; }
  };
  const vehicleJson = parseLocalJson(vehicleFsRel);
  const frontSuspRel = safeTrim(vehicleJson?.Axles?.[0]?.['Suspension Input File']);
  const rearSuspRel = safeTrim(vehicleJson?.Axles?.[1]?.['Suspension Input File']);
  const frontSusp = parseLocalJson(frontSuspRel);
  const rearSusp = parseLocalJson(rearSuspRel);
  const frontAc = (frontSusp && typeof frontSusp === 'object') ? frontSusp['AC Suspension'] : null;
  const rearAc = (rearSusp && typeof rearSusp === 'object') ? rearSusp['AC Suspension'] : null;
  const frontTrackAc = Number(frontAc?.track_target_m);
  const rearTrackAc = Number(rearAc?.track_target_m);
  const haveExplicitTrackTargets = Number.isFinite(frontTrackAc) && Number.isFinite(rearTrackAc);
  if (STRICT_DEBUG_NATIVE_ONLY && !haveExplicitTrackTargets) return null;
  const frontTrack = frontTrackAc;
  const rearTrack = rearTrackAc;
  const trackSource = haveExplicitTrackTargets ? 'ac_track_target' : 'missing';
  const frontX = Number(vehicleJson?.Axles?.[0]?.['Suspension Location']?.[0]);
  const rearX = Number(vehicleJson?.Axles?.[1]?.['Suspension Location']?.[0]);
  const wheelbase = Number(vehicleJson?.Wheelbase);
  const hasVehicleTires = !!safeTrim(vehicleJson?.Axles?.[0]?.['Tire Input File']) && !!safeTrim(vehicleJson?.Axles?.[1]?.['Tire Input File']);
  const wheelbaseOk = (
    Number.isFinite(wheelbase) && wheelbase > 2.0 && wheelbase < 3.4
    && Number.isFinite(frontX) && Number.isFinite(rearX) && frontX > rearX
    && Math.abs((frontX - rearX) - wheelbase) < 0.5
  );
  const trackOk = (
    Number.isFinite(frontTrack) && Number.isFinite(rearTrack)
    && (
    frontTrack > 1.0 && frontTrack < 2.5
    && rearTrack > 1.0 && rearTrack < 2.5
  ));
  const geomOk = wheelbaseOk && trackOk;
  if (!geomOk || !hasVehicleTires) return null;

  const tireJson = parseLocalJson(tireFsRel);
  if (!tireJson || safeTrim(tireJson?.Type) !== 'Tire') return null;
  const engineFsRel = safeTrim(vehicleJson?.Powertrain?.['Engine Input File']);
  const transFsRel = safeTrim(vehicleJson?.Powertrain?.['Transmission Input File']);
  const engineJson = engineFsRel ? parseLocalJson(engineFsRel) : null;
  const transJson = transFsRel ? parseLocalJson(transFsRel) : null;
  const engineFullMap = Array.isArray(engineJson?.['Map Full Throttle']) ? engineJson['Map Full Throttle'] : [];
  const p0 = Array.isArray(engineFullMap[0]) ? engineFullMap[0] : null;
  const p1 = Array.isArray(engineFullMap[1]) ? engineFullMap[1] : null;
  const zeroMap = Array.isArray(engineJson?.['Map Zero Throttle']) ? engineJson['Map Zero Throttle'] : [];
  const coastP0 = Array.isArray(zeroMap[0]) ? zeroMap[0] : null;
  const transGearBox = (transJson && typeof transJson === 'object')
    ? (transJson['Gear Box'] || transJson.GearBox || transJson.gearBox || transJson)
    : null;
  const forwardRatiosRaw = Array.isArray(transGearBox?.['Forward Gear Ratios'])
    ? transGearBox['Forward Gear Ratios']
    : (Array.isArray(transGearBox?.forward_gear_ratios) ? transGearBox.forward_gear_ratios : []);
  const reverseRatioRaw = Number(
    transGearBox?.['Reverse Gear Ratio']
    ?? transGearBox?.reverse_gear_ratio
    ?? transJson?.['Reverse Gear Ratio']
    ?? transJson?.reverse_gear_ratio
  );
  const finalRatioRaw = Number(
    transJson?.['Axle Differential Ratio']
    ?? transJson?.['Final Drive Ratio']
    ?? transJson?.axle_differential_ratio
    ?? transJson?.final_drive_ratio
  );
  const drivelineFsRel = safeTrim(vehicleJson?.Driveline?.['Input File']);
  const drivelineJson = drivelineFsRel ? parseLocalJson(drivelineFsRel) : null;
  const conicalRatio = Number(
    drivelineJson?.['Gear Ratio']?.['Conical Gear']
    ?? drivelineJson?.gear_ratio?.conical_gear
  );
  const finalRatioFromDriveline = (
    Number.isFinite(conicalRatio) && Math.abs(conicalRatio) > 1e-6
      ? Math.abs(1.0 / conicalRatio)
      : NaN
  );

  return {
    jsonPath: vehicleFsRel,
    sourceJsonPath: vehicleFsRel,
    tireJsonPath: tireFsRel,
    jsonPathAbs: `${fsRoot}/${vehicleFsRel}`.replace(/\/+/g, '/'),
    tireJsonPathAbs: `${fsRoot}/${tireFsRel}`.replace(/\/+/g, '/'),
    manifestUrl: mUrl,
    vehicleUrl: resolveChronoUrl(mUrl, manifest?.vehicleJsonUrl || ''),
    tireUrl: resolveChronoUrl(mUrl, manifest?.tireJsonUrl || ''),
    powertrain: {
      enginePath: engineFsRel || '',
      transPath: transFsRel || '',
      engineType: safeTrim(engineJson?.Template || ''),
      transType: safeTrim(transJson?.Template || ''),
      mapP0: p0 ? { rpm: Number(p0[0]), tq: Number(p0[1]) } : null,
      mapP1: p1 ? { rpm: Number(p1[0]), tq: Number(p1[1]) } : null,
      fullThrottleMapRpmNm: engineFullMap,
      coastTorqueNm: coastP0 ? Number(coastP0[1]) : NaN,
      forwardRatiosRaw,
      reverseRatioRaw,
      finalRatioRaw,
      finalRatioFromDriveline,
      conicalRatioRaw: conicalRatio,
    },
    geom: { wheelbase, frontTrack, rearTrack, frontX, rearX, trackSource },
    hardpoints: {
      mode: safeTrim(manifest?.hardpointsMode || frontAc?.hardpoints_mode || rearAc?.hardpoints_mode || 'unknown'),
      requested: (
        (typeof manifest?.hardpointsRequested === 'boolean') ? !!manifest.hardpointsRequested
          : (!!frontAc?.hardpoints_requested || !!rearAc?.hardpoints_requested)
      ),
      frontApplied: !!frontAc?.hardpoints_applied,
      frontGeomOk: !!frontAc?.hardpoints_geom_ok,
      frontPartial: !!frontAc?.hardpoints_partial_ac,
      frontFull: !!frontAc?.hardpoints_full_ac,
      rearApplied: !!rearAc?.hardpoints_applied,
      rearGeomOk: !!rearAc?.hardpoints_geom_ok,
      rearPartial: !!rearAc?.hardpoints_partial_ac,
      rearFull: !!rearAc?.hardpoints_full_ac,
    },
  };
}

function getAnchorPosVec3(meta, key, fallback) {
  const p = meta?.anchors?.[key]?.pos;
  const arr = Array.isArray(p) ? p : null;
  if (arr && arr.length >= 3) {
    return new THREE.Vector3(Number(arr[0]) || 0, Number(arr[1]) || 0, Number(arr[2]) || 0);
  }
  return fallback ? fallback.clone() : new THREE.Vector3(0, 1.2, 0.0);
}

function vec3FromObj(p) {
  return new THREE.Vector3(Number(p?.x), Number(p?.y), Number(p?.z));
}

function quatFromObj(q) {
  return new THREE.Quaternion(Number(q?.x), Number(q?.y), Number(q?.z), Number(q?.w)).normalize();
}

function computeVehiclePose(st, cfg) {
  const px = Number(st?.x) || 0;
  const py = Number(st?.y);
  const pz = Number(st?.z) || 0;
  const yaw = Number(st?.yaw) || 0;
  const qx = Number(st?.qx);
  const qy = Number(st?.qy);
  const qz = Number(st?.qz);
  const qw = Number(st?.qw);
  const hasStateExPose = (
    Number.isFinite(py)
    && Math.abs(py) < 1e3
    && Number.isFinite(qx)
    && Number.isFinite(qy)
    && Number.isFinite(qz)
    && Number.isFinite(qw)
  );
  if (cfg?.pose?.preferStateEx && hasStateExPose) {
    const useY = !!cfg?.pose?.useStateExY;
    return {
      usedStateEx: true,
      position: new THREE.Vector3(px, useY ? py : 0, pz),
      quaternion: new THREE.Quaternion(qx, qy, qz, qw).normalize(),
      yaw,
    };
  }
  return {
    usedStateEx: false,
    position: new THREE.Vector3(px, 0, pz),
    quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
    yaw,
  };
}

function applyWheelVizFromSpindles(spindles, simWheelViz, cfg) {
  if (!Array.isArray(spindles) || spindles.length < 4 || !simWheelViz) return;
  const map = { lf: spindles[0], rf: spindles[1], lr: spindles[2], rr: spindles[3] };
  const pMap = {};
  const ids = ['lf', 'rf', 'lr', 'rr'];
  for (const id of ids) {
    const s = map[id];
    const obj = simWheelViz.wheels[id];
    if (!s || !obj) continue;
    const p = vec3FromObj(s.pos);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
    if (Math.abs(p.x) > cfg.pose.spindleMaxAbs || Math.abs(p.y) > cfg.pose.spindleMaxAbs || Math.abs(p.z) > cfg.pose.spindleMaxAbs) continue;
    // Keep wheel markers rigidly anchored to spindle pose.
    obj.position.copy(p);
    const qS = quatFromObj(s.quat);
    if (cfg.visual.wheelMarkerFollowSpindleOrientation) {
      obj.quaternion.copy(qS).multiply(simWheelViz.wheelAxisFix);
    } else {
      obj.quaternion.copy(simWheelViz.wheelAxisFix);
    }
    const ax = simWheelViz.axes[id];
    if (ax) {
      ax.position.copy(p);
      ax.quaternion.copy(qS);
    }
    pMap[id] = p;
  }
  if (simWheelViz.lines.front && pMap.lf && pMap.rf) {
    simWheelViz.lines.front.geometry.setFromPoints([pMap.lf, pMap.rf]);
  }
  if (simWheelViz.lines.rear && pMap.lr && pMap.rr) {
    simWheelViz.lines.rear.geometry.setFromPoints([pMap.lr, pMap.rr]);
  }
}

function getSpindleCenterWorld(spindles) {
  if (!Array.isArray(spindles) || spindles.length < 4) return null;
  const out = new THREE.Vector3();
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const p = vec3FromObj(spindles[i]?.pos);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
    out.add(p);
    n++;
  }
  if (n < 4) return null;
  return out.multiplyScalar(1 / n);
}

function canonicalizeSpindleOrderByPose(spindles, poseQuat) {
  if (!Array.isArray(spindles) || spindles.length < 4) return null;
  const pts = [];
  for (let i = 0; i < 4; i++) {
    const p = vec3FromObj(spindles[i]?.pos);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
    pts.push({ idx: i, p });
  }
  const center = new THREE.Vector3();
  for (const it of pts) center.add(it.p);
  center.multiplyScalar(0.25);

  const q = (poseQuat && Number.isFinite(poseQuat.x) && Number.isFinite(poseQuat.y) && Number.isFinite(poseQuat.z) && Number.isFinite(poseQuat.w))
    ? poseQuat
    : new THREE.Quaternion();
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q).setY(0);
  if (fwd.lengthSq() < 1e-6) return null;
  fwd.normalize();
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q).setY(0);
  if (right.lengthSq() < 1e-6) right.set(fwd.z, 0, -fwd.x);
  right.normalize();

  const recs = pts.map((it) => {
    const d = it.p.clone().sub(center);
    return {
      idx: it.idx,
      longitudinal: d.dot(fwd),
      lateral: d.dot(right),
    };
  });
  const byLong = recs.slice().sort((a, b) => b.longitudinal - a.longitudinal);
  const frontPair = byLong.slice(0, 2).sort((a, b) => a.lateral - b.lateral); // left then right
  const rearPair = byLong.slice(2, 4).sort((a, b) => a.lateral - b.lateral); // left then right
  if (frontPair.length < 2 || rearPair.length < 2) return null;

  const longSep = (
    ((frontPair[0].longitudinal + frontPair[1].longitudinal) * 0.5)
    - ((rearPair[0].longitudinal + rearPair[1].longitudinal) * 0.5)
  );
  const latFront = Math.abs(frontPair[1].lateral - frontPair[0].lateral);
  const latRear = Math.abs(rearPair[1].lateral - rearPair[0].lateral);
  const plausible = (longSep > 0.2 && latFront > 0.2 && latRear > 0.2);

  const orderedIdx = [frontPair[0].idx, frontPair[1].idx, rearPair[0].idx, rearPair[1].idx];
  const reordered = orderedIdx.some((v, i) => v !== i);
  return {
    spindles: orderedIdx.map((i) => spindles[i]),
    reordered,
    plausible,
    longSep,
    latFront,
    latRear,
  };
}

function isSpindleGeometryInRange(wb, tf, tr) {
  return (
    wb > SPINDLE_GEOM_LIMITS.wheelbaseMin && wb < SPINDLE_GEOM_LIMITS.wheelbaseMax
    && tf > SPINDLE_GEOM_LIMITS.trackMin && tf < SPINDLE_GEOM_LIMITS.trackMax
    && tr > SPINDLE_GEOM_LIMITS.trackMin && tr < SPINDLE_GEOM_LIMITS.trackMax
  );
}

function analyzeSpindleGeometry(spindles) {
  if (!Array.isArray(spindles) || spindles.length < 4) {
    return { seen: false, initialized: false, finite: false, ok: false, wb: NaN, tf: NaN, tr: NaN };
  }
  const lf = vec3FromObj(spindles[0]?.pos);
  const rf = vec3FromObj(spindles[1]?.pos);
  const lr = vec3FromObj(spindles[2]?.pos);
  const rr = vec3FromObj(spindles[3]?.pos);
  const finite = [lf, rf, lr, rr].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
  if (!finite) return { seen: true, initialized: false, finite: false, ok: false, wb: NaN, tf: NaN, tr: NaN };
  const maxAbs = Math.max(
    Math.abs(lf.x), Math.abs(lf.y), Math.abs(lf.z),
    Math.abs(rf.x), Math.abs(rf.y), Math.abs(rf.z),
    Math.abs(lr.x), Math.abs(lr.y), Math.abs(lr.z),
    Math.abs(rr.x), Math.abs(rr.y), Math.abs(rr.z),
  );
  // Chrono can briefly return all-zero spindle poses just after spawn/reset.
  // Treat that as "not initialized yet", not invalid geometry.
  if (maxAbs < 1e-5) return { seen: true, initialized: false, finite: true, ok: false, wb: NaN, tf: NaN, tr: NaN };
  const front = lf.clone().add(rf).multiplyScalar(0.5);
  const rear = lr.clone().add(rr).multiplyScalar(0.5);
  const wb = front.clone().sub(rear).setY(0).length();
  const tf = lf.clone().sub(rf).setY(0).length();
  const tr = lr.clone().sub(rr).setY(0).length();
  const ok = isSpindleGeometryInRange(wb, tf, tr);
  return { seen: true, initialized: true, finite: true, ok, wb, tf, tr };
}

function sampleSpindleFrame(spindles) {
  if (!Array.isArray(spindles) || spindles.length < 4) return null;
  const lf = vec3FromObj(spindles[0]?.pos);
  const rf = vec3FromObj(spindles[1]?.pos);
  const lr = vec3FromObj(spindles[2]?.pos);
  const rr = vec3FromObj(spindles[3]?.pos);
  const finite = [lf, rf, lr, rr].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
  if (!finite) return null;
  const front = lf.clone().add(rf).multiplyScalar(0.5);
  const rear = lr.clone().add(rr).multiplyScalar(0.5);
  return {
    wb: front.clone().sub(rear).setY(0).length(),
    tf: lf.clone().sub(rf).setY(0).length(),
    tr: lr.clone().sub(rr).setY(0).length(),
    lf, rf, lr, rr,
  };
}

function sampleMeshSpindleFrameMismatch(wheelSkin, spindles) {
  const out = {
    available: false,
    count: 0,
    maxPosErr: NaN,
    rmsPosErr: NaN,
    byId: { lf: NaN, rf: NaN, lr: NaN, rr: NaN },
  };
  if (!wheelSkin?.corners || !Array.isArray(spindles) || spindles.length < 4) return out;
  const idToIdx = { lf: 0, rf: 1, lr: 2, rr: 3 };
  let n = 0;
  let sum2 = 0;
  let maxErr = 0;
  const wp = new THREE.Vector3();
  for (const id of ['lf', 'rf', 'lr', 'rr']) {
    const rec = wheelSkin.corners?.[id];
    const node = rec?.node;
    const idx = idToIdx[id];
    const sp = vec3FromObj(spindles?.[idx]?.pos);
    if (!node || !Number.isFinite(sp.x) || !Number.isFinite(sp.y) || !Number.isFinite(sp.z)) continue;
    try {
      node.updateMatrixWorld(true);
      node.getWorldPosition(wp);
    } catch { continue; }
    if (!Number.isFinite(wp.x) || !Number.isFinite(wp.y) || !Number.isFinite(wp.z)) continue;
    const e = wp.distanceTo(sp);
    if (!Number.isFinite(e)) continue;
    out.byId[id] = e;
    n++;
    sum2 += e * e;
    if (e > maxErr) maxErr = e;
  }
  if (n <= 0) return out;
  out.available = true;
  out.count = n;
  out.maxPosErr = maxErr;
  out.rmsPosErr = Math.sqrt(sum2 / n);
  return out;
}

function formatGeomTraceSummary(trace) {
  if (!trace || !Array.isArray(trace.frames) || trace.frames.length === 0) return 'geom trace: (empty)';
  const lastN = trace.frames.slice(-8);
  const firstBad = trace.firstBad;
  const head = (
    `geom trace: n=${trace.frames.length} badFrames=${trace.badCount} ` +
    `firstBad=${firstBad ? `#${firstBad.frame}@${fmt(firstBad.t, 2)}s wb=${fmt(firstBad.wb, 3)} tf=${fmt(firstBad.tf, 3)} tr=${fmt(firstBad.tr, 3)}` : 'none'}`
  );
  const rows = lastN.map((r) => (
    `#${r.frame}@${fmt(r.t, 2)}s wb=${fmt(r.wb, 3)} tf=${fmt(r.tf, 3)} tr=${fmt(r.tr, 3)} api=${r.apiOk ? 'ok' : 'bad'} raw=${r.rawOk ? 'ok' : 'bad'} rawBad=${Number(r.rawBadFrames) || 0} reorder=${r.reorder ? 'yes' : 'no'}`
  ));
  return `${head}\n${rows.join('\n')}`;
}

function spindleReasonLabel(v) {
  const r = Number(v);
  if (!Number.isFinite(r)) return 'n/a';
  switch (Math.trunc(r)) {
    case 0: return 'unset';
    case 1: return 'ok_direct';
    case 2: return 'ok_cache_missing_wheel';
    case 3: return 'ok_cache_sane_fail';
    case 4: return 'fail_no_cache';
    case 5: return 'ok_cache_exception';
    case 6: return 'fail_exception';
    case 7: return 'ok_fallback_only';
    case 8: return 'ok_mixed';
    case 11: return 'fail_axles_lt2';
    default: return `code_${Math.trunc(r)}`;
  }
}

function spindleFailStageLabel(v) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 'none';
  if (n === 1) return 'direct_invalid';
  if (n === 2) return 'fallback_invalid';
  return `stage_${n}`;
}

function wheelIdxLabel(v) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < 0) return 'none';
  return ['FL', 'FR', 'RL', 'RR'][n] || `wheel_${n}`;
}

function wheelMaskLabel(v) {
  const m = Math.trunc(Number(v)) & 0x0f;
  const names = ['FL', 'FR', 'RL', 'RR'];
  const on = names.filter((_, i) => (m & (1 << i)) !== 0);
  return `${m}(${on.join(',') || '-'})`;
}

function spindleHealStageLabel(v) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 'none';
  if (n === 1) return 'pre_step';
  if (n === 2) return 'post_step';
  return `stage_${n}`;
}

function getMeshWheelCenterLocal(meta) {
  const keys = ['wheel_lf', 'wheel_rf', 'wheel_lr', 'wheel_rr'];
  const out = new THREE.Vector3();
  let n = 0;
  for (const k of keys) {
    const a = meta?.anchors?.[k]?.pos;
    if (!Array.isArray(a) || a.length < 3) continue;
    const x = Number(a[0]);
    const y = Number(a[1]);
    const z = Number(a[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    out.add(new THREE.Vector3(x, y, z));
    n++;
  }
  if (n < 4) return null;
  return out.multiplyScalar(1 / n);
}

function wheelCornerFromName(name) {
  const raw = safeTrim(name).toLowerCase();
  if (!raw) return '';
  const nm = raw.replace(/[^a-z0-9]+/g, '_');
  if (!/(?:^|_)(wheel|tire|tyre|rim)(?:_|$)/.test(nm)) return '';
  if (/(?:^|_)(caliper|susp|shock|spring|knuckle|wishbone|control_arm|steer|chassis|body)(?:_|$)/.test(nm)) return '';
  const aliasById = {
    lf: ['lf', 'fl', 'front_left', 'left_front'],
    rf: ['rf', 'fr', 'front_right', 'right_front'],
    lr: ['lr', 'rl', 'rear_left', 'left_rear', 'back_left', 'left_back'],
    rr: ['rr', 'rear_right', 'right_rear', 'back_right', 'right_back'],
  };
  for (const [id, aliases] of Object.entries(aliasById)) {
    for (const a of aliases) {
      const rx = new RegExp(`(?:^|_)${a}(?:_|$)`);
      if (rx.test(nm)) return id;
    }
  }
  return '';
}

function isWheelAccessoryName(name) {
  const nm = safeTrim(name).toLowerCase().replace(/[^a-z0-9]+/g, '_');
  if (!nm) return false;
  if (!/(?:^|_)(lug|nut|bolt|stud|hubcap|center_cap|wheel_cap|cap)(?:_|$)/.test(nm)) return false;
  if (/(?:^|_)(caliper|susp|shock|spring|knuckle|wishbone|control_arm|steer|chassis|body|door|bumper)(?:_|$)/.test(nm)) return false;
  return true;
}

function nodeDepth(node, root) {
  let d = 0;
  let p = node;
  while (p && p !== root) {
    d++;
    p = p.parent;
  }
  return d;
}

function isAncestorNode(ancestor, node) {
  let p = node;
  while (p) {
    if (p === ancestor) return true;
    p = p.parent;
  }
  return false;
}

function detectWheelRollAxisLocal(node, steerAxisLocal, fallbackAxisLocal) {
  const fallback = (fallbackAxisLocal?.clone?.() || new THREE.Vector3(1, 0, 0)).normalize();
  const steer = (steerAxisLocal?.clone?.() || new THREE.Vector3(0, 1, 0)).normalize();
  if (!node?.traverse) return fallback;
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  const invNode = new THREE.Matrix4();
  const toNode = new THREE.Matrix4();
  const hasFiniteBox = (b) => (
    Number.isFinite(b?.min?.x) && Number.isFinite(b?.min?.y) && Number.isFinite(b?.min?.z)
    && Number.isFinite(b?.max?.x) && Number.isFinite(b?.max?.y) && Number.isFinite(b?.max?.z)
  );
  try { node.updateMatrixWorld(true); } catch { /* ignore */ }
  try { invNode.copy(node.matrixWorld).invert(); } catch { return fallback; }
  let seen = false;
  try {
    node.traverse((c) => {
      if (!c || (!c.isMesh && !c.isSkinnedMesh) || !c.geometry) return;
      const g = c.geometry;
      try { if (!g.boundingBox) g.computeBoundingBox(); } catch { /* ignore */ }
      if (!g.boundingBox || !hasFiniteBox(g.boundingBox)) return;
      try {
        toNode.copy(invNode).multiply(c.matrixWorld);
        tmp.copy(g.boundingBox).applyMatrix4(toNode);
        if (!hasFiniteBox(tmp)) return;
        if (!seen) {
          box.copy(tmp);
          seen = true;
        } else {
          box.union(tmp);
        }
      } catch { /* ignore */ }
    });
  } catch { /* ignore */ }
  if (!seen || !hasFiniteBox(box)) return fallback;
  const ext = box.getSize(new THREE.Vector3());
  const dims = [
    { axis: new THREE.Vector3(1, 0, 0), extent: Number(ext.x) || 0 },
    { axis: new THREE.Vector3(0, 1, 0), extent: Number(ext.y) || 0 },
    { axis: new THREE.Vector3(0, 0, 1), extent: Number(ext.z) || 0 },
  ].sort((a, b) => a.extent - b.extent);
  const align = (axis) => {
    const d = axis.dot(fallback);
    return d < 0 ? axis.clone().multiplyScalar(-1) : axis.clone();
  };
  for (const c of dims) {
    const ax = align(c.axis).normalize();
    if (Math.abs(ax.dot(steer)) < 0.7) return ax;
  }
  return align(dims[0].axis).normalize();
}

function estimateNodeCenterWorld(node, fallbackWorld = null) {
  const out = (fallbackWorld?.clone?.() || new THREE.Vector3());
  if (!node) return out;
  const box = new THREE.Box3();
  try {
    node.updateMatrixWorld(true);
    box.setFromObject(node);
    if (Number.isFinite(box.min.x) && Number.isFinite(box.min.y) && Number.isFinite(box.min.z)
      && Number.isFinite(box.max.x) && Number.isFinite(box.max.y) && Number.isFinite(box.max.z)
    ) {
      return box.getCenter(new THREE.Vector3());
    }
  } catch { /* ignore */ }
  try { node.getWorldPosition(out); } catch { /* ignore */ }
  return out;
}

function createWheelHubPivot(node, hubWorld) {
  if (!node || !node.parent || !hubWorld) return null;
  const parent = node.parent;
  const nodeWorldQuat = new THREE.Quaternion();
  const parentWorldQuat = new THREE.Quaternion();
  const hubLocal = new THREE.Vector3();
  try {
    node.updateMatrixWorld(true);
    parent.updateMatrixWorld(true);
    node.getWorldQuaternion(nodeWorldQuat);
    parent.getWorldQuaternion(parentWorldQuat);
    hubLocal.copy(parent.worldToLocal(hubWorld.clone()));
  } catch {
    return null;
  }
  const pivot = new THREE.Object3D();
  pivot.name = `${safeTrim(node.name) || 'wheel'}__hub_pivot`;
  pivot.position.copy(hubLocal);
  pivot.quaternion.copy(parentWorldQuat.clone().invert().multiply(nodeWorldQuat));
  parent.add(pivot);
  try {
    pivot.updateMatrix();
    pivot.updateMatrixWorld(true);
    pivot.attach(node);
    node.updateMatrix();
    node.updateMatrixWorld(true);
  } catch { /* ignore */ }
  return pivot;
}

function detectWheelSkinNodes(carRoot, meta) {
  const empty = { count: 0, corners: {}, rollById: { lf: 0, rf: 0, lr: 0, rr: 0 }, lastDirSign: 1, radiusM: 0.34 };
  if (!carRoot?.traverse) return empty;

  const byId = { lf: [], rf: [], lr: [], rr: [] };
  carRoot.traverse((n) => {
    if (!n || !safeTrim(n?.name)) return;
    const id = wheelCornerFromName(n.name);
    if (id && byId[id]) byId[id].push(n);
  });

  const anchorWorld = { lf: null, rf: null, lr: null, rr: null };
  try {
    for (const [k, id] of [['wheel_lf', 'lf'], ['wheel_rf', 'rf'], ['wheel_lr', 'lr'], ['wheel_rr', 'rr']]) {
      const local = getAnchorPosVec3(meta, k, null);
      if (local) anchorWorld[id] = carRoot.localToWorld(local.clone());
    }
  } catch { /* ignore */ }

  const normName = (n) => safeTrim(n?.name).toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const hasRenderableDescendant = (node) => {
    try {
      if (!node?.traverse) return false;
      let ok = false;
      node.traverse((c) => {
        if (ok || c === node) return;
        if (c?.isMesh || c?.isSkinnedMesh) ok = true;
      });
      return ok;
    } catch {
      return false;
    }
  };
  const nodePriority = (n) => {
    const nm = normName(n);
    const hasOwnGeom = !!(n?.isMesh || n?.isSkinnedMesh);
    const hasChildGeom = hasRenderableDescendant(n);
    const tireLike = /(?:^|_)(tire|tyre|rim)(?:_|$)/.test(nm) ? 5 : 0;
    const wheelLike = /(?:^|_)wheel(?:_|$)/.test(nm) ? 2 : 0;
    const accessoryPenalty = isWheelAccessoryName(nm) ? -8 : 0;
    const hubPenalty = /(?:^|_)hub(?:_|$)/.test(nm) ? -2 : 0;
    // Higher is better: prefer actual wheel/rim/tire geometry over accessory pieces.
    return (
      (hasOwnGeom ? 6 : 0)
      + (hasChildGeom ? 3 : 0)
      + tireLike
      + wheelLike
      + accessoryPenalty
      + hubPenalty
    );
  };

  const pickNode = (id) => {
    const list = byId[id] || [];
    if (!list.length) return null;
    const aw = anchorWorld[id];
    if (aw) {
      let best = null;
      let bestD2 = Infinity;
      let bestPri = -Infinity;
      let bestDepth = -Infinity;
      const p = new THREE.Vector3();
      for (const n of list) {
        try {
          n.getWorldPosition(p);
          const d2 = p.distanceToSquared(aw);
          if (d2 > (1.25 * 1.25)) continue;
          const pri = nodePriority(n);
          const dep = nodeDepth(n, carRoot);
          if (
            (d2 < bestD2)
            || (Math.abs(d2 - bestD2) <= 1e-8 && pri > bestPri)
            || (Math.abs(d2 - bestD2) <= 1e-8 && pri === bestPri && dep > bestDepth)
          ) {
            bestPri = pri;
            bestD2 = d2;
            bestDepth = dep;
            best = n;
          }
        } catch { /* ignore */ }
      }
      if (best) return best;
    }
    return list.slice().sort((a, b) => {
      const pa = nodePriority(a);
      const pb = nodePriority(b);
      if (pa !== pb) return pb - pa;
      return nodeDepth(b, carRoot) - nodeDepth(a, carRoot);
    })[0] || null;
  };

  const corners = {};
  let count = 0;
  try { carRoot.updateMatrixWorld(true); } catch { /* ignore */ }
  const carWorldQuat = new THREE.Quaternion();
  try { carRoot.getWorldQuaternion(carWorldQuat); } catch { carWorldQuat.identity(); }
  const worldUp = new THREE.Vector3(0, 1, 0);
  const worldRight = new THREE.Vector3(1, 0, 0).applyQuaternion(carWorldQuat).normalize();
  const qWorldInv = new THREE.Quaternion();
  for (const id of ['lf', 'rf', 'lr', 'rr']) {
    const sourceNode = pickNode(id);
    let node = sourceNode;
    if (!node) continue;
    try {
      const anchor = anchorWorld[id];
      const hubWorld = anchor || estimateNodeCenterWorld(node, null);
      const pivot = createWheelHubPivot(node, hubWorld);
      if (pivot) node = pivot;
    } catch { /* ignore */ }
    try {
      node.matrixAutoUpdate = true;
      node.matrixWorldAutoUpdate = true;
      node.updateMatrix();
      node.updateMatrixWorld(true);
    } catch { /* ignore */ }
    let steerAxisLocal = new THREE.Vector3(0, 1, 0);
    let rollAxisLocal = new THREE.Vector3(1, 0, 0);
    try {
      const qWorld = new THREE.Quaternion();
      node.getWorldQuaternion(qWorld);
      qWorldInv.copy(qWorld).invert();
      steerAxisLocal = worldUp.clone().applyQuaternion(qWorldInv).normalize();
      const fallbackRollAxis = worldRight.clone().applyQuaternion(qWorldInv).normalize();
      rollAxisLocal = detectWheelRollAxisLocal(node, steerAxisLocal, fallbackRollAxis);
    } catch { /* ignore */ }
    const followers = [];
    const peers = [];
    try {
      const center = new THREE.Vector3();
      node.getWorldPosition(center);
      const tmp = new THREE.Vector3();
      carRoot.traverse((cand) => {
        if (!cand || cand === node || cand.parent === node) return;
        if (!safeTrim(cand?.name)) return;
        if (!isWheelAccessoryName(cand.name)) return;
        if (wheelCornerFromName(cand.name) !== id) return;
        if (cand === carRoot || cand === node.parent) return;
        try {
          cand.getWorldPosition(tmp);
          if (tmp.distanceTo(center) > 0.75) return;
          node.attach(cand);
          try {
            cand.matrixAutoUpdate = true;
            cand.matrixWorldAutoUpdate = true;
            cand.updateMatrix();
            cand.updateMatrixWorld(true);
          } catch { /* ignore */ }
          followers.push({ node: cand, baseQuat: cand.quaternion.clone(), name: safeTrim(cand.name) });
        } catch { /* ignore */ }
      });
      const peerList = (byId[id] || []).slice();
      for (const cand of peerList) {
        if (!cand || cand === node) continue;
        if (isAncestorNode(node, cand) || isAncestorNode(cand, node)) continue;
        try {
          cand.getWorldPosition(tmp);
          if (tmp.distanceTo(center) > 1.10) continue;
          try { node.attach(cand); } catch { /* ignore */ }
          cand.matrixAutoUpdate = true;
          cand.matrixWorldAutoUpdate = true;
          cand.updateMatrix();
          cand.updateMatrixWorld(true);
          const qWorld = new THREE.Quaternion();
          cand.getWorldQuaternion(qWorld);
          qWorldInv.copy(qWorld).invert();
          const peerSteerAxis = worldUp.clone().applyQuaternion(qWorldInv).normalize();
          const peerFallbackRollAxis = worldRight.clone().applyQuaternion(qWorldInv).normalize();
          const peerRollAxis = detectWheelRollAxisLocal(cand, peerSteerAxis, peerFallbackRollAxis);
          peers.push({
            node: cand,
            baseQuat: cand.quaternion.clone(),
            steerAxisLocal: peerSteerAxis,
            rollAxisLocal: peerRollAxis,
            name: safeTrim(cand.name),
          });
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    corners[id] = {
      node,
      baseQuat: node.quaternion.clone(),
      steerAxisLocal,
      rollAxisLocal,
      followers,
      peers,
      name: safeTrim(node.name),
    };
    count++;
  }
  return { ...empty, corners, count };
}

function computeRollAxesFromSpindles(wheelSkin, spindles) {
  if (!wheelSkin || (Number(wheelSkin.count) || 0) <= 0) return null;
  if (!Array.isArray(spindles) || spindles.length < 4) return null;
  const worldPos = (idx) => {
    const p = spindles?.[idx]?.pos;
    const x = Number(p?.x);
    const y = Number(p?.y);
    const z = Number(p?.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return new THREE.Vector3(x, y, z);
  };
  const lf = worldPos(0);
  const rf = worldPos(1);
  const lr = worldPos(2);
  const rr = worldPos(3);
  const frontAxisW = (lf && rf) ? rf.clone().sub(lf) : null;
  const rearAxisW = (lr && rr) ? rr.clone().sub(lr) : null;
  if (frontAxisW && frontAxisW.lengthSq() > 1e-8) frontAxisW.normalize();
  if (rearAxisW && rearAxisW.lengthSq() > 1e-8) rearAxisW.normalize();
  const axisByIdW = {
    lf: frontAxisW,
    rf: frontAxisW,
    lr: rearAxisW,
    rr: rearAxisW,
  };
  const out = {};
  for (const id of ['lf', 'rf', 'lr', 'rr']) {
    const axisW = axisByIdW[id];
    if (!axisW || axisW.lengthSq() <= 1e-8) continue;
    out[id] = axisW.clone();
  }
  return Object.keys(out).length ? out : null;
}

function applyWheelSkinAnimation(wheelSkin, wheelState, steerCmd, signedSpeed, dtSec, spindles) {
  if (!wheelSkin || (Number(wheelSkin.count) || 0) <= 0) return;
  const dt = Number(dtSec) || 0;
  if (!(dt > 0)) return;
  const steerVisualPriority = Math.abs(Number(steerCmd) || 0) > 0.35;

  const steerById = {
    lf: Number.isFinite(Number(wheelState?.steerFL)) ? Number(wheelState?.steerFL) : 0,
    rf: Number.isFinite(Number(wheelState?.steerFR)) ? Number(wheelState?.steerFR) : 0,
    lr: 0,
    rr: 0,
  };
  const omegaById = {
    lf: Number(wheelState?.omegaFL),
    rf: Number(wheelState?.omegaFR),
    lr: Number(wheelState?.omegaRL),
    rr: Number(wheelState?.omegaRR),
  };
  const haveOmega = Object.values(omegaById).some((v) => Number.isFinite(v) && Math.abs(v) > 1e-4);

  let dirSign = Number(wheelSkin.lastDirSign) || 1;
  const vSigned = Number(signedSpeed) || 0;
  if (Math.abs(vSigned) > 0.35) dirSign = Math.sign(vSigned) || dirSign;
  wheelSkin.lastDirSign = dirSign;

  if (!steerVisualPriority && haveOmega) {
    for (const id of ['lf', 'rf', 'lr', 'rr']) {
      const om = Number(omegaById[id]);
      const prev = Number(wheelSkin.rollById?.[id]) || 0;
      const da = Number.isFinite(om) ? (dirSign * Math.abs(om) * dt) : 0;
      let a = prev + da;
      if (!Number.isFinite(a)) a = 0;
      wheelSkin.rollById[id] = Math.atan2(Math.sin(a), Math.cos(a));
    }
  } else if (!steerVisualPriority && !STRICT_DEBUG_NATIVE_ONLY) {
    const r = Math.max(0.08, Number(wheelSkin.radiusM) || 0.34);
    const da = (vSigned * dt) / r;
    for (const id of ['lf', 'rf', 'lr', 'rr']) {
      const prev = Number(wheelSkin.rollById?.[id]) || 0;
      let a = prev + da;
      if (!Number.isFinite(a)) a = 0;
      wheelSkin.rollById[id] = Math.atan2(Math.sin(a), Math.cos(a));
    }
  }

  // Keep a stable local roll axis per wheel. Dynamic spindle-derived axis updates can
  // introduce frame-to-frame sign flips that break steering visual continuity checks.
  const dynamicRollAxes = null;
  const qSteer = new THREE.Quaternion();
  const qRoll = new THREE.Quaternion();
  const spindleWorldById = (() => {
    if (!Array.isArray(spindles) || spindles.length < 4) return null;
    const mk = (idx) => {
      const p = spindles?.[idx]?.pos;
      const x = Number(p?.x);
      const y = Number(p?.y);
      const z = Number(p?.z);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
      return new THREE.Vector3(x, y, z);
    };
    return {
      lf: mk(0),
      rf: mk(1),
      lr: mk(2),
      rr: mk(3),
    };
  })();
  for (const id of ['lf', 'rf', 'lr', 'rr']) {
    const rec = wheelSkin.corners?.[id];
    const node = rec?.node;
    if (!node || !rec?.baseQuat) continue;
    try {
      // Keep visual wheel hubs glued to live spindle centers.
      const w = spindleWorldById?.[id];
      if (w && node.parent) {
        const lp = node.parent.worldToLocal(w.clone());
        if (Number.isFinite(lp.x) && Number.isFinite(lp.y) && Number.isFinite(lp.z)) {
          node.position.copy(lp);
          node.updateMatrix();
          node.updateMatrixWorld(true);
        }
      }
    } catch { /* ignore */ }
    const steer = (id === 'lf' || id === 'rf') ? (Number(steerById[id]) || 0) : 0;
    const roll = Number(wheelSkin.rollById?.[id]) || 0;
    const applyNode = (targetNode, baseQuat, steerAxisLocal, baseRollAxisLocal) => {
      if (!targetNode || !baseQuat) return;
      const steerAxis = (steerAxisLocal?.clone?.() || new THREE.Vector3(0, 1, 0)).normalize();
      const baseRollAxis = (baseRollAxisLocal?.clone?.() || new THREE.Vector3(1, 0, 0)).normalize();
      let rollAxis = baseRollAxis;
      try {
        const st = steerAxis.clone().normalize();
        const axisDegenerate = Math.abs(st.dot(baseRollAxis)) > 0.86;
        const axisW = dynamicRollAxes?.[id];
        if (axisDegenerate && axisW && axisW.lengthSq() > 1e-8) {
          const qWorld = new THREE.Quaternion();
          targetNode.getWorldQuaternion(qWorld);
          const qInv = qWorld.clone().invert();
          const axisLocalFromSpindle = axisW.clone().applyQuaternion(qInv).normalize();
          if (axisLocalFromSpindle.lengthSq() > 1e-8 && Math.abs(axisLocalFromSpindle.dot(st)) <= 0.92) {
            if (axisLocalFromSpindle.dot(baseRollAxis) < 0) axisLocalFromSpindle.multiplyScalar(-1);
            rollAxis = axisLocalFromSpindle;
          }
        }
      } catch { /* ignore */ }
      qSteer.setFromAxisAngle(steerAxis, steer);
      qRoll.setFromAxisAngle(rollAxis, roll);
      targetNode.quaternion.copy(baseQuat).multiply(qSteer).multiply(qRoll);
    };
    applyNode(node, rec.baseQuat, rec?.steerAxisLocal, rec?.rollAxisLocal);
    const followers = Array.isArray(rec.followers) ? rec.followers : [];
    for (const f of followers) {
      if (!f?.node || !f?.baseQuat) continue;
      if (f.node.parent === node) continue;
      applyNode(f.node, f.baseQuat, rec?.steerAxisLocal, rec?.rollAxisLocal);
    }
    const peers = Array.isArray(rec.peers) ? rec.peers : [];
    for (const p of peers) {
      if (!p?.node || !p?.baseQuat) continue;
      if (p.node.parent === node) continue;
      applyNode(p.node, p.baseQuat, p?.steerAxisLocal, p?.rollAxisLocal);
    }
  }
}

function captureWheelVisualState(wheelSkin) {
  const out = { available: false, count: 0, corners: {} };
  if (!wheelSkin || (Number(wheelSkin.count) || 0) <= 0) return out;
  out.available = true;
  out.count = Number(wheelSkin.count) || 0;
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  for (const id of ['lf', 'rf', 'lr', 'rr']) {
    const rec = wheelSkin.corners?.[id];
    const node = rec?.node;
    if (!node) continue;
    try {
      node.updateMatrixWorld(true);
      node.getWorldPosition(p);
      node.getWorldQuaternion(q);
      out.corners[id] = {
        name: safeTrim(rec?.name),
        px: Number(p.x) || 0,
        py: Number(p.y) || 0,
        pz: Number(p.z) || 0,
        lpx: Number(node.position?.x) || 0,
        lpy: Number(node.position?.y) || 0,
        lpz: Number(node.position?.z) || 0,
        qx: Number(q.x) || 0,
        qy: Number(q.y) || 0,
        qz: Number(q.z) || 0,
        qw: Number(q.w) || 1,
        lqx: Number(node.quaternion?.x) || 0,
        lqy: Number(node.quaternion?.y) || 0,
        lqz: Number(node.quaternion?.z) || 0,
        lqw: Number(node.quaternion?.w) || 1,
      };
    } catch { /* ignore */ }
  }
  return out;
}

function isFiniteVec3Like(x, y, z) {
  return Number.isFinite(Number(x)) && Number.isFinite(Number(y)) && Number.isFinite(Number(z));
}

function isFiniteState(st) {
  if (!st || typeof st !== 'object') return false;
  return (
    isFiniteVec3Like(st.x, 0, st.z)
    && Number.isFinite(Number(st.yaw))
    && Number.isFinite(Number(st.vx))
    && Number.isFinite(Number(st.vz))
    && Number.isFinite(Number(st.speed))
    && Number.isFinite(Number(st.steerRad))
    && Number.isFinite(Number(st.yawRate))
  );
}

function computeSignedForwardSpeed(st) {
  // The WASM bridge currently reports `speed` via Chrono's GetSpeed(), which may be non-negative.
  // For input logic (reverse/brake decisions), we want signed speed along the vehicle forward axis.
  const yaw = Number(st?.yaw);
  const vx = Number(st?.vx);
  const vy = Number(st?.vy);
  const vz = Number(st?.vz);
  if (!Number.isFinite(vx) || !Number.isFinite(vz)) return 0;

  const vySafe = Number.isFinite(vy) ? vy : 0;

  let speedYaw = NaN;
  if (Number.isFinite(yaw)) {
    // When yaw=0 our vehicle forward is world -Z (Three.js default forward).
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    // forward = rotateY(yaw) * (0,0,-1) = (-sin(yaw), 0, -cos(yaw))
    // signed speed = v · forward
    speedYaw = (vx * (-s)) + (vz * (-c));
  }

  let speedQuat = NaN;
  const qx = Number(st?.qx);
  const qy = Number(st?.qy);
  const qz = Number(st?.qz);
  const qw = Number(st?.qw);
  if (Number.isFinite(qx) && Number.isFinite(qy) && Number.isFinite(qz) && Number.isFinite(qw)) {
    // Rotate local forward (0,0,-1) by quaternion (qx,qy,qz,qw) to world.
    // v' = v + 2*w*(q x v) + 2*(q x (q x v))
    const vx0 = 0;
    const vy0 = 0;
    const vz0 = -1;
    const cx1 = qy * vz0 - qz * vy0;
    const cy1 = qz * vx0 - qx * vz0;
    const cz1 = qx * vy0 - qy * vx0;
    const cx2 = qy * cz1 - qz * cy1;
    const cy2 = qz * cx1 - qx * cz1;
    const cz2 = qx * cy1 - qy * cx1;
    const fx = vx0 + 2 * (qw * cx1 + cx2);
    const fy = vy0 + 2 * (qw * cy1 + cy2);
    const fz = vz0 + 2 * (qw * cz1 + cz2);
    speedQuat = (vx * fx) + (vySafe * fy) + (vz * fz);
  }

  if (Number.isFinite(speedQuat) && Number.isFinite(speedYaw)) {
    // Prefer quaternion, but fall back if it is tiny or disagrees strongly with yaw.
    if (Math.abs(speedQuat) < 1e-4 && Math.abs(speedYaw) >= 1e-4) return speedYaw;
    if (Math.abs(speedYaw) < 1e-4 && Math.abs(speedQuat) >= 1e-4) return speedQuat;
    if (Math.sign(speedQuat) !== Math.sign(speedYaw)) {
      return (Math.abs(speedQuat) >= Math.abs(speedYaw)) ? speedQuat : speedYaw;
    }
    return speedQuat;
  }
  if (Number.isFinite(speedQuat)) return speedQuat;
  if (Number.isFinite(speedYaw)) return speedYaw;
  return 0;
}

function setupKeys() {
  const down = new Set();

  const onKey = (e, isDown) => {
    try {
      const code = String(e?.code || '');
      if (!code) return;
      if (isDown) down.add(code);
      else down.delete(code);
    } catch { /* ignore */ }
  };

  window.addEventListener('keydown', (e) => onKey(e, true), { passive: true });
  window.addEventListener('keyup', (e) => onKey(e, false), { passive: true });
  window.addEventListener('blur', () => { try { down.clear(); } catch { /* ignore */ } });

  return down;
}

async function main() {
  const canvas = /** @type {HTMLCanvasElement|null} */ (document.getElementById('glCanvas'));
  const hud = /** @type {HTMLDivElement|null} */ (document.getElementById('hud'));
  const debugPanel = /** @type {HTMLDivElement|null} */ (document.getElementById('debugPanel'));
  const statusText = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('statusText'));
  const copyBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('copyStatusBtn'));
  if (!canvas || !hud) throw new Error('missing DOM elements');

  let lastStatus = '';
  const setHud = (s) => {
    const txt = String(s || '');
    lastStatus = txt;
    try { hud.textContent = txt; } catch { /* ignore */ }
    try { if (statusText) statusText.value = txt; } catch { /* ignore */ }
  };

  const setDebugVisible = (on) => {
    if (!debugPanel) return;
    debugPanel.style.display = on ? 'flex' : 'none';
  };

  const tryCopyText = async (txt) => {
    const s = String(txt || '');
    if (!s.trim()) return false;

    // Best-case: async clipboard API (requires secure context).
    try {
      if (window.isSecureContext && navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(s);
        return true;
      }
    } catch { /* ignore */ }

    // Fallback: execCommand('copy') with a hidden textarea.
    // This works in many non-secure dev setups where Clipboard API is blocked.
    try {
      const ta = document.createElement('textarea');
      ta.value = s;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus({ preventScroll: true });
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = !!document.execCommand?.('copy');
      try { document.body.removeChild(ta); } catch { /* ignore */ }
      return ok;
    } catch { /* ignore */ }

    return false;
  };

  const copyStatus = async () => {
    const txt = String(lastStatus || '');
    if (!txt.trim()) return;
    const ok = await tryCopyText(txt);

    // If copy failed, select the debug textarea (manual Ctrl+C).
    if (!ok) {
      try { setDebugVisible(true); } catch { /* ignore */ }
      try {
        if (statusText) {
          statusText.focus({ preventScroll: true });
          statusText.select();
        }
      } catch { /* ignore */ }
    }

    // Give quick UI feedback if the button is visible.
    try {
      if (copyBtn) {
        const prev = copyBtn.textContent || 'Copy status';
        copyBtn.textContent = ok ? 'Copied' : 'Select + Ctrl+C';
        window.setTimeout(() => { try { copyBtn.textContent = prev; } catch { /* ignore */ } }, 900);
      }
    } catch { /* ignore */ }
  };

  try { if (copyBtn) copyBtn.addEventListener('click', () => { void copyStatus(); }); } catch { /* ignore */ }

  // ---- Three.js ----
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // If the sim explodes and triggers GPU resets, this helps with debuggability.
  try {
    canvas.addEventListener('webglcontextlost', (e) => {
      try { e?.preventDefault?.(); } catch { /* ignore */ }
      setHud(`WebGL context lost.\n\nThis can happen if the sim produces NaNs/Infs or the GPU/driver resets.\nReload the page after fixing the underlying issue.`);
      try { setDebugVisible(true); } catch { /* ignore */ }
    }, false);
    canvas.addEventListener('webglcontextrestored', () => {
      setHud('WebGL context restored. Reload recommended.');
    }, false);
  } catch { /* ignore */ }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07090d);

  const camera = new THREE.PerspectiveCamera(70, 1, 0.03, 2500);
  camera.position.set(0, 1.5, 2.8);

  const hemi = new THREE.HemisphereLight(0xdde8ff, 0x1a2230, 0.95);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.05);
  sun.position.set(7, 10, 5);
  scene.add(sun);

  const grid = new THREE.GridHelper(120, 120, 0x243044, 0x162033);
  grid.position.y = 0;
  scene.add(grid);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(500, 500, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x0b0f18, roughness: 1.0, metalness: 0.0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  ground.receiveShadow = false;
  scene.add(ground);

  const resize = () => {
    const w = Math.max(1, window.innerWidth || canvas.clientWidth || 1);
    const h = Math.max(1, window.innerHeight || canvas.clientHeight || 1);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize, { passive: true });
  resize();

  // ---- Load 350Z + meta ----
  setHud('Loading 350Z model + meta…');
  const [meta, gltf] = await Promise.all([
    fetchJson(CAR_META_URL),
    (new GLTFLoader()).loadAsync(CAR_URL),
  ]);

  const meshYawOffset = getMeshYawOffset(meta, SIM_DEBUG_CONFIG);
  const driverLocal = getAnchorPosVec3(meta, 'camera_driver', getAnchorPosVec3(meta, 'driver', new THREE.Vector3(-0.35, 1.15, -0.67)));

  const carGroup = new THREE.Group();
  carGroup.name = 'CarGroup';
  scene.add(carGroup);

  const carRoot = gltf?.scene || null;
  if (!carRoot) throw new Error('350Z GLB loaded but no scene root');
  carRoot.name = 'CarRoot';
  carGroup.add(carRoot);

  // Apply static skin calibration once (offset/yaw/scale). Chrono pose drives carGroup each frame.
  const carRootBaseQuat = carRoot.quaternion.clone();
  try {
    applySkinCalibration(carRoot, carRootBaseQuat, meshYawOffset, SIM_DEBUG_CONFIG);
  } catch { /* ignore */ }

  const metaAnchors = (meta?.anchors && typeof meta.anchors === 'object') ? meta.anchors : null;
  const metaAnchorKeys = metaAnchors ? Object.keys(metaAnchors) : [];
  const wheelSkin = detectWheelSkinNodes(carRoot, meta);

  // Diagnostics for mesh/sim alignment.
  const meshDiag = {
    groundOffsetY: 0,
    groundMethod: 'bbox',
    bboxSize: new THREE.Vector3(),
    bboxCenterLocal: new THREE.Vector3(),
    bboxMinLocal: new THREE.Vector3(),
    bboxMaxLocal: new THREE.Vector3(),
    autoAlignApplied: false,
    autoAlignDelta: new THREE.Vector3(),
  };

  try {
    // Diagnostics only. We do not apply dynamic grounding/alignment offsets to the skin.
    meshDiag.groundMethod = 'static_skin_calibration';
    meshDiag.groundOffsetY = Number(SIM_DEBUG_CONFIG?.visual?.meshLocalOffset?.y) || 0;

    // Cache bounds diagnostics after grounding.
    carRoot.updateMatrixWorld(true);
    const box1 = new THREE.Box3().setFromObject(carRoot);
    const centerW = box1.getCenter(new THREE.Vector3());
    meshDiag.bboxSize.copy(box1.getSize(new THREE.Vector3()));
    meshDiag.bboxCenterLocal.copy(carRoot.worldToLocal(centerW.clone()));
    meshDiag.bboxMinLocal.copy(carRoot.worldToLocal(box1.min.clone()));
    meshDiag.bboxMaxLocal.copy(carRoot.worldToLocal(box1.max.clone()));
  } catch { /* ignore */ }
  const meshWheelCenterLocal = getMeshWheelCenterLocal(meta);

  // Visual debug: axes at sim origin (carGroup) and mesh pivot (carRoot).
  let debugAxesOn = true;
  const debugViz = new THREE.Group();
  debugViz.name = 'DebugViz';
  const debugVizMesh = new THREE.Group();
  debugVizMesh.name = 'DebugVizMesh';
  try {
    const axesSim = new THREE.AxesHelper(0.85);
    axesSim.name = 'AxesSimOrigin';
    debugViz.add(axesSim);

    const axesMesh = new THREE.AxesHelper(0.55);
    axesMesh.name = 'AxesMeshPivot';
    debugVizMesh.add(axesMesh);

    const mkSphere = (r, color) => new THREE.Mesh(
      new THREE.SphereGeometry(r, 12, 8),
      new THREE.MeshBasicMaterial({ color }),
    );
    const simMarker = mkSphere(0.06, 0xff4d4d);
    simMarker.name = 'SimOriginMarker';
    debugViz.add(simMarker);

    const meshCenterMarker = mkSphere(0.05, 0x4dff9a);
    meshCenterMarker.name = 'MeshBoundsCenterLocalMarker';
    meshCenterMarker.position.copy(meshDiag.bboxCenterLocal);
    debugVizMesh.add(meshCenterMarker);
  } catch { /* ignore */ }
  carGroup.add(debugViz);
  carRoot.add(debugVizMesh);

  // Sim chassis debug visualization (simple wireframe box).
  const simChassisViz = {
    mesh: null,
  };
  try {
    // Unit box so runtime `scale` corresponds directly to world meters.
    const geom = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true });
    const box = new THREE.Mesh(geom, mat);
    box.name = 'SimChassisDebug';
    scene.add(box);
    simChassisViz.mesh = box;
  } catch { /* ignore */ }

  // Sim wheel markers (visualize Chrono spindle positions).
  const simWheelViz = {
    group: new THREE.Group(),
    wheels: /** @type {Record<string, THREE.Object3D>} */ ({}),
    axes: /** @type {Record<string, THREE.Object3D>} */ ({}),
    wheelAxisFix: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), SIM_DEBUG_CONFIG.visual.wheelAxisFixRad),
    lines: {
      front: null,
      rear: null,
    },
  };
  simWheelViz.group.name = 'SimWheelViz';
  try {
    const mkWheel = (color) => new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.22, 0.12, 18),
      new THREE.MeshBasicMaterial({ color, wireframe: true }),
    );
    const colors = { lf: 0xff6b6b, rf: 0x6bc6ff, lr: 0xffd56b, rr: 0x8bff6b };
    for (const id of ['lf', 'rf', 'lr', 'rr']) {
      const w = mkWheel(colors[id]);
      w.name = `SimWheel_${id}`;
      simWheelViz.wheels[id] = w;
      simWheelViz.group.add(w);
      const ax = new THREE.AxesHelper(0.25);
      ax.name = `SimWheelAxes_${id}`;
      simWheelViz.axes[id] = ax;
      simWheelViz.group.add(ax);
    }
    const mkLine = (color) => {
      const geom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const mat = new THREE.LineBasicMaterial({ color });
      return new THREE.Line(geom, mat);
    };
    simWheelViz.lines.front = mkLine(0xffffff);
    simWheelViz.lines.front.name = 'SimAxleFront';
    simWheelViz.group.add(simWheelViz.lines.front);
    simWheelViz.lines.rear = mkLine(0xffffff);
    simWheelViz.lines.rear.name = 'SimAxleRear';
    simWheelViz.group.add(simWheelViz.lines.rear);
  } catch { /* ignore */ }
  scene.add(simWheelViz.group);


  // ---- Chrono WASM ----
  setHud('Initializing Chrono WASM…');
  const sim = new ProjectChronoWasmVehicleSim();
  try {
    window.__chronoDebug = {
      sim,
      vehHandle: 0,
      lastState: null,
      lastSpindles: null,
      lastWheel: null,
      rawSpindles: null,
      wheelVisual: captureWheelVisualState(wheelSkin),
      apiCoverage: null,
    };
  } catch { /* ignore */ }
  const ok = await sim.init();
  if (!ok) {
    setHud(`Chrono init failed:\n${sim.initError || '(no details)'}\n\nMake sure /chrono/chrono_vehicle_module.wasm is being served.`);
    return;
  }
  const apiCoverage = getChronoTestApiCoverage(sim);
  try {
    if (window.__chronoDebug) window.__chronoDebug.apiCoverage = apiCoverage;
  } catch { /* ignore */ }

  // ---- Chrono world tuning (exercise world APIs) ----
  const worldTuning = {
    spawnWorldY: SIM_DEBUG_CONFIG.world.spawnWorldY,
    frictionMu: SIM_DEBUG_CONFIG.world.frictionMu,
    staticsOn: SIM_DEBUG_CONFIG.world.staticsOn,
  };

  // A few simple obstacles in WORLD coordinates, packed as [minx,miny,minz,maxx,maxy,maxz] * N.
  // Keep them conservative (no razor-thin geometry) to avoid solver nastiness.
  const staticAabbs = new Float32Array([
    // A low "speed bump" ahead of spawn.
    -1.5, 0.0, -18.0,   1.5, 0.35, -16.0,
    // A small block to side-swipe.
    3.5, 0.0, -26.0,    5.0, 0.9,  -24.5,
    // A wider block further out.
    -6.0, 0.0, -40.0,   -2.0, 1.2, -36.0,
  ]);

  const applyWorldTuning = () => {
    try { sim.setSpawnWorldY?.(worldTuning.spawnWorldY); } catch { /* ignore */ }
    try { sim.setWorldFriction?.(worldTuning.frictionMu); } catch { /* ignore */ }
    try {
      sim.setStaticAabbsWorld?.(worldTuning.staticsOn ? staticAabbs : new Float32Array());
    } catch { /* ignore */ }
  };

  applyWorldTuning();

  // Verify Chrono vehicle data is present in the WASM FS (if preloaded).
  const mod = /** @type {any} */ (sim)._mod || null;
  const FS = mod?.FS || null;
  const fsCanAnalyze = !!FS?.analyzePath;
  const fsRt = {
    createPath: typeof mod?.FS_createPath === 'function',
    createDataFile: typeof mod?.FS_createDataFile === 'function',
    unlink: typeof mod?.FS_unlink === 'function',
  };
  const fsExists = (p) => {
    try { return !!FS?.analyzePath?.(String(p || ''))?.exists; } catch { return false; }
  };
  const fsHas = {
    fs: !!FS || (typeof mod?.FS_createDataFile === 'function'),
  };
  const chronoManifestUrl = safeTrim(meta?.chronoManifestUrl);
  let chronoSpec = null;
  try {
    chronoSpec = await loadChronoVehicleSpecIntoFs(sim, chronoManifestUrl);
  } catch {
    chronoSpec = null;
  }
  const exportedTransmissionMode = getTransmissionControlMode(chronoSpec, null);

  const readDataStatus = () => {
    const expected = Number(mod?.expectedDataFileDownloads) || 0;
    const finished = Number(mod?.finishedDataFileDownloads) || 0;
    const pre = (mod?.preloadResults && typeof mod.preloadResults === 'object') ? mod.preloadResults : null;
    const preloadKeys = pre ? Object.keys(pre) : [];
    const dld = (mod?.dataFileDownloads && typeof mod.dataFileDownloads === 'object') ? mod.dataFileDownloads : null;
    let dlLoaded = 0;
    let dlTotal = 0;
    let dlN = 0;
    if (dld) {
      for (const v of Object.values(dld)) {
        const loaded = Number(v?.loaded) || 0;
        const total = Number(v?.total) || 0;
        if (total > 0) { dlLoaded += loaded; dlTotal += total; dlN++; }
      }
    }
    return { expected, finished, preloadKeys, dlN, dlLoaded, dlTotal };
  };
  const isDataReady = (st) => (
    (st.expected === 0)
    || (st.finished >= st.expected)
    || (st.dlTotal > 0 && st.dlLoaded >= st.dlTotal)
    || (st.preloadKeys.length > 0)
  );
  const dataDl = readDataStatus();

  const waitForDataReady = async (timeoutSec = 3.0) => {
    if (isDataReady(readDataStatus())) return true;
    const start = nowSec();
    while ((nowSec() - start) < timeoutSec) {
      await new Promise((r) => setTimeout(r, 50));
      if (isDataReady(readDataStatus())) return true;
    }
    return false;
  };

  const validateHandle = (h) => {
    const handle = Number(h) || 0;
    if (!handle) return { ok: false, handle, state: null, spindleSeen: false, spindleOk: false };
    // Warm-up a few tiny steps with neutral controls; avoid applying power during settle.
    try {
      try { sim.enableBrakeLocking?.(handle, false); } catch { /* ignore */ }
      try { sim.setParkingBrake?.(handle, false); } catch { /* ignore */ }
      if (exportedTransmissionMode === 'manual') setManualGearIndex(sim, handle, 0);
      else setDriveMode(sim, handle, 0);
      try {
        const useEx = (exportedTransmissionMode === 'manual') || (!!SIM_DEBUG_CONFIG?.sim?.preferControlsEx && (typeof sim.setControlsEx === 'function'));
        if (useEx) sim.setControlsEx(handle, 0, 0, 0, exportedTransmissionMode === 'manual' ? 1 : 0);
        else sim.setControls?.(handle, 0, 0, 0);
      } catch { /* ignore */ }
      // Give the chassis/suspension time to settle before evaluating readback health.
      for (let i = 0; i < 60; i++) sim.step(1 / 120);
      try {
        const useEx = (exportedTransmissionMode === 'manual') || (!!SIM_DEBUG_CONFIG?.sim?.preferControlsEx && (typeof sim.setControlsEx === 'function'));
        if (useEx) sim.setControlsEx(handle, 0, 0, 0, exportedTransmissionMode === 'manual' ? 1 : 0);
        else sim.setControls?.(handle, 0, 0, 0);
      } catch { /* ignore */ }
    } catch { /* ignore */ }
    let st = null;
    try { st = sim.getState(handle); } catch { st = null; }
    let spindleOk = false;
    let spindleSeen = false;
    try {
      const sp = sim.getSpindles4?.(handle);
      const sd = analyzeSpindleGeometry(sp);
      spindleSeen = sd.seen;
      spindleOk = sd.ok;
    } catch { /* ignore */ }
    return { ok: isFiniteState(st) && spindleSeen && spindleOk, handle, state: st, spindleSeen, spindleOk };
  };

  const spawnVehicle = () => {
    const attempts = [];

    // Preferred: use exported 350z Chrono JSONs from the model meta manifest.
    if (chronoSpec?.jsonPath) {
      try {
        const spawnParams = {
          jsonPath: chronoSpec.jsonPath,
          tireJsonPath: chronoSpec.tireJsonPath,
          x: 0,
          z: 0,
          yaw: 0,
        };
        const h0 = Number(sim.createVehicleJson?.(spawnParams)) || 0;
        const v = validateHandle(h0);
        attempts.push({
          kind: 'json_350z_manifest_ex',
          jsonPath: chronoSpec.jsonPath,
          tireJsonPath: chronoSpec.tireJsonPath,
          handle: h0,
          ok: v.ok,
          reason: v.ok ? '' : (!isFiniteState(v.state) ? 'state_invalid' : (v.spindleSeen ? 'spindle_invalid' : 'spindle_missing')),
        });
        if (h0 > 0 && v.ok) {
          return { handle: h0, kind: 'json_350z_manifest_ex', jsonPath: chronoSpec.jsonPath, attempts };
        }
        // Keep a finite-state handle alive in degraded mode so runtime bridge diagnostics
        // (spindle status/diag masks) remain queryable instead of losing context.
        if (h0 > 0 && isFiniteState(v.state)) {
          return { handle: h0, kind: 'json_350z_manifest_ex_degraded', jsonPath: chronoSpec.jsonPath, attempts };
        }
        if (h0 > 0) {
          try { sim.destroyVehicle?.(h0); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }

    attempts.push({
      kind: 'json_350z_manifest_ex',
      ok: false,
      reason: chronoSpec ? 'spawn_failed' : 'chrono_spec_missing',
      manifestUrl: chronoManifestUrl || '',
    });
    return { handle: 0, kind: 'failed', jsonPath: '', attempts };
  };

  // Ensure data bundle is ready before spawning.
  if (!isDataReady(readDataStatus())) {
    const okData = await waitForDataReady(4.0);
    if (!okData) {
      const st = readDataStatus();
      setHud(
        `Vehicle data not ready yet.\n\n` +
        `data bundle: expected=${st.expected} finished=${st.finished} downloads=${st.dlN} bytes=${st.dlLoaded}/${st.dlTotal}\n` +
        `preload keys: ${st.preloadKeys.join(', ') || '(none)'}\n\n` +
        `Reload after the data bundle finishes loading.`,
      );
      return;
    }
  }

  // Spawn vehicle sim; we "skin" it with the 350Z GLB.
  let vehRec = spawnVehicle();
  let vehHandle = Number(vehRec?.handle) || 0;
  try { if (window.__chronoDebug) window.__chronoDebug.vehHandle = vehHandle; } catch { /* ignore */ }
  if (!vehHandle) {
    const api = /** @type {any} */ (sim)._api || null;
    const apiHas = {
      createVehicle: typeof api?.createVehicle === 'function',
      createVehicleJson: typeof api?.createVehicleJson === 'function',
      getState: typeof api?.getState === 'function',
      getWheelState: typeof api?.getWheelState === 'function',
      stepWorld: typeof api?.stepWorld === 'function',
    };
      setHud(
        `Vehicle spawn failed.\n\n` +
        `api: createVehicle=${apiHas.createVehicle} createVehicleJson=${apiHas.createVehicleJson} step=${apiHas.stepWorld} state=${apiHas.getState} wheel=${apiHas.getWheelState}\n\n` +
        `api coverage: ${apiCoverage.availableCount}/${apiCoverage.total} available  used=${apiCoverage.usedCount}  unused=${apiCoverage.unusedCount}  missing=${apiCoverage.missingCount}\n` +
        `api missing: ${apiCoverage.missing.join(', ') || '(none)'}\n` +
        `api unused: ${apiCoverage.unused.join(', ') || '(none)'}\n\n` +
        `FS exported: ${!!FS} (analyzePath=${fsCanAnalyze})\n` +
        `FS runtime helpers: createPath=${fsRt.createPath} createDataFile=${fsRt.createDataFile} unlink=${fsRt.unlink}\n` +
        `chrono manifest: ${chronoSpec?.manifestUrl || chronoManifestUrl || '(none)'}\n` +
        `chrono vehicle spec: ${chronoSpec?.jsonPath || '(not loaded)'}\n` +
        `chrono tire spec: ${chronoSpec?.tireJsonPath || '(not loaded)'}\n\n` +
        `data bundle: expected=${dataDl.expected} finished=${dataDl.finished} downloads=${dataDl.dlN} bytes=${dataDl.dlLoaded}/${dataDl.dlTotal}\n` +
        `preload keys: ${dataDl.preloadKeys.join(', ') || '(none)'}\n\n` +
        `attempts: ${(Array.isArray(vehRec?.attempts) ? vehRec.attempts : []).map((a) => `${a.kind}:${a.ok ? 'ok' : 'fail'}(h=${a.handle || 0})`).join('  ') || '(none)'}`,
      );
    return;
  }

  // Single drivetrain authority: default to FORWARD drive mode; switch to REVERSE only on intent.
  let manualGearIndex = 1;
  applyVehicleDriveTuning(sim, vehHandle, exportedTransmissionMode, manualGearIndex);
  let authoredPowertrainApplied = false;
  primeVehicleTransmission(sim, vehHandle, exportedTransmissionMode, manualGearIndex);
  let spawnHoldUntil = nowSec() + SPAWN_BRAKE_HOLD_SEC;

  // ---- Input ----
  const keysDown = setupKeys();
  let camMode = 'in_car'; // 'in_car' | 'chase'
  let viewYaw = 0;   // radians, relative to vehicle forward
  let viewPitch = 0; // radians, relative to vehicle forward

  const recenterView = () => { viewYaw = 0; viewPitch = 0; };
  const mouseSens = 0.0024;

  const pointerLocked = () => document.pointerLockElement === canvas;
  canvas.addEventListener('click', () => {
    try { canvas.requestPointerLock?.(); } catch { /* ignore */ }
  });
  window.addEventListener('mousemove', (e) => {
    if (!pointerLocked()) return;
    const dx = Number(e?.movementX) || 0;
    const dy = Number(e?.movementY) || 0;
    viewYaw -= dx * mouseSens;
    viewPitch -= dy * mouseSens;
    viewPitch = clamp(viewPitch, -1.15, 1.15);
  }, { passive: true });

  // Command state (applied to sim).
  const cmd = {
    throttle: 0,
    brake: 0,
    steer: 0,
  };
  // Chrono clutch convention can differ across bridge/runtime combinations.
  // Start with 0 and flip once on sustained inert behavior.
  let clutchCmd = 0;
  let clutchFlipTried = false;

  const tmpForward = new THREE.Vector3();
  const tmpRight = new THREE.Vector3();
  const tmpUp = new THREE.Vector3(0, 1, 0);
  const tmpPos = new THREE.Vector3();
  const tmpLook = new THREE.Vector3();
  const tmpDir = new THREE.Vector3();
  const tmpFYaw = new THREE.Vector3();
  const tmpRYaw = new THREE.Vector3();
  const qYaw = new THREE.Quaternion();
  const qPitch = new THREE.Quaternion();

  let lastT = nowSec();
  let lastState = null;
  let lastWheel = null;
  let lastPowertrain = null;
  let lastSpindles = null;
  let lastHudAt = 0;
  let bridgeProxyPose = null;
  // Pose source is centralized in computeVehiclePose().
  let lastPoseUsedStateEx = false;

  // Physics stepping: fixed substeps are much more stable than variable dt for Chrono vehicles.
  // Keep it conservative so the render loop can't spiral into doing too many steps.
  const fixedStep = SIM_DEBUG_CONFIG.sim.fixedStep;
  const maxSubstepsPerFrame = SIM_DEBUG_CONFIG.sim.maxSubstepsPerFrame;
  let simAcc = 0;
  let badStateFrames = 0;
  let badSpindleFrames = 0;
  let rawBadSpindleFrames = 0;
  let geomMismatchFrames = 0;
  let geomMismatchRecoverFrames = 0;
  let geomMismatchLatched = false;
  const geomMismatchLast = { dWb: NaN, dTf: NaN, dTr: NaN, simWb: NaN, simTf: NaN, simTr: NaN };
  let meshFrameMismatchFrames = 0;
  let meshFrameMismatchLatched = false;
  let meshFrameMismatchLast = {
    available: false,
    count: 0,
    maxPosErr: NaN,
    rmsPosErr: NaN,
    byId: { lf: NaN, rf: NaN, lr: NaN, rr: NaN },
  };
  let lastDriveMode = 1; // -1 reverse, 1 drive
  let lastParkingBrakeCommand = false;
  let wasInSpawnHold = true;
  let clutchShiftHoldUntil = -1e9;
  let noDriveResponseFrames = 0;
  let noDriveResponseSec = 0;
  let driveHealthyUnderThrottleSec = 0;
  let driveRecoveryStage = authoredPowertrainApplied ? 1 : 0;
  let lastResetAt = -1e9;
  let resetCount = 0;
  let lastResetReason = 'none';
  let geomFrameId = 0;
  const geomTrace = { frames: [], firstBad: null, badCount: 0 };

  const doReset = (reason = 'manual') => {
    const tNow = nowSec();
    if ((tNow - lastResetAt) < 0.35) return;
    lastResetAt = tNow;
    resetCount++;
    lastResetReason = safeTrim(reason) || 'manual';
    try { sim.reset(); } catch { /* ignore */ }
    try { applyWorldTuning(); } catch { /* ignore */ }
    vehRec = spawnVehicle();
    vehHandle = Number(vehRec?.handle) || 0;
    try { if (window.__chronoDebug) window.__chronoDebug.vehHandle = vehHandle; } catch { /* ignore */ }
    manualGearIndex = 1;
    applyVehicleDriveTuning(sim, vehHandle, exportedTransmissionMode, manualGearIndex);
    authoredPowertrainApplied = false;
    lastDriveMode = 1;
    clutchShiftHoldUntil = -1e9;
    primeVehicleTransmission(sim, vehHandle, exportedTransmissionMode, manualGearIndex);
    try { sim.setParkingBrake?.(vehHandle, false); } catch { /* ignore */ }
    badStateFrames = 0;
    badSpindleFrames = 0;
    rawBadSpindleFrames = 0;
    geomMismatchFrames = 0;
    geomMismatchRecoverFrames = 0;
    geomMismatchLatched = false;
    geomMismatchLast.dWb = NaN;
    geomMismatchLast.dTf = NaN;
    geomMismatchLast.dTr = NaN;
    geomMismatchLast.simWb = NaN;
    geomMismatchLast.simTf = NaN;
    geomMismatchLast.simTr = NaN;
    meshFrameMismatchFrames = 0;
    meshFrameMismatchLatched = false;
    meshFrameMismatchLast = {
      available: false,
      count: 0,
      maxPosErr: NaN,
      rmsPosErr: NaN,
      byId: { lf: NaN, rf: NaN, lr: NaN, rr: NaN },
    };
    spawnHoldUntil = nowSec() + SPAWN_BRAKE_HOLD_SEC;
    wasInSpawnHold = true;
    geomFrameId = 0;
    geomTrace.frames = [];
    geomTrace.firstBad = null;
    geomTrace.badCount = 0;
    noDriveResponseFrames = 0;
    noDriveResponseSec = 0;
    driveHealthyUnderThrottleSec = 0;
    bridgeProxyPose = null;
    driveRecoveryStage = 0;
    cmd.throttle = 0;
    cmd.brake = 0;
    cmd.steer = 0;
    clutchCmd = 0;
    clutchFlipTried = false;
  };

  window.addEventListener('keydown', (e) => {
    const code = String(e?.code || '');
    if (code === 'KeyR' && !e?.repeat) doReset('key_R');
    if (code === 'KeyV') camMode = (camMode === 'in_car') ? 'chase' : 'in_car';
    if (code === 'KeyC') recenterView();
    if (code === 'KeyO') {
      debugAxesOn = !debugAxesOn;
      try { debugViz.visible = debugAxesOn; } catch { /* ignore */ }
      try { debugVizMesh.visible = debugAxesOn; } catch { /* ignore */ }
    }
    if (code === 'KeyP') {
      try {
        const isOn = (debugPanel?.style?.display || '') !== 'none' && !!debugPanel?.style?.display;
        setDebugVisible(!isOn);
      } catch { /* ignore */ }
    }
    if (code === 'KeyC' && (e?.shiftKey || false)) {
      // Shift+C: copy current status text.
      void copyStatus();
    }
  });

  setHud('Starting…');

  const tick = () => {
    requestAnimationFrame(tick);

    const t = nowSec();
    const dt = clamp(t - lastT, 0, 1 / 15);
    lastT = t;

    if (!vehHandle || !sim.ready) return;

    // Read current state for speedRef and rendering.
    let st = null;
    try { st = sim.getState(vehHandle); } catch { st = null; }
    if (isFiniteState(st)) {
      lastState = st;
      badStateFrames = 0;
    } else if (st) {
      // If we got a non-null but invalid state, treat it as a hard error signal.
      badStateFrames++;
    }
    // Inputs
    const forward = (keysDown.has('KeyW') || keysDown.has('ArrowUp')) ? 1 : 0;
    const back = (keysDown.has('KeyS') || keysDown.has('ArrowDown')) ? 1 : 0;
    const left = (keysDown.has('KeyA') || keysDown.has('ArrowLeft')) ? 1 : 0;
    const right = (keysDown.has('KeyD') || keysDown.has('ArrowRight')) ? 1 : 0;
    const handbrake = keysDown.has('Space') ? 1 : 0;
    const transmissionMode = getTransmissionControlMode(chronoSpec, lastPowertrain);
    const manualTestMode = (transmissionMode === 'manual');

    // Normalized road-car controls:
    // - W accelerates forward
    // - S brakes when moving forward, reverse when near stop
    // - steer is smoothed and slightly reduced at higher speed
    const spdSignedNow = computeSignedForwardSpeed(lastState);
    const absSpd = Math.abs(spdSignedNow);
    const wantForward = !!forward && !back;
    const wantReverse = !!back && !forward;

    let targetDrive = lastDriveMode;
    if (wantForward) targetDrive = 1;
    else if (wantReverse && absSpd < 0.8) targetDrive = -1;
    else if (!wantForward && !wantReverse && absSpd < 0.5) targetDrive = 1;

    if (manualTestMode) {
      const targetGearIndex = (targetDrive < 0) ? -1 : 1;
      if (targetGearIndex !== manualGearIndex && absSpd < 0.8) {
        manualGearIndex = targetGearIndex;
        lastDriveMode = Math.sign(targetGearIndex) || 1;
        clutchShiftHoldUntil = t + 0.18;
        setManualGearIndex(sim, vehHandle, manualGearIndex);
      }
      try {
        const reportedGear = Math.trunc(Number(lastPowertrain?.gear) || 0);
        if ((wantForward || wantReverse) && absSpd < 1.0 && reportedGear !== manualGearIndex) {
          setManualGearIndex(sim, vehHandle, manualGearIndex);
        }
      } catch { /* ignore */ }
    } else {
      if (targetDrive !== lastDriveMode && absSpd < 0.8) {
        lastDriveMode = targetDrive;
        setDriveMode(sim, vehHandle, targetDrive);
      }
      // Recover if transmission reports a stale drive mode after a mode switch.
      try {
        const reportedDrive = Math.sign(Number(lastPowertrain?.driveMode) || 0);
        if ((wantForward || wantReverse) && absSpd < 1.0 && reportedDrive !== lastDriveMode) {
          setDriveMode(sim, vehHandle, lastDriveMode);
        }
      } catch { /* ignore */ }
    }

    let wantThrottle = 0;
    let wantBrake = handbrake ? 1 : 0;
    if (manualTestMode) {
      if (wantForward) {
        wantThrottle = 1;
      } else if (wantReverse) {
        if (spdSignedNow > 0.5 && absSpd > 0.5) {
          wantBrake = Math.max(wantBrake, clamp(absSpd / 8, 0.25, 1));
        } else {
          wantThrottle = 0.65;
        }
      }
    } else {
      if (wantForward) {
        if (lastDriveMode === 1 || absSpd < 0.5) wantThrottle = 1;
        if (lastDriveMode === -1 && spdSignedNow < -0.5) wantBrake = Math.max(wantBrake, clamp(absSpd / 8, 0.2, 1));
      } else if (wantReverse) {
        if (spdSignedNow > 0.5 && lastDriveMode !== -1) {
          wantBrake = Math.max(wantBrake, clamp(absSpd / 8, 0.25, 1));
        } else if (lastDriveMode === -1 || absSpd < 0.5) {
          wantThrottle = 0.65;
        }
      }
    }

    // Dampen idle creep/jitter from suspension settle at very low speed.
    if (!wantForward && !wantReverse && !handbrake && absSpd < IDLE_BRAKE_DAMP_SPEED_MPS) {
      wantBrake = Math.max(wantBrake, IDLE_BRAKE_DAMP_AMOUNT);
    }

    const steerInput = clamp(left - right, -1, 1);
    const steerAuthority = 1.0 - clamp(absSpd / 45, 0, 0.65);
    const steerTarget = steerInput * steerAuthority;
    const steerRate = (Math.abs(steerInput) < 1e-3) ? 28.0 : 12.0;
    const steerAlpha = 1.0 - Math.exp(-steerRate * dt);

    const inSpawnHold = t < spawnHoldUntil;
    if (inSpawnHold) {
      wantThrottle = 0;
      wantBrake = Math.max(wantBrake, 0.25);
      lastParkingBrakeCommand = true;
    } else {
      if (wasInSpawnHold) {
        try {
          if (manualTestMode) setManualGearIndex(sim, vehHandle, manualGearIndex);
          else setDriveMode(sim, vehHandle, lastDriveMode);
        } catch { /* ignore */ }
      }
      lastParkingBrakeCommand = !!handbrake;
    }
    wasInSpawnHold = inSpawnHold;
    try { sim.setParkingBrake?.(vehHandle, lastParkingBrakeCommand); } catch { /* ignore */ }

    cmd.throttle = wantThrottle;
    cmd.brake = wantBrake;
    cmd.steer += (steerTarget - cmd.steer) * steerAlpha;
    if (manualTestMode) {
      if (inSpawnHold || handbrake) {
        clutchCmd = 1;
      } else if (t < clutchShiftHoldUntil) {
        clutchCmd = 0.9;
      } else if (wantThrottle > 0.05 && absSpd < 1.5) {
        clutchCmd = clamp(0.55 - (absSpd / 1.5) * 0.45, 0.10, 0.55);
      } else if (!wantForward && !wantReverse && absSpd < 0.25) {
        clutchCmd = 0.20;
      } else {
        clutchCmd = 0;
      }
    }
    try {
      const useEx = (manualTestMode || !!SIM_DEBUG_CONFIG?.sim?.preferControlsEx) && (typeof sim.setControlsEx === 'function');
      if (useEx) sim.setControlsEx(vehHandle, cmd.throttle, cmd.brake, cmd.steer, clutchCmd);
      else sim.setControls?.(vehHandle, cmd.throttle, cmd.brake, cmd.steer);
    } catch { /* ignore */ }

    // Advance sim in fixed substeps for stability.
    simAcc = Math.min(simAcc + dt, fixedStep * maxSubstepsPerFrame);
    let sub = 0;
    while (simAcc >= fixedStep && sub < maxSubstepsPerFrame) {
      try { sim.step(fixedStep); } catch { badStateFrames++; break; }
      simAcc -= fixedStep;
      sub++;
    }

    let st2 = null;
    try { st2 = sim.getState(vehHandle); } catch { st2 = null; }
    if (isFiniteState(st2)) {
      lastState = st2;
      badStateFrames = 0;
    } else if (st2) {
      badStateFrames++;
    }
    try { lastWheel = sim.getWheelState(vehHandle) || lastWheel; } catch { /* ignore */ }
    try { lastPowertrain = sim.getPowertrainState?.(vehHandle) || lastPowertrain; } catch { /* ignore */ }
    let hardResetIssued = false;
    {
      const throttleCmd = Number(cmd.throttle) || 0;
      const brakeCmd = Number(cmd.brake) || 0;
      const oFL = Number(lastWheel?.omegaFL);
      const oFR = Number(lastWheel?.omegaFR);
      const oRL = Number(lastWheel?.omegaRL);
      const oRR = Number(lastWheel?.omegaRR);
      const maxOmega = Math.max(
        Number.isFinite(oFL) ? Math.abs(oFL) : 0,
        Number.isFinite(oFR) ? Math.abs(oFR) : 0,
        Number.isFinite(oRL) ? Math.abs(oRL) : 0,
        Number.isFinite(oRR) ? Math.abs(oRR) : 0,
      );
      const driveshaftNmPt = Number(lastPowertrain?.driveshaftTorqueNm);
      const driveshaftNmWh = Number(lastWheel?.driveshaftTorqueNm);
      const driveshaftNm = Number.isFinite(driveshaftNmPt) ? driveshaftNmPt : driveshaftNmWh;
      const motorshaftRpmPt = Number(lastPowertrain?.motorshaftRpm);
      const motorshaftRpmWh = Number(lastWheel?.motorshaftRpm);
      const motorshaftRpm = Number.isFinite(motorshaftRpmPt) ? motorshaftRpmPt : motorshaftRpmWh;
      const ptDriveMode = Number(lastPowertrain?.driveMode);
      const ptGear = Number(lastPowertrain?.gear);
      const whGear = Number(lastWheel?.gear);
      const inDrive = (
        (Number.isFinite(ptDriveMode) && Math.sign(ptDriveMode) >= 1)
        || (Number.isFinite(ptGear) && ptGear >= 0.5)
        || (Number.isFinite(whGear) && whGear >= 0.5)
      );
      const absDriveshaftNm = Math.abs(Number.isFinite(driveshaftNm) ? driveshaftNm : 0);
      const absMotorshaftRpm = Math.abs(Number.isFinite(motorshaftRpm) ? motorshaftRpm : 0);
      const driveSignal =
        (maxOmega >= 1.0)
        || (absDriveshaftNm >= 8.0)
        || (absMotorshaftRpm >= 120.0)
        || (absSpd >= 0.35);
      const throttleDemand =
        !inSpawnHold
        && throttleCmd > 0.55
        && brakeCmd < 0.05
        && inDrive;
      if (throttleDemand && !driveSignal) {
        noDriveResponseFrames++;
        noDriveResponseSec += dt;
        driveHealthyUnderThrottleSec = 0;
      } else if (throttleDemand) {
        noDriveResponseFrames = 0;
        noDriveResponseSec = 0;
        driveHealthyUnderThrottleSec += dt;
      } else {
        noDriveResponseFrames = 0;
        noDriveResponseSec = 0;
        driveHealthyUnderThrottleSec = 0;
      }
      if (!STRICT_CHRONO_MODE) {
        // Stage 2 recovery: reassert transmission+brake state even if powertrain object exists.
        if (
          !inSpawnHold
          && throttleCmd > 0.55
          && brakeCmd < 0.05
          && noDriveResponseSec >= DRIVE_INERT_RECOVERY.reassertSec
          && driveRecoveryStage < 2
        ) {
          driveRecoveryStage = 2;
          try { sim.setShiftMode?.(vehHandle, false); } catch { /* ignore */ }
          try { sim.setGearIndex?.(vehHandle, 1); } catch { /* ignore */ }
          try { setDriveMode(sim, vehHandle, 1); } catch { /* ignore */ }
          try { sim.setParkingBrake?.(vehHandle, false); } catch { /* ignore */ }
          try { sim.enableBrakeLocking?.(vehHandle, false); } catch { /* ignore */ }
          try { sim.clearBrakePerWheel?.(vehHandle); } catch { /* ignore */ }
        }
        // If we're commanding throttle in-drive and still inert, flip clutch convention once.
        if (
          SIM_DEBUG_CONFIG?.sim?.enableClutchAutoFlip
          && !clutchFlipTried
          && !inSpawnHold
          && throttleCmd > 0.55
          && brakeCmd < 0.05
          && noDriveResponseSec >= DRIVE_INERT_RECOVERY.rescueSec
        ) {
          clutchCmd = (clutchCmd > 0.5) ? 0 : 1;
          clutchFlipTried = true;
          noDriveResponseFrames = 0;
          noDriveResponseSec = 0;
        }
        // Stage 3 recovery: full respawn, without mutating the authored powertrain.
        if (
          !!SIM_DEBUG_CONFIG?.sim?.enableInertAutoRespawn
          && !inSpawnHold
          && throttleCmd > 0.55
          && brakeCmd < 0.05
          && noDriveResponseSec >= DRIVE_INERT_RECOVERY.respawnSec
          && driveRecoveryStage < 3
          && (nowSec() - lastResetAt) > 1.2
        ) {
          driveRecoveryStage = 3;
          doReset('inert_stage3');
          hardResetIssued = true;
        }
      }
    }
    if (hardResetIssued) return;
    const poseForSpindleOrder = computeVehiclePose(lastState, SIM_DEBUG_CONFIG);
    let rawSpindlesApi = null;
    try { rawSpindlesApi = sim.getSpindles4RawWithStatus?.(vehHandle) || null; } catch { rawSpindlesApi = null; }
    let spindleBridgeStatus = null;
    try { spindleBridgeStatus = sim.getSpindles4Status?.(vehHandle) || null; } catch { spindleBridgeStatus = null; }
    let spindleBridgeDiag = null;
    try { spindleBridgeDiag = sim.getSpindles4Diag?.(vehHandle) || null; } catch { spindleBridgeDiag = null; }
    let driveProxyDiag = null;
    try { driveProxyDiag = sim.getDriveProxyDiag?.(vehHandle) || null; } catch { driveProxyDiag = null; }
    bridgeProxyPose = null;
    let bridgeDiagVersion = 0;
    try { bridgeDiagVersion = Math.trunc(Number(sim.getBridgeDiagVersion?.()) || 0); } catch { bridgeDiagVersion = 0; }
    const rawSpindlesDirect = rawSpindlesApi?.packet || null;
    const rawSpindleDiagNative = analyzeSpindleGeometry(rawSpindlesDirect);
    const rawSpindleCanon = canonicalizeSpindleOrderByPose(rawSpindlesDirect, poseForSpindleOrder?.quaternion || carGroup.quaternion);
    const rawSpindlesNorm = rawSpindleCanon?.spindles || rawSpindlesDirect;
    const rawSpindleDiag = analyzeSpindleGeometry(rawSpindlesNorm);
    lastSpindles = Array.isArray(rawSpindlesNorm) ? rawSpindlesNorm : null;
    const spindleDiag = analyzeSpindleGeometry(lastSpindles);
    // "raw bad" is reserved for stream validity problems (missing/non-finite),
    // not for geometric plausibility mismatches.
    if (!rawSpindleDiag.seen || !rawSpindleDiag.finite) rawBadSpindleFrames++;
    else rawBadSpindleFrames = 0;
    if (rawSpindleDiag.seen && rawSpindleDiag.initialized && !rawSpindleDiag.ok) badSpindleFrames++;
    else badSpindleFrames = 0;
    try {
      if (window.__chronoDebug) {
        window.__chronoDebug.lastState = lastState;
        window.__chronoDebug.lastWheel = lastWheel;
        window.__chronoDebug.lastSpindles = lastSpindles;
        window.__chronoDebug.rawSpindles = rawSpindlesDirect;
        window.__chronoDebug.rawSpindlesCanon = rawSpindlesNorm;
        window.__chronoDebug.rawSpindleCanonMeta = rawSpindleCanon || null;
        window.__chronoDebug.rawSpindlesApi = rawSpindlesApi || null;
        window.__chronoDebug.spindleBridgeStatus = spindleBridgeStatus || null;
        window.__chronoDebug.spindleBridgeDiag = spindleBridgeDiag || null;
        window.__chronoDebug.driveProxyDiag = driveProxyDiag || null;
        window.__chronoDebug.apiCoverage = apiCoverage;
      }
    } catch { /* ignore */ }
    geomFrameId++;
    try {
      const sample = sampleSpindleFrame(rawSpindlesNorm);
      if (sample) {
        const rec = {
          frame: geomFrameId,
          t,
          wb: sample.wb,
          tf: sample.tf,
          tr: sample.tr,
          rawOk: !!(rawSpindleDiag?.ok),
          rawBadFrames: rawBadSpindleFrames,
          reorder: !!(rawSpindleCanon?.reordered),
          apiOk: !!(rawSpindlesApi?.apiOk),
        };
        geomTrace.frames.push(rec);
        if (geomTrace.frames.length > GEOM_TRACE_MAX_FRAMES) geomTrace.frames.shift();
        const bad = !isSpindleGeometryInRange(sample.wb, sample.tf, sample.tr);
        if (bad) {
          geomTrace.badCount++;
          if (!geomTrace.firstBad) geomTrace.firstBad = rec;
        }
      }
    } catch { /* ignore */ }

    // Authoritative vehicle pose from Chrono.
    const pose = computeVehiclePose(lastState, SIM_DEBUG_CONFIG);
    lastPoseUsedStateEx = !!pose.usedStateEx;
    const yaw = Number(pose.yaw) || 0;
    carGroup.position.copy(pose.position);
    carGroup.quaternion.copy(pose.quaternion);
    try {
      applyWheelSkinAnimation(wheelSkin, lastWheel, cmd.steer, computeSignedForwardSpeed(lastState), dt, lastSpindles);
    } catch { /* ignore */ }
    try {
      if (window.__chronoDebug) window.__chronoDebug.wheelVisual = captureWheelVisualState(wheelSkin);
    } catch { /* ignore */ }
    try {
      meshFrameMismatchLast = sampleMeshSpindleFrameMismatch(wheelSkin, lastSpindles);
      if (
        t > (spawnHoldUntil + 0.20)
        && meshFrameMismatchLast.available
        && meshFrameMismatchLast.count >= 4
      ) {
        if (Number.isFinite(meshFrameMismatchLast.maxPosErr) && meshFrameMismatchLast.maxPosErr > MESH_FRAME_MISMATCH_LIMITS.posLatchMeters) {
          meshFrameMismatchFrames++;
        } else {
          meshFrameMismatchFrames = 0;
          if (meshFrameMismatchLatched && Number.isFinite(meshFrameMismatchLast.maxPosErr) && meshFrameMismatchLast.maxPosErr <= MESH_FRAME_MISMATCH_LIMITS.posWarnMeters) {
            meshFrameMismatchLatched = false;
          }
        }
        if (meshFrameMismatchFrames >= MESH_FRAME_MISMATCH_LIMITS.frames) meshFrameMismatchLatched = true;
      } else {
        meshFrameMismatchFrames = 0;
      }
    } catch { /* ignore */ }

    // One-time alignment: map mesh wheel-center reference to Chrono spindle center.
    // This centralizes offsets and avoids iterative drift corrections.
    try {
      if (
        !meshDiag.autoAlignApplied
        && SIM_DEBUG_CONFIG?.visual?.autoAlignMeshToSpindles
        && meshWheelCenterLocal
      ) {
        const cWorld = getSpindleCenterWorld(lastSpindles);
        if (cWorld) {
          carRoot.updateMatrixWorld(true);
          const meshCtrWorld = carRoot.localToWorld(meshWheelCenterLocal.clone());
          const deltaWorld = cWorld.clone().sub(meshCtrWorld);
          // Keep auto-align conservative: apply vertical correction only.
          const deltaYWorld = clamp(deltaWorld.y, -1.5, 1.5);
          const deltaLocal = new THREE.Vector3(0, deltaYWorld, 0).applyQuaternion(carGroup.quaternion.clone().invert());
          carRoot.position.add(deltaLocal);
          meshDiag.autoAlignDelta.set(0, deltaYWorld, 0);
          meshDiag.autoAlignApplied = true;
        }
      }
    } catch { /* ignore */ }

    // Update sim wheel markers from spindle poses (world frame).
    try {
      if (spindleDiag.ok) applyWheelVizFromSpindles(lastSpindles, simWheelViz, SIM_DEBUG_CONFIG);
    } catch { /* ignore */ }

    // Sim chassis debug from spindle geometry (world), oriented by the Chrono vehicle pose.
    try {
      if (simChassisViz.mesh) {
        const sp = Array.isArray(lastSpindles) ? lastSpindles : null;
        if (sp && sp.length >= 4) {
          const lf = vec3FromObj(sp[0].pos);
          const rf = vec3FromObj(sp[1].pos);
          const lr = vec3FromObj(sp[2].pos);
          const rr = vec3FromObj(sp[3].pos);
          const front = lf.clone().add(rf).multiplyScalar(0.5);
          const rear = lr.clone().add(rr).multiplyScalar(0.5);
          const center = front.clone().add(rear).multiplyScalar(0.5);
          const wb = front.clone().sub(rear).setY(0).length();
          const trackF = lf.clone().sub(rf).setY(0).length();
          const trackR = lr.clone().sub(rr).setY(0).length();
          const track = (trackF + trackR) * 0.5;
          const length = Math.max(1.0, wb * 1.1);
          const width = Math.max(0.6, track * 0.9);
          const height = 0.35;
          simChassisViz.mesh.scale.set(width, height, length);
          simChassisViz.mesh.position.copy(center);
        } else {
          simChassisViz.mesh.position.copy(carGroup.position);
        }
        simChassisViz.mesh.quaternion.copy(carGroup.quaternion);
      }
    } catch { /* ignore */ }

    // If the sim is producing invalid state for multiple consecutive frames, stop applying transforms.
    if (badStateFrames >= 3) {
      setHud(
        `Sim became unstable (invalid state values).\n` +
        `This usually indicates too-large timesteps or a vehicle config issue.\n\n` +
        `Try: press R to respawn. If it keeps happening, rebuild Chrono and consider lowering fixedStep.\n\n` +
        `Tip: open debug panel (P) and copy status.`,
      );
      try { setDebugVisible(true); } catch { /* ignore */ }
      return;
    }
    let transientHudAlert = '';
    if (rawBadSpindleFrames >= RAW_SPINDLE_BAD_FRAME_LIMIT) {
      transientHudAlert =
        `Raw spindle stream is unhealthy (continuous invalid frames).\n` +
        `latest raw: wheelbase=${Number.isFinite(rawSpindleDiag.wb) ? fmt(rawSpindleDiag.wb, 3) : '—'} ` +
        `trackF=${Number.isFinite(rawSpindleDiag.tf) ? fmt(rawSpindleDiag.tf, 3) : '—'} ` +
        `trackR=${Number.isFinite(rawSpindleDiag.tr) ? fmt(rawSpindleDiag.tr, 3) : '—'}\n` +
        `raw bad frames: ${rawBadSpindleFrames}\n` +
        `bridge: reason=${spindleReasonLabel(spindleBridgeStatus?.reason)} allWheels=${spindleBridgeStatus?.allWheelsOk ? 'yes' : 'no'} sane=${spindleBridgeStatus?.sanePacket ? 'yes' : 'no'} failWheel=${wheelIdxLabel(spindleBridgeStatus?.failWheel)} failStage=${spindleFailStageLabel(spindleBridgeStatus?.failStage)} directMask=${Math.trunc(Number(spindleBridgeStatus?.directOkMask) || 0)} fallbackMask=${Math.trunc(Number(spindleBridgeStatus?.fallbackOkMask) || 0)} ` +
        `wb=${Number.isFinite(spindleBridgeStatus?.wb) ? fmt(spindleBridgeStatus.wb, 3) : '—'} ` +
        `tf=${Number.isFinite(spindleBridgeStatus?.tf) ? fmt(spindleBridgeStatus.tf, 3) : '—'} ` +
        `tr=${Number.isFinite(spindleBridgeStatus?.tr) ? fmt(spindleBridgeStatus.tr, 3) : '—'}\n` +
        `bridge diag: axles=${Number.isFinite(spindleBridgeDiag?.axleCount) ? fmt(spindleBridgeDiag.axleCount, 0) : '—'} ` +
        `spawnW=${wheelMaskLabel(spindleBridgeDiag?.spawnExpectedWheelMask)} spawnT=${wheelMaskLabel(spindleBridgeDiag?.spawnExpectedTireMask)} ` +
        `wheelPtr=${wheelMaskLabel(spindleBridgeDiag?.wheelPtrMask)} wheelFinite=${wheelMaskLabel(spindleBridgeDiag?.wheelStateFiniteMask)} ` +
        `fallbackTry=${wheelMaskLabel(spindleBridgeDiag?.fallbackAttemptMask)} wsPos=${wheelMaskLabel(spindleBridgeDiag?.wsPosFiniteMask)} wsRot=${wheelMaskLabel(spindleBridgeDiag?.wsRotFiniteMask)} wsLin=${wheelMaskLabel(spindleBridgeDiag?.wsLinFiniteMask)} wsAng=${wheelMaskLabel(spindleBridgeDiag?.wsAngFiniteMask)} wsExc=${wheelMaskLabel(spindleBridgeDiag?.wsExceptionMask)}\n` +
        `bridge direct/body: dPos=${wheelMaskLabel(spindleBridgeDiag?.directPosFiniteMask)} dRot=${wheelMaskLabel(spindleBridgeDiag?.directRotFiniteMask)} dLin=${wheelMaskLabel(spindleBridgeDiag?.directLinFiniteMask)} dAng=${wheelMaskLabel(spindleBridgeDiag?.directAngFiniteMask)} dExc=${wheelMaskLabel(spindleBridgeDiag?.directExceptionMask)} sbTry=${wheelMaskLabel(spindleBridgeDiag?.spindleBodyAttemptMask)} sbPos=${wheelMaskLabel(spindleBridgeDiag?.spindleBodyPosFiniteMask)} sbRot=${wheelMaskLabel(spindleBridgeDiag?.spindleBodyRotFiniteMask)} sbLin=${wheelMaskLabel(spindleBridgeDiag?.spindleBodyLinFiniteMask)} sbAng=${wheelMaskLabel(spindleBridgeDiag?.spindleBodyAngFiniteMask)} sbExc=${wheelMaskLabel(spindleBridgeDiag?.spindleBodyExceptionMask)}\n` +
        `This points to spindle readback/API-stream validity (missing/non-finite), not visual skin anchoring.\n\n` +
        `${formatGeomTraceSummary(geomTrace)}\n\n` +
        `Tip: open debug panel (P) and copy status.`;
      try { setDebugVisible(true); } catch { /* ignore */ }
      // Keep running so we can continue collecting drivetrain + pose telemetry.
    } else if (badSpindleFrames >= 3) {
      transientHudAlert =
        `Sim spindle geometry became invalid (wheelbase/track out of range).\n` +
        `measured: wheelbase=${Number.isFinite(spindleDiag.wb) ? fmt(spindleDiag.wb, 3) : '—'} ` +
        `trackF=${Number.isFinite(spindleDiag.tf) ? fmt(spindleDiag.tf, 3) : '—'} ` +
        `trackR=${Number.isFinite(spindleDiag.tr) ? fmt(spindleDiag.tr, 3) : '—'}\n` +
        `This indicates a bad vehicle/suspension config rather than rendering.\n\n` +
        `Try: press R to respawn. If it repeats, rebuild/regenerate Chrono vehicle JSON and keep debug panel open.\n\n` +
        `${formatGeomTraceSummary(geomTrace)}\n\n` +
        `Tip: open debug panel (P) and copy status.`;
      try { setDebugVisible(true); } catch { /* ignore */ }
      // Keep running so drivetrain/pose can still be exercised while geometry is debugged.
    } else if (meshFrameMismatchLatched) {
      transientHudAlert =
        `Mesh-vs-sim frame mismatch (latched): wheel mesh pivots are not tracking Chrono spindle frame.\n` +
        `pos err(m): max=${Number.isFinite(meshFrameMismatchLast.maxPosErr) ? fmt(meshFrameMismatchLast.maxPosErr, 3) : '—'} ` +
        `rms=${Number.isFinite(meshFrameMismatchLast.rmsPosErr) ? fmt(meshFrameMismatchLast.rmsPosErr, 3) : '—'} ` +
        `lf=${Number.isFinite(meshFrameMismatchLast.byId?.lf) ? fmt(meshFrameMismatchLast.byId.lf, 3) : '—'} ` +
        `rf=${Number.isFinite(meshFrameMismatchLast.byId?.rf) ? fmt(meshFrameMismatchLast.byId.rf, 3) : '—'} ` +
        `lr=${Number.isFinite(meshFrameMismatchLast.byId?.lr) ? fmt(meshFrameMismatchLast.byId.lr, 3) : '—'} ` +
        `rr=${Number.isFinite(meshFrameMismatchLast.byId?.rr) ? fmt(meshFrameMismatchLast.byId.rr, 3) : '—'}\n` +
        `threshold: >${fmt(MESH_FRAME_MISMATCH_LIMITS.posLatchMeters, 3)}m for ${MESH_FRAME_MISMATCH_LIMITS.frames} frames\n` +
        `This indicates wheel-node mapping/pivot issues in mesh binding, not Chrono vehicle physics.\n\n` +
        `Tip: open debug panel (P) and copy status.`;
      try { setDebugVisible(true); } catch { /* ignore */ }
    }
    {
      const expWb = Number(chronoSpec?.geom?.wheelbase);
      const expTf = Number(chronoSpec?.geom?.frontTrack);
      const expTr = Number(chronoSpec?.geom?.rearTrack);
      const readyForCheck = (
        t > (spawnHoldUntil + GEOM_MISMATCH_LIMITS.settleSecAfterHold)
        && Number.isFinite(expWb) && Number.isFinite(expTf) && Number.isFinite(expTr)
        && spindleDiag?.ok
      );
      if (readyForCheck) {
        const bridgeHealthy = (
          !spindleBridgeStatus
          || (
            spindleBridgeStatus?.allWheelsOk !== false
            && spindleBridgeStatus?.sanePacket !== false
          )
        );
        const rawHealthy = !!(rawSpindleDiag?.ok);
        const stableOrder = !rawSpindleCanon?.reordered;
        const dWb = Math.abs(Number(spindleDiag.wb) - expWb);
        const dTf = Math.abs(Number(spindleDiag.tf) - expTf);
        const dTr = Math.abs(Number(spindleDiag.tr) - expTr);
        geomMismatchLast.dWb = dWb;
        geomMismatchLast.dTf = dTf;
        geomMismatchLast.dTr = dTr;
        geomMismatchLast.simWb = Number(spindleDiag.wb);
        geomMismatchLast.simTf = Number(spindleDiag.tf);
        geomMismatchLast.simTr = Number(spindleDiag.tr);
        const badDelta = (
          dWb > GEOM_MISMATCH_LIMITS.wheelbaseAbs
          || dTf > GEOM_MISMATCH_LIMITS.trackAbs
          || dTr > GEOM_MISMATCH_LIMITS.trackAbs
        );
        if (badDelta && bridgeHealthy && rawHealthy && stableOrder) {
          geomMismatchFrames++;
          geomMismatchRecoverFrames = 0;
        } else {
          geomMismatchFrames = 0;
          if (geomMismatchLatched && !badDelta) {
            geomMismatchRecoverFrames++;
            if (geomMismatchRecoverFrames >= GEOM_MISMATCH_LIMITS.clearFrames) {
              geomMismatchLatched = false;
              geomMismatchRecoverFrames = 0;
            }
          } else {
            geomMismatchRecoverFrames = 0;
          }
        }
        if (geomMismatchFrames >= GEOM_MISMATCH_LIMITS.frames) geomMismatchLatched = true;
      } else {
        geomMismatchFrames = 0;
        geomMismatchRecoverFrames = 0;
      }
    }
    if (geomMismatchLatched) {
      let pLF = null;
      let pRF = null;
      let pLR = null;
      let pRR = null;
      try {
        if (Array.isArray(lastSpindles) && lastSpindles.length >= 4) {
          pLF = vec3FromObj(lastSpindles[0].pos);
          pRF = vec3FromObj(lastSpindles[1].pos);
          pLR = vec3FromObj(lastSpindles[2].pos);
          pRR = vec3FromObj(lastSpindles[3].pos);
        }
      } catch { /* ignore */ }
      setHud(
        `Source-vs-sim geometry mismatch (latched).\n` +
        `expected: wb=${Number.isFinite(chronoSpec?.geom?.wheelbase) ? fmt(chronoSpec.geom.wheelbase, 3) : '—'} ` +
        `tf=${Number.isFinite(chronoSpec?.geom?.frontTrack) ? fmt(chronoSpec.geom.frontTrack, 3) : '—'} ` +
        `tr=${Number.isFinite(chronoSpec?.geom?.rearTrack) ? fmt(chronoSpec.geom.rearTrack, 3) : '—'} ` +
        `src=${safeTrim(chronoSpec?.geom?.trackSource) || 'unknown'}\n` +
        `measured: wb=${Number.isFinite(geomMismatchLast.simWb) ? fmt(geomMismatchLast.simWb, 3) : '—'} ` +
        `tf=${Number.isFinite(geomMismatchLast.simTf) ? fmt(geomMismatchLast.simTf, 3) : '—'} ` +
        `tr=${Number.isFinite(geomMismatchLast.simTr) ? fmt(geomMismatchLast.simTr, 3) : '—'}\n` +
        `delta: dWb=${Number.isFinite(geomMismatchLast.dWb) ? fmt(geomMismatchLast.dWb, 3) : '—'} ` +
        `dTf=${Number.isFinite(geomMismatchLast.dTf) ? fmt(geomMismatchLast.dTf, 3) : '—'} ` +
        `dTr=${Number.isFinite(geomMismatchLast.dTr) ? fmt(geomMismatchLast.dTr, 3) : '—'} ` +
        `(limits wb>${fmt(GEOM_MISMATCH_LIMITS.wheelbaseAbs, 2)} track>${fmt(GEOM_MISMATCH_LIMITS.trackAbs, 2)})\n` +
        `spindle xz: FL=${fmtPosXZ(pLF)} FR=${fmtPosXZ(pRF)} RL=${fmtPosXZ(pLR)} RR=${fmtPosXZ(pRR)}\n` +
        `hardpoints: mode=${safeTrim(chronoSpec?.hardpoints?.mode) || 'unknown'} requested=${chronoSpec?.hardpoints?.requested ? 'yes' : 'no'} ` +
        `front(applied=${chronoSpec?.hardpoints?.frontApplied ? 'yes' : 'no'} geomOk=${chronoSpec?.hardpoints?.frontGeomOk ? 'yes' : 'no'} partial=${chronoSpec?.hardpoints?.frontPartial ? 'yes' : 'no'}) ` +
        `rear(applied=${chronoSpec?.hardpoints?.rearApplied ? 'yes' : 'no'} geomOk=${chronoSpec?.hardpoints?.rearGeomOk ? 'yes' : 'no'} partial=${chronoSpec?.hardpoints?.rearPartial ? 'yes' : 'no'})\n\n` +
        `This is a vehicle/suspension export/config issue. Stop tuning render alignment and fix Chrono JSON hardpoints/templates/driveline.\n\n` +
        `${formatGeomTraceSummary(geomTrace)}\n\n` +
        `Tip: open debug panel (P) and copy status.`,
      );
      try { setDebugVisible(true); } catch { /* ignore */ }
      return;
    }

    // Camera
    tmpForward.set(0, 0, -1).applyQuaternion(carGroup.quaternion).normalize();
    tmpRight.set(1, 0, 0).applyQuaternion(carGroup.quaternion).normalize();
    qYaw.setFromAxisAngle(tmpUp, viewYaw);
    tmpFYaw.copy(tmpForward).applyQuaternion(qYaw).normalize();
    tmpRYaw.copy(tmpRight).applyQuaternion(qYaw).normalize();
    qPitch.setFromAxisAngle(tmpRYaw, viewPitch);
    tmpDir.copy(tmpFYaw).applyQuaternion(qPitch).normalize();
    if (camMode === 'chase') {
      // Orbit-ish chase cam controlled by mouse look.
      const chaseDist = 8.5;
      const chaseLift = 2.2;
      tmpPos.copy(carGroup.position)
        .addScaledVector(tmpUp, chaseLift)
        .addScaledVector(tmpDir, -chaseDist);
      tmpLook.copy(carGroup.position).addScaledVector(tmpUp, 1.1);
      camera.position.lerp(tmpPos, 1.0 - Math.exp(-8.0 * dt));
      camera.lookAt(tmpLook);
    } else {
      // In-car camera at meta anchor.
      tmpPos.copy(driverLocal);
      try { carRoot.updateMatrixWorld(true); } catch { /* ignore */ }
      carRoot.localToWorld(tmpPos);
      tmpPos.y = Math.max(0.55, tmpPos.y);
      tmpLook.copy(tmpPos).addScaledVector(tmpDir, 14.0);
      camera.position.lerp(tmpPos, 1.0 - Math.exp(-18.0 * dt));
      camera.lookAt(tmpLook);
    }

    // HUD (throttle updates). In transient alert mode, keep the alert stable and
    // avoid alternating with the telemetry HUD.
    if (transientHudAlert) {
      setHud(transientHudAlert);
    } else if ((t - lastHudAt) > 0.05) {
      lastHudAt = t;
      const spdMag = Math.hypot(Number(lastState?.vx) || 0, Number(lastState?.vz) || 0);
      const spdSigned = computeSignedForwardSpeed(lastState);
      const yawDeg = (Number.isFinite(yaw) ? (yaw * 180 / Math.PI) : NaN);
      const steer = cmd.steer;
      const steerDeg = (Number.isFinite(steer) ? (steer * 25.0) : NaN);
      const ptGear = Number(lastPowertrain?.gear);
      const whGear = Number(lastWheel?.gear);
      const trGear = Number.isFinite(ptGear) ? ptGear : whGear;
      const hasTr = !!lastPowertrain?.hasTransmission || !!lastWheel?.hasTransmission;
      const txPt = Number(lastPowertrain?.driveshaftTorqueNm);
      const txWh = Number(lastWheel?.driveshaftTorqueNm);
      const tx = Number.isFinite(txPt) ? txPt : txWh;
      const engRpmPt = Number(lastPowertrain?.motorshaftRpm);
      const engRpmWh = Number(lastWheel?.motorshaftRpm);
      const engRpm = Number.isFinite(engRpmPt) ? engRpmPt : engRpmWh;
      const ptHasEngine = !!lastPowertrain?.hasEngine;
      const ptType = Number(lastPowertrain?.transType);
      const ptShift = Number(lastPowertrain?.shiftMode);
      const ptDrive = Number(lastPowertrain?.driveMode);
      const ptEngineRpm = Number(lastPowertrain?.engineRpm);
      const ptEngineTq = Number(lastPowertrain?.engineTorqueNm);
      const ptTcOutTq = Number(lastPowertrain?.tcOutputTorqueNm);
      const ptTcOutRpm = Number(lastPowertrain?.tcOutputSpeedRpm);
      const ptTcSlip = Number(lastPowertrain?.tcSlip);
      const ptHasTc = !!lastPowertrain?.hasTorqueConverter;
      const apiHasInputsEx = typeof sim?._api?.setInputsEx === 'function';
      const transmissionMode = getTransmissionControlMode(chronoSpec, lastPowertrain);
      const manualTestMode = (transmissionMode === 'manual');
      const inputsModeLabel = ((manualTestMode || !!SIM_DEBUG_CONFIG?.sim?.preferControlsEx) && apiHasInputsEx) ? 'setControlsEx' : 'setControls';
      let dyn = null;
      let slips4 = null;
      let tireStateFL = null;
      try { dyn = sim.getVehicleDynamics?.(vehHandle) || null; } catch { /* ignore */ }
      try { slips4 = sim.getTireSlips4?.(vehHandle) || null; } catch { /* ignore */ }
      try { tireStateFL = sim.getTireState?.(vehHandle, 0, 0) || null; } catch { /* ignore */ }
      const oFL = Number(lastWheel?.omegaFL);
      const oFR = Number(lastWheel?.omegaFR);
      const oRL = Number(lastWheel?.omegaRL);
      const oRR = Number(lastWheel?.omegaRR);
      const steerFL = Number(lastWheel?.steerFL);
      const steerFR = Number(lastWheel?.steerFR);
      const steerFLHud = steerFL;
      const steerFRHud = steerFR;
      let simWB = NaN;
      let simTrackF = NaN;
      let simTrackR = NaN;
      let spindlePosLine = '';
      try {
        if (Array.isArray(lastSpindles) && lastSpindles.length >= 4) {
          const lf = vec3FromObj(lastSpindles[0].pos);
          const rf = vec3FromObj(lastSpindles[1].pos);
          const lr = vec3FromObj(lastSpindles[2].pos);
          const rr = vec3FromObj(lastSpindles[3].pos);
          const front = lf.clone().add(rf).multiplyScalar(0.5);
          const rear = lr.clone().add(rr).multiplyScalar(0.5);
          simWB = front.clone().sub(rear).setY(0).length();
          simTrackF = lf.clone().sub(rf).setY(0).length();
          simTrackR = lr.clone().sub(rr).setY(0).length();
          spindlePosLine = `spindle xz: FL=${fmtPosXZ(lf)} FR=${fmtPosXZ(rf)} RL=${fmtPosXZ(lr)} RR=${fmtPosXZ(rr)}`;
        }
      } catch { /* ignore */ }

      setHud(
        `Chrono WASM Drive Test (350Z skin)\n` +
        `A/D steer · W forward · S reverse · Space brake · R reset · V camera · C recenter view · O debug axes · click to mouse-look (Esc to release)\n\n` +
        `vehicle: ${safeTrim(vehRec?.kind) || '—'}   state: ${lastState ? 'ok' : '—'}   wheelState: ${lastWheel ? 'ok' : '—'}\n` +
        `spawn attempts: ${(Array.isArray(vehRec?.attempts) ? vehRec.attempts : []).map((a) => `${a.kind}:${a.ok ? 'ok' : 'fail'}(${a.jsonPath || a.reason || 'n/a'})`).join('  ') || '(none)'}\n` +
        `mesh: groundY=${fmt(meshDiag.groundOffsetY, 2)} (${safeTrim(meshDiag.groundMethod) || '—'})  bbox(xyz m)=${fmt(meshDiag.bboxSize.x, 2)},${fmt(meshDiag.bboxSize.y, 2)},${fmt(meshDiag.bboxSize.z, 2)}  centerLocal=${fmt(meshDiag.bboxCenterLocal.x, 2)},${fmt(meshDiag.bboxCenterLocal.y, 2)},${fmt(meshDiag.bboxCenterLocal.z, 2)}\n` +
        `skin wheels: found=${wheelSkin.count}/4  lf=${safeTrim(wheelSkin?.corners?.lf?.name || '—')} rf=${safeTrim(wheelSkin?.corners?.rf?.name || '—')} lr=${safeTrim(wheelSkin?.corners?.lr?.name || '—')} rr=${safeTrim(wheelSkin?.corners?.rr?.name || '—')}\n` +
        `meta: yawOffsetRad=${fmt(meshYawOffset, 3)}  anchors=${metaAnchorKeys.length}${metaAnchorKeys.length ? ` [${metaAnchorKeys.slice(0, 8).join(', ')}${metaAnchorKeys.length > 8 ? ', …' : ''}]` : ''}  debugAxes=${debugAxesOn}  stateEx=${lastPoseUsedStateEx ? 'yes' : 'no'}  y(sim)=${fmt(lastState?.y, 2)}\n` +
        `align: auto=${SIM_DEBUG_CONFIG?.visual?.autoAlignMeshToSpindles ? (meshDiag.autoAlignApplied ? 'on' : 'pending') : 'off'}  dWorld=${fmt(meshDiag.autoAlignDelta.x, 2)},${fmt(meshDiag.autoAlignDelta.y, 2)},${fmt(meshDiag.autoAlignDelta.z, 2)}\n` +
        `mesh frame err(m): max=${Number.isFinite(meshFrameMismatchLast.maxPosErr) ? fmt(meshFrameMismatchLast.maxPosErr, 3) : '—'} rms=${Number.isFinite(meshFrameMismatchLast.rmsPosErr) ? fmt(meshFrameMismatchLast.rmsPosErr, 3) : '—'} frames=${meshFrameMismatchFrames}/${MESH_FRAME_MISMATCH_LIMITS.frames} latched=${meshFrameMismatchLatched ? 'yes' : 'no'}\n` +
        `sim: wheelbase=${Number.isFinite(simWB) ? fmt(simWB, 2) : '—'}  trackF=${Number.isFinite(simTrackF) ? fmt(simTrackF, 2) : '—'}  trackR=${Number.isFinite(simTrackR) ? fmt(simTrackR, 2) : '—'}\n` +
        `raw spindle: api=${rawSpindlesApi?.apiOk ? 'ok' : 'bad'} finite=${rawSpindlesApi?.finite ? 'yes' : 'no'} plausible=${rawSpindlesApi?.plausible ? 'yes' : 'no'} canon=${rawSpindleDiag.ok ? 'ok' : 'bad'} filtered=no  badFrames=${rawBadSpindleFrames}/${RAW_SPINDLE_BAD_FRAME_LIMIT}\n` +
        `bridge spindle: reason=${spindleReasonLabel(spindleBridgeStatus?.reason)} allWheels=${spindleBridgeStatus?.allWheelsOk ? 'yes' : 'no'} sane=${spindleBridgeStatus?.sanePacket ? 'yes' : 'no'} failWheel=${wheelIdxLabel(spindleBridgeStatus?.failWheel)} failStage=${spindleFailStageLabel(spindleBridgeStatus?.failStage)} directMask=${Math.trunc(Number(spindleBridgeStatus?.directOkMask) || 0)} fallbackMask=${Math.trunc(Number(spindleBridgeStatus?.fallbackOkMask) || 0)} wb=${Number.isFinite(spindleBridgeStatus?.wb) ? fmt(spindleBridgeStatus.wb, 3) : '—'} tf=${Number.isFinite(spindleBridgeStatus?.tf) ? fmt(spindleBridgeStatus.tf, 3) : '—'} tr=${Number.isFinite(spindleBridgeStatus?.tr) ? fmt(spindleBridgeStatus.tr, 3) : '—'}\n` +
        `bridge diag: axles=${Number.isFinite(spindleBridgeDiag?.axleCount) ? fmt(spindleBridgeDiag.axleCount, 0) : '—'} spawnWheel=${wheelMaskLabel(spindleBridgeDiag?.spawnExpectedWheelMask)} spawnTire=${wheelMaskLabel(spindleBridgeDiag?.spawnExpectedTireMask)} wheelPtr=${wheelMaskLabel(spindleBridgeDiag?.wheelPtrMask)} wheelFinite=${wheelMaskLabel(spindleBridgeDiag?.wheelStateFiniteMask)} fallbackTry=${wheelMaskLabel(spindleBridgeDiag?.fallbackAttemptMask)} wsPos=${wheelMaskLabel(spindleBridgeDiag?.wsPosFiniteMask)} wsRot=${wheelMaskLabel(spindleBridgeDiag?.wsRotFiniteMask)} wsLin=${wheelMaskLabel(spindleBridgeDiag?.wsLinFiniteMask)} wsAng=${wheelMaskLabel(spindleBridgeDiag?.wsAngFiniteMask)} wsExc=${wheelMaskLabel(spindleBridgeDiag?.wsExceptionMask)}\n` +
        `bridge direct/body: dPos=${wheelMaskLabel(spindleBridgeDiag?.directPosFiniteMask)} dRot=${wheelMaskLabel(spindleBridgeDiag?.directRotFiniteMask)} dLin=${wheelMaskLabel(spindleBridgeDiag?.directLinFiniteMask)} dAng=${wheelMaskLabel(spindleBridgeDiag?.directAngFiniteMask)} dExc=${wheelMaskLabel(spindleBridgeDiag?.directExceptionMask)} sbTry=${wheelMaskLabel(spindleBridgeDiag?.spindleBodyAttemptMask)} sbPos=${wheelMaskLabel(spindleBridgeDiag?.spindleBodyPosFiniteMask)} sbRot=${wheelMaskLabel(spindleBridgeDiag?.spindleBodyRotFiniteMask)} sbLin=${wheelMaskLabel(spindleBridgeDiag?.spindleBodyLinFiniteMask)} sbAng=${wheelMaskLabel(spindleBridgeDiag?.spindleBodyAngFiniteMask)} sbExc=${wheelMaskLabel(spindleBridgeDiag?.spindleBodyExceptionMask)}\n` +
        `bridge heal: total=${Math.trunc(Number(spindleBridgeDiag?.healEventsTotal) || 0)} pre=${Math.trunc(Number(spindleBridgeDiag?.healEventsPre) || 0)} post=${Math.trunc(Number(spindleBridgeDiag?.healEventsPost) || 0)} last=${spindleHealStageLabel(spindleBridgeDiag?.healLastStage)} mask=${wheelMaskLabel(spindleBridgeDiag?.healLastWheelMask)} pos=${Math.trunc(Number(spindleBridgeDiag?.healPosEvents) || 0)} rot=${Math.trunc(Number(spindleBridgeDiag?.healRotEvents) || 0)} lin=${Math.trunc(Number(spindleBridgeDiag?.healLinEvents) || 0)} ang=${Math.trunc(Number(spindleBridgeDiag?.healAngEvents) || 0)}\n` +
        `spindle order: native=${rawSpindleDiagNative.ok ? 'ok' : 'bad'} canon=${rawSpindleDiag.ok ? 'ok' : 'bad'} reordered=${rawSpindleCanon?.reordered ? 'yes' : 'no'} plausible=${rawSpindleCanon ? (rawSpindleCanon.plausible ? 'yes' : 'no') : 'n/a'}\n` +
        `bridge version: ${bridgeDiagVersion || '—'}\n` +
        `api coverage: ${apiCoverage.availableCount}/${apiCoverage.total} available  used=${apiCoverage.usedCount}  unused=${apiCoverage.unusedCount}  missing=${apiCoverage.missingCount}\n` +
        `api missing: ${apiCoverage.missing.join(', ') || '(none)'}\n` +
        `api unused: ${apiCoverage.unused.join(', ') || '(none)'}\n` +
        `bridge proxy: active=${driveProxyDiag?.active ? 'yes' : 'no'} speed=${Number.isFinite(driveProxyDiag?.speed) ? fmt(driveProxyDiag.speed, 2) : '—'} yawRate=${Number.isFinite(driveProxyDiag?.yawRate) ? fmt(driveProxyDiag.yawRate, 3) : '—'} posC=${Number.isFinite(driveProxyDiag?.proxyPosChrono?.x) ? fmt(driveProxyDiag.proxyPosChrono.x, 2) : '—'},${Number.isFinite(driveProxyDiag?.proxyPosChrono?.y) ? fmt(driveProxyDiag.proxyPosChrono.y, 2) : '—'},${Number.isFinite(driveProxyDiag?.proxyPosChrono?.z) ? fmt(driveProxyDiag.proxyPosChrono.z, 2) : '—'} calls[s=${Number.isFinite(driveProxyDiag?.stateCalls) ? fmt(driveProxyDiag.stateCalls, 0) : '—'}/${Number.isFinite(driveProxyDiag?.stateOk) ? fmt(driveProxyDiag.stateOk, 0) : '—'}, sx=${Number.isFinite(driveProxyDiag?.stateExCalls) ? fmt(driveProxyDiag.stateExCalls, 0) : '—'}/${Number.isFinite(driveProxyDiag?.stateExOk) ? fmt(driveProxyDiag.stateExOk, 0) : '—'}, w=${Number.isFinite(driveProxyDiag?.wheelCalls) ? fmt(driveProxyDiag.wheelCalls, 0) : '—'}/${Number.isFinite(driveProxyDiag?.wheelOk) ? fmt(driveProxyDiag.wheelOk, 0) : '—'}, p=${Number.isFinite(driveProxyDiag?.powertrainCalls) ? fmt(driveProxyDiag.powertrainCalls, 0) : '—'}/${Number.isFinite(driveProxyDiag?.powertrainOk) ? fmt(driveProxyDiag.powertrainOk, 0) : '—'}]\n` +
        `resets: count=${resetCount} last=${lastResetReason}  inertAutoRespawn=${SIM_DEBUG_CONFIG?.sim?.enableInertAutoRespawn ? 'on' : 'off'}\n` +
        `fs: ${fsHas.fs} (exported:${!!FS}, analyze:${fsCanAnalyze})   rt: path=${fsRt.createPath} file=${fsRt.createDataFile}\n` +
        `data: 350z_manifest=${chronoSpec ? 'loaded' : 'missing'}\n\n` +
        `chrono manifest: ${chronoSpec?.manifestUrl || chronoManifestUrl || '(none)'}\n` +
        `chrono vehicle spec: ${chronoSpec?.jsonPath || '(not loaded)'}\n\n` +
        `chrono vehicle source: ${chronoSpec?.sourceJsonPath || chronoSpec?.jsonPath || '(not loaded)'}\n` +
        `chrono tire spec: ${chronoSpec?.tireJsonPath || '(not loaded)'}\n` +
        `chrono ptrain: engine=${chronoSpec?.powertrain?.enginePath || '(none)'} trans=${chronoSpec?.powertrain?.transPath || '(none)'} type=${chronoSpec?.powertrain?.engineType || '—'}/${chronoSpec?.powertrain?.transType || '—'} mapP0=${Number.isFinite(chronoSpec?.powertrain?.mapP0?.rpm) ? fmt(chronoSpec.powertrain.mapP0.rpm, 0) : '—'},${Number.isFinite(chronoSpec?.powertrain?.mapP0?.tq) ? fmt(chronoSpec.powertrain.mapP0.tq, 1) : '—'} mapP1=${Number.isFinite(chronoSpec?.powertrain?.mapP1?.rpm) ? fmt(chronoSpec.powertrain.mapP1.rpm, 0) : '—'},${Number.isFinite(chronoSpec?.powertrain?.mapP1?.tq) ? fmt(chronoSpec.powertrain.mapP1.tq, 1) : '—'}\n` +
        `pre-spawn geom: wb=${Number.isFinite(chronoSpec?.geom?.wheelbase) ? fmt(chronoSpec.geom.wheelbase, 3) : '—'} tf=${Number.isFinite(chronoSpec?.geom?.frontTrack) ? fmt(chronoSpec.geom.frontTrack, 3) : '—'} tr=${Number.isFinite(chronoSpec?.geom?.rearTrack) ? fmt(chronoSpec.geom.rearTrack, 3) : '—'} src=${safeTrim(chronoSpec?.geom?.trackSource) || 'unknown'} hold=${inSpawnHold ? 'yes' : 'no'}\n` +
        `geom delta: dWb=${(Number.isFinite(simWB) && Number.isFinite(chronoSpec?.geom?.wheelbase)) ? fmt(Math.abs(simWB - chronoSpec.geom.wheelbase), 3) : '—'} dTf=${(Number.isFinite(simTrackF) && Number.isFinite(chronoSpec?.geom?.frontTrack)) ? fmt(Math.abs(simTrackF - chronoSpec.geom.frontTrack), 3) : '—'} dTr=${(Number.isFinite(simTrackR) && Number.isFinite(chronoSpec?.geom?.rearTrack)) ? fmt(Math.abs(simTrackR - chronoSpec.geom.rearTrack), 3) : '—'}  mismatchFrames=${geomMismatchFrames}/${GEOM_MISMATCH_LIMITS.frames}\n` +
        `hardpoints: mode=${safeTrim(chronoSpec?.hardpoints?.mode) || 'unknown'} requested=${chronoSpec?.hardpoints?.requested ? 'yes' : 'no'} front(applied=${chronoSpec?.hardpoints?.frontApplied ? 'yes' : 'no'} geomOk=${chronoSpec?.hardpoints?.frontGeomOk ? 'yes' : 'no'} partial=${chronoSpec?.hardpoints?.frontPartial ? 'yes' : 'no'}) rear(applied=${chronoSpec?.hardpoints?.rearApplied ? 'yes' : 'no'} geomOk=${chronoSpec?.hardpoints?.rearGeomOk ? 'yes' : 'no'} partial=${chronoSpec?.hardpoints?.rearPartial ? 'yes' : 'no'})\n\n` +
        `input: W=${forward ? '1' : '0'} S=${back ? '1' : '0'} A=${left ? '1' : '0'} D=${right ? '1' : '0'} Space=${handbrake ? '1' : '0'} park=${lastParkingBrakeCommand ? '1' : '0'}\n` +
        `control: mode=${manualTestMode ? 'manual_test' : 'auto'} gearCmd=${manualTestMode ? fmt(manualGearIndex, 0) : fmt(lastDriveMode, 0)} clutch=${fmt(clutchCmd, 2)}\n` +
        `speed m/s: ${fmt(spdMag, 2)}   signedFwd: ${fmt(spdSigned, 2)}   mph: ${fmt(spdMag * 2.236936, 1)}\n` +
        `throttle: ${fmt(cmd.throttle, 2)}   brake: ${fmt(cmd.brake, 2)}   steer: ${fmt(steer, 2)} (~${fmt(steerDeg, 0)}°)\n` +
        `yaw(deg): ${fmt(yawDeg, 1)}\n` +
        `powertrain: trans=${hasTr} hasEngine=${ptHasEngine} type=${Number.isFinite(ptType) ? fmt(ptType, 0) : '—'} shiftMode=${Number.isFinite(ptShift) ? fmt(ptShift, 0) : '—'} driveMode=${Number.isFinite(ptDrive) ? fmt(ptDrive, 0) : '—'} targetDrive=${fmt(lastDriveMode, 0)} gear=${Number.isFinite(trGear) ? fmt(trGear, 0) : '—'} driveshaftNm=${Number.isFinite(tx) ? fmt(tx, 0) : '—'} motorshaftRpm=${Number.isFinite(engRpm) ? fmt(engRpm, 0) : '—'}\n` +
        `powertrain detail: engineRpm=${Number.isFinite(ptEngineRpm) ? fmt(ptEngineRpm, 0) : '—'} engineNm=${Number.isFinite(ptEngineTq) ? fmt(ptEngineTq, 0) : '—'} tc=${ptHasTc ? 'yes' : 'no'} tcOutNm=${Number.isFinite(ptTcOutTq) ? fmt(ptTcOutTq, 0) : '—'} tcOutRpm=${Number.isFinite(ptTcOutRpm) ? fmt(ptTcOutRpm, 0) : '—'} tcSlip=${Number.isFinite(ptTcSlip) ? fmt(ptTcSlip, 3) : '—'}\n` +
        `powertrain source: ${authoredPowertrainApplied ? 'authored_simplemap' : 'authored_json'}  strictChrono=${STRICT_CHRONO_MODE ? 'yes' : 'no'}  nativeOnly=${STRICT_DEBUG_NATIVE_ONLY ? 'yes' : 'no'}  inertFrames=${noDriveResponseFrames} inertSec=${fmt(noDriveResponseSec, 2)}  clutchCmd=${fmt(clutchCmd, 2)} flipTried=${clutchFlipTried ? 'yes' : 'no'}  inputsMode=${inputsModeLabel}\n` +
        `bridge ptrain: in(thr=${Number.isFinite(lastWheel?.inputThrottleBridge) ? fmt(lastWheel.inputThrottleBridge, 2) : '—'} brk=${Number.isFinite(lastWheel?.inputBrakeBridge) ? fmt(lastWheel.inputBrakeBridge, 2) : '—'} clu=${Number.isFinite(lastWheel?.inputClutchBridge) ? fmt(lastWheel.inputClutchBridge, 2) : '—'}) inert=${Number.isFinite(lastWheel?.ptrainInertFrames) ? fmt(lastWheel.ptrainInertFrames, 0) : '—'} events=${Number.isFinite(lastWheel?.ptrainBootstrapEvents) ? fmt(lastWheel.ptrainBootstrapEvents, 0) : '—'} fixed=${lastWheel?.chassisIsFixedBridge ? 'yes' : 'no'} massKg=${Number.isFinite(lastWheel?.chassisMassBridgeKg) ? fmt(lastWheel.chassisMassBridgeKg, 1) : '—'}\n` +
        `vehicle dyn: roll=${Number.isFinite(dyn?.roll) ? fmt(dyn.roll, 3) : '—'} pitch=${Number.isFinite(dyn?.pitch) ? fmt(dyn.pitch, 3) : '—'} slip=${Number.isFinite(dyn?.slipAngle) ? fmt(dyn.slipAngle, 3) : '—'} yawRate=${Number.isFinite(dyn?.yawRate) ? fmt(dyn.yawRate, 3) : '—'} turnRate=${Number.isFinite(dyn?.turnRate) ? fmt(dyn.turnRate, 3) : '—'}\n` +
        `tire slips4: FL=${Number.isFinite(slips4?.FL?.slipAngle) ? fmt(slips4.FL.slipAngle, 3) : '—'}/${Number.isFinite(slips4?.FL?.longSlip) ? fmt(slips4.FL.longSlip, 3) : '—'} FR=${Number.isFinite(slips4?.FR?.slipAngle) ? fmt(slips4.FR.slipAngle, 3) : '—'}/${Number.isFinite(slips4?.FR?.longSlip) ? fmt(slips4.FR.longSlip, 3) : '—'} RL=${Number.isFinite(slips4?.RL?.slipAngle) ? fmt(slips4.RL.slipAngle, 3) : '—'}/${Number.isFinite(slips4?.RL?.longSlip) ? fmt(slips4.RL.longSlip, 3) : '—'} RR=${Number.isFinite(slips4?.RR?.slipAngle) ? fmt(slips4.RR.slipAngle, 3) : '—'}/${Number.isFinite(slips4?.RR?.longSlip) ? fmt(slips4.RR.longSlip, 3) : '—'}\n` +
        `tire FL: sa=${Number.isFinite(tireStateFL?.slipAngle) ? fmt(tireStateFL.slipAngle, 3) : '—'} ls=${Number.isFinite(tireStateFL?.longSlip) ? fmt(tireStateFL.longSlip, 3) : '—'} camber=${Number.isFinite(tireStateFL?.camber) ? fmt(tireStateFL.camber, 3) : '—'} Fz=${Number.isFinite(tireStateFL?.force?.y) ? fmt(tireStateFL.force.y, 1) : '—'}\n` +
        `wheel steer(rad): FL=${Number.isFinite(steerFLHud) ? fmt(steerFLHud, 3) : '—'} FR=${Number.isFinite(steerFRHud) ? fmt(steerFRHud, 3) : '—'}   spindle=${Array.isArray(lastSpindles) ? 'ok' : '—'}\n` +
        `wheel omega(rad/s): FL=${Number.isFinite(oFL) ? fmt(oFL, 1) : '—'} FR=${Number.isFinite(oFR) ? fmt(oFR, 1) : '—'} RL=${Number.isFinite(oRL) ? fmt(oRL, 1) : '—'} RR=${Number.isFinite(oRR) ? fmt(oRR, 1) : '—'}\n` +
        `${spindlePosLine || 'spindle xz: —'}\n` +
        `${formatGeomTraceSummary(geomTrace)}\n` +
        `car: ${CAR_URL}\n`,
      );
    }

    try { renderer.render(scene, camera); } catch (e) {
      const msg = (e && typeof e === 'object' && 'stack' in e) ? String(e.stack || e) : String(e);
      setHud(`Render error:\n${msg}`);
      try { setDebugVisible(true); } catch { /* ignore */ }
    }
  };

  tick();
}

main().catch((e) => {
  const hud = /** @type {HTMLDivElement|null} */ (document.getElementById('hud'));
  const msg = (e && typeof e === 'object' && 'stack' in e) ? String(e.stack || e) : String(e);
  if (hud) hud.textContent = `Fatal error:\n${msg}`;
  // eslint-disable-next-line no-console
  console.error(e);
});
