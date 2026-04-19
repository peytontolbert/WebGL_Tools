import { ROOM_SIM_PENTHOUSE_BUILDING_ASSET_PATH } from '../../../shared/room_sim_penthouse_defaults.js';
import { safeTrim, uniqStrings } from './core/scene_utils.js';

export const SCENE_ASSET_LOCATIONS = Object.freeze({
  generatedScenes: 'assets/generated/convert/',
  characters: 'assets/characters/',
  buildings: 'assets/buildings/',
  vehicles: 'assets/generated/vehicles/halo/',
  vehiclesLegacy: 'assets/generated/halo/',
  aiCityBuildings: 'assets/ai_city/buildings/',
});

export const SCENE_PENTHOUSE_BUILDING_ASSET_PATH = safeTrim(ROOM_SIM_PENTHOUSE_BUILDING_ASSET_PATH)
  || `${SCENE_ASSET_LOCATIONS.buildings}room_sim_penthouse.json`;

export const SCENE_DRIFT_TRACK_BUILDING_ASSET_PATH = `${SCENE_ASSET_LOCATIONS.buildings}drift_track.json`;

export const SCENE_VEHICLE_PRESETS = [
  {
    id: 'ghost_aa3',
    label: 'Halo Ghost AA3',
    modelUrl: `${SCENE_ASSET_LOCATIONS.vehicles}ghost_aa3.glb`,
    sceneInboxUrl: `${SCENE_ASSET_LOCATIONS.vehicles}ghost_aa3.scene-inbox.json`,
    metaUrl: `${SCENE_ASSET_LOCATIONS.vehicles}ghost_aa3.meta.json`,
    recommendedScale: 0.01,
    source: 'RejectedShotgun-Tags + HaloAnimationRepository',
  },
];

export function withVehiclePathFallbacks(raw) {
  const s = safeTrim(raw).replace(/\\/g, '/');
  if (!s) return [];
  const out = [s];
  const nextPrefix = SCENE_ASSET_LOCATIONS.vehicles;
  const prevPrefix = SCENE_ASSET_LOCATIONS.vehiclesLegacy;
  if (s.startsWith(nextPrefix)) out.push(`${prevPrefix}${s.slice(nextPrefix.length)}`);
  if (s.startsWith(prevPrefix)) out.push(`${nextPrefix}${s.slice(prevPrefix.length)}`);
  return uniqStrings(out);
}

export const WORLD_THEME_PRESETS = Object.freeze({
  neutral: Object.freeze({
    label: 'Neutral studio',
    groundColor: 0x131a24,
    wallColor: 0x304058,
    fogColor: 0x0a0e16,
    fogDensity: 0.0,
  }),
  city_day: Object.freeze({
    label: 'City daytime',
    groundColor: 0x2f3640,
    wallColor: 0x4f6074,
    fogColor: 0xcfdaf0,
    fogDensity: 0.0028,
  }),
  arena_night: Object.freeze({
    label: 'Arena night',
    groundColor: 0x0d1220,
    wallColor: 0x22314a,
    fogColor: 0x050913,
    fogDensity: 0.0105,
  }),
  fantasy_soft: Object.freeze({
    label: 'Fantasy soft',
    groundColor: 0x253126,
    wallColor: 0x536b52,
    fogColor: 0x8ea98f,
    fogDensity: 0.0045,
  }),
});

export function getWorldThemePreset(theme) {
  const key = safeTrim(theme).toLowerCase();
  return WORLD_THEME_PRESETS[key] || WORLD_THEME_PRESETS.neutral;
}

export const WORLD_TEMPLATE_PRESETS = Object.freeze({
  sandbox: Object.freeze({
    label: 'Sandbox builder',
    blurb: 'Best for world building and experimentation.',
    includePhysics: true,
    includeCollision: true,
    includeLocomotion: true,
    includeWeapons: false,
    includeInteractions: true,
    includeEnemies: false,
    includeVehicles: false,
    groundSize: 90,
    addPerimeterWalls: true,
    wallHeight: 3.2,
    worldTheme: 'neutral',
    playerSpeed: 6.0,
    sprintSpeed: 11.0,
    gameplayGoal: 'Explore and build your world.',
    mapStartMode: 'flat',
    quickMapDensity: 'balanced',
    characterStartMode: 'pill',
  }),
  shooter: Object.freeze({
    label: 'Shooter arena',
    blurb: 'Quick combat setup with enemies and vehicles.',
    includePhysics: true,
    includeCollision: true,
    includeLocomotion: true,
    includeWeapons: true,
    includeInteractions: true,
    includeEnemies: true,
    includeVehicles: true,
    groundSize: 120,
    addPerimeterWalls: true,
    wallHeight: 4.0,
    worldTheme: 'arena_night',
    playerSpeed: 6.6,
    sprintSpeed: 12.4,
    gameplayGoal: 'Eliminate enemies and capture objective points.',
    mapStartMode: 'quick_build',
    quickMapDensity: 'dense',
    characterStartMode: 'pill',
  }),
  exploration: Object.freeze({
    label: 'Exploration world',
    blurb: 'Movement and discovery focused, no combat required.',
    includePhysics: true,
    includeCollision: true,
    includeLocomotion: true,
    includeWeapons: false,
    includeInteractions: true,
    includeEnemies: false,
    includeVehicles: false,
    groundSize: 160,
    addPerimeterWalls: false,
    wallHeight: 3.0,
    worldTheme: 'city_day',
    playerSpeed: 6.0,
    sprintSpeed: 11.5,
    gameplayGoal: 'Discover routes, landmarks, and interaction points.',
    mapStartMode: 'quick_build',
    quickMapDensity: 'balanced',
    characterStartMode: 'pill',
  }),
  showcase: Object.freeze({
    label: 'Showcase demo',
    blurb: 'Presentation-friendly world for portfolio or product demos.',
    includePhysics: false,
    includeCollision: true,
    includeLocomotion: false,
    includeWeapons: false,
    includeInteractions: true,
    includeEnemies: false,
    includeVehicles: false,
    groundSize: 80,
    addPerimeterWalls: true,
    wallHeight: 2.8,
    worldTheme: 'fantasy_soft',
    playerSpeed: 5.0,
    sprintSpeed: 9.0,
    gameplayGoal: 'Guide users through key areas and story beats.',
    mapStartMode: 'quick_build',
    quickMapDensity: 'compact',
    characterStartMode: 'model',
  }),
});

export function getWorldTemplatePreset(kind) {
  const key = safeTrim(kind).toLowerCase();
  return WORLD_TEMPLATE_PRESETS[key] || WORLD_TEMPLATE_PRESETS.sandbox;
}

