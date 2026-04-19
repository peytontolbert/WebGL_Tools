#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TP="$ROOT/tools/third_party"
EMSDK="$TP/emsdk"
CHRONO="$TP/chrono"
EIGEN="$TP/eigen"

OUT_PUBLIC="$ROOT/public/chrono"

echo "[chrono_wasm] root: $ROOT"
echo "[chrono_wasm] third_party: $TP"

mkdir -p "$TP"
mkdir -p "$OUT_PUBLIC"

if ! command -v git >/dev/null; then
  echo "git not found" >&2
  exit 1
fi
if ! command -v cmake >/dev/null; then
  echo "cmake not found" >&2
  exit 1
fi
if ! command -v ninja >/dev/null; then
  echo "ninja not found (install ninja-build)" >&2
  exit 1
fi

echo "[chrono_wasm] Ensuring emsdk..."
if [ ! -d "$EMSDK" ]; then
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$EMSDK"
fi

pushd "$EMSDK" >/dev/null
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh
popd >/dev/null

echo "[chrono_wasm] Ensuring Project Chrono source..."
if [ ! -d "$CHRONO" ]; then
  git clone --depth 1 https://github.com/projectchrono/chrono.git "$CHRONO"
fi

echo "[chrono_wasm] Ensuring Eigen headers..."
if [ ! -d "$EIGEN" ]; then
  # Header-only; shallow clone is fine.
  git clone --depth 1 https://github.com/eigenteam/eigen-git-mirror.git "$EIGEN"
fi

CH_BUILD="$TP/chrono_build_wasm"
mkdir -p "$CH_BUILD"

echo "[chrono_wasm] Patching Chrono for Emscripten (sockets)..."
SOCK_H="$CHRONO/src/chrono/utils/ChSocket.h"
if [ -f "$SOCK_H" ]; then
  SOCK_H="$SOCK_H" python3 - <<'PY'
import os
import pathlib

p = pathlib.Path(os.environ["SOCK_H"])
txt = p.read_text(encoding="utf-8", errors="ignore")
old = "#if (defined(__linux__) || defined(__APPLE__))"
new = "#if (defined(__linux__) || defined(__APPLE__) || defined(__EMSCRIPTEN__))"
if old in txt and new not in txt:
    txt = txt.replace(old, new, 1)
    p.write_text(txt, encoding="utf-8")
PY
fi

echo "[chrono_wasm] Configure Chrono (WASM)..."
pushd "$CH_BUILD" >/dev/null
emcmake cmake -G Ninja "$CHRONO" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CUDA_COMPILER=NOTFOUND \
  -DCMAKE_CXX_FLAGS= \
  -DEIGEN3_INCLUDE_DIR="$EIGEN" \
  -DCH_ENABLE_MODULE_VEHICLE=ON \
  -DCH_ENABLE_MODULE_VEHICLE_MODELS=ON \
  -DCH_ENABLE_MODULE_IRRLICHT=OFF \
  -DCH_ENABLE_MODULE_VSG=OFF \
  -DCH_ENABLE_MODULE_PARDISO_MKL=OFF \
  -DCH_ENABLE_MODULE_FSI=OFF \
  -DCH_ENABLE_MODULE_SENSOR=OFF \
  -DCH_ENABLE_MODULE_POSTPROCESS=OFF \
  -DBUILD_DEMOS=OFF \
  -DBUILD_TESTING=OFF

echo "[chrono_wasm] Build Chrono libs (WASM)..."
ninja
popd >/dev/null

echo "[chrono_wasm] Compile bridge with em++..."
CORE_LIB="$(ls -1 "$CH_BUILD/lib"/libChrono_core*.a 2>/dev/null | head -n 1 || true)"
VEH_LIB="$(ls -1 "$CH_BUILD/lib"/libChrono_vehicle*.a 2>/dev/null | head -n 1 || true)"
MODELS_LIB="$(ls -1 "$CH_BUILD/lib"/libChronoModels_vehicle*.a 2>/dev/null | head -n 1 || true)"

if [ -z "$CORE_LIB" ] || [ -z "$VEH_LIB" ] || [ -z "$MODELS_LIB" ]; then
  echo "Could not find Chrono static libs under $CH_BUILD/lib" >&2
  echo "core:   $CORE_LIB" >&2
  echo "vehicle: $VEH_LIB" >&2
  echo "models: $MODELS_LIB" >&2
  exit 1
fi

BRIDGE_CPP="$ROOT/tools/chrono_wasm/src/chrono_vehicle_bridge.cpp"
BRIDGE_OUT_DIR="$ROOT/tools/chrono_wasm/build_out"
mkdir -p "$BRIDGE_OUT_DIR"

