import fs from 'node:fs';
import path from 'node:path';
import child_process from 'node:child_process';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function tryGitShortHash() {
  try {
    return String(child_process.execSync('git rev-parse --short HEAD', {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    }) || '').trim() || null;
  } catch {
    return null;
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyFileIfExists(src, dst) {
  if (!exists(src)) return false;
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  return true;
}

function run(cmd, { env = {} } = {}) {
  child_process.execSync(cmd, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
}

function main() {
  // 1) Build ONLY resume.html via Vite multi-page input switching.
  run('npx vite build', { env: { BUILD_TARGET: 'resume' } });

  const distDir = path.join(repoRoot, 'dist');
  const resumeOutHtml = path.join(distDir, 'resume.html');
  const indexOutHtml = path.join(distDir, 'index.html');

  // 1.5) Write a unique build id for client-side cache busting.
  // This helps ensure the browser doesn't keep an older cached HTML shell.
  const git = tryGitShortHash();
  const buildId = `${git || 'dev'}-${Date.now()}`;
  try {
    fs.writeFileSync(
      path.join(distDir, 'resume_build.json'),
      JSON.stringify({ id: buildId, git, builtAt: new Date().toISOString() }, null, 2),
    );
  } catch (e) {
    console.warn(`[build:resume] Failed to write dist/resume_build.json: ${String(e?.message || e || 'unknown')}`);
  }

  // 2) Make static-hosting easy: also write dist/index.html.
  if (exists(resumeOutHtml)) {
    fs.copyFileSync(resumeOutHtml, indexOutHtml);
    // Keep the export minimal: the static host only needs index.html.
    try { fs.rmSync(resumeOutHtml); } catch { /* ignore */ }
  }

  // 3) Copy required runtime assets for the resume build.
  // Put large “resume assets” under dist/resume/ so they’re easy to manage.
  const distResumeDir = path.join(distDir, 'resume');
  ensureDir(distResumeDir);

  // Walker / avatar GLB expected by js/resume/main.js:
  //   resume/exported-model.glb
  const walkerSrc = path.join(repoRoot, 'exported-model.glb');
  const walkerDst = path.join(distResumeDir, 'exported-model.glb');
  if (!copyFileIfExists(walkerSrc, walkerDst)) {
    console.warn(`[build:resume] Missing ${walkerSrc}. The site will load, but the animated walker/third-person avatar may fail to load.`);
  }

  // Optional: if you have a dedicated texture-source GLB, copy it too (not required by default runtime).
  const texSrc = path.join(repoRoot, 'outputs', 'new_tpose_trellis.glb');
  const texDst = path.join(distResumeDir, 'new_tpose_trellis.glb');
  if (copyFileIfExists(texSrc, texDst)) {
    console.log('[build:resume] Copied optional texture source GLB (resume/new_tpose_trellis.glb).');
  }

  // Heads-up for Chrono WASM: SceneTool tries to init it in the background.
  // Resume export disables Chrono; remove it from dist to keep the payload minimal.
  try { fs.rmSync(path.join(distDir, 'chrono'), { recursive: true, force: true }); } catch { /* ignore */ }

  // 4) Remove unrelated public assets that Vite copied through.
  // (Resume showcase doesn’t need them, and you asked for a minimal export.)
  try { fs.rmSync(path.join(distDir, 'external'), { recursive: true, force: true }); } catch { /* ignore */ }

  console.log('[build:resume] Done. Upload the contents of dist/ to your static host.');
}

main();

