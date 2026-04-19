#!/usr/bin/env python3
"""Export an Assetto Corsa track KN5 into a SceneTool-loadable GLB + scenario JSON.

This is a geometry-first exporter:
- Converts the track's main *.kn5 into OBJ (baking node transforms) using `assetto_corsa_kn5_to_obj.py`
- Converts OBJ -> GLB using `tools/obj_to_glb.mjs` (Node + Three.js, no Blender dependency)
- Writes a SceneTool scenario snapshot JSON that points at the exported GLB

Texture embedding is currently best-effort (OBJ->GLB converter does not import textures).
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

from assetto_corsa_kn5_to_obj import export_kn5_to_obj


UTC = getattr(dt, "UTC", dt.timezone.utc)

LUT_REF_RE = re.compile(r"([A-Za-z0-9_\-./\\]+\.lut)\b", re.IGNORECASE)

AI_LINE_HEADER_SIZE = 4 * 4  # 4x int32
AI_LINE_POINT_SIZE = 4 * 4 + 4  # 4x float32 + int32
AI_LINE_DETAIL_SIZE = 4 * 18  # 18x float32


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


def _which(cmd: str) -> str:
    p = shutil.which(cmd)
    return str(p or "").strip()


def _safe_name(s: str) -> str:
    out = "".join(ch if (ch.isalnum() or ch in ("_", "-", ".")) else "_" for ch in str(s or "").strip())
    out = out.strip("._-")
    return out[:120]


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


def _iter_files(root: Path) -> Iterable[Path]:
    for p in sorted(root.rglob("*")):
        if p.is_file():
            yield p


def _copy_tree(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def _parse_bounds_csv(s: str) -> Tuple[float, float, float]:
    parts = [p.strip() for p in str(s or "").split(",") if p.strip()]
    if len(parts) != 3:
        return 0.0, 0.0, 0.0
    try:
        return float(parts[0]), float(parts[1]), float(parts[2])
    except Exception:
        return 0.0, 0.0, 0.0


def _read_i32_le(f) -> int:
    import struct

    b = f.read(4)
    if len(b) != 4:
        raise EOFError("read_i32: truncated")
    return int(struct.unpack("<i", b)[0])


def _read_f32s_le(f, n: int) -> Tuple[float, ...]:
    import struct

    b = f.read(4 * n)
    if len(b) != 4 * n:
        raise EOFError("read_f32s: truncated")
    return tuple(float(x) for x in struct.unpack(f"<{n}f", b))


def _parse_ac_ai_line(ai_path: Path) -> Optional[Dict]:
    """Parse Assetto Corsa `fast_lane.ai` / `pit_lane.ai` (binary) into a JSON-friendly dict.

    Format reference: widely used Blender import scripts read:
    - header: 4 int32 (the second int is point count)
    - points: count * (4 float32 + 1 int32)
    - details: count * (18 float32)  (sometimes missing or truncated; best-effort)

    Coordinate convention:
    We preserve the stored (x, y, z) order as: x = f0, y = f1, z = f2.
    """
    try:
        ai_path = Path(ai_path).resolve()
        if not ai_path.exists() or not ai_path.is_file():
            return None
        st = ai_path.stat()
        if st.st_size < (AI_LINE_HEADER_SIZE + AI_LINE_POINT_SIZE):
            return None

        with ai_path.open("rb") as f:
            h0 = _read_i32_le(f)
            count = _read_i32_le(f)
            u1 = _read_i32_le(f)
            u2 = _read_i32_le(f)
            if count <= 0 or count > 5_000_000:
                return None

            points_raw = []
            import struct

            for i in range(count):
                b = f.read(AI_LINE_POINT_SIZE)
                if len(b) != AI_LINE_POINT_SIZE:
                    break
                # Common importer names these (x, z, y, dist, id). The second float is
                # generally "up" (height). We preserve to (x,y,z) = (f0,f1,f2).
                f0, f1, f2, dist, pid = struct.unpack("<4fi", b)
                points_raw.append((float(f0), float(f1), float(f2), float(dist), int(pid)))

            if len(points_raw) < 2:
                return None

            # Details (optional).
            details = []
            # Some files include extra trailing data; cap reads at available bytes.
            try:
                remaining = ai_path.stat().st_size - (AI_LINE_HEADER_SIZE + len(points_raw) * AI_LINE_POINT_SIZE)
            except Exception:
                remaining = 0
            want = min(len(points_raw), max(0, remaining // AI_LINE_DETAIL_SIZE))
            for _ in range(want):
                try:
                    details.append(_read_f32s_le(f, 18))
                except Exception:
                    break

            # Derive forward direction in XZ plane (used by traffic/autopilot).
            pts = []
            n = len(points_raw)
            for i, (x, y, z, dist, pid) in enumerate(points_raw):
                j = (i + 1) % n
                nx, ny, nz, *_ = points_raw[j]
                dx = float(nx - x)
                dz = float(nz - z)
                l = math.hypot(dx, dz)
                if l < 1e-9:
                    tx, tz = 0.0, -1.0
                else:
                    tx, tz = dx / l, dz / l
                rec = {"x": x, "y": y, "z": z, "dist": dist, "id": pid, "tangent": [tx, tz]}
                # Attach a few commonly useful channels when present.
                if i < len(details):
                    d = details[i]
                    # d[1]=speed, d[2]=gas, d[3]=brake, d[6]=wallLeft, d[7]=wallRight in common scripts.
                    rec["speed"] = float(d[1])
                    rec["gas"] = float(d[2])
                    rec["brake"] = float(d[3])
                    rec["wallLeft"] = float(d[6])
                    rec["wallRight"] = float(d[7])
                pts.append(rec)

            return {
                "schema": "ac.ai_line.v1",
                "source": {"path": ai_path.as_posix()},
                "header": {"h0": int(h0), "count": int(count), "u1": int(u1), "u2": int(u2)},
                "pointCount": int(len(pts)),
                "hasDetails": bool(details),
                "points": pts,
            }
    except Exception:
        return None


def _pick_main_kn5(track_root: Path) -> Optional[Path]:
    kn5s = []
    for p in track_root.glob("*.kn5"):
        if not p.is_file():
            continue
        low = p.name.lower()
        if "collider" in low or "collision" in low:
            continue
        try:
            sz = p.stat().st_size
        except Exception:
            sz = 0
        kn5s.append((sz, p))
    if not kn5s:
        return None
    kn5s.sort(key=lambda t: t[0], reverse=True)
    return kn5s[0][1]


def _export_track_glb(
    *,
    track_root: Path,
    out_dir: Path,
    track_id: str,
    model_kn5: str,
    model_out_name: str,
    keep_materials: Optional[List[str]] = None,
) -> Dict[str, str]:
    kn5_path = Path(model_kn5).expanduser()
    if not kn5_path.is_absolute():
        kn5_path = (track_root / kn5_path).resolve()
    if not kn5_path.exists() or not kn5_path.is_file():
        raise SystemExit(f"Track KN5 not found: {kn5_path}")

    model_dir = out_dir / "model"
    src_dir = model_dir / "src_obj"
    src_dir.mkdir(parents=True, exist_ok=True)

    stem = (model_out_name.strip() or track_id).strip()
    if stem.lower().endswith(".glb"):
        stem = stem[:-4]

    # KN5 -> OBJ (+ embedded textures extracted to src_obj/texture/)
    rec = export_kn5_to_obj(kn5_path=kn5_path, out_dir=src_dir, obj_name=stem)
    obj_path = Path(rec["obj_path"]).resolve()
    mtl_path = Path(rec["mtl_path"]).resolve()

    # OBJ -> GLB
    node = _which("node")
    if not node:
        raise SystemExit("Track export requires node (Node.js). Install node and retry.")
    obj_to_glb = (Path(__file__).resolve().parents[1] / "tools" / "obj_to_glb.mjs").resolve()
    if not obj_to_glb.exists():
        raise SystemExit(f"Missing OBJ->GLB converter: {obj_to_glb}")

    glb_path = (model_dir / f"{stem}.glb").resolve()
    glb_path.parent.mkdir(parents=True, exist_ok=True)

    keep = [str(k).strip().upper() for k in (keep_materials or []) if str(k).strip()]
    keep_arg = ",".join(keep) if keep else ""
    obj_bytes = 0
    try:
        obj_bytes = int(obj_path.stat().st_size)
    except Exception:
        obj_bytes = 0
    prefer_keep = bool(keep_arg) and obj_bytes >= 300_000_000  # avoid Node string limits on very large OBJs

    def _run_convert(use_keep: bool) -> None:
        args = [node, str(obj_to_glb), "--in", str(obj_path), "--out", str(glb_path)]
        if use_keep and keep_arg:
            args += ["--keep-materials", keep_arg]
        subprocess.run(
            args,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    try:
        _run_convert(use_keep=prefer_keep)
    except subprocess.CalledProcessError as e:
        # If full export fails, retry with keep-materials (driveable surfaces) when available.
        if (not prefer_keep) and keep_arg:
            try:
                _run_convert(use_keep=True)
            except subprocess.CalledProcessError as e2:
                err = (e2.stderr or e2.stdout or "").strip()
                raise SystemExit(f"OBJ->GLB converter failed (retry keep-materials): {err or e2}") from e2
        else:
            err = (e.stderr or e.stdout or "").strip()
            raise SystemExit(f"OBJ->GLB converter failed: {err or e}") from e
    if not glb_path.exists() or not glb_path.is_file() or glb_path.stat().st_size < 50_000:
        raise SystemExit(f"Track export failed: GLB not written (or too small): {glb_path}")

    return {
        "kn5_path": kn5_path.as_posix(),
        "obj_path": obj_path.as_posix(),
        "mtl_path": mtl_path.as_posix(),
        "glb_path": glb_path.as_posix(),
        "bounds_min": str(rec.get("bounds_min", "")),
        "bounds_max": str(rec.get("bounds_max", "")),
    }


def _surface_keep_keys_from_entries(entries: List[Dict]) -> List[str]:
    # Surfaces are authored in data/surfaces.ini:
    # [SURFACE_*] KEY=ROAD FRICTION=1.00 IS_VALID_TRACK=1 IS_PITLANE=0 ...
    # For "driveable" optimized ground collider, keep only valid track + pitlane surfaces.
    by_sec: Dict[str, Dict[str, str]] = {}
    for e in entries:
        try:
            file = str(e.get("file") or "").strip().lower()
            if not (file.endswith("surfaces.ini") or file.endswith("/surfaces.ini")):
                continue
            sec = str(e.get("section") or "").strip()
            if not sec:
                continue
            key = str(e.get("key") or "").strip().lower()
            val = str(e.get("value") if ("value" in e) else "").strip()
            if sec not in by_sec:
                by_sec[sec] = {}
            by_sec[sec][key] = val
        except Exception:
            continue
    keep = []
    for sec, kv in by_sec.items():
        k = str(kv.get("key") or "").strip().upper()
        if not k:
            continue
        is_valid = str(kv.get("is_valid_track") or "").strip()
        is_pit = str(kv.get("is_pitlane") or "").strip()
        try:
            valid = int(float(is_valid)) if is_valid else 0
        except Exception:
            valid = 0
        try:
            pit = int(float(is_pit)) if is_pit else 0
        except Exception:
            pit = 0
        if valid == 1 or pit == 1:
            keep.append(k)
    # Reasonable fallbacks.
    if not keep:
        for k in ("ROAD", "PITLANE"):
            if k not in keep:
                keep.append(k)
    # Unique preserve order.
    out = []
    seen = set()
    for k in keep:
        kk = str(k or "").strip().upper()
        if not kk or kk in seen:
            continue
        seen.add(kk)
        out.append(kk)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Export Assetto Corsa track KN5 -> GLB + SceneTool scenario.")
    ap.add_argument("--track-root", required=True, help="Path to AC track folder (contains *.kn5 and models.ini).")
    ap.add_argument(
        "--track-id",
        default="",
        help="Optional override for exported track id (output folder name). Default: derived from track-root folder name.",
    )
    ap.add_argument(
        "--out-root",
        default="assets/generated/assetto_corsa/tracks",
        help="Output root under the repo (default: assets/generated/assetto_corsa/tracks).",
    )
    ap.add_argument("--run-id", default="", help="Run id for output folder; auto timestamp if empty.")
    ap.add_argument(
        "--model-kn5",
        default="",
        help="Optional: KN5 filename/path under track-root to export (default: largest non-collider *.kn5).",
    )
    ap.add_argument(
        "--model-out-name",
        default="",
        help="Optional: output GLB filename (default: <track_id>.glb). '.glb' suffix optional.",
    )
    args = ap.parse_args()

    track_root = Path(args.track_root).expanduser().resolve()
    if not track_root.exists() or not track_root.is_dir():
        raise SystemExit(f"Invalid --track-root: {track_root}")

    track_id = _safe_name(args.track_id.strip()) or _safe_name(track_root.name) or "track"
    run_id = _safe_name(args.run_id.strip()) or _now_stamp()

    repo_root = Path(__file__).resolve().parents[1]
    out_root = Path(args.out_root).expanduser()
    if not out_root.is_absolute():
        out_root = (repo_root / out_root).resolve()
    out_dir = (out_root / track_id / run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    # Full export: keep the raw track config alongside the converted model.
    ac_raw_dir = out_dir / "ac_raw"
    normalized_dir = out_dir / "normalized"
    for p in (ac_raw_dir, normalized_dir):
        p.mkdir(parents=True, exist_ok=True)

    copied = {"data": False, "ui": False, "extension": False, "ai": False, "models_ini": False, "map_png": False, "layouts": 0}
    ini_entries: List[Dict] = []
    lut_refs: List[Dict] = []

    # Copy common track folders/files.
    try:
        src = track_root / "data"
        if src.exists() and src.is_dir():
            _copy_tree(src, ac_raw_dir / "data")
            copied["data"] = True
    except Exception:
        copied["data"] = False
    try:
        src = track_root / "ui"
        if src.exists() and src.is_dir():
            _copy_tree(src, ac_raw_dir / "ui")
            copied["ui"] = True
    except Exception:
        copied["ui"] = False
    try:
        src = track_root / "extension"
        if src.exists() and src.is_dir():
            _copy_tree(src, ac_raw_dir / "extension")
            copied["extension"] = True
    except Exception:
        copied["extension"] = False
    try:
        src = track_root / "ai"
        if src.exists() and src.is_dir():
            _copy_tree(src, ac_raw_dir / "ai")
            copied["ai"] = True
    except Exception:
        copied["ai"] = False

    # Some large mod tracks (e.g. Shutoko) keep layout-specific data under subfolders like
    # `main_layout/data`, `main_layout/ai`, etc. Copy these too so we can extract surfaces/friction
    # and any AI line files (fast_lane.ai) when present.
    try:
        layouts_root = (ac_raw_dir / "layouts").resolve()
        layouts_root.mkdir(parents=True, exist_ok=True)
        n_layouts = 0
        for child in sorted(track_root.iterdir()):
            try:
                if not child.is_dir():
                    continue
                name = _safe_name(child.name)
                if not name:
                    continue
                if name.lower() in {"data", "ui", "ai", "extension"}:
                    continue
                has_any = any((child / k).exists() and (child / k).is_dir() for k in ("data", "ui", "ai"))
                if not has_any:
                    continue
                out_base = layouts_root / name
                for k in ("data", "ui", "ai"):
                    src_k = child / k
                    if src_k.exists() and src_k.is_dir():
                        _copy_tree(src_k, out_base / k)
                # Copy common per-layout map assets when present (non-breaking).
                for fn in ("map.png", "map_mini.png", "models.ini"):
                    src_f = child / fn
                    if src_f.exists() and src_f.is_file():
                        try:
                            (out_base / fn).write_bytes(src_f.read_bytes())
                        except Exception:
                            pass
                n_layouts += 1
            except Exception:
                continue
        copied["layouts"] = int(n_layouts)
    except Exception:
        copied["layouts"] = 0
    try:
        src = track_root / "models.ini"
        if src.exists() and src.is_file():
            (ac_raw_dir / "models.ini").write_bytes(src.read_bytes())
            copied["models_ini"] = True
    except Exception:
        copied["models_ini"] = False
    try:
        src = track_root / "map.png"
        if src.exists() and src.is_file():
            (ac_raw_dir / "map.png").write_bytes(src.read_bytes())
            copied["map_png"] = True
    except Exception:
        copied["map_png"] = False

    # Index raw files + parse INIs (lossless).
    file_items = []
    ini_files = []
    lut_files = []
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
        st0 = f.stat()
        file_items.append({"path": rel, "kind": kind, "bytes": int(st0.st_size), "sha256": digest})

    ac_raw_index = {
        "track_id": track_id,
        "run_id": run_id,
        "source_track_root": track_root.as_posix(),
        "generated_at_utc": dt.datetime.now(UTC).isoformat(),
        "copied": copied,
        "files": file_items,
        "ini_files": sorted(ini_files),
        "lut_files": sorted(lut_files),
    }
    (ac_raw_dir / "index.json").write_text(
        json.dumps(ac_raw_index, indent=2, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )
    params_raw = {"track_id": track_id, "run_id": run_id, "entries": ini_entries, "lut_references": lut_refs}
    (ac_raw_dir / "params.raw.json").write_text(
        json.dumps(params_raw, indent=2, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )

    model_kn5 = args.model_kn5.strip()
    if not model_kn5:
        picked = _pick_main_kn5(track_root)
        if not picked:
            raise SystemExit(f"No *.kn5 found in track root: {track_root}")
        model_kn5 = picked.name

    model_out = args.model_out_name.strip() or f"{track_id}.glb"
    # Keep keys for a "driveable surfaces" fallback when the full track is too large to convert.
    keep_keys_for_drive = []
    try:
        keep_keys_for_drive = _surface_keep_keys_from_entries(ini_entries)
    except Exception:
        keep_keys_for_drive = []

    export = _export_track_glb(
        track_root=track_root,
        out_dir=out_dir,
        track_id=track_id,
        model_kn5=model_kn5,
        model_out_name=model_out,
        keep_materials=keep_keys_for_drive,
    )
    # Optional: export an optimized "ground collider" GLB containing only track drive surfaces.
    ground_collider_glb_rel = ""
    try:
        keep_keys = _surface_keep_keys_from_entries(ini_entries)
        if keep_keys:
            node = _which("node")
            obj_to_glb = (Path(__file__).resolve().parents[1] / "tools" / "obj_to_glb.mjs").resolve()
            obj_path = Path(export.get("obj_path") or "").resolve()
            if node and obj_to_glb.exists() and obj_path.exists():
                stem = Path(export.get("glb_path") or "track.glb").stem
                out_glb = (out_dir / "model" / f"{stem}.collider_ground.glb").resolve()
                subprocess.run(
                    [
                        node,
                        str(obj_to_glb),
                        "--in",
                        str(obj_path),
                        "--out",
                        str(out_glb),
                        "--keep-materials",
                        ",".join(keep_keys),
                    ],
                    check=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                if out_glb.exists() and out_glb.is_file() and out_glb.stat().st_size > 10_000:
                    try:
                        ground_collider_glb_rel = out_glb.relative_to(repo_root).as_posix()
                    except Exception:
                        ground_collider_glb_rel = ""
    except Exception:
        ground_collider_glb_rel = ""

    # Scenario snapshot (SceneTool schema=1).
    bmin = _parse_bounds_csv(export.get("bounds_min", ""))
    bmax = _parse_bounds_csv(export.get("bounds_max", ""))
    cx = 0.5 * (bmin[0] + bmax[0])
    cz = 0.5 * (bmin[2] + bmax[2])
    y_spawn = (bmin[1] if (bmin[1] or bmax[1]) else 0.0) + 1.0

    glb_rel = ""
    try:
        glb_rel = Path(export["glb_path"]).resolve().relative_to(repo_root).as_posix()
    except Exception:
        glb_rel = export.get("glb_path") or ""

    scenario = {
        "schema": 1,
        "name": f"AC Track: {track_root.name}",
        "path": glb_rel,
        "spawn": {"x": cx, "y": y_spawn, "z": cz},
        "view": {"yaw": 0.0, "pitch": -0.05, "eyeH": 1.7},
        "settings": {
            "mode": "fps",
            "showGrid": False,
            "fly": False,
            "speed": 6,
            "sprint": 11,
            "drivingEnabled": True,
            "spawnInPits": True,
        },
        "content": {"waypoints": [], "triggers": [], "meta": {"avatarProfile": "", "avatarAction": ""}},
    }
    scenario_path = (out_dir / "scene.scenario.json").resolve()
    scenario_path.write_text(json.dumps(scenario, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")

    # Optional: parse AC AI spline(s) into normalized JSON for downstream traffic.
    ai_fast_rel = ""
    ai_pit_rel = ""
    try:
        ai_dir = (ac_raw_dir / "ai").resolve()
        if ai_dir.exists() and ai_dir.is_dir():
            norm_ai_dir = (normalized_dir / "ai").resolve()
            norm_ai_dir.mkdir(parents=True, exist_ok=True)

            fast_ai = ai_dir / "fast_lane.ai"
            fast = _parse_ac_ai_line(fast_ai)
            if fast:
                out_p = (norm_ai_dir / "fast_lane.json").resolve()
                out_p.write_text(json.dumps(fast, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
                try:
                    ai_fast_rel = out_p.relative_to(repo_root).as_posix()
                except Exception:
                    ai_fast_rel = ""

            pit_ai = ai_dir / "pit_lane.ai"
            pit = _parse_ac_ai_line(pit_ai)
            if pit:
                out_p = (norm_ai_dir / "pit_lane.json").resolve()
                out_p.write_text(json.dumps(pit, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
                try:
                    ai_pit_rel = out_p.relative_to(repo_root).as_posix()
                except Exception:
                    ai_pit_rel = ""
                # Prefer pit lane start as default spawn for driveable scenarios.
                try:
                    pts = pit.get("points") or []
                    if isinstance(pts, list) and len(pts) >= 1:
                        p0 = pts[0] or {}
                        px = float(p0.get("x") or 0.0)
                        py = float(p0.get("y") or y_spawn)
                        pz = float(p0.get("z") or 0.0)
                        scenario["spawn"] = {"x": px, "y": py, "z": pz}
                except Exception:
                    pass
    except Exception:
        ai_fast_rel = ""
        ai_pit_rel = ""

    # Normalized track bundle (stable URLs relative to repo root when possible).
    bundle_path = (normalized_dir / "track.bundle.json").resolve()
    ac_raw_rel = ""
    try:
        ac_raw_rel = ac_raw_dir.resolve().relative_to(repo_root).as_posix()
    except Exception:
        ac_raw_rel = ""
    try:
        scenario_rel = scenario_path.resolve().relative_to(repo_root).as_posix()
    except Exception:
        scenario_rel = ""
    bundle = {
        "schema": "ac.track.bundle.v1",
        "track_id": track_id,
        "run_id": run_id,
        "track_name": track_root.name,
        "generated_at_utc": dt.datetime.now(UTC).isoformat(),
        "source": {"track_root": track_root.as_posix()},
        "paths": {
            "ac_raw_dir": ("/" + ac_raw_rel.lstrip("/")) if ac_raw_rel else "",
            "ac_raw_index_json": ("/" + (ac_raw_dir / "index.json").resolve().relative_to(repo_root).as_posix().lstrip("/")) if ac_raw_rel else "",
            "ac_raw_params_json": ("/" + (ac_raw_dir / "params.raw.json").resolve().relative_to(repo_root).as_posix().lstrip("/")) if ac_raw_rel else "",
            "scenario_json": ("/" + scenario_rel.lstrip("/")) if scenario_rel else "",
            "model_glb": ("/" + glb_rel.lstrip("/")) if glb_rel and not glb_rel.startswith("/") else glb_rel,
            "ground_collider_glb": ("/" + ground_collider_glb_rel.lstrip("/")) if ground_collider_glb_rel else "",
            "ai_fast_lane_json": ("/" + ai_fast_rel.lstrip("/")) if ai_fast_rel else "",
            "ai_pit_lane_json": ("/" + ai_pit_rel.lstrip("/")) if ai_pit_rel else "",
        },
        "model": {
            "kn5_rel": model_kn5,
            "kn5_abs": export.get("kn5_path"),
            "glb_rel": glb_rel,
            "bounds_min": export.get("bounds_min"),
            "bounds_max": export.get("bounds_max"),
        },
        "copied": copied,
    }
    bundle_path.write_text(json.dumps(bundle, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")

    result = {
        "ok": True,
        "trackId": track_id,
        "trackName": track_root.name,
        "runId": run_id,
        "outDir": out_dir.as_posix(),
        "indexJson": (ac_raw_dir / "index.json").as_posix(),
        "paramsRawJson": (ac_raw_dir / "params.raw.json").as_posix(),
        "bundleJson": bundle_path.as_posix(),
        "modelGlbPath": export.get("glb_path"),
        "modelGlbRel": glb_rel,
        "scenarioJson": scenario_path.as_posix(),
        "scenarioRel": "",
        "scenario": scenario,
    }
    try:
        # Python 3.8 doesn't have Path.is_relative_to; keep this compatible.
        result["scenarioRel"] = scenario_path.resolve().relative_to(repo_root).as_posix()
    except Exception:
        result["scenarioRel"] = ""
    try:
        result["bundleRel"] = bundle_path.resolve().relative_to(repo_root).as_posix()
    except Exception:
        result["bundleRel"] = ""
    print("ASSETTO_CORSA_TRACK_EXPORT_RESULT_JSON:" + json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())

