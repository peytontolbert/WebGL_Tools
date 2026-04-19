#!/usr/bin/env python3
"""
Export 350Z Chrono packages for controlled hardpoint A/B testing.

Example:
  python3 tools/chrono_350z_export_variants.py --run-prefix run_350z_ab
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


def run_export(repo_root: Path, car_root: Path, out_root: Path, run_id: str, mode: str) -> int:
    env = dict(os.environ)
    env["AC_CHRONO_HARDPOINTS_MODE"] = mode
    cmd = [
        sys.executable,
        str(repo_root / "tools" / "assetto_corsa_export.py"),
        "--car-root",
        str(car_root),
        "--out-root",
        str(out_root),
        "--run-id",
        run_id,
    ]
    print(f"\n== Export mode={mode} run_id={run_id} ==")
    proc = subprocess.run(cmd, cwd=str(repo_root), env=env, text=True, check=False)
    return int(proc.returncode)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-prefix", default="run_350z_variant")
    ap.add_argument(
        "--car-root",
        default="assetto/assettocorsa/content/cars/streetcarpack_nissan_350z",
    )
    ap.add_argument("--out-root", default="assets/generated/assetto_corsa")
    args = ap.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    car_root = (repo_root / args.car_root).resolve()
    out_root = (repo_root / args.out_root).resolve()

    rc = 0
    rc |= run_export(repo_root, car_root, out_root, f"{args.run_prefix}_hp_off", "off")
    rc |= run_export(repo_root, car_root, out_root, f"{args.run_prefix}_hp_on", "on")

    print("\nDone.")
    return 0 if rc == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())

