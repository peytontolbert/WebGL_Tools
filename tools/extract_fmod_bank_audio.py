#!/usr/bin/env python3
"""
Extract/decode audio streams from an FMOD .bank into WAV or OGG for web playback.

Uses vgmstream-cli (https://vgmstream.org/) to decode.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Dict, List, Optional, Tuple


def _which(cmd: str) -> str:
    from shutil import which

    return str(which(cmd) or "").strip()


def _run(cmd: list[str]) -> Tuple[int, str]:
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return int(p.returncode), str(p.stdout or "")


def _parse_subsong_count(meta_text: str) -> Optional[int]:
    """
    Best-effort parse of vgmstream-cli -m output.
    Different builds print different labels; try a few.
    """
    t = str(meta_text or "")
    pats = [
        r"(?im)^\s*subsongs?\s*:\s*(\d+)\s*$",
        r"(?im)^\s*subsong\s+count\s*:\s*(\d+)\s*$",
        r"(?im)^\s*stream\s+count\s*:\s*(\d+)\s*$",
        r"(?im)^\s*total\s+subsongs?\s*:\s*(\d+)\s*$",
    ]
    for pat in pats:
        m = re.search(pat, t)
        if m:
            try:
                n = int(m.group(1))
                return n if n > 0 else None
            except Exception:
                continue
    return None


def _parse_meta_field(meta_text: str, key: str) -> Optional[str]:
    t = str(meta_text or "")
    # Example lines:
    # stream name: foo
    # play duration: 234836 samples (0:05.325 seconds)
    m = re.search(rf"(?im)^\s*{re.escape(key)}\s*:\s*(.+?)\s*$", t)
    return str(m.group(1)).strip() if m else None


def _safe_name(s: str) -> str:
    raw = str(s or "").strip()
    out = re.sub(r"[^A-Za-z0-9._-]+", "_", raw)
    out = re.sub(r"_{2,}", "_", out).strip("_")
    return out or "stream"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bank", required=True, help="Path to .bank file")
    ap.add_argument("--out-dir", required=True, help="Output directory for decoded streams")
    ap.add_argument("--format", choices=["wav", "ogg"], default="ogg")
    ap.add_argument("--max-subsongs", type=int, default=256, help="Safety cap when subsong count can't be detected")
    ap.add_argument("--start", type=int, default=1, help="Start subsong index (1-based)")
    ap.add_argument("--end", type=int, default=0, help="End subsong index (0=auto)")
    ap.add_argument("--vgmstream", default="", help="Path to vgmstream-cli (optional)")
    ap.add_argument("--ffmpeg", default="", help="Path to ffmpeg (required for ogg)")
    ap.add_argument("--manifest-only", action="store_true", help="Only write manifest.json (no decoding)")
    args = ap.parse_args()

    bank = Path(args.bank).expanduser().resolve()
    if not bank.exists() or not bank.is_file():
        print(f"Missing bank: {bank}", file=sys.stderr)
        return 2

    out_dir = Path(args.out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    vgm = str(args.vgmstream or "").strip() or _which("vgmstream-cli") or _which("vgmstream_cli")
    if not vgm:
        # Prefer repo-local install location if present.
        repo_local = (Path(__file__).resolve().parents[0] / "bin" / "vgmstream-cli").resolve()
        if repo_local.exists():
            vgm = repo_local.as_posix()
    if not vgm:
        print("Missing vgmstream-cli. Run: tools/install_vgmstream_cli.sh", file=sys.stderr)
        return 3

    ffmpeg = str(args.ffmpeg or "").strip() or _which("ffmpeg")
    if args.format == "ogg" and not ffmpeg:
        print("Missing ffmpeg (required for ogg output).", file=sys.stderr)
        return 4

    # Detect subsong count if possible.
    code, meta = _run([vgm, "-m", bank.as_posix()])
    if code != 0:
        # Some builds use -I for info; try that too.
        code, meta = _run([vgm, "-I", bank.as_posix()])
    subsongs = _parse_subsong_count(meta)

    start = max(1, int(args.start or 1))
    end = int(args.end or 0)
    if end <= 0:
        end = int(subsongs or 0)
    if end <= 0:
        end = min(int(args.max_subsongs or 256), 256)
    end = max(start, min(end, int(args.max_subsongs or 256)))

    manifest: Dict[str, object] = {
        "schema": 1,
        "bank": bank.as_posix(),
        "out_dir": out_dir.as_posix(),
        "format": args.format,
        "stream_count": int(subsongs or 0),
        "streams": [],
    }

    # Decode each subsong.
    ok = 0
    fail = 0
    for i in range(start, end + 1):
        # Get per-stream metadata (for naming + manifest).
        code_i, meta_i = _run([vgm, "-m", "-s", str(i), bank.as_posix()])
        if code_i != 0:
            code_i, meta_i = _run([vgm, "-I", "-s", str(i), bank.as_posix()])
        stream_name = _parse_meta_field(meta_i, "stream name") or ""
        play_dur = _parse_meta_field(meta_i, "play duration") or ""

        stem = f"{bank.stem}__{i:03d}"
        wav_path = (out_dir / f"{stem}.wav").resolve()
        ogg_path = (out_dir / f"{stem}.ogg").resolve()

        manifest["streams"].append(
            {
                "index": i,
                "name": stream_name,
                "duration": play_dur,
                "file": (ogg_path.name if args.format == "ogg" else wav_path.name),
            }
        )

        if bool(args.manifest_only):
            continue

        # Decode to WAV first.
        if not wav_path.exists() or wav_path.stat().st_size < 44:
            code, out = _run([vgm, "-s", str(i), "-o", wav_path.as_posix(), bank.as_posix()])
            if code != 0 or not wav_path.exists() or wav_path.stat().st_size < 44:
                # Stop early if we hit a bunch of failures at the start (likely invalid range).
                fail += 1
                try:
                    if wav_path.exists():
                        wav_path.unlink()
                except Exception:
                    pass
                # Heuristic: after 8 consecutive failures from the start, stop.
                if i <= start + 8 and fail >= 8 and ok == 0:
                    break
                continue

        if args.format == "wav":
            ok += 1
            continue

        # Convert WAV -> OGG.
        if not ogg_path.exists() or ogg_path.stat().st_size < 128:
            cmd = [
                ffmpeg,
                "-y",
                "-loglevel",
                "error",
                "-i",
                wav_path.as_posix(),
                "-c:a",
                "libvorbis",
                "-q:a",
                "5",
                ogg_path.as_posix(),
            ]
            code, out = _run(cmd)
            if code != 0 or not ogg_path.exists() or ogg_path.stat().st_size < 128:
                fail += 1
                continue
        # Keep workspace size reasonable: delete intermediate WAV.
        try:
            wav_path.unlink()
        except Exception:
            pass
        ok += 1

    # Write manifest.
    try:
        import json

        (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    except Exception:
        pass

    print(
        "FMOD_BANK_EXTRACT_RESULT_JSON:"
        + (
            f'{{"ok":true,"bank":"{bank.as_posix()}","outDir":"{out_dir.as_posix()}","decoded":{ok},"failed":{fail}}}'
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

