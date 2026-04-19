#!/usr/bin/env python3
"""
Targeted exporter for missing archetypes/models.
---------------------------------------------

Scans the viewer's streamed entity chunks to discover which archetype hashes are actually referenced,
then compares that set against what has been exported into `assets/models/*.bin` and runs targeted exports
for the missing ones.

Why this exists:
- `assets/models/manifest.json` can be huge (hundreds of MB). Reading it just to find missing meshes is slow.
- The authoritative "what should exist" is `assets/entities_chunks/*.jsonl`.
- Some DLC packs (notably `patchday27ng`) are intentionally skipped by CodeWalker unless explicitly selected.
  So a second targeted pass is often required.

Usage:
  python webgl_viewer/tools/targeted_export_missing.py --game-path /path/to/GTA5 --assets-dir webgl_viewer/assets

Recommended:
  # First pass: all DLC overlays (but still excludes patchday27ng per CodeWalker)
  python webgl_viewer/tools/targeted_export_missing.py --game-path ... --assets-dir ... --run-export

  # Second pass: include patchday27ng explicitly
  python webgl_viewer/tools/targeted_export_missing.py --game-path ... --assets-dir ... --run-export --also-patchday27ng
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Optional

#
# Allow running this script directly from anywhere (Cursor/terminal) without requiring PYTHONPATH.
# Repo layout: <repo>/gta5_modules and <repo>/export_drawables_for_chunk.py live at repo root.
#
_REPO_ROOT = Path(__file__).resolve().parents[2]
try:
    sys.path.insert(0, str(_REPO_ROOT))
except Exception:
    pass

from gta5_modules.hash_utils import joaat as _joaat
from gta5_modules.script_paths import auto_assets_dir


_BIN_RX = re.compile(r"^(?P<h>\d+)(?:[_\.].*)?\.bin$", re.IGNORECASE)


def _u32(n: int) -> int:
    return int(n) & 0xFFFFFFFF


def _parse_archetype_hash_from_entity(ent: dict) -> Optional[int]:
    """
    Entity JSONL schema is produced by our extraction pipeline and commonly includes:
      - archetype_hash: int (preferred)
      - archetype: str (often decimal digits)
      - archetype_raw: str (name)
    """
    if not isinstance(ent, dict):
        return None
    # Preferred: explicit numeric hash.
    ah = ent.get("archetype_hash")
    if ah is not None:
        try:
            return _u32(int(ah))
        except Exception:
            pass
    # Next: archetype field (often decimal digits string).
    a = ent.get("archetype")
    if a is not None:
        s = str(a).strip()
        if s:
            if s.isdigit():
                try:
                    return _u32(int(s))
                except Exception:
                    pass
            if s.lower().startswith("0x"):
                try:
                    return _u32(int(s, 16))
                except Exception:
                    pass
            # Sometimes 'archetype' is a name.
            try:
                return _u32(int(_joaat(s.lower())))
            except Exception:
                pass
    # Last: archetype_raw is a name.
    ar = ent.get("archetype_raw")
    if ar is not None:
        s = str(ar).strip()
        if s:
            try:
                return _u32(int(_joaat(s.lower())))
            except Exception:
                pass
    return None


def _iter_chunk_files(assets_dir: Path) -> list[Path]:
    idx_path = assets_dir / "entities_index.json"
    if idx_path.exists():
        try:
            idx = json.loads(idx_path.read_text(encoding="utf-8", errors="ignore"))
        except Exception:
            idx = None
        chunks = idx.get("chunks") if isinstance(idx, dict) else None
        if isinstance(chunks, dict) and chunks:
            out = []
            chunks_dir = assets_dir / str(idx.get("chunks_dir") or "entities_chunks")
            for meta in chunks.values():
                if not isinstance(meta, dict):
                    continue
                fn = str(meta.get("file") or "").strip()
                if not fn:
                    continue
                p = chunks_dir / fn
                if p.exists():
                    out.append(p)
            if out:
                return out
    # Fallback: list directory.
    chunks_dir = assets_dir / "entities_chunks"
    if not chunks_dir.exists():
        return []
    return sorted(chunks_dir.glob("*.jsonl"))


def scan_used_archetypes(assets_dir: Path, *, max_chunks: int = 0) -> Counter[int]:
    files = _iter_chunk_files(assets_dir)
    if max_chunks and max_chunks > 0:
        files = files[: int(max_chunks)]
    counts: Counter[int] = Counter()
    mlo_instance_refs = 0
    bad_lines = 0
    for p in files:
        try:
            with p.open("r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    s = line.strip()
                    if not s:
                        continue
                    try:
                        ent = json.loads(s)
                    except Exception:
                        bad_lines += 1
                        continue
                    # MLO instance archetypes generally do NOT have direct drawables (they are interior containers).
                    # The viewer handles interiors separately, so exclude them from "missing mesh" accounting.
                    if bool(ent.get("is_mlo_instance")):
                        mlo_instance_refs += 1
                        continue
                    h = _parse_archetype_hash_from_entity(ent)
                    if h is not None and h != 0:
                        counts[h] += 1
        except Exception:
            continue
    if bad_lines:
        print(f"[scan] warning: {bad_lines} JSONL lines failed to parse (ignored).")
    if mlo_instance_refs:
        print(f"[scan] skipped MLO instance refs (is_mlo_instance=true): {mlo_instance_refs}")
    return counts


def scan_exported_mesh_bins(assets_dir: Path) -> set[int]:
    models_dir = assets_dir / "models"
    out: set[int] = set()
    if not models_dir.exists():
        return out
    try:
        with os.scandir(models_dir) as it:
            for e in it:
                if not e.is_file():
                    continue
                nm = e.name
                if not nm.lower().endswith(".bin"):
                    continue
                m = _BIN_RX.match(nm)
                if not m:
                    continue
                try:
                    out.add(_u32(int(m.group("h"))))
                except Exception:
                    continue
    except Exception:
        pass
    return out


def write_hash_list(path: Path, hashes: list[int], counts: Counter[int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    for h in hashes:
        # Keep this file machine-friendly: one token per line (the exporter accepts hash or name).
        # Counts are still available in the JSON report.
        lines.append(f"{int(h)}")
    path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def run_targeted_export(
    *,
    repo_root: Path,
    game_path: str,
    assets_dir: Path,
    hashes_file: Path,
    selected_dlc: str,
    export_textures: bool,
    write_report: bool,
) -> int:
    exporter = repo_root / "export_drawables_for_chunk.py"
    cmd = [
        sys.executable,
        str(exporter),
        "--game-path",
        str(game_path),
        "--assets-dir",
        str(assets_dir),
        "--selected-dlc",
        str(selected_dlc),
        "--hashes-file",
        str(hashes_file),
        "--skip-existing",
    ]
    if export_textures:
        cmd.append("--export-textures")
    if write_report:
        cmd.append("--write-report")
    print(f"[run] {' '.join(cmd)}")
    try:
        return int(subprocess.call(cmd))
    except Exception:
        return 1


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-path", default=os.getenv("gta_location", ""), help="GTA5 install folder (or set gta_location)")
    ap.add_argument("--assets-dir", default="", help="webgl_viewer/assets folder (auto if omitted)")
    ap.add_argument("--max-chunks", type=int, default=0, help="Limit number of chunks scanned (0 = all)")
    ap.add_argument("--min-count", type=int, default=1, help="Only export archetypes with at least this many instances")
    ap.add_argument("--max-hashes", type=int, default=0, help="Cap number of missing hashes exported (0 = all)")
    ap.add_argument("--selected-dlc", default="all", help="First-pass CodeWalker DLC level (default: all)")
    ap.add_argument("--also-patchday27ng", action="store_true", help="Run a second pass with --selected-dlc patchday27ng")
    ap.add_argument("--export-textures", action="store_true", help="Also export textures during targeted export (slower)")
    ap.add_argument("--run-export", action="store_true", help="Actually run the exporter. Without this flag, only scan/report.")
    ap.add_argument("--write-report", action="store_true", help="Pass --write-report to the exporter.")
    args = ap.parse_args()

    game_path = str(args.game_path or "").strip().strip('"').strip("'")
    if not game_path:
        raise SystemExit("Missing --game-path (or gta_location env var)")

    assets_dir = auto_assets_dir(args.assets_dir)
    repo_root = (Path(__file__).resolve().parents[2])  # .../webgl-gta

    print(f"[scan] assets_dir={assets_dir}")
    used = scan_used_archetypes(assets_dir, max_chunks=int(args.max_chunks or 0))
    print(f"[scan] entities with archetype hashes: unique={len(used)} totalRefs={sum(used.values())}")

    exported = scan_exported_mesh_bins(assets_dir)
    print(f"[scan] exported mesh bins: unique={len(exported)}")

    missing = [h for h in used.keys() if h not in exported]
    missing.sort(key=lambda h: (-int(used[h]), int(h)))

    min_count = max(1, int(args.min_count or 1))
    if min_count > 1:
        missing = [h for h in missing if int(used[h]) >= min_count]

    if args.max_hashes and int(args.max_hashes) > 0:
        missing = missing[: int(args.max_hashes)]

    out_hashes = assets_dir / "models" / "targeted_missing_mesh_hashes.txt"
    write_hash_list(out_hashes, missing, used)
    # Keep both numbers: total missing in the world vs this batch cap.
    total_missing = len([h for h in used.keys() if h not in exported])
    print(f"[scan] missing mesh hashes: total={total_missing} batch={len(missing)} (wrote {out_hashes})")

    # Small JSON report for quick inspection.
    rep = {
        "assets_dir": str(assets_dir),
        "unique_used_archetypes": len(used),
        "unique_exported_bins": len(exported),
        "missing_mesh_archetypes": len(missing),
        "min_count": min_count,
        "max_hashes": int(args.max_hashes or 0),
        "top_missing": [{"hash": int(h), "count": int(used[h])} for h in missing[:200]],
    }
    rep_path = assets_dir / "models" / "targeted_missing_mesh_report.json"
    rep_path.write_text(json.dumps(rep, indent=2), encoding="utf-8")
    print(f"[scan] wrote report {rep_path}")

    if not args.run_export:
        print("[scan] --run-export not set; stopping after report.")
        return

    if not missing:
        print("[run] no missing hashes to export.")
        return

    # Pass 1: requested DLC level (typically 'all')
    rc1 = run_targeted_export(
        repo_root=repo_root,
        game_path=game_path,
        assets_dir=assets_dir,
        hashes_file=out_hashes,
        selected_dlc=str(args.selected_dlc or "all"),
        export_textures=bool(args.export_textures),
        write_report=bool(args.write_report),
    )
    print(f"[run] pass1 exit={rc1}")

    # Refresh exported set and compute remaining missing (cheap, avoids rescanning chunk jsonl).
    exported2 = scan_exported_mesh_bins(assets_dir)
    remaining_all = [h for h in used.keys() if h not in exported2]
    remaining = list(remaining_all)
    remaining.sort(key=lambda h: (-int(used[h]), int(h)))
    if min_count > 1:
        remaining = [h for h in remaining if int(used[h]) >= min_count]
    if args.max_hashes and int(args.max_hashes) > 0:
        remaining = remaining[: int(args.max_hashes)]
    print(f"[run] remaining missing after pass1: total={len(remaining_all)} batch={len(remaining)}")

    if args.also_patchday27ng and remaining:
        out_hashes2 = assets_dir / "models" / "targeted_missing_mesh_hashes_patchday27ng.txt"
        write_hash_list(out_hashes2, remaining, used)
        rc2 = run_targeted_export(
            repo_root=repo_root,
            game_path=game_path,
            assets_dir=assets_dir,
            hashes_file=out_hashes2,
            selected_dlc="patchday27ng",
            export_textures=bool(args.export_textures),
            write_report=bool(args.write_report),
        )
        print(f"[run] pass2(patchday27ng) exit={rc2}")

        exported3 = scan_exported_mesh_bins(assets_dir)
        remaining2_all = [h for h in used.keys() if h not in exported3]
        remaining2 = list(remaining2_all)
        remaining2.sort(key=lambda h: (-int(used[h]), int(h)))
        if min_count > 1:
            remaining2 = [h for h in remaining2 if int(used[h]) >= min_count]
        if args.max_hashes and int(args.max_hashes) > 0:
            remaining2 = remaining2[: int(args.max_hashes)]
        print(f"[run] remaining missing after pass2: total={len(remaining2_all)} batch={len(remaining2)}")


if __name__ == "__main__":
    main()


