#!/usr/bin/env python3
"""
USD stage inspection (requires OpenUSD Python bindings: pxr).

Outputs a compact JSON summary:
- prim type histogram (top N)
- presence of skel/mesh/material primitives (best-effort)
- dependency scan via UsdUtils.ComputeAllDependencies (layers/assets/unresolved)
- missing files (resolved absolute paths that don't exist)

Designed to run in the repo's `conda trellis` environment.
"""

from __future__ import annotations

import argparse
import json
import os
from collections import Counter
from pathlib import Path


def _as_path_str(x) -> str:
    # UsdUtils.ComputeAllDependencies returns a mix of:
    # - Sdf layer objects (Sdf.Find(...)) -> has .realPath/.identifier
    # - strings for asset paths
    try:
        if hasattr(x, "realPath"):
            rp = str(getattr(x, "realPath") or "")
            if rp:
                return rp
    except Exception:
        pass
    try:
        if hasattr(x, "identifier"):
            ident = str(getattr(x, "identifier") or "")
            if ident:
                return ident
    except Exception:
        pass
    return str(x)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="input_path", required=True)
    ap.add_argument("--top", type=int, default=30)
    args = ap.parse_args()

    inp = Path(args.input_path).expanduser().resolve()
    if not inp.exists():
        print(json.dumps({"ok": False, "error": f"missing input: {str(inp)}"}))
        return 2

    try:
        from pxr import Ar, Usd, UsdSkel, UsdShade, UsdGeom, UsdUtils  # type: ignore
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"missing pxr (OpenUSD) python bindings: {e}"}))
        return 2

    stage = Usd.Stage.Open(str(inp))
    if not stage:
        print(json.dumps({"ok": False, "error": "Usd.Stage.Open returned None"}))
        return 2

    # Stage metadata (useful for debugging import/export assumptions).
    default_prim_path = ""
    try:
        dp = stage.GetDefaultPrim()
        if dp:
            default_prim_path = dp.GetPath().pathString
    except Exception:
        default_prim_path = ""

    up_axis = ""
    try:
        up_axis = str(UsdGeom.GetStageUpAxis(stage) or "")
    except Exception:
        up_axis = ""

    meters_per_unit = 0.0
    try:
        meters_per_unit = float(UsdGeom.GetStageMetersPerUnit(stage) or 0.0)
    except Exception:
        meters_per_unit = 0.0

    root_layer_ident = ""
    root_layer_real = ""
    try:
        rl = stage.GetRootLayer()
        root_layer_ident = str(getattr(rl, "identifier", "") or "")
        root_layer_real = str(getattr(rl, "realPath", "") or "")
    except Exception:
        root_layer_ident = ""
        root_layer_real = ""

    type_counts: Counter[str] = Counter()
    mesh_count = 0
    material_count = 0
    shader_count = 0
    skel_root_count = 0
    skel_anim_count = 0
    skel_skeleton_count = 0
    skel_bindings_count = 0

    # Composition arc signals (fast heuristics; not a full audit).
    prims_with_references = 0
    prims_with_payloads = 0
    prims_with_variants = 0
    prims_with_inherits = 0
    prims_with_specializes = 0

    for prim in stage.TraverseAll():
        t = prim.GetTypeName() or ""
        type_counts[t] += 1
        # Best-effort schema detection
        if t == "Mesh":
            mesh_count += 1
        elif t == "Material":
            material_count += 1
        elif t == "Shader":
            shader_count += 1
        elif t == "SkelRoot":
            skel_root_count += 1
        elif t == "Skeleton":
            skel_skeleton_count += 1
        elif t == "SkelAnimation":
            skel_anim_count += 1

        # Composition arcs (authored opinions on the prim).
        try:
            if prim.HasAuthoredReferences():
                prims_with_references += 1
        except Exception:
            pass
        try:
            if prim.HasAuthoredPayloads():
                prims_with_payloads += 1
        except Exception:
            pass
        try:
            # We count prims that have any authored variant sets.
            vs = prim.GetVariantSets()
            if vs and list(vs.GetNames() or []):
                prims_with_variants += 1
        except Exception:
            pass
        try:
            if prim.HasAuthoredInherits():
                prims_with_inherits += 1
        except Exception:
            pass
        try:
            if prim.HasAuthoredSpecializes():
                prims_with_specializes += 1
        except Exception:
            pass

        # Skel binding signal (helps distinguish "rigged mesh" vs loose animation layers).
        try:
            b = UsdSkel.BindingAPI(prim)
            rel = b.GetSkeletonRel()
            if rel and rel.HasAuthoredTargets():
                skel_bindings_count += 1
        except Exception:
            pass

    # Dependencies / missing references.
    deps_layers: list[str] = []
    deps_assets: list[str] = []
    deps_unresolved: list[str] = []
    missing_abs: list[str] = []
    resolved_assets: list[str] = []
    unresolved_after_resolve: list[str] = []
    missing_resolved: list[str] = []

    try:
        ident = stage.GetRootLayer().identifier
        deps = UsdUtils.ComputeAllDependencies(ident)
        # Returns a tuple of (layers, assets, unresolved)
        if isinstance(deps, tuple) and len(deps) == 3:
            deps_layers = [_as_path_str(x) for x in (deps[0] or [])]
            deps_assets = [_as_path_str(x) for x in (deps[1] or [])]
            deps_unresolved = [_as_path_str(x) for x in (deps[2] or [])]
        else:
            deps_unresolved = [_as_path_str(deps)]
    except Exception as e:
        deps_unresolved = deps_unresolved + [f"(dependency scan error) {e}"]

    # Mark missing files for any absolute paths we can test.
    def consider_missing_abs(p: str) -> None:
        s = str(p or "").strip()
        if not s:
            return
        # Many unresolved entries are non-files like "OmniPBR.mdl".
        if os.path.isabs(s) and not os.path.exists(s):
            missing_abs.append(s)

    for p in deps_layers:
        consider_missing_abs(p)
    for p in deps_assets:
        consider_missing_abs(p)
    for p in deps_unresolved:
        consider_missing_abs(p)

    # Best-effort resolver pass for relative / virtual asset paths.
    try:
        resolver = Ar.GetResolver()
        ctx = stage.GetPathResolverContext()
        with Ar.ResolverContextBinder(ctx):
            for raw in list(deps_assets) + list(deps_unresolved):
                s = str(raw or "").strip()
                if not s:
                    continue
                # Skip obvious non-asset strings emitted as errors.
                if s.startswith("(") and s.endswith(")"):
                    continue
                if s.startswith("(dependency scan error)"):
                    continue
                try:
                    resolved = str(resolver.Resolve(s) or "").strip()
                except Exception:
                    resolved = ""
                if resolved:
                    resolved_assets.append(resolved)
                    if not os.path.exists(resolved):
                        missing_resolved.append(resolved)
                else:
                    # Some resolvers only resolve relative paths when the calling layer is known;
                    # we still record this for debugging.
                    unresolved_after_resolve.append(s)
    except Exception:
        # Non-fatal: deps + missingAbs are still useful.
        pass

    top_n = max(5, min(200, int(args.top)))
    top_types = [
        {"type": k, "count": int(v)}
        for (k, v) in type_counts.most_common(top_n)
        if str(k).strip()
    ]

    missing_files = sorted(
        list(dict.fromkeys([*missing_abs, *missing_resolved]))
    )

    out = {
        "ok": True,
        "input": str(inp),
        "rootLayer": root_layer_ident or str(stage.GetRootLayer().identifier),
        "meta": {
            "rootLayerRealPath": root_layer_real,
            "defaultPrim": default_prim_path,
            "upAxis": up_axis,
            "metersPerUnit": meters_per_unit,
        },
        "stats": {
            "primTypesTop": top_types,
            "meshCount": int(mesh_count),
            "materialCount": int(material_count),
            "shaderCount": int(shader_count),
            "skelRootCount": int(skel_root_count),
            "skeletonCount": int(skel_skeleton_count),
            "skelAnimationCount": int(skel_anim_count),
            "skelBindingCount": int(skel_bindings_count),
        },
        "compositionStats": {
            "primsWithReferences": int(prims_with_references),
            "primsWithPayloads": int(prims_with_payloads),
            "primsWithVariants": int(prims_with_variants),
            "primsWithInherits": int(prims_with_inherits),
            "primsWithSpecializes": int(prims_with_specializes),
        },
        "dependencies": {
            "layers": deps_layers,
            "assets": deps_assets,
            "unresolved": deps_unresolved,
        },
        "dependencyStats": {
            "layerCount": int(len(deps_layers)),
            "assetCount": int(len(deps_assets)),
            "unresolvedCount": int(len(deps_unresolved)),
            "resolvedAssetCount": int(len(set(resolved_assets))),
            "unresolvedAfterResolveCount": int(len(set(unresolved_after_resolve))),
            "missingAbsCount": int(len(set(missing_abs))),
            "missingResolvedCount": int(len(set(missing_resolved))),
        },
        # Keep output compact: we expose full lists for debugging, but with de-dupe.
        "resolvedAssets": sorted(list(dict.fromkeys(resolved_assets)))[:5000],
        "unresolvedAfterResolve": sorted(list(dict.fromkeys(unresolved_after_resolve)))[:5000],
        "missingFiles": missing_files,
    }
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

