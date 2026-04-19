import { el, clear } from '../../ui/dom.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { parseDds } from './dds_loader.js';

function safeTrim(s) {
  return String(s ?? '').trim();
}

function computeLocalBounds(root) {
  // Compute an AABB in the root's *local* space (more stable than world AABB).
  const out = new THREE.Box3();
  out.makeEmpty();
  if (!root) return out;
  const invRootWorld = new THREE.Matrix4();
  try {
    root.updateMatrixWorld(true);
    invRootWorld.copy(root.matrixWorld).invert();
  } catch {
    // best-effort; if invert fails, fall back below
  }
  let any = false;
  try {
    root.traverse?.((n) => {
      if (!n) return;
      const mesh = /** @type {any} */ (n);
      const geo = mesh.geometry;
      if (!geo) return;
      if (!geo.boundingBox) {
        try { geo.computeBoundingBox?.(); } catch { /* ignore */ }
      }
      const bb = geo.boundingBox;
      if (!bb) return;
      const b = bb.clone();
      try { mesh.updateMatrixWorld?.(true); } catch { /* ignore */ }
      // geometry bb is in geometry local -> mesh world
      try { b.applyMatrix4(mesh.matrixWorld); } catch { return; }
      // mesh world -> root local
      try { b.applyMatrix4(invRootWorld); } catch { /* ignore */ }
      out.union(b);
      any = true;
    });
  } catch { /* ignore */ }
  if (!any) {
    try {
      // Fallback: world AABB (root is usually identity world anyway)
      out.setFromObject(root);
    } catch { /* ignore */ }
  }
  return out;
}

function clamp01(x) {
  const v = Number(x) || 0;
  return Math.max(0, Math.min(1, v));
}

function degToRad(deg) {
  return (Number(deg) || 0) * (Math.PI / 180);
}

function isNearIdentityQuat(q, eps = 1e-6) {
  if (!q) return true;
  const x = Number(q.x) || 0;
  const y = Number(q.y) || 0;
  const z = Number(q.z) || 0;
  const w = Number(q.w);
  const ww = Number.isFinite(w) ? w : 1;
  return (Math.abs(x) <= eps) && (Math.abs(y) <= eps) && (Math.abs(z) <= eps) && (Math.abs(ww - 1) <= eps);
}

function disposeVehiclesToolOwnedObject3D(root) {
  // IMPORTANT: We must not dispose geometry/material from wheel-model instances
  // because they share references with the cached wheel GLTF.
  try {
    root?.traverse?.((n) => {
      const any = /** @type {any} */ (n);
      if (!any?.userData?.__vehiclesToolOwned) return;
      try { any.geometry?.dispose?.(); } catch { /* ignore */ }
      const mat = any.material;
      const mats = Array.isArray(mat) ? mat : (mat ? [mat] : []);
      for (const m of mats) {
        if (!m) continue;
        for (const k of ['map', 'normalMap', 'metalnessMap', 'roughnessMap', 'emissiveMap', 'aoMap']) {
          const t = m[k];
          if (t && t.isTexture) {
            try { t.dispose?.(); } catch { /* ignore */ }
          }
        }
        try { m.dispose?.(); } catch { /* ignore */ }
      }
    });
  } catch { /* ignore */ }
}

function extOf(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i).toLowerCase() : '';
}

function bytesToMiB(bytes) {
  const b = Number(bytes) || 0;
  return (b / (1024 * 1024)).toFixed(2);
}

function fmtTime(ms) {
  const t = Number(ms) || 0;
  if (!t) return '';
  try { return new Date(t).toLocaleString(); } catch { return ''; }
}

function vehicleNameFromPath(relPath) {
  // relPath like: webautos/Abarth_124/stream/124spider_hi.glb
  const p = String(relPath || '').replace(/\\/g, '/');
  const parts = p.split('/').filter(Boolean);
  const i = parts.indexOf('webautos');
  if (i >= 0 && parts[i + 1]) return parts[i + 1];
  if (parts.length >= 2 && parts[0] === 'webautos') return parts[1];
  return '(unknown)';
}

function inferLodLabel(relPath) {
  const low = String(relPath || '').toLowerCase();
  if (low.includes('_hi.')) return 'hi';
  if (low.includes('_lod0.')) return 'lod0';
  if (low.includes('_lod1.')) return 'lod1';
  if (low.includes('_lod2.')) return 'lod2';
  return '';
}

