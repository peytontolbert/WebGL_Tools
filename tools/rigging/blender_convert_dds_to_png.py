from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

import bpy  # type: ignore

from blender_common import blender_argv_after_double_dash


def _parse(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(prog="blender_convert_dds_to_png.py")
    ap.add_argument("--in-dir", required=True, help="Directory containing DDS files.")
    ap.add_argument("--recursive", default="1", help="Search recursively (1/0).")
    ap.add_argument("--overwrite", default="0", help="Overwrite existing PNGs (1/0).")
    ap.add_argument("--delete-dds", default="0", help="Delete DDS after successful conversion (1/0).")
    return ap.parse_args(argv)


def _b01(v: str) -> bool:
    return str(v or "").strip() not in ("", "0", "false", "False", "no", "No")


def _dds_dxgi_format(path: Path) -> int:
    try:
        b = path.read_bytes()
    except Exception:
        return -1
    if len(b) < 132:
        return -1
    if b[0:4] != b"DDS ":
        return -1
    fourcc = b[84:88]
    if fourcc != b"DX10":
        return -1
    return int.from_bytes(b[128:132], "little", signed=False)


def main() -> None:
    args = _parse(blender_argv_after_double_dash())
    in_dir = Path(args.in_dir).resolve()
    recursive = _b01(args.recursive)
    overwrite = _b01(args.overwrite)
    delete_dds = _b01(args.delete_dds)

    if not in_dir.exists() or not in_dir.is_dir():
        raise SystemExit(f"Invalid --in-dir: {in_dir}")

    glob = "**/*.dds" if recursive else "*.dds"
    dds_files = sorted(in_dir.glob(glob))

    ok = 0
    skipped = 0
    failed = 0
    failures: list[dict] = []

    for dds in dds_files:
        try:
            if not dds.is_file():
                continue
            out = dds.with_suffix(".png")
            # Keep BC6/BC7 DDS as-is; Blender decode is unreliable for these variants.
            dxgi = _dds_dxgi_format(dds)
            if dxgi in (95, 96, 98, 99):
                skipped += 1
                continue
            if out.exists() and not overwrite:
                skipped += 1
                continue

            # Load DDS. Blender supports many DDS formats (including BC7) via its image loaders.
            img = bpy.data.images.load(str(dds), check_existing=False)
            try:
                img.filepath_raw = str(out)
                img.file_format = "PNG"
                img.save()
            finally:
                try:
                    bpy.data.images.remove(img)
                except Exception:
                    pass

            ok += 1
            if delete_dds:
                try:
                    dds.unlink()
                except Exception:
                    pass
        except Exception as e:
            msg = str(getattr(e, "message", e) or e)
            # Some DDS variants (notably certain DX10 BC7 maps) may be valid for runtime GPU upload
            # but unavailable through Blender image decode. Keep them as DDS and mark skipped.
            if "does not have any image data" in msg.lower():
                skipped += 1
                continue
            failed += 1
            failures.append({"dds": str(dds), "error": msg})

    print(
        "DDS_TO_PNG_RESULT_JSON:"
        + json.dumps(
            {
                "ok": True,
                "inDir": str(in_dir),
                "countDds": len(dds_files),
                "converted": ok,
                "skipped": skipped,
                "failed": failed,
                "failures": failures[:50],
            },
            ensure_ascii=True,
        )
    )


if __name__ == "__main__":
    main()

