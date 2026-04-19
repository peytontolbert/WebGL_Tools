import { SCENE_DRIFT_TRACK_BUILDING_ASSET_PATH, SCENE_PENTHOUSE_BUILDING_ASSET_PATH } from '../scene_presets.js';
import { safeTrim } from '../core/scene_utils.js';

export const scenarioDefaultsMixin = {
  _ensureDefaultFpsArenaScenario({ forceToast = false } = {}) {
    const name = 'FPS Arena (model-free)';
    const path = 'proc:arena';
    const list = this._loadScenarioList();
    const exists = list.some((x) => safeTrim(x?.name) === name);

    // A decent starter layout: spawn, view, a few patrol waypoints, and one goal trigger.
    const sc = {
      schema: 1,
      name,
      path,
      spawn: { x: 0, y: 0, z: 18 },
      view: { yaw: Math.PI, pitch: -0.05, eyeH: 1.7 },
      settings: {
        mode: 'fps',
        showGrid: false,
        fly: false,
        speed: 6,
        sprint: 11,
        drivingEnabled: true,
      },
      content: {
        waypoints: [
          { name: 'Alpha In', x: -18, y: 0, z: -2 },
          { name: 'Alpha Mid', x: -14, y: 0, z: -10 },
          { name: 'Yard', x: 0, y: 0, z: -8 },
          { name: 'Bravo In', x: 10, y: 0, z: 10 },
          { name: 'Bravo Mid', x: 22, y: 0, z: 14 },
        ],
        triggers: [
          {
            id: crypto?.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2),
            name: 'Extract',
            type: 'goal',
            once: true,
            requireInteract: true,
            prompt: 'Extract',
            center: { x: -2, y: 1.0, z: 18 },
            size: { x: 4, y: 2, z: 4 },
            goal: true,
          },
        ],
      },
    };

    const next = list.filter((x) => safeTrim(x?.name) !== name);
    next.unshift(sc); // upsert (keeps the default scenario in sync with current proc:arena layout)
    this._saveScenarioList(next.slice(0, 50));
    if (forceToast) this._ctx?.toast?.(exists ? 'Updated saved scenario: FPS Arena (model-free)' : 'Added saved scenario: FPS Arena (model-free)', exists ? 'info' : 'success', { title: 'Scene' });
  },

  _ensureDefaultDriftTrackScenario({ forceToast = false } = {}) {
    const name = 'Drift Track (Driveable)';
    const path = 'proc:drift_track';
    const list = this._loadScenarioList();
    const exists = list.some((x) => safeTrim(x?.name) === name);

    const sc = {
      schema: 1,
      name,
      path,
      spawn: { x: 0, y: 0, z: 54 },
      view: { yaw: Math.PI, pitch: -0.05, eyeH: 1.7 },
      settings: {
        mode: 'fps',
        showGrid: false,
        fly: false,
        speed: 6,
        sprint: 11,
        drivingEnabled: true,
      },
      proc: {
        // Drift track is authored as a building JSON asset (editable in Buildings tool).
        buildingAssetPath: SCENE_DRIFT_TRACK_BUILDING_ASSET_PATH,
      },
      content: {
        waypoints: [
          { name: 'Start line', x: 0, y: 0, z: 54 },
          { name: 'Outer entry', x: 42, y: 0, z: 34 },
          { name: 'Inner clip', x: 0, y: 0, z: 0 },
          { name: 'Outer exit', x: -42, y: 0, z: -34 },
        ],
        triggers: [],
      },
    };

    const next = list.filter((x) => safeTrim(x?.name) !== name);
    next.unshift(sc); // upsert
    this._saveScenarioList(next.slice(0, 50));
    if (forceToast) this._ctx?.toast?.(exists ? 'Updated saved scenario: Drift Track (Driveable)' : 'Added saved scenario: Drift Track (Driveable)', exists ? 'info' : 'success', { title: 'Scene' });
  },

  _ensureDefaultPenthouseScenario({ forceToast = false } = {}) {
    const name = 'Penthouse (Room Sim)';
    const path = 'proc:penthouse_room_sim';
    const list = this._loadScenarioList();
    const exists = list.some((x) => safeTrim(x?.name) === name);

    // Data-driven: points at a building JSON asset for parameters (edited in Buildings tool).
    const sc = {
      schema: 1,
      name,
      path,
      // Spawn roughly inside the hall. The procedural loader will clamp/adjust if needed.
      spawn: { x: 8, y: 0, z: 0 },
      view: { yaw: Math.PI * 0.5, pitch: -0.05, eyeH: 1.7 },
      settings: {
        mode: 'fps',
        showGrid: false,
        fly: false,
        speed: 6,
        sprint: 11,
      },
      proc: {
        // This is the "data" for penthouse procedural generation.
        buildingAssetPath: SCENE_PENTHOUSE_BUILDING_ASSET_PATH,
      },
      content: {
        waypoints: [],
        triggers: [],
      },
    };

    const next = list.filter((x) => safeTrim(x?.name) !== name);
    next.unshift(sc); // upsert
    this._saveScenarioList(next.slice(0, 50));
    if (forceToast) this._ctx?.toast?.(exists ? 'Updated saved scenario: Penthouse (Room Sim)' : 'Added saved scenario: Penthouse (Room Sim)', exists ? 'info' : 'success', { title: 'Scene' });
  },

  _ensureDefaultResumeShowcaseScenario({ forceToast = false } = {}) {
    const name = 'Resume Showcase (Playable)';
    const path = 'proc:resume_showcase';
    const list = this._loadScenarioList();
    const exists = list.some((x) => safeTrim(x?.name) === name);

    const sc = {
      schema: 1,
      name,
      path,
      spawn: { x: 0, y: 0, z: 20 },
      view: { yaw: Math.PI, pitch: -0.04, eyeH: 1.7 },
      settings: {
        mode: 'fps',
        showGrid: false,
        fly: false,
        speed: 6,
        sprint: 11,
      },
      proc: {
        githubUser: safeTrim(this._resumeShowcase?.githubUser || '') || 'peytontolbert',
      },
      content: {
        waypoints: [],
        triggers: [],
      },
    };

    const next = list.filter((x) => safeTrim(x?.name) !== name);
    next.unshift(sc); // upsert
    this._saveScenarioList(next.slice(0, 50));
    if (forceToast) this._ctx?.toast?.(exists ? 'Updated saved scenario: Resume Showcase (Playable)' : 'Added saved scenario: Resume Showcase (Playable)', exists ? 'info' : 'success', { title: 'Scene' });
  },
};

export function ensureDefaultScenarios(tool, { forceToast = false } = {}) {
  if (!tool) return;
  try { tool._ensureDefaultFpsArenaScenario({ forceToast }); } catch { /* ignore */ }
  try { tool._ensureDefaultDriftTrackScenario({ forceToast }); } catch { /* ignore */ }
  try { tool._ensureDefaultPenthouseScenario({ forceToast }); } catch { /* ignore */ }
  try { tool._ensureDefaultResumeShowcaseScenario({ forceToast }); } catch { /* ignore */ }
}

