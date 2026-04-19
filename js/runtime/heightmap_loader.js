function clamp(n, a, b) {
  const x = Number(n);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

async function fetchJsonMaybeGzip(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  const u = String(url || '').toLowerCase();
  if (u.endsWith('.gz')) {
    if (!resp.body) throw new Error(`Failed to stream ${url}`);
    if (typeof DecompressionStream === 'undefined') {
      throw new Error(`DecompressionStream not available; cannot read ${url}. Use .json instead of .json.gz.`);
    }
    const ds = new DecompressionStream('gzip');
    const decompressed = resp.body.pipeThrough(ds);
    const text = await new Response(decompressed).text();
    return JSON.parse(text);
  }
  return await resp.json();
}

async function fetchArrayBuffer(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  return await resp.arrayBuffer();
}

function swapU16Endian(u16) {
  for (let i = 0; i < u16.length; i++) {
    const v = u16[i];
    u16[i] = ((v & 0xff) << 8) | ((v >> 8) & 0xff);
  }
}

function resolveSiblingUrl(metaUrl, fileName) {
  const base = String(metaUrl || '');
  const i = base.lastIndexOf('/');
  if (i < 0) return String(fileName || '');
  return base.slice(0, i + 1) + String(fileName || '');
}

/**
 * Loads the viewer heightmap format:
 *  - JSON: { width, height, file, endian, minZ?, maxZ? }
 *  - BIN: raw uint16 samples, row-major, top-to-bottom
 *
 * Returned heights are a Uint16Array with values in [0, 65535] (already normalized).
 */
export async function loadHeightmapU16(metaUrl) {
  const meta = await fetchJsonMaybeGzip(metaUrl);
  const width = Math.max(2, Number(meta?.width) | 0);
  const height = Math.max(2, Number(meta?.height) | 0);
  const file = String(meta?.file || '');
  if (!file) throw new Error(`Heightmap meta missing 'file': ${metaUrl}`);

  const endian = String(meta?.endian || 'little').toLowerCase();
  const binUrl = resolveSiblingUrl(metaUrl, file);
  const ab = await fetchArrayBuffer(binUrl);
  const u16 = new Uint16Array(ab);
  if (u16.length < width * height) {
    throw new Error(`Heightmap bin too small: got ${u16.length} samples, expected ${width * height} (${binUrl})`);
  }
  if (endian === 'big') swapU16Endian(u16);

  const minZRaw = Number(meta?.minZ);
  const maxZRaw = Number(meta?.maxZ);
  const minZ = Number.isFinite(minZRaw) ? minZRaw : NaN;
  const maxZ = Number.isFinite(maxZRaw) ? maxZRaw : NaN;
  return { width, height, heightsU16: u16, minZ, maxZ, meta };
}