# Clean stale packager outputs from previous builds (preload-file creates .data).
rm -f \
  "$BRIDGE_OUT_DIR/chrono_vehicle_module.data" \
  "$BRIDGE_OUT_DIR/chrono_vehicle_module.worker.js" \
  "$OUT_PUBLIC/chrono_vehicle_module.data" \
  "$OUT_PUBLIC/chrono_vehicle_module.worker.js" \
  || true

# Export helpers used by JS runtime + drive-test tooling.
# - cwrap/ccall/getValue/setValue: sim API + heap access fallback
# - FS (+ helpers): allow verifying and writing files in the Emscripten FS from JS
EXPORTED_RUNTIME_METHODS="['cwrap','ccall','getValue','setValue','FS','FS_createPath','FS_createDataFile','FS_unlink']"

em++ -O3 -std=c++17 \
  -I"$CHRONO/src" \
  -I"$CH_BUILD" \
  -I"$CHRONO/src/chrono/collision/bullet" \
  -I"$CHRONO/src/chrono/collision/gimpact" \
  -I"$CHRONO/src/chrono_thirdparty/HACD" \
  -I"$CHRONO/src/chrono_thirdparty/HACDv2" \
  -isystem "$EIGEN" \
  "$BRIDGE_CPP" \
  "$CORE_LIB" "$VEH_LIB" "$MODELS_LIB" \
  -o "$BRIDGE_OUT_DIR/chrono_vehicle_module.js" \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sENVIRONMENT=web,worker \
  -sALLOW_MEMORY_GROWTH=1 \
  -sWASM=1 \
  -sFILESYSTEM=1 \
  -sLEGACY_RUNTIME=1 \
  -sEXPORTED_RUNTIME_METHODS="$EXPORTED_RUNTIME_METHODS" \
  --preload-file "$CHRONO/data/vehicle/generic@/data/vehicle/generic" \
  -sEXPORTED_FUNCTIONS="['_malloc','_free','_cv_get_bridge_diag_version','_cv_create_world','_cv_destroy_world','_cv_destroy_vehicle','_cv_step_world','_cv_set_world_friction','_cv_set_spawn_world_y','_cv_set_terrain_flat_rigid','_cv_set_terrain_mesh_obj','_cv_set_terrain_heightmap_bmp','_cv_set_terrain_heightfield','_cv_clear_statics','_cv_add_static_aabb_world','_cv_add_static_trimesh_world','_cv_create_vehicle','_cv_create_vehicle_json','_cv_create_vehicle_json_ex','_cv_set_inputs','_cv_set_inputs_ex','_cv_set_brake4','_cv_clear_brake4','_cv_set_wheel_mu4','_cv_clear_wheel_mu4','_cv_set_gear','_cv_set_gear_index','_cv_set_shift_mode','_cv_set_drive_mode','_cv_set_vehicle_tuning_basic','_cv_set_vehicle_chassis_mass_inertia','_cv_set_vehicle_chassis_com_ref','_cv_set_vehicle_powertrain_simplemap','_cv_set_parking_brake','_cv_enable_brake_locking','_cv_lock_axle_diff','_cv_lock_central_diff','_cv_disconnect_driveline','_cv_get_state','_cv_get_state_ex','_cv_get_vehicle_dynamics','_cv_get_spindles4','_cv_get_spindles4_status','_cv_get_spindles4_diag','_cv_get_tire_state','_cv_get_tire_slips4','_cv_get_powertrain_state','_cv_get_wheel_state']"

# NOTE:
# We intentionally do NOT preload Chrono's full data directory.
# Preloading "$CHRONO/data@/data" creates a multi-GB .data bundle which browsers struggle with.
# We do preload a small subset (generic vehicle JSON templates) for the optional JSON-defined vehicle path.

echo "[chrono_wasm] Copy outputs to public/chrono/ ..."
rm -f "$OUT_PUBLIC/chrono_vehicle_module.data" "$OUT_PUBLIC/chrono_vehicle_module.worker.js" || true
cp -f "$BRIDGE_OUT_DIR/chrono_vehicle_module.js" "$OUT_PUBLIC/chrono_vehicle_module.js"
cp -f "$BRIDGE_OUT_DIR/chrono_vehicle_module.wasm" "$OUT_PUBLIC/chrono_vehicle_module.wasm"
if [ -f "$BRIDGE_OUT_DIR/chrono_vehicle_module.data" ]; then
  cp -f "$BRIDGE_OUT_DIR/chrono_vehicle_module.data" "$OUT_PUBLIC/chrono_vehicle_module.data"
fi
if [ -f "$BRIDGE_OUT_DIR/chrono_vehicle_module.worker.js" ]; then
  cp -f "$BRIDGE_OUT_DIR/chrono_vehicle_module.worker.js" "$OUT_PUBLIC/chrono_vehicle_module.worker.js"
fi

echo "[chrono_wasm] Done."
echo "  Output: $OUT_PUBLIC/chrono_vehicle_module.js"
echo "  Output: $OUT_PUBLIC/chrono_vehicle_module.wasm"
