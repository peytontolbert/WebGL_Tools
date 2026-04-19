## Project Chrono VEHICLE → WebAssembly (WASM)

This folder contains the **bridge code + build scripts** to compile a small slice of
Project Chrono (C++) + Chrono::Vehicle into WebAssembly, so our WebGL tools can use
**full Chrono vehicle physics**.

### What you get

After a successful build, the scripts copy these into `public/chrono/`:

- `chrono_vehicle_module.js`
- `chrono_vehicle_module.wasm`
- `data/` (Chrono vehicle data assets, embedded or served)

The runtime loader is `js/runtime/project_chrono_wasm_vehicle_sim.js`.

### Quick start (Linux)

1. Install prerequisites (system packages vary by distro):
   - `git`, `cmake`, `ninja`, `python3`
   - a working C/C++ toolchain

2. Build:

```bash
cd tools/chrono_wasm
./build_chrono_vehicle_wasm.sh
```

3. Run devtools as usual:

```bash
npm run dev
```

If WASM loads successfully, the Scene tool will toast:
`Project Chrono WASM loaded (vehicle physics enabled)`.

### Notes

- This build is intentionally isolated under `tools/third_party/` (gitignored).
- Building Chrono for WASM can take **15–30+ minutes** depending on your machine.
- The initial bridge uses the built-in Chrono HMMWV vehicle model as a baseline.
  You can extend `cv_create_vehicle()` to support more vehicle models (JSON-defined,
  sedan, trucks, etc.) as we add them.

