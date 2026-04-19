## Project Chrono WASM output (generated)

This folder is **generated** by the Chrono WASM build scripts in `tools/chrono_wasm/`.

Expected files after building:

- `chrono_vehicle_module.js`
- `chrono_vehicle_module.wasm`
- `data/` (Chrono vehicle data files, if your build preloads them)

These outputs are ignored by git (see `.gitignore`), but this README is kept so the path exists and
the runtime loader can resolve `./chrono/chrono_vehicle_module.js` at runtime when present.

