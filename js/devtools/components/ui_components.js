/**
 * Shared, reusable UI components for DevTools.
 * Eliminates duplicate code across tools for common patterns:
 *  - AssetPicker (search + list)
 *  - JobRunner   (start / poll / kill with progress + logs)
 *  - DropZone    (drag-and-drop file input)
 *  - ProgressBar (determinate or indeterminate)
 */

import { el, clear } from '../../ui/dom.js';

function safeErrMsg(e) {
  return String(e?.message || e || 'Unknown error');
}

async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(String(text ?? '')); return true; } catch { return false; }
}

/* ═══════════════════════════════════════════════
 *  DropZone
 * ═══════════════════════════════════════════════ */

/**
 * Creates a drag-and-drop file input zone.
 *
 * @param {{
 *   accept?: string,
 *   label?: string,
 *   hint?: string,
 *   icon?: string,
 *   multiple?: boolean,
 *   onFiles: (files: File[]) => void,
 * }} opts
 * @returns {HTMLElement}
 */
export function createDropZone({
  accept = '*',
  label = 'Drop file here or click to browse',
  hint = '',
  icon = '↓',
  multiple = false,
  onFiles,
}) {
  const fileInput = el('input', {
    type: 'file',
    accept,
    multiple: multiple || undefined,
    onchange: (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length) onFiles(files);
      // Reset so re-selecting the same file still fires.
      try { e.target.value = ''; } catch { /* */ }
    },
  });

  const zone = el('div', { class: 'dropZone' }, [
    el('div', { class: 'dropIcon' }, [icon]),
    el('div', { class: 'dropLabel' }, [label]),
    hint ? el('div', { class: 'dropHint' }, [hint]) : null,
    fileInput,
  ].filter(Boolean));

  // Drag highlight
  let dragCounter = 0;
  zone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    zone.classList.add('dropHover');
  });
  zone.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; zone.classList.remove('dropHover'); }
  });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    zone.classList.remove('dropHover');
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) onFiles(files);
  });

  return zone;
}

/* ═══════════════════════════════════════════════
 *  ProgressBar
 * ═══════════════════════════════════════════════ */

/**
 * Creates a thin progress bar element.
 *
 * @returns {{ element: HTMLElement, set: (fraction: number|null) => void, setIndeterminate: () => void, hide: () => void }}
 */
export function createProgressBar() {
  const fill = el('div', { class: 'progressFill', style: { width: '0%' } });
  const bar = el('div', { class: 'progressBar', style: { display: 'none' } }, [fill]);

  return {
    element: bar,
    /** @param {number|null} fraction 0..1, or null to hide. */
    set(fraction) {
      bar.classList.remove('indeterminate');
      if (fraction == null) {
        bar.style.display = 'none';
        return;
      }
      bar.style.display = 'block';
      const pct = Math.max(0, Math.min(100, (fraction * 100)));
      fill.style.width = `${pct}%`;
    },
    setIndeterminate() {
      bar.style.display = 'block';
      bar.classList.add('indeterminate');
      fill.style.width = '35%';
    },
    hide() {
      bar.style.display = 'none';
    },
  };
}

/* ═══════════════════════════════════════════════
 *  AssetPicker
 * ═══════════════════════════════════════════════ */

/**
 * Creates a collapsible asset picker (search + list).
 *
 * @param {{
 *   ctx: { assetIndex: Function, log?: Function },
 *   title?: string,
 *   ext?: string,
 *   placeholder?: string,
 *   maxResults?: number,
 *   listHeight?: string,
 *   onPick: (path: string) => void,
 *   open?: boolean,
 * }} opts
 * @returns {HTMLElement}
 */
