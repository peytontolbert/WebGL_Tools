"""
Generate `webgl_viewer/assets/ymap_versions.json` from CodeWalker RPF indexes.

Why:
  CodeWalker resolves .ymap files by ShortNameHash (base filename hash) with DLC overlays/patchdays.
  If your export includes entities from multiple versions of the same YMAP, the viewer can show duplicates.

This file lets the viewer choose, for a given selected DLC anchor, the "best" ymap version:
  best = max(order <= selectedMaxOrder) per ymapHash

Output schema:
  {
    "schema": "webglgta-ymap-versions-v1",
    "generatedAtUnix": 1700000000,
    "selectedDlc": "all",
    "dlcOrder": { "patchday1ng": 1, ... },
    "byYmapHash": {
      "123456789": [
        {"order": 0, "dlc": "", "path": "x64a.rpf\\...\\foo.ymap"},
        {"order": 12, "dlc": "patchday12ng", "path": "update\\x64\\dlcpacks\\patchday12ng\\dlc.rpf\\...\\foo.ymap"}
      ]
    }
  }

Usage:
  python3 webgl-gta/webgl_viewer/tools/write_ymap_versions_from_codewalker.py \
    --gta-path /data/webglgta/gta5 \
    --selected-dlc all \
    --write
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Tuple


def _dotnet_dict_to_items(d: Any) -> List[Tuple[Any, Any]]:
    if d is None:
        return []
    try:
        # pythonnet often allows direct iteration over DictionaryEntry
        return list(d.items())
    except Exception:
        pass
    try:
        # Try Keys / indexer
        keys = list(getattr(d, "Keys"))
        out = []
        for k in keys:
            try:
                out.append((k, d[k]))
            except Exception:
                continue
        return out
    except Exception:
        return []


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


def _parse_dlc_name_from_path(path: str) -> str:
    s = str(path or "").strip().replace("/", "\\").lower()
    if not s:
        return ""
    marker = "\\dlcpacks\\"
    i = s.find(marker)
    if i < 0:
        return ""
    rest = s[i + len(marker) :]
    name = rest.split("\\", 1)[0].strip()
    return name


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

    # DLC order mapping (CodeWalker DlcSetupFiles order)
    dlc_order: Dict[str, int] = {}
    try:
        setup_files = _dotnet_list_to_py_list(getattr(gfc, "DlcSetupFiles", None))
        items = []
        for sf in setup_files:
            try:
                order = int(getattr(sf, "order", 0))
            except Exception:
                order = 0
            dlc_file = getattr(sf, "DlcFile", None)
            p = ""
            try:
                p = str(getattr(dlc_file, "Path", "") or "")
            except Exception:
                p = ""
            name = _parse_dlc_name_from_path(p)
            if not name:
                continue
            items.append((order, name))
        items.sort(key=lambda t: (int(t[0]), str(t[1])))
        seen = set()
        cur = 1
        for _, name in items:
            n = str(name).strip().lower()
            if not n or n in seen:
                continue
            seen.add(n)
            dlc_order[n] = cur
            cur += 1
    except Exception:
        dlc_order = {}

    # Enumerate ALL .ymap entries from RpfManager.EntryDict.
    rpfman = getattr(gfc, "RpfMan", None)
    entry_dict = getattr(rpfman, "EntryDict", None) if rpfman is not None else None
    if entry_dict is None:
        raise SystemExit("GameFileCache.RpfMan.EntryDict is missing; cannot enumerate ymaps.")

    by_hash: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    seen_path: Dict[str, set] = defaultdict(set)  # hash -> set(path)

    for _, entry in _dotnet_dict_to_items(entry_dict):
        if entry is None:
            continue
        try:
            name_lower = str(getattr(entry, "NameLower", "") or "")
        except Exception:
            name_lower = ""
        if not name_lower.endswith(".ymap"):
            continue
        try:
            path = str(getattr(entry, "Path", "") or "")
        except Exception:
            path = ""
        if not path:
            continue
        try:
            h = int(getattr(entry, "ShortNameHash"))
        except Exception:
            continue
        h_u32 = h & 0xFFFFFFFF
        hs = str(h_u32)
        if path in seen_path[hs]:
            continue
        seen_path[hs].add(path)

        dlc = _parse_dlc_name_from_path(path)
        order = int(dlc_order.get(dlc, 0)) if dlc else 0
        by_hash[hs].append({"order": order, "dlc": dlc, "path": path})

    # Sort versions per ymapHash
    for hs, arr in by_hash.items():
        arr.sort(key=lambda it: (int(it.get("order", 0)), str(it.get("dlc", "")), str(it.get("path", ""))))

    out = {
        "schema": "webglgta-ymap-versions-v1",
        "generatedAtUnix": int(time.time()),
        "selectedDlc": str(args.selected_dlc),
        "dlcOrder": dlc_order,
        "byYmapHash": dict(by_hash),
    }

    if not args.write:
        print(json.dumps(out, indent=2, sort_keys=True))
        return 0

    assets_dir.mkdir(parents=True, exist_ok=True)
    dst = assets_dir / "ymap_versions.json"
    tmp = assets_dir / "ymap_versions.json.tmp"
    tmp.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(dst)
    print(f"Wrote {dst} ({len(by_hash)} ymap hashes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


