import * as THREE from 'three';

export function normAnimName(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[-_.:]/g, '');
}

export function clipByAliases(clips, aliases) {
  if (!Array.isArray(clips) || clips.length === 0) return null;
  const byNorm = new Map();
  for (const c of clips) {
    if (!c?.name) continue;
    byNorm.set(normAnimName(c.name), c);
  }
  const want = Array.isArray(aliases) ? aliases : [];
  for (const a of want) {
    const hit = byNorm.get(normAnimName(a));
    if (hit) return hit;
  }
  for (const a of want) {
    const key = normAnimName(a);
    if (!key) continue;
    for (const [nn, clip] of byNorm.entries()) {
      if (nn.includes(key)) return clip;
    }
  }
  return null;
}

const DEFAULT_CHARACTER_ACTION_ALIASES = {
  idle: ['idle', 'stand', 'rest'],
  walk_fwd: ['walk_fwd', 'walkfwd', 'walkforward', 'walk_forward', 'walk'],
  walk_back: ['walk_back', 'walkback', 'walkbackward', 'walk_backward'],
  walk_left: ['walk_left', 'walkleft', 'strafeleft', 'strafe_left'],
  walk_right: ['walk_right', 'walkright', 'straferight', 'strafe_right'],
  run_fwd: ['run_fwd', 'runfwd', 'runforward', 'run_forward', 'run', 'jog', 'sprint'],
  run_back: ['run_back', 'runback', 'runbackward', 'run_backward'],
  run_left: ['run_left', 'runleft', 'run_strafeleft'],
  run_right: ['run_right', 'runright', 'run_straferight'],
  turn_left: ['turn_left', 'turnleft', 'turn_l', 'turn_l_45', 'turn_l_90', 'rotate_left'],
  turn_right: ['turn_right', 'turnright', 'turn_r', 'turn_r_45', 'turn_r_90', 'rotate_right'],
  jump_start: ['jump_start', 'jumpstart', 'jump_takeoff', 'takeoff', 'jump'],
  jump_air: ['jump_air', 'jumpair', 'inair', 'air', 'fall'],
  jump_land: ['jump_land', 'jumpland', 'land', 'landing'],
};

export const CHARACTER_ACTION_KEYS = Object.freeze(Object.keys(DEFAULT_CHARACTER_ACTION_ALIASES));

function safeTrim(s) { return String(s ?? '').trim(); }

export function buildCharacterActionAliases(profileData = null) {
  const out = {};
  for (const [k, aliases] of Object.entries(DEFAULT_CHARACTER_ACTION_ALIASES)) out[k] = aliases.slice();
  const p = (profileData && typeof profileData === 'object') ? profileData : null;
  const actionMap = (p?.actions && typeof p.actions === 'object') ? p.actions : {};
  const slots = (p?.slots && typeof p.slots === 'object') ? p.slots : {};
  for (const [key, baseAliases] of Object.entries(out)) {
    const merged = Array.isArray(baseAliases) ? baseAliases.slice() : [];
    const explicit = actionMap?.[key];
    if (Array.isArray(explicit)) {
      for (const a of explicit) {
        const s = safeTrim(a);
        if (s) merged.push(s);
      }
    }
    const motionClip = safeTrim(slots?.[key]?.motionClip || '');
    if (motionClip) merged.push(motionClip);
    if (key) merged.unshift(key);
    out[key] = Array.from(new Set(merged.map((s) => safeTrim(s)).filter(Boolean)));
  }
  return out;
}

export function computeAutoGroundYOffset(root) {
  // Returns a Y offset that moves the lowest mesh point to y=0.
  // Helpful for GLBs whose origin is at hips/center instead of feet.
  if (!root) return 0.0;
  const lower = (s) => String(s || '').trim().toLowerCase();
  const isBackground = (n) => {
    const name = lower(n?.name);
    return !!name && (name === 'background' || name.includes('background'));
  };
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  let has = false;
  try {
    root.traverse?.((n) => {
      if (!n) return;
      if (isBackground(n)) return;
      if (!(n.isMesh || n.isSkinnedMesh)) return;
      try {
        tmp.setFromObject(n);
        if (!Number.isFinite(tmp.min.y)) return;
        if (!has) { box.copy(tmp); has = true; }
        else box.union(tmp);
      } catch { /* ignore */ }
    });
  } catch { /* ignore */ }
  if (!has || !Number.isFinite(box.min.y)) return 0.0;
  return -box.min.y;
}
