# This file will be configured to contain variables for CPack. These variables
# should be set in the CMake list file of the project before CPack module is
# included. The list of available CPACK_xxx variables and their associated
# documentation may be obtained using
#  cpack --help-variable-list
#
# Some variables are common to all generators (e.g. CPACK_PACKAGE_NAME)
# and some are specific to a generator
# (e.g. CPACK_NSIS_EXTRA_INSTALL_COMMANDS). The generator specific variables
# usually begin with CPACK_<GENNAME>_xxxx.


set(CPACK_BUILD_SOURCE_DIRS "/data/webgl-game/tools/chrono_wasm;/data/webgl-game/tools/chrono_wasm/build")
set(CPACK_BUILD_TYPE "Release")
set(CPACK_CMAKE_GENERATOR "Ninja")
set(CPACK_COMPONENT_UNSPECIFIED_HIDDEN "TRUE")
set(CPACK_COMPONENT_UNSPECIFIED_REQUIRED "TRUE")
set(CPACK_DEFAULT_PACKAGE_DESCRIPTION_FILE "/usr/share/cmake-3.28/Templates/CPack.GenericDescription.txt")
set(CPACK_DEFAULT_PACKAGE_DESCRIPTION_SUMMARY "chrono_vehicle_wasm_bridge built using CMake")
set(CPACK_DMG_SLA_USE_RESOURCE_FILE_LICENSE "ON")
set(CPACK_GENERATOR "ZIP")
set(CPACK_INNOSETUP_ARCHITECTURE "x86")
set(CPACK_INSTALL_CMAKE_PROJECTS "/data/webgl-game/tools/chrono_wasm/build;chrono_vehicle_wasm_bridge;ALL;/")
set(CPACK_INSTALL_PREFIX "/data/webgl-game/tools/third_party/emsdk/upstream/emscripten/cache/sysroot")
set(CPACK_MODULE_PATH "/data/webgl-game/tools/third_party/chrono/cmake;/data/webgl-game/tools/third_party/emsdk/upstream/emscripten/cmake/Modules;/data/webgl-game/tools/third_party/emsdk/upstream/emscripten/cmake/Modules;/data/webgl-game/tools/third_party/emsdk/upstream/emscripten/cmake/Modules;/data/webgl-game/tools/third_party/emsdk/upstream/emscripten/cmake/Modules;/data/webgl-game/tools/chrono_wasm/cmake/")
set(CPACK_NSIS_DISPLAY_NAME "Chrono")
set(CPACK_NSIS_INSTALLER_ICON_CODE "")
set(CPACK_NSIS_INSTALLER_MUI_ICON_CODE "")
set(CPACK_NSIS_INSTALL_ROOT "$PROGRAMFILES")
set(CPACK_NSIS_PACKAGE_NAME "Chrono")
set(CPACK_NSIS_UNINSTALL_NAME "Uninstall")
set(CPACK_OBJCOPY_EXECUTABLE "/usr/bin/objcopy")
set(CPACK_OBJDUMP_EXECUTABLE "/usr/bin/objdump")
set(CPACK_OUTPUT_CONFIG_FILE "/data/webgl-game/tools/chrono_wasm/build/CPackConfig.cmake")
set(CPACK_PACKAGE_DEFAULT_LOCATION "/")
set(CPACK_PACKAGE_DESCRIPTION_FILE "/usr/share/cmake-3.28/Templates/CPack.GenericDescription.txt")
set(CPACK_PACKAGE_DESCRIPTION_SUMMARY "Chrono is a multibody-dynamics package")
set(CPACK_PACKAGE_FILE_NAME "Chrono-Emscripten-x86-Release-")
set(CPACK_PACKAGE_INSTALL_DIRECTORY "Chrono")
set(CPACK_PACKAGE_INSTALL_REGISTRY_KEY "Chrono")
set(CPACK_PACKAGE_NAME "Chrono")
set(CPACK_PACKAGE_RELOCATABLE "true")
set(CPACK_PACKAGE_VENDOR "UWSBEL")
set(CPACK_PACKAGE_VERSION "9.0.1")
set(CPACK_PACKAGE_VERSION_MAJOR "9")
set(CPACK_PACKAGE_VERSION_MINOR "0")
set(CPACK_PACKAGE_VERSION_PATCH "1")
set(CPACK_READELF_EXECUTABLE "/usr/bin/readelf")
set(CPACK_RESOURCE_FILE_LICENSE "/data/webgl-game/tools/chrono_wasm/LICENSE")
set(CPACK_RESOURCE_FILE_README "/data/webgl-game/tools/chrono_wasm/README.md")
set(CPACK_RESOURCE_FILE_WELCOME "/usr/share/cmake-3.28/Templates/CPack.GenericWelcome.txt")
set(CPACK_SET_DESTDIR "OFF")
set(CPACK_SOURCE_GENERATOR "TGZ")
set(CPACK_SOURCE_OUTPUT_CONFIG_FILE "/data/webgl-game/tools/chrono_wasm/build/CPackSourceConfig.cmake")
set(CPACK_SOURCE_STRIP_FILES "")
set(CPACK_SYSTEM_NAME "Emscripten-x86")
set(CPACK_THREADS "1")
set(CPACK_TOPLEVEL_TAG "Emscripten-x86")
set(CPACK_WIX_SIZEOF_VOID_P "4")

if(NOT CPACK_PROPERTIES_FILE)
  set(CPACK_PROPERTIES_FILE "/data/webgl-game/tools/chrono_wasm/build/CPackProperties.cmake")
endif()

if(EXISTS ${CPACK_PROPERTIES_FILE})
  include(${CPACK_PROPERTIES_FILE})
endif()
