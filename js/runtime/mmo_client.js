import * as Colyseus from 'colyseus.js';

function nowMs() {
  try { return (globalThis.performance && performance.now) ? performance.now() : Date.now(); } catch { return Date.now(); }
}

/**
 * Thin wrapper around Colyseus for a GTA-like "city shard" room.
 * - Sends compact input messages (bitmask + yaw).
 * - Maintains a local cache of remote player transforms for rendering.
 */
export class MmoClient {
  constructor({
    endpoint = 'ws://127.0.0.1:2567',
    roomName = 'city',
    sendRateHz = 20,
    onStatus = null,
  } = {}) {
    this.endpoint = String(endpoint || '').trim() || 'ws://127.0.0.1:2567';
    this.roomName = String(roomName || '').trim() || 'city';
    this.sendRateHz = Math.max(1, Number(sendRateHz) || 20);
    this.onStatus = (typeof onStatus === 'function') ? onStatus : null;

    /** @type {import('colyseus.js').Client|null} */
    this.client = null;
    /** @type {import('colyseus.js').Room|null} */
    this.room = null;

    this.status = 'disconnected'; // disconnected | connecting | connected | error
    this.lastError = '';
    this.sessionId = '';

    // sessionId -> { x, y, yaw, updatedAtMs }
    this.players = new Map();

    this._lastSendMs = 0;
  }

  _setStatus(status, err = '') {
    this.status = status;
    this.lastError = String(err || '');
    if (typeof this.onStatus === 'function') {
      try { this.onStatus(this.status, this.lastError); } catch { /* ignore */ }
    }
  }

  get connected() {
    return this.status === 'connected' && !!this.room;
  }

  async connect() {
    if (this.connected) return true;
    this.disconnect();
    this._setStatus('connecting');
    try {
      this.client = new Colyseus.Client(this.endpoint);
      this.room = await this.client.joinOrCreate(this.roomName, {});
      this.sessionId = String(this.room.sessionId || '');

      // Reset cache; server will stream current state via schema.
      this.players.clear();

      // Schema state listeners (players MapSchema)
      const state = this.room.state;
      if (state?.players) {
        state.players.onAdd = (p, id) => {
          const sid = String(id || '');
          if (!sid) return;
          const obj = { x: Number(p?.x) || 0, y: Number(p?.y) || 0, yaw: Number(p?.yaw) || 0, updatedAtMs: nowMs() };
          this.players.set(sid, obj);
          try {
            p.onChange = () => {
              const cur = this.players.get(sid);
              if (!cur) return;
              cur.x = Number(p?.x) || 0;
              cur.y = Number(p?.y) || 0;
              cur.yaw = Number(p?.yaw) || 0;
              cur.updatedAtMs = nowMs();
            };
          } catch { /* ignore */ }
        };
        state.players.onRemove = (_p, id) => {
          const sid = String(id || '');
          if (!sid) return;
          this.players.delete(sid);
        };
      }

      this.room.onLeave((code) => {
        this._setStatus('disconnected', `left (${code})`);
        try { this.players.clear(); } catch { /* ignore */ }
        this.room = null;
        this.client = null;
        this.sessionId = '';
      });
      this.room.onError((code, message) => {
        this._setStatus('error', `${code}: ${String(message || '')}`);
      });

      this._setStatus('connected');
      return true;
    } catch (e) {
      this._setStatus('error', e?.message || String(e));
      return false;
    }
  }

  disconnect() {
    try { if (this.room) this.room.leave(true); } catch { /* ignore */ }
    this.room = null;
    this.client = null;
    this.sessionId = '';
    try { this.players.clear(); } catch { /* ignore */ }
    this._setStatus('disconnected');
  }

  /**
   * Request a server-side spawn position (meters, same XY space as the client map).
   */
  spawnAt(x, y) {
    if (!this.connected || !this.room) return;
    try { this.room.send('spawn', { x: Number(x) || 0, y: Number(y) || 0 }); } catch { /* ignore */ }
  }

  /**
   * Send input at a fixed rate.
   * @param {number} tNowMs
   * @param {{ mask: number, yaw: number }} input
   */
  tick(tNowMs, input) {
    if (!this.connected || !this.room) return;
    const t = Number(tNowMs);
    if (!Number.isFinite(t)) return;
    const minDt = 1000.0 / Math.max(1, this.sendRateHz);
    if ((t - (this._lastSendMs || 0)) < (minDt - 0.5)) return;
    this._lastSendMs = t;
    const mask = (input?.mask >>> 0);
    const yaw = Number(input?.yaw) || 0;
    try { this.room.send('input', { mask, yaw }); } catch { /* ignore */ }
  }

  /**
   * @returns {{ id: string, x: number, y: number, yaw: number, updatedAtMs: number }[]}
   */
  listPlayers() {
    const out = [];
    for (const [id, p] of this.players.entries()) {
      out.push({
        id,
        x: Number(p?.x) || 0,
        y: Number(p?.y) || 0,
        yaw: Number(p?.yaw) || 0,
        updatedAtMs: Number(p?.updatedAtMs) || 0,
      });
    }
    return out;
  }
}

