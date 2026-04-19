import { defineConfig } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import sirv from 'sirv';
import crypto from 'node:crypto';
import child_process from 'node:child_process';

function contentTypeForPath(p) {
  const ext = String(path.extname(p || '')).toLowerCase();
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.bin') return 'application/octet-stream';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.ktx2') return 'image/ktx2';
  if (ext === '.geojson') return 'application/geo+json; charset=utf-8';
  if (ext === '.obj') return 'text/plain; charset=utf-8';
  if (ext === '.mp4') return 'video/mp4';
  return 'application/octet-stream';
}

function safeJoin(rootDir, urlPath) {
  const rel = String(urlPath || '').replace(/^\/+/, '');
  const full = path.join(rootDir, rel);
  const normRoot = path.resolve(rootDir) + path.sep;
  const normFull = path.resolve(full);
  if (!normFull.startsWith(normRoot)) return null;
  return normFull;
}

function addPrecompressedGzipMiddleware(server, baseUrl, roots) {
  server.middlewares.use(baseUrl, (req, res, next) => {
    try {
      if (!req || !res) return next();
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const ae = String(req.headers?.['accept-encoding'] || '');
      if (!/\bgzip\b/i.test(ae)) return next();
      const rawUrl = String(req.url || '');
      const q = rawUrl.indexOf('?');
      const urlPath = (q >= 0) ? rawUrl.slice(0, q) : rawUrl;
      if (!urlPath || urlPath.endsWith('.gz')) return next();
      const decoded = decodeURIComponent(urlPath);

      for (const root of roots) {
        const full = safeJoin(root, decoded);
        if (!full) continue;
        const gz = full + '.gz';
        if (!fs.existsSync(gz)) continue;

        res.statusCode = 200;
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', 'Accept-Encoding');
        res.setHeader('Content-Type', contentTypeForPath(full));
        res.setHeader('Cache-Control', 'public, max-age=3600');
        fs.createReadStream(gz).pipe(res);
        return;
      }
    } catch {
      // fall through
    }
    next();
  });
}

function listFilesRecursive(rootDir, { maxFiles = 20000 } = {}) {
  const out = [];
  const stack = [rootDir];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { ents = []; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile()) {
        out.push(p);
      }
      if (out.length >= maxFiles) break;
    }
  }
  return out;
}

function toPosix(p) {
  return String(p || '').split(path.sep).join('/');
}

