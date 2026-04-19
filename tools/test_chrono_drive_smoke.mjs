#!/usr/bin/env node
import { spawn } from 'node:child_process';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import process from 'node:process';
import { chromium } from 'playwright';

const EXPLICIT_BASE_URL = process.env.CHRONO_TEST_BASE_URL || '';
const EXPLICIT_PAGE_URL = process.env.CHRONO_TEST_PAGE_URL || '';
const START_SERVER = String(process.env.CHRONO_TEST_START_SERVER || '1') !== '0';
const LOAD_TIMEOUT_MS = Number(process.env.CHRONO_TEST_LOAD_TIMEOUT_MS || 120000);
const HOLD_W_MS = Number(process.env.CHRONO_TEST_HOLD_W_MS || 9000);
const HOLD_A_MS = Number(process.env.CHRONO_TEST_HOLD_A_MS || 800);
const HOLD_S_MS = Number(process.env.CHRONO_TEST_HOLD_S_MS || 4500);
const HOLD_SPACE_MS = Number(process.env.CHRONO_TEST_HOLD_SPACE_MS || 1800);
const COAST_CHECK_MS = Number(process.env.CHRONO_TEST_COAST_CHECK_MS || 2500);
const SAMPLE_INTERVAL_MS = Number(process.env.CHRONO_TEST_SAMPLE_INTERVAL_MS || 250);
const COAST_EXPECT_RELEASE_SPEED_MPS = Number(process.env.CHRONO_TEST_COAST_EXPECT_RELEASE_SPEED_MPS || 1.0);
const COAST_MIN_SPEED_MPS = Number(process.env.CHRONO_TEST_COAST_MIN_SPEED_MPS || 0.35);
const MIN_SPINDLE_CENTER_DISPLACEMENT_M = Number(process.env.CHRONO_TEST_MIN_SPINDLE_CENTER_DISPLACEMENT_M || 0.6);
const MIN_REVERSE_SUSTAINED_SAMPLES = Number(process.env.CHRONO_TEST_MIN_REVERSE_SUSTAINED_SAMPLES || 3);
const BRAKE_STOP_SPEED_MPS = Number(process.env.CHRONO_TEST_BRAKE_STOP_SPEED_MPS || 0.25);
const BRAKE_STOP_MAX_OMEGA = Number(process.env.CHRONO_TEST_BRAKE_STOP_MAX_OMEGA || 0.8);
const BRAKE_STOP_CONSECUTIVE_SAMPLES = Number(process.env.CHRONO_TEST_BRAKE_STOP_CONSECUTIVE_SAMPLES || 3);
const MIN_MOTION_SPEED_MPS = Number(process.env.CHRONO_TEST_MIN_MOTION_SPEED_MPS || 0.8);
const MIN_SUSTAINED_MOTION_SAMPLES = Number(process.env.CHRONO_TEST_MIN_SUSTAINED_MOTION_SAMPLES || 8);
const MAX_HEALTH_FAILURES_DURING_MOTION = Number(process.env.CHRONO_TEST_MAX_HEALTH_FAILURES || 1);
const MAX_STALL_SAMPLE_RATIO = Number(process.env.CHRONO_TEST_MAX_STALL_SAMPLE_RATIO || 0.6);
const MAX_CONSECUTIVE_STALL_SAMPLES = Number(process.env.CHRONO_TEST_MAX_CONSECUTIVE_STALL_SAMPLES || 5);
const MAX_REASONABLE_SPEED_MPS = Number(process.env.CHRONO_TEST_MAX_REASONABLE_SPEED_MPS || 130.0);
const IDLE_CHECK_MS = Number(process.env.CHRONO_TEST_IDLE_CHECK_MS || 1400);
const IDLE_MAX_SPEED_MPS = Number(process.env.CHRONO_TEST_IDLE_MAX_SPEED_MPS || 0.20);
const IDLE_MAX_OMEGA_RAD_PER_S = Number(process.env.CHRONO_TEST_IDLE_MAX_OMEGA_RAD_PER_S || 0.75);
const IDLE_MAX_ENGINE_RPM = Number(process.env.CHRONO_TEST_IDLE_MAX_ENGINE_RPM || 2200);
const MIN_ENGINE_RPM_UNDER_THROTTLE = Number(process.env.CHRONO_TEST_MIN_ENGINE_RPM_UNDER_THROTTLE || 900);
const MIN_DRIVESHAFT_NM_UNDER_THROTTLE = Number(process.env.CHRONO_TEST_MIN_DRIVESHAFT_NM_UNDER_THROTTLE || 25);
const MIN_THROTTLE_DRIVETRAIN_SAMPLES = Number(process.env.CHRONO_TEST_MIN_THROTTLE_DRIVETRAIN_SAMPLES || 4);
const MIN_REVERSE_GEAR_ACK_SAMPLES = Number(process.env.CHRONO_TEST_MIN_REVERSE_GEAR_ACK_SAMPLES || 2);
const BRAKE_ALL_WHEELS_MAX_OMEGA = Number(process.env.CHRONO_TEST_BRAKE_ALL_WHEELS_MAX_OMEGA || 1.0);
const STRICT_BRIDGE_REASON = String(process.env.CHRONO_TEST_STRICT_BRIDGE_REASON || '0') !== '0';
const REQUIRE_DIRECT_BRIDGE_WHEELS = String(process.env.CHRONO_TEST_REQUIRE_DIRECT_BRIDGE_WHEELS || '0') !== '0';
const REQUIRE_ALL_WHEELS_VISUAL_ROLL = String(process.env.CHRONO_TEST_REQUIRE_ALL_WHEELS_VISUAL_ROLL || '1') !== '0';
const VISUAL_MIN_ROLL_DELTA_RAD = Number(process.env.CHRONO_TEST_VISUAL_MIN_ROLL_DELTA_RAD || 0.08);
const VISUAL_MIN_STEER_DELTA_RAD = Number(process.env.CHRONO_TEST_VISUAL_MIN_STEER_DELTA_RAD || 0.03);
const VISUAL_MIN_CENTER_DISP_M = Number(process.env.CHRONO_TEST_VISUAL_MIN_CENTER_DISP_M || 0.6);
const VISUAL_MIN_OMEGA_FOR_ROLL_RAD_PER_S = Number(process.env.CHRONO_TEST_VISUAL_MIN_OMEGA_FOR_ROLL_RAD_PER_S || 2.0);
const VISUAL_RECENTER_MAX_DELTA_RAD = Number(process.env.CHRONO_TEST_VISUAL_RECENTER_MAX_DELTA_RAD || 0.12);
const DEFAULT_BASE_URL = 'http://127.0.0.1:5179';
const TEST_PORT_START = Number(process.env.CHRONO_TEST_PORT_START || 5190);
const TEST_PORT_END = Number(process.env.CHRONO_TEST_PORT_END || 5290);
const WHEEL_IDS = ['lf', 'rf', 'lr', 'rr'];

