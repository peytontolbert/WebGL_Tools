import { DevToolsApp } from './runtime/devtools_app.js';
import { TerrainTool } from './tools/terrain_tool.js';
import { ModelViewerTool } from './tools/model_viewer_tool.js';
import { SceneTool } from './tools/scene_tool.js';
import { BuildingsTool } from './tools/buildings_tool.js';
import { ForgeTool } from './tools/forge_tool.js';
import { RigTool } from './tools/rig_tool.js';
import { AnimationTool } from './tools/animation_tool.js';
import { LocomotionTool } from './tools/locomotion_tool.js';
import { Mesh2MotionTool } from './tools/mesh2motion_tool.js';
import { CharacterTool } from './tools/character_tool.js';
import { HumanDatasetRiggedTool } from './tools/humandataset_rigged_tool.js';
import { DatasetTool } from './tools/dataset_tool.js';
import { TextureTool } from './tools/texture_tool.js';
import { AssetsTool } from './tools/assets_tool.js';
import { VehiclesTool } from './tools/vehicles_tool.js';
import { AssettoCorsaTool } from './tools/assetto_corsa_tool.js';
import { AssettoCorsaTrackTool } from './tools/assetto_corsa_track_tool.js';
import { ImageModelGenTool } from './tools/image_model_gen_tool.js';
import { TrellisRetextureTool } from './tools/trellis_retexture_tool.js';
import { TrellisTurntableTool as TurntableTool } from './tools/trellis_turntable_tool.js';
import { TrellisDatasetTool } from './tools/trellis_dataset_tool.js';
import { OVoxelLabTool } from './tools/ovoxel_lab_tool.js';
import { Code2WorldsTool } from './tools/code2worlds_tool.js';
import { ZImage3DTool } from './tools/zimage_3d_tool.js';
import { RembgTool } from './tools/rembg_tool.js';
import { GlInfoTool } from './tools/gl_info_tool.js';
import { OmniverseTool } from './tools/omniverse_tool.js';
import { GameTool } from './tools/game_tool.js';

const canvasHost = /** @type {HTMLDivElement} */ (document.getElementById('canvasHost'));
const uiRoot = /** @type {HTMLDivElement} */ (document.getElementById('uiRoot'));

if (!canvasHost || !uiRoot) {
  throw new Error('Missing #canvasHost or #uiRoot');
}

/*
 * Tool categories for the sidebar.
 * Each category has a label, an icon, and a list of tools.
 */
const toolCategories = [
  {
    label: 'World Building',
    icon: '◈',
    tools: [
      {
        tool: new SceneTool(),
        icon: '▣',
        product: 'Scene',
        summary: 'Scenario generation, editing, and save/load workflows.',
      },
      {
        tool: new TerrainTool(),
        icon: '▦',
        product: 'Map Editors',
        summary: 'Terrain map editing and heightmap conversion.',
      },
      {
        tool: new BuildingsTool(),
        icon: '⌂',
        product: 'Map Editors',
        summary: 'Building layout and placement editing.',
      },
      {
        tool: new ForgeTool(),
        icon: '⚒',
        product: 'Forge',
        summary: 'Fast blockout and map prototyping workflow.',
      },
      {
        tool: new VehiclesTool(),
        icon: '⎈',
        product: 'Vehicles',
        summary: 'Vehicle browsing, preview, and scene handoff.',
      },
      {
        tool: new AssettoCorsaTool(),
        icon: '🏁',
        product: 'Vehicles',
        summary: 'Export AC static physics + runtime traces.',
      },
      {
        tool: new AssettoCorsaTrackTool(),
        icon: '🗺',
        product: 'Worlds',
        summary: 'Export an AC track KN5 to a SceneTool scenario.',
      },
      {
        tool: new ModelViewerTool(),
        icon: '◇',
        product: 'Viewer',
        summary: 'Inspect individual 3D assets.',
      },
      {
        tool: new GameTool(),
        icon: '♟',
        product: 'Game',
        summary: 'Package scenes into playable game flows.',
      },
    ],
  },
  {
    label: 'Assets',
    icon: '▣',
    tools: [
      { tool: new AssetsTool(),   icon: '▤', product: 'Assets', summary: 'Browse and manage project assets.' },
      { tool: new DatasetTool(),  icon: '▥', product: 'Assets', summary: 'Dataset indexing and utilities.' },
    ],
  },
  {
    label: '3D Generation',
    icon: '◆',
    tools: [
      { tool: new ZImage3DTool(),          icon: '◈', product: '3D Generation', summary: 'Image-to-3D model generation.' },
      { tool: new ImageModelGenTool(),     icon: '◉', product: '3D Generation', summary: 'Prompt-driven model generation jobs.' },
      { tool: new TrellisRetextureTool(),  icon: '◎', product: '3D Generation', summary: 'Retexture meshes with Trellis pipelines.' },
      { tool: new TurntableTool(),         icon: '○', product: '3D Generation', summary: 'Turntable renders for model review.' },
      { tool: new TrellisDatasetTool(),    icon: '◍', product: '3D Generation', summary: 'Trellis dataset utilities.' },
      { tool: new OVoxelLabTool(),         icon: '◌', product: '3D Generation', summary: 'Voxel editing and conversion flows.' },
      { tool: new Code2WorldsTool(),       icon: '⧉', product: '3D Generation', summary: 'Text-to-world generation workflow.' },
    ],
  },
  {
    label: 'Processing',
    icon: '⬡',
    tools: [
      { tool: new TextureTool(),  icon: '▧', product: 'Processing', summary: 'Texture operations and baking helpers.' },
      { tool: new RembgTool(),    icon: '◐', product: 'Processing', summary: 'Background removal processing.' },
    ],
  },
  {
    label: 'Rigging',
    icon: '⬢',
    tools: [
      { tool: new CharacterTool(), icon: '♘', product: 'Rigging', summary: 'Character setup and rig controls.' },
      { tool: new HumanDatasetRiggedTool(), icon: '◫', product: 'Rigging', summary: 'Rigged human dataset workflows.' },
      { tool: new RigTool(),        icon: '⧫', product: 'Rigging', summary: 'Rigging utilities and conversions.' },
      { tool: new AnimationTool(),  icon: '▶', product: 'Rigging', summary: 'Animation editing and export tasks.' },
      { tool: new LocomotionTool(), icon: '⇄', product: 'Rigging', summary: 'Locomotion setup and validation.' },
      { tool: new Mesh2MotionTool(), icon: '⬣', product: 'Rigging', summary: 'Mesh-to-motion conversion workflows.' },
    ],
  },
  {
    label: 'Omniverse',
    icon: '◆',
    tools: [
      { tool: new OmniverseTool(),  icon: '◆', product: 'Omniverse', summary: 'Omniverse integration tools.' },
    ],
  },
  {
    label: 'System',
    icon: '⚙',
    tools: [
      { tool: new GlInfoTool(),  icon: '⊞', product: 'System', summary: 'Graphics/runtime diagnostics.' },
    ],
  },
];

const app = new DevToolsApp({
  canvasHost,
  uiRoot,
  toolCategories,
});

app.start();

// Handy DevTools hooks
globalThis.__devtools = app;
