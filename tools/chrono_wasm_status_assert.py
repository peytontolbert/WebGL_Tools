#!/usr/bin/env python3
"""
Assert Chrono WASM drive-test HUD status against structural failure signatures.

Usage:
  python3 tools/chrono_wasm_status_assert.py --status /path/to/status.txt
  cat status.txt | python3 tools/chrono_wasm_status_assert.py
"""

from __future__ import annotations

import argparse
import re
import sys


def _read_text(path: str | None) -> str:
    if path:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    return sys.stdin.read()


def _f(x: str) -> float:
    try:
        return float(x)
    except Exception:
        return float("nan")


def _token(line: str, key: str, pattern: str) -> str | None:
    m = re.search(rf"\b{re.escape(key)}=({pattern})", line)
    return m.group(1) if m else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--status", default="", help="Path to copied HUD status text")
    ap.add_argument("--max-dwb", type=float, default=0.12)
    ap.add_argument("--max-dtf", type=float, default=0.12)
    ap.add_argument("--max-dtr", type=float, default=0.12)
    ap.add_argument("--max-inert-frames-under-throttle", type=int, default=45)
    ap.add_argument("--allow-partial-hardpoints", action="store_true")
    ap.add_argument("--allow-missing-spindle-health", action="store_true")
    args = ap.parse_args()

    txt = _read_text(args.status or None)
    if not txt.strip():
        print("FAIL: empty status text")
        return 2

    failures: list[str] = []

    m_spec = re.search(r"chrono vehicle spec:\s*(.+)", txt)
    spec = (m_spec.group(1).strip() if m_spec else "")
    if "vehicle_drivefix_4wd.json" in spec:
        failures.append("spec uses vehicle_drivefix_4wd.json (runtime rewrite/stale build)")

    m_proxy = re.search(r"bridge proxy:\s*active=(yes|no)", txt)
    if m_proxy and m_proxy.group(1).lower() == "yes":
        failures.append("bridge proxy is active")

    m_src_line = re.search(r"powertrain source:\s*([a-zA-Z0-9_.\-]+)", txt)
    if m_src_line:
        powertrain_source = m_src_line.group(1).strip().lower()
        if powertrain_source != "authored_json":
            failures.append(f"powertrain source is {powertrain_source}")

    m_pre = re.search(r"pre-spawn geom:\s*wb=([0-9.\-]+)\s*tf=([0-9.\-]+)\s*tr=([0-9.\-]+)", txt)
    m_pre_src = re.search(r"pre-spawn geom:.*\bsrc=([a-zA-Z0-9_.\-]+)", txt)
    if m_pre_src:
        src = m_pre_src.group(1).strip().lower()
        if src == "spindle_com_legacy":
            failures.append("pre-spawn track source is spindle_com_legacy (non-authoritative)")
    m_sim = re.search(r"sim:\s*wheelbase=([0-9.\-]+)\s*trackF=([0-9.\-]+)\s*trackR=([0-9.\-]+)", txt)
    if m_pre and m_sim:
        pre_wb, pre_tf, pre_tr = map(_f, m_pre.groups())
        sim_wb, sim_tf, sim_tr = map(_f, m_sim.groups())
        d_wb = abs(sim_wb - pre_wb)
        d_tf = abs(sim_tf - pre_tf)
        d_tr = abs(sim_tr - pre_tr)
        if d_wb > args.max_dwb:
            failures.append(f"dWb too high: {d_wb:.3f} > {args.max_dwb:.3f}")
        if d_tf > args.max_dtf:
            failures.append(f"dTf too high: {d_tf:.3f} > {args.max_dtf:.3f}")
        if d_tr > args.max_dtr:
            failures.append(f"dTr too high: {d_tr:.3f} > {args.max_dtr:.3f}")
    else:
        failures.append("missing pre-spawn/sim geometry lines")

    m_hp = re.search(
        r"hardpoints:\s*front\(applied=(yes|no)\s+geomOk=(yes|no)\s+partial=(yes|no)\)\s+rear\(applied=(yes|no)\s+geomOk=(yes|no)\s+partial=(yes|no)\)",
        txt,
    )
    if m_hp:
        f_ap, f_ok, f_part, r_ap, r_ok, r_part = m_hp.groups()
        if f_ap != "yes" or f_ok != "yes":
            failures.append(f"front hardpoints not healthy: applied={f_ap} geomOk={f_ok}")
        if r_ap != "yes" or r_ok != "yes":
            failures.append(f"rear hardpoints not healthy: applied={r_ap} geomOk={r_ok}")
        if not args.allow_partial_hardpoints and (f_part == "yes" or r_part == "yes"):
            failures.append("partial hardpoints detected (front or rear)")
    else:
        failures.append("missing hardpoints summary line")

    m_raw = re.search(
        r"raw spindle:\s*api=(ok|bad)\s+finite=(yes|no)\s+plausible=(yes|no).*?badFrames=([0-9]+)\/([0-9]+)",
        txt,
    )
    m_raw_alert = re.search(r"raw bad frames:\s*([0-9]+)", txt, flags=re.IGNORECASE)
    if m_raw:
        api_ok, finite_ok, plausible_ok, raw_bad, raw_limit = m_raw.groups()
        if api_ok != "ok":
            failures.append("raw spindle api is bad")
        if finite_ok != "yes":
            failures.append("raw spindle finite=no")
        if plausible_ok != "yes":
            failures.append("raw spindle plausible=no")
        if int(raw_bad) > int(raw_limit):
            failures.append(f"raw spindle badFrames exceeded: {raw_bad}/{raw_limit}")
    elif m_raw_alert:
        raw_bad = int(m_raw_alert.group(1))
        if raw_bad > 0:
            failures.append(f"raw spindle bad frames reported: {raw_bad}")
    elif not args.allow_missing_spindle_health:
        failures.append("missing raw spindle health line")

    m_bridge_line = re.search(r"^bridge(?: spindle)?:[^\n]*", txt, flags=re.IGNORECASE | re.MULTILINE)
    if m_bridge_line:
        line = m_bridge_line.group(0)
        reason = (_token(line, "reason", r"[a-zA-Z0-9_.\-]+") or "").lower()
        all_wheels = (_token(line, "allWheels", r"(?:yes|no)") or "").lower()
        sane = (_token(line, "sane", r"(?:yes|no)") or "").lower()
        fail_wheel = _token(line, "failWheel", r"[^\s]+")
        fail_stage = _token(line, "failStage", r"[^\s]+")
        direct_mask = _token(line, "directMask", r"[0-9.\-]+")
        fallback_mask = _token(line, "fallbackMask", r"[0-9.\-]+")

        if not reason or not all_wheels or not sane or direct_mask is None or fallback_mask is None:
            failures.append("bridge spindle health line missing required tokens")
            reason = reason or "missing"
            all_wheels = all_wheels or "missing"
            sane = sane or "missing"
            dmask = 0
            fmask = 0
        else:
            dmask = int(_f(direct_mask))
            fmask = int(_f(fallback_mask))

        reason_ok = reason.startswith("ok")
        if not reason_ok:
            failures.append(f"bridge spindle reason is {reason}")
        if all_wheels != "yes":
            failures.append("bridge spindle allWheels=no")
        if sane != "yes":
            failures.append("bridge spindle sane=no")
        if fail_wheel and fail_stage and (not reason_ok or all_wheels != "yes" or sane != "yes"):
            failures.append(f"bridge spindle first failure: wheel={fail_wheel} stage={fail_stage}")
        if fail_wheel and fail_wheel not in {"FL", "FR", "RL", "RR", "-", "—", "none", "n/a"}:
            failures.append(f"bridge spindle failWheel unknown: {fail_wheel}")
        if dmask < 0 or dmask > 15 or fmask < 0 or fmask > 15:
            failures.append(f"bridge spindle masks out of range: direct={dmask} fallback={fmask}")
        if dmask == 0 and fmask == 0:
            failures.append("bridge spindle has no valid wheels in direct or fallback paths")
    elif not args.allow_missing_spindle_health:
        failures.append("missing bridge spindle health line")

    # Dead-drivetrain guard:
    # When forward throttle is clearly commanded and powertrain is present/engaged,
    # persistent zero engine+driveshaft+wheel signals indicate a non-driving sim.
    m_cmd = re.search(r"throttle:\s*([0-9.\-]+)\s+brake:\s*([0-9.\-]+)", txt)
    m_pt = re.search(
        r"powertrain:\s*trans=(true|false)\s+hasEngine=(true|false).*?driveMode=([0-9.\-]+).*?gear=([0-9.\-]+).*?driveshaftNm=([0-9.\-]+).*?motorshaftRpm=([0-9.\-]+)",
        txt,
    )
    m_pt_detail = re.search(r"powertrain detail:\s*engineRpm=([0-9.\-]+)\s+engineNm=([0-9.\-]+)", txt)
    m_omega = re.search(r"wheel omega\(rad/s\):\s*FL=([0-9.\-]+)\s+FR=([0-9.\-]+)\s+RL=([0-9.\-]+)\s+RR=([0-9.\-]+)", txt)
    m_src = re.search(r"powertrain source:\s*([a-zA-Z0-9_.\-]+).*?\binertFrames=([0-9]+)", txt)
    if m_cmd and m_pt and m_pt_detail and m_omega and m_src:
        throttle_cmd, brake_cmd = map(_f, m_cmd.groups())
        trans_on = m_pt.group(1) == "true"
        eng_on = m_pt.group(2) == "true"
        drive_mode = _f(m_pt.group(3))
        gear = _f(m_pt.group(4))
        driveshaft_nm = _f(m_pt.group(5))
        motorshaft_rpm = _f(m_pt.group(6))
        engine_rpm = _f(m_pt_detail.group(1))
        engine_nm = _f(m_pt_detail.group(2))
        omegas = [_f(v) for v in m_omega.groups()]
        max_omega = max([abs(v) for v in omegas if v == v] or [0.0])  # NaN-safe
        inert_frames = int(m_src.group(2))
        demanding_forward = (
            throttle_cmd > 0.55
            and brake_cmd < 0.05
            and trans_on
            and eng_on
            and drive_mode >= 0.5
            and gear >= 0.5
        )
        drivetrain_dead = (
            abs(engine_rpm) < 1.0
            and abs(engine_nm) < 1.0
            and abs(driveshaft_nm) < 1.0
            and abs(motorshaft_rpm) < 5.0
            and max_omega < 0.05
        )
        if demanding_forward and drivetrain_dead and inert_frames >= args.max_inert_frames_under_throttle:
            failures.append(
                "dead drivetrain under forward throttle: engine/driveshaft/wheel signals remain zero"
            )

    if failures:
        print("FAIL")
        for it in failures:
            print(f"- {it}")
        return 1

    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
