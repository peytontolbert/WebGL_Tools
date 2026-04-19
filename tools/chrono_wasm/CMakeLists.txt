cmake_minimum_required(VERSION 3.20)
project(chrono_vehicle_wasm_bridge LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(CHRONO_SOURCE_DIR "" CACHE PATH "Path to Project Chrono source checkout")
if(NOT CHRONO_SOURCE_DIR)
  message(FATAL_ERROR "Set -DCHRONO_SOURCE_DIR=/path/to/projectchrono/chrono")
endif()

# Chrono's top-level CMake assumes its own `cmake/` directory is on the module path.
list(PREPEND CMAKE_MODULE_PATH "${CHRONO_SOURCE_DIR}/cmake")

# Build Chrono as a subproject so we don't rely on 'install' (WASM installs are often incomplete).
set(CH_ENABLE_MODULE_VEHICLE ON CACHE BOOL "" FORCE)
set(CH_ENABLE_MODULE_VEHICLE_MODELS ON CACHE BOOL "" FORCE)
set(CH_ENABLE_MODULE_IRRLICHT OFF CACHE BOOL "" FORCE)
set(CH_ENABLE_MODULE_VSG OFF CACHE BOOL "" FORCE)
set(CH_ENABLE_MODULE_SENSOR OFF CACHE BOOL "" FORCE)
set(CH_ENABLE_MODULE_POSTPROCESS OFF CACHE BOOL "" FORCE)
set(CH_ENABLE_MODULE_FSI OFF CACHE BOOL "" FORCE)
set(CH_ENABLE_MODULE_MULTICORE OFF CACHE BOOL "" FORCE)
set(CH_ENABLE_MODULE_PARDISO_MKL OFF CACHE BOOL "" FORCE)

add_subdirectory(${CHRONO_SOURCE_DIR} ${CMAKE_BINARY_DIR}/chrono_subbuild)

add_executable(chrono_vehicle_module
  src/chrono_vehicle_bridge.cpp
)

target_include_directories(chrono_vehicle_module PRIVATE
  ${CHRONO_INCLUDE_DIRS}
)

target_link_libraries(chrono_vehicle_module PRIVATE
  Chrono::core
  Chrono::vehicle
  Chrono::models_vehicle
)

# Emscripten output naming to match our runtime loader.
set_target_properties(chrono_vehicle_module PROPERTIES
  OUTPUT_NAME "chrono_vehicle_module"
  SUFFIX ".js"
)

if(EMSCRIPTEN)
  # Optionally embed Chrono data into the WASM bundle (recommended).
  # Pass -DCHRONO_DATA_DIR=/path/to/chrono/data when configuring this project.
  set(CHRONO_DATA_DIR "" CACHE PATH "Path to Project Chrono data directory (contains vehicle/)")

  # Export a small C API and the runtime helpers we use.
  target_link_options(chrono_vehicle_module PRIVATE
    "SHELL:-sMODULARIZE=1"
    "SHELL:-sEXPORT_ES6=1"
    "SHELL:-sENVIRONMENT=web,worker"
    "SHELL:-sALLOW_MEMORY_GROWTH=1"
    "SHELL:-sWASM=1"
    "SHELL:-sFILESYSTEM=1"
    "SHELL:-sLEGACY_RUNTIME=1"
    # Export memory helpers so JS can read state buffers without requiring Module.HEAP* views.
    "SHELL:-sEXPORTED_RUNTIME_METHODS=['cwrap','ccall','getValue','setValue']"
    "SHELL:--preload-file ${CMAKE_SOURCE_DIR}/../third_party/chrono/data/vehicle/generic@/data/vehicle/generic"
    "SHELL:-sEXPORTED_FUNCTIONS=['_malloc','_free','_cv_get_bridge_diag_version','_cv_create_world','_cv_destroy_world','_cv_destroy_vehicle','_cv_step_world','_cv_set_world_friction','_cv_set_spawn_world_y','_cv_set_terrain_flat_rigid','_cv_set_terrain_mesh_obj','_cv_set_terrain_heightmap_bmp','_cv_set_terrain_heightfield','_cv_clear_statics','_cv_add_static_aabb_world','_cv_add_static_trimesh_world','_cv_create_vehicle','_cv_create_vehicle_json','_cv_create_vehicle_json_ex','_cv_set_inputs','_cv_set_inputs_ex','_cv_set_brake4','_cv_clear_brake4','_cv_set_wheel_mu4','_cv_clear_wheel_mu4','_cv_set_gear','_cv_set_gear_index','_cv_set_shift_mode','_cv_set_drive_mode','_cv_set_vehicle_tuning_basic','_cv_set_vehicle_chassis_mass_inertia','_cv_set_vehicle_chassis_com_ref','_cv_set_vehicle_powertrain_simplemap','_cv_set_parking_brake','_cv_enable_brake_locking','_cv_lock_axle_diff','_cv_lock_central_diff','_cv_disconnect_driveline','_cv_get_state','_cv_get_state_ex','_cv_get_vehicle_dynamics','_cv_get_spindles4','_cv_get_spindles4_status','_cv_get_spindles4_diag','_cv_get_tire_state','_cv_get_tire_slips4','_cv_get_powertrain_state','_cv_get_wheel_state']"
  )

  if(CHRONO_DATA_DIR)
    target_link_options(chrono_vehicle_module PRIVATE
      "SHELL:--preload-file ${CHRONO_DATA_DIR}@/data"
    )
  endif()
endif()
