#!/usr/bin/env python3
"""
Convert Halo-style JMS text meshes into a basic GLB (mesh + materials).

Supported JMS sections:
- MATERIALS
- VERTICES
- TRIANGLES

This converter intentionally ignores markers/physics/constraints sections.
Output is a static mesh that can be loaded by GLTFLoader in this repo.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from dataclasses import dataclass
from pathlib import Path


def _is_comment_or_blank(s: str) -> bool:
    t = s.strip()
    return (not t) or t.startswith(";")


def _next_data_line(lines: list[str], i: int) -> int:
    n = len(lines)
    while i < n and _is_comment_or_blank(lines[i]):
        i += 1
    if i >= n:
        raise ValueError("Unexpected EOF while reading JMS data.")
    return i


def _seek_exact(lines: list[str], text: str, start: int = 0) -> int:
    for i in range(start, len(lines)):
        if lines[i].strip() == text:
            return i
    raise ValueError(f"Missing JMS section/header: {text}")


def _seek_prefix(lines: list[str], prefix: str, start: int) -> int:
    for i in range(start, len(lines)):
        if lines[i].strip().startswith(prefix):
            return i
    raise ValueError(f"Missing JMS record prefix: {prefix}")


def _parse_int(line: str) -> int:
    return int(line.strip().split()[0])


def _parse_floats(line: str, count: int) -> list[float]:
    vals = [float(x) for x in line.strip().split()]
    if len(vals) < count:
        raise ValueError(f"Expected at least {count} floats, got {len(vals)} from: {line!r}")
    return vals[:count]


def _parse_ints(line: str, count: int) -> list[int]:
    vals = [int(x) for x in line.strip().split()]
    if len(vals) < count:
        raise ValueError(f"Expected at least {count} ints, got {len(vals)} from: {line!r}")
    return vals[:count]


@dataclass
class JmsMesh:
    materials: list[str]
    positions: list[float]  # flattened xyz
    normals: list[float]  # flattened xyz
    uvs: list[float]  # flattened uv
    tris_by_material: dict[int, list[int]]  # material index -> flattened triangle vertex indices


def _apply_axis_to_vec3(x: float, y: float, z: float, axis_mode: str) -> tuple[float, float, float]:
    """
    Axis conversion from JMS-space into glTF-space.

    - none: keep coordinates as-is.
    - halo_zup_to_gltf_yup: rotate -90deg around +X, so Z-up becomes Y-up.
      (x, y, z) -> (x, z, -y)
    """
    mode = str(axis_mode or "halo_zup_to_gltf_yup").strip().lower()
    if mode == "none":
        return x, y, z
    if mode == "halo_zup_to_gltf_yup":
        return x, z, -y
    raise ValueError(f"Unsupported axis mode: {axis_mode}")


def parse_jms(path: Path, *, axis_mode: str = "halo_zup_to_gltf_yup") -> JmsMesh:
    lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()

    # MATERIALS
    mat_hdr = _seek_exact(lines, ";### MATERIALS ###")
    i = _next_data_line(lines, mat_hdr + 1)
    mat_count = _parse_int(lines[i])
    i += 1

    materials: list[str] = []
    for _ in range(mat_count):
        i = _seek_prefix(lines, ";MATERIAL", i)
        i = _next_data_line(lines, i + 1)
        mat_name = lines[i].strip()
        i = _next_data_line(lines, i + 1)
        mat_slot_info = lines[i].strip()
        # Preserve both human-readable fields so duplicate base names remain distinguishable.
        materials.append(f"{mat_name} {mat_slot_info}".strip())
        i += 1

    # VERTICES
    v_hdr = _seek_exact(lines, ";### VERTICES ###", i)
    i = _next_data_line(lines, v_hdr + 1)
    v_count = _parse_int(lines[i])
    i += 1

    positions: list[float] = []
    normals: list[float] = []
    uvs: list[float] = []

    for _ in range(v_count):
        i = _seek_prefix(lines, ";VERTEX", i)

        i = _next_data_line(lines, i + 1)
        px, py, pz = _parse_floats(lines[i], 3)
        px, py, pz = _apply_axis_to_vec3(px, py, pz, axis_mode)
        positions.extend((px, py, pz))

        i = _next_data_line(lines, i + 1)
        nx, ny, nz = _parse_floats(lines[i], 3)
        nx, ny, nz = _apply_axis_to_vec3(nx, ny, nz, axis_mode)
        normals.extend((nx, ny, nz))

        i = _next_data_line(lines, i + 1)
        influence_count = _parse_int(lines[i])
        i += 1
        for _inf in range(max(0, influence_count)):
            i = _next_data_line(lines, i)  # node index
            i = _next_data_line(lines, i + 1)  # node weight
            i += 1

        i = _next_data_line(lines, i)
        uv_count = _parse_int(lines[i])
        i += 1
        u = 0.0
        v = 0.0
        for uv_i in range(max(0, uv_count)):
            i = _next_data_line(lines, i)
            uu, vv = _parse_floats(lines[i], 2)
            if uv_i == 0:
                u, v = uu, vv
            i += 1
        uvs.extend((u, v))

        i = _next_data_line(lines, i)
        _ = _parse_floats(lines[i], 3)  # color, ignored for now
        i += 1

    # TRIANGLES
    t_hdr = _seek_exact(lines, ";### TRIANGLES ###", i)
    i = _next_data_line(lines, t_hdr + 1)
    tri_count = _parse_int(lines[i])
    i += 1

    tris_by_material: dict[int, list[int]] = {}
    for _ in range(tri_count):
        i = _seek_prefix(lines, ";TRIANGLE", i)

        i = _next_data_line(lines, i + 1)
        mat_idx = _parse_int(lines[i])

        i = _next_data_line(lines, i + 1)
        v0, v1, v2 = _parse_ints(lines[i], 3)
        tris_by_material.setdefault(mat_idx, []).extend((v0, v1, v2))
        i += 1

    return JmsMesh(
        materials=materials,
        positions=positions,
        normals=normals,
        uvs=uvs,
        tris_by_material=tris_by_material,
    )


class BufferBuilder:
    def __init__(self) -> None:
        self.buf = bytearray()

    def append(self, data: bytes, align: int = 4) -> tuple[int, int]:
        while align > 1 and (len(self.buf) % align) != 0:
            self.buf.append(0)
        off = len(self.buf)
        self.buf.extend(data)
        return off, len(data)

    def bytes(self) -> bytes:
        return bytes(self.buf)


def _pack_f32(values: list[float]) -> bytes:
    if not values:
        return b""
    return struct.pack("<" + ("f" * len(values)), *values)


def _pack_u16(values: list[int]) -> bytes:
    if not values:
        return b""
    return struct.pack("<" + ("H" * len(values)), *values)


def _pack_u32(values: list[int]) -> bytes:
    if not values:
        return b""
    return struct.pack("<" + ("I" * len(values)), *values)


def _image_mime_for_path(path: Path) -> str:
    ext = path.suffix.lower()
    if ext == ".png":
        return "image/png"
    if ext in (".jpg", ".jpeg"):
        return "image/jpeg"
    if ext == ".webp":
        return "image/webp"
    raise ValueError(f"Unsupported image format for glTF embedding: {path.suffix}")


def _min_max_positions(flat_xyz: list[float]) -> tuple[list[float], list[float]]:
    if not flat_xyz:
        return [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]
    xs = flat_xyz[0::3]
    ys = flat_xyz[1::3]
    zs = flat_xyz[2::3]
    return [min(xs), min(ys), min(zs)], [max(xs), max(ys), max(zs)]


def build_glb(
    mesh: JmsMesh,
    *,
    base_color_image_bytes: bytes | None = None,
    base_color_image_mime: str = "",
    base_color_image_name: str = "",
) -> bytes:
    if len(mesh.positions) == 0:
        raise ValueError("JMS has no vertices.")
    if not mesh.tris_by_material:
        raise ValueError("JMS has no triangles.")

    vertex_count = len(mesh.positions) // 3
    if len(mesh.normals) // 3 != vertex_count:
        raise ValueError("Vertex normals count does not match position count.")
    if len(mesh.uvs) // 2 != vertex_count:
        raise ValueError("Vertex UV count does not match position count.")

    b = BufferBuilder()
    buffer_views: list[dict] = []
    accessors: list[dict] = []
    materials: list[dict] = []
    samplers: list[dict] = []
    textures: list[dict] = []
    images: list[dict] = []

    # Positions
    pos_min, pos_max = _min_max_positions(mesh.positions)
    pos_off, pos_len = b.append(_pack_f32(mesh.positions), align=4)
    pos_bv = len(buffer_views)
    buffer_views.append({"buffer": 0, "byteOffset": pos_off, "byteLength": pos_len, "target": 34962})
    pos_acc = len(accessors)
    accessors.append(
        {
            "bufferView": pos_bv,
            "componentType": 5126,  # FLOAT
            "count": vertex_count,
            "type": "VEC3",
            "min": pos_min,
            "max": pos_max,
        }
    )

    # Normals
    nrm_off, nrm_len = b.append(_pack_f32(mesh.normals), align=4)
    nrm_bv = len(buffer_views)
    buffer_views.append({"buffer": 0, "byteOffset": nrm_off, "byteLength": nrm_len, "target": 34962})
    nrm_acc = len(accessors)
    accessors.append(
        {
            "bufferView": nrm_bv,
            "componentType": 5126,  # FLOAT
            "count": vertex_count,
            "type": "VEC3",
        }
    )

    # UVs
    uv_off, uv_len = b.append(_pack_f32(mesh.uvs), align=4)
    uv_bv = len(buffer_views)
    buffer_views.append({"buffer": 0, "byteOffset": uv_off, "byteLength": uv_len, "target": 34962})
    uv_acc = len(accessors)
    accessors.append(
        {
            "bufferView": uv_bv,
            "componentType": 5126,  # FLOAT
            "count": vertex_count,
            "type": "VEC2",
        }
    )

    # Optional shared base color texture for all materials.
    base_color_tex_idx: int | None = None
    if base_color_image_bytes:
        img_off, img_len = b.append(base_color_image_bytes, align=4)
        img_bv = len(buffer_views)
        buffer_views.append({"buffer": 0, "byteOffset": img_off, "byteLength": img_len})
        images.append(
            {
                "name": base_color_image_name or "baseColorTexture",
                "bufferView": img_bv,
                "mimeType": base_color_image_mime or "image/png",
            }
        )
        samplers.append({"magFilter": 9729, "minFilter": 9729, "wrapS": 10497, "wrapT": 10497})
        textures.append({"sampler": 0, "source": 0, "name": base_color_image_name or "baseColorTexture"})
        base_color_tex_idx = 0

    # Materials in JMS order
    for i, mname in enumerate(mesh.materials):
        pbr = {
            "baseColorFactor": [0.8, 0.8, 0.8, 1.0],
            "metallicFactor": 0.0,
            "roughnessFactor": 1.0,
        }
        if base_color_tex_idx is not None:
            pbr["baseColorTexture"] = {"index": base_color_tex_idx}
        materials.append(
            {
                "name": mname if mname else f"material_{i}",
                "pbrMetallicRoughness": pbr,
                "doubleSided": False,
            }
        )

    primitives: list[dict] = []
    for mat_idx in sorted(mesh.tris_by_material.keys()):
        idx = mesh.tris_by_material[mat_idx]
        if not idx:
            continue
        max_i = max(idx)
        if max_i >= vertex_count or min(idx) < 0:
            raise ValueError(f"Triangle references out-of-range vertex index for material {mat_idx}.")

        if max_i <= 65535:
            idx_component_type = 5123  # UNSIGNED_SHORT
            idx_bytes = _pack_u16(idx)
        else:
            idx_component_type = 5125  # UNSIGNED_INT
            idx_bytes = _pack_u32(idx)

        idx_off, idx_len = b.append(idx_bytes, align=4)
        idx_bv = len(buffer_views)
        buffer_views.append({"buffer": 0, "byteOffset": idx_off, "byteLength": idx_len, "target": 34963})
        idx_acc = len(accessors)
        accessors.append(
            {
                "bufferView": idx_bv,
                "componentType": idx_component_type,
                "count": len(idx),
                "type": "SCALAR",
                "min": [min(idx)],
                "max": [max_i],
            }
        )

        primitive = {
            "attributes": {"POSITION": pos_acc, "NORMAL": nrm_acc, "TEXCOORD_0": uv_acc},
            "indices": idx_acc,
            "mode": 4,  # TRIANGLES
        }
        if 0 <= mat_idx < len(materials):
            primitive["material"] = mat_idx
        primitives.append(primitive)

    if not primitives:
        raise ValueError("No triangle primitives generated.")

    gltf = {
        "asset": {"version": "2.0", "generator": "tools/jms_to_glb.py"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "JMSMesh"}],
        "meshes": [{"name": "JMSMesh", "primitives": primitives}],
        "materials": materials,
        "buffers": [{"byteLength": len(b.buf)}],
        "bufferViews": buffer_views,
        "accessors": accessors,
    }
    if images:
        gltf["images"] = images
    if samplers:
        gltf["samplers"] = samplers
    if textures:
        gltf["textures"] = textures

    json_chunk = json.dumps(gltf, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    while len(json_chunk) % 4 != 0:
        json_chunk += b" "

    bin_chunk = b.bytes()
    while len(bin_chunk) % 4 != 0:
        bin_chunk += b"\x00"

    # GLB header
    # magic(4) + version(4) + length(4)
    # JSON chunk: chunkLength(4) + chunkType(4='JSON') + data
    # BIN chunk:  chunkLength(4) + chunkType(4='BIN\0') + data
    total_len = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
    out = bytearray()
    out.extend(struct.pack("<4sII", b"glTF", 2, total_len))
    out.extend(struct.pack("<II", len(json_chunk), 0x4E4F534A))
    out.extend(json_chunk)
    out.extend(struct.pack("<II", len(bin_chunk), 0x004E4942))
    out.extend(bin_chunk)
    return bytes(out)


def main() -> int:
    ap = argparse.ArgumentParser(description="Convert Halo JMS text mesh to GLB.")
    ap.add_argument("--in", dest="input", required=True, help="Input .JMS file")
    ap.add_argument("--out", dest="output", required=True, help="Output .glb file")
    ap.add_argument(
        "--axis",
        default="halo_zup_to_gltf_yup",
        choices=["halo_zup_to_gltf_yup", "none"],
        help="Axis conversion mode before writing GLB.",
    )
    ap.add_argument(
        "--base-color-texture",
        default="",
        help="Optional image (.png/.jpg/.jpeg/.webp) embedded and applied to all materials as baseColorTexture.",
    )
    args = ap.parse_args()

    inp = Path(args.input).resolve()
    out = Path(args.output).resolve()

    if not inp.exists():
        print(f"Input not found: {inp}", file=sys.stderr)
        return 2
    if inp.suffix.lower() != ".jms":
        print(f"Warning: input does not end with .jms: {inp}", file=sys.stderr)

    tex_bytes: bytes | None = None
    tex_mime = ""
    tex_name = ""
    tex_arg = Path(args.base_color_texture).expanduser().resolve() if str(args.base_color_texture or "").strip() else None
    if tex_arg is not None:
        if not tex_arg.exists():
            print(f"Base color texture not found: {tex_arg}", file=sys.stderr)
            return 2
        try:
            tex_mime = _image_mime_for_path(tex_arg)
            tex_bytes = tex_arg.read_bytes()
            tex_name = tex_arg.name
        except Exception as e:
            print(f"Texture read/validation failed: {e}", file=sys.stderr)
            return 2

    try:
        mesh = parse_jms(inp, axis_mode=args.axis)
        glb = build_glb(
            mesh,
            base_color_image_bytes=tex_bytes,
            base_color_image_mime=tex_mime,
            base_color_image_name=tex_name,
        )
    except Exception as e:
        print(f"Conversion failed: {e}", file=sys.stderr)
        return 2

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(glb)
    print(f"Wrote GLB: {out}")
    print(f"Vertices: {len(mesh.positions)//3}")
    print(f"Triangles: {sum(len(v) for v in mesh.tris_by_material.values())//3}")
    print(f"Materials: {len(mesh.materials)}")
    if tex_bytes:
        print(f"Embedded base-color texture: {tex_name} ({tex_mime}, {len(tex_bytes)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
