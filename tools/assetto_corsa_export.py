#!/usr/bin/env python3
"""Export an Assetto Corsa car bundle for devtools.

Includes:
- A raw copy of the car's `data/` directory (or best-effort unpack of `data.acd` into `ac_raw/data/`)
- A lossless, line-numbered parse of every `*.ini` (stored in `ac_raw/params.raw.json`)
- An index of all exported files and discovered `*.lut` references
- Optional runtime trace conversion/copy (if provided)
"""

from __future__ import annotations

import argparse
import copy
import csv
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Dict, Iterable, List, Optional, Tuple

from assetto_corsa_kn5_to_obj import export_kn5_to_obj


UTC = getattr(dt, "UTC", dt.timezone.utc)


LUT_REF_RE = re.compile(r"([A-Za-z0-9_\-./\\]+\.lut)\b", re.IGNORECASE)
INCLUDE_REF_RE = re.compile(r"^\s*include(?:_ext)?\s*=\s*(.+?)\s*$", re.IGNORECASE)
ASSET_REF_RE = re.compile(
    r"([A-Za-z0-9_\-./\\]+\.(?:dds|png|jpg|jpeg|tga|bmp|gif|webp|exr|hdr))\b", re.IGNORECASE
)
TIME_KEY_CANDIDATES = (
    "t",
    "time",
    "timestamp",
    "time_s",
    "session_time",
    "physics_time",
)


def _now_stamp() -> str:
    return dt.datetime.now(UTC).replace(microsecond=0).isoformat().replace(":", "-") + "Z"


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            b = f.read(1024 * 1024)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def _read_text_lines(path: Path) -> List[str]:
    try:
        return path.read_text(encoding="utf-8").splitlines()
    except UnicodeDecodeError:
        return path.read_text(encoding="latin-1", errors="replace").splitlines()


def _parse_ini_lossless(ini_path: Path, display_path: str) -> Tuple[List[Dict], List[Dict]]:
    entries: List[Dict] = []
    lut_refs: List[Dict] = []
    section = ""
    lines = _read_text_lines(ini_path)

    for idx, raw in enumerate(lines, start=1):
        line = raw.strip()
        if not line:
            continue
        if line.startswith(";") or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].strip()
            continue
        if "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        item = {
            "file": display_path,
            "line": idx,
            "section": section,
            "key": key.strip(),
            "value": value.strip(),
            "raw": raw,
        }
        entries.append(item)
        for m in LUT_REF_RE.finditer(value):
            lut_refs.append(
                {
                    "file": display_path,
                    "line": idx,
                    "section": section,
                    "key": key.strip(),
                    "lut": m.group(1).replace("\\", "/"),
                }
            )
    return entries, lut_refs


