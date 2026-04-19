from __future__ import annotations

import datetime as dt
import json
import math
import struct
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple


UTC = getattr(dt, "UTC", dt.timezone.utc)


def _read_i32(f) -> int:
    return struct.unpack("<i", f.read(4))[0]


def _read_u16s(f, count: int) -> Tuple[int, ...]:
    if count <= 0:
        return tuple()
    return struct.unpack(f"<{count}H", f.read(count * 2))


def _read_f32(f) -> float:
    return struct.unpack("<f", f.read(4))[0]


def _read_string(f, n: int) -> str:
    if n <= 0:
        return ""
    return f.read(n).decode("utf-8", errors="replace")


def _mat4_identity() -> List[List[float]]:
    return [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]


def _mat4_mul(a: List[List[float]], b: List[List[float]]) -> List[List[float]]:
    # We preserve the (somewhat unusual) multiplication conventions used by common KN5 OBJ dumpers.
    out = [[0.0] * 4 for _ in range(4)]
    for i in range(4):
        ai0, ai1, ai2, ai3 = a[i]
        for j in range(4):
            out[i][j] = ai0 * b[0][j] + ai1 * b[1][j] + ai2 * b[2][j] + ai3 * b[3][j]
    return out


def _apply_mat_pos(m: List[List[float]], x: float, y: float, z: float) -> Tuple[float, float, float]:
    # Matches the convention used by many existing KN5 -> OBJ scripts.
    vx = m[0][0] * x + m[1][0] * y + m[2][0] * z + m[3][0]
    vy = m[0][1] * x + m[1][1] * y + m[2][1] * z + m[3][1]
    vz = m[0][2] * x + m[1][2] * y + m[2][2] * z + m[3][2]
    return vx, vy, vz


def _apply_mat_nrm(m: List[List[float]], x: float, y: float, z: float) -> Tuple[float, float, float]:
    nx = m[0][0] * x + m[1][0] * y + m[2][0] * z
    ny = m[0][1] * x + m[1][1] * y + m[2][1] * z
    nz = m[0][2] * x + m[1][2] * y + m[2][2] * z
    # Normalize for stability.
    l = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
    return nx / l, ny / l, nz / l


def _is_transparent_shader(shader: str) -> bool:
    s = (shader or "").strip()
    return (
        s.startswith("ksPerPixelAT")
        or s in {"ksPerPixelAlpha", "ksSkidMark", "ksTree", "ksGrass", "ksFlags"}
    )


@dataclass
class Kn5Material:
    name: str = ""
    shader: str = ""
    props: Dict[str, float] = field(default_factory=dict)
    samples: Dict[str, str] = field(default_factory=dict)  # sampleName -> textureName

    @property
    def tx_diffuse(self) -> str:
        return str(self.samples.get("txDiffuse", "") or "")

    @property
    def tx_normal(self) -> str:
        return str(self.samples.get("txNormal", "") or "")


@dataclass
class Kn5Node:
    type: int = 1  # 1 dummy, 2 mesh, 3 skinned mesh
    name: str = "Default"
    parent: int = -1
    tmatrix: List[List[float]] = field(default_factory=_mat4_identity)
    hmatrix: List[List[float]] = field(default_factory=_mat4_identity)
    material_id: int = -1
    vertex_count: int = 0
    pos: List[float] = field(default_factory=list)
    nrm: List[float] = field(default_factory=list)
    uv0: List[float] = field(default_factory=list)
    indices: Tuple[int, ...] = field(default_factory=tuple)


