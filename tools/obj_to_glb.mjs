import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

// GLTFExporter assumes a browser-like environment. Provide minimal polyfills for Node.
// Node 20+ provides Blob, but not FileReader.
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class FileReader {
    constructor() {
      this.result = null;
      this.error = null;
      this.onload = null;
      this.onloadend = null;
      this.onerror = null;
    }
    async _finishOk(result) {
      this.result = result;
      try { this.onload?.({ target: this }); } catch { /* ignore */ }
      try { this.onloadend?.({ target: this }); } catch { /* ignore */ }
    }
    async _finishErr(err) {
      this.error = err;
      try { this.onerror?.(err); } catch { /* ignore */ }
      try { this.onloadend?.({ target: this }); } catch { /* ignore */ }
    }
    readAsArrayBuffer(blob) {
      Promise.resolve()
        .then(() => blob.arrayBuffer())
        .then((ab) => this._finishOk(ab))
        .catch((e) => this._finishErr(e));
    }
    readAsDataURL(blob) {
      Promise.resolve()
        .then(() => blob.arrayBuffer())
        .then((ab) => {
          const b = Buffer.from(ab);
          const mime = (blob && blob.type) ? String(blob.type) : 'application/octet-stream';
          return `data:${mime};base64,${b.toString('base64')}`;
        })
        .then((url) => this._finishOk(url))
        .catch((e) => this._finishErr(e));
    }
  };
}

function argValue(name, def = '') {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return def;
  return String(process.argv[idx + 1] || def);
}

function must(v, msg) {
  const s = String(v || '').trim();
  if (!s) throw new Error(msg);
  return s;
}

function ensureDir(p) {
  return fsp.mkdir(p, { recursive: true });
}

function forceMaterials(root, { keepMaterials = null } = {}) {
  const keep = (keepMaterials && keepMaterials.size) ? keepMaterials : null;
  const keepArr = keep ? Array.from(keep.values()) : null;
  root.traverse((obj) => {
    if (!obj || !obj.isMesh) return;
    const mesh = obj;
    const mat = mesh.material;
    const matName = (Array.isArray(mat) ? (mat[0]?.name || '') : (mat?.name || ''));
    const name = String(matName || mesh.name || 'mat').trim() || 'mat';
    const key = name.toLowerCase();
    if (keep) {
      const ok = keepArr.some((tok) => {
        const t = String(tok || '').trim().toLowerCase();
        if (!t) return false;
        return key === t || key.includes(t);
      });
      if (!ok) {
        mesh.visible = false;
        return;
      }
      mesh.visible = true;
    }
    mesh.visible = true;
    // Make sure we export something that glTF understands.
    mesh.material = new THREE.MeshStandardMaterial({ name: String(name), color: 0xcccccc, roughness: 0.9, metalness: 0.0 });
    try { mesh.material.side = THREE.DoubleSide; } catch { /* ignore */ }
    try { mesh.castShadow = true; mesh.receiveShadow = true; } catch { /* ignore */ }
    // Defensive: some OBJ meshes may lack normals.
    try {
      const g = mesh.geometry;
      if (g && g.isBufferGeometry) {
        const n = g.getAttribute('normal');
        if (!n || n.count === 0) g.computeVertexNormals();
      }
    } catch { /* ignore */ }
  });
}

function parseObjFaceVertex(tok, { vCount, vtCount, vnCount }) {
  // tok: "v", "v/vt", "v//vn", "v/vt/vn"
  const parts = String(tok || '').split('/');
  const toIdx = (raw, count) => {
    const n = Number.parseInt(String(raw || '').trim(), 10);
    if (!Number.isFinite(n) || n === 0) return null;
    // OBJ indices are 1-based; negatives are relative to end.
    if (n < 0) return (count + 1 + n) || null;
    return n;
  };
  const vi = toIdx(parts[0], vCount);
  const vti = (parts.length >= 2 && parts[1] !== '') ? toIdx(parts[1], vtCount) : null;
  const vni = (parts.length >= 3 && parts[2] !== '') ? toIdx(parts[2], vnCount) : null;
  return { vi, vti, vni };
}

function keepMat(curKey, keepMaterials) {
  if (!keepMaterials || !keepMaterials.size) return true;
  const k = String(curKey || '').trim().toLowerCase();
  if (!k) return false;
  for (const tok of keepMaterials.values()) {
    const t = String(tok || '').trim().toLowerCase();
    if (!t) continue;
    if (k === t || k.includes(t)) return true;
  }
  return false;
}