export class VehiclesTool {
  constructor() {
    this.id = 'vehicles';
    this.label = 'Vehicles';

    this._ctx = null;
    this._root = null;

    this._state = {
      query: 'webautos/',
      search: '',
      onlyHi: true,
      sort: 'recent', // recent | name | size
      limit: 400,
    };

    /** @type {{ path: string, bytes: number, mtimeMs: number, url: string, vehicle: string, lod: string }[]} */
    this._items = [];
    /** @type {string} */
    this._selectedPath = '';

    this._statusEl = null;
    this._listEl = null;
    this._detailEl = null;

    this._lastRuntimeVehicleUrlSeen = '';

    // 3D preview
    this._canvas = null;
    this._renderer = null;
    this._scene = null;
    this._camera = null;
    this._controls = null;
    this._loader = new GLTFLoader();
    this._clock = new THREE.Clock();
    this._gltf = null;
    this._modelRoot = null;
    this._grid = null;
    this._axes = null;

    this._preview = {
      enabled: true,
      showGrid: true,
    };

    this._previewStatusEl = null;
    this._previewModelUrl = '';

    // Optional wheel placement metadata (.meta.json) and preview overlay helpers.
    /** @type {any|null} */
    this._meta = null;
    this._metaUrl = '';
    this._metaStatus = '';

    this._wheel = {
      // Bump this when persisted wheel overlay semantics change.
      settingsVersion: 2,
      enabled: true,
      showAnchors: true,
      showWheels: true,
      showRims: true,
      mode: 'model', // placeholder | model
      // Use a *relative* URL so it works in dist/ with base:'./' too.
      wheelUrl: 'external/polyhaven/old_tyre_2k/old_tyre_2k.gltf',
      // Interpretation:
      // - placeholder: (meta.wheelScale*) is treated as radius (meters)
      // - model: wheel model is auto-scaled so its outer radius matches (meta.wheelScale*)
      useMetaScale: true,
      frontScaleMul: 1.0,
      rearScaleMul: 1.0,
      placeholderWidth: 0.20,
      // Wheel model transform tweaks (degrees, applied after meta quat).
      rotXDeg: 0,
      rotYDeg: 0,
      rotZDeg: 0,
      flipRight: false,
      // Quick browsing helpers (optional; can paste a URL directly).
      browseQuery: 'assets/',
      browseSearch: 'wheel',
      browseLimit: 60,
    };

    this._wheelLoader = new GLTFLoader();
    this._wheelGltf = null;
    this._wheelGltfUrl = '';
    this._wheelGltfUrlResolved = '';
    this._wheelAssetInfo = null; // { root, alignQ, outerRadius, width }
    this._wheelModelStatus = '';
    this._wheelModelError = '';
    this._wheelModelLoading = false;
    /** @type {THREE.Group|null} */
    this._wheelGroup = null;
    this._wheelBrowseItems = [];

    // Assetto texture binding caches (VehiclesTool preview only).
    this._acTextureCache = new Map(); // url -> THREE.Texture
    this._acMaterialsCache = new Map(); // url -> { atMs, matsByName }
    this._acBindReport = null; // last bind report for current preview model
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
    const u = safeTrim(url);
    if (!u) return null;
    const cached = this._acTextureCache.get(u) || null;
    if (cached) return cached;

    const ext = String(u).toLowerCase().split('?')[0].split('#')[0];
    const isDds = ext.endsWith('.dds');
    const wantSrgb = (String(kind || 'diffuse').toLowerCase() === 'diffuse');

    const tryLoadSiblingPng = async () => {
      if (!isDds) return null;
      const u2 = String(u).replace(/\.dds(?=([?#]|$))/i, '.png');
      if (!u2 || u2 === u) return null;
      try {
        // Avoid noisy console errors from TextureLoader for 404s by probing first.
        const head = await fetch(u2, { method: 'HEAD', cache: 'no-store' });
        if (!head.ok) return null;
      } catch {
        return null;
      }
      try {
        const loader = new THREE.TextureLoader();
        const tex = await loader.loadAsync(u2);
        try { tex.flipY = false; } catch { /* ignore */ }
        try { tex.colorSpace = wantSrgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; } catch { /* ignore */ }
        try { tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping; } catch { /* ignore */ }
        try { tex.anisotropy = 4; } catch { /* ignore */ }
        try { tex.needsUpdate = true; } catch { /* ignore */ }
        this._acTextureCache.set(u2, tex);
        this._acTextureCache.set(u, tex);
        return tex;
      } catch {
        return null;
      }
    };

    try {
      // Prefer PNG/JPG path first (many exports include converted PNGs).
      if (isDds) {
        const tex = await tryLoadSiblingPng();
        if (tex) return tex;
      }

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

      // DDS fallback (best-effort; may still fail depending on browser extensions/format).
      const resp = await fetch(u, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const ab = await resp.arrayBuffer();
      const info = parseDds(ab);
      const blockBytes = this._acDdsBlockBytes(info);
      const fmt = this._acDdsThreeFormat(info);
      if (!blockBytes || !fmt) throw new Error(`Unsupported DDS (fourCC=${info?.fourCC} dxgi=${info?.dxgiFormat})`);

      // Best-effort capability guard: if the GPU can't upload this compressed format,
      // prefer returning null so the caller can fall back to heuristics (or PNG if present)
      // instead of "applying" a texture that will render black.
      try {
        const gl = this._renderer?.getContext?.() || null;
        if (gl && typeof gl.getExtension === 'function') {
          const fourCC = String(info?.fourCC || '');
          const dxgi = info?.dxgiFormat;
          if (fourCC === 'DXT1' || fourCC === 'DXT3' || fourCC === 'DXT5' || dxgi === 71 || dxgi === 74 || dxgi === 77) {
            const extS3tc = gl.getExtension('WEBGL_compressed_texture_s3tc');
            if (!extS3tc) throw new Error('DDS requires WEBGL_compressed_texture_s3tc');
          }
          if (fourCC === 'ATI1' || fourCC === 'ATI2' || dxgi === 80 || dxgi === 83) {
            const extRgtc = gl.getExtension('EXT_texture_compression_rgtc');
            if (!extRgtc) throw new Error('DDS requires EXT_texture_compression_rgtc');
          }
          if (dxgi === 95 || dxgi === 96 || dxgi === 98 || dxgi === 99) {
            const extBptc = gl.getExtension('EXT_texture_compression_bptc');
            if (!extBptc) throw new Error('DDS requires EXT_texture_compression_bptc');
          }
        }
      } catch {
        throw new Error('Unsupported compressed texture extension');
      }

      // Build mipmaps list.
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
      // Last chance: if DDS failed, retry PNG and cache under DDS URL.
      if (isDds) {
        const tex = await tryLoadSiblingPng();
        if (tex) return tex;
      }
      return null;
    }
  }

  async _loadAcMaterialsManifest(url) {
    const u = safeTrim(url);
    if (!u) return null;
    const now = Date.now();
    const cached = this._acMaterialsCache.get(u) || null;
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
          txDirty: safeTrim(samples.txDirty || ''),
          txBlur: safeTrim(samples.txBlur || ''),
          txNormalBlur: safeTrim(samples.txNormalBlur || ''),
          useDetail: (Number(props.useDetail) || 0) > 0,
          detailUVMultiplier: Number.isFinite(dmul) ? dmul : 0,
          ksSpecular: Number.isFinite(ksSpec) ? ksSpec : null,
          ksSpecularEXP: Number.isFinite(ksExp) ? ksExp : null,
          ksAlphaRef: Number.isFinite(ksAlphaRef) ? ksAlphaRef : null,
          ksEmissive: Number.isFinite(ksEmissive) ? ksEmissive : null,
        };
      }
      try { this._acMaterialsCache.set(u, { atMs: now, matsByName: out }); } catch { /* ignore */ }
      return out;
    } catch {
      return null;
    }
  }

  async _applyAcTexturesToRoot(root, cfgMeta) {
    const texDir = safeTrim(cfgMeta?.acTextureDirUrl || '');
    const matsEmbedded = (cfgMeta?.acMaterials && typeof cfgMeta.acMaterials === 'object') ? cfgMeta.acMaterials : null;
    const matsUrl = safeTrim(cfgMeta?.acMaterialsUrl || '');
    const matsFromUrl = matsUrl ? await this._loadAcMaterialsManifest(matsUrl) : null;
    const mats = (() => {
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
    const matsExactLo = new Map();
    /** @type {Map<string, { name: string, rec: any }[]>} */
    const matsIndex = new Map();
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

    const phongExpToRoughness = (exp) => {
      const e = Math.max(0.0, Number(exp) || 0.0);
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
        m = ensurePhysical(mesh, m);
        try { m.metalness = Math.max(0.10, Math.min(0.6, Number(m.metalness) || 0.2)); } catch { /* ignore */ }
        try { m.roughness = Math.min(0.35, Math.max(0.08, Number(m.roughness) || 0.22)); } catch { /* ignore */ }
        try { m.clearcoat = 0.9; } catch { /* ignore */ }
        try { m.clearcoatRoughness = Math.min(0.28, Math.max(0.04, (Number(m.roughness) || 0.2) * 0.7)); } catch { /* ignore */ }
        try { if (m.envMapIntensity != null) m.envMapIntensity = 1.6; } catch { /* ignore */ }
      } else if (isGlass) {
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

    const report = {
      atMs: Date.now(),
      texDir,
      matsUrl,
      materialsSeen: 0,
      materialsMatched: 0,
      materialsUnmatched: /** @type {string[]} */ ([]),
      textureFailures: /** @type {{ material: string, kind: string, tex: string, url: string }[]} */ ([]),
      applied: { diffuse: 0, normal: 0, maps: 0, mask: 0, emissive: 0 },
      adjusted: { transparency: 0, alphaTest: 0, heuristicPbr: 0 },
    };
    const seenNames = new Set();
    const matchedNames = new Set();

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
        const primaryName = safeTrim(m.name || mesh.name || '');
        if (primaryName && !seenNames.has(primaryName)) { seenNames.add(primaryName); report.materialsSeen++; }
        if (!rec || typeof rec !== 'object') {
          continue;
        }
        if (primaryName && !matchedNames.has(primaryName)) { matchedNames.add(primaryName); report.materialsMatched++; }

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

        // Alpha test / transparency heuristics (helps glass + cutouts look correct).
        try {
          const nmLo = safeTrim(m?.name || '').toLowerCase();
          const shLo = shaderName.toLowerCase();
          if (Number.isFinite(ksAlphaRef) && ksAlphaRef > 0) {
            try { m.alphaTest = Math.max(0.0, Math.min(1.0, ksAlphaRef)); } catch { /* ignore */ }
            try { report.adjusted.alphaTest++; } catch { /* ignore */ }
          }
          const wantsTransparent = shLo.includes('alpha') || shLo.startsWith('ksperpixelat') || nmLo.includes('glass') || nmLo.includes('window') || nmLo.includes('headlight');
          if (wantsTransparent) {
            try { m.transparent = true; } catch { /* ignore */ }
            try { m.depthWrite = false; } catch { /* ignore */ }
            try {
              const o = Number(m.opacity);
              m.opacity = Number.isFinite(o) ? Math.min(0.75, Math.max(0.15, o)) : 0.35;
            } catch { /* ignore */ }
            try { report.adjusted.transparency++; } catch { /* ignore */ }
          }
        } catch { /* ignore */ }

        if (txDiffuse) {
          const u = join(texDir, txDiffuse);
          tasks.push(this._loadAcTexture(u, { kind: 'diffuse' }).then((t) => {
            if (!t) { report.textureFailures.push({ material: primaryName, kind: 'diffuse', tex: txDiffuse, url: u }); return; }
            try { if (m.color && typeof m.color.set === 'function') m.color.set(0xffffff); } catch { /* ignore */ }
            m.map = t;
            try { m.needsUpdate = true; } catch { /* ignore */ }
            try { report.applied.diffuse++; } catch { /* ignore */ }
          }));
        }
        if (txNormal) {
          const u = join(texDir, txNormal);
          tasks.push(this._loadAcTexture(u, { kind: 'normal' }).then((t) => {
            if (!t) { report.textureFailures.push({ material: primaryName, kind: 'normal', tex: txNormal, url: u }); return; }
            m.normalMap = t;
            try {
              if (m.normalScale && typeof m.normalScale.set === 'function') m.normalScale.set(1, -1);
              else m.normalScale = new THREE.Vector2(1, -1);
            } catch { /* ignore */ }
            try { m.needsUpdate = true; } catch { /* ignore */ }
            try { report.applied.normal++; } catch { /* ignore */ }
          }));
        }
        if (txMaps) {
          const u = join(texDir, txMaps);
          tasks.push(this._loadAcTexture(u, { kind: 'linear' }).then((t) => {
            if (!t) { report.textureFailures.push({ material: primaryName, kind: 'maps', tex: txMaps, url: u }); return; }
            try { if (!m.roughnessMap) m.roughnessMap = t; } catch { /* ignore */ }
            try { if (!m.metalnessMap) m.metalnessMap = t; } catch { /* ignore */ }
            try { if (!Number.isFinite(Number(m.roughness))) m.roughness = 1.0; } catch { /* ignore */ }
            try { if (!Number.isFinite(Number(m.metalness))) m.metalness = 0.0; } catch { /* ignore */ }
            try { m.needsUpdate = true; } catch { /* ignore */ }
            try { report.applied.maps++; } catch { /* ignore */ }
          }));
        }
        if (txMask) {
          const u = join(texDir, txMask);
          tasks.push(this._loadAcTexture(u, { kind: 'linear' }).then((t) => {
            if (!t) { report.textureFailures.push({ material: primaryName, kind: 'mask', tex: txMask, url: u }); return; }
            try { if (!m.roughnessMap) m.roughnessMap = t; } catch { /* ignore */ }
            try { if (!m.metalnessMap) m.metalnessMap = t; } catch { /* ignore */ }
            try { if (!Number.isFinite(Number(m.roughness))) m.roughness = 1.0; } catch { /* ignore */ }
            try { if (!Number.isFinite(Number(m.metalness))) m.metalness = 0.0; } catch { /* ignore */ }
            try { m.needsUpdate = true; } catch { /* ignore */ }
            try { report.applied.mask++; } catch { /* ignore */ }
          }));
        }
        if (txDetail) {
          tasks.push(this._loadAcTexture(join(texDir, txDetail), { kind: 'linear' }));
        }
        if (txEmissive && txEmissive.toLowerCase() !== 'null.png') {
          const u = join(texDir, txEmissive);
          tasks.push(this._loadAcTexture(u, { kind: 'diffuse' }).then((t) => {
            if (!t) { report.textureFailures.push({ material: primaryName, kind: 'emissive', tex: txEmissive, url: u }); return; }
            try { m.emissiveMap = t; } catch { /* ignore */ }
            try {
              if (m.emissive && typeof m.emissive.set === 'function') m.emissive.set(0xffffff);
              else m.emissive = new THREE.Color(0xffffff);
            } catch { /* ignore */ }
            try { if (Number.isFinite(Number(m.emissiveIntensity))) m.emissiveIntensity = Math.max(0.1, Number(m.emissiveIntensity) || 1.0); } catch { /* ignore */ }
            try { m.needsUpdate = true; } catch { /* ignore */ }
            try { report.applied.emissive++; } catch { /* ignore */ }
          }));
        }

        // Heuristic fallback when packed maps textures aren't usable (often BC7).
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
            try { report.adjusted.heuristicPbr++; } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }
    });

    if (tasks.length) {
      try { await Promise.all(tasks); } catch { /* ignore */ }
    }

    // Finalize bind report for UI.
    try {
      const out = [];
      for (const nm of seenNames) {
        if (!matchedNames.has(nm)) out.push(nm);
      }
      out.sort();
      report.materialsUnmatched = out.slice(0, 200);
    } catch { /* ignore */ }
    this._acBindReport = report;
    try { this._syncDetails(); } catch { /* ignore */ }
  }

  async mount(ctx) {
    this._ctx = ctx;
    this._root = ctx.uiRoot;
    // Restore persisted wheel overlay settings (best-effort).
    try {
      const s = JSON.parse(String(localStorage.getItem('devtools.vehicles.wheelOverlay') || 'null'));
      if (s && typeof s === 'object') {
        // Migrate older settings (pre settingsVersion).
        // Old UI accidentally suggested rotZ=90, which makes wheels appear "laid flat".
        const sv = Number(s?.settingsVersion) || 0;
        /** @type {any} */
        const migrated = { ...s };
        if (sv < 2) {
          const rx = Number(migrated?.rotXDeg) || 0;
          const ry = Number(migrated?.rotYDeg) || 0;
          const rz = Number(migrated?.rotZDeg);
          // Only auto-correct the common accidental case: (rx,ry)≈0 and rz exactly 90.
          if (Math.abs(rx) < 1e-6 && Math.abs(ry) < 1e-6 && (rz === 90 || rz === -270)) {
            migrated.rotZDeg = 0;
          }
          migrated.settingsVersion = 2;
        }
        this._wheel = { ...this._wheel, ...migrated };
      }
    } catch { /* ignore */ }
    this._mountPreviewCanvas();
    this._buildUi();
    await this._refresh();
  }

  async unmount() {
    try { this._disposePreview(); } catch { /* ignore */ }
    try { this._disposeWheelModel(); } catch { /* ignore */ }
    this._ctx = null;
    this._root = null;
  }

  tick() {
    // If some other tool changed the runtime vehicle url, reflect it.
    try {
      const cur = safeTrim(localStorage.getItem('gameplay.vehicleUrl') || '');
      if (cur && cur !== this._lastRuntimeVehicleUrlSeen) {
        this._lastRuntimeVehicleUrlSeen = cur;
        // Select the matching path if we have it.
        const rel = cur.startsWith('/') ? cur.slice(1) : cur;
        if (rel && this._items.some((it) => it.path === rel)) {
          this._selectedPath = rel;
          this._syncDetails();
          this._syncListSelection();
        }
      }
    } catch { /* ignore */ }

    // Render preview (if enabled).
    try { this._tickPreview(); } catch { /* ignore */ }
  }

  getStats() {
    return {
      count: Array.isArray(this._items) ? this._items.length : 0,
      selected: this._selectedPath || '',
      query: this._state.query || '',
    };
  }

  _mountPreviewCanvas() {
    const ctx = this._ctx;
    if (!ctx?.canvasHost) return;

    // Canvas
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
    renderer.setClearColor(new THREE.Color(0x07090d), 1.0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this._renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x07090d);
    this._scene = scene;

    const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 200000);
    camera.position.set(3.0, 2.2, 4.0);
    this._camera = camera;

    const controls = new OrbitControls(camera, this._canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.target.set(0, 1, 0);
    this._controls = controls;

    // Lights
    scene.add(new THREE.HemisphereLight(0xdde8ff, 0x1a2230, 0.95));
    const dir = new THREE.DirectionalLight(0xffffff, 1.05);
    dir.position.set(6, 10, 4);
    scene.add(dir);

    // Grid + axes
    this._grid = new THREE.GridHelper(10, 10, 0x3a4a64, 0x223046);
    this._grid.material.opacity = 0.55;
    this._grid.material.transparent = true;
    scene.add(this._grid);
    this._axes = new THREE.AxesHelper(1.0);
    scene.add(this._axes);

    // Reset clock so dt behaves on mount.
    try { this._clock.elapsedTime = 0; } catch { /* ignore */ }
  }

  _disposePreview() {
    try { this._clearPreviewModel(); } catch { /* ignore */ }
    try { this._controls?.dispose?.(); } catch { /* ignore */ }
    try { this._renderer?.dispose?.(); } catch { /* ignore */ }
    this._controls = null;
    this._renderer = null;
    this._scene = null;
    this._camera = null;
    this._grid = null;
    this._axes = null;
    if (this._canvas?.parentNode) this._canvas.parentNode.removeChild(this._canvas);
    this._canvas = null;
  }

  _resizeCanvasToDisplaySize(maxDpr = 2.0) {
    const canvasEl = this._canvas;
    if (!canvasEl) return { dpr: 1, w: 1, h: 1, changed: false };
    const dpr = Math.min(maxDpr, window.devicePixelRatio || 1);
    const rect = canvasEl.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    const changed = (canvasEl.width !== w || canvasEl.height !== h);
    if (changed) {
      canvasEl.width = w;
      canvasEl.height = h;
    }
    return { dpr, w, h, changed };
  }

  _clearPreviewModel() {
    if (this._modelRoot && this._scene) {
      try { this._scene.remove(this._modelRoot); } catch { /* ignore */ }
    }
    // Dispose geometries/materials/textures
    try {
      this._modelRoot?.traverse?.((n) => {
        if (!n) return;
        const any = /** @type {any} */ (n);
        try { any.geometry?.dispose?.(); } catch { /* ignore */ }
        const mat = any.material;
        const mats = Array.isArray(mat) ? mat : (mat ? [mat] : []);
        for (const m of mats) {
          if (!m) continue;
          for (const k of ['map', 'normalMap', 'metalnessMap', 'roughnessMap', 'emissiveMap', 'aoMap']) {
            const t = m[k];
            if (t && t.isTexture) {
              try { t.dispose?.(); } catch { /* ignore */ }
            }
          }
          try { m.dispose?.(); } catch { /* ignore */ }
        }
      });
    } catch { /* ignore */ }
    this._gltf = null;
    this._modelRoot = null;
    this._wheelGroup = null;

    try { this._acTextureCache.clear(); } catch { /* ignore */ }
    try { this._acMaterialsCache.clear(); } catch { /* ignore */ }
  }

  async _loadPreviewModel(url) {
    const ctx = this._ctx;
    if (!ctx || !this._scene) return;
    const u = safeTrim(url);
    if (!u) return;
    this._previewModelUrl = u;

    this._clearPreviewModel();
    if (this._previewStatusEl) this._previewStatusEl.textContent = 'Loading preview…';

    const gltf = await this._loader.loadAsync(u);
    this._gltf = gltf;
    this._modelRoot = gltf.scene || null;
    if (!this._modelRoot) return;

    this._scene.add(this._modelRoot);

    // Attempt to load sibling .meta.json and (re)build overlay.
    try { await this._maybeLoadMetaForModelUrl(u); } catch { /* ignore */ }
    try { await this._applyAcTexturesToRoot(this._modelRoot, this._meta); } catch { /* ignore */ }
    try { this._rebuildWheelOverlay(); } catch { /* ignore */ }

    // Frame camera to model bounds.
    try {
      const box = new THREE.Box3().setFromObject(this._modelRoot);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);
      const r = Math.max(0.25, Math.max(size.x, size.y, size.z) * 0.65);
      if (this._controls) this._controls.target.copy(center);
      if (this._camera) {
        this._camera.position.set(center.x + r * 1.2, center.y + r * 0.8, center.z + r * 1.2);
        this._camera.near = Math.max(0.01, r * 0.02);
        this._camera.far = Math.max(2000, r * 80.0);
        this._camera.updateProjectionMatrix();
      }
    } catch { /* ignore */ }

    if (this._previewStatusEl) this._previewStatusEl.textContent = 'Preview loaded.';
  }

  _persistWheelSettings() {
    try { localStorage.setItem('devtools.vehicles.wheelOverlay', JSON.stringify(this._wheel)); } catch { /* ignore */ }
  }

  _metaUrlForModelUrl(modelUrl) {
    const u = safeTrim(modelUrl);
    if (!u) return '';
    // Common convention: <name>.glb -> <name>.meta.json
    if (u.toLowerCase().endsWith('.meta.json')) return u;
    if (u.toLowerCase().endsWith('.glb')) return u.slice(0, -4) + '.meta.json';
    if (u.toLowerCase().endsWith('.gltf')) return u.slice(0, -5) + '.meta.json';
    // Fallback: append (rare).
    return u + '.meta.json';
  }

  async _maybeLoadMetaForModelUrl(modelUrl) {
    const metaUrl = this._metaUrlForModelUrl(modelUrl);
    if (!metaUrl) return;
    // Avoid refetch spam if selection doesn't change.
    if (this._metaUrl && metaUrl === this._metaUrl && this._meta) return;
    await this._loadMeta(metaUrl);
  }

  async _loadMeta(metaUrl) {
    const u = safeTrim(metaUrl);
    this._metaUrl = u;
    this._meta = null;
    this._metaStatus = '';
    this._syncDetails(); // show "loading" quickly

    try {
      const resp = await fetch(u, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} (${resp.statusText || 'fetch failed'})`);
      const j = await resp.json();
      const anchors = (j?.anchors && typeof j.anchors === 'object') ? j.anchors : null;
      if (!anchors) throw new Error('meta.json missing anchors{}');
      this._meta = j;
      const wt = String(j?.wheelType || '').trim();
      const ws = Number(j?.wheelScale);
      const wr = Number(j?.wheelScaleRear);
      this._metaStatus = `Loaded metadata${wt ? ` (wheelType=${wt})` : ''}${Number.isFinite(ws) ? ` wheelScale=${ws}` : ''}${Number.isFinite(wr) ? ` rear=${wr}` : ''}`;
      try { await this._applyAcTexturesToRoot(this._modelRoot, this._meta); } catch { /* ignore */ }
    } catch (e) {
      this._meta = null;
      this._metaStatus = `No metadata found for this model (${String(e?.message || e)})`;
    }

    try { this._syncDetails(); } catch { /* ignore */ }
    try { this._rebuildWheelOverlay(); } catch { /* ignore */ }
  }

  _disposeWheelModel() {
    // Dispose cached wheel GLTF (not the clones attached to the model).
    try {
      const root = this._wheelGltf?.scene || null;
      root?.traverse?.((n) => {
        const any = /** @type {any} */ (n);
        try { any.geometry?.dispose?.(); } catch { /* ignore */ }
        const mat = any.material;
        const mats = Array.isArray(mat) ? mat : (mat ? [mat] : []);
        for (const m of mats) {
          if (!m) continue;
          for (const k of ['map', 'normalMap', 'metalnessMap', 'roughnessMap', 'emissiveMap', 'aoMap']) {
            const t = m[k];
            if (t && t.isTexture) {
              try { t.dispose?.(); } catch { /* ignore */ }
            }
          }
          try { m.dispose?.(); } catch { /* ignore */ }
        }
      });
    } catch { /* ignore */ }
    this._wheelGltf = null;
    this._wheelGltfUrl = '';
    this._wheelGltfUrlResolved = '';
    this._wheelAssetInfo = null;
    this._wheelModelStatus = '';
    this._wheelModelError = '';
    this._wheelModelLoading = false;
  }

  async _loadWheelModel(url) {
    const raw = safeTrim(url);
    if (!raw) return;
    if (this._wheelGltf && this._wheelGltfUrl === raw) return;
    this._disposeWheelModel();
    this._wheelModelLoading = true;
    this._wheelModelStatus = `Loading wheel model… (${raw})`;
    this._wheelModelError = '';
    try {
      const tried = [];
      const push = (c) => {
        const s = safeTrim(c);
        if (!s) return;
        if (tried.includes(s)) return;
        tried.push(s);
      };

      push(raw);
      // Common "base path" mistakes: leading slash vs relative.
      if (raw.startsWith('/')) push(raw.slice(1));
      else push('/' + raw);
      // Explicitly resolve against document base URI (helps with devtools served under a subpath).
      try { push(new URL(raw, document.baseURI).toString()); } catch { /* ignore */ }
      try { if (raw.startsWith('/')) push(new URL(raw.slice(1), document.baseURI).toString()); } catch { /* ignore */ }

      let lastErr = null;
      let loadedFrom = '';
      for (const cand of tried) {
        try {
          this._wheelModelStatus = `Loading wheel model… (${cand})`;
          const gltf = await this._wheelLoader.loadAsync(cand);
          this._wheelGltf = gltf;
          loadedFrom = cand;
          // Cache key should be the *raw* URL from the UI, so we don't constantly reload
          // when the loader succeeds via a different equivalent URL variant.
          this._wheelGltfUrl = raw;
          this._wheelGltfUrlResolved = cand;
          this._wheelModelStatus = `Wheel model loaded. (${cand})`;
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
        }
      }

      if (!this._wheelGltf) throw lastErr || new Error('Wheel model load failed');
    } catch (e) {
      this._wheelGltf = null;
      this._wheelGltfUrl = raw;
      this._wheelGltfUrlResolved = '';
      this._wheelAssetInfo = null;
      this._wheelModelError = String(e?.message || e || 'Wheel model load failed');
      this._wheelModelStatus = `Wheel model load FAILED. (${raw})`;
      throw e;
    } finally {
      this._wheelModelLoading = false;
    }

    // Compute alignment + scale hints:
    // - alignQ: rotates wheel model so its axle/width axis aligns with +X.
    // - outerRadius: approximate radius from AABB.
    // - width: smallest dimension length.
    try {
      const root = this._wheelGltf?.scene || null;
      if (root) {
        const box = computeLocalBounds(root);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);
        const dims = [Math.abs(size.x), Math.abs(size.y), Math.abs(size.z)];
        const eps = 1e-6;

        // Wheel axle/width axis detection (more reliable for real tire assets):
        // Use the smallest AABB dimension as "width", since tire width << diameter.
        let widthAxis = 0;
        if (dims[1] < dims[widthAxis]) widthAxis = 1;
        if (dims[2] < dims[widthAxis]) widthAxis = 2;
        // If the bounds are close to a cube (ambiguous), avoid auto-rotating.
        const dMin = Math.min(dims[0], dims[1], dims[2]) + eps;
        const dMax = Math.max(dims[0], dims[1], dims[2]) + eps;
        if ((dMin / dMax) > 0.75) widthAxis = 0;

        const widthLen = Math.max(0, dims[widthAxis]);
        const otherA = dims[(widthAxis + 1) % 3];
        const otherB = dims[(widthAxis + 2) % 3];
        // Outer radius should come from the diameter axes, not the width.
        const outerRadius = 0.5 * Math.max(otherA, otherB, 1e-6);

        // Deterministic alignment (avoid setFromUnitVectors underconstrained roll).
        // Build a full basis in the model's local axes:
        // - sX: model's width axis
        // - sY: preferred "up" axis (model +Y unless it's the width axis, then model +Z)
        // - sZ: right-handed cross
        //
        // Then the alignment matrix is simply S^T (change of basis into [sX,sY,sZ]),
        // which maps model-space vectors into a frame where width axis becomes +X.
        const AXES = [
          new THREE.Vector3(1, 0, 0),
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(0, 0, 1),
        ];
        const sX = AXES[widthAxis].clone();
        const upAxis = (widthAxis !== 1) ? 1 : 2;
        let sY = AXES[upAxis].clone();
        let sZ = new THREE.Vector3().crossVectors(sX, sY);
        if (sZ.lengthSq() < 1e-8) {
          // Fallback if axes are degenerate (shouldn't happen).
          sY = AXES[(upAxis + 1) % 3].clone();
          sZ = new THREE.Vector3().crossVectors(sX, sY);
        }
        sZ.normalize();
        // Re-orthogonalize sY to ensure a perfect basis.
        sY = new THREE.Vector3().crossVectors(sZ, sX).normalize();
        const S = new THREE.Matrix4().makeBasis(sX, sY, sZ);
        const alignM = S.clone().transpose();
        const alignQ = new THREE.Quaternion().setFromRotationMatrix(alignM);

        this._wheelAssetInfo = { root, alignQ, outerRadius, width: widthLen, center, size, widthAxis };
      } else {
        this._wheelAssetInfo = null;
      }
    } catch {
      this._wheelAssetInfo = null;
    }
  }

  _clearWheelOverlay() {
    if (this._wheelGroup && this._modelRoot) {
      try { this._modelRoot.remove(this._wheelGroup); } catch { /* ignore */ }
    }
    this._wheelGroup = null;
  }

  _ensureWheelGroup() {
    if (!this._modelRoot) return null;
    if (this._wheelGroup) return this._wheelGroup;
    const g = new THREE.Group();
    g.name = 'VehiclesTool_WheelOverlay';
    this._modelRoot.add(g);
    this._wheelGroup = g;
    return g;
  }

  _anchorQuat(a) {
    const q = Array.isArray(a?.quat) ? a.quat : null;
    if (!q || q.length < 4) return new THREE.Quaternion(0, 0, 0, 1);
    const x = Number(q[0]) || 0;
    const y = Number(q[1]) || 0;
    const z = Number(q[2]) || 0;
    const w = Number(q[3]);
    return new THREE.Quaternion(x, y, z, Number.isFinite(w) ? w : 1);
  }

  _anchorPos(a) {
    const p = Array.isArray(a?.pos) ? a.pos : null;
    if (!p || p.length < 3) return new THREE.Vector3(0, 0, 0);
    return new THREE.Vector3(Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0);
  }

  _rebuildWheelOverlay() {
    if (!this._scene || !this._modelRoot) return;
    const wst = this._wheel;
    if (!wst?.enabled) { this._clearWheelOverlay(); return; }

    const meta = this._meta;
    const anchors = (meta?.anchors && typeof meta.anchors === 'object') ? meta.anchors : null;
    if (!anchors) { this._clearWheelOverlay(); return; }

    const g = this._ensureWheelGroup();
    if (!g) return;
    // Clear children.
    // NOTE: We only dispose resources we created (placeholders/anchor viz).
    // Wheel-model instances share geometry/material with the cached wheel GLTF and must NOT be disposed here.
    const oldKids = g.children.slice();
    while (g.children.length) g.remove(g.children[g.children.length - 1]);
    for (const k of oldKids) disposeVehiclesToolOwnedObject3D(k);

    const wantAnchors = !!wst.showAnchors;
    const wantWheels = !!wst.showWheels;
    if (!wantAnchors && !wantWheels) return;

    const frontR = Number(meta?.wheelScale);
    const rearR = Number(meta?.wheelScaleRear);
    const fr = Number.isFinite(frontR) ? frontR : 0.30;
    const rr = Number.isFinite(rearR) ? rearR : fr;
    const width = Math.max(0.02, Number(wst.placeholderWidth) || 0.20);

    const rotOff = new THREE.Euler(degToRad(wst.rotXDeg), degToRad(wst.rotYDeg), degToRad(wst.rotZDeg));
    const rotOffQ = new THREE.Quaternion().setFromEuler(rotOff);
    // Placeholder tire uses cylinder meshes (axis +Y). Wheel axle is treated as +X in "wheel local".
    // Rotate +Y -> +X (note the sign: +90deg around Z maps +Y to -X).
    const cylAxisToAxleXQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI * 0.5);

    // Derive axle directions from anchors (uses the actual wheel layout, rather than assuming facing/axes).
    const xAxis = new THREE.Vector3(1, 0, 0);
    const axleF = (() => {
      const lf = anchors?.wheel_lf, rf = anchors?.wheel_rf;
      if (!lf || !rf) return null;
      const a = this._anchorPos(lf);
      const b = this._anchorPos(rf);
      const d = b.clone().sub(a);
      const l = d.length();
      if (!(l > 1e-6)) return null;
      return d.multiplyScalar(1 / l);
    })();
    const axleR = (() => {
      const lr = anchors?.wheel_lr, rr = anchors?.wheel_rr;
      if (!lr || !rr) return null;
      const a = this._anchorPos(lr);
      const b = this._anchorPos(rr);
      const d = b.clone().sub(a);
      const l = d.length();
      if (!(l > 1e-6)) return null;
      return d.multiplyScalar(1 / l);
    })();
    const axleBaseDirFor = (isFront) => (isFront ? axleF : axleR) || axleF || axleR || xAxis;
    // IMPORTANT: axle direction sign matters for asymmetric wheel models.
    // We define wheel local +X as "outward" from vehicle center:
    // - left wheels: -axleBase (points left)
    // - right wheels: +axleBase (points right)
    const axleDirFor = (isFront, isRight) => {
      const d = axleBaseDirFor(isFront).clone().normalize();
      return isRight ? d : d.multiplyScalar(-1);
    };
    // IMPORTANT: setFromUnitVectors() only constrains one axis.
    // For +X -> -X (left wheels) the roll is underconstrained and Three picks an arbitrary orthogonal axis.
    // Placeholder cylinders hide this, but real tire models expose it (tread/sidewall "goes the wrong way").
    // Build a full orthonormal wheel frame with a stable "up" reference (world +Y).
    const worldUp = new THREE.Vector3(0, 1, 0);
    const wheelFrameQFor = (isFront, isRight) => {
      const x = axleDirFor(isFront, isRight).clone().normalize(); // wheel local +X (axle, outward)
      // Make +Y be as close as possible to worldUp but orthogonal to +X.
      let y = worldUp.clone().sub(x.clone().multiplyScalar(worldUp.dot(x)));
      if (y.lengthSq() < 1e-8) {
        // Degenerate (axle parallel to up); pick an arbitrary fallback up.
        y = new THREE.Vector3(0, 0, 1).sub(x.clone().multiplyScalar(new THREE.Vector3(0, 0, 1).dot(x)));
      }
      y.normalize();
      const z = new THREE.Vector3().crossVectors(x, y).normalize();
      // Re-orthogonalize y to avoid drift.
      y = new THREE.Vector3().crossVectors(z, x).normalize();
      const m = new THREE.Matrix4().makeBasis(x, y, z);
      return new THREE.Quaternion().setFromRotationMatrix(m);
    };

    const makeAnchorViz = (colorHex, size = 0.035) => {
      const geo = new THREE.SphereGeometry(size, 16, 12);
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(colorHex) });
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      m.userData.__vehiclesToolOwned = true;
      return m;
    };

    const tireMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x111111),
      roughness: 0.95,
      metalness: 0.02,
    });
    const rimMatFront = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0xa7b9ff),
      roughness: 0.35,
      metalness: 0.65,
    });
    const rimMatRear = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0xa7ffd3),
      roughness: 0.35,
      metalness: 0.65,
    });

    const addProceduralRim = (pos, wheelQuat, radius, isFront, isRight) => {
      const rad = Math.max(0.01, Number(radius) || 0.30);
      const grp = new THREE.Group();
      grp.position.copy(pos);
      // Cylinder axis (+Y) -> axle (+X), then orient wheel local +X to the vehicle axle.
      grp.quaternion.copy(wheelQuat.clone().multiply(cylAxisToAxleXQ));
      if (wst.flipRight && isRight) {
        grp.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI));
      }
      grp.userData.__vehiclesToolOwned = true;

      const rimR = Math.max(0.001, rad * 0.55);
      const rimGeo = new THREE.CylinderGeometry(rimR, rimR, width * 1.02, 26, 1, false);
      const rim = new THREE.Mesh(rimGeo, isFront ? rimMatFront : rimMatRear);
      rim.frustumCulled = false;
      rim.userData.__vehiclesToolOwned = true;
      grp.add(rim);

      grp.traverse?.((n) => { n.frustumCulled = false; });
      g.add(grp);
      return grp;
    };

    const addPlaceholderTire = (pos, wheelQuat, radius, isFront, isRight) => {
      const rad = Math.max(0.01, Number(radius) || 0.30);
      const grp = new THREE.Group();
      grp.position.copy(pos);
      // Cylinder axis (+Y) -> axle (+X), then orient wheel local +X to the vehicle axle.
      grp.quaternion.copy(wheelQuat.clone().multiply(cylAxisToAxleXQ));
      if (wst.flipRight && isRight) {
        // Rotate about axle (local +X) rather than negative scale (avoids inside-out normals).
        grp.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI));
      }
      grp.userData.__vehiclesToolOwned = true;

      // Rubber tire
      const tireGeo = new THREE.CylinderGeometry(rad, rad, width, 28, 1, false);
      const tire = new THREE.Mesh(tireGeo, tireMat);
      tire.frustumCulled = false;
      tire.userData.__vehiclesToolOwned = true;
      grp.add(tire);

      // Simple rim (slightly smaller radius)
      const rimR = Math.max(0.001, rad * 0.55);
      const rimGeo = new THREE.CylinderGeometry(rimR, rimR, width * 1.02, 22, 1, false);
      const rim = new THREE.Mesh(rimGeo, isFront ? rimMatFront : rimMatRear);
      rim.frustumCulled = false;
      rim.userData.__vehiclesToolOwned = true;
      grp.add(rim);

      grp.traverse?.((n) => { n.frustumCulled = false; });
      g.add(grp);
      return grp;
    };

    // Preload wheel model if requested (best-effort).
    // IMPORTANT: Guard against infinite rebuild loops by only auto-loading when:
    // - we're in model mode
    // - we want wheels
    // - we don't already have the wheel model loaded for the current URL
    // - we aren't already loading
    const wheelUrl = safeTrim(wst.wheelUrl);
    if (wantWheels && wst.mode === 'model' && wheelUrl) {
      const alreadyLoadedForUrl = !!this._wheelGltf && (this._wheelGltfUrl === wheelUrl);
      if (!alreadyLoadedForUrl && !this._wheelModelLoading) {
        void (async () => {
          try { await this._loadWheelModel(wheelUrl); } catch { /* ignore */ }
          try { this._rebuildWheelOverlay(); } catch { /* ignore */ }
          try { this._syncDetails(); } catch { /* ignore */ }
        })();
      }
    }

    const keys = ['wheel_lf', 'wheel_rf', 'wheel_lr', 'wheel_rr'];
    for (const k of keys) {
      const a = anchors?.[k] || null;
      if (!a) continue;
      const p = this._anchorPos(a);
      const q = this._anchorQuat(a);
      const isFront = k.includes('_f');
      const isRight = k.includes('_r');

      if (wantAnchors) {
        const c = isFront ? 0x3aa0ff : 0x33dd88;
        const viz = makeAnchorViz(c, 0.035);
        viz.position.copy(p);
        g.add(viz);
      }

      if (!wantWheels) continue;

      // Wheel pose:
      // - Prefer anchor quat if provided (meta exporter can encode the wheel frame).
      // - Otherwise, derive axle from wheel anchor positions (robust fallback).
      // Then apply user tweak in the wheel's local space.
      let baseQ = null;
      if (Array.isArray(a?.quat) && !isNearIdentityQuat(q)) baseQ = q.clone();
      else baseQ = wheelFrameQFor(isFront, isRight);
      const wheelQ = baseQ.multiply(rotOffQ);
      // Optional per-right-wheel flip, applied as a roll about the axle (wheel local +X).
      if (wst.flipRight && isRight) {
        wheelQ.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI));
      }

      const useMeta = !!wst.useMetaScale;
      const base = isFront ? fr : rr;
      const mul = isFront ? (Number(wst.frontScaleMul) || 1.0) : (Number(wst.rearScaleMul) || 1.0);
      const desiredRadius = (useMeta ? base : 1.0) * mul;

      if (wst.mode === 'model') {
        const info = this._wheelAssetInfo;
        const src = info?.root || this._wheelGltf?.scene || null;
        if (!src) {
          // While the model loads (or if it fails), still show placeholders so the user gets feedback.
          addPlaceholderTire(p, wheelQ, desiredRadius, isFront, isRight);
          continue;
        }
        // Keep the anchor pose identical to placeholder mode, then apply model-specific
        // alignment/scaling in child nodes. This avoids frame-order issues where non-uniform
        // width scaling can shift/tilt wheels relative to anchors.
        const pivot = new THREE.Group();
        pivot.position.copy(p);
        pivot.quaternion.copy(wheelQ);

        const outerR = Math.max(1e-6, Number(info?.outerRadius) || 1.0);
        const sU = Math.max(1e-6, desiredRadius / outerR);

        // Optional width squash to match placeholderWidth (helps avoid super-fat tires).
        const w0 = Math.max(0, Number(info?.width) || 0);
        const wantW = Math.max(0.02, Number(wst.placeholderWidth) || 0.20);
        let wMul = 1.0;
        // Guard: if bbox width is degenerate, skip width scaling (prevents "pole" stretching).
        if (w0 > 1e-4) {
          const curW = w0 * sU;
          const wMulRaw = wantW / Math.max(1e-6, curW);
          // Clamp to avoid extreme distortion if bounds are weird.
          wMul = Math.max(0.25, Math.min(4.0, wMulRaw));
        }

        // Apply scale in wheel-local space (+X is axle/width after alignment).
        const scaleNode = new THREE.Group();
        scaleNode.scale.set(sU * wMul, sU, sU);
        pivot.add(scaleNode);

        const alignNode = new THREE.Group();
        const alignQ = info?.alignQ || new THREE.Quaternion(0, 0, 0, 1);
        alignNode.quaternion.copy(alignQ);
        scaleNode.add(alignNode);

        const inst = /** @type {THREE.Object3D} */ (src.clone(true));
        // Center model geometry about its own AABB center so the anchor hits wheel center.
        const c = (info?.center && info.center.isVector3) ? info.center : new THREE.Vector3(0, 0, 0);
        inst.position.copy(c).multiplyScalar(-1);

        // Avoid accidental culling of small attached meshes.
        try {
          pivot.traverse?.((n) => { n.frustumCulled = false; });
          inst.traverse?.((n) => { n.frustumCulled = false; });
        } catch { /* ignore */ }

        alignNode.add(inst);
        g.add(pivot);
        if (wst.showRims) addProceduralRim(p, wheelQ, desiredRadius, isFront, isRight);
      } else {
        // Placeholder wheel: simple tire + rim
        addPlaceholderTire(p, wheelQ, desiredRadius, isFront, isRight);
      }
    }
  }

  _tickPreview() {
    if (!this._preview.enabled) return;
    if (!this._renderer || !this._scene || !this._camera || !this._canvas) return;

    const { dpr, w, h } = this._resizeCanvasToDisplaySize(2.0);
    this._renderer.setPixelRatio(dpr);
    this._renderer.setSize(w / dpr, h / dpr, false);
    this._camera.aspect = Math.max(1e-6, w / Math.max(1e-6, h));
    this._camera.updateProjectionMatrix();

    if (this._controls) this._controls.update();

    if (this._grid) this._grid.visible = !!this._preview.showGrid;
    // Keep clock ticking (so controls damping is smooth even when not animating).
    try { this._clock.getDelta(); } catch { /* ignore */ }

    this._renderer.render(this._scene, this._camera);
  }

  _buildUi() {
    const root = this._root;
    const ctx = this._ctx;
    if (!root || !ctx) return;
    clear(root);

    this._statusEl = el('div', { class: 'muted', style: { marginBottom: '8px' } }, ['']);

    const queryInput = el('input', {
      value: String(this._state.query || ''),
      placeholder: 'Index query (e.g. webautos/)',
      onchange: (e) => { this._state.query = safeTrim(e.target.value); },
    });

    const searchInput = el('input', {
      value: String(this._state.search || ''),
      placeholder: 'Search (name/path)…',
      oninput: (e) => { this._state.search = safeTrim(e.target.value); this._syncList(); },
    });

    const onlyHiToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center' } }, [
      el('input', {
        type: 'checkbox',
        checked: !!this._state.onlyHi,
        onchange: (e) => { this._state.onlyHi = !!e.target.checked; this._syncList(); },
      }),
      el('span', {}, ['Only “_hi” GLBs']),
    ]);

    const sortSel = el('select', {
      value: String(this._state.sort || 'recent'),
      onchange: (e) => { this._state.sort = String(e.target.value || 'recent'); this._syncList(); },
      title: 'Sort',
    }, [
      el('option', { value: 'recent' }, ['Recent']),
      el('option', { value: 'name' }, ['Name']),
      el('option', { value: 'size' }, ['Size']),
    ]);

    const refreshBtn = el('button', {
      class: 'primary',
      onclick: async () => { await this._refresh(); },
      title: 'Rescan webautos/',
    }, ['Refresh']);

    const setDefaultBtn = el('button', {
      onclick: () => {
        this._state.query = 'webautos/';
        try { queryInput.value = this._state.query; } catch { /* ignore */ }
      },
    }, ['Use default query']);

    const help = el('div', { class: 'muted', style: { whiteSpace: 'pre-line', marginTop: '8px' } }, [
      'This tool lists converted vehicle models under webautos/.\n' +
      'Use “Use in Gameplay” to set the runtime URL, then in the main app press B (in Gameplay) to spawn it in front of you.',
    ]);

    const previewEnabledToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px' } }, [
      el('input', {
        type: 'checkbox',
        checked: !!this._preview.enabled,
        onchange: (e) => { this._preview.enabled = !!e.target.checked; },
      }),
      el('span', {}, ['Show 3D preview']),
    ]);
    const previewGridToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' } }, [
      el('input', {
        type: 'checkbox',
        checked: !!this._preview.showGrid,
        onchange: (e) => { this._preview.showGrid = !!e.target.checked; },
      }),
      el('span', {}, ['Grid']),
    ]);

    this._listEl = el('div', { class: 'card', style: { marginTop: '10px' } }, ['']);
    this._detailEl = el('div', { class: 'card', style: { marginTop: '10px' } }, ['']);
    this._previewStatusEl = el('div', { class: 'muted', style: { marginTop: '8px' } }, ['']);

    root.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'mapName' }, ['Vehicle Library']),
      this._statusEl,
      el('div', { class: 'row', style: { marginTop: '8px' } }, [queryInput, setDefaultBtn, refreshBtn]),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [searchInput, sortSel]),
      el('div', { style: { marginTop: '8px' } }, [onlyHiToggle]),
      previewEnabledToggle,
      previewGridToggle,
      this._previewStatusEl,
      help,
    ]));

    root.appendChild(this._listEl);
    root.appendChild(this._detailEl);
  }

  async _refresh() {
    const ctx = this._ctx;
    if (!ctx) return;

    const q = safeTrim(this._state.query || 'webautos/');
    try {
      if (this._statusEl) this._statusEl.textContent = 'Loading…';
      const items = await ctx.assetIndex({ query: q, ext: '.glb,.gltf' });
      const out = [];
      for (const it of (Array.isArray(items) ? items : [])) {
        const p = safeTrim(it?.path || '');
        if (!p) continue;
        const ext = extOf(p);
        if (ext !== '.glb' && ext !== '.gltf') continue;
        const vname = vehicleNameFromPath(p);
        const url = '/' + p.replace(/^\/+/, '');
        out.push({
          path: p,
          bytes: Number(it?.bytes) || 0,
          mtimeMs: Number(it?.mtimeMs) || 0,
          url,
          vehicle: vname,
          lod: inferLodLabel(p),
        });
      }
      this._items = out;

      // Try to default-select runtime vehicle if set, else first Abarth, else first item.
      let wanted = '';
      try { wanted = safeTrim(localStorage.getItem('gameplay.vehicleUrl') || ''); } catch { wanted = ''; }
      this._lastRuntimeVehicleUrlSeen = wanted;
      const wantedRel = wanted.startsWith('/') ? wanted.slice(1) : wanted;
      const hasWanted = wantedRel && out.some((x) => x.path === wantedRel);
      if (hasWanted) this._selectedPath = wantedRel;
      else if (!this._selectedPath) {
        const ab = out.find((x) => x.vehicle.toLowerCase().includes('abarth')) || null;
        this._selectedPath = String(ab?.path || out[0]?.path || '');
      } else if (!out.some((x) => x.path === this._selectedPath)) {
        this._selectedPath = String(out[0]?.path || '');
      }

      this._syncList();
      this._syncDetails();
    } catch (e) {
      if (this._statusEl) this._statusEl.textContent = `Failed: ${String(e?.message || e)}`;
      this._items = [];
      this._syncList();
      this._syncDetails();
    }
  }

  _visibleItems() {
    const search = safeTrim(this._state.search || '').toLowerCase();
    const onlyHi = !!this._state.onlyHi;
    let arr = Array.isArray(this._items) ? this._items.slice() : [];
    if (onlyHi) arr = arr.filter((x) => x?.lod === 'hi' || String(x?.path || '').toLowerCase().includes('_hi.'));
    if (search) {
      arr = arr.filter((x) => {
        const hay = `${x.vehicle} ${x.path}`.toLowerCase();
        return hay.includes(search);
      });
    }

    const sort = String(this._state.sort || 'recent');
    if (sort === 'name') arr.sort((a, b) => String(a.vehicle).localeCompare(String(b.vehicle)) || String(a.path).localeCompare(String(b.path)));
    else if (sort === 'size') arr.sort((a, b) => (Number(b.bytes) || 0) - (Number(a.bytes) || 0));
    else arr.sort((a, b) => (Number(b.mtimeMs) || 0) - (Number(a.mtimeMs) || 0));

    const limit = Math.max(1, Math.min(2000, Number(this._state.limit) || 400));
    return arr.slice(0, limit);
  }

  _syncList() {
    const host = this._listEl;
    if (!host) return;
    clear(host);

    const items = this._visibleItems();
    const total = Array.isArray(this._items) ? this._items.length : 0;
    if (this._statusEl) this._statusEl.textContent = `Found ${total} file(s), showing ${items.length}.`;

    if (!items.length) {
      host.appendChild(el('div', { class: 'muted' }, ['No vehicle models found.']));
      return;
    }

    // Group by vehicle name.
    const byVeh = new Map();
    for (const it of items) {
      const k = String(it.vehicle || '(unknown)');
      if (!byVeh.has(k)) byVeh.set(k, []);
      byVeh.get(k).push(it);
    }

    const vehicles = Array.from(byVeh.entries());
    vehicles.sort((a, b) => String(a[0]).localeCompare(String(b[0])));

    for (const [veh, arr] of vehicles) {
      const title = el('div', { class: 'mapName', style: { marginTop: '8px' } }, [veh]);
      host.appendChild(title);

      const list = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' } });
      for (const it of arr) {
        const isSel = (it.path === this._selectedPath);
        const lod = it.lod ? `(${it.lod}) ` : '';
        list.appendChild(el('button', {
          class: isSel ? 'primary' : '',
          style: { textAlign: 'left' },
          title: it.path,
          onclick: () => {
            this._selectedPath = it.path;
            this._syncDetails();
            this._syncListSelection();
            // Auto-load preview on click.
            try { if (this._preview.enabled) void this._loadPreviewModel(it.url); } catch { /* ignore */ }
          },
        }, [`${lod}${it.path.replace(/^webautos\//, '')}`]));
      }
      host.appendChild(list);
    }
  }

  _syncListSelection() {
    // Re-render is simplest; lists are small enough (limit 400).
    this._syncList();
  }

  _syncDetails() {
    const host = this._detailEl;
    if (!host) return;
    clear(host);

    const it = this._items.find((x) => x.path === this._selectedPath) || null;
    if (!it) {
      host.appendChild(el('div', { class: 'muted' }, ['Select a vehicle model from the list.']));
      return;
    }

    const ctx = this._ctx;
    const url = it.url;

    const copyBtn = el('button', {
      onclick: async () => {
        try { await navigator.clipboard.writeText(url); } catch { /* ignore */ }
        ctx?.toast?.('Copied vehicle URL to clipboard', 'success');
      },
    }, ['Copy URL']);

    const openBtn = el('button', {
      onclick: () => {
        try { window.open(url, '_blank', 'noopener,noreferrer'); } catch { /* ignore */ }
      },
      title: 'Open the raw file URL in a new tab',
    }, ['Open URL']);

    const useInGameplayBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try { localStorage.setItem('gameplay.vehicleUrl', url); } catch { /* ignore */ }
        try { localStorage.setItem('gameplay.vehicleEnabled', '1'); } catch { /* ignore */ }
        this._lastRuntimeVehicleUrlSeen = url;
        ctx?.toast?.('Set runtime vehicle URL (Gameplay)', 'success');
      },
      title: 'Sets the runtime vehicle GLB URL and enables vehicle rendering',
    }, ['Use in Gameplay']);

