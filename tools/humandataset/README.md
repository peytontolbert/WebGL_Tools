# HumanDataset Rigged Helpers

Use this helper to build a local catalog from downloaded HumanDataset rigged assets.

## Build catalog + mesh list

```bash
python3 tools/humandataset/build_rigged_catalog.py \
  --workspace-root . \
  --root repos/TRELLIS.2/datasets/humandataset/rigged \
  --out-json tools/out/humandataset/rigged_catalog.json \
  --out-list tools/out/humandataset/rigged_meshes.txt
```

Outputs:
- `tools/out/humandataset/rigged_catalog.json`: metadata used for indexing/auditing.
- `tools/out/humandataset/rigged_meshes.txt`: newline list of mesh paths for batch processing scripts.

## Preprocess for TRELLIS.2 training

```bash
python3 tools/humandataset/preprocess_trellis2.py \
  --trellis-root repos/TRELLIS.2 \
  --source-root repos/TRELLIS.2/datasets/humandataset/rigged \
  --dataset-root repos/TRELLIS.2/datasets/humandataset/trellis_train \
  --steps all
```

Optional: process only a subset via `--instances tools/out/humandataset/rigged_meshes.txt`.

## LoRA training entrypoint

```bash
cd repos/TRELLIS.2
python train_lora.py \
  --config configs/gen/slat_flow_img2shape_dit_1_3B_512_bf16_ft1024.json \
  --output_dir results/humandataset_lora_img2shape \
  --data_dir "{\"humandataset\": {\"base\": \"datasets/humandataset/trellis_train\", \"shape_latent\": \"datasets/humandataset/trellis_train/shape_latents/shape_enc_next_dc_f16c32_fp16_1024\", \"render_cond\": \"datasets/humandataset/trellis_train/renders_cond\"}}" \
  --lora_target_model denoiser \
  --lora_target_modules to_qkv,to_q,to_kv,to_out \
  --lora_r 16 --lora_alpha 32 --lora_dropout 0.05
```