export function createAssetPicker({
  ctx,
  title = 'Asset Picker',
  ext = '',
  placeholder = 'Search assets\u2026',
  maxResults = 250,
  listHeight = '180px',
  onPick,
  open = false,
}) {
  const queryInput = el('input', { placeholder });
  const list = el('div', { class: 'scrollArea', style: { height: listHeight } }, ['Enter a search and press Enter.']);

  const refresh = async () => {
    const q = String(queryInput.value || '').trim();
    if (!q) { list.textContent = 'Enter a search query.'; return; }
    try {
      list.textContent = 'Searching\u2026';
      const items = await ctx.assetIndex({ query: q, ext });
      if (!items.length) { list.textContent = 'No matches.'; return; }
      clear(list);
      for (const it of items.slice(0, maxResults)) {
        const p = String(it?.path || '');
        const fileName = p.split('/').pop() || p;
        const bytes = Number(it?.bytes) || 0;
        const sizeMiB = (bytes / (1024 * 1024)).toFixed(2);
        list.appendChild(el('button', {
          class: 'toolBtn',
          style: { marginTop: '2px', padding: '4px 8px', fontSize: '11px' },
          onclick: () => onPick(p),
          title: `${p}  (${sizeMiB} MiB)`,
        }, [fileName]));
      }
    } catch (e) {
      list.textContent = `Error: ${e?.message || e}`;
    }
  };
  queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') refresh(); });

  const details = el('details', { class: 'card' }, [
    el('summary', {}, [el('div', { class: 'dockTitle' }, [title])]),
    el('div', { class: 'cardBody' }, [
      el('div', { class: 'row', style: { marginTop: '6px' } }, [
        queryInput,
        el('button', { onclick: refresh }, ['Search']),
      ]),
      el('div', { style: { marginTop: '6px' } }, [list]),
    ]),
  ]);
  if (open) details.open = true;

  return details;
}

/* ═══════════════════════════════════════════════
 *  JobRunner
 * ═══════════════════════════════════════════════ */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Creates a reusable job runner UI with start/kill buttons, status, progress bar, and log area.
 *
 * @param {{
 *   ctx: { log?: Function },
 *   label?: string,
 *   startLabel?: string,
 *   killLabel?: string,
 *   logHeight?: string,
 *   onStart: () => Promise<{ id: string, [k: string]: any }>,
 *   onPoll: (id: string) => Promise<{ status: string, stdout?: string, stderr?: string, exitCode?: number, [k: string]: any }>,
 *   onKill?: (id: string) => Promise<void>,
 *   onDone?: (job: any) => void,
 *   extraButtons?: HTMLElement[],
 * }} opts
 * @returns {{ element: HTMLElement, isRunning: () => boolean, getJob: () => any }}
 */