    const previewBtn = el('button', {
      onclick: async () => {
        try { await this._loadPreviewModel(url); } catch { /* ignore */ }
      },
      title: 'Load this vehicle in the left 3D preview canvas',
    }, ['Preview']);

    const viewInViewerBtn = el('button', {
      onclick: async () => {
        // Drive the Model Viewer tool via the shared storage convention.
        try { localStorage.setItem('devtools.lastGeneratedModelUrl', url); } catch { /* ignore */ }
        try {
          const app = globalThis.__devtools;
          if (app?.setActiveTool) await app.setActiveTool('model_viewer');
        } catch { /* ignore */ }
        ctx?.toast?.('Sent to Model Viewer', 'info');
      },
      title: 'Open this model in the DevTools Model Viewer',
    }, ['View in Model Viewer']);

    const sendToSceneBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        // Send selected vehicle model URL to the Scene tool (for prop spawning).
        try {
          localStorage.setItem('devtools.scene.inbox', JSON.stringify({
            schema: 1,
            kind: 'spawn_prop',
            url,
            name: String(it.vehicle || ''),
            source: 'vehicles_tool',
            time: new Date().toISOString(),
          }));
        } catch { /* ignore */ }
        try {
          const app = globalThis.__devtools;
          if (app?.setActiveTool) await app.setActiveTool('scene');
        } catch { /* ignore */ }
        ctx?.toast?.('Sent to Scene tool (spawn as prop)', 'success');
      },
      title: 'Open Scene tool and stage this vehicle for spawning as a prop',
    }, ['Send to Scene (prop)']);

    const sendToSceneVehicleBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        // Send selected vehicle model URL to the Scene tool (for driveable vehicle spawning).
        const metaUrl = this._metaUrlForModelUrl(url);
        const canAttachMeta = !!this._meta && safeTrim(this._metaUrl) === safeTrim(metaUrl);
        const previewMatches = safeTrim(this._previewModelUrl) === safeTrim(url);
        const clipNames = previewMatches
          ? (Array.isArray(this._gltf?.animations) ? this._gltf.animations.map((c) => safeTrim(c?.name || '')).filter(Boolean) : [])
          : [];
        const vehicleConfig = {
          schema: 1,
          source: 'vehicles_tool',
          modelUrl: url,
          metaUrl: metaUrl || '',
          // Include lightweight meta payload when this exact model's meta is already loaded.
          meta: canAttachMeta ? {
            wheelType: String(this._meta?.wheelType || ''),
            wheelScale: Number(this._meta?.wheelScale),
            wheelScaleRear: Number(this._meta?.wheelScaleRear),
            anchors: (this._meta?.anchors && typeof this._meta.anchors === 'object') ? this._meta.anchors : null,
          } : null,
          // Current wheel overlay intent can inform scene-side spawn tuning.
          wheelOverlay: {
            enabled: !!this._wheel?.enabled,
            useMetaScale: !!this._wheel?.useMetaScale,
            frontScaleMul: Number(this._wheel?.frontScaleMul) || 1.0,
            rearScaleMul: Number(this._wheel?.rearScaleMul) || 1.0,
            placeholderWidth: Number(this._wheel?.placeholderWidth) || 0.20,
          },
          animationClipNames: clipNames,
        };
        try {
          localStorage.setItem('devtools.scene.inbox', JSON.stringify({
            schema: 1,
            kind: 'spawn_vehicle_asset',
            url,
            name: String(it.vehicle || ''),
            vehicleConfig,
            source: 'vehicles_tool',
            time: new Date().toISOString(),
          }));
        } catch { /* ignore */ }
        try {
          const app = globalThis.__devtools;
          if (app?.setActiveTool) await app.setActiveTool('scene');
        } catch { /* ignore */ }
        ctx?.toast?.('Sent to Scene tool (spawn as driveable vehicle)', 'success');
      },
      title: 'Open Scene tool and stage this vehicle for spawning as a driveable vehicle',
    }, ['Send to Scene (vehicle)']);

    const meta = [
      `Path: ${it.path}`,
      `URL: ${url}`,
      `Size: ${bytesToMiB(it.bytes)} MiB`,
      it.mtimeMs ? `Modified: ${fmtTime(it.mtimeMs)}` : '',
    ].filter(Boolean).join('\n');

    host.appendChild(el('div', { class: 'mapName' }, ['Selected']));
    host.appendChild(el('div', { class: 'muted', style: { whiteSpace: 'pre-line', marginTop: '6px' } }, [meta]));
    host.appendChild(el('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, [
      useInGameplayBtn,
      previewBtn,
      viewInViewerBtn,
      sendToSceneBtn,
      sendToSceneVehicleBtn,
      copyBtn,
      openBtn,
    ]));

    host.appendChild(el('div', { class: 'muted', style: { whiteSpace: 'pre-line', marginTop: '10px' } }, [
      'Runtime notes:\n' +
      '- In the main app: Map tab → Spawn character → Gameplay.\n' +
      '- Press B to spawn the vehicle in front of you.\n' +
      '- If the model is too big/small, adjust Vehicle scale in the Map tab UI.',
    ]));

    // ---- Wheel metadata + overlay preview helpers ----
    const metaUrl = this._metaUrlForModelUrl(url);
    const metaStatus = String(this._metaStatus || '').trim();
    const metaLoaded = !!this._meta;
    const wt = safeTrim(this._meta?.wheelType || '');
    const ws = Number(this._meta?.wheelScale);
    const wr = Number(this._meta?.wheelScaleRear);
    const anchors = (this._meta?.anchors && typeof this._meta.anchors === 'object') ? this._meta.anchors : null;
    const anchorKeys = anchors ? Object.keys(anchors) : [];
    const hasWheelAnchors = anchors && ['wheel_lf', 'wheel_rf', 'wheel_lr', 'wheel_rr'].every((k) => !!anchors[k]);

    // ---- AC texture bind report (debug/validation) ----
    const rep = this._acBindReport;
    if (rep && this._previewModelUrl && safeTrim(this._previewModelUrl) === safeTrim(url)) {
      const failLines = (rep.textureFailures || []).slice(0, 40).map((f) => `- ${f.material || '(unnamed)'}: ${f.kind} ${f.tex} (${f.url})`);
      const unmatchedLines = (rep.materialsUnmatched || []).slice(0, 40).map((s) => `- ${s}`);
      const body = [
        `Bound at: ${fmtTime(rep.atMs)}`,
        rep.texDir ? `texDir: ${rep.texDir}` : '',
        rep.matsUrl ? `matsUrl: ${rep.matsUrl}` : '',
        `materials seen: ${Number(rep.materialsSeen) || 0}`,
        `materials matched: ${Number(rep.materialsMatched) || 0}`,
        `applied maps: diffuse=${Number(rep.applied?.diffuse) || 0} normal=${Number(rep.applied?.normal) || 0} maps=${Number(rep.applied?.maps) || 0} mask=${Number(rep.applied?.mask) || 0} emissive=${Number(rep.applied?.emissive) || 0}`,
        `adjustments: transparency=${Number(rep.adjusted?.transparency) || 0} alphaTest=${Number(rep.adjusted?.alphaTest) || 0} heuristicPbr=${Number(rep.adjusted?.heuristicPbr) || 0}`,
        failLines.length ? `\nTexture load failures (first ${failLines.length}):\n${failLines.join('\n')}` : '\nTexture load failures: (none)',
        unmatchedLines.length ? `\nUnmatched materials (first ${unmatchedLines.length}):\n${unmatchedLines.join('\n')}` : '\nUnmatched materials: (none)',
      ].filter(Boolean).join('\n');

      host.appendChild(el('div', { class: 'card', style: { marginTop: '10px' } }, [
        el('div', { class: 'mapName' }, ['AC texture bind report (preview)']),
        el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-line' } }, [body]),
      ]));
    }

    const metaCard = el('div', { class: 'card', style: { marginTop: '10px' } }, [
      el('div', { class: 'mapName' }, ['Wheel metadata / placement']),
      el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-line' } }, [
        [
          `Meta URL: ${metaUrl}`,
          metaLoaded ? `Status: loaded${wt ? ` (wheelType=${wt})` : ''}` : `Status: ${metaStatus || 'not loaded'}`,
          Number.isFinite(ws) ? `wheelScale (front): ${ws}` : '',
          Number.isFinite(wr) ? `wheelScaleRear: ${wr}` : '',
          anchorKeys.length ? `anchors: ${anchorKeys.join(', ')}` : '',
          hasWheelAnchors ? 'wheel anchors: OK (wheel_lf/rf/lr/rr)' : (anchors ? 'wheel anchors: missing some keys' : ''),
        ].filter(Boolean).join('\n'),
      ]),
    ]);

    const loadMetaBtn = el('button', {
      class: metaLoaded ? '' : 'primary',
      onclick: async () => { try { await this._loadMeta(metaUrl); } catch { /* ignore */ } },
      title: 'Fetch and parse the sibling .meta.json file (wheel anchors)',
    }, [metaLoaded ? 'Reload meta.json' : 'Load meta.json']);

    const overlayEnabledToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px' } }, [
      el('input', {
        type: 'checkbox',
        checked: !!this._wheel.enabled,
        onchange: (e) => { this._wheel.enabled = !!e.target.checked; this._persistWheelSettings(); this._rebuildWheelOverlay(); },
      }),
      el('span', {}, ['Enable wheel overlay (preview only)']),
    ]);

    const showAnchorsToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' } }, [
      el('input', {
        type: 'checkbox',
        checked: !!this._wheel.showAnchors,
        onchange: (e) => { this._wheel.showAnchors = !!e.target.checked; this._persistWheelSettings(); this._rebuildWheelOverlay(); },
      }),
      el('span', {}, ['Show wheel anchor gizmos']),
    ]);

    const showWheelsToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' } }, [
      el('input', {
        type: 'checkbox',
        checked: !!this._wheel.showWheels,
        onchange: (e) => { this._wheel.showWheels = !!e.target.checked; this._persistWheelSettings(); this._rebuildWheelOverlay(); },
      }),
      el('span', {}, ['Show wheels (placeholder/model)']),
    ]);

    const showRimsToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' } }, [
      el('input', {
        type: 'checkbox',
        checked: !!this._wheel.showRims,
        onchange: (e) => { this._wheel.showRims = !!e.target.checked; this._persistWheelSettings(); this._rebuildWheelOverlay(); },
      }),
      el('span', {}, ['Add procedural rims (useful for tire-only wheel models)']),
    ]);

    const modeSel = el('select', {
      value: String(this._wheel.mode || 'placeholder'),
      onchange: (e) => { this._wheel.mode = String(e.target.value || 'placeholder'); this._persistWheelSettings(); this._rebuildWheelOverlay(); },
      title: 'Wheel overlay mode',
    }, [
      el('option', { value: 'placeholder' }, ['Placeholder (cylinders)']),
      el('option', { value: 'model' }, ['Wheel model (GLB)']),
    ]);

    const useMetaScaleToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' } }, [
      el('input', {
        type: 'checkbox',
        checked: !!this._wheel.useMetaScale,
        onchange: (e) => { this._wheel.useMetaScale = !!e.target.checked; this._persistWheelSettings(); this._rebuildWheelOverlay(); },
      }),
      el('span', {}, ['Use meta wheelScale values']),
    ]);

    const frontMul = el('input', {
      type: 'number',
      step: '0.02',
      value: String(Number(this._wheel.frontScaleMul ?? 1.0) || 1.0),
      title: 'Front scale multiplier',
      onchange: (e) => { this._wheel.frontScaleMul = Number(e.target.value) || 1.0; this._persistWheelSettings(); this._rebuildWheelOverlay(); },
    });
    const rearMul = el('input', {
      type: 'number',
      step: '0.02',
      value: String(Number(this._wheel.rearScaleMul ?? 1.0) || 1.0),
      title: 'Rear scale multiplier',
      onchange: (e) => { this._wheel.rearScaleMul = Number(e.target.value) || 1.0; this._persistWheelSettings(); this._rebuildWheelOverlay(); },
    });
    const widthInput = el('input', {
      type: 'number',
      step: '0.01',
      value: String(Number(this._wheel.placeholderWidth ?? 0.20) || 0.20),
      title: 'Placeholder wheel width (meters)',
      onchange: (e) => { this._wheel.placeholderWidth = Math.max(0.02, Number(e.target.value) || 0.20); this._persistWheelSettings(); this._rebuildWheelOverlay(); },
    });

    const wheelUrlInput = el('input', {
      value: String(this._wheel.wheelUrl || ''),
      placeholder: 'Wheel GLB URL (for “Wheel model” mode)',
      onchange: (e) => { this._wheel.wheelUrl = safeTrim(e.target.value); this._persistWheelSettings(); },
    });

    const wheelStatusEl = el('div', { class: 'muted', style: { marginTop: '6px', whiteSpace: 'pre-line' } }, [
      (() => {
        const st = safeTrim(this._wheelModelStatus || '');
        const err = safeTrim(this._wheelModelError || '');
        const raw = safeTrim(this._wheelGltfUrl || '');
        const resolved = safeTrim(this._wheelGltfUrlResolved || '');
        const urlLine = resolved ? `Loaded from: ${resolved}\n(URL field: ${raw || '(none)'})` : (raw ? `URL field: ${raw}` : '');
        const info = this._wheelAssetInfo;
        const dims = info?.size ? `Asset bounds (local): ${info.size.x.toFixed(3)} × ${info.size.y.toFixed(3)} × ${info.size.z.toFixed(3)}` : '';
        const rad = (info?.outerRadius && Number.isFinite(info.outerRadius)) ? `Asset outerRadius≈${Number(info.outerRadius).toFixed(3)}` : '';
        const wid = (info?.width && Number.isFinite(info.width)) ? `Asset width≈${Number(info.width).toFixed(3)} (axis=${String(info?.widthAxis ?? '')})` : '';
        const geomLine = [dims, rad, wid].filter(Boolean).join('\n');
        if (err) return `Wheel model status: ${st}\n${urlLine}\nError: ${err}\nTip: open the “Loaded from” URL in a new tab and check for 404s.`;
        if (st) return `Wheel model status: ${st}\n${urlLine}${geomLine ? `\n${geomLine}` : ''}`.trim();
        return 'Wheel model status: (not loaded yet)';
      })(),
    ]);

    const loadWheelBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        try {
          const u = safeTrim(this._wheel.wheelUrl);
          if (!u) return;
          await this._loadWheelModel(u);
          this._rebuildWheelOverlay();
          this._syncDetails();
          ctx?.toast?.('Wheel model loaded (preview overlay)', 'success');
        } catch (e) {
          try { this._syncDetails(); } catch { /* ignore */ }
          ctx?.toast?.(`Wheel load failed: ${String(e?.message || e)}`, 'error');
        }
      },
      title: 'Loads the wheel GLB and instances it at wheel anchors',
    }, ['Load wheel GLB']);

    const resetWheelBtn = el('button', {
      onclick: () => {
        try { localStorage.removeItem('devtools.vehicles.wheelOverlay'); } catch { /* ignore */ }
        // Restore defaults (keep existing object shape, overwrite with constructor defaults).
        this._wheel = {
          ...this._wheel,
          enabled: true,
          showAnchors: true,
          showWheels: true,
          mode: 'model',
          wheelUrl: 'external/polyhaven/old_tyre_2k/old_tyre_2k.gltf',
          useMetaScale: true,
          frontScaleMul: 1.0,
          rearScaleMul: 1.0,
          placeholderWidth: 0.20,
          rotXDeg: 0,
          rotYDeg: 0,
          rotZDeg: 0,
          flipRight: false,
        };
        try { wheelUrlInput.value = this._wheel.wheelUrl; } catch { /* ignore */ }
        this._persistWheelSettings();
        this._disposeWheelModel();
        this._rebuildWheelOverlay();
        this._syncDetails();
        ctx?.toast?.('Wheel overlay settings reset', 'info');
      },
      title: 'Clears wheel overlay settings stored in localStorage',
    }, ['Reset wheel settings']);

    const rotX = el('input', {
      type: 'number',
      step: '1',
      value: String(Number(this._wheel.rotXDeg ?? 0) || 0),
      title: 'Rotation X (deg)',
      onchange: (e) => { this._wheel.rotXDeg = Number(e.target.value) || 0; this._persistWheelSettings(); this._rebuildWheelOverlay(); },
    });
    const rotY = el('input', {
      type: 'number',
      step: '1',
      value: String(Number(this._wheel.rotYDeg ?? 0) || 0),
      title: 'Rotation Y (deg)',
      onchange: (e) => { this._wheel.rotYDeg = Number(e.target.value) || 0; this._persistWheelSettings(); this._rebuildWheelOverlay(); },
    });
    const rotZ = el('input', {
      type: 'number',
      step: '1',
      value: String(Number(this._wheel.rotZDeg ?? 0) || 0),
      title: 'Rotation Z (deg)',
      onchange: (e) => { this._wheel.rotZDeg = Number(e.target.value) || 0; this._persistWheelSettings(); this._rebuildWheelOverlay(); },
    });
    const flipRightToggle = el('label', { class: 'muted', style: { display: 'flex', gap: '8px', alignItems: 'center' } }, [
      el('input', {
        type: 'checkbox',
        checked: !!this._wheel.flipRight,
        onchange: (e) => { this._wheel.flipRight = !!e.target.checked; this._persistWheelSettings(); this._rebuildWheelOverlay(); },
      }),
      el('span', {}, ['Flip right-side wheels']),
    ]);

    // Optional quick wheel browsing (best-effort; useful if you have wheel GLBs somewhere in the repo).
    const browseQueryInput = el('input', {
      value: String(this._wheel.browseQuery || 'assets/'),
      placeholder: 'Browse query (e.g. assets/, webautos/)',
      onchange: (e) => { this._wheel.browseQuery = safeTrim(e.target.value) || 'assets/'; this._persistWheelSettings(); },
    });
    const browseSearchInput = el('input', {
      value: String(this._wheel.browseSearch || 'wheel'),
      placeholder: 'Filter (path contains)…',
      oninput: (e) => { this._wheel.browseSearch = safeTrim(e.target.value); this._persistWheelSettings(); this._syncDetails(); },
    });
    const browseBtn = el('button', {
      onclick: async () => {
        try {
          const q = safeTrim(this._wheel.browseQuery || 'assets/');
          const ext = '.glb,.gltf';
          const items = await ctx.assetIndex({ query: q, ext });
          this._wheelBrowseItems = Array.isArray(items) ? items : [];
          this._syncDetails();
        } catch (e) {
          ctx?.toast?.(`Browse failed: ${String(e?.message || e)}`, 'error');
        }
      },
      title: 'Scan for GLB/GLTF files you can use as wheel models',
    }, ['Browse']);

    const browseList = (() => {
      const wrap = el('div', { style: { marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' } });
      const items = Array.isArray(this._wheelBrowseItems) ? this._wheelBrowseItems : [];
      const f = safeTrim(this._wheel.browseSearch || '').toLowerCase();
      const limit = Math.max(10, Math.min(200, Number(this._wheel.browseLimit) || 60));
      const filtered = f
        ? items.filter((x) => String(x?.path || '').toLowerCase().includes(f))
        : items;
      for (const it2 of filtered.slice(0, limit)) {
        const p2 = safeTrim(it2?.path || '');
        if (!p2) continue;
        const url2 = '/' + p2.replace(/^\/+/, '');
        wrap.appendChild(el('button', {
          style: { textAlign: 'left' },
          onclick: () => {
            this._wheel.wheelUrl = url2;
            this._persistWheelSettings();
            try { wheelUrlInput.value = url2; } catch { /* ignore */ }
          },
          title: url2,
        }, [p2]));
      }
      if (!wrap.childNodes.length) {
        wrap.appendChild(el('div', { class: 'muted' }, ['(no browse results yet — press Browse, or paste a wheel URL above)']));
      }
      return wrap;
    })();

    metaCard.appendChild(el('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, [loadMetaBtn]));
    metaCard.appendChild(overlayEnabledToggle);
    metaCard.appendChild(showAnchorsToggle);
    metaCard.appendChild(showWheelsToggle);
    metaCard.appendChild(showRimsToggle);
    metaCard.appendChild(el('div', { class: 'row', style: { marginTop: '8px' } }, [
      el('div', { class: 'muted', style: { minWidth: '90px' } }, ['mode']),
      modeSel,
    ]));
    metaCard.appendChild(useMetaScaleToggle);
    metaCard.appendChild(el('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } }, [
      el('div', { class: 'muted', style: { minWidth: '90px' } }, ['front× / rear×']),
      frontMul,
      rearMul,
      el('div', { class: 'muted', style: { marginLeft: '8px' } }, ['width']),
      widthInput,
    ]));
    metaCard.appendChild(el('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } }, [
      wheelUrlInput,
      loadWheelBtn,
      resetWheelBtn,
    ]));
    metaCard.appendChild(wheelStatusEl);
    metaCard.appendChild(el('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } }, [
      el('div', { class: 'muted', style: { minWidth: '90px' } }, ['rot (deg)']),
      rotX,
      rotY,
      rotZ,
      flipRightToggle,
    ]));
    metaCard.appendChild(el('div', { class: 'muted', style: { marginTop: '8px', whiteSpace: 'pre-line' } }, [
      'Notes:\n' +
      '- This is preview-only; it does not change the vehicle GLB.\n' +
      '- When “Use meta wheelScale” is on, placeholder wheels treat wheelScale as radius (meters).\n' +
      '- For wheel-model mode, wheelScale is treated as a uniform scale factor — adjust multipliers as needed.',
    ]));

    // Show browsing helpers only if metadata exists (otherwise it’s confusing).
    if (hasWheelAnchors) {
      metaCard.appendChild(el('details', { style: { marginTop: '10px' } }, [
        el('summary', { class: 'muted' }, ['(optional) Browse wheel models in project']),
        el('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } }, [browseQueryInput, browseBtn]),
        el('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } }, [browseSearchInput]),
        browseList,
      ]));
    }

    host.appendChild(metaCard);

    // Auto-load meta.json when a model is selected (best-effort).
    // We do this at the end so the card exists even during loading.
    try {
      if (!metaLoaded && metaUrl && metaUrl !== this._metaUrl) void this._loadMeta(metaUrl);
    } catch { /* ignore */ }
  }
}

