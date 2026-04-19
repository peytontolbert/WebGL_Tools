#!/usr/bin/env python3
"""
Inspect an extracted Omniverse Characters pack and emit a tagging JSON report.

This is intended to answer questions like:
- does each character stage actually include Mesh prims (geometry)?
- does it include a rig (SkelRoot / Skeleton)?
- which USDs are motion-only (SkelAnimation without Mesh)?
- what textures/materials are shipped alongside each character?

Run inside the repo's `conda trellis` environment (needs `pxr`):
  conda run -n trellis python3 tools/omniverse_verify_characters_pack.py \
    --pack Characters_NVD_10012 \
    --out outputs/omniverse/Characters_NVD_10012_tags.json
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]

USD_EXTS = {".usd", ".usda", ".usdc", ".usdz"}
IMAGE_EXTS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".tga",
    ".exr",
    ".hdr",
    ".dds",
    ".ktx2",
    ".tif",
    ".tiff",
    ".bmp",
    ".webp",
    ".gif",
}
MATERIAL_EXTS = {".mdl"}

BLENDER5_PORTABLE = REPO_ROOT / "tools" / "third_party" / "blender-5.0" / "blender-5.0.0-linux-x64" / "blender"


def _to_rel_posix(p: Path) -> str:
    try:
        return p.resolve().relative_to(REPO_ROOT.resolve()).as_posix()
    except Exception:
        return p.as_posix()


def _safe_stat_size(p: Path) -> int:
    try:
        return int(p.stat().st_size)
    except Exception:
        return 0


def _find_reallusion_root(pack_abs: Path) -> Path | None:
    """
    Characters_NVD packs commonly organize characters like:
      <pack>/Assets/Characters/Reallusion/<...>
    """
    direct = pack_abs / "Assets" / "Characters" / "Reallusion"
    if direct.exists() and direct.is_dir():
        return direct

    # Fallback: find a Reallusion dir inside Assets/Characters
    try:
        for cand in pack_abs.rglob("Reallusion"):
            if not cand.is_dir():
                continue
            low = cand.as_posix().lower()
            if "/assets/characters/" in low and low.endswith("/reallusion"):
                return cand
    except Exception:
        pass
    return None


def _inspect_usd_counts(abs_path: Path) -> dict[str, Any]:
    """
    Lightweight USD inspection (counts only). No dependency scan (faster).
    """
    try:
        from pxr import Usd  # type: ignore
    except Exception as e:
        return {"ok": False, "error": f"missing pxr bindings: {e}"}

    if not abs_path.exists():
        return {"ok": False, "error": f"missing file: {abs_path}"}

    stage = Usd.Stage.Open(str(abs_path))
    if not stage:
        return {"ok": False, "error": "Usd.Stage.Open returned None"}

    mesh_count = 0
    material_count = 0
    shader_count = 0
    skel_root_count = 0
    skel_anim_count = 0

    try:
        for prim in stage.TraverseAll():
            t = prim.GetTypeName() or ""
            if t == "Mesh":
                mesh_count += 1
            elif t == "Material":
                material_count += 1
            elif t == "Shader":
                shader_count += 1
            elif t == "SkelRoot":
                skel_root_count += 1
            elif t == "SkelAnimation":
                skel_anim_count += 1
    except Exception as e:
        return {"ok": False, "error": f"traverse failed: {e}"}

    return {
        "ok": True,
        "stats": {
            "meshCount": int(mesh_count),
            "materialCount": int(material_count),
            "shaderCount": int(shader_count),
            "skelRootCount": int(skel_root_count),
            "skelAnimationCount": int(skel_anim_count),
        },
    }


def _inspect_usd_counts_via_blender(abs_path: Path, blender_exe: str) -> dict[str, Any]:
    """
    Fallback when system Python lacks pxr: run our Blender-based USD inspector.

    This depends on a Blender build that ships OpenUSD python bindings (pxr).
    """
    if not abs_path.exists():
        return {"ok": False, "error": f"missing file: {abs_path}"}

    script = (REPO_ROOT / "tools" / "rigging" / "blender_usd_inspect.py").resolve()
    if not script.exists():
        return {"ok": False, "error": f"missing blender inspector script: {script}"}

    cmd = [
        str(blender_exe),
        "--background",
        "--factory-startup",
        "--python",
        str(script),
        "--",
        "--in",
        str(abs_path.resolve()),
        "--top",
        "5",
    ]
    try:
        p = subprocess.run(cmd, cwd=str(REPO_ROOT), capture_output=True, text=True, timeout=90)
    except Exception as e:
        return {"ok": False, "error": f"blender inspect failed: {e}"}

    raw = (p.stdout or "").strip()
    if not raw:
        return {"ok": False, "error": f"blender inspect produced no stdout (exit {p.returncode})", "stderr": (p.stderr or "")[-4000:]}

    # Blender prints a banner before the JSON; extract the JSON object.
    i0 = raw.find("{")
    i1 = raw.rfind("}")
    if i0 < 0 or i1 <= i0:
        return {"ok": False, "error": f"blender inspect output not JSON (exit {p.returncode})", "stdout": raw[-4000:], "stderr": (p.stderr or "")[-4000:]}

    try:
        j = json.loads(raw[i0 : i1 + 1])
    except Exception as e:
        return {"ok": False, "error": f"failed to parse blender inspect JSON: {e}", "stdout": raw[i0 : min(len(raw), i0 + 4000)], "stderr": (p.stderr or "")[-4000:]}

    if not isinstance(j, dict) or not j.get("ok"):
        return {"ok": False, "error": str((j or {}).get("error") or "blender inspect returned ok=false")}

    stats = (j.get("stats") or {}) if isinstance(j.get("stats"), dict) else {}
    return {
        "ok": True,
        "stats": {
            "meshCount": int(stats.get("meshCount") or 0),
            "materialCount": int(stats.get("materialCount") or 0),
            "shaderCount": int(stats.get("shaderCount") or 0),
            "skelRootCount": int(stats.get("skelRootCount") or 0),
            "skelAnimationCount": int(stats.get("skelAnimationCount") or 0),
        },
    }


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


def main() -> int:
    ap = argparse.ArgumentParser(prog="omniverse_verify_characters_pack.py")
    ap.add_argument("--pack", default="Characters_NVD_10012", help="Pack folder name under --packs-root.")
    ap.add_argument("--packs-root", default="assets/external/omniverse/packs", help="Root directory containing extracted packs.")
    ap.add_argument("--out", default="", help="Output JSON path (default: outputs/omniverse/<pack>_tags.json).")
    ap.add_argument("--limit-chars", type=int, default=0, help="Optional cap (debug). 0 = no cap.")
    ap.add_argument("--blender", default="", help="Optional Blender executable (defaults to portable Blender 5.0 if present).")
    args = ap.parse_args()

    packs_root = (REPO_ROOT / str(args.packs_root)).resolve()
    pack_abs = (packs_root / str(args.pack)).resolve()
    if not pack_abs.exists():
        raise FileNotFoundError(f"Missing pack dir: {pack_abs}")

    reallusion_root = _find_reallusion_root(pack_abs)
    if not reallusion_root:
        raise RuntimeError(f"Could not locate Reallusion characters root under: {pack_abs}")

    out_path = str(args.out or "").strip()
    if not out_path:
        out_path = str((REPO_ROOT / "outputs" / "omniverse" / f"{args.pack}_tags.json").resolve())
    out_abs = Path(out_path).resolve()
    out_abs.parent.mkdir(parents=True, exist_ok=True)

    blender_exe = _pick_blender5(str(args.blender or ""))

    def inspect_counts(p: Path) -> dict[str, Any]:
        """
        Prefer direct pxr (fast) if available; otherwise fall back to Blender 5.0 (portable).
        """
        r = _inspect_usd_counts(p)
        if r.get("ok"):
            return r
        # Only fall back when failure is "missing pxr" (not a stage error).
        msg = str(r.get("error") or "").lower()
        if "missing pxr" in msg or "no module named" in msg or "pxr" in msg:
            return _inspect_usd_counts_via_blender(p, blender_exe)
        return r

    chars: list[dict[str, Any]] = []

    # Collect character directories from multiple subgroups:
    # - ActorCore: <Reallusion>/ActorCore/<CharacterDir>
    # - Direct characters: <Reallusion>/<CharacterName> (e.g. Debra/Orc/Worker)
    # - Audio2Face presets: <Reallusion>/Audio2Face_Preset_Examples/<ExampleDir>
    char_sources: list[tuple[str, Path]] = []

    actorcore_dir = reallusion_root / "ActorCore"
    if actorcore_dir.exists() and actorcore_dir.is_dir():
        for p in actorcore_dir.iterdir():
            if p.is_dir() and not p.name.startswith("."):
                char_sources.append(("ActorCore", p))

    for p in reallusion_root.iterdir():
        if not p.is_dir() or p.name.startswith("."):
            continue
        if p.name in ("ActorCore", "Audio2Face_Preset_Examples"):
            continue
        # Treat as a character if it has at least one USD in its root.
        try:
            if any((f.is_file() and f.suffix.lower() in USD_EXTS) for f in p.iterdir()):
                char_sources.append(("Reallusion", p))
        except Exception:
            continue

    a2f_dir = reallusion_root / "Audio2Face_Preset_Examples"
    if a2f_dir.exists() and a2f_dir.is_dir():
        for p in a2f_dir.iterdir():
            if p.is_dir() and not p.name.startswith("."):
                char_sources.append(("Audio2Face_Preset_Examples", p))

    # Stable ordering + optional limit.
    char_sources.sort(key=lambda t: (t[0].lower(), t[1].name.lower()))
    if int(args.limit_chars or 0) > 0:
        char_sources = char_sources[: int(args.limit_chars)]

    for (source, char_dir) in char_sources:
        # Entry USD: prefer a USD file directly under the character folder.
        # Heuristic:
        # - if a <DirName>.usd exists, use it
        # - else fall back to the largest USD in the folder root
        entry_usds = [
            p
            for p in char_dir.iterdir()
            if p.is_file() and p.suffix.lower() in USD_EXTS and p.name.lower().endswith(".usd")
        ]
        entry_usds.sort(key=_safe_stat_size, reverse=True)
        exact = [p for p in entry_usds if p.stem.lower() == char_dir.name.lower()]
        exact.sort(key=_safe_stat_size, reverse=True)
        entry_abs = (exact[0] if exact else (entry_usds[0] if entry_usds else None))

        # Actor USD: common patterns under Actor/ or Props/ (varies by character set)
        actor_candidates = []
        try:
            for pat in ("Actor/**/*.usd", "Actor/**/**/*.usd", "Props/**/*.usd", "Props/**/**/*.usd"):
                for p in char_dir.glob(pat):
                    if not p.is_file():
                        continue
                    # Prefer files whose stem matches their immediate folder, or the character folder.
                    if p.stem.lower() == p.parent.name.lower() or p.stem.lower() == char_dir.name.lower():
                        actor_candidates.append(p)
        except Exception:
            actor_candidates = []
        actor_candidates.sort(key=_safe_stat_size, reverse=True)
        actor_abs = actor_candidates[0] if actor_candidates else None

        # Motion USDs: under Motion(s)/ folders (often motion-only, meshCount=0).
        motion_paths: set[Path] = set()
        for pat in ("Motion/**/*.usd", "Motions/**/*.usd", "Actor/**/Motion/**/*.usd", "Actor/**/Motions/**/*.usd"):
            try:
                for p in char_dir.glob(pat):
                    if p.is_file() and p.suffix.lower() in USD_EXTS:
                        motion_paths.add(p)
            except Exception:
                pass

        # Prop/variant USDs: often full-body stages with pose/animation names.
        prop_paths: set[Path] = set()
        for pat in ("Props/**/*.usd", "Props/**/**/*.usd"):
            try:
                for p in char_dir.glob(pat):
                    if p.is_file() and p.suffix.lower() in USD_EXTS:
                        prop_paths.add(p)
            except Exception:
                pass

        # Exclude entry/actor from motion bucket if they happen to match the patterns.
        if entry_abs:
            motion_paths.discard(entry_abs)
            prop_paths.discard(entry_abs)
        if actor_abs:
            motion_paths.discard(actor_abs)
            prop_paths.discard(actor_abs)
        motion_abs_sorted = sorted(motion_paths, key=lambda p: p.as_posix().lower())
        prop_abs_sorted = sorted(prop_paths, key=lambda p: p.as_posix().lower())

        # Materials/textures alongside the character (filesystem-level tagging).
        materials = []
        textures = []
        try:
            for p in char_dir.rglob("*"):
                if not p.is_file():
                    continue
                ext = p.suffix.lower()
                if ext in MATERIAL_EXTS:
                    materials.append(p)
                elif ext in IMAGE_EXTS:
                    textures.append(p)
        except Exception:
            pass

        # USD inspection (counts-only).
        entry_inspect = inspect_counts(entry_abs) if entry_abs else {"ok": False, "error": "missing entry usd"}
        actor_inspect = inspect_counts(actor_abs) if actor_abs and actor_abs != entry_abs else {"ok": False, "error": "missing actor usd"}

        motions_inspect = []
        for mp in motion_abs_sorted:
            ir = inspect_counts(mp)
            motions_inspect.append(
                {
                    "path": _to_rel_posix(mp),
                    "ok": bool(ir.get("ok")),
                    "error": ir.get("error", ""),
                    "stats": ir.get("stats", {}),
                }
            )

        props_inspect = []
        for pp in prop_abs_sorted:
            ir = inspect_counts(pp)
            props_inspect.append(
                {
                    "path": _to_rel_posix(pp),
                    "ok": bool(ir.get("ok")),
                    "error": ir.get("error", ""),
                    "stats": ir.get("stats", {}),
                }
            )

        def _stats(ir: dict[str, Any]) -> dict[str, int]:
            s = ir.get("stats") or {}
            return {
                "meshCount": int(s.get("meshCount") or 0),
                "materialCount": int(s.get("materialCount") or 0),
                "shaderCount": int(s.get("shaderCount") or 0),
                "skelRootCount": int(s.get("skelRootCount") or 0),
                "skelAnimationCount": int(s.get("skelAnimationCount") or 0),
            }

        entry_stats = _stats(entry_inspect)
        actor_stats = _stats(actor_inspect) if actor_abs and actor_abs != entry_abs else {"meshCount": 0, "materialCount": 0, "shaderCount": 0, "skelRootCount": 0, "skelAnimationCount": 0}

        has_mesh = (entry_stats["meshCount"] > 0) or (actor_stats["meshCount"] > 0)
        has_rig = (entry_stats["skelRootCount"] > 0) or (actor_stats["skelRootCount"] > 0)
        has_anim = (entry_stats["skelAnimationCount"] > 0) or (actor_stats["skelAnimationCount"] > 0) or any(
            int((m.get("stats") or {}).get("skelAnimationCount") or 0) > 0 for m in motions_inspect
        ) or any(int((m.get("stats") or {}).get("skelAnimationCount") or 0) > 0 for m in props_inspect)

        chars.append(
            {
                "source": str(source),
                "name": char_dir.name,
                "dir": _to_rel_posix(char_dir),
                "entryUsd": _to_rel_posix(entry_abs) if entry_abs else "",
                "actorUsd": _to_rel_posix(actor_abs) if actor_abs else "",
                "counts": {
                    "motions": int(len(motions_inspect)),
                    "props": int(len(props_inspect)),
                    "materials": int(len(materials)),
                    "textures": int(len(textures)),
                },
                "usd": {
                    "entry": {"path": _to_rel_posix(entry_abs) if entry_abs else "", "ok": bool(entry_inspect.get("ok")), "error": entry_inspect.get("error", ""), "stats": entry_stats},
                    "actor": {"path": _to_rel_posix(actor_abs) if actor_abs else "", "ok": bool(actor_inspect.get("ok")), "error": actor_inspect.get("error", ""), "stats": actor_stats},
                    "motions": motions_inspect,
                    "props": props_inspect,
                },
                "tags": {
                    "hasMesh": bool(has_mesh),
                    "hasRig": bool(has_rig),
                    "hasAnimation": bool(has_anim),
                    "hasMaterials": bool(len(materials) > 0),
                    "hasTextures": bool(len(textures) > 0),
                },
            }
        )

    out_obj = {
        "ok": True,
        "pack": str(args.pack),
        "packsRoot": str(_to_rel_posix(packs_root)),
        "reallusionRoot": str(_to_rel_posix(reallusion_root)),
        "characterCount": int(len(chars)),
        "characters": chars,
    }
    out_abs.write_text(json.dumps(out_obj, indent=2) + "\n", encoding="utf-8")

    print(f"Wrote: {out_abs}")
    print(f"Characters: {len(chars)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

