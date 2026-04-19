# Chrono WASM Test Coverage (Current + Expansion Matrix)

## Scope

This document tracks what the current Chrono regression suite validates, and what to add next to close remaining runtime gaps.

Primary entrypoint:

- `npm run test:chrono`
- Full gate (includes browser driveability smoke):
  - `npm run test:chrono:full`

Primary suites:

- `tests/test_chrono_tools.py`
- `tests/test_chrono_module_contracts.py`

## Current Coverage

### Status parser (`tools/chrono_wasm_status_assert.py`)

- Geometry mismatch detection:
  - compares `pre-spawn geom` vs `sim`
  - fails on `dWb`, `dTf`, `dTr` above thresholds
- Source authority guard:
  - fails on `src=spindle_com_legacy`
- Hardpoint health guard:
  - enforces front/rear `applied=yes` and `geomOk=yes`
  - optional allowlist for partial hardpoints
- Raw spindle health guard:
  - full panel format (`raw spindle:`)
  - alert format (`raw bad frames:`)
  - fails on bad API, non-finite, implausible, or bad frame overflow
- Bridge spindle health guard:
  - full panel format (`bridge spindle:`)
  - alert format (`bridge:`)
  - fails on `reason!=ok`, `allWheels!=yes`, `sane!=yes`
  - fails on `directMask=0 && fallbackMask=0`
  - emits first-failure marker using `failWheel` + `failStage`
  - validates masks are in [0..15]

### Bridge failure matrix (new)

- Per-wheel failure coverage:
  - `failWheel=FL|FR|RL|RR`
- Per-stage failure coverage:
  - `failStage=direct_invalid|fallback_invalid`
- Combined failure assertion:
  - verifies reason/allWheels/sane failure and first-failure marker are surfaced for each wheel/stage pair

### Export audit (`tools/chrono_export_geometry_audit.py`)

- AC wheelbase/track vs exported Chrono geometry consistency
- partial-hardpoint policy enforcement

### Contract checks

- Bridge C++ exposes status API and failure fields
- JS wrapper binds status API
- Drive-test HUD surfaces bridge diagnostics

### End-to-end driveability smoke (new)

- Scripted browser harness:
  - `tools/test_chrono_drive_smoke.mjs`
- Assertions:
  - holding `W` produces at least one propulsion signal (`speed` or `wheel omega` or `engineRpm` or `driveshaftNm`)
  - pressing `A` produces non-zero steer command in HUD

## Expansion Matrix (Next)

## 1) Bridge mask semantics

- Add explicit bit-level semantics tests:
  - map bits to wheels: `1=FL`, `2=FR`, `4=RL`, `8=RR`
  - verify single-wheel mask cases and mixed masks
  - verify fail-wheel bit is absent in failing-stage mask

## 2) Runtime bridge snapshots

- Add fixture corpus from real HUD/debug-panel captures:
  - startup transient bad frames
  - post-reset transient
  - stable healthy run
  - persistent `fail_no_cache` run

## 3) Parser resilience

- Token order independence (bridge/raw fields in different order)
- Optional-token behavior (`failWheel`/`failStage` missing)
- Unicode and whitespace variants

## 4) End-to-end harness checks

- Expand smoke assertions:
  - assert no continuous invalid spindle stream after warmup window
  - assert no respawn storm under idle input
  - assert forward throttle increases signed speed over a minimum window

## 5) CI policy gates

- Add strict CI mode:
  - disallow `--allow-missing-spindle-health`
  - require at least one healthy spindle frame in status fixture pack