function parseYesNo(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'yes') return true;
  if (s === 'no') return false;
  return null;
}

function parsePoint2(raw) {
  const m = String(raw || '').match(/\s*([\-0-9.]+)\s*,\s*([\-0-9.]+)\s*/);
  if (!m) return null;
  const x = Number(m[1]);
  const z = Number(m[2]);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return { x, z };
}

function dist2(a, b) {
  if (!a || !b) return NaN;
  const dx = Number(a.x) - Number(b.x);
  const dz = Number(a.z) - Number(b.z);
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) return NaN;
  return Math.hypot(dx, dz);
}

function qAngle(a, b) {
  if (!a || !b) return NaN;
  const ax = Number(a.qx);
  const ay = Number(a.qy);
  const az = Number(a.qz);
  const aw = Number(a.qw);
  const bx = Number(b.qx);
  const by = Number(b.qy);
  const bz = Number(b.qz);
  const bw = Number(b.qw);
  if (![ax, ay, az, aw, bx, by, bz, bw].every(Number.isFinite)) return NaN;
  const dot = Math.abs((ax * bx) + (ay * by) + (az * bz) + (aw * bw));
  const clamped = Math.min(1, Math.max(-1, dot));
  return 2 * Math.acos(clamped);
}

function cornerQuat(corner, useLocal = false) {
  if (!corner) return null;
  const pre = useLocal ? 'lq' : 'q';
  const q = {
    qx: Number(corner?.[`${pre}x`]),
    qy: Number(corner?.[`${pre}y`]),
    qz: Number(corner?.[`${pre}z`]),
    qw: Number(corner?.[`${pre}w`]),
  };
  if (![q.qx, q.qy, q.qz, q.qw].every(Number.isFinite)) return null;
  return q;
}

function cornerDelta(v0, v1, id, useLocal = false) {
  return qAngle(
    cornerQuat(v0?.corners?.[id], useLocal),
    cornerQuat(v1?.corners?.[id], useLocal),
  );
}

function isValidWheelVisualSnapshot(v) {
  if (!v?.available || Number(v?.count || 0) < 4) return false;
  for (const id of WHEEL_IDS) {
    const c = v?.corners?.[id];
    if (!c) return false;
    if (!cornerQuat(c, false) || !cornerQuat(c, true)) return false;
    const px = Number(c?.px);
    const py = Number(c?.py);
    const pz = Number(c?.pz);
    if (![px, py, pz].every(Number.isFinite)) return false;
  }
  return true;
}

function meanAbsOmega(samples, wheelId) {
  const idx = { lf: 0, rf: 1, lr: 2, rr: 3 }[wheelId];
  if (!Number.isInteger(idx)) return NaN;
  let n = 0;
  let sum = 0;
  for (const s of (samples || [])) {
    const w = Number(s?.omegas?.[idx]);
    if (!Number.isFinite(w)) continue;
    n++;
    sum += Math.abs(w);
  }
  return n > 0 ? (sum / n) : NaN;
}

function wheelVisualCenter(v) {
  let n = 0;
  let x = 0;
  let z = 0;
  for (const id of ['lf', 'rf', 'lr', 'rr']) {
    const c = v?.corners?.[id];
    const px = Number(c?.px);
    const pz = Number(c?.pz);
    if (!Number.isFinite(px) || !Number.isFinite(pz)) continue;
    x += px;
    z += pz;
    n++;
  }
  if (n < 4) return null;
  return { x: x / n, z: z / n };
}

function parseHud(hudText) {
  const txt = String(hudText || '');
  const num = (re) => {
    const m = txt.match(re);
    return m ? Number(m[1]) : NaN;
  };
  const speed = num(/speed m\/s:\s*([\-0-9.]+)/i);
  const signedFwd = num(/signedFwd:\s*([\-0-9.]+)/i);
  const engineRpm = num(/powertrain detail:\s*engineRpm=([\-0-9.]+)/i);
  const driveshaftNm = num(/powertrain:.*?\bdriveshaftNm=([\-0-9.]+)/i);
  const steerCmd = num(/throttle:\s*[\-0-9.]+\s+brake:\s*[\-0-9.]+\s+steer:\s*([\-0-9.]+)/i);
  const keyW = num(/input:\s*W=([01])/i);
  const keyS = num(/input:\s*W=[01]\s+S=([01])/i);
  const keyA = num(/input:\s*W=[01]\s+S=[01]\s+A=([01])/i);
  const keyD = num(/input:\s*W=[01]\s+S=[01]\s+A=[01]\s+D=([01])/i);
  const keySpace = num(/input:\s*W=[01]\s+S=[01]\s+A=[01]\s+D=[01]\s+Space=([01])/i);
  const park = num(/input:\s*W=[01]\s+S=[01]\s+A=[01]\s+D=[01]\s+Space=[01]\s+park=([01])/i);
  const gear = num(/powertrain:.*?\bgear=([\-0-9.]+)/i);
  const driveMode = num(/powertrain:.*?\bdriveMode=([\-0-9.]+)/i);
  const steerWheelLine = txt.match(/wheel steer\(rad\):\s*FL=([\-0-9.]+)\s+FR=([\-0-9.]+)/i);
  const steerFL = steerWheelLine ? Number(steerWheelLine[1]) : NaN;
  const steerFR = steerWheelLine ? Number(steerWheelLine[2]) : NaN;
  const holdMatch = txt.match(/pre-spawn geom:.*\bhold=(yes|no)\b/i);
  const inSpawnHold = holdMatch ? String(holdMatch[1]).toLowerCase() === 'yes' : false;
  const wheelLine = txt.match(/wheel omega\(rad\/s\):\s*FL=([\-0-9.]+)\s+FR=([\-0-9.]+)\s+RL=([\-0-9.]+)\s+RR=([\-0-9.]+)/i);
  const omegas = wheelLine ? wheelLine.slice(1).map((s) => Number(s)) : [NaN, NaN, NaN, NaN];
  const maxOmega = Math.max(...omegas.map((x) => (Number.isFinite(x) ? Math.abs(x) : 0)));
  const spindleLine = txt.match(/spindle xz:\s*FL=\(([^)]+)\)\s+FR=\(([^)]+)\)\s+RL=\(([^)]+)\)\s+RR=\(([^)]+)\)/i);
  const spindleFL = spindleLine ? parsePoint2(spindleLine[1]) : null;
  const spindleFR = spindleLine ? parsePoint2(spindleLine[2]) : null;
  const spindleRL = spindleLine ? parsePoint2(spindleLine[3]) : null;
  const spindleRR = spindleLine ? parsePoint2(spindleLine[4]) : null;
  const spindleCenter = (spindleFL && spindleFR && spindleRL && spindleRR)
    ? {
      x: 0.25 * (spindleFL.x + spindleFR.x + spindleRL.x + spindleRR.x),
      z: 0.25 * (spindleFL.z + spindleFR.z + spindleRL.z + spindleRR.z),
    }
    : null;
  const rawLine = txt.match(/raw spindle:\s*api=(ok|bad)\s+finite=(yes|no)\s+plausible=(yes|no).*?\bbadFrames=([0-9]+)\/([0-9]+)/i);
  const bridgeLine = txt.match(/bridge spindle:\s*reason=([a-z0-9_.-]+)\s+allWheels=(yes|no)\s+sane=(yes|no)/i);
  const bridgeMasks = txt.match(/bridge spindle:.*?\bdirectMask=([0-9]+)\s+fallbackMask=([0-9]+)/i);
  const geomLine = txt.match(/geom delta:.*\bmismatchFrames=([0-9]+)\/([0-9]+)/i);
  const geomTraceLine = txt.match(/geom trace:\s*n=([0-9]+)/i);
  return {
    txt,
    speed,
    signedFwd,
    engineRpm,
    driveshaftNm,
    steerCmd,
    keyW,
    keyS,
    keyA,
    keyD,
    keySpace,
    park,
    gear,
    driveMode,
    steerFL,
    steerFR,
    inSpawnHold,
    omegas,
    maxOmega,
    rawApiOk: rawLine ? String(rawLine[1]).toLowerCase() === 'ok' : null,
    rawFinite: rawLine ? parseYesNo(rawLine[2]) : null,
    rawPlausible: rawLine ? parseYesNo(rawLine[3]) : null,
    rawBadFrames: rawLine ? Number(rawLine[4]) : NaN,
    rawBadFrameLimit: rawLine ? Number(rawLine[5]) : NaN,
    bridgeReason: bridgeLine ? String(bridgeLine[1]).toLowerCase() : '',
    bridgeAllWheels: bridgeLine ? parseYesNo(bridgeLine[2]) : null,
    bridgeSane: bridgeLine ? parseYesNo(bridgeLine[3]) : null,
    bridgeDirectMask: bridgeMasks ? Number(bridgeMasks[1]) : NaN,
    bridgeFallbackMask: bridgeMasks ? Number(bridgeMasks[2]) : NaN,
    geomMismatchFrames: geomLine ? Number(geomLine[1]) : NaN,
    geomMismatchLimit: geomLine ? Number(geomLine[2]) : NaN,
    geomTraceN: geomTraceLine ? Number(geomTraceLine[1]) : NaN,
    spindleCenter,
    hasFatalError: /fatal error:/i.test(txt),
    hasMotionBreakSignal: /raw spindle stream is unhealthy|sim spindle geometry became invalid|source-vs-sim geometry mismatch|fatal error:/i.test(txt),
  };
}

