#!/usr/bin/env bash
set -euo pipefail

# Fetch Poly Haven CC0 "Old Tyre" model (2K glTF + textures) into public/ for Vite/static serving.
#
# Output URL (in app):
#   /external/polyhaven/old_tyre_2k/old_tyre_2k.gltf
#
# Source:
#   https://polyhaven.com/a/old_tyre (CC0)
#   https://api.polyhaven.com/files/old_tyre (file URLs)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/public/external/polyhaven/old_tyre_2k"
TEX_DIR="${OUT_DIR}/textures"

mkdir -p "${TEX_DIR}"

echo "Downloading Poly Haven old_tyre (2K glTF)…"

# glTF (2k)
curl -L --fail --retry 3 --retry-delay 1 \
  -o "${OUT_DIR}/old_tyre_2k.gltf" \
  "https://dl.polyhaven.org/file/ph-assets/Models/gltf/2k/old_tyre/old_tyre_2k.gltf"

# Buffer (shared across resolutions in Poly Haven's packaging for this asset)
curl -L --fail --retry 3 --retry-delay 1 \
  -o "${OUT_DIR}/old_tyre.bin" \
  "https://dl.polyhaven.org/file/ph-assets/Models/gltf/4k/old_tyre/old_tyre.bin"

# Textures (2k, JPG)
curl -L --fail --retry 3 --retry-delay 1 \
  -o "${TEX_DIR}/old_tyre_diff_2k.jpg" \
  "https://dl.polyhaven.org/file/ph-assets/Models/jpg/2k/old_tyre/old_tyre_diff_2k.jpg"

curl -L --fail --retry 3 --retry-delay 1 \
  -o "${TEX_DIR}/old_tyre_nor_gl_2k.jpg" \
  "https://dl.polyhaven.org/file/ph-assets/Models/jpg/2k/old_tyre/old_tyre_nor_gl_2k.jpg"

curl -L --fail --retry 3 --retry-delay 1 \
  -o "${TEX_DIR}/old_tyre_arm_2k.jpg" \
  "https://dl.polyhaven.org/file/ph-assets/Models/jpg/2k/old_tyre/old_tyre_arm_2k.jpg"

echo "Done."
echo "Files written to: ${OUT_DIR}"
echo "Runtime URL: /external/polyhaven/old_tyre_2k/old_tyre_2k.gltf"