def _copy_tree(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def _is_safe_rel_path(s: str) -> bool:
    s = str(s or "").strip()
    if not s:
        return False
    if s.startswith("/") or s.startswith("\\"):
        return False
    if ".." in s.replace("\\", "/").split("/"):
        return False
    return True


def _copy_file_preserve_rel(*, src: Path, base: Path, dst_root: Path) -> Optional[str]:
    try:
        src = Path(src).resolve()
        base = Path(base).resolve()
        if not src.exists() or not src.is_file():
            return None
        rel = src.relative_to(base).as_posix()
        out = (dst_root / rel).resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        if out.exists():
            return rel
        shutil.copy2(str(src), str(out))
        return rel
    except Exception:
        return None


def _read_text_best_effort(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="latin-1", errors="replace")
    except Exception:
        return ""


def _extract_include_refs(text: str) -> List[str]:
    out: List[str] = []
    for raw in str(text or "").splitlines():
        m = INCLUDE_REF_RE.match(raw)
        if not m:
            continue
        rhs = str(m.group(1) or "").strip()
        if not rhs:
            continue
        # INCLUDE often supports comma-separated includes.
        parts = [p.strip() for p in re.split(r"[,\s]+", rhs) if p.strip()]
        out.extend(parts)
    # Dedup preserve order.
    seen = set()
    uniq: List[str] = []
    for s in out:
        k = s.lower()
        if k in seen:
            continue
        seen.add(k)
        uniq.append(s)
    return uniq


def _extract_asset_path_refs(text: str) -> List[str]:
    out: List[str] = []
    for m in ASSET_REF_RE.finditer(str(text or "")):
        out.append(str(m.group(1) or "").replace("\\", "/"))
    # Dedup preserve order.
    seen = set()
    uniq: List[str] = []
    for s in out:
        k = s.lower()
        if k in seen:
            continue
        seen.add(k)
        uniq.append(s)
    return uniq


def _try_import_acd_lib() -> Optional[object]:
    """Best-effort import of the vendored `acd` library for unpacking data.acd.

    We vendor it under `repos/acd/acd` in this repo (see PhilippKosarev/acd).
    """
    try:
        # If user already installed `acd` in their environment, prefer that.
        import acd  # type: ignore

        return acd
    except Exception:
        pass
    try:
        repo_root = Path(__file__).resolve().parents[1]
        vendored = repo_root / "repos" / "acd" / "acd"
        if vendored.exists():
            sys.path.insert(0, str(vendored))
            import acd  # type: ignore

            return acd
    except Exception:
        return None
    return None


def _unpack_data_acd_to_dir(data_acd: Path, out_data_dir: Path) -> Dict[str, int]:
    """Unpack an Assetto Corsa `data.acd` into `out_data_dir`.

    Returns simple stats: { files_written, bytes_written }.
    """
    acd = _try_import_acd_lib()
    if not acd:
        raise SystemExit(
            "Car has packed data.acd but no unpacked data/. "
            "To auto-unpack, vendor the Python acd library into repos/acd (PhilippKosarev/acd) "
            "or `pip install git+https://github.com/PhilippKosarev/acd.git`."
        )

    out_data_dir.mkdir(parents=True, exist_ok=True)
    data = acd.read_file(str(data_acd))
    files_written = 0
    bytes_written = 0
    for rel_name, content in data.items():
        # Keys are filenames like "car.ini", "power.lut". Keep it conservative.
        rel = str(rel_name).replace("\\", "/").lstrip("/")
        if ".." in rel or rel.startswith("/"):
            continue
        out_path = out_data_dir / rel
        out_path.parent.mkdir(parents=True, exist_ok=True)
        # Library returns decoded string content.
        if not isinstance(content, str):
            continue
        # Preserve line endings; write as UTF-8.
        b = content.encode("utf-8", errors="replace")
        out_path.write_bytes(b)
        files_written += 1
        bytes_written += len(b)
    return {"files_written": files_written, "bytes_written": bytes_written}


def _iter_files(root: Path) -> Iterable[Path]:
    for p in sorted(root.rglob("*")):
        if p.is_file():
            yield p


def _safe_float(v) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _strip_ini_inline_comment(v) -> str:
    s = str(v or "")
    for ch in (";", "#"):
        i = s.find(ch)
        if i >= 0:
            s = s[:i]
    return s.strip()


def _build_ini_lookup(entries: List[Dict]):
    def _norm(s) -> str:
        return str(s or "").strip().lower()

    def _get(file_endswith: str, section: str, key: str) -> str:
        fe = _norm(file_endswith)
        sec = _norm(section)
        ky = _norm(key)
        for e in entries:
            f = _norm(e.get("file", ""))
            if not f:
                continue
            if fe and not (f.endswith(fe) or f.endswith("/" + fe)):
                continue
            if sec and _norm(e.get("section", "")) != sec:
                continue
            if ky and _norm(e.get("key", "")) != ky:
                continue
            return _strip_ini_inline_comment(e.get("value", ""))
        return ""

    def _get_any_section(file_endswith: str, key: str) -> str:
        fe = _norm(file_endswith)
        ky = _norm(key)
        for e in entries:
            f = _norm(e.get("file", ""))
            if not f:
                continue
            if fe and not (f.endswith(fe) or f.endswith("/" + fe)):
                continue
            if ky and _norm(e.get("key", "")) != ky:
                continue
            return _strip_ini_inline_comment(e.get("value", ""))
        return ""

    return _get, _get_any_section


def _parse_lut_pairs(path: Path) -> List[Tuple[float, float]]:
    out: List[Tuple[float, float]] = []
    if not path.exists() or not path.is_file():
        return out
    for raw in _read_text_lines(path):
        s = str(raw or "").strip()
        if not s:
            continue
        for ch in (";", "#"):
            i = s.find(ch)
            if i >= 0:
                s = s[:i].strip()
        if not s:
            continue
        if "|" in s:
            a, b = s.split("|", 1)
        elif "," in s:
            a, b = s.split(",", 1)
        else:
            parts = s.split()
            if len(parts) < 2:
                continue
            a, b = parts[0], parts[1]
        x = _safe_float(a.strip())
        y = _safe_float(b.strip())
        if x is None or y is None:
            continue
        out.append((float(x), float(y)))
    # Dedup/sort by x, keep last value for duplicate keys.
    by_x: Dict[float, float] = {}
    for x, y in out:
        by_x[float(x)] = float(y)
    return sorted([(k, by_x[k]) for k in by_x.keys()], key=lambda t: t[0])


def _load_jsonc(path: Path) -> Dict:
    txt = _read_text_best_effort(path)
    if not txt:
        return {}
    # Remove C++-style comments and block comments from Chrono sample files.
    txt = re.sub(r"/\*.*?\*/", "", txt, flags=re.DOTALL)
    txt = re.sub(r"(^|\s)//.*$", "", txt, flags=re.MULTILINE)
    try:
        j = json.loads(txt)
        return j if isinstance(j, dict) else {}
    except Exception:
        return {}


def _export_full_native_chrono_from_ac(*, car_id: str, run_id: str, entries: List[Dict], normalized_dir: Path, out_dir: Path) -> Dict:
    _get, _get_any = _build_ini_lookup(entries)
    # Hardpoint mode:
    # - AC_CHRONO_HARDPOINTS_MODE=off|template|0  => disable AC hardpoint mapping
    # - AC_CHRONO_HARDPOINTS_MODE=on|full|1       => force AC hardpoint mapping
    # - AC_CHRONO_HARDPOINTS_MODE=auto (default)  => legacy behavior, with per-car overrides.
    hp_mode_env = str(os.environ.get("AC_CHRONO_HARDPOINTS_MODE", "")).strip().lower()
    hp_mode = hp_mode_env or "auto"
    if hp_mode in ("0", "off", "none", "template"):
        use_ac_hardpoints = False
    elif hp_mode in ("1", "on", "true", "yes", "full", "force"):
        use_ac_hardpoints = True
    else:
        hp_mode = "auto"
        use_ac_hardpoints = False

    # Back-compat flag: AC_CHRONO_USE_HARDPOINTS=1/true/yes/on
    # only affects behavior when mode is auto.
    hp_env = str(os.environ.get("AC_CHRONO_USE_HARDPOINTS", "")).strip().lower()
    if hp_mode == "auto":
        use_ac_hardpoints = hp_env in ("1", "true", "yes", "on")
        # 350Z: AC-authored hardpoints are higher fidelity than generic template points.
        # Keep global default OFF, but auto-enable for this specific car unless user explicitly set env.
        if car_id == "streetcarpack_nissan_350z" and not hp_env:
            use_ac_hardpoints = True

    def _f(v, d=math.nan):
        x = _safe_float(v)
        return float(x) if x is not None else float(d)

    def _clamp(v: float, lo: float, hi: float) -> float:
        return max(lo, min(hi, float(v)))

    wheelbase = _f(_get("suspensions.ini", "basic", "wheelbase"), 2.6)
    if not math.isfinite(wheelbase):
        wheelbase = 2.6
    wheelbase = _clamp(wheelbase, 1.6, 4.2)

    steer_lock_deg = _f(_get_any("car.ini", "steer_lock"), math.nan)
    steer_ratio_raw = _f(_get_any("car.ini", "steer_ratio"), math.nan)
    steer_ratio = abs(steer_ratio_raw) if math.isfinite(steer_ratio_raw) else math.nan
    max_steer_deg = 25.0
    if math.isfinite(steer_lock_deg) and steer_lock_deg > 0:
        if math.isfinite(steer_ratio) and steer_ratio > 0.1:
            max_steer_deg = steer_lock_deg / steer_ratio
        elif steer_lock_deg <= 90:
            max_steer_deg = steer_lock_deg
        else:
            max_steer_deg = steer_lock_deg / 14.0
    max_steer_deg = _clamp(max_steer_deg, 8.0, 35.0)

    traction_type = str(_get("drivetrain.ini", "traction", "type") or _get_any("drivetrain.ini", "type") or "").strip().upper()
    if "4WD" in traction_type or "AWD" in traction_type:
        driveline = {"Input File": "generic/driveline/Driveline4WD.json", "Suspension Indexes": [0, 1]}
    elif "FWD" in traction_type:
        driveline = {"Input File": "generic/driveline/Driveline2WD.json", "Suspension Indexes": [0]}
    else:
        driveline = {"Input File": "generic/driveline/Driveline2WD.json", "Suspension Indexes": [1]}

    tyre_idx_raw = _f(_get("tyres.ini", "compound_default", "index"), math.nan)
    tyre_idx = int(max(0, min(9, math.floor(tyre_idx_raw)))) if math.isfinite(tyre_idx_raw) else 0
    front_sec = f"FRONT_{tyre_idx + 1}"
    rear_sec = f"REAR_{tyre_idx + 1}"

    r_f = _f(_get("tyres.ini", front_sec, "radius") or _get("tyres.ini", "front", "radius"), math.nan)
    w_f = _f(_get("tyres.ini", front_sec, "width") or _get("tyres.ini", "front", "width"), math.nan)
    dy0 = _f(_get("tyres.ini", front_sec, "dy0") or _get("tyres.ini", "front", "dy0"), math.nan)
    dx0 = _f(_get("tyres.ini", front_sec, "dx0") or _get("tyres.ini", "front", "dx0"), math.nan)
    relax = _f(_get("tyres.ini", front_sec, "relaxation_length") or _get("tyres.ini", "front", "relaxation_length"), 0.15)
    tyre_rate_f = _f(_get("tyres.ini", front_sec, "rate") or _get("tyres.ini", "front", "rate"), 310000)
    tyre_damp_f = _f(_get("tyres.ini", front_sec, "damp") or _get("tyres.ini", "front", "damp"), 3100)
    tyre_rate_f = _clamp(tyre_rate_f if math.isfinite(tyre_rate_f) else 310000, 20_000, 800_000)
    tyre_damp_f = _clamp(tyre_damp_f if math.isfinite(tyre_damp_f) else 3100, 50, 50_000)

    wheel_r = _clamp(r_f if math.isfinite(r_f) else 0.31, 0.18, 0.65)
    wheel_w = _clamp(w_f if math.isfinite(w_f) else 0.23, 0.08, 0.45)
    mu_like = max(dy0 if math.isfinite(dy0) else 0.0, dx0 if math.isfinite(dx0) else 0.0)
    u_max = _clamp(mu_like if mu_like > 0 else 1.0, 0.5, 3.0)
    u_min = _clamp(u_max * 0.90, 0.3, u_max)
    relax = _clamp(relax if math.isfinite(relax) else 0.15, 0.005, 1.5)

    # Build a full native Chrono package for this car under /data/vehicle/<car_id>/...
    repo_root = Path(__file__).resolve().parents[1]
    chrono_tpl_root = (repo_root / "tools" / "third_party" / "chrono" / "data" / "vehicle").resolve()
    car_fs_root = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(car_id or "car")).strip("_") or "car"
    front_x = 0.5 * wheelbase
    rear_x = -0.5 * wheelbase

    # AC physical signals.
    mass_total = _f(_get_any("car.ini", "totalmass"), 1300.0)
    if not math.isfinite(mass_total) or mass_total <= 100:
        mass_total = 1300.0
    mass_total = _clamp(mass_total, 400.0, 5000.0)

    dim_x = _f((_get_any("car.ini", "inertia") or "").split(",")[0] if _get_any("car.ini", "inertia") else "", 4.3)
    dim_y = _f((_get_any("car.ini", "inertia") or "").split(",")[1] if _get_any("car.ini", "inertia") else "", 1.8)
    dim_z = _f((_get_any("car.ini", "inertia") or "").split(",")[2] if _get_any("car.ini", "inertia") else "", 1.3)
    dim_x = _clamp(dim_x if math.isfinite(dim_x) else 4.3, 2.0, 7.0)
    dim_y = _clamp(dim_y if math.isfinite(dim_y) else 1.8, 1.0, 3.0)
    dim_z = _clamp(dim_z if math.isfinite(dim_z) else 1.3, 0.8, 3.0)
    moi_x = (mass_total / 12.0) * (dim_y * dim_y + dim_z * dim_z)
    moi_y = (mass_total / 12.0) * (dim_x * dim_x + dim_z * dim_z)
    moi_z = (mass_total / 12.0) * (dim_x * dim_x + dim_y * dim_y)

    cg_front_frac = _f(_get("suspensions.ini", "basic", "cg_location"), 0.5)
    cg_front_frac = _clamp(cg_front_frac if math.isfinite(cg_front_frac) else 0.5, 0.35, 0.65)
    cg_x = (cg_front_frac - 0.5) * wheelbase
    basey_f = _f(_get("suspensions.ini", "front", "basey"), -0.22)
    basey_r = _f(_get("suspensions.ini", "rear", "basey"), -0.22)
    r_r = _f(_get("tyres.ini", rear_sec, "radius") or _get("tyres.ini", "rear", "radius"), wheel_r)
    cg_z = max(0.05, 0.5 * ((wheel_r + basey_f) + ((r_r if math.isfinite(r_r) else wheel_r) + basey_r)))

    track_f = _f(_get("suspensions.ini", "front", "track"), 1.55)
    track_r = _f(_get("suspensions.ini", "rear", "track"), 1.55)
    track_f = _clamp(track_f if math.isfinite(track_f) else 1.55, 1.1, 2.4)
    track_r = _clamp(track_r if math.isfinite(track_r) else 1.55, 1.1, 2.4)
    toe_out_f = _f(_get("suspensions.ini", "front", "toe_out"), 0.0)
    toe_out_r = _f(_get("suspensions.ini", "rear", "toe_out"), 0.0)
    toe_deg_f = _clamp(math.degrees(math.atan2(toe_out_f, max(0.2, 0.5 * track_f))), -10.0, 10.0)
    toe_deg_r = _clamp(math.degrees(math.atan2(toe_out_r, max(0.2, 0.5 * track_r))), -10.0, 10.0)
    arb_f = _clamp(_f(_get("suspensions.ini", "arb", "front"), 0.0), 0.0, 2_000_000.0)
    arb_r = _clamp(_f(_get("suspensions.ini", "arb", "rear"), 0.0), 0.0, 2_000_000.0)

    spring_f = _f(_get("suspensions.ini", "front", "spring_rate"), 80_000.0)
    spring_r = _f(_get("suspensions.ini", "rear", "spring_rate"), 80_000.0)
    prog_spring_f = _f(_get("suspensions.ini", "front", "progressive_spring_rate"), 0.0)
    prog_spring_r = _f(_get("suspensions.ini", "rear", "progressive_spring_rate"), 0.0)
    bump_stop_rate_f = _f(_get("suspensions.ini", "front", "bump_stop_rate"), 0.0)
    bump_stop_rate_r = _f(_get("suspensions.ini", "rear", "bump_stop_rate"), 0.0)
    bump_stop_up_f = _f(_get("suspensions.ini", "front", "bumpstop_up"), 0.0)
    bump_stop_up_r = _f(_get("suspensions.ini", "rear", "bumpstop_up"), 0.0)
    bump_stop_dn_f = _f(_get("suspensions.ini", "front", "bumpstop_dn"), 0.0)
    bump_stop_dn_r = _f(_get("suspensions.ini", "rear", "bumpstop_dn"), 0.0)
    packer_range_f = _f(_get("suspensions.ini", "front", "packer_range"), 0.0)
    packer_range_r = _f(_get("suspensions.ini", "rear", "packer_range"), 0.0)
    spring_f = _clamp(spring_f if math.isfinite(spring_f) else 80_000.0, 5_000.0, 1_500_000.0)
    spring_r = _clamp(spring_r if math.isfinite(spring_r) else 80_000.0, 5_000.0, 1_500_000.0)
    damp_f_b = _f(_get("suspensions.ini", "front", "damp_bump"), 6_000.0)
    damp_f_r = _f(_get("suspensions.ini", "front", "damp_rebound"), 8_000.0)
    damp_r_b = _f(_get("suspensions.ini", "rear", "damp_bump"), 6_000.0)
    damp_r_r = _f(_get("suspensions.ini", "rear", "damp_rebound"), 8_000.0)
    damp_f_fb = _f(_get("suspensions.ini", "front", "damp_fast_bump"), damp_f_b)
    damp_f_fr = _f(_get("suspensions.ini", "front", "damp_fast_rebound"), damp_f_r)
    damp_r_fb = _f(_get("suspensions.ini", "rear", "damp_fast_bump"), damp_r_b)
    damp_r_fr = _f(_get("suspensions.ini", "rear", "damp_fast_rebound"), damp_r_r)
    damp_f_bt = _f(_get("suspensions.ini", "front", "damp_fast_bumpthreshold"), 0.05)
    damp_f_rt = _f(_get("suspensions.ini", "front", "damp_fast_reboundthreshold"), 0.05)
    damp_r_bt = _f(_get("suspensions.ini", "rear", "damp_fast_bumpthreshold"), 0.05)
    damp_r_rt = _f(_get("suspensions.ini", "rear", "damp_fast_reboundthreshold"), 0.05)
    damp_f = _clamp(0.65 * 0.5 * (abs(damp_f_b) + abs(damp_f_r)) + 0.35 * 0.5 * (abs(damp_f_fb) + abs(damp_f_fr)), 100.0, 80_000.0)
    damp_r = _clamp(0.65 * 0.5 * (abs(damp_r_b) + abs(damp_r_r)) + 0.35 * 0.5 * (abs(damp_r_fb) + abs(damp_r_fr)), 100.0, 80_000.0)
    camber_f = _f(_get("suspensions.ini", "front", "static_camber"), 0.0)
    camber_r = _f(_get("suspensions.ini", "rear", "static_camber"), 0.0)
    camber_f = _clamp(camber_f if math.isfinite(camber_f) else 0.0, -8.0, 8.0)
    camber_r = _clamp(camber_r if math.isfinite(camber_r) else 0.0, -8.0, 8.0)

    hub_mass_f = _f(_get("suspensions.ini", "front", "hub_mass"), 60.0)
    hub_mass_r = _f(_get("suspensions.ini", "rear", "hub_mass"), 60.0)
    wheel_mass_f = _clamp((hub_mass_f if math.isfinite(hub_mass_f) else 60.0) * 0.25, 8.0, 40.0)
    wheel_mass_r = _clamp((hub_mass_r if math.isfinite(hub_mass_r) else 60.0) * 0.25, 8.0, 40.0)
    ang_inertia_f = _f(_get("tyres.ini", front_sec, "angular_inertia") or _get("tyres.ini", "front", "angular_inertia"), 1.2)
    ang_inertia_r = _f(_get("tyres.ini", rear_sec, "angular_inertia") or _get("tyres.ini", "rear", "angular_inertia"), 1.2)
    ang_inertia_f = _clamp(ang_inertia_f if math.isfinite(ang_inertia_f) else 1.2, 0.1, 10.0)
    ang_inertia_r = _clamp(ang_inertia_r if math.isfinite(ang_inertia_r) else 1.2, 0.1, 10.0)
    wheel_w_f = wheel_w
    wheel_w_r = _clamp(_f(_get("tyres.ini", rear_sec, "width") or _get("tyres.ini", "rear", "width"), wheel_w), 0.08, 0.45)
    wheel_r_r = _clamp(r_r if math.isfinite(r_r) else wheel_r, 0.18, 0.65)
    rim_r_f = _clamp(_f(_get("tyres.ini", front_sec, "rim_radius") or _get("tyres.ini", "front", "rim_radius"), wheel_r * 0.72), 0.12, wheel_r)
    rim_r_r = _clamp(_f(_get("tyres.ini", rear_sec, "rim_radius") or _get("tyres.ini", "rear", "rim_radius"), wheel_r_r * 0.72), 0.12, wheel_r_r)

    brake_max = _f(_get("brakes.ini", "data", "max_torque"), 2500.0)
    brake_front_share = _f(_get("brakes.ini", "data", "front_share"), 0.65)
    brake_max = _clamp(brake_max if math.isfinite(brake_max) else 2500.0, 200.0, 15_000.0)
    brake_front_share = _clamp(brake_front_share if math.isfinite(brake_front_share) else 0.65, 0.3, 0.9)
    brake_f_tq = _clamp(brake_max * brake_front_share, 150.0, 20_000.0)
    brake_r_tq = _clamp(brake_max * (1.0 - brake_front_share), 100.0, 20_000.0)

    engine_limiter = _f(_get("engine.ini", "engine_data", "limiter"), 7500.0)
    engine_idle = _f(_get("engine.ini", "engine_data", "minimum"), 800.0)
    engine_limiter = _clamp(engine_limiter if math.isfinite(engine_limiter) else 7500.0, 2000.0, 20_000.0)
    engine_idle = _clamp(engine_idle if math.isfinite(engine_idle) else 800.0, 200.0, engine_limiter * 0.8)
    coast_ref_rpm = _f(_get("engine.ini", "coast_ref", "rpm"), engine_limiter)
    coast_ref_torque = _f(_get("engine.ini", "coast_ref", "torque"), 60.0)
    coast_ref_rpm = _clamp(coast_ref_rpm if math.isfinite(coast_ref_rpm) else engine_limiter, engine_idle, engine_limiter * 1.2)
    coast_ref_torque = _clamp(abs(coast_ref_torque if math.isfinite(coast_ref_torque) else 60.0), 5.0, 600.0)

    gear_r = _f(_get("drivetrain.ini", "gears", "gear_r"), 3.2)
    gear_count_raw = _f(_get("drivetrain.ini", "gears", "count"), 6.0)
    gear_count = int(_clamp(math.floor(gear_count_raw) if math.isfinite(gear_count_raw) else 6.0, 1, 12))
    final_drive = _f(_get("drivetrain.ini", "gears", "final"), 3.8)
    final_drive = _clamp(abs(final_drive if math.isfinite(final_drive) else 3.8), 0.5, 10.0)
    supports_shifter_raw = _f(_get("drivetrain.ini", "gearbox", "supports_shifter"), math.nan)
    supports_shifter = bool(math.isfinite(supports_shifter_raw) and supports_shifter_raw >= 0.5)
    gearbox_inertia = _f(_get("drivetrain.ini", "gearbox", "inertia"), 0.02)
    gearbox_inertia = _clamp(gearbox_inertia if math.isfinite(gearbox_inertia) else 0.02, 0.005, 0.25)
    clutch_max_torque = _f(_get("drivetrain.ini", "clutch", "max_torque"), 450.0)
    clutch_max_torque = _clamp(clutch_max_torque if math.isfinite(clutch_max_torque) else 450.0, 120.0, 4000.0)
    fwd_red: List[float] = []
    for gi in range(1, gear_count + 1):
        gv = _f(_get("drivetrain.ini", "gears", f"gear_{gi}"), math.nan)
        if math.isfinite(gv) and gv > 0:
            fwd_red.append(float(gv))
    if not fwd_red:
        fwd_red = [2.8, 1.9, 1.4, 1.1, 0.95, 0.82]
    # AutomaticTransmissionSimpleMap expects transmission gear-box ratios only.
    # Final drive belongs in driveline["Gear Ratio"]["Conical Gear"].
    fwd_ratios = [_clamp(1.0 / g, 0.02, 3.0) for g in fwd_red]
    rev_ratio = -_clamp(1.0 / abs(gear_r if math.isfinite(gear_r) else 3.2), 0.02, 3.0)
    # Some AC packs expose gear_i values that already include final drive, producing
    # ratios close to 1/final. Detect that and un-bake final to avoid double application.
    conical_ratio = _clamp(1.0 / final_drive, 0.02, 2.0)
    ratio_looks_final_baked = any(
        (r > 1e-6) and (abs((r / conical_ratio) - 1.0) <= 0.03)
        for r in fwd_ratios
    )
    if ratio_looks_final_baked:
        fwd_ratios = [_clamp(r * final_drive, 0.02, 3.0) for r in fwd_ratios]
        rev_ratio = -_clamp(abs(rev_ratio) * final_drive, 0.02, 3.0)
    shift_up = _clamp(engine_limiter * 0.93, engine_idle + 500.0, engine_limiter * 1.1)
    shift_dn = _clamp(max(engine_idle + 250.0, engine_limiter * 0.35), engine_idle + 150.0, shift_up - 100.0)

    diff_power = _f(_get("drivetrain.ini", "differential", "power"), 0.2)
    diff_coast = _f(_get("drivetrain.ini", "differential", "coast"), 0.2)
    diff_preload = _f(_get("drivetrain.ini", "differential", "preload"), 20.0)
    diff_power = _clamp(diff_power if math.isfinite(diff_power) else 0.2, 0.0, 1.0)
    diff_coast = _clamp(diff_coast if math.isfinite(diff_coast) else 0.2, 0.0, 1.0)
    diff_preload = _clamp(diff_preload if math.isfinite(diff_preload) else 20.0, 0.0, 500.0)
    diff_lock_limit = _clamp(diff_preload * (1.0 + 2.0 * max(diff_power, diff_coast)), 10.0, 5_000.0)

    # Tire model values from selected AC compound.
    dy0_r = _f(_get("tyres.ini", rear_sec, "dy0") or _get("tyres.ini", "rear", "dy0"), dy0 if math.isfinite(dy0) else 1.0)
    dx0_r = _f(_get("tyres.ini", rear_sec, "dx0") or _get("tyres.ini", "rear", "dx0"), dx0 if math.isfinite(dx0) else 1.0)
    relax_r = _f(_get("tyres.ini", rear_sec, "relaxation_length") or _get("tyres.ini", "rear", "relaxation_length"), relax)
    tyre_rate_r = _f(_get("tyres.ini", rear_sec, "rate") or _get("tyres.ini", "rear", "rate"), tyre_rate_f)
    tyre_damp_r = _f(_get("tyres.ini", rear_sec, "damp") or _get("tyres.ini", "rear", "damp"), tyre_damp_f)
    tyre_rate_r = _clamp(tyre_rate_r if math.isfinite(tyre_rate_r) else tyre_rate_f, 20_000, 800_000)
    tyre_damp_r = _clamp(tyre_damp_r if math.isfinite(tyre_damp_r) else tyre_damp_f, 50, 50_000)
    u_max_r = _clamp(max(dy0_r if math.isfinite(dy0_r) else 0.0, dx0_r if math.isfinite(dx0_r) else 0.0) or u_max, 0.5, 3.0)
    u_min_r = _clamp(u_max_r * 0.90, 0.3, u_max_r)
    relax_r = _clamp(relax_r if math.isfinite(relax_r) else relax, 0.005, 1.5)

    # Torque map from AC power.lut.
    power_curve_rel = _get("engine.ini", "header", "power_curve") or _get("engine.ini", "", "power_curve")
    if not power_curve_rel:
        power_curve_rel = _get_any("engine.ini", "power_curve")
    power_curve_rel = str(power_curve_rel or "power.lut").strip().replace("\\", "/")
    ac_data_dir = (out_dir / "ac_raw" / "data").resolve()
    power_curve_path = (ac_data_dir / Path(power_curve_rel).name).resolve()
    lut = _parse_lut_pairs(power_curve_path)
    if not lut:
        lut = [(500.0, 80.0), (1000.0, 140.0), (2000.0, 220.0), (3000.0, 260.0), (4000.0, 280.0), (5000.0, 270.0), (6500.0, 230.0)]
    full_map = [[-10.0, max(0.0, lut[0][1])]] + [[float(r), float(t)] for (r, t) in lut]
    zero_map = [
        [-10.0, 0.0],
        [10.0, 0.0],
        [float(engine_idle), -0.25 * coast_ref_torque],
        [float(max(engine_idle + 400.0, 0.4 * coast_ref_rpm)), -0.40 * coast_ref_torque],
        [float(max(engine_idle + 800.0, 0.7 * coast_ref_rpm)), -0.70 * coast_ref_torque],
        [float(coast_ref_rpm), -coast_ref_torque],
        [float(max(engine_limiter, coast_ref_rpm + 250.0)), -1.15 * coast_ref_torque],
    ]

    # Templates.
    tpl_chassis = _load_jsonc(chrono_tpl_root / "generic" / "chassis" / "Chassis.json")
    tpl_steer = _load_jsonc(chrono_tpl_root / "generic" / "steering" / "RackPinion.json")
    tpl_susp_f = _load_jsonc(chrono_tpl_root / "generic" / "suspension" / "MacPhersonStrut.json")
    tpl_susp_r = _load_jsonc(chrono_tpl_root / "generic" / "suspension" / "DoubleWishbone.json")
    tpl_wheel = _load_jsonc(chrono_tpl_root / "generic" / "wheel" / "WheelSimple.json")
    tpl_brake = _load_jsonc(chrono_tpl_root / "generic" / "brake" / "BrakeSimple.json")
    tpl_arb = _load_jsonc(chrono_tpl_root / "generic" / "antirollbar" / "AntirollBarRSD.json")
    tpl_dline = _load_jsonc(chrono_tpl_root / "generic" / "driveline" / ("Driveline4WD.json" if ("4WD" in traction_type or "AWD" in traction_type) else "Driveline2WD.json"))
    tpl_tire = _load_jsonc(chrono_tpl_root / "generic" / "tire" / "FialaTire.json")

    chassis_json = copy.deepcopy(tpl_chassis) if tpl_chassis else {
        "Name": f"{car_id} chassis",
        "Type": "Chassis",
        "Template": "RigidChassis",
        "Components": [{"Centroidal Frame": {"Location": [0, 0, 0.2], "Orientation": [1, 0, 0, 0]}, "Mass": mass_total, "Moments of Inertia": [moi_x, moi_y, moi_z], "Products of Inertia": [0, 0, 0], "Void": False}],
    }
    comps = chassis_json.get("Components") if isinstance(chassis_json.get("Components"), list) else []
    if not comps:
        comps = [{}]
        chassis_json["Components"] = comps
    c0 = comps[0] if isinstance(comps[0], dict) else {}
    c0["Mass"] = mass_total
    c0["Moments of Inertia"] = [moi_x, moi_y, moi_z]
    c0["Products of Inertia"] = [0, 0, 0]
    cf = c0.get("Centroidal Frame") if isinstance(c0.get("Centroidal Frame"), dict) else {}
    cf["Location"] = [cg_x, 0.0, cg_z]
    cf["Orientation"] = [1, 0, 0, 0]
    c0["Centroidal Frame"] = cf
    comps[0] = c0
    chassis_json["Components"] = comps
    chassis_json["Name"] = f"{car_id} chassis"

    def _scale_y_fields(node, ratio):
        # Scale only geometric coordinate vectors (Y component), never generic numeric arrays
        # such as inertia/moments, to avoid corrupting dynamics parameters.
        point_keys = {
            "COM",
            "Location",
            "Location Chassis",
            "Location Chassis Front",
            "Location Chassis Back",
            "Location Upright",
            "Location Arm",
            "Driver Position",
        }
        if isinstance(node, dict):
            for k, v in list(node.items()):
                if (
                    isinstance(v, list)
                    and len(v) >= 3
                    and all(isinstance(x, (int, float)) for x in v[:3])
                    and (k in point_keys or "Location" in str(k))
                ):
                    vv = list(v)
                    vv[1] = float(vv[1]) * ratio
                    node[k] = vv
                else:
                    _scale_y_fields(v, ratio)
        elif isinstance(node, list):
            for item in node:
                _scale_y_fields(item, ratio)

    def _spindle_y_half_track(susp_json: Dict, fallback_half_track: float) -> float:
        if not isinstance(susp_json, dict):
            return fallback_half_track
        sp = susp_json.get("Spindle")
        if not isinstance(sp, dict):
            return fallback_half_track
        com = sp.get("COM")
        if not (isinstance(com, list) and len(com) >= 2):
            return fallback_half_track
        yv = _f(com[1], math.nan)
        if not math.isfinite(yv):
            return fallback_half_track
        return max(0.05, abs(float(yv)))

    def _parse_vec3(txt: str) -> Optional[Tuple[float, float, float]]:
        s = str(txt or "").strip()
        if not s:
            return None
        parts = [p.strip() for p in s.split(",")]
        if len(parts) < 3:
            return None
        a = _safe_float(parts[0])
        b = _safe_float(parts[1])
        c = _safe_float(parts[2])
        if a is None or b is None or c is None:
            return None
        return (float(a), float(b), float(c))

    def _hp(section: str, key: str) -> Optional[Tuple[float, float, float]]:
        return _parse_vec3(_get("suspensions.ini", section, key))

    def _ac_to_chrono_car(v: Tuple[float, float, float], half_track: float) -> List[float]:
        # Chassis-side hardpoints (WBCAR_*, STRUT_CAR) are in a car-local frame:
        # x=lateral from centerline, y=vertical, z=longitudinal.
        lat_car, vert, lon = float(v[0]), float(v[1]), float(v[2])
        return [
            _clamp(lon, -1.5, 1.5),
            _clamp(abs(lat_car), 0.05, 1.8),
            _clamp(vert, -1.2, 1.2),
        ]

    def _ac_to_chrono_tyre(v: Tuple[float, float, float], half_track: float) -> List[float]:
        # Wheel/upright-side hardpoints (WBTYRE_*, STRUT_TYRE) are in a wheel-side frame:
        # x=lateral offset from wheel center toward chassis, y=vertical, z=longitudinal.
        lat_off, vert, lon = float(v[0]), float(v[1]), float(v[2])
        return [
            _clamp(lon, -1.5, 1.5),
            _clamp(half_track - lat_off, 0.05, 1.8),
            _clamp(vert, -1.2, 1.2),
        ]

    def _v3(v) -> Optional[Tuple[float, float, float]]:
        if not isinstance(v, list) or len(v) < 3:
            return None
        x = _f(v[0], math.nan)
        y = _f(v[1], math.nan)
        z = _f(v[2], math.nan)
        if not (math.isfinite(x) and math.isfinite(y) and math.isfinite(z)):
            return None
        return (float(x), float(y), float(z))

    def _dist(a, b) -> float:
        av = _v3(a)
        bv = _v3(b)
        if av is None or bv is None:
            return math.inf
        dx = av[0] - bv[0]
        dy = av[1] - bv[1]
        dz = av[2] - bv[2]
        return float(math.sqrt(dx * dx + dy * dy + dz * dz))

    def _front_geom_ok(sj: Dict, target_track: float) -> bool:
        ca = sj.get("Control Arm") if isinstance(sj.get("Control Arm"), dict) else {}
        tr = sj.get("Tierod") if isinstance(sj.get("Tierod"), dict) else {}
        up = ca.get("Location Upright")
        cf = ca.get("Location Chassis Front")
        cb = ca.get("Location Chassis Back")
        tc = tr.get("Location Chassis")
        tu = tr.get("Location Upright")
        uv = _v3(up)
        sp_half = _track_half_ref_from_spindle(sj)
        if sp_half is not None:
            track_est = 2.0 * sp_half
        elif uv is not None:
            track_est = 2.0 * abs(uv[1])
        else:
            return False
        tr_len = _dist(tc, tu)
        a_len0 = _dist(cf, up)
        a_len1 = _dist(cb, up)
        base_span = _dist(cf, cb)
        return (
            0.85 * target_track <= track_est <= 1.20 * target_track
            and 0.08 <= tr_len <= 1.2
            and 0.08 <= a_len0 <= 1.4
            and 0.08 <= a_len1 <= 1.4
            and 0.10 <= base_span <= 1.2
        )

    def _rear_geom_ok(sj: Dict, target_track: float) -> bool:
        ua = sj.get("Upper Control Arm") if isinstance(sj.get("Upper Control Arm"), dict) else {}
        la = sj.get("Lower Control Arm") if isinstance(sj.get("Lower Control Arm"), dict) else {}
        tr = sj.get("Tierod") if isinstance(sj.get("Tierod"), dict) else {}
        up = _v3(ua.get("Location Upright")) or _v3(la.get("Location Upright"))
        tc = tr.get("Location Chassis")
        tu = tr.get("Location Upright")
        sp_half = _track_half_ref_from_spindle(sj)
        if sp_half is not None:
            track_est = 2.0 * sp_half
        elif up is not None:
            track_est = 2.0 * abs(up[1])
        else:
            return False
        tr_len = _dist(tc, tu)
        ua_cf = ua.get("Location Chassis Front")
        ua_cb = ua.get("Location Chassis Back")
        la_cf = la.get("Location Chassis Front")
        la_cb = la.get("Location Chassis Back")
        span_u = _dist(ua_cf, ua_cb)
        span_l = _dist(la_cf, la_cb)
        return (
            0.85 * target_track <= track_est <= 1.20 * target_track
            and 0.08 <= tr_len <= 1.2
            and 0.10 <= span_u <= 1.5
            and 0.10 <= span_l <= 1.5
        )

    def _scale_point_y(p, s):
        v = _v3(p)
        if v is None:
            return p
        return [v[0], v[1] * s, v[2]]

    def _track_half_ref_from_spindle(sj: Dict) -> Optional[float]:
        if not isinstance(sj, dict):
            return None
        sp = sj.get("Spindle") if isinstance(sj.get("Spindle"), dict) else {}
        # Spindle COM Y is a better wheel-center proxy than control-arm upright pickup.
        com = _v3(sp.get("COM"))
        if com is not None and abs(com[1]) > 1e-4:
            return abs(com[1])
        up = sj.get("Upright") if isinstance(sj.get("Upright"), dict) else {}
        up_com = _v3(up.get("COM"))
        if up_com is not None and abs(up_com[1]) > 1e-4:
            return abs(up_com[1])
        return None

    def _normalize_front_track(sj: Dict, target_track: float):
        if not isinstance(sj, dict):
            return
        cur_half = _track_half_ref_from_spindle(sj)
        if cur_half is None:
            ca = sj.get("Control Arm") if isinstance(sj.get("Control Arm"), dict) else {}
            up = _v3(ca.get("Location Upright"))
            if up is None:
                return
            cur_half = abs(up[1])
        if cur_half < 1e-4:
            return
        s = _clamp((0.5 * target_track) / cur_half, 0.4, 2.5)
        for sec_name, keys in (
            ("Spindle", ("COM",)),
            ("Upright", ("COM",)),
            ("Control Arm", ("Location Chassis Front", "Location Chassis Back", "Location Upright")),
            ("Tierod", ("Location Chassis", "Location Upright")),
            ("Spring", ("Location Chassis", "Location Upright")),
            ("Shock", ("Location Chassis", "Location Upright")),
        ):
            sec = sj.get(sec_name) if isinstance(sj.get(sec_name), dict) else None
            if not isinstance(sec, dict):
                continue
            for k in keys:
                if k in sec:
                    sec[k] = _scale_point_y(sec.get(k), s)

    def _normalize_rear_track(sj: Dict, target_track: float):
        if not isinstance(sj, dict):
            return
        cur_half = _track_half_ref_from_spindle(sj)
        if cur_half is None:
            la = sj.get("Lower Control Arm") if isinstance(sj.get("Lower Control Arm"), dict) else {}
            up = _v3(la.get("Location Upright"))
            if up is None:
                ua = sj.get("Upper Control Arm") if isinstance(sj.get("Upper Control Arm"), dict) else {}
                up = _v3(ua.get("Location Upright"))
            if up is None:
                return
            cur_half = abs(up[1])
        if cur_half < 1e-4:
            return
        s = _clamp((0.5 * target_track) / cur_half, 0.4, 2.5)
        for sec_name, keys in (
            ("Spindle", ("COM",)),
            ("Upright", ("COM",)),
            ("Upper Control Arm", ("Location Chassis Front", "Location Chassis Back", "Location Upright")),
            ("Lower Control Arm", ("Location Chassis Front", "Location Chassis Back", "Location Upright")),
            ("Tierod", ("Location Chassis", "Location Upright")),
            ("Spring", ("Location Chassis", "Location Arm")),
            ("Shock", ("Location Chassis", "Location Arm")),
        ):
            sec = sj.get(sec_name) if isinstance(sj.get(sec_name), dict) else None
            if not isinstance(sec, dict):
                continue
            for k in keys:
                if k in sec:
                    sec[k] = _scale_point_y(sec.get(k), s)

    def _copy_if_vec3(v, fallback):
        vv = _v3(v)
        if vv is not None:
            return [vv[0], vv[1], vv[2]]
        fb = _v3(fallback)
        if fb is not None:
            return [fb[0], fb[1], fb[2]]
        return fallback

    def _limit_point_delta(mapped, ref, max_delta: float = 0.75):
        mv = _v3(mapped)
        rv = _v3(ref)
        if mv is None:
            return ref
        if rv is None:
            return [mv[0], mv[1], mv[2]]
        dx = mv[0] - rv[0]
        dy = mv[1] - rv[1]
        dz = mv[2] - rv[2]
        n = math.sqrt(dx * dx + dy * dy + dz * dz)
        if n <= max_delta or n <= 1e-9:
            return [mv[0], mv[1], mv[2]]
        s = max_delta / n
        return [rv[0] + dx * s, rv[1] + dy * s, rv[2] + dz * s]

    def _apply_mapped_point(mapped, ref, max_delta: float = 0.75):
        out = _limit_point_delta(mapped, ref, max_delta=max_delta)
        mv = _v3(mapped)
        ov = _v3(out)
        if mv is None:
            return out, "template_missing"
        if ov is None:
            return out, "ac"
        d = math.dist(mv, ov)
        return out, ("ac_clamped" if d > 1e-6 else "ac")

    def _repair_front_hardpoints_if_degenerate(sj: Dict, tpl_scaled: Dict):
        if not isinstance(sj, dict) or not isinstance(tpl_scaled, dict):
            return
        ca = sj.get("Control Arm") if isinstance(sj.get("Control Arm"), dict) else {}
        tr = sj.get("Tierod") if isinstance(sj.get("Tierod"), dict) else {}
        sp = sj.get("Spring") if isinstance(sj.get("Spring"), dict) else {}
        sh = sj.get("Shock") if isinstance(sj.get("Shock"), dict) else {}
        t_ca = tpl_scaled.get("Control Arm") if isinstance(tpl_scaled.get("Control Arm"), dict) else {}
        t_tr = tpl_scaled.get("Tierod") if isinstance(tpl_scaled.get("Tierod"), dict) else {}
        t_sp = tpl_scaled.get("Spring") if isinstance(tpl_scaled.get("Spring"), dict) else {}
        t_sh = tpl_scaled.get("Shock") if isinstance(tpl_scaled.get("Shock"), dict) else {}

        # Degenerate strut/upright attachment (often STRUT_TYRE == WBTYRE_BOTTOM) creates near-singular constraints.
        if _dist(sp.get("Location Upright"), ca.get("Location Upright")) < 0.06:
            sp["Location Upright"] = _copy_if_vec3(t_sp.get("Location Upright"), sp.get("Location Upright"))
            sh["Location Upright"] = _copy_if_vec3(t_sh.get("Location Upright"), sh.get("Location Upright"))

        # Very short tie-rod length is unstable in Chrono's rack+strut setup.
        if _dist(tr.get("Location Chassis"), tr.get("Location Upright")) < 0.16:
            tr["Location Chassis"] = _copy_if_vec3(t_tr.get("Location Chassis"), tr.get("Location Chassis"))
            tr["Location Upright"] = _copy_if_vec3(t_tr.get("Location Upright"), tr.get("Location Upright"))

        if ca:
            sj["Control Arm"] = ca
        if tr:
            sj["Tierod"] = tr
        if sp:
            sj["Spring"] = sp
        if sh:
            sj["Shock"] = sh

    def _repair_rear_hardpoints_if_degenerate(sj: Dict, tpl_scaled: Dict):
        if not isinstance(sj, dict) or not isinstance(tpl_scaled, dict):
            return
        tr = sj.get("Tierod") if isinstance(sj.get("Tierod"), dict) else {}
        t_tr = tpl_scaled.get("Tierod") if isinstance(tpl_scaled.get("Tierod"), dict) else {}
        # Rear toe-link near collapse can destabilize axle constraints.
        if _dist(tr.get("Location Chassis"), tr.get("Location Upright")) < 0.14:
            tr["Location Chassis"] = _copy_if_vec3(t_tr.get("Location Chassis"), tr.get("Location Chassis"))
            tr["Location Upright"] = _copy_if_vec3(t_tr.get("Location Upright"), tr.get("Location Upright"))
        if tr:
            sj["Tierod"] = tr

    susp_f_json = copy.deepcopy(tpl_susp_f) if tpl_susp_f else {}
    susp_r_json = copy.deepcopy(tpl_susp_r) if tpl_susp_r else {}
    base_half_track_f = _spindle_y_half_track(susp_f_json, 0.5 * track_f)
    base_half_track_r = _spindle_y_half_track(susp_r_json, 0.5 * track_r)
    y_ratio_f = _clamp((0.5 * track_f) / max(0.05, base_half_track_f), 0.35, 2.0)
    y_ratio_r = _clamp((0.5 * track_r) / max(0.05, base_half_track_r), 0.35, 2.0)
    # Critical stability rule:
    # Keep suspension templates in their authored Chrono geometry unless AC hardpoint mapping is enabled.
    # Global lateral rescaling of template-only suspensions can produce unstable/NaN wheel states at runtime.
    if use_ac_hardpoints:
        _scale_y_fields(susp_f_json, y_ratio_f)
        _scale_y_fields(susp_r_json, y_ratio_r)
    susp_f_template_scaled = copy.deepcopy(susp_f_json)
    susp_r_template_scaled = copy.deepcopy(susp_r_json)
    for sj, cam, kspring, kdamp, nm in (
        (susp_f_json, camber_f, spring_f, damp_f, "front suspension"),
        (susp_r_json, camber_r, spring_r, damp_r, "rear suspension"),
    ):
        if not isinstance(sj, dict):
            continue
        sj["Name"] = f"{car_id} {nm}"
        sj["Camber Angle (deg)"] = cam
        sj["Toe Angle (deg)"] = toe_deg_f if "front" in nm else toe_deg_r
        if isinstance(sj.get("Spring"), dict):
            pgr = max(0.0, prog_spring_f if "front" in nm else prog_spring_r)
            pkr = max(0.0, packer_range_f if "front" in nm else packer_range_r)
            sj["Spring"]["Spring Coefficient"] = _clamp(kspring + pgr * pkr * 0.25, 5_000.0, 2_000_000.0)
        if isinstance(sj.get("Shock"), dict):
            sj["Shock"]["Damping Coefficient"] = kdamp
        sj["AC Suspension"] = {
            "track_target_m": track_f if "front" in nm else track_r,
            "wheelbase_m": wheelbase,
            "progressive_spring_rate": prog_spring_f if "front" in nm else prog_spring_r,
            "bump_stop_rate": bump_stop_rate_f if "front" in nm else bump_stop_rate_r,
            "bumpstop_up": bump_stop_up_f if "front" in nm else bump_stop_up_r,
            "bumpstop_dn": bump_stop_dn_f if "front" in nm else bump_stop_dn_r,
            "packer_range": packer_range_f if "front" in nm else packer_range_r,
            "damp_fast_bump": damp_f_fb if "front" in nm else damp_r_fb,
            "damp_fast_rebound": damp_f_fr if "front" in nm else damp_r_fr,
            "damp_fast_bumpthreshold": damp_f_bt if "front" in nm else damp_r_bt,
            "damp_fast_reboundthreshold": damp_f_rt if "front" in nm else damp_r_rt,
        }

    # Front (STRUT) hardpoints.
    hf = 0.5 * track_f
    front_hp_sources: Dict[str, str] = {}
    if use_ac_hardpoints and isinstance(susp_f_json, dict):
        ca = susp_f_json.get("Control Arm") if isinstance(susp_f_json.get("Control Arm"), dict) else {}
        tr = susp_f_json.get("Tierod") if isinstance(susp_f_json.get("Tierod"), dict) else {}
        sp = susp_f_json.get("Spring") if isinstance(susp_f_json.get("Spring"), dict) else {}
        sh = susp_f_json.get("Shock") if isinstance(susp_f_json.get("Shock"), dict) else {}
        ca_tpl = susp_f_template_scaled.get("Control Arm") if isinstance(susp_f_template_scaled.get("Control Arm"), dict) else {}
        sp_tpl = susp_f_template_scaled.get("Spring") if isinstance(susp_f_template_scaled.get("Spring"), dict) else {}
        sh_tpl = susp_f_template_scaled.get("Shock") if isinstance(susp_f_template_scaled.get("Shock"), dict) else {}
        tr_tpl = susp_f_template_scaled.get("Tierod") if isinstance(susp_f_template_scaled.get("Tierod"), dict) else {}
        if _hp("front", "WBCAR_BOTTOM_FRONT") is not None:
            p_out, p_src = _apply_mapped_point(
                _ac_to_chrono_car(_hp("front", "WBCAR_BOTTOM_FRONT"), hf),
                ca_tpl.get("Location Chassis Front"),
            )
            ca["Location Chassis Front"] = p_out
            front_hp_sources["Control Arm.Location Chassis Front"] = p_src
        if _hp("front", "WBCAR_BOTTOM_REAR") is not None:
            p_out, p_src = _apply_mapped_point(
                _ac_to_chrono_car(_hp("front", "WBCAR_BOTTOM_REAR"), hf),
                ca_tpl.get("Location Chassis Back"),
            )
            ca["Location Chassis Back"] = p_out
            front_hp_sources["Control Arm.Location Chassis Back"] = p_src
        if _hp("front", "WBTYRE_BOTTOM") is not None:
            p_out, p_src = _apply_mapped_point(
                _ac_to_chrono_tyre(_hp("front", "WBTYRE_BOTTOM"), hf),
                ca_tpl.get("Location Upright"),
            )
            ca["Location Upright"] = p_out
            front_hp_sources["Control Arm.Location Upright"] = p_src
        if _hp("front", "WBTYRE_STEER") is not None:
            p_out, p_src = _apply_mapped_point(
                _ac_to_chrono_tyre(_hp("front", "WBTYRE_STEER"), hf),
                tr_tpl.get("Location Upright"),
            )
            tr["Location Upright"] = p_out
            front_hp_sources["Tierod.Location Upright"] = p_src
        if isinstance(tr_tpl, dict) and "Tierod.Location Chassis" not in front_hp_sources:
            if _v3(tr_tpl.get("Location Chassis")) is not None:
                tr["Location Chassis"] = list(_v3(tr_tpl.get("Location Chassis")))
                front_hp_sources["Tierod.Location Chassis"] = "template_locked"
        if _hp("front", "STRUT_CAR") is not None:
            p = _ac_to_chrono_car(_hp("front", "STRUT_CAR"), hf)
            p_sp, s_sp = _apply_mapped_point(p, sp_tpl.get("Location Chassis"))
            p_sh, s_sh = _apply_mapped_point(p, sh_tpl.get("Location Chassis"))
            sp["Location Chassis"] = p_sp
            sh["Location Chassis"] = p_sh
            front_hp_sources["Spring.Location Chassis"] = s_sp
            front_hp_sources["Shock.Location Chassis"] = s_sh
        if _hp("front", "STRUT_TYRE") is not None:
            p = _ac_to_chrono_tyre(_hp("front", "STRUT_TYRE"), hf)
            p_sp, s_sp = _apply_mapped_point(p, sp_tpl.get("Location Upright"))
            p_sh, s_sh = _apply_mapped_point(p, sh_tpl.get("Location Upright"))
            sp["Location Upright"] = p_sp
            sh["Location Upright"] = p_sh
            front_hp_sources["Spring.Location Upright"] = s_sp
            front_hp_sources["Shock.Location Upright"] = s_sh
        if ca:
            susp_f_json["Control Arm"] = ca
        if tr:
            susp_f_json["Tierod"] = tr
        if sp:
            susp_f_json["Spring"] = sp
        if sh:
            susp_f_json["Shock"] = sh
        _repair_front_hardpoints_if_degenerate(susp_f_json, susp_f_template_scaled)

    # Rear (DWB) hardpoints.
    hr = 0.5 * track_r
    rear_hp_sources: Dict[str, str] = {}
    if use_ac_hardpoints and isinstance(susp_r_json, dict):
        ua = susp_r_json.get("Upper Control Arm") if isinstance(susp_r_json.get("Upper Control Arm"), dict) else {}
        la = susp_r_json.get("Lower Control Arm") if isinstance(susp_r_json.get("Lower Control Arm"), dict) else {}
        tr = susp_r_json.get("Tierod") if isinstance(susp_r_json.get("Tierod"), dict) else {}
        ua_tpl = susp_r_template_scaled.get("Upper Control Arm") if isinstance(susp_r_template_scaled.get("Upper Control Arm"), dict) else {}
        la_tpl = susp_r_template_scaled.get("Lower Control Arm") if isinstance(susp_r_template_scaled.get("Lower Control Arm"), dict) else {}
        tr_tpl = susp_r_template_scaled.get("Tierod") if isinstance(susp_r_template_scaled.get("Tierod"), dict) else {}
        if _hp("rear", "WBCAR_TOP_FRONT") is not None:
            p_out, p_src = _apply_mapped_point(
                _ac_to_chrono_car(_hp("rear", "WBCAR_TOP_FRONT"), hr),
                ua_tpl.get("Location Chassis Front"),
            )
            ua["Location Chassis Front"] = p_out
            rear_hp_sources["Upper Control Arm.Location Chassis Front"] = p_src
        if _hp("rear", "WBCAR_TOP_REAR") is not None:
            p_out, p_src = _apply_mapped_point(
                _ac_to_chrono_car(_hp("rear", "WBCAR_TOP_REAR"), hr),
                ua_tpl.get("Location Chassis Back"),
            )
            ua["Location Chassis Back"] = p_out
            rear_hp_sources["Upper Control Arm.Location Chassis Back"] = p_src
        if _hp("rear", "WBTYRE_TOP") is not None:
            p_out, p_src = _apply_mapped_point(
                _ac_to_chrono_tyre(_hp("rear", "WBTYRE_TOP"), hr),
                ua_tpl.get("Location Upright"),
            )
            ua["Location Upright"] = p_out
            rear_hp_sources["Upper Control Arm.Location Upright"] = p_src
        if _hp("rear", "WBCAR_BOTTOM_FRONT") is not None:
            p_out, p_src = _apply_mapped_point(
                _ac_to_chrono_car(_hp("rear", "WBCAR_BOTTOM_FRONT"), hr),
                la_tpl.get("Location Chassis Front"),
            )
            la["Location Chassis Front"] = p_out
            rear_hp_sources["Lower Control Arm.Location Chassis Front"] = p_src
        if _hp("rear", "WBCAR_BOTTOM_REAR") is not None:
            p_out, p_src = _apply_mapped_point(
                _ac_to_chrono_car(_hp("rear", "WBCAR_BOTTOM_REAR"), hr),
                la_tpl.get("Location Chassis Back"),
            )
            la["Location Chassis Back"] = p_out
            rear_hp_sources["Lower Control Arm.Location Chassis Back"] = p_src
        if _hp("rear", "WBTYRE_BOTTOM") is not None:
            p_out, p_src = _apply_mapped_point(
                _ac_to_chrono_tyre(_hp("rear", "WBTYRE_BOTTOM"), hr),
                la_tpl.get("Location Upright"),
            )
            la["Location Upright"] = p_out
            rear_hp_sources["Lower Control Arm.Location Upright"] = p_src
        if _hp("rear", "WBTYRE_STEER") is not None:
            p_out, p_src = _apply_mapped_point(
                _ac_to_chrono_tyre(_hp("rear", "WBTYRE_STEER"), hr),
                tr_tpl.get("Location Upright"),
            )
            tr["Location Upright"] = p_out
            rear_hp_sources["Tierod.Location Upright"] = p_src
        if isinstance(tr_tpl, dict) and "Tierod.Location Chassis" not in rear_hp_sources:
            if _v3(tr_tpl.get("Location Chassis")) is not None:
                tr["Location Chassis"] = list(_v3(tr_tpl.get("Location Chassis")))
                rear_hp_sources["Tierod.Location Chassis"] = "template_locked"
        if ua:
            susp_r_json["Upper Control Arm"] = ua
        if la:
            susp_r_json["Lower Control Arm"] = la
        if tr:
            susp_r_json["Tierod"] = tr
        _repair_rear_hardpoints_if_degenerate(susp_r_json, susp_r_template_scaled)

    front_hardpoints_geom_ok = use_ac_hardpoints and _front_geom_ok(susp_f_json, track_f)
    rear_hardpoints_geom_ok = use_ac_hardpoints and _rear_geom_ok(susp_r_json, track_r)
    front_ac_count = sum(1 for s in front_hp_sources.values() if str(s).startswith("ac"))
    rear_ac_count = sum(1 for s in rear_hp_sources.values() if str(s).startswith("ac"))
    front_tpl_count = sum(1 for s in front_hp_sources.values() if str(s).startswith("template"))
    rear_tpl_count = sum(1 for s in rear_hp_sources.values() if str(s).startswith("template"))
    front_hardpoints_applied = bool(use_ac_hardpoints and front_hardpoints_geom_ok and front_ac_count > 0)
    rear_hardpoints_applied = bool(use_ac_hardpoints and rear_hardpoints_geom_ok and rear_ac_count > 0)
    front_hardpoints_full_ac = bool(front_hardpoints_applied and front_tpl_count == 0 and len(front_hp_sources) > 0)
    rear_hardpoints_full_ac = bool(rear_hardpoints_applied and rear_tpl_count == 0 and len(rear_hp_sources) > 0)
    if not front_hardpoints_applied:
        susp_f_json = copy.deepcopy(susp_f_template_scaled)
    if not rear_hardpoints_applied:
        susp_r_json = copy.deepcopy(susp_r_template_scaled)
    # Always normalize lateral suspension geometry to AC target track.
    # In hardpoints=off mode this prevents fallback to generic Chrono template track (~2.2 m).
    _normalize_front_track(susp_f_json, track_f)
    _normalize_rear_track(susp_r_json, track_r)
    try:
        acf = susp_f_json.get("AC Suspension") if isinstance(susp_f_json.get("AC Suspension"), dict) else {}
        acf["track_target_m"] = track_f
        acf["wheelbase_m"] = wheelbase
        acf["hardpoints_mode"] = hp_mode
        acf["hardpoints_requested"] = bool(use_ac_hardpoints)
        acf["hardpoints_applied"] = bool(front_hardpoints_applied)
        acf["hardpoints_geom_ok"] = bool(front_hardpoints_geom_ok)
        acf["hardpoints_full_ac"] = bool(front_hardpoints_full_ac)
        acf["hardpoints_partial_ac"] = bool(front_hardpoints_applied and not front_hardpoints_full_ac)
        acf["hardpoints_source_counts"] = {"ac": int(front_ac_count), "template": int(front_tpl_count)}
        acf["hardpoints_sources"] = dict(front_hp_sources)
        susp_f_json["AC Suspension"] = acf
        acr = susp_r_json.get("AC Suspension") if isinstance(susp_r_json.get("AC Suspension"), dict) else {}
        acr["track_target_m"] = track_r
        acr["wheelbase_m"] = wheelbase
        acr["hardpoints_mode"] = hp_mode
        acr["hardpoints_requested"] = bool(use_ac_hardpoints)
        acr["hardpoints_applied"] = bool(rear_hardpoints_applied)
        acr["hardpoints_geom_ok"] = bool(rear_hardpoints_geom_ok)
        acr["hardpoints_full_ac"] = bool(rear_hardpoints_full_ac)
        acr["hardpoints_partial_ac"] = bool(rear_hardpoints_applied and not rear_hardpoints_full_ac)
        acr["hardpoints_source_counts"] = {"ac": int(rear_ac_count), "template": int(rear_tpl_count)}
        acr["hardpoints_sources"] = dict(rear_hp_sources)
        susp_r_json["AC Suspension"] = acr
    except Exception:
        pass

    steer_json = copy.deepcopy(tpl_steer) if tpl_steer else {}
    if isinstance(steer_json, dict):
        steer_json["Name"] = f"{car_id} steering"
        sl = steer_json.get("Steering Link") if isinstance(steer_json.get("Steering Link"), dict) else {}
        sl["Length"] = _clamp(track_f * 0.42, 0.45, 0.8)
        steer_json["Steering Link"] = sl
        pin = steer_json.get("Pinion") if isinstance(steer_json.get("Pinion"), dict) else {}
        pin["Maximum Angle (deg)"] = max_steer_deg
        steer_json["Pinion"] = pin

    wheel_f_json = copy.deepcopy(tpl_wheel) if tpl_wheel else {}
    wheel_r_json = copy.deepcopy(tpl_wheel) if tpl_wheel else {}
    for wj, m_w, i_w, wr, ww, nm in (
        (wheel_f_json, wheel_mass_f, ang_inertia_f, rim_r_f, wheel_w_f, "front wheel"),
        (wheel_r_json, wheel_mass_r, ang_inertia_r, rim_r_r, wheel_w_r, "rear wheel"),
    ):
        if not isinstance(wj, dict):
            continue
        wj["Name"] = f"{car_id} {nm}"
        wj["Mass"] = m_w
        wj["Inertia"] = [_clamp(i_w, 0.05, 20.0), _clamp(i_w * 2.0, 0.05, 40.0), _clamp(i_w, 0.05, 20.0)]
        vis = wj.get("Visualization") if isinstance(wj.get("Visualization"), dict) else {}
        vis["Radius"] = wr
        vis["Width"] = ww
        wj["Visualization"] = vis

    brake_f_json = copy.deepcopy(tpl_brake) if tpl_brake else {}
    brake_r_json = copy.deepcopy(tpl_brake) if tpl_brake else {}
    if isinstance(brake_f_json, dict):
        brake_f_json["Name"] = f"{car_id} front brake"
        brake_f_json["Maximum Torque"] = brake_f_tq
    if isinstance(brake_r_json, dict):
        brake_r_json["Name"] = f"{car_id} rear brake"
        brake_r_json["Maximum Torque"] = brake_r_tq

    arb_f_json = copy.deepcopy(tpl_arb) if tpl_arb else {}
    arb_r_json = copy.deepcopy(tpl_arb) if tpl_arb else {}
    if isinstance(arb_f_json, dict):
        arb_f_json["Name"] = f"{car_id} front antirollbar"
        rsd = arb_f_json.get("RSD") if isinstance(arb_f_json.get("RSD"), dict) else {}
        rsd["Spring Coefficient"] = arb_f
        arb_f_json["RSD"] = rsd
    if isinstance(arb_r_json, dict):
        arb_r_json["Name"] = f"{car_id} rear antirollbar"
        rsd = arb_r_json.get("RSD") if isinstance(arb_r_json.get("RSD"), dict) else {}
        rsd["Spring Coefficient"] = arb_r
        arb_r_json["RSD"] = rsd

    driveline_json = copy.deepcopy(tpl_dline) if tpl_dline else {}
    if isinstance(driveline_json, dict):
        driveline_json["Name"] = f"{car_id} driveline"
        if isinstance(driveline_json.get("Gear Ratio"), dict):
            driveline_json["Gear Ratio"]["Conical Gear"] = _clamp(1.0 / final_drive, 0.02, 2.0)
        driveline_json["Axle Differential Locking Limit"] = diff_lock_limit

    engine_json = {
        "Name": f"{car_id} engine simple map",
        "Type": "Engine",
        "Template": "EngineSimpleMap",
        "Maximal Engine Speed RPM": engine_limiter,
        "Map Full Throttle": full_map,
        "Map Zero Throttle": zero_map,
    }
    # The 350Z AC source is authored as a clutch/shifter car. Export it as a true manual
    # transmission so the drive test can exercise Chrono's manual clutch/gear path directly.
    prefer_manual_transmission = bool(car_id == "streetcarpack_nissan_350z" and supports_shifter)
    if prefer_manual_transmission:
        trans_json = {
            "Name": f"{car_id} manual transmission shafts",
            "Type": "Transmission",
            "Template": "ManualTransmissionShafts",
            "Transmission Block Inertia": _clamp(gearbox_inertia * 18.0, 0.2, 2.0),
            "Input Shaft Inertia": _clamp(gearbox_inertia, 0.01, 0.15),
            "Motorshaft Inertia": _clamp(gearbox_inertia * 4.0, 0.02, 0.30),
            "Driveshaft Inertia": _clamp(gearbox_inertia, 0.01, 0.15),
            "Clutch Torque Limit": clutch_max_torque,
            "Gear Box": {
                "Reverse Gear Ratio": rev_ratio,
                "Forward Gear Ratios": fwd_ratios,
            },
        }
    else:
        trans_json = {
            "Name": f"{car_id} automatic transmission simple map",
            "Type": "Transmission",
            "Template": "AutomaticTransmissionSimpleMap",
            "Gear Box": {
                "Reverse Gear Ratio": rev_ratio,
                "Forward Gear Ratios": fwd_ratios,
                "Shift Points Map RPM": [[shift_dn, shift_up] for _ in fwd_ratios],
            },
        }

    tire_f_json = copy.deepcopy(tpl_tire) if tpl_tire else {}
    tire_r_json = copy.deepcopy(tpl_tire) if tpl_tire else {}
    for tj, nm, wr, ww, kr, cd, uu0, uu1, rlx in (
        (tire_f_json, "front tire", wheel_r, wheel_w_f, tyre_rate_f, tyre_damp_f, u_min, u_max, relax),
        (tire_r_json, "rear tire", wheel_r_r, wheel_w_r, tyre_rate_r, tyre_damp_r, u_min_r, u_max_r, relax_r),
    ):
        if not isinstance(tj, dict):
            continue
        tj["Name"] = f"{car_id} {nm}"
        tj["Type"] = "Tire"
        tj["Template"] = "FialaTire"
        tj["Mass"] = _clamp(0.5 * (wheel_mass_f + wheel_mass_r), 8.0, 80.0)
        tj["Inertia"] = [_clamp(ang_inertia_f, 0.05, 20.0), _clamp(ang_inertia_f * 2.2, 0.1, 40.0), _clamp(ang_inertia_f, 0.05, 20.0)]
        fp = tj.get("Fiala Parameters") if isinstance(tj.get("Fiala Parameters"), dict) else {}
        fp["Unloaded Radius"] = wr
        fp["Width"] = ww
        fp["Vertical Stiffness"] = kr
        fp["Vertical Damping"] = cd
        fp["Rolling Resistance"] = _clamp(_f(_get("tyres.ini", front_sec, "rolling_resistance_1"), 0.001), 0.0001, 0.02)
        fp["CSLIP"] = 45_000
        fp["CALPHA"] = 45_000
        fp["UMIN"] = uu0
        fp["UMAX"] = uu1
        fp["X Relaxation Length"] = _clamp(rlx * 0.35, 0.005, 1.0)
        fp["Y Relaxation Length"] = rlx
        tj["Fiala Parameters"] = fp
        vis = tj.get("Visualization") if isinstance(tj.get("Visualization"), dict) else {}
        vis["Width"] = ww
        tj["Visualization"] = vis

    fs_vehicle = f"{car_fs_root}/vehicle/vehicle.json"
    fs_chassis = f"{car_fs_root}/chassis/chassis.json"
    fs_steer = f"{car_fs_root}/steering/rack_pinion.json"
    fs_susp_f = f"{car_fs_root}/suspension/front.json"
    fs_susp_r = f"{car_fs_root}/suspension/rear.json"
    fs_wheel_f = f"{car_fs_root}/wheel/front.json"
    fs_wheel_r = f"{car_fs_root}/wheel/rear.json"
    fs_brake_f = f"{car_fs_root}/brake/front.json"
    fs_brake_r = f"{car_fs_root}/brake/rear.json"
    fs_dline = f"{car_fs_root}/driveline/driveline.json"
    fs_engine = f"{car_fs_root}/powertrain/engine_simple_map.json"
    fs_trans = f"{car_fs_root}/powertrain/transmission_simple_map.json"
    fs_tire_f = f"{car_fs_root}/tire/front_fiala.json"
    fs_tire_r = f"{car_fs_root}/tire/rear_fiala.json"
    fs_arb_f = f"{car_fs_root}/antirollbar/front.json"
    fs_arb_r = f"{car_fs_root}/antirollbar/rear.json"

    drivetrain_input = {"Input File": fs_dline, "Suspension Indexes": [0, 1]} if ("4WD" in traction_type or "AWD" in traction_type) else (
        {"Input File": fs_dline, "Suspension Indexes": [0]} if "FWD" in traction_type else {"Input File": fs_dline, "Suspension Indexes": [1]}
    )
    # Subsystem locations are in the vehicle frame (ISO: X forward, Y left, Z up).
    # Keep Z at chassis reference; suspension/steering hardpoints are already defined in subsystem frame.
    susp_loc_z = 0.0
    steer_loc_x = front_x - 0.15
    steer_loc_z = 0.0

    vehicle_json = {
        "Name": f"{car_id} vehicle (AC->Chrono full-native)",
        "Type": "Vehicle",
        "Template": "WheeledVehicle",
        "Chassis": {"Input File": fs_chassis},
        "Axles": [
            {
                "Suspension Input File": fs_susp_f,
                "Suspension Location": [front_x, 0, susp_loc_z],
                "Steering Index": 0,
                "Left Wheel Input File": fs_wheel_f,
                "Right Wheel Input File": fs_wheel_f,
                "Left Brake Input File": fs_brake_f,
                "Right Brake Input File": fs_brake_f,
                "Tire Input File": fs_tire_f,
            },
            {
                "Suspension Input File": fs_susp_r,
                "Suspension Location": [rear_x, 0, susp_loc_z],
                "Left Wheel Input File": fs_wheel_r,
                "Right Wheel Input File": fs_wheel_r,
                "Left Brake Input File": fs_brake_r,
                "Right Brake Input File": fs_brake_r,
                "Tire Input File": fs_tire_r,
            },
        ],
        "Steering Subsystems": [
            {
                "Input File": fs_steer,
                "Location": [steer_loc_x, 0, steer_loc_z],
                "Orientation": [1, 0, 0, 0],
            }
        ],
        "Wheelbase": wheelbase,
        "Maximum Steering Angle (deg)": max_steer_deg,
        "Powertrain": {
            "Engine Input File": fs_engine,
            "Transmission Input File": fs_trans,
        },
        "Driveline": drivetrain_input,
    }

    # 350Z stabilization: keep authored car suspension/wheel/brake/tire files for
    # correct visual track width, but keep steering angle conservative.
    if car_id == "streetcarpack_nissan_350z":
        vehicle_json["Maximum Steering Angle (deg)"] = float(max(10.0, min(20.0, max_steer_deg)))

    tire_json = tire_f_json if isinstance(tire_f_json, dict) else {
        "Name": f"{car_id} tire",
        "Type": "Tire",
        "Template": "FialaTire",
        "Fiala Parameters": {"Unloaded Radius": wheel_r, "Width": wheel_w_f},
    }

    chrono_dir = (normalized_dir / "chrono").resolve()
    chrono_dir.mkdir(parents=True, exist_ok=True)
    fs_payload: Dict[str, Dict] = {
        fs_vehicle: vehicle_json,
        fs_chassis: chassis_json,
        fs_steer: steer_json,
        fs_susp_f: susp_f_json,
        fs_susp_r: susp_r_json,
        fs_wheel_f: wheel_f_json,
        fs_wheel_r: wheel_r_json,
        fs_brake_f: brake_f_json,
        fs_brake_r: brake_r_json,
        fs_dline: driveline_json,
        fs_engine: engine_json,
        fs_trans: trans_json,
        fs_tire_f: tire_f_json,
        fs_tire_r: tire_r_json,
        **({fs_arb_f: arb_f_json} if arb_f > 0 and isinstance(arb_f_json, dict) else {}),
        **({fs_arb_r: arb_r_json} if arb_r > 0 and isinstance(arb_r_json, dict) else {}),
    }
    data_files: List[Dict] = []
    for fs_rel, payload in fs_payload.items():
        out_path = (chrono_dir / fs_rel).resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
        data_files.append({"fsRel": fs_rel, "rel": fs_rel})

    # Compatibility root files expected by existing consumers.
    vehicle_path = (chrono_dir / "vehicle.json").resolve()
    tire_path = (chrono_dir / "tire.json").resolve()
    vehicle_path.write_text(json.dumps(vehicle_json, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    tire_path.write_text(json.dumps(tire_json, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    data_files.append({"fsRel": fs_vehicle, "rel": "vehicle.json"})
    data_files.append({"fsRel": fs_tire_f, "rel": "tire.json"})
    # Deterministic manifest ordering and de-duplication.
    uniq = {}
    for rec in data_files:
        if not isinstance(rec, dict):
            continue
        fs_rel = str(rec.get("fsRel") or "").strip().replace("\\", "/")
        rel = str(rec.get("rel") or "").strip().replace("\\", "/")
        if not fs_rel:
            continue
        uniq[(fs_rel, rel)] = {"fsRel": fs_rel, "rel": rel}
    data_files = [uniq[k] for k in sorted(uniq.keys(), key=lambda x: (x[0], x[1]))]

    manifest_rel = "normalized/chrono/manifest.json"
    vehicle_rel = "vehicle.json"
    tire_rel = "tire.json"
    manifest = {
        "schema": 1,
        "source": "assetto_corsa_export.py",
        "carId": car_id,
        "runId": run_id,
        "mode": "full_native_v1",
        "vehicleJsonRel": vehicle_rel,
        "tireJsonRel": tire_rel,
        "vehicleFsRel": fs_vehicle,
        "tireFsRel": fs_tire_f,
        "hardpointsMode": hp_mode,
        "hardpointsRequested": bool(use_ac_hardpoints),
        "notes": "Full native AC->Chrono package with car-specific vehicle/chassis/suspension/steering/wheels/brakes/driveline/powertrain/tire files.",
        "dataFiles": data_files,
    }
    try:
        out_rel = out_dir.resolve().relative_to(repo_root).as_posix().lstrip("/")
        manifest["manifestUrl"] = f"/{out_rel}/{manifest_rel}"
        manifest["vehicleJsonUrl"] = f"/{out_rel}/normalized/chrono/vehicle.json"
        manifest["tireJsonUrl"] = f"/{out_rel}/normalized/chrono/tire.json"
        if isinstance(manifest.get("dataFiles"), list):
            for rec in manifest["dataFiles"]:
                if not isinstance(rec, dict):
                    continue
                rel = str(rec.get("rel") or "").strip().replace("\\", "/")
                if rel:
                    rec["url"] = f"/{out_rel}/normalized/chrono/{rel}"
    except Exception:
        pass
    manifest_path = (chrono_dir / "manifest.json").resolve()
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    return manifest


def _row_time(row: Dict) -> Optional[float]:
    lowered = {str(k).strip().lower(): v for k, v in row.items()}
    for key in TIME_KEY_CANDIDATES:
        if key in lowered:
            t = _safe_float(lowered.get(key))
            if t is not None:
                return t
    return None


def _write_ndjson(path: Path, rows: Iterable[Dict]) -> int:
    count = 0
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=True) + "\n")
            count += 1
    return count


def _copy_or_convert_runtime(runtime_src: Path, runtime_dir: Path) -> Tuple[Path, int, Dict]:
    runtime_dir.mkdir(parents=True, exist_ok=True)
    ext = runtime_src.suffix.lower()
    out_path = runtime_dir / "runtime_trace.ndjson"
    sample_count = 0
    t_values: List[float] = []

    if ext == ".csv":
        with runtime_src.open("r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            rows = []
            for row in reader:
                r = {str(k): row[k] for k in row.keys()}
                t = _row_time(r)
                if t is not None:
                    t_values.append(t)
                rows.append(r)
            sample_count = _write_ndjson(out_path, rows)
    else:
        with runtime_src.open("r", encoding="utf-8", errors="replace") as src, out_path.open(
            "w", encoding="utf-8"
        ) as dst:
            for raw in src:
                line = raw.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                    if isinstance(row, dict):
                        t = _row_time(row)
                        if t is not None:
                            t_values.append(t)
                        dst.write(json.dumps(row, ensure_ascii=True) + "\n")
                        sample_count += 1
                    else:
                        dst.write(json.dumps({"value": row}, ensure_ascii=True) + "\n")
                        sample_count += 1
                except json.JSONDecodeError:
                    dst.write(json.dumps({"raw": line}, ensure_ascii=True) + "\n")
                    sample_count += 1

    t_values_sorted = sorted(t_values)
    dts = []
    for i in range(1, len(t_values_sorted)):
        d = t_values_sorted[i] - t_values_sorted[i - 1]
        if d >= 0:
            dts.append(d)
    summary = {
        "source": runtime_src.as_posix(),
        "trace_path": out_path.as_posix(),
        "sample_count": sample_count,
        "time_min": t_values_sorted[0] if t_values_sorted else None,
        "time_max": t_values_sorted[-1] if t_values_sorted else None,
        "dt_min": min(dts) if dts else None,
        "dt_max": max(dts) if dts else None,
        "dt_avg": (sum(dts) / len(dts)) if dts else None,
    }
    return out_path, sample_count, summary


def _pick_main_kn5(car_root: Path) -> Optional[Path]:
    kn5s = []
    try:
        for p in car_root.glob("*.kn5"):
            if not p.is_file():
                continue
            low = p.name.lower()
            if "collider" in low:
                continue
            try:
                sz = p.stat().st_size
            except Exception:
                sz = 0
            kn5s.append((sz, p))
    except Exception:
        kn5s = []
    if not kn5s:
        return None
    kn5s.sort(key=lambda t: t[0], reverse=True)
    return kn5s[0][1]


def _which(cmd: str) -> str:
    p = shutil.which(cmd)
    return str(p or "").strip()


def _convert_dds_to_png(ffmpeg: str, src_dds: Path, dst_png: Path) -> None:
    dst_png.parent.mkdir(parents=True, exist_ok=True)
    errs: List[str] = []

    # 1) ffmpeg (handles many DDS variants, but not BC7 on some builds)
    try:
        subprocess.run(
            [ffmpeg, "-y", "-loglevel", "error", "-i", str(src_dds), str(dst_png)],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if dst_png.exists() and dst_png.is_file() and dst_png.stat().st_size >= 16:
            return
    except Exception as e:
        errs.append(f"ffmpeg: {e}")

    # 2) NVTT (if available): nvtt_export --format png --output out in.dds
    nvtt = _which("nvtt_export")
    if nvtt:
        try:
            subprocess.run(
                [nvtt, "--format", "png", "--output", str(dst_png), str(src_dds)],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            if dst_png.exists() and dst_png.is_file() and dst_png.stat().st_size >= 16:
                return
        except Exception as e:
            errs.append(f"nvtt_export: {e}")

    # 2b) Legacy NVTT path: nvdecompress <in.dds> -> <stem>.tga, then ffmpeg tga->png
    nvdecomp = _which("nvdecompress")
    if nvdecomp:
        try:
            with tempfile.TemporaryDirectory(prefix="dds_nvdecomp_") as td:
                tdir = Path(td).resolve()
                src_tmp = (tdir / src_dds.name).resolve()
                shutil.copy2(str(src_dds), str(src_tmp))
                subprocess.run(
                    [nvdecomp, str(src_tmp)],
                    check=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                tga = src_tmp.with_suffix(".tga")
                if tga.exists() and tga.is_file() and tga.stat().st_size > 64:
                    subprocess.run(
                        [ffmpeg, "-y", "-loglevel", "error", "-i", str(tga), str(dst_png)],
                        check=True,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True,
                    )
                    if dst_png.exists() and dst_png.is_file() and dst_png.stat().st_size >= 16:
                        return
        except Exception as e:
            errs.append(f"nvdecompress: {e}")

    # 3) texconv (DirectXTex): texconv -ft PNG -o <outdir> -y <in.dds>
    # Supports BC7 very reliably when available (native or via wine+texconv.exe).
    texconv = _which("texconv")
    wine = _which("wine")
    texconv_exe = _which("texconv.exe")
    if texconv or texconv_exe:
        try:
            out_dir = str(dst_png.parent.resolve())
            cmd: List[str]
            if texconv:
                cmd = [texconv, "-ft", "PNG", "-o", out_dir, "-y", str(src_dds)]
            elif wine and texconv_exe:
                cmd = [wine, texconv_exe, "-ft", "PNG", "-o", out_dir, "-y", str(src_dds)]
            else:
                cmd = []
            if cmd:
                subprocess.run(
                    cmd,
                    check=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                # texconv writes <stem>.PNG by default; normalize to requested dst name.
                out1 = (dst_png.parent / (src_dds.stem + ".png")).resolve()
                out2 = (dst_png.parent / (src_dds.stem + ".PNG")).resolve()
                produced = out1 if out1.exists() else (out2 if out2.exists() else dst_png)
                if produced.exists() and produced.is_file() and produced.stat().st_size >= 16:
                    if produced != dst_png:
                        try:
                            if dst_png.exists():
                                dst_png.unlink()
                        except Exception:
                            pass
                        produced.replace(dst_png)
                    return
        except Exception as e:
            errs.append(f"texconv: {e}")

    # 4) Compressonator (if available): output format inferred from extension.
    cmp = _which("compressonatorcli")
    if cmp:
        try:
            subprocess.run(
                [cmp, str(src_dds), str(dst_png)],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            if dst_png.exists() and dst_png.is_file() and dst_png.stat().st_size >= 16:
                return
        except Exception as e:
            errs.append(f"compressonatorcli: {e}")

    raise RuntimeError("DDS->PNG conversion failed for "
                       f"{src_dds.name}. Tried ffmpeg"
                       + (", nvtt_export" if nvtt else "")
                       + (", nvdecompress" if nvdecomp else "")
                       + (", texconv" if (texconv or texconv_exe) else "")
                       + (", compressonatorcli" if cmp else "")
                       + ".")


def _rewrite_mtl_paths(mtl_path: Path, replacements: Dict[str, str]) -> None:
    txt = mtl_path.read_text(encoding="utf-8", errors="replace")
    # Normalize slashes for Blender importer.
    txt = txt.replace("texture\\\\", "texture/").replace("texture\\", "texture/")
    for src, dst in replacements.items():
        # Replace case-insensitively for .dds/.DDS occurrences by doing a couple common variants.
        txt = txt.replace(src, dst)
        txt = txt.replace(src.lower(), dst)
        txt = txt.replace(src.upper(), dst)
    mtl_path.write_text(txt, encoding="utf-8")


def _copy_missing_textures_from_dir(src_dir: Path, dst_dir: Path) -> int:
    """Copy files from src_dir into dst_dir if missing (flat by filename)."""
    if not src_dir.exists() or not src_dir.is_dir():
        return 0
    dst_dir.mkdir(parents=True, exist_ok=True)
    n = 0
    for p in sorted(src_dir.rglob("*")):
        try:
            if not p.is_file():
                continue
            out = dst_dir / p.name
            if out.exists():
                continue
            shutil.copy2(str(p), str(out))
            n += 1
        except Exception:
            continue
    return n


def _copy_tree_hardlink(src: Path, dst: Path) -> int:
    """
    Copy a directory tree, preferring hardlinks when possible.

    Returns number of files written.
    """
    src = Path(src).resolve()
    dst = Path(dst).resolve()
    if not src.exists() or not src.is_dir():
        return 0
    dst.mkdir(parents=True, exist_ok=True)
    n = 0
    for p in sorted(src.rglob("*")):
        try:
            rel = p.relative_to(src)
        except Exception:
            continue
        out = dst / rel
        if p.is_dir():
            out.mkdir(parents=True, exist_ok=True)
            continue
        if not p.is_file():
            continue
        out.parent.mkdir(parents=True, exist_ok=True)
        if out.exists():
            continue
        try:
            os.link(str(p), str(out))
        except Exception:
            try:
                shutil.copy2(str(p), str(out))
            except Exception:
                continue
        n += 1
    return n


def _parse_engine_ini_filenames(ini_text: str) -> List[str]:
    """
    Extract FILENAME=... values from AC sample-based engine INI files.
    Keep it loose and ignore comments.
    """
    out: List[str] = []
    for raw in str(ini_text or "").replace("\r", "").split("\n"):
        line = raw.strip()
        if not line:
            continue
        if line.startswith(";") or line.startswith("#") or line.startswith("//"):
            continue
        # Drop inline comments.
        line = re.sub(r"\s*(;|//).*$", "", line).strip()
        m = re.match(r"(?i)^\s*FILENAME\s*=\s*(.+?)\s*$", line)
        if not m:
            continue
        v = str(m.group(1) or "").strip().strip('"').strip("'")
        v = v.replace("\\", "/")
        if v:
            out.append(v)
    # Dedup preserve order (case-insensitive).
    seen = set()
    uniq: List[str] = []
    for s in out:
        k = s.lower()
        if k in seen:
            continue
        seen.add(k)
        uniq.append(s)
    return uniq


def _fix_sfx_sample_casing(sfx_dir: Path) -> Dict[str, int]:
    """
    On Linux, HTTP paths are case-sensitive. Many AC mods author engine.ini on Windows and
    reference WAV filenames with casing that doesn't match the actual on-disk filename.

    This routine creates copies (or hardlinks) using the exact referenced casing so runtime fetches work.
    """
    stats = {"engine_ini_found": 0, "samples_referenced": 0, "aliases_created": 0, "missing": 0}
    if not sfx_dir.exists() or not sfx_dir.is_dir():
        return stats

    ini_paths: List[Path] = []
    for nm in ("engine.ini", "engineINT.ini", "engineInt.ini", "engine_ext.ini", "engine_int.ini"):
        p = (sfx_dir / nm).resolve()
        if p.exists() and p.is_file():
            ini_paths.append(p)
    if not ini_paths:
        return stats
    stats["engine_ini_found"] = len(ini_paths)

    # Build a case-insensitive lookup by basename for all files under sfx_dir (including subfolders).
    lookup: Dict[str, Path] = {}
    for p in sfx_dir.rglob("*"):
        try:
            if not p.is_file():
                continue
            k = p.name.lower()
            if k and k not in lookup:
                lookup[k] = p
        except Exception:
            continue

    referenced: List[str] = []
    for ip in ini_paths:
        try:
            referenced.extend(_parse_engine_ini_filenames(_read_text_best_effort(ip)))
        except Exception:
            continue
    # Dedup preserve order (case-insensitive).
    seen = set()
    uniq: List[str] = []
    for s in referenced:
        k = s.lower()
        if k in seen:
            continue
        seen.add(k)
        uniq.append(s)
    referenced = uniq
    stats["samples_referenced"] = len(referenced)

    for rel in referenced:
        rel_norm = str(rel or "").strip().replace("\\", "/").lstrip("./")
        if not rel_norm:
            continue
        # Prefer relative path under sfx_dir when it includes subfolders.
        expected = (sfx_dir / rel_norm).resolve()
        if expected.exists() and expected.is_file():
            continue

        # Fallback to basename match (case-insensitive).
        src = lookup.get(Path(rel_norm).name.lower())
        if src is None:
            stats["missing"] += 1
            continue

        # Create an alias with the exact referenced relative path.
        try:
            expected.parent.mkdir(parents=True, exist_ok=True)
            if expected.exists():
                continue
            try:
                os.link(str(src), str(expected))
            except Exception:
                shutil.copy2(str(src), str(expected))
            stats["aliases_created"] += 1
        except Exception:
            stats["missing"] += 1
            continue

    return stats


def _publish_ac_luts_from_params(*, params_raw_json: Path, ac_raw_data_dir: Path, pub_ac_raw_dir: Path) -> Dict[str, int]:
    """
    Publish LUT files referenced by params.raw.json into <pub_ac_raw_dir>/data/.

    SceneVehicleSystem fetches /ac_raw/data/power.lut (derived from acBundleUrl) to estimate
    power/torque. Without publishing these LUTs, webautos-only deployments will 404.
    """
    stats = {"referenced": 0, "copied": 0, "missing": 0}
    try:
        j = json.loads(params_raw_json.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return stats
    refs = j.get("lut_references") if isinstance(j, dict) else None
    if not isinstance(refs, list):
        refs = []
    luts: List[str] = []
    for r in refs:
        if not isinstance(r, dict):
            continue
        lut = str(r.get("lut") or "").strip().replace("\\", "/")
        if lut.lower().endswith(".lut") and lut:
            luts.append(lut)
    # Always include power.lut if present (even if it wasn't detected via regex).
    luts.append("power.lut")
    # Dedup preserve order.
    seen = set()
    uniq: List[str] = []
    for s in luts:
        k = s.lower()
        if k in seen:
            continue
        seen.add(k)
        uniq.append(s)
    stats["referenced"] = len(uniq)

    out_dir = (pub_ac_raw_dir / "data").resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    for rel in uniq:
        # Lut refs are usually basenames, but support paths just in case.
        src = (ac_raw_data_dir / rel).resolve()
        if not (src.exists() and src.is_file()):
            # fallback to basename match
            src = (ac_raw_data_dir / Path(rel).name).resolve()
        if not (src.exists() and src.is_file()):
            stats["missing"] += 1
            continue
        dst = (out_dir / Path(rel).name).resolve()
        if dst.exists():
            continue
        try:
            os.link(str(src), str(dst))
        except Exception:
            try:
                shutil.copy2(str(src), str(dst))
            except Exception:
                stats["missing"] += 1
                continue
        stats["copied"] += 1

    return stats


def _pick_default_skin_dir(car_root: Path) -> Optional[Path]:
    skins = (car_root / "skins").resolve()
    if not skins.exists() or not skins.is_dir():
        return None
    try:
        subs = [p for p in sorted(skins.iterdir()) if p.is_dir()]
    except Exception:
        subs = []
    if not subs:
        return None
    # Prefer the common "00_*" convention when present.
    for p in subs:
        if p.name.lower().startswith("00"):
            return p
    return subs[0]


def _pick_skin_dir(car_root: Path, skin: str) -> Optional[Path]:
    skin = str(skin or "").strip()
    skins = (car_root / "skins").resolve()
    if not skins.exists() or not skins.is_dir():
        return None
    if skin:
        cand = (skins / skin).resolve()
        if cand.exists() and cand.is_dir():
            return cand
        return None
    return _pick_default_skin_dir(car_root)


def _overlay_skin_textures(*, skin_dir: Path, textures_dir: Path) -> Dict[str, int]:
    """
    Apply skin_dir as an override layer on top of textures_dir.

    Assetto skins override by filename, typically case-insensitive on Windows. On Linux,
    we treat matches as case-insensitive and overwrite the existing on-disk file to ensure
    the referenced texture name resolves to the skin content.
    """
    stats = {"scanned": 0, "added": 0, "overwritten": 0, "failed": 0}
    if not skin_dir.exists() or not skin_dir.is_dir():
        return stats
    textures_dir.mkdir(parents=True, exist_ok=True)

    # Build a case-insensitive lookup of existing destination files by basename.
    dst_by_lower: Dict[str, Path] = {}
    try:
        for p in textures_dir.rglob("*"):
            if not p.is_file():
                continue
            key = p.name.lower()
            if key and key not in dst_by_lower:
                dst_by_lower[key] = p
    except Exception:
        dst_by_lower = {}

    for p in sorted(skin_dir.rglob("*")):
        try:
            if not p.is_file():
                continue
            stats["scanned"] += 1
            key = p.name.lower()
            dst = dst_by_lower.get(key)
            if dst is None:
                dst = (textures_dir / p.name).resolve()
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(str(p), str(dst))
                dst_by_lower[key] = dst
                stats["added"] += 1
                continue

            # Overwrite the existing file in-place (preserve its casing/path).
            shutil.copy2(str(p), str(dst))
            stats["overwritten"] += 1
        except Exception:
            stats["failed"] += 1
            continue
    return stats


def _ensure_referenced_textures_present(*, materials_manifest_path: Path, textures_dir: Path, source_dirs: List[Path]) -> Dict[str, int]:
    """
    Ensure every referenced material sample texture exists in textures_dir.

    Assetto content is often authored on Windows with case-insensitive paths. When exporting on Linux,
    we must make sure we actually write files with the exact names referenced by the KN5 material
    samples (including casing), otherwise runtime fetches will 404.
    """
    stats = {"referenced": 0, "missing_before": 0, "copied": 0, "still_missing": 0}
    try:
        j = json.loads(materials_manifest_path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return stats
    mats = j.get("materials") if isinstance(j, dict) else None
    if not isinstance(mats, list):
        return stats

    wanted: List[str] = []
    for m in mats:
        if not isinstance(m, dict):
            continue
        samples = m.get("samples") if isinstance(m.get("samples"), dict) else {}
        for k, v in samples.items():
            if not str(k or "").startswith("tx"):
                continue
            name = str(v or "").strip().replace("\\", "/")
            if not name:
                continue
            wanted.append(name)

    # Dedup preserve order.
    seen = set()
    uniq: List[str] = []
    for w in wanted:
        if w in seen:
            continue
        seen.add(w)
        uniq.append(w)
    stats["referenced"] = len(uniq)

    # Build a lookup map for case-insensitive matching by basename.
    lookup: Dict[str, Path] = {}
    for sd in source_dirs:
        try:
            if not sd.exists() or not sd.is_dir():
                continue
        except Exception:
            continue
        for p in sd.rglob("*"):
            try:
                if not p.is_file():
                    continue
                key = p.name.lower()
                if key and key not in lookup:
                    lookup[key] = p
            except Exception:
                continue

    textures_dir.mkdir(parents=True, exist_ok=True)
    for rel in uniq:
        out = (textures_dir / rel).resolve()
        if out.exists() and out.is_file():
            continue
        stats["missing_before"] += 1

        # Try exact relative path under each source dir first.
        found = None
        for sd in source_dirs:
            try:
                cand = (sd / rel).resolve()
                if cand.exists() and cand.is_file():
                    found = cand
                    break
            except Exception:
                continue
        # Fallback: basename case-insensitive.
        if found is None:
            found = lookup.get(Path(rel).name.lower())

        if found is None:
            stats["still_missing"] += 1
            continue

        try:
            out.parent.mkdir(parents=True, exist_ok=True)
            if out.exists():
                continue
            try:
                os.link(str(found), str(out))
            except Exception:
                shutil.copy2(str(found), str(out))
            stats["copied"] += 1
        except Exception:
            stats["still_missing"] += 1
            continue

    return stats


def _export_ac_root_refs_for_car(
    *,
    ac_root: Path,
    car_root: Path,
    car_id: str,
    out_ac_root_dir: Path,
) -> Dict[str, object]:
    """
    Best-effort export of AC-install level refs that commonly affect visuals/behavior:
    - CSP global car configs under extension/config/cars/
    - Any INCLUDE fragments they reference
    - Any referenced textures under extension/textures/ or content/texture/

    Output is written under out_ac_root_dir, preserving paths relative to ac_root.
    """
    stats: Dict[str, object] = {"enabled": True, "copied": [], "skipped": [], "missing": []}
    copied: List[str] = []
    skipped: List[str] = []
    missing: List[str] = []

    ac_root = Path(ac_root).resolve()
    out_ac_root_dir.mkdir(parents=True, exist_ok=True)

    # Candidate CSP config roots to check for this car id.
    cfg_candidates: List[Path] = []
    for ext in (".ini", ".txt"):
        cfg_candidates.append(ac_root / "extension" / "config" / "cars" / f"{car_id}{ext}")
        cfg_candidates.append(ac_root / "extension" / "config" / "cars" / "loaded" / f"{car_id}{ext}")

    # Also include car-local ext_config.ini if present (some mods keep all CSP config per-car).
    try:
        cfg_candidates.append((car_root / "extension" / "ext_config.ini").resolve())
    except Exception:
        pass

    cfg_files: List[Path] = []
    for p in cfg_candidates:
        try:
            if p.exists() and p.is_file():
                cfg_files.append(p)
        except Exception:
            continue

    # Copy the cfg files themselves and then resolve includes/assets relative to common roots.
    include_queue: List[Tuple[Path, str]] = []  # (referrer_file, include_rel)
    asset_refs: List[str] = []
    for cfg in cfg_files:
        rel = _copy_file_preserve_rel(src=cfg, base=ac_root, dst_root=out_ac_root_dir)
        if rel:
            copied.append(rel)
        else:
            # If the cfg isn't under ac_root (e.g. car-local extension/ext_config.ini),
            # still copy it into a stable refs folder.
            try:
                refs_root = (out_ac_root_dir / "_refs").resolve()
                refs_root.mkdir(parents=True, exist_ok=True)
                dst = (refs_root / cfg.name).resolve()
                if not dst.exists():
                    shutil.copy2(str(cfg), str(dst))
                copied.append(f"_refs/{cfg.name}")
            except Exception:
                skipped.append(cfg.as_posix())

        txt = _read_text_best_effort(cfg)
        for inc in _extract_include_refs(txt):
            include_queue.append((cfg, inc))
        asset_refs.extend(_extract_asset_path_refs(txt))

    # Resolve include refs (best-effort) without unbounded recursion.
    # We preserve paths under ac_root when possible.
    seen_inc: set[str] = set()
    search_roots: List[Path] = [
        ac_root / "extension" / "config",
        ac_root / "extension",
        ac_root / "content",
        car_root / "extension",
        car_root,
    ]

    def _try_resolve_ref(referrer: Path, rel: str) -> Optional[Path]:
        rel = str(rel or "").strip().replace("\\", "/")
        if not _is_safe_rel_path(rel):
            return None
        # 1) relative to referrer
        try:
            cand = (referrer.parent / rel).resolve()
            if cand.exists() and cand.is_file():
                return cand
        except Exception:
            pass
        # 2) relative to known roots
        for root in search_roots:
            try:
                cand = (root / rel).resolve()
                if cand.exists() and cand.is_file():
                    return cand
            except Exception:
                continue
        return None

    # Breadth-first include copy, limited.
    max_includes = 512
    while include_queue and len(seen_inc) < max_includes:
        referrer, inc_rel = include_queue.pop(0)
        key = f"{referrer.as_posix()}::{inc_rel}".lower()
        if key in seen_inc:
            continue
        seen_inc.add(key)
        found = _try_resolve_ref(referrer, inc_rel)
        if not found:
            missing.append(inc_rel)
            continue
        rel = _copy_file_preserve_rel(src=found, base=ac_root, dst_root=out_ac_root_dir)
        if rel:
            copied.append(rel)
        else:
            # If the include isn't under ac_root, still copy it into a stable refs folder.
            try:
                refs_root = (out_ac_root_dir / "_refs").resolve()
                refs_root.mkdir(parents=True, exist_ok=True)
                dst = (refs_root / found.name).resolve()
                if not dst.exists():
                    shutil.copy2(str(found), str(dst))
                copied.append(f"_refs/{found.name}")
            except Exception:
                skipped.append(found.as_posix())
        # Recurse includes within includes.
        txt = _read_text_best_effort(found)
        for inc2 in _extract_include_refs(txt):
            include_queue.append((found, inc2))
        asset_refs.extend(_extract_asset_path_refs(txt))

    # Copy referenced assets that are clearly AC-install-relative.
    # Keep this conservative: only handle extension/textures and content/texture.
    asset_roots = [
        ("extension/textures/", ac_root / "extension" / "textures"),
        ("content/texture/", ac_root / "content" / "texture"),
    ]
    # Build a lookup for basename-only refs inside these roots.
    asset_lookup: Dict[str, Path] = {}
    try:
        for _, root in asset_roots:
            if not root.exists() or not root.is_dir():
                continue
            for p in root.rglob("*"):
                try:
                    if not p.is_file():
                        continue
                    k = p.name.lower()
                    if k and k not in asset_lookup:
                        asset_lookup[k] = p
                except Exception:
                    continue
    except Exception:
        asset_lookup = {}
    for rel in asset_refs:
        rel_norm = str(rel or "").strip().replace("\\", "/").lstrip("./")
        if not _is_safe_rel_path(rel_norm):
            continue
        copied_one = False
        for prefix, _root in asset_roots:
            if rel_norm.lower().startswith(prefix):
                src = (ac_root / rel_norm).resolve()
                rel2 = _copy_file_preserve_rel(src=src, base=ac_root, dst_root=out_ac_root_dir)
                if rel2:
                    copied.append(rel2)
                else:
                    missing.append(rel_norm)
                copied_one = True
                break
        # If the ref is basename-only, try resolving within the shared roots.
        if (not copied_one) and ("/" not in rel_norm) and ("\\\\" not in rel_norm):
            src = asset_lookup.get(rel_norm.lower())
            if src is not None:
                rel2 = _copy_file_preserve_rel(src=src, base=ac_root, dst_root=out_ac_root_dir)
                if rel2:
                    copied.append(rel2)
                else:
                    missing.append(rel_norm)
                copied_one = True
        if not copied_one:
            # Not AC-root anchored; ignore (likely car-local, already handled elsewhere).
            continue

    # Dedup lists.
    def _dedup(xs: List[str]) -> List[str]:
        seen = set()
        out = []
        for x in xs:
            k = str(x).lower()
            if k in seen:
                continue
            seen.add(k)
            out.append(x)
        return out

    stats["copied"] = _dedup(copied)
    stats["skipped"] = _dedup(skipped)
    stats["missing"] = _dedup(missing)
    stats["include_limit_reached"] = bool(len(seen_inc) >= max_includes and include_queue)
    return stats


def _convert_referenced_dds_to_png(
    *, ffmpeg: str, materials_manifest_path: Path, textures_dir: Path, overwrite: bool
) -> Dict[str, int]:
    """
    Convert referenced .dds textures to .png and rewrite the manifest in-place.

    This avoids runtime reliance on WebGL compressed texture extensions (S3TC/BPTC/etc),
    which are not guaranteed to be present on all browsers/hardware.
    """
    stats = {"dds_referenced": 0, "dds_converted": 0, "dds_failed": 0, "manifest_rewrites": 0}
    if not ffmpeg:
        return stats
    try:
        j = json.loads(materials_manifest_path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return stats
    mats = j.get("materials") if isinstance(j, dict) else None
    if not isinstance(mats, list):
        return stats

    # Collect referenced DDS sample strings (keep exact casing as authored).
    dds_names: List[str] = []
    for m in mats:
        if not isinstance(m, dict):
            continue
        samples = m.get("samples") if isinstance(m.get("samples"), dict) else {}
        for k, v in samples.items():
            if not str(k or "").startswith("tx"):
                continue
            name = str(v or "").strip().replace("\\", "/")
            if not name:
                continue
            if name.lower().endswith(".dds"):
                dds_names.append(name)

    # Dedup preserve order.
    seen = set()
    uniq: List[str] = []
    for nm in dds_names:
        if nm in seen:
            continue
        seen.add(nm)
        uniq.append(nm)
    stats["dds_referenced"] = len(uniq)
    if not uniq:
        return stats

    # Convert and build mapping: old -> new (.png).
    mapping: Dict[str, str] = {}
    for rel in uniq:
        src = (textures_dir / rel).resolve()
        if not src.exists() or not src.is_file():
            # If we can't find it, we can't convert it.
            stats["dds_failed"] += 1
            continue
        dst_rel = str(Path(rel).with_suffix(".png")).replace("\\", "/")
        dst = (textures_dir / dst_rel).resolve()
        try:
            if overwrite or (not dst.exists() or not dst.is_file() or dst.stat().st_size < 16):
                _convert_dds_to_png(ffmpeg, src, dst)
            if dst.exists() and dst.is_file() and dst.stat().st_size >= 16:
                mapping[rel] = dst_rel
                stats["dds_converted"] += 1
            else:
                stats["dds_failed"] += 1
        except Exception:
            stats["dds_failed"] += 1

    # If some conversions failed but a PNG exists (e.g. created by a previous pass),
    # still map it so we can rewrite the manifest.
    for rel in uniq:
        if rel in mapping:
            continue
        dst_rel = str(Path(rel).with_suffix(".png")).replace("\\", "/")
        dst = (textures_dir / dst_rel).resolve()
        try:
            if dst.exists() and dst.is_file() and dst.stat().st_size >= 16:
                mapping[rel] = dst_rel
        except Exception:
            continue

    if not mapping:
        return stats

    # Rewrite manifest samples to point at PNGs when available.
    rewrites = 0
    for m in mats:
        if not isinstance(m, dict):
            continue
        samples = m.get("samples") if isinstance(m.get("samples"), dict) else None
        if not samples:
            continue
        for k, v in list(samples.items()):
            name = str(v or "").strip().replace("\\", "/")
            if not name:
                continue
            if name in mapping:
                samples[k] = mapping[name]
                rewrites += 1
            else:
                # Also try case-insensitive match (Windows-authored assets).
                lo = name.lower()
                for old, new in mapping.items():
                    if lo == old.lower():
                        samples[k] = new
                        rewrites += 1
                        break
    stats["manifest_rewrites"] = rewrites

    try:
        materials_manifest_path.write_text(json.dumps(j, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    except Exception:
        # If we can't persist the rewrite, runtime won't see it; treat as failure.
        stats["manifest_rewrites"] = 0
    return stats


def _rewrite_manifest_dds_to_png_if_present(*, materials_manifest_path: Path, textures_dir: Path) -> int:
    """
    If a sample references X.dds but X.png exists next to it, rewrite to X.png.
    Returns number of rewrites applied.
    """
    try:
        j = json.loads(materials_manifest_path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return 0
    mats = j.get("materials") if isinstance(j, dict) else None
    if not isinstance(mats, list):
        return 0
    rewrites = 0
    for m in mats:
        if not isinstance(m, dict):
            continue
        samples = m.get("samples") if isinstance(m.get("samples"), dict) else None
        if not samples:
            continue
        for k, v in list(samples.items()):
            if not str(k or "").startswith("tx"):
                continue
            name = str(v or "").strip().replace("\\", "/")
            if not name.lower().endswith(".dds"):
                continue
            png_rel = str(Path(name).with_suffix(".png")).replace("\\", "/")
            png_path = (textures_dir / png_rel).resolve()
            try:
                if png_path.exists() and png_path.is_file() and png_path.stat().st_size >= 16:
                    samples[k] = png_rel
                    rewrites += 1
            except Exception:
                continue
    if not rewrites:
        return 0
    try:
        materials_manifest_path.write_text(json.dumps(j, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    except Exception:
        return 0
    return rewrites


def _sanitize_manifest_samples_for_webgl(*, materials_manifest_path: Path, textures_dir: Path) -> Dict[str, int]:
    """
    Best-effort cleanup for runtime compatibility:
    - Replace common NULL placeholders with empty strings.
    - Do NOT drop DDS packed maps (txMaps/txMask) just because PNG conversion isn't available.
      We have a runtime DDS path (DXT/BCn) and a heuristic PBR fallback when compressed formats
      are unsupported by a given browser/GPU. Keeping the reference preserves best fidelity
      on capable devices.
    """
    stats = {"null_dropped": 0, "dds_dropped": 0, "manifest_rewrites": 0}
    try:
        j = json.loads(materials_manifest_path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return stats
    mats = j.get("materials") if isinstance(j, dict) else None
    if not isinstance(mats, list):
        return stats

    rewrites = 0

    for m in mats:
        if not isinstance(m, dict):
            continue
        samples = m.get("samples") if isinstance(m.get("samples"), dict) else None
        if not samples:
            continue
        for k, v in list(samples.items()):
            kk = str(k or "")
            if not kk.startswith("tx"):
                continue
            name = str(v or "").strip().replace("\\", "/")
            if not name:
                continue

            lo = name.lower()
            if lo in {"null", "null.png", "null.dds"}:
                samples[k] = ""
                stats["null_dropped"] += 1
                rewrites += 1
                continue

            if not lo.endswith(".dds"):
                continue

            # Keep DDS references when present; runtime has DDS + PNG fallback paths.
            continue

    stats["manifest_rewrites"] = rewrites
    if not rewrites:
        return stats
    try:
        materials_manifest_path.write_text(json.dumps(j, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    except Exception:
        stats["manifest_rewrites"] = 0
    return stats


def _blender_convert_dds_dir_to_png(blender: str, dds_dir: Path, overwrite: bool) -> None:
    script = (Path(__file__).resolve().parents[1] / "tools" / "rigging" / "blender_convert_dds_to_png.py").resolve()
    if not script.exists():
        raise SystemExit(f"Missing Blender DDS converter script: {script}")
    subprocess.run(
        [
            blender,
            "-b",
            "-P",
            str(script),
            "--",
            "--in-dir",
            str(dds_dir),
            "--recursive",
            "1",
            "--overwrite",
            "1" if bool(overwrite) else "0",
        ],
        check=True,
    )


def _clean_env_for_blender() -> Dict[str, str]:
    env = dict(os.environ)
    # Avoid Conda/venv leaking into Blender's embedded Python (can break ctypes/_ctypes symbols).
    for k in (
        "PYTHONHOME",
        "PYTHONPATH",
        "CONDA_PREFIX",
        "CONDA_DEFAULT_ENV",
        "VIRTUAL_ENV",
        "LD_LIBRARY_PATH",
        "DYLD_LIBRARY_PATH",
    ):
        env.pop(k, None)
    env["PYTHONNOUSERSITE"] = "1"
    return env


def _strip_mtl_texture_refs(mtl_path: Path) -> None:
    """Remove map/bump lines so Blender won't try to load textures."""
    try:
        lines = mtl_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except Exception:
        return
    out = []
    for raw in lines:
        s = raw.strip().lower()
        if s.startswith("map_") or s.startswith("bump") or s.startswith("disp") or s.startswith("decal"):
            continue
        out.append(raw)
    try:
        mtl_path.write_text("\n".join(out) + "\n", encoding="utf-8")
    except Exception:
        pass


def _export_model_glb(
    *,
    car_root: Path,
    ac_root: Optional[Path],
    out_dir: Path,
    car_id: str,
    model_kn5: str,
    model_out_name: str,
    skin: str,
    export_audio: bool,
) -> Dict[str, str]:
    kn5_path = Path(model_kn5).expanduser()
    if not kn5_path.is_absolute():
        kn5_path = (car_root / kn5_path).resolve()
    if not kn5_path.exists() or not kn5_path.is_file():
        raise SystemExit(f"Model KN5 not found: {kn5_path}")

    model_dir = out_dir / "model"
    src_dir = model_dir / "src_obj"
    src_dir.mkdir(parents=True, exist_ok=True)

    stem = (model_out_name.strip() or car_id).strip()
    if stem.lower().endswith(".glb"):
        stem = stem[:-4]
    obj_name = stem

    # KN5 -> OBJ (+ extracted embedded textures)
    rec = export_kn5_to_obj(kn5_path=kn5_path, out_dir=src_dir, obj_name=obj_name)
    obj_path = Path(rec["obj_path"]).resolve()
    mtl_path = Path(rec["mtl_path"]).resolve()
    textures_dir = Path(rec["textures_dir"]).resolve()
    skin_dir = _pick_skin_dir(car_root, skin)

    glb_path = (model_dir / f"{stem}.glb").resolve()
    glb_path.parent.mkdir(parents=True, exist_ok=True)

    # Some cars reference external textures under car_root/t/, car_root/texture/, and skins/*.
    # (We don't embed textures into GLB yet; runtime binds via meta.json.)
    try:
        _copy_missing_textures_from_dir(car_root / "t", textures_dir)
    except Exception:
        pass
    try:
        _copy_missing_textures_from_dir(car_root / "texture", textures_dir)
    except Exception:
        pass
    try:
        if skin_dir:
            # Skins override base textures by filename (often case-insensitive).
            _overlay_skin_textures(skin_dir=skin_dir, textures_dir=textures_dir)
    except Exception:
        pass

    # Ensure every referenced tx* sample has an on-disk file with the exact referenced casing.
    # This is important on Linux (case-sensitive FS) for runtime URL fetches.
    try:
        man_path = Path(str(rec.get("materials_manifest_path") or "")).resolve()
        if man_path.exists():
            try:
                sd = _pick_skin_dir(car_root, skin)
            except Exception:
                sd = None
            # Resolve from:
            # - skin dir
            # - extracted embedded textures_dir
            # - common car-local texture folders (t/, texture/)
            # - shared AC install texture folders (content/texture, extension/textures) when provided
            source_dirs = [p for p in [sd, textures_dir, car_root / "t", car_root / "texture"] if p]
            try:
                if ac_root:
                    ar = Path(ac_root).resolve()
                    source_dirs.extend([ar / "content" / "texture", ar / "extension" / "textures"])
            except Exception:
                pass
            _ensure_referenced_textures_present(
                materials_manifest_path=man_path,
                textures_dir=textures_dir,
                source_dirs=[Path(p).resolve() for p in source_dirs],
            )
    except Exception:
        pass

    # Convert referenced DDS textures to PNG for broader runtime compatibility, and rewrite
    # the materials manifest so SceneTool binds the PNGs automatically.
    try:
        ffmpeg = _which("ffmpeg")
        man_path = Path(str(rec.get("materials_manifest_path") or "")).resolve()
        if ffmpeg and man_path.exists():
            _convert_referenced_dds_to_png(
                ffmpeg=ffmpeg,
                materials_manifest_path=man_path,
                textures_dir=textures_dir,
                overwrite=bool(skin_dir),
            )
    except Exception:
        pass

    # If DDS remain referenced (often BC7, which ffmpeg may not decode), try Blender as a fallback
    # then rewrite any remaining DDS->PNG references when the PNG exists.
    try:
        man_path = Path(str(rec.get("materials_manifest_path") or "")).resolve()
        if man_path.exists():
            blender = _which("blender")
            if blender:
                # Convert *all* DDS in the directory (Blender supports many DDS formats).
                _blender_convert_dds_dir_to_png(blender, textures_dir, overwrite=bool(skin_dir))
                _rewrite_manifest_dds_to_png_if_present(materials_manifest_path=man_path, textures_dir=textures_dir)
    except Exception:
        pass

    # Final cleanup for WebGL friendliness: drop NULL placeholders (keep DDS packed maps for fidelity).
    try:
        man_path = Path(str(rec.get("materials_manifest_path") or "")).resolve()
        if man_path.exists():
            _sanitize_manifest_samples_for_webgl(materials_manifest_path=man_path, textures_dir=textures_dir)
    except Exception:
        pass

    # Keep model export robust by stripping texture refs in MTL (OBJ->GLB converter ignores them anyway).
    _strip_mtl_texture_refs(mtl_path)

    node = _which("node")
    if not node:
        raise SystemExit("Model export requires node (Node.js). Install node and retry.")
    obj_to_glb = (Path(__file__).resolve().parents[1] / "tools" / "obj_to_glb.mjs").resolve()
    if not obj_to_glb.exists():
        raise SystemExit(f"Missing OBJ->GLB converter: {obj_to_glb}")

    # OBJ -> GLB via Node + Three.js (no Blender dependency).
    subprocess.run(
        [node, str(obj_to_glb), "--in", str(obj_path), "--out", str(glb_path)],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if not glb_path.exists() or not glb_path.is_file() or glb_path.stat().st_size < 10_000:
        raise SystemExit(f"Model export failed: GLB not written (or too small): {glb_path}")

    # Write sibling meta.json so SceneTool/VehicleTool stop 404'ing and the model is enterable.
    # Also embed acBundleUrl so spawning the model automatically applies AC physics tuning.
    def _parse_bounds(s: str) -> List[float]:
        parts = [p.strip() for p in str(s or "").split(",") if p.strip()]
        if len(parts) != 3:
            return [0.0, 0.0, 0.0]
        out = []
        for p in parts:
            try:
                out.append(float(p))
            except Exception:
                out.append(0.0)
        return out

    bmin = _parse_bounds(rec.get("bounds_min", ""))
    bmax = _parse_bounds(rec.get("bounds_max", ""))
    sx = max(0.1, float(bmax[0] - bmin[0]))
    sy = max(0.1, float(bmax[1] - bmin[1]))
    sz = max(0.1, float(bmax[2] - bmin[2]))
    halfX = 0.5 * sx
    frontZ = float(bmin[2])
    rearZ = float(bmax[2])

    # Heuristic anchors (meters, GLB local space). Good enough for entering/driving.
    seatY = max(0.35, min(2.2, float(bmin[1] + 0.70 * sy)))
    seatZ = frontZ + 0.32 * (rearZ - frontZ)
    seatX = -min(0.75, halfX * 0.36)
    doorY = max(0.25, min(1.8, float(bmin[1] + 0.55 * sy)))
    doorZ = frontZ + 0.24 * (rearZ - frontZ)
    doorX = -float(halfX + 0.25)

    wheelFrontZ = frontZ + 0.22 * (rearZ - frontZ)
    wheelRearZ = rearZ - 0.22 * (rearZ - frontZ)
    wheelX = float(halfX * 0.78)
    wheelY = float(bmin[1] + 0.30)  # rough; used mostly for overlays

    # Try to infer wheel anchors (and orientation) from the exported OBJ group blocks.
    # Many AC models have explicit groups like g_Tyre_LF/RF/LR/RR. When present, this is
    # much more reliable than bounds-based heuristics.
    wheel_anchors = None
    model_yaw_offset_rad = None
    try:
        # Regex matches common wheel suffixes in group names.
        _WHEEL_SUFFIX_RE = re.compile(r"(?:^|[^a-z0-9])(lf|rf|lr|rr|fl|fr|rl)(?:$|[^a-z0-9])", re.IGNORECASE)

        def _infer_wheel_centers_from_obj(obj_p: Path) -> Dict[str, List[float]]:
            centers: Dict[str, List[float]] = {}
            cur_name = None
            minx = miny = minz = float("inf")
            maxx = maxy = maxz = float("-inf")

            def commit():
                nonlocal cur_name, minx, miny, minz, maxx, maxy, maxz
                if not cur_name or not math.isfinite(minx):
                    cur_name = None
                    return
                nm = str(cur_name).strip().lower()
                if ("tyre" not in nm) and ("tire" not in nm) and ("wheel" not in nm) and ("rim" not in nm):
                    cur_name = None
                    return
                m = _WHEEL_SUFFIX_RE.search(nm)
                if not m:
                    cur_name = None
                    return
                suf = m.group(1).lower()
                # Normalize alt spellings (front-left == left-front etc).
                suf = {"fl": "lf", "fr": "rf", "rl": "lr"}.get(suf, suf)
                if suf not in ("lf", "rf", "lr", "rr"):
                    cur_name = None
                    return
                # Prefer tyres if multiple candidates exist: first write wins since exporter
                # usually emits tyre groups after other parts (but keep it best-effort).
                if suf in centers and ("tyre" not in nm and "tire" not in nm):
                    cur_name = None
                    return
                centers[suf] = [(minx + maxx) * 0.5, (miny + maxy) * 0.5, (minz + maxz) * 0.5]
                cur_name = None

            with obj_p.open("r", encoding="utf-8", errors="ignore") as f:
                for raw in f:
                    if raw.startswith("g ") or raw.startswith("o "):
                        commit()
                        cur_name = raw[2:].strip()
                        minx = miny = minz = float("inf")
                        maxx = maxy = maxz = float("-inf")
                        continue
                    if not cur_name:
                        continue
                    if raw.startswith("v "):
                        parts = raw.strip().split()
                        if len(parts) >= 4:
                            x = _safe_float(parts[1])
                            y = _safe_float(parts[2])
                            z = _safe_float(parts[3])
                            if x is None or y is None or z is None:
                                continue
                            minx = min(minx, x)
                            miny = min(miny, y)
                            minz = min(minz, z)
                            maxx = max(maxx, x)
                            maxy = max(maxy, y)
                            maxz = max(maxz, z)
            commit()
            return centers

        centers = _infer_wheel_centers_from_obj(obj_path)
        if all(k in centers for k in ("lf", "rf", "lr", "rr")):
            lf = centers["lf"]
            rf = centers["rf"]
            lr = centers["lr"]
            rr = centers["rr"]
            wheel_anchors = {
                "wheel_lf": lf,
                "wheel_rf": rf,
                "wheel_lr": lr,
                "wheel_rr": rr,
            }
            # Derive visual yaw offset so the model's forward axis matches sim forward (-Z).
            fcx = 0.5 * (lf[0] + rf[0])
            fcz = 0.5 * (lf[2] + rf[2])
            rcx = 0.5 * (lr[0] + rr[0])
            rcz = 0.5 * (lr[2] + rr[2])
            hx = fcx - rcx
            hz = fcz - rcz
            if (hx * hx + hz * hz) > 1e-10:
                heading = math.atan2(hx, hz)
                off = math.pi - heading
                model_yaw_offset_rad = math.atan2(math.sin(off), math.cos(off))
    except Exception:
        wheel_anchors = None
        model_yaw_offset_rad = None

    # Best-effort wheel/tire sizing (meters) for wheel overlay.
    # Prefer COMPOUND_DEFAULT in tyres.ini (e.g. FRONT_1/REAR_1), falling back to FRONT/REAR.
    wheel_radius = 0.36
    wheel_radius_rear = 0.36
    wheel_width = 0.20
    wheel_width_rear = 0.20
    try:
        tyres_ini = (out_dir / "ac_raw" / "data" / "tyres.ini").resolve()
        if tyres_ini.exists() and tyres_ini.is_file():
            entries, _ = _parse_ini_lossless(tyres_ini, "tyres.ini")

            def _norm(s: str) -> str:
                return str(s or "").strip().lower()

            def _get(section: str, key: str) -> str:
                sec = _norm(section)
                k = _norm(key)
                for e in entries:
                    if _norm(e.get("section", "")) != sec:
                        continue
                    if _norm(e.get("key", "")) != k:
                        continue
                    return str(e.get("value", "") or "").strip()
                return ""

            idx_raw = _get("COMPOUND_DEFAULT", "INDEX")
            idx = 0
            try:
                # Some mods write 0.0 or similar.
                idx = int(float(str(idx_raw or "0").strip()))
            except Exception:
                idx = 0
            idx = max(0, min(9, idx))

            front_sec = f"FRONT_{idx + 1}"
            rear_sec = f"REAR_{idx + 1}"

            r_f = _safe_float(_get(front_sec, "RADIUS") or _get("FRONT", "RADIUS") or "")
            r_r = _safe_float(_get(rear_sec, "RADIUS") or _get("REAR", "RADIUS") or "")
            w_f = _safe_float(_get(front_sec, "WIDTH") or _get("FRONT", "WIDTH") or "")
            w_r = _safe_float(_get(rear_sec, "WIDTH") or _get("REAR", "WIDTH") or "")

            def _clamp(v: float, lo: float, hi: float) -> float:
                return max(lo, min(hi, float(v)))

            if r_f is not None:
                wheel_radius = _clamp(r_f, 0.18, 0.65)
            if r_r is not None:
                wheel_radius_rear = _clamp(r_r, 0.18, 0.65)
            else:
                wheel_radius_rear = wheel_radius
            if w_f is not None:
                wheel_width = _clamp(w_f, 0.08, 0.45)
            if w_r is not None:
                wheel_width_rear = _clamp(w_r, 0.08, 0.45)
            else:
                wheel_width_rear = wheel_width
    except Exception:
        # Keep model export resilient; wheel overlay sizing is optional.
        wheel_radius_rear = wheel_radius
        wheel_width_rear = wheel_width

    # Construct exported URLs relative to dev server root (if out_dir is under repo root).
    repo_root = Path(__file__).resolve().parents[1]
    ac_bundle_url = ""
    chrono_manifest_url = ""
    try:
        out_rel = out_dir.resolve().relative_to(repo_root).as_posix()
        ac_bundle_url = "/" + out_rel.lstrip("/") + "/normalized/car.bundle.json"
        chrono_manifest_url = "/" + out_rel.lstrip("/") + "/normalized/chrono/manifest.json"
    except Exception:
        ac_bundle_url = ""
        chrono_manifest_url = ""

    # Optional: audio URLs (raw AC FMOD assets).
    ac_audio_dir_url = ""
    ac_audio_ini_url = ""
    if bool(export_audio):
        try:
            sfx_dir = (out_dir / "ac_raw" / "car_root" / "sfx").resolve()
            if sfx_dir.exists() and sfx_dir.is_dir():
                sfx_rel = sfx_dir.relative_to(repo_root).as_posix().rstrip("/") + "/"
                ac_audio_dir_url = "/" + sfx_rel.lstrip("/")
        except Exception:
            ac_audio_dir_url = ""
        try:
            audio_ini = (out_dir / "ac_raw" / "car_root" / "audio.ini").resolve()
            if audio_ini.exists() and audio_ini.is_file():
                ini_rel = audio_ini.relative_to(repo_root).as_posix()
                ac_audio_ini_url = "/" + ini_rel.lstrip("/")
        except Exception:
            ac_audio_ini_url = ""

    # Texture + material manifests (for runtime re-texturing).
    texture_dir_url = ""
    materials_url = ""
    ac_materials = {}
    try:
        tex_rel = textures_dir.resolve().relative_to(repo_root).as_posix()
        texture_dir_url = "/" + tex_rel.lstrip("/") + "/"
    except Exception:
        texture_dir_url = ""
    try:
        man_path = Path(str(rec.get("materials_manifest_path") or "")).resolve()
        man_rel = man_path.relative_to(repo_root).as_posix()
        materials_url = "/" + man_rel.lstrip("/")
        j = json.loads(man_path.read_text(encoding="utf-8"))
        mats = j.get("materials") if isinstance(j, dict) else None
        if isinstance(mats, list):
            for m in mats:
                if not isinstance(m, dict):
                    continue
                name = str(m.get("name") or "").strip()
                samples = m.get("samples") if isinstance(m.get("samples"), dict) else {}
                props = m.get("props") if isinstance(m.get("props"), dict) else {}
                shader = str(m.get("shader") or "").strip()
                if not name:
                    continue
                # Keep the runtime-relevant slots/props (small enough to embed in meta.json as a fallback).
                txd = str(samples.get("txDiffuse") or "").strip()
                txn = str(samples.get("txNormal") or "").strip()
                txm = str(samples.get("txMask") or "").strip()
                txd2 = str(samples.get("txDetail") or "").strip()
                txmaps = str(samples.get("txMaps") or "").strip()
                txe = str(samples.get("txEmissive") or "").strip()
                txg = str(samples.get("txGlow") or "").strip()
                ks_alpha_ref = props.get("ksAlphaRef")
                ks_emissive = props.get("ksEmissive")
                ks_spec = props.get("ksSpecular")
                ks_spec_exp = props.get("ksSpecularEXP")
                ks_diff = props.get("ksDiffuse")
                fres_c = props.get("fresnelC")
                fres_e = props.get("fresnelEXP")
                det_mul = props.get("detailUVMultiplier")
                use_det = props.get("useDetail")
                ac_materials[name] = {
                    "shader": shader,
                    "txDiffuse": txd,
                    "txNormal": txn,
                    "txMask": txm,
                    "txDetail": txd2,
                    "txMaps": txmaps,
                    "txEmissive": txe,
                    "txGlow": txg,
                    "ksAlphaRef": float(ks_alpha_ref) if isinstance(ks_alpha_ref, (int, float)) else None,
                    "ksEmissive": float(ks_emissive) if isinstance(ks_emissive, (int, float)) else None,
                    "ksSpecular": float(ks_spec) if isinstance(ks_spec, (int, float)) else None,
                    "ksSpecularEXP": float(ks_spec_exp) if isinstance(ks_spec_exp, (int, float)) else None,
                    "ksDiffuse": float(ks_diff) if isinstance(ks_diff, (int, float)) else None,
                    "fresnelC": float(fres_c) if isinstance(fres_c, (int, float)) else None,
                    "fresnelEXP": float(fres_e) if isinstance(fres_e, (int, float)) else None,
                    "detailUVMultiplier": float(det_mul) if isinstance(det_mul, (int, float)) else None,
                    "useDetail": bool(use_det) if isinstance(use_det, (int, float, bool)) else None,
                }
    except Exception:
        materials_url = ""
        ac_materials = {}

    meta = {
        "schema": 1,
        "source": "assetto_corsa_export.py",
        "wheelType": "wheeled",
        "wheelScale": wheel_radius,
        "wheelScaleRear": wheel_radius_rear,
        "wheelWidth": wheel_width,
        "wheelWidthRear": wheel_width_rear,
        "acBundleUrl": ac_bundle_url,
        "chronoManifestUrl": chrono_manifest_url,
        "acTextureDirUrl": texture_dir_url,
        "acMaterialsUrl": materials_url,
        "acMaterials": ac_materials,
        "anchors": {
            "driver": {"pos": [seatX, seatY, seatZ]},
            "driver_enter": {"pos": [doorX, doorY, doorZ]},
            "camera_driver": {"pos": [seatX, seatY + 0.35, seatZ + 0.10]},
            "wheel_lf": {"pos": (wheel_anchors.get("wheel_lf") if wheel_anchors else [-wheelX, wheelY, wheelFrontZ])},
            "wheel_rf": {"pos": (wheel_anchors.get("wheel_rf") if wheel_anchors else [wheelX, wheelY, wheelFrontZ])},
            "wheel_lr": {"pos": (wheel_anchors.get("wheel_lr") if wheel_anchors else [-wheelX, wheelY, wheelRearZ])},
            "wheel_rr": {"pos": (wheel_anchors.get("wheel_rr") if wheel_anchors else [wheelX, wheelY, wheelRearZ])},
        },
        "bounds": {"min": bmin, "max": bmax, "size": [sx, sy, sz]},
    }
    try:
        if ac_audio_dir_url:
            meta["acAudioDirUrl"] = ac_audio_dir_url
        if ac_audio_ini_url:
            meta["acAudioIniUrl"] = ac_audio_ini_url
    except Exception:
        pass
    try:
        if model_yaw_offset_rad is not None and math.isfinite(float(model_yaw_offset_rad)):
            meta["modelYawOffsetRad"] = float(model_yaw_offset_rad)
    except Exception:
        pass
    meta_path = glb_path.with_suffix(".meta.json")
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")

    # Optional: publish into webautos/ so it appears in VehiclesTool with one click.
    published = {}
    try:
        pub_dir = repo_root / "webautos" / f"ac__{car_id}" / "stream"
        pub_dir.mkdir(parents=True, exist_ok=True)
        pub_glb = pub_dir / f"ac__{car_id}_hi.glb"
        pub_meta = pub_dir / f"ac__{car_id}_hi.meta.json"
        pub_tex_dir = pub_dir / "texture"
        pub_norm_dir = pub_dir / "normalized"
        pub_ac_raw_dir = pub_dir / "ac_raw"
        pub_mat_manifest = pub_dir / Path(str(rec.get("materials_manifest_path") or "")).name
        try:
            if pub_glb.exists():
                pub_glb.unlink()
        except Exception:
            pass
        try:
            os.link(str(glb_path), str(pub_glb))
        except Exception:
            shutil.copy2(str(glb_path), str(pub_glb))

        # Publish referenced textures + material manifest so webautos is self-contained.
        try:
            try:
                if pub_tex_dir.exists():
                    shutil.rmtree(pub_tex_dir)
            except Exception:
                pass
            _copy_tree_hardlink(textures_dir, pub_tex_dir)
        except Exception:
            pass
        try:
            man_path = Path(str(rec.get("materials_manifest_path") or "")).resolve()
            if man_path.exists():
                try:
                    if pub_mat_manifest.exists():
                        pub_mat_manifest.unlink()
                except Exception:
                    pass
                try:
                    os.link(str(man_path), str(pub_mat_manifest))
                except Exception:
                    shutil.copy2(str(man_path), str(pub_mat_manifest))
        except Exception:
            pass

        # Publish normalized bundle + minimal params for AC tuning.
        try:
            norm_src = (out_dir / "normalized").resolve()
            try:
                if pub_norm_dir.exists():
                    shutil.rmtree(pub_norm_dir)
            except Exception:
                pass
            _copy_tree_hardlink(norm_src, pub_norm_dir)
        except Exception:
            pass
        try:
            pub_ac_raw_dir.mkdir(parents=True, exist_ok=True)
            params_src = (out_dir / "ac_raw" / "params.raw.json").resolve()
            if params_src.exists() and params_src.is_file():
                params_dst = (pub_ac_raw_dir / "params.raw.json").resolve()
                if not params_dst.exists():
                    try:
                        os.link(str(params_src), str(params_dst))
                    except Exception:
                        shutil.copy2(str(params_src), str(params_dst))
        except Exception:
            pass
        # Publish referenced LUTs (power curve, etc) so runtime tuning doesn't 404.
        try:
            params_src = (out_dir / "ac_raw" / "params.raw.json").resolve()
            ac_raw_data_dir = (out_dir / "ac_raw" / "data").resolve()
            if params_src.exists() and params_src.is_file() and ac_raw_data_dir.exists() and ac_raw_data_dir.is_dir():
                _publish_ac_luts_from_params(
                    params_raw_json=params_src,
                    ac_raw_data_dir=ac_raw_data_dir,
                    pub_ac_raw_dir=pub_ac_raw_dir,
                )
        except Exception:
            pass

        # Optional: publish audio assets (sfx/ + audio.ini) so webautos is self-contained.
        pub_sfx_dir = None
        if bool(export_audio):
            try:
                sfx_src = (out_dir / "ac_raw" / "car_root" / "sfx").resolve()
                if sfx_src.exists() and sfx_src.is_dir():
                    pub_sfx_dir = (pub_dir / "sfx").resolve()
                    try:
                        if pub_sfx_dir.exists():
                            shutil.rmtree(pub_sfx_dir)
                    except Exception:
                        pass
                    _copy_tree_hardlink(sfx_src, pub_sfx_dir)
                    try:
                        _fix_sfx_sample_casing(pub_sfx_dir)
                    except Exception:
                        pass
            except Exception:
                pub_sfx_dir = None
            try:
                ini_src = (out_dir / "ac_raw" / "car_root" / "audio.ini").resolve()
                if ini_src.exists() and ini_src.is_file():
                    ini_dst = (pub_dir / "audio.ini").resolve()
                    if not ini_dst.exists():
                        try:
                            os.link(str(ini_src), str(ini_dst))
                        except Exception:
                            shutil.copy2(str(ini_src), str(ini_dst))
            except Exception:
                pass

        # Rewrite URLs in the published meta to point at the published artifacts.
        pub_meta_obj = dict(meta)
        try:
            tex_rel = pub_tex_dir.relative_to(repo_root).as_posix().rstrip("/") + "/"
            pub_meta_obj["acTextureDirUrl"] = "/" + tex_rel
        except Exception:
            pass
        if pub_sfx_dir is not None:
            try:
                sfx_rel = pub_sfx_dir.relative_to(repo_root).as_posix().rstrip("/") + "/"
                pub_meta_obj["acAudioDirUrl"] = "/" + sfx_rel
            except Exception:
                pass
        try:
            ini_path = (pub_dir / "audio.ini").resolve()
            if ini_path.exists() and ini_path.is_file():
                ini_rel = ini_path.relative_to(repo_root).as_posix()
                if ini_rel:
                    pub_meta_obj["acAudioIniUrl"] = "/" + ini_rel.lstrip("/")
        except Exception:
            pass
        try:
            man_rel = pub_mat_manifest.relative_to(repo_root).as_posix()
            pub_meta_obj["acMaterialsUrl"] = "/" + man_rel
        except Exception:
            pass
        try:
            bun_rel = (pub_norm_dir / "car.bundle.json").relative_to(repo_root).as_posix()
            pub_meta_obj["acBundleUrl"] = "/" + bun_rel
        except Exception:
            pass
        try:
            cman_rel = (pub_norm_dir / "chrono" / "manifest.json").relative_to(repo_root).as_posix()
            pub_meta_obj["chronoManifestUrl"] = "/" + cman_rel
        except Exception:
            pass

        pub_meta.write_text(json.dumps(pub_meta_obj, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
        published = {
            "webautos_glb_path": pub_glb.as_posix(),
            "webautos_meta_path": pub_meta.as_posix(),
        }
        try:
            if pub_sfx_dir is not None:
                published["webautos_sfx_dir_path"] = str(pub_sfx_dir.as_posix())
        except Exception:
            pass
    except Exception:
        published = {}

    return {
        "kn5_path": kn5_path.as_posix(),
        "obj_path": obj_path.as_posix(),
        "mtl_path": mtl_path.as_posix(),
        "textures_dir": textures_dir.as_posix(),
        "glb_path": glb_path.as_posix(),
        "meta_path": meta_path.as_posix(),
        "ac_bundle_url": ac_bundle_url,
        **published,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Export Assetto Corsa car bundle for local devtools.")
    ap.add_argument("--car-root", required=True, help="Path to AC car folder (contains data/ or data.acd).")
    ap.add_argument(
        "--ac-root",
        default="",
        help=(
            "Optional: path to Assetto Corsa install root (contains content/, extension/, system/). "
            "Used to resolve shared textures (content/texture, extension/textures) and CSP global configs."
        ),
    )
    ap.add_argument(
        "--out-root",
        default="assets/generated/assetto_corsa",
        help="Output root for exports (default: assets/generated/assetto_corsa).",
    )
    ap.add_argument("--run-id", default="", help="Run id for output folder; auto timestamp if empty.")
    ap.add_argument(
        "--export-audio",
        action="store_true",
        help=(
            "Also export audio-related car-root assets into ac_raw/car_root/ (best-effort): "
            "copies sfx/ and audio.ini when present. Note: AC audio is typically FMOD bank/guids, not decoded samples."
        ),
    )
    ap.add_argument(
        "--export-extras",
        action="store_true",
        help=(
            "Also export selected car-root extras (e.g. extension/, ui/, sfx/, setups/) into ac_raw/car_root/. "
            "This can help future importers that want CSP config or non-physics metadata."
        ),
    )
    ap.add_argument(
        "--export-skins",
        action="store_true",
        help="When used with --export-extras, also export skins/ (can be very large).",
    )
    ap.add_argument(
        "--export-ac-root",
        action="store_true",
        help=(
            "When used with --ac-root, also export selected AC-install refs into ac_raw/ac_root/ "
            "(best-effort): CSP global car configs + INCLUDE fragments + referenced shared textures."
        ),
    )
    ap.add_argument(
        "--runtime-trace",
        default="",
        help="Optional path to runtime trace source (ndjson/jsonl/txt or csv).",
    )
    ap.add_argument(
        "--export-model",
        action="store_true",
        help="Also export the car 3D model to GLB (best-effort). Requires node.",
    )
    ap.add_argument(
        "--model-kn5",
        default="",
        help="Optional: KN5 filename/path under car-root to export (default: largest non-collider *.kn5).",
    )
    ap.add_argument(
        "--model-out-name",
        default="",
        help="Optional: output model name (default: <car_id>.glb). '.glb' suffix optional.",
    )
    ap.add_argument(
        "--skin",
        default="",
        help=(
            "Optional: skin folder name under car-root/skins/ to apply as a texture override layer "
            "when exporting the model. If omitted, a best-effort default skin is chosen."
        ),
    )
    args = ap.parse_args()

    car_root = Path(args.car_root).expanduser().resolve()
    if not car_root.exists() or not car_root.is_dir():
        raise SystemExit(f"Invalid --car-root: {car_root}")

    ac_root = None
    try:
        ac_root_s = str(args.ac_root or "").strip()
        if ac_root_s:
            cand = Path(ac_root_s).expanduser().resolve()
            if not cand.exists() or not cand.is_dir():
                raise SystemExit(f"Invalid --ac-root: {cand}")
            ac_root = cand
    except SystemExit:
        raise
    except Exception:
        ac_root = None

    data_dir = car_root / "data"
    data_acd = car_root / "data.acd"

    car_id = car_root.name
    run_id = args.run_id.strip() or _now_stamp()
    out_root = Path(args.out_root).expanduser().resolve()
    out_dir = out_root / car_id / run_id
    ac_raw_dir = out_dir / "ac_raw"
    normalized_dir = out_dir / "normalized"
    runtime_dir = out_dir / "runtime"
    ac_raw_data_dir = ac_raw_dir / "data"
    ac_raw_car_root_dir = ac_raw_dir / "car_root"
    model_export = {}

    for p in (ac_raw_dir, normalized_dir, runtime_dir):
        p.mkdir(parents=True, exist_ok=True)

    unpack_stats = {"files_written": 0, "bytes_written": 0}
    if data_dir.exists() and data_dir.is_dir():
        _copy_tree(data_dir, ac_raw_data_dir)
    else:
        if not data_acd.exists():
            raise SystemExit(f"No data/ directory or data.acd found at: {car_root}")
        # Prefer unpacking data.acd into the export bundle so downstream tools can parse INIs/LUTs.
        unpack_stats = _unpack_data_acd_to_dir(data_acd, ac_raw_data_dir)

    # Always keep a copy of data.acd for reference/debug when present (even if data/ exists).
    if data_acd.exists() and data_acd.is_file():
        try:
            shutil.copy2(str(data_acd), str(ac_raw_dir / "data.acd"))
        except Exception:
            pass

    audio = {
        "enabled": bool(args.export_audio),
        "copied": [],
        "skipped": [],
        "sample_case_fixes": {"engine_ini_found": 0, "samples_referenced": 0, "aliases_created": 0, "missing": 0},
    }
    if bool(args.export_audio):
        # Keep audio export narrow and explicit: primarily `sfx/` + `audio.ini`.
        # These are commonly needed for engine/transmission sounds and event routing.
        ac_raw_car_root_dir.mkdir(parents=True, exist_ok=True)

        # Copy sfx/ directory (FMOD banks/guids and sometimes wavs).
        try:
            src = (car_root / "sfx").resolve()
            dst = (ac_raw_car_root_dir / "sfx").resolve()
            if src.exists() and src.is_dir():
                _copy_tree(src, dst)
                audio["copied"].append("sfx/")
                try:
                    audio["sample_case_fixes"] = _fix_sfx_sample_casing(dst)
                except Exception:
                    audio["sample_case_fixes"] = {"engine_ini_found": 0, "samples_referenced": 0, "aliases_created": 0, "missing": 0}
            else:
                audio["skipped"].append("sfx/")
        except Exception:
            audio["skipped"].append("sfx/")

        # Copy a few small top-level audio config files (when present).
        for name in ("audio.ini", "sfx.ini"):
            try:
                src = (car_root / name).resolve()
                dst = (ac_raw_car_root_dir / name).resolve()
                if src.exists() and src.is_file():
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(str(src), str(dst))
                    audio["copied"].append(name)
                else:
                    audio["skipped"].append(name)
            except Exception:
                audio["skipped"].append(name)

    extras = {
        "enabled": bool(args.export_extras),
        "skins_included": bool(args.export_skins),
        "copied": [],
        "skipped": [],
    }
    if bool(args.export_extras):
        ac_raw_car_root_dir.mkdir(parents=True, exist_ok=True)
        # High-value car-root folders that are commonly useful but not part of `data/` physics.
        # Note: some mods store model textures in a car-local `texture/` folder or `t/`, and animations in `animations/`.
        extra_dirs = ["extension", "ui", "sfx", "setups", "texture", "t", "animations"]
        if bool(args.export_skins):
            extra_dirs.append("skins")
        for dname in extra_dirs:
            src = car_root / dname
            if src.exists() and src.is_dir():
                try:
                    _copy_tree(src, ac_raw_car_root_dir / dname)
                    extras["copied"].append(f"{dname}/")
                except Exception:
                    extras["skipped"].append(f"{dname}/")
            else:
                extras["skipped"].append(f"{dname}/")

        # Copy selected top-level config files (keep conservative; no huge binaries by default).
        top_level_globs = [
            # Models / colliders
            "*.kn5",
            "*.obj",
            "*.fbx",
            "*.ksanim",
            "*.anim",
            "*.mtl",
            # Textures commonly present at car-root (many mods keep textures in skins/ or texture/ instead).
            "*.dds",
            "*.png",
            "*.jpg",
            "*.jpeg",
            "*.tga",
            "*.bmp",
            "*.gif",
            "*.webp",
            "*.exr",
            "*.hdr",
            # Config / data
            "*.ini",
            "*.lut",
            "*.json",
            "*.txt",
            "*.cfg",
            "*.yml",
            "*.yaml",
        ]
        for pat in top_level_globs:
            for src in car_root.glob(pat):
                if not src.is_file():
                    continue
                try:
                    dst = ac_raw_car_root_dir / src.name
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(str(src), str(dst))
                    extras["copied"].append(src.name)
                except Exception:
                    extras["skipped"].append(src.name)

    ac_root_refs = {"enabled": False}
    if bool(args.export_ac_root) and ac_root is not None:
        try:
            out_ac_root_dir = (ac_raw_dir / "ac_root").resolve()
            ac_root_refs = _export_ac_root_refs_for_car(
                ac_root=ac_root,
                car_root=car_root,
                car_id=car_id,
                out_ac_root_dir=out_ac_root_dir,
            )
        except Exception:
            ac_root_refs = {"enabled": True, "copied": [], "skipped": [], "missing": [], "error": "failed"}

    file_items = []
    ini_entries: List[Dict] = []
    lut_refs: List[Dict] = []
    ini_files = []
    lut_files = []

    # Index + parse everything we exported under ac_raw/ (data/ plus optional car_root/ extras).
    # Note: index.json/params.raw.json are written after this loop, so they won't appear here.
    for f in _iter_files(ac_raw_dir):
        rel = f.relative_to(ac_raw_dir).as_posix()
        ext = f.suffix.lower()
        digest = _sha256_file(f)
        kind = "other"
        if ext == ".ini":
            kind = "ini"
            ini_files.append(rel)
            parsed, refs = _parse_ini_lossless(f, rel)
            ini_entries.extend(parsed)
            lut_refs.extend(refs)
        elif ext == ".lut":
            kind = "lut"
            lut_files.append(rel)
        st = f.stat()
        file_items.append(
            {
                "path": rel,
                "kind": kind,
                "bytes": int(st.st_size),
                "sha256": digest,
            }
        )

    index = {
        "car_id": car_id,
        "run_id": run_id,
        "source_car_root": car_root.as_posix(),
        "generated_at_utc": dt.datetime.now(UTC).isoformat(),
        "unpacked_from_acd": (not data_dir.exists()) and data_acd.exists(),
        "unpack_stats": unpack_stats,
        "audio": audio,
        "extras": extras,
        "ac_root": (ac_root.as_posix() if ac_root is not None else ""),
        "ac_root_refs": ac_root_refs,
        "files": file_items,
        "ini_files": sorted(ini_files),
        "lut_files": sorted(lut_files),
    }
    (ac_raw_dir / "index.json").write_text(json.dumps(index, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")

    params_raw = {
        "car_id": car_id,
        "run_id": run_id,
        "entries": ini_entries,
        "lut_references": lut_refs,
    }
    (ac_raw_dir / "params.raw.json").write_text(
        json.dumps(params_raw, indent=2, ensure_ascii=True) + "\n", encoding="utf-8"
    )

    chrono_manifest = _export_full_native_chrono_from_ac(
        car_id=car_id,
        run_id=run_id,
        entries=ini_entries,
        normalized_dir=normalized_dir,
        out_dir=out_dir,
    )

    bundle = {
        "schema": "ac.car.bundle.v1",
        "car_id": car_id,
        "run_id": run_id,
        "source": {
            "car_root": car_root.as_posix(),
            "data_root": ac_raw_data_dir.as_posix(),
        },
        "audio": audio,
        "stats": {
            "file_count": len(file_items),
            "ini_count": len(ini_files),
            "lut_count": len(lut_files),
            "lut_reference_count": len(lut_refs),
        },
        "paths": {
            "index_json": (ac_raw_dir / "index.json").as_posix(),
            "params_raw_json": (ac_raw_dir / "params.raw.json").as_posix(),
        },
        "chrono": chrono_manifest,
    }

    # Optional: export 3D model for easy spawning in SceneTool.
    if bool(args.export_model):
        kn5_sel = args.model_kn5.strip()
        if not kn5_sel:
            picked = _pick_main_kn5(car_root)
            if not picked:
                raise SystemExit(f"No *.kn5 model found in car root: {car_root}")
            kn5_sel = picked.name
        model_export = _export_model_glb(
            car_root=car_root,
            ac_root=ac_root,
            out_dir=out_dir,
            car_id=car_id,
            model_kn5=kn5_sel,
            model_out_name=(args.model_out_name.strip() or f"{car_id}.glb"),
            skin=str(args.skin or ""),
            export_audio=bool(args.export_audio),
        )
        # Add optional pointers for devtools (non-breaking extension).
        try:
            bundle["model"] = {
                "kn5_path": model_export.get("kn5_path"),
                "glb_path": model_export.get("glb_path"),
            }
        except Exception:
            pass
    (normalized_dir / "car.bundle.json").write_text(
        json.dumps(bundle, indent=2, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )

    runtime_summary = {
        "source": None,
        "trace_path": None,
        "sample_count": 0,
        "time_min": None,
        "time_max": None,
        "dt_min": None,
        "dt_max": None,
        "dt_avg": None,
    }
    runtime_src = args.runtime_trace.strip()
    if runtime_src:
        src = Path(runtime_src).expanduser().resolve()
        if not src.exists() or not src.is_file():
            raise SystemExit(f"Invalid --runtime-trace: {src}")
        _, _, runtime_summary = _copy_or_convert_runtime(src, runtime_dir)

    (runtime_dir / "summary.json").write_text(
        json.dumps(runtime_summary, indent=2, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )

    repo_root = Path(__file__).resolve().parents[1]
    model_glb_rel = None
    model_meta_rel = None
    webautos_glb_rel = None
    try:
        if model_export and model_export.get("glb_path"):
            model_glb_rel = Path(str(model_export.get("glb_path"))).resolve().relative_to(repo_root).as_posix()
    except Exception:
        model_glb_rel = None
    try:
        if model_export and model_export.get("meta_path"):
            model_meta_rel = Path(str(model_export.get("meta_path"))).resolve().relative_to(repo_root).as_posix()
    except Exception:
        model_meta_rel = None
    try:
        if model_export and model_export.get("webautos_glb_path"):
            webautos_glb_rel = Path(str(model_export.get("webautos_glb_path"))).resolve().relative_to(repo_root).as_posix()
    except Exception:
        webautos_glb_rel = None

    result = {
        "ok": True,
        "carId": car_id,
        "runId": run_id,
        "outDir": out_dir.as_posix(),
        "indexJson": (ac_raw_dir / "index.json").as_posix(),
        "paramsRawJson": (ac_raw_dir / "params.raw.json").as_posix(),
        "bundleJson": (normalized_dir / "car.bundle.json").as_posix(),
        "audioExported": bool(args.export_audio),
        "modelGlbPath": model_export.get("glb_path") if model_export else None,
        "modelGlbRel": model_glb_rel,
        "modelMetaRel": model_meta_rel,
        "publishedWebautosModelRel": webautos_glb_rel,
        "chronoManifestJson": (normalized_dir / "chrono" / "manifest.json").as_posix(),
        "chronoVehicleJson": (normalized_dir / "chrono" / "vehicle.json").as_posix(),
        "chronoTireJson": (normalized_dir / "chrono" / "tire.json").as_posix(),
        "chronoManifestUrl": str(chrono_manifest.get("manifestUrl") or "") if isinstance(chrono_manifest, dict) else "",
        "runtimeSummaryJson": (runtime_dir / "summary.json").as_posix(),
        "runtimeTracePath": runtime_summary.get("trace_path"),
        "runtimeSampleCount": runtime_summary.get("sample_count"),
    }
    print("ASSETTO_CORSA_EXPORT_RESULT_JSON:" + json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