function evaluateMotionHealth(snap) {
  const issues = [];
  if (snap.hasFatalError) issues.push('fatal');
  if (snap.hasMotionBreakSignal) issues.push('break_signal');
  if (snap.rawApiOk === false) issues.push('raw_api_bad');
  if (snap.rawFinite === false) issues.push('raw_non_finite');
  if (snap.rawPlausible === false) issues.push('raw_implausible');
  if (
    Number.isFinite(snap.rawBadFrames)
    && Number.isFinite(snap.rawBadFrameLimit)
    && snap.rawBadFrames > snap.rawBadFrameLimit
  ) {
    issues.push('raw_bad_frames_exceeded');
  }
  if (snap.bridgeReason && !snap.bridgeReason.startsWith('ok')) issues.push(`bridge_reason_${snap.bridgeReason}`);
  if (STRICT_BRIDGE_REASON && snap.bridgeReason && snap.bridgeReason !== 'ok') {
    issues.push(`bridge_reason_not_strict_ok_${snap.bridgeReason}`);
  }
  if (snap.bridgeAllWheels === false) issues.push('bridge_all_wheels_no');
  if (snap.bridgeSane === false) issues.push('bridge_sane_no');
  if (
    REQUIRE_DIRECT_BRIDGE_WHEELS
    && Number.isFinite(snap.bridgeDirectMask)
    && snap.bridgeDirectMask === 0
    && Number.isFinite(snap.bridgeFallbackMask)
    && snap.bridgeFallbackMask > 0
  ) {
    issues.push('bridge_direct_mask_zero_fallback_only');
  }
  if (
    Number.isFinite(snap.geomMismatchFrames)
    && Number.isFinite(snap.geomMismatchLimit)
    && snap.geomMismatchFrames >= snap.geomMismatchLimit
  ) {
    issues.push('geom_mismatch_latched');
  }
  if (!Number.isFinite(snap.speed) || Math.abs(snap.speed) > MAX_REASONABLE_SPEED_MPS) issues.push('speed_invalid');
  return issues;
}

async function waitForUrl(url, timeoutMs) {
  const start = Date.now();
  while ((Date.now() - start) < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) return true;
    } catch {
      // keep polling
    }
    await sleep(500);
  }
  return false;
}

async function isPortFree(port, host = '127.0.0.1') {
  return await new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ host, port }, () => {
      srv.close(() => resolve(true));
    });
  });
}

async function findFreePort(startPort, endPort) {
  for (let p = startPort; p <= endPort; p++) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await isPortFree(p);
    if (ok) return p;
  }
  // Fallback to OS-assigned ephemeral port so E2E can still run on busy CI/dev hosts.
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', (e) => reject(e));
    srv.listen({ host: '127.0.0.1', port: 0 }, () => {
      try {
        const addr = srv.address();
        const p = Number(addr?.port) || 0;
        srv.close(() => {
          if (p > 0) resolve(p);
          else reject(new Error(`No free port in range ${startPort}-${endPort} and failed to acquire ephemeral port`));
        });
      } catch (e) {
        try { srv.close(); } catch { /* ignore */ }
        reject(e);
      }
    });
  });
}

async function stopProcessGroup(childProc) {
  if (!childProc?.pid) return;
  const pgid = -Math.abs(childProc.pid);
  try {
    process.kill(pgid, 'SIGTERM');
  } catch {
    return;
  }
  for (let i = 0; i < 10; i++) {
    await sleep(100);
    try {
      process.kill(pgid, 0);
    } catch {
      return;
    }
  }
  try {
    process.kill(pgid, 'SIGKILL');
  } catch {
    // ignore; group is already gone or permission denied
  }
}

