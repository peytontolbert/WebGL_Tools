import { Schema, MapSchema, defineTypes, filterChildren } from '@colyseus/schema';

export class PlayerState extends Schema {
  constructor() {
    super();
    this.x = 0;
    this.y = 0;
    this.yaw = 0;
  }
}

defineTypes(PlayerState, {
  x: 'number',
  y: 'number',
  yaw: 'number',
});

export class CityState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
    // Server-side interest radius (meters). Clients will only receive players within this distance.
    this.interestRadius = 2000;
  }
}

defineTypes(CityState, {
  players: { map: PlayerState },
  interestRadius: 'number',
});

// Interest management: only sync nearby players to each client.
// This is critical for MMO scale: clients shouldn't even *receive* far-away entities.
filterChildren((client, key, value, root) => {
  try {
    const sid = String(client?.sessionId || '');
    const otherId = String(key || '');
    if (!sid || !otherId) return false;
    // Always send self.
    if (otherId === sid) return true;

    const me = root?.players?.get?.(sid) || null;
    // If we don't have a reference point yet, allow through (avoids "empty world" on initial join).
    if (!me) return true;

    const r = Math.max(1, Number(root?.interestRadius) || 2000);
    const r2 = r * r;
    const dx = (Number(value?.x) || 0) - (Number(me?.x) || 0);
    const dy = (Number(value?.y) || 0) - (Number(me?.y) || 0);
    return (dx * dx + dy * dy) <= r2;
  } catch {
    // Fail open (gameplay > optimization) if anything goes wrong.
    return true;
  }
})(CityState.prototype, 'players');

