// Camera-proximal streaming for building-footprint tiles (BFP1).
//
// Intended use:
// - huge city coverage: keep far LOD as instanced boxes (BUI1)
// - near camera: load BFP1 tiles and generate extruded mesh from footprints
//
// This is purposefully "dumb": it loads chunks and returns decoded footprint buildings.
// The caller decides how/when to triangulate/extrude and render.

function _nowMs() {
  try { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); } catch { return Date.now(); }
}

function _dist2(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

export class BuildingFootprintsTilesStreamer {
  constructor({ fetchImpl = null } = {}) {
    const f = fetchImpl || globalThis.fetch;
    this._fetch = (typeof f === 'function') ? f.bind(globalThis) : null;
    this.index = null;
    this.ready = false;
    this._baseDir = '';

    this.chunkSizeMeters = 512;
    this.quantizeMeters = 0.1;
    this.radiusChunks = 3;
    this.maxNewLoadsPerUpdate = 6;
    this.updateEveryMs = 160;

    this.loaded = new Map(); // key -> decoded buildings array
    this.loading = new Map(); // key -> { controller, token }
    this._nextToken = 1;

    this._lastWantedKeys = [];
    this._dirtyMerged = true;
    this._lastUpdateMs = 0;

    this.onMergedBuildings = null; // (buildingsArray, buildingCount) => void
  }

  _allIndexKeys() {
    const chunks = this.index?.chunks || null;
    if (!chunks) return [];
    return Object.keys(chunks);
  }

  async init(indexUrl) {
    const url = String(indexUrl || '').trim();
    if (!url) throw new Error('BuildingFootprintsTilesStreamer.init: missing indexUrl');
    if (!this._fetch) throw new Error('BuildingFootprintsTilesStreamer: fetch is not available');
    this._baseDir = url.replace(/\/[^\/?#]+(\?|#|$).*/g, '');
    const resp = await this._fetch(url);
    if (!resp.ok) throw new Error(`BuildingFootprintsTilesStreamer: failed to fetch index: ${resp.status}`);
    const idx = await resp.json();
    if (!idx || idx.schema !== 'webglgta-dataset-tiles-v1') throw new Error('BuildingFootprintsTilesStreamer: bad index schema');
    if (idx.chunkMagic !== 'BFP1') throw new Error(`BuildingFootprintsTilesStreamer: unsupported chunkMagic ${String(idx.chunkMagic)}`);
    this.index = idx;
    this.chunkSizeMeters = Number(idx.chunkSizeMeters) || this.chunkSizeMeters;
    this.quantizeMeters = Number(idx.quantizeMeters) || this.quantizeMeters;
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

  _wantedKeys(camera) {
    if (!this.index) return [];
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

  _decodeChunkBFP1(ab) {
    const view = new DataView(ab);
    if (view.byteLength < 8) return [];
    const magic =
      String.fromCharCode(view.getUint8(0)) +
      String.fromCharCode(view.getUint8(1)) +
      String.fromCharCode(view.getUint8(2)) +
      String.fromCharCode(view.getUint8(3));
    if (magic !== 'BFP1') return [];
    const count = view.getUint32(4, true);
    let off = 8;
    const q = Number(this.quantizeMeters) || 0.1;
    /** @type {{ ringXZ: number[][], centerXZ: [number, number], minY: number, maxY: number, color: number[] }[]} */
    const out = [];
    for (let i = 0; i < count; i++) {
      if (off + (4 * 8) + 2 > view.byteLength) break;
      const cx = view.getFloat32(off + 0, true);
      const cz = view.getFloat32(off + 4, true);
      const minY = view.getFloat32(off + 8, true);
      const maxY = view.getFloat32(off + 12, true);
      const r = view.getFloat32(off + 16, true);
      const g = view.getFloat32(off + 20, true);
      const b = view.getFloat32(off + 24, true);
      const a = view.getFloat32(off + 28, true);
      const n = view.getUint16(off + 32, true);
      off += 34;
      const need = n * 4;
      if (off + need > view.byteLength) break;
      const ringXZ = [];
      for (let j = 0; j < n; j++) {
        const dx = view.getInt16(off + j * 4 + 0, true);
        const dz = view.getInt16(off + j * 4 + 2, true);
        ringXZ.push([cx + dx * q, cz + dz * q]);
      }
      off += need;
      out.push({
        ringXZ,
        centerXZ: [cx, cz],
        minY,
        maxY,
        color: [r, g, b, a],
      });
    }
    return out;
  }

  async _loadChunk(key) {
    if (!this.index) return;
    const meta = this.index?.chunks?.[key];
    if (!meta || !meta.file) return;
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
      const decoded = this._decodeChunkBFP1(ab);

      const live = this.loading.get(key);
      if (!live || live.token !== token || signal.aborted) return;
      this.loading.delete(key);
      this.loaded.set(key, decoded);
      this._dirtyMerged = true;
    } catch {
      try { this.loading.delete(key); } catch { /* ignore */ }
    }
  }

  _mergeWanted(wantedKeys) {
    const idxChunks = this.index?.chunks || {};
    /** @type {any[]} */
    const out = [];
    for (const k of wantedKeys) {
      if (!idxChunks[k]) continue;
      const arr = this.loaded.get(k);
      if (!arr || !arr.length) continue;
      for (let i = 0; i < arr.length; i++) out.push(arr[i]);
    }
    return out;
  }

  update(camera, { force = false } = {}) {
    if (!this.ready || !this.index) return;
    const now = _nowMs();
    if (!force && (now - (this._lastUpdateMs || 0)) < (this.updateEveryMs || 160)) return;
    this._lastUpdateMs = now;

    const wanted = this._wantedKeys(camera);

    const budget = Math.max(1, Math.floor(this.maxNewLoadsPerUpdate));
    let started = 0;
    for (let i = 0; i < wanted.length; i++) {
      if (started >= budget) break;
      const k = wanted[i];
      if (this.loaded.has(k) || this.loading.has(k)) continue;
      started++;
      void this._loadChunk(k);
    }

    const wantedChanged =
      wanted.length !== this._lastWantedKeys.length ||
      wanted.some((v, i) => v !== this._lastWantedKeys[i]);
    if (wantedChanged) {
      this._lastWantedKeys = wanted.slice();
      this._dirtyMerged = true;
    }
    if (!this._dirtyMerged) return;

    const merged = this._mergeWanted(wanted);
    this._dirtyMerged = false;
    if (typeof this.onMergedBuildings === 'function') {
      try { this.onMergedBuildings(merged, merged.length); } catch { /* ignore */ }
    }
  }
}


