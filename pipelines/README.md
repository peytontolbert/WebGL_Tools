# Generative Pipelines (offline → viewer-ready formats)

This repo’s runtime doesn’t (yet) consume arbitrary `glTF` like Three.js would — it loads:

- **Terrain**: `heightmap-u16` (a small JSON meta + raw `uint16` binary samples)
- **Vector layers**: **GeoJSON in WGS84** for roads, buildings, props, trees, water, etc.
- **High-scale buildings**: optional **tiled instancing** (`instanced-tiles-buildings*`) via the existing `tools/` tilers

So these pipelines generate assets in *those* formats, ready to stream in the browser.

## Quick start: generate an “AI city” dataset

```bash
python3 pipelines/run.py proc-city \
  --id ai_city_example \
  --out assets/datasets/generated/ai_city_example \
  --origin-lon -76.30 --origin-lat 36.85 \
  --size-m 2400 \
  --grid 256 \
  --seed "ai_city_example" \
  --update-manifest
```

This writes dataset files under `assets/datasets/generated/...` and **upserts** entries into your local `assets/datasets/manifest.json` (which is gitignored).

Run the viewer and pick the dataset:

```bash
npm run dev
```

## What gets generated

The `proc-city` pipeline writes:

- `heightmap/meta.json` + `heightmap/heights.u16.bin`
- `roads.geojson` (`geojson-wgs84-roads`)
- `buildings.geojson` (`geojson-wgs84-buildings`)
- `trees.geojson` (`geojson-wgs84-trees`)
- `props.geojson` (`geojson-wgs84-props`)

All coordinates are WGS84 lon/lat so the existing loaders can project to meters.

## Optional: tile buildings (BUI2 / multi-LOD)

If you want city-scale performance, the repo already has tilers:

- `tools/tile_instanced_buildings.py`
- `tools/build_lod0_from_bui2_tiles.py`

The pipeline has a `--tile-buildings` option that will run those and emit a multi-LOD tileset.

```bash
python3 pipelines/run.py proc-city \
  --id ai_city_example \
  --out assets/datasets/generated/ai_city_example \
  --seed "ai_city_example" \
  --tile-buildings \
  --update-manifest
```

This creates a second top-level dataset id `${id}_multilod` that references `instanced-tiles-buildings-multilod` via:

- `assets/datasets/generated/<id>/tiles/multilod/multilod_index.json`

## Why the old output looked “random”

The initial `proc-city` prototype placed buildings as random rectangles across the entire map, independent of roads. The current generator is block-based:

- major road grid → **blocks**
- blocks → **lots** (street-facing strips with setbacks)
- lots → **building footprints** (no overlaps, aligned to streets)

This makes the city readable and “playable” immediately in the existing viewer.

## “AI” connectors (optional)

There are placeholders for heavier ML-driven generation (text-to-3D meshes, diffusion-based terrain texturing, etc.). Those are intentionally **optional**, because they require GPU + large model weights.

### Image → 3D mesh (Trellis2) → GLB → Rigging (optional)

If you have a separate GPU environment, the repo includes an **optional** connector for
`microsoft/TRELLIS.2-4B` under `tools/`:

```bash
conda activate trellis
python3 tools/trellis2_image_to_glb.py \
  --image /abs/path/input.png \
  --out-glb /abs/path/out.glb
```

You can then auto-rig the output GLB (requires Blender + your chosen backend):

```bash
python3 tools/rig_asset.py rigify --in /abs/path/out.glb --out /abs/path/out_rig.glb
```

