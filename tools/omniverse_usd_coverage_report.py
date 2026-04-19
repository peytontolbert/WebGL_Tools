#!/usr/bin/env python3
"""
Omniverse USD "coverage" report across extracted packs.

Goal:
- quantify how many USD files exist vs how many we successfully inspect
- highlight meshless (motion-only) USDs vs "real" model USDs
- surface dependency/missing-file issues (where available from inspector)

This script uses the repo's portable Blender 5.0 by default for inspection,
because it ships OpenUSD Python bindings (`pxr`) even when system Python doesn't.

Example:
  python3 tools/omniverse_usd_coverage_report.py --pack Characters_NVD_10012
  python3 tools/omniverse_usd_coverage_report.py --max-usd-per-pack 200
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
USD_EXTS = {".usd", ".usda", ".usdc", ".usdz"}
BLENDER5_PORTABLE = REPO_ROOT / "tools" / "third_party" / "blender-5.0" / "blender-5.0.0-linux-x64" / "blender"
BLENDER_INSPECT_SCRIPT = REPO_ROOT / "tools" / "rigging" / "blender_usd_inspect.py"


def _to_rel_posix(p: Path) -> str:
    try:
        return p.resolve().relative_to(REPO_ROOT.resolve()).as_posix()
    except Exception:
        return p.as_posix()


def _pick_blender5(blender_arg: str) -> str:
    explicit = str(blender_arg or "").strip()
    if explicit:
        return explicit
    try:
        if BLENDER5_PORTABLE.exists():
            return str(BLENDER5_PORTABLE.resolve())
    except Exception:
        pass
    return "blender"


def _parse_json_from_blender_stdout(stdout: str) -> dict[str, Any] | None:
    raw = str(stdout or "")
    i0 = raw.find("{")
    i1 = raw.rfind("}")
    if i0 < 0 or i1 <= i0:
        return None
    try:
        j = json.loads(raw[i0 : i1 + 1])
    except Exception:
        return None
    return j if isinstance(j, dict) else None


def inspect_usd(abs_path: Path, *, blender_exe: str, top: int = 10, timeout_s: int = 90) -> dict[str, Any]:
    if not abs_path.exists():
        return {"ok": False, "error": f"missing file: {abs_path}"}
    if not BLENDER_INSPECT_SCRIPT.exists():
        return {"ok": False, "error": f"missing inspector script: {BLENDER_INSPECT_SCRIPT}"}

    cmd = [
        str(blender_exe),
        "--background",
        "--factory-startup",
        "--python",
        str(BLENDER_INSPECT_SCRIPT),
        "--",
        "--in",
        str(abs_path.resolve()),
        "--top",
        str(max(5, min(200, int(top or 10)))),
    ]
    t0 = time.time()
    try:
        p = subprocess.run(cmd, cwd=str(REPO_ROOT), capture_output=True, text=True, timeout=int(timeout_s))
    except Exception as e:
        return {"ok": False, "error": f"blender run failed: {e}"}
    dt_ms = int((time.time() - t0) * 1000)

    j = _parse_json_from_blender_stdout(p.stdout or "")
    if not j:
        return {
            "ok": False,
            "error": f"could not parse inspector JSON (exit {p.returncode})",
            "stdoutTail": (p.stdout or "")[-2000:],
            "stderrTail": (p.stderr or "")[-2000:],
            "elapsedMs": dt_ms,
        }
    j.setdefault("elapsedMs", dt_ms)
    return j


def list_usd_files(pack_abs: Path) -> list[Path]:
    out: list[Path] = []
    try:
        for p in pack_abs.rglob("*"):
            try:
                if p.is_file() and p.suffix.lower() in USD_EXTS:
                    out.append(p)
            except OSError:
                continue
    except Exception:
        pass
    out.sort(key=lambda p: p.as_posix().lower())
    return out


@dataclass
class PackCoverage:
    pack: str
    usd_total: int
    usd_inspected: int
    inspected_ok: int
    inspected_err: int
    meshless: int
    motion_only: int
    rigged: int
    missing_any: int
    unresolved_any: int
    up_axis: dict[str, int]
    meters_per_unit: dict[str, int]
    samples: dict[str, list[str]]


def main() -> int:
    ap = argparse.ArgumentParser(prog="omniverse_usd_coverage_report.py")
    ap.add_argument("--packs-root", default="assets/external/omniverse/packs")
    ap.add_argument("--pack", default="", help="Optional single pack name.")
    ap.add_argument("--max-usd-per-pack", type=int, default=120, help="Cap inspected USDs per pack (0 = no cap).")
    ap.add_argument("--timeout-s", type=int, default=90)
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--blender", default="", help="Optional Blender exe (defaults to portable Blender 5.0 if present).")
    ap.add_argument("--out", default="", help="Output JSON path (default: outputs/omniverse/usd_coverage_report.json).")
    args = ap.parse_args()

    packs_root = (REPO_ROOT / str(args.packs_root)).resolve()
    if not packs_root.exists():
        raise FileNotFoundError(f"Missing packs root: {packs_root}")

    blender_exe = _pick_blender5(str(args.blender or ""))

    if args.pack:
        pack_dirs = [(str(args.pack).strip(), (packs_root / str(args.pack).strip()).resolve())]
    else:
        pack_dirs = [(p.name, p.resolve()) for p in packs_root.iterdir() if p.is_dir() and not p.name.startswith(".")]
        pack_dirs.sort(key=lambda t: t[0].lower())

    per_pack: list[PackCoverage] = []
    global_counts = Counter()
    t_start = time.time()

    for (pack_name, pack_abs) in pack_dirs:
        if not pack_abs.exists():
            continue

        usd_files = list_usd_files(pack_abs)
        max_n = int(args.max_usd_per_pack or 0)
        to_inspect = usd_files if max_n <= 0 else usd_files[:max_n]

        up_axis = Counter()
        mpu = Counter()
        samples: dict[str, list[str]] = {
            "meshless": [],
            "motion_only": [],
            "missing_files": [],
            "unresolved": [],
            "inspect_error": [],
        }

        ok = 0
        err = 0
        meshless = 0
        motion_only = 0
        rigged = 0
        missing_any = 0
        unresolved_any = 0

        for p in to_inspect:
            j = inspect_usd(p, blender_exe=blender_exe, top=int(args.top), timeout_s=int(args.timeout_s))
            if not j.get("ok"):
                err += 1
                if len(samples["inspect_error"]) < 10:
                    samples["inspect_error"].append(_to_rel_posix(p))
                continue
            ok += 1
            st = j.get("stats") if isinstance(j.get("stats"), dict) else {}
            mesh = int((st or {}).get("meshCount") or 0)
            skel_root = int((st or {}).get("skelRootCount") or 0)
            skel_anim = int((st or {}).get("skelAnimationCount") or 0)
            skeleton = int((st or {}).get("skeletonCount") or 0)

            if mesh <= 0:
                meshless += 1
                if len(samples["meshless"]) < 10:
                    samples["meshless"].append(_to_rel_posix(p))
                if skel_anim > 0:
                    motion_only += 1
                    if len(samples["motion_only"]) < 10:
                        samples["motion_only"].append(_to_rel_posix(p))
            if skel_root > 0 or skeleton > 0:
                rigged += 1

            meta = j.get("meta") if isinstance(j.get("meta"), dict) else {}
            ax = str(meta.get("upAxis") or "").strip() or "?"
            up_axis[ax] += 1
            meters = meta.get("metersPerUnit")
            try:
                m = float(meters)
                key = f"{m:.6g}"
            except Exception:
                key = "?"
            mpu[key] += 1

            missing_files = j.get("missingFiles")
            if isinstance(missing_files, list) and missing_files:
                missing_any += 1
                if len(samples["missing_files"]) < 10:
                    samples["missing_files"].append(_to_rel_posix(p))

            deps = j.get("dependencyStats") if isinstance(j.get("dependencyStats"), dict) else {}
            if int(deps.get("unresolvedCount") or 0) > 0:
                unresolved_any += 1
                if len(samples["unresolved"]) < 10:
                    samples["unresolved"].append(_to_rel_posix(p))

        cov = PackCoverage(
            pack=pack_name,
            usd_total=len(usd_files),
            usd_inspected=len(to_inspect),
            inspected_ok=ok,
            inspected_err=err,
            meshless=meshless,
            motion_only=motion_only,
            rigged=rigged,
            missing_any=missing_any,
            unresolved_any=unresolved_any,
            up_axis=dict(up_axis),
            meters_per_unit=dict(mpu),
            samples=samples,
        )
        per_pack.append(cov)

        global_counts["packs"] += 1
        global_counts["usd_total"] += len(usd_files)
        global_counts["usd_inspected"] += len(to_inspect)
        global_counts["inspected_ok"] += ok
        global_counts["inspected_err"] += err

    out_path = str(args.out or "").strip()
    if not out_path:
        out_path = str((REPO_ROOT / "outputs" / "omniverse" / "usd_coverage_report.json").resolve())
    out_abs = Path(out_path).resolve()
    out_abs.parent.mkdir(parents=True, exist_ok=True)

    obj = {
        "ok": True,
        "packsRoot": _to_rel_posix(packs_root),
        "blender": str(blender_exe),
        "inspector": _to_rel_posix(BLENDER_INSPECT_SCRIPT),
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t_start)),
        "elapsedSec": float(f"{(time.time() - t_start):.3f}"),
        "global": dict(global_counts),
        "packs": [c.__dict__ for c in per_pack],
        "notes": [
            "This is a *coverage sample* when --max-usd-per-pack > 0.",
            "Full coverage requires setting --max-usd-per-pack 0 (can take a long time).",
        ],
    }
    out_abs.write_text(json.dumps(obj, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote: {out_abs}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

