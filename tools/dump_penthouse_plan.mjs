import { buildRoomSimPenthouseLayout } from '../js/shared/room_sim_penthouse_layout.js';
import { DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS } from '../js/shared/room_sim_penthouse_defaults.js';
import { planToAscii } from '../js/shared/plan_grid.js';

const out = buildRoomSimPenthouseLayout({ ...DEFAULT_ROOM_SIM_PENTHOUSE_PARAMS });
const plan = out.plan;

if (!plan) {
  console.error('No plan found on layout output.');
  process.exit(1);
}

// Legend: keep it human-editable.
const legend = {
  0: ' ',
  1: '.', // wing hallway
  2: '|', // main corridor
  3: 'H', // amenities hall
};

// Suites 25: map to A..Y
for (let i = 0; i < 25; i++) {
  legend[100 + i] = String.fromCharCode('A'.charCodeAt(0) + i);
}

console.log('--- Penthouse PlanGrid ---');
console.log(`cellSize=${plan.cellSize}m width=${plan.width} height=${plan.height}`);
console.log(`origin=(${plan.originX.toFixed(2)}, ${plan.originY.toFixed(2)})`);
console.log('');
console.log(planToAscii(plan, legend));
console.log('');
console.log('planValidation:', out.planValidation);
console.log('planDerivedStats:', out.planDerivedStats);
console.log('omitEdges:', Array.isArray(out.planOmitEdges) ? out.planOmitEdges.length : 0);