async function parseObjStream(inAbs, { keepMaterials = null } = {}) {
  const verts = [null];   // 1-indexed
  const uvs = [null];     // 1-indexed
  const norms = [null];   // 1-indexed

  /** @type {Map<string, { name: string, pos: number[], uv: number[], nrm: number[] }>} */
  const buckets = new Map();
  let curMat = 'mat';
  let want = keepMaterials && keepMaterials.size ? keepMaterials : null;

  const getBucket = (name) => {
    const key = String(name || 'mat').trim() || 'mat';
    if (!buckets.has(key)) buckets.set(key, { name: key, pos: [], uv: [], nrm: [] });
    return buckets.get(key);
  };

  const rl = readline.createInterface({
    input: fs.createReadStream(inAbs, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const raw of rl) {
    const line = String(raw || '').trim();
    if (!line || line.startsWith('#')) continue;

    // Fast-path prefixes (avoid split-heavy parsing when possible).
    if (line.startsWith('v ')) {
      const p = line.split(/\s+/);
      if (p.length >= 4) {
        const x = Number(p[1]); const y = Number(p[2]); const z = Number(p[3]);
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) verts.push([x, y, z]);
      }
      continue;
    }
    if (line.startsWith('vt ')) {
      const p = line.split(/\s+/);
      if (p.length >= 3) {
        const u = Number(p[1]); const v = Number(p[2]);
        if (Number.isFinite(u) && Number.isFinite(v)) uvs.push([u, v]);
      }
      continue;
    }
    if (line.startsWith('vn ')) {
      const p = line.split(/\s+/);
      if (p.length >= 4) {
        const x = Number(p[1]); const y = Number(p[2]); const z = Number(p[3]);
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) norms.push([x, y, z]);
      }
      continue;
    }
    if (line.startsWith('usemtl ')) {
      curMat = line.slice(7).trim() || 'mat';
      continue;
    }
    if (line.startsWith('f ')) {
      if (!keepMat(curMat, want)) continue;
      const p = line.split(/\s+/);
      if (p.length < 4) continue;
      const bucket = getBucket(curMat);

      const vCount = verts.length - 1;
      const vtCount = uvs.length - 1;
      const vnCount = norms.length - 1;
      const vs = p.slice(1).map((tok) => parseObjFaceVertex(tok, { vCount, vtCount, vnCount }));

      // Triangulate fan: (0, i, i+1)
      for (let i = 1; i + 1 < vs.length; i++) {
        const tri = [vs[0], vs[i], vs[i + 1]];
        for (const tv of tri) {
          const vi = tv.vi;
          if (!vi || vi < 1 || vi >= verts.length) continue;
          const vv = verts[vi];
          bucket.pos.push(vv[0], vv[1], vv[2]);

          if (tv.vti && tv.vti >= 1 && tv.vti < uvs.length) {
            const uv = uvs[tv.vti];
            bucket.uv.push(uv[0], uv[1]);
          }
          if (tv.vni && tv.vni >= 1 && tv.vni < norms.length) {
            const nn = norms[tv.vni];
            bucket.nrm.push(nn[0], nn[1], nn[2]);
          }
        }
      }
      continue;
    }
  }

  const root = new THREE.Group();
  root.name = 'obj_root';

  for (const b of buckets.values()) {
    if (!b.pos.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    if (b.uv.length === (b.pos.length / 3) * 2) geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    if (b.nrm.length === b.pos.length) geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
    if (!geo.getAttribute('normal')) {
      try { geo.computeVertexNormals(); } catch { /* ignore */ }
    }
    const mat = new THREE.MeshStandardMaterial({ name: String(b.name), color: 0xcccccc, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `mesh_${String(b.name || 'mat')}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
  }

  return root;
}

async function main() {
  const inp = must(argValue('--in'), 'Missing --in <obj>');
  const out = must(argValue('--out'), 'Missing --out <glb>');
  const keepMaterialsRaw = String(argValue('--keep-materials', '') || '').trim();
  const keepMaterials = keepMaterialsRaw
    ? new Set(keepMaterialsRaw.split(',').map((s) => String(s || '').trim().toLowerCase()).filter(Boolean))
    : null;

  const inAbs = path.resolve(inp);
  const outAbs = path.resolve(out);
  await ensureDir(path.dirname(outAbs));

  const st = await fsp.stat(inAbs);
  const bigObj = Number(st?.size || 0) > (300 * 1024 * 1024);

  let root = null;
  if (keepMaterials || bigObj) {
    // Stream parser (avoids huge string allocations; supports material filtering).
    root = await parseObjStream(inAbs, { keepMaterials });
  } else {
    // Fast path for small OBJs: use Three's OBJLoader.
    const objText = await fsp.readFile(inAbs, 'utf8');
    const loader = new OBJLoader();
    root = loader.parse(objText);
  }
  if (!root) throw new Error('OBJ parse failed');

  // Ensure a stable materials setup (we’re not exporting textures yet).
  forceMaterials(root, { keepMaterials });

  const exporter = new GLTFExporter();
  const glb = await new Promise((resolve, reject) => {
    exporter.parse(
      root,
      (res) => resolve(res),
      (err) => reject(err),
      {
        binary: true,
        onlyVisible: true,
        embedImages: false,
        includeCustomExtensions: false,
      },
    );
  });
  if (!(glb instanceof ArrayBuffer)) throw new Error('Expected binary GLB ArrayBuffer');
  const buf = Buffer.from(glb);
  if (buf.length < 10_000) throw new Error(`GLB too small (${buf.length} bytes)`);
  await fsp.writeFile(outAbs, buf);

  process.stdout.write(`OBJ_TO_GLB_OK ${outAbs} bytes=${buf.length}\n`);
}

main().catch((e) => {
  process.stderr.write(`OBJ_TO_GLB_ERROR ${e?.stack || e?.message || e}\n`);
  process.exit(1);
});

