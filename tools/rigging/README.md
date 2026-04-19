## Rigging tools

This folder contains the **headless Blender scripts** used by the asset/animation connectors:

- `tools/rig_asset.py`: auto-rig a mesh (Blender backends + ML backends like UniRig).
- `tools/anim_asset.py`: inspect skeletons and retarget motion onto a target rig.

### Blender backends (deterministic, production-friendly)

All Blender backends run in headless mode:

```bash
blender --background --factory-startup --python <script> -- <args>
```

But you normally invoke them via `tools/rig_asset.py`.

#### Rigify (built into Blender)

```bash
python3 tools/rig_asset.py rigify \
  --in /abs/path/character.glb \
  --out /abs/path/character_rig.glb
```

Notes:
- This is best-effort “auto biped”: it adds the default human metarig, scales it, generates the rig, then binds with Blender Automatic Weights.
- For glTF export, the script exports **deform bones only** by default.

#### Rigacar (vehicles)

If you have Rigacar checked out under `repos/rigacar`, `tools/rig_asset.py` will auto-install it into the headless Blender session.

```bash
python3 tools/rig_asset.py rigacar \
  --in /abs/path/car.glb \
  --out /abs/path/car_rig.glb
```

Notes:
- Rigacar works best when your car is imported as **separate objects** named like `Body`, `Wheel.Ft.L`, `Wheel.Bk.R`, etc.
- The connector converts rigid parts into glTF skinning by creating per-part vertex groups (`DEF-*`) and (by default) **joining** meshes into one skinned mesh for export.
- If you really want separate objects, pass `--no-join-meshes`.

#### BlenRig (characters, high-end rig)

If you have BlenRig checked out under `repos/BlenRig`, `tools/rig_asset.py` will auto-install it into the headless Blender session.

```bash
python3 tools/rig_asset.py blenrig \
  --in /abs/path/character.glb \
  --out /abs/path/character_blenrig.glb
```

Notes:
- This connector currently does a **minimal** automated flow: add BlenRig’s biped rig + bind with Automatic Weights.
- BlenRig is version-sensitive (the repo’s `bl_info` targets Blender 4.x). If your Blender is older, enabling the addon may fail.

### UniRig (external ML rigger)

UniRig is integrated via `tools/rig_asset.py unirig`, which shells out to the upstream scripts:

- `launch/inference/generate_skeleton.sh`
- `launch/inference/generate_skin.sh`
- `launch/inference/merge.sh`

Example:

```bash
python3 tools/rig_asset.py unirig \
  --unirig-repo /abs/path/UniRig \
  --in /abs/path/creature.glb \
  --out /abs/path/creature_rig.glb
```

### RigAnything (external ML rigger, outputs GLB)

RigAnything is integrated via `tools/rig_asset.py riganything` and follows the upstream 3-step pipeline (simplify → inference → export rigged GLB).

```bash
python3 tools/rig_asset.py riganything \
  --riganything-repo /abs/path/RigAnything \
  --in /abs/path/creature.glb \
  --out /abs/path/creature_rig.glb
```

### Retargeting motion onto your rig

The retargeter is intentionally simple: it copies bone rotations (and optionally root translation) per-frame based on a JSON mapping.

- Print bone names:

```bash
python3 tools/anim_asset.py print-bones --in /abs/path/motion.bvh
python3 tools/anim_asset.py print-bones --in /abs/path/character_rig.glb
```

- Validate your mapping before retargeting (recommended):

```bash
python3 tools/anim_asset.py validate-map \
  --rig /abs/path/character_rig.glb \
  --motion /abs/path/motion.bvh \
  --map tools/rigging/mappings/example_map.json
```

- Retarget:

```bash
python3 tools/anim_asset.py retarget \
  --rig /abs/path/character_rig.glb \
  --motion /abs/path/motion.bvh \
  --map tools/rigging/mappings/example_map.json \
  --out /abs/path/anims/walk.glb \
  --clip-name walk \
  --root-motion
```

