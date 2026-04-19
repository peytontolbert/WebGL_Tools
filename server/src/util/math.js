export function clamp(v, lo, hi) {
  const x = Number(v);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

export function expApproach(cur, target, k, dt) {
  const t = Math.max(0, Number(dt) || 0);
  const kk = Math.max(0, Number(k) || 0);
  const a = 1.0 - Math.exp(-kk * t);
  return cur + (target - cur) * a;
}

