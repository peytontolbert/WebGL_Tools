/**
 * Single source of truth for Room Sim (Penthouse) defaults.
 *
 * Used by:
 * - Map creation (`MapStore`) so new Room Sim maps match the building asset defaults.
 * - Runtime (`EditorApp`) for NPC pathing / hall rect computation fallbacks.
 * - Devtools Scene penthouse procedural fallback (if the building JSON is missing).
 */

export const ROOM_SIM_PENTHOUSE_BUILDING_ASSET_PATH = 'assets/buildings/room_sim_penthouse.json';

export const DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS = Object.freeze({
  kind: 'proc:penthouse_room_sim',
  rows: 5,
  cols: 5,
  // Private character suites (each gets bath + closet + bedroom + lounge + desk + decor).
  // Bigger than the original so each character has real breathing room.
  roomW: 11.5,
  roomD: 10.5,
  // Internal suite hallways: ensures all 25 suites are reachable via corridors
  // (no walking "through" someone else's room to get anywhere).
  suiteHallW: 3.0,
  // Spine + public hall (amenities + lounge + kitchen + full-height glass).
  corridorD: 4.2,
  hallW: 98.0,
  // Construction.
  wallT: 0.25,
  wallH: 4.2,
  // Doors.
  doorW: 0.95,
  hallDoorW: 6.0,
  // Co-work grid (kept smaller; the penthouse is suite-first now).
  deskRows: 3,
  deskCols: 4,
  deskPadX: 4.6,
  deskPadY: 4.2,
});

export function mergeRoomSimPenthouseParams(overrides) {
  const o = (overrides && typeof overrides === 'object') ? overrides : {};
  // Be tolerant: building JSON may omit some keys or store them as strings.
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const int = (v, d) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? n : d;
  };
  return {
    ...DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS,
    kind: String(o.kind || DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS.kind),
    rows: int(o.rows, DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS.rows),
    cols: int(o.cols, DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS.cols),
    roomW: num(o.roomW, DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS.roomW),
    roomD: num(o.roomD, DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS.roomD),
    suiteHallW: num(o.suiteHallW, DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS.suiteHallW),
    corridorD: num(o.corridorD, DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS.corridorD),
    hallW: num(o.hallW, DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS.hallW),
    wallT: num(o.wallT, DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS.wallT),
    wallH: num(o.wallH, DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS.wallH),
    doorW: num(o.doorW, DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS.doorW),
    hallDoorW: num(o.hallDoorW, DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS.hallDoorW),
    deskRows: int(o.deskRows, DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS.deskRows),
    deskCols: int(o.deskCols, DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS.deskCols),
    deskPadX: num(o.deskPadX, DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS.deskPadX),
    deskPadY: num(o.deskPadY, DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS.deskPadY),
  };
}