export function createJobRunner({
  ctx,
  label = 'Job',
  startLabel = 'Start',
  killLabel = 'Kill',
  logHeight = '140px',
  onStart,
  onPoll,
  onKill,
  onDone,
  extraButtons = [],
}) {
  const progress = createProgressBar();
  const statusEl = el('div', { class: 'muted', style: { marginTop: '6px', display: 'flex', alignItems: 'center', gap: '6px' } }, []);
  const logEl = el('div', { class: 'scrollArea', style: { height: logHeight, marginTop: '6px' } }, ['']);

  let job = { id: '', status: '', stdout: '', stderr: '' };
  let polling = false;

  const updateStatus = (text, dotClass = 'idle') => {
    clear(statusEl);
    statusEl.appendChild(el('div', { class: `statusDot ${dotClass}` }));
    statusEl.appendChild(document.createTextNode(text));
  };

  const updateLog = () => {
    const out = job.stdout || '';
    const err = job.stderr || '';
    logEl.textContent = (err ? (out + '\n--- stderr ---\n' + err) : out) || '';
    try { logEl.scrollTop = logEl.scrollHeight; } catch { /* */ }
  };

  const startBtn = el('button', {
    class: 'primary',
    onclick: async () => {
      try {
        updateStatus('Starting\u2026', 'running');
        progress.setIndeterminate();
        logEl.textContent = '(starting\u2026)';

        const result = await onStart();
        job = { id: String(result?.id || ''), status: 'running', stdout: '', stderr: '', ...result };
        polling = true;
        ctx?.log?.(`${label}: started (${job.id})`);

        // Toast
        globalThis.__devtools?.toast?.(`${label} started`, 'info');

        void pollLoop();
      } catch (e) {
        updateStatus(`Start failed: ${e?.message || e}`, 'error');
        progress.hide();
        ctx?.log?.(`${label}: start failed: ${e?.message || e}`);
        globalThis.__devtools?.toast?.(`${label} failed: ${e?.message || e}`, 'error');
      }
    },
  }, [startLabel]);

  const killBtn = el('button', {
    class: 'danger',
    onclick: async () => {
      if (!job.id) return;
      try { await onKill?.(job.id); } catch { /* */ }
      polling = false;
      updateStatus('Killed', 'error');
      progress.hide();
    },
  }, [killLabel]);

  const pollLoop = async () => {
    const id = job.id;
    if (!id) return;
    let backoff = 500;
    while (polling && job.id === id) {
      try {
        const j = await onPoll(id);
        job.status = String(j?.status || '');
        job.stdout = String(j?.stdout || '');
        job.stderr = String(j?.stderr || '');
        Object.assign(job, j);

        const code = (j?.exitCode == null) ? '' : ` (exit ${j.exitCode})`;
        const dotClass = (job.status === 'done') ? 'done' : (job.status === 'error' || job.status === 'killed') ? 'error' : 'running';
        updateStatus(`${job.status}${code}`, dotClass);
        updateLog();

        if (job.status === 'done' || job.status === 'error' || job.status === 'killed') {
          polling = false;
          progress.hide();
          if (job.status === 'done') {
            progress.set(1);
            globalThis.__devtools?.toast?.(`${label} complete`, 'success');
          } else {
            globalThis.__devtools?.toast?.(`${label}: ${job.status}`, 'error');
          }
          ctx?.log?.(`${label}: ${job.status}`);
          onDone?.(job);
          return;
        }
        backoff = 800;
      } catch (e) {
        updateStatus(`Poll error: ${e?.message || e}`, 'error');
        backoff = Math.min(4000, Math.floor(backoff * 1.4));
      }
      await sleep(backoff);
    }
  };

  const buttons = [startBtn, killBtn, ...extraButtons];

  const container = el('div', { class: 'card' }, [
    el('div', { class: 'dockTitle' }, [label]),
    el('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap', gap: '6px' } }, buttons),
    progress.element,
    statusEl,
    logEl,
  ]);

  return {
    element: container,
    isRunning: () => polling,
    getJob: () => ({ ...job }),
  };
}

/* ═══════════════════════════════════════════════
 *  StatusDot (inline helper)
 * ═══════════════════════════════════════════════ */

/**
 * @param {'running'|'done'|'error'|'idle'} state
 * @returns {HTMLElement}
 */
export function createStatusDot(state = 'idle') {
  return el('div', { class: `statusDot ${state}` });
}

/* ═══════════════════════════════════════════════
 *  CopyButton / Copy helpers
 * ═══════════════════════════════════════════════ */

/**
 * Create a "Copy" button that writes text to clipboard and optionally toasts.
 *
 * @param {{
 *   ctx?: { toast?: Function, log?: Function },
 *   label?: string,
 *   title?: string,
 *   getText: () => (string|Promise<string>),
 *   toastTitle?: string,
 *   toastType?: 'info'|'success'|'error'|'warning',
 * }} opts
 * @returns {HTMLButtonElement}
 */
