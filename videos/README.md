# Video Retarget Inputs

Drop source videos here (for example: `.mp4`, `.mov`, `.mkv`), then run:

```bash
python3 tools/video_batch_retarget.py \
  --videos-dir videos \
  --rig assets/generated/hunyuan/character_rig.glb \
  --map tools/rigging/mappings/example_map.json
```

## Modes

### 1) Sidecar motion files (no extractor command)

If a video has a matching sidecar motion file with the same basename, it is used directly.

Examples:

- `videos/walk_01.mp4` + `videos/walk_01.bvh`
- `videos/run_02.mov` + `videos/run_02.fbx`

### 2) Auto-extract motion per video

Use `--extract-cmd` with placeholders:

- `{video}`: absolute path to input video
- `{motion}`: absolute path where motion should be written
- `{stem}`: basename without extension

Example:

```bash
python3 tools/video_batch_retarget.py \
  --videos-dir videos \
  --rig assets/generated/hunyuan/character_rig.glb \
  --map tools/rigging/mappings/example_map.json \
  --extract-cmd "python3 /abs/path/video_to_bvh.py --video {video} --out {motion}"
```

Outputs are written to `assets/animations/video_retarget/` by default.
