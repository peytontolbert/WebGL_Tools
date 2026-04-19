#!/usr/bin/env python3
"""
List GTA5 ped archetypes and whether they're exported into the WebGL viewer.

How it works:
- Uses CodeWalker.GameFileCache (via gta5_modules/DllManager) to load peds.meta/peds.ymt.
- Reads ped model names from `GameFileCache.PedsInitDict` values (CPedModelInfo__InitData.Name).
- Computes each ped's model hash (joaat/Jenkins on lowercase name).
- Checks if that hash exists in `assets/models/manifest_shards/<low8bits>.json`.

Outputs:
- JSON report (default: assets/meta/peds_export_report.json)
- Optional stdout listing (limited)

Example:
  python3 webgl_viewer/tools/list_exported_peds.py --game-path /data/webglgta/gta5 --assets-dir /data/webglgta/webgl-gta/webgl_viewer/assets
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Dict, List, Tuple


def _u32(v: int) -> int:
    return int(v) & 0xFFFFFFFF


def _shard_path(shards_dir: Path, h_u32: int) -> Path:
    return shards_dir / f"{(int(h_u32) & 0xFF):02x}.json"


def _scan_shard_for_hashes(shard_path: Path, hashes: List[int]) -> set[int]:
    """
    Return subset of `hashes` that exist as top-level keys in the shard JSON.
    Shard files are gigantic; stream scan and avoid parsing JSON.
    """
    found: set[int] = set()
    if not shard_path.exists() or not hashes:
        return found

    # For performance + memory, scan in chunks and only do exact needle checks on chunks that match.
    # Keys are stringified numbers: "1234567890": { ... }
    chunk_size = 200
    for i in range(0, len(hashes), chunk_size):
        chunk = hashes[i : i + chunk_size]
        # Build regex like b'"(?:123|456|...)":'
        alts = b"|".join(str(_u32(x)).encode("ascii") for x in chunk)
        if not alts:
            continue
        pat = re.compile(b"\"(?:" + alts + b")\"\\s*:")

        prev = b""
        with shard_path.open("rb") as f:
            while True:
                b = f.read(4 * 1024 * 1024)
                if not b:
                    break
                hay = prev + b
                if pat.search(hay):
                    # Resolve exact matches within this window.
                    for hh in chunk:
                        needle = (b"\"" + str(_u32(hh)).encode("ascii") + b"\":")
                        if needle in hay:
                            found.add(_u32(hh))
                prev = hay[-1024:]

    return found


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-path", default="/data/webglgta/gta5", help="GTA5 install folder")
    ap.add_argument("--assets-dir", default="", help="webgl_viewer/assets folder (auto: repo/webgl_viewer/assets)")
    ap.add_argument("--output", default="", help="Write JSON report to this path (default: assets/meta/peds_export_report.json)")
    ap.add_argument("--only-exported", action="store_true", help="Only print exported peds to stdout")
    ap.add_argument("--limit", type=int, default=120, help="Max rows to print to stdout (default 120)")
    ap.add_argument("--name-filter", default="", help="Case-insensitive substring filter for stdout (e.g. hipster, mp_m_)")
    args = ap.parse_args()

    repo = Path(__file__).resolve().parents[2]  # .../webgl-gta
    sys.path.insert(0, str(repo))

    from gta5_modules.dll_manager import DllManager
    from gta5_modules.hash_utils import joaat

    game_path = Path(args.game_path)
    if not game_path.exists():
        print(f"ERROR: missing GTA5 path: {game_path}", file=sys.stderr)
        return 2

    assets_dir = Path(args.assets_dir) if args.assets_dir else (repo / "webgl_viewer" / "assets")
    shards_dir = assets_dir / "models" / "manifest_shards"
    if not shards_dir.exists():
        print(f"ERROR: missing manifest shards dir: {shards_dir}", file=sys.stderr)
        return 2

    out_path = Path(args.output) if args.output else (assets_dir / "meta" / "peds_export_report.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    print("Initializing DllManager...")
    dm = DllManager(str(game_path))
    if not dm.initialized:
        print("ERROR: DllManager failed to initialize.", file=sys.stderr)
        return 3

    print("Initializing GameFileCache (peds)...")
    ok = dm.init_game_file_cache(load_vehicles=False, load_peds=True, load_audio=False, selected_dlc="all")
    if not ok:
        print("ERROR: GameFileCache init failed.", file=sys.stderr)
        return 3

    gfc = dm.get_game_file_cache()
    peds_dict = getattr(gfc, "PedsInitDict", None)
    if peds_dict is None:
        print("ERROR: GameFileCache has no PedsInitDict (unexpected).", file=sys.stderr)
        return 4

    # Extract names from values (CPedModelInfo__InitData.Name).
    # pythonnet dictionaries are .NET Dictionary<K,V>; safest is iterate Keys then index.
    items: List[Tuple[str, int]] = []
    keys = []
    try:
        keys = list(getattr(peds_dict, "Keys"))
    except Exception:
        keys = []
    for k in keys:
        v = None
        try:
            # pythonnet supports indexer access in many cases
            v = peds_dict[k]
        except Exception:
            try:
                # explicit indexer method
                v = peds_dict.get_Item(k)
            except Exception:
                v = None
        if v is None:
            continue
        try:
            name = getattr(v, "Name", None)
            s = str(name or "").strip()
            if not s:
                continue
            h = _u32(joaat(s.lower()))
            if h:
                items.append((s, h))
        except Exception:
            continue

    # Dedup by hash (names should be unique, but be safe).
    by_hash: Dict[int, str] = {}
    for name, h in items:
        by_hash.setdefault(h, name)

    all_peds = [(h, by_hash[h]) for h in sorted(by_hash.keys())]
    print(f"Peds in PedsInitDict: {len(all_peds)}")

    # Group by shard (low 8 bits).
    shard_groups: Dict[int, List[int]] = {}
    for h, _name in all_peds:
        shard_groups.setdefault(h & 0xFF, []).append(h)

    exported: set[int] = set()
    for sb, hs in sorted(shard_groups.items()):
        sp = shards_dir / f"{sb:02x}.json"
        exported |= _scan_shard_for_hashes(sp, hs)

    print(f"Exported ped hashes in models manifest: {len(exported)}")

    report = {
        "schema": "webglgta-peds-export-report-v1",
        "game_path": str(game_path),
        "assets_dir": str(assets_dir),
        "peds_total": len(all_peds),
        "peds_exported": len(exported),
        "peds": [
            {"name": name, "hash": int(h), "exported": bool(h in exported)}
            for (h, name) in sorted(((h, n) for (h, n) in all_peds), key=lambda x: x[1].lower())
        ],
    }
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Wrote report: {out_path}")

    # Optional stdout listing (filtered/limited).
    lim = max(0, min(5000, int(args.limit or 0)))
    filt = str(args.name_filter or "").strip().lower()
    rows = []
    for h, name in sorted(((h, n) for (h, n) in all_peds), key=lambda x: x[1].lower()):
        if args.only_exported and (h not in exported):
            continue
        if filt and (filt not in name.lower()):
            continue
        rows.append((name, h, (h in exported)))

    if lim > 0 and rows:
        print("")
        print("name\thash\texported")
        for name, h, ex in rows[:lim]:
            print(f"{name}\t{h}\t{1 if ex else 0}")
        if len(rows) > lim:
            print(f"... plus {len(rows) - lim} more matching rows")

    # Quick default ped sanity check.
    hipster = _u32(joaat("a_m_y_hipster_01"))
    print("")
    print(f"a_m_y_hipster_01 hash={hipster} exported={hipster in exported}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())


