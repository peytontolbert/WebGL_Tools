import { SceneTool } from '../devtools/tools/scene_tool.js';

async function main() {
  const canvasHost = /** @type {HTMLDivElement|null} */ (document.getElementById('canvasHost'));
  const toolUi = /** @type {HTMLDivElement|null} */ (document.getElementById('toolUi'));
  const actionHint = /** @type {HTMLDivElement|null} */ (document.getElementById('actionHint'));
  const btnUp = /** @type {HTMLButtonElement|null} */ (document.getElementById('btnUp'));
  const btnDown = /** @type {HTMLButtonElement|null} */ (document.getElementById('btnDown'));
  const btnLeft = /** @type {HTMLButtonElement|null} */ (document.getElementById('btnLeft'));
  const btnRight = /** @type {HTMLButtonElement|null} */ (document.getElementById('btnRight'));
  if (!canvasHost || !toolUi) throw new Error('Missing #canvasHost or #toolUi');

  // Signal to the shared SceneTool runtime that this is a minimal resume export.
  // Avoids background init of optional features (like Chrono WASM vehicles).
  try { globalThis.__resumeShowcase = true; } catch { /* ignore */ }
  try { globalThis.__disableProjectChronoWasm = true; } catch { /* ignore */ }
  // Resume export compatibility: force GLTFLoader to use TextureLoader instead of ImageBitmapLoader.
  // This avoids some environments where `createImageBitmap()` fails to decode large embedded PNGs,
  // producing "Couldn't load texture blob:..." errors.
  try {
    const key = 'createImageBitmap';
    const desc = Object.getOwnPropertyDescriptor(globalThis, key);
    const canDefine = !desc || desc.configurable;
    if (canDefine) {
      Object.defineProperty(globalThis, key, { value: undefined, writable: true, configurable: true });
    } else {
      // Best-effort fallback; may no-op in some environments.
      try { globalThis[key] = undefined; } catch { /* ignore */ }
    }
    globalThis.__resumeDisableImageBitmap = true;
  } catch { /* ignore */ }

  // We’re replacing tilt-to-move with an on-screen D-pad.
  try { globalThis.__resumeDisableTilt = true; } catch { /* ignore */ }

  const tool = new SceneTool();

  const ctx = {
    canvasHost,
    uiRoot: toolUi,
    log: (m) => { try { console.log('[resume]', m); } catch { /* ignore */ } },
    toast: (msg) => { try { console.log('[resume toast]', msg); } catch { /* ignore */ } },
    assetIndex: async () => [],
  };

  await tool.mount(ctx);

  // Mobile: bind on-screen arrows to Arrow key presses (reuses existing movement code).
  try {
    const mkEvt = (code) => ({
      code,
      key: code,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault() {},
      stopPropagation() {},
    });
    const bindHold = (el, code) => {
      if (!el) return;
      const down = (e) => {
        try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch { /* ignore */ }
        try { el.setPointerCapture?.(Number(e?.pointerId) || 0); } catch { /* ignore */ }
        try { tool._onKeyDown(mkEvt(code)); } catch { /* ignore */ }
      };
      const up = (e) => {
        try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch { /* ignore */ }
        try { tool._onKeyUp(mkEvt(code)); } catch { /* ignore */ }
      };
      try { el.addEventListener('pointerdown', down, { passive: false }); } catch { /* ignore */ }
      try { el.addEventListener('pointerup', up, { passive: false }); } catch { /* ignore */ }
      try { el.addEventListener('pointercancel', up, { passive: false }); } catch { /* ignore */ }
      try { el.addEventListener('pointerleave', up, { passive: false }); } catch { /* ignore */ }
    };
    bindHold(btnUp, 'ArrowUp');
    bindHold(btnDown, 'ArrowDown');
    bindHold(btnLeft, 'ArrowLeft');
    bindHold(btnRight, 'ArrowRight');
  } catch { /* ignore */ }

  // Hard guarantee: ensure we are actually in the interactive resume scene.
  // (In some dev shells, the SceneTool state can be clobbered; keep the export deterministic.)
  try {
    const cur = String(tool?._proc?.kind || '').toLowerCase();
    if (cur !== 'resume_showcase') {
      tool._state = tool._state || {};
      tool._state.sourceUrl = 'proc:resume_showcase';
      await tool._loadProcedural('proc:resume_showcase');
    }
  } catch { /* ignore */ }

  // Hard guarantee: ensure interaction triggers exist even if something clobbers scenario content.
  const ensureSeededInteractions = async () => {
    try {
      const cur = String(tool?._proc?.kind || '').toLowerCase();
      if (cur !== 'resume_showcase') return;
      const trigs = Array.isArray(tool?._scenarioContent?.triggers) ? tool._scenarioContent.triggers : [];
      if (trigs.length) return;
      await tool._seedResumeShowcaseContent?.({ scenario: null });
      // Nudge player near the console trigger so "Press E" is immediate.
      try {
        if (tool?._player) {
          tool._player.x = 0;
          tool._player.y = 0;
          tool._player.z = 9.4;
          tool._player.vy = 0;
        }
      } catch { /* ignore */ }
    } catch { /* ignore */ }
  };
  await ensureSeededInteractions();
  // Some async loaders can run after mount; re-check shortly after.
  try { setTimeout(() => { void ensureSeededInteractions(); }, 350); } catch { /* ignore */ }

  // Resume-only UX: surface the SceneTool “Press E: …” hints even though
  // we hide the devtools UI root.
  if (actionHint) {
    try {
      // Bind the tool's hint writer to our visible element.
      tool._ui = tool._ui || {};
      tool._ui.hintEl = actionHint;
    } catch { /* ignore */ }

    // Keep opacity in sync with text content (SceneTool only sets text).
    const syncHintVis = () => {
      const t = String(actionHint.textContent || '').trim();
      actionHint.style.opacity = t ? '1' : '0';
    };
    const obs = new MutationObserver(() => syncHintVis());
    try { obs.observe(actionHint, { childList: true, characterData: true, subtree: true }); } catch { /* ignore */ }
    syncHintVis();
  }

  let lastT = performance.now() * 0.001;
  const frame = () => {
    const t = performance.now() * 0.001;
    const dt = Math.max(0, Math.min(0.25, t - lastT));
    lastT = t;
    try { tool.tick(dt); } catch (e) { try { console.error(e); } catch { /* ignore */ } }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  window.addEventListener('beforeunload', () => {
    try { tool.unmount?.(); } catch { /* ignore */ }
  });
}

main().catch((e) => {
  try { console.error(e); } catch { /* ignore */ }
});

