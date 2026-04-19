#!/usr/bin/env python3
"""
Asset conversion helpers for this repo.

Primary goal: convert Omniverse/OpenUSD assets (USD/USDA/USDC/USDZ) into GLB/GLTF
so they can be previewed in devtools and used by the runtime.

Example:
  python3 tools/convert_asset.py to-gltf \
    --in assets/external/omniverse/packs/Characters_NVD_10012/.../character.usd \
    --out assets/generated/convert/character.glb
"""

from __future__ import annotations

import argparse
import os
import json
import struct
import shlex
import shutil
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
RIGGING_DIR = REPO_ROOT / "tools" / "rigging"
BLENDER5_PORTABLE = REPO_ROOT / "tools" / "third_party" / "blender-5.0" / "blender-5.0.0-linux-x64" / "blender"


class CmdError(RuntimeError):
    pass


def _run(cmd: list[str], *, cwd: Path | None = None) -> None:
    p = subprocess.run(cmd, cwd=str(cwd) if cwd else None, stdout=sys.stdout, stderr=sys.stderr)
    if p.returncode != 0:
        raise CmdError(f"Command failed ({p.returncode}): {shlex.join(cmd)}")


def _which_or_hint(exe: str, hint: str) -> str:
    p = shutil.which(exe)
    if p:
        return p
    raise CmdError(f"Missing executable `{exe}`. {hint}")


def _ensure_exists(path: Path, what: str) -> None:
    if not path.exists():
        raise CmdError(f"Missing {what}: {path}")


def _verify_gltf_textures(out_path: Path) -> None:
    """
    Verify we didn't produce a GLB/GLTF that references missing external textures.

    - GLB: images should be embedded (bufferView) or data: URIs.
    - GLTF_SEPARATE: image URIs should exist on disk relative to the .gltf.
    """
    out_path = Path(out_path)
    ext = out_path.suffix.lower()
    if ext not in (".glb", ".gltf"):
        return

    def _fail(msg: str) -> None:
        raise CmdError(f"Texture verify failed: {msg}")

    if ext == ".glb":
        raw = out_path.read_bytes()
        if len(raw) < 20:
            _fail(f"GLB too small: {out_path} ({len(raw)} bytes)")
        magic, version, length = struct.unpack_from("<4sII", raw, 0)
        if magic != b"glTF":
            _fail(f"Not a GLB (bad magic): {out_path}")
        if length != len(raw):
            # Not fatal, but suspicious.
            pass
        # First chunk should be JSON.
        off = 12
        if off + 8 > len(raw):
            _fail("GLB missing chunk header")
        chunk_len, chunk_type = struct.unpack_from("<II", raw, off)
        off += 8
        if chunk_type != 0x4E4F534A:  # JSON
            _fail("GLB first chunk is not JSON")
        js = raw[off : off + chunk_len]
        try:
            doc = json.loads(js.decode("utf-8", errors="ignore") or "{}")
        except Exception as e:
            _fail(f"GLB JSON parse error: {e}")
        images = doc.get("images") if isinstance(doc, dict) else None
        if not isinstance(images, list):
            return
        bad = []
        for i, im in enumerate(images):
            if not isinstance(im, dict):
                continue
            uri = str(im.get("uri") or "").strip()
            bv = im.get("bufferView")
            if uri:
                if uri.startswith("data:"):
                    continue
                bad.append(f"images[{i}] has external uri={uri!r}")
            elif bv is None:
                # Some exporters might omit both; treat as suspicious.
                bad.append(f"images[{i}] missing uri and bufferView")
        if bad:
            _fail("; ".join(bad[:10]))
        return

    # .gltf
    try:
        doc = json.loads(out_path.read_text(encoding="utf-8", errors="ignore") or "{}")
    except Exception as e:
        _fail(f"GLTF JSON parse error: {e}")
    images = doc.get("images") if isinstance(doc, dict) else None
    if not isinstance(images, list):
        return
    missing = []
    for i, im in enumerate(images):
        if not isinstance(im, dict):
            continue
        uri = str(im.get("uri") or "").strip()
        if not uri:
            continue
        if uri.startswith("data:"):
            continue
        img_abs = (out_path.parent / uri).resolve()
        if not img_abs.exists():
            missing.append(f"images[{i}] missing file: {uri}")
    if missing:
        _fail("; ".join(missing[:10]))


