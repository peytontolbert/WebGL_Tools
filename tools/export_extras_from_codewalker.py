#!/usr/bin/env python3
"""
Export "extra" GTA datasets from CodeWalker.Core that our main mesh/entity exporters don't cover yet.
Intended output is under `webgl-gta/output/` so it can be staged into `webgl_viewer/assets/` via setup scripts.
Current exports:
  - YND (node graph)        -> output/nav/ynd/{index.json, tiles/*.json}
  - YNV (navmesh) index     -> output/nav/ynv/index.json (metadata only; full mesh export is large)
  - Distant lights (.dat)   -> output/lights/distant_lights/index.json + per-file JSON
  - GXT2 strings            -> output/strings/gxt2_{lang}/index.json (hash->text map)

Notes:
  - This script is best-effort and defensive: it will skip files that fail to parse.
  - For huge datasets, prefer exporting indices first, then add targeted extraction later.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _to_u32(x: Any, default: int = 0) -> int:
    if x is None:
        return int(default) & 0xFFFFFFFF
    # MetaHash-like structs often expose `.Hash`.
    try:
        if hasattr(x, "Hash"):
            return int(getattr(x, "Hash")) & 0xFFFFFFFF
    except Exception:
        pass
    try:
        return int(x) & 0xFFFFFFFF
    except Exception:
        pass
    try:
        s = str(x).strip()
        if s.isdigit():
            return int(s) & 0xFFFFFFFF
    except Exception:
        pass
    return int(default) & 0xFFFFFFFF


def _v3(v: Any) -> Tuple[float, float, float]:
    if v is None:
        return (0.0, 0.0, 0.0)
    return (float(getattr(v, "X", 0.0)), float(getattr(v, "Y", 0.0)), float(getattr(v, "Z", 0.0)))


def _iter_dotnet_list(x: Any) -> List[Any]:
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


def _iter_all_file_entries(rpfman: Any) -> Iterable[Any]:
    """
    Iterate all RpfFileEntry-like objects across all RPFS.
    """
    rpfs = _iter_dotnet_list(getattr(rpfman, "AllRpfs", None))
    for rpf in rpfs:
        entries = getattr(rpf, "AllEntries", None)
        if entries is None:
            continue
        for e in _iter_dotnet_list(entries):
            # We only want file entries (not directories).
            name_lower = str(getattr(e, "NameLower", "") or "")
            if not name_lower:
                continue
            yield e


def _write_json_atomic(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def _export_ynd(
    *,
    out_dir: Path,
    rpfman: Any,
    YndFile: Any,
    max_files: int = 0,
    index_only: bool = False,
) -> Dict[str, Any]:
    """
    Export .ynd (traffic/ped node graphs) into per-file JSON.
    """
    base = out_dir / "nav" / "ynd"
    tiles_dir = base / "tiles"
    tiles_dir.mkdir(parents=True, exist_ok=True)

    found: List[Any] = []
    for e in _iter_all_file_entries(rpfman):
        nl = str(getattr(e, "NameLower", "") or "")
        if nl.endswith(".ynd"):
            found.append(e)

    # Deterministic order: by virtual path
    found.sort(key=lambda x: str(getattr(x, "Path", "") or ""))
    if max_files and max_files > 0:
        found = found[: int(max_files)]

    idx_rows: List[Dict[str, Any]] = []
    ok = 0
    failed = 0

    for i, entry in enumerate(found):
        try:
            path = str(getattr(entry, "Path", "") or "")
            name = str(getattr(entry, "Name", "") or "")
            name_lower = str(getattr(entry, "NameLower", "") or "")
            short_hash = int(getattr(entry, "ShortNameHash", 0) or 0) & 0xFFFFFFFF
            size = int(getattr(entry, "FileSize", 0) or 0)

            if index_only:
                idx_rows.append(
                    {
                        "shortNameHash": str(short_hash),
                        "file": None,
                        "sourcePath": path,
                        "fileSize": int(size),
                        "nodeCount": None,
                        "linkCount": None,
                    }
                )
                ok += 1
                continue

            data = rpfman.GetFileData(path)
            if not data:
                raise RuntimeError("GetFileData returned empty")

            ynd = YndFile(entry)
            ynd.Load(data, entry)

            nodes = _iter_dotnet_list(getattr(ynd, "Nodes", None))
            nd = getattr(ynd, "NodeDictionary", None)
            raw_links = _iter_dotnet_list(getattr(nd, "Links", None)) if nd is not None else []
            nodes_out: List[Dict[str, Any]] = []

            min_x = min_y = min_z = float("inf")
            max_x = max_y = max_z = float("-inf")

            for n in nodes:
                pos = _v3(getattr(n, "Position", None))
                min_x, min_y, min_z = min(min_x, pos[0]), min(min_y, pos[1]), min(min_z, pos[2])
                max_x, max_y, max_z = max(max_x, pos[0]), max(max_y, pos[1]), max(max_z, pos[2])

                nodes_out.append(
                    {
                        "areaId": int(getattr(n, "AreaID", 0) or 0),
                        "nodeId": int(getattr(n, "NodeID", 0) or 0),
                        "pos": [pos[0], pos[1], pos[2]],
                        "flags0": int(getattr(getattr(n, "Flags0", 0), "Value", getattr(n, "Flags0", 0)) or 0),
                        "flags1": int(getattr(getattr(n, "Flags1", 0), "Value", getattr(n, "Flags1", 0)) or 0),
                        "flags2": int(getattr(getattr(n, "Flags2", 0), "Value", getattr(n, "Flags2", 0)) or 0),
                        "flags3": int(getattr(getattr(n, "Flags3", 0), "Value", getattr(n, "Flags3", 0)) or 0),
                        "flags4": int(getattr(getattr(n, "Flags4", 0), "Value", getattr(n, "Flags4", 0)) or 0),
                        "linkCount": int(getattr(n, "LinkCount", 0) or 0),
                        "linkCountUnk": int(getattr(n, "LinkCountUnk", 0) or 0),
                        "speed": int(getattr(n, "Speed", 0) or 0),
                        "special": int(getattr(n, "Special", 0) or 0),
                        "isPedNode": bool(getattr(n, "IsPedNode", False)),
                        "streetNameHash": _to_u32(getattr(n, "StreetName", None), 0),
                        "linkId": int(getattr(n, "LinkID", 0) or 0),
                    }
                )

            # Links are NOT populated on YndFile.Load() in CodeWalker; the editor populates them via World.Space.
            # However, the underlying NodeDictionary contains the raw link list + per-node link ranges (LinkID/LinkCount).
            # Export directed edges from NodeDictionary so downstream tools can build traffic/ped graphs.
            links_out: List[Dict[str, Any]] = []
            if raw_links and nodes:
                for n in nodes:
                    n_area = int(getattr(n, "AreaID", 0) or 0)
                    n_id = int(getattr(n, "NodeID", 0) or 0)
                    link_id = int(getattr(n, "LinkID", 0) or 0)
                    link_count = int(getattr(n, "LinkCount", 0) or 0)
                    if link_count <= 0:
                        continue
                    for li in range(link_id, min(link_id + link_count, len(raw_links))):
                        lk = raw_links[li]
                        # NodeLink fields: AreaID/NodeID target + flags bytes + link length.
                        t_area = int(getattr(lk, "AreaID", 0) or 0)
                        t_id = int(getattr(lk, "NodeID", 0) or 0)
                        f0 = int(getattr(getattr(lk, "Flags0", 0), "Value", getattr(lk, "Flags0", 0)) or 0)
                        f1 = int(getattr(getattr(lk, "Flags1", 0), "Value", getattr(lk, "Flags1", 0)) or 0)
                        f2 = int(getattr(getattr(lk, "Flags2", 0), "Value", getattr(lk, "Flags2", 0)) or 0)
                        ll = int(getattr(getattr(lk, "LinkLength", 0), "Value", getattr(lk, "LinkLength", 0)) or 0)
                        links_out.append(
                            {
                                "a": {"areaId": n_area, "nodeId": n_id},
                                "b": {"areaId": t_area, "nodeId": t_id},
                                "flags0": f0,
                                "flags1": f1,
                                "flags2": f2,
                                "len": ll,
                                # Keep raw lane encoding for later decoding (CodeWalker computes lanes from flags2 bits).
                            }
                        )

            bounds = None
            if nodes_out:
                bounds = {"min": [min_x, min_y, min_z], "max": [max_x, max_y, max_z]}

            payload = {
                "schema": "webglgta-ynd-v1",
                "sourcePath": path,
                "name": name,
                "nameLower": name_lower,
                "shortNameHash": str(short_hash),
                "fileSize": int(size),
                "bounds": bounds,
                "nodeCount": len(nodes_out),
                "linkCount": len(links_out),
                "nodes": nodes_out,
                "links": links_out,
            }

            out_path = tiles_dir / f"{short_hash}.json"
            _write_json_atomic(out_path, payload)
            idx_rows.append(
                {
                    "shortNameHash": str(short_hash),
                    "file": str(out_path.relative_to(out_dir)),
                    "sourcePath": path,
                    "fileSize": int(size),
                    "nodeCount": int(payload["nodeCount"]),
                    "linkCount": int(payload["linkCount"]),
                }
            )
            ok += 1
        except Exception:
            failed += 1
            continue

        if (i + 1) % 50 == 0:
            print(f"[ynd] {i+1}/{len(found)} ok={ok} failed={failed}")

    index = {
        "schema": "webglgta-ynd-index-v1",
        "generatedAtUnix": int(time.time()),
        "countTotal": int(len(found)),
        "countOk": int(ok),
        "countFailed": int(failed),
        "tilesDir": "nav/ynd/tiles",
        "indexOnly": bool(index_only),
        "rows": idx_rows,
    }
    _write_json_atomic(base / "index.json", index)
    return index


def _export_ynv_index(*, out_dir: Path, gfc: Any) -> Dict[str, Any]:
    """
    Export a lightweight index of YNV navmesh entries (no heavy geometry extraction).
    """
    base = out_dir / "nav" / "ynv"
    base.mkdir(parents=True, exist_ok=True)

    d = getattr(gfc, "YnvDict", None)
    entries = []
    try:
        # Dictionary<uint,RpfFileEntry> is iterable in pythonnet as KeyValuePair.
        for kv in list(d) if d is not None else []:
            e = getattr(kv, "Value", None)
            if e is None:
                continue
            entries.append(e)
    except Exception:
        # Fallback to Values
        try:
            vals = getattr(d, "Values", None)
            if vals is not None:
                entries = list(vals)
        except Exception:
            entries = []

    rows: List[Dict[str, Any]] = []
    for e in entries:
        path = str(getattr(e, "Path", "") or "")
        short_hash = int(getattr(e, "ShortNameHash", 0) or 0) & 0xFFFFFFFF
        rows.append(
            {
                "shortNameHash": str(short_hash),
                "sourcePath": path,
                "name": str(getattr(e, "Name", "") or ""),
                "fileSize": int(getattr(e, "FileSize", 0) or 0),
            }
        )
    rows.sort(key=lambda r: (r.get("sourcePath") or ""))

    index = {
        "schema": "webglgta-ynv-index-v1",
        "generatedAtUnix": int(time.time()),
        "count": int(len(rows)),
        "rows": rows,
    }
    _write_json_atomic(base / "index.json", index)
    return index


def _export_distant_lights(*, out_dir: Path, rpfman: Any, DistantLightsFile: Any) -> Dict[str, Any]:
    """
    Export distant lights files (usually in .dat) as JSON.
    """
    base = out_dir / "lights" / "distant_lights"
    files_dir = base / "files"
    files_dir.mkdir(parents=True, exist_ok=True)

    # Find candidates by filename. GTA has multiple; we'll export any match.
    found: List[Any] = []
    for e in _iter_all_file_entries(rpfman):
        nl = str(getattr(e, "NameLower", "") or "")
        if nl.endswith(".dat") and ("distant" in nl) and ("light" in nl):
            found.append(e)
    found.sort(key=lambda x: str(getattr(x, "Path", "") or ""))

    rows: List[Dict[str, Any]] = []
    ok = 0
    failed = 0
    for entry in found:
        try:
            path = str(getattr(entry, "Path", "") or "")
            name = str(getattr(entry, "Name", "") or "")
            short_hash = int(getattr(entry, "ShortNameHash", 0) or 0) & 0xFFFFFFFF
            size = int(getattr(entry, "FileSize", 0) or 0)

            data = rpfman.GetFileData(path)
            if not data:
                raise RuntimeError("GetFileData returned empty")

            dl = DistantLightsFile(entry)
            dl.Load(data, entry)

            # Export cells with their path ranges, and basic path/node info.
            paths = _iter_dotnet_list(getattr(dl, "Paths", None))
            paths_out: List[Dict[str, Any]] = []
            for p in paths:
                paths_out.append(
                    {
                        "centerX": int(getattr(p, "CenterX", 0) or 0),
                        "centerY": int(getattr(p, "CenterY", 0) or 0),
                        "sizeX": int(getattr(p, "SizeX", 0) or 0),
                        "sizeY": int(getattr(p, "SizeY", 0) or 0),
                        "nodeIndex": int(getattr(p, "NodeIndex", 0) or 0),
                        "nodeCount": int(getattr(p, "NodeCount", 0) or 0),
                        "short7": int(getattr(p, "Short7", 0) or 0),
                        "short8": int(getattr(p, "Short8", 0) or 0),
                        "float1": float(getattr(p, "Float1", 0.0) or 0.0),
                        "b1": int(getattr(p, "Byte1", 0) or 0),
                        "b2": int(getattr(p, "Byte2", 0) or 0),
                        "b3": int(getattr(p, "Byte3", 0) or 0),
                        "b4": int(getattr(p, "Byte4", 0) or 0),
                    }
                )

            nodes = _iter_dotnet_list(getattr(dl, "Nodes", None))
            nodes_out: List[List[int]] = []
            for n in nodes:
                nodes_out.append([int(getattr(n, "X", 0) or 0), int(getattr(n, "Y", 0) or 0), int(getattr(n, "Z", 0) or 0)])

            payload = {
                "schema": "webglgta-distant-lights-v1",
                "sourcePath": path,
                "name": name,
                "shortNameHash": str(short_hash),
                "fileSize": int(size),
                "hd": bool(getattr(dl, "HD", True)),
                "gridSize": int(getattr(dl, "GridSize", 0) or 0),
                "cellSize": int(getattr(dl, "CellSize", 0) or 0),
                "nodeCount": int(getattr(dl, "NodeCount", 0) or 0),
                "pathCount": int(getattr(dl, "PathCount", 0) or 0),
                "nodes": nodes_out,
                "paths": paths_out,
            }
            out_path = files_dir / f"{short_hash}.json"
            _write_json_atomic(out_path, payload)
            rows.append(
                {
                    "shortNameHash": str(short_hash),
                    "file": str(out_path.relative_to(out_dir)),
                    "sourcePath": path,
                    "fileSize": int(size),
                    "nodeCount": int(payload["nodeCount"]),
                    "pathCount": int(payload["pathCount"]),
                    "hd": bool(payload["hd"]),
                }
            )
            ok += 1
        except Exception:
            failed += 1
            continue

    index = {
        "schema": "webglgta-distant-lights-index-v1",
        "generatedAtUnix": int(time.time()),
        "countTotal": int(len(found)),
        "countOk": int(ok),
        "countFailed": int(failed),
        "rows": rows,
    }
    _write_json_atomic(base / "index.json", index)
    return index


def _export_gxt2(*, out_dir: Path, gfc: Any, rpfman: Any, Gxt2File: Any, lang: str) -> Dict[str, Any]:
    """
    Export a combined hash->text map from all GXT2 files in GameFileCache.Gxt2Dict.
    """
    base = out_dir / "strings" / f"gxt2_{lang}"
    base.mkdir(parents=True, exist_ok=True)

    d = getattr(gfc, "Gxt2Dict", None)
    entries: List[Any] = []
    try:
        for kv in list(d) if d is not None else []:
            e = getattr(kv, "Value", None)
            if e is not None:
                entries.append(e)
    except Exception:
        try:
            vals = getattr(d, "Values", None)
            if vals is not None:
                entries = list(vals)
        except Exception:
            entries = []

    # Deterministic order: path (so later entries override earlier consistently)
    entries.sort(key=lambda e: str(getattr(e, "Path", "") or ""))

    by_hash: Dict[str, str] = {}
    files_out: List[Dict[str, Any]] = []
    ok = 0
    failed = 0

    for e in entries:
        try:
            path = str(getattr(e, "Path", "") or "")
            name = str(getattr(e, "Name", "") or "")
            short_hash = int(getattr(e, "ShortNameHash", 0) or 0) & 0xFFFFFFFF
            size = int(getattr(e, "FileSize", 0) or 0)

            data = rpfman.GetFileData(path)
            if not data:
                raise RuntimeError("GetFileData returned empty")

            gf = Gxt2File()
            gf.Load(data, e)
            text_entries = _iter_dotnet_list(getattr(gf, "TextEntries", None))
            n_added = 0
            for te in text_entries:
                h = _to_u32(getattr(te, "Hash", None), 0)
                t = str(getattr(te, "Text", "") or "")
                if h == 0 or not t:
                    continue
                by_hash[str(h)] = t
                n_added += 1
            files_out.append(
                {
                    "shortNameHash": str(short_hash),
                    "sourcePath": path,
                    "name": name,
                    "fileSize": int(size),
                    "entries": int(n_added),
                }
            )
            ok += 1
        except Exception:
            failed += 1
            continue

    out = {
        "schema": "webglgta-gxt2-index-v1",
        "generatedAtUnix": int(time.time()),
        "lang": str(lang),
        "filesTotal": int(len(entries)),
        "filesOk": int(ok),
        "filesFailed": int(failed),
        "stringsCount": int(len(by_hash)),
        "files": files_out,
        "byHash": by_hash,
    }
    _write_json_atomic(base / "index.json", out)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gta-path", required=True)
    ap.add_argument("--selected-dlc", default="all")
    ap.add_argument("--out-dir", default="", help="Defaults to repo_root/output")
    ap.add_argument("--max-ynd", type=int, default=0, help="Limit number of .ynd files to export (0=all)")
    ap.add_argument("--ynd-index-only", action="store_true", help="Only write nav/ynd/index.json (no tiles).")
    ap.add_argument("--lang", default="en", help="Label for output folder only; CodeWalker language selection is internal.")
    ap.add_argument("--no-ynd", action="store_true")
    ap.add_argument("--no-ynv-index", action="store_true")
    ap.add_argument("--no-distant-lights", action="store_true")
    ap.add_argument("--no-gxt2", action="store_true")
    args = ap.parse_args()

    repo_root = _repo_root()
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    from gta5_modules.dll_manager import DllManager  # noqa

    out_dir = Path(args.out_dir) if args.out_dir else (repo_root / "output")
    out_dir = out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

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

    rpfman = getattr(gfc, "RpfMan", None)
    if rpfman is None or not getattr(rpfman, "IsInited", False):
        raise SystemExit("RpfManager not inited.")

    # IMPORTANT: only import CodeWalker types *after* DllManager has loaded assemblies via pythonnet.
    # Many environments won't have `CodeWalker` importable until clr.AddReference(...) runs.
    YndFile = getattr(dm, "YndFile", None)
    if YndFile is None:
        # Fallback: import from CodeWalker if DllManager didn't expose it (should be rare).
        from CodeWalker.GameFiles import YndFile as _YndFile  # type: ignore
        YndFile = _YndFile

    # Optional file types (not always present in DllManager's initial import list).
    DistantLightsFile = None
    Gxt2File = None
    try:
        from CodeWalker.GameFiles import DistantLightsFile as _DistantLightsFile  # type: ignore
        DistantLightsFile = _DistantLightsFile
    except Exception:
        DistantLightsFile = None
    try:
        from CodeWalker.GameFiles import Gxt2File as _Gxt2File  # type: ignore
        Gxt2File = _Gxt2File
    except Exception:
        Gxt2File = None

    summary: Dict[str, Any] = {
        "schema": "webglgta-extras-export-v1",
        "generatedAtUnix": int(time.time()),
        "selectedDlc": str(args.selected_dlc),
        "outDir": str(out_dir),
        "exports": {},
    }

    if not args.no_ynd:
        print("[extras] Exporting YND (node graph)...")
        summary["exports"]["ynd"] = _export_ynd(
            out_dir=out_dir,
            rpfman=rpfman,
            YndFile=YndFile,
            max_files=int(args.max_ynd or 0),
            index_only=bool(args.ynd_index_only),
        )
    if not args.no_ynv_index:
        print("[extras] Exporting YNV index (navmesh metadata)...")
        summary["exports"]["ynvIndex"] = _export_ynv_index(out_dir=out_dir, gfc=gfc)
    if not args.no_distant_lights:
        if DistantLightsFile is None:
            print("[extras] Skipping DistantLights export (CodeWalker.GameFiles.DistantLightsFile not importable).")
        else:
            print("[extras] Exporting DistantLights (.dat)...")
            summary["exports"]["distantLights"] = _export_distant_lights(out_dir=out_dir, rpfman=rpfman, DistantLightsFile=DistantLightsFile)
    if not args.no_gxt2:
        if Gxt2File is None:
            print("[extras] Skipping GXT2 export (CodeWalker.GameFiles.Gxt2File not importable).")
        else:
            print("[extras] Exporting GXT2 strings (hash->text)...")
            summary["exports"]["gxt2"] = _export_gxt2(out_dir=out_dir, gfc=gfc, rpfman=rpfman, Gxt2File=Gxt2File, lang=str(args.lang))

    _write_json_atomic(out_dir / "extras_export_report.json", summary)
    print(f"[extras] Wrote {out_dir / 'extras_export_report.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


