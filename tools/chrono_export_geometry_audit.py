#!/usr/bin/env python3
"""
Audit AC->Chrono geometry consistency for a single exported car stream.

Checks:
- AC suspensions.ini wheelbase/track values
- Chrono vehicle wheelbase
- Chrono suspension AC metadata track_target_m
- Chrono suspension spindle-COM track proxy
- Hardpoint application flags (applied/geom_ok/partial)
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any


def _f(v: Any) -> float:
    try:
        if isinstance(v, str):
            v = v.split(";", 1)[0].strip()
        return float(v)
    except Exception:
        return float("nan")


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _ac_targets(params_raw: dict[str, Any]) -> dict[str, float]:
    out: dict[str, float] = {}
    for ent in params_raw.get("entries", []):
        if not isinstance(ent, dict):
            continue
        if str(ent.get("file", "")).lower() != "data/suspensions.ini":
            continue
        sec = str(ent.get("section", "")).lower()
        key = str(ent.get("key", "")).lower()
        if sec == "basic" and key == "wheelbase":
            out["wheelbase"] = _f(ent.get("value"))
        elif sec == "front" and key == "track":
            out["track_f"] = _f(ent.get("value"))
        elif sec == "rear" and key == "track":
            out["track_r"] = _f(ent.get("value"))
    return out


def _susp_metrics(sj: dict[str, Any]) -> dict[str, Any]:
    ac = sj.get("AC Suspension", {}) if isinstance(sj.get("AC Suspension"), dict) else {}
    sp = sj.get("Spindle", {}) if isinstance(sj.get("Spindle"), dict) else {}
    sp_com = sp.get("COM", []) if isinstance(sp.get("COM"), list) else []
    sp_track = float("nan")
    if len(sp_com) >= 2:
        sp_track = 2.0 * abs(_f(sp_com[1]))
    return {
        "track_target_m": _f(ac.get("track_target_m")),
        "spindle_track_m": sp_track,
        "hardpoints_applied": bool(ac.get("hardpoints_applied")),
        "hardpoints_geom_ok": bool(ac.get("hardpoints_geom_ok")),
        "hardpoints_partial_ac": bool(ac.get("hardpoints_partial_ac")),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--stream-root",
        required=True,
        help="Path like webautos/ac__<car>/stream",
    )
    ap.add_argument("--max-vehicle-wheelbase-delta", type=float, default=0.03)
    ap.add_argument("--max-track-delta", type=float, default=0.03)
    ap.add_argument("--allow-partial-hardpoints", action="store_true")
    args = ap.parse_args()

    root = Path(args.stream_root)
    params = _load_json(root / "ac_raw" / "params.raw.json")
    manifest = _load_json(root / "normalized" / "chrono" / "manifest.json")
    vehicle_rel = str(manifest.get("vehicleFsRel") or "")
    if not vehicle_rel:
        print("FAIL")
        print("- missing vehicleFsRel in chrono manifest")
        return 2
    vehicle_path = root / "normalized" / "chrono" / vehicle_rel
    vehicle = _load_json(vehicle_path)
    front_rel = str(vehicle.get("Axles", [{}])[0].get("Suspension Input File", ""))
    rear_rel = str(vehicle.get("Axles", [{}, {}])[1].get("Suspension Input File", ""))
    if not front_rel or not rear_rel:
        print("FAIL")
        print("- vehicle JSON missing front/rear suspension input files")
        return 2
    front = _load_json(root / "normalized" / "chrono" / front_rel)
    rear = _load_json(root / "normalized" / "chrono" / rear_rel)

    ac = _ac_targets(params)
    fm = _susp_metrics(front)
    rm = _susp_metrics(rear)
    veh_wb = _f(vehicle.get("Wheelbase"))
    ac_wb = _f(ac.get("wheelbase"))
    ac_tf = _f(ac.get("track_f"))
    ac_tr = _f(ac.get("track_r"))

    print("AC targets:", f"wb={ac_wb:.3f}", f"tf={ac_tf:.3f}", f"tr={ac_tr:.3f}")
    print("Vehicle:", f"wb={veh_wb:.3f}", f"delta={abs(veh_wb - ac_wb):.3f}")
    print("Front suspension:",
          f"target={fm['track_target_m']:.3f}",
          f"spindle={fm['spindle_track_m']:.3f}",
          f"hardpoints(applied={fm['hardpoints_applied']} geom_ok={fm['hardpoints_geom_ok']} partial={fm['hardpoints_partial_ac']})")
    print("Rear suspension:",
          f"target={rm['track_target_m']:.3f}",
          f"spindle={rm['spindle_track_m']:.3f}",
          f"hardpoints(applied={rm['hardpoints_applied']} geom_ok={rm['hardpoints_geom_ok']} partial={rm['hardpoints_partial_ac']})")

    failures: list[str] = []
    if math.isfinite(ac_wb) and math.isfinite(veh_wb) and abs(veh_wb - ac_wb) > args.max_vehicle_wheelbase_delta:
        failures.append(f"vehicle wheelbase delta too high: {abs(veh_wb - ac_wb):.3f}")
    if math.isfinite(ac_tf) and math.isfinite(fm["track_target_m"]) and abs(ac_tf - fm["track_target_m"]) > args.max_track_delta:
        failures.append(f"front target track delta too high: {abs(ac_tf - fm['track_target_m']):.3f}")
    if math.isfinite(ac_tr) and math.isfinite(rm["track_target_m"]) and abs(ac_tr - rm["track_target_m"]) > args.max_track_delta:
        failures.append(f"rear target track delta too high: {abs(ac_tr - rm['track_target_m']):.3f}")
    if math.isfinite(ac_tf) and math.isfinite(fm["spindle_track_m"]) and abs(ac_tf - fm["spindle_track_m"]) > args.max_track_delta:
        failures.append(f"front spindle track delta too high: {abs(ac_tf - fm['spindle_track_m']):.3f}")
    if math.isfinite(ac_tr) and math.isfinite(rm["spindle_track_m"]) and abs(ac_tr - rm["spindle_track_m"]) > args.max_track_delta:
        failures.append(f"rear spindle track delta too high: {abs(ac_tr - rm['spindle_track_m']):.3f}")
    if not args.allow_partial_hardpoints:
        if fm["hardpoints_partial_ac"]:
            failures.append("front hardpoints are partial")
        if rm["hardpoints_partial_ac"]:
            failures.append("rear hardpoints are partial")
    if not fm["hardpoints_applied"] or not fm["hardpoints_geom_ok"]:
        failures.append(
            f"front hardpoints unhealthy: applied={fm['hardpoints_applied']} geom_ok={fm['hardpoints_geom_ok']}"
        )
    if not rm["hardpoints_applied"] or not rm["hardpoints_geom_ok"]:
        failures.append(
            f"rear hardpoints unhealthy: applied={rm['hardpoints_applied']} geom_ok={rm['hardpoints_geom_ok']}"
        )

    if failures:
        print("FAIL")
        for f in failures:
            print("-", f)
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
