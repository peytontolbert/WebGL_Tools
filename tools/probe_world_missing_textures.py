#!/usr/bin/env python3
"""
Probe *valid texture references from world entities* that are NOT exported.

This tool connects:
  - assets/entities_chunks_inst/*.bin  (ENT1 instance bins; includes archetype hashes)
  - assets/models/manifest_shards/*.json (per-archetype submeshes + material texture relpaths)
  - assets/models_textures/index.json (+ models_textures_ktx2/index.json)

Output:
  - A JSON report listing texture hashes that are referenced by world-used archetypes but are missing
    from exported indices / missing on disk.

Why this exists:
  - In a full streamed world, you can encounter millions of entities.
  - Letting the viewer "probe" missing textures causes huge 404 spam.
  - This tool gives you a deterministic list of missing exports to backfill.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import struct
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional, Tuple


_RE_MODEL_TEX = re.compile(r"^models_textures/(\d+)(?:_[^/]+)?\.(png|dds|jpg|jpeg|webp|ktx2)$", re.IGNORECASE)
_RE_MODEL_TEX_KTX2 = re.compile(r"^models_textures_ktx2/(\d+)(?:_[^/]+)?\.(ktx2)$", re.IGNORECASE)


def _load_index_byhash(p: Path) -> Dict[str, object]:
    try:
        d = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return {}
    if isinstance(d, dict) and isinstance(d.get("byHash"), dict):
        return d.get("byHash") or {}
    return d if isinstance(d, dict) else {}


def _read_manifest_index_header(models_dir: Path) -> Tuple[int, int, str]:
    """
    Returns: (shard_bits, shard_count, shard_dir)
    """
    p = models_dir / "manifest_index.json"
    shard_bits = 8
    shard_count = 256
    shard_dir = "manifest_shards"
    try:
        # Avoid loading huge JSON: parse a small prefix.
        with open(p, "rb") as f:
            head = f.read(8192)
        s = head.decode("utf-8", errors="ignore")
        m = re.search(r"\"shard_bits\"\\s*:\\s*(\\d+)", s)
        if m:
            shard_bits = max(4, min(12, int(m.group(1))))
        m = re.search(r"\"shard_count\"\\s*:\\s*(\\d+)", s)
        if m:
            shard_count = max(1, int(m.group(1)))
        m = re.search(r"\"shard_dir\"\\s*:\\s*\"([^\"]+)\"", s)
        if m:
            shard_dir = str(m.group(1))
    except Exception:
        pass
    return shard_bits, shard_count, shard_dir


def _ent1_stride(path: Path, count: int) -> int:
    """
    ENT1 formats:
      v1: 44 bytes
      v2: 48 bytes
      v3: 64 bytes
      v4: 72 bytes
    """
    try:
        size = int(path.stat().st_size)
    except Exception:
        return 44
    payload = max(0, size - 8)
    if count <= 0:
        return 44
    stride0 = payload // int(count)
    if stride0 in (44, 48, 64, 72):
        return int(stride0)
    # Nearest known stride.
    cand = min((44, 48, 64, 72), key=lambda s: abs(int(s) - int(stride0)))
    return int(cand)


def _iter_ent1_archetypes(path: Path) -> Iterator[int]:
    with open(path, "rb") as f:
        head = f.read(8)
        if len(head) != 8 or head[:4] != b"ENT1":
            return
        count = struct.unpack("<I", head[4:8])[0]
        stride = _ent1_stride(path, int(count))
        remaining = int(count) * int(stride)
        bufsize = 1024 * 1024
        carry = b""
        while remaining > 0:
            take = min(bufsize, remaining)
            data = f.read(take)
            if not data:
                break
            remaining -= len(data)
            data = carry + data
            nrec = len(data) // stride
            end = nrec * stride
            mv = memoryview(data)
            for r in range(nrec):
                off = r * stride
                h = struct.unpack_from("<I", mv, off)[0]
                yield int(h) & 0xFFFFFFFF
            carry = bytes(mv[end:])


def _iter_material_texture_rels(mat: object) -> Iterator[str]:
    if not isinstance(mat, dict):
        return
    for _k, v in mat.items():
        if isinstance(v, str):
            s = v.strip().lstrip("/")
            if s.startswith("assets/"):
                s = s[7:]
            if s.startswith("models_textures/") or s.startswith("models_textures_ktx2/"):
                yield s


@dataclass
class TexRef:
    rel: str
    kind: str  # 'png' or 'ktx2'
    hash_str: str


def _parse_tex_rel(rel: str) -> Optional[TexRef]:
    r = str(rel or "").strip().lstrip("/")
    if r.startswith("assets/"):
        r = r[7:]
    m = _RE_MODEL_TEX.match(r)
    if m:
        return TexRef(rel=f"models_textures/{m.group(1)}.{m.group(2).lower()}", kind="png", hash_str=str(m.group(1)))
    m = _RE_MODEL_TEX_KTX2.match(r)
    if m:
        return TexRef(rel=f"models_textures_ktx2/{m.group(1)}.ktx2", kind="ktx2", hash_str=str(m.group(1)))
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--assets-dir", required=True, help="Path to webgl_viewer/assets")
    ap.add_argument("--max-archetypes", type=int, default=20000, help="Limit archetypes scanned (by instance frequency). 0=all")
    ap.add_argument("--max-shards", type=int, default=0, help="Limit number of manifest shards loaded (debug). 0=all")
    ap.add_argument("--out", default="", help="Write JSON report to this path (default: tools/out/world_missing_textures.json)")
    args = ap.parse_args()

    assets_dir = Path(str(args.assets_dir)).resolve()
    inst_dir = assets_dir / "entities_chunks_inst"
    models_dir = assets_dir / "models"
    shards_dir = models_dir / "manifest_shards"
    tex_dir = assets_dir / "models_textures"
    tex_k_dir = assets_dir / "models_textures_ktx2"
    out_path = Path(str(args.out)).resolve() if str(args.out).strip() else (assets_dir.parent / "tools" / "out" / "world_missing_textures.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    arch_counts: Counter[int] = Counter()

    # 1) Archetypes used by world entities (counted by instances).
    bins = sorted(inst_dir.glob("*.bin"))
    for p in bins:
        try:
            for h in _iter_ent1_archetypes(p):
                arch_counts[h] += 1
        except Exception:
            continue

    arch_total = len(arch_counts)
    if args.max_archetypes and args.max_archetypes > 0:
        keep = set([h for h, _c in arch_counts.most_common(int(args.max_archetypes))])
        arch_counts = Counter({h: c for h, c in arch_counts.items() if h in keep})

    # 2) Load texture indices (exported set).
    idx_png = _load_index_byhash(assets_dir / "models_textures" / "index.json")
    idx_k = _load_index_byhash(assets_dir / "models_textures_ktx2" / "index.json")

    # 3) Load manifest shards for the archetypes and gather referenced textures.
    shard_bits, _shard_count, shard_dir_name = _read_manifest_index_header(models_dir)
    mask = (1 << int(shard_bits)) - 1
    shard_dir = models_dir / str(shard_dir_name)

    # Group archetypes by shard for efficient shard loads.
    shard_to_arch: Dict[int, List[int]] = defaultdict(list)
    for h in arch_counts.keys():
        shard_to_arch[int(h) & mask].append(int(h))

    shard_ids = sorted(shard_to_arch.keys())
    if args.max_shards and args.max_shards > 0:
        shard_ids = shard_ids[: int(args.max_shards)]

    tex_ref_instances: Counter[str] = Counter()  # rel -> weighted instance refs
    tex_ref_arches: Dict[str, List[int]] = defaultdict(list)  # rel -> sample archetypes
    missing_mesh_arches = 0

    # shard filename: low bits hex (2 chars for 8 bits, 3 for 12, etc.)
    hexw = max(1, (int(shard_bits) + 3) // 4)

    shard_loaded = 0
    for sid in shard_ids:
        sp = shard_dir / (f"{int(sid):0{hexw}x}.json")
        if not sp.exists():
            continue
        try:
            shard = json.loads(sp.read_text(encoding="utf-8", errors="ignore"))
        except Exception:
            continue
        meshes = shard.get("meshes") if isinstance(shard, dict) else None
        if not isinstance(meshes, dict):
            continue

        for h in shard_to_arch.get(int(sid), []):
            ent = meshes.get(str(int(h)))
            if not isinstance(ent, dict):
                missing_mesh_arches += 1
                continue
            lods = ent.get("lods")
            if not isinstance(lods, dict):
                continue
            # Scan all lods; textures can differ.
            for _lod, lodent in lods.items():
                if not isinstance(lodent, dict):
                    continue
                subs = lodent.get("submeshes")
                if not isinstance(subs, list):
                    continue
                for sm in subs:
                    if not isinstance(sm, dict):
                        continue
                    mat = sm.get("material")
                    for rel in _iter_material_texture_rels(mat):
                        tr = _parse_tex_rel(rel)
                        if not tr:
                            continue
                        tex_ref_instances[tr.rel] += int(arch_counts.get(h, 1))
                        # Keep a small sample of archetypes for debugging.
                        if len(tex_ref_arches[tr.rel]) < 8:
                            tex_ref_arches[tr.rel].append(int(h))

        shard_loaded += 1

    # 4) Determine which referenced textures are missing from export/index/filesystem.
    missing = []
    for rel, weight in tex_ref_instances.most_common():
        tr = _parse_tex_rel(rel)
        if not tr:
            continue
        if tr.kind == "png":
            ent = idx_png.get(tr.hash_str)
            in_index = ent is not None
            # Check filesystem existence (hash-only + preferredFile if any).
            exists = False
            cand = [tex_dir / f"{tr.hash_str}.png"]
            if isinstance(ent, dict):
                pf = str(ent.get("preferredFile") or "").strip()
                if pf:
                    cand.append(tex_dir / pf)
            for cp in cand:
                try:
                    if cp.exists():
                        exists = True
                        break
                except Exception:
                    pass
            if in_index and exists:
                continue  # exported ok
            missing.append({
                "hash": int(tr.hash_str),
                "hashStr": tr.hash_str,
                "rel": tr.rel,
                "kind": "png",
                "weightedRefs": int(weight),
                "inIndex": bool(in_index),
                "fileExists": bool(exists),
                "exampleArchetypes": [int(x) for x in tex_ref_arches.get(tr.rel, [])],
            })
        else:
            ent = idx_k.get(tr.hash_str)
            in_index = ent is not None
            exists = False
            cand = [tex_k_dir / f"{tr.hash_str}.ktx2"]
            if isinstance(ent, dict):
                pf = str(ent.get("preferredFile") or "").strip()
                if pf:
                    cand.append(tex_k_dir / pf)
            for cp in cand:
                try:
                    if cp.exists():
                        exists = True
                        break
                except Exception:
                    pass
            if in_index and exists:
                continue
            missing.append({
                "hash": int(tr.hash_str),
                "hashStr": tr.hash_str,
                "rel": tr.rel,
                "kind": "ktx2",
                "weightedRefs": int(weight),
                "inIndex": bool(in_index),
                "fileExists": bool(exists),
                "exampleArchetypes": [int(x) for x in tex_ref_arches.get(tr.rel, [])],
            })

    dt = max(0.001, time.time() - t0)
    out = {
        "schema": "webglgta-world-missing-textures-v1",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "assetsDir": str(assets_dir),
        "stats": {
            "entityInstBins": len(bins),
            "worldArchetypesDistinct": int(arch_total),
            "worldArchetypesScanned": int(len(arch_counts)),
            "manifestShardBits": int(shard_bits),
            "manifestShardsLoaded": int(shard_loaded),
            "missingMeshArchetypes": int(missing_mesh_arches),
            "referencedTexturesDistinct": int(len(tex_ref_instances)),
            "missingTextures": int(len(missing)),
            "seconds": float(dt),
        },
        "missing": missing,
    }
    out_path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"Wrote: {out_path}  (missing={len(missing)} referenced={len(tex_ref_instances)} archetypes={len(arch_counts)} shardsLoaded={shard_loaded} seconds={dt:.1f})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