export default defineConfig({
  base: './',
  plugins: [
    {
      name: 'webgl-editor-runtime-assets',
      configureServer(server) {
        const root = path.resolve(__dirname);
        const runtimeAssets = path.join(root, 'assets');
        const runtimeOutputs = path.join(root, 'outputs');
        const runtimeWebautos = path.join(root, 'webautos');
        const runtimeAssetto = path.join(root, 'assetto');
        const mesh2motionImages = path.join(root, 'repos', 'mesh2motion-app', 'static', 'images');

        // Guardrail: it's easy to accidentally open built output under the dev server,
        // e.g. http://.../dist/devtools.html, which will 404 on ./bundled/* and look "randomly broken".
        // In dev, always use /devtools.html (source) instead of /dist/*.
        server.middlewares.use('/dist', (req, res, next) => {
          try {
            if (!req || !res) return next();
            res.statusCode = 404;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('Do not open /dist/* in dev. Use /devtools.html (dev server) or run `npm run build && npm run preview` and open /devtools.html there.');
          } catch {
            next();
          }
        });

        // Mesh2Motion embedded pages expect icons under /mesh2motion/images/...
        try {
          if (fs.existsSync(mesh2motionImages)) {
            server.middlewares.use('/mesh2motion/images', sirv(mesh2motionImages, { dev: true, etag: true, single: false }));
          }
        } catch { /* ignore */ }

        addPrecompressedGzipMiddleware(server, '/assets', [runtimeAssets]);
        server.middlewares.use('/assets', sirv(runtimeAssets, { dev: true, etag: true, single: false }));
        server.middlewares.use('/assets', (req, res, next) => {
          if (res.headersSent) return next();
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Not found');
        });

        // Devtools quality-of-life: allow previewing generated images/videos under outputs/.
        addPrecompressedGzipMiddleware(server, '/outputs', [runtimeOutputs]);
        server.middlewares.use('/outputs', sirv(runtimeOutputs, { dev: true, etag: true, single: false }));
        server.middlewares.use('/outputs', (req, res, next) => {
          if (res.headersSent) return next();
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Not found');
        });

        // Allow previewing converted vehicle GLBs (e.g. GTA/FiveM -> GLB) under webautos/.
        addPrecompressedGzipMiddleware(server, '/webautos', [runtimeWebautos]);
        server.middlewares.use('/webautos', sirv(runtimeWebautos, { dev: true, etag: true, single: false }));
        server.middlewares.use('/webautos', (req, res, next) => {
          if (res.headersSent) return next();
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Not found');
        });

        // Allow devtools to access a local Assetto Corsa install checked into ./assetto/.
        // This enables workflows where external tools export a GLB + .meta.json directly next to the source car.
        server.middlewares.use('/assetto', sirv(runtimeAssetto, { dev: true, etag: true, single: false }));
        server.middlewares.use('/assetto', (req, res, next) => {
          if (res.headersSent) return next();
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Not found');
        });
      },
      configurePreviewServer(server) {
        const root = path.resolve(__dirname);
        const distAssets = path.join(root, 'dist', 'assets');
        const runtimeAssets = path.join(root, 'assets');
        const runtimeOutputs = path.join(root, 'outputs');
        const runtimeWebautos = path.join(root, 'webautos');
        const runtimeAssetto = path.join(root, 'assetto');
        const hasDist = fs.existsSync(distAssets);
        if (hasDist) {
          addPrecompressedGzipMiddleware(server, '/assets', [distAssets, runtimeAssets]);
          server.middlewares.use('/assets', sirv(distAssets, { dev: false, etag: true, single: false }));
          server.middlewares.use('/assets', sirv(runtimeAssets, { dev: false, etag: true, single: false }));
        } else {
          addPrecompressedGzipMiddleware(server, '/assets', [runtimeAssets]);
          server.middlewares.use('/assets', sirv(runtimeAssets, { dev: false, etag: true, single: false }));
        }
        server.middlewares.use('/assets', (req, res, next) => {
          if (res.headersSent) return next();
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Not found');
        });

        // Preview server should also serve outputs/ for devtools.
        addPrecompressedGzipMiddleware(server, '/outputs', [runtimeOutputs]);
        server.middlewares.use('/outputs', sirv(runtimeOutputs, { dev: false, etag: true, single: false }));
        server.middlewares.use('/outputs', (req, res, next) => {
          if (res.headersSent) return next();
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Not found');
        });

        // Preview converted vehicle GLBs under webautos/.
        addPrecompressedGzipMiddleware(server, '/webautos', [runtimeWebautos]);
        server.middlewares.use('/webautos', sirv(runtimeWebautos, { dev: false, etag: true, single: false }));
        server.middlewares.use('/webautos', (req, res, next) => {
          if (res.headersSent) return next();
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Not found');
        });

        // Preview server should also expose local assetto/ for devtools.
        server.middlewares.use('/assetto', sirv(runtimeAssetto, { dev: false, etag: true, single: false }));
        server.middlewares.use('/assetto', (req, res, next) => {
          if (res.headersSent) return next();
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Not found');
        });
      },
    },
    {
      name: 'webgl-editor-dev-endpoints',
      configureServer(server) {
        const root = path.resolve(__dirname);
        const assetsRoot = path.join(root, 'assets');
        const outputsRoot = path.join(root, 'outputs');
        const webautosRoot = path.join(root, 'webautos');
        const riggingMapsRoot = path.join(root, 'tools', 'rigging', 'mappings');
        const outDir = path.join(root, 'tools', 'out', 'asset_requests');
        const trellisOutRoot = path.join(root, 'assets', 'generated', 'trellis');
        const trellisWorkRoot = path.join(root, 'tools', 'out', 'trellis');
        const trellisRetextureOutRoot = path.join(root, 'assets', 'generated', 'trellis_retexture');
        const trellisRetextureWorkRoot = path.join(root, 'tools', 'out', 'trellis_retexture');
        const trellisRenderOutRoot = path.join(root, 'assets', 'generated', 'trellis_render');
        const trellisDatasetWorkRoot = path.join(root, 'tools', 'out', 'trellis_dataset');
        const ovoxelOutRoot = path.join(root, 'assets', 'generated', 'ovoxel');
        const ovoxelWorkRoot = path.join(root, 'tools', 'out', 'ovoxel_lab');
        const zimageOutRoot = path.join(root, 'assets', 'generated', 'zimage');
        const convertOutRoot = path.join(root, 'assets', 'generated', 'convert');
        const rigOutRoot = path.join(root, 'assets', 'generated', 'rig');
        // Canonical place for retargeted clips (checked into the repo if you want).
        // DevTools should make it easy to say "walk/idle/run" and get a predictable path.
        const animOutRoot = path.join(root, 'assets', 'animations');
        const outfitOutRoot = path.join(root, 'assets', 'generated', 'outfit');
        const heightmapOutRoot = path.join(root, 'assets', 'generated', 'heightmap');
        const code2worldsOutRoot = path.join(root, 'assets', 'generated', 'code2worlds');
        const code2worldsWorkRoot = path.join(root, 'tools', 'out', 'code2worlds');
        const assettoCorsaOutRoot = path.join(root, 'assets', 'generated', 'assetto_corsa');
        const datasetsGenRoot = path.join(root, 'assets', 'datasets', 'generated');
        const humanDatasetRiggedRoot = path.join(root, 'repos', 'TRELLIS.2', 'datasets', 'humandataset', 'rigged');
        const omniversePacksRoot = path.join(root, 'assets', 'external', 'omniverse', 'packs');

        /** @type {Map<string, any>} */
        const trellisJobs = new Map(); // id -> { id, status, createdAt, startedAt, endedAt, cmd, cwd, stdout, stderr, outGlbRel, outRigRel, exitCode }
        /** @type {Map<string, any>} */
        const trellisRetextureJobs = new Map(); // id -> { ... stdout/stderr, outGlbRel, exitCode }
        /** @type {Map<string, any>} */
        const trellisTurntableJobs = new Map(); // id -> { ... stdout/stderr, outMp4Rel, exitCode }
        /** @type {Map<string, any>} */
        const trellisDatasetJobs = new Map(); // id -> { ... stdout/stderr, cmd, exitCode }
        /** @type {Map<string, any>} */
        const ovoxelLabJobs = new Map(); // id -> { ... stdout/stderr, cmd, outputs, exitCode }
        /** @type {Map<string, any>} */
        const zimageJobs = new Map(); // legacy: id -> { ... stdout/stderr, outGlbRel, outImageRel, outRigRel, exitCode }
        /** @type {Map<string, any>} */
        const zimageT2IJobs = new Map(); // id -> { outImageRel, ... }
        /** @type {Map<string, any>} */
        const zimageImg2ImgJobs = new Map(); // id -> { outImageRel, ... }
        /** @type {Map<string, any>} */
        const zimageRembgJobs = new Map(); // id -> { outImageRel, ... }
        /** @type {Map<string, any>} */
        const zimageMeshJobs = new Map(); // id -> { outGlbRel, outRigRel, ... }
        /** @type {Map<string, any>} */
        const convertJobs = new Map(); // id -> { outGlbRel, ... }
        /** @type {Map<string, any>} */
        const rigJobs = new Map(); // id -> { outRigRel, ... }
        /** @type {Map<string, any>} */
        const animJobs = new Map(); // id -> { outGlbRel, ... }
        /** @type {Map<string, any>} */
        const outfitJobs = new Map(); // id -> { outGlbRel, ... }
        /** @type {Map<string, any>} */
        const heightmapJobs = new Map(); // id -> { outMetaRel, ... }
        /** @type {Map<string, any>} */
        const citygenJobs = new Map(); // id -> { outDirRel, datasetId, ... }
        /** @type {Map<string, any>} */
        const code2worldsJobs = new Map(); // id -> { outPathRel, stdout/stderr, cmd, exitCode, ... }
        /** @type {Map<string, any>} */
        const assettoCorsaJobs = new Map(); // id -> { outPathRel, stdout/stderr, cmd, exitCode, ... }
        /** @type {Map<string, any>} */
        const assettoCorsaTrackJobs = new Map(); // id -> { outPathRel, stdout/stderr, cmd, exitCode, ... }
        /** @type {Map<string, any>} */
        const omniverseImportJobs = new Map(); // id -> { status, stdout, stderr, ... }
        /** @type {Map<string, any>} */
        const mesh2motionTestJobs = new Map(); // id -> standalone mesh2motion pipeline test jobs

        const ensureOut = () => {
          try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* ignore */ }
        };
        const ensureTrellisDirs = () => {
          try { fs.mkdirSync(trellisOutRoot, { recursive: true }); } catch { /* ignore */ }
          try { fs.mkdirSync(trellisWorkRoot, { recursive: true }); } catch { /* ignore */ }
          try { fs.mkdirSync(path.join(trellisWorkRoot, 'inputs'), { recursive: true }); } catch { /* ignore */ }
        };
        const ensureTrellisRetextureDirs = () => {
          try { fs.mkdirSync(trellisRetextureOutRoot, { recursive: true }); } catch { /* ignore */ }
          try { fs.mkdirSync(trellisRetextureWorkRoot, { recursive: true }); } catch { /* ignore */ }
          try { fs.mkdirSync(path.join(trellisRetextureWorkRoot, 'inputs'), { recursive: true }); } catch { /* ignore */ }
        };
        const ensureTrellisRenderDirs = () => {
          try { fs.mkdirSync(trellisRenderOutRoot, { recursive: true }); } catch { /* ignore */ }
        };
        const ensureTrellisDatasetDirs = () => {
          try { fs.mkdirSync(trellisDatasetWorkRoot, { recursive: true }); } catch { /* ignore */ }
        };
        const ensureOVoxelDirs = () => {
          try { fs.mkdirSync(ovoxelOutRoot, { recursive: true }); } catch { /* ignore */ }
          try { fs.mkdirSync(ovoxelWorkRoot, { recursive: true }); } catch { /* ignore */ }
        };
        const ensureZImageDirs = () => {
          try { fs.mkdirSync(zimageOutRoot, { recursive: true }); } catch { /* ignore */ }
        };
        const ensureConvertDirs = () => {
          try { fs.mkdirSync(convertOutRoot, { recursive: true }); } catch { /* ignore */ }
        };
        const ensureRigDirs = () => {
          try { fs.mkdirSync(rigOutRoot, { recursive: true }); } catch { /* ignore */ }
        };
        const ensureAnimDirs = () => {
          try { fs.mkdirSync(animOutRoot, { recursive: true }); } catch { /* ignore */ }
        };
        const ensureOutfitDirs = () => {
          try { fs.mkdirSync(outfitOutRoot, { recursive: true }); } catch { /* ignore */ }
        };
        const ensureHeightmapDirs = () => {
          try { fs.mkdirSync(heightmapOutRoot, { recursive: true }); } catch { /* ignore */ }
        };
        const ensureCode2WorldsDirs = () => {
          try { fs.mkdirSync(code2worldsOutRoot, { recursive: true }); } catch { /* ignore */ }
          try { fs.mkdirSync(code2worldsWorkRoot, { recursive: true }); } catch { /* ignore */ }
        };
        const ensureAssettoCorsaDirs = () => {
          try { fs.mkdirSync(assettoCorsaOutRoot, { recursive: true }); } catch { /* ignore */ }
        };
        const ensureGeneratedDatasetsDir = () => {
          try { fs.mkdirSync(datasetsGenRoot, { recursive: true }); } catch { /* ignore */ }
        };
        const safeStamp = () => new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');

        // GET /__editor_assets_index?query=foo&ext=.obj,.bin
        server.middlewares.use('/__editor_assets_index', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const query = String(url.searchParams.get('query') || '').toLowerCase();
            const extsRaw = String(url.searchParams.get('ext') || '');
            const exts = extsRaw
              ? extsRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
              : [];

            // When the query targets a specific root (like "webautos/"), scan only that root.
            // This avoids truncation for large trees like webautos/ when maxFiles is hit.
            const roots = (() => {
              const q = String(query || '');
              if (q.startsWith('webautos/')) return [{ abs: webautosRoot, allowPrefix: 'webautos/', maxFiles: 250000 }];
              if (q.startsWith('assets/')) return [{ abs: assetsRoot, allowPrefix: 'assets/', maxFiles: 250000 }];
              if (q.startsWith('outputs/')) return [{ abs: outputsRoot, allowPrefix: 'outputs/', maxFiles: 250000 }];
              if (q.startsWith('tools/rigging/mappings/')) return [{ abs: riggingMapsRoot, allowPrefix: 'tools/rigging/mappings/', maxFiles: 250000 }];
              return [
                { abs: assetsRoot, allowPrefix: 'assets/', maxFiles: 20000 },
                { abs: outputsRoot, allowPrefix: 'outputs/', maxFiles: 8000 },
                { abs: riggingMapsRoot, allowPrefix: 'tools/rigging/mappings/', maxFiles: 2000 },
                // Converted vehicle assets (e.g. GTA/FiveM -> GLB).
                { abs: webautosRoot, allowPrefix: 'webautos/', maxFiles: 5000 },
              ];
            })();
            const all = [];
            for (const r of roots) {
              try {
                for (const p of listFilesRecursive(r.abs, { maxFiles: r.maxFiles })) all.push(p);
              } catch { /* ignore */ }
            }
            const items = [];
            for (const abs of all) {
              const rel = toPosix(path.relative(root, abs));
              if (!(rel.startsWith('assets/') || rel.startsWith('outputs/') || rel.startsWith('tools/rigging/mappings/') || rel.startsWith('webautos/'))) continue;
              const low = rel.toLowerCase();
              if (query && !low.includes(query)) continue;
              if (exts.length) {
                const ext = String(path.extname(rel)).toLowerCase();
                if (!exts.includes(ext)) continue;
              }
              let st = null;
              try { st = fs.statSync(abs); } catch { st = null; }
              items.push({
                path: rel,
                bytes: st ? st.size : 0,
                mtimeMs: st ? Number(st.mtimeMs || 0) : 0,
              });
              if (items.length >= 5000) break;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, root: 'project', count: items.length, items }));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_character_manifests
        // Robust character manifest listing that scans only assets/characters
        // to avoid truncation from generic asset index caps.
        server.middlewares.use('/__devtools_character_manifests', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const charsRoot = path.join(assetsRoot, 'characters');
            const items = [];
            if (fs.existsSync(charsRoot)) {
              const all = listFilesRecursive(charsRoot, { maxFiles: 20000 });
              for (const abs of all) {
                const rel = toPosix(path.relative(root, abs));
                if (!rel.startsWith('assets/characters/')) continue;
                if (!rel.endsWith('/character_manifest.json')) continue;
                let st = null;
                try { st = fs.statSync(abs); } catch { st = null; }
                items.push({
                  path: rel,
                  bytes: st ? Number(st.size || 0) : 0,
                  mtimeMs: st ? Number(st.mtimeMs || 0) : 0,
                });
              }
            }
            items.sort((a, b) => String(a.path || '').localeCompare(String(b.path || '')));
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, count: items.length, items }));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_humandataset_index?rootPath=<projectRelativeOrAbsolute>&query=<substring>&limit=<n>
        // Index local HumanDataset Rigged models (FBX/GLB/OBJ) under repos/TRELLIS.2 by default.
        server.middlewares.use('/__devtools_humandataset_index', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const q = String(url.searchParams.get('query') || '').trim().toLowerCase();
            const limitRaw = Number(url.searchParams.get('limit') || 2000);
            const limit = Math.max(1, Math.min(10000, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 2000));
            const rootPathRaw = String(url.searchParams.get('rootPath') || 'repos/TRELLIS.2/datasets/humandataset/rigged').trim();

            const requestedAbs = resolveProjectFileWithPrefixes(rootPathRaw, { prefixes: ['repos/'] });
            const scanRoot = (requestedAbs && fs.existsSync(requestedAbs)) ? requestedAbs : humanDatasetRiggedRoot;
            if (!scanRoot || !fs.existsSync(scanRoot)) throw new Error('Rigged dataset root not found');

            const allowedExts = new Set(['.fbx', '.glb', '.gltf', '.obj']);
            const all = listFilesRecursive(scanRoot, { maxFiles: Math.max(5000, limit * 8) });
            const items = [];
            for (const abs of all) {
              const rel = toPosix(path.relative(root, abs));
              const low = rel.toLowerCase();
              const ext = String(path.extname(low || '')).toLowerCase();
              if (!allowedExts.has(ext)) continue;
              if (q && !low.includes(q)) continue;
              const base = String(path.basename(rel, ext) || '').trim();
              const modelId = base.replace(/_(u3d|ue4|yup_a|zup_a)$/i, '');
              let st = null;
              try { st = fs.statSync(abs); } catch { st = null; }
              items.push({
                path: rel,
                ext,
                modelId,
                bytes: st ? Number(st.size || 0) : 0,
                mtimeMs: st ? Number(st.mtimeMs || 0) : 0,
              });
            }

            items.sort((a, b) => {
              const aId = String(a.modelId || '').toLowerCase();
              const bId = String(b.modelId || '').toLowerCase();
              if (aId !== bId) return aId.localeCompare(bId);
              const aPath = String(a.path || '').toLowerCase();
              const bPath = String(b.path || '').toLowerCase();
              return aPath.localeCompare(bPath);
            });

            const clipped = items.slice(0, limit);
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({
              ok: true,
              rootPath: toPosix(path.relative(root, scanRoot)),
              count: clipped.length,
              totalMatched: items.length,
              items: clipped,
            }));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_omniverse_packs
        // Returns the list of extracted Omniverse packs under assets/external/omniverse/packs/
        server.middlewares.use('/__devtools_omniverse_packs', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const items = [];
            try {
              if (fs.existsSync(omniversePacksRoot)) {
                const ents = fs.readdirSync(omniversePacksRoot, { withFileTypes: true });
                for (const e of ents) {
                  if (!e || !e.isDirectory()) continue;
                  const name = String(e.name || '').trim();
                  if (!name || name.startsWith('.')) continue;
                  const rel = toPosix(path.relative(root, path.join(omniversePacksRoot, name)));
                  items.push({ name, path: rel });
                }
              }
            } catch { /* ignore */ }

            items.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, packs: items }));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_omniverse_ls?pack=<packName>&path=<subdir>
        // Lists *directories* directly under a pack subdirectory.
        // - pack: one of the extracted pack folder names under assets/external/omniverse/packs/
        // - path: optional relative folder path *within the pack* (e.g. "Assets/Characters/")
        // Returns: { ok: true, pack, path, absExists, dirs: [{name, path}], files: [{name, path}] }
        server.middlewares.use('/__devtools_omniverse_ls', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const pack = String(url.searchParams.get('pack') || '').trim();
            const subRaw = String(url.searchParams.get('path') || '').trim();
            if (!pack || pack.includes('..') || pack.includes('/') || pack.includes('\\')) throw new Error('Invalid pack');

            const packAbs = path.join(omniversePacksRoot, pack);
            const packAbsNorm = path.resolve(packAbs) + path.sep;
            if (!fs.existsSync(packAbs) || !fs.statSync(packAbs).isDirectory()) throw new Error('Pack not found');

            const sub = subRaw.replace(/^\/+/, '').replace(/\\/g, '/');
            if (sub.includes('..')) throw new Error('Invalid path');
            const dirAbs = path.join(packAbs, sub);
            const dirAbsNorm = path.resolve(dirAbs);
            if (!dirAbsNorm.startsWith(packAbsNorm)) throw new Error('Invalid path');

            const dirs = [];
            const files = [];
            let absExists = false;
            try {
              absExists = fs.existsSync(dirAbsNorm) && fs.statSync(dirAbsNorm).isDirectory();
              if (absExists) {
                const ents = fs.readdirSync(dirAbsNorm, { withFileTypes: true });
                for (const ent of ents) {
                  if (!ent || String(ent.name || '').startsWith('.')) continue;
                  const name = String(ent.name || '');
                  const rel = toPosix(path.relative(root, path.join(dirAbsNorm, name)));
                  if (ent.isDirectory()) dirs.push({ name, path: rel });
                  else if (ent.isFile()) files.push({ name, path: rel });
                }
              }
            } catch { /* ignore */ }

            dirs.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
            files.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, pack, path: sub, absExists, dirs, files }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_omniverse_models?pack=<packName>
        // Returns curated list of "model entry point" USD/FBX files from Omniverse packs.
        // Uses heuristics to filter sub-components (meshes, bones, materials, textures, etc.)
        // and return only top-level scene/model files a user would want to open.
        //
        // Heuristics:
        //  1. USD/FBX files whose stem matches their parent folder name (e.g. Debra/Debra.usd)
        //  2. USD files directly in category folders (not inside Materials/, Textures/, Meshes/, Bones/, etc.)
        //  3. Exclude _base, _inst, _inst_base variants (SimReady sub-layers)
        //
        // Response: { ok, pack, models: [{ name, path, category, pack }] }
        const _omniModelsCache = new Map();
        server.middlewares.use('/__devtools_omniverse_models', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const packFilter = String(url.searchParams.get('pack') || '').trim();
            const queryFilter = String(url.searchParams.get('query') || '').trim().toLowerCase();

            // Determine which packs to scan.
            let packDirs = [];
            if (packFilter && packFilter !== '(all)') {
              if (packFilter.includes('..') || packFilter.includes('/') || packFilter.includes('\\')) throw new Error('Invalid pack');
              const abs = path.join(omniversePacksRoot, packFilter);
              if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
                packDirs.push({ name: packFilter, abs });
              }
            } else {
              try {
                if (fs.existsSync(omniversePacksRoot)) {
                  for (const ent of fs.readdirSync(omniversePacksRoot, { withFileTypes: true })) {
                    if (!ent || !ent.isDirectory() || String(ent.name).startsWith('.')) continue;
                    packDirs.push({ name: ent.name, abs: path.join(omniversePacksRoot, ent.name) });
                  }
                }
              } catch { /* ignore */ }
            }

            const MODEL_EXTS = new Set(['.usd', '.usda', '.usdc', '.usdz', '.fbx', '.glb', '.gltf']);
            // Folders that contain sub-components, not entry-point models.
            const SKIP_DIRS = new Set([
              'materials', 'textures', 'texture', 'meshes', 'mesh', 'bones', 'stage',
              'motion', 'motions', 'animations', 'animation', 'anim', '.thumbs',
              'package-licenses', 'mdl', 'shaders', 'geometry',
            ]);
            // SimReady sub-layer suffixes to exclude.
            const SKIP_SUFFIXES = ['_base', '_inst', '_inst_base'];

            const allModels = [];

            for (const pack of packDirs) {
              // Check cache (keyed by pack name; invalidated by pack mtime).
              let packMtime = 0;
              try { packMtime = fs.statSync(pack.abs).mtimeMs; } catch { /* ignore */ }
              const cacheKey = pack.name;
              const cached = _omniModelsCache.get(cacheKey);
              if (cached && cached.mtime === packMtime) {
                for (const m of cached.models) {
                  if (!queryFilter || m.name.toLowerCase().includes(queryFilter) || m.path.toLowerCase().includes(queryFilter)) {
                    allModels.push(m);
                  }
                }
                continue;
              }

              const packModels = [];

              // Recursive scan with heuristic filtering.
              const scanDir = (dir, depth) => {
                let entries;
                try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

                const dirName = path.basename(dir).toLowerCase();
                // Skip known sub-component directories.
                if (depth > 0 && SKIP_DIRS.has(dirName)) return;

                const subDirs = [];
                const usdFiles = [];

                for (const ent of entries) {
                  const name = String(ent.name || '');
                  if (name.startsWith('.')) continue;
                  if (ent.isDirectory()) {
                    subDirs.push({ name, abs: path.join(dir, name) });
                  } else if (ent.isFile()) {
                    const ext = path.extname(name).toLowerCase();
                    if (MODEL_EXTS.has(ext)) {
                      usdFiles.push({ name, abs: path.join(dir, name), ext });
                    }
                  }
                }

                // Heuristic 1: file whose stem matches parent folder name → entry point.
                // e.g. Debra/Debra.usd, antiquelvase/antiquelvase.usd
                const parentName = path.basename(dir).toLowerCase();
                for (const f of usdFiles) {
                  const stem = path.basename(f.name, f.ext).toLowerCase();

                  // Skip sub-layer variants (_base, _inst, _inst_base).
                  if (SKIP_SUFFIXES.some((s) => stem.endsWith(s))) continue;

                  const isNameMatch = stem === parentName;

                  // Heuristic 2: if in a "category" folder (Conference/, Seating/, etc.)
                  // and the file is a plain USD at reasonable depth, treat as entry.
                  // We consider files at depth >= 2 in non-skip dirs that don't have
                  // dots in stem (Debra.Heroine_Arrogant.usd → animated variant, skip).
                  const hasDotInStem = path.basename(f.name, f.ext).includes('.');
                  const isCategoryFile = depth >= 2 && !hasDotInStem;

                  if (isNameMatch || isCategoryFile) {
                    const rel = toPosix(path.relative(root, f.abs));
                    const relInPack = toPosix(path.relative(pack.abs, f.abs));

                    // Derive a human-friendly category from path.
                    const parts = relInPack.split('/');
                    const category = parts.length >= 3 ? parts.slice(0, -1).join('/') : parts[0] || '';

                    let bytes = 0;
                    try { bytes = fs.statSync(f.abs).size; } catch { /* ignore */ }

                    packModels.push({
                      name: path.basename(f.name, f.ext),
                      path: rel,
                      pack: pack.name,
                      category,
                      bytes,
                    });
                  }
                }

                // Recurse into subdirectories (limit depth to avoid runaway).
                if (depth < 8) {
                  for (const sd of subDirs) {
                    scanDir(sd.abs, depth + 1);
                  }
                }
              };

              scanDir(pack.abs, 0);
              _omniModelsCache.set(cacheKey, { mtime: packMtime, models: packModels });

              for (const m of packModels) {
                if (!queryFilter || m.name.toLowerCase().includes(queryFilter) || m.path.toLowerCase().includes(queryFilter)) {
                  allModels.push(m);
                }
              }
            }

            // Sort by pack then path.
            allModels.sort((a, b) => {
              const pc = String(a.pack).localeCompare(String(b.pack));
              if (pc !== 0) return pc;
              return String(a.path).localeCompare(String(b.path));
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({
              ok: true,
              pack: packFilter || '(all)',
              count: allModels.length,
              models: allModels.slice(0, 2000),
            }));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_omniverse_characters?pack=<packName>&query=<substring>
        // Returns a structured "character" view of Omniverse packs:
        // - entry-point model file whose stem matches its folder name (e.g. Debra/Debra.usd)
        // - related motions/materials/textures under that character folder
        //
        // Intended for packs like Characters_NVD_10012:
        //   <pack>/Assets/Characters/Reallusion/ActorCore/<Character>/<Character>.usd
        const _omniCharactersCache = new Map();
        server.middlewares.use('/__devtools_omniverse_characters', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const packFilter = String(url.searchParams.get('pack') || '').trim();
            const queryFilter = String(url.searchParams.get('query') || '').trim().toLowerCase();

            // Determine which packs to scan.
            let packDirs = [];
            if (packFilter && packFilter !== '(all)') {
              if (packFilter.includes('..') || packFilter.includes('/') || packFilter.includes('\\')) throw new Error('Invalid pack');
              const abs = path.join(omniversePacksRoot, packFilter);
              if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
                packDirs.push({ name: packFilter, abs });
              }
            } else {
              try {
                if (fs.existsSync(omniversePacksRoot)) {
                  for (const ent of fs.readdirSync(omniversePacksRoot, { withFileTypes: true })) {
                    if (!ent || !ent.isDirectory() || String(ent.name).startsWith('.')) continue;
                    packDirs.push({ name: ent.name, abs: path.join(omniversePacksRoot, ent.name) });
                  }
                }
              } catch { /* ignore */ }
            }

            const MODEL_EXTS = new Set(['.usd', '.usda', '.usdc', '.usdz', '.fbx', '.glb', '.gltf']);
            const TEXTURE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.tga', '.exr', '.hdr', '.dds', '.ktx2', '.tif', '.tiff', '.bmp', '.webp', '.gif']);
            const MATERIAL_EXTS = new Set(['.mdl']);
            const SKIP_DIRS = new Set([
              'materials', 'textures', 'texture', 'meshes', 'mesh', 'bones', 'stage',
              'motion', 'motions', 'animations', 'animation', 'anim', '.thumbs',
              'package-licenses', 'mdl', 'shaders', 'geometry',
            ]);
            const SKIP_SUFFIXES = ['_base', '_inst', '_inst_base'];
            const MOTION_DIRS = new Set(['motion', 'motions', 'animation', 'animations', 'anim']);

            const toRelPosix = (absPath) => toPosix(path.relative(root, absPath));
            const relInPackPosix = (packAbs, absPath) => toPosix(path.relative(packAbs, absPath));

            const looksLikeCharacterPath = (relPosix) => {
              const low = String(relPosix || '').toLowerCase();
              return low.includes('/assets/characters/')
                || low.includes('/reallusion/actorcore/')
                || low.includes('/actorcore/');
            };

            const allCharacters = [];

            for (const pack of packDirs) {
              // Cache by pack dir mtime.
              let packMtime = 0;
              try { packMtime = fs.statSync(pack.abs).mtimeMs; } catch { /* ignore */ }
              const cacheKey = pack.name;
              const cached = _omniCharactersCache.get(cacheKey);
              if (cached && cached.mtime === packMtime) {
                for (const c of cached.characters) {
                  if (!queryFilter || c.name.toLowerCase().includes(queryFilter) || c.entry.path.toLowerCase().includes(queryFilter)) {
                    allCharacters.push(c);
                  }
                }
                continue;
              }

              /** @type {Map<string, any>} */
              const byCharDir = new Map(); // relDir -> character object

              const scanForEntries = (dir, depth) => {
                let entries;
                try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

                const dirName = path.basename(dir).toLowerCase();
                if (depth > 0 && SKIP_DIRS.has(dirName)) return;

                const subDirs = [];
                const modelFiles = [];

                for (const ent of entries) {
                  const name = String(ent.name || '');
                  if (name.startsWith('.')) continue;
                  if (ent.isDirectory()) subDirs.push({ name, abs: path.join(dir, name) });
                  else if (ent.isFile()) {
                    const ext = path.extname(name).toLowerCase();
                    if (MODEL_EXTS.has(ext)) modelFiles.push({ name, abs: path.join(dir, name), ext });
                  }
                }

                const parentName = path.basename(dir).toLowerCase();
                for (const f of modelFiles) {
                  const stemRaw = path.basename(f.name, f.ext);
                  const stem = stemRaw.toLowerCase();
                  if (SKIP_SUFFIXES.some((s) => stem.endsWith(s))) continue;
                  if (stem !== parentName) continue;

                  const relEntry = toRelPosix(f.abs);
                  if (!looksLikeCharacterPath(relEntry)) continue;

                  const relDir = toRelPosix(dir);
                  let bytes = 0;
                  try { bytes = fs.statSync(f.abs).size; } catch { /* ignore */ }

                  const relInPack = relInPackPosix(pack.abs, f.abs);
                  const category = (relInPack.split('/').slice(0, -2).join('/')) || '';
                  const isActorCore = /\/reallusion\/actorcore\//i.test('/' + relInPack + '/');

                  // Prefer the first discovered entry per dir (some packs may have duplicates).
                  if (!byCharDir.has(relDir)) {
                    byCharDir.set(relDir, {
                      id: `${pack.name}:${relDir}`,
                      pack: pack.name,
                      name: path.basename(dir),
                      dir: relDir,
                      category,
                      tags: {
                        isActorCore,
                        vendor: isActorCore ? 'reallusion' : '',
                      },
                      entry: { path: relEntry, ext: f.ext, bytes },
                      motions: [],
                      materials: [],
                      textures: [],
                      counts: { motions: 0, materials: 0, textures: 0 },
                    });
                  }
                }

                if (depth < 10) {
                  for (const sd of subDirs) scanForEntries(sd.abs, depth + 1);
                }
              };

              scanForEntries(pack.abs, 0);

              const collectRelated = (charAbs, charObj) => {
                const maxPerBucket = 800; // safety cap for giant folders
                const walk = (dir, depth) => {
                  let entries;
                  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

                  for (const ent of entries) {
                    const name = String(ent.name || '');
                    if (name.startsWith('.')) continue;
                    const abs = path.join(dir, name);
                    if (ent.isDirectory()) {
                      if (depth < 8) walk(abs, depth + 1);
                      continue;
                    }
                    if (!ent.isFile()) continue;

                    const ext = path.extname(name).toLowerCase();
                    const rel = toRelPosix(abs);
                    const low = rel.toLowerCase();

                    // Motions: USD/FBX/BVH under known motion-ish folders.
                    const dirParts = low.split('/');
                    const hasMotionDir = dirParts.some((p) => MOTION_DIRS.has(p));
                    const isMotionFile = hasMotionDir && (ext === '.bvh' || ext === '.fbx' || ext === '.usd' || ext === '.usda' || ext === '.usdc' || ext === '.usdz');
                    if (isMotionFile && charObj.motions.length < maxPerBucket) {
                      charObj.motions.push({ path: rel, ext });
                      continue;
                    }

                    // Materials
                    const isMaterial = MATERIAL_EXTS.has(ext) || low.includes('/materials/') || low.includes('/material/') || low.includes('/mdl/');
                    if (isMaterial && charObj.materials.length < maxPerBucket) {
                      charObj.materials.push({ path: rel, ext });
                      continue;
                    }

                    // Textures/images
                    const isTexture = TEXTURE_EXTS.has(ext) || low.includes('/textures/') || low.includes('/texture/');
                    if (isTexture && charObj.textures.length < maxPerBucket) {
                      charObj.textures.push({ path: rel, ext });
                      continue;
                    }
                  }
                };
                walk(charAbs, 0);
                charObj.counts.motions = charObj.motions.length;
                charObj.counts.materials = charObj.materials.length;
                charObj.counts.textures = charObj.textures.length;
              };

              for (const c of byCharDir.values()) {
                try {
                  // c.dir is repo-relative posix; translate to abs by joining root.
                  const absDir = path.join(root, c.dir.replace(/^\/+/, ''));
                  collectRelated(absDir, c);
                } catch { /* ignore */ }
              }

              const packCharacters = Array.from(byCharDir.values());
              packCharacters.sort((a, b) => String(a.name).localeCompare(String(b.name)));
              _omniCharactersCache.set(cacheKey, { mtime: packMtime, characters: packCharacters });

              for (const c of packCharacters) {
                if (!queryFilter || c.name.toLowerCase().includes(queryFilter) || c.entry.path.toLowerCase().includes(queryFilter)) {
                  allCharacters.push(c);
                }
              }
            }

            allCharacters.sort((a, b) => {
              const pc = String(a.pack).localeCompare(String(b.pack));
              if (pc !== 0) return pc;
              return String(a.name).localeCompare(String(b.name));
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({
              ok: true,
              pack: packFilter || '(all)',
              count: allCharacters.length,
              characters: allCharacters.slice(0, 4000),
            }));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_omniverse_catalog?pack=<packName>&kind=model|motion|any&type=character|animation|city|building|prop|vehicle|environment|other|any&q=<substring>&limit=500
        //
        // Returns a lightweight "asset catalog" for Omniverse packs with best-effort tagging.
        // This is used by devtools to quickly switch between characters, animations/motions,
        // city/environment scenes, buildings, props, etc. without folder spelunking.
        //
        // Response: { ok, pack, count, items: [{ kind, assetType, name, path, pack, category, bytes, tags }] }
        const _omniCatalogCache = new Map(); // packName -> { mtime, items }
        server.middlewares.use('/__devtools_omniverse_catalog', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const packFilter = String(url.searchParams.get('pack') || '').trim();
            const qRaw = String(url.searchParams.get('q') || '').trim().toLowerCase();
            const kindFilter = String(url.searchParams.get('kind') || 'any').trim().toLowerCase(); // model | motion | any
            const typeFilter = String(url.searchParams.get('type') || 'any').trim().toLowerCase(); // character | animation | ...
            const limit = Math.max(50, Math.min(5000, Number(url.searchParams.get('limit') || 800) || 800));

            // Determine which packs to scan.
            let packDirs = [];
            if (packFilter && packFilter !== '(all)') {
              if (packFilter.includes('..') || packFilter.includes('/') || packFilter.includes('\\')) throw new Error('Invalid pack');
              const abs = path.join(omniversePacksRoot, packFilter);
              if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
                packDirs.push({ name: packFilter, abs });
              }
            } else {
              try {
                if (fs.existsSync(omniversePacksRoot)) {
                  for (const ent of fs.readdirSync(omniversePacksRoot, { withFileTypes: true })) {
                    if (!ent || !ent.isDirectory() || String(ent.name).startsWith('.')) continue;
                    packDirs.push({ name: ent.name, abs: path.join(omniversePacksRoot, ent.name) });
                  }
                }
              } catch { /* ignore */ }
            }

            const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.hdr', '.exr']);
            const MODEL_EXTS = new Set(['.usd', '.usda', '.usdc', '.usdz', '.fbx', '.glb', '.gltf']);
            const MOTION_EXTS = new Set(['.bvh']); // other formats gated by folder/name heuristics

            const SKIP_TRAVERSAL_DIRS = new Set([
              '.thumbs', '__pycache__', 'package-licenses', 'licenses', 'license',
            ]);
            // Folders that contain sub-components, not entry-point models.
            const SKIP_MODEL_DIRS = new Set([
              'materials', 'textures', 'texture', 'meshes', 'mesh', 'bones', 'stage',
              'motion', 'motions', 'animations', 'animation', 'anim', 'anims',
              'mdl', 'shaders', 'shader', 'geometry',
            ]);
            const MOTION_DIR_HINTS = new Set(['motion', 'motions', 'animation', 'animations', 'anim', 'anims', 'bvh']);
            const SKIP_SUFFIXES = ['_base', '_inst', '_inst_base'];

            const tokenize = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean);
            const hasAny = (tokens, arr) => arr.some((t) => tokens.includes(t));
            const inferAssetType = (relInPack, kind) => {
              const tokens = tokenize(relInPack);
              if (kind === 'motion') return 'animation';
              if (hasAny(tokens, ['character', 'characters', 'people', 'person', 'human', 'humans', 'avatar'])) return 'character';
              if (hasAny(tokens, ['anim', 'anims', 'animation', 'animations', 'motion', 'motions', 'walk', 'run', 'idle'])) return 'animation';
              if (hasAny(tokens, ['city', 'cities', 'town', 'street', 'streets', 'urban', 'block', 'road', 'roads'])) return 'city';
              if (hasAny(tokens, ['building', 'buildings', 'house', 'apartment', 'tower', 'skyscraper', 'office', 'warehouse', 'datacenter', 'restaurant', 'residential', 'commercial'])) return 'building';
              if (hasAny(tokens, ['vehicle', 'vehicles', 'car', 'truck', 'bus', 'van', 'bike', 'bicycle'])) return 'vehicle';
              if (hasAny(tokens, ['prop', 'props', 'furniture', 'chair', 'table', 'sofa', 'lamp', 'shelf', 'cabinet', 'misc'])) return 'prop';
              if (hasAny(tokens, ['environment', 'env', 'terrain', 'landscape', 'park', 'nature', 'outdoor'])) return 'environment';
              return 'other';
            };

            const all = [];

            for (const pack of packDirs) {
              let packMtime = 0;
              try { packMtime = fs.statSync(pack.abs).mtimeMs; } catch { /* ignore */ }
              const cached = _omniCatalogCache.get(pack.name);

              const appendFiltered = (items) => {
                for (const it of items) {
                  if (kindFilter !== 'any' && String(it.kind || '') !== kindFilter) continue;
                  if (typeFilter !== 'any' && String(it.assetType || '') !== typeFilter) continue;
                  if (qRaw) {
                    const hay = `${it.name || ''} ${it.path || ''} ${it.category || ''} ${it.pack || ''}`.toLowerCase();
                    if (!hay.includes(qRaw)) continue;
                  }
                  all.push(it);
                  if (all.length >= 20000) return; // safety cap
                }
              };

              if (cached && cached.mtime === packMtime) {
                appendFiltered(cached.items || []);
                continue;
              }

              const packItems = [];

              const scanDir = (dirAbs, depth, motionCtx) => {
                let entries;
                try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
                const dirName = path.basename(dirAbs).toLowerCase();
                if (depth > 0 && SKIP_TRAVERSAL_DIRS.has(dirName)) return;

                const isMotionCtx = !!motionCtx || (depth > 0 && MOTION_DIR_HINTS.has(dirName));

                const subDirs = [];
                const files = [];
                for (const ent of entries) {
                  const name = String(ent?.name || '');
                  if (!name || name.startsWith('.')) continue;
                  const abs = path.join(dirAbs, name);
                  if (ent.isDirectory()) subDirs.push({ name, abs });
                  else if (ent.isFile()) files.push({ name, abs });
                }

                // Files pass
                const parentName = path.basename(dirAbs).toLowerCase();
                for (const f of files) {
                  const ext = path.extname(f.name).toLowerCase();
                  const stemRaw = path.basename(f.name, ext);
                  const stem = stemRaw.toLowerCase();

                  // --- Motions ---
                  if (MOTION_EXTS.has(ext)) {
                    const rel = toPosix(path.relative(root, f.abs));
                    const relInPack = toPosix(path.relative(pack.abs, f.abs));
                    const category = relInPack.split('/').slice(0, -1).join('/');
                    let bytes = 0;
                    try { bytes = fs.statSync(f.abs).size; } catch { /* ignore */ }
                    const assetType = inferAssetType(relInPack, 'motion');
                    packItems.push({
                      kind: 'motion',
                      assetType,
                      name: stemRaw,
                      path: rel,
                      pack: pack.name,
                      category,
                      bytes,
                      tags: [assetType, 'motion'],
                    });
                    continue;
                  }

                  // Some packs store motion as FBX/USD inside Animations/ or Motion/ directories.
                  const looksLikeMotionByName = /(^|[^a-z0-9])(anim|animation|motion|walk|run|idle)([^a-z0-9]|$)/i.test(stemRaw);
                  if (MODEL_EXTS.has(ext) && (isMotionCtx || looksLikeMotionByName) && (ext === '.fbx' || ext.startsWith('.usd'))) {
                    // Skip obvious model entry points in this motion channel: "Character/Character.usd"
                    const relInPack = toPosix(path.relative(pack.abs, f.abs));
                    const rel = toPosix(path.relative(root, f.abs));
                    const category = relInPack.split('/').slice(0, -1).join('/');
                    let bytes = 0;
                    try { bytes = fs.statSync(f.abs).size; } catch { /* ignore */ }
                    const assetType = inferAssetType(relInPack, 'motion');
                    packItems.push({
                      kind: 'motion',
                      assetType,
                      name: stemRaw,
                      path: rel,
                      pack: pack.name,
                      category,
                      bytes,
                      tags: [assetType, 'motion'],
                    });
                    continue;
                  }

                  // --- Models (entry points only) ---
                  if (!MODEL_EXTS.has(ext)) continue;

                  // Skip sub-layer variants.
                  if (SKIP_SUFFIXES.some((s) => stem.endsWith(s))) continue;

                  // Skip known sub-component directories for model entry points.
                  if (depth > 0 && SKIP_MODEL_DIRS.has(dirName)) continue;
                  if (isMotionCtx) continue; // motion folders are not model entry points

                  const hasDotInStem = stemRaw.includes('.');
                  const isNameMatch = stem === parentName;
                  const isCategoryFile = depth >= 2 && !hasDotInStem;
                  if (!(isNameMatch || isCategoryFile)) continue;

                  const rel = toPosix(path.relative(root, f.abs));
                  const relInPack = toPosix(path.relative(pack.abs, f.abs));
                  const parts = relInPack.split('/');
                  const category = parts.length >= 3 ? parts.slice(0, -1).join('/') : parts[0] || '';
                  let bytes = 0;
                  try { bytes = fs.statSync(f.abs).size; } catch { /* ignore */ }

                  const assetType = inferAssetType(relInPack, 'model');
                  packItems.push({
                    kind: 'model',
                    assetType,
                    name: stemRaw,
                    path: rel,
                    pack: pack.name,
                    category,
                    bytes,
                    tags: [assetType, 'model'],
                  });
                }

                // Recurse
                if (depth < 9) {
                  for (const sd of subDirs) scanDir(sd.abs, depth + 1, isMotionCtx);
                }
              };

              scanDir(pack.abs, 0, false);

              // Normalize + de-dupe by path.
              const uniq = new Map();
              for (const it of packItems) {
                const p = String(it?.path || '');
                if (!p) continue;
                if (!uniq.has(p)) uniq.set(p, it);
              }
              const normalized = Array.from(uniq.values());

              _omniCatalogCache.set(pack.name, { mtime: packMtime, items: normalized });
              appendFiltered(normalized);
            }

            // Sort: group by assetType then name, stable-ish.
            all.sort((a, b) => {
              const kc = String(a.kind || '').localeCompare(String(b.kind || ''));
              if (kc !== 0) return kc;
              const tc = String(a.assetType || '').localeCompare(String(b.assetType || ''));
              if (tc !== 0) return tc;
              const pc = String(a.pack || '').localeCompare(String(b.pack || ''));
              if (pc !== 0) return pc;
              return String(a.path || '').localeCompare(String(b.path || ''));
            });

            const out = all.slice(0, limit);
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({
              ok: true,
              pack: packFilter || '(all)',
              count: out.length,
              items: out,
            }));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_omniverse_pack_tags?pack=<packName>
        //
        // Loads a previously generated tags report:
        //   outputs/omniverse/<pack>_tags.json
        // and returns a flattened byPath index so devtools can show mesh/rig/anim
        // badges instantly without running usd_inspect on every click.
        const _omniPackTagsCache = new Map(); // packName -> { mtimeMs, resp }
        server.middlewares.use('/__devtools_omniverse_pack_tags', async (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const pack = String(url.searchParams.get('pack') || '').trim();
            if (!pack || pack === '(all)') throw new Error('Missing pack');
            if (pack.includes('..') || pack.includes('/') || pack.includes('\\')) throw new Error('Invalid pack');

            const tagsAbs = path.join(root, 'outputs', 'omniverse', `${pack}_tags.json`);

            // If the tags report file is missing, attempt to discover tags on-demand by scanning the pack
            // and running USD inspection (same underlying pipeline as /__devtools_usd_inspect).
            // This keeps the Omniverse tool usable without requiring a precomputed *_tags.json.
            const packAbs = path.join(omniversePacksRoot, pack);
            let packMtimeMs = 0;
            try { packMtimeMs = Number(fs.statSync(packAbs).mtimeMs || 0) || 0; } catch { packMtimeMs = 0; }

            const writeOut = String(url.searchParams.get('write') || '').trim() === '1';
            const maxUsdRaw = Number(url.searchParams.get('maxUsd'));
            const maxUsd = Number.isFinite(maxUsdRaw) ? Math.max(0, Math.min(5000, Math.floor(maxUsdRaw))) : 250; // 0 = no cap
            const concurrencyRaw = Number(url.searchParams.get('concurrency'));
            const concurrency = Number.isFinite(concurrencyRaw) ? Math.max(1, Math.min(4, Math.floor(concurrencyRaw))) : 2;

            const hasFile = fs.existsSync(tagsAbs);
            let mtimeMs = 0;
            if (hasFile) {
              try { mtimeMs = Number(fs.statSync(tagsAbs).mtimeMs || 0) || 0; } catch { mtimeMs = 0; }
            } else {
              // Use a negative mtime marker for generated reports, so caches don't collide with file-based reports.
              mtimeMs = 0 - (Number(packMtimeMs || 0) || 0);
            }
            const cached = _omniPackTagsCache.get(pack);
            if (cached && Number(cached.mtimeMs || 0) === mtimeMs && cached.resp) {
              res.statusCode = 200;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ...cached.resp, cached: true }));
              return;
            }

            let report = {};
            let generated = false;
            let partial = false;
            let discoveredCount = 0;
            let discoveredErrors = 0;

            if (hasFile) {
              const raw = fs.readFileSync(tagsAbs, 'utf-8');
              report = raw ? JSON.parse(raw) : {};
            } else {
              // Discover on-demand.
              if (!fs.existsSync(packAbs)) {
                res.statusCode = 404;
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ ok: false, error: `Missing pack folder: assets/external/omniverse/packs/${pack}` }));
                return;
              }

              const USD_EXTS = new Set(['.usd', '.usda', '.usdc', '.usdz']);
              const MODEL_EXTS = new Set(['.usd', '.usda', '.usdc', '.usdz', '.fbx', '.glb', '.gltf']);
              const MOTION_EXTS = new Set(['.bvh']);

              const SKIP_TRAVERSAL_DIRS = new Set([
                '.thumbs', '__pycache__', 'package-licenses', 'licenses', 'license',
              ]);
              const SKIP_MODEL_DIRS = new Set([
                'materials', 'textures', 'texture', 'meshes', 'mesh', 'bones', 'stage',
                'motion', 'motions', 'animations', 'animation', 'anim', 'anims',
                'mdl', 'shaders', 'shader', 'geometry',
              ]);
              const MOTION_DIR_HINTS = new Set(['motion', 'motions', 'animation', 'animations', 'anim', 'anims', 'bvh']);
              const SKIP_SUFFIXES = ['_base', '_inst', '_inst_base'];

              const tokenize = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean);
              const hasAny = (tokens, arr) => arr.some((t) => tokens.includes(t));
              const inferAssetType = (relInPack, kind) => {
                const tokens = tokenize(relInPack);
                if (kind === 'motion') return 'animation';
                if (hasAny(tokens, ['character', 'characters', 'people', 'person', 'human', 'humans', 'avatar'])) return 'character';
                if (hasAny(tokens, ['anim', 'anims', 'animation', 'animations', 'motion', 'motions', 'walk', 'run', 'idle'])) return 'animation';
                if (hasAny(tokens, ['city', 'cities', 'town', 'street', 'streets', 'urban', 'block', 'road', 'roads'])) return 'city';
                if (hasAny(tokens, ['building', 'buildings', 'house', 'apartment', 'tower', 'skyscraper', 'office', 'warehouse', 'datacenter', 'restaurant', 'residential', 'commercial'])) return 'building';
                if (hasAny(tokens, ['vehicle', 'vehicles', 'car', 'truck', 'bus', 'van', 'bike', 'bicycle'])) return 'vehicle';
                if (hasAny(tokens, ['prop', 'props', 'furniture', 'chair', 'table', 'sofa', 'lamp', 'shelf', 'cabinet', 'misc'])) return 'prop';
                if (hasAny(tokens, ['environment', 'env', 'terrain', 'landscape', 'park', 'nature', 'outdoor'])) return 'environment';
                return 'other';
              };

              /** @type {{ abs: string, rel: string, relInPack: string, bytes: number, kind: 'model' | 'motion', assetType: string }[]} */
              const usdCandidates = [];
              const seen = new Set();

              const scanDir = (dirAbs, depth, motionCtx) => {
                let entries;
                try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
                const dirName = path.basename(dirAbs).toLowerCase();
                if (depth > 0 && SKIP_TRAVERSAL_DIRS.has(dirName)) return;

                const isMotionCtx = !!motionCtx || (depth > 0 && MOTION_DIR_HINTS.has(dirName));

                const subDirs = [];
                const files = [];
                for (const ent of entries) {
                  const name = String(ent?.name || '');
                  if (!name || name.startsWith('.')) continue;
                  const abs = path.join(dirAbs, name);
                  if (ent.isDirectory()) subDirs.push({ name, abs });
                  else if (ent.isFile()) files.push({ name, abs });
                }

                const parentName = path.basename(dirAbs).toLowerCase();
                for (const f of files) {
                  const ext = path.extname(f.name).toLowerCase();
                  const stemRaw = path.basename(f.name, ext);
                  const stem = stemRaw.toLowerCase();

                  // Ignore non-model-ish files early.
                  if (!MODEL_EXTS.has(ext) && !MOTION_EXTS.has(ext)) continue;
                  if (!USD_EXTS.has(ext)) continue; // tags report is used for USD stats only

                  const rel = toPosix(path.relative(root, f.abs));
                  if (seen.has(rel)) continue;

                  const relInPack = toPosix(path.relative(packAbs, f.abs));
                  const looksLikeMotionByName = /(^|[^a-z0-9])(anim|animation|motion|walk|run|idle)([^a-z0-9]|$)/i.test(stemRaw);

                  // Motion USDs: allow broadly inside motion-ish folders or with motion-ish names.
                  if (isMotionCtx || looksLikeMotionByName) {
                    let bytes = 0;
                    try { bytes = fs.statSync(f.abs).size; } catch { /* ignore */ }
                    const assetType = inferAssetType(relInPack, 'motion');
                    usdCandidates.push({ abs: f.abs, rel, relInPack, bytes, kind: 'motion', assetType });
                    seen.add(rel);
                    continue;
                  }

                  // Model USDs: entry points only.
                  if (SKIP_SUFFIXES.some((s) => stem.endsWith(s))) continue;
                  if (depth > 0 && SKIP_MODEL_DIRS.has(dirName)) continue;

                  const hasDotInStem = stemRaw.includes('.');
                  const isNameMatch = stem === parentName;
                  const isCategoryFile = depth >= 2 && !hasDotInStem;
                  if (!(isNameMatch || isCategoryFile)) continue;

                  let bytes = 0;
                  try { bytes = fs.statSync(f.abs).size; } catch { /* ignore */ }
                  const assetType = inferAssetType(relInPack, 'model');
                  usdCandidates.push({ abs: f.abs, rel, relInPack, bytes, kind: 'model', assetType });
                  seen.add(rel);
                }

                if (depth < 9) {
                  for (const sd of subDirs) scanDir(sd.abs, depth + 1, isMotionCtx);
                }
              };

              scanDir(packAbs, 0, false);

              // Prefer inspecting "bigger" stages first (more likely to be important entrypoints).
              usdCandidates.sort((a, b) => Number(b.bytes || 0) - Number(a.bytes || 0));

              const capped = maxUsd > 0 ? usdCandidates.slice(0, maxUsd) : usdCandidates;
              partial = maxUsd > 0 && capped.length < usdCandidates.length;

              // Inspect helper using the same Blender USD inspector (with caching).
              const BLENDER5_PORTABLE = path.join(root, 'tools', 'third_party', 'blender-5.0', 'blender-5.0.0-linux-x64', 'blender');
              const pickBlender5 = () => {
                try { if (fs.existsSync(BLENDER5_PORTABLE)) return BLENDER5_PORTABLE; } catch { /* ignore */ }
                return 'blender';
              };
              const blenderCmd = pickBlender5();
              const blenderScriptAbs = path.join(root, 'tools', 'rigging', 'blender_usd_inspect.py');

              const inspectUsdAbs = async (inputAbs) => {
                // Reuse /__devtools_usd_inspect cache shape where possible.
                let inMtimeMs = 0;
                try { inMtimeMs = Number(fs.statSync(inputAbs).mtimeMs || 0) || 0; } catch { inMtimeMs = 0; }
                const cacheKey = `blender_5::${String(blenderCmd || '')}::${inputAbs}`;
                const cachedInspect = _usdInspectCache?.get?.(cacheKey);
                if (cachedInspect && Number(cachedInspect.mtimeMs || 0) === inMtimeMs && cachedInspect.resp?.json) {
                  return cachedInspect.resp.json;
                }

                const args = [
                  '--background',
                  '--factory-startup',
                  '--python',
                  blenderScriptAbs,
                  '--',
                  '--in',
                  inputAbs,
                ];

                const out = await new Promise((resolve) => {
                  const proc = child_process.spawn(blenderCmd, args, { cwd: root, env: process.env });
                  let stdout = '';
                  let stderr = '';
                  let done = false;
                  const finish = (exitCode, timedOut) => {
                    if (done) return;
                    done = true;
                    resolve({ stdout, stderr, exitCode, timedOut });
                  };
                  const t = setTimeout(() => {
                    try { proc.kill('SIGTERM'); } catch { /* ignore */ }
                    finish(-3, true);
                  }, 60_000);
                  proc.stdout.on('data', (d) => {
                    stdout += String(d);
                    if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000);
                  });
                  proc.stderr.on('data', (d) => {
                    stderr += String(d);
                    if (stderr.length > 2_000_000) stderr = stderr.slice(-2_000_000);
                  });
                  proc.on('close', (code) => {
                    try { clearTimeout(t); } catch { /* ignore */ }
                    finish((code == null) ? null : Number(code), false);
                  });
                  proc.on('error', (e) => {
                    try { clearTimeout(t); } catch { /* ignore */ }
                    stderr += `\n(proc error) ${String(e?.message || e)}`;
                    finish(-1, false);
                  });
                });

                // Blender prints a banner like "Blender 5.0.0 ..." before our JSON.
                let parsed = null;
                try {
                  const rawOut = String(out.stdout || '');
                  if (!rawOut.trim()) {
                    parsed = null;
                  } else {
                    try {
                      parsed = JSON.parse(rawOut);
                    } catch {
                      const i0 = rawOut.indexOf('{');
                      const i1 = rawOut.lastIndexOf('}');
                      if (i0 >= 0 && i1 > i0) parsed = JSON.parse(rawOut.slice(i0, i1 + 1));
                      else parsed = null;
                    }
                  }
                } catch {
                  parsed = null;
                }

                try {
                  const respObj = {
                    ok: true,
                    cmd: [blenderCmd, ...args].join(' '),
                    stdout: out.stdout || '',
                    stderr: out.timedOut ? (`(timed out)\n` + (out.stderr || '')) : (out.stderr || ''),
                    exitCode: out.exitCode,
                    json: parsed,
                  };
                  _usdInspectCache?.set?.(cacheKey, { mtimeMs: inMtimeMs, resp: respObj });
                } catch { /* ignore */ }

                return parsed;
              };

              /** @type {Record<string, any>} */
              const genByPath = {};
              const addGen = (p, stats, extra) => {
                const s = (stats && typeof stats === 'object') ? stats : {};
                const sp = String(p || '').trim();
                if (!sp) return;
                genByPath[sp] = {
                  ok: true,
                  stats: {
                    meshCount: Number(s.meshCount) || 0,
                    materialCount: Number(s.materialCount) || 0,
                    shaderCount: Number(s.shaderCount) || 0,
                    skelRootCount: Number(s.skelRootCount) || 0,
                    skelAnimationCount: Number(s.skelAnimationCount) || 0,
                  },
                  ...(extra && typeof extra === 'object' ? extra : {}),
                };
              };

              // Concurrency-limited inspection.
              let idx = 0;
              const workers = Array.from({ length: Math.min(concurrency, capped.length) }, () => (async () => {
                while (idx < capped.length) {
                  const i = idx++;
                  const it = capped[i];
                  try {
                    const parsed = await inspectUsdAbs(String(it.abs || ''));
                    if (parsed?.ok) {
                      const stats = parsed?.stats || {};
                      const mesh = Number(stats?.meshCount) || 0;
                      const skelAnim = Number(stats?.skelAnimationCount) || 0;
                      const kindHint = (mesh <= 0 && skelAnim > 0) ? 'motion' : String(it.kind || 'model');
                      addGen(it.rel, stats, {
                        kindHint,
                        assetTypeHint: String(it.assetType || ''),
                        bytes: Number(it.bytes) || 0,
                      });
                      discoveredCount++;
                    } else {
                      discoveredErrors++;
                      partial = true;
                    }
                  } catch {
                    discoveredErrors++;
                    partial = true;
                  }
                }
              })());
              await Promise.all(workers);

              generated = true;
              report = {
                ok: true,
                pack,
                packsRoot: toPosix(path.relative(root, omniversePacksRoot)),
                byPath: genByPath,
                generatedAt: new Date().toISOString(),
                partial,
                discoveredCount,
                discoveredErrors,
                maxUsd,
                concurrency,
              };

              if (writeOut) {
                try {
                  const outDir = path.join(root, 'outputs', 'omniverse');
                  fs.mkdirSync(outDir, { recursive: true });
                  fs.writeFileSync(tagsAbs, JSON.stringify(report, null, 2) + '\n', 'utf8');
                } catch {
                  // Non-fatal: discovery still works without persisting.
                }
              }
            }

            /** @type {Record<string, any>} */
            const byPath = {};
            const add = (p, stats, extra) => {
              const s = (stats && typeof stats === 'object') ? stats : {};
              const sp = String(p || '').trim();
              if (!sp) return;
              byPath[sp] = {
                ok: true,
                stats: {
                  meshCount: Number(s.meshCount) || 0,
                  materialCount: Number(s.materialCount) || 0,
                  shaderCount: Number(s.shaderCount) || 0,
                  skelRootCount: Number(s.skelRootCount) || 0,
                  skelAnimationCount: Number(s.skelAnimationCount) || 0,
                },
                ...(extra && typeof extra === 'object' ? extra : {}),
              };
            };

            // If the report already contains a byPath map, trust it directly.
            // This supports both character-specific and generic pack audits.
            if (report?.byPath && typeof report.byPath === 'object') {
              for (const [p, v] of Object.entries(report.byPath)) {
                const sp = String(p || '').trim();
                if (!sp) continue;
                if (v && typeof v === 'object' && v.stats) add(sp, v.stats, { ...(v || {}) });
                else if (v && typeof v === 'object') add(sp, v, {});
              }
            } else {
              const chars = Array.isArray(report?.characters) ? report.characters : [];
              for (const c of chars) {
                const entry = c?.usd?.entry;
                const actor = c?.usd?.actor;
                if (entry?.path && entry?.stats) add(entry.path, entry.stats, { kindHint: 'model', char: String(c?.name || '') });
                if (actor?.path && actor?.stats) add(actor.path, actor.stats, { kindHint: 'model', char: String(c?.name || '') });

                const motions = Array.isArray(c?.usd?.motions) ? c.usd.motions : [];
                for (const m of motions) {
                  if (!m?.path || !m?.stats) continue;
                  const mesh = Number(m?.stats?.meshCount) || 0;
                  add(m.path, m.stats, { kindHint: mesh > 0 ? 'model' : 'motion', char: String(c?.name || '') });
                }

                const props = Array.isArray(c?.usd?.props) ? c.usd.props : [];
                for (const m of props) {
                  if (!m?.path || !m?.stats) continue;
                  const mesh = Number(m?.stats?.meshCount) || 0;
                  add(m.path, m.stats, { kindHint: mesh > 0 ? 'model' : 'motion', char: String(c?.name || '') });
                }
              }
            }

            const respObj = {
              ok: true,
              pack,
              reportPath: hasFile ? toPosix(path.relative(root, tagsAbs)) : '(generated)',
              characterCount: Number(report?.characterCount || 0) || 0,
              generated,
              partial: !!report?.partial || partial,
              discoveredCount: Number(report?.discoveredCount || discoveredCount || 0) || 0,
              discoveredErrors: Number(report?.discoveredErrors || discoveredErrors || 0) || 0,
              byPath,
            };
            try { _omniPackTagsCache.set(pack, { mtimeMs, resp: respObj }); } catch { /* ignore */ }

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(respObj));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // ---- Omniverse import: download & extract packs via omniverse_assets.py ----
        // Known Omniverse pack names (mirrors PACK_URLS_TEXT in omniverse_assets.py).
        const OMNIVERSE_KNOWN_PACKS = [
          { name: 'Extensions_Samples_NVD_10010', category: 'extensions' },
          { name: 'AEC_XR_NVD_100.1.2', category: 'aec' },
          { name: 'AECO_CityDemoPack_NVD_10011', category: 'city' },
          { name: 'AECO_CityMassingDemoPack_NVD_10011', category: 'city' },
          { name: 'Particles_NVD_10010', category: 'other' },
          { name: 'USD_Explorer_Sample_NVD_10011', category: 'other' },
          { name: 'Characters_NVD_10012', category: 'characters' },
          { name: 'AECDemo_NVD_10012', category: 'aec' },
          { name: 'AECO_RestaurantDemoPack_NVD_10012', category: 'aec' },
          { name: 'AECO_CityTowerDemoPack_NVD_10011', category: 'city' },
          { name: 'Industrial_NVD_10012', category: 'industrial' },
          { name: 'Commercial_NVD_10013', category: 'city' },
          { name: 'XR_Content_NVD_10010', category: 'other' },
          { name: 'Configurator_Content_NVD_10010', category: 'other' },
          { name: 'Showcases_Content_NVD_10011', category: 'other' },
          { name: 'AECO_TowerDemoPack_NVD_10012', category: 'city' },
          { name: 'SimReady_Furniture_Misc_01_NVD_10010', category: 'furniture' },
          { name: 'Core_Demos_NVD_10010', category: 'other' },
          { name: 'Warehouse_NVD_10013', category: 'industrial' },
          { name: 'SimReady_Warehouse_01_NVD_10010', category: 'industrial' },
          { name: 'Residential_NVD_10012', category: 'city' },
          { name: 'Datacenter_NVD_10012', category: 'industrial' },
        ];

        // GET /__devtools_omniverse_available
        // Returns the list of all known Omniverse packs with download/extract status.
        // Optional query param: category=city (filters to city packs only)
        server.middlewares.use('/__devtools_omniverse_available', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const categoryFilter = String(url.searchParams.get('category') || '').trim().toLowerCase();

            // Read download state file if it exists.
            const stateFile = path.join(root, 'assets', 'external', 'omniverse', 'download_state.json');
            let dlState = {};
            try {
              if (fs.existsSync(stateFile)) {
                dlState = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
              }
            } catch { /* ignore */ }
            const packStates = dlState?.packs || {};

            const packs = [];
            for (const known of OMNIVERSE_KNOWN_PACKS) {
              if (categoryFilter && known.category !== categoryFilter) continue;
              const ps = packStates[known.name] || {};
              const packDir = path.join(omniversePacksRoot, known.name);
              let extracted = false;
              try { extracted = fs.existsSync(packDir) && fs.readdirSync(packDir).length > 0; } catch { /* ignore */ }
              packs.push({
                name: known.name,
                category: known.category,
                status: extracted ? 'extracted' : (ps.status || 'not_downloaded'),
                zipSizeBytes: Number(ps.zip_size_bytes) || 0,
                estimatedUnpackedBytes: Number(ps.estimated_unpacked_bytes) || 0,
                extracted,
              });
            }

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, packs }));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_omniverse_import_start
        // Body:
        //  - packs: string[] (pack names to import; e.g. ['AECO_CityDemoPack_NVD_10011'])
        //  - maxGb: number (default 10)
        //  - downloadOnly: boolean (default false)
        //  - match: string (optional regex filter — alternative to packs list)
        // Spawns: python3 omniverse_assets.py --only <packs...> --max-gb <n>
        server.middlewares.use('/__devtools_omniverse_import_start', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req);
            const packs = Array.isArray(obj?.packs) ? obj.packs.map((s) => String(s || '').trim()).filter(Boolean) : [];
            const matchRegex = String(obj?.match || '').trim();
            const maxGb = Math.max(0.1, Number(obj?.maxGb) || 10);
            const downloadOnly = !!obj?.downloadOnly;

            if (!packs.length && !matchRegex) throw new Error('Must specify at least one pack name or a match regex');

            const scriptAbs = path.join(root, 'omniverse_assets.py');
            if (!fs.existsSync(scriptAbs)) throw new Error('omniverse_assets.py not found');

            const args = [
              scriptAbs,
              '--max-gb', String(maxGb),
              '--root', path.join(root, 'assets', 'external', 'omniverse'),
            ];
            for (const p of packs) {
              args.push('--only', p);
            }
            if (matchRegex) {
              args.push('--match', matchRegex);
            }
            if (downloadOnly) {
              args.push('--download-only');
            }

            const id = crypto.randomBytes(8).toString('hex');
            const job = {
              id,
              status: 'running',
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              endedAt: '',
              cwd: root,
              cmd: ['python3', ...args].join(' '),
              stdout: '',
              stderr: '',
              packs,
              matchRegex,
              maxGb,
              exitCode: null,
              error: '',
              _proc: null,
            };
            omniverseImportJobs.set(id, job);

            const proc = child_process.spawn('python3', args, { cwd: root, env: process.env });
            job._proc = proc;
            proc.stdout.on('data', (d) => {
              job.stdout += String(d);
              if (job.stdout.length > 2_000_000) job.stdout = job.stdout.slice(-2_000_000);
            });
            proc.stderr.on('data', (d) => {
              job.stderr += String(d);
              if (job.stderr.length > 2_000_000) job.stderr = job.stderr.slice(-2_000_000);
            });
            proc.on('close', (code) => {
              job.exitCode = (code == null) ? null : Number(code);
              job.endedAt = new Date().toISOString();
              job.status = (job.exitCode === 0) ? 'done' : 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });
            proc.on('error', (e) => {
              job.error = String(e?.message || e);
              job.exitCode = -1;
              job.endedAt = new Date().toISOString();
              job.status = 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, id, packs, maxGb }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_omniverse_import_job?id=...
        server.middlewares.use('/__devtools_omniverse_import_job', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const id = String(url.searchParams.get('id') || '');
            const job = omniverseImportJobs.get(id);
            if (!job) {
              res.statusCode = 404;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: 'job not found' }));
              return;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({
              ok: true,
              id: job.id,
              status: job.status,
              stdout: job.stdout,
              stderr: job.stderr,
              packs: job.packs,
              maxGb: job.maxGb,
              exitCode: job.exitCode,
              error: job.error,
            }));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_omniverse_import_kill { id }
        server.middlewares.use('/__devtools_omniverse_import_kill', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 100_000 });
            const id = String(obj?.id || '');
            const job = omniverseImportJobs.get(id);
            if (!job) throw new Error('job not found');
            const proc = job._proc;
            if (proc && typeof proc.kill === 'function') {
              try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              job.status = 'killed';
              job.endedAt = new Date().toISOString();
              job.exitCode = -2;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_usd_inspect
        // Body:
        //  - runner: 'python3' | 'conda_trellis' | 'blender_5' (optional; default blender_5)
        //  - blenderPath: optional Blender executable path (for blender_5 runner)
        //  - inputPath: assets/... | outputs/... | repos/... (or absolute within repo)
        // Runs:
        //  - tools/rigging/blender_usd_inspect.py inside Blender (portable Blender 5 ships pxr)
        //  - OR tools/usd_inspect.py in conda trellis (legacy / fallback)
        const _usdInspectCache = new Map(); // cacheKey -> { mtimeMs, resp }
        server.middlewares.use('/__devtools_usd_inspect', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req, { maxBytes: 200_000 });

            const BLENDER5_PORTABLE = path.join(root, 'tools', 'third_party', 'blender-5.0', 'blender-5.0.0-linux-x64', 'blender');
            const pickBlender5 = (blenderPathRaw) => {
              const explicit = String(blenderPathRaw || '').trim();
              if (explicit) return explicit;
              try { if (fs.existsSync(BLENDER5_PORTABLE)) return BLENDER5_PORTABLE; } catch { /* ignore */ }
              return 'blender';
            };

            const runner = String(obj?.runner || 'blender_5');
            const runnerMap = {
              python3: { kind: 'python', cmd: 'python3', baseArgs: [] },
              conda_trellis: { kind: 'python', cmd: 'conda', baseArgs: ['run', '-n', 'trellis', 'python3'] },
              blender_5: { kind: 'blender', cmd: pickBlender5(obj?.blenderPath), baseArgs: [] },
            };
            const r = runnerMap[runner] || runnerMap.blender_5;

            const inputAbs = resolveProjectFileWithPrefixes(obj?.inputPath, {
              prefixes: ['assets/external/', 'assets/', 'outputs/', 'repos/', 'tools/out/'],
            });
            if (!inputAbs || !fs.existsSync(inputAbs)) throw new Error('Missing or invalid inputPath');

            // Cache by input mtime (and runner) to make bulk inspection usable in devtools.
            let mtimeMs = 0;
            try { mtimeMs = Number(fs.statSync(inputAbs).mtimeMs || 0) || 0; } catch { mtimeMs = 0; }
            const cacheKey = `${runner}::${String(r?.cmd || '')}::${inputAbs}`;
            const cached = _usdInspectCache.get(cacheKey);
            if (cached && Number(cached.mtimeMs || 0) === mtimeMs && cached.resp) {
              res.statusCode = 200;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ...cached.resp, cached: true }));
              return;
            }

            let cmd = r.cmd;
            let args = [];
            if (r.kind === 'blender') {
              const blenderScriptAbs = path.join(root, 'tools', 'rigging', 'blender_usd_inspect.py');
              args = [
                '--background',
                '--factory-startup',
                '--python',
                blenderScriptAbs,
                '--',
                '--in',
                inputAbs,
              ];
              const top = Number(obj?.top);
              if (Number.isFinite(top) && top > 0) args.push('--top', String(Math.max(5, Math.min(200, Math.floor(top)))));
            } else {
              const scriptAbs = path.join(root, 'tools', 'usd_inspect.py');
              args = [
                ...r.baseArgs,
                scriptAbs,
                '--in',
                inputAbs,
              ];
              const top = Number(obj?.top);
              if (Number.isFinite(top) && top > 0) args.push('--top', String(Math.max(5, Math.min(200, Math.floor(top)))));
            }

            const out = await new Promise((resolve) => {
              const proc = child_process.spawn(cmd, args, { cwd: root, env: process.env });
              let stdout = '';
              let stderr = '';
              let done = false;
              const finish = (exitCode, timedOut) => {
                if (done) return;
                done = true;
                resolve({ stdout, stderr, exitCode, timedOut });
              };
              const t = setTimeout(() => {
                try { proc.kill('SIGTERM'); } catch { /* ignore */ }
                finish(-3, true);
              }, 60_000);
              proc.stdout.on('data', (d) => {
                stdout += String(d);
                if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000);
              });
              proc.stderr.on('data', (d) => {
                stderr += String(d);
                if (stderr.length > 2_000_000) stderr = stderr.slice(-2_000_000);
              });
              proc.on('close', (code) => {
                try { clearTimeout(t); } catch { /* ignore */ }
                finish((code == null) ? null : Number(code), false);
              });
              proc.on('error', (e) => {
                try { clearTimeout(t); } catch { /* ignore */ }
                stderr += `\n(proc error) ${String(e?.message || e)}`;
                finish(-1, false);
              });
            });

            // Blender prints a banner like "Blender 5.0.0 ..." before our JSON.
            // Parse robustly by extracting the first JSON object from stdout.
            let parsed = null;
            try {
              const rawOut = String(out.stdout || '');
              if (!rawOut.trim()) {
                parsed = null;
              } else {
                try {
                  parsed = JSON.parse(rawOut);
                } catch {
                  const i0 = rawOut.indexOf('{');
                  const i1 = rawOut.lastIndexOf('}');
                  if (i0 >= 0 && i1 > i0) {
                    parsed = JSON.parse(rawOut.slice(i0, i1 + 1));
                  } else {
                    parsed = null;
                  }
                }
              }
            } catch {
              parsed = null;
            }

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            const respObj = {
              ok: true,
              cmd: [cmd, ...args].join(' '),
              stdout: out.stdout || '',
              stderr: out.timedOut ? (`(timed out)\n` + (out.stderr || '')) : (out.stderr || ''),
              exitCode: out.exitCode,
              json: parsed,
            };
            try { _usdInspectCache.set(cacheKey, { mtimeMs, resp: respObj }); } catch { /* ignore */ }
            res.end(JSON.stringify(respObj));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__editor_request_asset  { kind, prompt, nameHint, format, tags, ... }
        server.middlewares.use('/__editor_request_asset', (req, res, next) => {
          if (req.method === 'OPTIONS') {
            res.statusCode = 204;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            res.end();
            return;
          }
          if (req.method !== 'POST') return next();
          let body = '';
          req.on('data', (c) => { body += c; if (body.length > 2_000_000) req.destroy(); });
          req.on('end', () => {
            try {
              const obj = body ? JSON.parse(body) : {};
              ensureOut();
              const kind = String(obj?.kind || 'asset').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64) || 'asset';
              const p = path.join(outDir, `request_${kind}_${safeStamp()}.json`);
              fs.writeFileSync(p, JSON.stringify({ ...obj, _serverTime: new Date().toISOString() }, null, 2), 'utf8');
              res.statusCode = 200;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: true, path: p }));
            } catch (e) {
              res.statusCode = 400;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
            }
          });
        });

        function readJsonBody(req, { maxBytes = 6_000_000 } = {}) {
          return new Promise((resolve, reject) => {
            let body = '';
            req.on('data', (c) => {
              body += c;
              if (body.length > maxBytes) {
                try { req.destroy(); } catch { /* ignore */ }
                reject(new Error('Body too large'));
              }
            });
            req.on('end', () => {
              try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
            });
          });
        }

        function safeRelAssetPath(p) {
          const s = String(p || '').replace(/^\/+/, '');
          if (!s.startsWith('assets/')) return null;
          if (s.includes('..')) return null;
          return s;
        }

        // POST /__devtools_write_json_asset
        //   {
        //     relPath?: 'assets/.../file.json',
        //     relDir?: 'assets/.../',           // optional output directory (must be within assets/)
        //     nameHint?: string,
        //     data: any
        //   }
        // Writes a JSON file into the project assets/ tree (dev server only).
        server.middlewares.use('/__devtools_write_json_asset', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req, { maxBytes: 4_000_000 });
            const rel0 = safeRelAssetPath(obj?.relPath);
            const nameHint = String(obj?.nameHint || 'building');

            const relDir0 = String(obj?.relDir || '').replace(/^\/+/, '').replace(/\\/g, '/');
            const relDir = (relDir0 && relDir0.startsWith('assets/') && !relDir0.includes('..'))
              ? (relDir0.endsWith('/') ? relDir0 : (relDir0 + '/'))
              : 'assets/buildings/';

            const rel = rel0 || (`${relDir}${safeName(nameHint)}.json`);
            const abs = path.join(root, rel);

            // Ensure destination is within assetsRoot.
            const absNorm = path.resolve(abs);
            const assetsNorm = path.resolve(assetsRoot);
            if (!absNorm.startsWith(assetsNorm + path.sep) && absNorm !== assetsNorm) throw new Error('Invalid output path');

            try { fs.mkdirSync(path.dirname(absNorm), { recursive: true }); } catch { /* ignore */ }
            const payload = {
              ...(obj?.data ?? {}),
              _serverTime: new Date().toISOString(),
            };
            fs.writeFileSync(absNorm, JSON.stringify(payload, null, 2) + '\n', 'utf8');

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, relPath: rel, absPath: absNorm }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        function safeName(s) {
          const base = String(s || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
          return (base || 'trellis') + '_' + safeStamp();
        }

        function decodeDataUrlToFile(dataUrl, outAbsPath) {
          const raw = String(dataUrl || '');
          const m = raw.match(/^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/);
          if (!m) throw new Error('Invalid data URL');
          const b64 = m[2];
          const buf = Buffer.from(b64, 'base64');
          fs.writeFileSync(outAbsPath, buf);
        }

        function jobToJson(j) {
          return {
            ok: true,
            id: j.id,
            status: j.status,
            createdAt: j.createdAt,
            startedAt: j.startedAt,
            endedAt: j.endedAt,
            cwd: j.cwd,
            cmd: j.cmd,
            stdout: j.stdout,
            stderr: j.stderr,
            outGlb: j.outGlbRel,
            outVxz: j.outVxzRel || '',
            outPath: j.outPathRel || '',
            outMeshesDir: j.outMeshesDirRel || '',
            outMeshes: Array.isArray(j.outMeshesRel) ? j.outMeshesRel : [],
            outImage: j.outImageRel || '',
            outMp4: j.outMp4Rel || '',
            outRig: j.outRigRel,
            exitCode: j.exitCode,
            error: j.error || '',
          };
        }

        function listEnvmaps() {
          /** @type {string[]} */
          const out = [];
          const roots = [
            path.join(root, 'assets', 'hdri'),
            path.join(root, 'repos', 'TRELLIS.2', 'assets', 'hdri'),
          ];
          for (const dirAbs of roots) {
            try {
              if (!fs.existsSync(dirAbs)) continue;
              const ents = fs.readdirSync(dirAbs, { withFileTypes: true });
              for (const ent of ents) {
                if (!ent.isFile()) continue;
                const low = String(ent.name || '').toLowerCase();
                if (!low.endsWith('.exr') && !low.endsWith('.hdr')) continue;
                const abs = path.join(dirAbs, ent.name);
                const rel = toPosix(path.relative(root, abs));
                out.push(rel);
              }
            } catch { /* ignore */ }
          }
          out.sort();
          return Array.from(new Set(out));
        }

        function resolveProjectFile(userPath) {
          const raw = String(userPath || '').trim();
          if (!raw) return null;
          if (raw.includes('..')) return null;

          // Absolute path? Only allow if inside this repo root.
          if (path.isAbsolute(raw)) {
            const abs = path.resolve(raw);
            const normRoot = path.resolve(root) + path.sep;
            const normAbs = path.resolve(abs);
            if (!normAbs.startsWith(normRoot)) return null;
            return abs;
          }

          // Relative paths: allow within assets/ or repos/ (devtools-only).
          const rel = raw.replace(/^\/+/, '');
          if (!rel.startsWith('assets/') && !rel.startsWith('repos/')) return null;
          return path.join(root, rel);
        }

        function resolveProjectFileWithPrefixes(userPath, { prefixes }) {
          const raw = String(userPath || '').trim();
          if (!raw) return null;
          if (raw.includes('..')) return null;

          // Absolute path? Only allow if inside this repo root.
          if (path.isAbsolute(raw)) {
            const abs = path.resolve(raw);
            const normRoot = path.resolve(root) + path.sep;
            const normAbs = path.resolve(abs);
            if (!normAbs.startsWith(normRoot)) return null;
            return abs;
          }

          const rel = raw.replace(/^\/+/, '');
          const ok = Array.isArray(prefixes) && prefixes.some((p) => rel.startsWith(String(p)));
          if (!ok) return null;
          return path.join(root, rel);
        }

        function resolveLocalOrProjectPath(userPath, { prefixes = [] } = {}) {
          const raw = String(userPath || '').trim();
          if (!raw) return null;
          if (raw.includes('..')) return null;
          if (path.isAbsolute(raw)) return path.resolve(raw);
          if (!Array.isArray(prefixes) || !prefixes.length) return null;
          const rel = raw.replace(/^\/+/, '');
          const ok = prefixes.some((p) => rel.startsWith(String(p)));
          if (!ok) return null;
          return path.join(root, rel);
        }

        function splitArgs(s) {
          const src = String(s || '');
          /** @type {string[]} */
          const out = [];
          let cur = '';
          let quote = ''; // '' | "'" | '"'
          let esc = false;
          for (let i = 0; i < src.length; i++) {
            const ch = src[i];
            if (esc) {
              cur += ch;
              esc = false;
              continue;
            }
            if (ch === '\\') {
              esc = true;
              continue;
            }
            if (quote) {
              if (ch === quote) quote = '';
              else cur += ch;
              continue;
            }
            if (ch === '"' || ch === "'") {
              quote = ch;
              continue;
            }
            if (/\s/.test(ch)) {
              if (cur) { out.push(cur); cur = ''; }
              continue;
            }
            cur += ch;
          }
          if (cur) out.push(cur);
          return out;
        }

        function trellisRunnerSpec(runnerRaw) {
          const runner = String(runnerRaw || 'conda_trellis');
          const runnerMap = {
            python3: { key: 'python3', cmd: 'python3', baseArgs: [] },
            conda_hunyuan3d: { key: 'conda_hunyuan3d', cmd: 'conda', baseArgs: ['run', '-n', 'hunyuan3d', 'python3'] },
            conda_trellis: { key: 'conda_trellis', cmd: 'conda', baseArgs: ['run', '-n', 'trellis', 'python3'] },
          };
          return runnerMap[runner] || runnerMap.conda_trellis;
        }

        function runTrellisEnvProbe({ runner }) {
          const spec = trellisRunnerSpec(runner);
          const probeScript = [
            'import json, os, importlib.util',
            "checks = {}",
            "mods = [",
            " ('torch','torch'),",
            " ('trellis2','trellis2'),",
            " ('o_voxel','o_voxel'),",
            " ('cumesh','cumesh'),",
            " ('flex_gemm','flex_gemm'),",
            " ('nvdiffrast','nvdiffrast.torch'),",
            " ('nvdiffrec','nvdiffrec_render.light'),",
            " ('flash_attn','flash_attn'),",
            " ('xformers','xformers.ops'),",
            " ('opencv','cv2'),",
            "]",
            "for key, mod in mods:",
            "  try:",
            "    checks[key] = bool(importlib.util.find_spec(mod))",
            "  except Exception:",
            "    checks[key] = False",
            "cuda = {'available': False, 'device_count': 0}",
            "torch_version = ''",
            "try:",
            "  import torch",
            "  torch_version = str(getattr(torch, '__version__', '') or '')",
            "  cuda['available'] = bool(torch.cuda.is_available())",
            "  cuda['device_count'] = int(torch.cuda.device_count() if torch.cuda.is_available() else 0)",
            "except Exception:",
            "  pass",
            "attn_backend = str(os.environ.get('ATTN_BACKEND', '') or os.environ.get('SPARSE_ATTN_BACKEND', '') or '')",
            "payload = {'checks': checks, 'cuda': cuda, 'torch_version': torch_version, 'attn_backend': attn_backend}",
            "print(json.dumps(payload))",
          ].join('\n');

          const args = [...spec.baseArgs, '-c', probeScript];
          const p = child_process.spawnSync(spec.cmd, args, {
            cwd: root,
            env: process.env,
            encoding: 'utf8',
            timeout: 120000,
          });
          const stdout = String(p?.stdout || '');
          const stderr = String(p?.stderr || '');
          const exitCode = Number(p?.status == null ? -1 : p.status);
          let payload = null;
          try {
            const lines = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
            for (let i = lines.length - 1; i >= 0; i--) {
              try {
                payload = JSON.parse(lines[i]);
                if (payload && typeof payload === 'object') break;
              } catch { /* ignore */ }
            }
          } catch { /* ignore */ }
          return {
            runner: spec.key,
            cmd: [spec.cmd, ...args].join(' '),
            exitCode,
            stdout,
            stderr,
            payload,
          };
        }

        function buildTrellisSetupHints(payload) {
          const checks = payload?.checks || {};
          const missing = [];
          const hints = [];
          const pushMissing = (key, flag) => {
            if (!checks[key]) {
              missing.push(key);
              if (flag) hints.push(flag);
            }
          };
          pushMissing('flash_attn', '--flash-attn');
          pushMissing('cumesh', '--cumesh');
          pushMissing('o_voxel', '--o-voxel');
          pushMissing('flex_gemm', '--flexgemm');
          pushMissing('nvdiffrast', '--nvdiffrast');
          pushMissing('nvdiffrec', '--nvdiffrec');
          return {
            missing,
            setupFlags: Array.from(new Set(hints)),
          };
        }

        // GET /__devtools_envmaps
        server.middlewares.use('/__devtools_envmaps', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const items = listEnvmaps();
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, count: items.length, items }));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_trellis_env_check
        // Body:
        //  - runner: 'python3' | 'conda_trellis' (optional; default conda_trellis)
        server.middlewares.use('/__devtools_trellis_env_check', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 100_000 });
            const runner = String(obj?.runner || 'conda_trellis');
            const r = runTrellisEnvProbe({ runner });
            const hints = buildTrellisSetupHints(r.payload || {});
            const setupCmd = hints.setupFlags.length
              ? `. ./repos/TRELLIS.2/setup.sh --basic ${hints.setupFlags.join(' ')}`
              : '';
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({
              ok: true,
              runner: r.runner,
              cmd: r.cmd,
              exitCode: r.exitCode,
              probe: r.payload || {},
              missing: hints.missing,
              setupFlags: hints.setupFlags,
              setupCmd,
              stderr: r.stderr,
            }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // ---- Trellis Dataset Toolkit runner (repos/TRELLIS.2/data_toolkit) ----
        //
        // POST /__devtools_trellis_dataset_start
        // Body:
        //  - runner: 'python3' | 'conda_trellis'
        //  - step: build_metadata | download | dump_mesh | dump_pbr | asset_stats | dual_grid |
        //          voxelize_pbr | encode_shape_latent | encode_pbr_latent | encode_ss_latent | render_cond
        //  - subset, source, rootPath, resolution, numViews, shapeLatentName, rank, worldSize
        server.middlewares.use('/__devtools_trellis_dataset_start', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req);
            ensureTrellisDatasetDirs();

            const runnerSpec = trellisRunnerSpec(obj?.runner);
            const step = String(obj?.step || '').trim();
            const subset = String(obj?.subset || '').trim();
            const source = String(obj?.source || '').trim();
            const resolution = String(obj?.resolution || '').trim();
            const numViews = String(obj?.numViews || '').trim();
            const shapeLatentName = String(obj?.shapeLatentName || '').trim();
            const rank = String(obj?.rank || '').trim();
            const worldSize = String(obj?.worldSize || '').trim();

            const stepConfigs = {
              build_metadata: { scriptName: 'build_metadata.py', needsSubset: true, supportsSource: true, supportsResolution: false, supportsNumViews: false, supportsShapeLatent: false },
              download: { scriptName: 'download.py', needsSubset: true, supportsSource: false, supportsResolution: false, supportsNumViews: false, supportsShapeLatent: false },
              dump_mesh: { scriptName: 'dump_mesh.py', needsSubset: true, supportsSource: false, supportsResolution: false, supportsNumViews: false, supportsShapeLatent: false },
              dump_pbr: { scriptName: 'dump_pbr.py', needsSubset: true, supportsSource: false, supportsResolution: false, supportsNumViews: false, supportsShapeLatent: false },
              asset_stats: { scriptName: 'asset_stats.py', needsSubset: false, supportsSource: false, supportsResolution: false, supportsNumViews: false, supportsShapeLatent: false },
              dual_grid: { scriptName: 'dual_grid.py', needsSubset: true, supportsSource: false, supportsResolution: true, supportsNumViews: false, supportsShapeLatent: false },
              voxelize_pbr: { scriptName: 'voxelize_pbr.py', needsSubset: true, supportsSource: false, supportsResolution: true, supportsNumViews: false, supportsShapeLatent: false },
              encode_shape_latent: { scriptName: 'encode_shape_latent.py', needsSubset: false, supportsSource: false, supportsResolution: true, supportsNumViews: false, supportsShapeLatent: false },
              encode_pbr_latent: { scriptName: 'encode_pbr_latent.py', needsSubset: false, supportsSource: false, supportsResolution: true, supportsNumViews: false, supportsShapeLatent: false },
              encode_ss_latent: { scriptName: 'encode_ss_latent.py', needsSubset: false, supportsSource: false, supportsResolution: true, supportsNumViews: false, supportsShapeLatent: true },
              render_cond: { scriptName: 'render_cond.py', needsSubset: true, supportsSource: false, supportsResolution: false, supportsNumViews: true, supportsShapeLatent: false },
            };
            const cfg = stepConfigs[step];
            if (!cfg) throw new Error('Unsupported step');

            const rootAbs = resolveProjectFileWithPrefixes(obj?.rootPath, {
              prefixes: ['repos/', 'assets/', 'outputs/', 'tools/out/'],
            });
            if (!rootAbs) throw new Error('Missing or invalid rootPath');

            if (cfg.needsSubset && !subset) throw new Error(`Step "${step}" requires subset`);
            if (cfg.supportsShapeLatent && !shapeLatentName) throw new Error('encode_ss_latent requires shapeLatentName');

            const scriptAbs = path.join(root, 'repos', 'TRELLIS.2', 'data_toolkit', cfg.scriptName);
            if (!fs.existsSync(scriptAbs)) throw new Error(`Script not found: ${toPosix(path.relative(root, scriptAbs))}`);

            const args = [
              ...runnerSpec.baseArgs,
              scriptAbs,
            ];

            if (cfg.needsSubset) args.push(subset);
            args.push('--root', rootAbs);

            if (cfg.supportsSource && source) args.push('--source', source);
            if (cfg.supportsResolution && resolution) args.push('--resolution', resolution);
            if (cfg.supportsNumViews && numViews) args.push('--num_views', numViews);
            if (cfg.supportsShapeLatent && shapeLatentName) args.push('--shape_latent_name', shapeLatentName);
            if (rank) args.push('--rank', rank);
            if (worldSize) args.push('--world_size', worldSize);

            const id = crypto.randomBytes(8).toString('hex');
            const job = {
              id,
              step,
              status: 'running',
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              endedAt: '',
              cwd: root,
              cmd: [runnerSpec.cmd, ...args].join(' '),
              stdout: '',
              stderr: '',
              outGlbRel: '',
              outRigRel: '',
              outMp4Rel: '',
              outImageRel: '',
              exitCode: null,
              error: '',
              _proc: null,
            };
            trellisDatasetJobs.set(id, job);

            const proc = child_process.spawn(runnerSpec.cmd, args, { cwd: root, env: process.env });
            job._proc = proc;
            proc.stdout.on('data', (d) => {
              job.stdout += String(d);
              if (job.stdout.length > 2_000_000) job.stdout = job.stdout.slice(-2_000_000);
            });
            proc.stderr.on('data', (d) => {
              job.stderr += String(d);
              if (job.stderr.length > 2_000_000) job.stderr = job.stderr.slice(-2_000_000);
            });
            proc.on('close', (code) => {
              job.exitCode = (code == null) ? null : Number(code);
              job.endedAt = new Date().toISOString();
              job.status = (job.exitCode === 0) ? 'done' : 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });
            proc.on('error', (e) => {
              job.error = String(e?.message || e);
              job.exitCode = -1;
              job.endedAt = new Date().toISOString();
              job.status = 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, id, step, cmd: job.cmd }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_trellis_dataset_job?id=...
        server.middlewares.use('/__devtools_trellis_dataset_job', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const id = String(url.searchParams.get('id') || '');
            const job = trellisDatasetJobs.get(id);
            if (!job) {
              res.statusCode = 404;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: 'job not found' }));
              return;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(jobToJson(job)));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_trellis_dataset_kill { id }
        server.middlewares.use('/__devtools_trellis_dataset_kill', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 100_000 });
            const id = String(obj?.id || '');
            const job = trellisDatasetJobs.get(id);
            if (!job) throw new Error('job not found');
            const proc = job._proc;
            if (proc && typeof proc.kill === 'function') {
              try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              job.status = 'killed';
              job.endedAt = new Date().toISOString();
              job.exitCode = -2;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_trellis_start
        // Body:
        //  - runner: 'python3' | 'conda_trellis'
        //  - imageAssetPath: 'assets/..../img.png'  OR  imageDataUrl: 'data:image/png;base64,...'
        //  - outName: string (optional)
        //  - device, model
        //  - rigBackend, rigArgs
        server.middlewares.use('/__devtools_trellis_start', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req);
            ensureTrellisDirs();

            const runner = String(obj?.runner || 'conda_hunyuan3d');
            const runnerMap = {
              python3: { cmd: 'python3', baseArgs: [] },
              conda_hunyuan3d: { cmd: 'conda', baseArgs: ['run', '-n', 'hunyuan3d', 'python3'] },
              conda_trellis: { cmd: 'conda', baseArgs: ['run', '-n', 'trellis', 'python3'] },
            };
            const r = runnerMap[runner] || runnerMap.conda_trellis;

            // Resolve input image path.
            let imageAbs = '';
            const imageAssetPath = safeRelAssetPath(obj?.imageAssetPath);
            const imageDataUrl = String(obj?.imageDataUrl || '');
            if (imageAssetPath) {
              imageAbs = path.join(root, imageAssetPath);
              if (!fs.existsSync(imageAbs)) throw new Error(`Image not found: ${imageAssetPath}`);
            } else if (imageDataUrl) {
              const ext = String(obj?.imageExt || 'png').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'png';
              const inName = `${safeName(obj?.outName || 'trellis_input')}.${ext}`;
              imageAbs = path.join(trellisWorkRoot, 'inputs', inName);
              decodeDataUrlToFile(imageDataUrl, imageAbs);
            } else {
              throw new Error('Missing imageAssetPath or imageDataUrl');
            }

            const backend = String(obj?.meshBackend || 'hunyuan').trim().toLowerCase() === 'trellis' ? 'trellis' : 'hunyuan';
            const outBase = safeName(obj?.outName || (backend === 'trellis' ? 'trellis' : 'hunyuan'));
            const outGlbAbs = path.join(trellisOutRoot, `${outBase}.glb`);
            const outRigAbs = path.join(trellisOutRoot, `${outBase}_rig.glb`);
            const outMp4Abs = path.join(trellisOutRoot, `${outBase}.mp4`);
            const outGlbRel = toPosix(path.relative(root, outGlbAbs));
            const outRigRel = toPosix(path.relative(root, outRigAbs));
            const outMp4Rel = toPosix(path.relative(root, outMp4Abs));

            const scriptAbs = (backend === 'trellis')
              ? path.join(root, 'tools', 'trellis2_image_to_glb.py')
              : path.join(root, 'tools', 'hunyuan_mesh_texture_to_glb.py');
            const args = [
              ...r.baseArgs,
              scriptAbs,
              '--image', imageAbs,
              '--out-glb', outGlbAbs,
            ];

            const addArg = (k, v) => {
              const s = String(v ?? '').trim();
              if (!s) return;
              // Some values (notably AABB) may start with "-" and can confuse intermediate
              // argument parsing when executed via wrappers. Use the "--key=value" form in
              // that case so it's guaranteed to stay attached to its flag.
              if (s.startsWith('-')) args.push(`${k}=${s}`);
              else args.push(k, s);
            };

            if (backend === 'trellis') addArg('--model', obj?.model);
            else addArg('--shape-model', obj?.model);
            addArg('--device', obj?.device);
            if (backend === 'trellis') {
              addArg('--pipeline-type', obj?.pipelineType);
              if (obj?.seed != null) addArg('--seed', obj?.seed);
              if (obj?.preprocessImage != null) addArg('--preprocess-image', obj?.preprocessImage);
              if (obj?.steps != null) addArg('--steps', obj?.steps);
              if (obj?.guidanceStrength != null) addArg('--guidance-strength', obj?.guidanceStrength);
              if (obj?.ssSteps != null) addArg('--ss-steps', obj?.ssSteps);
              if (obj?.ssGuidanceStrength != null) addArg('--ss-guidance-strength', obj?.ssGuidanceStrength);
              if (obj?.ssGuidanceRescale != null) addArg('--ss-guidance-rescale', obj?.ssGuidanceRescale);
              if (obj?.ssRescaleT != null) addArg('--ss-rescale-t', obj?.ssRescaleT);
              if (obj?.shapeSteps != null) addArg('--shape-steps', obj?.shapeSteps);
              if (obj?.shapeGuidanceStrength != null) addArg('--shape-guidance-strength', obj?.shapeGuidanceStrength);
              if (obj?.shapeGuidanceRescale != null) addArg('--shape-guidance-rescale', obj?.shapeGuidanceRescale);
              if (obj?.shapeRescaleT != null) addArg('--shape-rescale-t', obj?.shapeRescaleT);
              if (obj?.texSteps != null) addArg('--tex-steps', obj?.texSteps);
              if (obj?.texGuidanceStrength != null) addArg('--tex-guidance-strength', obj?.texGuidanceStrength);
              if (obj?.texGuidanceRescale != null) addArg('--tex-guidance-rescale', obj?.texGuidanceRescale);
              if (obj?.texRescaleT != null) addArg('--tex-rescale-t', obj?.texRescaleT);
              if (obj?.simplify != null) addArg('--simplify', obj?.simplify);
              addArg('--aabb', obj?.aabb);
              if (obj?.decimationTarget != null) addArg('--decimation-target', obj?.decimationTarget);
              if (obj?.textureSize != null) addArg('--texture-size', obj?.textureSize);
              if (obj?.remesh != null) addArg('--remesh', obj?.remesh);
              if (obj?.remeshBand != null) addArg('--remesh-band', obj?.remeshBand);
              if (obj?.remeshProject != null) addArg('--remesh-project', obj?.remeshProject);
              if (obj?.extensionWebp != null) addArg('--extension-webp', obj?.extensionWebp);
            } else {
              if (obj?.shapeSteps != null) addArg('--shape-steps', obj?.shapeSteps);
              if (obj?.shapeOctree != null) addArg('--shape-octree', obj?.shapeOctree);
              if (obj?.shapeNumChunks != null) addArg('--shape-num-chunks', obj?.shapeNumChunks);
              if (obj?.seed != null) addArg('--shape-seed', obj?.seed);
              if (obj?.shapeSubfolder != null) addArg('--shape-subfolder', obj?.shapeSubfolder);
              if (obj?.shapeVariant != null) addArg('--shape-variant', obj?.shapeVariant);
              if (obj?.texModel != null) addArg('--tex-model', obj?.texModel);
              if (obj?.texSubfolder != null) addArg('--tex-subfolder', obj?.texSubfolder);
              if (obj?.enableFlashvdm != null) addArg('--enable-flashvdm', obj?.enableFlashvdm);
              if (obj?.rembg != null) addArg('--rembg', obj?.rembg);
            }

            const rigBackend = String(obj?.rigBackend || '').trim();
            const rigArgs = String(obj?.rigArgs || '').trim();
            if (backend === 'trellis' && rigBackend) {
              args.push('--rig-backend', rigBackend, '--rig-out', outRigAbs);
              if (rigArgs) args.push('--rig-args', rigArgs);
            }

            const renderMp4 = (backend === 'trellis' && Number(obj?.renderMp4 || 0)) ? 1 : 0;
            if (renderMp4) {
              args.push('--out-mp4', outMp4Abs);
              const envmapAbs = resolveProjectFile(obj?.envmap);
              if (envmapAbs && fs.existsSync(envmapAbs)) args.push('--envmap', envmapAbs);
              if (obj?.fps != null) args.push('--fps', String(obj.fps));
            }

            const id = crypto.randomBytes(8).toString('hex');
            const job = {
              id,
              status: 'running',
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              endedAt: '',
              cwd: root,
              cmd: [r.cmd, ...args].join(' '),
              stdout: '',
              stderr: '',
              outGlbRel,
              outMp4Rel: renderMp4 ? outMp4Rel : '',
              outRigRel: (backend === 'trellis' && rigBackend) ? outRigRel : '',
              exitCode: null,
              error: '',
              _proc: null,
            };
            trellisJobs.set(id, job);

            // Spawn the process.
            const proc = child_process.spawn(r.cmd, args, { cwd: root, env: process.env });
            job._proc = proc;
            proc.stdout.on('data', (d) => {
              job.stdout += String(d);
              if (job.stdout.length > 2_000_000) job.stdout = job.stdout.slice(-2_000_000);
            });
            proc.stderr.on('data', (d) => {
              job.stderr += String(d);
              if (job.stderr.length > 2_000_000) job.stderr = job.stderr.slice(-2_000_000);
            });
            proc.on('close', (code) => {
              job.exitCode = (code == null) ? null : Number(code);
              job.endedAt = new Date().toISOString();
              job.status = (job.exitCode === 0) ? 'done' : 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });
            proc.on('error', (e) => {
              job.error = String(e?.message || e);
              job.exitCode = -1;
              job.endedAt = new Date().toISOString();
              job.status = 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, id, outGlb: outGlbRel, outRig: job.outRigRel, outMp4: job.outMp4Rel || '' }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_trellis_job?id=...
        server.middlewares.use('/__devtools_trellis_job', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const id = String(url.searchParams.get('id') || '');
            const job = trellisJobs.get(id);
            if (!job) {
              res.statusCode = 404;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: 'job not found' }));
              return;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(jobToJson(job)));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_trellis_kill { id }
        server.middlewares.use('/__devtools_trellis_kill', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 100_000 });
            const id = String(obj?.id || '');
            const job = trellisJobs.get(id);
            if (!job) throw new Error('job not found');
            const proc = job._proc;
            if (proc && typeof proc.kill === 'function') {
              try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              job.status = 'killed';
              job.endedAt = new Date().toISOString();
              job.exitCode = -2;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // ---- Trellis mesh retexturing (mesh + image -> textured GLB) ----
        //
        // POST /__devtools_trellis_retexture_start
        // Body:
        //  - runner: 'python3' | 'conda_trellis'
        //  - meshAssetPath: 'assets/.../mesh.glb'
        //  - imageAssetPath: 'assets/.../ref.png' OR imageDataUrl: 'data:image/png;base64,...'
        //  - outName, device, model, configFile, seed, resolution, textureSize, preprocessImage
        server.middlewares.use('/__devtools_trellis_retexture_start', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req);
            ensureTrellisRetextureDirs();

            const runner = String(obj?.runner || 'conda_hunyuan3d');
            const runnerMap = {
              python3: { cmd: 'python3', baseArgs: [] },
              conda_hunyuan3d: { cmd: 'conda', baseArgs: ['run', '-n', 'hunyuan3d', 'python3'] },
              conda_trellis: { cmd: 'conda', baseArgs: ['run', '-n', 'trellis', 'python3'] },
            };
            const r = runnerMap[runner] || runnerMap.conda_trellis;

            const meshAssetPath = safeRelAssetPath(obj?.meshAssetPath);
            if (!meshAssetPath) throw new Error('Missing/invalid meshAssetPath (must be under assets/)');
            const meshAbs = path.join(root, meshAssetPath);
            if (!fs.existsSync(meshAbs)) throw new Error(`Mesh not found: ${meshAssetPath}`);

            // Resolve input image path.
            let imageAbs = '';
            const imageAssetPath = safeRelAssetPath(obj?.imageAssetPath);
            const imageDataUrl = String(obj?.imageDataUrl || '');
            if (imageAssetPath) {
              imageAbs = path.join(root, imageAssetPath);
              if (!fs.existsSync(imageAbs)) throw new Error(`Image not found: ${imageAssetPath}`);
            } else if (imageDataUrl) {
              const ext = String(obj?.imageExt || 'png').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'png';
              const inName = `${safeName(obj?.outName || 'trellis_retexture_input')}.${ext}`;
              imageAbs = path.join(trellisRetextureWorkRoot, 'inputs', inName);
              decodeDataUrlToFile(imageDataUrl, imageAbs);
            } else {
              throw new Error('Missing imageAssetPath or imageDataUrl');
            }

            const outBase = safeName(obj?.outName || 'trellis_retexture');
            const outGlbAbs = path.join(trellisRetextureOutRoot, `${outBase}.glb`);
            const outGlbRel = toPosix(path.relative(root, outGlbAbs));

            const scriptAbs = path.join(root, 'tools', 'trellis2_retexture_mesh_to_glb.py');
            const args = [
              ...r.baseArgs,
              scriptAbs,
              '--mesh', meshAbs,
              '--image', imageAbs,
              '--out-glb', outGlbAbs,
            ];

            const addArg = (k, v) => {
              const s = String(v ?? '').trim();
              if (!s) return;
              args.push(k, s);
            };

            addArg('--device', obj?.device);
            addArg('--model', obj?.model);
            addArg('--config-file', obj?.configFile);
            if (obj?.seed != null) addArg('--seed', obj?.seed);
            if (obj?.resolution != null) addArg('--resolution', obj?.resolution);
            if (obj?.textureSize != null) addArg('--texture-size', obj?.textureSize);
            if (obj?.preprocessImage != null) addArg('--preprocess-image', obj?.preprocessImage);
            if (obj?.texSteps != null) addArg('--tex-steps', obj?.texSteps);
            if (obj?.texGuidanceStrength != null) addArg('--tex-guidance-strength', obj?.texGuidanceStrength);
            if (obj?.texGuidanceRescale != null) addArg('--tex-guidance-rescale', obj?.texGuidanceRescale);
            if (obj?.texRescaleT != null) addArg('--tex-rescale-t', obj?.texRescaleT);
            if (obj?.preserveUv != null) addArg('--preserve-uv', obj?.preserveUv);
            if (obj?.extensionWebp != null) addArg('--extension-webp', obj?.extensionWebp);

            const id = crypto.randomBytes(8).toString('hex');
            const job = {
              id,
              status: 'running',
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              endedAt: '',
              cwd: root,
              cmd: [r.cmd, ...args].join(' '),
              stdout: '',
              stderr: '',
              outGlbRel,
              outRigRel: '',
              outMp4Rel: '',
              outImageRel: '',
              exitCode: null,
              error: '',
              _proc: null,
            };
            trellisRetextureJobs.set(id, job);

            const proc = child_process.spawn(r.cmd, args, { cwd: root, env: process.env });
            job._proc = proc;
            proc.stdout.on('data', (d) => {
              job.stdout += String(d);
              if (job.stdout.length > 2_000_000) job.stdout = job.stdout.slice(-2_000_000);
            });
            proc.stderr.on('data', (d) => {
              job.stderr += String(d);
              if (job.stderr.length > 2_000_000) job.stderr = job.stderr.slice(-2_000_000);
            });
            proc.on('close', (code) => {
              job.exitCode = (code == null) ? null : Number(code);
              job.endedAt = new Date().toISOString();
              job.status = (job.exitCode === 0) ? 'done' : 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });
            proc.on('error', (e) => {
              job.error = String(e?.message || e);
              job.exitCode = -1;
              job.endedAt = new Date().toISOString();
              job.status = 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, id, outGlb: outGlbRel }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_trellis_retexture_job?id=...
        server.middlewares.use('/__devtools_trellis_retexture_job', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const id = String(url.searchParams.get('id') || '');
            const job = trellisRetextureJobs.get(id);
            if (!job) {
              res.statusCode = 404;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: 'job not found' }));
              return;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(jobToJson(job)));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_trellis_retexture_kill { id }
        server.middlewares.use('/__devtools_trellis_retexture_kill', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 100_000 });
            const id = String(obj?.id || '');
            const job = trellisRetextureJobs.get(id);
            if (!job) throw new Error('job not found');
            const proc = job._proc;
            if (proc && typeof proc.kill === 'function') {
              try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              job.status = 'killed';
              job.endedAt = new Date().toISOString();
              job.exitCode = -2;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // ---- O-Voxel Lab (mesh<->voxel, preview, inspect, format convert) ----
        //
        // POST /__devtools_ovoxel_lab_start
        // Body:
        //  - runner: 'python3' | 'conda_trellis' (optional; default conda_trellis)
        //  - mode: 'convert' | 'reconstruct' | 'render' | 'inspect' | 'io_convert'
        server.middlewares.use('/__devtools_ovoxel_lab_start', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req);
            ensureOVoxelDirs();

            const runner = String(obj?.runner || 'conda_hunyuan3d');
            const runnerMap = {
              python3: { cmd: 'python3', baseArgs: [] },
              conda_hunyuan3d: { cmd: 'conda', baseArgs: ['run', '-n', 'hunyuan3d', 'python3'] },
              conda_trellis: { cmd: 'conda', baseArgs: ['run', '-n', 'trellis', 'python3'] },
            };
            const r = runnerMap[runner] || runnerMap.conda_trellis;

            const modeRaw = String(obj?.mode || '').trim().toLowerCase();
            const mode = (modeRaw === 'io_convert') ? 'io-convert' : modeRaw;
            if (!['convert', 'reconstruct', 'render', 'inspect', 'io-convert'].includes(mode)) {
              throw new Error('Unsupported mode');
            }

            const scriptAbs = path.join(root, 'tools', 'ovoxel_lab.py');
            if (!fs.existsSync(scriptAbs)) throw new Error('Missing tools/ovoxel_lab.py');
            const args = [...r.baseArgs, scriptAbs, mode];

            const resolveInput = (p) => resolveProjectFileWithPrefixes(p, {
              prefixes: [
                'assets/',
                'outputs/',
                'repos/',
                'tools/out/',
                'webautos/',
              ],
            });
            const addArg = (k, v) => {
              const s = String(v ?? '').trim();
              if (!s) return;
              if (s.startsWith('-')) args.push(`${k}=${s}`);
              else args.push(k, s);
            };

            let outPathRel = '';
            let outVxzRel = '';
            let outGlbRel = '';
            let outImageRel = '';
            let outMp4Rel = '';

            if (mode === 'convert') {
              const meshAbs = resolveInput(obj?.meshPath);
              if (!meshAbs || !fs.existsSync(meshAbs)) throw new Error('Invalid meshPath');
              const outBase = safeName(obj?.outName || 'ovoxel');
              const outVxzAbs = path.join(ovoxelOutRoot, `${outBase}.vxz`);
              outPathRel = toPosix(path.relative(root, outVxzAbs));
              outVxzRel = outPathRel;

              addArg('--mesh', meshAbs);
              addArg('--out', outVxzAbs);
              addArg('--grid-size', obj?.gridSize);
              addArg('--aabb', obj?.aabb);
              addArg('--face-weight', obj?.faceWeight);
              addArg('--boundary-weight', obj?.boundaryWeight);
              addArg('--regularization-weight', obj?.regularizationWeight);
              addArg('--timing', obj?.timing);
            } else if (mode === 'reconstruct') {
              const inAbs = resolveInput(obj?.inputPath);
              if (!inAbs || !fs.existsSync(inAbs)) throw new Error('Invalid inputPath');
              const outExt = String(obj?.outExt || '.glb').trim().toLowerCase() === '.ply' ? '.ply' : '.glb';
              const outBase = safeName(obj?.outName || 'ovoxel_recon');
              const outAbs = path.join(ovoxelOutRoot, `${outBase}${outExt}`);
              outPathRel = toPosix(path.relative(root, outAbs));
              if (outExt === '.glb') outGlbRel = outPathRel;

              addArg('--input', inAbs);
              addArg('--out', outAbs);
              addArg('--device', obj?.device || 'cuda');
              addArg('--grid-size', obj?.gridSize);
              addArg('--aabb', obj?.aabb);
              addArg('--split-weight', obj?.splitWeight);
              addArg('--decimation-target', obj?.decimationTarget);
              addArg('--texture-size', obj?.textureSize);
              addArg('--remesh', obj?.remesh);
              addArg('--remesh-band', obj?.remeshBand);
              addArg('--remesh-project', obj?.remeshProject);
              addArg('--extension-webp', obj?.extensionWebp);
              addArg('--verbose', obj?.verbose);
            } else if (mode === 'render') {
              const inAbs = resolveInput(obj?.inputPath);
              if (!inAbs || !fs.existsSync(inAbs)) throw new Error('Invalid inputPath');
              const outBase = safeName(obj?.outName || 'ovoxel_preview');
              const outImageAbs = path.join(ovoxelOutRoot, `${outBase}.png`);
              const renderMp4 = Number(obj?.renderMp4 || 0) ? 1 : 0;
              const outMp4Abs = path.join(ovoxelOutRoot, `${outBase}.mp4`);
              outPathRel = toPosix(path.relative(root, outImageAbs));
              outImageRel = outPathRel;
              if (renderMp4) outMp4Rel = toPosix(path.relative(root, outMp4Abs));

              addArg('--input', inAbs);
              addArg('--out-image', outImageAbs);
              if (renderMp4) addArg('--out-mp4', outMp4Abs);
              addArg('--grid-size', obj?.gridSize);
              addArg('--resolution', obj?.resolution);
              addArg('--ssaa', obj?.ssaa);
              addArg('--near', obj?.near);
              addArg('--far', obj?.far);
              addArg('--yaw-deg', obj?.yawDeg);
              addArg('--pitch-deg', obj?.pitchDeg);
              addArg('--radius', obj?.radius);
              addArg('--fov-deg', obj?.fovDeg);
              addArg('--num-frames', obj?.numFrames);
              addArg('--fps', obj?.fps);
            } else if (mode === 'inspect') {
              const inAbs = resolveInput(obj?.inputPath);
              if (!inAbs || !fs.existsSync(inAbs)) throw new Error('Invalid inputPath');
              addArg('--input', inAbs);
            } else if (mode === 'io-convert') {
              const inAbs = resolveInput(obj?.inputPath);
              if (!inAbs || !fs.existsSync(inAbs)) throw new Error('Invalid inputPath');
              const outExt = String(obj?.outExt || '.npz').trim().toLowerCase();
              if (!['.vxz', '.npz', '.ply'].includes(outExt)) throw new Error('Unsupported outExt');
              const outBase = safeName(obj?.outName || 'ovoxel_transcoded');
              const outAbs = path.join(ovoxelOutRoot, `${outBase}${outExt}`);
              outPathRel = toPosix(path.relative(root, outAbs));
              if (outExt === '.vxz') outVxzRel = outPathRel;

              addArg('--input', inAbs);
              addArg('--out', outAbs);
              addArg('--chunk-size', obj?.chunkSize);
              addArg('--compression', obj?.compression);
              addArg('--filter-mode', obj?.filterMode);
              addArg('--attr-interleave', obj?.attrInterleave);
            }

            const id = crypto.randomBytes(8).toString('hex');
            const job = {
              id,
              mode,
              status: 'running',
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              endedAt: '',
              cwd: root,
              cmd: [r.cmd, ...args].join(' '),
              stdout: '',
              stderr: '',
              outGlbRel,
              outVxzRel,
              outPathRel,
              outImageRel,
              outMp4Rel,
              outRigRel: '',
              exitCode: null,
              error: '',
              _proc: null,
            };
            ovoxelLabJobs.set(id, job);

            const proc = child_process.spawn(r.cmd, args, { cwd: root, env: process.env });
            job._proc = proc;
            proc.stdout.on('data', (d) => {
              job.stdout += String(d);
              if (job.stdout.length > 2_000_000) job.stdout = job.stdout.slice(-2_000_000);
            });
            proc.stderr.on('data', (d) => {
              job.stderr += String(d);
              if (job.stderr.length > 2_000_000) job.stderr = job.stderr.slice(-2_000_000);
            });
            proc.on('close', (code) => {
              job.exitCode = (code == null) ? null : Number(code);
              job.endedAt = new Date().toISOString();
              job.status = (job.exitCode === 0) ? 'done' : 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });
            proc.on('error', (e) => {
              job.error = String(e?.message || e);
              job.exitCode = -1;
              job.endedAt = new Date().toISOString();
              job.status = 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({
              ok: true,
              id,
              mode,
              cmd: job.cmd,
              outPath: outPathRel,
              outVxz: outVxzRel,
              outGlb: outGlbRel,
              outImage: outImageRel,
              outMp4: outMp4Rel,
            }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_ovoxel_lab_job?id=...
        server.middlewares.use('/__devtools_ovoxel_lab_job', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const id = String(url.searchParams.get('id') || '');
            const job = ovoxelLabJobs.get(id);
            if (!job) {
              res.statusCode = 404;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: 'job not found' }));
              return;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(jobToJson(job)));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_ovoxel_lab_kill { id }
        server.middlewares.use('/__devtools_ovoxel_lab_kill', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 100_000 });
            const id = String(obj?.id || '');
            const job = ovoxelLabJobs.get(id);
            if (!job) throw new Error('job not found');
            const proc = job._proc;
            if (proc && typeof proc.kill === 'function') {
              try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              job.status = 'killed';
              job.endedAt = new Date().toISOString();
              job.exitCode = -2;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // ---- Trellis PBR turntable renderer (GLB -> MP4) ----
        //
        // POST /__devtools_trellis_turntable_start
        // Body:
        //  - runner: 'python3' | 'conda_trellis'
        //  - glbAssetPath: 'assets/.../model.glb'
        //  - outName, device, envmap, fps, numFrames, resolution, r, fov
        server.middlewares.use('/__devtools_trellis_turntable_start', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req);
            ensureTrellisRenderDirs();

            const runner = String(obj?.runner || 'conda_trellis');
            const runnerMap = {
              python3: { cmd: 'python3', baseArgs: [] },
              conda_trellis: { cmd: 'conda', baseArgs: ['run', '-n', 'trellis', 'python3'] },
            };
            const rnr = runnerMap[runner] || runnerMap.conda_trellis;

            const glbAssetPath = safeRelAssetPath(obj?.glbAssetPath);
            if (!glbAssetPath) throw new Error('Missing/invalid glbAssetPath (must be under assets/)');
            const glbAbs = path.join(root, glbAssetPath);
            if (!fs.existsSync(glbAbs)) throw new Error(`GLB not found: ${glbAssetPath}`);

            const outBase = safeName(obj?.outName || 'turntable');
            const outMp4Abs = path.join(trellisRenderOutRoot, `${outBase}.mp4`);
            const outMp4Rel = toPosix(path.relative(root, outMp4Abs));

            const scriptAbs = path.join(root, 'tools', 'trellis2_render_turntable.py');
            const args = [
              ...rnr.baseArgs,
              scriptAbs,
              '--glb', glbAbs,
              '--out-mp4', outMp4Abs,
            ];

            const addArg = (k, v) => {
              const s = String(v ?? '').trim();
              if (!s) return;
              args.push(k, s);
            };

            addArg('--device', obj?.device);
            const envmapAbs = resolveProjectFile(obj?.envmap);
            if (envmapAbs && fs.existsSync(envmapAbs)) addArg('--envmap', envmapAbs);
            if (obj?.fps != null) addArg('--fps', obj?.fps);
            if (obj?.numFrames != null) addArg('--num-frames', obj?.numFrames);
            if (obj?.resolution != null) addArg('--resolution', obj?.resolution);
            if (obj?.r != null) addArg('--r', obj?.r);
            if (obj?.fov != null) addArg('--fov', obj?.fov);

            const id = crypto.randomBytes(8).toString('hex');
            const job = {
              id,
              status: 'running',
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              endedAt: '',
              cwd: root,
              cmd: [rnr.cmd, ...args].join(' '),
              stdout: '',
              stderr: '',
              outMp4Rel,
              outGlbRel: '',
              outRigRel: '',
              outImageRel: '',
              exitCode: null,
              error: '',
              _proc: null,
            };
            trellisTurntableJobs.set(id, job);

            const proc = child_process.spawn(rnr.cmd, args, { cwd: root, env: process.env });
            job._proc = proc;
            proc.stdout.on('data', (d) => {
              job.stdout += String(d);
              if (job.stdout.length > 2_000_000) job.stdout = job.stdout.slice(-2_000_000);
            });
            proc.stderr.on('data', (d) => {
              job.stderr += String(d);
              if (job.stderr.length > 2_000_000) job.stderr = job.stderr.slice(-2_000_000);
            });
            proc.on('close', (code) => {
              job.exitCode = (code == null) ? null : Number(code);
              job.endedAt = new Date().toISOString();
              job.status = (job.exitCode === 0) ? 'done' : 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });
            proc.on('error', (e) => {
              job.error = String(e?.message || e);
              job.exitCode = -1;
              job.endedAt = new Date().toISOString();
              job.status = 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, id, outMp4: outMp4Rel }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_trellis_turntable_job?id=...
        server.middlewares.use('/__devtools_trellis_turntable_job', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const id = String(url.searchParams.get('id') || '');
            const job = trellisTurntableJobs.get(id);
            if (!job) {
              res.statusCode = 404;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: 'job not found' }));
              return;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(jobToJson(job)));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_trellis_turntable_kill { id }
        server.middlewares.use('/__devtools_trellis_turntable_kill', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 100_000 });
            const id = String(obj?.id || '');
            const job = trellisTurntableJobs.get(id);
            if (!job) throw new Error('job not found');
            const proc = job._proc;
            if (proc && typeof proc.kill === 'function') {
              try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              job.status = 'killed';
              job.endedAt = new Date().toISOString();
              job.exitCode = -2;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // ---- Z-Image-Turbo (text->image) -> Trellis (image->glb) ----
        // POST /__devtools_zimage3d_start
        // Body:
        //  - runner: 'python3' | 'conda_trellis'
        //  - prompt, seed, width, height, steps, guidanceScale, zimageModel, dtype, device, lowCpuMemUsage, cpuOffload, attentionBackend, compileTransformer
        //  - outName
        //  - trellisModel, simplify, aabb, decimationTarget, textureSize, remesh, remeshBand, remeshProject, extensionWebp
        //  - rigBackend, rigArgs
        server.middlewares.use('/__devtools_zimage3d_start', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req);
            ensureZImageDirs();

            const runner = String(obj?.runner || 'conda_hunyuan3d');
            const runnerMap = {
              python3: { cmd: 'python3', baseArgs: [] },
              conda_hunyuan3d: { cmd: 'conda', baseArgs: ['run', '-n', 'hunyuan3d', 'python3'] },
              conda_trellis: { cmd: 'conda', baseArgs: ['run', '-n', 'trellis', 'python3'] },
            };
            const r = runnerMap[runner] || runnerMap.conda_trellis;

            const prompt = String(obj?.prompt || '').trim();
            if (!prompt) throw new Error('Missing prompt');

            const outBase = safeName(obj?.outName || 'zimage');
            const outImageAbs = path.join(zimageOutRoot, `${outBase}.png`);
            const outGlbAbs = path.join(zimageOutRoot, `${outBase}.glb`);
            const outRigAbs = path.join(zimageOutRoot, `${outBase}_rig.glb`);
            const outMp4Abs = path.join(zimageOutRoot, `${outBase}.mp4`);

            const outImageRel = toPosix(path.relative(root, outImageAbs));
            const outGlbRel = toPosix(path.relative(root, outGlbAbs));
            const outRigRel = toPosix(path.relative(root, outRigAbs));
            const outMp4Rel = toPosix(path.relative(root, outMp4Abs));

            const scriptAbs = path.join(root, 'tools', 'zimage_text_to_glb.py');
            const args = [
              ...r.baseArgs,
              scriptAbs,
              '--prompt', prompt,
              '--out-image', outImageAbs,
              '--out-glb', outGlbAbs,
            ];

            const addArg = (k, v) => {
              const s = String(v ?? '').trim();
              if (!s) return;
              args.push(k, s);
            };

            // Z-Image args
            addArg('--device', obj?.device);
            addArg('--dtype', obj?.dtype);
            addArg('--zimage-model', obj?.zimageModel);
            if (obj?.seed != null) addArg('--seed', obj?.seed);
            if (obj?.width != null) addArg('--width', obj?.width);
            if (obj?.height != null) addArg('--height', obj?.height);
            if (obj?.steps != null) addArg('--steps', obj?.steps);
            if (obj?.guidanceScale != null) addArg('--guidance-scale', obj?.guidanceScale);
            if (obj?.lowCpuMemUsage != null) addArg('--low-cpu-mem-usage', obj?.lowCpuMemUsage);
            if (obj?.cpuOffload != null) addArg('--cpu-offload', obj?.cpuOffload);
            addArg('--attention-backend', obj?.attentionBackend);
            if (obj?.compileTransformer != null) addArg('--compile-transformer', obj?.compileTransformer);

            // Trellis export args
            addArg('--trellis-model', obj?.trellisModel);
            if (obj?.simplify != null) addArg('--simplify', obj?.simplify);
            addArg('--aabb', obj?.aabb);
            if (obj?.decimationTarget != null) addArg('--decimation-target', obj?.decimationTarget);
            if (obj?.textureSize != null) addArg('--texture-size', obj?.textureSize);
            if (obj?.remesh != null) addArg('--remesh', obj?.remesh);
            if (obj?.remeshBand != null) addArg('--remesh-band', obj?.remeshBand);
            if (obj?.remeshProject != null) addArg('--remesh-project', obj?.remeshProject);
            if (obj?.extensionWebp != null) addArg('--extension-webp', obj?.extensionWebp);

            const rigBackend = String(obj?.rigBackend || '').trim();
            const rigArgs = String(obj?.rigArgs || '').trim();
            if (rigBackend) {
              args.push('--rig-backend', rigBackend, '--rig-out', outRigAbs);
              if (rigArgs) args.push('--rig-args', rigArgs);
            }

            // Optional preview MP4 render.
            const renderMp4 = Number(obj?.renderMp4 || 0) ? 1 : 0;
            if (renderMp4) {
              args.push('--out-mp4', outMp4Abs);
              const envmapAbs = resolveProjectFile(obj?.envmap);
              if (envmapAbs && fs.existsSync(envmapAbs)) args.push('--envmap', envmapAbs);
              if (obj?.fps != null) args.push('--fps', String(obj.fps));
            }

            const id = crypto.randomBytes(8).toString('hex');
            const job = {
              id,
              status: 'running',
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              endedAt: '',
              cwd: root,
              cmd: [r.cmd, ...args].join(' '),
              stdout: '',
              stderr: '',
              outGlbRel,
              outImageRel,
              outMp4Rel: renderMp4 ? outMp4Rel : '',
              outRigRel: rigBackend ? outRigRel : '',
              exitCode: null,
              error: '',
              _proc: null,
            };
            zimageJobs.set(id, job);

            const proc = child_process.spawn(r.cmd, args, { cwd: root, env: process.env });
            job._proc = proc;
            proc.stdout.on('data', (d) => {
              job.stdout += String(d);
              if (job.stdout.length > 2_000_000) job.stdout = job.stdout.slice(-2_000_000);
            });
            proc.stderr.on('data', (d) => {
              job.stderr += String(d);
              if (job.stderr.length > 2_000_000) job.stderr = job.stderr.slice(-2_000_000);
            });
            proc.on('close', (code) => {
              job.exitCode = (code == null) ? null : Number(code);
              job.endedAt = new Date().toISOString();
              job.status = (job.exitCode === 0) ? 'done' : 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });
            proc.on('error', (e) => {
              job.error = String(e?.message || e);
              job.exitCode = -1;
              job.endedAt = new Date().toISOString();
              job.status = 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, id, outGlb: outGlbRel, outRig: job.outRigRel, outMp4: job.outMp4Rel || '', outImage: outImageRel }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // ---- Z-Image-Turbo step 1: text -> image (PNG) ----
        server.middlewares.use('/__devtools_zimage_t2i_start', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req);
            ensureZImageDirs();

            const runner = String(obj?.runner || 'conda_hunyuan3d');
            const runnerMap = {
              python3: { cmd: 'python3', baseArgs: [] },
              conda_hunyuan3d: { cmd: 'conda', baseArgs: ['run', '-n', 'hunyuan3d', 'python3'] },
              conda_trellis: { cmd: 'conda', baseArgs: ['run', '-n', 'trellis', 'python3'] },
            };
            const r = runnerMap[runner] || runnerMap.conda_trellis;

            const prompt = String(obj?.prompt || '').trim();
            if (!prompt) throw new Error('Missing prompt');

            const outBase = safeName(obj?.outName || 'zimage');
            const outImageAbs = path.join(zimageOutRoot, `${outBase}.png`);
            const outImageRel = toPosix(path.relative(root, outImageAbs));

            const scriptAbs = path.join(root, 'tools', 'zimage_text_to_image.py');
            const args = [
              ...r.baseArgs,
              scriptAbs,
              '--prompt', prompt,
              '--out', outImageAbs,
            ];

            const addArg = (k, v) => {
              const s = String(v ?? '').trim();
              if (!s) return;
              if (s.startsWith('-')) args.push(`${k}=${s}`);
              else args.push(k, s);
            };

            addArg('--model', obj?.zimageModel);
            addArg('--device', obj?.device);
            addArg('--dtype', obj?.dtype);
            if (obj?.seed != null) addArg('--seed', obj?.seed);
            if (obj?.width != null) addArg('--width', obj?.width);
            if (obj?.height != null) addArg('--height', obj?.height);
            if (obj?.steps != null) addArg('--steps', obj?.steps);
            if (obj?.guidanceScale != null) addArg('--guidance-scale', obj?.guidanceScale);
            if (obj?.lowCpuMemUsage != null) addArg('--low-cpu-mem-usage', obj?.lowCpuMemUsage);
            if (obj?.cpuOffload != null) addArg('--cpu-offload', obj?.cpuOffload);
            addArg('--attention-backend', obj?.attentionBackend);
            if (obj?.compileTransformer != null) addArg('--compile-transformer', obj?.compileTransformer);

            const id = crypto.randomBytes(8).toString('hex');
            const job = {
              id,
              status: 'running',
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              endedAt: '',
              cwd: root,
              cmd: [r.cmd, ...args].join(' '),
              stdout: '',
              stderr: '',
              outGlbRel: '',
              outImageRel,
              outRigRel: '',
              exitCode: null,
              error: '',
              _proc: null,
            };
            zimageT2IJobs.set(id, job);

            const proc = child_process.spawn(r.cmd, args, { cwd: root, env: process.env });
            job._proc = proc;
            proc.stdout.on('data', (d) => {
              job.stdout += String(d);
              if (job.stdout.length > 2_000_000) job.stdout = job.stdout.slice(-2_000_000);
            });
            proc.stderr.on('data', (d) => {
              job.stderr += String(d);
              if (job.stderr.length > 2_000_000) job.stderr = job.stderr.slice(-2_000_000);
            });
            proc.on('close', (code) => {
              job.exitCode = (code == null) ? null : Number(code);
              job.endedAt = new Date().toISOString();
              job.status = (job.exitCode === 0) ? 'done' : 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });
            proc.on('error', (e) => {
              job.error = String(e?.message || e);
              job.exitCode = -1;
              job.endedAt = new Date().toISOString();
              job.status = 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, id, outImage: outImageRel }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        server.middlewares.use('/__devtools_zimage_t2i_job', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const id = String(url.searchParams.get('id') || '');
            const job = zimageT2IJobs.get(id);
            if (!job) {
              res.statusCode = 404;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: 'job not found' }));
              return;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(jobToJson(job)));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        server.middlewares.use('/__devtools_zimage_t2i_kill', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 100_000 });
            const id = String(obj?.id || '');
            const job = zimageT2IJobs.get(id);
            if (!job) throw new Error('job not found');
            const proc = job._proc;
            if (proc && typeof proc.kill === 'function') {
              try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              job.status = 'killed';
              job.endedAt = new Date().toISOString();
              job.exitCode = -2;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // ---- Z-Image-Turbo step 1.5: image -> image (img2img) ----
        // POST /__devtools_zimage_img2img_start
        // Body:
        //  - runner: 'python3' | 'conda_trellis'
        //  - prompt (required)
        //  - inImageAssetPath (required; assets/...)
        //  - outName (optional)
        //  - model, device, dtype, seed, steps, guidanceScale, strength, lowCpuMemUsage, cpuOffload, attentionBackend, compileTransformer
        server.middlewares.use('/__devtools_zimage_img2img_start', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req);
            ensureZImageDirs();

            const runner = String(obj?.runner || 'conda_hunyuan3d');
            const runnerMap = {
              python3: { cmd: 'python3', baseArgs: [] },
              conda_hunyuan3d: { cmd: 'conda', baseArgs: ['run', '-n', 'hunyuan3d', 'python3'] },
              conda_trellis: { cmd: 'conda', baseArgs: ['run', '-n', 'trellis', 'python3'] },
            };
            const r = runnerMap[runner] || runnerMap.conda_trellis;

            const prompt = String(obj?.prompt || '').trim();
            if (!prompt) throw new Error('Missing prompt');

            const inImageAssetPath = safeRelAssetPath(obj?.inImageAssetPath);
            if (!inImageAssetPath) throw new Error('Missing inImageAssetPath');
            const inImageAbs = path.join(root, inImageAssetPath);
            if (!fs.existsSync(inImageAbs)) throw new Error(`Image not found: ${inImageAssetPath}`);

            const outBase = safeName(obj?.outName || 'zimage_edit');
            const outImageAbs = path.join(zimageOutRoot, `${outBase}_edit.png`);
            const outImageRel = toPosix(path.relative(root, outImageAbs));

            const scriptAbs = path.join(root, 'tools', 'zimage_img2img.py');
            const args = [
              ...r.baseArgs,
              scriptAbs,
              '--image', inImageAbs,
              '--prompt', prompt,
              '--out', outImageAbs,
            ];

            const addArg = (k, v) => {
              const s = String(v ?? '').trim();
              if (!s) return;
              if (s.startsWith('-')) args.push(`${k}=${s}`);
              else args.push(k, s);
            };

            addArg('--model', obj?.model);
            addArg('--device', obj?.device);
            addArg('--dtype', obj?.dtype);
            if (obj?.seed != null) addArg('--seed', obj?.seed);
            if (obj?.steps != null) addArg('--steps', obj?.steps);
            if (obj?.guidanceScale != null) addArg('--guidance-scale', obj?.guidanceScale);
            if (obj?.strength != null) addArg('--strength', obj?.strength);
            if (obj?.lowCpuMemUsage != null) addArg('--low-cpu-mem-usage', obj?.lowCpuMemUsage);
            if (obj?.cpuOffload != null) addArg('--cpu-offload', obj?.cpuOffload);
            addArg('--attention-backend', obj?.attentionBackend);
            if (obj?.compileTransformer != null) addArg('--compile-transformer', obj?.compileTransformer);

            const id = crypto.randomBytes(8).toString('hex');
            const job = {
              id,
              status: 'running',
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              endedAt: '',
              cwd: root,
              cmd: [r.cmd, ...args].join(' '),
              stdout: '',
              stderr: '',
              outGlbRel: '',
              outImageRel: outImageRel,
              outMp4Rel: '',
              outRigRel: '',
              exitCode: null,
              error: '',
              _proc: null,
            };
            zimageImg2ImgJobs.set(id, job);

            const proc = child_process.spawn(r.cmd, args, { cwd: root, env: process.env });
            job._proc = proc;
            proc.stdout.on('data', (d) => {
              job.stdout += String(d);
              if (job.stdout.length > 2_000_000) job.stdout = job.stdout.slice(-2_000_000);
            });
            proc.stderr.on('data', (d) => {
              job.stderr += String(d);
              if (job.stderr.length > 2_000_000) job.stderr = job.stderr.slice(-2_000_000);
            });
            proc.on('close', (code) => {
              job.exitCode = (code == null) ? null : Number(code);
              job.endedAt = new Date().toISOString();
              job.status = (job.exitCode === 0) ? 'done' : 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });
            proc.on('error', (e) => {
              job.error = String(e?.message || e);
              job.exitCode = -1;
              job.endedAt = new Date().toISOString();
              job.status = 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, id, outImage: outImageRel }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        server.middlewares.use('/__devtools_zimage_img2img_job', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const id = String(url.searchParams.get('id') || '');
            const job = zimageImg2ImgJobs.get(id);
            if (!job) {
              res.statusCode = 404;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: 'job not found' }));
              return;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(jobToJson(job)));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        server.middlewares.use('/__devtools_zimage_img2img_kill', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 100_000 });
            const id = String(obj?.id || '');
            const job = zimageImg2ImgJobs.get(id);
            if (!job) throw new Error('job not found');
            const proc = job._proc;
            if (proc && typeof proc.kill === 'function') {
              try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              job.status = 'killed';
              job.endedAt = new Date().toISOString();
              job.exitCode = -2;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // ---- Optional step 2: remove background (PNG -> RGBA PNG) ----
        server.middlewares.use('/__devtools_zimage_rembg_start', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req);
            ensureZImageDirs();

            const runner = String(obj?.runner || 'conda_hunyuan3d');
            const runnerMap = {
              python3: { cmd: 'python3', baseArgs: [] },
              conda_hunyuan3d: { cmd: 'conda', baseArgs: ['run', '-n', 'hunyuan3d', 'python3'] },
              conda_trellis: { cmd: 'conda', baseArgs: ['run', '-n', 'trellis', 'python3'] },
            };
            const r = runnerMap[runner] || runnerMap.conda_trellis;

            const outBase = safeName(obj?.outName || 'zimage_cutout');
            const outImageAbs = path.join(zimageOutRoot, `${outBase}_cutout.png`);
            const outImageRel = toPosix(path.relative(root, outImageAbs));

            // Resolve input image:
            // - inImageAssetPath: existing file under assets/
            // - inImageDataUrl (+ inImageExt): uploaded image from the browser
            let inAbs = '';
            const inAsset = safeRelAssetPath(obj?.inImageAssetPath);
            const inDataUrl = String(obj?.inImageDataUrl || '');
            if (inAsset) {
              inAbs = path.join(root, inAsset);
              if (!fs.existsSync(inAbs)) throw new Error(`Image not found: ${inAsset}`);
            } else if (inDataUrl) {
              const ext = String(obj?.inImageExt || obj?.imageExt || 'png').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'png';
              const inImageAbs = path.join(zimageOutRoot, `${outBase}_input.${ext}`);
              decodeDataUrlToFile(inDataUrl, inImageAbs);
              inAbs = inImageAbs;
            } else {
              throw new Error('Missing inImageAssetPath or inImageDataUrl');
            }

            const scriptAbs = path.join(root, 'tools', 'remove_bg_birefnet.py');
            const args = [
              ...r.baseArgs,
              scriptAbs,
              '--in', inAbs,
              '--out', outImageAbs,
            ];

            const addArg = (k, v) => {
              const s = String(v ?? '').trim();
              if (!s) return;
              if (s.startsWith('-')) args.push(`${k}=${s}`);
              else args.push(k, s);
            };
            addArg('--device', obj?.device);
            addArg('--model', obj?.rembgModel);

            const id = crypto.randomBytes(8).toString('hex');
            const job = {
              id,
              status: 'running',
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              endedAt: '',
              cwd: root,
              cmd: [r.cmd, ...args].join(' '),
              stdout: '',
              stderr: '',
              outGlbRel: '',
              outImageRel,
              outRigRel: '',
              exitCode: null,
              error: '',
              _proc: null,
            };
            zimageRembgJobs.set(id, job);

            const proc = child_process.spawn(r.cmd, args, { cwd: root, env: process.env });
            job._proc = proc;
            proc.stdout.on('data', (d) => {
              job.stdout += String(d);
              if (job.stdout.length > 2_000_000) job.stdout = job.stdout.slice(-2_000_000);
            });
            proc.stderr.on('data', (d) => {
              job.stderr += String(d);
              if (job.stderr.length > 2_000_000) job.stderr = job.stderr.slice(-2_000_000);
            });
            proc.on('close', (code) => {
              job.exitCode = (code == null) ? null : Number(code);
              job.endedAt = new Date().toISOString();
              job.status = (job.exitCode === 0) ? 'done' : 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });
            proc.on('error', (e) => {
              job.error = String(e?.message || e);
              job.exitCode = -1;
              job.endedAt = new Date().toISOString();
              job.status = 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, id, outImage: outImageRel }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        server.middlewares.use('/__devtools_zimage_rembg_job', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const id = String(url.searchParams.get('id') || '');
            const job = zimageRembgJobs.get(id);
            if (!job) {
              res.statusCode = 404;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: 'job not found' }));
              return;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(jobToJson(job)));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        server.middlewares.use('/__devtools_zimage_rembg_kill', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 100_000 });
            const id = String(obj?.id || '');
            const job = zimageRembgJobs.get(id);
            if (!job) throw new Error('job not found');
            const proc = job._proc;
            if (proc && typeof proc.kill === 'function') {
              try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              job.status = 'killed';
              job.endedAt = new Date().toISOString();
              job.exitCode = -2;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // ---- Step 3: image -> GLB (Hunyuan) using chosen image (original or cutout) ----
        server.middlewares.use('/__devtools_zimage_mesh_start', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req);
            ensureZImageDirs();

            const runner = String(obj?.runner || 'conda_hunyuan3d');
            const runnerMap = {
              python3: { cmd: 'python3', baseArgs: [] },
              conda_hunyuan3d: { cmd: 'conda', baseArgs: ['run', '-n', 'hunyuan3d', 'python3'] },
              conda_trellis: { cmd: 'conda', baseArgs: ['run', '-n', 'trellis', 'python3'] },
            };
            const r = runnerMap[runner] || runnerMap.conda_trellis;

            const imageAssetPath = safeRelAssetPath(obj?.imageAssetPath);
            if (!imageAssetPath) throw new Error('Missing imageAssetPath');
            const imageAbs = path.join(root, imageAssetPath);
            if (!fs.existsSync(imageAbs)) throw new Error(`Image not found: ${imageAssetPath}`);

            const backend = String(obj?.meshBackend || 'hunyuan').trim().toLowerCase() === 'trellis' ? 'trellis' : 'hunyuan';
            const outBase = safeName(obj?.outName || (backend === 'trellis' ? 'zimage' : 'zimage_hunyuan'));
            const outGlbAbs = path.join(zimageOutRoot, `${outBase}.glb`);
            const outRigAbs = path.join(zimageOutRoot, `${outBase}_rig.glb`);
            const outMp4Abs = path.join(zimageOutRoot, `${outBase}.mp4`);
            const outGlbRel = toPosix(path.relative(root, outGlbAbs));
            const outRigRel = toPosix(path.relative(root, outRigAbs));
            const outMp4Rel = toPosix(path.relative(root, outMp4Abs));

            const scriptAbs = (backend === 'trellis')
              ? path.join(root, 'tools', 'trellis2_image_to_glb.py')
              : path.join(root, 'tools', 'hunyuan_mesh_texture_to_glb.py');
            const args = [
              ...r.baseArgs,
              scriptAbs,
              '--image', imageAbs,
              '--out-glb', outGlbAbs,
            ];

            const addArg = (k, v) => {
              const s = String(v ?? '').trim();
              if (!s) return;
              if (s.startsWith('-')) args.push(`${k}=${s}`);
              else args.push(k, s);
            };

            if (backend === 'trellis') addArg('--model', obj?.trellisModel);
            else addArg('--shape-model', obj?.trellisModel);
            addArg('--device', obj?.device);
            if (backend === 'trellis') {
              if (obj?.simplify != null) addArg('--simplify', obj?.simplify);
              addArg('--aabb', obj?.aabb);
              if (obj?.decimationTarget != null) addArg('--decimation-target', obj?.decimationTarget);
              if (obj?.textureSize != null) addArg('--texture-size', obj?.textureSize);
              if (obj?.remesh != null) addArg('--remesh', obj?.remesh);
              if (obj?.remeshBand != null) addArg('--remesh-band', obj?.remeshBand);
              if (obj?.remeshProject != null) addArg('--remesh-project', obj?.remeshProject);
              if (obj?.extensionWebp != null) addArg('--extension-webp', obj?.extensionWebp);
            } else {
              if (obj?.shapeSteps != null) addArg('--shape-steps', obj?.shapeSteps);
              if (obj?.shapeOctree != null) addArg('--shape-octree', obj?.shapeOctree);
              if (obj?.shapeNumChunks != null) addArg('--shape-num-chunks', obj?.shapeNumChunks);
              if (obj?.seed != null) addArg('--shape-seed', obj?.seed);
              if (obj?.shapeSubfolder != null) addArg('--shape-subfolder', obj?.shapeSubfolder);
              if (obj?.shapeVariant != null) addArg('--shape-variant', obj?.shapeVariant);
              if (obj?.texModel != null) addArg('--tex-model', obj?.texModel);
              if (obj?.texSubfolder != null) addArg('--tex-subfolder', obj?.texSubfolder);
              if (obj?.enableFlashvdm != null) addArg('--enable-flashvdm', obj?.enableFlashvdm);
              if (obj?.rembg != null) addArg('--rembg', obj?.rembg);
            }

            const rigBackend = String(obj?.rigBackend || '').trim();
            const rigArgs = String(obj?.rigArgs || '').trim();
            if (backend === 'trellis' && rigBackend) {
              args.push('--rig-backend', rigBackend, '--rig-out', outRigAbs);
              if (rigArgs) args.push('--rig-args', rigArgs);
            }

            const renderMp4 = (backend === 'trellis' && Number(obj?.renderMp4 || 0)) ? 1 : 0;
            if (renderMp4) {
              args.push('--out-mp4', outMp4Abs);
              const envmapAbs = resolveProjectFile(obj?.envmap);
              if (envmapAbs && fs.existsSync(envmapAbs)) args.push('--envmap', envmapAbs);
              if (obj?.fps != null) args.push('--fps', String(obj.fps));
            }

            const id = crypto.randomBytes(8).toString('hex');
            const job = {
              id,
              status: 'running',
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              endedAt: '',
              cwd: root,
              cmd: [r.cmd, ...args].join(' '),
              stdout: '',
              stderr: '',
              outGlbRel,
              outImageRel: '',
              outMp4Rel: renderMp4 ? outMp4Rel : '',
              outRigRel: (backend === 'trellis' && rigBackend) ? outRigRel : '',
              exitCode: null,
              error: '',
              _proc: null,
            };
            zimageMeshJobs.set(id, job);

            const proc = child_process.spawn(r.cmd, args, { cwd: root, env: process.env });
            job._proc = proc;
            proc.stdout.on('data', (d) => {
              job.stdout += String(d);
              if (job.stdout.length > 2_000_000) job.stdout = job.stdout.slice(-2_000_000);
            });
            proc.stderr.on('data', (d) => {
              job.stderr += String(d);
              if (job.stderr.length > 2_000_000) job.stderr = job.stderr.slice(-2_000_000);
            });
            proc.on('close', (code) => {
              job.exitCode = (code == null) ? null : Number(code);
              job.endedAt = new Date().toISOString();
              job.status = (job.exitCode === 0) ? 'done' : 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });
            proc.on('error', (e) => {
              job.error = String(e?.message || e);
              job.exitCode = -1;
              job.endedAt = new Date().toISOString();
              job.status = 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, id, outGlb: outGlbRel, outRig: job.outRigRel, outMp4: job.outMp4Rel || '' }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        server.middlewares.use('/__devtools_zimage_mesh_job', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const id = String(url.searchParams.get('id') || '');
            const job = zimageMeshJobs.get(id);
            if (!job) {
              res.statusCode = 404;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: 'job not found' }));
              return;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(jobToJson(job)));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        server.middlewares.use('/__devtools_zimage_mesh_kill', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 100_000 });
            const id = String(obj?.id || '');
            const job = zimageMeshJobs.get(id);
            if (!job) throw new Error('job not found');
            const proc = job._proc;
            if (proc && typeof proc.kill === 'function') {
              try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              job.status = 'killed';
              job.endedAt = new Date().toISOString();
              job.exitCode = -2;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_zimage3d_job?id=...
        server.middlewares.use('/__devtools_zimage3d_job', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const id = String(url.searchParams.get('id') || '');
            const job = zimageJobs.get(id);
            if (!job) {
              res.statusCode = 404;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: 'job not found' }));
              return;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(jobToJson(job)));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_zimage3d_kill { id }
        server.middlewares.use('/__devtools_zimage3d_kill', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 100_000 });
            const id = String(obj?.id || '');
            const job = zimageJobs.get(id);
            if (!job) throw new Error('job not found');
            const proc = job._proc;
            if (proc && typeof proc.kill === 'function') {
              try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              job.status = 'killed';
              job.endedAt = new Date().toISOString();
              job.exitCode = -2;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // ---- Rigging: run tools/rig_asset.py on an existing model ----
        // POST /__devtools_rig_start
        // Body:
        //  - runner: 'python3' | 'conda_trellis' (optional; default conda_trellis)
        //  - inModelPath: assets/... | outputs/... | repos/... (or absolute within repo)
        //  - rigBackend: rigify | blenrig | rigacar | unirig | riganything | rignet
        //  - rigArgs: string (extra args appended after backend; optional)
        //  - blenderPath: optional explicit Blender executable path (for Blender backends)
        //  - outName: optional
        server.middlewares.use('/__devtools_rig_start', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req);
            ensureRigDirs();

            const runner = String(obj?.runner || 'conda_trellis');
            const runnerMap = {
              python3: { cmd: 'python3', baseArgs: [] },
              conda_trellis: { cmd: 'conda', baseArgs: ['run', '-n', 'trellis', 'python3'] },
            };
            const r = runnerMap[runner] || runnerMap.conda_trellis;

            const inAbs = resolveProjectFileWithPrefixes(obj?.inModelPath, { prefixes: ['assets/', 'outputs/', 'repos/', 'tools/out/'] });
            if (!inAbs || !fs.existsSync(inAbs)) throw new Error('Missing or invalid inModelPath');

            const backend = String(obj?.rigBackend || '').trim();
            if (!backend) throw new Error('Missing rigBackend');

            const outBase = safeName(obj?.outName || 'rig');
            const outAbs = path.join(rigOutRoot, `${outBase}_${backend}.glb`);
            const outRel = toPosix(path.relative(root, outAbs));

            const scriptAbs = path.join(root, 'tools', 'rig_asset.py');
            const extra = splitArgs(String(obj?.rigArgs || '').trim());
            const blenderPath = String(obj?.blenderPath || '').trim();
            const isBlenderBackend = (backend === 'rigify' || backend === 'blenrig' || backend === 'rigacar');
            const args = [
              ...r.baseArgs,
              scriptAbs,
              backend,
              '--in',
              inAbs,
              '--out',
              outAbs,
              ...(isBlenderBackend && blenderPath ? ['--blender', blenderPath] : []),
              ...extra,
            ];

            const id = crypto.randomBytes(8).toString('hex');
            const job = {
              id,
              status: 'running',
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              endedAt: '',
              cwd: root,
              cmd: [r.cmd, ...args].join(' '),
              stdout: '',
              stderr: '',
              outGlbRel: '',
              outImageRel: '',
              outMp4Rel: '',
              outRigRel: outRel,
              exitCode: null,
              error: '',
              _proc: null,
            };
            rigJobs.set(id, job);

            const proc = child_process.spawn(r.cmd, args, { cwd: root, env: process.env });
            job._proc = proc;
            proc.stdout.on('data', (d) => {
              job.stdout += String(d);
              if (job.stdout.length > 2_000_000) job.stdout = job.stdout.slice(-2_000_000);
            });
            proc.stderr.on('data', (d) => {
              job.stderr += String(d);
              if (job.stderr.length > 2_000_000) job.stderr = job.stderr.slice(-2_000_000);
            });
            proc.on('close', (code) => {
              job.exitCode = (code == null) ? null : Number(code);
              job.endedAt = new Date().toISOString();
              job.status = (job.exitCode === 0) ? 'done' : 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });
            proc.on('error', (e) => {
              job.error = String(e?.message || e);
              job.exitCode = -1;
              job.endedAt = new Date().toISOString();
              job.status = 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, id, outRig: outRel }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_rig_job?id=...
        server.middlewares.use('/__devtools_rig_job', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const id = String(url.searchParams.get('id') || '');
            const job = rigJobs.get(id);
            if (!job) {
              res.statusCode = 404;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: 'job not found' }));
              return;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(jobToJson(job)));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_rig_kill { id }
        server.middlewares.use('/__devtools_rig_kill', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 100_000 });
            const id = String(obj?.id || '');
            const job = rigJobs.get(id);
            if (!job) throw new Error('job not found');
            const proc = job._proc;
            if (proc && typeof proc.kill === 'function') {
              try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              job.status = 'killed';
              job.endedAt = new Date().toISOString();
              job.exitCode = -2;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // ---- Convert assets (USD -> GLB/GLTF) ----
        // POST /__devtools_convert_start
        // Body:
        //  - runner: 'python3' | 'conda_trellis' (optional; default conda_trellis)
        //  - inPath: assets/... | outputs/... | repos/... (or absolute within repo)
        //  - blenderPath: optional explicit Blender executable path
        //  - exportFormat: GLB | GLTF_SEPARATE
        //  - outName (optional)
        server.middlewares.use('/__devtools_convert_start', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req);
            ensureConvertDirs();

            const runner = String(obj?.runner || 'conda_trellis');
            const runnerMap = {
              python3: { cmd: 'python3', baseArgs: [] },
              conda_trellis: { cmd: 'conda', baseArgs: ['run', '-n', 'trellis', 'python3'] },
            };
            const r = runnerMap[runner] || runnerMap.conda_trellis;

            const inAbs = resolveProjectFileWithPrefixes(obj?.inPath, { prefixes: ['assets/', 'outputs/', 'repos/', 'tools/out/'] });
            if (!inAbs || !fs.existsSync(inAbs)) throw new Error('Missing or invalid inPath');

            // Server-side preflight: refuse to convert meshless USD stages.
            // This prevents accidental conversion even if UI tags/filters are wrong.
            try {
              const ext = String(path.extname(inAbs) || '').toLowerCase();
              const isUsd = ext === '.usd' || ext === '.usda' || ext === '.usdc' || ext === '.usdz';
              if (isUsd) {
                // Reuse the usd_inspect cache if possible.
                let mtimeMs = 0;
                try { mtimeMs = Number(fs.statSync(inAbs).mtimeMs || 0) || 0; } catch { mtimeMs = 0; }
                const cacheKey = `${runner}::${inAbs}`;
                const cached = _usdInspectCache.get(cacheKey);
                let parsed = null;

                if (cached && Number(cached.mtimeMs || 0) === mtimeMs && cached.resp?.json) {
                  parsed = cached.resp.json;
                } else {
                  const scriptAbsInspect = path.join(root, 'tools', 'usd_inspect.py');
                  const inspectArgs = [
                    ...r.baseArgs,
                    scriptAbsInspect,
                    '--in',
                    inAbs,
                  ];
                  const out = await new Promise((resolve) => {
                    const proc = child_process.spawn(r.cmd, inspectArgs, { cwd: root, env: process.env });
                    let stdout = '';
                    let stderr = '';
                    let done = false;
                    const finish = (exitCode, timedOut) => {
                      if (done) return;
                      done = true;
                      resolve({ stdout, stderr, exitCode, timedOut });
                    };
                    const t = setTimeout(() => {
                      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
                      finish(-3, true);
                    }, 60_000);
                    proc.stdout.on('data', (d) => {
                      stdout += String(d);
                      if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000);
                    });
                    proc.stderr.on('data', (d) => {
                      stderr += String(d);
                      if (stderr.length > 2_000_000) stderr = stderr.slice(-2_000_000);
                    });
                    proc.on('close', (code) => {
                      try { clearTimeout(t); } catch { /* ignore */ }
                      finish((code == null) ? null : Number(code), false);
                    });
                    proc.on('error', (e) => {
                      try { clearTimeout(t); } catch { /* ignore */ }
                      stderr += `\n(proc error) ${String(e?.message || e)}`;
                      finish(-1, false);
                    });
                  });
                  try { parsed = out.stdout ? JSON.parse(String(out.stdout)) : null; } catch { parsed = null; }

                  // Store a cache entry shaped like /__devtools_usd_inspect.
                  const respObj = {
                    ok: true,
                    cmd: [r.cmd, ...inspectArgs].join(' '),
                    stdout: out.stdout || '',
                    stderr: out.timedOut ? (`(timed out)\n` + (out.stderr || '')) : (out.stderr || ''),
                    exitCode: out.exitCode,
                    json: parsed,
                  };
                  try { _usdInspectCache.set(cacheKey, { mtimeMs, resp: respObj }); } catch { /* ignore */ }
                }

                if (parsed?.ok) {
                  const stats = parsed?.stats || {};
                  const meshCount = Number(stats?.meshCount) || 0;
                  if (meshCount <= 0) {
                    const skelRoot = Number(stats?.skelRootCount) || 0;
                    const skelAnim = Number(stats?.skelAnimationCount) || 0;
                    if (skelAnim <= 0) {
                      throw new Error(`Convert blocked: USD has no Mesh prims (meshCount=0) and no SkelAnimation prims (skelAnim=0). (skelRoot=${skelRoot})`);
                    }
                  }
                }
              }
            } catch (e) {
              // Only hard-block when we positively detect a meshless USD.
              // Other failures should not prevent conversion (keep behavior consistent with client preflight).
              const msg = String(e?.message || e || '');
              if (msg.toLowerCase().includes('convert blocked') || msg.toLowerCase().includes('no mesh prims') || msg.toLowerCase().includes('meshcount=0')) {
                throw e;
              }
            }

            const outBase = safeName(obj?.outName || path.parse(inAbs).name || 'convert');
            const exportFormat = String(obj?.exportFormat || 'GLB').trim() || 'GLB';
            const outExt = (exportFormat === 'GLTF_SEPARATE') ? '.gltf' : '.glb';
            const outAbs = path.join(convertOutRoot, `${outBase}${outExt}`);
            const outRel = toPosix(path.relative(root, outAbs));
            const splitMeshes = !!obj?.splitMeshes;
            const meshesDirAbs = path.join(convertOutRoot, `${outBase}_meshes`);
            const meshesDirRel = toPosix(path.relative(root, meshesDirAbs));

            const scriptAbs = path.join(root, 'tools', 'convert_asset.py');
            const blenderPath = String(obj?.blenderPath || '').trim();
            const args = [
              ...r.baseArgs,
              scriptAbs,
              'to-gltf',
              '--in',
              inAbs,
              '--out',
              outAbs,
              '--export-format',
              exportFormat,
            ];
            if (blenderPath) args.push('--blender', blenderPath);
            if (splitMeshes && exportFormat === 'GLB') {
              args.push('--split-meshes', '--split-out-dir', meshesDirAbs);
            }

            const id = crypto.randomBytes(8).toString('hex');
            const job = {
              id,
              status: 'running',
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              endedAt: '',
              cwd: root,
              cmd: [r.cmd, ...args].join(' '),
              stdout: '',
              stderr: '',
              outGlbRel: outRel,
              outMeshesDirRel: splitMeshes ? meshesDirRel : '',
              outMeshesRel: [],
              outImageRel: '',
              outMp4Rel: '',
              outRigRel: '',
              exitCode: null,
              error: '',
              _proc: null,
            };
            convertJobs.set(id, job);

            const proc = child_process.spawn(r.cmd, args, { cwd: root, env: process.env });
            job._proc = proc;
            proc.stdout.on('data', (d) => {
              job.stdout += String(d);
              if (job.stdout.length > 2_000_000) job.stdout = job.stdout.slice(-2_000_000);
            });
            proc.stderr.on('data', (d) => {
              job.stderr += String(d);
              if (job.stderr.length > 2_000_000) job.stderr = job.stderr.slice(-2_000_000);
            });
            proc.on('close', (code) => {
              job.exitCode = (code == null) ? null : Number(code);
              job.endedAt = new Date().toISOString();
              job.status = (job.exitCode === 0) ? 'done' : 'error';
              if (job.status === 'done' && job.outMeshesDirRel) {
                try {
                  const manAbs = path.join(root, job.outMeshesDirRel, '_meshes.json');
                  if (fs.existsSync(manAbs)) {
                    const raw = fs.readFileSync(manAbs, 'utf-8');
                    const man = JSON.parse(raw || '{}');
                    const files = Array.isArray(man?.files) ? man.files : [];
                    job.outMeshesRel = files
                      .map((p) => toPosix(path.relative(root, String(p || ''))))
                      .filter((p) => p && !p.includes('..'));
                  } else {
                    const dirAbs = path.join(root, job.outMeshesDirRel);
                    if (fs.existsSync(dirAbs) && fs.statSync(dirAbs).isDirectory()) {
                      const out = [];
                      for (const ent of fs.readdirSync(dirAbs, { withFileTypes: true })) {
                        if (!ent || !ent.isFile()) continue;
                        const low = String(ent.name || '').toLowerCase();
                        if (!low.endsWith('.glb')) continue;
                        out.push(toPosix(path.relative(root, path.join(dirAbs, ent.name))));
                      }
                      out.sort();
                      job.outMeshesRel = out;
                    }
                  }
                } catch { /* ignore */ }
              }
              try { job._proc = null; } catch { /* ignore */ }
            });
            proc.on('error', (e) => {
              job.error = String(e?.message || e);
              job.exitCode = -1;
              job.endedAt = new Date().toISOString();
              job.status = 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, id, outGlb: outRel, outMeshesDir: splitMeshes ? meshesDirRel : '' }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_convert_job?id=...
        server.middlewares.use('/__devtools_convert_job', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const id = String(url.searchParams.get('id') || '');
            const job = convertJobs.get(id);
            if (!job) {
              res.statusCode = 404;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: 'job not found' }));
              return;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(jobToJson(job)));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_convert_kill { id }
        server.middlewares.use('/__devtools_convert_kill', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 100_000 });
            const id = String(obj?.id || '');
            const job = convertJobs.get(id);
            if (!job) throw new Error('job not found');
            const proc = job._proc;
            if (proc && typeof proc.kill === 'function') {
              try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              job.status = 'killed';
              job.endedAt = new Date().toISOString();
              job.exitCode = -2;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // ---- Animation retarget: run tools/anim_asset.py retarget ----
        // POST /__devtools_anim_list_motion_files
        // Body:
        //  - motionRoot: folder containing animation files
        // Returns: { files: [projectRelativePath, ...] }
        server.middlewares.use('/__devtools_anim_list_motion_files', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req);
            const rootAbs = resolveProjectFileWithPrefixes(obj?.motionRoot, {
              prefixes: ['assets/animations/', 'assets/external/', 'assets/', 'outputs/', 'repos/', 'tools/out/'],
            });
            if (!rootAbs || !fs.existsSync(rootAbs)) throw new Error('Missing or invalid motionRoot');
            if (!fs.statSync(rootAbs).isDirectory()) throw new Error('motionRoot must be a directory');

            const exts = new Set(['.glb', '.gltf', '.fbx', '.bvh', '.usd', '.usda', '.usdc', '.usdz', '.blend']);
            const files = [];
            // Keep a high safety ceiling, but do not truncate normal pack sets.
            const MAX_FILES = 10000;
            const MAX_DEPTH = 16;

            const walk = (dirAbs, depth) => {
              if (files.length >= MAX_FILES) return;
              if (depth > MAX_DEPTH) return;
              let ents = [];
              try { ents = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
              for (const ent of ents) {
                if (files.length >= MAX_FILES) return;
                const abs = path.join(dirAbs, ent.name);
                if (ent.isDirectory()) {
                  walk(abs, depth + 1);
                  continue;
                }
                if (!ent.isFile()) continue;
                const ext = path.extname(ent.name).toLowerCase();
                if (!exts.has(ext)) continue;
                const rel = toPosix(path.relative(root, abs));
                if (!rel || rel.startsWith('..')) continue;
                files.push(rel);
              }
            };
            walk(rootAbs, 0);
            files.sort((a, b) => a.localeCompare(b));

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, files }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_anim_list_clips
        // Body:
        //  - runner: 'python3' | 'conda_trellis' (optional; default conda_trellis)
        //  - motionPath: assets/... | outputs/... | repos/... (or absolute within repo)
        //  - blenderPath: optional explicit Blender executable path
        // Returns: { clips: [{name,start,end}, ...], stdout, stderr, exitCode }
        server.middlewares.use('/__devtools_anim_list_clips', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req);
            const runner = String(obj?.runner || 'conda_trellis');
            const runnerMap = {
              python3: { cmd: 'python3', baseArgs: [] },
              conda_trellis: { cmd: 'conda', baseArgs: ['run', '-n', 'trellis', 'python3'] },
            };
            const r = runnerMap[runner] || runnerMap.conda_trellis;

            const motionAbs = resolveProjectFileWithPrefixes(obj?.motionPath, { prefixes: ['assets/', 'outputs/', 'repos/', 'tools/out/'] });
            if (!motionAbs || !fs.existsSync(motionAbs)) throw new Error('Missing or invalid motionPath');

            const scriptAbs = path.join(root, 'tools', 'anim_asset.py');
            const blenderPath = String(obj?.blenderPath || '').trim();
            const args = [
              ...r.baseArgs,
              scriptAbs,
              'list-clips',
              '--in',
              motionAbs,
            ];
            if (blenderPath) args.push('--blender', blenderPath);

            const out = await new Promise((resolve) => {
              const proc = child_process.spawn(r.cmd, args, { cwd: root, env: process.env });
              let stdout = '';
              let stderr = '';
              let done = false;
              const finish = (exitCode) => {
                if (done) return;
                done = true;
                resolve({ stdout, stderr, exitCode });
              };
              const t = setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch { /* ignore */ }
                finish(-3);
              }, 60_000);
              proc.stdout.on('data', (d) => {
                stdout += String(d);
                if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000);
              });
              proc.stderr.on('data', (d) => {
                stderr += String(d);
                if (stderr.length > 2_000_000) stderr = stderr.slice(-2_000_000);
              });
              proc.on('close', (code) => {
                try { clearTimeout(t); } catch { /* ignore */ }
                finish((code == null) ? null : Number(code));
              });
              proc.on('error', (e) => {
                try { clearTimeout(t); } catch { /* ignore */ }
                stderr += `\n(proc error) ${String(e?.message || e)}`;
                finish(-1);
              });
            });

            const clips = [];
            const lines = String(out.stdout || '').split(/\r?\n/);
            for (const line of lines) {
              const m = String(line || '').match(/^\s*-\s+(.+?)(?:\s+\[(\d+)\.\.(\d+)\])?\s*$/);
              if (!m) continue;
              const name = String(m[1] || '').trim();
              if (!name) continue;
              const start = (m[2] != null) ? Number(m[2]) : null;
              const end = (m[3] != null) ? Number(m[3]) : null;
              clips.push({
                name,
                start: Number.isFinite(start) ? start : null,
                end: Number.isFinite(end) ? end : null,
              });
            }

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, clips, stdout: out.stdout || '', stderr: out.stderr || '', exitCode: out.exitCode }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_anim_validate_map
        // Body:
        //  - runner: 'python3' | 'conda_trellis' (optional; default conda_trellis)
        //  - rigPath: assets/... | outputs/... | repos/... (or absolute within repo)
        //  - motionPath: assets/... | outputs/... | repos/... (or absolute within repo)
        //  - mapPath: tools/rigging/mappings/...json (or absolute within repo)
        //  - blenderPath: optional explicit Blender executable path
        // Returns: { ok, stdout, stderr, exitCode }
        server.middlewares.use('/__devtools_anim_validate_map', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req);
            const runner = String(obj?.runner || 'conda_trellis');
            const runnerMap = {
              python3: { cmd: 'python3', baseArgs: [] },
              conda_trellis: { cmd: 'conda', baseArgs: ['run', '-n', 'trellis', 'python3'] },
            };
            const r = runnerMap[runner] || runnerMap.conda_trellis;

            const rigAbs = resolveProjectFileWithPrefixes(obj?.rigPath, { prefixes: ['assets/', 'outputs/', 'repos/', 'tools/out/'] });
            if (!rigAbs || !fs.existsSync(rigAbs)) throw new Error('Missing or invalid rigPath');

            const motionAbs = resolveProjectFileWithPrefixes(obj?.motionPath, { prefixes: ['assets/', 'outputs/', 'repos/', 'tools/out/'] });
            if (!motionAbs || !fs.existsSync(motionAbs)) throw new Error('Missing or invalid motionPath');

            // Allow either tools/rigging/mappings/* or a project-relative absolute path.
            const mapAbs = resolveProjectFileWithPrefixes(obj?.mapPath, { prefixes: ['tools/rigging/mappings/', 'tools/', 'assets/', 'outputs/', 'repos/'] });
            if (!mapAbs || !fs.existsSync(mapAbs)) throw new Error('Missing or invalid mapPath');

            const scriptAbs = path.join(root, 'tools', 'anim_asset.py');
            const blenderPath = String(obj?.blenderPath || '').trim();
            const args = [
              ...r.baseArgs,
              scriptAbs,
              'validate-map',
              '--rig',
              rigAbs,
              '--motion',
              motionAbs,
              '--map',
              mapAbs,
            ];
            if (blenderPath) args.push('--blender', blenderPath);

            const out = await new Promise((resolve) => {
              const proc = child_process.spawn(r.cmd, args, { cwd: root, env: process.env });
              let stdout = '';
              let stderr = '';
              let done = false;
              const finish = (exitCode) => {
                if (done) return;
                done = true;
                resolve({ stdout, stderr, exitCode });
              };
              const t = setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch { /* ignore */ }
                finish(-3);
              }, 60_000);
              proc.stdout.on('data', (d) => {
                stdout += String(d);
                if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000);
              });
              proc.stderr.on('data', (d) => {
                stderr += String(d);
                if (stderr.length > 2_000_000) stderr = stderr.slice(-2_000_000);
              });
              proc.on('close', (code) => {
                try { clearTimeout(t); } catch { /* ignore */ }
                finish((code == null) ? null : Number(code));
              });
              proc.on('error', (e) => {
                try { clearTimeout(t); } catch { /* ignore */ }
                stderr += `\n(proc error) ${String(e?.message || e)}`;
                finish(-1);
              });
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, stdout: out.stdout || '', stderr: out.stderr || '', exitCode: out.exitCode }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_anim_retarget_start
        // Body:
        //  - runner: 'python3' | 'conda_trellis' (optional; default conda_trellis)
        //  - rigPath: assets/... | outputs/... | repos/... (or absolute within repo)
        //  - motionPath: assets/... | outputs/... | repos/... (or absolute within repo)
        //  - mapPath: tools/rigging/mappings/...json (or absolute within repo)
        //  - clipName, fps, start, end, rootMotion, includeMesh, exportFormat
        //  - blenderPath: optional explicit Blender executable path
        //  - outName (optional)
        server.middlewares.use('/__devtools_anim_retarget_start', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req);
            ensureAnimDirs();

            const runner = String(obj?.runner || 'conda_trellis');
            const runnerMap = {
              python3: { cmd: 'python3', baseArgs: [] },
              conda_trellis: { cmd: 'conda', baseArgs: ['run', '-n', 'trellis', 'python3'] },
            };
            const r = runnerMap[runner] || runnerMap.conda_trellis;

            const rigAbs = resolveProjectFileWithPrefixes(obj?.rigPath, { prefixes: ['assets/', 'outputs/', 'repos/', 'tools/out/'] });
            // DevTools convention: source motion lives in outputs/ (scratch) or assets/animations/ (canonical),
            // but we also commonly inspect/retarget Omniverse/NVIDIA sample assets under assets/external/.
            const motionAbs = resolveProjectFileWithPrefixes(obj?.motionPath, {
              prefixes: ['assets/animations/', 'assets/external/', 'assets/', 'outputs/', 'repos/', 'tools/out/'],
            });
            const mapAbs = resolveProjectFileWithPrefixes(obj?.mapPath, { prefixes: ['tools/rigging/mappings/'] });
            if (!rigAbs || !fs.existsSync(rigAbs)) throw new Error('Missing or invalid rigPath');
            if (!motionAbs || !fs.existsSync(motionAbs)) throw new Error('Missing or invalid motionPath');
            if (!mapAbs || !fs.existsSync(mapAbs)) throw new Error('Missing or invalid mapPath');

            const outBase = safeName(obj?.outName || 'anim');
            const outAbs = path.join(animOutRoot, `${outBase}.glb`);
            const outRel = toPosix(path.relative(root, outAbs));

            const scriptAbs = path.join(root, 'tools', 'anim_asset.py');
            const blenderPath = String(obj?.blenderPath || '').trim();
            const args = [
              ...r.baseArgs,
              scriptAbs,
              'retarget',
              '--rig',
              rigAbs,
              '--motion',
              motionAbs,
              '--map',
              mapAbs,
              '--out',
              outAbs,
            ];
            if (blenderPath) args.push('--blender', blenderPath);

            const motionClip = String(obj?.motionClip || '').trim();
            if (motionClip) args.push('--motion-clip', motionClip);

            const clipName = String(obj?.clipName || '').trim();
            if (clipName) args.push('--clip-name', clipName);
            const exportFormat = String(obj?.exportFormat || '').trim();
            if (exportFormat) args.push('--export-format', exportFormat);
            if (Number(obj?.rootMotion || 0)) args.push('--root-motion');
            if (Number(obj?.includeMesh || 0)) args.push('--include-mesh');

            const id = crypto.randomBytes(8).toString('hex');
            const job = {
              id,
              status: 'running',
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              endedAt: '',
              cwd: root,
              cmd: [r.cmd, ...args].join(' '),
              stdout: '',
              stderr: '',
              outGlbRel: outRel,
              outImageRel: '',
              outMp4Rel: '',
              outRigRel: '',
              exitCode: null,
              error: '',
              _proc: null,
            };
            animJobs.set(id, job);

            const proc = child_process.spawn(r.cmd, args, { cwd: root, env: process.env });
            job._proc = proc;
            proc.stdout.on('data', (d) => {
              job.stdout += String(d);
              if (job.stdout.length > 2_000_000) job.stdout = job.stdout.slice(-2_000_000);
            });
            proc.stderr.on('data', (d) => {
              job.stderr += String(d);
              if (job.stderr.length > 2_000_000) job.stderr = job.stderr.slice(-2_000_000);
            });
            proc.on('close', (code) => {
              job.exitCode = (code == null) ? null : Number(code);
              job.endedAt = new Date().toISOString();
              job.status = (job.exitCode === 0) ? 'done' : 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });
            proc.on('error', (e) => {
              job.error = String(e?.message || e);
              job.exitCode = -1;
              job.endedAt = new Date().toISOString();
              job.status = 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, id, outGlb: outRel }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_anim_locomotion_pack_start
        // Body:
        //  - runner: 'python3' | 'conda_trellis' (optional; default conda_trellis)
        //  - rigPath: assets/... | outputs/... | repos/... (or absolute within repo)
        //  - mapPath: tools/rigging/mappings/...json (or absolute within repo)
        //  - clips: [{ clipName, motionPath, motionClip?, start?, end?, fps?, rootMotion? }, ...]
        //  - blenderPath: optional explicit Blender executable path
        //  - exportFormat: 'GLB' | 'GLTF_SEPARATE'
        //  - includeMesh: 1/0
        //  - outName: optional (output file stem under assets/animations/)
        server.middlewares.use('/__devtools_anim_locomotion_pack_start', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req);
            ensureAnimDirs();

            const runner = String(obj?.runner || 'conda_trellis');
            const runnerMap = {
              python3: { cmd: 'python3', baseArgs: [] },
              conda_trellis: { cmd: 'conda', baseArgs: ['run', '-n', 'trellis', 'python3'] },
            };
            const r = runnerMap[runner] || runnerMap.conda_trellis;

            const rigAbs = resolveProjectFileWithPrefixes(obj?.rigPath, { prefixes: ['assets/', 'outputs/', 'repos/', 'tools/out/'] });
            const mapAbs = resolveProjectFileWithPrefixes(obj?.mapPath, { prefixes: ['tools/rigging/mappings/'] });
            if (!rigAbs || !fs.existsSync(rigAbs)) throw new Error('Missing or invalid rigPath');
            if (!mapAbs || !fs.existsSync(mapAbs)) throw new Error('Missing or invalid mapPath');

            const clipsIn = Array.isArray(obj?.clips) ? obj.clips : [];
            if (!clipsIn.length) throw new Error('Missing clips[]');

            // Resolve motion paths inside clip spec.
            const clips = clipsIn.map((c) => {
              const clipName = String(c?.clipName || c?.name || '').trim().replace(/^@+/, '');
              const motionPath = String(c?.motionPath || c?.motion || '').trim();
              const motionAbs = resolveProjectFileWithPrefixes(motionPath, {
                prefixes: ['assets/animations/', 'assets/external/', 'assets/', 'outputs/', 'repos/', 'tools/out/'],
              });
              if (!clipName) throw new Error('clips[].clipName is required');
              if (!motionAbs || !fs.existsSync(motionAbs)) throw new Error(`Missing or invalid clips[].motionPath for ${clipName}`);
              return {
                clipName,
                motionPath: motionAbs,
                motionClip: String(c?.motionClip || '').trim().replace(/^@+/, ''),
                start: (c?.start == null || c?.start === '') ? null : c.start,
                end: (c?.end == null || c?.end === '') ? null : c.end,
                fps: (c?.fps == null || c?.fps === '') ? null : c.fps,
                rootMotion: (Number(c?.rootMotion || 0) ? 1 : 0),
              };
            });

            // Persist clip spec to a file (avoid huge argv; makes jobs reproducible).
            const locoWorkRoot = path.join(root, 'tools', 'out', 'locomotion_packs');
            try { fs.mkdirSync(locoWorkRoot, { recursive: true }); } catch { /* ignore */ }
            const id = crypto.randomBytes(8).toString('hex');
            const clipsAbs = path.join(locoWorkRoot, `locomotion_pack_${id}.json`);
            fs.writeFileSync(clipsAbs, JSON.stringify({ clips }, null, 2), 'utf-8');

            const outBase = safeName(obj?.outName || `locomotion_pack_${safeStamp()}`);
            const outAbs = path.join(animOutRoot, `${outBase}.glb`);
            const outRel = toPosix(path.relative(root, outAbs));

            const scriptAbs = path.join(root, 'tools', 'anim_asset.py');
            const blenderPath = String(obj?.blenderPath || '').trim();
            const exportFormat = String(obj?.exportFormat || 'GLB').trim();
            const includeMesh = Number(obj?.includeMesh ?? 1) ? 1 : 0;

            const args = [
              ...r.baseArgs,
              scriptAbs,
              'locomotion-pack',
              '--rig',
              rigAbs,
              '--map',
              mapAbs,
              '--clips-json',
              clipsAbs,
              '--out',
              outAbs,
              '--export-format',
              exportFormat,
              ...(includeMesh ? ['--include-mesh'] : []),
            ];
            if (blenderPath) args.push('--blender', blenderPath);

            const job = {
              id,
              status: 'running',
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              endedAt: '',
              cwd: root,
              cmd: [r.cmd, ...args].join(' '),
              stdout: '',
              stderr: '',
              outGlbRel: outRel,
              outImageRel: '',
              outMp4Rel: '',
              outRigRel: '',
              exitCode: null,
              error: '',
              _proc: null,
            };
            animJobs.set(id, job);

            const proc = child_process.spawn(r.cmd, args, { cwd: root, env: process.env });
            job._proc = proc;
            proc.stdout.on('data', (d) => {
              job.stdout += String(d);
              if (job.stdout.length > 2_000_000) job.stdout = job.stdout.slice(-2_000_000);
            });
            proc.stderr.on('data', (d) => {
              job.stderr += String(d);
              if (job.stderr.length > 2_000_000) job.stderr = job.stderr.slice(-2_000_000);
            });
            proc.on('close', (code) => {
              job.exitCode = (code == null) ? null : Number(code);
              job.endedAt = new Date().toISOString();
              job.status = (job.exitCode === 0) ? 'done' : 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });
            proc.on('error', (e) => {
              job.error = String(e?.message || e);
              job.exitCode = -1;
              job.endedAt = new Date().toISOString();
              job.status = 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, id, outGlb: outRel }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // ---- Animation inspection: list clips / print bones (AnimGraph-friendly) ----
        // POST /__devtools_anim_inspect
        // Body:
        //  - runner: 'python3' | 'conda_trellis' (optional; default conda_trellis)
        //  - inputPath: assets/... | outputs/... | repos/... (or absolute within repo)
        //  - mode: 'list-clips' | 'print-bones'
        //  - blenderPath: optional explicit Blender executable path
        server.middlewares.use('/__devtools_anim_inspect', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req, { maxBytes: 200_000 });
            const runner = String(obj?.runner || 'conda_trellis');
            const runnerMap = {
              python3: { cmd: 'python3', baseArgs: [] },
              conda_trellis: { cmd: 'conda', baseArgs: ['run', '-n', 'trellis', 'python3'] },
            };
            const r = runnerMap[runner] || runnerMap.conda_trellis;

            const inputAbs = resolveProjectFileWithPrefixes(obj?.inputPath, {
              prefixes: ['assets/animations/', 'assets/external/', 'assets/', 'outputs/', 'repos/', 'tools/out/'],
            });
            if (!inputAbs || !fs.existsSync(inputAbs)) throw new Error('Missing or invalid inputPath');

            const modeRaw = String(obj?.mode || 'list-clips').trim();
            const mode = (modeRaw === 'print-bones') ? 'print-bones' : 'list-clips';
            const blenderPath = String(obj?.blenderPath || '').trim();

            const scriptAbs = path.join(root, 'tools', 'anim_asset.py');
            const args = [
              ...r.baseArgs,
              scriptAbs,
              mode,
              '--in',
              inputAbs,
              ...(blenderPath ? ['--blender', blenderPath] : []),
            ];

            const job = { stdout: '', stderr: '', exitCode: null, cmd: [r.cmd, ...args].join(' ') };
            const proc = child_process.spawn(r.cmd, args, { cwd: root, env: process.env });
            proc.stdout.on('data', (d) => {
              job.stdout += String(d);
              if (job.stdout.length > 2_000_000) job.stdout = job.stdout.slice(-2_000_000);
            });
            proc.stderr.on('data', (d) => {
              job.stderr += String(d);
              if (job.stderr.length > 2_000_000) job.stderr = job.stderr.slice(-2_000_000);
            });

            const done = await new Promise((resolve) => {
              const t = setTimeout(() => {
                try { proc.kill('SIGTERM'); } catch { /* ignore */ }
                resolve({ exitCode: -3, timedOut: true });
              }, 60_000);
              proc.on('close', (code) => {
                clearTimeout(t);
                resolve({ exitCode: (code == null) ? null : Number(code), timedOut: false });
              });
              proc.on('error', () => {
                clearTimeout(t);
                resolve({ exitCode: -1, timedOut: false });
              });
            });
            job.exitCode = done.exitCode;

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({
              ok: true,
              cmd: job.cmd,
              stdout: job.stdout,
              stderr: done.timedOut ? (`(timed out)\n` + job.stderr) : job.stderr,
              exitCode: job.exitCode,
            }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_anim_job?id=...
        server.middlewares.use('/__devtools_anim_job', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const id = String(url.searchParams.get('id') || '');
            const job = animJobs.get(id);
            if (!job) {
              res.statusCode = 404;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: 'job not found' }));
              return;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(jobToJson(job)));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_anim_kill { id }
        server.middlewares.use('/__devtools_anim_kill', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 100_000 });
            const id = String(obj?.id || '');
            const job = animJobs.get(id);
            if (!job) throw new Error('job not found');
            const proc = job._proc;
            if (proc && typeof proc.kill === 'function') {
              try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              job.status = 'killed';
              job.endedAt = new Date().toISOString();
              job.exitCode = -2;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // ---- Outfit: attach clothing meshes to a rigged base GLB ----
        // POST /__devtools_outfit_start
        // Body:
        //  - runner: 'python3' | 'conda_trellis' (optional; default conda_trellis)
        //  - baseRigPath: assets/... | outputs/... | repos/... | tools/out/... (or absolute within repo)
        //  - clothesPaths: string[] (each under assets/outputs/repos/tools/out) OR
        //    clothesPathsText: string (newline or comma-separated)
        //  - outfitArgs: string (extra args appended after tool; optional)
        //  - blenderPath: optional explicit Blender executable path
        //  - outName: optional
        server.middlewares.use('/__devtools_outfit_start', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req);
            ensureOutfitDirs();

            const runner = String(obj?.runner || 'conda_trellis');
            const runnerMap = {
              python3: { cmd: 'python3', baseArgs: [] },
              conda_trellis: { cmd: 'conda', baseArgs: ['run', '-n', 'trellis', 'python3'] },
            };
            const r = runnerMap[runner] || runnerMap.conda_trellis;

            const baseAbs = resolveProjectFileWithPrefixes(obj?.baseRigPath, { prefixes: ['assets/', 'outputs/', 'repos/', 'tools/out/'] });
            if (!baseAbs || !fs.existsSync(baseAbs)) throw new Error('Missing or invalid baseRigPath');

            /** @type {string[]} */
            let clothes = [];
            if (Array.isArray(obj?.clothesPaths)) {
              clothes = obj.clothesPaths.map((x) => String(x || '').trim()).filter(Boolean);
            } else {
              const txt = String(obj?.clothesPathsText || '').trim();
              if (txt) {
                clothes = txt
                  .split(/[\n,]+/g)
                  .map((s) => String(s || '').trim())
                  .filter(Boolean);
              }
            }
            if (!clothes.length) throw new Error('Missing clothesPaths (provide one or more clothing assets)');

            /** @type {string[]} */
            const clothesAbs = [];
            for (const p of clothes) {
              const abs = resolveProjectFileWithPrefixes(p, { prefixes: ['assets/', 'outputs/', 'repos/', 'tools/out/'] });
              if (!abs || !fs.existsSync(abs)) throw new Error(`Invalid clothes path: ${p}`);
              clothesAbs.push(abs);
            }

            const outBase = safeName(obj?.outName || 'outfit');
            const outAbs = path.join(outfitOutRoot, `${outBase}.glb`);
            const outRel = toPosix(path.relative(root, outAbs));

            const scriptAbs = path.join(root, 'tools', 'outfit_asset.py');
            const extra = splitArgs(String(obj?.outfitArgs || '').trim());
            const blenderPath = String(obj?.blenderPath || '').trim();
            const args = [
              ...r.baseArgs,
              scriptAbs,
              '--base',
              baseAbs,
              '--out',
              outAbs,
              ...(blenderPath ? ['--blender', blenderPath] : []),
              ...clothesAbs.flatMap((p) => ['--clothes', p]),
              ...extra,
            ];

            const id = crypto.randomBytes(8).toString('hex');
            const job = {
              id,
              status: 'running',
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              endedAt: '',
              cwd: root,
              cmd: [r.cmd, ...args].join(' '),
              stdout: '',
              stderr: '',
              outGlbRel: outRel,
              outImageRel: '',
              outMp4Rel: '',
              outRigRel: '',
              exitCode: null,
              error: '',
              _proc: null,
            };
            outfitJobs.set(id, job);

            const proc = child_process.spawn(r.cmd, args, { cwd: root, env: process.env });
            job._proc = proc;
            proc.stdout.on('data', (d) => {
              job.stdout += String(d);
              if (job.stdout.length > 2_000_000) job.stdout = job.stdout.slice(-2_000_000);
            });
            proc.stderr.on('data', (d) => {
              job.stderr += String(d);
              if (job.stderr.length > 2_000_000) job.stderr = job.stderr.slice(-2_000_000);
            });
            proc.on('close', (code) => {
              job.exitCode = (code == null) ? null : Number(code);
              job.endedAt = new Date().toISOString();
              job.status = (job.exitCode === 0) ? 'done' : 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });
            proc.on('error', (e) => {
              job.error = String(e?.message || e);
              job.exitCode = -1;
              job.endedAt = new Date().toISOString();
              job.status = 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, id, outGlb: outRel }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_outfit_job?id=...
        server.middlewares.use('/__devtools_outfit_job', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const id = String(url.searchParams.get('id') || '');
            const job = outfitJobs.get(id);
            if (!job) {
              res.statusCode = 404;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: 'job not found' }));
              return;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(jobToJson(job)));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_outfit_kill { id }
        server.middlewares.use('/__devtools_outfit_kill', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 100_000 });
            const id = String(obj?.id || '');
            const job = outfitJobs.get(id);
            if (!job) throw new Error('job not found');
            const proc = job._proc;
            if (proc && typeof proc.kill === 'function') {
              try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              job.status = 'killed';
              job.endedAt = new Date().toISOString();
              job.exitCode = -2;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // ---- Mesh2Motion bridge endpoints (upload + standalone + smoke test) ----
        // POST /__devtools_mesh2motion_upload_asset
        // Body: { fileName, dataUrl } where dataUrl is base64 file content.
        server.middlewares.use('/__devtools_mesh2motion_upload_asset', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 140_000_000 });
            const fileNameRaw = String(obj?.fileName || 'upload.glb').trim();
            const extRaw = String(path.extname(fileNameRaw || '') || '').toLowerCase();
            const allow = new Set(['.glb', '.gltf', '.fbx', '.obj', '.bvh']);
            const ext = allow.has(extRaw) ? extRaw : '.glb';
            const dataUrl = String(obj?.dataUrl || '');
            if (!dataUrl.startsWith('data:')) throw new Error('Missing dataUrl');

            const uploadsRoot = path.join(outputsRoot, 'uploads');
            try { fs.mkdirSync(uploadsRoot, { recursive: true }); } catch { /* ignore */ }
            const outBase = safeName(path.parse(fileNameRaw).name || 'upload');
            const outAbs = path.join(uploadsRoot, `${outBase}${ext}`);
            decodeDataUrlToFile(dataUrl, outAbs);
            const outRel = toPosix(path.relative(root, outAbs));

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, path: outRel }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_mesh2motion_save_asset
        // Body: { fileName, dataUrl, folder? }
        // Writes into assets/ (default: assets/generated/mesh2motion/) and returns { path }.
        server.middlewares.use('/__devtools_mesh2motion_save_asset', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req, { maxBytes: 220_000_000 });
            const fileNameRaw = String(obj?.fileName || 'export.glb').trim();
            const extRaw = String(path.extname(fileNameRaw || '') || '').toLowerCase();
            const allow = new Set(['.glb', '.gltf']);
            const ext = allow.has(extRaw) ? extRaw : '.glb';
            const dataUrl = String(obj?.dataUrl || '');
            if (!dataUrl.startsWith('data:')) throw new Error('Missing dataUrl');

            // Allow a custom folder but restrict to assets/...
            const folderRaw = String(obj?.folder || 'assets/generated/mesh2motion').trim().replace(/\\/g, '/');
            const folderRel = folderRaw.startsWith('assets/') ? folderRaw : 'assets/generated/mesh2motion';
            const folderAbs = path.join(root, folderRel);
            try { fs.mkdirSync(folderAbs, { recursive: true }); } catch { /* ignore */ }

            const stem = safeName(path.parse(fileNameRaw).name || 'export');
            const outAbs = path.join(folderAbs, `${stem}_${safeStamp()}${ext}`);
            decodeDataUrlToFile(dataUrl, outAbs);
            const outRel = toPosix(path.relative(root, outAbs));

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, path: outRel }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_mesh2motion_status
        server.middlewares.use('/__devtools_mesh2motion_status', async (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            // Mesh2Motion is embedded into this Vite server (no separate ports).
            const createUrl = '/mesh2motion/create.html';
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, online: true, port: null, createUrl }));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_mesh2motion_test_start
        server.middlewares.use('/__devtools_mesh2motion_test_start', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            await readJsonBody(req, { maxBytes: 100_000 });

            const id = crypto.randomBytes(8).toString('hex');
            const args = [path.join(root, 'tools', 'mesh2motion_pipeline_test.mjs')];
            const cmd = ['node', ...args].join(' ');
            const job = {
              id,
              status: 'running',
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              endedAt: '',
              cwd: root,
              cmd,
              stdout: '',
              stderr: '',
              outGlbRel: '',
              outImageRel: '',
              outMp4Rel: '',
              outRigRel: '',
              exitCode: null,
              error: '',
              _proc: null,
            };
            mesh2motionTestJobs.set(id, job);

            const proc = child_process.spawn('node', args, { cwd: root, env: process.env });
            job._proc = proc;
            proc.stdout.on('data', (d) => {
              job.stdout += String(d);
              if (job.stdout.length > 2_000_000) job.stdout = job.stdout.slice(-2_000_000);
            });
            proc.stderr.on('data', (d) => {
              job.stderr += String(d);
              if (job.stderr.length > 2_000_000) job.stderr = job.stderr.slice(-2_000_000);
            });
            proc.on('close', (code) => {
              job.exitCode = (code == null) ? null : Number(code);
              job.endedAt = new Date().toISOString();
              job.status = (job.exitCode === 0) ? 'done' : 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });
            proc.on('error', (e) => {
              job.error = String(e?.message || e);
              job.exitCode = -1;
              job.endedAt = new Date().toISOString();
              job.status = 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, id }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_mesh2motion_test_job?id=...
        server.middlewares.use('/__devtools_mesh2motion_test_job', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const id = String(url.searchParams.get('id') || '');
            const job = mesh2motionTestJobs.get(id);
            if (!job) {
              res.statusCode = 404;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: 'job not found' }));
              return;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(jobToJson(job)));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_mesh2motion_test_kill { id }
        server.middlewares.use('/__devtools_mesh2motion_test_kill', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 100_000 });
            const id = String(obj?.id || '');
            const job = mesh2motionTestJobs.get(id);
            if (!job) throw new Error('job not found');
            const proc = job._proc;
            if (proc && typeof proc.kill === 'function') {
              try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              job.status = 'killed';
              job.endedAt = new Date().toISOString();
              job.exitCode = -2;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // ---- Heightmap: convert a mesh into heightmap-u16 ----
        // POST /__devtools_heightmap_start
        // Body:
        //  - runner: 'python3' | 'conda_trellis' (optional; default conda_trellis)
        //  - inMeshPath: assets/... | outputs/... | repos/... | tools/out/... (or absolute within repo)
        //  - grid: number (optional; default 256)
        //  - heightmapArgs: string (extra args appended after tool; optional)
        //  - blenderPath: optional explicit Blender executable path
        //  - outName: optional
        server.middlewares.use('/__devtools_heightmap_start', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req);
            ensureHeightmapDirs();

            const runner = String(obj?.runner || 'conda_trellis');
            const runnerMap = {
              python3: { cmd: 'python3', baseArgs: [] },
              conda_trellis: { cmd: 'conda', baseArgs: ['run', '-n', 'trellis', 'python3'] },
            };
            const r = runnerMap[runner] || runnerMap.conda_trellis;

            const inAbs = resolveProjectFileWithPrefixes(obj?.inMeshPath, { prefixes: ['assets/', 'outputs/', 'repos/', 'tools/out/'] });
            if (!inAbs || !fs.existsSync(inAbs)) throw new Error('Missing or invalid inMeshPath');

            const outBase = safeName(obj?.outName || 'heightmap');
            const outDirAbs = path.join(heightmapOutRoot, outBase);
            const outMetaAbs = path.join(outDirAbs, 'meta.json');
            const outMetaRel = toPosix(path.relative(root, outMetaAbs));

            const grid = Math.max(16, Math.min(4096, Number(obj?.grid || 256) || 256));
            const scriptAbs = path.join(root, 'tools', 'mesh_to_heightmap_u16.py');
            const extra = splitArgs(String(obj?.heightmapArgs || '').trim());
            const blenderPath = String(obj?.blenderPath || '').trim();
            const args = [
              ...r.baseArgs,
              scriptAbs,
              '--in',
              inAbs,
              '--out',
              outDirAbs,
              '--grid',
              String(Math.floor(grid)),
              ...(blenderPath ? ['--blender', blenderPath] : []),
              ...extra,
            ];

            const id = crypto.randomBytes(8).toString('hex');
            const job = {
              id,
              status: 'running',
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              endedAt: '',
              cwd: root,
              cmd: [r.cmd, ...args].join(' '),
              stdout: '',
              stderr: '',
              outGlbRel: '',
              outImageRel: '',
              outMp4Rel: '',
              outRigRel: '',
              outMetaRel,
              exitCode: null,
              error: '',
              _proc: null,
            };
            heightmapJobs.set(id, job);

            const proc = child_process.spawn(r.cmd, args, { cwd: root, env: process.env });
            job._proc = proc;
            proc.stdout.on('data', (d) => {
              job.stdout += String(d);
              if (job.stdout.length > 2_000_000) job.stdout = job.stdout.slice(-2_000_000);
            });
            proc.stderr.on('data', (d) => {
              job.stderr += String(d);
              if (job.stderr.length > 2_000_000) job.stderr = job.stderr.slice(-2_000_000);
            });
            proc.on('close', (code) => {
              job.exitCode = (code == null) ? null : Number(code);
              job.endedAt = new Date().toISOString();
              job.status = (job.exitCode === 0) ? 'done' : 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });
            proc.on('error', (e) => {
              job.error = String(e?.message || e);
              job.exitCode = -1;
              job.endedAt = new Date().toISOString();
              job.status = 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, id, outMeta: outMetaRel }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_heightmap_job?id=...
        server.middlewares.use('/__devtools_heightmap_job', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const id = String(url.searchParams.get('id') || '');
            const job = heightmapJobs.get(id);
            if (!job) {
              res.statusCode = 404;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: 'job not found' }));
              return;
            }
            const j = jobToJson(job);
            j.outMeta = job.outMetaRel || '';
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(j));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_heightmap_kill { id }
        server.middlewares.use('/__devtools_heightmap_kill', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 100_000 });
            const id = String(obj?.id || '');
            const job = heightmapJobs.get(id);
            if (!job) throw new Error('job not found');
            const proc = job._proc;
            if (proc && typeof proc.kill === 'function') {
              try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              job.status = 'killed';
              job.endedAt = new Date().toISOString();
              job.exitCode = -2;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // ---- Citygen: generate a full dataset (roads/buildings/etc) and optionally overwrite terrain from mesh ----
        // POST /__devtools_citygen_start
        // Body:
        //  - runner: 'python3' | 'conda_trellis' (optional; default python3)
        //  - datasetId: string (required)
        //  - originLon, originLat, sizeM, grid, maxBuildings, maxTrees, maxProps, tileBuildings, tileChunkM
        //  - updateManifest: 1/0 (default 1)
        //  - manifestPath: optional (default assets/datasets/manifest.json)
        //  - heightmapMeshPath: optional (assets/outputs/repos/tools/out)
        //  - heightmapGrid: optional
        //  - blenderPath: optional
        //  - heightmapArgs: optional string
        server.middlewares.use('/__devtools_citygen_start', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req);
            ensureGeneratedDatasetsDir();

            // Code2Worlds should run in the active devtools Python environment;
            // keep legacy runner values as aliases to python3.
            const runner = 'python3';
            const r = { cmd: 'python3', baseArgs: [] };

            const datasetId = String(obj?.datasetId || '').trim();
            if (!datasetId) throw new Error('Missing datasetId');
            const safeId = datasetId.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'city';

            const outDirAbs = path.join(datasetsGenRoot, safeId);
            const outDirRel = toPosix(path.relative(root, outDirAbs));

            const originLon = Number(obj?.originLon ?? -76.30);
            const originLat = Number(obj?.originLat ?? 36.85);
            const sizeM = Number(obj?.sizeM ?? 2400);
            const grid = Math.max(64, Math.min(2048, Number(obj?.grid ?? 256) || 256));
            const maxBuildings = Math.max(0, Number(obj?.maxBuildings ?? 12000) || 12000);
            const maxTrees = Math.max(0, Number(obj?.maxTrees ?? 25000) || 25000);
            const maxProps = Math.max(0, Number(obj?.maxProps ?? 12000) || 12000);
            const tileBuildings = Number(obj?.tileBuildings || 0) ? 1 : 0;
            const tileChunkM = Number(obj?.tileChunkM ?? 512) || 512;
            const updateManifest = (obj?.updateManifest == null) ? 1 : (Number(obj?.updateManifest || 0) ? 1 : 0);
            const manifestPath = String(obj?.manifestPath || 'assets/datasets/manifest.json').trim() || 'assets/datasets/manifest.json';

            const blenderPath = String(obj?.blenderPath || '').trim();
            const heightmapGrid = Math.max(16, Math.min(4096, Number(obj?.heightmapGrid ?? grid) || grid));
            const heightmapArgs = String(obj?.heightmapArgs || '').trim();

            let heightmapMeshAbs = '';
            const hmRel = String(obj?.heightmapMeshPath || '').trim();
            if (hmRel) {
              const abs = resolveProjectFileWithPrefixes(hmRel, { prefixes: ['assets/', 'outputs/', 'repos/', 'tools/out/'] });
              if (!abs || !fs.existsSync(abs)) throw new Error('Invalid heightmapMeshPath');
              heightmapMeshAbs = abs;
            }

            const scriptAbs = path.join(root, 'tools', 'gen_city_dataset.py');
            const args = [
              ...r.baseArgs,
              scriptAbs,
              '--id',
              safeId,
              '--out',
              outDirAbs,
              '--origin-lon',
              String(originLon),
              '--origin-lat',
              String(originLat),
              '--size-m',
              String(sizeM),
              '--grid',
              String(Math.floor(grid)),
              '--max-buildings',
              String(Math.floor(maxBuildings)),
              '--max-trees',
              String(Math.floor(maxTrees)),
              '--max-props',
              String(Math.floor(maxProps)),
              '--tile-chunk-m',
              String(tileChunkM),
              ...(tileBuildings ? ['--tile-buildings'] : []),
              ...(updateManifest ? ['--update-manifest', '--manifest', path.join(root, manifestPath.replace(/^\/+/, ''))] : []),
              ...(heightmapMeshAbs ? ['--heightmap-mesh', heightmapMeshAbs, '--heightmap-grid', String(Math.floor(heightmapGrid))] : []),
              ...(blenderPath ? ['--blender', blenderPath] : []),
              ...(heightmapArgs ? ['--heightmap-args', heightmapArgs] : []),
            ];

            const id = crypto.randomBytes(8).toString('hex');
            const job = {
              id,
              status: 'running',
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              endedAt: '',
              cwd: root,
              cmd: [r.cmd, ...args].join(' '),
              stdout: '',
              stderr: '',
              outGlbRel: '',
              outImageRel: '',
              outMp4Rel: '',
              outRigRel: '',
              outDirRel,
              datasetId: safeId,
              exitCode: null,
              error: '',
              _proc: null,
            };
            citygenJobs.set(id, job);

            const proc = child_process.spawn(r.cmd, args, { cwd: root, env: process.env });
            job._proc = proc;
            proc.stdout.on('data', (d) => {
              job.stdout += String(d);
              if (job.stdout.length > 2_000_000) job.stdout = job.stdout.slice(-2_000_000);
            });
            proc.stderr.on('data', (d) => {
              job.stderr += String(d);
              if (job.stderr.length > 2_000_000) job.stderr = job.stderr.slice(-2_000_000);
            });
            proc.on('close', (code) => {
              job.exitCode = (code == null) ? null : Number(code);
              job.endedAt = new Date().toISOString();
              job.status = (job.exitCode === 0) ? 'done' : 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });
            proc.on('error', (e) => {
              job.error = String(e?.message || e);
              job.exitCode = -1;
              job.endedAt = new Date().toISOString();
              job.status = 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, id, datasetId: safeId, outDir: outDirRel }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_citygen_job?id=...
        server.middlewares.use('/__devtools_citygen_job', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const id = String(url.searchParams.get('id') || '');
            const job = citygenJobs.get(id);
            if (!job) {
              res.statusCode = 404;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: 'job not found' }));
              return;
            }
            const j = jobToJson(job);
            j.outDir = job.outDirRel || '';
            j.datasetId = job.datasetId || '';
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(j));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_citygen_kill { id }
        server.middlewares.use('/__devtools_citygen_kill', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 100_000 });
            const id = String(obj?.id || '');
            const job = citygenJobs.get(id);
            if (!job) throw new Error('job not found');
            const proc = job._proc;
            if (proc && typeof proc.kill === 'function') {
              try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              job.status = 'killed';
              job.endedAt = new Date().toISOString();
              job.exitCode = -2;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // ---- Assetto Corsa: local install scanning (cars list) ----
        // GET /__devtools_assetto_corsa_cars?root=assetto/assettocorsa
        // Returns a lightweight listing of car folders with basic metadata (kn5/data/glb/meta presence).
        server.middlewares.use('/__devtools_assetto_corsa_cars', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const rootInput = String(url.searchParams.get('root') || '').trim();
            const filter = String(url.searchParams.get('filter') || '').trim().toLowerCase();
            const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit') || '600') || 600));

            const installAbs = rootInput
              ? (resolveLocalOrProjectPath(rootInput, { prefixes: ['assetto/'] }) || null)
              : path.join(root, 'assetto', 'assettocorsa');
            if (!installAbs || !fs.existsSync(installAbs)) throw new Error('Invalid root');

            const carsAbs = path.join(installAbs, 'content', 'cars');
            if (!fs.existsSync(carsAbs)) throw new Error('Missing content/cars under root');
            let carDirs = [];
            try {
              carDirs = fs.readdirSync(carsAbs, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
            } catch {
              carDirs = [];
            }
            carDirs.sort((a, b) => String(a).localeCompare(String(b)));

            const items = [];
            for (const carId of carDirs) {
              if (items.length >= limit) break;
              const low = String(carId || '').toLowerCase();
              if (filter && !low.includes(filter)) continue;

              const carRootAbs = path.join(carsAbs, carId);
              const dataDirAbs = path.join(carRootAbs, 'data');
              const dataAcdAbs = path.join(carRootAbs, 'data.acd');
              const hasDataDir = (() => {
                try { return fs.existsSync(dataDirAbs) && fs.statSync(dataDirAbs).isDirectory(); } catch { return false; }
              })();
              const hasDataAcd = (() => {
                try { return fs.existsSync(dataAcdAbs) && fs.statSync(dataAcdAbs).isFile(); } catch { return false; }
              })();

              /** @type {string[]} */
              let topFiles = [];
              try {
                topFiles = fs.readdirSync(carRootAbs, { withFileTypes: true })
                  .filter((e) => e.isFile())
                  .map((e) => e.name);
              } catch {
                topFiles = [];
              }
              const kn5 = topFiles.filter((n) => String(n).toLowerCase().endsWith('.kn5')).sort();
              const glb = topFiles.filter((n) => {
                const l = String(n).toLowerCase();
                return l.endsWith('.glb') || l.endsWith('.gltf');
              }).sort();
              const meta = topFiles.filter((n) => String(n).toLowerCase().endsWith('.meta.json')).sort();

              // Best-effort picks for convenience.
              const pickModel = (() => {
                const want = [`${carId}.glb`, `${carId}.gltf`].map((s) => String(s).toLowerCase());
                const hit = glb.find((n) => want.includes(String(n).toLowerCase()));
                return hit || (glb[0] || '');
              })();
              const pickMeta = (() => {
                if (!pickModel) return meta[0] || '';
                const want = String(pickModel).replace(/\.(glb|gltf)$/i, '.meta.json').toLowerCase();
                const hit = meta.find((n) => String(n).toLowerCase() === want);
                return hit || (meta[0] || '');
              })();

              const carRootRel = toPosix(path.relative(root, carRootAbs));
              const modelRel = pickModel ? toPosix(path.relative(root, path.join(carRootAbs, pickModel))) : '';
              const metaRel = pickMeta ? toPosix(path.relative(root, path.join(carRootAbs, pickMeta))) : '';

              items.push({
                carId,
                carRootRel,
                hasDataDir,
                hasDataAcd,
                kn5Count: kn5.length,
                glbCount: glb.length,
                metaCount: meta.length,
                modelRel,
                metaRel,
              });
            }

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, root: toPosix(path.relative(root, installAbs)), count: items.length, items }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // ---- Assetto Corsa: local install scanning (tracks list) ----
        // GET /__devtools_assetto_corsa_tracks?root=assetto/assettocorsa
        // Returns a lightweight listing of track folders with basic metadata (kn5/models.ini presence).
        server.middlewares.use('/__devtools_assetto_corsa_tracks', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const rootInput = String(url.searchParams.get('root') || '').trim();
            const filter = String(url.searchParams.get('filter') || '').trim().toLowerCase();
            const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit') || '250') || 250));

            const installAbs = rootInput
              ? (resolveLocalOrProjectPath(rootInput, { prefixes: ['assetto/'] }) || null)
              : path.join(root, 'assetto', 'assettocorsa');
            if (!installAbs || !fs.existsSync(installAbs)) throw new Error('Invalid root');

            const tracksAbs = path.join(installAbs, 'content', 'tracks');
            if (!fs.existsSync(tracksAbs)) throw new Error('Missing content/tracks under root');
            let trackDirs = [];
            try {
              trackDirs = fs.readdirSync(tracksAbs, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
            } catch {
              trackDirs = [];
            }
            trackDirs.sort((a, b) => String(a).localeCompare(String(b)));

            const pickFromModelsIni = (trackRootAbs) => {
              const iniAbs = path.join(trackRootAbs, 'models.ini');
              if (!fs.existsSync(iniAbs)) return '';
              let txt = '';
              try { txt = String(fs.readFileSync(iniAbs, 'utf8') || ''); } catch { txt = ''; }
              const lines = txt.split(/\r?\n/);
              for (const raw of lines) {
                const line = String(raw || '').trim();
                if (!line || line.startsWith(';') || line.startsWith('#')) continue;
                const m = line.match(/^FILE\s*=\s*(.+)$/i);
                if (!m) continue;
                const v = String(m[1] || '').trim().replace(/^"+|"+$/g, '');
                if (!v.toLowerCase().endsWith('.kn5')) continue;
                const kn5Abs = path.join(trackRootAbs, v);
                if (fs.existsSync(kn5Abs)) return v;
              }
              return '';
            };

            const items = [];
            for (const trackName of trackDirs) {
              if (items.length >= limit) break;
              const low = String(trackName || '').toLowerCase();
              if (filter && !low.includes(filter)) continue;

              const trackRootAbs = path.join(tracksAbs, trackName);
              const modelsIniAbs = path.join(trackRootAbs, 'models.ini');
              const modelsIni = (() => {
                try { return fs.existsSync(modelsIniAbs) && fs.statSync(modelsIniAbs).isFile(); } catch { return false; }
              })();

              /** @type {string[]} */
              let topFiles = [];
              try {
                topFiles = fs.readdirSync(trackRootAbs, { withFileTypes: true })
                  .filter((e) => e.isFile())
                  .map((e) => e.name);
              } catch {
                topFiles = [];
              }
              const kn5 = topFiles.filter((n) => String(n).toLowerCase().endsWith('.kn5')).sort();

              const kn5PickRel = (() => {
                const iniPick = pickFromModelsIni(trackRootAbs);
                if (iniPick) return toPosix(path.relative(root, path.join(trackRootAbs, iniPick)));
                // Fall back to largest KN5.
                let best = '';
                let bestSz = -1;
                for (const n of kn5) {
                  const abs = path.join(trackRootAbs, n);
                  let sz = 0;
                  try { sz = Number(fs.statSync(abs).size || 0); } catch { sz = 0; }
                  if (sz > bestSz) { bestSz = sz; best = n; }
                }
                return best ? toPosix(path.relative(root, path.join(trackRootAbs, best))) : '';
              })();

              const trackRootRel = toPosix(path.relative(root, trackRootAbs));
              items.push({
                trackName,
                trackRootRel,
                kn5Count: kn5.length,
                modelsIni,
                kn5PickRel,
              });
            }

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, root: toPosix(path.relative(root, installAbs)), count: items.length, items }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // ---- Assetto Corsa: auto-discover exported track scenarios ----
        // GET /__devtools_assetto_corsa_exported_track_scenarios?limit=250
        // Scans assets/generated/assetto_corsa/tracks/**/**/scene.scenario.json and returns a lightweight listing.
        server.middlewares.use('/__devtools_assetto_corsa_exported_track_scenarios', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit') || '500') || 500));

            const tracksOutAbs = path.join(root, 'assets', 'generated', 'assetto_corsa', 'tracks');
            if (!fs.existsSync(tracksOutAbs)) {
              res.statusCode = 200;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: true, root: 'assets/generated/assetto_corsa/tracks', count: 0, items: [] }));
              return;
            }

            const all = listFilesRecursive(tracksOutAbs, { maxFiles: 30000 });
            const scenarioFiles = [];
            for (const abs of all) {
              const low = String(abs || '').toLowerCase();
              if (low.endsWith(`${path.sep}scene.scenario.json`) || low.endsWith('/scene.scenario.json')) scenarioFiles.push(abs);
            }

            const items = [];
            for (const abs of scenarioFiles) {
              if (items.length >= limit) break;
              const rel = toPosix(path.relative(root, abs));
              // Expected rel:
              // assets/generated/assetto_corsa/tracks/<trackId>/<runId>/scene.scenario.json
              const m = rel.match(/^assets\/generated\/assetto_corsa\/tracks\/([^/]+)\/([^/]+)\/scene\.scenario\.json$/i);
              const trackId = m ? String(m[1] || '').trim() : '';
              const runId = m ? String(m[2] || '').trim() : '';
              let st = null;
              try { st = fs.statSync(abs); } catch { st = null; }
              const mtimeMs = st ? Number(st.mtimeMs || 0) : 0;

              let scenario = null;
              try { scenario = JSON.parse(String(fs.readFileSync(abs, 'utf8') || '')); } catch { scenario = null; }
              const name = scenario && typeof scenario === 'object' ? String(scenario?.name || '') : '';
              const modelPath = scenario && typeof scenario === 'object' ? String(scenario?.path || '') : '';

              const bundleAbs = (trackId && runId)
                ? path.join(root, 'assets', 'generated', 'assetto_corsa', 'tracks', trackId, runId, 'normalized', 'track.bundle.json')
                : '';
              const bundleRel = (bundleAbs && fs.existsSync(bundleAbs))
                ? toPosix(path.relative(root, bundleAbs))
                : '';

              items.push({
                trackId,
                runId,
                scenarioRel: rel,
                name,
                modelPath,
                bundleRel,
                mtimeMs,
              });
            }

            items.sort((a, b) => Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0));
            const out = items.slice(0, limit);

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, root: 'assets/generated/assetto_corsa/tracks', count: out.length, items: out }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // ---- Assetto Corsa: static+runtime bundle export ----
        // POST /__devtools_assetto_corsa_export_start
        server.middlewares.use('/__devtools_assetto_corsa_export_start', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 300_000 });
            ensureAssettoCorsaDirs();

            const scriptAbs = path.join(root, 'tools', 'assetto_corsa_export.py');
            if (!fs.existsSync(scriptAbs)) throw new Error('Missing tools/assetto_corsa_export.py');

            const carRootAbs = resolveLocalOrProjectPath(String(obj?.carRoot || '').trim(), {
              prefixes: ['assets/', 'repos/', 'tools/', 'outputs/', 'assetto/'],
            });
            if (!carRootAbs || !fs.existsSync(carRootAbs)) throw new Error('Invalid carRoot');
            let st = null;
            try { st = fs.statSync(carRootAbs); } catch { st = null; }
            if (!st || !st.isDirectory()) throw new Error('carRoot must be a directory');

            const outRootInput = String(obj?.outRoot || '').trim();
            const outRootAbs = outRootInput
              ? (resolveLocalOrProjectPath(outRootInput, { prefixes: ['assets/', 'outputs/', 'tools/'] }) || null)
              : assettoCorsaOutRoot;
            if (!outRootAbs) throw new Error('Invalid outRoot');

            const runId = safeName(String(obj?.runId || '').trim());
            const runtimeTraceInput = String(obj?.runtimeTrace || '').trim();
            const runtimeTraceAbs = runtimeTraceInput
              ? resolveLocalOrProjectPath(runtimeTraceInput, { prefixes: ['assets/', 'outputs/', 'tools/'] })
              : null;
            if (runtimeTraceInput && !runtimeTraceAbs) throw new Error('Invalid runtimeTrace');
            if (runtimeTraceAbs && !fs.existsSync(runtimeTraceAbs)) throw new Error('runtimeTrace not found');

            const args = [
              scriptAbs,
              '--car-root',
              carRootAbs,
              '--out-root',
              outRootAbs,
              ...(runId ? ['--run-id', runId] : []),
              ...(runtimeTraceAbs ? ['--runtime-trace', runtimeTraceAbs] : []),
              ...(obj?.exportModel ? ['--export-model'] : []),
              ...(obj?.exportAudio ? ['--export-audio'] : []),
            ];

            const id = crypto.randomBytes(8).toString('hex');
            const outPathRel = path.resolve(outRootAbs).startsWith(path.resolve(root) + path.sep)
              ? toPosix(path.relative(root, outRootAbs))
              : outRootAbs;
            const cmdSafe = ['python3', scriptAbs, '--car-root', carRootAbs, '--out-root', outRootAbs]
              .concat(runId ? ['--run-id', runId] : [])
              .concat(runtimeTraceAbs ? ['--runtime-trace', runtimeTraceAbs] : [])
              .concat(obj?.exportModel ? ['--export-model'] : [])
              .concat(obj?.exportAudio ? ['--export-audio'] : [])
              .join(' ');
            const job = {
              id,
              status: 'running',
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              endedAt: '',
              cwd: root,
              cmd: cmdSafe,
              stdout: '',
              stderr: '',
              outPathRel,
              exitCode: null,
              error: '',
              _proc: null,
            };
            assettoCorsaJobs.set(id, job);

            const proc = child_process.spawn('python3', args, { cwd: root, env: process.env });
            job._proc = proc;
            proc.stdout.on('data', (d) => {
              job.stdout += String(d);
              if (job.stdout.length > 2_000_000) job.stdout = job.stdout.slice(-2_000_000);
            });
            proc.stderr.on('data', (d) => {
              job.stderr += String(d);
              if (job.stderr.length > 2_000_000) job.stderr = job.stderr.slice(-2_000_000);
            });
            proc.on('close', (code) => {
              try {
                const m = String(job.stdout || '').match(/ASSETTO_CORSA_EXPORT_RESULT_JSON:({[\s\S]*})/);
                if (m && m[1]) {
                  const parsed = JSON.parse(m[1]);
                  const outDir = String(parsed?.outDir || '').trim();
                  if (outDir) {
                    job.outPathRel = path.resolve(outDir).startsWith(path.resolve(root) + path.sep)
                      ? toPosix(path.relative(root, outDir))
                      : outDir;
                  }
                }
              } catch { /* ignore */ }
              job.exitCode = (code == null) ? null : Number(code);
              job.endedAt = new Date().toISOString();
              job.status = (job.exitCode === 0) ? 'done' : 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });
            proc.on('error', (e) => {
              job.error = String(e?.message || e);
              job.exitCode = -1;
              job.endedAt = new Date().toISOString();
              job.status = 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, id, outPath: outPathRel, cmd: job.cmd }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_assetto_corsa_export_job?id=...
        server.middlewares.use('/__devtools_assetto_corsa_export_job', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const id = String(url.searchParams.get('id') || '');
            const job = assettoCorsaJobs.get(id);
            if (!job) {
              res.statusCode = 404;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: 'job not found' }));
              return;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(jobToJson(job)));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_assetto_corsa_export_kill { id }
        server.middlewares.use('/__devtools_assetto_corsa_export_kill', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 100_000 });
            const id = String(obj?.id || '');
            const job = assettoCorsaJobs.get(id);
            if (!job) throw new Error('job not found');
            const proc = job._proc;
            if (proc && typeof proc.kill === 'function') {
              try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              job.status = 'killed';
              job.endedAt = new Date().toISOString();
              job.exitCode = -2;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // ---- Assetto Corsa: track KN5 -> GLB + SceneTool scenario ----
        // POST /__devtools_assetto_corsa_track_export_start
        server.middlewares.use('/__devtools_assetto_corsa_track_export_start', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 250_000 });

            const scriptAbs = path.join(root, 'tools', 'assetto_corsa_track_export.py');
            if (!fs.existsSync(scriptAbs)) throw new Error('Missing tools/assetto_corsa_track_export.py');

            const trackRootAbs = resolveLocalOrProjectPath(String(obj?.trackRoot || '').trim(), {
              prefixes: ['assets/', 'repos/', 'tools/', 'outputs/', 'assetto/'],
            });
            if (!trackRootAbs || !fs.existsSync(trackRootAbs)) throw new Error('Invalid trackRoot');
            let st = null;
            try { st = fs.statSync(trackRootAbs); } catch { st = null; }
            if (!st || !st.isDirectory()) throw new Error('trackRoot must be a directory');

            const outRootInput = String(obj?.outRoot || '').trim();
            const outRootAbs = outRootInput
              ? (resolveLocalOrProjectPath(outRootInput, { prefixes: ['assets/', 'outputs/', 'tools/'] }) || null)
              : path.join(assettoCorsaOutRoot, 'tracks');
            if (!outRootAbs) throw new Error('Invalid outRoot');
            try { fs.mkdirSync(outRootAbs, { recursive: true }); } catch { /* ignore */ }

            const runId = safeName(String(obj?.runId || '').trim());
            const args = [
              scriptAbs,
              '--track-root',
              trackRootAbs,
              '--out-root',
              outRootAbs,
              ...(runId ? ['--run-id', runId] : []),
            ];

            const id = crypto.randomBytes(8).toString('hex');
            const outPathRel = path.resolve(outRootAbs).startsWith(path.resolve(root) + path.sep)
              ? toPosix(path.relative(root, outRootAbs))
              : outRootAbs;
            const cmdSafe = ['python3', scriptAbs, '--track-root', trackRootAbs, '--out-root', outRootAbs]
              .concat(runId ? ['--run-id', runId] : [])
              .join(' ');
            const job = {
              id,
              status: 'running',
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              endedAt: '',
              cwd: root,
              cmd: cmdSafe,
              stdout: '',
              stderr: '',
              outPathRel,
              exitCode: null,
              error: '',
              _proc: null,
            };
            assettoCorsaTrackJobs.set(id, job);

            const proc = child_process.spawn('python3', args, { cwd: root, env: process.env });
            job._proc = proc;
            proc.stdout.on('data', (d) => {
              job.stdout += String(d);
              if (job.stdout.length > 2_000_000) job.stdout = job.stdout.slice(-2_000_000);
            });
            proc.stderr.on('data', (d) => {
              job.stderr += String(d);
              if (job.stderr.length > 2_000_000) job.stderr = job.stderr.slice(-2_000_000);
            });
            proc.on('close', (code) => {
              try {
                const m = String(job.stdout || '').match(/ASSETTO_CORSA_TRACK_EXPORT_RESULT_JSON:({[\s\S]*})/);
                if (m && m[1]) {
                  const parsed = JSON.parse(m[1]);
                  const outDir = String(parsed?.outDir || '').trim();
                  if (outDir) {
                    job.outPathRel = path.resolve(outDir).startsWith(path.resolve(root) + path.sep)
                      ? toPosix(path.relative(root, outDir))
                      : outDir;
                  }
                }
              } catch { /* ignore */ }
              job.exitCode = (code == null) ? null : Number(code);
              job.endedAt = new Date().toISOString();
              job.status = (job.exitCode === 0) ? 'done' : 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });
            proc.on('error', (e) => {
              job.error = String(e?.message || e);
              job.exitCode = -1;
              job.endedAt = new Date().toISOString();
              job.status = 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, id, outPath: outPathRel, cmd: job.cmd }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_assetto_corsa_track_export_job?id=...
        server.middlewares.use('/__devtools_assetto_corsa_track_export_job', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const id = String(url.searchParams.get('id') || '');
            const job = assettoCorsaTrackJobs.get(id);
            if (!job) {
              res.statusCode = 404;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: 'job not found' }));
              return;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(jobToJson(job)));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_assetto_corsa_track_export_kill { id }
        server.middlewares.use('/__devtools_assetto_corsa_track_export_kill', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 100_000 });
            const id = String(obj?.id || '');
            const job = assettoCorsaTrackJobs.get(id);
            if (!job) throw new Error('job not found');
            const proc = job._proc;
            if (proc && typeof proc.kill === 'function') {
              try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              job.status = 'killed';
              job.endedAt = new Date().toISOString();
              job.exitCode = -2;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // ---- Code2Worlds: local-model world generation + optional Infinigen render ----
        // POST /__devtools_code2worlds_env_check
        server.middlewares.use('/__devtools_code2worlds_env_check', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 200_000 });

            const runner = String(obj?.runner || 'python3');
            const runnerMap = {
              python3: { cmd: 'python3', baseArgs: [] },
              conda_trellis: { cmd: 'conda', baseArgs: ['run', '-n', 'trellis', 'python3'] },
            };
            const r = runnerMap[runner] || runnerMap.python3;

            const c2wAbs = resolveProjectFileWithPrefixes(
              String(obj?.code2worldsRoot || 'repos/Code2Worlds').trim(),
              { prefixes: ['repos/'] },
            );
            const infAbs = resolveProjectFileWithPrefixes(
              String(obj?.infinigenRoot || 'repos/infinigen').trim(),
              { prefixes: ['repos/'] },
            );
            const checks = {
              code2worldsRoot: !!(c2wAbs && fs.existsSync(c2wAbs)),
              infinigenRoot: !!(infAbs && fs.existsSync(infAbs)),
              bridgeScript: fs.existsSync(path.join(root, 'tools', 'code2worlds_generate_world.py')),
              blender: false,
              localLlmRuntime: false,
              infinigenImport: false,
              infinigenGenerateNatureHelp: false,
            };

            const pyProbe = [
              ...r.baseArgs,
              '-c',
              [
                'import importlib.util',
                'mods=["transformers","torch","json","infinigen"]',
                'ok={m:bool(importlib.util.find_spec(m)) for m in mods}',
                'print(ok)',
              ].join(';'),
            ];
            const probeEnv = { ...process.env };
            if (infAbs && fs.existsSync(infAbs)) {
              const pyPath = String(infAbs);
              probeEnv.PYTHONPATH = probeEnv.PYTHONPATH ? `${pyPath}${path.delimiter}${probeEnv.PYTHONPATH}` : pyPath;
            }
            const p = child_process.spawnSync(r.cmd, pyProbe, {
              cwd: root,
              env: probeEnv,
              timeout: 30_000,
              encoding: 'utf8',
            });
            const exitCode = (p.status == null) ? -1 : Number(p.status);
            const stdout = String(p.stdout || '').trim();
            const stderr = String(p.stderr || '').trim();
            const hasTransformers = /\btransformers['"]?:\s*True\b/.test(stdout) || /'transformers': True/.test(stdout) || /"transformers": true/i.test(stdout);
            const hasTorch = /\btorch['"]?:\s*True\b/.test(stdout) || /'torch': True/.test(stdout) || /"torch": true/i.test(stdout);
            checks.localLlmRuntime = hasTransformers && hasTorch;
            checks.infinigenImport = /\binfinigen['"]?:\s*True\b/.test(stdout) || /'infinigen': True/.test(stdout) || /"infinigen": true/i.test(stdout);

            const blenderPath = String(obj?.blenderPath || '').trim();
            const blenderExe = blenderPath || 'blender';
            const b = child_process.spawnSync(blenderExe, ['--version'], {
              cwd: root,
              env: process.env,
              timeout: 15_000,
              encoding: 'utf8',
            });
            checks.blender = Number(b.status || 0) === 0;

            const gn = child_process.spawnSync(r.cmd, [...r.baseArgs, '-m', 'infinigen_examples.generate_nature', '--help'], {
              cwd: root,
              env: probeEnv,
              timeout: 30_000,
              encoding: 'utf8',
            });
            checks.infinigenGenerateNatureHelp = Number(gn.status || 0) === 0;

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({
              ok: true,
              runner,
              checks,
              exitCode,
              stdout,
              stderr,
              blenderStdout: String(b.stdout || '').trim(),
              blenderStderr: String(b.stderr || '').trim(),
              generateNatureHelpStdout: String(gn.stdout || '').trim(),
              generateNatureHelpStderr: String(gn.stderr || '').trim(),
              code2worldsRoot: c2wAbs ? toPosix(path.relative(root, c2wAbs)) : '',
              infinigenRoot: infAbs ? toPosix(path.relative(root, infAbs)) : '',
            }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_code2worlds_start
        server.middlewares.use('/__devtools_code2worlds_start', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();

            const obj = await readJsonBody(req, { maxBytes: 300_000 });
            ensureCode2WorldsDirs();

            const prompt = String(obj?.prompt || '').trim();
            if (!prompt) throw new Error('Missing prompt');
            const modelName = String(obj?.modelName || 'meta-llama/Llama-3.2-3B-Instruct').trim();
            if (!modelName) throw new Error('Missing modelName');

            const code2worldsRootAbs = resolveProjectFileWithPrefixes(
              String(obj?.code2worldsRoot || 'repos/Code2Worlds').trim(),
              { prefixes: ['repos/'] },
            );
            if (!code2worldsRootAbs || !fs.existsSync(code2worldsRootAbs)) throw new Error('Invalid code2worldsRoot');

            const infinigenRootAbs = resolveProjectFileWithPrefixes(
              String(obj?.infinigenRoot || 'repos/infinigen').trim(),
              { prefixes: ['repos/'] },
            );
            if (!infinigenRootAbs || !fs.existsSync(infinigenRootAbs)) throw new Error('Invalid infinigenRoot');

            // Code2Worlds should run in the active devtools Python environment;
            // keep legacy runner values as aliases to python3.
            const runner = 'python3';
            const r = { cmd: 'python3', baseArgs: [] };

            const outName = safeName(obj?.outName || 'world');
            const workDirAbs = path.join(code2worldsWorkRoot, outName);
            const outputDirAbs = path.join(code2worldsOutRoot, outName);
            try { fs.mkdirSync(workDirAbs, { recursive: true }); } catch { /* ignore */ }
            try { fs.mkdirSync(outputDirAbs, { recursive: true }); } catch { /* ignore */ }

            const scriptAbs = path.join(root, 'tools', 'code2worlds_generate_world.py');
            if (!fs.existsSync(scriptAbs)) throw new Error('Missing tools/code2worlds_generate_world.py');

            const runRender = Number(obj?.runRender || 0) ? 1 : 0;
            const seed = Number(obj?.seed ?? 0) || 0;
            const baseUrl = String(obj?.baseUrl || '').trim();
            const cacheDir = String(obj?.cacheDir || '/data/checkpoints/').trim();
            const blenderPath = String(obj?.blenderPath || '').trim();

            const args = [
              ...r.baseArgs,
              scriptAbs,
              '--prompt',
              prompt,
              '--model-name',
              modelName,
              '--cache-dir',
              cacheDir,
              '--code2worlds-root',
              code2worldsRootAbs,
              '--infinigen-root',
              infinigenRootAbs,
              '--out-name',
              outName,
              '--work-dir',
              workDirAbs,
              '--output-dir',
              outputDirAbs,
              '--seed',
              String(seed),
              ...(runRender ? ['--run-render'] : []),
              ...(baseUrl ? ['--base-url', baseUrl] : []),
              ...(blenderPath ? ['--blender-path', blenderPath] : []),
            ];

            const id = crypto.randomBytes(8).toString('hex');
            const outPathRel = toPosix(path.relative(root, outputDirAbs));
            const cmdSafe = [
              r.cmd,
              ...r.baseArgs,
              scriptAbs,
              '--prompt',
              '[redacted]',
              '--model-name',
              modelName,
              '--cache-dir',
              cacheDir,
              '--code2worlds-root',
              code2worldsRootAbs,
              '--infinigen-root',
              infinigenRootAbs,
              '--out-name',
              outName,
              '--work-dir',
              workDirAbs,
              '--output-dir',
              outputDirAbs,
              '--seed',
              String(seed),
              ...(runRender ? ['--run-render'] : []),
              ...(baseUrl ? ['--base-url', baseUrl] : []),
              ...(blenderPath ? ['--blender-path', blenderPath] : []),
            ].join(' ');
            const job = {
              id,
              status: 'running',
              createdAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              endedAt: '',
              cwd: root,
              cmd: cmdSafe,
              stdout: '',
              stderr: '',
              outGlbRel: '',
              outVxzRel: '',
              outPathRel,
              outImageRel: '',
              outMp4Rel: '',
              outRigRel: '',
              exitCode: null,
              error: '',
              _proc: null,
            };
            code2worldsJobs.set(id, job);

            const proc = child_process.spawn(r.cmd, args, { cwd: root, env: process.env });
            job._proc = proc;
            proc.stdout.on('data', (d) => {
              job.stdout += String(d);
              if (job.stdout.length > 2_000_000) job.stdout = job.stdout.slice(-2_000_000);
            });
            proc.stderr.on('data', (d) => {
              job.stderr += String(d);
              if (job.stderr.length > 2_000_000) job.stderr = job.stderr.slice(-2_000_000);
            });
            proc.on('close', (code) => {
              try {
                const m = String(job.stdout || '').match(/CODE2WORLDS_RESULT_JSON:({[\s\S]*})/);
                if (m && m[1]) {
                  const parsed = JSON.parse(m[1]);
                  const sceneUrl = String(parsed?.sceneSourceUrl || '').trim();
                  if (sceneUrl) job.outGlbRel = sceneUrl;
                  const outPath = String(parsed?.renderOutPath || '').trim();
                  if (outPath) job.outPathRel = outPath;
                }
              } catch { /* ignore */ }
              job.exitCode = (code == null) ? null : Number(code);
              job.endedAt = new Date().toISOString();
              job.status = (job.exitCode === 0) ? 'done' : 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });
            proc.on('error', (e) => {
              job.error = String(e?.message || e);
              job.exitCode = -1;
              job.endedAt = new Date().toISOString();
              job.status = 'error';
              try { job._proc = null; } catch { /* ignore */ }
            });

            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true, id, outPath: outPathRel, cmd: job.cmd }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // GET /__devtools_code2worlds_job?id=...
        server.middlewares.use('/__devtools_code2worlds_job', (req, res, next) => {
          try {
            if (req.method !== 'GET') return next();
            const url = new URL(req.url, 'http://127.0.0.1');
            const id = String(url.searchParams.get('id') || '');
            const job = code2worldsJobs.get(id);
            if (!job) {
              res.statusCode = 404;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: 'job not found' }));
              return;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(jobToJson(job)));
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });

        // POST /__devtools_code2worlds_kill { id }
        server.middlewares.use('/__devtools_code2worlds_kill', async (req, res, next) => {
          try {
            if (req.method === 'OPTIONS') {
              res.statusCode = 204;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
              res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
              res.end();
              return;
            }
            if (req.method !== 'POST') return next();
            const obj = await readJsonBody(req, { maxBytes: 100_000 });
            const id = String(obj?.id || '');
            const job = code2worldsJobs.get(id);
            if (!job) throw new Error('job not found');
            const proc = job._proc;
            if (proc && typeof proc.kill === 'function') {
              try { proc.kill('SIGTERM'); } catch { /* ignore */ }
              job.status = 'killed';
              job.endedAt = new Date().toISOString();
              job.exitCode = -2;
            }
            res.statusCode = 200;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: String(e?.message || e || 'unknown') }));
          }
        });
      },
    },
    {
      // Dev/prod helper:
      // - In dev, if public/chrono/ is missing the .wasm, serve it from tools/chrono_wasm/build_out/.
      // - In build, copy the .wasm into dist/chrono/ so preview/prod can load it.
      name: 'chrono-wasm-fallback',
      configResolved(config) {
        // Vite may bundle this config into a temp directory, so `__dirname` is not reliable.
        // Use Vite's resolved root/outDir instead.
        try { this.__chronoRoot = String(config?.root || ''); } catch { /* ignore */ }
        try { this.__chronoOutDir = String(config?.build?.outDir || 'dist'); } catch { /* ignore */ }
      },
      configureServer(server) {
        const root = String(this?.__chronoRoot || server?.config?.root || process.cwd() || '').trim();
        const pubChrono = path.join(root, 'public', 'chrono');
        const buildOut = path.join(root, 'tools', 'chrono_wasm', 'build_out');

        const useBuildOut = (() => {
          try {
            // In dev, always prefer tools/chrono_wasm/build_out if present.
            // public/chrono can easily become stale (copied on a previous build), and mixing JS/WASM/DATA
            // across different builds can lead to "everything loads, but APIs behave wrong".
            const outWasm = path.join(buildOut, 'chrono_vehicle_module.wasm');
            const outJs = path.join(buildOut, 'chrono_vehicle_module.js');
            const outData = path.join(buildOut, 'chrono_vehicle_module.data');
            return fs.existsSync(outWasm) && fs.existsSync(outJs) && fs.existsSync(outData);
          } catch {
            return false;
          }
        })();

        const serveChronoFile = (urlPath, filename, contentType, { force = false, preferBuildOut = false } = {}) => {
          server.middlewares.use(urlPath, (req, res, next) => {
            try {
              if (!req || !res) return next();
              if (req.method !== 'GET' && req.method !== 'HEAD') return next();
              const pubFile = path.join(pubChrono, filename);
              if (!force && fs.existsSync(pubFile)) return next();
              const outFile = path.join(buildOut, filename);
              const src = preferBuildOut
                ? (fs.existsSync(outFile) ? outFile : (fs.existsSync(pubFile) ? pubFile : ''))
                : (fs.existsSync(pubFile) ? pubFile : (fs.existsSync(outFile) ? outFile : ''));
              if (!src || !fs.existsSync(src)) return next();

              res.statusCode = 200;
              res.setHeader('Content-Type', contentType);
              res.setHeader('Cache-Control', 'no-store');
              if (req.method === 'HEAD') {
                res.end();
                return;
              }
              fs.createReadStream(src).pipe(res);
              return;
            } catch {
              return next();
            }
          });
        };

        // Only patch the missing pieces; public/chrono already contains the .js/.data in this repo.
        // Note: Vite's dev public-file middleware can emit an empty Content-Type for ".data" files,
        // which breaks some browsers' fetch streaming behavior. Always serve this file ourselves.
        serveChronoFile('/chrono/chrono_vehicle_module.data', 'chrono_vehicle_module.data', 'application/octet-stream', { force: true, preferBuildOut: useBuildOut });
        serveChronoFile('/chrono/chrono_vehicle_module.wasm', 'chrono_vehicle_module.wasm', 'application/wasm', { force: useBuildOut, preferBuildOut: useBuildOut });
        serveChronoFile('/chrono/chrono_vehicle_module.js', 'chrono_vehicle_module.js', 'text/javascript; charset=utf-8', { force: useBuildOut, preferBuildOut: useBuildOut });
        serveChronoFile('/chrono/chrono_vehicle_module.worker.js', 'chrono_vehicle_module.worker.js', 'text/javascript; charset=utf-8', { force: useBuildOut, preferBuildOut: useBuildOut });
      },
      closeBundle() {
        try {
          const root = String(this?.__chronoRoot || process.cwd() || '').trim();
          const outDirRel = String(this?.__chronoOutDir || '').trim() || 'dist';
          const outDir = path.isAbsolute(outDirRel) ? outDirRel : path.join(root, outDirRel);
          const outChrono = path.join(outDir, 'chrono');
          const pubChrono = path.join(root, 'public', 'chrono');
          const buildOut = path.join(root, 'tools', 'chrono_wasm', 'build_out');

          const pubWasm = path.join(pubChrono, 'chrono_vehicle_module.wasm');
          const outWasm = path.join(buildOut, 'chrono_vehicle_module.wasm');
          const shouldForceBuildOut = !fs.existsSync(pubWasm) && fs.existsSync(outWasm);

          const copyIfMissing = (filename) => {
            const dst = path.join(outChrono, filename);
            // If it exists in public it should already be in dist; only copy if missing.
            if (fs.existsSync(dst)) return;
            const srcPreferred = path.join(pubChrono, filename);
            const srcFallback = path.join(buildOut, filename);
            const src = fs.existsSync(srcPreferred) ? srcPreferred : (fs.existsSync(srcFallback) ? srcFallback : '');
            if (!src) return;
            try { fs.mkdirSync(outChrono, { recursive: true }); } catch { /* ignore */ }
            try { fs.copyFileSync(src, dst); } catch { /* ignore */ }
          };

          copyIfMissing('chrono_vehicle_module.wasm');
          copyIfMissing('chrono_vehicle_module.data');
          copyIfMissing('chrono_vehicle_module.worker.js');

          // If we had to fall back to build_out for wasm, ensure dist gets a coherent set too.
          if (shouldForceBuildOut) {
            const forceCopy = (filename) => {
              const src = path.join(buildOut, filename);
              const dst = path.join(outChrono, filename);
              if (!fs.existsSync(src)) return;
              try { fs.mkdirSync(outChrono, { recursive: true }); } catch { /* ignore */ }
              try { fs.copyFileSync(src, dst); } catch { /* ignore */ }
            };
            forceCopy('chrono_vehicle_module.wasm');
            forceCopy('chrono_vehicle_module.data');
            forceCopy('chrono_vehicle_module.worker.js');
            forceCopy('chrono_vehicle_module.js');
          }
        } catch { /* ignore */ }
      },
    },
  ],
  build: {
    assetsDir: 'bundled',
    rollupOptions: {
      input: (() => {
        const target = String(process?.env?.BUILD_TARGET || '').trim().toLowerCase();
        if (target === 'resume') {
          // Minimal static export: ONLY the resume showcase page.
          return {
            resume: path.resolve(__dirname, 'resume.html'),
          };
        }
        return {
          main: path.resolve(__dirname, 'index.html'),
          devtools: path.resolve(__dirname, 'devtools.html'),
          chrono_wasm_drive_test: path.resolve(__dirname, 'chrono_wasm_drive_test.html'),
          mesh2motion_create: path.resolve(__dirname, 'mesh2motion/create.html'),
          mesh2motion_retarget: path.resolve(__dirname, 'mesh2motion/retarget.html'),
        };
      })(),
    },
  },
  server: {
    watch: {
      // Avoid ENOSPC crashes on large repos (polling instead of inotify watchers).
      usePolling: true,
      interval: 1000,
      ignored: [
        '**/assets/**',
        '**/dist/**',
        // Large local datasets (avoid hitting inotify watch limits).
        '**/assetto/**',
        // Some chokidar paths arrive as absolute; keep a regex too (belt + suspenders).
        /\/assetto\/.*/,
        // Vendored SDKs / toolchains can contain huge file trees.
        '**/tools/third_party/**',
        '**/tools/third_party/emsdk/**',
        // Prevent ENOSPC crashes by excluding large external content repos.
        '**/repos/HaloAnimationRepository/**',
        '**/repos/infinigen/**',
      ],
    },
  },
});


