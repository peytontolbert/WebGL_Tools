#!/usr/bin/env python3
"""
Batch retarget helper: video clips -> motion files -> retargeted GLBs.

This tool does not hardcode one mocap extractor. Instead it supports:
  1) Sidecar motion files (same basename as video, e.g. clip01.bvh), or
  2) A user-provided extraction command template:
       --extract-cmd "python3 /abs/path/video_to_bvh.py --video {video} --out {motion}"

Then each motion clip is retargeted onto your target rig using tools/anim_asset.py.
"""

from __future__ import annotations

import argparse
import shlex
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_VIDEO_EXTS = (".mp4", ".mov", ".mkv", ".webm", ".avi")
DEFAULT_MOTION_SIDEcar_EXTS = (".bvh", ".fbx", ".glb", ".gltf")


class CmdError(RuntimeError):
    pass


def _run(cmd: list[str], *, cwd: Path | None = None, dry_run: bool = False) -> None:
    pretty = " ".join(shlex.quote(x) for x in cmd)
    print(f"$ {pretty}")
    if dry_run:
        return
    p = subprocess.run(cmd, cwd=str(cwd) if cwd else None, stdout=sys.stdout, stderr=sys.stderr)
    if p.returncode != 0:
        raise CmdError(f"Command failed ({p.returncode}): {pretty}")


def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="tools/video_batch_retarget.py")
    ap.add_argument("--videos-dir", default="videos", help="Directory containing input videos.")
    ap.add_argument("--rig", required=True, help="Target rig asset path (typically GLB).")
    ap.add_argument("--map", required=True, help="Retarget mapping JSON path.")
    ap.add_argument(
        "--out-dir",
        default="assets/animations/video_retarget",
        help="Directory for retargeted GLB outputs.",
    )
    ap.add_argument(
        "--motions-dir",
        default="outputs/video_mocap",
        help="Directory where extracted motion files are written/read.",
    )
    ap.add_argument(
        "--motion-ext",
        default="bvh",
        choices=["bvh", "fbx", "glb", "gltf"],
        help="Extension used for extracted motion files in motions-dir.",
    )
    ap.add_argument(
        "--extract-cmd",
        default="",
        help=(
            "Optional command template to produce motion from each video. "
            "Supports placeholders: {video}, {motion}, {stem}. "
            "Example: \"python3 /abs/path/video_to_bvh.py --video {video} --out {motion}\""
        ),
    )
    ap.add_argument(
        "--video-exts",
        default=",".join(DEFAULT_VIDEO_EXTS),
        help="Comma-separated video extensions to scan.",
    )
    ap.add_argument("--root-motion", action="store_true", help="Enable root translation copy.")
    ap.add_argument("--include-mesh", action="store_true", help="Include mesh in each output GLB.")
    ap.add_argument("--export-format", default="GLB", choices=["GLB", "GLTF_SEPARATE"])
    ap.add_argument("--blender", default="", help="Optional Blender executable path.")
    ap.add_argument("--python", default=sys.executable, help="Python executable for child scripts.")
    ap.add_argument("--dry-run", action="store_true", help="Print commands without executing.")
    return ap.parse_args()


def _resolve(p: str) -> Path:
    pp = Path(p).expanduser()
    if pp.is_absolute():
        return pp.resolve()
    return (REPO_ROOT / pp).resolve()


def _split_exts(raw: str) -> tuple[str, ...]:
    parts = []
    for item in str(raw or "").split(","):
        v = item.strip().lower()
        if not v:
            continue
        if not v.startswith("."):
            v = "." + v
        parts.append(v)
    if not parts:
        return DEFAULT_VIDEO_EXTS
    return tuple(parts)


def _discover_videos(videos_dir: Path, exts: tuple[str, ...]) -> list[Path]:
    if not videos_dir.exists():
        raise CmdError(f"Missing videos directory: {videos_dir}")
    out = []
    for p in sorted(videos_dir.iterdir()):
        if not p.is_file():
            continue
        if p.suffix.lower() in exts:
            out.append(p)
    return out


