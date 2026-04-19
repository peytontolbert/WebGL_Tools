#!/usr/bin/env python3
"""
Omniverse downloadable asset pack helper.

- Keeps the original "top to bottom" URL order (edit PACK_URLS_TEXT).
- Downloads zips into:   assets/external/omniverse/zips/
- Extracts each pack into assets/external/omniverse/packs/<pack_name>/
- Stops before extracting the next pack once the total uncompressed size
  would exceed --max-gb (default: 5GiB).

Notes:
- These packs are governed by the NVIDIA Omniverse License Agreement referenced
  inside each pack (typically in PACKAGE-LICENSES/).
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlparse


PACK_URLS_TEXT = """
https://d4i3qtqj3r0z5.cloudfront.net/Extensions_Samples_NVD%4010010.zip
https://d4i3qtqj3r0z5.cloudfront.net/AEC_XR_NVD%40100.1.2.zip
https://d4i3qtqj3r0z5.cloudfront.net/AECO_CityDemoPack_NVD%4010011.zip
https://d4i3qtqj3r0z5.cloudfront.net/AECO_CityMassingDemoPack_NVD%4010011.zip
https://d4i3qtqj3r0z5.cloudfront.net/Particles_NVD%4010010.zip
https://d4i3qtqj3r0z5.cloudfront.net/USD_Explorer_Sample_NVD%4010011.zip
https://d4i3qtqj3r0z5.cloudfront.net/Characters_NVD%4010012.zip
https://d4i3qtqj3r0z5.cloudfront.net/AECDemo_NVD%4010012.zip
https://d4i3qtqj3r0z5.cloudfront.net/AECO_RestaurantDemoPack_NVD%4010012.zip
https://d4i3qtqj3r0z5.cloudfront.net/AECO_CityTowerDemoPack_NVD%4010011.zip
https://d4i3qtqj3r0z5.cloudfront.net/Industrial_NVD%4010012.zip
https://d4i3qtqj3r0z5.cloudfront.net/Commercial_NVD%4010013.zip
https://d4i3qtqj3r0z5.cloudfront.net/XR_Content_NVD%4010010.zip
https://d4i3qtqj3r0z5.cloudfront.net/Configurator_Content_NVD%4010010.zip
https://d4i3qtqj3r0z5.cloudfront.net/Showcases_Content_NVD%4010011.zip
https://d4i3qtqj3r0z5.cloudfront.net/AECO_TowerDemoPack_NVD%4010012.zip
https://d4i3qtqj3r0z5.cloudfront.net/SimReady_Furniture_Misc_01_NVD%4010010.zip

https://d4i3qtqj3r0z5.cloudfront.net/Core_Demos_NVD%4010010.zip

