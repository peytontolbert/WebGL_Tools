#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path


REQUIRED_KEYS = [
    "version",
    "prompt",
    "modelName",
    "manifestPath",
    "paramsPath",
    "ginPath",
    "renderRequested",
    "renderExitCode",
    "sceneSourceUrl",
    "sceneLoadable",
]


def main() -> int:
    ap = argparse.ArgumentParser(description="Smoke-check Code2Worlds artifact contract and discoverability.")
    ap.add_argument("--contract", required=True, help="Path to scene_contract.json (project-relative or absolute)")
    ap.add_argument("--repo-root", default=None, help="Optional repo root for path checks")
    args = ap.parse_args()

    contract_path = Path(args.contract).resolve()
    if not contract_path.exists():
        raise SystemExit(f"[FAIL] Missing contract: {contract_path}")
    contract = json.loads(contract_path.read_text(encoding="utf-8"))

    missing = [k for k in REQUIRED_KEYS if k not in contract]
    if missing:
        raise SystemExit(f"[FAIL] Contract missing keys: {missing}")

    root = Path(args.repo_root).resolve() if args.repo_root else contract_path.parents[2]
    for key in ("manifestPath", "paramsPath", "ginPath"):
        rel = str(contract.get(key) or "").strip()
        if not rel:
            raise SystemExit(f"[FAIL] Empty required path: {key}")
        p = (root / rel).resolve()
        if not p.exists():
            raise SystemExit(f"[FAIL] Referenced file missing ({key}): {p}")

    scene_source = str(contract.get("sceneSourceUrl") or "").strip()
    scene_loadable = bool(contract.get("sceneLoadable"))
    if scene_loadable and not scene_source:
        raise SystemExit("[FAIL] sceneLoadable is true but sceneSourceUrl is empty")
    if scene_source:
        p = (root / scene_source).resolve()
        if not p.exists():
            raise SystemExit(f"[FAIL] sceneSourceUrl does not exist: {p}")
        if p.suffix.lower() not in (".glb", ".gltf"):
            raise SystemExit(f"[FAIL] sceneSourceUrl must be .glb/.gltf, got: {p.suffix}")

    print("[OK] Code2Worlds contract smoke-check passed")
    print(f"contract={contract_path}")
    print(f"sceneLoadable={scene_loadable}")
    print(f"sceneSourceUrl={scene_source}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