def _blender_run(blender_exe: str, script: Path, *, script_args: list[str]) -> None:
    _ensure_exists(script, "Blender script")
    cmd = [blender_exe, "--background", "--factory-startup", "--python", str(script), "--"] + script_args
    _run(cmd, cwd=REPO_ROOT)


def _pick_default_blender_for_input(inp: Path) -> str:
    """
    Pick a sane default Blender executable for this conversion.

    Motivation: system Blender builds are sometimes compiled without OpenUSD,
    which breaks USD imports. This repo vendors a portable Blender 5 build
    with USD support under tools/third_party/.
    """
    ext = inp.suffix.lower()
    wants_usd = ext in (".usd", ".usda", ".usdc", ".usdz")
    if wants_usd:
        try:
            if BLENDER5_PORTABLE.exists():
                return str(BLENDER5_PORTABLE.resolve())
        except Exception:
            pass
    # Fall back to PATH blender.
    return _which_or_hint("blender", "Install Blender or pass --blender /path/to/blender")


def _cmd_to_gltf(args: argparse.Namespace) -> None:
    script = RIGGING_DIR / "blender_convert_asset_to_gltf.py"

    inp = Path(args.input).resolve()
    out = Path(args.output).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    _ensure_exists(inp, "input asset")

    blender = str(args.blender or "").strip() or str(os.environ.get("BLENDER", "")).strip() or _pick_default_blender_for_input(inp)

    split_meshes = bool(args.split_meshes)
    split_out_dir = str(args.split_out_dir or "").strip()
    if split_meshes and not split_out_dir:
        split_out_dir = str((out.parent / f"{out.stem}_meshes").resolve())

    _blender_run(
        blender,
        script,
        script_args=[
            "--in",
            str(inp),
            "--out",
            str(out),
            "--export-format",
            str(args.export_format),
            "--deform-only",
            "1" if args.deform_only else "0",
            "--use-selection",
            "1" if args.use_selection else "0",
            "--split-meshes",
            "1" if split_meshes else "0",
            "--split-out-dir",
            split_out_dir,
        ],
    )

    if not out.exists():
        raise CmdError(f"Conversion did not produce output: {out}")

    # Ensure we didn't "lose" textures by emitting external references that don't exist.
    _verify_gltf_textures(out)


def _cmd_cleanup_mesh_particles(args: argparse.Namespace) -> None:
    """
    Clean up generated GLB/GLTF meshes by deleting tiny disconnected "particle" islands.
    Runs through Blender to preserve rigs/skins/animations where possible.
    """
    script = RIGGING_DIR / "blender_cleanup_mesh_particles.py"

    inp = Path(args.input).resolve()
    out = Path(args.output).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    _ensure_exists(inp, "input asset")

    blender = str(args.blender or "").strip() or str(os.environ.get("BLENDER", "")).strip() or _pick_default_blender_for_input(inp)

    _blender_run(
        blender,
        script,
        script_args=[
            "--in",
            str(inp),
            "--out",
            str(out),
            "--export-format",
            str(args.export_format),
            "--deform-only",
            "1" if args.deform_only else "0",
            "--use-selection",
            "1" if args.use_selection else "0",
            "--min-face-count",
            str(int(args.min_face_count)),
            "--min-area-ratio",
            str(float(args.min_area_ratio)),
            "--min-bbox-diag-ratio",
            str(float(args.min_bbox_diag_ratio)),
            "--keep-largest-n",
            str(int(args.keep_largest_n)),
            "--max-distance-ratio",
            str(float(args.max_distance_ratio)),
            "--main-islands-n",
            str(int(args.main_islands_n)),
            "--main-bbox-pad-ratio",
            str(float(args.main_bbox_pad_ratio)),
            "--min-object-face-count",
            str(int(args.min_object_face_count)),
            "--min-object-area-ratio",
            str(float(args.min_object_area_ratio)),
            "--min-object-bbox-diag-ratio",
            str(float(args.min_object_bbox_diag_ratio)),
            "--keep-largest-objects-n",
            str(int(args.keep_largest_objects_n)),
        ],
    )

    if not out.exists():
        raise CmdError(f"Cleanup did not produce output: {out}")

    # Ensure we didn't "lose" textures by emitting external references that don't exist.
    _verify_gltf_textures(out)


