"""
Ingest a viewer warning report (from js/warning_collector.js) and produce a patching-oriented list.

Primary use-case:
- Collect missing texture warnings from a real gameplay/viewer session
- Export JSON from the browser
- Run this tool to get a deduped, sorted list of texture hashes/rels
  plus a sanity check against CURRENT indices (base + enabled asset packs)

Usage:
  python3 webgl-gta/webgl_viewer/tools/ingest_viewer_warning_report.py \
    --report /path/to/webglgta_warnings_*.json \
    --assets-dir webgl-gta/webgl_viewer/assets \
    --out webgl-gta/webgl_viewer/tools/out/missing_textures_from_viewer_warnings.json
"""

from __future__ import annotations

import argparse
import glob
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


def _load_json(p: Path) -> Any:
    return json.loads(p.read_text(encoding="utf-8", errors="ignore"))


def _load_byhash_index(p: Path) -> Optional[Dict[str, Any]]:
    if not p.exists():
        return None
    try:
        obj = _load_json(p)
        if isinstance(obj, dict) and isinstance(obj.get("byHash"), dict):
            return obj["byHash"]
        if isinstance(obj, dict):
            return obj
    except Exception:
        return None
    return None


def _get_enabled_packs(assets_dir: Path) -> List[Dict[str, Any]]:
    packs_path = assets_dir / "asset_packs.json"
    if not packs_path.exists():
        return []
    try:
        obj = _load_json(packs_path)
    except Exception:
        return []
    packs0 = []
    if isinstance(obj, dict) and isinstance(obj.get("packs"), list):
        packs0 = obj["packs"]
    elif isinstance(obj, list):
        packs0 = obj
    out = []
    for p in packs0:
        if not isinstance(p, dict):
            continue
        enabled = True if p.get("enabled") is None else bool(p.get("enabled"))
        if not enabled:
            continue
        pid = str(p.get("id") or "").strip()
        root_rel = str(p.get("rootRel") or p.get("root") or "").strip()
        if not pid:
            continue
        if not root_rel:
            root_rel = f"packs/{pid}"
        root_rel = root_rel.lstrip("/").rstrip("/")
        out.append({"id": pid, "rootRel": root_rel, "priority": int(p.get("priority") or 0)})
    out.sort(key=lambda x: (-int(x.get("priority") or 0), str(x.get("id") or "")))
    return out


def _as_int_hash(h: Any) -> Optional[int]:
    try:
        s = str(h).strip()
        if not s:
            return None
        return int(s) & 0xFFFFFFFF
    except Exception:
        return None