https://d4i3qtqj3r0z5.cloudfront.net/Warehouse_NVD%4010013.zip
https://d4i3qtqj3r0z5.cloudfront.net/SimReady_Warehouse_01_NVD%4010010.zip
https://d4i3qtqj3r0z5.cloudfront.net/Residential_NVD%4010012.zip
https://d4i3qtqj3r0z5.cloudfront.net/Datacenter_NVD%4010012.zip
""".strip()


@dataclass(frozen=True)
class Pack:
    url: str
    name: str
    zip_filename: str


def parse_packs(text: str) -> list[Pack]:
    packs: list[Pack] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        parsed = urlparse(line)
        base = unquote(Path(parsed.path).name)  # turns %40 into '@'
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", base)
        name = safe.removesuffix(".zip")
        packs.append(Pack(url=line, name=name, zip_filename=safe))
    return packs


def fmt_bytes(n: int) -> str:
    units = ["B", "KiB", "MiB", "GiB", "TiB"]
    f = float(n)
    for u in units:
        if f < 1024.0 or u == units[-1]:
            return f"{int(f)} {u}" if u == "B" else f"{f:.2f} {u}"
        f /= 1024.0
    return f"{int(n)} B"


def ensure_tool(name: str) -> None:
    from shutil import which

    if which(name) is None:
        raise RuntimeError(f"Missing required tool: {name!r}. Please install it and re-run.")

def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def wget_download(url: str, out_zip: Path) -> None:
    out_zip.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["wget", "-c", "-O", str(out_zip), url], check=True)


def zip_uncompressed_size(zip_path: Path) -> int:
    with zipfile.ZipFile(zip_path, "r") as zf:
        return sum(int(i.file_size) for i in zf.infolist())


def unzip_extract(zip_path: Path, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(["unzip", "-q", str(zip_path), "-d", str(out_dir)], check=True)

def load_state(path: Path) -> dict:
    if not path.exists():
        return {"schema": 1, "packs": {}}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        # If the state file gets corrupted, don't brick downloads.
        return {"schema": 1, "packs": {}}


def save_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-gb", type=float, default=5.0, help="Max extracted (uncompressed) size in GiB.")
    ap.add_argument("--root", type=Path, default=Path("assets/external/omniverse"))
    ap.add_argument("--start-index", type=int, default=0, help="Start at this pack index (0-based).")
    ap.add_argument(
        "--state",
        type=Path,
        default=None,
        help="Path to JSON state file (default: <root>/download_state.json).",
    )
    ap.add_argument(
        "--only",
        action="append",
        default=[],
        help="Only process packs matching this pack name (repeatable).",
    )
    ap.add_argument(
        "--match",
        type=str,
        default="",
        help="Only process packs whose name matches this regex (in addition to --only).",
    )
    ap.add_argument(
        "--download-only",
        action="store_true",
        help="Download zips (and update state), but skip extraction.",
    )
    args = ap.parse_args()

    ensure_tool("wget")
    ensure_tool("unzip")

    packs = parse_packs(PACK_URLS_TEXT)
    if not packs:
        print("No pack URLs found.", file=sys.stderr)
        return 2

    only_list = [s.strip() for s in (args.only or []) if s.strip()]
    match_re = re.compile(args.match) if args.match else None
    if only_list:
        by_name = {p.name: p for p in packs}
        ordered: list[Pack] = []
        missing: list[str] = []
        for name in only_list:
            p = by_name.get(name)
            if p is None:
                missing.append(name)
                continue
            ordered.append(p)
        if missing:
            print("Unknown pack name(s) in --only:", ", ".join(missing), file=sys.stderr)
            print("Tip: pack names come from the URL filename (with '%40' -> '@', then sanitized).", file=sys.stderr)
            return 2
        packs = ordered

    if match_re:
        packs = [p for p in packs if match_re.search(p.name)]
        if not packs:
            print("No packs matched filters.", file=sys.stderr)
            return 2

    root: Path = args.root
    zips_dir = root / "zips"
    packs_dir = root / "packs"
    zips_dir.mkdir(parents=True, exist_ok=True)
    packs_dir.mkdir(parents=True, exist_ok=True)

    state_path: Path = args.state or (root / "download_state.json")
    state = load_state(state_path)
    state.setdefault("schema", 1)
    state.setdefault("packs", {})

    cap_bytes = int(args.max_gb * (1024**3))
    extracted_bytes = 0

    for i, pack in enumerate(packs[args.start_index :], start=args.start_index):
        zip_path = zips_dir / pack.zip_filename
        out_dir = packs_dir / pack.name

        print(f"\n[{i+1}/{len(packs)}] {pack.name}")
        print(f"  url: {pack.url}")

        pack_state = state["packs"].get(pack.name, {})
        pack_state.update(
            {
                "name": pack.name,
                "url": pack.url,
                "zip_filename": pack.zip_filename,
                "zip_path": str(zip_path),
                "out_dir": str(out_dir),
                "last_seen_at": utc_now_iso(),
            }
        )
        state["packs"][pack.name] = pack_state
        save_state(state_path, state)

        if not zip_path.exists() or zip_path.stat().st_size == 0:
            print("  downloading...")
            pack_state.setdefault("download_attempts", 0)
            pack_state["download_attempts"] += 1
            pack_state["download_started_at"] = utc_now_iso()
            save_state(state_path, state)
            wget_download(pack.url, zip_path)
            pack_state["download_finished_at"] = utc_now_iso()
        else:
            print(f"  zip exists ({fmt_bytes(zip_path.stat().st_size)}), skipping download")

        if args.download_only:
            pack_state["zip_size_bytes"] = int(zip_path.stat().st_size)
            pack_state["status"] = "downloaded"
            save_state(state_path, state)
            continue

        expected = zip_uncompressed_size(zip_path)
        remaining = cap_bytes - extracted_bytes
        pack_state["zip_size_bytes"] = int(zip_path.stat().st_size)
        pack_state["estimated_unpacked_bytes"] = int(expected)
        print(f"  estimated unpacked: {fmt_bytes(expected)} (remaining: {fmt_bytes(max(0, remaining))})")

        if expected > remaining:
            print("  STOP: extracting this pack would exceed --max-gb")
            pack_state["status"] = "stopped_before_extract_cap"
            save_state(state_path, state)
            break

        if out_dir.exists() and any(out_dir.iterdir()):
            print("  out dir already non-empty, skipping extract")
            pack_state["status"] = "already_extracted"
        else:
            print("  extracting...")
            pack_state.setdefault("extract_attempts", 0)
            pack_state["extract_attempts"] += 1
            pack_state["extract_started_at"] = utc_now_iso()
            save_state(state_path, state)
            unzip_extract(zip_path, out_dir)
            pack_state["extract_finished_at"] = utc_now_iso()
            pack_state["status"] = "extracted"

        extracted_bytes += expected
        print(f"  total extracted estimate: {fmt_bytes(extracted_bytes)} / {fmt_bytes(cap_bytes)}")
        save_state(state_path, state)

        if extracted_bytes >= cap_bytes:
            print("  reached --max-gb cap; stopping")
            pack_state["status"] = "stopped_after_extract_cap"
            save_state(state_path, state)
            break

    print("\nDone.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())