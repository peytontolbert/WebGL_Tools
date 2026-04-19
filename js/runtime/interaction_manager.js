import { el, clear } from '../ui/dom.js';

function clamp(x, lo, hi) {
  const n = Number(x) || 0;
  return Math.max(lo, Math.min(hi, n));
}

function normDeg360(deg) {
  const d = Number(deg) || 0;
  return ((d % 360) + 360) % 360;
}

function yawRadFromDeg(deg) {
  return (normDeg360(deg) * Math.PI) / 180;
}

function rotate2(x, y, yawRad) {
  const c = Math.cos(Number(yawRad) || 0);
  const s = Math.sin(Number(yawRad) || 0);
  return { x: x * c - y * s, y: x * s + y * c };
}

/**
 * @typedef {{
 *   id: string,
 *   type: 'chair'|'bed'|'tv',
 *   x: number,
 *   y: number,
 *   z: number,
 *   yawDeg: number,
 *   radius: number,
 *   meta: any,
 * }} Interactable
 */

/**
 * @param {any[]} instances
 * @returns {Interactable[]}
 */
export function buildInteractablesFromInstances(instances) {
  const inst = Array.isArray(instances) ? instances : [];
  /** @type {Interactable[]} */
  const out = [];
  for (let i = 0; i < inst.length; i++) {
    const it = inst[i] || {};
    const kind = String(it.kind || '');
    if (kind !== 'room_chair' && kind !== 'room_bed' && kind !== 'room_tv') continue;
    const id = String(it.id || '');
    const pos = it.pos || [0, 0, 0];
    const x = Number(pos[0]) || 0;
    const y = Number(pos[1]) || 0;
    const z = Number(pos[2]) || 0;
    const yawDeg = Number(it.yawDeg) || 0;
    const meta = (it.meta && typeof it.meta === 'object') ? it.meta : {};
    const sx = Number(meta.sx) || 1;
    const sz = Number(meta.sz) || 1;
    const baseR = Math.max(0.9, Math.max(Math.abs(sx), Math.abs(sz)) * 0.60);
    const radius = clamp(meta.interactRadius, 0.9, 3.5) || clamp(baseR, 0.9, 3.5);
    const type = (kind === 'room_bed') ? 'bed' : (kind === 'room_tv') ? 'tv' : 'chair';
    out.push({ id, type, x, y, z, yawDeg, radius, meta });
  }
  return out;
}

export class InteractionManager {
  /**
   * @param {{ app: any }} cfg
   */
  constructor(cfg) {
    this.app = cfg?.app;

    /** @type {Interactable[]} */
    this.interactables = [];
    /** @type {Interactable|null} */
    this.target = null;

    this._prevKeys = new Set();

    // HUD elements (lazy-built).
    this._hudPromptEl = null;
    this._tvPanelEl = null;
    this._tvTextEl = null;

    // TV state
    /** @type {Map<string, boolean>} */
    this._tvOn = new Map();
    this._tvActiveId = '';
    this._tvLines = [];
    this._tvGame = { mode: 'menu', secret: 0, tries: 0 };

    // Lightweight external hook for agent controllers running in-page.
    // Usage:
    // - `window.__interact(id)` to toggle/sit/lay/watch (same as pressing E near it)
    // - `window.__tvKey('Digit1')` to send TV menu/game keys
    try {
      globalThis.__interact = (id) => {
        const sid = String(id || '');
        const it = this.interactables.find((x) => String(x.id || '') === sid) || null;
        if (!it) return false;
        if (it.type === 'chair') this._beginSit(it);
        else if (it.type === 'bed') this._beginLay(it);
        else if (it.type === 'tv') this._toggleTv(it);
        return true;
      };
      globalThis.__tvKey = (code) => this._handleTvKey(String(code || ''));
    } catch { /* ignore */ }
  }

  /**
   * @param {HTMLElement} uiRoot
   */
  ensureUi(uiRoot) {
    if (!uiRoot) return;
    if (!this._hudPromptEl) {
      this._hudPromptEl = /** @type {HTMLDivElement} */ (el('div', {
        id: 'hudInteractPrompt',
        style: {
          position: 'fixed',
          left: '50%',
          bottom: '24px',
          transform: 'translateX(-50%)',
          padding: '10px 12px',
          borderRadius: '10px',
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial',
          fontSize: '13px',
          letterSpacing: '0.2px',
          color: '#e7eefc',
          background: 'rgba(12,18,28,0.78)',
          border: '1px solid rgba(150,175,210,0.18)',
          boxShadow: '0 10px 22px rgba(0,0,0,0.35)',
          display: 'none',
          pointerEvents: 'none',
          zIndex: '50',
          whiteSpace: 'nowrap',
        },
      }, []));
      uiRoot.appendChild(this._hudPromptEl);
    }
    if (!this._tvPanelEl) {
      this._tvPanelEl = /** @type {HTMLDivElement} */ (el('div', {
        id: 'tvPanel',
        style: {
          position: 'fixed',
          right: '18px',
          bottom: '18px',
          width: '380px',
          maxWidth: 'calc(100vw - 36px)',
          maxHeight: '46vh',
          overflow: 'auto',
          padding: '12px',
          borderRadius: '12px',
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial',
          fontSize: '12px',
          color: '#e7eefc',
          background: 'rgba(7,10,16,0.86)',
          border: '1px solid rgba(150,175,210,0.18)',
          boxShadow: '0 12px 26px rgba(0,0,0,0.45)',
          display: 'none',
          zIndex: '60',
        },
      }, []));
      this._tvTextEl = /** @type {HTMLPreElement} */ (el('pre', {
        style: {
          margin: '0',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          lineHeight: '1.35',
        },
      }, []));
      this._tvPanelEl.appendChild(this._tvTextEl);
      uiRoot.appendChild(this._tvPanelEl);
    }
  }

