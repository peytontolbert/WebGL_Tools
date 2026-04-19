import { createStartScreen } from './ui/start_screen.js';
import { EditorApp } from './runtime/editor_app.js';
import { MapStore } from './runtime/map_store.js';

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('glCanvas'));
const uiRoot = /** @type {HTMLDivElement} */ (document.getElementById('uiRoot'));

if (!canvas || !uiRoot) {
  throw new Error('Missing #glCanvas or #uiRoot');
}

function resizeCanvasToDisplaySize(canvasEl, maxDpr = 2.0) {
  const dpr = Math.min(maxDpr, window.devicePixelRatio || 1);
  const rect = canvasEl.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (canvasEl.width !== w || canvasEl.height !== h) {
    canvasEl.width = w;
    canvasEl.height = h;
    return true;
  }
  return false;
}

/** @type {EditorApp|null} */
let app = null;

const store = new MapStore();

const start = createStartScreen({
  root: uiRoot,
  store,
  onLoadMap: async (mapId) => {
    const map = store.loadMap(mapId);
    if (!map) return;
    start.hide();
    if (app) {
      try { app.dispose(); } catch { /* ignore */ }
      app = null;
    }
    app = new EditorApp(canvas, uiRoot, store);
    await app.loadMap(map);
  },
  onCreateNew: async (templateId) => {
    const map = store.createMapFromTemplate(templateId);
    start.hide();
    if (app) {
      try { app.dispose(); } catch { /* ignore */ }
      app = null;
    }
    app = new EditorApp(canvas, uiRoot, store);
    await app.loadMap(map);
  },
});

start.show();

function frame() {
  resizeCanvasToDisplaySize(canvas, 2.0);
  if (app) app.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener('keydown', (e) => {
  // Escape returns to map chooser (keeps map saved).
  if (e.key === 'Escape') {
    if (app) {
      try { app.requestAutosave(); } catch { /* ignore */ }
      try { app.dispose(); } catch { /* ignore */ }
      app = null;
    }
    start.refresh();
    start.show();
  }
});

// Handy DevTools hooks
globalThis.__editorStore = store;
globalThis.__editorApp = () => app;