def _build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="tools/convert_asset.py")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("to-gltf", help="Convert an asset (USD/FBX/etc) to GLB/GLTF via Blender.")
    p.add_argument("--in", dest="input", required=True, help="Input asset path.")
    p.add_argument("--out", dest="output", required=True, help="Output GLB/GLTF path.")
    p.add_argument("--export-format", default="GLB", choices=["GLB", "GLTF_SEPARATE"])
    p.add_argument("--deform-only", action="store_true", help="Export deform bones only (if an armature exists).")
    p.add_argument("--use-selection", action="store_true", default=True, help="Export only imported objects.")
    p.add_argument("--split-meshes", action="store_true", help="Also export one GLB per mesh object into a sibling folder.")
    p.add_argument("--split-out-dir", default="", help="Optional output directory for per-mesh GLBs.")
    p.add_argument("--blender", default="", help="Blender executable path (or set BLENDER env var).")
    p.set_defaults(func=_cmd_to_gltf)

    p = sub.add_parser("cleanup-mesh", help="Remove tiny disconnected mesh islands (floaters/particles) via Blender, export GLB/GLTF.")
    p.add_argument("--in", dest="input", required=True, help="Input asset path.")
    p.add_argument("--out", dest="output", required=True, help="Output GLB/GLTF path.")
    p.add_argument("--export-format", default="GLB", choices=["GLB", "GLTF_SEPARATE"])
    p.add_argument("--deform-only", action="store_true", help="Export deform bones only (if an armature exists).")
    p.add_argument("--use-selection", action="store_true", default=True, help="Export only imported objects.")
    p.add_argument("--min-face-count", type=int, default=20, help="Delete islands with fewer faces than this.")
    p.add_argument("--min-area-ratio", type=float, default=0.0005, help="Delete islands with area < ratio * largest-island-area.")
    p.add_argument("--min-bbox-diag-ratio", type=float, default=0.01, help="Delete islands with AABB diagonal < ratio * largest-island-diagonal.")
    p.add_argument("--keep-largest-n", type=int, default=6, help="Always keep at least N largest islands per mesh (by area).")
    p.add_argument("--max-distance-ratio", type=float, default=0.0, help="Delete islands far from main bbox (0 disables).")
    p.add_argument("--main-islands-n", type=int, default=20, help="Number of largest islands to define main bbox.")
    p.add_argument("--main-bbox-pad-ratio", type=float, default=0.03, help="Pad main bbox by this fraction of main diagonal.")
    p.add_argument("--min-object-face-count", type=int, default=0, help="Delete mesh objects with fewer faces than this (0 disables).")
    p.add_argument("--min-object-area-ratio", type=float, default=0.0, help="Delete mesh objects with area < ratio * largest-mesh-object-area (0 disables).")
    p.add_argument("--min-object-bbox-diag-ratio", type=float, default=0.0, help="Delete mesh objects with AABB diagonal < ratio * largest-mesh-object-diagonal (0 disables).")
    p.add_argument("--keep-largest-objects-n", type=int, default=0, help="Always keep at least N largest mesh objects (by area) (0 disables).")
    p.add_argument("--blender", default="", help="Blender executable path (or set BLENDER env var).")
    p.set_defaults(func=_cmd_cleanup_mesh_particles)

    return ap


def main() -> int:
    ap = _build_parser()
    args = ap.parse_args()
    try:
        args.func(args)
        return 0
    except Exception as e:
        print(str(e), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