  /**
   * @param {Interactable[]} items
   */
  setInteractables(items) {
    this.interactables = Array.isArray(items) ? items : [];
  }

  _justPressed(keys, code) {
    return keys.has(code) && !this._prevKeys.has(code);
  }

  _pushEvent(evt) {
    // 1) Local HUD log
    try {
      globalThis.__gameEvents = Array.isArray(globalThis.__gameEvents) ? globalThis.__gameEvents : [];
      globalThis.__gameEvents.push({ t: Date.now(), ...evt });
      if (globalThis.__gameEvents.length > 200) globalThis.__gameEvents.splice(0, globalThis.__gameEvents.length - 200);
      globalThis.__lastGameEvent = evt;
    } catch { /* ignore */ }
    // 2) DOM event for external agent/controller hooks
    try {
      window.dispatchEvent(new CustomEvent('game:interaction', { detail: evt }));
    } catch { /* ignore */ }
  }

  _setHudPrompt(text) {
    const eln = this._hudPromptEl;
    if (!eln) return;
    if (!text) {
      eln.style.display = 'none';
      eln.textContent = '';
      return;
    }
    eln.style.display = 'block';
    eln.textContent = text;
  }

  _tvWrite(line) {
    const s = String(line || '');
    if (!s) return;
    this._tvLines.push(s);
    if (this._tvLines.length > 40) this._tvLines.splice(0, this._tvLines.length - 40);
    if (this._tvTextEl) this._tvTextEl.textContent = this._tvLines.join('\n');
  }

  _tvShow(show) {
    if (this._tvPanelEl) this._tvPanelEl.style.display = show ? 'block' : 'none';
  }

  _tvResetToMenu() {
    this._tvGame.mode = 'menu';
    this._tvLines.length = 0;
    this._tvWrite('TV Console (text-based)');
    this._tvWrite('1) News  2) Weather  3) Guessing Game  4) Help');
    this._tvWrite('Press number keys. Press E again to stop watching.');
  }

  _setTvScreenOn(tvId, on) {
    const app = this.app;
    const inst = app?.map?.data?.instances;
    if (!Array.isArray(inst)) return;
    const screenId = `${String(tvId || '')}_screen`;
    for (let i = 0; i < inst.length; i++) {
      const it = inst[i];
      if (!it || String(it.id || '') !== screenId) continue;
      const col = on ? [0.65, 0.85, 1.0, 1.0] : [0.06, 0.07, 0.09, 1.0];
      it.color = col;
      break;
    }
    try { app?._rebuildInstanceBuffer?.(); } catch { /* ignore */ }
  }

  _toggleTv(tv) {
    const tvId = String(tv?.id || '');
    if (!tvId) return;
    const cur = !!this._tvOn.get(tvId);
    const next = !cur;
    this._tvOn.set(tvId, next);
    this._tvActiveId = next ? tvId : '';
    this._setTvScreenOn(tvId, next);
    this._pushEvent({ kind: 'tv', id: tvId, on: next, at: { x: tv.x, y: tv.y } });
    if (next) {
      this._tvResetToMenu();
      this._tvShow(true);
    } else {
      this._tvShow(false);
    }
  }

  _beginSit(chair) {
    const app = this.app;
    const p = app?.player;
    if (!p?.beginInteraction) return;
    const yawRad = yawRadFromDeg(chair?.yawDeg || 0);
    // Sit a little "behind" the chair so we aren't intersecting the backrest.
    const o = rotate2(0, -0.55, yawRad);
    const ax = (chair.x + o.x);
    const ay = (chair.y + o.y);
    p.beginInteraction({ mode: 'sit', x: ax, y: ay, yawRad });
    try { p._applyWallCollision?.(); } catch { /* ignore */ }
    this._pushEvent({ kind: 'sit', id: String(chair.id || ''), at: { x: ax, y: ay } });
  }

  _beginLay(bed) {
    const app = this.app;
    const p = app?.player;
    if (!p?.beginInteraction) return;
    const yawRad = yawRadFromDeg(bed?.yawDeg || 0);
    // Lay near center, slightly toward "foot" so camera isn't inside a wall.
    const o = rotate2(0, -0.35, yawRad);
    const ax = (bed.x + o.x);
    const ay = (bed.y + o.y);
    p.beginInteraction({ mode: 'lay', x: ax, y: ay, yawRad });
    try { p._applyWallCollision?.(); } catch { /* ignore */ }
    this._pushEvent({ kind: 'lay', id: String(bed.id || ''), at: { x: ax, y: ay } });
  }