def _resolve_report_path(report_arg: str) -> Path:
    """
    Accept:
    - exact file path
    - glob patterns (eg /tmp/webglgta_warnings_*.json)
    - directory (auto-pick newest likely report within)
    """
    raw = str(report_arg or "").strip()
    if not raw:
        raise SystemExit("--report is empty")

    p = Path(raw).expanduser()
    if p.exists() and p.is_file():
        return p.resolve()

    # Directory: search for likely report names inside.
    if p.exists() and p.is_dir():
        patterns = [
            str(p / "webglgta_warnings_*.json"),
            str(p / "unresolved_textures_report*.json"),
            str(p / "missing_textures_from_viewer_warnings*.json"),
            str(p / "*.json"),
        ]
        matches: List[Path] = []
        for pat in patterns:
            for m in glob.glob(pat):
                mp = Path(m)
                if mp.exists() and mp.is_file():
                    matches.append(mp)
        if not matches:
            raise SystemExit(f"report directory has no json files: {p}")
        matches.sort(key=lambda x: (x.stat().st_mtime, str(x)), reverse=True)
        return matches[0].resolve()

    # Globs: if the arg contains glob characters, expand and pick newest.
    if any(ch in raw for ch in ["*", "?", "["]):
        matches = [Path(m) for m in glob.glob(raw)]
        matches = [m for m in matches if m.exists() and m.is_file()]
        if not matches:
            raise SystemExit(
                "report glob matched 0 files. "
                "If you used __WEBGLGTA_WARNING_COLLECTOR.download(), "
                "copy the downloaded JSON onto this machine (or point --report at an existing report under tools/out/). "
                f"glob={raw}"
            )
        matches.sort(key=lambda x: (x.stat().st_mtime, str(x)), reverse=True)
        return matches[0].resolve()

    raise SystemExit(
        "report not found: "
        f"{p}\n"
        "Tip: pass an actual file path, a glob (eg /tmp/webglgta_warnings_*.json), "
        "or a directory containing the report."
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", required=True, help="Browser-exported webglgta_warnings_*.json")
    ap.add_argument(
        "--assets-dir",
        default="",
        help="Viewer assets dir (default: <repo>/webgl_viewer/assets).",
    )
    ap.add_argument("--out", required=True)
    ap.add_argument("--type", default="texture_index_missing", help="Warning type filter (warning-report inputs only)")
    ap.add_argument("--index", default="BASE", help="Index filter (warning-report inputs only)")
    args = ap.parse_args()

    report_path = _resolve_report_path(str(args.report))

    repo_root = Path(__file__).resolve().parents[2]
    webgl_viewer_dir = repo_root / "webgl_viewer"
    assets_dir = Path(args.assets_dir).resolve() if args.assets_dir else (webgl_viewer_dir / "assets")

    rep = _load_json(report_path)
    # Supported inputs:
    # 1) Warning report from js/warning_collector.js: { warnings: [...] }
    # 2) Unresolved report (already deduped): [ { requestedRel, useCount, texHash, ... }, ... ]
    warnings: Optional[List[Any]] = None
    unresolved_list: Optional[List[Any]] = None
    if isinstance(rep, dict) and isinstance(rep.get("warnings"), list):
        warnings = rep["warnings"]
    elif isinstance(rep, list):
        unresolved_list = rep
    else:
        raise SystemExit(
            "Unsupported report JSON format.\n"
            "- Expected {warnings:[...]} from __WEBGLGTA_WARNING_COLLECTOR.download()\n"
            "- Or a list like unresolved_textures_report*.json"
        )

    base_index_path = assets_dir / "models_textures" / "index.json"
    base_byhash = _load_byhash_index(base_index_path) or {}

    packs = _get_enabled_packs(assets_dir)
    pack_indices: List[Tuple[str, Path, Dict[str, Any]]] = []
    for p in packs:
        pid = str(p["id"])
        root_rel = str(p["rootRel"])
        idx_path = assets_dir / root_rel / "models_textures" / "index.json"
        byhash = _load_byhash_index(idx_path)
        if byhash:
            pack_indices.append((pid, idx_path, byhash))

    out_rows: List[Dict[str, Any]] = []
    if warnings is not None:
        for w in warnings:
            if not isinstance(w, dict):
                continue
            if str(w.get("type") or "") != str(args.type):
                continue
            if str(w.get("index") or "") != str(args.index):
                continue
            h_int = _as_int_hash(w.get("hash"))
            if h_int is None:
                continue
            h_key = str(h_int)
            rel = str(w.get("rel") or "").strip() or None
            count = int(w.get("count") or 0)

            base_has = h_key in base_byhash
            pack_hits = []
            for (pid, idx_path, byhash) in pack_indices:
                if h_key in byhash:
                    pack_hits.append({"packId": pid, "indexPath": str(idx_path)})

            status = "missing_in_all_indices"
            if base_has:
                status = "present_in_base_index"
            elif pack_hits:
                status = "present_in_pack_index"

            out_rows.append(
                {
                    "hash": h_int,
                    "hashStr": h_key,
                    "rel": rel,
                    "count": count,
                    "firstSeenTs": int(w.get("firstSeenTs") or 0),
                    "lastSeenTs": int(w.get("lastSeenTs") or 0),
                    "mode": w.get("mode"),
                    "gate": w.get("gate"),
                    "status": status,
                    "baseIndexPath": str(base_index_path),
                    "baseIndexHas": bool(base_has),
                    "packIndexHits": pack_hits,
                    "key": w.get("key"),
                }
            )
    else:
        assert unresolved_list is not None
        for r in unresolved_list:
            if not isinstance(r, dict):
                continue
            # Normalize fields from unresolved_textures_report*.json
            h_int = _as_int_hash(r.get("texHash") if r.get("texHash") is not None else r.get("hash"))
            if h_int is None:
                continue
            h_key = str(h_int)
            rel = str(r.get("requestedRel") or r.get("rel") or "").strip() or None
            count = int(r.get("useCount") if r.get("useCount") is not None else (r.get("count") or 0))

            base_has = h_key in base_byhash
            pack_hits = []
            for (pid, idx_path, byhash) in pack_indices:
                if h_key in byhash:
                    pack_hits.append({"packId": pid, "indexPath": str(idx_path)})

            status = "missing_in_all_indices"
            if base_has:
                status = "present_in_base_index"
            elif pack_hits:
                status = "present_in_pack_index"

            out_rows.append(
                {
                    "hash": h_int,
                    "hashStr": h_key,
                    "rel": rel,
                    "count": count,
                    "firstSeenTs": 0,
                    "lastSeenTs": 0,
                    "mode": None,
                    "gate": None,
                    "status": status,
                    "baseIndexPath": str(base_index_path),
                    "baseIndexHas": bool(base_has),
                    "packIndexHits": pack_hits,
                    "key": None,
                }
            )

    out_rows.sort(key=lambda r: (-int(r.get("count") or 0), str(r.get("rel") or ""), int(r.get("hash") or 0)))

    out_obj = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "inputReport": str(report_path),
        "assetsDir": str(assets_dir),
        "filters": {"type": str(args.type), "index": str(args.index)},
        "stats": {
            "totalWarningsInReport": len(warnings) if warnings is not None else None,
            "totalRowsInListReport": len(unresolved_list) if unresolved_list is not None else None,
            "matchedWarnings": len(out_rows),
            "enabledPacks": len(packs),
            "packsWithIndexLoaded": len(pack_indices),
        },
        "missingTextures": out_rows,
    }

    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out_obj, indent=2), encoding="utf-8")
    print(f"wrote {out_path} rows={len(out_rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


