// Camera-proximal streaming for instanced-box tiles.
//
// This is a minimal port of the original viewer's chunk-streaming idea:
// - compute wanted chunk keys around the camera
// - load a bounded number of new chunks per update (avoid request spikes)
// - allow cancellation (eviction intentionally disabled so we can accumulate a whole metro region)
// - rebuild the GPU instance buffer only when the wanted/loaded set changes

function _nowMs() {
  try { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); } catch { return Date.now(); }
}

function _dist2(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

export class InstancedTilesStreamer {
  constructor({ fetchImpl = null } = {}) {
    // Some environments require fetch to be called with the correct global `this`.
    // Store a bound function to avoid "Illegal invocation".
    const f = fetchImpl || globalThis.fetch;
    this._fetch = (typeof f === 'function') ? f.bind(globalThis) : null;
    this.index = null; // loaded index.json
    this.ready = false;
    this._baseDir = '';
    this._chunkMagic = 'BUI1';

    this.chunkSizeMeters = 512;
    this.radiusChunks = 8;
    // If true, ignore camera radius and stream/render the entire index chunk set.
    // Useful for metro-scale datasets where we want to eventually load everything.
    this.loadAllChunks = false;
    this.maxNewLoadsPerUpdate = 8;
    this.updateEveryMs = 160;
    // If true, evict chunks that are no longer wanted (caps memory for huge datasets).
    // Default false to preserve the previous "accumulate whole metro region" behavior.
    this.evictUnwanted = false;

    // key -> Float32Array (BUI1, or BUI2 decoded) OR packed chunk object (BUI2 packed mode)
    this.loaded = new Map();
    this.loading = new Map(); // key -> { controller, token }
    this._nextToken = 1;

    this._lastWantedKeys = [];
    this._dirtyMerged = true;
    this._lastUpdateMs = 0;

    // Hook: called when merged buffer changes
    this.onMergedInstances = null; // (bufFloat32, instCount) => void
    // Hook: called with the set of wanted+loaded chunks (enables per-chunk GPU render without merges).
    // When set, BUI2 chunks are kept packed (Uint8Array) instead of decoded to float32.
    this.onWantedChunks = null; // (chunksArray, totalInstanceCount) => void
  }

  _allIndexKeys() {
    const chunks = this.index?.chunks || null;
    if (!chunks) return [];
    // Preserve insertion order from JSON parse (stable) to avoid re-sorting huge lists every frame.
    // (The loader loop will still make progress via maxNewLoadsPerUpdate.)
    return Object.keys(chunks);
  }

  async init(indexUrl) {
    const url = String(indexUrl || '').trim();
    if (!url) throw new Error('InstancedTilesStreamer.init: missing indexUrl');
    if (!this._fetch) throw new Error('InstancedTilesStreamer: fetch is not available');
    // Base dir for resolving relative chunk paths.
    this._baseDir = url.replace(/\/[^\/?#]+(\?|#|$).*/g, '');
    const resp = await this._fetch(url);
    if (!resp.ok) throw new Error(`InstancedTilesStreamer: failed to fetch index: ${resp.status}`);
    const idx = await resp.json();
    if (!idx || idx.schema !== 'webglgta-dataset-tiles-v1') throw new Error('InstancedTilesStreamer: bad index schema');
    const magic = String(idx.chunkMagic || 'BUI1');
    // Supported building tile formats:
    // - BUI1: float32 instances (count * 11 float32)
    // - BUI2: packed instances (quantized u16 + i16 + u8), decoded to float32 at load time
    if (magic !== 'BUI1' && magic !== 'BUI2') throw new Error(`InstancedTilesStreamer: unsupported chunkMagic ${String(idx.chunkMagic)}`);
    this.index = idx;
    this._chunkMagic = magic;
    this.chunkSizeMeters = Number(idx.chunkSizeMeters) || this.chunkSizeMeters;
    this.ready = true;
    return true;
  }

  dispose() {
    for (const { controller } of this.loading.values()) {
      try { controller.abort(); } catch { /* ignore */ }
    }
    this.loading.clear();
    this.loaded.clear();
    this.index = null;
    this.ready = false;
    this._dirtyMerged = true;
    this._lastWantedKeys = [];
  }

  _chunkKeyForXZ(x, z) {
    const cs = Math.max(1e-6, Number(this.chunkSizeMeters) || 512);
    const cx = Math.floor(Number(x) / cs);
    const cz = Math.floor(Number(z) / cs);
    return `${cx}_${cz}`;
  }

  _wantedKeys(camera) {
    if (!this.index) return [];
    if (this.loadAllChunks) return this._allIndexKeys();
    const cs = Math.max(1e-6, Number(this.chunkSizeMeters) || 512);
    const r = Math.max(1, Math.floor(this.radiusChunks));
    const x = Number(camera?.position?.[0] ?? 0);
    const z = Number(camera?.position?.[2] ?? 0);
    const cx = Math.floor(x / cs);
    const cz = Math.floor(z / cs);

    const keys = [];
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        keys.push(`${cx + dx}_${cz + dz}`);
      }
    }

    // Sort by distance to camera chunk center (good enough).
    const camCx = (cx + 0.5) * cs;
    const camCz = (cz + 0.5) * cs;
    keys.sort((a, b) => {
      const [ax, az] = a.split('_').map((v) => Number(v));
      const [bx, bz] = b.split('_').map((v) => Number(v));
      const ad = _dist2((ax + 0.5) * cs, (az + 0.5) * cs, camCx, camCz);
      const bd = _dist2((bx + 0.5) * cs, (bz + 0.5) * cs, camCx, camCz);
      return ad - bd;
    });
    return keys;
  }

  async _loadChunk(key, { priority = 'high' } = {}) {
    if (!this.index) return;
    const meta = this.index?.chunks?.[key];
    if (!meta || !meta.file) return; // missing chunk -> treat as empty
    if (this.loaded.has(key) || this.loading.has(key)) return;

    const controller = new AbortController();
    const token = (this._nextToken++ >>> 0);
    this.loading.set(key, { controller, token });
    const signal = controller.signal;

    try {
      const file0 = String(meta.file);
      const url = (file0.startsWith('http://') || file0.startsWith('https://') || file0.startsWith('/'))
        ? file0
        : (this._baseDir ? `${this._baseDir}/${file0}` : file0);
      const resp = await this._fetch(url, signal ? { signal } : undefined);
      if (!resp.ok) return;
      const ab = await resp.arrayBuffer();
      if (signal.aborted) return;
      const view = new DataView(ab);
      if (view.byteLength < 8) return;
      const magic =
        String.fromCharCode(view.getUint8(0)) +
        String.fromCharCode(view.getUint8(1)) +
        String.fromCharCode(view.getUint8(2)) +
        String.fromCharCode(view.getUint8(3));
      if (magic !== 'BUI1' && magic !== 'BUI2') return;
      const count = view.getUint32(4, true);
      if (!Number.isFinite(count) || count <= 0) return;

      /** @type {any} */
      let payload = null;
      if (magic === 'BUI1') {
        const floats = count * 11;
        const need = 8 + floats * 4;
        if (need > view.byteLength) return;
        payload = new Float32Array(ab, 8, floats);
      } else if (magic === 'BUI2') {
        // Packed chunk format (little-endian):
        // 0..3   magic 'BUI2'
        // 4..7   u32 count
        // 8..27  f32 chunkMinX, chunkMinZ, chunkSize, maxTy, maxScale
        // 28..   count records: <6H h 4B> = 18 bytes each
        const hdr = 8 + 5 * 4;
        const recBytes = 18;
        const need = hdr + count * recBytes;
        if (need > view.byteLength) return;

        const chunkMinX = view.getFloat32(8, true);
        const chunkMinZ = view.getFloat32(12, true);
        const chunkSize = view.getFloat32(16, true);
        const maxTy = view.getFloat32(20, true);
        const maxScale = view.getFloat32(24, true);
        const cs = (Number.isFinite(chunkSize) && chunkSize > 0) ? chunkSize : (Number(this.chunkSizeMeters) || 512);
        const tyMax = (Number.isFinite(maxTy) && maxTy > 0) ? maxTy : 256.0;
        const scMax = (Number.isFinite(maxScale) && maxScale > 0) ? maxScale : 256.0;

        // If caller wants per-chunk rendering, keep packed records and provide header.
        if (typeof this.onWantedChunks === 'function') {
          payload = {
            magic: 'BUI2',
            count,
            header: { chunkMinX, chunkMinZ, chunkSize: cs, maxTy: tyMax, maxScale: scMax },
            data: new Uint8Array(ab, hdr, count * recBytes),
          };
        } else {
          // Back-compat: decode to float32 so it can be merged and fed into InstancedBoxRenderer.
          const out = new Float32Array(count * 11);
          const invU16 = 1.0 / 65535.0;
          const invI16 = 1.0 / 32767.0;
          let offB = hdr;
          let offF = 0;
          for (let i = 0; i < count; i++) {
            const txu = view.getUint16(offB + 0, true);
            const tyu = view.getUint16(offB + 2, true);
            const tzu = view.getUint16(offB + 4, true);
            const sxu = view.getUint16(offB + 6, true);
            const syu = view.getUint16(offB + 8, true);
            const szu = view.getUint16(offB + 10, true);
            const yawI = view.getInt16(offB + 12, true);
            const r8 = view.getUint8(offB + 14);
            const g8 = view.getUint8(offB + 15);
            const b8 = view.getUint8(offB + 16);
            const a8 = view.getUint8(offB + 17);
            offB += recBytes;

            const tx = chunkMinX + (txu * invU16) * cs;
            const tz = chunkMinZ + (tzu * invU16) * cs;
            const ty = (tyu * invU16) * tyMax;
            const sx = (sxu * invU16) * scMax;
            const sy = (syu * invU16) * scMax;
            const sz = (szu * invU16) * scMax;
            const yaw = (yawI * invI16) * Math.PI;

            out[offF + 0] = tx;
            out[offF + 1] = ty;
            out[offF + 2] = tz;
            out[offF + 3] = sx;
            out[offF + 4] = sy;
            out[offF + 5] = sz;
            out[offF + 6] = yaw;
            out[offF + 7] = r8 / 255.0;
            out[offF + 8] = g8 / 255.0;
            out[offF + 9] = b8 / 255.0;
            out[offF + 10] = a8 / 255.0;
            offF += 11;
          }
          payload = out;
        }
      }
      if (!payload) return;

      // stale?
      const live = this.loading.get(key);
      if (!live || live.token !== token || signal.aborted) return;

      this.loading.delete(key);
      // Preserve key on packed payloads for convenience.
      if (payload && typeof payload === 'object' && payload.magic === 'BUI2') payload.key = key;
      this.loaded.set(key, payload);
      this._dirtyMerged = true;
    } catch (e) {
      // Abort or fetch error; ignore.
      try { this.loading.delete(key); } catch { /* ignore */ }
    }
  }

  _mergeWanted(wantedKeys) {
    // Only include chunks that exist in index + are loaded.
    const idxChunks = this.index?.chunks || {};
    let totalFloats = 0;
    const arrs = [];
    for (const k of wantedKeys) {
      if (!idxChunks[k]) continue;
      const a = this.loaded.get(k);
      if (!a) continue;
      totalFloats += a.length;
      arrs.push(a);
    }
    if (totalFloats <= 0) return new Float32Array(0);
    const out = new Float32Array(totalFloats);
    let off = 0;
    for (const a of arrs) {
      out.set(a, off);
      off += a.length;
    }
    return out;
  }

  update(camera, { force = false } = {}) {
    if (!this.ready || !this.index) return;
    const now = _nowMs();
    if (!force && (now - (this._lastUpdateMs || 0)) < (this.updateEveryMs || 160)) return;
    this._lastUpdateMs = now;

    const wanted = this._wantedKeys(camera);

    // Optional eviction: keep memory bounded for huge datasets.
    if (this.evictUnwanted && !this.loadAllChunks) {
      const wantedSet = new Set(wanted);
      let evictedAny = false;
      for (const k of this.loaded.keys()) {
        if (!wantedSet.has(k)) {
          this.loaded.delete(k);
          evictedAny = true;
        }
      }
      if (evictedAny) this._dirtyMerged = true;
    }

    // Start new loads with a small budget.
    const budget = Math.max(1, Math.floor(this.maxNewLoadsPerUpdate));
    let started = 0;
    for (let i = 0; i < wanted.length; i++) {
      if (started >= budget) break;
      const k = wanted[i];
      if (this.loaded.has(k) || this.loading.has(k)) continue;
      started++;
      void this._loadChunk(k, { priority: (i < 9) ? 'high' : 'low' });
    }

    // Rebuild output only when needed.
    const wantedChanged =
      wanted.length !== this._lastWantedKeys.length ||
      wanted.some((v, i) => v !== this._lastWantedKeys[i]);
    if (wantedChanged) {
      this._lastWantedKeys = wanted.slice();
      this._dirtyMerged = true;
    }
    if (!this._dirtyMerged) return;

    this._dirtyMerged = false;

    if (typeof this.onWantedChunks === 'function') {
      const idxChunks = this.index?.chunks || {};
      /** @type {any[]} */
      const out = [];
      let total = 0;
      for (const k of wanted) {
        if (!idxChunks[k]) continue;
        const v = this.loaded.get(k);
        if (!v) continue;
        if (v instanceof Float32Array) {
          // If caller asked for chunks but we have float32, wrap it anyway.
          out.push({ key: k, magic: 'BUI1', count: Math.floor(v.length / 11), float32: v });
          total += Math.floor(v.length / 11);
        } else if (v && v.magic === 'BUI2') {
          out.push(v);
          total += Number(v.count) || 0;
        }
      }
      try { this.onWantedChunks(out, total); } catch { /* ignore */ }
      return;
    }

    const merged = this._mergeWanted(wanted);
    const instCount = Math.floor(merged.length / 11);
    if (typeof this.onMergedInstances === 'function') {
      try { this.onMergedInstances(merged, instCount); } catch { /* ignore */ }
    }
  }
}


