#!/usr/bin/env python3
"""
Bulk convert Omniverse USD assets to GLB using the ingestion manifest.

Input:
  outputs/omniverse/omniverse_ingest_manifest.json

Output (default):
  assets/generated/omniverse_glb/<pack>/<original-relative-path-without-ext>.glb
  outputs/omniverse/omniverse_bulk_convert_results.json

Safety:
- Only converts items listed under `convertToGlb` in the manifest.
- Skips any item that looks motion-only or meshless (defensive).
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = REPO_ROOT / "outputs" / "omniverse" / "omniverse_ingest_manifest.json"
DEFAULT_OUT_ROOT = REPO_ROOT / "assets" / "generated" / "omniverse_glb"
DEFAULT_RESULTS = REPO_ROOT / "outputs" / "omniverse" / "omniverse_bulk_convert_results.json"

USD_EXTS = {".usd", ".usda", ".usdc", ".usdz"}


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8") or "{}")


def _write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2) + "\n", encoding="utf-8")


def _safe_int(x: Any) -> int:
    try:
        return int(x)
    except Exception:
        return 0


def _rel_to_abs(rel_posix: str) -> Path:
    # Manifest paths are repo-relative posix paths (e.g. assets/external/...).
    s = str(rel_posix or "").lstrip("/").strip()
    if not s or ".." in s:
        raise ValueError(f"invalid rel path: {rel_posix!r}")
    return (REPO_ROOT / s).resolve()


def _out_path_for_input(out_root: Path, pack: str, input_rel_posix: str, export_format: str) -> Path:
    # Preserve pack + relative structure under the pack folder, but strip the leading packs root.
    # Example:
    #   assets/external/omniverse/packs/Commercial_NVD_10013/Foo/Bar.usd
    # -> assets/generated/omniverse_glb/Commercial_NVD_10013/Foo/Bar.glb
    p = str(input_rel_posix or "").lstrip("/").strip()
    ext = Path(p).suffix.lower()
    stem = p[: -len(ext)] if ext else p

    prefix = f"assets/external/omniverse/packs/{pack}/"
    if stem.startswith(prefix):
        stem = stem[len(prefix) :]
    else:
        # Fallback: keep the whole path under the pack folder.
        stem = stem.replace(":", "_")

    out_ext = ".gltf" if export_format == "GLTF_SEPARATE" else ".glb"
    return (out_root / pack / f"{stem}{out_ext}").resolve()


def _is_motion_only(stats: dict[str, Any]) -> bool:
    mesh = _safe_int(stats.get("meshCount"))
    skel_anim = _safe_int(stats.get("skelAnimationCount"))
    return mesh <= 0 and skel_anim > 0


def _run_convert(convert_asset_py: Path, *, inp: Path, out: Path, export_format: str, blender: str) -> tuple[int, float, str]:
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        sys.executable,
        str(convert_asset_py),
        "to-gltf",
        "--in",
        str(inp),
        "--out",
        str(out),
        "--export-format",
        str(export_format),
    ]
    if blender:
        cmd += ["--blender", blender]

    t0 = time.time()
    p = subprocess.run(cmd, cwd=str(REPO_ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    dt = time.time() - t0
    return int(p.returncode), float(dt), str(p.stdout or "")


def main() -> int:
    ap = argparse.ArgumentParser(prog="omniverse_bulk_convert_from_manifest.py")
    ap.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    ap.add_argument("--out-root", default=str(DEFAULT_OUT_ROOT))
    ap.add_argument("--results", default=str(DEFAULT_RESULTS))
    ap.add_argument("--export-format", default="GLB", choices=["GLB", "GLTF_SEPARATE"])
    ap.add_argument("--blender", default="", help="Optional Blender executable path. If empty, convert_asset.py will auto-pick.")
    ap.add_argument("--pack", action="append", default=[], help="Only convert these packs (repeatable).")
    ap.add_argument("--max-total", type=int, default=0, help="Optional cap for total conversions (0 = no cap).")
    ap.add_argument("--max-per-pack", type=int, default=0, help="Optional cap per pack (0 = no cap).")
    ap.add_argument("--dry-run", action="store_true", help="Print planned outputs but do not convert.")
    args = ap.parse_args()

    manifest_abs = Path(args.manifest).resolve()
    if not manifest_abs.exists():
        raise FileNotFoundError(str(manifest_abs))

    manifest = _read_json(manifest_abs)
    packs = manifest.get("packs") or []
    if not isinstance(packs, list):
        raise ValueError("manifest.packs must be a list")

    out_root = Path(args.out_root).resolve()
    results_abs = Path(args.results).resolve()
    export_format = str(args.export_format or "GLB").strip() or "GLB"
    blender = str(args.blender or "").strip()

    only_packs = {s.strip() for s in (args.pack or []) if s.strip()}

    convert_asset_py = (REPO_ROOT / "tools" / "convert_asset.py").resolve()
    if not convert_asset_py.exists():
        raise FileNotFoundError(str(convert_asset_py))

    planned = []
    for pack_rec in packs:
        if not isinstance(pack_rec, dict) or not pack_rec.get("ok"):
            continue
        pack = str(pack_rec.get("pack") or "").strip()
        if not pack:
            continue
        if only_packs and pack not in only_packs:
            continue

        items = pack_rec.get("convertToGlb") or []
        if not isinstance(items, list):
            continue
        n_pack = 0
        for it in items:
            if args.max_total and len(planned) >= int(args.max_total):
                break
            if args.max_per_pack and n_pack >= int(args.max_per_pack):
                break
            if not isinstance(it, dict):
                continue
            rel = str(it.get("path") or "").strip()
            if not rel:
                continue
            stats = it.get("stats") or {}
            if not isinstance(stats, dict):
                stats = {}
            # Defensive safety: skip meshless/motion-only.
            if _safe_int(stats.get("meshCount")) <= 0:
                continue
            if _is_motion_only(stats):
                continue
            inp_abs = _rel_to_abs(rel)
            if not inp_abs.exists():
                continue
            out_abs = _out_path_for_input(out_root, pack, rel, export_format)
            planned.append({"pack": pack, "in": rel, "inAbs": str(inp_abs), "outAbs": str(out_abs)})
            n_pack += 1

    if args.dry_run:
        print(f"Planned conversions: {len(planned)}")
        for row in planned[:200]:
            print(f"- [{row['pack']}] {row['in']} -> {Path(row['outAbs']).relative_to(REPO_ROOT)}")
        if len(planned) > 200:
            print(f"(+{len(planned) - 200} more)")
        return 0

    results = {
        "ok": True,
        "manifest": str(manifest_abs),
        "outRoot": str(out_root),
        "exportFormat": export_format,
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "itemsPlanned": len(planned),
        "items": [],
    }

    converted = 0
    for row in planned:
        pack = row["pack"]
        inp_abs = Path(row["inAbs"])
        out_abs = Path(row["outAbs"])

        if out_abs.exists() and out_abs.stat().st_size > 256:
            results["items"].append(
                {
                    "pack": pack,
                    "in": row["in"],
                    "out": str(out_abs.relative_to(REPO_ROOT)),
                    "status": "skipped_exists",
                    "seconds": 0.0,
                    "exitCode": 0,
                    "logTail": "",
                }
            )
            continue

        code, seconds, out_log = _run_convert(convert_asset_py, inp=inp_abs, out=out_abs, export_format=export_format, blender=blender)
        tail = "\n".join(out_log.splitlines()[-60:]) if out_log else ""
        status = "ok" if (code == 0 and out_abs.exists() and out_abs.stat().st_size > 256) else "error"
        results["items"].append(
            {
                "pack": pack,
                "in": row["in"],
                "out": str(out_abs.relative_to(REPO_ROOT)) if out_abs.exists() else str(out_abs),
                "status": status,
                "seconds": float(seconds),
                "exitCode": int(code),
                "logTail": tail,
              }
        )
        converted += 1

        # Persist results incrementally so we can resume after failures.
        try:
            _write_json(results_abs, results)
        except Exception:
            pass

    results["endedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    results["itemsConvertedAttempted"] = converted
    _write_json(results_abs, results)

    ok = sum(1 for it in results["items"] if it.get("status") == "ok")
    err = sum(1 for it in results["items"] if it.get("status") == "error")
    sk = sum(1 for it in results["items"] if str(it.get("status")).startswith("skipped"))
    print(f"Wrote: {results_abs}")
    print(f"ok={ok} error={err} skipped={sk}")
    return 0 if err == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())

