"""
Generate `webgl_viewer/assets/dlc_order.json` from CodeWalker DLC setup ordering.

Why:
  CodeWalker loads DLC in a specific order (DlcSetupFiles.OrderBy(order)) and stops at "SelectedDlc".
  The WebGL viewer can mirror this via a simple "DLC anchor" dropdown that filters streamed YMAP entities
  by their source path (e.g. update\\x64\\dlcpacks\\<dlcname>\\...).

Output schema:
  {
    "schema": "webglgta-dlc-order-v1",
    "generatedAtUnix": 1700000000,
    "selectedDlc": "all",
    "dlcNamesOrdered": ["patchday1ng", "patchday2ng", "mpheist", ...]
  }

Usage:
  python3 webgl-gta/webgl_viewer/tools/write_dlc_order_from_codewalker.py \
    --gta-path /data/webglgta/gta5 \
    --selected-dlc all \
    --write
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional


def _dotnet_list_to_py_list(x: Any) -> List[Any]:
    if x is None:
        return []
    try:
        return list(x)
    except Exception:
        pass
    try:
        n = int(getattr(x, "Count"))
    except Exception:
        n = 0
    out: List[Any] = []
    for i in range(max(0, n)):
        try:
            out.append(x[i])
        except Exception:
            continue
    return out


def _parse_dlc_name_from_rpf_path(path: str) -> str:
    """
    Best-effort parse of DLC name from an RPF path like:
      "update\\x64\\dlcpacks\\mpheist\\dlc.rpf"
    """
    s = str(path or "").strip().replace("/", "\\").lower()
    if not s:
        return ""
    # Typical: ...\dlcpacks\<name>\dlc.rpf
    marker = "\\dlcpacks\\"
    i = s.find(marker)
    if i >= 0:
        rest = s[i + len(marker) :]
        name = rest.split("\\", 1)[0].strip()
        return name
    # update.rpf itself (acts like a "base title update" layer)
    if s.endswith("\\update.rpf") or s.endswith("update.rpf"):
        return "update"
    return ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gta-path", required=True)
    ap.add_argument("--selected-dlc", default="all")
    ap.add_argument("--assets-dir", default="", help="defaults to webgl_viewer/assets next to this script")
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    from gta5_modules.dll_manager import DllManager  # noqa

    viewer_root = Path(__file__).resolve().parents[1]
    assets_dir = Path(args.assets_dir) if args.assets_dir else (viewer_root / "assets")

    dm = DllManager(str(args.gta_path))
    if not getattr(dm, "initialized", False):
        raise SystemExit("DllManager failed to initialize.")

    ok = dm.init_game_file_cache(
        selected_dlc=str(args.selected_dlc),
        load_vehicles=False,
        load_peds=False,
        load_audio=False,
    )
    if not ok:
        raise SystemExit("Failed to init GameFileCache.")
    gfc = dm.get_game_cache()
    if gfc is None or not getattr(gfc, "IsInited", False):
        raise SystemExit("GameFileCache not inited.")

    setup_files = _dotnet_list_to_py_list(getattr(gfc, "DlcSetupFiles", None))
    items: List[Dict[str, Any]] = []
    for sf in setup_files:
        try:
            order = int(getattr(sf, "order", 0))
        except Exception:
            order = 0
        dlc_file = getattr(sf, "DlcFile", None)
        path = ""
        try:
            path = str(getattr(dlc_file, "Path", "") or "")
        except Exception:
            path = ""
        name = _parse_dlc_name_from_rpf_path(path)
        if not name or name == "update":
            # Keep update separate; the viewer treats base/update as always-on.
            continue
        items.append({"order": order, "name": name, "path": path})

    # Sort by CodeWalker 'order' (stable tiebreaker by name).
    items.sort(key=lambda it: (int(it.get("order", 0)), str(it.get("name", ""))))
    dlc_names: List[str] = []
    seen = set()
    for it in items:
        n = str(it.get("name", "")).strip().lower()
        if not n or n in seen:
            continue
        seen.add(n)
        dlc_names.append(n)

    out = {
        "schema": "webglgta-dlc-order-v1",
        "generatedAtUnix": int(time.time()),
        "selectedDlc": str(args.selected_dlc),
        "dlcNamesOrdered": dlc_names,
    }

    if not args.write:
        print(json.dumps(out, indent=2, sort_keys=True))
        return 0

    assets_dir.mkdir(parents=True, exist_ok=True)
    dst = assets_dir / "dlc_order.json"
    tmp = assets_dir / "dlc_order.json.tmp"
    tmp.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(dst)
    print(f"Wrote {dst} ({len(dlc_names)} dlcs)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