def _find_sidecar_motion(video_path: Path) -> Path | None:
    for ext in DEFAULT_MOTION_SIDEcar_EXTS:
        p = video_path.with_suffix(ext)
        if p.exists():
            return p
    return None


def _build_extract_cmd(template: str, *, video: Path, motion: Path) -> list[str]:
    rendered = template.format(video=str(video), motion=str(motion), stem=video.stem)
    return shlex.split(rendered)


def _main() -> int:
    args = _parse_args()

    videos_dir = _resolve(args.videos_dir)
    rig_path = _resolve(args.rig)
    map_path = _resolve(args.map)
    out_dir = _resolve(args.out_dir)
    motions_dir = _resolve(args.motions_dir)

    if not rig_path.exists():
        raise CmdError(f"Missing rig: {rig_path}")
    if not map_path.exists():
        raise CmdError(f"Missing map: {map_path}")

    out_dir.mkdir(parents=True, exist_ok=True)
    motions_dir.mkdir(parents=True, exist_ok=True)

    video_exts = _split_exts(args.video_exts)
    videos = _discover_videos(videos_dir, video_exts)
    if not videos:
        raise CmdError(f"No videos found in {videos_dir} for extensions: {video_exts}")

    print(f"Found {len(videos)} video(s) in {videos_dir}")
    print(f"Rig: {rig_path}")
    print(f"Map: {map_path}")
    print(f"Output dir: {out_dir}")

    succeeded = []
    failed = []

    for video in videos:
        stem = video.stem
        print(f"\n=== {video.name} ===")
        motion_path = motions_dir / f"{stem}.{args.motion_ext}"

        try:
            if str(args.extract_cmd or "").strip():
                cmd = _build_extract_cmd(str(args.extract_cmd), video=video, motion=motion_path)
                _run(cmd, cwd=REPO_ROOT, dry_run=bool(args.dry_run))
                if not args.dry_run and not motion_path.exists():
                    raise CmdError(f"Extractor did not produce expected motion file: {motion_path}")
                source_motion = motion_path
            else:
                sidecar = _find_sidecar_motion(video)
                if sidecar is None:
                    raise CmdError(
                        "No extractor configured and no sidecar motion found "
                        f"(expected one of {DEFAULT_MOTION_SIDEcar_EXTS} next to video)."
                    )
                source_motion = sidecar
                print(f"Using sidecar motion: {source_motion}")

            out_glb = out_dir / f"{stem}.glb"
            cmd = [
                str(args.python),
                str(REPO_ROOT / "tools" / "anim_asset.py"),
                "retarget",
                "--rig",
                str(rig_path),
                "--motion",
                str(source_motion),
                "--map",
                str(map_path),
                "--out",
                str(out_glb),
                "--clip-name",
                stem,
                "--export-format",
                str(args.export_format),
            ]
            if args.root_motion:
                cmd.append("--root-motion")
            if args.include_mesh:
                cmd.append("--include-mesh")
            if str(args.blender or "").strip():
                cmd += ["--blender", str(args.blender).strip()]

            _run(cmd, cwd=REPO_ROOT, dry_run=bool(args.dry_run))
            succeeded.append((video, out_glb))
        except Exception as e:
            failed.append((video, str(e)))
            print(f"FAILED: {e}", file=sys.stderr)

    print("\n=== Summary ===")
    print(f"Succeeded: {len(succeeded)}")
    for v, out_glb in succeeded:
        print(f"  - {v.name} -> {out_glb}")
    print(f"Failed: {len(failed)}")
    for v, msg in failed:
        print(f"  - {v.name}: {msg}")

    return 0 if not failed else 1


if __name__ == "__main__":
    try:
        raise SystemExit(_main())
    except CmdError as e:
        print(str(e), file=sys.stderr)
        raise SystemExit(2)
