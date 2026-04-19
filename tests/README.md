# Chrono Tests

This folder contains regression tests for Chrono WASM diagnostic tooling.

Coverage tracker:

- `tests/CHRONO_TEST_COVERAGE.md`

## Run

```bash
python3 -m unittest discover -s tests -p "test_chrono_*.py" -v
```

Or via npm:

```bash
npm run test:chrono
```

## Current coverage

- `tools/chrono_wasm_status_assert.py`
  - fails on large source-vs-sim geometry deltas
  - fails on legacy non-authoritative track source (`spindle_com_legacy`)
  - fails on unhealthy raw spindle API stream (`api=bad`, non-finite, implausible, or bad frame overflow)
  - fails on unhealthy bridge spindle status (`reason!=ok`, `allWheels=no`, `sane=no`, or `directMask=0 && fallbackMask=0`)
  - supports both full debug-panel lines (`raw spindle:` / `bridge spindle:`) and alert-style lines (`raw bad frames:` / `bridge:`)
- `tools/chrono_export_geometry_audit.py`
  - validates AC vs exported wheelbase/track consistency
  - enforces hardpoint health and partial-hardpoint policy