export function createCopyButton({
  ctx,
  label = 'Copy',
  title = 'Copy to clipboard',
  getText,
  toastTitle = 'Copied',
  toastType = 'success',
}) {
  return /** @type {HTMLButtonElement} */ (el('button', {
    onclick: async () => {
      try {
        const t = await getText();
        const ok = await copyToClipboard(String(t || ''));
        if (!ok) throw new Error('Clipboard permission denied');
        ctx?.toast?.('Copied to clipboard', toastType, { title: toastTitle, durationMs: 1400 });
      } catch (e) {
        const msg = safeErrMsg(e);
        ctx?.log?.(`Copy failed: ${msg}`);
        ctx?.toast?.(msg, 'error', { title: 'Copy failed' });
      }
    },
    title,
    style: { flex: '0 0 auto' },
  }, [label]));
}

/**
 * Create a small JSON import/export textarea card (replaces prompt() UX).
 *
 * @param {{
 *   ctx?: { toast?: Function, log?: Function },
 *   title: string,
 *   storageKey?: string,
 *   placeholder?: string,
 *   rows?: number,
 *   onApply: (obj: any) => void,
 *   applyLabel?: string,
 *   copyLabel?: string,
 * }} opts
 * @returns {HTMLElement}
 */
export function createJsonTextAreaCard({
  ctx,
  title,
  storageKey = '',
  placeholder = 'Paste JSON here…',
  rows = 8,
  onApply,
  applyLabel = 'Apply JSON',
  copyLabel = 'Copy JSON',
}) {
  let initial = '';
  if (storageKey) {
    try { initial = String(localStorage.getItem(storageKey) || ''); } catch { /* ignore */ }
  }

  const ta = el('textarea', {
    rows: String(rows),
    placeholder,
    value: initial,
    oninput: (e) => {
      if (!storageKey) return;
      try { localStorage.setItem(storageKey, String(e.target.value || '')); } catch { /* ignore */ }
    },
  });

  const applyBtn = el('button', {
    class: 'primary',
    style: { flex: '0 0 auto' },
    onclick: () => {
      const raw = String(ta.value || '').trim();
      if (!raw) { ctx?.toast?.('Paste JSON first', 'warning', { title: 'Nothing to apply' }); return; }
      try {
        const obj = JSON.parse(raw);
        onApply(obj);
        ctx?.toast?.('Applied JSON', 'success');
      } catch (e) {
        const msg = safeErrMsg(e);
        ctx?.log?.(`JSON apply failed: ${msg}`);
        ctx?.toast?.(msg, 'error', { title: 'Invalid JSON' });
      }
    },
  }, [applyLabel]);

  const copyBtn = createCopyButton({
    ctx,
    label: copyLabel,
    toastTitle: 'JSON copied',
    getText: () => String(ta.value || ''),
  });

  return el('details', { class: 'card' }, [
    el('summary', {}, [el('div', { class: 'dockTitle' }, [title])]),
    el('div', { class: 'cardBody' }, [
      el('div', { class: 'muted' }, ['Tip: this text area persists while DevTools is open.']),
      el('div', { class: 'formGroup' }, [ta]),
      el('div', { class: 'row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } }, [applyBtn, copyBtn]),
    ]),
  ]);
}

/* ═══════════════════════════════════════════════
 *  fileToDataUrl (shared utility)
 * ═══════════════════════════════════════════════ */

/**
 * Reads a File object into a base64 data URL.
 * @param {File} file
 * @returns {Promise<string>}
 */
export async function fileToDataUrl(file) {
  if (!file) throw new Error('Missing file');
  const ab = await file.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  const mime = file.type || 'application/octet-stream';
  return `data:${mime};base64,${b64}`;
}

/**
 * Guess file extension from a data URL MIME.
 * @param {string} dataUrl
 * @returns {string}
 */
export function guessExtFromDataUrl(dataUrl) {
  const s = String(dataUrl || '');
  const m = s.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,/);
  if (!m) return 'png';
  const ext = m[1].toLowerCase();
  if (ext.includes('jpeg')) return 'jpg';
  if (ext.includes('png')) return 'png';
  if (ext.includes('webp')) return 'webp';
  return 'png';
}