def _read_nodes(f, nodes: List[Kn5Node], parent_id: int) -> List[Kn5Node]:
    n = Kn5Node()
    n.parent = parent_id

    n.type = _read_i32(f)
    n.name = _read_string(f, _read_i32(f))
    children_count = _read_i32(f)
    f.read(1)  # unknown byte

    if n.type == 1:
        # dummy node with transform matrix
        m = [[0.0] * 4 for _ in range(4)]
        for i in range(4):
            for j in range(4):
                m[i][j] = _read_f32(f)
        n.tmatrix = m
    elif n.type == 2:
        # mesh
        f.read(3)  # unknown bytes
        n.vertex_count = _read_i32(f)
        n.pos = []
        n.nrm = []
        n.uv0 = []
        for _ in range(n.vertex_count):
            n.pos.extend(struct.unpack("<fff", f.read(12)))
            n.nrm.extend(struct.unpack("<fff", f.read(12)))
            u, v = struct.unpack("<ff", f.read(8))
            n.uv0.extend([u, 1.0 - v])
            f.read(12)  # tangents
        index_count = _read_i32(f)
        n.indices = _read_u16s(f, index_count)
        n.material_id = _read_i32(f)
        f.read(29)  # unknown block
    elif n.type == 3:
        # skinned mesh
        f.read(3)  # unknown bytes
        bone_count = _read_i32(f)
        for _ in range(bone_count):
            _ = _read_string(f, _read_i32(f))
            f.read(64)  # bone matrix
        n.vertex_count = _read_i32(f)
        n.pos = []
        n.nrm = []
        n.uv0 = []
        for _ in range(n.vertex_count):
            n.pos.extend(struct.unpack("<fff", f.read(12)))
            n.nrm.extend(struct.unpack("<fff", f.read(12)))
            u, v = struct.unpack("<ff", f.read(8))
            n.uv0.extend([u, 1.0 - v])
            f.read(44)  # tangents + weights
        index_count = _read_i32(f)
        n.indices = _read_u16s(f, index_count)
        n.material_id = _read_i32(f)
        f.read(12)  # unknown block

    # Hierarchy matrix: preserve the convention used by common KN5 OBJ scripts.
    if parent_id < 0:
        n.hmatrix = n.tmatrix
    else:
        n.hmatrix = _mat4_mul(n.tmatrix, nodes[parent_id].hmatrix)

    nodes.append(n)
    cur_id = len(nodes) - 1
    for _ in range(children_count):
        _read_nodes(f, nodes, cur_id)
    return nodes


