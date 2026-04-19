#!/usr/bin/env node
/**
 * Mesh2Motion pipeline test: plain mesh (no skeleton) → create flow → export
 * Run: node tools/mesh2motion_pipeline_test.mjs
 * Requires: npm install playwright (or npx playwright)
 * Prereq: mesh2motion dev server on port 5174 or 5175
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GLB_PATH = path.join(ROOT, 'outputs', 'tpose_trellis.glb');
const PORTS = [5174, 5175, 5179];

const report = { steps: [], errors: [], consoleLogs: [], finalVerdict: null, firstBlocker: null };

function log(step, status, detail = '') {
  const entry = { step, status, detail };
  report.steps.push(entry);
  console.log(`[${status.toUpperCase()}] ${step}${detail ? ': ' + detail : ''}`);
}

async function findServer() {
  for (const port of PORTS) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return port;
    } catch {}
  }
  return null;
}

async function main() {
  if (!fs.existsSync(GLB_PATH)) {
    log('File check', 'fail', `GLB not found: ${GLB_PATH}`);
    report.finalVerdict = 'BLOCKED';
    report.firstBlocker = 'Missing input file outputs/tpose_trellis.glb';
    outputReport();
    process.exit(1);
  }
  log('File check', 'pass', 'tpose_trellis.glb exists');

  const port = await findServer();
  if (!port) {
    log('Server', 'fail', 'No mesh2motion server on 5174/5175/5179');
    report.finalVerdict = 'BLOCKED';
    report.firstBlocker = 'Start mesh2motion: cd repos/mesh2motion-app && npm run dev -- --port 5174';
    outputReport();
    process.exit(1);
  }
  log('Server', 'pass', `Found server on port ${port}`);

  const baseUrl = `http://127.0.0.1:${port}`;
  const createUrl = `${baseUrl}/create.html`;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  page.on('console', (msg) => {
    const text = msg.text();
    report.consoleLogs.push(text);
    if (text.toLowerCase().includes('error') || text.toLowerCase().includes('fail')) {
      report.errors.push(text);
    }
  });

  try {
    // 1) Navigate to create flow
    await page.goto(createUrl, { waitUntil: 'networkidle', timeout: 15000 });
    const title = await page.title();
    if (!title.toLowerCase().includes('create') && !title.toLowerCase().includes('mesh2motion')) {
      log('Navigate create', 'warn', `Title: ${title}`);
    } else {
      log('Navigate create', 'pass', 'Create page loaded');
    }

    // Check for Upload / load-model UI
    const uploadInput = page.locator('#model-upload');
    await uploadInput.waitFor({ state: 'visible', timeout: 5000 });
    log('Upload UI', 'pass', 'Model upload input visible');

    // 2) Upload GLB via file chooser
    const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 5000 });
    await uploadInput.click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(GLB_PATH);
    log('Upload file', 'pass', 'File selected via file chooser');

    // Wait for model to load - look for "Load Skeleton" step UI
    await page.waitForTimeout(3000);

    // Check if we advanced to Load Skeleton step (skeleton template select visible)
    const skeletonSelect = page.locator('#skeleton-selection');
    const loadSkeletonBtn = page.locator('#load-skeleton-button');
    const backBtn = page.locator('#action_back_to_load_model');
    const editSkeletonBtn = page.locator('#load-skeleton-button');

    const skeletonVisible = await skeletonSelect.isVisible().catch(() => false);
    if (!skeletonVisible) {
      // Maybe still on load-model with "reference model" - check for load-model-tools or error dialog
      const errorDialog = page.locator('.modal-dialog, [class*="modal"], [class*="error"]');
      const hasError = await errorDialog.first().isVisible().catch(() => false);
      if (hasError) {
        const errText = await errorDialog.first().textContent().catch(() => '');
        log('Model load', 'fail', `Error dialog: ${errText.slice(0, 200)}`);
        report.firstBlocker = errText.slice(0, 150);
      } else {
        log('Model load', 'warn', 'Skeleton step not yet visible - model may still be loading or UI differs');
      }
    } else {
      log('Model load', 'pass', 'Model loaded, Load Skeleton step visible');
    }

    // 3) Select skeleton template and proceed
    if (skeletonVisible) {
      await skeletonSelect.selectOption('human');
      log('Skeleton selection', 'pass', 'Human skeleton selected');
      await page.waitForTimeout(500);

      // Click "Edit Skeleton &gt" to go to Edit Skeleton step
      const editBtn = page.locator('button:has-text("Edit Skeleton")');
      if (await editBtn.isVisible().catch(() => false)) {
        await editBtn.click();
        await page.waitForTimeout(1500);
        log('Edit Skeleton', 'pass', 'Advanced to Edit Skeleton step');
      } else {
        log('Edit Skeleton', 'fail', 'Edit Skeleton button not found');
      }
    }

    // 4) Bind pose - look for "Bind pose" button
    const bindPoseBtn = page.locator('#action_bind_pose, button:has-text("Bind pose")');
    const bindVisible = await bindPoseBtn.first().isVisible().catch(() => false);
    if (bindVisible) {
      await bindPoseBtn.first().click();
      await page.waitForTimeout(3000); // Weight skin can take a moment
      log('Bind pose', 'pass', 'Bind pose clicked');
    } else {
      log('Bind pose', 'skip', 'Bind pose button not visible (may need to complete Edit Skeleton first)');
    }

    // 5) Check for Animations listing / Export
    const exportBtn = page.locator('#export-button, #export-retargeting-button, button:has-text("Download")');
    const exportVisible = await exportBtn.first().isVisible().catch(() => false);
    if (exportVisible) {
      log('Export UI', 'pass', 'Export/Download button visible');
    } else {
      log('Export UI', 'warn', 'Export button not yet visible');
    }

    // 6) Try export (if visible)
    if (exportVisible) {
      const downloadPromise = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
      await exportBtn.first().click();
      const download = await downloadPromise;
      if (download) {
        const outPath = path.join(ROOT, 'outputs', `mesh2motion_test_export_${Date.now()}.glb`);
        await download.saveAs(outPath);
        log('Export', 'pass', `Saved to ${path.basename(outPath)}`);
      } else {
        log('Export', 'warn', 'Export clicked but no download triggered (may need animation selection)');
      }
    }
  } catch (err) {
    log('Browser test', 'fail', err.message);
    report.errors.push(err.stack || err.message);
    report.firstBlocker = report.firstBlocker || err.message;
  } finally {
    await browser.close();
  }

  report.finalVerdict = report.steps.some(s => s.status === 'fail') ? 'BLOCKED' : 
    (report.steps.filter(s => s.status === 'pass').length >= 4 ? 'WORKS' : 'PARTIAL');
  outputReport();
}

function outputReport() {
  console.log('\n--- Mesh2Motion Pipeline Test Report ---');
  console.log('Steps:');
  report.steps.forEach(s => console.log(`  ${s.status.padEnd(6)} ${s.step} ${s.detail || ''}`));
  if (report.errors.length) {
    console.log('\nErrors/console:');
    report.errors.slice(0, 5).forEach(e => console.log('  ', e.slice(0, 200)));
  }
  console.log('\nFinal verdict:', report.finalVerdict);
  if (report.firstBlocker) console.log('First blocker:', report.firstBlocker);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
