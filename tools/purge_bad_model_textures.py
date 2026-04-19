"""
Purge obviously bad/corrupt exported model textures so the repair pipeline can overwrite them cleanly.

Why:
- The extraction/repair tools are intentionally "skip if file exists" to avoid redoing work.
- If a file on disk is broken (HTML, empty, wrong container type, stub checkerboard), it will *block* repair
  unless we delete it first.

This script deletes only files that are very likely wrong:
- Empty/unreadable files
- Container mismatch (e.g. *.png that doesn't start with PNG magic)
- Optional: known stub PNGs (4x4 magenta/black checkerboard from write_stub_textures_for_missing.py)

Typical workflow:
  python webgl-gta/webgl_viewer/tools/purge_bad_model_textures.py --regen-index
  python webgl-gta/webgl_viewer/tools/repair_missing_model_textures.py --gta-path /data/webglgta/gta5 --max-textures 0
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional


PNG_SIG = b"\x89PNG\r\n\x1a\n"


@dataclass(frozen=True)
class FileSig:
    kind: str
    detail: str


def _read_head(p: Path, n: int = 64) -> bytes:
    try:
        with p.open("rb") as f:
            return f.read(n)
    except Exception:
        return b""


def _strip_leading_ws(b: bytes) -> bytes:
    i = 0
    while i < len(b) and b[i] in (9, 10, 13, 32):  # \t \n \r space
        i += 1
    return b[i:]


def sniff_bytes(head: bytes) -> FileSig:
    if not head:
        return FileSig("unreadable_or_empty", "no bytes read")
    b = _strip_leading_ws(head)
    if not b:
        return FileSig("empty_or_whitespace", "only whitespace")
    if b.startswith(b"<"):
        return FileSig("html", "starts with '<' (SPA fallback / wrong file)")
    if b.startswith(b"DDS "):
        return FileSig("dds", "DDS magic")
    if len(b) >= 12 and b[:12] == b"\xABKTX 20\xBB\r\n\x1A\n":
        return FileSig("ktx2", "KTX2 magic")
    if b.startswith(PNG_SIG):
        if len(b) < 16:
            return FileSig("png_truncated", "signature present but too short for IHDR header")
        ihdr_type = b[12:16]
        if ihdr_type != b"IHDR":
            return FileSig("png_suspicious", f"signature ok but first chunk type={ihdr_type!r} (expected b'IHDR')")
        return FileSig("png", "signature ok (IHDR present)")
    if len(b) >= 3 and b[0:3] == b"\xFF\xD8\xFF":
        return FileSig("jpeg", "SOI header")
    if b.startswith(b"GIF87a") or b.startswith(b"GIF89a"):
        return FileSig("gif", "GIF header")
    if len(b) >= 2 and b[0:2] == b"BM":
        return FileSig("bmp", "BM header")
    if len(b) >= 12 and b[0:4] == b"RIFF" and b[8:12] == b"WEBP":
        return FileSig("webp", "RIFF WEBP header")
    return FileSig("unknown", f"head={b[:16].hex(' ')}")


def _is_stub_png(path: Path) -> bool:
    """
    Matches write_stub_textures_for_missing.py output:
      - PNG
      - 4x4 RGBA
      - strict magenta/black checkerboard
    """
    try:
        from PIL import Image  # type: ignore
    except Exception:
        return False
    try:
        with Image.open(path) as im:
            im = im.convert("RGBA")
            if im.size != (4, 4):
                return False
            px = im.load()
            mag = (255, 0, 255, 255)
            blk = (0, 0, 0, 255)
            for y in range(4):
                for x in range(4):
                    want = mag if ((x ^ y) & 1) else blk
                    if tuple(px[x, y]) != want:
                        return False
            return True
    except Exception:
        return False


def _iter_texture_dirs(assets_dir: Path) -> list[Path]:
    out: list[Path] = []
    out.append(assets_dir / "models_textures")
    out.append(assets_dir / "models_textures_ktx2")

    packs_dir = assets_dir / "packs"
    if packs_dir.exists() and packs_dir.is_dir():
        try:
            for ent in sorted(packs_dir.iterdir(), key=lambda p: p.name):
                if not ent.is_dir():
                    continue
                out.append(ent / "models_textures")
                out.append(ent / "models_textures_ktx2")
        except Exception:
            pass

    # If asset_packs.json exists and uses a non-default packs root, include those too.
    ap = assets_dir / "asset_packs.json"
    if ap.exists():
        try:
            cfg = json.loads(ap.read_text(encoding="utf-8", errors="ignore"))
            packs = cfg.get("packs") if isinstance(cfg, dict) else None
            if isinstance(packs, list):
                for p in packs:
                    if not isinstance(p, dict):
                        continue
                    if p.get("enabled") is False:
                        continue
                    rr = str(p.get("rootRel") or p.get("root") or "").strip().strip("/").lstrip("/")
                    pid = str(p.get("id") or "").strip()
                    if not rr and pid:
                        rr = f"packs/{pid}"
                    if rr:
                        out.append(assets_dir / rr / "models_textures")
                        out.append(assets_dir / rr / "models_textures_ktx2")
        except Exception:
            pass

    # Uniq + keep order.
    seen = set()
    uniq: list[Path] = []
    for d in out:
        if d in seen:
            continue
        seen.add(d)
        uniq.append(d)
    return uniq


def _should_delete_by_sig(p: Path, sig: FileSig) -> Optional[str]:
    ext = p.suffix.lower().lstrip(".")
    # Always delete empty/unreadable.
    if sig.kind in ("unreadable_or_empty", "empty_or_whitespace"):
        return f"{sig.kind}"

    # Container mismatches.
    if ext == "png":
        if sig.kind != "png":
            return f"png_mismatch(sig={sig.kind})"
        if sig.kind == "png_suspicious" or sig.kind == "png_truncated":
            return f"png_bad(sig={sig.kind})"
        return None
    if ext in ("jpg", "jpeg"):
        return None if sig.kind == "jpeg" else f"jpeg_mismatch(sig={sig.kind})"
    if ext == "webp":
        return None if sig.kind == "webp" else f"webp_mismatch(sig={sig.kind})"
    if ext == "gif":
        return None if sig.kind == "gif" else f"gif_mismatch(sig={sig.kind})"
    if ext == "bmp":
        return None if sig.kind == "bmp" else f"bmp_mismatch(sig={sig.kind})"
    if ext == "ktx2":
        return None if sig.kind == "ktx2" else f"ktx2_mismatch(sig={sig.kind})"
    if ext == "dds":
        return None if sig.kind == "dds" else f"dds_mismatch(sig={sig.kind})"

    return None


def _iter_files(d: Path, exts: Iterable[str]) -> Iterable[Path]:
    if not d.exists() or not d.is_dir():
        return []
    try:
        with os.scandir(d) as it:
            for ent in it:
                try:
                    if not ent.is_file():
                        continue
                    p = Path(ent.path)
                    if p.suffix.lower().lstrip(".") in exts:
                        yield p
                except Exception:
                    continue
    except Exception:
        return []


def _regen_indices(assets_dir: Path) -> None:
    # Load setup_assets.py directly so this works when run as a script (no install).
    repo_root = Path(__file__).resolve().parents[2]
    setup_path = repo_root / "webgl_viewer" / "setup_assets.py"
    if not setup_path.exists():
        print(f"[purge] WARN: cannot find setup_assets.py at {setup_path}; skipping index regen.")
        return
    import importlib.util

    try:
        spec = importlib.util.spec_from_file_location("webglgta_setup_assets", setup_path)
        if spec is None or spec.loader is None:
            raise RuntimeError("spec_from_file_location returned None")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # type: ignore[attr-defined]
        getattr(mod, "_ensure_models_textures_index")(Path(assets_dir))
    except Exception as e:
        print(f"[purge] WARN: failed to regen indices: {type(e).__name__}: {e}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--assets-dir",
        default="",
        help="Viewer assets dir (default: <repo>/webgl_viewer/assets).",
    )
    ap.add_argument("--dry-run", action="store_true", default=False)
    ap.add_argument("--delete-stubs", default=True, action=getattr(argparse, "BooleanOptionalAction", "store_true"))
    ap.add_argument("--regen-index", action="store_true", default=False)
    ap.add_argument("--max-files", type=int, default=0, help="Limit processed files (0 = all)")
    args = ap.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    viewer_root = repo_root / "webgl_viewer"
    assets_dir = Path(args.assets_dir).resolve() if args.assets_dir else (viewer_root / "assets")

    tex_dirs = _iter_texture_dirs(assets_dir)
    exts = {"png", "dds", "jpg", "jpeg", "webp", "gif", "bmp", "ktx2"}

    deleted = 0
    kept = 0
    stubs_deleted = 0
    by_reason: dict[str, int] = {}

    processed = 0
    for d in tex_dirs:
        for p in _iter_files(d, exts):
            processed += 1
            if args.max_files and int(args.max_files) > 0 and processed > int(args.max_files):
                break

            sig = sniff_bytes(_read_head(p, 64))
            reason = _should_delete_by_sig(p, sig)
            if reason is None and bool(args.delete_stubs) and p.suffix.lower() == ".png":
                # Only run the expensive PIL decode when needed.
                if _is_stub_png(p):
                    reason = "stub_png"

            if reason is None:
                kept += 1
                continue

            by_reason[reason] = int(by_reason.get(reason, 0) or 0) + 1
            if reason == "stub_png":
                stubs_deleted += 1

            if bool(args.dry_run):
                continue

            try:
                p.unlink()
                deleted += 1
            except Exception:
                # If we can't delete it, treat as kept.
                kept += 1

        if args.max_files and int(args.max_files) > 0 and processed > int(args.max_files):
            break

    print(f"[purge] assets_dir={assets_dir}")
    print(f"[purge] dry_run={bool(args.dry_run)} delete_stubs={bool(args.delete_stubs)}")
    print(f"[purge] scanned_files={processed} kept={kept} deleted={deleted} stubs_deleted={stubs_deleted}")
    if by_reason:
        for k in sorted(by_reason.keys()):
            print(f"[purge] reason {k}: {by_reason[k]}")

    if args.regen_index and not bool(args.dry_run):
        _regen_indices(assets_dir)
        print("[purge] regen-index: done")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())