async function main() {
  let devServer = null;
  let browser = null;
  let pageUrl = EXPLICIT_PAGE_URL;
  let baseUrl = EXPLICIT_BASE_URL || DEFAULT_BASE_URL;
  try {
    if (START_SERVER) {
      if (!EXPLICIT_BASE_URL && !EXPLICIT_PAGE_URL) {
        const port = await findFreePort(TEST_PORT_START, TEST_PORT_END);
        baseUrl = `http://127.0.0.1:${port}`;
      }
      if (!pageUrl) pageUrl = `${baseUrl}/chrono_wasm_drive_test.html`;
      const port = Number(new URL(baseUrl).port || 80);
      devServer = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
        stdio: 'ignore',
        detached: true,
        env: process.env,
      });
      const ok = await waitForUrl(pageUrl, LOAD_TIMEOUT_MS);
      if (!ok) throw new Error(`Drive test page not reachable: ${pageUrl}`);
    } else if (!pageUrl) {
      pageUrl = `${baseUrl}/chrono_wasm_drive_test.html`;
    }

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: LOAD_TIMEOUT_MS });
    await page.waitForSelector('#hud', { timeout: LOAD_TIMEOUT_MS });
    await page.waitForSelector('#glCanvas', { timeout: LOAD_TIMEOUT_MS });

    // Wait until the HUD has full simulation diagnostics.
    const start = Date.now();
    while ((Date.now() - start) < LOAD_TIMEOUT_MS) {
      const hudText = await page.locator('#hud').textContent();
      if (String(hudText || '').includes('powertrain:')) break;
      await sleep(300);
    }

    const keyFromCode = (code) => {
      if (code === 'Space') return ' ';
      return String(code || '').replace(/^Key/, '').toLowerCase();
    };
    const keyDown = async (code) => {
      try { await page.keyboard.down(keyFromCode(code)); } catch { /* ignore */ }
      await page.evaluate((c) => {
        window.dispatchEvent(new KeyboardEvent('keydown', {
          code: c,
          key: c.replace(/^Key/, ''),
          bubbles: true,
          cancelable: true,
        }));
      }, code);
    };
    const keyUp = async (code) => {
      try { await page.keyboard.up(keyFromCode(code)); } catch { /* ignore */ }
      await page.evaluate((c) => {
        window.dispatchEvent(new KeyboardEvent('keyup', {
          code: c,
          key: c.replace(/^Key/, ''),
          bubbles: true,
          cancelable: true,
        }));
      }, code);
    };
    const getWheelVisual = async () => {
      return await page.evaluate(() => {
        const w = window?.__chronoDebug?.wheelVisual;
        return w ? JSON.parse(JSON.stringify(w)) : null;
      });
    };

    await page.click('#glCanvas');
    await keyUp('KeyW');
    await keyUp('KeyA');
    await keyUp('KeyS');
    await keyUp('KeyD');
    await keyUp('Space');
    const initialWheelVisual = await getWheelVisual();
    if (!(initialWheelVisual?.available) || Number(initialWheelVisual?.count || 0) < 4) {
      throw new Error(
        `Wheel visual binding check failed: expected 4 wheel mesh corners, got ${Number(initialWheelVisual?.count || 0)}.\n\n` +
        `HUD:\n${String(await page.locator('#hud').textContent() || '')}`
      );
    }
    if (!isValidWheelVisualSnapshot(initialWheelVisual)) {
      throw new Error(
        `Wheel visual binding check failed: wheel visual snapshot missing finite local/world pose data.\n\n` +
        `HUD:\n${String(await page.locator('#hud').textContent() || '')}`
      );
    }
    const cornerNames = WHEEL_IDS.map((id) => String(initialWheelVisual?.corners?.[id]?.name || '').trim()).filter(Boolean);
    if (new Set(cornerNames).size < 4) {
      throw new Error(
        `Wheel visual binding check failed: wheel corner node selection is not unique across LF/RF/LR/RR.\n` +
        `names=${cornerNames.join(', ')}\n\n` +
        `HUD:\n${String(await page.locator('#hud').textContent() || '')}`
      );
    }

    // Idle-phase validation before drive input.
    const idleSampleN = Math.max(1, Math.floor(IDLE_CHECK_MS / SAMPLE_INTERVAL_MS));
    let idleBad = null;
    for (let i = 0; i < idleSampleN; i++) {
      await sleep(SAMPLE_INTERVAL_MS);
      const snap = parseHud(await page.locator('#hud').textContent());
      const hasInput = (snap.keyW === 1 || snap.keyA === 1 || snap.keyS === 1 || snap.keyD === 1 || snap.keySpace === 1);
      const idleUnstable = (
        (Number.isFinite(snap.speed) && Math.abs(snap.speed) > IDLE_MAX_SPEED_MPS)
        || (Number.isFinite(snap.maxOmega) && snap.maxOmega > IDLE_MAX_OMEGA_RAD_PER_S)
        || (Number.isFinite(snap.engineRpm) && Math.abs(snap.engineRpm) > IDLE_MAX_ENGINE_RPM)
      );
      if (hasInput || idleUnstable) {
        idleBad = snap;
        break;
      }
    }
    if (idleBad) {
      throw new Error(
        `Idle stability check failed before drive input.\n` +
        `speed=${idleBad.speed} maxOmega=${idleBad.maxOmega} engineRpm=${idleBad.engineRpm} ` +
        `keys=[W:${idleBad.keyW} A:${idleBad.keyA} S:${idleBad.keyS} D:${idleBad.keyD} Space:${idleBad.keySpace}]\n\n` +
        `HUD:\n${idleBad.txt}`
      );
    }

    await keyDown('KeyW');
    let afterW = null;
    let lastOutOfHold = null;
    let observedWDown = false;
    let observedOutOfHold = false;
    let reachedMotion = false;
    let reachMotionAt = -1;
    const outOfHoldSamples = [];
    const outOfHoldVisuals = [];
    const sampleN = Math.max(1, Math.floor(HOLD_W_MS / SAMPLE_INTERVAL_MS));
    for (let i = 0; i < sampleN; i++) {
      await sleep(SAMPLE_INTERVAL_MS);
      const snap = parseHud(await page.locator('#hud').textContent());
      if (snap.keyW === 1) observedWDown = true;
      if (!afterW) afterW = snap;
      if (snap.inSpawnHold) {
        afterW = snap;
        continue;
      }
      observedOutOfHold = true;
      lastOutOfHold = snap;
      outOfHoldSamples.push(snap);
      outOfHoldVisuals.push(await getWheelVisual());
      const movedNow = (
        (Number.isFinite(snap.speed) && Math.abs(snap.speed) > 0.25)
        || (Number.isFinite(snap.maxOmega) && snap.maxOmega > 0.5)
        || (Number.isFinite(snap.engineRpm) && Math.abs(snap.engineRpm) > 250)
        || (Number.isFinite(snap.driveshaftNm) && Math.abs(snap.driveshaftNm) > 10)
      );
      if (movedNow && !reachedMotion) {
        reachedMotion = true;
        reachMotionAt = outOfHoldSamples.length - 1;
      }
      afterW = snap;
    }
    await keyUp('KeyW');
    if (!observedWDown) {
      throw new Error(
        `Input injection check failed: HUD never observed W=1 while KeyW was held.\n\nHUD:\n${afterW?.txt || ''}`
      );
    }
    if (!observedOutOfHold) {
      throw new Error(
        `Driveability check inconclusive: simulation never exited spawn-hold while W was held.\n\nHUD:\n${afterW?.txt || ''}`
      );
    }
    if (!afterW) afterW = parseHud(await page.locator('#hud').textContent());
    const evalW = lastOutOfHold || afterW;
    const moved = (
      (Number.isFinite(evalW.speed) && Math.abs(evalW.speed) > 0.25)
      || (Number.isFinite(evalW.maxOmega) && evalW.maxOmega > 0.5)
      || (Number.isFinite(evalW.engineRpm) && Math.abs(evalW.engineRpm) > 250)
      || (Number.isFinite(evalW.driveshaftNm) && Math.abs(evalW.driveshaftNm) > 10)
    );
    if (!moved) {
      throw new Error(
        `Driveability check failed: no propulsion response.\n` +
        `speed=${evalW.speed} maxOmega=${evalW.maxOmega} engineRpm=${evalW.engineRpm} driveshaftNm=${evalW.driveshaftNm}\n\n` +
        `HUD:\n${evalW.txt}`
      );
    }
    if (!reachedMotion) {
      throw new Error(
        `Driveability check failed: no motion reached while holding W over ${HOLD_W_MS}ms.\n\nHUD:\n${evalW.txt}`
      );
    }

    const motionSamples = outOfHoldSamples.slice(Math.max(0, reachMotionAt));
    if (motionSamples.length < MIN_SUSTAINED_MOTION_SAMPLES) {
      throw new Error(
        `Driveability check failed: motion did not sustain long enough after first movement.\n` +
        `samples=${motionSamples.length} required=${MIN_SUSTAINED_MOTION_SAMPLES}\n\nHUD:\n${evalW.txt}`
      );
    }

    const fastSamples = motionSamples.filter((s) => Number.isFinite(s.speed) && Math.abs(s.speed) >= MIN_MOTION_SPEED_MPS);
    if (!fastSamples.length) {
      throw new Error(
        `Driveability check failed: no sustained in-motion samples above ${MIN_MOTION_SPEED_MPS} m/s.\n\nHUD:\n${evalW.txt}`
      );
    }
    const sustainedMotionSamples = motionSamples.filter((s) => (
      (Number.isFinite(s.speed) && Math.abs(s.speed) >= MIN_MOTION_SPEED_MPS)
      || (Number.isFinite(s.maxOmega) && s.maxOmega >= 3.0)
    ));
    if (sustainedMotionSamples.length < Math.max(3, Math.floor(MIN_SUSTAINED_MOTION_SAMPLES / 2))) {
      throw new Error(
        `Driveability check failed: not enough sustained motion during throttle hold.\n` +
        `movingSamples=${sustainedMotionSamples.length}/${motionSamples.length}\n\nHUD:\n${evalW.txt}`
      );
    }
    const stallSamples = motionSamples.filter((s) => (
      s.keyW === 1
      && Number.isFinite(s.speed) && Math.abs(s.speed) < 0.15
      && Number.isFinite(s.maxOmega) && s.maxOmega < 0.5
    ));
    let maxConsecutiveStalls = 0;
    let consecutiveStalls = 0;
    for (const s of motionSamples) {
      const stalled = (
        s.keyW === 1
        && Number.isFinite(s.speed) && Math.abs(s.speed) < 0.15
        && Number.isFinite(s.maxOmega) && s.maxOmega < 0.5
      );
      if (stalled) {
        consecutiveStalls++;
        maxConsecutiveStalls = Math.max(maxConsecutiveStalls, consecutiveStalls);
      } else {
        consecutiveStalls = 0;
      }
    }
    const stallRatio = motionSamples.length ? (stallSamples.length / motionSamples.length) : 0;
    if (maxConsecutiveStalls >= MAX_CONSECUTIVE_STALL_SAMPLES || stallRatio >= MAX_STALL_SAMPLE_RATIO) {
      throw new Error(
        `Driveability check failed: drivetrain stalled under held throttle.\n` +
        `stallSamples=${stallSamples.length}/${motionSamples.length} ` +
        `maxConsecutive=${maxConsecutiveStalls} ratio=${stallRatio.toFixed(2)}\n\n` +
        `HUD:\n${stallSamples[0]?.txt || evalW.txt}`
      );
    }
    const drivetrainActiveSamples = motionSamples.filter((s) => (
      s.keyW === 1
      && Number.isFinite(s.engineRpm)
      && s.engineRpm >= MIN_ENGINE_RPM_UNDER_THROTTLE
      && Number.isFinite(s.driveshaftNm)
      && Math.abs(s.driveshaftNm) >= MIN_DRIVESHAFT_NM_UNDER_THROTTLE
      && Number.isFinite(s.maxOmega)
      && s.maxOmega >= 1.0
      && Number.isFinite(s.gear)
      && s.gear >= 0.5
      && Number.isFinite(s.driveMode)
      && s.driveMode >= 0.5
      && s.park === 0
    ));
    if (drivetrainActiveSamples.length < MIN_THROTTLE_DRIVETRAIN_SAMPLES) {
      throw new Error(
        `Drivetrain engagement check failed under throttle.\n` +
        `activeSamples=${drivetrainActiveSamples.length}/${motionSamples.length} required=${MIN_THROTTLE_DRIVETRAIN_SAMPLES}\n\n` +
        `HUD:\n${evalW.txt}`
      );
    }

    const healthIssues = [];
    for (const [idx, snap] of motionSamples.entries()) {
      const issues = evaluateMotionHealth(snap);
      if (issues.length) healthIssues.push({ idx, issues, snap });
    }
    if (healthIssues.length > MAX_HEALTH_FAILURES_DURING_MOTION) {
      const first = healthIssues[0];
      throw new Error(
        `In-motion stability failed: ${healthIssues.length} unhealthy motion samples ` +
        `(allowed ${MAX_HEALTH_FAILURES_DURING_MOTION}). First idx=${first.idx} issues=${first.issues.join(',')}.\n\n` +
        `HUD:\n${first.snap?.txt || evalW.txt}`
      );
    }
    const spindleCenters = motionSamples.map((s) => s.spindleCenter).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.z));
    if (spindleCenters.length < Math.max(3, Math.floor(motionSamples.length * 0.5))) {
      throw new Error(
        `Spindle follow check failed: insufficient spindle center samples during motion.\n` +
        `centers=${spindleCenters.length}/${motionSamples.length}\n\nHUD:\n${evalW.txt}`
      );
    }
    const spindleDisp = dist2(spindleCenters[0], spindleCenters[spindleCenters.length - 1]);
    const peakSpeed = motionSamples.reduce((m, s) => Math.max(m, Math.abs(Number(s.speed) || 0)), 0);
    if (peakSpeed >= 1.0 && !(Number.isFinite(spindleDisp) && spindleDisp >= MIN_SPINDLE_CENTER_DISPLACEMENT_M)) {
      throw new Error(
        `Spindle follow check failed: wheel/spindle center did not move with vehicle motion.\n` +
        `peakSpeed=${peakSpeed.toFixed(2)} spindleDisp=${Number(spindleDisp).toFixed(3)}\n\nHUD:\n${evalW.txt}`
      );
    }
    const motionVisualsRaw = outOfHoldVisuals.slice(Math.max(0, reachMotionAt));
    const motionVisuals = motionVisualsRaw.filter((v) => isValidWheelVisualSnapshot(v));
    if (motionVisuals.length < Math.max(3, Math.floor(motionSamples.length * 0.5))) {
      throw new Error(
        `Wheel mesh visual check failed: insufficient wheel visual samples during motion.\n` +
        `visual=${motionVisuals.length}/${motionSamples.length}\n\nHUD:\n${evalW.txt}`
      );
    }
    const baseVisual = motionVisuals[0];
    const maxDeltaById = { lf: 0, rf: 0, lr: 0, rr: 0 };
    for (const v of motionVisuals) {
      for (const id of WHEEL_IDS) {
        const da = cornerDelta(baseVisual, v, id, true);
        if (Number.isFinite(da)) maxDeltaById[id] = Math.max(maxDeltaById[id], da);
      }
    }
    const rollingCorners = WHEEL_IDS.filter((id) => Number.isFinite(maxDeltaById[id]) && maxDeltaById[id] >= VISUAL_MIN_ROLL_DELTA_RAD);
    const omegaDrivenCorners = WHEEL_IDS.filter((id) => {
      const avgAbs = meanAbsOmega(motionSamples, id);
      return Number.isFinite(avgAbs) && avgAbs >= VISUAL_MIN_OMEGA_FOR_ROLL_RAD_PER_S;
    });
    const minRollingCorners = REQUIRE_ALL_WHEELS_VISUAL_ROLL ? 4 : 2;
    if (rollingCorners.length < minRollingCorners) {
      throw new Error(
        `Wheel mesh visual check failed: wheel rotations were not observed on rendered mesh.\n` +
        `rolling=${rollingCorners.length} required=${minRollingCorners}\n` +
        `delta(rad): lf=${maxDeltaById.lf.toFixed(3)} rf=${maxDeltaById.rf.toFixed(3)} ` +
        `lr=${maxDeltaById.lr.toFixed(3)} rr=${maxDeltaById.rr.toFixed(3)}\n\nHUD:\n${evalW.txt}`
      );
    }
    const missingDrivenRoll = omegaDrivenCorners.filter((id) => !(Number.isFinite(maxDeltaById[id]) && maxDeltaById[id] >= VISUAL_MIN_ROLL_DELTA_RAD));
    if (omegaDrivenCorners.length >= 2 && missingDrivenRoll.length) {
      throw new Error(
        `Wheel mesh visual check failed: wheel(s) had sustained omega but did not rotate visually.\n` +
        `missing=${missingDrivenRoll.join(',')} omegaThreshold=${VISUAL_MIN_OMEGA_FOR_ROLL_RAD_PER_S.toFixed(2)}\n` +
        `delta(rad): lf=${maxDeltaById.lf.toFixed(3)} rf=${maxDeltaById.rf.toFixed(3)} ` +
        `lr=${maxDeltaById.lr.toFixed(3)} rr=${maxDeltaById.rr.toFixed(3)}\n\nHUD:\n${evalW.txt}`
      );
    }
    const visCenter0 = wheelVisualCenter(baseVisual);
    const visCenter1 = wheelVisualCenter(motionVisuals[motionVisuals.length - 1]);
    const visCenterDisp = dist2(visCenter0, visCenter1);
    if (peakSpeed >= 1.0 && !(Number.isFinite(visCenterDisp) && visCenterDisp >= VISUAL_MIN_CENTER_DISP_M)) {
      throw new Error(
        `Wheel mesh follow check failed: rendered wheel center did not move with vehicle.\n` +
        `peakSpeed=${peakSpeed.toFixed(2)} visualCenterDisp=${Number(visCenterDisp).toFixed(3)}\n\nHUD:\n${evalW.txt}`
      );
    }

    // Release throttle and verify the sim keeps running without respawn/reset.
    let coastObservedWUp = false;
    let coastObservedCarry = false;
    let coastHoldViolation = null;
    let coastTraceReset = null;
    const coastHealthIssues = [];
    const releaseSpeed = Number.isFinite(evalW.speed) ? Math.abs(evalW.speed) : 0;
    let prevGeomTraceN = Number.isFinite(evalW.geomTraceN) ? evalW.geomTraceN : NaN;
    const coastSampleN = Math.max(1, Math.floor(COAST_CHECK_MS / SAMPLE_INTERVAL_MS));
    for (let i = 0; i < coastSampleN; i++) {
      await sleep(SAMPLE_INTERVAL_MS);
      const snap = parseHud(await page.locator('#hud').textContent());
      if (snap.keyW === 0) coastObservedWUp = true;
      if (Number.isFinite(snap.speed) && Math.abs(snap.speed) >= COAST_MIN_SPEED_MPS) coastObservedCarry = true;
      if (snap.inSpawnHold && !coastHoldViolation) coastHoldViolation = snap;
      if (
        Number.isFinite(prevGeomTraceN)
        && Number.isFinite(snap.geomTraceN)
        && snap.geomTraceN + 2 < prevGeomTraceN
        && !coastTraceReset
      ) {
        coastTraceReset = snap;
      }
      if (Number.isFinite(snap.geomTraceN)) prevGeomTraceN = snap.geomTraceN;
      const issues = evaluateMotionHealth(snap);
      if (issues.length) coastHealthIssues.push({ idx: i, issues, snap });
    }
    if (!coastObservedWUp) {
      throw new Error(`Input release check failed: HUD never observed W=0 after KeyW release.`);
    }
    if (coastHoldViolation) {
      throw new Error(
        `Coast stability failed: simulation re-entered spawn hold after releasing throttle (likely reset).\n\n` +
        `HUD:\n${coastHoldViolation.txt}`
      );
    }
    if (coastTraceReset) {
      throw new Error(
        `Coast stability failed: geometry trace counter reset during coast window (likely reset).\n\n` +
        `HUD:\n${coastTraceReset.txt}`
      );
    }
    if (releaseSpeed >= COAST_EXPECT_RELEASE_SPEED_MPS && !coastObservedCarry) {
      throw new Error(
        `Coast stability failed: speed collapsed immediately after throttle release (no carry).\n` +
        `releaseSpeed=${releaseSpeed.toFixed(2)} expectedCarry>=${COAST_MIN_SPEED_MPS.toFixed(2)}\n\n` +
        `HUD:\n${evalW.txt}`
      );
    }
    if (coastHealthIssues.length > MAX_HEALTH_FAILURES_DURING_MOTION) {
      const first = coastHealthIssues[0];
      throw new Error(
        `Coast stability failed: ${coastHealthIssues.length} unhealthy coast samples ` +
        `(allowed ${MAX_HEALTH_FAILURES_DURING_MOTION}). First idx=${first.idx} issues=${first.issues.join(',')}.\n\n` +
        `HUD:\n${first.snap?.txt || evalW.txt}`
      );
    }

    const visBeforeA = await getWheelVisual();
    await keyDown('KeyA');
    await sleep(Math.max(120, Math.floor(HOLD_A_MS * 0.7)));
    const snapWhileA = parseHud(await page.locator('#hud').textContent());
    const visWhileA = await getWheelVisual();
    await sleep(Math.max(120, Math.floor(HOLD_A_MS * 0.3)));
    await keyUp('KeyA');
    const afterA = snapWhileA;
    if (!(Number.isFinite(afterA.steerCmd) && Math.abs(afterA.steerCmd) > 0.02)) {
      throw new Error(
        `Steering check failed: steer command did not respond to A key.\n` +
        `steer=${afterA.steerCmd}\n\nHUD:\n${afterA.txt}`
      );
    }
    const wheelSteerAbs = Math.max(Math.abs(Number(afterA.steerFL) || 0), Math.abs(Number(afterA.steerFR) || 0));
    if (!(Number.isFinite(wheelSteerAbs) && wheelSteerAbs > 0.02)) {
      throw new Error(
        `Steering check failed: wheel steer angles did not move.\n` +
        `steerFL=${afterA.steerFL} steerFR=${afterA.steerFR}\n\nHUD:\n${afterA.txt}`
      );
    }
    const frontDeltaA = Math.max(
      cornerDelta(visBeforeA, visWhileA, 'lf', true) || 0,
      cornerDelta(visBeforeA, visWhileA, 'rf', true) || 0,
    );
    const rearDeltaA = Math.max(
      cornerDelta(visBeforeA, visWhileA, 'lr', true) || 0,
      cornerDelta(visBeforeA, visWhileA, 'rr', true) || 0,
    );
    if (!(frontDeltaA > VISUAL_MIN_STEER_DELTA_RAD && frontDeltaA > (rearDeltaA + 0.01))) {
      throw new Error(
        `Steering visual check failed (A): front wheel mesh did not steer relative to rear.\n` +
        `frontDelta=${frontDeltaA.toFixed(3)} rearDelta=${rearDeltaA.toFixed(3)}\n\nHUD:\n${afterA.txt}`
      );
    }
    const visBeforeD = await getWheelVisual();
    await keyDown('KeyD');
    await sleep(Math.max(120, Math.floor(HOLD_A_MS * 0.7)));
    const snapWhileD = parseHud(await page.locator('#hud').textContent());
    const visWhileD = await getWheelVisual();
    await sleep(Math.max(120, Math.floor(HOLD_A_MS * 0.3)));
    await keyUp('KeyD');
    if (!(Number.isFinite(snapWhileD.steerCmd) && snapWhileD.steerCmd < -0.02)) {
      throw new Error(
        `Steering check failed: steer command did not respond to D key.\n` +
        `steer=${snapWhileD.steerCmd}\n\nHUD:\n${snapWhileD.txt}`
      );
    }
    const wheelSteerDAbs = Math.max(Math.abs(Number(snapWhileD.steerFL) || 0), Math.abs(Number(snapWhileD.steerFR) || 0));
    if (!(Number.isFinite(wheelSteerDAbs) && wheelSteerDAbs > 0.02)) {
      throw new Error(
        `Steering check failed: wheel steer angles did not respond to D key.\n` +
        `steerFL=${snapWhileD.steerFL} steerFR=${snapWhileD.steerFR}\n\nHUD:\n${snapWhileD.txt}`
      );
    }
    const frontDeltaD = Math.max(
      cornerDelta(visBeforeD, visWhileD, 'lf', true) || 0,
      cornerDelta(visBeforeD, visWhileD, 'rf', true) || 0,
    );
    const rearDeltaD = Math.max(
      cornerDelta(visBeforeD, visWhileD, 'lr', true) || 0,
      cornerDelta(visBeforeD, visWhileD, 'rr', true) || 0,
    );
    if (!(frontDeltaD > VISUAL_MIN_STEER_DELTA_RAD && frontDeltaD > (rearDeltaD + 0.01))) {
      throw new Error(
        `Steering visual check failed (D): front wheel mesh did not steer relative to rear.\n` +
        `frontDelta=${frontDeltaD.toFixed(3)} rearDelta=${rearDeltaD.toFixed(3)}\n\nHUD:\n${snapWhileD.txt}`
      );
    }
    // Ensure lateral key state is released before reverse/brake phase.
    for (let i = 0; i < 6; i++) {
      await sleep(100);
      const snap = parseHud(await page.locator('#hud').textContent());
      if (snap.keyA === 0) break;
      await keyUp('KeyA');
      await keyUp('KeyD');
    }
    let recentered = false;
    for (let i = 0; i < 10; i++) {
      await sleep(120);
      const snap = parseHud(await page.locator('#hud').textContent());
      const wheelMag = Math.max(Math.abs(Number(snap.steerFL) || 0), Math.abs(Number(snap.steerFR) || 0));
      if (Math.abs(Number(snap.steerCmd) || 0) < 0.08 && wheelMag < 0.08) {
        recentered = true;
        break;
      }
    }
    if (!recentered) {
      const s = parseHud(await page.locator('#hud').textContent());
      throw new Error(
        `Steering check failed: steering did not recenter after key release.\n\nHUD:\n${s.txt}`
      );
    }
    const visAfterRecenter = await getWheelVisual();
    const recenterFrontDelta = Math.max(
      cornerDelta(visBeforeD, visAfterRecenter, 'lf', true) || 0,
      cornerDelta(visBeforeD, visAfterRecenter, 'rf', true) || 0,
    );
    const recenterRearDelta = Math.max(
      cornerDelta(visBeforeD, visAfterRecenter, 'lr', true) || 0,
      cornerDelta(visBeforeD, visAfterRecenter, 'rr', true) || 0,
    );
    if (!(Number.isFinite(recenterFrontDelta) && recenterFrontDelta <= (recenterRearDelta + VISUAL_RECENTER_MAX_DELTA_RAD))) {
      throw new Error(
        `Steering visual recenter failed: front wheel local orientation remained offset after release.\n` +
        `frontDelta=${Number(recenterFrontDelta).toFixed(3)} rearDelta=${Number(recenterRearDelta).toFixed(3)} ` +
        `margin=${VISUAL_RECENTER_MAX_DELTA_RAD.toFixed(3)}\n\n` +
        `HUD:\n${String((await page.locator('#hud').textContent()) || '')}`
      );
    }

    // Brake phase: explicit service brake (Space) should bring car to near stop.
    await keyDown('Space');
    let sawSpaceDown = false;
    let stopConsecutive = 0;
    let sawBrakeStop = false;
    const brakeHealthIssues = [];
    let brakeHoldViolation = null;
    let allWheelStopSamples = 0;
    const brakeSampleN = Math.max(1, Math.floor(HOLD_SPACE_MS / SAMPLE_INTERVAL_MS));
    for (let i = 0; i < brakeSampleN; i++) {
      await sleep(SAMPLE_INTERVAL_MS);
      const snap = parseHud(await page.locator('#hud').textContent());
      if (snap.keySpace === 1) sawSpaceDown = true;
      const stopped = (
        Number.isFinite(snap.speed) && Math.abs(snap.speed) <= BRAKE_STOP_SPEED_MPS
        && Number.isFinite(snap.maxOmega) && snap.maxOmega <= BRAKE_STOP_MAX_OMEGA
      );
      if (stopped) {
        stopConsecutive++;
        if (stopConsecutive >= BRAKE_STOP_CONSECUTIVE_SAMPLES) sawBrakeStop = true;
      } else {
        stopConsecutive = 0;
      }
      const perWheelStopped = Array.isArray(snap.omegas)
        && snap.omegas.length === 4
        && snap.omegas.every((w) => Number.isFinite(w) && Math.abs(w) <= BRAKE_ALL_WHEELS_MAX_OMEGA);
      if (perWheelStopped) allWheelStopSamples++;
      if (snap.inSpawnHold && !brakeHoldViolation) brakeHoldViolation = snap;
      const issues = evaluateMotionHealth(snap);
      if (issues.length) brakeHealthIssues.push({ idx: i, issues, snap });
    }
    await keyUp('Space');
    if (!sawSpaceDown) {
      throw new Error(`Brake check failed: HUD never observed Space=1 while braking.`);
    }
    if (brakeHoldViolation) {
      throw new Error(
        `Brake check failed: simulation re-entered spawn hold during brake phase.\n\nHUD:\n${brakeHoldViolation.txt}`
      );
    }
    if (!sawBrakeStop) {
      // Some runs settle to stop just after releasing brake input; allow a short post-brake window.
      for (let i = 0; i < 5 && !sawBrakeStop; i++) {
        await sleep(120);
        const snap = parseHud(await page.locator('#hud').textContent());
        const stopped = (
          Number.isFinite(snap.speed) && Math.abs(snap.speed) <= BRAKE_STOP_SPEED_MPS
          && Number.isFinite(snap.maxOmega) && snap.maxOmega <= BRAKE_STOP_MAX_OMEGA
        );
        if (stopped) sawBrakeStop = true;
      }
      if (!sawBrakeStop) {
        const s = parseHud(await page.locator('#hud').textContent());
        throw new Error(
          `Brake check failed: service brake did not bring vehicle to near-stop.\n\nHUD:\n${s.txt}`
        );
      }
    }
    if (allWheelStopSamples < Math.max(2, Math.floor(BRAKE_STOP_CONSECUTIVE_SAMPLES / 2))) {
      const s = parseHud(await page.locator('#hud').textContent());
      throw new Error(
        `Brake check failed: not all wheel omegas settled under brake.\n` +
        `allWheelStopSamples=${allWheelStopSamples} thresholdOmega=${BRAKE_ALL_WHEELS_MAX_OMEGA.toFixed(2)}\n\nHUD:\n${s.txt}`
      );
    }
    if (brakeHealthIssues.length > MAX_HEALTH_FAILURES_DURING_MOTION) {
      const first = brakeHealthIssues[0];
      throw new Error(
        `Brake stability failed: ${brakeHealthIssues.length} unhealthy brake samples ` +
        `(allowed ${MAX_HEALTH_FAILURES_DURING_MOTION}). First idx=${first.idx} issues=${first.issues.join(',')}.\n\n` +
        `HUD:\n${first.snap?.txt || ''}`
      );
    }

    // Stop-and-reverse phase: hold S, verify decel/stop then negative signed forward speed.
    await keyDown('KeyS');
    let sawSDown = false;
    let reverseSamples = 0;
    let reverseGearAckSamples = 0;
    let reverseHoldViolation = null;
    const reverseHealthIssues = [];
    let lastReverseSnap = null;
    const reverseSampleN = Math.max(1, Math.floor(HOLD_S_MS / SAMPLE_INTERVAL_MS));
    for (let i = 0; i < reverseSampleN; i++) {
      await sleep(SAMPLE_INTERVAL_MS);
      const snap = parseHud(await page.locator('#hud').textContent());
      lastReverseSnap = snap;
      if (snap.keyS === 1) sawSDown = true;
      if (
        Number.isFinite(snap.signedFwd)
        && snap.signedFwd < -0.35
        && Number.isFinite(snap.maxOmega)
        && snap.maxOmega > 0.5
      ) {
        reverseSamples++;
      }
      if (
        (Number.isFinite(snap.gear) && snap.gear <= -0.5)
        || (Number.isFinite(snap.driveMode) && snap.driveMode <= -0.5)
      ) {
        reverseGearAckSamples++;
      }
      if (snap.inSpawnHold && !reverseHoldViolation) reverseHoldViolation = snap;
      const issues = evaluateMotionHealth(snap);
      if (issues.length) reverseHealthIssues.push({ idx: i, issues, snap });
    }
    await keyUp('KeyS');
    if (!sawSDown) {
      throw new Error(`Input check failed: HUD never observed S=1 while KeyS was held.`);
    }
    if (reverseHoldViolation) {
      throw new Error(
        `Reverse check failed: simulation re-entered spawn hold during stop/reverse phase.\n\n` +
        `HUD:\n${reverseHoldViolation.txt}`
      );
    }
    if (reverseSamples < MIN_REVERSE_SUSTAINED_SAMPLES) {
      throw new Error(
        `Reverse check failed: reverse motion was not sustained.\n` +
        `reverseSamples=${reverseSamples}/${reverseSampleN} required=${MIN_REVERSE_SUSTAINED_SAMPLES}\n\n` +
        `HUD:\n${lastReverseSnap?.txt || afterA.txt}`
      );
    }
    if (reverseGearAckSamples < MIN_REVERSE_GEAR_ACK_SAMPLES) {
      throw new Error(
        `Reverse drivetrain check failed: reverse command was not acknowledged by gear/driveMode.\n` +
        `ackSamples=${reverseGearAckSamples}/${reverseSampleN} required=${MIN_REVERSE_GEAR_ACK_SAMPLES}\n\n` +
        `HUD:\n${lastReverseSnap?.txt || afterA.txt}`
      );
    }
    if (reverseHealthIssues.length > MAX_HEALTH_FAILURES_DURING_MOTION) {
      const first = reverseHealthIssues[0];
      throw new Error(
        `Reverse stability failed: ${reverseHealthIssues.length} unhealthy reverse samples ` +
        `(allowed ${MAX_HEALTH_FAILURES_DURING_MOTION}). First idx=${first.idx} issues=${first.issues.join(',')}.\n\n` +
        `HUD:\n${first.snap?.txt || afterA.txt}`
      );
    }

    console.log('PASS: Chrono drive smoke (propulsion + coast + steering + stop/reverse)');
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
    if (devServer) {
      await stopProcessGroup(devServer);
    }
  }
}

main().catch((err) => {
  console.error(`FAIL: ${err?.message || err}`);
  process.exit(1);
});

