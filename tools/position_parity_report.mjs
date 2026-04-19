#!/usr/bin/env node
/**
 * Position parity report
 *
 * Goal: detect coordinate-frame disconnects (origin mismatch, lon/lat swap, etc.)
 * between datasets/layers and the hardcoded VB spawn point used in editor_app.js.
 *
 * This intentionally avoids JSON.parse on huge GeoJSON (OSM buildings can be 100s of MB).
 * Instead, it streams the file and heuristically extracts [lon,lat] pairs to compute bounds.
 *
 * Usage:
 *   node tools/position_parity_report.mjs --dataset osm_va_virginia_beach_scene
 *   node tools/position_parity_report.mjs --dataset osm_va_virginia_beach_buildings
 *   node tools/position_parity_report.mjs --all
 *
 * Options:
 *   --dataset <id>        Dataset id from assets/datasets/manifest.json (bundle or leaf)
 *   --all                Report for all datasets (can take a while)
 *   --max-matches <n>    Stop scanning each GeoJSON after n coord matches (default: unlimited)
 *   --progress-mb <n>    Print progress every n MB scanned (default: 64; set 0 to disable)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..'); // webgl_viewer_standalone/

function usage(exitCode = 0) {
  // eslint-disable-next-line no-console
  console.log(
    [
      'Position parity report',
      '',
      'Usage:',
      '  node tools/position_parity_report.mjs --dataset <id>',
      '  node tools/position_parity_report.mjs --all',
      '',
      'Options:',
      '  --dataset <id>        Dataset id from assets/datasets/manifest.json (bundle or leaf)',
      '  --all                Report for all datasets (can take a while)',
      '  --max-matches <n>    Stop scanning each GeoJSON after n coord matches (default: unlimited)',
      '  --progress-mb <n>    Print progress every n MB scanned (default: 64; set 0 to disable)',
    ].join('\n'),
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = {
    dataset: '',
    all: false,
    maxMatches: Infinity,
    progressMb: 64,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') usage(0);
    if (a === '--all') { out.all = true; continue; }
    if (a === '--dataset') { out.dataset = String(argv[++i] || ''); continue; }
    if (a === '--max-matches') {
      const n = Number(argv[++i]);
      out.maxMatches = Number.isFinite(n) && n > 0 ? n : Infinity;
      continue;
    }
    if (a === '--progress-mb') {
      const n = Number(argv[++i]);
      out.progressMb = Number.isFinite(n) && n >= 0 ? n : 64;
      continue;
    }
    // eslint-disable-next-line no-console
    console.error(`Unknown arg: ${a}`);
    usage(2);
  }
  return out;
}

function toRad(deg) {
  return (Number(deg) || 0) * Math.PI / 180;
}

// Equirectangular meters around origin (must match `js/runtime/osm_loader.js` + `editor_app.js`)
function projectLonLatMeters(lon, lat, originLon, originLat) {
  const R = 6378137.0;
  const lam = toRad(lon);
  const phi = toRad(lat);
  const lam0 = toRad(originLon);
  const phi0 = toRad(originLat);
  const x = (lam - lam0) * Math.cos(phi0) * R;
  const y = (phi - phi0) * R;
  return [x, y];
}

function fmtLonLat(ol) {
  const lon = Number(ol?.[0]);
  const lat = Number(ol?.[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return 'none';
  return `${lon.toFixed(6)},${lat.toFixed(6)}`;
}

function resolveBundle(manifest, datasetId, _seen = new Set()) {
  const id = String(datasetId || '');
  if (!id) return [];
  if (_seen.has(id)) return []; // prevent cycles
  _seen.add(id);

  const entry = manifest.find((d) => d && d.id === id);
  if (!entry) return [];
  if (entry.kind === 'bundle' && Array.isArray(entry.bundle)) {
    const out = [];
    for (const child of entry.bundle) out.push(...resolveBundle(manifest, child, _seen));
    return out;
  }
  return [id];
}

function readJson(filePath) {
  const txt = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(txt);
}

async function scanGeojsonLonLatBounds(filePath, { maxMatches = Infinity, progressMb = 64 } = {}) {
  const st = fs.statSync(filePath);
  const totalBytes = st.size;
  const progressBytes = Math.max(0, Number(progressMb) || 0) * 1024 * 1024;

  // Find plausible [lon, lat] pairs; allow exponent; allow optional 3rd number (e.g., altitude).
  // We filter by lon/lat ranges to avoid counting random numeric arrays in properties.
  const re = /\[\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*,\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*(?:,\s*-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)?\s*\]/ig;

  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  let lonLatCount = 0;
  let latLonCount = 0;
  let matches = 0;

  let bytesRead = 0;
  let nextProgress = progressBytes > 0 ? progressBytes : Infinity;
  let carry = '';

  const rs = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 256 });
  for await (const chunk of rs) {
    bytesRead += Buffer.byteLength(chunk, 'utf8');
    const text = carry + chunk;
    carry = text.slice(Math.max(0, text.length - 256));

    re.lastIndex = 0;
    for (;;) {
      const m = re.exec(text);
      if (!m) break;
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;

      const aLon = a >= -180 && a <= 180;
      const aLat = a >= -90 && a <= 90;
      const bLon = b >= -180 && b <= 180;
      const bLat = b >= -90 && b <= 90;

      // Prefer (lon,lat) but record evidence for swap.
      if (aLon && bLat) {
        minLon = Math.min(minLon, a);
        maxLon = Math.max(maxLon, a);
        minLat = Math.min(minLat, b);
        maxLat = Math.max(maxLat, b);
        lonLatCount++;
        matches++;
      } else if (aLat && bLon) {
        latLonCount++;
      }

      if (matches >= maxMatches) {
        rs.destroy();
        break;
      }
    }

    if (bytesRead >= nextProgress) {
      // eslint-disable-next-line no-console
      console.log(`  ... scanned ${(bytesRead / (1024 * 1024)).toFixed(1)} MB / ${(totalBytes / (1024 * 1024)).toFixed(1)} MB`);
      nextProgress += progressBytes;
    }
    if (matches >= maxMatches) break;
  }

  if (!Number.isFinite(minLon)) return null;
  return {
    minLon, minLat, maxLon, maxLat,
    coordMatches: matches,
    lonLatCount,
    latLonCount,
  };
}

function bboxCenter(b) {
  return [(b.minLon + b.maxLon) * 0.5, (b.minLat + b.maxLat) * 0.5];
}

function fmtBbox(b) {
  return `lon[${b.minLon.toFixed(6)}, ${b.maxLon.toFixed(6)}] lat[${b.minLat.toFixed(6)}, ${b.maxLat.toFixed(6)}]`;
}

function projectBboxToMeters(b, originLonLat) {
  const olon = Number(originLonLat?.[0]);
  const olat = Number(originLonLat?.[1]);
  if (!b || !Number.isFinite(olon) || !Number.isFinite(olat)) return null;
  const a = projectLonLatMeters(b.minLon, b.minLat, olon, olat);
  const c = projectLonLatMeters(b.maxLon, b.maxLat, olon, olat);
  const minX = Math.min(a[0], c[0]);
  const maxX = Math.max(a[0], c[0]);
  const minZ = Math.min(a[1], c[1]);
  const maxZ = Math.max(a[1], c[1]);
  return { minX, maxX, minZ, maxZ };
}

function fmtMeterBbox(mb) {
  return `x[${mb.minX.toFixed(1)}, ${mb.maxX.toFixed(1)}] z[${mb.minZ.toFixed(1)}, ${mb.maxZ.toFixed(1)}]`;
}

async function reportDataset(manifest, datasetId, opts) {
  const leafIds = resolveBundle(manifest, datasetId);
  if (!leafIds.length) {
    // eslint-disable-next-line no-console
    console.log(`- ${datasetId}: not found or empty bundle`);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`\n=== Dataset: ${datasetId} ===`);
  // eslint-disable-next-line no-console
  console.log(`Entries (${leafIds.length}): ${leafIds.join(', ')}`);

  // Known “sanity check” point used by editor spawn button.
  const vb = { lon: -75.9780, lat: 36.8529, label: 'Virginia Beach spawn' };

  /** @type {{ id: string, kind: string, url: string, tileOriginLonLat?: number[], bbox?: any, originAutoLonLat?: number[] }} */
  const rows = [];

  for (const id of leafIds) {
    const entry = manifest.find((d) => d && d.id === id);
    if (!entry) continue;
    const kind = String(entry.kind || '');
    const url = String(entry.url || '');
    const row = { id, kind, url };

    if (kind === 'instanced-tiles-buildings' || kind === 'tiles-footprints-buildings') {
      const idxPath = path.resolve(ROOT, url);
      if (fs.existsSync(idxPath)) {
        try {
          const idx = readJson(idxPath);
          const ol = idx?.originLonLat;
          const lon = Number(ol?.[0]);
          const lat = Number(ol?.[1]);
          if (Number.isFinite(lon) && Number.isFinite(lat)) row.tileOriginLonLat = [lon, lat];
        } catch {
          // ignore
        }
      }
      rows.push(row);
      continue;
    }

    if (kind.startsWith('geojson-wgs84-') && url) {
      const filePath = path.resolve(ROOT, url);
      if (!fs.existsSync(filePath)) {
        rows.push(row);
        continue;
      }
      const bb = await scanGeojsonLonLatBounds(filePath, { maxMatches: opts.maxMatches, progressMb: opts.progressMb });
      if (bb) {
        row.bbox = bb;
        row.originAutoLonLat = bboxCenter(bb);
      }
      rows.push(row);
      continue;
    }

    rows.push(row);
  }

  const tileOrigins = rows.map((r) => r.tileOriginLonLat).filter(Boolean);
  const autoOrigins = rows.map((r) => r.originAutoLonLat).filter(Boolean);

  // Approximate runtime-origin selection:
  // - If tiles exist: those *must* drive the origin (everything else should align to tiler origin)
  // - Else prefer roads (they are loaded before buildings in EditorApp), falling back to first auto origin
  const roadAuto = rows.find((r) => r && r.kind === 'geojson-wgs84-roads')?.originAutoLonLat || null;
  const runtimeOrigin =
    (tileOrigins.length ? tileOrigins[0] : null) ||
    roadAuto ||
    (autoOrigins.length ? autoOrigins[0] : null) ||
    null;

  // eslint-disable-next-line no-console
  console.log('\nPer-entry bounds/origin:');
  for (const r of rows) {
    // eslint-disable-next-line no-console
    console.log(`- ${r.id} (${r.kind})`);
    if (r.tileOriginLonLat) {
      // eslint-disable-next-line no-console
      console.log(`  tile originLonLat: ${fmtLonLat(r.tileOriginLonLat)}`);
    }
    if (r.bbox) {
      // eslint-disable-next-line no-console
      console.log(`  bbox: ${fmtBbox(r.bbox)}  matches=${r.bbox.coordMatches}  lon,lat=${r.bbox.lonLatCount}  lat,lon=${r.bbox.latLonCount}`);
    }
    if (r.originAutoLonLat) {
      // eslint-disable-next-line no-console
      console.log(`  auto originLonLat (bbox center): ${fmtLonLat(r.originAutoLonLat)}`);
    }
    if (r.bbox && runtimeOrigin) {
      const mb = projectBboxToMeters(r.bbox, runtimeOrigin);
      if (mb) {
        // eslint-disable-next-line no-console
        console.log(`  bbox projected into runtime origin ${fmtLonLat(runtimeOrigin)}: ${fmtMeterBbox(mb)}`);
      }
    }
  }

  // Choose a “reference origin” for quick parity math:
  // - If tiles exist: they are the most fragile (must match tiler), so prefer tile origin
  // - else: prefer first auto origin
  const refOrigin =
    (tileOrigins.length ? tileOrigins[0] : null) ||
    (autoOrigins.length ? autoOrigins[0] : null) ||
    null;

  // eslint-disable-next-line no-console
  console.log('\nOrigin parity (meters, equirectangular around REF origin):');
  // eslint-disable-next-line no-console
  console.log(`REF originLonLat: ${fmtLonLat(refOrigin)}`);
  // eslint-disable-next-line no-console
  console.log(`Runtime originLonLat (approx): ${fmtLonLat(runtimeOrigin)}`);

  const allOrigins = [
    ...tileOrigins.map((o) => ({ label: 'tile', origin: o })),
    ...autoOrigins.map((o) => ({ label: 'auto', origin: o })),
  ];

  if (!refOrigin || !allOrigins.length) {
    // eslint-disable-next-line no-console
    console.log('  (no origins found for this dataset)');
    return;
  }

  for (const { label, origin } of allOrigins) {
    const [dx, dz] = projectLonLatMeters(origin[0], origin[1], refOrigin[0], refOrigin[1]);
    // eslint-disable-next-line no-console
    console.log(`- ${label} ${fmtLonLat(origin)}  deltaFromRef: dx=${dx.toFixed(2)}m dz=${dz.toFixed(2)}m  dist=${Math.hypot(dx, dz).toFixed(2)}m`);
  }

  // eslint-disable-next-line no-console
  console.log(`\nSpawn check: ${vb.label} (lon=${vb.lon}, lat=${vb.lat})`);
  for (const { label, origin } of allOrigins) {
    const [x, z] = projectLonLatMeters(vb.lon, vb.lat, origin[0], origin[1]);
    // eslint-disable-next-line no-console
    console.log(`- vs ${label} origin ${fmtLonLat(origin)} -> meters: x=${x.toFixed(2)} z=${z.toFixed(2)}`);
  }
  if (runtimeOrigin) {
    const [x, z] = projectLonLatMeters(vb.lon, vb.lat, runtimeOrigin[0], runtimeOrigin[1]);
    // eslint-disable-next-line no-console
    console.log(`- vs runtime origin ${fmtLonLat(runtimeOrigin)} -> meters: x=${x.toFixed(2)} z=${z.toFixed(2)}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.all && !opts.dataset) usage(2);

  const manifestPath = path.resolve(ROOT, 'assets/datasets/manifest.json');
  if (!fs.existsSync(manifestPath)) {
    // eslint-disable-next-line no-console
    console.error(`Missing manifest: ${manifestPath}`);
    process.exit(2);
  }
  const json = readJson(manifestPath);
  const manifest = Array.isArray(json?.datasets) ? json.datasets : [];

  const ids = opts.all
    ? manifest.map((d) => String(d?.id || '')).filter(Boolean)
    : [String(opts.dataset)];

  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    await reportDataset(manifest, id, opts);
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});