  _stopInteraction() {
    const p = this.app?.player;
    try { p?.endInteraction?.(); } catch { /* ignore */ }
    this._tvShow(false);
    this._tvActiveId = '';
    this._pushEvent({ kind: 'stop_interaction' });
  }

  _handleTvKey(code) {
    if (!this._tvActiveId) return false;
    if (code === 'Digit4') {
      this._tvWrite('');
      this._tvWrite('Help:');
      this._tvWrite('- 1 News: headlines');
      this._tvWrite('- 2 Weather: forecast');
      this._tvWrite('- 3 Guessing Game: guess 1-5');
      this._tvWrite('- Press E to exit watching');
      return true;
    }
    if (code === 'Digit1') {
      this._tvWrite('');
      this._tvWrite('[NEWS] Penthouse wing opens: 25 bespoke suites, zero shared bedrooms.');
      this._tvWrite('[NEWS] Markets: GPU instances up, wall yaw bugs down.');
      return true;
    }
    if (code === 'Digit2') {
      this._tvWrite('');
      this._tvWrite('[WEATHER] Clear skies. Interior: warm indirect lighting, mild synthwave ambience.');
      return true;
    }
    if (code === 'Digit3') {
      this._tvWrite('');
      this._tvWrite('[GAME] Guessing Game: I picked a number 1-5. Press 1-5.');
      this._tvGame.mode = 'guess';
      this._tvGame.secret = 1 + Math.floor(Math.random() * 5);
      this._tvGame.tries = 0;
      return true;
    }
    if (this._tvGame.mode === 'guess') {
      if (code === 'Digit1' || code === 'Digit2' || code === 'Digit3' || code === 'Digit4' || code === 'Digit5') {
        const g = Number(code.slice(-1)) || 0;
        this._tvGame.tries++;
        if (g === this._tvGame.secret) {
          this._tvWrite(`[GAME] Correct. You got it in ${this._tvGame.tries} tries.`);
          this._tvGame.mode = 'menu';
          this._tvWrite('Back to menu: 1) News  2) Weather  3) Guessing Game  4) Help');
        } else {
          this._tvWrite(`[GAME] Nope (${g}). Try again.`);
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Called every frame from EditorApp.
   * @param {number} nowMs
   * @param {number} dt
   */
  tick(nowMs, dt) {
    void nowMs; void dt;
    const app = this.app;
    if (!app || !app.gameplayEnabled) {
      this._setHudPrompt('');
      this._tvShow(false);
      this._prevKeys = new Set(app?._keys ? Array.from(app._keys) : []);
      return;
    }

    // Ensure UI exists once gameplay is active.
    try { this.ensureUi(app.uiRoot || document.body); } catch { /* ignore */ }

    const keys = app._keys || new Set();
    const player = app.player;
    if (!player?.enabled) {
      this._setHudPrompt('');
      this._prevKeys = new Set(keys);
      return;
    }

    // Find nearest interactable in range.
    const px = Number(player.pos?.x) || 0;
    const py = Number(player.pos?.y) || 0;
    /** @type {Interactable|null} */
    let best = null;
    let bestD2 = Infinity;
    for (let i = 0; i < this.interactables.length; i++) {
      const it = this.interactables[i];
      const dx = px - it.x;
      const dy = py - it.y;
      const d2 = dx * dx + dy * dy;
      const r = Math.max(0.5, Number(it.radius) || 1.2);
      if (d2 <= r * r && d2 < bestD2) { best = it; bestD2 = d2; }
    }
    this.target = best;

    // TV overlay hotkeys (only when TV is on).
    if (this._tvActiveId) {
      for (const k of ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5']) {
        if (this._justPressed(keys, k)) this._handleTvKey(k);
      }
    }

    const interacting = !!player.isInteracting?.();
    if (interacting) {
      this._setHudPrompt('E: Stop interacting');
    } else if (best) {
      const label = (best.type === 'bed') ? 'Lay down'
        : (best.type === 'chair') ? 'Sit'
          : 'Watch TV';
      this._setHudPrompt(`E: ${label}`);
    } else {
      this._setHudPrompt('');
    }

    // Use key (E)
    if (this._justPressed(keys, 'KeyE')) {
      if (interacting) {
        this._stopInteraction();
      } else if (best) {
        if (best.type === 'chair') this._beginSit(best);
        else if (best.type === 'bed') this._beginLay(best);
        else if (best.type === 'tv') {
          // Watching TV is an interaction lock + TV menu.
          try {
            const yawRad = yawRadFromDeg(best.yawDeg || 0);
            const o = rotate2(0.9, 0, yawRad); // stand a bit in front of the screen
            player.beginInteraction?.({ mode: 'watch', x: best.x + o.x, y: best.y + o.y, yawRad });
          } catch { /* ignore */ }
          this._toggleTv(best);
        }
      }
    }

    // Store previous key snapshot for edge detection.
    this._prevKeys = new Set(keys);
  }
}

