#!/usr/bin/env python3
"""
Diagnose missing mesh hashes (why they weren't exported).

Reads a hash list (one hash per line) and uses CodeWalker GameFileCache to classify each hash into:
- no_archetype: GetArchetype returned None (likely DLC selection, non-meta YTYP, or non-archetype content)
- no_drawable: archetype exists but TryGetDrawable returned None (often non-renderable archetype types)
- ok: drawable resolved (meaning exporter should be able to export; indicates an exporter bug/exception)

This tool is meant to answer: "Are we missing something we can export, or are these truly non-mesh archetypes?"
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

# Ensure repo root on sys.path so `gta5_modules` imports work when running directly.
_REPO_ROOT = Path(__file__).resolve().parents[2]
try:
    sys.path.insert(0, str(_REPO_ROOT))
except Exception:
    pass

from gta5_modules.dll_manager import DllManager
from gta5_modules.codewalker_archetypes import get_archetype_best_effort
from gta5_modules.cw_loaders import try_get_drawable as _try_get_drawable
from gta5_modules.script_paths import auto_assets_dir


def _u32(x: int) -> int:
    return int(x) & 0xFFFFFFFF


def _read_hashes(path: Path) -> list[int]:
    try:
        raw = path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        raw = ""
    out: list[int] = []
    for line in raw.splitlines():
        s = line.strip()
        if not s:
            continue
        # allow "<hash> <anything>"
        s = s.split()[0]
        try:
            out.append(_u32(int(s)))
        except Exception:
            continue
    # unique, stable
    seen = set()
    uniq = []
    for h in out:
        if h in seen:
            continue
        seen.add(h)
        uniq.append(h)
    return uniq


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-path", required=True, help="GTA5 install folder")
    ap.add_argument("--assets-dir", default="", help="webgl_viewer/assets folder (auto if omitted)")
    ap.add_argument(
        "--hashes-file",
        default="",
        help="Hash list file (defaults to assets/models/targeted_missing_mesh_hashes.txt)",
    )
    ap.add_argument("--selected-dlc", default="all", help="CodeWalker DLC level for the cache (default: all)")
    ap.add_argument(
        "--also-try-patchday27ng",
        action="store_true",
        help="If a hash is no_archetype/no_drawable in 'all', also try scanning under DLC level patchday27ng.",
    )
    ap.add_argument("--limit", type=int, default=0, help="Limit number of hashes diagnosed (0 = all)")
    ap.add_argument("--spins", type=int, default=800, help="TryGetDrawable spins")
    args = ap.parse_args()

    game_path = str(args.game_path or "").strip().strip('"').strip("'")
    assets_dir = auto_assets_dir(args.assets_dir)

    hashes_path = Path(str(args.hashes_file or "").strip()) if str(args.hashes_file or "").strip() else (assets_dir / "models" / "targeted_missing_mesh_hashes.txt")
    hashes = _read_hashes(hashes_path)
    if args.limit and int(args.limit) > 0:
        hashes = hashes[: int(args.limit)]

    dm = DllManager(game_path)
    if not dm.initialized:
        raise SystemExit("Failed to initialize DllManager")
    if not dm.init_game_file_cache(selected_dlc=str(args.selected_dlc or "").strip() or None):
        raise SystemExit("Failed to init GameFileCache")
    gfc = dm.get_game_file_cache()
    try:
        gfc.MaxItemsPerLoop = 200
    except Exception:
        pass

    def classify_one(h: int) -> tuple[str, dict]:
        arch = get_archetype_best_effort(gfc, _u32(h), dll_manager=dm)
        if arch is None and args.also_try_patchday27ng:
            arch = get_archetype_best_effort(gfc, _u32(h), dll_manager=dm, also_scan_dlc_levels=["patchday27ng"])
        if arch is None:
            return "no_archetype", {"hash": int(h)}

        # Pull some identifying strings when possible.
        try:
            name = str(getattr(arch, "Name", "") or "")
        except Exception:
            name = ""
        try:
            asset = str(getattr(arch, "AssetName", "") or "")
        except Exception:
            asset = ""
        try:
            drawdict = getattr(arch, "DrawableDict", None)
            drawdict_h = int(getattr(drawdict, "Hash", int(drawdict))) & 0xFFFFFFFF if drawdict is not None else 0
        except Exception:
            drawdict_h = 0

        drawable = _try_get_drawable(gfc, arch, spins=int(args.spins or 0))
        if drawable is None and args.also_try_patchday27ng:
            # Best-effort: if drawable might exist only under patchday27ng's mounted set, retry under that level.
            try:
                if hasattr(gfc, "SetDlcLevel"):
                    gfc.SetDlcLevel("patchday27ng", True)
            except Exception:
                pass
            drawable = _try_get_drawable(gfc, arch, spins=int(args.spins or 0))
            # Restore original selection (best-effort) so subsequent hashes remain consistent.
            try:
                if hasattr(gfc, "SetDlcLevel"):
                    gfc.SetDlcLevel(str(args.selected_dlc or "all"), True)
            except Exception:
                pass

        if drawable is None:
            return "no_drawable", {"hash": int(h), "name": name, "asset": asset, "drawableDict": int(drawdict_h)}

        # If drawable resolves, exporter failures are likely due to mesh extraction edge cases.
        return "ok", {"hash": int(h), "name": name, "asset": asset, "drawableDict": int(drawdict_h), "drawableType": str(type(drawable))}

    counts = Counter()
    samples: dict[str, list[dict]] = {"no_archetype": [], "no_drawable": [], "ok": []}
    for h in hashes:
        cls, info = classify_one(h)
        counts[cls] += 1
        if len(samples[cls]) < 60:
            samples[cls].append(info)

    out = {
        "hashesFile": str(hashes_path),
        "selectedDlc": str(args.selected_dlc),
        "alsoTryPatchday27ng": bool(args.also_try_patchday27ng),
        "spins": int(args.spins or 0),
        "counts": dict(counts),
        "samples": samples,
    }
    out_path = assets_dir / "models" / "diagnose_missing_mesh_hashes.json"
    out_path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(json.dumps(out, indent=2))
    print(f"\n[ok] wrote {out_path}")


if __name__ == "__main__":
    main()


