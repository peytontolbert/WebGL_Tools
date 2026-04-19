function clamp01(x) { return Math.max(0, Math.min(1, Number(x) || 0)); }
function clamp(x, a, b) { return Math.max(a, Math.min(b, Number(x) || 0)); }

/**
 * Converts discrete input + speed into sim controls.
 *
 * Conventions:
 * - `steer` is left-positive in [-1,1] (matches current scene tool + chrono sims)
 * - `throttle` is magnitude in [0,1] (gear indicates sign for JS backend; WASM uses gear separately)
 * - `brake` is [0,1]
 *
 * @param {{
 *  driveType?: 'wheeled'|'hover',
 *  forward?: number,
 *  back?: number,
 *  left?: number,
 *  right?: number,
 *  speedRef?: number
 * }} params
 * @returns {{throttle:number, brake:number, gear:number, steer:number}}
 */
export function computeVehicleControls(params) {
  const driveType = (String(params?.driveType || 'wheeled').trim().toLowerCase() === 'hover') ? 'hover' : 'wheeled';
  const forward = (Number(params?.forward) || 0) ? 1 : 0;
  const back = (Number(params?.back) || 0) ? 1 : 0;
  const left = (Number(params?.left) || 0) ? 1 : 0;
  const right = (Number(params?.right) || 0) ? 1 : 0;
  const steer = clamp(left - right, -1, 1);

  const spd = Number(params?.speedRef);
  const speedRef = Number.isFinite(spd) ? spd : 0;

  let throttle = 0;
  let brake = 0;
  let gear = 1;

  if (driveType === 'hover') {
    // Hovercraft-like: direct signed thrust instead of car-style brake/gear logic.
    throttle = clamp(forward - back, -1, 1);
    brake = 0;
    gear = (throttle < 0) ? -1 : 1;
    return { throttle, brake, gear, steer };
  }

  // Realistic-ish mapping with gears:
  // - W selects drive, then throttle forward (or brakes if currently rolling backward).
  // - S brakes while moving forward; once nearly stopped, selects reverse and throttles.
  if (forward && !back) {
    gear = 1;
    if (speedRef < -0.6) { brake = 1.0; throttle = 0; }
    else { throttle = 1.0; brake = 0; }
  } else if (back && !forward) {
    if (speedRef > 0.8) {
      gear = 1;
      brake = 1.0;
      throttle = 0;
    } else {
      gear = -1;
      brake = 0;
      throttle = 0.75;
    }
  } else {
    throttle = 0;
    brake = 0;
    gear = 1;
  }

  return { throttle: clamp01(throttle), brake: clamp01(brake), gear: (gear < 0 ? -1 : 1), steer };
}

