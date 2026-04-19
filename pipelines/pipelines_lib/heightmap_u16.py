from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class HeightmapU16:
    width: int
    height: int
    heights_u16: list[int]  # row-major


def write_heightmap_u16(out_dir: Path, hm: HeightmapU16, *, endian: str = "little", min_z: float | None = None, max_z: float | None = None, bbox: dict | None = None) -> tuple[Path, Path]:
    """
    Writes the viewer's heightmap format:
      meta.json: { width, height, file, endian, minZ?, maxZ?, bbox? }
      heights.u16.bin: raw uint16, row-major
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    bin_path = out_dir / "heights.u16.bin"
    meta_path = out_dir / "meta.json"

    w = int(hm.width)
    h = int(hm.height)
    if w < 2 or h < 2:
        raise ValueError("heightmap must be at least 2x2")
    if len(hm.heights_u16) < w * h:
        raise ValueError(f"heightmap buffer too small: {len(hm.heights_u16)} < {w*h}")

    # Write bin (uint16).
    # Keep explicit endianness to match runtime loader.
    if endian not in ("little", "big"):
        raise ValueError("endian must be 'little' or 'big'")
    b = bytearray()
    for i in range(w * h):
        v = int(hm.heights_u16[i]) & 0xFFFF
        if endian == "little":
            b.append(v & 0xFF)
            b.append((v >> 8) & 0xFF)
        else:
            b.append((v >> 8) & 0xFF)
            b.append(v & 0xFF)
    bin_path.write_bytes(bytes(b))

    meta = {"width": w, "height": h, "file": bin_path.name, "endian": endian}
    if min_z is not None:
        meta["minZ"] = float(min_z)
    if max_z is not None:
        meta["maxZ"] = float(max_z)
    if bbox is not None:
        meta["bbox"] = bbox
    meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return meta_path, bin_path