def export_kn5_to_obj(*, kn5_path: Path, out_dir: Path, obj_name: str) -> Dict[str, str]:
    """
    Convert a KN5 into:
      - <out_dir>/<obj_name>.obj
      - <out_dir>/<obj_name>.mtl
      - <out_dir>/texture/* (extracted embedded textures)
    """
    kn5_path = Path(kn5_path).resolve()
    out_dir = Path(out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    tex_dir = out_dir / "texture"
    tex_dir.mkdir(parents=True, exist_ok=True)

    materials: List[Kn5Material] = []
    nodes: List[Kn5Node] = []

    with kn5_path.open("rb") as f:
        header = f.read(10)
        if len(header) != 10:
            raise RuntimeError("KN5 header too short")
        magic, version = struct.unpack("<6sI", header)
        if version > 5:
            f.read(4)  # unknown

        # Embedded textures
        tex_count = _read_i32(f)
        for _ in range(tex_count):
            _tex_type = _read_i32(f)
            tex_name = _read_string(f, _read_i32(f))
            tex_size = _read_i32(f)
            if not tex_name or tex_size < 0:
                f.seek(max(0, tex_size), 1)
                continue
            out_tex = tex_dir / tex_name
            out_tex.parent.mkdir(parents=True, exist_ok=True)
            if out_tex.exists() and out_tex.is_file() and out_tex.stat().st_size == tex_size:
                f.seek(tex_size, 1)
            else:
                out_tex.write_bytes(f.read(tex_size))

        # Materials
        mat_count = _read_i32(f)
        for _ in range(mat_count):
            m = Kn5Material()
            m.name = _read_string(f, _read_i32(f))
            m.shader = _read_string(f, _read_i32(f))
            f.read(2)  # short
            if version > 4:
                f.read(4)  # int
            prop_count = _read_i32(f)
            for _ in range(prop_count):
                prop_name = _read_string(f, _read_i32(f))
                prop_value = _read_f32(f)
                if prop_name:
                    m.props[prop_name] = float(prop_value)
                f.read(36)  # unknown
            sample_count = _read_i32(f)
            for _ in range(sample_count):
                sample_name = _read_string(f, _read_i32(f))
                f.read(4)  # slot
                tex_name = _read_string(f, _read_i32(f))
                if sample_name and tex_name:
                    m.samples[sample_name] = tex_name
            materials.append(m)

        # Nodes/meshes
        nodes = _read_nodes(f, [], -1)

    # --- Write MTL ---
    mtl_path = (out_dir / obj_name).with_suffix(".mtl")
    lines: List[str] = []
    for m in materials:
        mat_name = (m.name or "mat").replace(" ", "_")
        lines.append(f"newmtl {mat_name}")
        # Very simple Phong-ish defaults; importer will map as best it can.
        lines.append("Ka 0.6 0.6 0.6")
        lines.append("Kd 0.6 0.6 0.6")
        lines.append("Ks 0.9 0.9 0.9")
        lines.append("Ns 64")
        lines.append("illum 2")
        if _is_transparent_shader(m.shader):
            lines.append("d 0.9999")
        if m.tx_diffuse:
            lines.append(f"map_Kd texture/{m.tx_diffuse}")
            if _is_transparent_shader(m.shader):
                lines.append(f"map_d texture/{m.tx_diffuse}")
        if m.tx_normal:
            lines.append(f"bump texture/{m.tx_normal}")
        lines.append("")
    mtl_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    # --- Write a small material->texture manifest (for runtime retexturing) ---
    materials_manifest_path = (out_dir / f"{obj_name}.materials.json").resolve()
    try:
        mats_out = []
        for m in materials:
            mats_out.append(
                {
                    "name": str(m.name or ""),
                    "shader": str(m.shader or ""),
                    "samples": {str(k): str(v) for k, v in (m.samples or {}).items()},
                    "props": {str(k): float(v) for k, v in (m.props or {}).items()},
                }
            )
        materials_manifest_path.write_text(
            json.dumps(
                {
                    "schema": "ac.kn5.materials.v1",
                    "source_kn5": kn5_path.as_posix(),
                    "count": len(mats_out),
                    "materials": mats_out,
                },
                indent=2,
                ensure_ascii=True,
            )
            + "\n",
            encoding="utf-8",
        )
    except Exception:
        # Non-critical.
        pass

    # --- Write OBJ ---
    obj_path = (out_dir / obj_name).with_suffix(".obj")
    bb_min = [1e18, 1e18, 1e18]
    bb_max = [-1e18, -1e18, -1e18]
    with obj_path.open("w", encoding="utf-8") as w:
        w.write("# Assetto Corsa model (KN5)\n")
        w.write(f"# Source: {kn5_path.as_posix()}\n")
        w.write(f"# Exported: {dt.datetime.now(UTC).isoformat()}\n")
        w.write(f"mtllib {mtl_path.name}\n\n")

        vertex_pad = 1
        for n in nodes:
            if n.type not in (2, 3):
                continue
            if (n.name or "").startswith("AC_"):
                continue
            group_name = (n.name or "mesh").replace(" ", "_")
            w.write(f"\ng {group_name}\n")

            # Positions
            for vi in range(n.vertex_count):
                x = float(n.pos[vi * 3 + 0])
                y = float(n.pos[vi * 3 + 1])
                z = float(n.pos[vi * 3 + 2])
                vx, vy, vz = _apply_mat_pos(n.hmatrix, x, y, z)
                w.write(f"v {vx} {vy} {vz}\n")
                if vx < bb_min[0]:
                    bb_min[0] = vx
                if vy < bb_min[1]:
                    bb_min[1] = vy
                if vz < bb_min[2]:
                    bb_min[2] = vz
                if vx > bb_max[0]:
                    bb_max[0] = vx
                if vy > bb_max[1]:
                    bb_max[1] = vy
                if vz > bb_max[2]:
                    bb_max[2] = vz

            # Normals
            for vi in range(n.vertex_count):
                x = float(n.nrm[vi * 3 + 0])
                y = float(n.nrm[vi * 3 + 1])
                z = float(n.nrm[vi * 3 + 2])
                nx, ny, nz = _apply_mat_nrm(n.hmatrix, x, y, z)
                w.write(f"vn {nx} {ny} {nz}\n")

            # UV0
            for vi in range(n.vertex_count):
                u = float(n.uv0[vi * 2 + 0])
                v = float(n.uv0[vi * 2 + 1])
                w.write(f"vt {u} {v}\n")

            # Material
            if 0 <= n.material_id < len(materials):
                mat_name = (materials[n.material_id].name or "mat").replace(" ", "_")
            else:
                mat_name = "Default"
            w.write(f"\nusemtl {mat_name}\n")

            # Faces
            idx = n.indices
            tri_count = len(idx) // 3
            for ti in range(tri_count):
                i1 = int(idx[ti * 3 + 0]) + vertex_pad
                i2 = int(idx[ti * 3 + 1]) + vertex_pad
                i3 = int(idx[ti * 3 + 2]) + vertex_pad
                w.write(f"f {i1}/{i1}/{i1} {i2}/{i2}/{i2} {i3}/{i3}/{i3}\n")

            vertex_pad += n.vertex_count

    return {
        "obj_path": obj_path.as_posix(),
        "mtl_path": mtl_path.as_posix(),
        "textures_dir": tex_dir.as_posix(),
        "materials_manifest_path": materials_manifest_path.as_posix(),
        "bounds_min": ",".join(str(float(x)) for x in bb_min),
        "bounds_max": ",".join(str(float(x)) for x in bb_max),
    }

