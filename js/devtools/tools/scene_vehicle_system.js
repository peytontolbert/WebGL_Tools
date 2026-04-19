import { el, clear, clamp } from '../../ui/dom.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { ProjectChronoWasmVehicleSim } from '../../runtime/project_chrono_wasm_vehicle_sim.js';
import { computeVehicleControls } from '../../runtime/vehicle_controls.js';
import { parseDds } from './dds_loader.js';

function safeTrim(s) { return String(s ?? '').trim(); }
function stripIniInlineComment(v) {
  // Assetto Corsa INI/LUT lines often use `;` (and sometimes `#`) for comments.
  // Some sources preserve inline comments in parsed values, so strip them before use.
  const s = String(v ?? '');
  let out = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      out += c;
      continue;
    }
    if (c === '"' || c === '\'') { q = c; out += c; continue; }
    if (c === ';' || c === '#') break;
    out += c;
  }
  let t = out.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith('\'') && t.endsWith('\''))
  ) t = t.slice(1, -1).trim();
  return t;
}
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp01(x) { return Math.max(0, Math.min(1, Number(x) || 0)); }

function normAnimName(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[-_.:]/g, '');
}

function degToRad(deg) {
  return (Number(deg) || 0) * (Math.PI / 180);
}

class SimpleVehicleEngineSynth {
  /**
   * @param {AudioContext} ctx
   * @param {GainNode} out
   */
  constructor(ctx, out) {
    this.ctx = ctx;
    this.out = out;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 700;
    filter.Q.value = 0.6;

    const gain = ctx.createGain();
    gain.gain.value = 0.0;

    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    const osc2 = ctx.createOscillator();
    osc2.type = 'square';

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(gain);
    gain.connect(out);

    this._filter = filter;
    this._gain = gain;
    this._osc1 = osc1;
    this._osc2 = osc2;

    this._started = false;
    this._targetGain = 0.0;
    this._rpmSm = 0.0;
  }

  _startIfNeeded() {
    if (this._started) return;
    this._started = true;
    try { this._osc1.start(); } catch { /* ignore */ }
    try { this._osc2.start(); } catch { /* ignore */ }
  }

  update({ rpm, idleRpm, limRpm, throttle01, speedAbs }, dt) {
    this._startIfNeeded();
    const t = this.ctx.currentTime;
    const dts = Math.max(0, Number(dt) || 0);

    const idle = Math.max(600, Number(idleRpm) || 900);
    const lim = Math.max(idle + 500, Number(limRpm) || 7200);
    const rr = clamp(Number(rpm) || idle, idle, lim);
    const x = clamp01((rr - idle) / Math.max(1, (lim - idle)));

    // Smooth RPM a bit to avoid zipper noise.
    if (!Number.isFinite(this._rpmSm) || this._rpmSm <= 0) this._rpmSm = rr;
    this._rpmSm = lerp(this._rpmSm, rr, 1.0 - Math.exp(-14.0 * dts));
    const xs = clamp01((this._rpmSm - idle) / Math.max(1, (lim - idle)));

    // Fundamental in audible range.
    const f0 = 35 + 175 * xs;
    const f1 = f0;
    const f2 = 2.0 * f0;

    // Tone shaping: open up with throttle and RPM.
    const open = clamp01(0.20 + 0.80 * Math.max(xs, throttle01));
    const cutoff = 220 + 2400 * open;
    const volBase = 0.010 + 0.030 * clamp01(speedAbs / 18.0);
    const vol = clamp(volBase + 0.13 * throttle01 + 0.06 * x, 0.0, 0.22);

    try { this._osc1.frequency.setTargetAtTime(f1, t, 0.030); } catch { /* ignore */ }
    try { this._osc2.frequency.setTargetAtTime(f2, t, 0.030); } catch { /* ignore */ }
    try { this._filter.frequency.setTargetAtTime(cutoff, t, 0.050); } catch { /* ignore */ }
    this._targetGain = vol;
    try { this._gain.gain.setTargetAtTime(vol, t, 0.060); } catch { /* ignore */ }
  }

  stop({ fadeSec = 0.12 } = {}) {
    const t = this.ctx.currentTime;
    const fade = Math.max(0.02, Number(fadeSec) || 0.12);
    try { this._gain.gain.setTargetAtTime(0.0, t, fade); } catch { /* ignore */ }
    const stopAt = t + Math.max(0.04, fade * 3.0);
    try { this._osc1.stop(stopAt); } catch { /* ignore */ }
    try { this._osc2.stop(stopAt); } catch { /* ignore */ }
    try { this._osc1.disconnect(); } catch { /* ignore */ }
    try { this._osc2.disconnect(); } catch { /* ignore */ }
    try { this._filter.disconnect(); } catch { /* ignore */ }
    try { this._gain.disconnect(); } catch { /* ignore */ }
  }
}

function parseIniLoose(text) {
  const out = { sections: new Map() };
  let section = '';
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  for (const raw of lines) {
    const line0 = String(raw || '').trim();
    if (!line0) continue;
    if (line0.startsWith(';') || line0.startsWith('#') || line0.startsWith('//')) continue;
    if (line0.startsWith('[') && line0.endsWith(']')) {
      section = line0.slice(1, -1).trim();
      if (!out.sections.has(section)) out.sections.set(section, new Map());
      continue;
    }
    const eq = line0.indexOf('=');
    if (eq <= 0) continue;
    const k = line0.slice(0, eq).trim();
    let v = line0.slice(eq + 1).trim();
    // Strip inline comments (best-effort).
    v = v.replace(/\s*(;|\/\/).+$/, '').trim();
    const sec = out.sections.get(section) || new Map();
    sec.set(k, v);
    out.sections.set(section, sec);
  }
  return out;
}

function parseAcSfxEngineIni(text) {
  const ini = parseIniLoose(text);
  const header = ini.sections.get('HEADER') || new Map();
  const pedal = ini.sections.get('PEDAL_MIX') || new Map();

  const loadMode = String(header.get('LOAD_MODE') || 'TWO_POINTS').trim().toUpperCase();
  const crossfadeRange = Math.max(0, Number(header.get('CROSSFADE_RANGE')) || 500);
  const mixVolume = Math.max(0, Number(header.get('MIX_VOLUME')) || 1.0);

  const gamma = Math.max(0.05, Number(pedal.get('GAMMA')) || 1.0);
  const coastGamma = Math.max(0.05, Number(pedal.get('COAST_GAMMA')) || 1.0);

  /** @type {{ filename:string, inRpm:number, outRpm:number, naturalRpm:number, pedalBlend:number }[]} */
  const samples = [];
  for (const [secName, sec] of ini.sections.entries()) {
    if (!/^SAMPLE_/i.test(secName)) continue;
    const filename = safeTrim(sec.get('FILENAME') || '');
    if (!filename) continue;
    const inRpm = Number(sec.get('IN')) || 0;
    const outRpm = Number(sec.get('OUT')) || 0;
    const naturalRpm = Math.max(1, Number(sec.get('NATURAL')) || 1);
    const pedalBlend = Number(sec.get('PEDALBLEND')) || 0;
    samples.push({ filename, inRpm, outRpm, naturalRpm, pedalBlend });
  }

  const tr = ini.sections.get('TRANSMISSION') || new Map();
  const trFilename = safeTrim(tr.get('FILENAME') || '');
  const transmission = trFilename ? {
    filename: trFilename,
    natural: Math.max(1e-3, Number(tr.get('NATURAL')) || 110),
    globalGain: Math.max(0, Number(tr.get('GLOBAL_GAIN')) || 0.15),
    volumeGain: Math.max(0, Number(tr.get('VOLUME_GAIN')) || 0.12),
  } : null;

  return { loadMode, crossfadeRange, mixVolume, gamma, coastGamma, samples, transmission };
}

class AcSfxSampleEngine {
  /**
   * @param {AudioContext} ctx
   * @param {GainNode} out
   * @param {{
   *  baseUrl: string,
   *  loadAudioBuffer: (absUrl: string) => Promise<AudioBuffer>,
   *  preferInterior?: boolean,
   * }} opts
   */
  constructor(ctx, out, opts) {
    this.ctx = ctx;
    this.out = out;
    this.baseUrl = String(opts?.baseUrl || '');
    this._loadAudioBuffer = opts?.loadAudioBuffer;
    this._preferInterior = !!opts?.preferInterior;

    this._loaded = false;
    this._failed = false;
    this._loadPromise = null;

    this._engineCfg = null;
    this._nodes = []; // { sample, src, gain }
    this._txNode = null; // { cfg, src, gain }
  }

  get ready() { return !!this._loaded && !this._failed; }
  get failed() { return !!this._failed; }

  setPreferInterior(v) { this._preferInterior = !!v; }

  _abs(rel) {
    const base = String(this.baseUrl || '');
    if (!base) return '';
    try { return new URL(String(rel || '').replace(/\\/g, '/'), base).toString(); } catch { return ''; }
  }

  async _fetchText(absUrl) {
    const u = String(absUrl || '');
    if (!u) return '';
    const resp = await fetch(u, { cache: 'no-store' });
    if (!resp.ok) return '';
    return await resp.text();
  }

  async load() {
    if (this._loadPromise) return await this._loadPromise;
    this._loadPromise = (async () => {
      try {
        const base = String(this.baseUrl || '');
        if (!base) throw new Error('missing baseUrl');

        const cand = this._preferInterior
          ? ['engineINT.ini', 'engineInt.ini', 'engine_int.ini', 'engine_interior.ini', 'engine.ini']
          : ['engine.ini', 'engine_ext.ini', 'engineEXT.ini', 'engineINT.ini', 'engineInt.ini'];
        let iniText = '';
        let iniName = '';
        for (const name of cand) {
          const abs = this._abs(name);
          if (!abs) continue;
          try {
            const t = await this._fetchText(abs);
            if (t && t.length > 20 && /\[SAMPLE_/i.test(t)) { iniText = t; iniName = name; break; }
          } catch { /* ignore */ }
        }
        if (!iniText) throw new Error('no engine.ini found');

        const cfg = parseAcSfxEngineIni(iniText);
        if (!cfg?.samples?.length) throw new Error(`engine ini has no samples (${iniName})`);
        this._engineCfg = cfg;

        // Load and start all sample loops (gain 0 initially).
        for (const s of cfg.samples) {
          const abs = this._abs(s.filename);
          if (!abs) continue;
          let buf = null;
          try {
            buf = await this._loadAudioBuffer(abs);
          } catch {
            buf = null;
          }
          if (!buf) continue;

          const gain = this.ctx.createGain();
          gain.gain.value = 0.0;
          gain.connect(this.out);

          const src = this.ctx.createBufferSource();
          src.buffer = buf;
          src.loop = true;
          src.playbackRate.value = 1.0;
          src.connect(gain);
          // Randomize loop start to reduce phasing artifacts across samples.
          const dur = Math.max(0.01, Number(buf.duration) || 0.0);
          const offset = Math.random() * Math.min(dur - 0.001, Math.max(0.001, dur * 0.75));
          try { src.start(0, Math.max(0, offset)); } catch { try { src.start(); } catch { /* ignore */ } }
          this._nodes.push({ sample: s, src, gain });
        }

        if (!this._nodes.length) throw new Error(`no audio samples loaded (${iniName})`);

        // Transmission loop (optional).
        if (cfg.transmission?.filename) {
          try {
            const abs = this._abs(cfg.transmission.filename);
            const buf = abs ? await this._loadAudioBuffer(abs) : null;
            if (buf) {
              const gain = this.ctx.createGain();
              gain.gain.value = 0.0;
              gain.connect(this.out);
              const src = this.ctx.createBufferSource();
              src.buffer = buf;
              src.loop = true;
              src.playbackRate.value = 1.0;
              src.connect(gain);
              try { src.start(); } catch { /* ignore */ }
              this._txNode = { cfg: cfg.transmission, src, gain };
            }
          } catch { /* ignore */ }
        }

        this._loaded = true;
        this._failed = false;
        return true;
      } catch {
        this._failed = true;
        this._loaded = false;
        return false;
      }
    })();
    return await this._loadPromise;
  }

  _shape01(rpm, inRpm, outRpm, cf) {
    const r = Number(rpm) || 0;
    const a = Number(inRpm) || 0;
    const b = Number(outRpm) || 0;
    const c = Math.max(0, Number(cf) || 0);
    if (!(b > a)) return 0;
    if (c <= 1e-3) return (r >= a && r <= b) ? 1 : 0;
    if (r < (a - c) || r > (b + c)) return 0;
    if (r < (a + c)) return clamp01((r - (a - c)) / (2 * c));
    if (r > (b - c)) return clamp01(((b + c) - r) / (2 * c));
    return 1;
  }

  update({ rpm, throttle01, speedAbs }, dt) {
    if (!this.ready || !this._engineCfg) return;
    const cfg = this._engineCfg;
    const t = this.ctx.currentTime;

    const thr = clamp01(Number(throttle01) || 0);
    let on = Math.pow(thr, cfg.gamma || 1.0);
    let off = Math.pow(1.0 - thr, cfg.coastGamma || 1.0);
    const sum = Math.max(1e-6, on + off);
    on /= sum;
    off /= sum;

    const cf = cfg.crossfadeRange || 500;
    const vol = Math.max(0, cfg.mixVolume || 1.0);

    for (const n of this._nodes) {
      const s = n.sample;
      const w = this._shape01(rpm, s.inRpm, s.outRpm, cf);
      const pb = Number(s.pedalBlend) || 0;
      const pedalW = (pb >= 0.5) ? on : (pb <= -0.5) ? off : 1.0;
      const g = vol * w * pedalW;
      const rate = clamp(Number(rpm) / Math.max(1, Number(s.naturalRpm) || 1), 0.2, 3.0);
      try { n.src.playbackRate.setTargetAtTime(rate, t, 0.030); } catch { /* ignore */ }
      try { n.gain.gain.setTargetAtTime(g, t, 0.045); } catch { /* ignore */ }
    }

    if (this._txNode?.cfg && this._txNode?.src && this._txNode?.gain) {
      const tx = this._txNode.cfg;
      const speedKph = Math.max(0, Number(speedAbs) || 0) * 3.6;
      const rate = clamp(speedKph / Math.max(1e-3, Number(tx.natural) || 110), 0.2, 3.0);
      const g = clamp(Number(tx.globalGain) + Number(tx.volumeGain) * thr, 0.0, 0.45) * vol;
      try { this._txNode.src.playbackRate.setTargetAtTime(rate, t, 0.060); } catch { /* ignore */ }
      try { this._txNode.gain.gain.setTargetAtTime(g, t, 0.080); } catch { /* ignore */ }
    }
  }

  stop({ fadeSec = 0.12 } = {}) {
    const t = this.ctx.currentTime;
    const fade = Math.max(0.02, Number(fadeSec) || 0.12);
    const stopAt = t + Math.max(0.04, fade * 3.0);
    for (const n of this._nodes) {
      try { n.gain.gain.setTargetAtTime(0.0, t, fade); } catch { /* ignore */ }
      try { n.src.stop(stopAt); } catch { /* ignore */ }
      try { n.src.disconnect(); } catch { /* ignore */ }
      try { n.gain.disconnect(); } catch { /* ignore */ }
    }
    this._nodes = [];
    if (this._txNode) {
      try { this._txNode.gain.gain.setTargetAtTime(0.0, t, fade); } catch { /* ignore */ }
      try { this._txNode.src.stop(stopAt); } catch { /* ignore */ }
      try { this._txNode.src.disconnect(); } catch { /* ignore */ }
      try { this._txNode.gain.disconnect(); } catch { /* ignore */ }
      this._txNode = null;
    }
  }
}

function safeName(s) {
  const raw = String(s || '').trim();
  const out = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
  return out || 'scene';
}

function getFileStem(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const base = s.split('/').pop() || s;
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(0, i) : base;
}

function normalizeAssetUrl(raw) {
  const s = safeTrim(raw).replace(/\\/g, '/');
  if (!s) return '';
  if (s.startsWith('http://') || s.startsWith('https://')) return s;
  try {
    const base = String(document?.baseURI || window?.location?.href || '');
    const rel = s.startsWith('/') ? s.slice(1) : s;
    return new URL(rel, base).toString();
  } catch {
    return s;
  }
}

function metaUrlForModelUrl(raw) {
  const s = safeTrim(raw);
  if (!s) return '';
  // Preserve cache-busting query/hash from the model URL.
  const noHash = s.split('#')[0] || '';
  const hash = s.includes('#') ? ('#' + (s.split('#').slice(1).join('#') || '')) : '';
  const noQuery = noHash.split('?')[0] || '';
  const query = noHash.includes('?') ? ('?' + (noHash.split('?').slice(1).join('?') || '')) : '';

  const low = noQuery.toLowerCase();
  if (low.endsWith('.meta.json')) return noQuery + query + hash;
  if (low.endsWith('.glb')) return noQuery.slice(0, -4) + '.meta.json' + query + hash;
  if (low.endsWith('.gltf')) return noQuery.slice(0, -5) + '.meta.json' + query + hash;
  return noQuery + '.meta.json' + query + hash;
}

function uniqStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const v of (Array.isArray(arr) ? arr : [])) {
    const s = safeTrim(v);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function disposeThreeObject(obj) {
  if (!obj) return;
  obj.traverse?.((n) => {
    if (n?.userData?.__skipDispose) return;
    if (n?.geometry) {
      try { n.geometry.dispose?.(); } catch { /* ignore */ }
    }
    const mat = n?.material;
    const mats = Array.isArray(mat) ? mat : (mat ? [mat] : []);
    for (const m of mats) {
      if (!m) continue;
      if (m?.userData?.__skipDispose) continue;
      for (const k of ['map', 'normalMap', 'metalnessMap', 'roughnessMap', 'emissiveMap', 'aoMap']) {
        const t = m[k];
        if (t && t.isTexture) {
          try { t.dispose?.(); } catch { /* ignore */ }
        }
      }
      try { m.dispose?.(); } catch { /* ignore */ }
    }
  });
}

function extractVehicleMotionClipBuckets(clips) {
  const out = {
    idle: [],
    drive: [],
    wheel: [],
    suspension: [],
    steering: [],
    combat: [],
  };
  if (!Array.isArray(clips) || !clips.length) return out;
  for (const c of clips) {
    const name = safeTrim(c?.name || '');
    if (!name) continue;
    const n = normAnimName(name);
    if (!n) continue;
    if (/(^|)(idle|park|neutral|still|aim)(|$)/.test(n)) out.idle.push(name);
    if (/(^|)(drive|move|speed|engine|motor|run)(|$)/.test(n)) out.drive.push(name);
    if (/(^|)(wheel|tire|tyre|spin|roll)(|$)/.test(n)) out.wheel.push(name);
    if (/(^|)(susp|shock|bounce)(|$)/.test(n)) out.suspension.push(name);
    if (/(^|)(steer|steering|turn|yaw)(|$)/.test(n)) out.steering.push(name);
    if (/(^|)(combat|fire|gun|shoot|weapon)(|$)/.test(n)) out.combat.push(name);
  }
  return out;
}

const SCENE_ASSET_LOCATIONS = Object.freeze({
  vehicles: 'assets/generated/vehicles/halo/',
  vehiclesLegacy: 'assets/generated/halo/',
});

const SCENE_VEHICLE_PRESETS = [
  {
    id: 'ghost_aa3',
    label: 'Halo Ghost AA3',
    modelUrl: `${SCENE_ASSET_LOCATIONS.vehicles}ghost_aa3.glb`,
    sceneInboxUrl: `${SCENE_ASSET_LOCATIONS.vehicles}ghost_aa3.scene-inbox.json`,
    metaUrl: `${SCENE_ASSET_LOCATIONS.vehicles}ghost_aa3.meta.json`,
    recommendedScale: 0.01,
    source: 'RejectedShotgun-Tags + HaloAnimationRepository',
  },
];

function withVehiclePathFallbacks(raw) {
  const s = safeTrim(raw).replace(/\\/g, '/');
  if (!s) return [];
  const out = [s];
  const nextPrefix = SCENE_ASSET_LOCATIONS.vehicles;
  const prevPrefix = SCENE_ASSET_LOCATIONS.vehiclesLegacy;
  if (s.startsWith(nextPrefix)) out.push(`${prevPrefix}${s.slice(nextPrefix.length)}`);
  if (s.startsWith(prevPrefix)) out.push(`${nextPrefix}${s.slice(prevPrefix.length)}`);
  return uniqStrings(out);
}

export class SceneVehicleSystem {
  /** @param {any} host */
  constructor(host) {
    this.host = host;

    // Spawned driveable vehicles and driving context.
    this._vehicles = [];
    this._vehicleBoxes = [];
    this._vehicleCtx = { inVehicle: false, vehicleId: '', seatId: '', role: '', camMode: 'first', lastVehicleYaw: 0, prevMode: 'fps' };
    this._drivingEnabled = true;

    // Assetto Corsa physics bundle + texture caches.
    this._acPhysicsCache = new Map(); // url -> { atMs, simTuning, wheelRadius, wheelWidth, debug }
    this._acTextureCache = new Map(); // url -> THREE.Texture
    this._acMaterialsCache = new Map(); // url -> { atMs, matsByName }

    // Dynamic vehicle presets (from webautos/ scan).
    this._vehiclePresetsDyn = [];
    this._vehiclePresetsDynStatus = '';
    this._vehiclePresetsDynLoading = false;
    this._vehiclePresetsDynLoadedAtMs = 0;
    this._vehiclePresetsDynAutoRequested = false;

    // Vehicle physics backend (WASM-only).
    this._chronoVehWasm = new ProjectChronoWasmVehicleSim();
    this._vehicleSim = this._chronoVehWasm;
    this._vehicleSimKind = 'wasm'; // wasm
    // Debug: last failure reason when a spawn returns null.
    this._lastVehicleSpawnError = '';
    // Auto-init Chrono WASM in background.
    try { void this.initProjectChronoWasm(); } catch { /* ignore */ }

    // Realistic tire overlay asset (optional; used for proc:arena vehicles).
    this._tire = {
      enabled: true,
      url: '/external/polyhaven/old_tyre_2k/old_tyre_2k.gltf',
      widthMul: 1.0,
    };
    this._tireLoader = new GLTFLoader();
    this._tireAsset = null; // { url, root, alignQ, outerRadius, width }
    this._tireLoading = false;

    // Temp objects (avoid per-frame allocations).
    this._tmpSteerQ = new THREE.Quaternion();

    // Simple vehicle audio (WebAudio synth fallback).
    // Note: AC exports may include FMOD .bank + GUIDs (not decoded in browser). However, many cars
    // still ship sample-based audio via sfx/engine*.ini + .wav, which we can play directly.
    this._vehAudio = {
      enabled: true,
      ctx: null,
      master: null,
      activeVehicleId: '',
      synth: null,
      acSfx: null,
      acSfxBaseUrl: '',
      acSfxPreferInterior: true,
      warnNoAcAudioAtMs: 0,
      lastResumeAtMs: 0,
    };
    this._audioBufferCache = new Map(); // absUrl -> Promise<AudioBuffer>

    // Simple traffic AI (NPC drivers) following a loop route.
    this._traffic = {
      enabled: false,
      vehicleUrl: '',
      // Route: { points:[{x,y,z,tx,tz,s}], length:number }
      route: null,
      // Params
      count: 0,
      spacingM: 22,
      speedKphMin: 70,
      speedKphMax: 115,
      lookaheadBaseM: 7,
      lookaheadSpeedMul: 0.6,
      laneOffsetM: 0,
      // Internal
      startedAtMs: 0,
    };

    // Traffic route recording (useful when an AC track has no fast_lane.ai).
    this._trafficRecord = {
      active: false,
      points: [],
      lastX: NaN,
      lastZ: NaN,
      accMs: 0,
      sampleEveryMs: 350,
      sampleEveryDistM: 6.0,
      maxPoints: 8000,
    };

    // Vehicle HUD fallback:
    // SceneTool's driving HUD lives in its FPS demo overlay and is not always created for every scene.
    // Keep a local HUD so driving UI still works outside proc:arena.
    this._vehHud = null;
  }

  _ensureVehicleHud() {
    // No DOM in this environment.
    if (typeof document === 'undefined') return null;

    const cur = this._vehHud;
    if (cur?.root && cur.root.isConnected) return cur;

    try { cur?.root?.parentNode?.removeChild(cur.root); } catch { /* ignore */ }

    const vehSpeedVal = el('div', { style: { fontSize: '34px', fontWeight: '700', letterSpacing: '-0.02em', lineHeight: '1.0' } }, ['0']);
    const vehSpeedUnit = el('div', { style: { fontSize: '12px', opacity: '0.85', marginLeft: '6px' } }, ['KPH']);
    const vehGearVal = el('div', { style: {
      marginLeft: 'auto',
      fontSize: '22px',
      fontWeight: '700',
      padding: '4px 10px',
      borderRadius: '10px',
      background: 'rgba(255,255,255,0.08)',
      border: '1px solid rgba(255,255,255,0.12)',
      minWidth: '44px',
      textAlign: 'center',
    } }, ['D']);
    const vehRpmVal = el('div', { style: { fontSize: '12px', opacity: '0.92' } }, ['0 rpm']);
    const vehOdoVal = el('div', { style: { fontSize: '12px', opacity: '0.82' } }, ['0.00 km']);
    const vehRpmBarFill = el('div', { style: { height: '100%', width: '0%', background: 'linear-gradient(90deg, rgba(126,179,255,0.95), rgba(255,90,90,0.95))' } });
    const vehRpmBar = el('div', { style: {
      marginTop: '6px',
      height: '6px',
      borderRadius: '999px',
      overflow: 'hidden',
      background: 'rgba(255,255,255,0.10)',
      border: '1px solid rgba(255,255,255,0.10)',
    } }, [vehRpmBarFill]);
    const vehPedalThrottleFill = el('div', { style: { height: '100%', width: '0%', background: 'rgba(126,179,255,0.92)' } });
    const vehPedalBrakeFill = el('div', { style: { height: '100%', width: '0%', background: 'rgba(255,90,90,0.92)' } });
    const pedalBarStyle = {
      height: '5px',
      borderRadius: '999px',
      overflow: 'hidden',
      background: 'rgba(255,255,255,0.08)',
      border: '1px solid rgba(255,255,255,0.10)',
    };
    const vehPedals = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '8px' } }, [
      el('div', { style: pedalBarStyle }, [vehPedalThrottleFill]),
      el('div', { style: pedalBarStyle }, [vehPedalBrakeFill]),
    ]);
    const vehTagStyle = {
      padding: '2px 8px',
      borderRadius: '999px',
      background: 'rgba(255,255,255,0.06)',
      border: '1px solid rgba(255,255,255,0.12)',
      fontSize: '10px',
      fontWeight: '700',
      letterSpacing: '-0.01em',
      lineHeight: '1.4',
      opacity: '0.92',
    };
    const vehCamTag = el('div', { style: vehTagStyle }, ['CAM 1P']);
    const vehHbTag = el('div', { style: { ...vehTagStyle, opacity: '0.65' } }, ['HB']);
    const vehControlsHint = el('div', { style: { marginLeft: 'auto', fontSize: '10px', opacity: '0.62', whiteSpace: 'nowrap' } }, [
      'W/S throttle+brake · A/D steer · Space HB · V cam · F exit',
    ]);
    const vehMeta = el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' } }, [
      vehCamTag,
      vehHbTag,
      vehControlsHint,
    ]);

    const root = el('div', { style: {
      position: 'fixed',
      right: '12px',
      bottom: '12px',
      padding: '10px 12px',
      borderRadius: '10px',
      background: 'rgba(10,13,18,0.65)',
      border: '1px solid rgba(255,255,255,0.10)',
      backdropFilter: 'blur(10px)',
      WebkitBackdropFilter: 'blur(10px)',
      minWidth: '250px',
      display: 'none',
      pointerEvents: 'none',
      zIndex: '9999',
      fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
      color: 'rgba(234,240,255,0.92)',
    } }, [
      el('div', { style: { display: 'flex', alignItems: 'baseline', gap: '0px' } }, [
        vehSpeedVal,
        vehSpeedUnit,
        vehGearVal,
      ]),
      el('div', { style: { display: 'flex', gap: '10px', marginTop: '6px', alignItems: 'baseline' } }, [
        vehRpmVal,
        el('div', { style: { marginLeft: 'auto' } }, [vehOdoVal]),
      ]),
      vehRpmBar,
      vehPedals,
      vehMeta,
    ]);

    // Always mount to <body> so `position: fixed` is reliable.
    // (Some shells apply transforms to UI roots, which changes fixed positioning.)
    try { (this.host?._canvas?.ownerDocument || document).body?.appendChild(root); } catch { document.body.appendChild(root); }

    this._vehHud = {
      root,
      speedVal: vehSpeedVal,
      gearVal: vehGearVal,
      rpmVal: vehRpmVal,
      odoVal: vehOdoVal,
      rpmBarFill: vehRpmBarFill,
      throttleFill: vehPedalThrottleFill,
      brakeFill: vehPedalBrakeFill,
      camTag: vehCamTag,
      hbTag: vehHbTag,
    };
    return this._vehHud;
  }

  _ensureVehicleAudio() {
    const a = this._vehAudio;
    if (!a || a.enabled === false) return null;
    if (a.ctx && a.master) return a;
    try {
      const Ctx = (globalThis.AudioContext || globalThis.webkitAudioContext);
      if (!Ctx) return null;
      const ctx = new Ctx();
      const master = ctx.createGain();
      master.gain.value = 0.18;
      master.connect(ctx.destination);
      a.ctx = ctx;
      a.master = master;
      try { if (ctx.state === 'suspended') void ctx.resume(); } catch { /* ignore */ }
      return a;
    } catch {
      return null;
    }
  }

  async _loadAudioBuffer(absUrl) {
    const a = this._vehAudio;
    if (!a?.ctx) throw new Error('AudioContext not ready');
    const url = safeTrim(absUrl);
    if (!url) throw new Error('Missing audio url');
    const cache = this._audioBufferCache;
    if (cache?.has(url)) return await cache.get(url);
    const p = (async () => {
      const resp = await fetch(url, { cache: 'force-cache' });
      if (!resp.ok) throw new Error(`Audio fetch failed: ${resp.status}`);
      const ab = await resp.arrayBuffer();
      // Some browsers require copy; best-effort.
      const buf = await a.ctx.decodeAudioData(ab.slice(0));
      return buf;
    })();
    try { cache?.set?.(url, p); } catch { /* ignore */ }
    return await p;
  }

  _resumeVehicleAudioIfNeeded() {
    const a = this._vehAudio;
    if (!a?.ctx) return;
    try {
      const now = Date.now();
      // Avoid spamming resume calls.
      if ((now - (Number(a.lastResumeAtMs) || 0)) < 250) return;
      a.lastResumeAtMs = now;
      if (a.ctx.state === 'suspended') void a.ctx.resume();
    } catch { /* ignore */ }
  }

  _stopVehicleSynth({ fadeSec = 0.12 } = {}) {
    const a = this._vehAudio;
    const s = a?.synth || null;
    if (!a || !s) return;
    try { s.stop({ fadeSec }); } catch { /* ignore */ }
    a.synth = null;
    // Keep activeVehicleId managed by the caller so AC audio can take over.
  }

  _stopVehicleAcSfx({ fadeSec = 0.12 } = {}) {
    const a = this._vehAudio;
    const s = a?.acSfx || null;
    if (!a || !s) return;
    try { s.stop({ fadeSec }); } catch { /* ignore */ }
    a.acSfx = null;
    a.acSfxBaseUrl = '';
  }

  _stopAllVehicleAudio({ fadeSec = 0.12 } = {}) {
    try { this._stopVehicleAcSfx({ fadeSec }); } catch { /* ignore */ }
    try { this._stopVehicleSynth({ fadeSec }); } catch { /* ignore */ }
    try { if (this._vehAudio) this._vehAudio.activeVehicleId = ''; } catch { /* ignore */ }
  }

  _ensureVehicleAcSfxFor(vehicleId, { baseUrl, preferInterior = true } = {}) {
    const a = this._ensureVehicleAudio();
    if (!a?.ctx || !a.master) return null;
    const vid = safeTrim(vehicleId);
    const bu = safeTrim(baseUrl);
    if (!vid || !bu) return null;

    if (a.acSfx && safeTrim(a.activeVehicleId) === vid && safeTrim(a.acSfxBaseUrl) === bu) {
      try { a.acSfx.setPreferInterior(!!preferInterior); } catch { /* ignore */ }
      return a.acSfx;
    }

    const sameVeh = safeTrim(a.activeVehicleId) === vid;
    // Switching vehicles: stop everything. Switching base URL for same vehicle: keep synth running
    // while AC samples load (we'll fade synth out once AC is ready).
    if (!sameVeh) this._stopAllVehicleAudio({ fadeSec: 0.08 });
    else this._stopVehicleAcSfx({ fadeSec: 0.08 });
    a.activeVehicleId = vid;
    a.acSfxBaseUrl = bu;
    a.acSfxPreferInterior = !!preferInterior;
    try {
      a.acSfx = new AcSfxSampleEngine(a.ctx, a.master, {
        baseUrl: bu,
        preferInterior: !!preferInterior,
        loadAudioBuffer: (u) => this._loadAudioBuffer(u),
      });
      // Fire and forget; if it fails we'll fall back to synth.
      void a.acSfx.load();
      return a.acSfx;
    } catch {
      a.acSfx = null;
      a.acSfxBaseUrl = '';
      return null;
    }
  }

  _ensureVehicleSynthFor(vehicleId) {
    const a = this._ensureVehicleAudio();
    if (!a?.ctx || !a.master) return null;
    const vid = safeTrim(vehicleId);
    if (!vid) return null;
    const sameVeh = safeTrim(a.activeVehicleId) === vid;
    if (a.synth && sameVeh) return a.synth;
    // If we're already loading/playing AC audio for this vehicle, allow synth to coexist
    // temporarily without interrupting the AC loader.
    if (!sameVeh) {
      // Switch active engine audio to the new vehicle.
      this._stopAllVehicleAudio({ fadeSec: 0.08 });
      a.activeVehicleId = vid;
    }
    try {
      a.synth = new SimpleVehicleEngineSynth(a.ctx, a.master);
      return a.synth;
    } catch {
      a.activeVehicleId = '';
      a.synth = null;
      return null;
    }
  }

  // ---- Host proxies (keep moved code changes small) ----
  get _ctx() { return this.host?._ctx; }
  get _ui() { return this.host?._ui; }
  get _scene() { return this.host?._scene; }
  get _camera() { return this.host?._camera; }
  get _player() { return this.host?._player; }
  get _state() { return this.host?._state; }
  get _plock() { return this.host?._plock; }
  get _keysDown() { return this.host?._keysDown; }
  get _keysPressed() { return this.host?._keysPressed; }
  get _game() { return this.host?._game; }
  get _triggerInteractHintActive() { return this.host?._triggerInteractHintActive; }

  _tryPointerLock(reason = '') { return this.host?._tryPointerLock?.(reason); }
  _collidesAtRadius(x, yFeet, z, r) { return this.host?._collidesAtRadius?.(x, yFeet, z, r); }
  _findGroundY(x, y, z) { return this.host?._findGroundY?.(x, y, z); }
  _setStatus(msg) { return this.host?._setStatus?.(msg); }
  _showMsg(msg, sec) { return this.host?._showMsg?.(msg, sec); }
  async _getPropTemplate(url) { return await this.host?._getPropTemplate?.(url); }

  // ---- Public API used by SceneTool ----
  inVehicle() { return !!this._vehicleCtx?.inVehicle; }
  getVehicleCtx() { return this._vehicleCtx; }
  getVehicles() { return Array.isArray(this._vehicles) ? this._vehicles : []; }
  getSpawnedAssetVehicleCount() { return (Array.isArray(this._vehicles) ? this._vehicles : []).filter((v) => safeTrim(v?.kind) === 'asset').length; }
  getVehicleBoxes() { return Array.isArray(this._vehicleBoxes) ? this._vehicleBoxes : []; }
  setDrivingEnabled(enabled) { this._drivingEnabled = (enabled == null) ? true : !!enabled; }
  getDrivingEnabled() { return !!this._drivingEnabled; }

  /**
   * Deterministic enter (used by scenario auto-enter).
   * @param {string} vehicleId
   * @param {string} seatId
   */
  enterVehicleById(vehicleId, seatId = 'driver') {
    const vid = safeTrim(vehicleId);
    const sid = safeTrim(seatId) || 'driver';
    if (!vid) return false;
    const v = (this._vehicles || []).find((x) => safeTrim(x?.id) === vid) || null;
    if (!v) return false;
    const seat = (v?.seats || []).find((s) => safeTrim(s?.id) === sid) || (v?.seats || [])[0] || null;
    if (!seat) return false;

    // If already in a vehicle, exit first (best-effort).
    if (this._vehicleCtx?.inVehicle) {
      try { this._tryExitVehicle(); } catch { /* ignore */ }
    }

    // Ensure FPS mode (vehicle cam logic assumes fps).
    const prevMode = String(this._state?.mode || 'fps');
    if (prevMode === 'orbit') {
      this._state.mode = 'fps';
      this.host?._savePrefs?.();
      this.host?._syncModeUi?.();
    }

    // Handle occupancy. For driver seat, allow takeover similar to normal enter flow.
    try {
      const occ = v.occ?.get?.(seat.id) || null;
      if (safeTrim(seat.id) === 'driver' && occ) {
        const free = (v.seats || []).find((s) => safeTrim(s?.id) !== 'driver' && !v.occ.get(s.id));
        if (free) v.occ.set(free.id, occ);
        v.occ.set('driver', null);
      }
      if (v.occ?.get?.(seat.id)) return false;
      v.occ.set(seat.id, 'player');
    } catch { /* ignore */ }

    this._vehicleCtx = {
      inVehicle: true,
      vehicleId: v.id,
      seatId: seat.id,
      role: seat.role,
      camMode: 'first',
      lastVehicleYaw: Number(v.yaw) || 0,
      prevMode,
    };

    // Keep player anchored at vehicle for trigger/interaction logic.
    try {
      this._player.x = Number(v.group?.position?.x) || 0;
      this._player.z = Number(v.group?.position?.z) || 0;
      this._player.y = 0;
      this._player.vy = 0;
    } catch { /* ignore */ }

    this._snapCameraToVehicleSeat(v, seat.id, 1 / 60);
    this._showMsg(seat.role === 'driver' ? 'Driving (F to exit)' : 'Passenger (F to exit)', 1.0);
    // Clear any "stuck" held keys (keyup can be missed during focus/pointer-lock transitions).
    // This is especially important for Space (handbrake) and S (brake/reverse) when entering vehicles.
    try { this._keysDown?.clear?.(); } catch { /* ignore */ }
    try { this._keysPressed?.clear?.(); } catch { /* ignore */ }
    try { if (this._state.mode === 'fps' && !this._plock?.isLocked) this._tryPointerLock('enter_vehicle'); } catch { /* ignore */ }
    return true;
  }

  stopTraffic() {
    this._traffic.enabled = false;
    this._traffic.route = null;
    this._traffic.vehicleUrl = '';
    this._traffic.count = 0;
    // Remove any traffic-tagged vehicles.
    try {
      const keep = [];
      for (const v of (this._vehicles || [])) {
        const isTraffic = !!(v?.ai && safeTrim(v.ai.kind) === 'traffic');
        if (!isTraffic) { keep.push(v); continue; }
        try { if (v?.group && this._scene) this._scene.remove(v.group); } catch { /* ignore */ }
        try { if (v?.simHandle) this._vehicleSim?.destroyVehicle?.(v.simHandle); } catch { /* ignore */ }
        try { disposeThreeObject(v?.group); } catch { /* ignore */ }
      }
      this._vehicles = keep;
    } catch { /* ignore */ }
  }

  /**
   * Start traffic AI along a loop route.
   * @param {{
   *  routePoints: {x:number,y?:number,z:number}[],
   *  vehicleUrl: string,
   *  count?: number,
   *  spacingM?: number,
   *  speedKphMin?: number,
   *  speedKphMax?: number,
   *  lookaheadBaseM?: number,
   *  lookaheadSpeedMul?: number,
   *  laneOffsetM?: number,
   * }} opts
   */
  async startTraffic(opts) {
    const o = (opts && typeof opts === 'object') ? opts : {};
    const url = safeTrim(o.vehicleUrl || '');
    const pts0 = Array.isArray(o.routePoints) ? o.routePoints : [];
    if (!url || pts0.length < 3) return false;

    // Reset any existing traffic.
    this.stopTraffic();

    const route = this._buildTrafficRoute(pts0);
    if (!route) return false;

    this._traffic.enabled = true;
    this._traffic.vehicleUrl = url;
    this._traffic.route = route;
    this._traffic.count = Math.max(1, Math.min(200, Math.floor(Number(o.count) || 24)));
    this._traffic.spacingM = Math.max(6, Math.min(140, Number(o.spacingM) || 22));
    this._traffic.speedKphMin = Math.max(10, Math.min(220, Number(o.speedKphMin) || 70));
    this._traffic.speedKphMax = Math.max(this._traffic.speedKphMin, Math.min(260, Number(o.speedKphMax) || 115));
    this._traffic.lookaheadBaseM = Math.max(2, Math.min(30, Number(o.lookaheadBaseM) || 7));
    this._traffic.lookaheadSpeedMul = Math.max(0, Math.min(2.5, Number(o.lookaheadSpeedMul) || 0.6));
    this._traffic.laneOffsetM = clamp(Number(o.laneOffsetM) || 0, -12, 12);
    this._traffic.startedAtMs = Date.now();

    // Spawn vehicles along the route.
    const n = this._traffic.count;
    for (let i = 0; i < n; i++) {
      const s0 = (i * this._traffic.spacingM) % Math.max(1e-3, route.length);
      const pose = this._routePoseAtS(route, s0, this._traffic.laneOffsetM);
      if (!pose) continue;
      try {
        const v = await this.spawnDriveableVehicleFromAssetUrl(url, {
          name: `traffic_${i + 1}`,
          scale: 1.0,
          yawDeg: (pose.yawRad * 180 / Math.PI),
          x: pose.x,
          z: pose.z,
          place: 'player',
          vehicleConfig: null,
        });
        if (!v?.group) continue;
        try { v.occ?.set?.('driver', 'npc'); } catch { /* ignore */ }
        v.ai = {
          kind: 'traffic',
          s: s0,
          iHint: pose.iHint || 0,
          speedTarget: this._pickTrafficSpeedTargetMps(i),
        };
      } catch { /* ignore */ }
    }
    return true;
  }

  startTrafficRecording() {
    this._trafficRecord.active = true;
    this._trafficRecord.points = [];
    this._trafficRecord.lastX = NaN;
    this._trafficRecord.lastZ = NaN;
    this._trafficRecord.accMs = 0;
    try { this._setStatus('Traffic route recording: ON (drive the highway, then stop + commit).'); } catch { /* ignore */ }
  }

  stopTrafficRecording({ commitToScenario = true } = {}) {
    this._trafficRecord.active = false;
    const pts = Array.isArray(this._trafficRecord.points) ? this._trafficRecord.points.slice() : [];
    if (!pts.length) {
      try { this._setStatus('Traffic route recording: stopped (no points).'); } catch { /* ignore */ }
      return pts;
    }
    try { this._setStatus(`Traffic route recording: stopped (${pts.length} pts).`); } catch { /* ignore */ }

    if (commitToScenario) {
      try {
        const host = this.host;
        if (!host) return pts;
        const sc = (host._scenarioContent && typeof host._scenarioContent === 'object') ? host._scenarioContent : null;
        if (!sc) return pts;
        sc.traffic = (sc.traffic && typeof sc.traffic === 'object') ? sc.traffic : {};
        sc.traffic.enabled = true;
        sc.traffic.route = { kind: 'points', points: pts };
        // Reasonable defaults (can be edited by hand in saved scenario JSON).
        if (!safeTrim(sc.traffic.vehicleUrl)) sc.traffic.vehicleUrl = '/webautos/ac__streetcarpack_nissan_350z/stream/ac__streetcarpack_nissan_350z_hi.glb';
        if (!Number.isFinite(Number(sc.traffic.count))) sc.traffic.count = 32;
        if (!Number.isFinite(Number(sc.traffic.spacingM))) sc.traffic.spacingM = 26;
        if (!Number.isFinite(Number(sc.traffic.speedKphMin))) sc.traffic.speedKphMin = 70;
        if (!Number.isFinite(Number(sc.traffic.speedKphMax))) sc.traffic.speedKphMax = 120;
        if (!Number.isFinite(Number(sc.traffic.laneOffsetM))) sc.traffic.laneOffsetM = 3.2;
        try { host._renderWaypointsUi?.(); } catch { /* ignore */ }
      } catch { /* ignore */ }
    }
    return pts;
  }

  clearTrafficRecording() {
    this._trafficRecord.points = [];
    this._trafficRecord.lastX = NaN;
    this._trafficRecord.lastZ = NaN;
    this._trafficRecord.accMs = 0;
    try { this._setStatus('Traffic route recording: cleared.'); } catch { /* ignore */ }
  }

  resetForWorldClear() {
    // Remove from scene, reset handles, clear context.
    try {
      for (const v of (this._vehicles || [])) {
        try { if (v?.group && this._scene) this._scene.remove(v.group); } catch { /* ignore */ }
        try { disposeThreeObject(v?.group); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    this._vehicles = [];
    this._vehicleBoxes = [];
    this._vehicleCtx = { inVehicle: false, vehicleId: '', seatId: '', role: '', camMode: 'first', lastVehicleYaw: 0, prevMode: 'fps' };
    this._traffic.enabled = false;
    this._traffic.route = null;
    this._traffic.vehicleUrl = '';
    this._traffic.count = 0;
    try { this._vehHud?.root?.parentNode?.removeChild?.(this._vehHud.root); } catch { /* ignore */ }
    this._vehHud = null;
    try { this._vehicleSim?.reset?.(); } catch { /* ignore */ }
    try { this._syncVehicleSimStatics(); } catch { /* ignore */ }
  }

  async initProjectChronoWasm() {
    // Initialize Project Chrono WASM backend (single vehicle backend).
    const ok = await this._chronoVehWasm.init();
    if (!ok) {
      const raw = this._chronoVehWasm?.initError;
      const msg = safeTrim(raw) ? `Failed to init Project Chrono WASM: ${safeTrim(raw)}` : 'Failed to init Project Chrono WASM (no error details).';
      try {
        this._ctx?.toast?.(msg, 'warning', { title: 'Vehicles (WASM)' });
      } catch { /* ignore */ }
      return;
    }

    this._vehicleSim = this._chronoVehWasm;
    this._vehicleSimKind = 'wasm';
    try { this._ctx?.toast?.('Project Chrono WASM loaded (vehicle physics enabled)', 'success', { title: 'Vehicles' }); } catch { /* ignore */ }

    // Create a fresh Chrono world and re-bind existing vehicles to it.
    try { this._vehicleSim.reset(); } catch { /* ignore */ }
    try { this._syncVehicleSimStatics(); } catch { /* ignore */ }
    try { this._recreateVehicleSimHandles(); } catch { /* ignore */ }
  }

  syncStatics() {
    try { this._syncVehicleSimStatics(); } catch { /* ignore */ }
  }

  tick(dt) {
    this._tickVehicles(dt);
    try { this._tickVehicleHud(dt); } catch { /* ignore */ }
    try { this._tickTrafficRecording(dt); } catch { /* ignore */ }
  }

  nearestVehicleDoor(maxDist = 1.6) {
    return this._nearestVehicleDoor(maxDist);
  }

  tryEnterVehicle() { return this._tryEnterVehicle(); }
  tryExitVehicle() { return this._tryExitVehicle(); }

  toggleVehicleCamera() {
    if (!this._vehicleCtx?.inVehicle) return false;
    this._vehicleCtx.camMode = (this._vehicleCtx.camMode === 'third') ? 'first' : 'third';
    const mode = this._vehicleCtx.camMode;
    if (mode === 'third' && this._camera) {
      const v = (this._vehicles || []).find((x) => x?.id === this._vehicleCtx.vehicleId) || null;
      if (v) {
        try { this._camera.rotation.order = 'YXZ'; } catch { /* ignore */ }
        try { this._camera.rotation.y = Number(v.yaw) || 0; } catch { /* ignore */ }
        try { this._camera.rotation.z = 0; } catch { /* ignore */ }
        this._vehicleCtx.lastVehicleYaw = Number(v.yaw) || 0;
      }
    }
    this._showMsg(mode === 'third' ? 'Vehicle cam: third-person' : 'Vehicle cam: first-person', 0.8);
    return true;
  }

  // UI hook: called by SceneTool._buildUi() at the place where vehicle presets used to render.
  appendVehiclesUi({ detailsCard, host, ui }) {
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
    ui.vehiclePresetSel = vehiclePresetSel;
    ui.vehiclePresetInfo = vehicleInfo;
    ui.vehicleScaleInput = vehicleScaleInput;
    ui.vehicleYawInput = vehicleYawInput;
    ui.vehiclePresetStatusEl = vehiclePresetStatusEl;

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
    ui.vehiclePresetRefreshBtn = refreshVehiclePresetsBtn;

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

    // Vehicle physics backend selector (JS bicycle vs Chrono WASM).
    // Vehicle physics backend (WASM-only).
    const backendStatusEl = el('div', { class: 'muted', style: { fontSize: '10px', whiteSpace: 'pre-wrap' } }, ['']);
    const refreshBackendStatus = () => {
      const kind = safeTrim(this._vehicleSimKind || '');
      const wasmReady = !!this._chronoVehWasm?.ready;
      const wasmErr = safeTrim(this._chronoVehWasm?.initError || '');
      backendStatusEl.textContent = [
        `Backend: ${kind || '(none)'}`,
        `WASM ready: ${wasmReady ? 'yes' : 'no'}`,
        wasmErr ? `WASM initError: ${wasmErr}` : '',
      ].filter(Boolean).join('\n');
    };
    try { refreshBackendStatus(); } catch { /* ignore */ }
    // Keep backend status live so init errors show up even if init happens in the background.
    try {
      if (ui._vehicleBackendStatusTimer) clearInterval(ui._vehicleBackendStatusTimer);
      ui._vehicleBackendStatusTimer = setInterval(() => { try { refreshBackendStatus(); } catch { /* ignore */ } }, 350);
    } catch { /* ignore */ }

    // Live runtime debug readout (helps validate that AC tuning + JSON vehicle path is active).
    // Make this visually distinct so it's easy to find while debugging.
    const vehicleRuntimeInfoEl = el('div', {
      class: 'muted',
      style: {
        marginTop: '6px',
        fontSize: '10px',
        whiteSpace: 'pre-wrap',
        padding: '6px 8px',
        borderRadius: '6px',
        border: '1px solid rgba(255,255,255,0.10)',
        background: 'rgba(255,255,255,0.04)',
        userSelect: 'text',
      },
    }, ['Vehicles runtime: (loading…)']);
    ui.vehicleRuntimeInfoEl = vehicleRuntimeInfoEl;
    const refreshRuntimeVehicleInfo = () => {
      try {
        const kind = safeTrim(this._vehicleSimKind || '');
        const vv = (() => {
          const curId = safeTrim(this._vehicleCtx?.vehicleId || '');
          if (curId) return (this._vehicles || []).find((x) => safeTrim(x?.id) === curId) || null;
          return (this._vehicles && this._vehicles.length) ? this._vehicles[0] : null;
        })();
        if (!vv) {
          vehicleRuntimeInfoEl.textContent = [
            'Vehicles runtime:',
            `Backend active: ${kind || '(none)'}`,
            'Active vehicle: (none)',
          ].join('\n');
          return;
        }
        const st = (vv?.simHandle) ? this._vehicleSim?.getState?.(vv.simHandle) : null;
        const ws = (kind === 'wasm' && vv?.simHandle) ? this._vehicleSim?.getWheelState?.(vv.simHandle) : null;
        let lockDeg = NaN;
        let ratio = NaN;
        let wb = NaN;
        try { lockDeg = Number(vv?.acTuning?.debug?.steerLockDeg); } catch { /* ignore */ }
        try { ratio = Number(vv?.acTuning?.debug?.steerRatio); } catch { /* ignore */ }
        try { wb = Number(vv?.acTuning?.simTuning?.wheelbase); } catch { /* ignore */ }
        const jsonPath = safeTrim(vv?.simCreateOptions?.wasm?.jsonPath || '');
        const steerFL = Number(ws?.steerFL);
        const steerFR = Number(ws?.steerFR);
        const omegaFL = Number(ws?.omegaFL);
        const omegaFR = Number(ws?.omegaFR);
        const omegaRL = Number(ws?.omegaRL);
        const omegaRR = Number(ws?.omegaRR);
        const wsGear = Number(ws?.gear);
        const wsHasTrans = !!ws?.hasTransmission;
        const wsTq = Number(ws?.driveshaftTorqueNm);
        const wsMotRpm = Number(ws?.motorshaftRpm);
        const slipRearEstPct = (() => {
          // Very rough slip ratio estimate using driven wheel omega (rear) vs vehicle forward speed.
          // This is just for debugging "are we spinning" and is not used by the sim.
          const r = Number(vv?.acTuning?.wheelRadius) || Number(vv?.acTuning?.simTuning?.wheelRadius) || 0;
          const rUse = (Number.isFinite(r) && r > 0.05) ? r : 0.33;
          const vAbs = Math.abs(Number(st?.speed) || 0);
          const wAvg = 0.5 * ((Number.isFinite(omegaRL) ? omegaRL : 0) + (Number.isFinite(omegaRR) ? omegaRR : 0));
          const vWheel = Math.abs(wAvg) * rUse;
          const denom = Math.max(1e-3, Math.max(vAbs, 1.0));
          const slip = (vWheel - vAbs) / denom;
          return clamp(slip * 100, -250, 250);
        })();
        const betaDeg = (() => {
          const u = Number(st?.uBody);
          const w = Number(st?.wBody);
          if (!Number.isFinite(u) || !Number.isFinite(w)) return NaN;
          return (Math.atan2(w, Math.max(1e-6, Math.abs(u))) * (180 / Math.PI));
        })();
        const slipF = Number(st?.slipFront01);
        const slipR = Number(st?.slipRear01);
        vehicleRuntimeInfoEl.textContent = [
          'Vehicles runtime:',
          `Backend active: ${kind || '(none)'}`,
          `Vehicle: ${safeTrim(vv?.id) || '(unnamed)'} (${safeTrim(vv?.driveType) || 'wheeled'})`,
          `simHandle: ${Number(vv?.simHandle) || 0}`,
          jsonPath ? `Chrono JSON: ${jsonPath}` : 'Chrono JSON: (none)',
          Number.isFinite(wb) ? `AC wheelbase: ${wb.toFixed(3)} m` : '',
          Number.isFinite(lockDeg) ? `AC steer_lock: ${lockDeg.toFixed(1)} deg` : '',
          Number.isFinite(ratio) ? `AC steer_ratio: ${ratio.toFixed(2)}` : '',
          st ? `speed: ${(Number(st?.speed) || 0).toFixed(2)} m/s` : 'state: (missing)',
          st ? `steer: ${((Number(st?.steerRad) || 0) * (180 / Math.PI)).toFixed(1)}°` : '',
          st ? `yawRate: ${((Number(st?.yawRate) || 0) * (180 / Math.PI)).toFixed(1)} °/s` : '',
          (kind === 'wasm' && ws)
            ? `trans: ${wsHasTrans ? 'yes' : 'no'} · gear ${Number.isFinite(wsGear) ? wsGear.toFixed(0) : '?'} · shaft ${(Number.isFinite(wsMotRpm) ? wsMotRpm.toFixed(0) : '?')} rpm · tq ${(Number.isFinite(wsTq) ? wsTq.toFixed(0) : '?')} Nm`
            : '',
          st ? `body u: ${(Number(st?.uBody) || 0).toFixed(2)} m/s, w: ${(Number(st?.wBody) || 0).toFixed(2)} m/s, beta≈${Number.isFinite(betaDeg) ? betaDeg.toFixed(1) : '?'}°` : '',
          (Number.isFinite(slipF) && Number.isFinite(slipR)) ? `axle saturation: front ${(clamp01(slipF) * 100).toFixed(0)}%, rear ${(clamp01(slipR) * 100).toFixed(0)}%` : '',
          st ? `alphaF: ${((Number(st?.alphaF) || 0) * (180 / Math.PI)).toFixed(1)}°, alphaR: ${((Number(st?.alphaR) || 0) * (180 / Math.PI)).toFixed(1)}°` : '',
          (Number.isFinite(steerFL) && Number.isFinite(steerFR))
            ? `wheel steer: FL ${(steerFL * (180 / Math.PI)).toFixed(1)}°, FR ${(steerFR * (180 / Math.PI)).toFixed(1)}°`
            : '',
          (Number.isFinite(omegaFL) || Number.isFinite(omegaFR) || Number.isFinite(omegaRL) || Number.isFinite(omegaRR))
            ? `wheel ω (rad/s): FL ${Number.isFinite(omegaFL) ? omegaFL.toFixed(1) : '?'}, FR ${Number.isFinite(omegaFR) ? omegaFR.toFixed(1) : '?'}, RL ${Number.isFinite(omegaRL) ? omegaRL.toFixed(1) : '?'}, RR ${Number.isFinite(omegaRR) ? omegaRR.toFixed(1) : '?'}`
            : '',
          (kind === 'wasm' && st) ? `rear slip est: ${Number.isFinite(slipRearEstPct) ? slipRearEstPct.toFixed(0) : '?'}%` : '',
        ].filter(Boolean).join('\n');
      } catch { /* ignore */ }
    };
    try {
      if (ui._vehicleRuntimeInfoTimer) clearInterval(ui._vehicleRuntimeInfoTimer);
      ui._vehicleRuntimeInfoTimer = setInterval(() => { try { refreshRuntimeVehicleInfo(); } catch { /* ignore */ } }, 250);
    } catch { /* ignore */ }
    // Populate once immediately so the box isn't empty.
    try { refreshRuntimeVehicleInfo(); } catch { /* ignore */ }

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
          const out = await this.spawnDriveableVehicleFromAssetUrl(resolved.modelUrl, {
            name: safeTrim(resolved?.preset?.label) || safeTrim(resolved?.preset?.id) || 'vehicle',
            scale: sc,
            yawDeg,
            place: 'player',
            vehicleConfig: resolved.vehicleConfig || null,
          });
          if (!out) {
            const wasmErr = safeTrim(this._chronoVehWasm?.initError || '');
            if (!this._chronoVehWasm?.ready && wasmErr) throw new Error(`Vehicle sim unavailable: ${wasmErr}`);
            throw new Error('Vehicle sim unavailable or model failed to load.');
          }
          this._setStatus(`Spawned vehicle preset @ player: ${safeTrim(resolved?.preset?.label) || pid}`);
          this._ctx?.toast?.('Driveable vehicle spawned', 'success', { title: 'Vehicles' });
          void this.host?._renderPropsUi?.();
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
          const out = await this.spawnDriveableVehicleFromAssetUrl(resolved.modelUrl, {
            name: safeTrim(resolved?.preset?.label) || safeTrim(resolved?.preset?.id) || 'vehicle',
            scale: sc,
            yawDeg,
            place: 'spawn',
            vehicleConfig: resolved.vehicleConfig || null,
          });
          if (!out) {
            const wasmErr = safeTrim(this._chronoVehWasm?.initError || '');
            if (!this._chronoVehWasm?.ready && wasmErr) throw new Error(`Vehicle sim unavailable: ${wasmErr}`);
            throw new Error('Vehicle sim unavailable or model failed to load.');
          }
          this._setStatus(`Spawned vehicle preset @ spawn: ${safeTrim(resolved?.preset?.label) || pid}`);
          this._ctx?.toast?.('Driveable vehicle spawned', 'success', { title: 'Vehicles' });
          void this.host?._renderPropsUi?.();
        } catch (e) {
          this._ctx?.toast?.(`Vehicle spawn failed: ${e?.message || e}`, 'error', { title: 'Vehicles' });
        }
      },
      title: 'Spawn selected preset as a driveable vehicle at the spawn marker',
    }, ['Spawn selected @ spawn']);

    const setScenarioStartVehicleBtn = el('button', {
      onclick: async () => {
        try {
          const pid = safeTrim(vehiclePresetSel.value);
          if (!pid) throw new Error('Pick a vehicle preset first.');
          const resolved = await this._resolveVehiclePresetSelection(pid);
          const modelUrl = normalizeAssetUrl(resolved?.modelUrl || '');
          if (!modelUrl) throw new Error('Selected preset has no model URL.');

          const sc = this.host?._scenarioContent;
          if (!sc || typeof sc !== 'object') throw new Error('Scenario content unavailable (load a scene first).');
          sc.vehicles = Array.isArray(sc.vehicles) ? sc.vehicles : [];

          const entry = {
            role: 'player',
            name: safeTrim(resolved?.preset?.label) || safeTrim(resolved?.preset?.id) || 'Player vehicle',
            url: modelUrl,
            metaUrl: safeTrim(resolved?.vehicleConfig?.metaUrl || '') || metaUrlForModelUrl(modelUrl),
            place: 'spawn',
            yawDeg: Number(vehicleYawInput.value) || 0,
            scale: Math.max(0.001, Number(vehicleScaleInput.value) || 1.0),
            autoEnter: true,
            vehicleConfig: resolved?.vehicleConfig || {
              schema: 1,
              source: 'scene_vehicle_system_ui',
              modelUrl,
              metaUrl: metaUrlForModelUrl(modelUrl),
            },
          };

          // Upsert: ensure only one "player" entry.
          sc.vehicles = sc.vehicles.filter((v) => safeTrim(v?.role) !== 'player');
          sc.vehicles.unshift(entry);
          this._ctx?.toast?.('Scenario start vehicle set (auto-enter on load)', 'success', { title: 'Vehicles' });
        } catch (e) {
          this._ctx?.toast?.(`Set scenario start vehicle failed: ${e?.message || e}`, 'error', { title: 'Vehicles' });
        }
      },
      title: 'Writes a player vehicle entry into the current scenario (saved with Ctrl+S)',
    }, ['Set as scenario start (auto-enter)']);

    const usePresetInAssetUrlBtn = el('button', {
      onclick: async () => {
        try {
          const pid = safeTrim(vehiclePresetSel.value);
          if (!pid) throw new Error('Pick a vehicle preset first.');
          const resolved = await this._resolveVehiclePresetSelection(pid);
          const u = normalizeAssetUrl(resolved?.modelUrl || '');
          if (!u) throw new Error('Selected preset has no model URL.');
          if (ui?.propUrlInput) ui.propUrlInput.value = u;
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
        el('div', { style: { flex: '0 0 auto' } }, [el('div', { class: 'fieldLabel' }, ['Vehicle physics'])]),
        el('div', { style: { flex: '1 1 360px' } }, [backendStatusEl]),
      ]),
      vehicleRuntimeInfoEl,
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
        setScenarioStartVehicleBtn,
        usePresetInAssetUrlBtn,
      ]),
    ]));

    // Traffic AI tools (record a route, then spawn NPCs).
    const trafficCountInput = el('input', { value: '32', style: { width: '90px' }, title: 'Traffic car count' });
    const trafficSpacingInput = el('input', { value: '26', style: { width: '90px' }, title: 'Spacing (meters)' });
    const trafficMinKphInput = el('input', { value: '70', style: { width: '90px' }, title: 'Min speed (kph)' });
    const trafficMaxKphInput = el('input', { value: '120', style: { width: '90px' }, title: 'Max speed (kph)' });
    const trafficLaneOffsetInput = el('input', { value: '3.2', style: { width: '90px' }, title: 'Lane offset (meters, +right)' });
    const trafficModelUrlInput = el('input', {
      value: '/webautos/ac__streetcarpack_nissan_350z/stream/ac__streetcarpack_nissan_350z_hi.glb',
      style: { width: '520px', maxWidth: '100%' },
      title: 'Vehicle model URL for traffic',
    });
    const trafficStatusEl = el('div', { class: 'muted', style: { marginTop: '6px', fontSize: '10px', whiteSpace: 'pre-wrap' } }, ['']);
    const refreshTrafficStatus = () => {
      const recOn = !!this._trafficRecord?.active;
      const recN = Array.isArray(this._trafficRecord?.points) ? this._trafficRecord.points.length : 0;
      const scPts = (() => {
        try {
          const t = this.host?._scenarioContent?.traffic;
          const r = t?.route;
          if (r && typeof r === 'object' && safeTrim(r?.kind) === 'points' && Array.isArray(r?.points)) return r.points.length;
        } catch { /* ignore */ }
        return 0;
      })();
      const running = !!this._traffic?.enabled;
      trafficStatusEl.textContent = [
        `Recorder: ${recOn ? 'ON' : 'off'}   recorded points: ${recN}`,
        scPts ? `Scenario route points: ${scPts}` : '',
        `Traffic: ${running ? 'RUNNING' : 'stopped'}`,
      ].filter(Boolean).join('\n');
    };

    const trafficRecordBtn = el('button', {
      class: this._trafficRecord?.active ? 'danger' : 'primary',
      onclick: () => {
        if (this._trafficRecord?.active) this.stopTrafficRecording({ commitToScenario: true });
        else this.startTrafficRecording();
        refreshTrafficStatus();
      },
      title: 'Record a loop route from your current position (drive around, then click again to stop + commit)',
    }, [this._trafficRecord?.active ? 'Stop + commit recording' : 'Record traffic route']);

    const trafficClearBtn = el('button', {
      onclick: () => { this.clearTrafficRecording(); refreshTrafficStatus(); },
      title: 'Clear recorded points (does not remove scenario traffic config)',
    }, ['Clear recording']);

    const trafficStartBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        const recPts = Array.isArray(this._trafficRecord?.points) ? this._trafficRecord.points : [];
        const scPts = (() => {
          try {
            const t = this.host?._scenarioContent?.traffic;
            const r = t?.route;
            if (r && typeof r === 'object' && safeTrim(r?.kind) === 'points' && Array.isArray(r?.points)) return r.points;
          } catch { /* ignore */ }
          return [];
        })();
        const pts = (recPts.length >= 3) ? recPts : scPts;
        if (!pts || pts.length < 3) {
          this._ctx?.toast?.('No route points. Record a route first.', 'warning', { title: 'Traffic' });
          return;
        }
        const count = Math.max(1, Math.min(200, Math.floor(Number(trafficCountInput.value) || 32)));
        const spacingM = Math.max(6, Math.min(140, Number(trafficSpacingInput.value) || 26));
        const speedKphMin = Math.max(5, Math.min(260, Number(trafficMinKphInput.value) || 70));
        const speedKphMax = Math.max(speedKphMin, Math.min(320, Number(trafficMaxKphInput.value) || 120));
        const laneOffsetM = clamp(Number(trafficLaneOffsetInput.value) || 0, -12, 12);
        const vehicleUrl = safeTrim(trafficModelUrlInput.value || '');
        if (!vehicleUrl) return;

        // Persist into the scenario so Ctrl+S captures it (not just the in-memory traffic sim state).
        try {
          const sc = this.host?._scenarioContent;
          if (sc && typeof sc === 'object') {
            sc.traffic = (sc.traffic && typeof sc.traffic === 'object') ? sc.traffic : {};
            sc.traffic.enabled = true;
            sc.traffic.route = { kind: 'points', points: pts };
            sc.traffic.vehicleUrl = vehicleUrl;
            sc.traffic.count = count;
            sc.traffic.spacingM = spacingM;
            sc.traffic.speedKphMin = speedKphMin;
            sc.traffic.speedKphMax = speedKphMax;
            sc.traffic.laneOffsetM = laneOffsetM;
          }
        } catch { /* ignore */ }

        await this.startTraffic({ routePoints: pts, vehicleUrl, count, spacingM, speedKphMin, speedKphMax, laneOffsetM });
        refreshTrafficStatus();
        try { void this.host?._renderPropsUi?.(); } catch { /* ignore */ }
      },
      title: 'Spawn NPC cars and have them follow the recorded route',
    }, ['Start traffic']);

    const trafficStopBtn = el('button', {
      class: 'danger',
      onclick: () => { this.stopTraffic(); refreshTrafficStatus(); try { void this.host?._renderPropsUi?.(); } catch { /* ignore */ } },
      title: 'Stop traffic and remove traffic vehicles',
    }, ['Stop traffic']);

    host.appendChild(detailsCard('Traffic (AI)', { open: false, hint: 'record a route, spawn NPC traffic' }, [
      el('div', { class: 'muted', style: { fontSize: '10px' } }, [
        'Some AC tracks ship without fast_lane.ai. Record a loop route once (while driving), save the scenario, and traffic can reuse it.',
      ]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, [
        trafficRecordBtn,
        trafficClearBtn,
      ]),
      trafficStatusEl,
      el('div', { class: 'muted', style: { marginTop: '10px', fontSize: '10px' } }, ['Traffic parameters']),
      el('div', { class: 'row', style: { marginTop: '6px', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, [
        el('span', { class: 'muted' }, ['count']), trafficCountInput,
        el('span', { class: 'muted' }, ['spacing m']), trafficSpacingInput,
        el('span', { class: 'muted' }, ['min kph']), trafficMinKphInput,
        el('span', { class: 'muted' }, ['max kph']), trafficMaxKphInput,
        el('span', { class: 'muted' }, ['lane off m']), trafficLaneOffsetInput,
      ]),
      el('div', { class: 'muted', style: { marginTop: '10px', fontSize: '10px' } }, ['traffic vehicle modelUrl']),
      trafficModelUrlInput,
      el('div', { class: 'row', style: { marginTop: '10px', gap: '8px', flexWrap: 'wrap' } }, [
        trafficStartBtn,
        trafficStopBtn,
      ]),
    ]));
    refreshTrafficStatus();

    void refreshVehicleInfo();
    refreshBackendStatus();
    refreshRuntimeVehicleInfo();
    try { vehiclePresetStatusEl.textContent = safeTrim(this._vehiclePresetsDynStatus || ''); } catch { /* ignore */ }
    if (!this._vehiclePresetsDynAutoRequested) {
      this._vehiclePresetsDynAutoRequested = true;
      void this._refreshVehiclePresetsFromWebautos();
    }
  }

  // ---- Vehicle presets (webautos) ----
  _getVehiclePresetCatalog() {
    const base = Array.isArray(SCENE_VEHICLE_PRESETS) ? SCENE_VEHICLE_PRESETS.slice() : [];
    const dyn = Array.isArray(this._vehiclePresetsDyn) ? this._vehiclePresetsDyn.slice() : [];
    return base.concat(dyn);
  }

  async _refreshVehiclePresetsFromWebautos() {
    const ctx = this._ctx;
    if (!ctx || typeof ctx.assetIndex !== 'function') return;
    if (this._vehiclePresetsDynLoading) return;
    this._vehiclePresetsDynLoading = true;
    this._vehiclePresetsDynStatus = 'Scanning webautos/…';
    try { if (this._ui?.vehiclePresetStatusEl) this._ui.vehiclePresetStatusEl.textContent = this._vehiclePresetsDynStatus; } catch { /* ignore */ }

    try {
      const items = await ctx.assetIndex({ query: 'webautos/', ext: '.glb,.gltf' });
      let arr = Array.isArray(items) ? items : [];
      arr = arr.filter((it) => {
        const p = safeTrim(it?.path || '').replace(/\\/g, '/');
        if (!p.startsWith('webautos/')) return false;
        if (!p.includes('/stream/')) return false;
        const low = p.toLowerCase();
        if (!(low.endsWith('.glb') || low.endsWith('.gltf'))) return false;
        return low.includes('_hi.') || low.includes('/ac__') || low.includes('ac__') || low.endsWith('.glb');
      });
      arr.sort((a, b) => (Number(b?.mtimeMs) || 0) - (Number(a?.mtimeMs) || 0));
      arr = arr.slice(0, 350);

      const presets = [];
      for (const it of arr) {
        const rel = safeTrim(it?.path || '').replace(/^\/+/, '').replace(/\\/g, '/');
        if (!rel) continue;
        const parts = rel.split('/').filter(Boolean);
        const name = (parts[0] === 'webautos' && parts[1]) ? parts[1] : (parts[parts.length - 1] || rel);
        const label = String(name || '').trim() || rel;
        const modelUrl = '/' + rel;
        const metaUrl = (modelUrl.toLowerCase().endsWith('.glb'))
          ? modelUrl.slice(0, -4) + '.meta.json'
          : (modelUrl.toLowerCase().endsWith('.gltf') ? modelUrl.slice(0, -5) + '.meta.json' : modelUrl + '.meta.json');
        presets.push({
          id: `webautos:${rel}`,
          label,
          modelUrl,
          metaUrl,
          recommendedScale: 1.0,
          source: 'webautos',
        });
      }
      this._vehiclePresetsDyn = presets;
      this._vehiclePresetsDynLoadedAtMs = Date.now();
      this._vehiclePresetsDynStatus = `Loaded ${presets.length} preset(s) from webautos/.`;
    } catch (e) {
      this._vehiclePresetsDyn = [];
      this._vehiclePresetsDynStatus = `Scan failed: ${String(e?.message || e)}`;
    } finally {
      this._vehiclePresetsDynLoading = false;
      try { if (this._ui?.vehiclePresetStatusEl) this._ui.vehiclePresetStatusEl.textContent = this._vehiclePresetsDynStatus; } catch { /* ignore */ }
      try { if (this._ui?.vehiclePresetRefreshBtn) this._ui.vehiclePresetRefreshBtn.disabled = false; } catch { /* ignore */ }
      try { this._syncVehiclePresetSelectOptions(); } catch { /* ignore */ }
    }
  }

  _syncVehiclePresetSelectOptions() {
    const sel = this._ui?.vehiclePresetSel;
    if (!sel) return;
    const cur = safeTrim(sel.value || '');
    const presets = this._getVehiclePresetCatalog();
    clear(sel);
    for (const p of presets) {
      const pid = safeTrim(p?.id);
      if (!pid) continue;
      sel.appendChild(el('option', { value: pid }, [safeTrim(p?.label) || pid]));
    }
    const still = cur && presets.some((p) => safeTrim(p?.id) === cur);
    const pick = still ? cur : safeTrim(presets?.[0]?.id || '');
    try { sel.value = pick; } catch { /* ignore */ }
    try {
      if (this._ui?.vehicleScaleInput) {
        const vehicleScaleStorageKeyFor = (presetId) => `devtools.scene.vehicleScale.${safeTrim(presetId) || 'default'}`;
        const p = presets.find((pp) => safeTrim(pp?.id) === safeTrim(pick)) || null;
        const rec = Number(p?.recommendedScale);
        const recScale = (Number.isFinite(rec) && rec > 0) ? rec : 1.0;
        let v = '';
        try { v = String(localStorage.getItem(vehicleScaleStorageKeyFor(pick)) || '').trim(); } catch { v = ''; }
        const n = v ? Number(v) : NaN;
        this._ui.vehicleScaleInput.value = String((Number.isFinite(n) && n > 0) ? n : recScale);
      }
    } catch { /* ignore */ }
    try { this._ui?.vehiclePresetSel?.onchange?.(); } catch { /* ignore */ }
  }

  async _resolveVehiclePresetSelection(presetId) {
    const id = safeTrim(presetId);
    if (!id) return null;
    const preset = this._getVehiclePresetCatalog().find((p) => safeTrim(p?.id) === id) || null;
    if (!preset) return null;

    const modelCandidates = withVehiclePathFallbacks(preset.modelUrl || '').map((u) => normalizeAssetUrl(u)).filter(Boolean);
    const modelUrl = modelCandidates[0] || '';
    if (!modelUrl) throw new Error('Vehicle preset has no model URL.');

    let vehicleConfig = null;
    try {
      const inboxCandidates = withVehiclePathFallbacks(preset.sceneInboxUrl || '').map((u) => normalizeAssetUrl(u)).filter(Boolean);
      for (const inboxUrl of inboxCandidates) {
        try {
          const resp = await fetch(inboxUrl, { cache: 'no-store' });
          if (!resp.ok) continue;
          const j = await resp.json();
          if (j && typeof j === 'object') {
            const vc = (j?.vehicleConfig && typeof j.vehicleConfig === 'object') ? j.vehicleConfig : null;
            if (vc) {
              vehicleConfig = vc;
              break;
            }
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    if (!vehicleConfig) {
      let meta = null;
      const rawMeta = safeTrim(preset.metaUrl || '') || metaUrlForModelUrl(modelUrl);
      const metaCandidates = withVehiclePathFallbacks(rawMeta).map((u) => normalizeAssetUrl(u)).filter(Boolean);
      let metaUrl = metaCandidates[0] || '';
      for (const u of metaCandidates) {
        try {
          const resp = await fetch(u, { cache: 'no-store' });
          if (!resp.ok) continue;
          meta = await resp.json();
          metaUrl = u;
          break;
        } catch { /* ignore */ }
      }
      vehicleConfig = {
        schema: 1,
        source: 'scene_tool.vehicle_presets',
        modelUrl,
        metaUrl: metaUrl || '',
        meta: (meta && typeof meta === 'object') ? {
          wheelType: String(meta?.wheelType || ''),
          wheelScale: Number(meta?.wheelScale),
          wheelScaleRear: Number(meta?.wheelScaleRear),
          anchors: (meta?.anchors && typeof meta.anchors === 'object') ? meta.anchors : null,
        } : null,
        wheelOverlay: {
          enabled: true,
          useMetaScale: true,
          frontScaleMul: 1.0,
          rearScaleMul: 1.0,
          placeholderWidth: 0.20,
        },
        animationClipNames: [],
      };
    }

    vehicleConfig = {
      ...(vehicleConfig && typeof vehicleConfig === 'object' ? vehicleConfig : {}),
      schema: 1,
      source: safeTrim(vehicleConfig?.source) || 'scene_tool.vehicle_presets',
      modelUrl: safeTrim(vehicleConfig?.modelUrl) || modelUrl,
      metaUrl: safeTrim(vehicleConfig?.metaUrl) || metaUrlForModelUrl(modelUrl),
    };

    return { preset, modelUrl, vehicleConfig };
  }

  // ---- Assetto Corsa helpers ----
  _acBundleToParamsUrl(bundleUrl) {
    const u = safeTrim(bundleUrl);
    if (!u) return '';
    if (u.endsWith('/normalized/car.bundle.json')) return u.replace(/\/normalized\/car\.bundle\.json$/i, '/ac_raw/params.raw.json');
    if (!u.endsWith('.json') && !u.endsWith('/')) return `${u}/ac_raw/params.raw.json`;
    if (u.endsWith('/')) return `${u}ac_raw/params.raw.json`;
    return '';
  }

  _acBundleToChronoManifestUrl(bundleUrl) {
    const u = safeTrim(bundleUrl);
    if (!u) return '';
    if (u.endsWith('/normalized/car.bundle.json')) return u.replace(/\/normalized\/car\.bundle\.json$/i, '/normalized/chrono/manifest.json');
    if (!u.endsWith('.json') && !u.endsWith('/')) return `${u}/normalized/chrono/manifest.json`;
    if (u.endsWith('/')) return `${u}normalized/chrono/manifest.json`;
    return '';
  }

  async _spawnWasmVehicleFromChronoManifest(sim, { manifestUrl = '', x = 0, z = 0, yaw = 0 } = {}) {
    if (!sim || typeof sim.writeFile !== 'function' || typeof sim.createVehicleJson !== 'function') return null;
    const mu = normalizeAssetUrl(manifestUrl);
    if (!mu) return null;
    try {
      const mr = await fetch(mu, { cache: 'no-store' });
      if (!mr.ok) return null;
      const manifest = await mr.json();
      if (!manifest || typeof manifest !== 'object') return null;

      const toAbs = (v) => {
        const s = safeTrim(v || '');
        if (!s) return '';
        if (/^https?:\/\//i.test(s) || s.startsWith('/')) return normalizeAssetUrl(s);
        try { return new URL(s, mu).toString(); } catch { return ''; }
      };

      const vehUrl = toAbs(manifest.vehicleJsonUrl || manifest.vehicleJsonRel || manifest.vehicleJson);
      if (!vehUrl) return null;
      const tireUrl = toAbs(manifest.tireJsonUrl || manifest.tireJsonRel || manifest.tireJson);

      const vr = await fetch(vehUrl, { cache: 'no-store' });
      if (!vr.ok) return null;
      const vehicleText = await vr.text();
      let tireText = '';
      if (tireUrl) {
        try {
          const tr = await fetch(tireUrl, { cache: 'no-store' });
          if (tr.ok) tireText = await tr.text();
        } catch { /* ignore */ }
      }

      const tNow = Date.now();
      const stem = safeName(getFileStem(vehUrl || mu) || 'ac');
      const vehiclePath = `/tmp/chrono_manifest_${stem}_${tNow}_vehicle.json`;
      const tirePath = `/tmp/chrono_manifest_${stem}_${tNow}_tire.json`;
      const okVeh = !!sim.writeFile(vehiclePath, vehicleText);
      if (!okVeh) return null;
      const okTire = tireText ? !!sim.writeFile(tirePath, tireText) : false;
      const h = Number(sim.createVehicleJson({
        jsonPath: vehiclePath,
        tireJsonPath: okTire ? tirePath : '',
        x: Number(x) || 0,
        z: Number(z) || 0,
        yaw: Number(yaw) || 0,
      })) || 0;
      const st = h ? sim.getState?.(h) : null;
      if (!st) return null;
      return { handle: h, vehiclePath, tirePath: okTire ? tirePath : '' };
    } catch {
      return null;
    }
  }

  _applyAcWasmTuningToSimHandle(sim, handle, acTuning) {
    if (!sim || !handle) return;
    const wt = (acTuning?.wasmTuning && typeof acTuning.wasmTuning === 'object') ? acTuning.wasmTuning : null;
    try {
      // Chrono's Fiala tire model clamps terrain friction to <= 1.0; actual grip should come
      // from the tire JSON's UMIN/UMAX. Keep terrain at a neutral baseline.
      sim.setWorldFriction?.(1.0);
    } catch { /* ignore */ }
    try {
      const maxSteerRad = Number(wt?.maxSteerRad) || 0;
      const dp = Number(wt?.diffLockPower) || 0;
      const dc = Number(wt?.diffLockCoast) || 0;
      if (maxSteerRad > 1e-4 || dp > 1e-4 || dc > 1e-4) {
        sim.setVehicleTuningBasic?.(handle, {
          maxSteerRad: (maxSteerRad > 1e-4) ? maxSteerRad : 0.48,
          throttleScale: 1.0,
          brakeScale: 1.0,
          diffLockPower: clamp(dp, 0, 1),
          diffLockCoast: clamp(dc, 0, 1),
        });
      }
    } catch { /* ignore */ }
    try {
      const massKg = Number(wt?.massKg) || 0;
      const ixx = Number(wt?.ixx) || 0;
      const iyy = Number(wt?.iyy) || 0;
      const izz = Number(wt?.izz) || 0;
      if (massKg > 50 && ixx > 0 && iyy > 0 && izz > 0) {
        sim.setVehicleChassisMassInertia?.(handle, { massKg, ixx, iyy, izz });
      }
    } catch { /* ignore */ }
    try {
      // Ensure there's *some* powertrain. JSON vehicles may be created without one, and not all AC bundles
      // provide enough drivetrain info to build a per-car map.
      const limiterRpm = Number(wt?.limiterRpm) || 0;
      const finalRatio = Number(wt?.finalRatio) || 0;
      const reverseGear = Number(wt?.reverseGear) || 0;
      const forwardGears = Array.isArray(wt?.forwardGears) ? wt.forwardGears : [];
      const rpms = Array.isArray(wt?.rpms) ? wt.rpms : [];
      const torquesNm = Array.isArray(wt?.torquesNm) ? wt.torquesNm : [];
      const coastTorqueNm = Number(wt?.coastTorqueNm);

      const useTuned = (limiterRpm > 1000 && finalRatio > 0.01 && forwardGears.length);
      const maxRpm = useTuned ? limiterRpm : 6500;
      const fr = useTuned ? finalRatio : 4.10;
      const rev = useTuned ? ((reverseGear > 0.01) ? reverseGear : 3.2) : 3.20;
      const fwd = useTuned
        ? forwardGears
        : [3.20, 2.10, 1.50, 1.10, 0.90];
      const rpmPts = (useTuned && rpms.length && torquesNm.length)
        ? rpms
        : [1000, 1500, 2000, 3000, 4000, 5000, 6500];
      const tqPts = (useTuned && rpms.length && torquesNm.length)
        ? torquesNm
        : [220, 250, 270, 285, 275, 255, 210];
      const coast = Number.isFinite(coastTorqueNm) ? coastTorqueNm : -35;

      sim.setVehiclePowertrainSimpleMap?.(handle, {
        maxRpm,
        rpms: rpmPts,
        torquesNm: tqPts,
        coastTorqueNm: coast,
        finalRatio: fr,
        reverseGear: rev,
        forwardGears: fwd,
      });
    } catch { /* ignore */ }
  }

  async _getAcPhysicsTuningFromBundleUrl(bundleUrl) {
    const u = normalizeAssetUrl(bundleUrl);
    if (!u) return null;
    const now = Date.now();
    const cached = this._acPhysicsCache?.get?.(u) || null;
    if (cached && (now - (Number(cached.atMs) || 0)) < 30_000) return cached;

    const paramsUrl = normalizeAssetUrl(this._acBundleToParamsUrl(u));
    if (!paramsUrl) return null;

    const resp = await fetch(paramsUrl, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`AC params fetch failed: HTTP ${resp.status}`);
    const j = await resp.json();
    const entries = Array.isArray(j?.entries) ? j.entries : [];

    const norm = (s) => String(s || '').trim().toLowerCase();
    const get = (fileEndsWith, sectionName, keyName) => {
      const fe = norm(fileEndsWith);
      const sec = norm(sectionName);
      const key = norm(keyName);
      for (const e of entries) {
        const f = norm(e?.file || '');
        if (!f) continue;
        if (fe && !(f.endsWith(fe) || f.endsWith('/' + fe))) continue;
        const s0 = norm(e?.section || '');
        const k0 = norm(e?.key || '');
        if (sec && s0 !== sec) continue;
        if (key && k0 !== key) continue;
        return stripIniInlineComment(e?.value ?? '');
      }
      return '';
    };
    const getAnySection = (fileEndsWith, keyName) => {
      const fe = norm(fileEndsWith);
      const key = norm(keyName);
      for (const e of entries) {
        const f = norm(e?.file || '');
        if (!f) continue;
        if (fe && !(f.endsWith(fe) || f.endsWith('/' + fe))) continue;
        const k0 = norm(e?.key || '');
        if (key && k0 !== key) continue;
        return stripIniInlineComment(e?.value ?? '');
      }
      return '';
    };
    const fnum = (s) => {
      const v = Number(String(s || '').trim().split(/[,\s]+/)[0]);
      return Number.isFinite(v) ? v : NaN;
    };
    const clampN = (x, a, b) => {
      const v = Number(x);
      if (!Number.isFinite(v)) return a;
      return Math.max(a, Math.min(b, v));
    };

    const dbg = {};
    const simSpeedScale = 0.35;

    const massRaw =
      get('car.ini', 'basic', 'totalmass') ||
      getAnySection('car.ini', 'totalmass') ||
      get('car.ini', 'basic', 'mass') ||
      getAnySection('car.ini', 'mass') ||
      '';
    const massKg = fnum(massRaw);
    if (Number.isFinite(massKg) && massKg > 200) dbg.massKg = massKg;

    // Inertia:
    // `INERTIA=x,y,z` is commonly provided in `car.ini` as three numbers.
    // Many configs use "normalized" inertias (roughly radius-of-gyration^2) which need scaling by mass.
    // Using a too-small inertia (especially Iz) makes yaw response feel extremely arcadey.
    const inertiaRaw =
      get('car.ini', 'basic', 'inertia') ||
      getAnySection('car.ini', 'inertia') ||
      '';
    const inertiaParts = String(inertiaRaw || '')
      .split(/[,\s]+/)
      .map((t) => Number(String(t || '').trim()))
      .filter((n) => Number.isFinite(n));
    let ixxFromInertia = NaN;
    let iyyFromInertia = NaN;
    let izFromInertia = NaN;
    if (inertiaParts.length >= 3) {
      const ixRaw = inertiaParts[0];
      const iyRaw = inertiaParts[1];
      const izRaw = inertiaParts[2];
      // Heuristic:
      // - If values are small (<50), treat them as "per-mass" and scale by mass.
      // - Otherwise treat as already in kg*m^2.
      const scaleIfNormalized = (raw) => {
        if (!(Number.isFinite(raw) && raw > 0)) return NaN;
        if (raw < 50 && Number.isFinite(massKg) && massKg > 100) return raw * massKg;
        return raw;
      };
      ixxFromInertia = scaleIfNormalized(ixRaw);
      iyyFromInertia = scaleIfNormalized(iyRaw);
      izFromInertia = scaleIfNormalized(izRaw);
    }
    if (Number.isFinite(ixxFromInertia)) dbg.ixxFromInertia = ixxFromInertia;
    if (Number.isFinite(iyyFromInertia)) dbg.iyyFromInertia = iyyFromInertia;
    if (Number.isFinite(izFromInertia)) dbg.izFromInertia = izFromInertia;

    const wbRaw =
      get('suspensions.ini', 'basic', 'wheelbase') ||
      getAnySection('suspensions.ini', 'wheelbase') ||
      '';
    const wheelbase = fnum(wbRaw);
    if (Number.isFinite(wheelbase) && wheelbase > 0.6) dbg.wheelbase = wheelbase;
    // AC `CG_LOCATION` is commonly either:
    // - a fraction of wheelbase measured from the FRONT axle (0..1), or
    // - an absolute distance in meters from the FRONT axle (0..wheelbase).
    //
    // Historically we treated it like a "front weight fraction" and inverted it, which can
    // swap `a`/`b` in the bicycle model and make turning feel very wrong.
    const cgLocRaw =
      get('suspensions.ini', 'basic', 'cg_location') ||
      getAnySection('suspensions.ini', 'cg_location') ||
      '';
    const cgLoc = fnum(cgLocRaw);
    if (Number.isFinite(cgLoc)) dbg.cgLocationRaw = cgLoc;
    const cgToFront = (() => {
      if (!(Number.isFinite(wheelbase) && wheelbase > 0.6)) return NaN;
      if (!Number.isFinite(cgLoc)) return NaN;
      // Heuristic:
      // - If in (0,1.0] treat as fraction from FRONT axle.
      // - If in (1.0, wheelbase) treat as meters from FRONT axle.
      // - Otherwise ignore.
      if (cgLoc > 0 && cgLoc <= 1.0) {
        const frac = clampN(cgLoc, 0.20, 0.80);
        dbg.cgLocationInterpreted = 'fraction_from_front';
        dbg.cgToFrontM = wheelbase * frac;
        return clampN(wheelbase * frac, 0.20, wheelbase - 0.20);
      }
      if (cgLoc > 1.0 && cgLoc < (wheelbase - 0.05)) {
        dbg.cgLocationInterpreted = 'meters_from_front';
        dbg.cgToFrontM = cgLoc;
        return clampN(cgLoc, 0.20, wheelbase - 0.20);
      }
      dbg.cgLocationInterpreted = 'ignored';
      return NaN;
    })();

    // Steering:
    // Assetto commonly uses:
    // - `STEER_LOCK` as steering wheel lock (deg), and `STEER_RATIO` to get road wheel angle.
    // Some mods omit ratio or use different conventions, so we use a defensive heuristic.
    const steerLockDeg = fnum(getAnySection('car.ini', 'steer_lock') || '');
    const steerRatioRaw = fnum(getAnySection('car.ini', 'steer_ratio') || '');
    // Mods sometimes use a negative ratio just to invert direction; magnitude is what matters.
    const steerRatio = Number.isFinite(steerRatioRaw) ? Math.abs(steerRatioRaw) : NaN;
    if (Number.isFinite(steerLockDeg)) dbg.steerLockDeg = steerLockDeg;
    if (Number.isFinite(steerRatioRaw)) dbg.steerRatioRaw = steerRatioRaw;
    if (Number.isFinite(steerRatio)) dbg.steerRatio = steerRatio;

    const maxWheelSteerDeg = (() => {
      if (!Number.isFinite(steerLockDeg) || !(steerLockDeg > 0)) return NaN;
      // If lock looks like a wheel angle already (most cars <= ~45), use it as-is.
      if (steerLockDeg <= 90 && !(Number.isFinite(steerRatio) && steerRatio > 0.1)) {
        dbg.steerInterpreted = 'wheel_angle_deg';
        return steerLockDeg;
      }
      // Prefer ratio if present.
      if (Number.isFinite(steerRatio) && steerRatio > 0.1) {
        dbg.steerInterpreted = 'lock_over_ratio';
        return steerLockDeg / steerRatio;
      }
      // Fallback for missing ratio: assume a typical steering ratio.
      const assumed = 14.0;
      dbg.steerInterpreted = `lock_over_assumed_ratio_${assumed}`;
      return steerLockDeg / assumed;
    })();
    if (Number.isFinite(maxWheelSteerDeg)) dbg.maxWheelSteerDeg = maxWheelSteerDeg;
    const maxSteerRad = Number.isFinite(maxWheelSteerDeg)
      ? degToRad(clampN(maxWheelSteerDeg, 8, 45))
      : NaN;
    // Steering "feel" defaults (used by both JS and WASM paths).
    // These are *input shaping* values, not physical steering geometry.
    // Keep them conservative so high-speed keyboard steering doesn't look like instant lock.
    const steerSpeedRef = 9.5;
    const steerMinFactor = 0.18;
    const steerRate = 6.8;

    // Tyres.ini commonly has multiple compounds: FRONT_1/FRONT_2/... and a COMPOUND_DEFAULT INDEX.
    // Prefer the default compound for driving feel; fall back to FRONT/REAR if needed.
    const tyreCompoundIndexRaw = fnum(get('tyres.ini', 'compound_default', 'index') || get('tires.ini', 'compound_default', 'index') || '');
    const tyreCompoundN = Number.isFinite(tyreCompoundIndexRaw) ? (Math.floor(tyreCompoundIndexRaw) + 1) : NaN; // INDEX=0 -> *_1
    const pickTyreSection = (axleBase) => {
      const b = String(axleBase || '').trim().toLowerCase();
      if (!b) return '';
      const cands = [];
      if (Number.isFinite(tyreCompoundN) && tyreCompoundN >= 1 && tyreCompoundN <= 8) cands.push(`${b}_${tyreCompoundN}`);
      cands.push(`${b}_1`);
      cands.push(b);
      // Use the first section that contains at least one known key.
      for (const s of cands) {
        const r0 = get('tyres.ini', s, 'radius') || get('tires.ini', s, 'radius') || '';
        const w0 = get('tyres.ini', s, 'width') || get('tires.ini', s, 'width') || '';
        const dx0 = get('tyres.ini', s, 'dx0') || get('tires.ini', s, 'dx0') || '';
        const dy0 = get('tyres.ini', s, 'dy0') || get('tires.ini', s, 'dy0') || '';
        if (safeTrim(r0 || w0 || dx0 || dy0)) return s;
      }
      return b;
    };
    const tyreSecFront = pickTyreSection('front');
    const tyreSecRear = pickTyreSection('rear');
    if (tyreSecFront) dbg.tyreSectionFront = tyreSecFront;
    if (tyreSecRear) dbg.tyreSectionRear = tyreSecRear;
    if (Number.isFinite(tyreCompoundIndexRaw)) dbg.tyreCompoundIndex = tyreCompoundIndexRaw;

    const rFront = fnum(get('tyres.ini', tyreSecFront, 'radius') || get('tires.ini', tyreSecFront, 'radius') || '');
    const wFront = fnum(get('tyres.ini', tyreSecFront, 'width') || get('tires.ini', tyreSecFront, 'width') || '');
    const rRear = fnum(get('tyres.ini', tyreSecRear, 'radius') || get('tires.ini', tyreSecRear, 'radius') || '');
    const wRear = fnum(get('tyres.ini', tyreSecRear, 'width') || get('tires.ini', tyreSecRear, 'width') || '');
    const dy0 = fnum(get('tyres.ini', tyreSecFront, 'dy0') || get('tires.ini', tyreSecFront, 'dy0') || '');
    const dx0 = fnum(get('tyres.ini', tyreSecFront, 'dx0') || get('tires.ini', tyreSecFront, 'dx0') || '');
    const dy1 = fnum(get('tyres.ini', tyreSecFront, 'dy1') || get('tires.ini', tyreSecFront, 'dy1') || '');
    const dx1 = fnum(get('tyres.ini', tyreSecFront, 'dx1') || get('tires.ini', tyreSecFront, 'dx1') || '');
    const rateFront = fnum(get('tyres.ini', tyreSecFront, 'rate') || get('tires.ini', tyreSecFront, 'rate') || '');
    const dampFront = fnum(get('tyres.ini', tyreSecFront, 'damp') || get('tires.ini', tyreSecFront, 'damp') || '');
    const rateRear = fnum(get('tyres.ini', tyreSecRear, 'rate') || get('tires.ini', tyreSecRear, 'rate') || '');
    const dampRear = fnum(get('tyres.ini', tyreSecRear, 'damp') || get('tires.ini', tyreSecRear, 'damp') || '');
    const camberGain = fnum(get('tyres.ini', tyreSecFront, 'camber_gain') || get('tires.ini', tyreSecFront, 'camber_gain') || '');
    const combinedFactor = fnum(get('tyres.ini', tyreSecFront, 'combined_factor') || get('tires.ini', tyreSecFront, 'combined_factor') || '');
    const speedSens = fnum(get('tyres.ini', tyreSecFront, 'speed_sensitivity') || get('tires.ini', tyreSecFront, 'speed_sensitivity') || '');
    const muLike = Math.max(Number.isFinite(dy0) ? dy0 : 0, Number.isFinite(dx0) ? dx0 : 0);
    if (Number.isFinite(rFront)) dbg.tireRadiusM = rFront;
    if (Number.isFinite(wFront)) dbg.tireWidthM = wFront;
    if (Number.isFinite(rRear)) dbg.tireRadiusRearM = rRear;
    if (Number.isFinite(wRear)) dbg.tireWidthRearM = wRear;
    if (Number.isFinite(muLike)) dbg.muLike = muLike;
    if (Number.isFinite(dx1)) dbg.dx1 = dx1;
    if (Number.isFinite(dy1)) dbg.dy1 = dy1;
    if (Number.isFinite(rateFront)) dbg.tyreRateFront = rateFront;
    if (Number.isFinite(dampFront)) dbg.tyreDampFront = dampFront;
    if (Number.isFinite(rateRear)) dbg.tyreRateRear = rateRear;
    if (Number.isFinite(dampRear)) dbg.tyreDampRear = dampRear;
    if (Number.isFinite(camberGain)) dbg.camberGain = camberGain;
    if (Number.isFinite(combinedFactor)) dbg.combinedFactor = combinedFactor;
    if (Number.isFinite(speedSens)) dbg.speedSensitivity = speedSens;
    const mu = Number.isFinite(muLike) ? clampN(muLike, 0.6, 2.0) : NaN;

    const rr0 = fnum(get('tyres.ini', tyreSecFront, 'rolling_resistance_0') || get('tires.ini', tyreSecFront, 'rolling_resistance_0') || '');
    const rollingResist = Number.isFinite(rr0) ? clampN(rr0 * 2.0, 4.0, 80.0) : NaN;
    if (Number.isFinite(rr0)) dbg.rollingResistance0 = rr0;

    let fz0Front = fnum(get('tyres.ini', tyreSecFront, 'fz0') || get('tires.ini', tyreSecFront, 'fz0') || '');
    const fz0Rear = fnum(get('tyres.ini', tyreSecRear, 'fz0') || get('tires.ini', tyreSecRear, 'fz0') || '');
    // Some tyre configs omit FRONT fz0; use REAR as a fallback reference load.
    if (!Number.isFinite(fz0Front) && Number.isFinite(fz0Rear)) fz0Front = fz0Rear;
    if (Number.isFinite(fz0Front)) dbg.fz0Front = fz0Front;
    if (Number.isFinite(fz0Rear)) dbg.fz0Rear = fz0Rear;

    // Tire relaxation length (helps remove instant / twitchy yaw response).
    const relaxFront = fnum(get('tyres.ini', tyreSecFront, 'relaxation_length') || get('tires.ini', tyreSecFront, 'relaxation_length') || '');
    const relaxRear = fnum(get('tyres.ini', tyreSecRear, 'relaxation_length') || get('tires.ini', tyreSecRear, 'relaxation_length') || '');
    if (Number.isFinite(relaxFront)) dbg.relaxFrontM = relaxFront;
    if (Number.isFinite(relaxRear)) dbg.relaxRearM = relaxRear;

    // Suspension geometry signals that strongly affect handling feel.
    const baseyFront = fnum(get('suspensions.ini', 'front', 'basey') || '');
    const baseyRear = fnum(get('suspensions.ini', 'rear', 'basey') || '');
    const trackFront = fnum(get('suspensions.ini', 'front', 'track') || '');
    const trackRear = fnum(get('suspensions.ini', 'rear', 'track') || '');
    const springFront = fnum(get('suspensions.ini', 'front', 'spring_rate') || '');
    const springRear = fnum(get('suspensions.ini', 'rear', 'spring_rate') || '');
    const dampBumpF = fnum(get('suspensions.ini', 'front', 'damp_bump') || '');
    const dampRebF = fnum(get('suspensions.ini', 'front', 'damp_rebound') || '');
    const dampBumpR = fnum(get('suspensions.ini', 'rear', 'damp_bump') || '');
    const dampRebR = fnum(get('suspensions.ini', 'rear', 'damp_rebound') || '');
    const camberF = fnum(get('suspensions.ini', 'front', 'static_camber') || '');
    const camberR = fnum(get('suspensions.ini', 'rear', 'static_camber') || '');
    const arbFront = fnum(get('suspensions.ini', 'arb', 'front') || '');
    const arbRear = fnum(get('suspensions.ini', 'arb', 'rear') || '');
    if (Number.isFinite(baseyFront)) dbg.baseyFront = baseyFront;
    if (Number.isFinite(baseyRear)) dbg.baseyRear = baseyRear;
    if (Number.isFinite(trackFront)) dbg.trackFront = trackFront;
    if (Number.isFinite(trackRear)) dbg.trackRear = trackRear;
    if (Number.isFinite(springFront)) dbg.springRateFront = springFront;
    if (Number.isFinite(springRear)) dbg.springRateRear = springRear;
    if (Number.isFinite(dampBumpF)) dbg.dampBumpFront = dampBumpF;
    if (Number.isFinite(dampRebF)) dbg.dampReboundFront = dampRebF;
    if (Number.isFinite(dampBumpR)) dbg.dampBumpRear = dampBumpR;
    if (Number.isFinite(dampRebR)) dbg.dampReboundRear = dampRebR;
    if (Number.isFinite(camberF)) dbg.staticCamberFrontDeg = camberF;
    if (Number.isFinite(camberR)) dbg.staticCamberRearDeg = camberR;
    if (Number.isFinite(arbFront)) dbg.arbFront = arbFront;
    if (Number.isFinite(arbRear)) dbg.arbRear = arbRear;
    // `BASEY` sign conventions vary; many cars use negative values. Empirically, using (radius - basey)
    // yields a reasonable CG height for typical AC configs.
    const cgHeightEst = (() => {
      const hf = (Number.isFinite(rFront) && Number.isFinite(baseyFront)) ? (rFront - baseyFront) : NaN;
      const hr = (Number.isFinite(rRear) && Number.isFinite(baseyRear)) ? (rRear - baseyRear) : NaN;
      if (Number.isFinite(hf) && Number.isFinite(hr)) return 0.5 * (hf + hr);
      if (Number.isFinite(hf)) return hf;
      if (Number.isFinite(hr)) return hr;
      return NaN;
    })();
    if (Number.isFinite(cgHeightEst)) dbg.cgHeightEst = cgHeightEst;
    const alphaPeak = (() => {
      if (!Number.isFinite(mu)) return 0.08;
      const t = clampN((mu - 0.85) / 0.85, 0, 1);
      return clampN(lerp(0.11, 0.06, t), 0.05, 0.12);
    })();
    const cornerStiffFront = (Number.isFinite(mu) && Number.isFinite(fz0Front) && fz0Front > 10)
      ? clampN((2.0 * mu * fz0Front) / Math.max(1e-4, alphaPeak), 20_000, 260_000)
      : NaN;
    const cornerStiffRear = (Number.isFinite(mu) && Number.isFinite(fz0Rear) && fz0Rear > 10)
      ? clampN((2.0 * mu * fz0Rear) / Math.max(1e-4, alphaPeak), 20_000, 260_000)
      : NaN;

    const cd = fnum(get('aero.ini', 'data', 'cd') || getAnySection('aero.ini', 'cd') || '');
    const fa = fnum(get('aero.ini', 'data', 'fa') || get('aero.ini', 'data', 'frontal_area') || getAnySection('aero.ini', 'fa') || '');
    if (Number.isFinite(cd) && cd > 0) dbg.cd = cd;
    if (Number.isFinite(fa) && fa > 0) dbg.frontalArea = fa;
    const rho = 1.225;
    const aeroDrag = (Number.isFinite(cd) && Number.isFinite(fa) && cd > 0 && fa > 0)
      ? (0.5 * rho * cd * fa)
      : NaN;

    // Downforce (very approximate): try to read a lift coefficient and treat positive as downforce.
    // Assetto configs vary a lot; we support a few common key names.
    const clRaw =
      get('aero.ini', 'data', 'cl') ||
      get('aero.ini', 'data', 'clift') ||
      get('aero.ini', 'data', 'lift_coefficient') ||
      getAnySection('aero.ini', 'cl') ||
      '';
    const cl = fnum(clRaw);
    if (Number.isFinite(cl)) dbg.cl = cl;

    // Wing/LUT-based aero fallback: if scalar CD/FA/CL are missing, derive an effective proxy
    // from WING_* sections + LUT_AOA_* tables at the configured ANGLE.
    let cdEff = cd;
    let faEff = fa;
    let clEff = cl;
    let aeroDragEff = aeroDrag;
    try {
      const needDrag = !(Number.isFinite(aeroDragEff) && aeroDragEff > 0);
      const needArea = !(Number.isFinite(faEff) && faEff > 0);
      const needCd = !(Number.isFinite(cdEff) && cdEff > 0);
      const needCl = !(Number.isFinite(clEff));
      if (needDrag || needArea || needCd || needCl) {
        const lutCache = new Map();
        const readLut = async (name) => {
          const k = stripIniInlineComment(name || '');
          if (!k) return null;
          if (lutCache.has(k)) return lutCache.get(k);
          try {
            const lutUrl = normalizeAssetUrl(u.replace(/\/normalized\/car\.bundle\.json$/i, `/ac_raw/data/${k}`));
            if (!lutUrl) { lutCache.set(k, null); return null; }
            const r = await fetch(lutUrl, { cache: 'no-store' });
            if (!r.ok) { lutCache.set(k, null); return null; }
            const t = await r.text();
            const pts = [];
            for (const line of String(t || '').split(/\r?\n/)) {
              const s = line.trim();
              if (!s || s.startsWith(';') || !s.includes('|')) continue;
              const parts = s.split('|');
              const x = Number(parts[0]);
              const y = Number(parts[1]);
              if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
              pts.push([x, y]);
            }
            pts.sort((a, b) => a[0] - b[0]);
            const out = pts.length ? pts : null;
            lutCache.set(k, out);
            return out;
          } catch {
            lutCache.set(k, null);
            return null;
          }
        };
        const evalPts = (pts, x) => {
          if (!Array.isArray(pts) || !pts.length) return NaN;
          const xv = Number(x);
          if (!Number.isFinite(xv)) return NaN;
          if (xv <= pts[0][0]) return Number(pts[0][1]);
          if (xv >= pts[pts.length - 1][0]) return Number(pts[pts.length - 1][1]);
          for (let i = 1; i < pts.length; i++) {
            const x1 = Number(pts[i][0]);
            if (!(xv <= x1)) continue;
            const x0 = Number(pts[i - 1][0]);
            const y0 = Number(pts[i - 1][1]);
            const y1 = Number(pts[i][1]);
            const tt = (xv - x0) / Math.max(1e-9, (x1 - x0));
            return lerp(y0, y1, clamp(tt, 0, 1));
          }
          return Number(pts[pts.length - 1][1]);
        };

        let sumArea = 0;
        let sumCdA = 0;
        let sumClA = 0;
        let usedWings = 0;
        for (let wi = 0; wi < 12; wi++) {
          const sec = `wing_${wi}`;
          const chord = fnum(get('aero.ini', sec, 'chord') || '');
          const span = fnum(get('aero.ini', sec, 'span') || '');
          if (!(Number.isFinite(chord) && chord > 0 && Number.isFinite(span) && span > 0)) continue;
          const area = Math.max(1e-6, chord * span);
          const cdGain = fnum(get('aero.ini', sec, 'cd_gain') || '');
          const clGain = fnum(get('aero.ini', sec, 'cl_gain') || '');
          const angle = fnum(get('aero.ini', sec, 'angle') || '');
          const lutCd = stripIniInlineComment(get('aero.ini', sec, 'lut_aoa_cd') || '');
          const lutCl = stripIniInlineComment(get('aero.ini', sec, 'lut_aoa_cl') || '');
          if (!lutCd && !lutCl) continue;

          let cd0 = NaN;
          let cl0 = NaN;
          if (lutCd) {
            const pts = await readLut(lutCd);
            cd0 = evalPts(pts, Number.isFinite(angle) ? angle : 0);
            if (Number.isFinite(cd0)) cd0 *= (Number.isFinite(cdGain) ? cdGain : 1.0);
          }
          if (lutCl) {
            const pts = await readLut(lutCl);
            cl0 = evalPts(pts, Number.isFinite(angle) ? angle : 0);
            if (Number.isFinite(cl0)) cl0 *= (Number.isFinite(clGain) ? clGain : 1.0);
          }
          if (!Number.isFinite(cd0) && !Number.isFinite(cl0)) continue;

          usedWings++;
          sumArea += area;
          if (Number.isFinite(cd0)) sumCdA += cd0 * area;
          if (Number.isFinite(cl0)) sumClA += cl0 * area;
        }

        if (usedWings && sumArea > 1e-6) {
          dbg.aeroWingLutUsed = true;
          dbg.aeroWingCount = usedWings;
          dbg.aeroWingArea = sumArea;
          if (needArea) faEff = sumArea;
          if (needCd && sumCdA > 0) cdEff = sumCdA / sumArea;
          if (needCl && Number.isFinite(sumClA)) clEff = sumClA / sumArea;
          if (needDrag && Number.isFinite(cdEff) && Number.isFinite(faEff) && cdEff > 0 && faEff > 0) {
            aeroDragEff = 0.5 * rho * cdEff * faEff;
          }
          if (Number.isFinite(cdEff)) dbg.cdEffFromWings = cdEff;
          if (Number.isFinite(clEff)) dbg.clEffFromWings = clEff;
          if (Number.isFinite(aeroDragEff)) dbg.aeroDragEff = aeroDragEff;
        }
      }
    } catch { /* ignore */ }

    // power.lut parsing (fetch directly). We'll use it both for maxima and a torque curve (for WASM tuning).
    let engineForceMax = NaN;
    let maxPowerW = NaN;
    let maxTorqueNm = NaN;
    const powerLutCurve = { rpms: [], torquesNm: [], maxPowerKw: 0, maxTorqueNm: 0 };
    try {
      const powerUrl = normalizeAssetUrl(u.replace(/\/normalized\/car\.bundle\.json$/i, '/ac_raw/data/power.lut'));
      if (powerUrl) {
        const pr = await fetch(powerUrl, { cache: 'no-store' });
        if (pr.ok) {
          const t = await pr.text();
          let mx = 0;
          let mxT = 0;
          for (const line of String(t || '').split(/\r?\n/)) {
            const s = line.trim();
            if (!s || s.startsWith(';') || !s.includes('|')) continue;
            const parts = s.split('|');
            const rpm = Number(parts[0]);
            const pKw = Number(parts[1]);
            if (Number.isFinite(pKw)) mx = Math.max(mx, pKw);
            if (Number.isFinite(rpm) && rpm > 100 && Number.isFinite(pKw) && pKw > 0) {
              const omega = (rpm * (2 * Math.PI)) / 60;
              const tq = (pKw * 1000) / Math.max(1e-6, omega);
              if (Number.isFinite(tq)) mxT = Math.max(mxT, tq);
              if (powerLutCurve.rpms.length < 512) {
                powerLutCurve.rpms.push(rpm);
                powerLutCurve.torquesNm.push(tq);
              }
            }
          }
          if (mx > 1) {
            dbg.maxPowerKw = mx;
            maxPowerW = mx * 1000;
            if (mxT > 1) {
              dbg.maxTorqueNm = mxT;
              maxTorqueNm = mxT;
            }
            powerLutCurve.maxPowerKw = mx;
            powerLutCurve.maxTorqueNm = mxT;
            const vRef = 11.0;
            engineForceMax = clampN((mx * 1000) / vRef, 1500, 35_000);
          }
        }
      }
    } catch { /* ignore */ }

    const tractionTypeRaw = get('drivetrain.ini', 'traction', 'type') || getAnySection('drivetrain.ini', 'type') || '';
    const tractionType = String(tractionTypeRaw || '').trim().split(/[\s;,#]+/)[0].toUpperCase();
    const driveBias = (() => {
      if (!tractionType) return NaN;
      if (tractionType === 'FWD') return 1.0;
      if (tractionType === 'RWD') return 0.0;
      if (tractionType === 'AWD' || tractionType === '4WD') return 0.5;
      return NaN;
    })();
    if (tractionType) dbg.tractionType = tractionType;

    const finalRatio = fnum(get('drivetrain.ini', 'gears', 'final') || getAnySection('drivetrain.ini', 'final') || '');
    const gearRatios = [];
    for (let i = 1; i <= 12; i++) {
      const gr = fnum(get('drivetrain.ini', 'gears', `gear_${i}`) || '');
      if (Number.isFinite(gr) && gr > 0) gearRatios.push(gr);
    }
    const reverseGear = fnum(
      get('drivetrain.ini', 'gears', 'reverse') ||
      get('drivetrain.ini', 'gears', 'gear_r') ||
      getAnySection('drivetrain.ini', 'reverse') ||
      getAnySection('drivetrain.ini', 'gear_r') ||
      '',
    );
    const firstGear = gearRatios.length ? gearRatios[0] : fnum(get('drivetrain.ini', 'gears', 'gear_1') || '');
    const topGear = gearRatios.length ? Math.min(...gearRatios) : NaN;
    if (Number.isFinite(finalRatio)) dbg.finalRatio = finalRatio;
    if (Number.isFinite(firstGear)) dbg.firstGear = firstGear;
    if (Number.isFinite(topGear)) dbg.topGear = topGear;

    const limiterRpmRaw =
      get('engine.ini', 'engine_data', 'limiter') ||
      getAnySection('engine.ini', 'limiter') ||
      get('engine.ini', 'coast_ref', 'rpm') ||
      getAnySection('engine.ini', 'rpm') ||
      '';
    const limiterRpm = fnum(limiterRpmRaw);
    if (Number.isFinite(limiterRpm) && limiterRpm > 100) dbg.limiterRpm = limiterRpm;

    const vTopReal = (Number.isFinite(limiterRpm) && limiterRpm > 100 && Number.isFinite(topGear) && topGear > 0.01 && Number.isFinite(finalRatio) && finalRatio > 0.01 && Number.isFinite(rFront) && rFront > 0.05)
      ? (((limiterRpm * (2 * Math.PI)) / 60) / (topGear * finalRatio)) * rFront
      : NaN;
    if (Number.isFinite(vTopReal)) dbg.topSpeedMS = vTopReal;
    const speedMax = Number.isFinite(vTopReal) ? clampN(vTopReal * simSpeedScale, 10.0, 45.0) : NaN;

    if (Number.isFinite(maxTorqueNm) && Number.isFinite(firstGear) && firstGear > 0.01 && Number.isFinite(finalRatio) && finalRatio > 0.01 && Number.isFinite(rFront) && rFront > 0.05) {
      const ratio = firstGear * finalRatio;
      const eff = 0.86;
      const fx = (maxTorqueNm * ratio * eff) / rFront;
      dbg.engineForceFromTorque = fx;
      if (Number.isFinite(fx) && fx > 100) {
        const blended = Number.isFinite(engineForceMax) ? lerp(engineForceMax, fx, 0.65) : fx;
        engineForceMax = clampN(blended, 1500, 45_000);
      }
    }

    const aeroDragFromPower = (Number.isFinite(maxPowerW) && Number.isFinite(speedMax) && speedMax > 1.0)
      ? clampN((2.5 * maxPowerW) / (speedMax * speedMax * speedMax), 5.0, 120.0)
      : NaN;
    if (Number.isFinite(aeroDragFromPower)) dbg.aeroDragFromPower = aeroDragFromPower;

    const coastTq = fnum(get('engine.ini', 'coast_ref', 'torque') || getAnySection('engine.ini', 'torque') || '');
    if (Number.isFinite(coastTq)) dbg.coastTorqueNm = coastTq;
    // Differential (optional): used as a crude locking proxy for WASM.
    const diffNorm = (v) => {
      const x = Number(v);
      if (!Number.isFinite(x)) return NaN;
      if (x > 1.5 && x <= 100.0) return clampN(x / 100.0, 0, 1);
      return clampN(x, 0, 1);
    };
    const diffLockPower = diffNorm(
      get('differential.ini', 'differential', 'power') ||
      getAnySection('differential.ini', 'power') ||
      get('drivetrain.ini', 'differential', 'power') ||
      getAnySection('drivetrain.ini', 'power') ||
      '',
    );
    const diffLockCoast = diffNorm(
      get('differential.ini', 'differential', 'coast') ||
      getAnySection('differential.ini', 'coast') ||
      get('drivetrain.ini', 'differential', 'coast') ||
      getAnySection('drivetrain.ini', 'coast') ||
      '',
    );
    if (Number.isFinite(diffLockPower)) dbg.diffLockPower = diffLockPower;
    if (Number.isFinite(diffLockCoast)) dbg.diffLockCoast = diffLockCoast;

    const engineBrakeForce = (Number.isFinite(coastTq) && Number.isFinite(rFront) && rFront > 0.05)
      ? clampN((coastTq / rFront) * 10.0, 100, 8000)
      : NaN;

    const bMax = fnum(get('brakes.ini', 'data', 'max_torque') || getAnySection('brakes.ini', 'max_torque') || '');
    const bShare = fnum(get('brakes.ini', 'data', 'front_share') || getAnySection('brakes.ini', 'front_share') || '');
    const bFrontTq = fnum(get('brakes.ini', 'data', 'max_torque_front') || getAnySection('brakes.ini', 'max_torque_front') || '');
    const bRearTq = fnum(get('brakes.ini', 'data', 'max_torque_rear') || getAnySection('brakes.ini', 'max_torque_rear') || '');
    let bTq = NaN;
    if (Number.isFinite(bFrontTq) && Number.isFinite(bRearTq) && bFrontTq > 0 && bRearTq > 0) {
      bTq = 2 * (bFrontTq + bRearTq);
    } else if (Number.isFinite(bMax) && bMax > 0) {
      bTq = 2 * bMax;
      if (Number.isFinite(bShare)) dbg.brakeFrontShare = bShare;
    }
    const brakeForceMax = (Number.isFinite(bTq) && Number.isFinite(rFront) && rFront > 0.05)
      ? (bTq / rFront)
      : NaN;
    if (Number.isFinite(bMax)) dbg.brakeMaxTorqueNm = bMax;
    if (Number.isFinite(brakeForceMax)) dbg.brakeForceMax = brakeForceMax;

    const simTuning = {};
    if (Number.isFinite(massKg)) simTuning.mass = clampN(massKg, 200, 4000);
    if (Number.isFinite(wheelbase)) simTuning.wheelbase = clampN(wheelbase, 0.6, 6.0);
    if (Number.isFinite(cgToFront)) simTuning.cgToFront = cgToFront;
    if (Number.isFinite(izFromInertia)) simTuning.iz = clampN(izFromInertia, 300, 120_000);
    else if (Number.isFinite(massKg) && Number.isFinite(wheelbase)) simTuning.iz = clampN(0.25 * massKg * wheelbase * wheelbase, 300, 25_000);
    if (Number.isFinite(maxSteerRad)) simTuning.maxSteerRad = clampN(maxSteerRad, 0.15, 0.95);
    if (Number.isFinite(mu)) simTuning.mu = mu;
    if (Number.isFinite(rollingResist)) simTuning.rollingResist = rollingResist;
    if (Number.isFinite(cornerStiffFront)) simTuning.cornerStiffFront = cornerStiffFront;
    if (Number.isFinite(cornerStiffRear)) simTuning.cornerStiffRear = cornerStiffRear;
    if (Number.isFinite(speedMax)) simTuning.speedMax = speedMax;
    if (Number.isFinite(driveBias)) simTuning.driveBias = clampN(driveBias, 0, 1);
    if (Number.isFinite(bShare)) simTuning.brakeBiasFront = clampN(bShare, 0, 1);
    if (Number.isFinite(cgHeightEst)) simTuning.cgHeight = clampN(cgHeightEst, 0.25, 0.95);
    if (Number.isFinite(trackFront) && trackFront > 0.5) simTuning.trackFront = clampN(trackFront, 0.8, 2.6);
    if (Number.isFinite(trackRear) && trackRear > 0.5) simTuning.trackRear = clampN(trackRear, 0.8, 2.6);
    if (Number.isFinite(springFront) && springFront > 1000) simTuning.springRateFront = clampN(springFront, 5_000, 200_000);
    if (Number.isFinite(springRear) && springRear > 1000) simTuning.springRateRear = clampN(springRear, 5_000, 200_000);
    if (Number.isFinite(dampBumpF) && Number.isFinite(dampRebF)) simTuning.damperFront = clampN(0.5 * (dampBumpF + dampRebF), 200, 80_000);
    if (Number.isFinite(dampBumpR) && Number.isFinite(dampRebR)) simTuning.damperRear = clampN(0.5 * (dampBumpR + dampRebR), 200, 80_000);
    if (Number.isFinite(camberF)) simTuning.staticCamberFrontDeg = clampN(camberF, -8, 8);
    if (Number.isFinite(camberR)) simTuning.staticCamberRearDeg = clampN(camberR, -8, 8);
    if (Number.isFinite(arbFront) && arbFront > 0) simTuning.arbFront = clampN(arbFront, 0, 200_000);
    if (Number.isFinite(arbRear) && arbRear > 0) simTuning.arbRear = clampN(arbRear, 0, 200_000);
    if (Number.isFinite(rateFront) && rateFront > 1000) simTuning.tyreRateFront = clampN(rateFront, 20_000, 800_000);
    if (Number.isFinite(dampFront) && dampFront > 10) simTuning.tyreDampFront = clampN(dampFront, 50, 50_000);
    if (Number.isFinite(rateRear) && rateRear > 1000) simTuning.tyreRateRear = clampN(rateRear, 20_000, 800_000);
    if (Number.isFinite(dampRear) && dampRear > 10) simTuning.tyreDampRear = clampN(dampRear, 50, 50_000);
    if (Number.isFinite(dx1)) simTuning.dx1 = clampN(dx1, -1.0, 1.0);
    if (Number.isFinite(dy1)) simTuning.dy1 = clampN(dy1, -1.0, 1.0);
    if (Number.isFinite(camberGain)) simTuning.camberGain = clampN(camberGain, -5.0, 5.0);
    if (Number.isFinite(combinedFactor)) simTuning.combinedFactor = clampN(combinedFactor, 0.0, 4.0);
    if (Number.isFinite(speedSens)) simTuning.speedSensitivity = clampN(speedSens, 0.0, 0.1);
    if (Number.isFinite(aeroDragFromPower)) simTuning.aeroDrag = aeroDragFromPower;
    else if (Number.isFinite(aeroDragEff)) simTuning.aeroDrag = clampN(aeroDragEff, 5.0, 120.0);
    if (Number.isFinite(engineForceMax)) simTuning.engineForceMax = engineForceMax;
    if (Number.isFinite(engineBrakeForce)) simTuning.engineBrakeForce = engineBrakeForce;
    if (Number.isFinite(brakeForceMax)) simTuning.brakeForceMax = clampN(brakeForceMax, 2000, 40_000);

    simTuning.steerSpeedRef = steerSpeedRef;
    simTuning.steerMinFactor = steerMinFactor;
    simTuning.steerRate = steerRate;

    if (Number.isFinite(relaxFront) && relaxFront > 0) simTuning.relaxLenFront = clampN(relaxFront, 0.005, 1.0);
    if (Number.isFinite(relaxRear) && relaxRear > 0) simTuning.relaxLenRear = clampN(relaxRear, 0.005, 1.0);

    // Provide drivetrain/engine info so the JS sim can approximate engine + gearbox dynamics.
    if (Number.isFinite(finalRatio)) simTuning.finalRatio = finalRatio;
    if (Array.isArray(gearRatios) && gearRatios.length) simTuning.gearRatios = gearRatios.slice(0, 16);
    if (Number.isFinite(reverseGear) && reverseGear > 0.01) simTuning.reverseGear = reverseGear;
    if (Number.isFinite(limiterRpm)) simTuning.limiterRpm = limiterRpm;
    if (Number.isFinite(maxPowerW)) simTuning.maxPowerW = maxPowerW;
    if (Number.isFinite(maxTorqueNm)) simTuning.maxTorqueNm = maxTorqueNm;
    if (Number.isFinite(coastTq)) simTuning.coastTorqueNm = clampN(coastTq, -400, 0);
    if (Number.isFinite(rFront) && rFront > 0.05) simTuning.wheelRadius = clampN(rFront, 0.18, 0.65);
    try {
      if (Array.isArray(powerLutCurve?.rpms) && Array.isArray(powerLutCurve?.torquesNm) && powerLutCurve.rpms.length >= 2 && powerLutCurve.torquesNm.length >= 2) {
        simTuning.torqueCurveRpms = powerLutCurve.rpms.slice(0, 512);
        simTuning.torqueCurveNm = powerLutCurve.torquesNm.slice(0, 512);
      }
    } catch { /* ignore */ }

    // Provide a basic downforce proxy (if present).
    if (Number.isFinite(clEff)) simTuning.aeroCl = clampN(clEff, -8.0, 8.0);
    if (Number.isFinite(faEff)) simTuning.frontalArea = clampN(faEff, 0.6, 6.0);

    const out = {
      atMs: now,
      simTuning,
      wheelRadius: Number.isFinite(rFront) ? clampN(rFront, 0.18, 0.65) : 0,
      wheelWidth: Number.isFinite(wFront) ? clampN(wFront, 0.08, 0.45) : 0,
      wheelRadiusRear: Number.isFinite(rRear) ? clampN(rRear, 0.18, 0.65) : 0,
      wheelWidthRear: Number.isFinite(wRear) ? clampN(wRear, 0.08, 0.45) : 0,
      finalRatio: Number.isFinite(finalRatio) ? finalRatio : 0,
      gearRatios: Array.isArray(gearRatios) ? gearRatios.slice(0, 16) : [],
      reverseGear: Number.isFinite(reverseGear) ? reverseGear : 0,
      limiterRpm: Number.isFinite(limiterRpm) ? limiterRpm : 0,
      maxPowerW: Number.isFinite(maxPowerW) ? maxPowerW : 0,
      maxTorqueNm: Number.isFinite(maxTorqueNm) ? maxTorqueNm : 0,
      powerLutCurve,
      wasmTuning: {
        // terrain/tire friction proxy
        mu: Number.isFinite(mu) ? mu : 0,
        // steering range proxy (used to scale Chrono driver input)
        maxSteerRad: Number.isFinite(maxSteerRad) ? clampN(maxSteerRad, 0.15, 0.95) : 0,
        // chassis
        massKg: Number.isFinite(massKg) ? clampN(massKg, 200, 4000) : 0,
        ixx: Number.isFinite(ixxFromInertia) ? clampN(ixxFromInertia, 200, 120_000) : 0,
        iyy: Number.isFinite(iyyFromInertia) ? clampN(iyyFromInertia, 200, 120_000) : 0,
        izz: Number.isFinite(izFromInertia) ? clampN(izFromInertia, 200, 120_000) : 0,
        // powertrain
        limiterRpm: Number.isFinite(limiterRpm) ? clampN(limiterRpm, 2000, 12_000) : 0,
        rpms: Array.isArray(powerLutCurve.rpms) ? powerLutCurve.rpms.slice(0, 512) : [],
        torquesNm: Array.isArray(powerLutCurve.torquesNm) ? powerLutCurve.torquesNm.slice(0, 512) : [],
        coastTorqueNm: Number.isFinite(coastTq) ? clampN(coastTq, -400, 0) : -30,
        finalRatio: Number.isFinite(finalRatio) ? clampN(finalRatio, 1.5, 8.0) : 0,
        reverseGear: Number.isFinite(reverseGear) ? clampN(reverseGear, 0.5, 8.0) : 0,
        forwardGears: Array.isArray(gearRatios) ? gearRatios.filter((x) => Number.isFinite(x) && x > 0).slice(0, 12) : [],
        // diff lock proxy
        diffLockPower: Number.isFinite(diffLockPower) ? diffLockPower : 0,
        diffLockCoast: Number.isFinite(diffLockCoast) ? diffLockCoast : 0,
      },
      debug: dbg,
    };
    try { this._acPhysicsCache?.set?.(u, out); } catch { /* ignore */ }
    return out;
  }

  _acDdsBlockBytes(info) {
    const fourCC = String(info?.fourCC || '');
    const dxgi = info?.dxgiFormat;
    if (fourCC === 'DXT1' || fourCC === 'ATI1') return 8;
    if (fourCC === 'DXT3' || fourCC === 'DXT5' || fourCC === 'ATI2') return 16;
    if (dxgi === 71 || dxgi === 80) return 8;
    if (dxgi === 74 || dxgi === 77 || dxgi === 83 || dxgi === 95 || dxgi === 96 || dxgi === 98 || dxgi === 99) return 16;
    return 0;
  }

  _acDdsThreeFormat(info) {
    const fourCC = String(info?.fourCC || '');
    const dxgi = info?.dxgiFormat;
    if (fourCC === 'DXT1') return THREE.RGBA_S3TC_DXT1_Format;
    if (fourCC === 'DXT3') return THREE.RGBA_S3TC_DXT3_Format;
    if (fourCC === 'DXT5') return THREE.RGBA_S3TC_DXT5_Format;
    if (fourCC === 'ATI1') return THREE.RED_RGTC1_Format;
    if (fourCC === 'ATI2') return THREE.RED_GREEN_RGTC2_Format;
    if (dxgi === 71) return THREE.RGBA_S3TC_DXT1_Format;
    if (dxgi === 74) return THREE.RGBA_S3TC_DXT3_Format;
    if (dxgi === 77) return THREE.RGBA_S3TC_DXT5_Format;
    if (dxgi === 80) return THREE.RED_RGTC1_Format;
    if (dxgi === 83) return THREE.RED_GREEN_RGTC2_Format;
    if (dxgi === 95) return THREE.RGB_BPTC_UNSIGNED_Format;
    if (dxgi === 96) return THREE.RGB_BPTC_SIGNED_Format;
    if (dxgi === 98 || dxgi === 99) return THREE.RGBA_BPTC_Format;
    return null;
  }

  async _loadAcTexture(url, { kind = 'diffuse' } = {}) {
    const u = normalizeAssetUrl(url);
    if (!u) return null;
    const cached = this._acTextureCache?.get?.(u) || null;
    if (cached) return cached;

    const ext = String(u).toLowerCase().split('?')[0].split('#')[0];
    const isDds = ext.endsWith('.dds');
    const wantSrgb = (String(kind || 'diffuse').toLowerCase() === 'diffuse');

    try {
      if (!isDds) {
        const loader = new THREE.TextureLoader();
        const tex = await loader.loadAsync(u);
        try { tex.flipY = false; } catch { /* ignore */ }
        try { tex.colorSpace = wantSrgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; } catch { /* ignore */ }
        try { tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping; } catch { /* ignore */ }
        try { tex.anisotropy = 4; } catch { /* ignore */ }
        try { tex.needsUpdate = true; } catch { /* ignore */ }
        this._acTextureCache.set(u, tex);
        return tex;
      }

      const resp = await fetch(u, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const ab = await resp.arrayBuffer();
      const info = parseDds(ab);
      const blockBytes = this._acDdsBlockBytes(info);
      const fmt = this._acDdsThreeFormat(info);
      if (!blockBytes || !fmt) throw new Error(`Unsupported DDS format (fourCC=${info?.fourCC} dxgi=${info?.dxgiFormat})`);

      const fourCC = String(info?.fourCC || '');
      const canCpuDecode = (fourCC === 'DXT1' || fourCC === 'DXT3' || fourCC === 'DXT5');
      if (canCpuDecode) {
        const w0 = Math.max(1, Number(info.width) || 1);
        const h0 = Math.max(1, Number(info.height) || 1);
        const offset0 = Math.max(0, Number(info.dataOffset) || 0);
        const bw0 = Math.max(1, Math.ceil(w0 / 4));
        const bh0 = Math.max(1, Math.ceil(h0 / 4));
        const size0 = bw0 * bh0 * blockBytes;
        if (offset0 + size0 > ab.byteLength) throw new Error('DDS: level0 out of range');

        const src = new Uint8Array(ab, offset0, size0);
        const out = new Uint8Array(w0 * h0 * 4);

        const dec565 = (c) => {
          const r = ((c >> 11) & 31) * (255 / 31);
          const g = ((c >> 5) & 63) * (255 / 63);
          const b = (c & 31) * (255 / 31);
          return [r | 0, g | 0, b | 0];
        };
        const lerp8 = (a, b, tNum, tDen) => ((a * (tDen - tNum) + b * tNum) / tDen) | 0;
        const readU16 = (i) => (src[i] | (src[i + 1] << 8)) >>> 0;
        const readU32 = (i) => (src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24)) >>> 0;

        const decodeColorBlock = (base) => {
          const c0 = readU16(base + 0);
          const c1 = readU16(base + 2);
          const [r0, g0, b0] = dec565(c0);
          const [r1, g1, b1] = dec565(c1);
          const useDxt1Mode = (fourCC === 'DXT1') && (c0 <= c1);
          const cols = [
            [r0, g0, b0, 255],
            [r1, g1, b1, 255],
            [0, 0, 0, 255],
            [0, 0, 0, 255],
          ];
          if (useDxt1Mode) {
            cols[2] = [lerp8(r0, r1, 1, 2), lerp8(g0, g1, 1, 2), lerp8(b0, b1, 1, 2), 255];
            cols[3] = [0, 0, 0, 0];
          } else {
            cols[2] = [lerp8(r0, r1, 1, 3), lerp8(g0, g1, 1, 3), lerp8(b0, b1, 1, 3), 255];
            cols[3] = [lerp8(r0, r1, 2, 3), lerp8(g0, g1, 2, 3), lerp8(b0, b1, 2, 3), 255];
          }
          const idx = readU32(base + 4);
          return { cols, idx };
        };

        const blocksX = bw0;
        const blocksY = bh0;
        const blockStride = (fourCC === 'DXT1') ? 8 : 16;
        for (let by = 0; by < blocksY; by++) {
          for (let bx = 0; bx < blocksX; bx++) {
            const blockBase = (by * blocksX + bx) * blockStride;
            let colorBase = blockBase;
            let a4 = null;
            let a5 = null;

            if (fourCC === 'DXT3') {
              a4 = [];
              for (let i = 0; i < 8; i++) a4.push(src[blockBase + i] >>> 0);
              colorBase = blockBase + 8;
            } else if (fourCC === 'DXT5') {
              const a0 = src[blockBase + 0] >>> 0;
              const a1 = src[blockBase + 1] >>> 0;
              let mask = 0n;
              for (let i = 0; i < 6; i++) mask |= BigInt(src[blockBase + 2 + i] >>> 0) << BigInt(8 * i);
              a5 = { a0, a1, mask };
              colorBase = blockBase + 8;
            }

            const { cols, idx } = decodeColorBlock(colorBase);
            const aLut5 = (() => {
              if (!a5) return null;
              const a0 = a5.a0;
              const a1 = a5.a1;
              const arr = new Array(8).fill(0);
              arr[0] = a0;
              arr[1] = a1;
              if (a0 > a1) {
                arr[2] = ((6 * a0 + 1 * a1) / 7) | 0;
                arr[3] = ((5 * a0 + 2 * a1) / 7) | 0;
                arr[4] = ((4 * a0 + 3 * a1) / 7) | 0;
                arr[5] = ((3 * a0 + 4 * a1) / 7) | 0;
                arr[6] = ((2 * a0 + 5 * a1) / 7) | 0;
                arr[7] = ((1 * a0 + 6 * a1) / 7) | 0;
              } else {
                arr[2] = ((4 * a0 + 1 * a1) / 5) | 0;
                arr[3] = ((3 * a0 + 2 * a1) / 5) | 0;
                arr[4] = ((2 * a0 + 3 * a1) / 5) | 0;
                arr[5] = ((1 * a0 + 4 * a1) / 5) | 0;
                arr[6] = 0;
                arr[7] = 255;
              }
              return arr;
            })();

            for (let py = 0; py < 4; py++) {
              for (let px = 0; px < 4; px++) {
                const x = bx * 4 + px;
                const y = by * 4 + py;
                if (x >= w0 || y >= h0) continue;

                const pi = py * 4 + px;
                const ci = (idx >> (2 * pi)) & 3;
                const c = cols[ci];
                let a = c[3] | 0;

                if (a4) {
                  const byte = a4[(pi >> 1)] | 0;
                  const nib = (pi & 1) ? (byte >> 4) : (byte & 0x0F);
                  a = (nib * 17) | 0;
                } else if (a5 && aLut5) {
                  const code = Number((a5.mask >> BigInt(3 * pi)) & 0x7n) | 0;
                  a = aLut5[code] | 0;
                }

                const di = (y * w0 + x) * 4;
                out[di + 0] = c[0] | 0;
                out[di + 1] = c[1] | 0;
                out[di + 2] = c[2] | 0;
                out[di + 3] = a | 0;
              }
            }
          }
        }

        const tex = new THREE.DataTexture(out, w0, h0, THREE.RGBAFormat, THREE.UnsignedByteType);
        try { tex.flipY = false; } catch { /* ignore */ }
        try { tex.colorSpace = wantSrgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; } catch { /* ignore */ }
        tex.needsUpdate = true;
        try { tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping; } catch { /* ignore */ }
        try { tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = true; } catch { /* ignore */ }
        try { tex.anisotropy = 4; } catch { /* ignore */ }
        this._acTextureCache.set(u, tex);
        return tex;
      }

      const mipmaps = [];
      let offset = Number(info.dataOffset) || 0;
      let w = Number(info.width) || 1;
      let h = Number(info.height) || 1;
      const mipCount = Math.max(1, Number(info.mipMapCount) || 1);
      for (let i = 0; i < mipCount; i++) {
        const bw = Math.max(1, Math.ceil(w / 4));
        const bh = Math.max(1, Math.ceil(h / 4));
        const size = bw * bh * blockBytes;
        if (offset + size > ab.byteLength) break;
        mipmaps.push({ data: new Uint8Array(ab, offset, size), width: w, height: h });
        offset += size;
        w = Math.max(1, w >> 1);
        h = Math.max(1, h >> 1);
      }

      const tex = new THREE.CompressedTexture(mipmaps, Number(info.width) || 1, Number(info.height) || 1, fmt);
      try { tex.flipY = false; } catch { /* ignore */ }
      try { tex.colorSpace = wantSrgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; } catch { /* ignore */ }
      tex.needsUpdate = true;
      try { tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping; } catch { /* ignore */ }
      try {
        const useMips = mipmaps.length > 1;
        tex.minFilter = useMips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
      } catch { /* ignore */ }
      this._acTextureCache.set(u, tex);
      return tex;
    } catch {
      // Many exports ship both .dds and pre-converted .png. If DDS parsing/upload fails (unsupported
      // format / missing extensions), fall back to a same-stem PNG and cache under the DDS URL.
      if (isDds) {
        const u2 = String(u).replace(/\.dds(?=([?#]|$))/i, '.png');
        if (u2 && u2 !== u) {
          try {
            const cached2 = this._acTextureCache?.get?.(u2) || null;
            if (cached2) {
              try { this._acTextureCache.set(u, cached2); } catch { /* ignore */ }
              return cached2;
            }
            const loader = new THREE.TextureLoader();
            const tex = await loader.loadAsync(u2);
            try { tex.flipY = false; } catch { /* ignore */ }
            try { tex.colorSpace = wantSrgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; } catch { /* ignore */ }
            try { tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping; } catch { /* ignore */ }
            try { tex.anisotropy = 4; } catch { /* ignore */ }
            try { tex.needsUpdate = true; } catch { /* ignore */ }
            try { this._acTextureCache.set(u2, tex); } catch { /* ignore */ }
            try { this._acTextureCache.set(u, tex); } catch { /* ignore */ }
            return tex;
          } catch { /* ignore */ }
        }
      }
      return null;
    }
  }

  async _loadAcMaterialsManifest(url) {
    const u = normalizeAssetUrl(url);
    if (!u) return null;
    const now = Date.now();
    const cached = this._acMaterialsCache?.get?.(u) || null;
    if (cached && (now - (Number(cached.atMs) || 0)) < 60_000) return cached.matsByName || null;
    try {
      const resp = await fetch(u, { cache: 'no-store' });
      if (!resp.ok) return null;
      const j = await resp.json();
      const arr = (j && typeof j === 'object' && Array.isArray(j.materials)) ? j.materials : null;
      if (!arr) return null;
      /** @type {Record<string, any>} */
      const out = {};
      for (const it of arr) {
        if (!it || typeof it !== 'object') continue;
        const name = safeTrim(it.name || '');
        if (!name) continue;
        const shaderName = safeTrim(it.shader || '');
        const samples = (it.samples && typeof it.samples === 'object') ? it.samples : {};
        const props = (it.props && typeof it.props === 'object') ? it.props : {};
        const dmul = Number(props.detailUVMultiplier);
        const ksSpec = Number(props.ksSpecular);
        const ksExp = Number(props.ksSpecularEXP);
        const ksDiff = Number(props.ksDiffuse);
        const fresC = Number(props.fresnelC);
        const fresE = Number(props.fresnelEXP);
        const ksAlphaRef = Number(props.ksAlphaRef);
        const ksEmissive = Number(props.ksEmissive);
        out[name] = {
          shader: shaderName,
          txDiffuse: safeTrim(samples.txDiffuse || ''),
          txNormal: safeTrim(samples.txNormal || ''),
          txMask: safeTrim(samples.txMask || ''),
          txDetail: safeTrim(samples.txDetail || ''),
          txMaps: safeTrim(samples.txMaps || ''),
          txEmissive: safeTrim(samples.txEmissive || ''),
          txGlow: safeTrim(samples.txGlow || ''),
          useDetail: (Number(props.useDetail) || 0) > 0,
          detailUVMultiplier: Number.isFinite(dmul) ? dmul : 0,
          ksSpecular: Number.isFinite(ksSpec) ? ksSpec : null,
          ksSpecularEXP: Number.isFinite(ksExp) ? ksExp : null,
          ksDiffuse: Number.isFinite(ksDiff) ? ksDiff : null,
          fresnelC: Number.isFinite(fresC) ? fresC : null,
          fresnelEXP: Number.isFinite(fresE) ? fresE : null,
          ksAlphaRef: Number.isFinite(ksAlphaRef) ? ksAlphaRef : null,
          ksEmissive: Number.isFinite(ksEmissive) ? ksEmissive : null,
        };
      }
      try { this._acMaterialsCache?.set?.(u, { atMs: now, matsByName: out }); } catch { /* ignore */ }
      return out;
    } catch {
      return null;
    }
  }

  _applyAcDetailMapToMaterial(mat, detailTex, { uvMul = 20 } = {}) {
    if (!mat || !detailTex) return;
    const m = /** @type {any} */ (mat);
    const mul = Math.max(0.01, Number(uvMul) || 20);
    try {
      m.userData = m.userData || {};
      const key = `ac_detail:${detailTex.uuid}:${mul}`;
      if (m.userData.__acDetailKey === key) return;
      m.userData.__acDetailKey = key;
    } catch { /* ignore */ }

    try { detailTex.wrapS = THREE.RepeatWrapping; detailTex.wrapT = THREE.RepeatWrapping; } catch { /* ignore */ }
    try { detailTex.repeat.set(mul, mul); } catch { /* ignore */ }
    try { detailTex.needsUpdate = true; } catch { /* ignore */ }

    const prev = (typeof m.onBeforeCompile === 'function') ? m.onBeforeCompile.bind(m) : null;
    m.onBeforeCompile = (shader) => {
      try { if (prev) prev(shader); } catch { /* ignore */ }
      try {
        shader.uniforms.acDetailMap = { value: detailTex };
        shader.uniforms.acDetailUvMul = { value: mul };
      } catch { /* ignore */ }
      try {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <common>',
          [
            '#include <common>',
            'uniform sampler2D acDetailMap;',
            'uniform float acDetailUvMul;',
          ].join('\n')
        );
      } catch { /* ignore */ }
      try {
        // Multiply in a subtle tiled detail texture after the base map is applied.
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <map_fragment>',
          [
            '#include <map_fragment>',
            '#ifdef USE_MAP',
            '  vec2 acDUv = vMapUv * acDetailUvMul;',
            '#if (__VERSION__ >= 300)',
            '  vec3 acD = texture(acDetailMap, acDUv).rgb;',
            '#else',
            '  vec3 acD = texture2D(acDetailMap, acDUv).rgb;',
            '#endif',
            '  diffuseColor.rgb *= mix(vec3(1.0), acD * 2.0, 0.25);',
            '#endif',
          ].join('\n')
        );
      } catch { /* ignore */ }
    };
    try { m.customProgramCacheKey = () => `acDetail:${detailTex.uuid}:${mul}`; } catch { /* ignore */ }
    try { m.needsUpdate = true; } catch { /* ignore */ }
  }

  async _applyAcTexturesToRoot(root, cfgMeta) {
    const texDir = safeTrim(cfgMeta?.acTextureDirUrl || '');
    const matsEmbedded = (cfgMeta?.acMaterials && typeof cfgMeta.acMaterials === 'object') ? cfgMeta.acMaterials : null;
    const matsUrl = safeTrim(cfgMeta?.acMaterialsUrl || '');
    const matsFromUrl = matsUrl ? await this._loadAcMaterialsManifest(matsUrl) : null;
    const mats = (() => {
      // Prefer the URL manifest when present (it is often post-processed to point at PNGs),
      // and use embedded meta only as a fallback for missing keys/fields.
      if (matsFromUrl && typeof matsFromUrl === 'object') {
        /** @type {any} */
        const out = { ...(matsEmbedded || {}) };
        for (const [k, v] of Object.entries(matsFromUrl || {})) {
          if (!k || !v || typeof v !== 'object') continue;
          out[k] = { ...(out[k] || {}), ...v };
        }
        return out;
      }
      return (matsEmbedded && typeof matsEmbedded === 'object') ? matsEmbedded : null;
    })();
    if (!root || !texDir || !mats) return;

    const stripDupSuffix = (s) => String(s || '').replace(/\.\d+$/g, '');
    const normKey = (s, { stripSuffix = false, spacesFromUnderscore = false } = {}) => {
      let out = safeTrim(s).toLowerCase();
      if (spacesFromUnderscore) out = out.replace(/_+/g, ' ');
      out = out.replace(/\s+/g, ' ').trim();
      if (stripSuffix) out = stripDupSuffix(out);
      return out;
    };
    /** @type {Map<string, any>} */
    const matsExactLo = new Map(); // lowercased original key -> rec
    /** @type {Map<string, { name: string, rec: any }[]>} */
    const matsIndex = new Map(); // normalized variants -> candidate recs
    try {
      for (const [k, v] of Object.entries(mats)) {
        if (!k || !v || typeof v !== 'object') continue;
        const kLo = safeTrim(k).toLowerCase();
        const kLoStrip = stripDupSuffix(kLo);
        if (kLo && !matsExactLo.has(kLo)) matsExactLo.set(kLo, v);
        if (kLoStrip && !matsExactLo.has(kLoStrip)) matsExactLo.set(kLoStrip, v);
        const keys = [
          normKey(k),
          normKey(k, { stripSuffix: true }),
          normKey(k, { spacesFromUnderscore: true }),
          normKey(k, { stripSuffix: true, spacesFromUnderscore: true }),
        ];
        for (const kk of keys) {
          if (!kk) continue;
          const arr = matsIndex.get(kk) || [];
          arr.push({ name: k, rec: v });
          matsIndex.set(kk, arr);
        }
      }
    } catch { /* ignore */ }

    const join = (dir, name) => {
      const d = String(dir || '').replace(/\/+$/, '');
      const n = String(name || '').replace(/^\/+/, '');
      return d && n ? `${d}/${n}` : '';
    };

    const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
    const phongExpToRoughness = (exp) => {
      const e = Math.max(0.0, Number(exp) || 0.0);
      // Approximate Phong exponent -> GGX roughness.
      // Common mapping: roughness ≈ sqrt(2/(n+2))
      return Math.max(0.02, Math.min(1.0, Math.sqrt(2.0 / (e + 2.0))));
    };

    const ensurePhysical = (mesh, mat) => {
      if (!mesh || !mat) return mat;
      const m0 = /** @type {any} */ (mat);
      if (m0?.isMeshPhysicalMaterial) return m0;
      if (!THREE.MeshPhysicalMaterial) return m0;
      try {
        /** @type {any} */
        const p = new THREE.MeshPhysicalMaterial();
        // Copy common PBR fields best-effort.
        p.name = safeTrim(m0.name || '');
        try { p.color = m0.color?.clone?.() || p.color; } catch { /* ignore */ }
        try { p.emissive = m0.emissive?.clone?.() || p.emissive; } catch { /* ignore */ }
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap']) {
          try { if (m0[k]) p[k] = m0[k]; } catch { /* ignore */ }
        }
        for (const k of ['roughness', 'metalness', 'opacity', 'alphaTest', 'envMapIntensity']) {
          try { if (Number.isFinite(Number(m0[k]))) p[k] = Number(m0[k]); } catch { /* ignore */ }
        }
        for (const k of ['transparent', 'depthWrite', 'depthTest', 'side']) {
          try { if (m0[k] != null) p[k] = m0[k]; } catch { /* ignore */ }
        }
        try { if (m0.normalScale) p.normalScale = m0.normalScale.clone?.() || m0.normalScale; } catch { /* ignore */ }
        try { p.userData = { ...(m0.userData || {}) }; } catch { /* ignore */ }
        // Swap on mesh.
        try {
          if (Array.isArray(mesh.material)) {
            const idx = mesh.material.indexOf(mat);
            if (idx >= 0) mesh.material[idx] = p;
          } else if (mesh.material === mat) {
            mesh.material = p;
          }
        } catch { /* ignore */ }
        return p;
      } catch {
        return m0;
      }
    };

    const applyAcShaderTuning = (mesh, mat, rec) => {
      if (!mesh || !mat || !rec || typeof rec !== 'object') return mat;
      /** @type {any} */
      let m = mat;
      const nmLo = safeTrim(m?.name || '').toLowerCase();
      const shLo = safeTrim(rec.shader || '').toLowerCase();

      const ksSpec = (rec.ksSpecular == null) ? NaN : Number(rec.ksSpecular);
      const ksExp = (rec.ksSpecularEXP == null) ? NaN : Number(rec.ksSpecularEXP);
      const ksEm = (rec.ksEmissive == null) ? NaN : Number(rec.ksEmissive);

      const roughFromExp = Number.isFinite(ksExp) ? phongExpToRoughness(ksExp) : NaN;
      const metalFromSpec = Number.isFinite(ksSpec) ? clamp01((ksSpec - 0.04) / 0.96) : NaN;

      const isTire = shLo.includes('kstyres') || nmLo.includes('tyre') || nmLo.includes('tire');
      const isBrake = shLo.includes('ksbrakedisc') || nmLo.includes('brake') || nmLo.includes('disk') || nmLo.includes('disc');
      const isChrome = nmLo.includes('chrome');
      const isPaint = shLo.includes('ksperpixelmultimap') || nmLo.includes('bodypaint') || nmLo.includes('_paint') || (nmLo === 'paint');
      const isGlass = shLo.includes('glass') || shLo.includes('alpha') || shLo.startsWith('ksperpixelat') || nmLo.includes('glass') || nmLo.includes('window') || nmLo.includes('windscreen') || nmLo.includes('windshield') || nmLo.includes('headlight') || nmLo.includes('mirror');
      const isReflection = shLo.includes('reflection');

      // Roughness/metalness baseline from KN5 props when present.
      try { if (Number.isFinite(roughFromExp)) m.roughness = roughFromExp; } catch { /* ignore */ }
      try { if (Number.isFinite(metalFromSpec)) m.metalness = metalFromSpec; } catch { /* ignore */ }

      if (isTire) {
        try { m.metalness = 0.0; } catch { /* ignore */ }
        try { m.roughness = Math.max(0.78, Number(m.roughness) || 0.9); } catch { /* ignore */ }
        try { if (m.envMapIntensity != null) m.envMapIntensity = 0.25; } catch { /* ignore */ }
      } else if (isChrome) {
        try { m.metalness = Math.max(0.9, Number(m.metalness) || 1.0); } catch { /* ignore */ }
        try { m.roughness = Math.min(0.22, Number(m.roughness) || 0.12); } catch { /* ignore */ }
        try { if (m.envMapIntensity != null) m.envMapIntensity = 2.0; } catch { /* ignore */ }
      } else if (isPaint) {
        // Paint looks much closer with clearcoat (MeshPhysicalMaterial).
        m = ensurePhysical(mesh, m);
        try { m.metalness = Math.max(0.10, Math.min(0.6, Number(m.metalness) || 0.2)); } catch { /* ignore */ }
        try { m.roughness = Math.min(0.35, Math.max(0.08, Number(m.roughness) || 0.22)); } catch { /* ignore */ }
        try { m.clearcoat = 0.9; } catch { /* ignore */ }
        try { m.clearcoatRoughness = Math.min(0.28, Math.max(0.04, (Number(m.roughness) || 0.2) * 0.7)); } catch { /* ignore */ }
        try { if (m.envMapIntensity != null) m.envMapIntensity = 1.6; } catch { /* ignore */ }
      } else if (isGlass) {
        // Approximate AC glass via transmission.
        m = ensurePhysical(mesh, m);
        try { m.metalness = 0.0; } catch { /* ignore */ }
        try { m.roughness = Math.min(0.12, Math.max(0.02, Number(m.roughness) || 0.06)); } catch { /* ignore */ }
        try { m.transparent = true; } catch { /* ignore */ }
        try { m.opacity = Math.min(0.65, Math.max(0.15, Number(m.opacity) || 0.35)); } catch { /* ignore */ }
        try { m.depthWrite = false; } catch { /* ignore */ }
        try { m.transmission = 0.88; } catch { /* ignore */ }
        try { m.thickness = 0.02; } catch { /* ignore */ }
        try { m.ior = 1.45; } catch { /* ignore */ }
        try { if (m.envMapIntensity != null) m.envMapIntensity = 1.2; } catch { /* ignore */ }
      } else if (isReflection) {
        try { m.roughness = Math.min(0.32, Math.max(0.06, Number(m.roughness) || 0.18)); } catch { /* ignore */ }
        try { if (m.envMapIntensity != null) m.envMapIntensity = 1.4; } catch { /* ignore */ }
      }

      if (isBrake) {
        try { m.metalness = Math.max(0.2, Math.min(0.8, Number(m.metalness) || 0.4)); } catch { /* ignore */ }
        try { m.roughness = Math.max(0.35, Math.min(0.9, Number(m.roughness) || 0.6)); } catch { /* ignore */ }
      }

      // Emissive intensity from KN5 prop if present.
      try {
        if (Number.isFinite(ksEm) && ksEm > 0) {
          if (!Number.isFinite(Number(m.emissiveIntensity))) m.emissiveIntensity = 1.0;
          m.emissiveIntensity = Math.max(Number(m.emissiveIntensity) || 1.0, Math.min(6.0, ksEm * 2.0));
        }
      } catch { /* ignore */ }

      try { m.needsUpdate = true; } catch { /* ignore */ }
      return m;
    };

    const pickRec = (raw) => {
      const r0 = safeTrim(raw);
      if (!r0) return null;
      // Prefer exact-ish matching first to avoid normalization collisions.
      const lo = r0.toLowerCase();
      const loStrip = stripDupSuffix(lo);
      const direct = matsExactLo.get(lo) || matsExactLo.get(loStrip) || null;
      if (direct && typeof direct === 'object') return direct;

      const ks = [
        normKey(r0),
        normKey(r0, { stripSuffix: true }),
        normKey(r0, { spacesFromUnderscore: true }),
        normKey(r0, { stripSuffix: true, spacesFromUnderscore: true }),
      ];
      let best = null;
      let bestScore = -Infinity;
      for (const kk of ks) {
        const arr = kk ? (matsIndex.get(kk) || null) : null;
        if (!arr || !arr.length) continue;
        for (const it of arr) {
          const nmLo = safeTrim(it?.name || '').toLowerCase();
          const nmLoStrip = stripDupSuffix(nmLo);
          let score = 0;
          if (nmLo === lo) score = 100;
          else if (nmLoStrip === loStrip) score = 90;
          else if (nmLo.includes(loStrip) || loStrip.includes(nmLoStrip)) score = 40;
          else score = 10;
          if (score > bestScore) { bestScore = score; best = it?.rec || null; }
        }
      }
      return best && typeof best === 'object' ? best : null;
    };

    const tasks = [];
    root.traverse?.((n) => {
      const mesh = /** @type {any} */ (n);
      if (!mesh?.isMesh) return;
      const matsArr = Array.isArray(mesh.material) ? mesh.material : (mesh.material ? [mesh.material] : []);
      for (const m0 of matsArr) {
        if (!m0) continue;
        /** @type {any} */
        let m = m0;
        const candidatesRaw = [
          safeTrim(m.name || ''),
          safeTrim(mesh.name || ''),
          safeTrim(mesh?.userData?.name || ''),
          safeTrim(mesh?.userData?.material || ''),
          safeTrim(stripDupSuffix(m.name || '')),
          safeTrim(stripDupSuffix(mesh.name || '')),
        ].filter(Boolean);
        let rec = null;
        for (const raw of candidatesRaw) {
          const hit = pickRec(raw);
          if (hit) { rec = hit; break; }
        }
        if (!rec || typeof rec !== 'object') continue;
        // Apply shader tuning before binding maps (so material class/features are ready).
        try { m = applyAcShaderTuning(mesh, m, rec) || m; } catch { /* ignore */ }

        const txDiffuse = safeTrim(rec.txDiffuse || '');
        const txNormal = safeTrim(rec.txNormal || '');
        const txMaps = safeTrim(rec.txMaps || '');
        const txMask = safeTrim(rec.txMask || '');
        const txDetail = safeTrim(rec.txDetail || '');
        const txEmissive = safeTrim(rec.txEmissive || rec.txGlow || '');
        const shaderName = safeTrim(rec.shader || '');
        const ksSpecular = (rec.ksSpecular == null) ? NaN : Number(rec.ksSpecular);
        const ksSpecularEXP = (rec.ksSpecularEXP == null) ? NaN : Number(rec.ksSpecularEXP);
        const ksAlphaRef = (rec.ksAlphaRef == null) ? NaN : Number(rec.ksAlphaRef);
        const ksEmissive = (rec.ksEmissive == null) ? NaN : Number(rec.ksEmissive);
        const useDetail = !!rec.useDetail || !!txDetail;
        const detailUvMul = Number(rec.detailUVMultiplier) || 0;

        // Alpha test / transparency heuristics (helps glass + cutouts look correct).
        try {
          const nmLo = safeTrim(m?.name || '').toLowerCase();
          const meshLo = safeTrim(mesh?.name || '').toLowerCase();
          const shLo = shaderName.toLowerCase();
          const texLo = `${txDiffuse} ${txNormal} ${txEmissive}`.toLowerCase();
          const tag = `${nmLo} ${meshLo} ${texLo}`;

          const isWindowGlass = (
            tag.includes('glass')
            || tag.includes('window')
            || tag.includes('windscreen')
            || tag.includes('windshield')
          );
          const isLightLens = (
            tag.includes('headlight')
            || tag.includes('tail_light')
            || tag.includes('taillight')
            || tag.includes('reverse_light')
            || tag.includes('reverselight')
            || tag.includes('indicator')
            || tag.includes('turnsignal')
            || tag.includes('turn_signal')
            || tag.includes('blink')
            || tag.includes('lens')
            || tag.includes('lightcover')
            || tag.includes('light_cover')
          );
          const isGlassLike = isWindowGlass || isLightLens;

          const isAlphaTestShader = shLo.includes('alphatest') || shLo.startsWith('ksperpixelat') || shLo.includes('alpha_test');
          const isAlphaBlendShader = shLo.includes('alpha') && !isAlphaTestShader;

          // Cutouts: prefer alphaTest (no blending) to avoid sorting artifacts.
          if (Number.isFinite(ksAlphaRef) && ksAlphaRef > 0 && !isGlassLike) {
            const at = clamp01(ksAlphaRef);
            try { m.alphaTest = at; } catch { /* ignore */ }
            if (at > 0) {
              try { m.transparent = false; } catch { /* ignore */ }
              try { m.depthWrite = true; } catch { /* ignore */ }
            }
          }

          // True glass/lenses: blending + reduced opacity.
          if (isGlassLike) {
            try { m.transparent = true; } catch { /* ignore */ }
            try { m.depthWrite = false; } catch { /* ignore */ }
            try {
              const o = Number(m.opacity);
              const base = Number.isFinite(o) ? o : (isLightLens ? 0.65 : 0.35);
              const lo = isLightLens ? 0.25 : 0.12;
              const hi = isLightLens ? 0.90 : 0.65;
              m.opacity = Math.min(hi, Math.max(lo, base));
            } catch { /* ignore */ }
            try { if ('side' in m) m.side = THREE.DoubleSide; } catch { /* ignore */ }
            try { m.roughness = Math.min(0.25, Math.max(0.02, Number(m.roughness) || 0.12)); } catch { /* ignore */ }
            try { m.metalness = Math.min(0.05, Math.max(0.0, Number(m.metalness) || 0.0)); } catch { /* ignore */ }
            try { m.needsUpdate = true; } catch { /* ignore */ }
          } else if (isAlphaBlendShader) {
            // Alpha-blended shaders (decals/grilles/etc): enable blending but keep opacity at 1 so texture alpha drives it.
            try { m.transparent = true; } catch { /* ignore */ }
            try { m.needsUpdate = true; } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
        if (txDiffuse) {
          tasks.push(this._loadAcTexture(join(texDir, txDiffuse), { kind: 'diffuse' }).then((t) => {
            if (t) {
              // Ensure map isn't multiplied away by a bad base color factor.
              try { if (m.color && typeof m.color.set === 'function') m.color.set(0xffffff); } catch { /* ignore */ }
              m.map = t;
              m.needsUpdate = true;
            }
          }));
        }
        if (txNormal) {
          tasks.push(this._loadAcTexture(join(texDir, txNormal), { kind: 'normal' }).then((t) => {
            if (t) {
              m.normalMap = t;
              try {
                if (m.normalScale && typeof m.normalScale.set === 'function') m.normalScale.set(1, -1);
                else m.normalScale = new THREE.Vector2(1, -1);
              } catch { /* ignore */ }
              m.needsUpdate = true;
            }
          }));
        }
        if (txMaps) {
          tasks.push(this._loadAcTexture(join(texDir, txMaps), { kind: 'linear' }).then((t) => {
            if (!t) return;
            // AC "txMaps" is commonly a packed "maps" texture; treat it like an ORM-ish helper.
            // We apply it as roughness/metalness (both read from the same packed texture).
            try { if (!m.roughnessMap) m.roughnessMap = t; } catch { /* ignore */ }
            try { if (!m.metalnessMap) m.metalnessMap = t; } catch { /* ignore */ }
            try {
              if (Number.isFinite(Number(m.roughness))) m.roughness = Math.max(0.0, Number(m.roughness));
              else m.roughness = 1.0;
            } catch { /* ignore */ }
            try {
              if (Number.isFinite(Number(m.metalness))) m.metalness = Math.max(0.0, Number(m.metalness));
              else m.metalness = 1.0;
            } catch { /* ignore */ }
            try { m.needsUpdate = true; } catch { /* ignore */ }
          }));
        }
        if (txMask) {
          tasks.push(this._loadAcTexture(join(texDir, txMask), { kind: 'linear' }).then((t) => {
            if (!t) return;
            // Some cars use txMask instead of txMaps. Map it the same conservative way.
            try { if (!m.roughnessMap) m.roughnessMap = t; } catch { /* ignore */ }
            try { if (!m.metalnessMap) m.metalnessMap = t; } catch { /* ignore */ }
            try {
              if (Number.isFinite(Number(m.roughness))) m.roughness = Math.max(0.0, Number(m.roughness));
              else m.roughness = 1.0;
            } catch { /* ignore */ }
            try {
              if (Number.isFinite(Number(m.metalness))) m.metalness = Math.max(0.0, Number(m.metalness));
              else m.metalness = 1.0;
            } catch { /* ignore */ }
            try { m.needsUpdate = true; } catch { /* ignore */ }
          }));
        }
        if (txDetail) {
          tasks.push(this._loadAcTexture(join(texDir, txDetail), { kind: 'linear' }).then((t) => {
            if (!t) return;
            const mul = (detailUvMul > 0) ? detailUvMul : 20;
            if (useDetail) this._applyAcDetailMapToMaterial(m, t, { uvMul: mul });
          }));
        }
        if (txEmissive) {
          const txEmLo = txEmissive.toLowerCase();
          if (!(txEmLo === 'null' || txEmLo === 'null.png' || txEmLo === 'null.dds')) {
            tasks.push(this._loadAcTexture(join(texDir, txEmissive), { kind: 'diffuse' }).then((t) => {
              if (!t) return;
              try { m.emissiveMap = t; } catch { /* ignore */ }
              try {
                if (m.emissive && typeof m.emissive.set === 'function') m.emissive.set(0xffffff);
                else m.emissive = new THREE.Color(0xffffff);
              } catch { /* ignore */ }
              try {
                const k = Number.isFinite(ksEmissive) ? Math.max(0.0, Math.min(20.0, ksEmissive)) : NaN;
                if (Number.isFinite(k)) m.emissiveIntensity = k;
                else if (!Number.isFinite(Number(m.emissiveIntensity))) m.emissiveIntensity = 1.0;
              } catch { /* ignore */ }
              try { if ('toneMapped' in m) m.toneMapped = false; } catch { /* ignore */ }
              try { m.needsUpdate = true; } catch { /* ignore */ }
            }));
          }
        }

        // If packed maps can't be used (often BC7), approximate roughness/metalness from shader props
        // so paint/rims/tires don't look flat.
        try {
          const haveMapsTex = !!(m.roughnessMap || m.metalnessMap);
          if (!haveMapsTex && (Number.isFinite(ksSpecularEXP) || Number.isFinite(ksSpecular))) {
            const nmLo = safeTrim(m?.name || '').toLowerCase();
            const shLo = shaderName.toLowerCase();
            let rough = Number.isFinite(ksSpecularEXP) ? phongExpToRoughness(ksSpecularEXP) : (Number(m.roughness) || 0.9);
            let metal = Number.isFinite(ksSpecular) ? clamp01((ksSpecular - 0.04) / 0.96) : (Number(m.metalness) || 0.0);

            const isTire = shLo.includes('kstyres') || nmLo.includes('tyre') || nmLo.includes('tire');
            const isChrome = nmLo.includes('chrome');
            const isPaint = (nmLo === 'bodypaint') || nmLo.includes('bodypaint') || nmLo.includes('_paint') || nmLo.includes('paint');

            if (isTire) {
              metal = 0.0;
              rough = Math.max(0.75, rough);
            }
            if (isChrome) {
              metal = Math.max(0.9, metal);
              rough = Math.min(0.22, rough);
            } else if (isPaint) {
              metal = Math.max(0.10, metal);
              rough = Math.min(0.35, rough);
            }

            try { if (Number.isFinite(Number(m.roughness))) m.roughness = Math.max(0.02, Math.min(1.0, Number(rough) || 0.9)); } catch { /* ignore */ }
            try { if (Number.isFinite(Number(m.metalness))) m.metalness = Math.max(0.0, Math.min(1.0, Number(metal) || 0.0)); } catch { /* ignore */ }
            try { m.needsUpdate = true; } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }
    });

    if (tasks.length) {
      try { await Promise.all(tasks); } catch { /* ignore */ }
    }
  }

  // ---- Tire overlay ----
  _resolveTireUrl() {
    try {
      const u = safeTrim(localStorage.getItem('gameplay.tireUrl') || '');
      if (u) return u;
    } catch { /* ignore */ }
    return safeTrim(this._tire?.url || '');
  }

  async _ensureTireAssetLoaded() {
    if (!this._tire?.enabled) return null;
    const u = this._resolveTireUrl();
    if (!u) return null;
    if (this._tireAsset && this._tireAsset.url === u && this._tireAsset.root) return this._tireAsset;
    if (this._tireLoading) return this._tireAsset;
    this._tireLoading = true;
    try {
      const gltf = await this._tireLoader.loadAsync(u);
      const root = gltf?.scene || null;
      if (!root) return null;

      const box = new THREE.Box3().setFromObject(root);
      const size = new THREE.Vector3();
      box.getSize(size);
      const dims = [Math.abs(size.x), Math.abs(size.y), Math.abs(size.z)];
      const minDim = Math.min(dims[0], dims[1], dims[2]);
      const widthAxis = (dims[0] === minDim) ? 0 : (dims[1] === minDim) ? 1 : 2;
      const widthVec = (widthAxis === 0) ? new THREE.Vector3(1, 0, 0) : (widthAxis === 1) ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
      const alignQ = new THREE.Quaternion().setFromUnitVectors(widthVec, new THREE.Vector3(1, 0, 0));
      const outerRadius = 0.5 * Math.max(dims[0], dims[1], dims[2], 1e-6);

      try {
        root.traverse?.((n) => {
          const any = /** @type {any} */ (n);
          const mat = any.material;
          if (Array.isArray(mat)) for (const m of mat) { if (m) { m.userData = m.userData || {}; m.userData.__skipDispose = true; } }
          else if (mat) { mat.userData = mat.userData || {}; mat.userData.__skipDispose = true; }
        });
      } catch { /* ignore */ }

      this._tireAsset = { url: u, root, alignQ, outerRadius, width: minDim };
      return this._tireAsset;
    } catch {
      return null;
    } finally {
      this._tireLoading = false;
    }
  }

  _applyRealisticTiresToVehicle(v) {
    const asset = this._tireAsset;
    if (!asset?.root) return;
    const parts = v?.parts || null;
    const wheels = parts?.wheelsAll || null;
    if (!Array.isArray(wheels) || wheels.length === 0) return;
    const radiusFront = Number(parts?.wheelRadius) || 0;
    const radiusRear = Number(parts?.wheelRadiusRear) || radiusFront;
    const widthFront = Number(parts?.wheelWidth) || 0.20;
    const widthRear = Number(parts?.wheelWidthRear) || widthFront;
    if (!(radiusFront > 0)) return;

    // Avoid double-wheels: many imported vehicle models already contain wheel/tire meshes.
    // In that case we only keep the authored wheels and skip the "realistic tire" overlay.
    const hasRealWheelMesh = (pivot) => {
      let ok = false;
      try {
        pivot?.traverse?.((n) => {
          if (ok) return;
          const any = /** @type {any} */ (n);
          if (!any || !any.isMesh) return;
          if (any?.userData?.__tirePlaceholder) return;
          if (safeTrim(any?.name || '') === 'tire_realistic') return;
          ok = true;
        });
      } catch { /* ignore */ }
      return ok;
    };

    const outerR = Math.max(1e-6, Number(asset.outerRadius) || 1.0);
    const baseWidth = Math.max(1e-6, Number(asset.width) || 0);
    const extraWidthMul = Number(this._tire?.widthMul) || 1.0;
    const frontSet = new Set(Array.isArray(parts?.wheelsFront) ? parts.wheelsFront : []);

    for (const pivot of wheels) {
      if (!pivot) continue;
      if (hasRealWheelMesh(pivot)) continue;
      const isFront = frontSet.has(pivot);
      const radius = isFront ? radiusFront : radiusRear;
      const width = isFront ? widthFront : widthRear;
      const sU = Math.max(1e-6, radius / outerR);
      const wantW = Math.max(0.02, width);
      const curW = baseWidth * sU;
      const wMul = (baseWidth > 0) ? (wantW / Math.max(1e-6, curW)) : 1.0;
      const kill = [];
      for (const ch of (pivot.children || [])) {
        if (!ch) continue;
        const isPlaceholder = !!(ch?.userData && ch.userData.__tirePlaceholder);
        if (ch.name === 'tire_realistic' || isPlaceholder) kill.push(ch);
      }
      for (const ch of kill) {
        try { pivot.remove(ch); } catch { /* ignore */ }
        try { disposeThreeObject(ch); } catch { /* ignore */ }
      }

      const inst = /** @type {THREE.Object3D} */ (asset.root.clone(true));
      inst.name = 'tire_realistic';
      inst.traverse?.((n) => { try { n.userData = n.userData || {}; n.userData.__skipDispose = true; } catch { /* ignore */ } });
      inst.quaternion.copy(asset.alignQ || new THREE.Quaternion(0, 0, 0, 1));
      inst.scale.setScalar(sU);
      inst.scale.x *= (wMul * extraWidthMul);
      pivot.add(inst);
    }
  }

  _ensureAssetVehicleWheelPivots(inst, vrec, anchors, anchorUnitScale = 1.0) {
    const parts = vrec?.parts || null;
    if (!inst || !parts) return;
    const have = Array.isArray(parts.wheelsAll) ? parts.wheelsAll : [];
    if (have.length) return;

    const wheelsAll = [];
    const wheelsFront = [];

    const attachPreserve = (parent, obj) => {
      if (!parent || !obj) return;
      try { if (typeof parent.attach === 'function') { parent.attach(obj); return; } } catch { /* ignore */ }
      try {
        obj.updateMatrixWorld(true);
        parent.updateMatrixWorld(true);
        const world = obj.matrixWorld.clone();
        parent.add(obj);
        const inv = parent.matrixWorld.clone().invert();
        obj.matrix.copy(inv.multiply(world));
        obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
      } catch {
        try { parent.add(obj); } catch { /* ignore */ }
      }
    };

    const candidates = [];
    const allMeshes = [];
    try {
      inst.traverse?.((n) => {
        const any = /** @type {any} */ (n);
        if (!any || !any.isMesh) return;
        const nm = safeTrim(any.name || '').toLowerCase();
        if (nm.includes('tire_realistic')) return;
        allMeshes.push(any);
        if (!nm) return;
        // Exclude interior steering wheel etc.
        if (nm.includes('steer') || nm.includes('steering')) return;
        // Avoid false positives like "trim" matching "rim", but still match "rim500" etc.
        // Treat digits/underscore as a boundary (common in AC exports: Rim500, RIM_BLUR_LF).
        if (!/(^|[^a-z])(wheel|tire|tyre|rim)([^a-z]|$)/.test(nm)) return;
        candidates.push(any);
      });
    } catch { /* ignore */ }

    const tmpA = new THREE.Vector3();
    const tmpB = new THREE.Vector3();
    const tmpS = new THREE.Vector3();
    const wheelRadiusGuess = (() => {
      try {
        const r0 = Number(parts?.wheelRadius) || 0;
        const rr = Number(parts?.wheelRadiusRear) || 0;
        const r = Math.max(r0, rr, 0.36);
        return clamp(Number(r) || 0.36, 0.18, 0.65);
      } catch {
        return 0.36;
      }
    })();
    const meshWorldRadius = (m) => {
      if (!m) return NaN;
      const g = /** @type {any} */ (m.geometry);
      if (!g) return NaN;
      try { if (!g.boundingSphere && typeof g.computeBoundingSphere === 'function') g.computeBoundingSphere(); } catch { /* ignore */ }
      const r = Number(g?.boundingSphere?.radius) || 0;
      if (!(r > 0)) return NaN;
      try { m.getWorldScale?.(tmpS); } catch { tmpS.set(1, 1, 1); }
      const ms = Math.max(Math.abs(tmpS.x) || 0, Math.abs(tmpS.y) || 0, Math.abs(tmpS.z) || 0, 1e-6);
      return r * ms;
    };
    // For imported vehicles (esp. Assetto exports), wheel meshes are often not named "wheel/tire/rim".
    // If we have very few name-based candidates, broaden to "wheel-like" meshes by size.
    if (Array.isArray(allMeshes) && allMeshes.length && (candidates.length < 4)) {
      const broad = [];
      for (const m of allMeshes) {
        if (!m || m.userData?.__wheelTaken) continue;
        const wr = meshWorldRadius(m);
        if (!Number.isFinite(wr)) continue;
        if (wr < wheelRadiusGuess * 0.25) continue;
        if (wr > wheelRadiusGuess * 3.5) continue;
        broad.push(m);
      }
      if (broad.length >= 4) {
        candidates.length = 0;
        candidates.push(...broad);
      }
    }
    const pickNearest = (targetWorld) => {
      let best = null;
      let bestD2 = Infinity;
      for (const m of candidates) {
        if (!m || m.userData?.__wheelTaken) continue;
        try {
          m.getWorldPosition(tmpA);
          const d2 = tmpA.distanceToSquared(targetWorld);
          if (d2 < bestD2) { bestD2 = d2; best = m; }
        } catch { /* ignore */ }
      }
      if (best) {
        try { best.userData = best.userData || {}; best.userData.__wheelTaken = true; } catch { /* ignore */ }
      }
      return best;
    };

    const mkPivot = (name, localPos) => {
      const p = new THREE.Group();
      p.name = name;
      p.position.copy(localPos);
      // Compose steering (Y) then roll (X) to avoid wheel wobble from Euler order.
      p.rotation.order = 'YXZ';
      inst.add(p);
      return p;
    };

    const wheelAnchorLocal = (key) => {
      const p = Array.isArray(anchors?.[key]?.pos) ? anchors[key].pos : null;
      if (!p || p.length < 3) return null;
      const s = (Number(anchorUnitScale) || 1.0);
      return new THREE.Vector3((Number(p[0]) || 0) * s, (Number(p[1]) || 0) * s, (Number(p[2]) || 0) * s);
    };

    const wheelKeys = [
      { key: 'wheel_lf', id: 'lf', isFront: true },
      { key: 'wheel_rf', id: 'rf', isFront: true },
      { key: 'wheel_lr', id: 'lr', isFront: false },
      { key: 'wheel_rr', id: 'rr', isFront: false },
    ];

    const locals = wheelKeys.map((w) => ({ ...w, local: wheelAnchorLocal(w.key) }));
    const haveAnchors = locals.every((w) => !!w.local);

    if (haveAnchors) {
      const pivots = new Map();
      const wheelWorld = new Map();
      for (const w of locals) {
        const local = w.local;
        const pivot = mkPivot(`wheel_${w.id}_pivot`, local);
        pivots.set(w.id, pivot);
        wheelsAll.push(pivot);
        if (w.isFront) wheelsFront.push(pivot);
        try { wheelWorld.set(w.id, inst.localToWorld(tmpB.copy(local)).clone()); } catch { /* ignore */ }
      }

      // If we detected only ~4 wheel candidates (often just tyres), try to pull in additional
      // wheel submeshes (rims/hubs/discs) by size + proximity to the anchor points.
      if (Array.isArray(allMeshes) && allMeshes.length && candidates.length < 8) {
        const candSet = new Set(candidates);
        const extra = [];
        const maxNearDist = Math.max(0.22, wheelRadiusGuess * 2.2);
        const maxNearDist2 = maxNearDist * maxNearDist;
        const centerDist = Math.max(0.22, wheelRadiusGuess * 1.35);
        const centerDist2 = centerDist * centerDist;
        for (const m of allMeshes) {
          if (!m || m.userData?.__wheelTaken) continue;
          if (candSet.has(m)) continue;
          const nm = safeTrim(m?.name || '').toLowerCase();
          if (nm.includes('tire_realistic')) continue;
          if (nm.includes('steer') || nm.includes('steering')) continue;
          // Avoid attaching body/glass bits even if they are near a wheel.
          if (nm.includes('glass') || nm.includes('window') || nm.includes('windscreen') || nm.includes('windshield')) continue;
          if (nm.includes('door') || nm.includes('bonnet') || nm.includes('hood') || nm.includes('trunk') || nm.includes('boot')) continue;

          const wr = meshWorldRadius(m);
          if (!Number.isFinite(wr)) continue;
          // Wheel-like size window (tighter than the earlier broad pass).
          if (wr < wheelRadiusGuess * 0.30) continue;
          if (wr > wheelRadiusGuess * 2.20) continue;

          // Must be close to some wheel anchor, and ideally close to the wheel center.
          try { m.getWorldPosition(tmpA); } catch { continue; }
          let bestD2 = Infinity;
          for (const w of locals) {
            const ww = wheelWorld.get(w.id);
            if (!ww) continue;
            const d2 = ww.distanceToSquared(tmpA);
            if (d2 < bestD2) bestD2 = d2;
          }
          if (!(bestD2 <= maxNearDist2)) continue;
          if (!(bestD2 <= centerDist2)) continue;
          extra.push(m);
        }
        if (extra.length) candidates.push(...extra);
      }

      const suffixFromName = (name) => {
        const nm = safeTrim(name || '').toLowerCase();
        if (!nm) return '';
        const m = nm.match(/(?:^|[^a-z0-9])(lf|rf|lr|rr|fl|fr|rl)(?:$|[^a-z0-9])/);
        if (!m) return '';
        const suf = String(m[1] || '').toLowerCase();
        return { fl: 'lf', fr: 'rf', rl: 'lr' }[suf] || suf;
      };

      // Attach *all* wheel-related meshes for each corner (tyre + rim submeshes + hub),
      // not just the nearest single mesh.
      const maxAttachDist = Math.max(0.20, wheelRadiusGuess * 2.2);
      const maxAttachDist2 = maxAttachDist * maxAttachDist;
      for (const m of candidates) {
        if (!m || m.userData?.__wheelTaken) continue;

        // Prefer explicit suffix mapping when present (common in Assetto exports).
        const suf = suffixFromName(m?.name || '');
        const pivotBySuf = suf ? pivots.get(suf) : null;
        if (pivotBySuf) {
          attachPreserve(pivotBySuf, m);
          try { m.userData = m.userData || {}; m.userData.__wheelTaken = true; } catch { /* ignore */ }
          continue;
        }

        // Fallback: distance-to-anchor assignment.
        let bestId = '';
        let bestD2 = Infinity;
        try { m.getWorldPosition(tmpA); } catch { continue; }
        for (const w of locals) {
          const ww = wheelWorld.get(w.id);
          if (!ww) continue;
          const d2 = ww.distanceToSquared(tmpA);
          if (d2 < bestD2) { bestD2 = d2; bestId = w.id; }
        }
        if (bestId && bestD2 <= maxAttachDist2) {
          const p = pivots.get(bestId);
          if (p) {
            attachPreserve(p, m);
            try { m.userData = m.userData || {}; m.userData.__wheelTaken = true; } catch { /* ignore */ }
          }
        }
      }
    } else {
      const scored = [];
      for (const m of candidates) {
        try {
          m.getWorldPosition(tmpA);
          const local = inst.worldToLocal(tmpA.clone());
          scored.push({ m, x: local.x, y: local.y, z: local.z });
        } catch { /* ignore */ }
      }
      if (scored.length >= 2) {
        const byZ = scored.slice().sort((a, b) => a.z - b.z);
        const front = byZ.slice(0, Math.min(2, byZ.length));
        const rear = byZ.slice(Math.max(0, byZ.length - 2));
        const pickLR = (arr) => {
          if (!arr.length) return { left: null, right: null };
          const left = arr.slice().sort((a, b) => a.x - b.x)[0] || null;
          const right = arr.slice().sort((a, b) => b.x - a.x)[0] || null;
          return { left, right };
        };
        const f = pickLR(front);
        const r = pickLR(rear);
        const slots = [
          { id: 'lf', isFront: true, item: f.left },
          { id: 'rf', isFront: true, item: f.right },
          { id: 'lr', isFront: false, item: r.left },
          { id: 'rr', isFront: false, item: r.right },
        ];
        for (const s of slots) {
          const it = s.item;
          if (!it?.m) continue;
          const pivot = mkPivot(`wheel_${s.id}_pivot`, new THREE.Vector3(it.x, it.y, it.z));
          attachPreserve(pivot, it.m);
          wheelsAll.push(pivot);
          if (s.isFront) wheelsFront.push(pivot);
        }
      }
    }

    parts.wheelsAll = wheelsAll;
    parts.wheelsFront = wheelsFront;
  }

  _ensureAssetVehicleWheelOverlayPlaceholders(vrec, { enabled = true, frontScaleMul = 1.0, rearScaleMul = 1.0 } = {}) {
    if (!enabled) return;
    const parts = vrec?.parts || null;
    if (!parts) return;
    const wheels = Array.isArray(parts.wheelsAll) ? parts.wheelsAll : [];
    if (!wheels.length) return;
    const fronts = new Set(Array.isArray(parts.wheelsFront) ? parts.wheelsFront : []);

    const radiusFront = Math.max(0.18, Number(parts.wheelRadius) || 0.36) * (Number(frontScaleMul) || 1.0);
    const radiusRear = Math.max(0.18, Number(parts.wheelRadiusRear) || radiusFront) * (Number(rearScaleMul) || 1.0);
    const widthFront = Math.max(0.08, Number(parts.wheelWidth) || 0.20);
    const widthRear = Math.max(0.08, Number(parts.wheelWidthRear) || widthFront);

    const tireMat = new THREE.MeshStandardMaterial({ color: 0x10151f, roughness: 0.95, metalness: 0.0 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x3a465a, roughness: 0.55, metalness: 0.05 });

    const hasRealWheelMesh = (pivot) => {
      let ok = false;
      try {
        pivot.traverse?.((n) => {
          if (ok) return;
          const any = /** @type {any} */ (n);
          if (!any || !any.isMesh) return;
          if (any?.userData?.__tirePlaceholder) return;
          if (safeTrim(any?.name || '') === 'tire_realistic') return;
          ok = true;
        });
      } catch { /* ignore */ }
      return ok;
    };

    for (const pivot of wheels) {
      if (!pivot) continue;
      if (hasRealWheelMesh(pivot)) continue;
      const isFront = fronts.has(pivot);
      const radius = isFront ? radiusFront : radiusRear;
      const width = isFront ? widthFront : widthRear;

      const already = (pivot.children || []).some((ch) => !!(ch?.userData && ch.userData.__tirePlaceholder));
      if (already) continue;

      const tireGeo = new THREE.CylinderGeometry(radius, radius, width, 14, 1);
      const tire = new THREE.Mesh(tireGeo, tireMat);
      tire.name = 'tire';
      try { tire.userData = tire.userData || {}; tire.userData.__tirePlaceholder = true; } catch { /* ignore */ }
      tire.rotation.z = Math.PI * 0.5;
      tire.castShadow = true;
      tire.receiveShadow = true;
      pivot.add(tire);

      const rimGeo = new THREE.CylinderGeometry(radius * 0.62, radius * 0.62, width * 0.85, 12, 1);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      rim.name = 'rim';
      try { rim.userData = rim.userData || {}; rim.userData.__tirePlaceholder = true; } catch { /* ignore */ }
      rim.rotation.z = Math.PI * 0.5;
      rim.position.y = 0.001;
      rim.castShadow = true;
      rim.receiveShadow = true;
      pivot.add(rim);
    }
  }

  // ---- Procedural (proc:arena) vehicles ----
  async spawnDefaultVehicles() {
    if (!this._scene || !this._game?.enabled) return;
    this.resetForWorldClear();
    // Procedural vehicles should also be Chrono-backed. Ensure WASM is ready first so
    // `_makeVehicle` can allocate a JSON-defined Chrono vehicle.
    if (!this._vehicleSim?.ready) {
      try { await this.initProjectChronoWasm(); } catch { /* ignore */ }
    }
    if (!this._vehicleSim?.ready) return;
    // Two vehicles placed near spawn area for easy testing
    const jeep = this._makeVehicle({ id: 'jeep', kind: 'jeep', x: -10, y: 0, z: 22, yaw: Math.PI * 0.5 });
    const van = this._makeVehicle({ id: 'van', kind: 'van', x: 10, y: 0, z: 22, yaw: -Math.PI * 0.5 });
    if (jeep) {
      jeep.occ.set('driver', 'npc');
      this._vehicles.push(jeep);
    }
    if (van) this._vehicles.push(van);
    void (async () => {
      try { await this._ensureTireAssetLoaded(); } catch { /* ignore */ }
      try { for (const vv of (this._vehicles || [])) this._applyRealisticTiresToVehicle(vv); } catch { /* ignore */ }
    })();
  }

  _makeVehicle({ id, kind, x, y, z, yaw }) {
    if (!this._scene) return null;
    const group = new THREE.Group();
    group.name = `veh_${id}`;
    group.position.set(Number(x) || 0, Number(y) || 0, Number(z) || 0);
    group.rotation.y = Number(yaw) || 0;

    const paintColor = (kind === 'van') ? 0x6b8bbd : 0x3d506b;
    const bodyMat = (THREE.MeshPhysicalMaterial)
      ? new THREE.MeshPhysicalMaterial({
        color: paintColor,
        roughness: 0.55,
        metalness: 0.05,
        clearcoat: 0.55,
        clearcoatRoughness: 0.28,
      })
      : new THREE.MeshStandardMaterial({ color: paintColor, roughness: 0.65, metalness: 0.05 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x1b2433, roughness: 0.8, metalness: 0.0 });
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x10151f, roughness: 0.95, metalness: 0.0 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x3a465a, roughness: 0.55, metalness: 0.05 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x0d1420, roughness: 0.12, metalness: 0.0, transparent: true, opacity: 0.48 });
    const accentMat = new THREE.MeshStandardMaterial({ color: 0xffd166, roughness: 0.55, metalness: 0.0, emissive: 0x241b05 });
    const headLightMat = new THREE.MeshStandardMaterial({ color: 0xd8f0ff, roughness: 0.15, metalness: 0.0, emissive: 0x9ad0ff, emissiveIntensity: 0.55 });
    const tailLightMat = new THREE.MeshStandardMaterial({ color: 0xff4d4d, roughness: 0.25, metalness: 0.0, emissive: 0xff2a2a, emissiveIntensity: 0.35 });

    const add = (mesh) => { group.add(mesh); return mesh; };
    const addBox = (w, h, d, mat, px, py, pz, name = '', { cast = true, recv = true } = {}) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(px, py, pz);
      if (name) m.name = name;
      m.castShadow = !!cast;
      m.receiveShadow = !!recv;
      return add(m);
    };
    const addWheel = ({ px, pz, radius = 0.36, width = 0.20, name = '' } = {}) => {
      const pivot = new THREE.Group();
      if (name) pivot.name = name;
      pivot.position.set(px, radius, pz);
      // Compose steering (Y) then roll (X) to avoid wheel wobble from Euler order.
      pivot.rotation.order = 'YXZ';
      group.add(pivot);

      const tireGeo = new THREE.CylinderGeometry(radius, radius, width, 14, 1);
      const tire = new THREE.Mesh(tireGeo, tireMat);
      tire.name = 'tire';
      try { tire.userData = tire.userData || {}; tire.userData.__tirePlaceholder = true; } catch { /* ignore */ }
      tire.rotation.z = Math.PI * 0.5;
      tire.castShadow = true;
      tire.receiveShadow = true;
      pivot.add(tire);

      const rimGeo = new THREE.CylinderGeometry(radius * 0.62, radius * 0.62, width * 0.85, 12, 1);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      rim.name = 'rim';
      try { rim.userData = rim.userData || {}; rim.userData.__tirePlaceholder = true; } catch { /* ignore */ }
      rim.rotation.z = Math.PI * 0.5;
      rim.position.y = 0.001;
      rim.castShadow = true;
      rim.receiveShadow = true;
      pivot.add(rim);

      const capGeo = new THREE.CylinderGeometry(radius * 0.18, radius * 0.18, width * 0.95, 10, 1);
      const cap = new THREE.Mesh(capGeo, trimMat);
      cap.name = 'cap';
      try { cap.userData = cap.userData || {}; cap.userData.__tirePlaceholder = true; } catch { /* ignore */ }
      cap.rotation.z = Math.PI * 0.5;
      cap.position.y = 0.002;
      cap.castShadow = true;
      cap.receiveShadow = true;
      pivot.add(cap);
      return pivot;
    };

    if (kind === 'van') {
      addBox(2.25, 0.58, 4.45, bodyMat, 0, 0.57, 0.05, 'van_base');
      addBox(2.08, 0.92, 3.30, bodyMat, 0, 1.12, 0.10, 'van_shell');
      addBox(2.10, 0.08, 3.10, trimMat, 0, 1.60, 0.15, 'van_roof_trim', { cast: false, recv: true });
      addBox(2.05, 0.28, 0.75, bodyMat, 0, 0.95, -1.85, 'van_hood', { cast: true, recv: true });
      addBox(2.28, 0.20, 0.55, trimMat, 0, 0.48, -2.10, 'van_bumper_f');
      addBox(2.28, 0.20, 0.55, trimMat, 0, 0.48, 2.15, 'van_bumper_r');
      addBox(1.72, 0.60, 0.06, glassMat, 0, 1.25, -1.98, 'van_windshield', { cast: false, recv: true });
      addBox(0.07, 0.52, 1.20, glassMat, -1.07, 1.20, -1.00, 'van_glassL', { cast: false, recv: true });
      addBox(0.07, 0.52, 1.20, glassMat, 1.07, 1.20, -1.00, 'van_glassR', { cast: false, recv: true });
      addBox(0.07, 0.52, 1.25, glassMat, -1.07, 1.20, 0.55, 'van_glassL2', { cast: false, recv: true });
      addBox(0.07, 0.52, 1.25, glassMat, 1.07, 1.20, 0.55, 'van_glassR2', { cast: false, recv: true });
      addBox(0.02, 0.62, 2.00, trimMat, 1.06, 0.95, 0.65, 'van_door_seam', { cast: false, recv: true });
      addBox(0.10, 0.05, 0.05, accentMat, 1.05, 1.06, 0.50, 'van_handle');
      addBox(0.20, 0.14, 0.05, headLightMat, -0.72, 0.78, -2.25, 'van_headL', { cast: false, recv: true });
      addBox(0.20, 0.14, 0.05, headLightMat, 0.72, 0.78, -2.25, 'van_headR', { cast: false, recv: true });
      addBox(0.18, 0.16, 0.05, tailLightMat, -0.88, 0.78, 2.35, 'van_tailL', { cast: false, recv: true });
      addBox(0.18, 0.16, 0.05, tailLightMat, 0.88, 0.78, 2.35, 'van_tailR', { cast: false, recv: true });
      addBox(0.14, 0.10, 0.18, trimMat, -1.20, 1.15, -1.25, 'van_mirrorL');
      addBox(0.14, 0.10, 0.18, trimMat, 1.20, 1.15, -1.25, 'van_mirrorR');
    } else {
      addBox(2.05, 0.52, 3.35, bodyMat, 0, 0.58, 0.15, 'jeep_base');
      addBox(1.92, 0.62, 1.45, bodyMat, 0, 1.03, -0.78, 'jeep_cabin');
      addBox(1.86, 0.38, 1.35, bodyMat, 0, 0.92, 1.25, 'jeep_bed');
      addBox(1.86, 0.10, 0.08, trimMat, 0, 1.15, 1.92, 'jeep_tailgate_top');
      addBox(0.08, 0.32, 1.20, trimMat, -0.93, 1.00, 1.25, 'jeep_bed_railL', { cast: false, recv: true });
      addBox(0.08, 0.32, 1.20, trimMat, 0.93, 1.00, 1.25, 'jeep_bed_railR', { cast: false, recv: true });
      addBox(2.12, 0.22, 0.55, trimMat, 0, 0.46, -1.65, 'jeep_bumper_f');
      addBox(1.30, 0.28, 0.18, trimMat, 0, 0.78, -1.50, 'jeep_grille');
      addBox(1.62, 0.50, 0.06, glassMat, 0, 1.15, -1.38, 'jeep_windshield', { cast: false, recv: true });
      addBox(0.06, 0.38, 0.85, glassMat, -0.98, 1.10, -0.75, 'jeep_glassL', { cast: false, recv: true });
      addBox(0.06, 0.38, 0.85, glassMat, 0.98, 1.10, -0.75, 'jeep_glassR', { cast: false, recv: true });
      addBox(0.28, 0.28, 0.70, trimMat, -1.05, 0.62, -1.18, 'jeep_fender_fl');
      addBox(0.28, 0.28, 0.70, trimMat, 1.05, 0.62, -1.18, 'jeep_fender_fr');
      addBox(0.28, 0.28, 0.70, trimMat, -1.05, 0.62, 1.48, 'jeep_fender_rl');
      addBox(0.28, 0.28, 0.70, trimMat, 1.05, 0.62, 1.48, 'jeep_fender_rr');
      addBox(1.55, 0.06, 1.10, trimMat, 0, 1.42, -0.85, 'jeep_roofrack');
      addBox(1.20, 0.08, 0.12, accentMat, 0, 1.34, -1.55, 'jeep_lightbar', { cast: false, recv: true });
      addBox(0.18, 0.14, 0.05, headLightMat, -0.62, 0.74, -1.90, 'jeep_headL', { cast: false, recv: true });
      addBox(0.18, 0.14, 0.05, headLightMat, 0.62, 0.74, -1.90, 'jeep_headR', { cast: false, recv: true });
      addBox(0.16, 0.14, 0.05, tailLightMat, -0.78, 0.74, 2.03, 'jeep_tailL', { cast: false, recv: true });
      addBox(0.16, 0.14, 0.05, tailLightMat, 0.78, 0.74, 2.03, 'jeep_tailR', { cast: false, recv: true });
      addBox(0.12, 0.08, 0.16, trimMat, -1.10, 1.16, -1.05, 'jeep_mirrorL');
      addBox(0.12, 0.08, 0.16, trimMat, 1.10, 1.16, -1.05, 'jeep_mirrorR');
      try {
        const spare = addWheel({ px: 0.0, pz: 2.05, radius: 0.33, width: 0.20, name: 'jeep_spare' });
        spare.position.y = 1.05;
        spare.rotation.x = Math.PI * 0.5;
      } catch { /* ignore */ }
    }

    const wheelsAll = [];
    const wheelsFront = [];
    const wR = (kind === 'van') ? 0.36 : 0.37;
    const wW = (kind === 'van') ? 0.21 : 0.20;
    const axleX = (kind === 'van') ? 1.08 : 0.98;
    const zFront = (kind === 'van') ? -1.75 : -1.35;
    const zRear = (kind === 'van') ? 1.70 : 1.40;
    const whFL = addWheel({ px: -axleX, pz: zFront, radius: wR, width: wW, name: `${kind}_wheel_fl` });
    const whFR = addWheel({ px: axleX, pz: zFront, radius: wR, width: wW, name: `${kind}_wheel_fr` });
    const whRL = addWheel({ px: -axleX, pz: zRear, radius: wR, width: wW, name: `${kind}_wheel_rl` });
    const whRR = addWheel({ px: axleX, pz: zRear, radius: wR, width: wW, name: `${kind}_wheel_rr` });
    wheelsAll.push(whFL, whFR, whRL, whRR);
    wheelsFront.push(whFL, whFR);

    const seats = [
      { id: 'driver', role: 'driver', localPos: new THREE.Vector3(-0.45, 0.95, -0.55) },
      { id: 'front_pass', role: 'passenger', localPos: new THREE.Vector3(0.45, 0.95, -0.55) },
      { id: 'rear_left', role: 'passenger', localPos: new THREE.Vector3(-0.45, 0.95, 0.60) },
      { id: 'rear_right', role: 'passenger', localPos: new THREE.Vector3(0.45, 0.95, 0.60) },
    ];
    const doors = [
      { id: 'door_driver', seatId: 'driver', localPos: new THREE.Vector3(-1.15, 0.55, -0.55), label: 'Driver door' },
      { id: 'door_front_pass', seatId: 'front_pass', localPos: new THREE.Vector3(1.15, 0.55, -0.55), label: 'Front passenger door' },
      { id: 'door_rear_left', seatId: 'rear_left', localPos: new THREE.Vector3(-1.15, 0.55, 0.60), label: 'Rear left door' },
      { id: 'door_rear_right', seatId: 'rear_right', localPos: new THREE.Vector3(1.15, 0.55, 0.60), label: 'Rear right door' },
    ];

    try {
      for (const d of doors) {
        const h = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.04, 0.04), accentMat);
        h.position.copy(d.localPos.clone().setY(1.05));
        h.castShadow = false;
        h.receiveShadow = true;
        group.add(h);
      }
    } catch { /* ignore */ }

    try {
      const seatMat = new THREE.MeshStandardMaterial({ color: 0x223042, roughness: 0.9, metalness: 0.0 });
      for (const s of seats) {
        const chair = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.42, 0.40), seatMat);
        chair.position.copy(s.localPos.clone().setY(0.75));
        chair.castShadow = false;
        chair.receiveShadow = true;
        group.add(chair);
      }
      const col = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.22, 0.06), trimMat);
      col.position.set(-0.42, 1.02, -0.95);
      col.castShadow = false;
      col.receiveShadow = true;
      group.add(col);
    } catch { /* ignore */ }

    this._scene.add(group);

    const occ = new Map();
    for (const s of seats) occ.set(s.id, null);

    const simCreateOptions = {
      yaw: Number(yaw) || 0,
      wasm: {
        jsonPath: '',
        tireJsonPath: '',
        chassisJsonPath: '',
      },
    };
    let simHandle = 0;
    try {
      const sim = this._vehicleSim;
      if (sim?.ready && typeof sim.writeFile === 'function' && typeof sim.createVehicleJson === 'function') {
        const tNow = Date.now();
        const k = safeName(safeTrim(kind) || 'veh');
        const jsonPath = `/tmp/chrono_proc_${k}_${tNow}.json`;
        // Build a minimal generic wheeled vehicle spec.
        const zFront = (safeTrim(kind) === 'van') ? -1.75 : -1.35;
        const zRear = (safeTrim(kind) === 'van') ? 1.70 : 1.40;
        const wbUse = Math.max(1.4, Math.min(4.6, Math.abs(zRear - zFront)));
        const frontX = 0.5 * wbUse;
        const rearX = -0.5 * wbUse;
        const vehJson = {
          Name: 'Proc vehicle (generated)',
          Type: 'Vehicle',
          Template: 'WheeledVehicle',
          Chassis: { 'Input File': 'generic/chassis/Chassis.json' },
          Axles: [
            {
              'Suspension Input File': 'generic/suspension/DoubleWishboneCurve.json',
              'Suspension Location': [frontX, 0, -0.21],
              'Steering Index': 0,
              'Left Wheel Input File': 'generic/wheel/WheelSimple.json',
              'Right Wheel Input File': 'generic/wheel/WheelSimple.json',
              'Left Brake Input File': 'generic/brake/BrakeSimple.json',
              'Right Brake Input File': 'generic/brake/BrakeSimple.json',
            },
            {
              'Suspension Input File': 'generic/suspension/DoubleWishbone.json',
              'Suspension Location': [rearX, 0, -0.21],
              'Left Wheel Input File': 'generic/wheel/WheelSimple.json',
              'Right Wheel Input File': 'generic/wheel/WheelSimple.json',
              'Left Brake Input File': 'generic/brake/BrakeSimple.json',
              'Right Brake Input File': 'generic/brake/BrakeSimple.json',
            },
          ],
          'Steering Subsystems': [
            { 'Input File': 'generic/steering/PitmanArm.json', Location: [frontX - 0.15, 0, -0.4], Orientation: [0.98699637, 0, 0.16074256, 0] },
          ],
          Wheelbase: wbUse,
          'Maximum Steering Angle (deg)': 25.0,
          Driveline: { 'Input File': 'generic/driveline/Driveline2WD.json', 'Suspension Indexes': [1] },
        };
        const ok = sim.writeFile(jsonPath, JSON.stringify(vehJson, null, 2));
        if (ok) {
          simCreateOptions.wasm.jsonPath = jsonPath;
          simHandle = Number(sim.createVehicleJson({ jsonPath, x: group.position.x, z: group.position.z, yaw: Number(yaw) || 0 })) || 0;
          // Some Chrono JSON failures can still return a nonzero handle; treat "no state" as failure.
          if (simHandle && !sim.getState?.(simHandle)) simHandle = 0;
          // JSON vehicles are created without a powertrain by design; ensure a default so they can drive.
          if (simHandle) {
            try { this._applyAcWasmTuningToSimHandle(sim, simHandle, {}); } catch { /* ignore */ }
          }
        }
      }
    } catch { simHandle = 0; }

    if (!simHandle) {
      try { this._setStatus(`Proc vehicle spawn failed (Chrono JSON unavailable): ${safeTrim(kind) || 'vehicle'}`); } catch { /* ignore */ }
      try { if (group?.parent) group.parent.remove(group); } catch { /* ignore */ }
      try { disposeThreeObject(group); } catch { /* ignore */ }
      return null;
    }

    return {
      id: String(id || ''),
      kind: String(kind || ''),
      group,
      seats,
      doors,
      occ,
      yaw: Number(yaw) || 0,
      speed: 0,
      steer: 0,
      driveType: 'wheeled',
      radius: (kind === 'van') ? 1.35 : 1.20,
      simCreateOptions,
      simHandle,
      parts: { wheelsAll, wheelsFront, wheelRadius: wR, wheelWidth: wW, wheelRoll: 0 },
    };
  }

  // ---- Main spawn path for imported vehicles ----
  async spawnDriveableVehicleFromAssetUrl(rawUrl, { name = '', scale = 1.0, yawDeg = 0, x = NaN, z = NaN, place = 'player', vehicleConfig = null } = {}) {
    this._lastVehicleSpawnError = '';
    const fail = (msg) => {
      try { this._lastVehicleSpawnError = safeTrim(String(msg || '')) || 'Vehicle spawn failed (unknown).'; } catch { this._lastVehicleSpawnError = 'Vehicle spawn failed (unknown).'; }
      return null;
    };
    const url = normalizeAssetUrl(rawUrl);
    if (!url) return fail(`Invalid vehicle URL: ${safeTrim(rawUrl) || '(empty)'}`);
    if (!this._scene) return fail('Vehicle spawn failed: scene not initialized.');
    if (!this._vehicleSim) return fail('Vehicle spawn failed: vehicle sim not configured.');
    // Ensure Chrono WASM backend is actually ready before we attempt to create a vehicle.
    // If we spawn before `ready`, `writeFile/createVehicleJson` will fail and we'll end up
    // with vehicles missing `simHandle` (or falling back to placeholders).
    if (!this._vehicleSim?.ready) {
      try { await this.initProjectChronoWasm(); } catch { /* ignore */ }
    }
    if (!this._vehicleSim?.ready) {
      const wasmErr = safeTrim(this._chronoVehWasm?.initError || '');
      return fail(wasmErr ? `Vehicle sim unavailable: ${wasmErr}` : 'Vehicle sim unavailable: Chrono WASM not ready.');
    }

    let tpl = null;
    try { tpl = await this._getPropTemplate(url); } catch (e) { return fail(`Failed to load model template for ${url}: ${e?.message || e}`); }
    if (!tpl?.templateRoot) return fail(`Failed to load model: ${url}`);

    const inst = SkeletonUtils.clone(tpl.templateRoot);
    inst.name = safeTrim(name) || `veh_${safeName(getFileStem(url))}`;

    const sc = Math.max(0.001, Number(scale) || 1.0);
    try { inst.scale.set(sc, sc, sc); } catch { /* ignore */ }

    const group = new THREE.Group();
    group.name = `veh_asset_${safeName(getFileStem(url))}`;
    group.add(inst);

    let cfg = null;
    try { if (vehicleConfig && typeof vehicleConfig === 'object') cfg = vehicleConfig; } catch { cfg = null; }
    let cfgMeta = null;
    try {
      const m = cfg?.meta;
      if (m && typeof m === 'object') cfgMeta = m;
    } catch { /* ignore */ }
    const needMetaFetch = (() => {
      if (!cfgMeta || typeof cfgMeta !== 'object') return true;
      const a = (cfgMeta.anchors && typeof cfgMeta.anchors === 'object') ? cfgMeta.anchors : null;
      const haveAnchors = !!(a && a.driver && a.driver_enter);
      const texDir = safeTrim(cfgMeta?.acTextureDirUrl || '');
      const mats = (cfgMeta?.acMaterials && typeof cfgMeta.acMaterials === 'object') ? cfgMeta.acMaterials : null;
      const haveAcTextures = !!(texDir && mats);
      const yawOff = Number(cfgMeta?.modelYawOffsetRad);
      const haveYawOff = Number.isFinite(yawOff);
      // If the model comes from webautos/, prefer fetching its sibling meta.json to avoid
      // stale inbox payloads pointing at assets/generated/ paths that may not exist in the current host.
      const uLow = String(url || '').toLowerCase();
      const isWebautosModel = uLow.includes('/webautos/');
      if (isWebautosModel) {
        const acOk = texDir.includes('/webautos/') || safeTrim(cfgMeta?.acMaterialsUrl || '').includes('/webautos/');
        if (!acOk) return true;
      }
      return !haveAnchors || !haveAcTextures || !haveYawOff;
    })();
    if (needMetaFetch) {
      try {
        const mUrl = safeTrim(cfg?.metaUrl || '') || metaUrlForModelUrl(url);
        if (mUrl) {
          const resp = await fetch(mUrl, { cache: 'no-store' });
          if (resp.ok) {
            const j = await resp.json();
            if (j && typeof j === 'object') {
              if (cfgMeta && typeof cfgMeta === 'object') {
                const jAnchors = (j.anchors && typeof j.anchors === 'object') ? j.anchors : {};
                const cAnchors = (cfgMeta.anchors && typeof cfgMeta.anchors === 'object') ? cfgMeta.anchors : {};
                const texDir = safeTrim(cfgMeta?.acTextureDirUrl || '');
                const mats = (cfgMeta?.acMaterials && typeof cfgMeta.acMaterials === 'object') ? cfgMeta.acMaterials : null;
                const isLightweightMeta = !(texDir && mats);
                if (isLightweightMeta) {
                  cfgMeta = {
                    ...j,
                    wheelType: safeTrim(cfgMeta?.wheelType || '') || safeTrim(j?.wheelType || ''),
                    wheelScale: Number.isFinite(Number(cfgMeta?.wheelScale)) ? Number(cfgMeta?.wheelScale) : Number(j?.wheelScale),
                    wheelScaleRear: Number.isFinite(Number(cfgMeta?.wheelScaleRear)) ? Number(cfgMeta?.wheelScaleRear) : Number(j?.wheelScaleRear),
                    anchors: jAnchors,
                  };
                } else {
                  cfgMeta = { ...j, ...cfgMeta, anchors: { ...jAnchors, ...cAnchors } };
                  // When spawning a webautos/ model, prefer the fetched published meta's AC bindings.
                  // This avoids stale inbox configs that carry old absolute paths.
                  try {
                    const uLow = String(url || '').toLowerCase();
                    if (uLow.includes('/webautos/')) {
                      for (const k of ['acTextureDirUrl', 'acMaterialsUrl', 'acMaterials', 'acBundleUrl', 'chronoManifestUrl', 'acAudioDirUrl', 'acAudioIniUrl']) {
                        if (k in j) cfgMeta[k] = j[k];
                      }
                    }
                  } catch { /* ignore */ }
                }
              } else {
                cfgMeta = j;
              }
            }
          }
        }
      } catch { /* ignore */ }
    }
    try { await this._applyAcTexturesToRoot(inst, cfgMeta); } catch { /* ignore */ }

    // Collect common AC visual parts (lights, rim blur meshes, glass, etc).
    const fx = {
      brakeLightMats: [],
      headLightMats: [],
      tailLightMats: [],
      reverseLightMats: [],
      indicatorLeftMats: [],
      indicatorRightMats: [],
      glassMats: [],
      rimBlurMeshes: [],
      steerMeshes: [],
      lightsOn: false,
      indicatorMode: 'off', // off | left | right | hazard
      blinkT: 0,
    };
    try {
      const brakeMats = new Set();
      const headMats = new Set();
      const tailMats = new Set();
      const revMats = new Set();
      const indLMats = new Set();
      const indRMats = new Set();
      const glassMats = new Set();
      const steerMeshes = new Set();
      inst.traverse?.((n) => {
        const any = /** @type {any} */ (n);
        if (!any || !any.isMesh) return;
        const nm = safeTrim(any.name || '').toLowerCase();
        if (nm) {
          // Assetto exports commonly include wheel blur meshes (e.g. RIM_BLUR_LF). We keep them off by default.
          if (nm.includes('rim_blur') || (nm.includes('blur') && nm.includes('rim'))) {
            fx.rimBlurMeshes.push(any);
            any.visible = false;
          }
          // Brake light meshes are often named Brakelights / Brakelight_*.
          if (nm.includes('brakelight') || (nm.includes('brake') && nm.includes('light'))) {
            const matsArr = Array.isArray(any.material) ? any.material : (any.material ? [any.material] : []);
            for (const m of matsArr) if (m) brakeMats.add(m);
          }

          // Glass meshes: make them transparent-ish.
          if (nm.includes('glass') || nm.includes('window') || nm.includes('windscreen') || nm.includes('windshield')) {
            const matsArr = Array.isArray(any.material) ? any.material : (any.material ? [any.material] : []);
            for (const m of matsArr) if (m) glassMats.add(m);
          }

          // Head/tail/reverse/indicator lights (best-effort naming heuristics).
          const matsArr = Array.isArray(any.material) ? any.material : (any.material ? [any.material] : []);
          const addMats = (set) => { for (const m of matsArr) if (m) set.add(m); };
          if (nm.includes('headlight') || nm.includes('head_light') || (nm.includes('head') && nm.includes('light'))) addMats(headMats);
          if (nm.includes('taillight') || nm.includes('tail_light') || (nm.includes('tail') && nm.includes('light'))) addMats(tailMats);
          if (nm.includes('reverselight') || nm.includes('reverse_light') || (nm.includes('reverse') && nm.includes('light'))) addMats(revMats);
          if (nm.includes('indicator') || nm.includes('turnsignal') || nm.includes('turn_signal') || nm.includes('blink')) {
            if (nm.includes('_l') || nm.endsWith('l') || nm.includes('left') || nm.includes('lf') || nm.includes('lr')) addMats(indLMats);
            else if (nm.includes('_r') || nm.endsWith('r') || nm.includes('right') || nm.includes('rf') || nm.includes('rr')) addMats(indRMats);
          }

          // Steering wheel: many AC cars use STEER_* naming. Exclude wheel hubs.
          if (nm.includes('steer') && !nm.includes('hub')) steerMeshes.add(any);
        }
      });
      fx.brakeLightMats = Array.from(brakeMats);
      fx.headLightMats = Array.from(headMats);
      fx.tailLightMats = Array.from(tailMats);
      fx.reverseLightMats = Array.from(revMats);
      fx.indicatorLeftMats = Array.from(indLMats);
      fx.indicatorRightMats = Array.from(indRMats);
      fx.glassMats = Array.from(glassMats);
      // Steering wheel: many AC exports bake transforms into vertex positions, leaving the mesh
      // transform at identity. Rotating such a mesh would spin it around the vehicle origin.
      // Fix by creating a pivot at the mesh's bounding-box center and rotating the pivot.
      fx.steerMeshes = (() => {
        const out = [];
        const src = Array.from(steerMeshes);
        if (!src.length) return out;

        const centers = new Map(); // mesh.uuid -> Vector3
        const axes = new Map();    // mesh.uuid -> Vector3
        for (const mesh of src) {
          const axis = new THREE.Vector3(0, 0, 1);
          const center = new THREE.Vector3(0, 0, 0);
          try {
            const g = mesh?.geometry || null;
            if (g) {
              try { if (!g.boundingBox && typeof g.computeBoundingBox === 'function') g.computeBoundingBox(); } catch { /* ignore */ }
              const bb = g.boundingBox || null;
              if (bb) {
                bb.getCenter(center);
                const dx = Math.abs(Number(bb.max.x) - Number(bb.min.x));
                const dy = Math.abs(Number(bb.max.y) - Number(bb.min.y));
                const dz = Math.abs(Number(bb.max.z) - Number(bb.min.z));
                // Steering wheels are usually "thin" along their spin axis; pick smallest extent.
                const min = Math.min(dx || Infinity, dy || Infinity, dz || Infinity);
                if (Number.isFinite(min)) {
                  if (min === dx) axis.set(1, 0, 0);
                  else if (min === dy) axis.set(0, 1, 0);
                  else axis.set(0, 0, 1);
                }
              }
            }
          } catch { /* ignore */ }
          centers.set(mesh.uuid, center);
          axes.set(mesh.uuid, axis);
        }

        /** @type {{ pivot: any, pos: THREE.Vector3, axis: THREE.Vector3, baseQuat: THREE.Quaternion }[]} */
        const pivots = [];
        const EPS = 0.12; // group steering parts into one wheel when centers are near

        for (const mesh of src) {
          const parent = mesh?.parent || null;
          if (!parent) continue;
          const c = centers.get(mesh.uuid) || new THREE.Vector3();
          const axis = axes.get(mesh.uuid) || new THREE.Vector3(0, 0, 1);

          let bucket = pivots.find((p) => p && p.pos && p.pos.distanceTo(c) < EPS) || null;
          if (!bucket) {
            const pivot = new THREE.Object3D();
            pivot.name = `__steer_pivot_${safeTrim(mesh?.name || '') || mesh.uuid}`;
            pivot.position.copy(c);
            try { parent.add(pivot); } catch { /* ignore */ }
            try { pivot.updateMatrixWorld(true); } catch { /* ignore */ }
            bucket = { pivot, pos: c.clone(), axis: axis.clone(), baseQuat: pivot.quaternion.clone() };
            pivots.push(bucket);
            out.push(bucket);
          }

          // Preserve world transform when reparenting under the pivot.
          try { bucket.pivot.attach(mesh); } catch { try { bucket.pivot.add(mesh); } catch { /* ignore */ } }
        }

        return out;
      })();

      // Initialize brake light materials for emissive control.
      const initEmissive = (m, colorHex) => {
        if (!m || !('emissive' in m)) return;
        try {
          try { m.emissive = new THREE.Color(colorHex); } catch { /* ignore */ }
          try { m.emissiveIntensity = 0.0; } catch { /* ignore */ }
          try { m.toneMapped = false; } catch { /* ignore */ }
          try { m.needsUpdate = true; } catch { /* ignore */ }
        } catch { /* ignore */ }
      };
      for (const m of fx.brakeLightMats) initEmissive(m, 0xff2a2a);
      for (const m of fx.headLightMats) initEmissive(m, 0xcfe8ff);
      for (const m of fx.tailLightMats) initEmissive(m, 0xff2a2a);
      for (const m of fx.reverseLightMats) initEmissive(m, 0xeaf6ff);
      for (const m of fx.indicatorLeftMats) initEmissive(m, 0xffb200);
      for (const m of fx.indicatorRightMats) initEmissive(m, 0xffb200);

      for (const m of fx.glassMats) {
        try {
          if (!m) continue;
          try { m.transparent = true; } catch { /* ignore */ }
          try {
            const o = Number(m.opacity);
            if (Number.isFinite(o)) m.opacity = Math.min(0.55, Math.max(0.15, o));
            else m.opacity = 0.35;
          } catch { /* ignore */ }
          try { m.roughness = Math.min(0.25, Math.max(0.02, Number(m.roughness) || 0.12)); } catch { /* ignore */ }
          try { m.metalness = Math.min(0.05, Math.max(0.0, Number(m.metalness) || 0.0)); } catch { /* ignore */ }
          try { m.depthWrite = false; } catch { /* ignore */ }
          try { if ('side' in m) m.side = THREE.DoubleSide; } catch { /* ignore */ }
          try { m.needsUpdate = true; } catch { /* ignore */ }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    // Compute bounds to derive seats/doors defaults.
    let halfX = 1.0;
    let halfZ = 1.6;
    let assetSizeX = 2.0;
    let assetSizeZ = 3.2;
    let frontZ = -halfZ;
    let rearZ = halfZ;
    let modelYawOffset = 0;
    let wheelbaseEst = Math.max(1.4, Math.min(3.8, Math.abs(rearZ - frontZ)));
    try {
      group.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(group);
      const sx = Math.max(0.1, Number(bb.max.x) - Number(bb.min.x));
      const sz = Math.max(0.1, Number(bb.max.z) - Number(bb.min.z));
      halfX = sx * 0.5;
      halfZ = sz * 0.5;
      assetSizeX = sx;
      assetSizeZ = sz;
      frontZ = Number(bb.min.z);
      rearZ = Number(bb.max.z);
    } catch { /* ignore */ }

    const wantX = Number(x);
    const wantZ = Number(z);
    const px = Number.isFinite(wantX)
      ? wantX
      : ((place === 'spawn') ? (Number(this.host?._spawn?.x) || 0) : (Number(this._player?.x) || 0));
    const pz = Number.isFinite(wantZ)
      ? wantZ
      : ((place === 'spawn') ? (Number(this.host?._spawn?.z) || 0) : (Number(this._player?.z) || 0));
    group.position.set(px, 0, pz);
    group.rotation.y = degToRad(Number(yawDeg) || 0);
    this._scene.add(group);

    try {
      group.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(group);
      const bottom = Number(box.min.y) || 0;
      let gy = this._findGroundY(px, (Number(this._player?.y) || 0) + 2.0, pz);
      // Long-range fallback for large imported tracks (e.g., AC) where the player's Y can start far off.
      try {
        if (gy == null && this.host?._raycastGroundYAt) {
          const originY = Math.max(500, (Number(this._player?.y) || 0) + 25);
          gy = this.host._raycastGroundYAt(px, pz, { originY, far: 6000 });
        }
      } catch { /* ignore */ }
      const spawnY = Number(this.host?._spawn?.y);
      const groundY = (gy == null)
        ? (Number.isFinite(spawnY) ? spawnY : 0)
        : (Number(gy) || 0);
      group.position.y += (groundY - bottom);
      group.updateMatrixWorld(true);
    } catch { /* ignore */ }

    const anchors = (cfgMeta?.anchors && typeof cfgMeta.anchors === 'object') ? cfgMeta.anchors : null;
    const anchorUnitScale = (() => {
      try {
        const a = anchors;
        if (!a) return 1.0;
        const pts = Object.values(a)
          .map((v) => (Array.isArray(v?.pos) ? v.pos : null))
          .filter((p) => Array.isArray(p) && p.length >= 3)
          .map((p) => ({ x: Number(p[0]) || 0, z: Number(p[2]) || 0 }));
        if (pts.length < 2) return 1.0;
        const xs = pts.map((p) => p.x);
        const zs = pts.map((p) => p.z);
        const spanX = Math.max(1e-6, (Math.max(...xs) - Math.min(...xs)));
        const spanZ = Math.max(1e-6, (Math.max(...zs) - Math.min(...zs)));
        const sx = Math.max(1e-3, Number(assetSizeX) || 0);
        const sz = Math.max(1e-3, Number(assetSizeZ) || 0);
        const ratioX = spanX / sx;
        const ratioZ = spanZ / sz;
        const mismatch = (ratioX > 4.0 || ratioZ > 4.0 || ratioX < 0.25 || ratioZ < 0.25);
        if (!mismatch) return 1.0;
        const kx = sx / spanX;
        const kz = sz / spanZ;
        const k = Math.sqrt(Math.max(1e-6, kx * kz));
        return clamp(Number(k) || 1.0, 0.01, 100.0);
      } catch {
        return 1.0;
      }
    })();

    try {
      const k = ['wheel_lf', 'wheel_rf', 'wheel_lr', 'wheel_rr'];
      const wp = k.map((kk) => anchors?.[kk]?.pos).filter((p) => Array.isArray(p) && p.length >= 3);
      if (wp.length >= 4) {
        const xs = wp.map((p) => (Number(p[0]) || 0) * anchorUnitScale);
        const zs = wp.map((p) => (Number(p[2]) || 0) * anchorUnitScale);
        const aHalfX = Math.max(...xs.map((v) => Math.abs(v))) + 0.22;
        const aFrontZ = Math.min(...zs);
        const aRearZ = Math.max(...zs);
        const aHalfZ = Math.max(Math.abs(aFrontZ), Math.abs(aRearZ));
        if (aHalfX <= Math.max(halfX * 2.0, halfX + 0.6)) halfX = Math.max(halfX, aHalfX);
        if (aHalfZ <= Math.max(halfZ * 2.0, halfZ + 0.8)) {
          frontZ = aFrontZ;
          rearZ = aRearZ;
          halfZ = Math.max(halfZ, aHalfZ);
        }
      }
    } catch { /* ignore */ }

    try {
      const wheelPos = (a) => {
        const p = Array.isArray(a?.pos) ? a.pos : null;
        if (!p || p.length < 3) return null;
        return { x: (Number(p[0]) || 0) * anchorUnitScale, z: (Number(p[2]) || 0) * anchorUnitScale };
      };
      const lf = wheelPos(anchors?.wheel_lf);
      const rf = wheelPos(anchors?.wheel_rf);
      const lr = wheelPos(anchors?.wheel_lr);
      const rr = wheelPos(anchors?.wheel_rr);
      if (lf && rf && lr && rr) {
        const fcx = (lf.x + rf.x) * 0.5;
        const fcz = (lf.z + rf.z) * 0.5;
        const rcx = (lr.x + rr.x) * 0.5;
        const rcz = (lr.z + rr.z) * 0.5;
        const hx = fcx - rcx;
        const hz = fcz - rcz;
        const hlen = Math.hypot(hx, hz);
        if (hlen > 1e-6) {
          const heading = Math.atan2(hx, hz);
          const off = Math.PI - heading;
          modelYawOffset = Math.atan2(Math.sin(off), Math.cos(off));
          wheelbaseEst = Math.max(1.4, Math.min(3.8, hlen));
        }
      }
    } catch { /* ignore */ }

    try {
      const cfgOff = Number(cfg?.modelYawOffsetRad);
      const metaOff = Number(cfgMeta?.modelYawOffsetRad);
      if (Number.isFinite(cfgOff)) modelYawOffset = cfgOff;
      else if (Number.isFinite(metaOff)) modelYawOffset = metaOff;
    } catch { /* ignore */ }

    const seatY = clamp(Number(cfg?.seatHeight) || 0.9, 0.35, 2.2);
    const seatZ = lerp(frontZ, rearZ, 0.32);
    const seatX = Math.min(0.75, halfX * 0.36);
    const doorY = clamp(Number(cfg?.doorHeight) || 0.55, 0.25, 1.8);
    const doorZ = lerp(frontZ, rearZ, 0.24);
    const doorX = halfX + 0.25;

    const anchorPos = (a) => {
      const p = Array.isArray(a?.pos) ? a.pos : null;
      if (!p || p.length < 3) return null;
      const x = (Number(p[0]) || 0) * anchorUnitScale;
      const y = (Number(p[1]) || 0) * anchorUnitScale;
      const z = (Number(p[2]) || 0) * anchorUnitScale;
      return new THREE.Vector3(x, y, z);
    };
    const anchorLooksReasonable = (v3) => {
      if (!v3) return false;
      const maxX = Math.max(1.5, Math.abs(halfX) * 2.5);
      const maxZ = Math.max(2.0, Math.abs(halfZ) * 2.5);
      return Math.abs(v3.x) <= maxX && Math.abs(v3.z) <= maxZ;
    };
    const driverAnchorRaw = anchorPos(anchors?.driver);
    const driverEnterAnchorRaw = anchorPos(anchors?.driver_enter);
    const cameraDriverAnchorRaw = anchorPos(anchors?.camera_driver);
    const driverAnchor = anchorLooksReasonable(driverAnchorRaw) ? driverAnchorRaw : null;
    const driverEnterAnchor = anchorLooksReasonable(driverEnterAnchorRaw) ? driverEnterAnchorRaw : null;
    const cameraDriverAnchor = anchorLooksReasonable(cameraDriverAnchorRaw) ? cameraDriverAnchorRaw : null;

    const driverSeat = driverAnchor
      ? new THREE.Vector3(driverAnchor.x, clamp(driverAnchor.y, 0.35, 2.2), driverAnchor.z)
      : new THREE.Vector3(-seatX, seatY, seatZ);
    const passSeatX = Math.max(Math.abs(driverSeat.x), seatX);
    const driverSeatSide = Math.sign(driverSeat.x) || -1;
    const passSeat = new THREE.Vector3(-driverSeatSide * passSeatX, driverSeat.y, driverSeat.z);
    const driverDoor = driverEnterAnchor
      ? new THREE.Vector3(driverEnterAnchor.x, clamp(driverEnterAnchor.y, 0.25, 1.8), driverEnterAnchor.z)
      : new THREE.Vector3(-doorX, doorY, doorZ);
    const driverDoorSide = Math.sign(driverDoor.x) || -1;
    const passDoor = new THREE.Vector3(-driverDoorSide * Math.abs(driverDoor.x), driverDoor.y, driverDoor.z);

    const seats = [
      { id: 'driver', role: 'driver', localPos: driverSeat },
      { id: 'front_pass', role: 'passenger', localPos: passSeat },
    ];
    const doors = [
      { id: 'door_driver', seatId: 'driver', localPos: driverDoor, label: 'Driver door' },
      { id: 'door_front_pass', seatId: 'front_pass', localPos: passDoor, label: 'Passenger door' },
    ];
    const occ = new Map();
    for (const s of seats) occ.set(s.id, null);

    const wheelType = safeTrim(cfgMeta?.wheelType || cfg?.wheelType || '').toLowerCase();
    const driveType = wheelType.includes('hover') ? 'hover' : 'wheeled';
    const simYaw0 = (Number(group.rotation.y) || 0) - (Number(modelYawOffset) || 0);

    let acTuning = null;
    let acBundleUrl = '';
    let chronoManifestUrl = '';
    try {
      acBundleUrl = safeTrim(cfg?.acBundleUrl || cfg?.acPhysicsBundleUrl || cfgMeta?.acBundleUrl || cfgMeta?.acPhysicsBundleUrl || '');
      chronoManifestUrl = safeTrim(cfg?.chronoManifestUrl || cfg?.chronoPhysicsManifestUrl || cfgMeta?.chronoManifestUrl || cfgMeta?.chronoPhysicsManifestUrl || '');
      if (!chronoManifestUrl && acBundleUrl) chronoManifestUrl = this._acBundleToChronoManifestUrl(acBundleUrl);
      if (acBundleUrl) acTuning = await this._getAcPhysicsTuningFromBundleUrl(acBundleUrl);
    } catch { /* ignore */ }

    const baseJsSimOpts = (() => {
      const wheelbase = Number(wheelbaseEst) || Math.max(1.4, Math.min(3.8, Math.abs(rearZ - frontZ)));
      const radiusEst = Math.max(0.8, Math.max(halfX, halfZ) * 0.85);
      const isHover = safeTrim(driveType) === 'hover';
      return {
        radius: radiusEst,
        wheelbase,
        // Defaults tuned to avoid "insane" high-speed steering with keyboard inputs.
        maxSteerRad: isHover ? 0.56 : 0.42,
        steerSpeedRef: isHover ? 18.0 : 10.0,
        steerMinFactor: isHover ? 0.55 : 0.18,
        mass: isHover ? 1200 : 1450,
        iz: isHover ? 1800 : 3200,
        mu: isHover ? 1.08 : 1.02,
        // Longitudinal grip scale (lets power break traction without making cornering icey).
        muLongMul: isHover ? 1.0 : 0.92,
        engineForceMax: isHover ? 12800 : 9800,
        engineBrakeForce: isHover ? 850 : 1200,
        brakeForceMax: isHover ? 9800 : 12500,
        rollingResist: isHover ? 11.0 : 21.0,
        aeroDrag: isHover ? 22.0 : 36.0,
        cornerStiffFront: isHover ? 76000 : 88000,
        cornerStiffRear: isHover ? 88000 : 105000,
        yawRateMax: isHover ? 3.4 : 2.2,
        steerRate: isHover ? 9.0 : 7.2,
        speedMax: isHover ? 25.0 : 18.0,
      };
    })();
    const jsSimOpts = (() => {
      const out = { ...baseJsSimOpts };
      const applyTune = (tuneObj) => {
        const t = (tuneObj && typeof tuneObj === 'object') ? tuneObj : null;
        if (!t) return;
        for (const [k0, v] of Object.entries(t)) {
          const k = String(k0 || '');
          if (!k) continue;
          // Preserve drivetrain arrays/flags; numeric-only copy would drop them.
          if (k === 'gearRatios') {
            if (Array.isArray(v) && v.length) {
              const gears = v
                .map((x) => Number(x))
                .filter((x) => Number.isFinite(x) && x > 0)
                .slice(0, 16);
              if (gears.length) out.gearRatios = gears;
            }
            continue;
          }
          if (k === 'torqueCurveRpms' || k === 'torqueCurveNm') {
            if (Array.isArray(v) && v.length >= 2) {
              const arr = v
                .map((x) => Number(x))
                .filter((x) => Number.isFinite(x))
                .slice(0, 512);
              if (arr.length >= 2) out[k] = arr;
            }
            continue;
          }
          if (typeof v === 'boolean') {
            out[k] = v;
            continue;
          }
          const n = Number(v);
          if (Number.isFinite(n)) out[k] = n;
        }
      };
      try {
        const tuneAc = (acTuning?.simTuning && typeof acTuning.simTuning === 'object') ? acTuning.simTuning : null;
        applyTune(tuneAc);
      } catch { /* ignore */ }
      const tune = (cfg?.simTuning && typeof cfg.simTuning === 'object') ? cfg.simTuning : null;
      if (!tune) return out;
      const keys = [
        'radius', 'wheelbase', 'cgToFront', 'maxSteerRad', 'mass', 'iz', 'mu', 'muLongMul',
        'engineForceMax', 'engineBrakeForce', 'brakeForceMax',
        'rollingResist', 'aeroDrag', 'cornerStiffFront', 'cornerStiffRear',
        // drivetrain/engine (optional): used for Chrono JSON powertrain tuning and audio estimation
        'wheelRadius', 'finalRatio', 'reverseGear', 'maxTorqueNm', 'maxPowerW', 'limiterRpm', 'idleRpm', 'drivetrainEff', 'coastTorqueNm',
        'relaxLenFront', 'relaxLenRear',
        'driveBias', 'brakeBiasFront',
        'yawRateMax', 'steerRate', 'speedMax',
      ];
      for (const k of keys) {
        const n = Number(tune?.[k]);
        if (Number.isFinite(n)) out[k] = n;
      }
      // Allow config to override/define gears too.
      try { applyTune({ gearRatios: tune?.gearRatios }); } catch { /* ignore */ }
      return out;
    })();

    let manifestSpawn = null;
    try {
      manifestSpawn = await this._spawnWasmVehicleFromChronoManifest(this._vehicleSim, {
        manifestUrl: chronoManifestUrl,
        x: Number(group.position.x) || 0,
        z: Number(group.position.z) || 0,
        yaw: Number(simYaw0) || 0,
      });
      if (manifestSpawn?.vehiclePath) {
        try { jsSimOpts._wasmJsonPath = manifestSpawn.vehiclePath; } catch { /* ignore */ }
      }
      if (manifestSpawn?.tirePath) {
        try { jsSimOpts._wasmTireJsonPath = manifestSpawn.tirePath; } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    const simHandle = (() => {
      const sim = this._vehicleSim;
      if (!sim) return 0;
      const x0 = Number(group.position.x) || 0;
      const z0 = Number(group.position.z) || 0;
      const yaw0 = Number(simYaw0) || 0;
      try {
        if (manifestSpawn?.handle) return Number(manifestSpawn.handle) || 0;
        // Prefer a JSON-defined generic vehicle when AC tuning is present (better geometry parity than Sedan/HMMWV).
        try {
          const wt = (acTuning?.wasmTuning && typeof acTuning.wasmTuning === 'object') ? acTuning.wasmTuning : null;
          const wb = Number(acTuning?.simTuning?.wheelbase);
          const wbUse = (Number.isFinite(wb) && wb > 0.6) ? wb : NaN;
          const maxSteerRad = Number(wt?.maxSteerRad);
          if (wt && Number.isFinite(wbUse) && wbUse > 1.0 && typeof sim.writeFile === 'function' && typeof sim.createVehicleJson === 'function') {
            const driveBias = Number(acTuning?.simTuning?.driveBias);
            const db = Number.isFinite(driveBias) ? clamp(driveBias, 0, 1) : NaN;
            const maxSteerDeg = (Number.isFinite(maxSteerRad) && maxSteerRad > 0) ? (maxSteerRad * (180 / Math.PI)) : 25.0;
            const frontX = 0.5 * wbUse;
            const rearX = -0.5 * wbUse;
            const driveKind = (Number.isFinite(db) ? (db > 0.66 ? 'fwd' : (db < 0.34 ? 'rwd' : 'awd')) : 'rwd');
            const driveline = (driveKind === 'awd')
              ? { 'Input File': 'generic/driveline/Driveline4WD.json', 'Suspension Indexes': [0, 1] }
              : { 'Input File': 'generic/driveline/Driveline2WD.json', 'Suspension Indexes': [(driveKind === 'fwd') ? 0 : 1] };

            // Optional chassis override: set centroid height from AC `suspensions.ini BASEY` heuristic.
            // NOTE: nested "Input File" paths in Chrono vehicle JSON are resolved relative to
            // vehicle data root (/data/vehicle), so generated subsystem files should live there
            // and be referenced with a data-root-relative path (not /tmp absolute paths).
            const cgHeight = Number(acTuning?.simTuning?.cgHeight);
            const stem = safeName(getFileStem(url));
            const tNow = Date.now();
            const dataTmpDir = '/data/vehicle/tmp';
            const dataTmpRefPrefix = 'tmp';
            let chassisPath = '';
            let chassisRefPath = '';
            try {
              if (Number.isFinite(cgHeight) && cgHeight > 0.2 && cgHeight < 1.2) {
                const chassisJson = {
                  Name: 'AC chassis (generated)',
                  Type: 'Chassis',
                  Template: 'RigidChassis',
                  Components: [
                    {
                      'Centroidal Frame': { Location: [0.056, 0, clamp(cgHeight, 0.25, 0.95)], Orientation: [1, 0, 0, 0] },
                      Mass: 1500,
                      'Moments of Inertia': [1200, 2500, 3200],
                      'Products of Inertia': [0, 0, 0],
                      Void: false,
                    },
                  ],
                  'Driver Position': { Location: [0, 0.5, 1.2], Orientation: [1, 0, 0, 0] },
                };
                chassisPath = `${dataTmpDir}/chrono_ac_${stem}_${tNow}_chassis.json`;
                chassisRefPath = `${dataTmpRefPrefix}/chrono_ac_${stem}_${tNow}_chassis.json`;
                const okCh = sim.writeFile(chassisPath, JSON.stringify(chassisJson, null, 2));
                if (!okCh) {
                  chassisPath = '';
                  chassisRefPath = '';
                }
              }
            } catch {
              chassisPath = '';
              chassisRefPath = '';
            }
            const vehJson = {
              Name: 'AC vehicle (generic JSON)',
              Type: 'Vehicle',
              Template: 'WheeledVehicle',
              Chassis: { 'Input File': chassisRefPath || 'generic/chassis/Chassis.json' },
              Axles: [
                {
                  'Suspension Input File': 'generic/suspension/DoubleWishboneCurve.json',
                  'Suspension Location': [frontX, 0, -0.21],
                  'Steering Index': 0,
                  'Left Wheel Input File': 'generic/wheel/WheelSimple.json',
                  'Right Wheel Input File': 'generic/wheel/WheelSimple.json',
                  'Left Brake Input File': 'generic/brake/BrakeSimple.json',
                  'Right Brake Input File': 'generic/brake/BrakeSimple.json',
                },
                {
                  'Suspension Input File': 'generic/suspension/DoubleWishbone.json',
                  'Suspension Location': [rearX, 0, -0.21],
                  'Left Wheel Input File': 'generic/wheel/WheelSimple.json',
                  'Right Wheel Input File': 'generic/wheel/WheelSimple.json',
                  'Left Brake Input File': 'generic/brake/BrakeSimple.json',
                  'Right Brake Input File': 'generic/brake/BrakeSimple.json',
                },
              ],
              'Steering Subsystems': [
                { 'Input File': 'generic/steering/PitmanArm.json', Location: [frontX - 0.15, 0, -0.4], Orientation: [0.98699637, 0, 0.16074256, 0] },
              ],
              Wheelbase: wbUse,
              // Keep this conservative: too-high max steer makes the car feel like it pivots unrealistically.
              'Maximum Steering Angle (deg)': clamp(maxSteerDeg, 8, 35),
              Driveline: driveline,
            };
            const jsonPath = `/tmp/chrono_ac_${stem}_${tNow}.json`;

            // Suspension + ARB tuning: generate per-car JSON subsystems when we have AC values.
            try {
              const tune = (acTuning?.simTuning && typeof acTuning.simTuning === 'object') ? acTuning.simTuning : null;
              const trackF = Number(tune?.trackFront);
              const trackR = Number(tune?.trackRear);
              const kF = Number(tune?.springRateFront);
              const kR = Number(tune?.springRateRear);
              const cF = Number(tune?.damperFront);
              const cR = Number(tune?.damperRear);
              const camF = Number(tune?.staticCamberFrontDeg);
              const camR = Number(tune?.staticCamberRearDeg);
              const arbF = Number(tune?.arbFront);
              const arbR = Number(tune?.arbRear);

              const mkDoubleWishbone = ({ track, springRate, damper, camberDeg }) => {
                const half = (Number.isFinite(track) && track > 0.5) ? (0.5 * track) : NaN;
                const baseHalf = 1.10; // from generic template Spindle.COM y
                const yScale = (Number.isFinite(half) && half > 0.2) ? clamp(half / baseHalf, 0.35, 1.35) : 1.0;
                const scaleLoc = (v) => (Array.isArray(v) && v.length >= 3)
                  ? [Number(v[0]) || 0, (Number(v[1]) || 0) * yScale, Number(v[2]) || 0]
                  : v;
                const scaleObj = (o) => {
                  if (!o || typeof o !== 'object') return;
                  for (const [kk, vv] of Object.entries(o)) {
                    const k = String(kk || '').toLowerCase();
                    if (k === 'com' || k.includes('location')) {
                      if (Array.isArray(vv) && vv.length >= 3) o[kk] = scaleLoc(vv);
                    } else if (vv && typeof vv === 'object') {
                      scaleObj(vv);
                    }
                  }
                };
                const out = {
                  Name: 'AC DoubleWishbone (generated)',
                  Type: 'Suspension',
                  Template: 'DoubleWishbone',
                  'Camber Angle (deg)': Number.isFinite(camberDeg) ? clamp(camberDeg, -8, 8) : 0,
                  'Toe Angle (deg)': 0,
                  Spindle: { Mass: 14.705, COM: [-0.040, 1.100, -0.026], Inertia: [0.04117, 0.07352, 0.04117], Radius: 0.10, Width: 0.06 },
                  Upright: { Mass: 19.450, COM: [-0.040, 0.880, -0.026], 'Moments of Inertia': [0.1656, 0.1934, 0.04367], 'Products of Inertia': [0, 0, 0], Radius: 0.04 },
                  'Upper Control Arm': {
                    Mass: 5.813, COM: [-0.196, 0.645, 0.245], 'Moments of Inertia': [0.03, 0.03, 0.06276], 'Products of Inertia': [0, 0, 0], Radius: 0.02,
                    'Location Chassis Front': [0.160, 0.539, 0.243], 'Location Chassis Back': [-0.339, 0.587, 0.249], 'Location Upright': [-0.088, 0.808, 0.243],
                  },
                  'Lower Control Arm': {
                    Mass: 23.965, COM: [-0.040, 0.639, -0.224], 'Moments of Inertia': [0.4, 0.4, 0.8938], 'Products of Inertia': [0, 0, 0], Radius: 0.03,
                    'Location Chassis Front': [0.199, 0.479, -0.206], 'Location Chassis Back': [-0.279, 0.539, -0.200], 'Location Upright': [-0.040, 0.898, -0.265],
                  },
                  Tierod: { 'Location Chassis': [-0.279, 0.479, -0.026], 'Location Upright': [-0.220, 0.898, -0.026] },
                  Spring: {
                    'Location Chassis': [-0.064, 0.659, 0.094],
                    'Location Arm': [-0.040, 0.718, -0.206],
                    // AC spring_rate is wheel-rate-ish; scale to match Chrono generic order-of-magnitude.
                    'Spring Coefficient': (Number.isFinite(springRate) && springRate > 1000) ? clamp(springRate * 10.0, 20_000, 800_000) : 369149.0,
                    'Free Length': 0.339,
                  },
                  Shock: {
                    'Location Chassis': [-0.088, 0.599, 0.393],
                    'Location Arm': [-0.040, 0.718, -0.206],
                    'Damping Coefficient': (Number.isFinite(damper) && damper > 10) ? clamp(damper * 2.5, 200, 80_000) : 22459.0,
                  },
                  Axle: { Inertia: 0.4 },
                };
                scaleObj(out);
                return out;
              };

              const suspF = mkDoubleWishbone({ track: trackF, springRate: kF, damper: cF, camberDeg: camF });
              const suspR = mkDoubleWishbone({ track: trackR, springRate: kR, damper: cR, camberDeg: camR });
              const suspFrontPath = `${dataTmpDir}/chrono_ac_${stem}_${tNow}_susp_front.json`;
              const suspRearPath = `${dataTmpDir}/chrono_ac_${stem}_${tNow}_susp_rear.json`;
              const suspFrontRef = `${dataTmpRefPrefix}/chrono_ac_${stem}_${tNow}_susp_front.json`;
              const suspRearRef = `${dataTmpRefPrefix}/chrono_ac_${stem}_${tNow}_susp_rear.json`;
              const okSF = sim.writeFile(suspFrontPath, JSON.stringify(suspF, null, 2));
              const okSR = sim.writeFile(suspRearPath, JSON.stringify(suspR, null, 2));
              if (okSF) vehJson.Axles[0]['Suspension Input File'] = suspFrontRef;
              if (okSR) vehJson.Axles[1]['Suspension Input File'] = suspRearRef;

              // Antiroll bars (if AC provides ARB stiffness).
              const mkArb = (k) => ({
                Name: 'AC Antirollbar (generated)',
                Type: 'Antirollbar',
                Template: 'AntirollBarRSD',
                Arm: { Mass: 1.0, Inertia: [1, 1, 1], Length: 0.70, Width: 0.4, Radius: 0.02 },
                Droplink: { Height: -0.04 },
                RSD: { 'Spring Coefficient': clamp(k, 0, 200_000), 'Damping Coefficient': 200 },
              });
              const arbXOff = 0.5914; // from generic Vehicle_DoubleWishbones_ARB.json
              const arbZ = -0.2364;
              if (Number.isFinite(arbF) && arbF > 0) {
                const p = `${dataTmpDir}/chrono_ac_${stem}_${tNow}_arb_front.json`;
                const pRef = `${dataTmpRefPrefix}/chrono_ac_${stem}_${tNow}_arb_front.json`;
                const ok = sim.writeFile(p, JSON.stringify(mkArb(arbF), null, 2));
                if (ok) {
                  vehJson.Axles[0]['Antirollbar Input File'] = pRef;
                  vehJson.Axles[0]['Antirollbar Location'] = [frontX - arbXOff, 0, arbZ];
                }
              }
              if (Number.isFinite(arbR) && arbR > 0) {
                const p = `${dataTmpDir}/chrono_ac_${stem}_${tNow}_arb_rear.json`;
                const pRef = `${dataTmpRefPrefix}/chrono_ac_${stem}_${tNow}_arb_rear.json`;
                const ok = sim.writeFile(p, JSON.stringify(mkArb(arbR), null, 2));
                if (ok) {
                  vehJson.Axles[1]['Antirollbar Input File'] = pRef;
                  vehJson.Axles[1]['Antirollbar Location'] = [rearX + arbXOff, 0, arbZ];
                }
              }
            } catch { /* ignore */ }

            // Best-effort per-car Fiala tire: use AC mu and dimensions when available.
            const tune = (acTuning?.simTuning && typeof acTuning.simTuning === 'object') ? acTuning.simTuning : null;
            const muBase = Number(wt?.mu) || 1.0;
            const dx1Use = Number(tune?.dx1);
            const dy1Use = Number(tune?.dy1);
            const loadSensAdj = (Number.isFinite(dx1Use) || Number.isFinite(dy1Use))
              ? (0.5 * Math.min(Number.isFinite(dx1Use) ? dx1Use : 0, Number.isFinite(dy1Use) ? dy1Use : 0))
              : 0;
            const muAc = clamp(muBase + loadSensAdj, 0.4, 2.5);
            const uMax = clamp(muAc, 0.5, 3.0);
            const uMin = clamp(uMax * 0.90, 0.3, uMax);
            const rM = clamp(Number(acTuning?.wheelRadius) || Number(acTuning?.simTuning?.wheelRadius) || 0.3099, 0.18, 0.65);
            const wM = clamp(Number(acTuning?.wheelWidth) || 0.235, 0.08, 0.45);
            const relaxF = Number(acTuning?.simTuning?.relaxLenFront);
            const relaxR = Number(acTuning?.simTuning?.relaxLenRear);
            const relaxAvg = (() => {
              const a = Number.isFinite(relaxF) ? relaxF : NaN;
              const b = Number.isFinite(relaxR) ? relaxR : NaN;
              if (Number.isFinite(a) && Number.isFinite(b)) return 0.5 * (a + b);
              if (Number.isFinite(a)) return a;
              if (Number.isFinite(b)) return b;
              return 0.15;
            })();
            const tireJson = {
              Name: 'AC Fiala Tire (generated)',
              Type: 'Tire',
              Template: 'FialaTire',
              'Coefficient of Friction': 1.0,
              Mass: 35.0,
              Inertia: [3.0, 6.0, 3.0],
              'Fiala Parameters': {
                'Unloaded Radius': rM,
                Width: wM,
                'Vertical Stiffness': (() => {
                  const kf = Number(tune?.tyreRateFront);
                  const kr = Number(tune?.tyreRateRear);
                  const k = (Number.isFinite(kf) && Number.isFinite(kr) && kf > 1000 && kr > 1000) ? (0.5 * (kf + kr))
                    : (Number.isFinite(kf) && kf > 1000) ? kf
                      : (Number.isFinite(kr) && kr > 1000) ? kr
                        : NaN;
                  return clamp(Number.isFinite(k) ? k : 310000, 20_000, 800_000);
                })(),
                'Vertical Damping': (() => {
                  const cf = Number(tune?.tyreDampFront);
                  const cr = Number(tune?.tyreDampRear);
                  const c = (Number.isFinite(cf) && Number.isFinite(cr) && cf > 10 && cr > 10) ? (0.5 * (cf + cr))
                    : (Number.isFinite(cf) && cf > 10) ? cf
                      : (Number.isFinite(cr) && cr > 10) ? cr
                        : NaN;
                  return clamp(Number.isFinite(c) ? c : 3100, 50, 50_000);
                })(),
                // Chrono uses a rolling resistance coefficient; approximate from AC RR0 (N) / FZ0 (N).
                'Rolling Resistance': (() => {
                  // Note: rr0/fz0Front are parsed inside _getAcPhysicsTuningFromBundleUrl and stored in debug.
                  const rrN = Number(acTuning?.debug?.rollingResistance0);
                  const fz = Number(acTuning?.debug?.fz0Front);
                  if (Number.isFinite(rrN) && rrN > 0 && Number.isFinite(fz) && fz > 100) return clamp(rrN / fz, 0.0005, 0.02);
                  return 0.001;
                })(),
                // Tire stiffness parameters:
                // - AC cornering stiffness we compute is for the *axle* (2 tires), so per-wheel is ~half.
                // - CSLIP controls longitudinal slip compliance; too large makes the tire unrealistically "rigid"
                //   and can kill believable wheelspin / traction transitions.
                CSLIP: (() => {
                  const fzf = Number(acTuning?.debug?.fz0Front);
                  const fzr = Number(acTuning?.debug?.fz0Rear);
                  const fz0 = (Number.isFinite(fzf) && Number.isFinite(fzr) && fzf > 100 && fzr > 100) ? (0.5 * (fzf + fzr))
                    : (Number.isFinite(fzf) && fzf > 100) ? fzf
                      : (Number.isFinite(fzr) && fzr > 100) ? fzr
                        : NaN;
                  const fz = (Number.isFinite(fz0) && fz0 > 100) ? fz0 : 3200;
                  return clamp(12.0 * fz, 20_000, 220_000);
                })(),
                CALPHA: (() => {
                  const cf = Number(tune?.cornerStiffFront);
                  const cr = Number(tune?.cornerStiffRear);
                  const caWheel = (Number.isFinite(cf) && Number.isFinite(cr) && cf > 1000 && cr > 1000)
                    ? (0.25 * (cf + cr)) // (front axle + rear axle) / 4 wheels
                    : (Number.isFinite(cf) && cf > 1000) ? (0.5 * cf)
                      : (Number.isFinite(cr) && cr > 1000) ? (0.5 * cr)
                        : NaN;
                  return Number.isFinite(caWheel) ? clamp(caWheel, 10_000, 250_000) : 45_000;
                })(),
                UMIN: uMin,
                UMAX: uMax,
                'X Relaxation Length': clamp(relaxAvg * 0.35, 0.005, 1.0),
                'Y Relaxation Length': clamp(relaxAvg, 0.005, 1.5),
              },
              Visualization: { Width: wM },
            };
            const tireJsonPath = `/tmp/chrono_ac_${stem}_${tNow}_tire.json`;

            const okVeh = sim.writeFile(jsonPath, JSON.stringify(vehJson, null, 2));
            const okTire = sim.writeFile(tireJsonPath, JSON.stringify(tireJson, null, 2));
            if (okVeh) {
              const h = Number(sim.createVehicleJson({ jsonPath, tireJsonPath: okTire ? tireJsonPath : '', x: x0, z: z0, yaw: yaw0 })) || 0;
              // Validate handle (JSON failure can still return nonzero handle).
              const stOk = h ? sim.getState?.(h) : null;
              if (stOk) {
                try { jsSimOpts._wasmJsonPath = jsonPath; } catch { /* ignore */ }
                try { jsSimOpts._wasmTireJsonPath = okTire ? tireJsonPath : ''; } catch { /* ignore */ }
                try { jsSimOpts._wasmChassisJsonPath = safeTrim(chassisPath || ''); } catch { /* ignore */ }
                return h;
              }
            }
          }
        } catch { /* ignore */ }
        // Fallback: if we can't create a JSON-defined Chrono vehicle, spawn a built-in Chrono vehicle
        // so users can still drive/test assets. (The JSON path can fail if a model lacks needed anchors,
        // if JSON parsing fails in the WASM build, or if filesystem writes are restricted.)
        try {
          const h = Number(sim.createVehicle({ kind: 0, x: x0, z: z0, yaw: yaw0 })) || 0;
          if (h) {
            try { jsSimOpts._wasmKind = 0; } catch { /* ignore */ }
            return h;
          }
        } catch { /* ignore */ }
        return 0;
      } catch {
        return 0;
      }
    })();

    // Apply Assetto-derived tuning to the Chrono WASM backend so steering/handling isn't "generic Sedan".
    try {
      if (this._vehicleSimKind === 'wasm' && simHandle && acTuning) {
        this._applyAcWasmTuningToSimHandle(this._vehicleSim, simHandle, acTuning);
      }
    } catch { /* ignore */ }

    let anim = null;
    try {
      const clips = Array.isArray(tpl?.clips) ? tpl.clips : [];
      if (clips.length) {
        const mixer = new THREE.AnimationMixer(inst);
        const byName = new Map();
        const byNormName = new Map();
        for (const c of clips) {
          const nm = safeTrim(c?.name || '');
          if (!nm) continue;
          byName.set(nm, c);
          const nn = normAnimName(nm);
          if (nn && !byNormName.has(nn)) byNormName.set(nn, c);
        }
        let sourceClips = clips;
        try {
          const want = Array.isArray(cfg?.animationClipNames) ? cfg.animationClipNames : [];
          const picked = [];
          for (const rawName of want) {
            const key = safeTrim(rawName);
            if (!key) continue;
            const clip = byName.get(key) || byNormName.get(normAnimName(key));
            if (clip) picked.push(clip);
          }
          if (picked.length) sourceClips = picked;
        } catch { /* ignore */ }
        const buckets = extractVehicleMotionClipBuckets(sourceClips);
        let mapped = null;
        try {
          const m = (cfg?.animationChannels && typeof cfg.animationChannels === 'object') ? cfg.animationChannels : null;
          if (m) {
            mapped = {
              idle: Array.isArray(m.idle) ? m.idle : [],
              drive: Array.isArray(m.drive) ? m.drive : [],
              wheel: Array.isArray(m.wheel) ? m.wheel : [],
              suspension: Array.isArray(m.suspension) ? m.suspension : [],
              steering: Array.isArray(m.steering) ? m.steering : [],
              combat: Array.isArray(m.combat) ? m.combat : [],
            };
          }
        } catch { /* ignore */ }
        const use = mapped || buckets;
        const toActions = (names) => {
          const out = [];
          for (const n of (Array.isArray(names) ? names : [])) {
            const clip = byName.get(n) || byNormName.get(normAnimName(n));
            if (!clip) continue;
            try {
              const a = mixer.clipAction(clip);
              a.enabled = true;
              a.setLoop(THREE.LoopRepeat, Infinity);
              a.clampWhenFinished = false;
              a.play();
              out.push(a);
            } catch { /* ignore */ }
          }
          return out;
        };
        const idle = toActions(use.idle);
        const drive = toActions(use.drive);
        const wheel = toActions(use.wheel);
        const suspension = toActions(use.suspension);
        const steering = toActions(use.steering);
        const combat = toActions(use.combat);
        for (const a of [...drive, ...wheel, ...suspension, ...steering, ...combat]) {
          try { a.setEffectiveWeight(0.0); a.setEffectiveTimeScale(0.0); } catch { /* ignore */ }
        }
        if (!idle.length && sourceClips.length) {
          try {
            const a0 = mixer.clipAction(sourceClips[0]);
            a0.enabled = true;
            a0.setLoop(THREE.LoopRepeat, Infinity);
            a0.clampWhenFinished = false;
            a0.play();
            idle.push(a0);
          } catch { /* ignore */ }
        }
        for (const a of idle) {
          try { a.setEffectiveWeight(1.0); a.setEffectiveTimeScale(1.0); } catch { /* ignore */ }
        }
        anim = { mixer, idle, drive, wheel, suspension, steering, combat };
      }
    } catch { /* ignore */ }

    const acAudio = (() => {
      const dirRaw = safeTrim(cfgMeta?.acAudioDirUrl || '');
      const iniRaw = safeTrim(cfgMeta?.acAudioIniUrl || '');
      const dirUrl = dirRaw ? normalizeAssetUrl(dirRaw) : '';
      const iniUrl = iniRaw ? normalizeAssetUrl(iniRaw) : '';
      return { dirUrl, iniUrl };
    })();

    const id = `${safeName(getFileStem(url))}_${Date.now()}`;
    const vrec = {
      id,
      kind: 'asset',
      group,
      modelRoot: inst,
      seats,
      doors,
      occ,
      driverSeatFromAnchor: !!driverAnchor,
      fx,
      acTuning,
      acAudio,
      drive: { gearN: 1, rpm: 0, shiftCd: 0 },
      yaw: Number(group.rotation.y) || 0,
      yawSim: (Number(group.rotation.y) || 0) - (Number(modelYawOffset) || 0),
      yawVisualOffset: Number(modelYawOffset) || 0,
      speed: 0,
      steer: 0,
      driveType,
      simCreateOptions: {
        js: { ...jsSimOpts },
        yaw: Number(simYaw0) || 0,
        wasm: {
          kind: Number.isFinite(Number(jsSimOpts?._wasmKind)) ? Number(jsSimOpts._wasmKind) : -1,
          jsonPath: safeTrim(jsSimOpts?._wasmJsonPath || ''),
          tireJsonPath: safeTrim(jsSimOpts?._wasmTireJsonPath || ''),
          chassisJsonPath: safeTrim(jsSimOpts?._wasmChassisJsonPath || ''),
        },
      },
      cameraDriverLocal: cameraDriverAnchor
        ? new THREE.Vector3(cameraDriverAnchor.x, clamp(cameraDriverAnchor.y, 0.55, 2.6), cameraDriverAnchor.z)
        : null,
      radius: Math.max(0.8, Math.max(halfX, halfZ) * 0.85),
      simHandle: Number(simHandle) || 0,
      parts: {
        wheelsAll: [],
        wheelsFront: [],
        wheelRadius: (() => {
          const r0 = Number(acTuning?.wheelRadius) || 0;
          if (r0 > 0) return Math.max(0.18, r0);
          return Math.max(0.18, Number(cfgMeta?.wheelScale) || 0.36);
        })(),
        wheelRadiusRear: (() => {
          const r0 = Number(acTuning?.wheelRadiusRear) || 0;
          if (r0 > 0) return Math.max(0.18, r0);
          const mr = Number(cfgMeta?.wheelScaleRear) || 0;
          if (mr > 0) return Math.max(0.18, mr);
          return Math.max(0.18, Number(acTuning?.wheelRadius) || Number(cfgMeta?.wheelScale) || 0.36);
        })(),
        wheelWidth: (() => {
          const w0 = Number(acTuning?.wheelWidth) || 0;
          if (w0 > 0) return Math.max(0.08, w0);
          return Math.max(0.08, Number(cfg?.wheelOverlay?.placeholderWidth) || 0.20);
        })(),
        wheelWidthRear: (() => {
          const w0 = Number(acTuning?.wheelWidthRear) || 0;
          if (w0 > 0) return Math.max(0.08, w0);
          const mw = Number(cfgMeta?.wheelWidthRear) || 0;
          if (mw > 0) return Math.max(0.08, mw);
          return Math.max(0.08, Number(acTuning?.wheelWidth) || Number(cfg?.wheelOverlay?.placeholderWidth) || 0.20);
        })(),
        wheelRoll: 0,
      },
      anim,
      vehicleConfig: cfg || null,
    };
    // If we failed to allocate a Chrono vehicle, remove the visual instance too.
    if (!vrec.simHandle) {
      try { this._setStatus(`Vehicle spawn failed (Chrono JSON unavailable; placeholders disabled): ${url}`); } catch { /* ignore */ }
      try { if (group?.parent) group.parent.remove(group); } catch { /* ignore */ }
      try { disposeThreeObject(group); } catch { /* ignore */ }
      return null;
    }
    try { this._ensureAssetVehicleWheelPivots(inst, vrec, anchors, anchorUnitScale); } catch { /* ignore */ }
    try {
      const wo = (cfg?.wheelOverlay && typeof cfg.wheelOverlay === 'object') ? cfg.wheelOverlay : null;
      const enabled = wo ? (wo.enabled !== false) : true;
      const fm = Number(wo?.frontScaleMul);
      const rm = Number(wo?.rearScaleMul);
      this._ensureAssetVehicleWheelOverlayPlaceholders(vrec, {
        enabled,
        frontScaleMul: Number.isFinite(fm) ? fm : 1.0,
        rearScaleMul: Number.isFinite(rm) ? rm : 1.0,
      });
    } catch { /* ignore */ }
    this._vehicles.push(vrec);
    if (this._tire?.enabled) {
      void (async () => {
        try { await this._ensureTireAssetLoaded(); } catch { /* ignore */ }
        try { this._applyRealisticTiresToVehicle(vrec); } catch { /* ignore */ }
      })();
    }
    return vrec;
  }

  // ---- Vehicle sim integration ----
  _syncVehicleSimStatics() {
    if (this._vehicleSimKind !== 'wasm') return;
    const sim = this._vehicleSim;
    if (!sim?.ready) return;
    const boxes = Array.isArray(this.host?._obstacleBoxes) ? this.host._obstacleBoxes : [];
    const out = new Float32Array(boxes.length * 6);
    let n = 0;
    for (const b of boxes) {
      if (!b?.min || !b?.max) continue;
      const i = n * 6;
      out[i + 0] = Number(b.min.x) || 0;
      out[i + 1] = Number(b.min.y) || 0;
      out[i + 2] = Number(b.min.z) || 0;
      out[i + 3] = Number(b.max.x) || 0;
      out[i + 4] = Number(b.max.y) || 0;
      out[i + 5] = Number(b.max.z) || 0;
      n++;
    }
    if (!n) sim.setStaticAabbsWorld(new Float32Array());
    else sim.setStaticAabbsWorld((n === boxes.length) ? out : out.slice(0, n * 6));
  }

  _recreateVehicleSimHandles() {
    const sim = this._vehicleSim;
    if (!sim) return;
    for (const v of (this._vehicles || [])) {
      if (!v?.group) continue;
      const x0 = Number(v.group.position.x) || 0;
      const z0 = Number(v.group.position.z) || 0;
      let h = 0;
      try {
        const yawSim = Number(v?.yawSim);
        const yaw0 = Number.isFinite(yawSim) ? yawSim : (Number(v.yaw) || 0);
        const jsonPath = safeTrim(v?.simCreateOptions?.wasm?.jsonPath || '');
        const tireJsonPath = safeTrim(v?.simCreateOptions?.wasm?.tireJsonPath || '');
        const kind = Math.floor(Number(v?.simCreateOptions?.wasm?.kind));
        if (jsonPath && typeof sim.createVehicleJson === 'function') {
          h = Number(sim.createVehicleJson({ jsonPath, tireJsonPath, x: x0, z: z0, yaw: yaw0 })) || 0;
          // Validate: JSON failures can return nonzero handles that can't report state.
          if (h && !sim.getState?.(h)) h = 0;
        }
        if (!h && typeof sim.createVehicle === 'function') {
          // If we can't recreate a JSON vehicle (e.g. stale /tmp path after module reload),
          // fall back to a built-in Chrono vehicle so driving still works.
          const kUse = (Number.isFinite(kind) && kind >= 0) ? kind : 0;
          h = Number(sim.createVehicle({ kind: kUse, x: x0, z: z0, yaw: yaw0 })) || 0;
        }
      } catch { h = 0; }
      v.simHandle = h;
      try {
        // JSON vehicles are created without a powertrain; always ensure one after (re)creation.
        // For AC-derived vehicles, this also applies per-car tuning; for others it installs a default map.
        const jsonPath = safeTrim(v?.simCreateOptions?.wasm?.jsonPath || '');
        if (h && jsonPath) this._applyAcWasmTuningToSimHandle(sim, h, v?.acTuning || {});
        else if (h && v?.acTuning) this._applyAcWasmTuningToSimHandle(sim, h, v.acTuning);
      } catch { /* ignore */ }
    }
  }

  _collidesWorldAtRadius(x, yFeet, z, r) {
    const radius = Math.max(0.05, Number(r) || 1.0);
    const bottom = Number(yFeet) + 0.05;
    const top = Number(yFeet) + 2.0;
    const boxes = Array.isArray(this.host?._obstacleBoxes) ? this.host._obstacleBoxes : [];
    for (const b of boxes) {
      if (!b) continue;
      const min = b.min, max = b.max;
      if (!(bottom < max.y && top > min.y)) continue;
      const qx = clamp(x, min.x, max.x);
      const qz = clamp(z, min.z, max.z);
      const dx = x - qx;
      const dz = z - qz;
      if ((dx * dx + dz * dz) < (radius * radius)) return true;
    }
    return false;
  }

  // ---- Traffic AI helpers ----
  _buildTrafficRoute(routePoints) {
    const pts0 = Array.isArray(routePoints) ? routePoints : [];
    const pts = [];
    for (const p of pts0) {
      const x = Number(p?.x);
      const z = Number(p?.z);
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      const y = Number(p?.y);
      pts.push({ x, y: Number.isFinite(y) ? y : 0, z });
    }
    if (pts.length < 3) return null;

    const out = [];
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const dx = (Number(b.x) || 0) - (Number(a.x) || 0);
      const dz = (Number(b.z) || 0) - (Number(a.z) || 0);
      const l = Math.hypot(dx, dz);
      const tx = (l > 1e-9) ? (dx / l) : 0;
      const tz = (l > 1e-9) ? (dz / l) : -1;
      out.push({ x: Number(a.x) || 0, y: Number(a.y) || 0, z: Number(a.z) || 0, tx, tz, s });
      s += (Number.isFinite(l) ? l : 0);
    }
    const length = Math.max(1e-3, Number(s) || 0);
    return { points: out, length };
  }

  _routePoseAtS(route, sRaw, laneOffsetM = 0) {
    const r = route && typeof route === 'object' ? route : null;
    const pts = Array.isArray(r?.points) ? r.points : [];
    const len = Math.max(1e-6, Number(r?.length) || 0);
    if (!pts.length || len <= 0) return null;

    let s = Number(sRaw) || 0;
    s = ((s % len) + len) % len;

    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) * 0.5);
      if ((Number(pts[mid]?.s) || 0) <= s) lo = mid;
      else hi = mid - 1;
    }
    const i = lo;
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const sa = Number(a?.s) || 0;
    const sb = (i === pts.length - 1) ? len : (Number(b?.s) || 0);
    const seg = Math.max(1e-6, sb - sa);
    const t = clamp((s - sa) / seg, 0, 1);

    const x0 = lerp(Number(a?.x) || 0, Number(b?.x) || 0, t);
    const z0 = lerp(Number(a?.z) || 0, Number(b?.z) || 0, t);
    let tx = lerp(Number(a?.tx) || 0, Number(b?.tx) || 0, t);
    let tz = lerp(Number(a?.tz) || -1, Number(b?.tz) || -1, t);
    const tl = Math.hypot(tx, tz);
    if (tl > 1e-9) { tx /= tl; tz /= tl; } else { tx = 0; tz = -1; }

    const rx = tz;
    const rz = -tx;
    const off = clamp(Number(laneOffsetM) || 0, -20, 20);
    const x = x0 + rx * off;
    const z = z0 + rz * off;

    const yawRad = Math.atan2(-tx, -tz);
    return { x, z, yawRad, iHint: i };
  }

  _teleportVehicleTo(v, x, z, yawRad) {
    if (!v?.group) return;
    const px = Number(x) || 0;
    const pz = Number(z) || 0;
    const yaw = Number(yawRad) || 0;
    const yawOff = Number(v?.yawVisualOffset) || 0;

    try {
      v.group.position.x = px;
      v.group.position.z = pz;
      v.yaw = yaw;
      v.yawSim = yaw - yawOff;
      v.group.rotation.y = v.yaw;
    } catch { /* ignore */ }

    try {
      v.group.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(v.group);
      const bottom = Number(box.min.y) || 0;
      let gy = this._findGroundY(px, (Number(this._player?.y) || 0) + 2.0, pz);
      try {
        if (gy == null && this.host?._raycastGroundYAt) {
          const originY = Math.max(800, (Number(this._player?.y) || 0) + 50);
          gy = this.host._raycastGroundYAt(px, pz, { originY, far: 12_000 });
        }
      } catch { /* ignore */ }
      const spawnY = Number(this.host?._spawn?.y);
      const groundY = (gy == null)
        ? (Number.isFinite(spawnY) ? spawnY : 0)
        : (Number(gy) || 0);
      v.group.position.y += (groundY - bottom);
      v.group.updateMatrixWorld(true);
    } catch { /* ignore */ }

    try { if (v?.simHandle) this._vehicleSim?.setPose?.(v.simHandle, px, pz, Number(v.yawSim) || 0); } catch { /* ignore */ }
  }

  _pickTrafficSpeedTargetMps(i = 0) {
    const a = this._traffic;
    const lo = Math.max(1, Number(a?.speedKphMin) || 70);
    const hi = Math.max(lo, Number(a?.speedKphMax) || 115);
    const r = 0.5 + 0.5 * Math.sin((Number(i) + 1) * 12.9898 + 78.233);
    const kph = lerp(lo, hi, clamp(r, 0, 1));
    return Math.max(1, kph / 3.6);
  }

  _tickTrafficAiBeforeSim(dt) {
    const a = this._traffic;
    if (!a?.enabled || !a?.route || !Array.isArray(this._vehicles) || !this._vehicles.length) return;
    const route = a.route;
    const pts = Array.isArray(route?.points) ? route.points : [];
    const len = Math.max(1e-6, Number(route?.length) || 0);
    if (pts.length < 3 || len <= 0) return;

    const dts = Math.max(0, Number(dt) || 0);
    const lookBase = Math.max(1, Number(a.lookaheadBaseM) || 7);
    const lookMul = Math.max(0, Number(a.lookaheadSpeedMul) || 0.6);
    const laneOff = clamp(Number(a.laneOffsetM) || 0, -20, 20);

    for (const v of (this._vehicles || [])) {
      if (!v?.simHandle || !v?.group) continue;
      if (!(v?.ai && safeTrim(v.ai.kind) === 'traffic')) continue;
      const drv = v?.occ?.get?.('driver') || null;
      if (drv !== 'npc') continue;

      const st = this._vehicleSim?.getState?.(v.simHandle) || null;
      const x = Number(st?.x ?? v.group.position.x) || 0;
      const z = Number(st?.z ?? v.group.position.z) || 0;
      const yawSim = Number.isFinite(Number(st?.yaw)) ? Number(st.yaw) : (Number(v.yawSim) || 0);
      const speed = Number.isFinite(Number(st?.speed)) ? Number(st.speed) : (Number(v.speed) || 0);

      let s = Number(v.ai.s) || 0;
      s += Math.max(0, speed) * dts;
      s = ((s % len) + len) % len;

      let iHint = Math.floor(Number(v.ai.iHint) || 0);
      if (!Number.isFinite(iHint)) iHint = 0;
      iHint = ((iHint % pts.length) + pts.length) % pts.length;
      let bestI = iHint;
      let bestD2 = Infinity;
      const win = 36;
      for (let k = -win; k <= win; k++) {
        const ii = (iHint + k + pts.length) % pts.length;
        const p = pts[ii];
        const dx = (Number(p?.x) || 0) - x;
        const dz = (Number(p?.z) || 0) - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; bestI = ii; }
      }
      if (Number.isFinite(bestD2) && bestD2 < 25 * 25) {
        const sCorr = Number(pts[bestI]?.s);
        if (Number.isFinite(sCorr)) s = sCorr;
        iHint = bestI;
      }

      const look = lookBase + Math.max(0, speed) * lookMul;
      const tgt = this._routePoseAtS(route, s + look, laneOff);
      if (!tgt) continue;

      const toX = (Number(tgt.x) || 0) - x;
      const toZ = (Number(tgt.z) || 0) - z;
      const toL = Math.hypot(toX, toZ);
      if (toL < 1e-6) continue;
      const desX = toX / toL;
      const desZ = toZ / toL;

      const fwdX = -Math.sin(yawSim);
      const fwdZ = -Math.cos(yawSim);
      const dot = clamp(fwdX * desX + fwdZ * desZ, -1, 1);
      const cross = (fwdX * desZ) - (fwdZ * desX);
      const angle = Math.atan2(cross, dot);
      const steer = clamp(angle / 0.55, -1, 1);

      const baseTarget = Number(v.ai.speedTarget) || this._pickTrafficSpeedTargetMps(0);
      const turnSlow = clamp(1.0 - Math.min(0.75, Math.abs(angle) * 0.55), 0.35, 1.0);
      const targetSpeed = Math.max(2.0, baseTarget * turnSlow);
      const err = targetSpeed - Math.max(0, speed);
      const throttle = clamp(err * 0.18, 0, 1);
      const brake = clamp((-err) * 0.22, 0, 1);

      try {
        if (this._vehicleSimKind === 'wasm') {
          try { this._vehicleSim?.setGear?.(v.simHandle, 1); } catch { /* ignore */ }
          // Speed-sensitive steering for traffic when using WASM backend.
          const tune = (v?.acTuning?.simTuning && typeof v.acTuning.simTuning === 'object') ? v.acTuning.simTuning : (v?.simCreateOptions?.js || null);
          const steerRef = Math.max(0.5, Number(tune?.steerSpeedRef) || 12.5);
          const steerMin = clamp(Number(tune?.steerMinFactor) || 0.33, 0.15, 1.0);
          const vAbs = Math.abs(Number(speed) || 0);
          const tt = clamp(vAbs / steerRef, 0, 1);
          const steerScale = 1.0 - tt * (1.0 - steerMin);
          const steerOut = clamp(steer * steerScale, -1, 1);
          const steerRate = Math.max(0.5, Number(tune?.steerRate) || 7.2);
          const prevSteer = Number(v?.drive?.steerCmdWasm);
          const sPrev = Number.isFinite(prevSteer) ? prevSteer : 0;
          const s = lerp(sPrev, steerOut, 1.0 - Math.exp(-steerRate * dts));
          try {
            if (!v.drive || typeof v.drive !== 'object') v.drive = {};
            v.drive.steerCmdWasm = s;
          } catch { /* ignore */ }
          this._vehicleSim?.setControls?.(v.simHandle, throttle, brake, s);
        } else {
          try { this._vehicleSim?.setGear?.(v.simHandle, 1); } catch { /* ignore */ }
          this._vehicleSim?.setControls?.(v.simHandle, throttle, brake, steer);
        }
      } catch { /* ignore */ }

      v.ai.s = s;
      v.ai.iHint = iHint;
    }
  }

  _tickTrafficRecording(dt) {
    const r = this._trafficRecord;
    if (!r?.active) return;
    const dts = Math.max(0, Number(dt) || 0);
    r.accMs += dts * 1000;

    const pickSourcePos = () => {
      try {
        if (this._vehicleCtx?.inVehicle) {
          const v = (this._vehicles || []).find((x) => safeTrim(x?.id) === safeTrim(this._vehicleCtx?.vehicleId)) || null;
          if (v?.group) return { x: Number(v.group.position.x) || 0, y: Number(v.group.position.y) || 0, z: Number(v.group.position.z) || 0 };
        }
      } catch { /* ignore */ }
      return { x: Number(this._player?.x) || 0, y: Number(this._player?.y) || 0, z: Number(this._player?.z) || 0 };
    };

    const src = pickSourcePos();
    const x = Number(src.x) || 0;
    const y = Number(src.y) || 0;
    const z = Number(src.z) || 0;

    const pts = Array.isArray(r.points) ? r.points : [];
    const needFirst = !pts.length || !Number.isFinite(Number(r.lastX)) || !Number.isFinite(Number(r.lastZ));
    const dx = needFirst ? Infinity : (x - Number(r.lastX));
    const dz = needFirst ? Infinity : (z - Number(r.lastZ));
    const dist = Math.hypot(dx, dz);
    const byDist = Number.isFinite(dist) && dist >= (Number(r.sampleEveryDistM) || 6.0);
    const byTime = Number(r.accMs) >= (Number(r.sampleEveryMs) || 350);
    if (!(needFirst || byDist || byTime)) return;

    pts.push({ x, y, z });
    r.points = pts;
    r.lastX = x;
    r.lastZ = z;
    r.accMs = 0;

    const maxPts = Math.max(200, Math.floor(Number(r.maxPoints) || 8000));
    if (pts.length > maxPts) {
      // Soft stop: avoid runaway memory usage.
      r.active = false;
      try { this._setStatus(`Traffic route recording auto-stopped (hit ${maxPts} points).`); } catch { /* ignore */ }
    }
  }

  // ---- Driving + interaction ----
  _tickVehicles(dt) {
    if (!Array.isArray(this._vehicles) || !this._vehicles.length) return;
    const dts = Math.max(0, Number(dt) || 0);

    if (!this._triggerInteractHintActive && !this._vehicleCtx.inVehicle) {
      const near = this._nearestVehicleEnterCandidate();
      if (near && this._ui?.hintEl) {
        const label = safeTrim(near?.door?.label) || (safeTrim(near?.seatId) === 'driver' ? 'Driver seat' : 'Enter');
        this._ui.hintEl.textContent = `Press E: enter (${label})`;
      } else if (this._ui?.hintEl) {
        const cur = safeTrim(this._ui.hintEl.textContent || '');
        if (cur.startsWith('Press E: enter')) this._ui.hintEl.textContent = '';
      }
    }

    try { this._vehicleSim?.clearControls?.(); } catch { /* ignore */ }
    const inVeh = !!this._vehicleCtx?.inVehicle;
    const driveInputs = new Map();
    const isDriverSeat = safeTrim(this._vehicleCtx?.role) === 'driver' || safeTrim(this._vehicleCtx?.seatId) === 'driver';
    // Driving should not be hard-gated on camera mode: if you're seated as the driver,
    // WASD should control the car even if the user is currently in orbit/editor mode.
    const canDrive = !!this._drivingEnabled && inVeh && isDriverSeat;
    if (canDrive) {
      // User is actively driving: this counts as an interaction trigger for WebAudio resume.
      // Ensure context exists before attempting to resume.
      try { this._ensureVehicleAudio(); } catch { /* ignore */ }
      this._resumeVehicleAudioIfNeeded();
      const vv = this._vehicles.find((x) => x.id === this._vehicleCtx.vehicleId) || null;
      const isHover = safeTrim(vv?.driveType) === 'hover';
      const forward = (this._keysDown.has('KeyW') || this._keysDown.has('ArrowUp')) ? 1 : 0;
      const back = (this._keysDown.has('KeyS') || this._keysDown.has('ArrowDown')) ? 1 : 0;
      const left = (this._keysDown.has('KeyA') || this._keysDown.has('ArrowLeft')) ? 1 : 0;
      const right = (this._keysDown.has('KeyD') || this._keysDown.has('ArrowRight')) ? 1 : 0;
      const handbrake = this._keysDown.has('Space') ? 1 : 0;
      if (vv && !vv.simHandle) {
        try { this._recreateVehicleSimHandles(); } catch { /* ignore */ }
      }
      const cur = (vv?.simHandle) ? this._vehicleSim?.getState?.(vv.simHandle) : null;
      const spd = Number(cur?.speed);
      const speedRef = Number.isFinite(spd) ? spd : (Number(vv?.speed) || 0);
      const ctrl = computeVehicleControls({ driveType: isHover ? 'hover' : 'wheeled', forward, back, left, right, speedRef });
      // Smooth throttle/brake so keyboard isn't a perfect on/off switch.
      // This helps traction feel a lot (especially in WASM where wheel omega reacts immediately).
      const wantThrottle = Number(ctrl.throttle) || 0;
      const wantBrake = Math.max(Number(ctrl.brake) || 0, Number(handbrake) || 0);
      const tune = (vv?.acTuning?.simTuning && typeof vv.acTuning.simTuning === 'object') ? vv.acTuning.simTuning : (vv?.simCreateOptions?.js || null);
      const thrUp = Math.max(0.5, Number(tune?.throttleRateUp) || 5.5);
      const thrDn = Math.max(0.5, Number(tune?.throttleRateDown) || 10.0);
      const brUp = Math.max(0.5, Number(tune?.brakeRateUp) || 9.0);
      const brDn = Math.max(0.5, Number(tune?.brakeRateDown) || 14.0);
      let throttle = wantThrottle;
      let brake = wantBrake;
      try {
        if (!vv.drive || typeof vv.drive !== 'object') vv.drive = {};
        const prevT = clamp01(Number(vv.drive.throttleCmd) || 0);
        const prevB = clamp01(Number(vv.drive.brakeCmd) || 0);
        const aT = 1.0 - Math.exp(-((wantThrottle > prevT) ? thrUp : thrDn) * dts);
        const aB = 1.0 - Math.exp(-((wantBrake > prevB) ? brUp : brDn) * dts);
        throttle = clamp01(lerp(prevT, wantThrottle, aT));
        brake = clamp01(lerp(prevB, wantBrake, aB));
        vv.drive.throttleCmd = throttle;
        vv.drive.brakeCmd = brake;
      } catch { /* ignore */ }
      const gearDir = Number(ctrl.gear) || 1;
      const steer = Number(ctrl.steer) || 0;
      // WASM backend only supports gear direction (-1/0/1). Keep audio gear as -1/1.
      const gearForAudio = (Number(gearDir) < 0) ? -1 : 1;
      try {
        if (vv) {
          vv.drive = (vv.drive && typeof vv.drive === 'object') ? vv.drive : { gearN: 1, rpm: 0, shiftCd: 0 };
          vv.drive.last = {
            throttle01: clamp01(Math.abs(Number(throttle) || 0)),
            brake01: clamp01(Number(brake) || 0),
            handbrake01: clamp01(Number(handbrake) || 0),
            gear: Number(gearForAudio) || 1,
            gearDir: Number(gearDir) || 1,
            gearIndex: 1,
            steer: Number(steer) || 0,
          };
        }
      } catch { /* ignore */ }
      if (vv) driveInputs.set(vv.id, { throttle, brake, gear: gearForAudio, gearDir, steer });
      if (vv?.simHandle) {
        if (isHover) {
          const tAbs = Math.abs(Number(throttle) || 0);
          const g = (Number(throttle) < -1e-6) ? -1 : 1;
          try { this._vehicleSim?.setGear?.(vv.simHandle, g); } catch { /* ignore */ }
          this._vehicleSim?.setControls?.(vv.simHandle, tAbs, brake, steer);
        } else {
          // Speed-sensitive steering for WASM backend: calms down high-speed yaw response.
          const steerRef = Math.max(0.5, Number(tune?.steerSpeedRef) || 12.5);
          const steerMin = clamp(Number(tune?.steerMinFactor) || 0.33, 0.15, 1.0);
          const vAbs = Math.abs(Number(speedRef) || 0);
          const t = clamp(vAbs / steerRef, 0, 1);
          const steerScale = 1.0 - t * (1.0 - steerMin);
          const steerOut = clamp(steer * steerScale, -1, 1);
          // Rate-limit steering so keyboard input doesn't instantly snap to full lock.
          const steerRate = Math.max(0.5, Number(tune?.steerRate) || 7.2);
          const prevSteer = Number(vv?.drive?.steerCmdWasm);
          const sPrev = Number.isFinite(prevSteer) ? prevSteer : 0;
          const s = lerp(sPrev, steerOut, 1.0 - Math.exp(-steerRate * dts));
          try { if (vv?.drive && typeof vv.drive === 'object') vv.drive.steerCmdWasm = s; } catch { /* ignore */ }
          try { this._vehicleSim?.setGear?.(vv.simHandle, gearDir); } catch { /* ignore */ }
          this._vehicleSim?.setControls?.(vv.simHandle, throttle, brake, s);
        }
      }
    }

    // NPC traffic AI controls (before friction + sim step).
    try { this._tickTrafficAiBeforeSim(dts); } catch { /* ignore */ }

    // AC track surface friction (WASM backend): adjust terrain friction by surface under wheels.
    try {
      void this.host?._maybeEnableAcTrackDrivingForSceneUrl?.(this._state?.sourceUrl || this._state?.lastGlbUrl || '');
    } catch { /* ignore */ }
    // WASM backend uses a global terrain friction. Keep it <= 1.0 (Chrono clamps terrain friction),
    // and treat the AC track mu multiplier as a reduction factor (ice/curbs/dirt).
    let muAcc = 0;
    let muN = 0;
    for (const v of (this._vehicles || [])) {
      if (!v?.simHandle || !v?.group) continue;
      try {
        const wb = Number(v?.acTuning?.simTuning?.wheelbase);
        const wheelbase = Math.max(0.6, Number.isFinite(wb) ? wb : 2.4);
        const yaw = Number(v?.yawSim);
        const yaw0 = Number.isFinite(yaw) ? yaw : ((Number(v?.yaw) || Number(v?.group?.rotation?.y) || 0) - (Number(v?.yawVisualOffset) || 0));
        const sy = Math.sin(yaw0);
        const cy = Math.cos(yaw0);
        const fwdX = -sy;
        const fwdZ = -cy;
        const a = 0.45 * wheelbase;
        const b = Math.max(0.20, wheelbase - a);
        const cx = Number(v.group.position.x) || 0;
        const cz = Number(v.group.position.z) || 0;
        const fx = cx + fwdX * a;
        const fz = cz + fwdZ * a;
        const rx = cx - fwdX * b;
        const rz = cz - fwdZ * b;
        const muF = Number(this.host?._getAcTrackMuMulAt?.(fx, fz)) || 1.0;
        const muR = Number(this.host?._getAcTrackMuMulAt?.(rx, rz)) || 1.0;
        const mu = (muF + muR) * 0.5;
        if (Number.isFinite(mu)) { muAcc += mu; muN++; }
      } catch { /* ignore */ }
    }
    if (muN > 0) {
      const muAvg = clamp(muAcc / muN, 0.2, 1.0);
      try { this._vehicleSim?.setWorldFriction?.(muAvg); } catch { /* ignore */ }
    }

    try { this._vehicleSim?.step?.(dts); } catch { /* ignore */ }

    for (const v of (this._vehicles || [])) {
      if (!v?.group) continue;
      let st = (v?.simHandle) ? this._vehicleSim?.getState?.(v.simHandle) : null;
      // If vehicle state goes missing (sim reset, backend swap, wasm not ready), we otherwise fall back
      // to the kinematic "move along forward axis" integrator below, which makes drifting impossible.
      // Re-bind sim handles on a cooldown to keep physics active.
      if (!st) {
        if (!!this._vehicleSim?.ready) {
          const nowMs = Date.now();
          const lastMs = Number(v?._simRebindAtMs) || 0;
          if ((nowMs - lastMs) > 1200) {
            try { v._simRebindAtMs = nowMs; } catch { /* ignore */ }
            try { this._recreateVehicleSimHandles(); } catch { /* ignore */ }
            try { st = (v?.simHandle) ? this._vehicleSim?.getState?.(v.simHandle) : null; } catch { /* ignore */ }
          }
        }
      }
      let steerRad = 0;
      if (st) {
        const yawRaw = Number(st.yaw) || 0;
        const yawOff = Number(v.yawVisualOffset) || 0;
        v.yawSim = yawRaw;
        v.yaw = yawRaw + yawOff;
        v.speed = Number(st.speed) || 0;
        steerRad = Number(st.steerRad) || 0;
        v.steer = (Math.abs(steerRad) > 1e-6) ? (steerRad / Math.max(1e-3, 0.48)) : 0;
        v.group.position.x = Number(st.x) || 0;
        v.group.position.z = Number(st.z) || 0;
        v.group.rotation.y = v.yaw;
      }

      // ---- Vehicle audio (engine synth fallback) ----
      try {
        const a = this._vehAudio;
        const isDriverVeh = !!inVeh && this._vehicleCtx?.role === 'driver' && safeTrim(this._vehicleCtx?.vehicleId) === safeTrim(v?.id);
        const inp = driveInputs.get(v.id) || { throttle: 0, brake: 0, gear: 1, steer: 0 };
        const throttle01 = clamp01(Math.abs(Number(inp.throttle) || 0));
        const brake01 = clamp01(Number(inp.brake) || 0);
        const speedAbs = Math.abs(Number(v.speed) || 0);

        // Estimate engine RPM from speed + gearing (if present), with stationary rev fallback.
        const tune = (v?.acTuning?.simTuning && typeof v.acTuning.simTuning === 'object') ? v.acTuning.simTuning : (v?.simCreateOptions?.js || null);
        const wheelR = Math.max(0.05, Number(tune?.wheelRadius) || Number(v?.parts?.wheelRadius) || 0.34);
        const finalRatio = Number(tune?.finalRatio) || 0;
        const gears = Array.isArray(tune?.gearRatios) ? tune.gearRatios : [];
        const idleRpm = Math.max(600, Number(tune?.idleRpm) || 950);
        const limRpm = Math.max(idleRpm + 500, Number(tune?.limiterRpm) || 7200);
        const gearNRaw = Math.floor(Number(inp.gear) || 1);
        const gearN = Math.max(1, Math.min(16, gearNRaw || 1));
        const ratio = (gears.length && gearN >= 1 && gearN <= gears.length) ? Number(gears[gearN - 1]) : (gears.length ? Number(gears[0]) : 0);
        const rpmFromSpeed = (wheelR > 0.05 && finalRatio > 0.01 && ratio > 0.01)
          ? ((speedAbs / wheelR) * (ratio * finalRatio) * (60 / (2 * Math.PI)))
          : NaN;
        let rpm = Number.isFinite(rpmFromSpeed) ? rpmFromSpeed : idleRpm;
        if (speedAbs < 0.6) {
          // Rev a bit when stationary.
          const target = idleRpm + Math.pow(throttle01, 0.7) * (0.45 * (limRpm - idleRpm));
          rpm = Number.isFinite(rpm) ? lerp(rpm, target, 0.85) : target;
        }
        rpm = clamp(rpm, idleRpm, limRpm);

        // Cache for UI/debug if needed.
        try {
          const d0 = (v.drive && typeof v.drive === 'object') ? v.drive : null;
          if (d0) {
            d0.gearN = gearN;
            const prev = Number(d0.rpm) || rpm;
            d0.rpm = lerp(prev, rpm, 1.0 - Math.exp(-10.0 * dts));
            d0.lastGear = Number(inp.gear) || 1;
            d0.lastThrottle01 = throttle01;
            d0.lastBrake01 = brake01;
            if (!Number.isFinite(Number(d0.odoM))) d0.odoM = 0;
            if (isDriverVeh) d0.odoM = Math.max(0, (Number(d0.odoM) || 0) + speedAbs * dts);
          }
        } catch { /* ignore */ }

        // Drive only one active synth (the player vehicle).
        if (a?.enabled && isDriverVeh) {
          // Prefer AC sample-based sfx/engine*.ini if present; fall back to synth while loading or missing.
          const dir0 = safeTrim(v?.acAudio?.dirUrl || '');
          const acBase = dir0 ? (dir0.endsWith('/') ? dir0 : `${dir0}/`) : '';
          let usedAc = false;
          if (acBase) {
            const eng = this._ensureVehicleAcSfxFor(v.id, { baseUrl: acBase, preferInterior: true });
            if (eng) {
              if (eng.ready) {
                usedAc = true;
                // If synth was playing during load, fade it out.
                if (a?.synth) this._stopVehicleSynth({ fadeSec: 0.08 });
                eng.update({ rpm, throttle01, speedAbs }, dts);
              } else if (eng.failed) {
                // Failed to load AC audio (commonly: FMOD-bank-only cars with no engine*.ini + wav).
                // Keep the failed instance so we don't retry and spam 404s every frame.
                try {
                  const now = Date.now();
                  if (a && (now - (Number(a.warnNoAcAudioAtMs) || 0)) > 8000) {
                    a.warnNoAcAudioAtMs = now;
                    // Keep this low-noise; many AC mods are bank-only.
                    console.warn('[vehicle-audio] AC sample audio not found; using fallback synth:', acBase);
                  }
                } catch { /* ignore */ }
              } else {
                // Loading: keep synth running for immediate feedback.
              }
            }
          } else {
            // If the vehicle has no AC audio bindings, don't warn too often.
            try {
              const now = Date.now();
              if (a && (now - (Number(a.warnNoAcAudioAtMs) || 0)) > 6000) {
                a.warnNoAcAudioAtMs = now;
              }
            } catch { /* ignore */ }
          }

          if (!usedAc) {
            const synth = this._ensureVehicleSynthFor(v.id);
            if (synth) synth.update({ rpm, idleRpm, limRpm, throttle01, speedAbs }, dts);
          }
        } else if (safeTrim(a?.activeVehicleId) === safeTrim(v?.id)) {
          // Fade out quickly when exiting or switching vehicles.
          this._stopAllVehicleAudio({ fadeSec: 0.10 });
        }
      } catch { /* ignore */ }

      try {
        const parts = v?.parts || null;
        const prF = Number(parts?.wheelRadius) || 0.36;
        const prR = Number(parts?.wheelRadiusRear) || prF;
        const pr = Math.max(0.05, 0.5 * (Math.abs(prF) + Math.abs(prR)) || 0.36);
        const wheels = Array.isArray(parts?.wheelsAll) ? parts.wheelsAll : [];
        const fronts = Array.isArray(parts?.wheelsFront) ? parts.wheelsFront : [];
        if (!parts || !wheels.length) throw new Error('no wheels');

        // Prefer Chrono's per-wheel spindle omega when using WASM backend.
        // This fixes "engine revs but wheels look frozen" in cases where speed is ~0 (burnout / wrong speed readback).
        const ws = (this._vehicleSimKind === 'wasm' && v?.simHandle)
          ? (this._vehicleSim?.getWheelState?.(v.simHandle) || null)
          : null;
        const omega = {
          lf: Number(ws?.omegaFL),
          rf: Number(ws?.omegaFR),
          lr: Number(ws?.omegaRL),
          rr: Number(ws?.omegaRR),
        };
        const haveOmega = Object.values(omega).some((x) => Number.isFinite(x) && Math.abs(x) > 1e-4);

        const inp = driveInputs.get(v.id) || null;
        const speedSigned = Number(v.speed) || 0;
        const gearDir = Number(inp?.gearDir) || ((Number(inp?.gear) || 1) < 0 ? -1 : 1);
        const dirSign = (Math.abs(speedSigned) > 0.6) ? Math.sign(speedSigned) : (gearDir < 0 ? -1 : 1);

        if (!parts.wheelRollById || typeof parts.wheelRollById !== 'object') parts.wheelRollById = { lf: 0, rf: 0, lr: 0, rr: 0 };
        const rollById = parts.wheelRollById;

        if (haveOmega) {
          // Integrate omega (rad/s) to angle (rad). Use abs() so L/R don't counter-rotate due to axis conventions.
          for (const id of ['lf', 'rf', 'lr', 'rr']) {
            const om = omega[id];
            const prev = Number(rollById[id]) || 0;
            const d = (Number.isFinite(om) ? (dirSign * Math.abs(om) * dts) : 0);
            let a = prev + d;
            if (!Number.isFinite(a)) a = 0;
            rollById[id] = Math.atan2(Math.sin(a), Math.cos(a));
          }
        } else {
          // Fallback: distance-based roll from signed speed.
          const speedClamped = Math.max(-25, Math.min(25, speedSigned));
          const rollDelta = (speedClamped * dts) / pr;
          const prevRoll = Number(parts?.wheelRoll) || 0;
          let wheelRoll = prevRoll + rollDelta;
          if (!Number.isFinite(wheelRoll)) wheelRoll = 0;
          wheelRoll = Math.atan2(Math.sin(wheelRoll), Math.cos(wheelRoll));
          parts.wheelRoll = wheelRoll;
          rollById.lf = wheelRoll;
          rollById.rf = wheelRoll;
          rollById.lr = wheelRoll;
          rollById.rr = wheelRoll;
        }

        // Apply roll to each pivot based on its corner id.
        for (const w of wheels) {
          if (!w) continue;
          if (w.rotation?.order !== 'YXZ') w.rotation.order = 'YXZ';
          const nm = safeTrim(w?.name || '').toLowerCase();
          const id = nm.includes('wheel_lf') ? 'lf'
            : nm.includes('wheel_rf') ? 'rf'
              : nm.includes('wheel_lr') ? 'lr'
                : nm.includes('wheel_rr') ? 'rr'
                  : '';
          const a = id ? (Number(rollById[id]) || 0) : (Number(parts.wheelRoll) || 0);
          w.rotation.x = a;
        }

        // Steering: prefer per-wheel steer angles from Chrono when available.
        const steerLf = Number(ws?.steerFL);
        const steerRf = Number(ws?.steerFR);
        for (const w of fronts) {
          if (!w) continue;
          if (w.rotation?.order !== 'YXZ') w.rotation.order = 'YXZ';
          const nm = safeTrim(w?.name || '').toLowerCase();
          const y = nm.includes('wheel_lf') && Number.isFinite(steerLf) ? steerLf
            : nm.includes('wheel_rf') && Number.isFinite(steerRf) ? steerRf
              : steerRad;
          w.rotation.y = Number.isFinite(y) ? y : 0;
        }
      } catch { /* ignore */ }

      // Visual FX (AC exports): brake light emissive + optional rim blur meshes.
      try {
        const fx = v?.fx || null;
        if (fx) {
          const inp = driveInputs.get(v.id) || null;
          const brake01 = clamp01(Number(inp?.brake) || 0);
          const gear = Number(inp?.gear) || 1;
          const speedAbs = Math.abs(Number(v.speed) || 0);
          const speedSigned = Number(v.speed) || 0;

          // Toggle lights / indicators (driver only).
          try {
            const isDriverVeh = !!inVeh && this._vehicleCtx?.role === 'driver' && safeTrim(this._vehicleCtx?.vehicleId) === safeTrim(v?.id);
            if (isDriverVeh) {
              if (this._keysPressed?.has?.('KeyL')) fx.lightsOn = !fx.lightsOn;
              if (this._keysPressed?.has?.('KeyZ')) fx.indicatorMode = (fx.indicatorMode === 'hazard') ? 'off' : 'hazard';
              if (this._keysPressed?.has?.('KeyQ')) fx.indicatorMode = (fx.indicatorMode === 'left') ? 'off' : 'left';
              if (this._keysPressed?.has?.('KeyE')) fx.indicatorMode = (fx.indicatorMode === 'right') ? 'off' : 'right';
            }
          } catch { /* ignore */ }

          fx.blinkT = (Number(fx.blinkT) || 0) + dts;
          const blinkOn = (Math.floor((Number(fx.blinkT) || 0) / 0.45) % 2) === 0;

          const bl = fx?.brakeLightMats || null;
          if (Array.isArray(bl) && bl.length) {
            const inten = (brake01 > 1e-4) ? (0.2 + 3.0 * brake01) : 0.0;
            for (const m of bl) {
              if (!m) continue;
              try { m.emissiveIntensity = inten; } catch { /* ignore */ }
            }
          }

          const lightsOn = !!fx.lightsOn;
          const tail = fx?.tailLightMats || null;
          if (Array.isArray(tail) && tail.length) {
            const inten = lightsOn ? 0.35 : 0.0;
            for (const m of tail) { if (m) { try { m.emissiveIntensity = Math.max(Number(m.emissiveIntensity) || 0, inten); } catch { /* ignore */ } } }
          }
          const head = fx?.headLightMats || null;
          if (Array.isArray(head) && head.length) {
            const inten = lightsOn ? 1.35 : 0.0;
            for (const m of head) { if (m) { try { m.emissiveIntensity = inten; } catch { /* ignore */ } } }
          }
          const rev = fx?.reverseLightMats || null;
          if (Array.isArray(rev) && rev.length) {
            const isReversing = (gear < 0) || (speedSigned < -0.6);
            const inten = isReversing ? 1.2 : 0.0;
            for (const m of rev) { if (m) { try { m.emissiveIntensity = inten; } catch { /* ignore */ } } }
          }

          const indL = fx?.indicatorLeftMats || null;
          const indR = fx?.indicatorRightMats || null;
          const mode = String(fx?.indicatorMode || 'off');
          const onL = (mode === 'left' || mode === 'hazard') && blinkOn;
          const onR = (mode === 'right' || mode === 'hazard') && blinkOn;
          if (Array.isArray(indL) && indL.length) {
            const inten = onL ? 2.2 : 0.0;
            for (const m of indL) { if (m) { try { m.emissiveIntensity = inten; } catch { /* ignore */ } } }
          }
          if (Array.isArray(indR) && indR.length) {
            const inten = onR ? 2.2 : 0.0;
            for (const m of indR) { if (m) { try { m.emissiveIntensity = inten; } catch { /* ignore */ } } }
          }

          const rb = fx?.rimBlurMeshes || null;
          if (Array.isArray(rb) && rb.length) {
            const showBlur = speedAbs > 12.0;
            for (const mesh of rb) {
              if (!mesh) continue;
              mesh.visible = !!showBlur;
            }
          }

          const steerMeshes = fx?.steerMeshes || null;
          if (Array.isArray(steerMeshes) && steerMeshes.length) {
            // Best-effort steering wheel animation.
            const s = clamp(Number(v.steer) || 0, -1, 1);
            let lockDeg = NaN;
            let ratio = NaN;
            try { lockDeg = Number(v?.acTuning?.debug?.steerLockDeg); } catch { /* ignore */ }
            try { ratio = Number(v?.acTuning?.debug?.steerRatio); } catch { /* ignore */ }
            let wheelLockDeg = NaN;
            if (Number.isFinite(lockDeg) && lockDeg > 0) {
              if (lockDeg > 90) wheelLockDeg = lockDeg; // likely already steering wheel lock (per-side)
              else if (Number.isFinite(ratio) && ratio > 0.1) wheelLockDeg = lockDeg * ratio; // wheel angle -> wheel lock
              else wheelLockDeg = lockDeg * 14.0;
            }
            if (!(Number.isFinite(wheelLockDeg) && wheelLockDeg > 0)) wheelLockDeg = 360;
            const wheelAngle = s * degToRad(clamp(wheelLockDeg, 90, 1080));

            const q = this._tmpSteerQ;
            for (const it of steerMeshes) {
              const pivot = it?.pivot || null;
              if (!pivot) continue;
              const axis = it?.axis || null;
              const base = it?.baseQuat || null;
              try {
                q.setFromAxisAngle(axis || new THREE.Vector3(0, 0, 1), wheelAngle);
                if (base && pivot.quaternion) pivot.quaternion.copy(base).multiply(q);
              } catch { /* ignore */ }
            }
          }
        }
      } catch { /* ignore */ }

      try {
        const va = v?.anim || null;
        const mx = va?.mixer || null;
        if (mx) {
          const speedAbs = Math.abs(Number(v.speed) || 0);
          const steer01 = clamp01(Math.abs(Number(v.steer) || 0));
          const setChannel = (arr, weight, ts) => {
            for (const a of (Array.isArray(arr) ? arr : [])) {
              if (!a) continue;
              try {
                a.enabled = true;
                a.setEffectiveWeight(Math.max(0, Number(weight) || 0));
                a.setEffectiveTimeScale(Number(ts) || 0);
              } catch { /* ignore */ }
            }
          };
          setChannel(va.idle, 1.0, 1.0);
          setChannel(va.drive, clamp01(speedAbs / 3.5), Math.max(0, Math.min(4, speedAbs * 0.22)));
          setChannel(va.wheel, clamp01(speedAbs / 2.0), Math.max(0, Math.min(8, speedAbs * 0.55)));
          setChannel(va.suspension, clamp01(speedAbs / 6.0), Math.max(0, Math.min(3, speedAbs * 0.16)));
          const steerTs = (Number(v.steer) >= 0) ? 1.0 : -1.0;
          setChannel(va.steering, steer01, steer01 > 0.02 ? steerTs : 0.0);
          const inVehDriver = !!inVeh && this._vehicleCtx?.role === 'driver' && safeTrim(this._vehicleCtx?.vehicleId) === safeTrim(v?.id);
          const fireOn = inVehDriver && !!this.host?._mouseDown;
          setChannel(va.combat, fireOn ? 1.0 : 0.0, fireOn ? 1.0 : 0.0);
          mx.update(dts);
        }
      } catch { /* ignore */ }
    }

    // If the player is no longer driving, ensure synth is stopped (covers vehicle deletion edge-cases).
    try {
      const a = this._vehAudio;
      const isDrivingNow = !!inVeh && this._vehicleCtx?.role === 'driver' && this._state.mode === 'fps';
      if (a?.synth && !isDrivingNow) this._stopVehicleSynth({ fadeSec: 0.12 });
    } catch { /* ignore */ }

    if (inVeh) {
      const v = this._vehicles.find((x) => x.id === this._vehicleCtx.vehicleId) || null;
      if (v?.group) {
        // Keep view rotating with the car, so first-person feels like you're seated
        // (mouse look remains relative due to pointer-lock).
        try {
          if (this._camera) {
            const last = Number(this._vehicleCtx.lastVehicleYaw);
            if (Number.isFinite(last)) {
              const dy = (Number(v.yaw) || 0) - last;
              if (Number.isFinite(dy) && Math.abs(dy) > 1e-9) this._camera.rotation.y += dy;
            }
          }
        } catch { /* ignore */ }
        this._vehicleCtx.lastVehicleYaw = Number(v.yaw) || 0;
        this._snapCameraToVehicleSeat(v, this._vehicleCtx.seatId, dts);
      }
    }

    this._vehicleBoxes = [];
    for (const v of (this._vehicles || [])) {
      if (!v?.group) continue;
      try {
        const b = new THREE.Box3().setFromObject(v.group);
        this._vehicleBoxes.push(b);
      } catch { /* ignore */ }
    }
  }

  _tickVehicleHud(dt) {
    const hud = this._ensureVehicleHud();
    const root = hud?.root || null;
    if (!root) return;

    const inVeh = !!this._vehicleCtx?.inVehicle;
    const isDriverSeat = safeTrim(this._vehicleCtx?.role) === 'driver' || safeTrim(this._vehicleCtx?.seatId) === 'driver';
    const canShow = !!this._drivingEnabled && inVeh && isDriverSeat;
    if (!canShow) {
      root.style.display = 'none';
      return;
    }

    const vid = safeTrim(this._vehicleCtx?.vehicleId || '');
    const v = (this._vehicles || []).find((x) => safeTrim(x?.id) === vid) || null;
    if (!v) {
      root.style.display = 'none';
      return;
    }

    root.style.display = 'block';

    const speedAbs = Math.abs(Number(v.speed) || 0);
    const speedKph = speedAbs * 3.6;

    const drive = (v?.drive && typeof v.drive === 'object') ? v.drive : null;
    const tune = (v?.acTuning?.simTuning && typeof v.acTuning.simTuning === 'object') ? v.acTuning.simTuning : (v?.simCreateOptions?.js || null);
    const idleRpm = Math.max(600, Number(tune?.idleRpm) || 950);
    const limRpm = Math.max(idleRpm + 500, Number(tune?.limiterRpm) || 7200);

    // Prefer cached RPM from audio estimator; fallback to an on-the-fly estimate.
    let rpm = Number(drive?.rpm);
    if (!Number.isFinite(rpm) || rpm <= 0) {
      const wheelR = Math.max(0.05, Number(tune?.wheelRadius) || Number(v?.parts?.wheelRadius) || 0.34);
      const finalRatio = Number(tune?.finalRatio) || 0;
      const gears = Array.isArray(tune?.gearRatios) ? tune.gearRatios : [];
      const gearN = Math.max(1, Math.min(16, Math.floor(Number(drive?.gearN) || 1)));
      const ratio = (gears.length && gearN >= 1 && gearN <= gears.length) ? Number(gears[gearN - 1]) : (gears.length ? Number(gears[0]) : 0);
      const rpmFromSpeed = (wheelR > 0.05 && finalRatio > 0.01 && ratio > 0.01)
        ? ((speedAbs / wheelR) * (ratio * finalRatio) * (60 / (2 * Math.PI)))
        : NaN;
      rpm = Number.isFinite(rpmFromSpeed) ? rpmFromSpeed : idleRpm;
    }
    rpm = clamp(Number(rpm) || idleRpm, idleRpm, limRpm);

    const lastGear = Number(drive?.lastGear) || Number(drive?.last?.gear) || 1;
    const gearDisp = (lastGear < 0)
      ? 'R'
      : ((this._vehicleSimKind === 'wasm') ? 'D' : String(Math.max(1, Math.floor(Number(drive?.gearN) || 1))));

    const odoM = Math.max(0, Number(drive?.odoM) || 0);
    const odoKm = odoM / 1000;

    const rpm01 = clamp01((rpm - idleRpm) / Math.max(1, (limRpm - idleRpm)));
    const th01 = clamp01(Number(drive?.lastThrottle01) || Number(drive?.last?.throttle01) || 0);
    const br01 = clamp01(Number(drive?.lastBrake01) || Number(drive?.last?.brake01) || 0);
    const hbOn = !!this._keysDown?.has?.('Space') || (Number(drive?.last?.handbrake01) || 0) > 0.5;

    try { if (hud.speedVal) hud.speedVal.textContent = String(Math.max(0, Math.round(speedKph))); } catch { /* ignore */ }
    try { if (hud.gearVal) hud.gearVal.textContent = gearDisp; } catch { /* ignore */ }
    try { if (hud.rpmVal) hud.rpmVal.textContent = `${Math.round(rpm)} rpm`; } catch { /* ignore */ }
    try {
      if (hud.gearVal && this._vehicleSimKind === 'wasm') {
        hud.gearVal.title = 'Gear display: WASM backend (auto; manual forward gears not supported)';
      } else if (hud.gearVal) {
        hud.gearVal.title = 'Gear display: JS backend (manual forward gears supported)';
      }
    } catch { /* ignore */ }
    try { if (hud.odoVal) hud.odoVal.textContent = `${odoKm.toFixed(2)} km`; } catch { /* ignore */ }
    try { if (hud.rpmBarFill) hud.rpmBarFill.style.width = `${(rpm01 * 100).toFixed(1)}%`; } catch { /* ignore */ }
    try { if (hud.throttleFill) hud.throttleFill.style.width = `${(th01 * 100).toFixed(1)}%`; } catch { /* ignore */ }
    try { if (hud.brakeFill) hud.brakeFill.style.width = `${(br01 * 100).toFixed(1)}%`; } catch { /* ignore */ }
    try {
      if (hud.camTag) {
        const cm = (this._vehicleCtx?.camMode === 'third') ? '3P' : '1P';
        hud.camTag.textContent = `CAM ${cm}`;
      }
    } catch { /* ignore */ }
    try {
      if (hud.hbTag) {
        hud.hbTag.textContent = 'HB';
        hud.hbTag.style.opacity = hbOn ? '0.98' : '0.65';
        hud.hbTag.style.background = hbOn ? 'rgba(255,90,90,0.22)' : 'rgba(255,255,255,0.06)';
        hud.hbTag.style.borderColor = hbOn ? 'rgba(255,90,90,0.55)' : 'rgba(255,255,255,0.12)';
      }
    } catch { /* ignore */ }
  }

  _nearestVehicleDoor(maxDist = 1.6) {
    const px = Number(this._player.x);
    const py = Number(this._player.y) + 1.0;
    const pz = Number(this._player.z);
    if (![px, py, pz].every((v) => Number.isFinite(v))) return null;
    const toV3 = (p, fbX = 0, fbY = 0, fbZ = 0) => {
      try {
        if (p && typeof p.clone === 'function') return p.clone();
        if (Array.isArray(p) && p.length >= 3) return new THREE.Vector3(Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0);
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) return new THREE.Vector3(Number(p.x), Number(p.y), Number(p.z));
      } catch { /* ignore */ }
      return new THREE.Vector3(fbX, fbY, fbZ);
    };
    let best = null;
    let bestD = Infinity;
    for (const v of (this._vehicles || [])) {
      for (const d of (v?.doors || [])) {
        const wp = toV3(d?.localPos);
        wp.applyEuler(v.group.rotation);
        wp.add(v.group.position);
        const dd = Math.hypot(wp.x - px, wp.z - pz);
        const dynamicMaxDist = Math.max(Number(maxDist) || 1.6, Math.min(24.0, Math.max(0, Number(v?.radius) || 0) * 0.35));
        if (dd < bestD) { bestD = dd; best = { vehicle: v, door: d, doorWorld: wp, dist: dd, maxDist: dynamicMaxDist }; }
      }
    }
    if (!best) return null;
    if (bestD > (Number(best.maxDist) || Number(maxDist) || 1.6)) return null;
    return best;
  }

  _nearestVehicleEnterCandidate(maxDist = 1.6) {
    const px = Number(this._player.x);
    const py = Number(this._player.y) + 1.0;
    const pz = Number(this._player.z);
    if (![px, py, pz].every((v) => Number.isFinite(v))) return null;

    const nearDoor = this._nearestVehicleDoor(maxDist);
    if (nearDoor) return { ...nearDoor, seatId: nearDoor?.door?.seatId || '' };

    let best = null;
    let bestD = Infinity;
    for (const v of (this._vehicles || [])) {
      if (!v?.group) continue;
      const dd = Math.hypot((Number(v.group.position.x) || 0) - px, (Number(v.group.position.z) || 0) - pz);
      const enterDist = Math.max(Number(maxDist) || 1.6, Math.min(6.0, Math.max(0, Number(v?.radius) || 0) * 0.55));
      if (dd < bestD && dd <= enterDist) {
        bestD = dd;
        best = { vehicle: v, door: null, doorWorld: null, dist: dd, maxDist: enterDist, seatId: 'driver' };
      }
    }
    return best;
  }

  _tryEnterVehicle() {
    if (this._vehicleCtx.inVehicle) {
      const v0 = this._vehicles.find((x) => x.id === this._vehicleCtx.vehicleId) || null;
      if (!v0) return false;
      if (this._vehicleCtx.role === 'driver') return false;
      const curSeatId = safeTrim(this._vehicleCtx.seatId);
      const drvSeat = v0.seats.find((s) => s.id === 'driver' && s.role === 'driver') || null;
      if (!drvSeat) return false;
      const drvOcc = v0.occ?.get('driver') || null;
      if (drvOcc && drvOcc !== 'player') {
        this._showMsg('Driver seat occupied', 0.8);
        return false;
      }
      try { if (curSeatId) v0.occ.set(curSeatId, null); } catch { /* ignore */ }
      try { v0.occ.set('driver', 'player'); } catch { /* ignore */ }
      this._vehicleCtx.seatId = 'driver';
      this._vehicleCtx.role = 'driver';
      this._vehicleCtx.lastVehicleYaw = Number(v0.yaw) || 0;
      this._snapCameraToVehicleSeat(v0, 'driver', 1 / 60);
      this._showMsg('Driving (F to exit)', 0.8);
      return true;
    }
    const near = this._nearestVehicleEnterCandidate();
    if (!near) return false;
    const v = near.vehicle;
    const seatId = safeTrim(near?.seatId || near?.door?.seatId || '');
    if (!v || !seatId) return false;

    const occ = v.occ?.get(seatId) || null;
    const seat = v.seats.find((s) => s.id === seatId);
    if (!seat) return false;

    if (seatId === 'driver' && occ) {
      const free = v.seats.find((s) => s.id !== 'driver' && !v.occ.get(s.id));
      if (free) v.occ.set(free.id, occ);
      v.occ.set('driver', null);
      this._ctx?.toast?.('Took driver seat', 'warning', { title: 'Vehicle' });
    }

    if (v.occ.get(seatId)) {
      this._showMsg('Seat occupied', 0.8);
      return false;
    }

    const prevMode = String(this._state?.mode || 'fps');
    if (prevMode === 'orbit') {
      this._state.mode = 'fps';
      this.host?._savePrefs?.();
      this.host?._syncModeUi?.();
    }

    v.occ.set(seatId, 'player');
    this._vehicleCtx = {
      inVehicle: true,
      vehicleId: v.id,
      seatId,
      role: seat.role,
      camMode: 'first',
      lastVehicleYaw: Number(v.yaw) || 0,
      prevMode,
    };

    this._player.x = v.group.position.x;
    this._player.z = v.group.position.z;
    this._player.y = 0;
    this._player.vy = 0;
    this._snapCameraToVehicleSeat(v, seatId, 1 / 60);
    this._showMsg(seat.role === 'driver' ? 'Driving (F to exit)' : 'Passenger (F to exit)', 1.0);
    try { if (this._state.mode === 'fps' && !this._plock?.isLocked) this._tryPointerLock('enter_vehicle'); } catch { /* ignore */ }
    return true;
  }

  _tryExitVehicle() {
    if (!this._vehicleCtx.inVehicle) return false;
    const v = this._vehicles.find((x) => x.id === this._vehicleCtx.vehicleId);
    if (!v) { this._vehicleCtx = { inVehicle: false, vehicleId: '', seatId: '', role: '', camMode: 'first', lastVehicleYaw: 0, prevMode: 'fps' }; return true; }
    const seatId = this._vehicleCtx.seatId;
    try { if (seatId) v.occ.set(seatId, null); } catch { /* ignore */ }

    const door = v.doors.find((d) => d.seatId === seatId) || v.doors[0];
    let out = v.group.position.clone();
    if (door) {
      try {
        if (door?.localPos && typeof door.localPos.clone === 'function') out = door.localPos.clone();
        else if (Array.isArray(door?.localPos) && door.localPos.length >= 3) out = new THREE.Vector3(Number(door.localPos[0]) || 0, Number(door.localPos[1]) || 0, Number(door.localPos[2]) || 0);
        else if (door?.localPos && Number.isFinite(door.localPos.x) && Number.isFinite(door.localPos.y) && Number.isFinite(door.localPos.z)) out = new THREE.Vector3(Number(door.localPos.x), Number(door.localPos.y), Number(door.localPos.z));
      } catch { /* ignore */ }
      out.applyEuler(v.group.rotation);
      out.add(v.group.position);
    }

    const vehicleCenter = v.group?.position?.clone?.() || new THREE.Vector3(0, 0, 0);
    let outward = new THREE.Vector3(out.x - vehicleCenter.x, 0, out.z - vehicleCenter.z);
    if (outward.lengthSq() < 1e-6) {
      const sideSign = Math.sign(Number(door?.localPos?.x) || 0) || 1;
      outward.set(Math.cos((Number(v.yaw) || 0) + (Math.PI * 0.5)) * sideSign, 0, Math.sin((Number(v.yaw) || 0) + (Math.PI * 0.5)) * sideSign);
    }
    outward.normalize();
    const side = new THREE.Vector3(-outward.z, 0, outward.x);
    const safeR = Math.max(0.22, Number(this._player?.radius) || 0.35);
    const candidates = [];
    const pushD = [0.0, 0.45, 0.8, 1.15, 1.5, 1.9, 2.4];
    for (const d of pushD) {
      candidates.push(new THREE.Vector3(out.x + outward.x * d, 0, out.z + outward.z * d));
      if (d >= 0.8) {
        candidates.push(new THREE.Vector3(out.x + outward.x * d + side.x * 0.45, 0, out.z + outward.z * d + side.z * 0.45));
        candidates.push(new THREE.Vector3(out.x + outward.x * d - side.x * 0.45, 0, out.z + outward.z * d - side.z * 0.45));
      }
    }
    candidates.push(new THREE.Vector3(vehicleCenter.x + outward.x * 2.8, 0, vehicleCenter.z + outward.z * 2.8));
    let placed = null;
    for (const c of candidates) {
      if (!Number.isFinite(c.x) || !Number.isFinite(c.z)) continue;
      if (this._collidesAtRadius(c.x, 0, c.z, safeR)) continue;
      placed = c;
      break;
    }
    if (!placed) {
      const sx = Number(this.host?._spawn?.x);
      const sz = Number(this.host?._spawn?.z);
      if (Number.isFinite(sx) && Number.isFinite(sz) && !this._collidesAtRadius(sx, 0, sz, safeR)) {
        placed = new THREE.Vector3(sx, 0, sz);
      } else {
        placed = new THREE.Vector3(out.x, 0, out.z);
      }
    }

    this._player.x = placed.x;
    this._player.z = placed.z;
    this._player.y = 0;
    this._player.vy = 0;
    if (this._camera) this._camera.position.set(this._player.x, this._player.y + this._player.eyeH, this._player.z);

    // Restore camera projection settings changed for cockpit view.
    try {
      const cam = /** @type {any} */ (this._camera);
      if (cam?.isPerspectiveCamera && cam?.userData) {
        const prevNear = Number(cam.userData.__vehPrevNear);
        const prevFov = Number(cam.userData.__vehPrevFov);
        if (Number.isFinite(prevNear) && prevNear > 0) cam.near = prevNear;
        if (Number.isFinite(prevFov) && prevFov > 1) cam.fov = prevFov;
        delete cam.userData.__vehPrevNear;
        delete cam.userData.__vehPrevFov;
        try { cam.updateProjectionMatrix?.(); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    // Restore any cockpit-hidden meshes.
    try {
      const fx = v?.fx || null;
      const prev = fx && Array.isArray(fx.cockpitRestore) ? fx.cockpitRestore : [];
      if (fx && fx.cockpitHidden && prev.length) {
        for (const rec of prev) {
          try { if (rec?.mesh) rec.mesh.visible = !!rec.visible; } catch { /* ignore */ }
        }
      }
      if (fx) {
        fx.cockpitRestore = [];
        fx.cockpitHidden = false;
      }
    } catch { /* ignore */ }

    const restore = String(this._vehicleCtx?.prevMode || 'fps');
    this._vehicleCtx = { inVehicle: false, vehicleId: '', seatId: '', role: '', camMode: 'first', lastVehicleYaw: 0, prevMode: 'fps' };
    // Clear stuck inputs on exit too (keyup can be missed during focus/pointer-lock transitions).
    try { this._keysDown?.clear?.(); } catch { /* ignore */ }
    try { this._keysPressed?.clear?.(); } catch { /* ignore */ }
    if (restore === 'orbit') {
      this._state.mode = 'orbit';
      this.host?._savePrefs?.();
      this.host?._syncModeUi?.();
    }
    this._showMsg('Exited vehicle', 0.6);
    return true;
  }

  _snapCameraToVehicleSeat(v, seatId, dt = 1 / 60) {
    if (!this._camera || !v) return;
    const seat = v.seats.find((s) => s.id === seatId) || v.seats[0];
    const mode = (this._vehicleCtx?.camMode === 'third') ? 'third' : 'first';
    const dts = Math.max(0, Number(dt) || 0);

    const setCockpitVisibility = (on) => {
      const fx = v?.fx || null;
      if (!fx) return;
      // Only do this for driver first-person; passengers should see full exterior.
      const isDriver = safeTrim(seatId) === 'driver';
      if (!isDriver) on = false;
      const prev = Array.isArray(fx.cockpitRestore) ? fx.cockpitRestore : [];
      const already = !!fx.cockpitHidden;
      if (!!on === already) return;

      if (!on) {
        for (const rec of prev) {
          try { if (rec?.mesh) rec.mesh.visible = !!rec.visible; } catch { /* ignore */ }
        }
        fx.cockpitRestore = [];
        fx.cockpitHidden = false;
        return;
      }

      const restore = [];
      let keepCount = 0;
      const keepByName = (nm) => {
        if (!nm) return false;
        if (nm.includes('cockpit') || nm.includes('interior') || nm.includes('dash') || nm.includes('gauge') || nm.includes('needle')) return true;
        if (nm.includes('seat') || nm.includes('steer') || nm.includes('headliner') || nm.includes('carpet')) return true;
        if (nm.includes('glass') || nm.includes('window') || nm.includes('windscreen') || nm.includes('windshield') || nm.includes('mirror')) return true;
        return false;
      };
      const hideByName = (nm) => {
        if (!nm) return false;
        // Never hide wheels.
        if (/(^|[^a-z0-9])(wheel|tire|tyre|rim|hub)([^a-z0-9]|$)/.test(nm)) return false;
        // Common exterior shells.
        if (nm.includes('lod0_body')) return true;
        if (nm.includes('exterior')) return true;
        if (nm.includes('body') && !nm.includes('cockpit')) return true;
        // Keep hood/bumper/fenders visible for a more Assetto-like cockpit framing.
        // (Hiding too much makes it feel like a "roof cam" with no dash/hood reference.)
        // if (nm.includes('hood') || nm.includes('bonnet') || nm.includes('trunk') || nm.includes('boot')) return true;
        // if (nm.includes('bumper') || nm.includes('fender') || nm.includes('spoiler') || nm.includes('wing')) return true;
        if (nm.includes('door') && !nm.includes('interior')) return true;
        return false;
      };

      v.group?.traverse?.((n) => {
        const any = /** @type {any} */ (n);
        if (!any || !any.isMesh) return;
        const nm = safeTrim(any.name || '').toLowerCase();
        if (keepByName(nm)) {
          keepCount++;
          return;
        }
        if (!hideByName(nm)) return;
        restore.push({ mesh: any, visible: !!any.visible });
      });
      // Guard against "car disappears" on assets that don't expose interior mesh naming.
      // If we can't identify at least a few cockpit meshes to keep, avoid exterior hiding entirely.
      if (keepCount < 3) {
        fx.cockpitRestore = [];
        fx.cockpitHidden = false;
        return;
      }
      for (const rec of restore) {
        try { if (rec?.mesh) rec.mesh.visible = false; } catch { /* ignore */ }
      }
      fx.cockpitRestore = restore;
      fx.cockpitHidden = true;
    };

    if (mode === 'third') {
      try { this._camera.rotation.order = 'YXZ'; } catch { /* ignore */ }
      try { this._camera.rotation.x = clamp(this._camera.rotation.x, -1.15, 0.35); } catch { /* ignore */ }

      const target = v.group.position.clone();
      target.y += 1.25;
      const fwd = new THREE.Vector3();
      this._camera.getWorldDirection(fwd);
      if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, -1);
      fwd.normalize();

      const camDist = 7.2;
      const camLift = 1.1;
      const pos = target.clone().addScaledVector(fwd, -camDist);
      pos.y += camLift;
      this._camera.position.copy(pos);

      this._player.x = v.group.position.x;
      this._player.z = v.group.position.z;
      this._player.y = 0;

      // Third-person: restore default-ish camera clip/fov if we had overridden it.
      try {
        const cam = /** @type {any} */ (this._camera);
        if (cam?.isPerspectiveCamera && cam?.userData) {
          const prevNear = Number(cam.userData.__vehPrevNear);
          const prevFov = Number(cam.userData.__vehPrevFov);
          if (Number.isFinite(prevNear) && prevNear > 0) cam.near = prevNear;
          if (Number.isFinite(prevFov) && prevFov > 1) cam.fov = prevFov;
          try { cam.updateProjectionMatrix?.(); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      try { setCockpitVisibility(false); } catch { /* ignore */ }
      return;
    }

    const useDriverCameraAnchor = (safeTrim(seat?.id) === 'driver') && !!v?.cameraDriverLocal;
    let pLocal = new THREE.Vector3(0, 1.0, 0);
    try {
      if (useDriverCameraAnchor && v?.cameraDriverLocal && typeof v.cameraDriverLocal.clone === 'function') pLocal = v.cameraDriverLocal.clone();
      else if (seat?.localPos && typeof seat.localPos.clone === 'function') pLocal = seat.localPos.clone();
      else if (Array.isArray(seat?.localPos) && seat.localPos.length >= 3) pLocal = new THREE.Vector3(Number(seat.localPos[0]) || 0, Number(seat.localPos[1]) || 0, Number(seat.localPos[2]) || 0);
      else if (seat?.localPos && Number.isFinite(seat.localPos.x) && Number.isFinite(seat.localPos.y) && Number.isFinite(seat.localPos.z)) pLocal = new THREE.Vector3(Number(seat.localPos.x), Number(seat.localPos.y), Number(seat.localPos.z));
    } catch { /* ignore */ }

    // Seat anchors are base positions. Authored camera_driver is usually already eye-level,
    // but still benefits from a small forward offset to avoid sitting "inside" the headrest.
    try {
      if (useDriverCameraAnchor) {
        // Nudge down/forward a bit to match typical AC cockpit framing.
        pLocal.y -= 0.10;
        pLocal.z -= 0.18; // forward (local -Z)
      } else {
        // If the seat position came from an authored `anchors.driver`, it's often closer to head/upper-torso
        // than "seat base" height. Using a full +0.55m eye offset can push the camera into the roof.
        const seatFromAnchor = (safeTrim(seat?.id) === 'driver') && !!v?.driverSeatFromAnchor;
        pLocal.y += seatFromAnchor ? 0.16 : 0.55;
        pLocal.z -= seatFromAnchor ? 0.14 : 0.10;
      }
    } catch { /* ignore */ }

    const desired = pLocal.clone();
    // Convert from model-local to world using the actual model root transform.
    // This correctly handles `inst.scale` (and any future model-local transforms).
    try {
      const root = v?.modelRoot;
      if (root && typeof root.localToWorld === 'function') {
        root.updateMatrixWorld?.(true);
        root.localToWorld(desired);
      } else {
        desired.applyEuler(v.group.rotation);
        desired.add(v.group.position);
      }
    } catch {
      desired.applyEuler(v.group.rotation);
      desired.add(v.group.position);
    }

    // Cockpit view: reduce near clip and slightly widen FOV for interior.
    try {
      const cam = /** @type {any} */ (this._camera);
      if (cam?.isPerspectiveCamera) {
        cam.userData = cam.userData || {};
        if (cam.userData.__vehPrevNear == null) cam.userData.__vehPrevNear = Number(cam.near) || 0.1;
        if (cam.userData.__vehPrevFov == null) cam.userData.__vehPrevFov = Number(cam.fov) || 75;
        cam.near = 0.03;
        cam.fov = 78;
        try { cam.updateProjectionMatrix?.(); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    // Smooth camera position to reduce jitter on rough ground / substep corrections.
    const alpha = 1.0 - Math.exp(-18.0 * Math.min(0.05, dts || (1 / 60)));
    try {
      if (Number.isFinite(alpha) && alpha > 0 && alpha < 1) this._camera.position.lerp(desired, alpha);
      else this._camera.position.copy(desired);
    } catch {
      this._camera.position.copy(desired);
    }

    try { setCockpitVisibility(true); } catch { /* ignore */ }

    this._player.x = desired.x;
    this._player.z = desired.z;
    this._player.y = 0;
  }
}

