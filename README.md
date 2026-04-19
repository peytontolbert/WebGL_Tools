# WebGL DevTools for Fast Game Building

This repo is centered on a browser-based DevTools product for building 3D games, interactive showrooms, and playable demos quickly.

The goal is not just to inspect assets. The goal is to go from a blank idea to something like [Peyton's showroom](https://peytontolbert.com/showroom/) in a few hours from scratch, using one workspace for world building, asset generation, characters, vehicles, and packaging.

The older standalone WebGL viewer/runtime is still in the repo, but it now supports the DevTools workflow instead of being the main story.

## Quick start

```bash
npm install
npm run dev
```

- DevTools authoring UI: `http://127.0.0.1:5179/devtools.html`
- Runtime/viewer entrypoint: `http://127.0.0.1:5179/`

Preview production assets locally:

```bash
npm run build
npm run preview
```

- Preview server: `http://127.0.0.1:5180`

## What the DevTools product covers

- **World building**: `Scene`, `Forge`, `Terrain`, and `Buildings` let you block out spaces, stage environments, and iterate on layouts quickly.
- **Prompt-to-world workflows**: `Code2Worlds` can generate a world concept and hand it directly into `Scene`.
- **Asset ingest + generation**: `Assets`, `Dataset`, `ZImage3D`, `Image Model Gen`, `Trellis`, `OVoxel`, and `Omniverse` turn prompts and source files into WebGL-ready content.
- **Characters + animation**: `Character`, `HumanDatasetRigged`, `Rig`, `Animation`, `Locomotion`, and `Mesh2Motion` get a playable character into the world quickly.
- **Vehicles**: `Vehicles`, `Assetto Corsa`, track export, and Chrono-backed runtime systems support drivable scenes and gameplay loops.
- **Packaging**: `Game` turns assembled scenes into a playable flow with menu, loading screen, character selection, preloads, save config, optional custom logic, and exportable package files.

## Fast path to a playable build

1. Start with a scene concept and rough blockout in `Forge`, `Scene`, or `Code2Worlds`.
2. Pull in environment and prop assets through generated GLBs, Omniverse conversion, or existing local assets.
3. Add a character, retarget motion, and validate interaction in `Scene`.
4. Add vehicles or runtime systems if the experience needs driving or traversal.
5. Finalize the experience in `Game`, then export the config, manifest, and launcher HTML for a playable package.

The sweet spot for this repo is a showroom-style experience, a small game prototype, or a polished vertical slice that can be built in one focused session instead of a long engine setup cycle.

## Useful commands

```bash
npm run dev
npm run build
npm run preview
npm run test:chrono
npm run test:chrono:e2e
npm run test:chrono:full
```

## Documentation

- [Docs hub](docs/README.md)
- [Asset layout](docs/asset_layout.md)
- [Omniverse ingest and conversion](docs/omniverse.md)
- [Rigging tools](tools/rigging/README.md)
- [Chrono WASM tooling](tools/chrono_wasm/README.md)
- [Human dataset tools](tools/humandataset/README.md)
- [Video retarget inputs](videos/README.md)
- [Pipeline entrypoints](pipelines/README.md)

## Repository notes

- `assets/**` is mostly local-only and gitignored. Keep manifests/reports in git; keep large generated payloads local.
- Many DevTools panels rely on optional local dependencies such as Blender, Omniverse packs, Assetto Corsa data, or local model runtimes.
- In dev, open `/devtools.html` instead of `/dist/*`. Build first if you want to test the preview bundle.

## Legacy runtime note

The runtime at `/` still contains the older viewer/editor flows, dataset loading, and multiplayer experimentation. That runtime remains useful for testing scenes and systems, but the repo should now be understood primarily as a DevTools-driven game-building workspace.
