import { Room } from '@colyseus/core';
import { CityState, PlayerState } from '../state/CityState.js';
import { clamp, expApproach } from '../util/math.js';

function randSpawn(r = 30) {
  const a = Math.random() * Math.PI * 2;
  const d = Math.sqrt(Math.random()) * r;
  return { x: Math.cos(a) * d, y: Math.sin(a) * d };
}

// Input bitmask (kept in sync with client)
const IN_W = 1 << 0;
const IN_A = 1 << 1;
const IN_S = 1 << 2;
const IN_D = 1 << 3;
const IN_RUN = 1 << 4;

export class CityRoom extends Room {
  onCreate() {
    this.setState(new CityState());
    // Allow overriding interest radius per room (meters).
    try {
      const rr = Number(this.options?.interestRadius || 0);
      if (Number.isFinite(rr) && rr > 0) this.state.interestRadius = rr;
    } catch { /* ignore */ }

    // Non-schema sim state (authoritative).
    /** @type {Map<string, { vx: number, vy: number, mask: number, yaw: number }>} */
    this._sim = new Map();

    // 20 Hz tick keeps CPU/network reasonable for a starter MMO.
    this.setSimulationInterval((dtMs) => this._step(dtMs / 1000), 50);

    this.onMessage('input', (client, msg) => {
      const sid = String(client?.sessionId || '');
      const s = this._sim.get(sid);
      if (!s) return;
      const mask = (Number(msg?.mask) >>> 0);
      const yaw = Number(msg?.yaw) || 0;
      s.mask = mask;
      s.yaw = yaw;
      const p = this.state.players.get(sid);
      if (p) p.yaw = yaw;
    });

    this.onMessage('spawn', (client, msg) => {
      const sid = String(client?.sessionId || '');
      const p = this.state.players.get(sid);
      if (!p) return;
      const x = clamp(Number(msg?.x) || 0, -1e9, 1e9);
      const y = clamp(Number(msg?.y) || 0, -1e9, 1e9);
      p.x = x;
      p.y = y;
      const s = this._sim.get(sid);
      if (s) { s.vx = 0; s.vy = 0; }
    });
  }

  onJoin(client) {
    const sid = String(client.sessionId || '');
    const p = new PlayerState();
    const sp = randSpawn(60);
    p.x = sp.x;
    p.y = sp.y;
    p.yaw = 0;
    this.state.players.set(sid, p);
    this._sim.set(sid, { vx: 0, vy: 0, mask: 0, yaw: 0 });
  }

  onLeave(client) {
    const sid = String(client?.sessionId || '');
    try { this.state.players.delete(sid); } catch { /* ignore */ }
    try { this._sim.delete(sid); } catch { /* ignore */ }
  }

  _step(dt) {
    const t = Math.max(0, Math.min(0.25, Number(dt) || 0));
    if (!t) return;

    // Movement "feel" roughly matches the client controller (but doesn't include terrain collision).
    const walkSpeed = 10.0;
    const runSpeed = 18.0;
    const accel = 42.0;
    const decel = 28.0;

    for (const [sid, p] of this.state.players.entries()) {
      const s = this._sim.get(sid);
      if (!s) continue;

      const mask = (s.mask >>> 0);
      const run = !!(mask & IN_RUN);
      const speed = run ? runSpeed : walkSpeed;

      // Forward from yaw (XZ plane); we simulate in (x,y) meters, matching the client "data space".
      const yaw = Number(s.yaw) || 0;
      const fx = Math.sin(yaw);
      const fy = Math.cos(yaw);
      const rx = fy;
      const ry = -fx;

      let mx = 0;
      let my = 0;
      if (mask & IN_W) { mx += fx; my += fy; }
      if (mask & IN_S) { mx -= fx; my -= fy; }
      if (mask & IN_D) { mx += rx; my += ry; }
      if (mask & IN_A) { mx -= rx; my -= ry; }

      const ml = Math.hypot(mx, my);
      const hasMove = ml > 1e-6;
      if (hasMove) { mx /= ml; my /= ml; }

      const targetVx = hasMove ? (mx * speed) : 0;
      const targetVy = hasMove ? (my * speed) : 0;
      const k = hasMove ? accel : decel;

      s.vx = expApproach(Number(s.vx) || 0, targetVx, k, t);
      s.vy = expApproach(Number(s.vy) || 0, targetVy, k, t);

      p.x = (Number(p.x) || 0) + s.vx * t;
      p.y = (Number(p.y) || 0) + s.vy * t;
    }
  }
}

