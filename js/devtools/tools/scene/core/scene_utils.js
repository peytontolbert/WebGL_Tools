export function safeTrim(s) { return String(s ?? '').trim(); }

export function lerp(a, b, t) { return a + (b - a) * t; }
export function clamp01(x) { return Math.max(0, Math.min(1, Number(x) || 0)); }

export function debounce(fn, ms = 150) {
  let t = 0;
  return (...args) => {
    try { clearTimeout(t); } catch { /* ignore */ }
    t = setTimeout(() => fn(...args), Math.max(0, Number(ms) || 0));
  };
}

export function normQuery(s) {
  return String(s || '').trim().toLowerCase();
}

export function extOf(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i).toLowerCase() : '';
}

export function isCharacterProfileAssetPath(raw) {
  const s = safeTrim(raw).replace(/\\/g, '/').toLowerCase();
  if (!s || extOf(s) !== '.json') return false;
  if (s.endsWith('/character_manifest.json')) return true;
  if (s.endsWith('/locomotion_profile.json')) return true;
  return false;
}

export function isGlTfExt(ext) { return ext === '.glb' || ext === '.gltf'; }
export function isUsdExt(ext) { return ext === '.usd' || ext === '.usda' || ext === '.usdc' || ext === '.usdz'; }
export function isConvertibleSceneExt(ext) { return isUsdExt(ext) || ext === '.fbx'; }
export function isProceduralPath(p) { return String(p || '').trim().toLowerCase().startsWith('proc:'); }

export function resizeCanvasToDisplaySize(canvasEl, maxDpr = 2.0) {
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

export function disposeThreeObject(obj) {
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

export function safeName(s) {
  const raw = String(s || '').trim();
  const out = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
  return out || 'scene';
}

export function getFileStem(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const base = s.split('/').pop() || s;
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(0, i) : base;
}

export function normalizeAssetUrl(raw) {
  const s = safeTrim(raw).replace(/\\/g, '/');
  if (!s) return '';
  // Keep absolute URLs; otherwise resolve relative to the document base URL.
  // This is critical for static hosting under a subpath (e.g. GitHub Pages), where forcing `/...`
  // would incorrectly point to the origin root and break model loads.
  if (s.startsWith('http://') || s.startsWith('https://')) return s;
  try {
    const base = String(document?.baseURI || window?.location?.href || '');
    const rel = s.startsWith('/') ? s.slice(1) : s;
    return new URL(rel, base).toString();
  } catch {
    // Fallback: keep the original string.
    return s;
  }
}

export function metaUrlForModelUrl(raw) {
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

export function resumeAssetCandidates(raw) {
  // Resume export prefers assets under `resume/` (dist/resume/*),
  // but in dev it’s common to only have the root assets present.
  const s0 = safeTrim(raw).replace(/\\/g, '/');
  if (!s0) return [];
  const out = [s0];
  try {
    if (s0.startsWith('resume/')) out.push(s0.slice('resume/'.length));
    if (s0.startsWith('/resume/')) out.push('/' + s0.slice('/resume/'.length));
  } catch { /* ignore */ }
  // Dedup while preserving order.
  const seen = new Set();
  const uniq = [];
  for (const s of out) {
    const k = safeTrim(s);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    uniq.push(k);
  }
  return uniq;
}

export function disableCreateImageBitmapForResumeExport() {
  // GLTFLoader chooses ImageBitmapLoader when `createImageBitmap` exists.
  // In some environments, decoding large embedded PNGs via createImageBitmap fails,
  // which surfaces as "THREE.GLTFLoader: Couldn't load texture blob:...".
  // For resume exports, prefer the more compatible HTMLImageElement decode path.
  try {
    const key = 'createImageBitmap';
    const desc = Object.getOwnPropertyDescriptor(globalThis, key);
    const canDefine = !desc || desc.configurable;
    if (canDefine) {
      Object.defineProperty(globalThis, key, { value: undefined, writable: true, configurable: true });
    } else {
      // Best-effort fallback; may no-op if non-writable.
      try { globalThis[key] = undefined; } catch { /* ignore */ }
    }
    try { globalThis.__resumeDisableImageBitmap = true; } catch { /* ignore */ }
  } catch { /* ignore */ }
}

export function normalizeWebUrl(raw) {
  const s = safeTrim(raw);
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return '';
}

export function uniqStrings(arr) {
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

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function degToRad(deg) {
  return (Number(deg) || 0) * (Math.PI / 180);
}
