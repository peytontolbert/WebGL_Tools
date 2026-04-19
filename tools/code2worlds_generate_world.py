#!/usr/bin/env python3
import argparse
import ast
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Tuple

DEFAULT_CODE2WORLDS_MODEL = "meta-llama/Llama-3.1-8B-Instruct"
DEFAULT_MODEL_CACHE_DIR = "/data/checkpoints/"
BLENDER42_INFINIGEN_REL = Path("repos") / "infinigen" / "blender" / "blender"
BLENDER5_PORTABLE_REL = Path("tools") / "third_party" / "blender-5.0" / "blender-5.0.0-linux-x64" / "blender"
BLENDER_REQUIRED_IMPORTS: Dict[str, str] = {
    # import_name: pip_package
    "imageio": "imageio<2.32.0",
    "numpy": "numpy<2",
    "tqdm": "tqdm",
    "matplotlib": "matplotlib",
    "cv2": "opencv-python-headless",
    "pandas": "pandas",
    "psutil": "psutil",
    "shapely": "shapely",
    "rtree": "rtree",
    "OpenEXR": "OpenEXR",
    "scipy": "scipy",
    "sklearn": "scikit-learn",
    "skimage": "scikit-image",
    "fcl": "python-fcl",
    "geomdl": "geomdl",
    "gin": "gin-config",
    "networkx": "networkx",
    "trimesh": "trimesh",
    "landlab": "landlab",
}


def _safe_name(s: str) -> str:
    out = "".join(ch if (ch.isalnum() or ch in ("-", "_")) else "_" for ch in str(s or "").strip().lower())
    out = out.strip("_")
    return out[:80] or "code2worlds"


def _repo_rel(root: Path, p: Path) -> str:
    try:
        return p.resolve().relative_to(root.resolve()).as_posix()
    except Exception:
        return p.resolve().as_posix()


def _extract_gin_bindings(gin_text: str) -> List[str]:
    def _bracket_balance(expr: str) -> int:
        """
        Track container balance for [], (), {} while ignoring quoted text.
        Positive means we likely need more lines to complete the value.
        """
        bal = 0
        in_str = False
        quote = ""
        escape = False
        for ch in str(expr or ""):
            if in_str:
                if escape:
                    escape = False
                    continue
                if ch == "\\":
                    escape = True
                    continue
                if ch == quote:
                    in_str = False
                continue
            if ch in ("'", '"'):
                in_str = True
                quote = ch
                continue
            if ch in "[{(":
                bal += 1
            elif ch in "]})":
                bal -= 1
        return bal

    def _has_balanced_quotes(expr: str) -> bool:
        in_str = False
        quote = ""
        escape = False
        for ch in str(expr or ""):
            if in_str:
                if escape:
                    escape = False
                    continue
                if ch == "\\":
                    escape = True
                    continue
                if ch == quote:
                    in_str = False
                continue
            if ch in ("'", '"'):
                in_str = True
                quote = ch
        return not in_str

    out: List[str] = []
    rows = str(gin_text or "").splitlines()
    i = 0
    while i < len(rows):
        raw = rows[i]
        line = raw.strip()
        if not line or line.startswith("#"):
            i += 1
            continue
        if "=" not in line:
            i += 1
            continue
        if line.lower().startswith("import "):
            i += 1
            continue
        left, right = line.split("=", 1)
        k = left.strip()
        v = right.strip()
        if not k or not v:
            i += 1
            continue

        # Some generated gin values span multiple lines (e.g. list registries).
        # When passed via `-p`, they must be represented as one complete binding.
        parts = [v]
        bal = _bracket_balance(v)
        while bal > 0 and (i + 1) < len(rows):
            i += 1
            nxt = rows[i].strip()
            if not nxt or nxt.startswith("#"):
                continue
            parts.append(nxt)
            bal += _bracket_balance(nxt)

        # If a container is still open at EOF, this binding is truncated and
        # would make gin parser fail with "EOF in multi-line statement".
        if bal != 0:
            print(
                f"Skipping malformed gin binding (unbalanced containers): {k}",
                flush=True,
            )
            i += 1
            continue
        merged = " ".join(parts)
        if not _has_balanced_quotes(merged):
            print(
                f"Skipping malformed gin binding (unbalanced quotes): {k}",
                flush=True,
            )
            i += 1
            continue

        out.append(f"{k}={merged}")
        i += 1
    return out


def _load_scene_gin_param_names(infinigen_root: Path) -> set:
    scene_py = (
        Path(infinigen_root).resolve()
        / "infinigen"
        / "terrain"
        / "scene.py"
    )
    try:
        tree = ast.parse(scene_py.read_text(encoding="utf-8"))
    except Exception:
        return set()

    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "scene":
            names = [a.arg for a in node.args.args]
            return {n for n in names if n not in {"seed", "on_the_fly_asset_folder", "reused_asset_folder", "device"}}
    return set()


def _load_terrain_gin_param_names(infinigen_root: Path) -> set:
    terrain_py = (
        Path(infinigen_root).resolve()
        / "infinigen"
        / "terrain"
        / "core.py"
    )
    try:
        tree = ast.parse(terrain_py.read_text(encoding="utf-8"))
    except Exception:
        return set()

    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "Terrain":
            for item in node.body:
                if isinstance(item, ast.FunctionDef) and item.name == "__init__":
                    names = [a.arg for a in item.args.args]
                    return {n for n in names if n != "self"}
    return set()


def _write_normalized_gin(
    bindings: List[str],
    out_path: Path,
    allowed_scene_params: set | None = None,
    allowed_terrain_params: set | None = None,
) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    rows: List[str] = []
    for item in bindings:
        s = str(item or "").strip()
        if not s or "=" not in s:
            continue
        k, v = s.split("=", 1)
        key = k.strip()
        val = v.strip()
        if not key or not val:
            continue
        if key.startswith("scene."):
            scene_param = key.split(".", 1)[1].strip()
            if (
                allowed_scene_params is not None
                and allowed_scene_params
                and scene_param
                and scene_param not in allowed_scene_params
            ):
                # Older/newer Infinigen revisions expose different `scene(...)`
                # kwargs. Route unknown scene keys to compose_nature, which
                # accepts flexible params and avoids gin parse hard-failures.
                key = f"compose_nature.{scene_param}"
        if key.startswith("Terrain."):
            terrain_param = key.split(".", 1)[1].strip()
            if (
                allowed_terrain_params is not None
                and allowed_terrain_params
                and terrain_param
                and terrain_param not in allowed_terrain_params
            ):
                print(
                    f"Skipping unsupported Terrain gin binding: {key}",
                    flush=True,
                )
                continue
        if key == "compose_nature.grass_habitats":
            # Infinigen expects a comma-separated tag string (e.g. "landscape"),
            # but LLM output often emits a single-item list like ["landscape,"].
            try:
                parsed = ast.literal_eval(val)
            except Exception:
                parsed = val
            if isinstance(parsed, (list, tuple)):
                tokens = [
                    str(x).strip().strip(",")
                    for x in parsed
                    if str(x).strip().strip(",")
                ]
                if tokens:
                    val = repr(",".join(tokens))
            elif isinstance(parsed, str):
                cleaned = parsed.strip().strip(",")
                if cleaned:
                    val = repr(cleaned)
        rows.append(f"{key} = {val}")
    out_path.write_text("\n".join(rows) + ("\n" if rows else ""), encoding="utf-8")
    return out_path


def _pick_scene_type_from_manifest(manifest: dict) -> str:
    terrain = manifest.get("terrain") if isinstance(manifest, dict) else {}
    landforms = terrain.get("landforms") if isinstance(terrain, dict) else []
    pool = [str(x).strip().lower() for x in (landforms if isinstance(landforms, list) else []) if str(x).strip()]
    # Map Code2Worlds landforms to known infinigen scene_types/*.gin.
    mapping = {
        "forest": "forest",
        "desert": "desert",
        "arctic": "arctic",
        "snowy_mountain": "snowy_mountain",
        "mountain": "mountain",
        "river": "river",
        "coral_reef": "coral_reef",
        "kelp_forest": "kelp_forest",
        "under_water": "under_water",
        "plain": "plain",
        "coast": "plain",
        "canyon": "mountain",
        "cliff": "mountain",
        "cave": "mountain",
    }
    for lf in pool:
        if lf in mapping:
            return mapping[lf]
    return "plain"


def _apply_model_cache_env(cache_dir: str) -> str:
    raw = str(cache_dir or "").strip()
    if not raw:
        return ""
    cache_abs = Path(raw).expanduser().resolve()
    cache_abs.mkdir(parents=True, exist_ok=True)
    cache_val = cache_abs.as_posix()
    os.environ["HF_HOME"] = cache_val
    os.environ["TRANSFORMERS_CACHE"] = cache_val
    os.environ["HUGGINGFACE_HUB_CACHE"] = cache_val
    return cache_val


def _apply_cuda_env(cuda_device: str) -> str:
    raw = str(cuda_device or "").strip()
    if not raw:
        return ""
    # Accept forms like "1" or "cuda:1".
    dev = raw
    low = raw.lower()
    if low.startswith("cuda:"):
        dev = raw.split(":", 1)[1].strip()
    if not dev:
        return ""
    os.environ["CUDA_VISIBLE_DEVICES"] = dev
    # Helps reduce allocator fragmentation for long, multi-stage runs.
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    return dev


def _materialize_blender_pydeps(pydeps_dir: Path) -> List[str]:
    """
    Copy a small set of pure-Python deps from the launcher env into a clean dir
    that can be safely exposed to Blender's interpreter via PYTHONPATH.
    This avoids leaking compiled wheels (e.g. numpy) across Python versions.
    """
    pydeps_dir.mkdir(parents=True, exist_ok=True)
    copied: List[str] = []

    def copy_module(mod_name: str) -> None:
        try:
            spec = importlib.util.find_spec(mod_name)
        except Exception:
            spec = None
        if not spec:
            return
        src = None
        is_pkg = False
        try:
            if spec.submodule_search_locations:
                src = Path(next(iter(spec.submodule_search_locations))).resolve()
                is_pkg = True
            elif spec.origin:
                src = Path(spec.origin).resolve()
        except Exception:
            src = None
        if not src or not src.exists():
            return
        dst = pydeps_dir / mod_name
        try:
            if dst.exists():
                if dst.is_dir():
                    shutil.rmtree(dst)
                else:
                    dst.unlink()
            if is_pkg:
                shutil.copytree(src, dst)
            else:
                dst = pydeps_dir / src.name
                shutil.copy2(src, dst)
            copied.append(mod_name)
        except Exception:
            pass

    # Keep this list pure-python only; compiled wheels must come from Blender's
    # own interpreter environment to avoid ABI mismatches.
    # gin/six fix config parsing, trimesh is required by infinigen.core.util.blender.
    for dep in ("gin", "six", "trimesh", "networkx"):
        copy_module(dep)

    return copied


def _probe_blender_python(blender_abs: Path, env: Dict[str, str]) -> dict:
    probe_imports = sorted(BLENDER_REQUIRED_IMPORTS.keys())
    expr = (
        "import importlib.util,json,sys;"
        f"mods={json.dumps(probe_imports)};"
        "missing=[m for m in mods if importlib.util.find_spec(m) is None];"
        "print('BLENDER_PROBE_JSON:'+json.dumps({'pythonExecutable':sys.executable,'missing':missing}))"
    )
    cmd = [
        str(blender_abs),
        "-noaudio",
        "--background",
        "--python-use-system-env",
        "--python-exit-code",
        "1",
        "--python-expr",
        expr,
    ]
    p = subprocess.run(
        cmd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    out = str(p.stdout or "")
    m = re.search(r"BLENDER_PROBE_JSON:(\{.*\})", out)
    if not m:
        return {"ok": False, "exitCode": int(p.returncode or 0), "stdout": out, "stderr": str(p.stderr or "")}
    try:
        parsed = json.loads(m.group(1))
    except Exception:
        parsed = {}
    parsed["ok"] = True
    parsed["exitCode"] = int(p.returncode or 0)
    return parsed


def _ensure_blender_python_deps(blender_abs: Path, env: Dict[str, str]) -> dict:
    before = _probe_blender_python(blender_abs, env)
    if not before.get("ok"):
        return {"ok": False, "reason": "probe_failed", "before": before}
    missing_before = [str(x) for x in (before.get("missing") or []) if str(x)]
    if not missing_before:
        return {"ok": True, "installed": [], "missingAfter": [], "pythonExecutable": str(before.get("pythonExecutable") or "")}

    py_exe = str(before.get("pythonExecutable") or "").strip()
    if not py_exe:
        return {"ok": False, "reason": "python_executable_missing", "before": before}

    pkgs = []
    for mod in missing_before:
        pkg = BLENDER_REQUIRED_IMPORTS.get(mod)
        if pkg and pkg not in pkgs:
            pkgs.append(pkg)
    if not pkgs:
        return {"ok": True, "installed": [], "missingAfter": missing_before, "pythonExecutable": py_exe}

    pip_cmd = [py_exe, "-m", "pip", "install", "--user", "--upgrade", *pkgs]
    pip_env = dict(env)
    pip_env["PIP_BREAK_SYSTEM_PACKAGES"] = "1"
    pip_run = subprocess.run(
        pip_cmd,
        env=pip_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    after = _probe_blender_python(blender_abs, env)
    missing_after = [str(x) for x in (after.get("missing") or []) if str(x)] if after.get("ok") else missing_before
    return {
        "ok": bool(after.get("ok")),
        "pythonExecutable": py_exe,
        "installed": pkgs,
        "missingBefore": missing_before,
        "missingAfter": missing_after,
        "pipExitCode": int(pip_run.returncode or 0),
        "pipStdout": str(pip_run.stdout or ""),
        "pipStderr": str(pip_run.stderr or ""),
        "after": after,
    }


def _ensure_infinigen_terrain_binaries(infinigen_root: Path, env: Dict[str, str]) -> dict:
    required_so = (
        Path(infinigen_root).resolve()
        / "infinigen"
        / "terrain"
        / "lib"
        / "cpu"
        / "elements"
        / "waterbody.so"
    )
    if required_so.exists():
        return {"ok": True, "compiled": False, "requiredSo": str(required_so)}

    print(
        f"Missing terrain binary {required_so}; compiling terrain libraries...",
        flush=True,
    )
    cmd = ["bash", "scripts/install/compile_terrain.sh"]
    run = subprocess.run(
        cmd,
        cwd=str(Path(infinigen_root).resolve()),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    ok = (run.returncode == 0) and required_so.exists()
    return {
        "ok": ok,
        "compiled": True,
        "requiredSo": str(required_so),
        "exitCode": int(run.returncode or 0),
        "stdout": str(run.stdout or ""),
        "stderr": str(run.stderr or ""),
    }


def _python_has_module(python_bin: str, module_name: str, env: Dict[str, str]) -> bool:
    expr = (
        "import importlib.util,sys;"
        f"sys.exit(0 if importlib.util.find_spec({module_name!r}) is not None else 1)"
    )
    try:
        p = subprocess.run(
            [str(python_bin), "-c", expr],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return p.returncode == 0
    except Exception:
        return False


def _has_working_marching_cubes_ext(
    python_bin: str, infinigen_root: Path, env: Dict[str, str]
) -> bool:
    probe = (
        "import glob,importlib.util,os,sys;"
        "root=os.environ.get('CODE2WORLDS_INFINIGEN_ROOT','').strip();"
        "base=(os.path.join(root,'infinigen','terrain') if root else '');"
        "cand=sorted(glob.glob(os.path.join(base,'marching_cubes*.so')));"
        "sys.exit(1) if not cand else None;"
        "pth=cand[0];"
        "spec=importlib.util.spec_from_file_location('infinigen.terrain.marching_cubes',pth);"
        "mod=importlib.util.module_from_spec(spec);"
        "spec.loader.exec_module(mod);"
        "sys.exit(0 if (hasattr(mod,'LutProvider') and hasattr(mod,'marching_cubes')) else 1)"
    )
    try:
        probe_env = dict(env)
        probe_env["CODE2WORLDS_INFINIGEN_ROOT"] = str(Path(infinigen_root).resolve())
        p = subprocess.run(
            [str(python_bin), "-c", probe],
            env=probe_env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return p.returncode == 0
    except Exception:
        return False


def _python_version_tuple(python_bin: str, env: Dict[str, str]) -> Tuple[int, int]:
    expr = "import sys;print(f'{sys.version_info[0]}.{sys.version_info[1]}')"
    try:
        p = subprocess.run(
            [str(python_bin), "-c", expr],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        if p.returncode != 0:
            return (0, 0)
        raw = str(p.stdout or "").strip()
        major, minor = raw.split(".", 1)
        return (int(major), int(minor))
    except Exception:
        return (0, 0)


def _python_has_dev_headers(python_bin: str, env: Dict[str, str]) -> bool:
    expr = (
        "import os,sys,sysconfig;"
        "inc=sysconfig.get_config_var('INCLUDEPY') or '';"
        "pth=os.path.join(inc,'Python.h') if inc else '';"
        "sys.exit(0 if (pth and os.path.exists(pth)) else 1)"
    )
    try:
        p = subprocess.run(
            [str(python_bin), "-c", expr],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return p.returncode == 0
    except Exception:
        return False


def _ensure_infinigen_marching_cubes_extension(
    python_bin: str, infinigen_root: Path, env: Dict[str, str]
) -> dict:
    if _has_working_marching_cubes_ext(python_bin, infinigen_root, env):
        return {"ok": True, "built": False}
    runtime_ver = _python_version_tuple(python_bin, env)

    candidates: List[str] = []

    conda_env_candidates: List[str] = []
    home = Path.home()
    for root in (home / "miniconda3" / "envs", home / ".conda" / "envs"):
        try:
            if root.exists():
                for py in sorted(root.glob("*/bin/python")):
                    conda_env_candidates.append(str(py.resolve()))
        except Exception:
            continue

    # Prefer an explicit builder when provided.
    forced_builder = str(env.get("CODE2WORLDS_MC_BUILDER_PYTHON") or "").strip()
    if forced_builder:
        conda_env_candidates.insert(0, forced_builder)
    # Prefer dedicated py311 build env if present.
    preferred_py311 = str((home / "miniconda3" / "envs" / "py311build" / "bin" / "python3.11").resolve())
    if preferred_py311 not in conda_env_candidates:
        conda_env_candidates.insert(0, preferred_py311)

    for cand in [
        python_bin,
        sys.executable,
        shutil.which("python3.11") or "",
        shutil.which("python3") or "",
        *conda_env_candidates,
    ]:
        s = str(cand or "").strip()
        if not s or s in candidates:
            continue
        candidates.append(s)

    build_attempts: List[dict] = []
    for builder in candidates:
        b_ver = _python_version_tuple(builder, env)
        if runtime_ver != (0, 0) and b_ver != runtime_ver:
            build_attempts.append(
                {
                    "python": builder,
                    "skipped": f"version_mismatch runtime={runtime_ver} builder={b_ver}",
                }
            )
            continue
        has_headers = _python_has_dev_headers(builder, env)
        if (not has_headers) and ("py311build" not in builder):
            build_attempts.append(
                {"python": builder, "skipped": "missing_python_headers"}
            )
            continue

        pip_env = dict(env)
        pip_env["PIP_BREAK_SYSTEM_PACKAGES"] = "1"
        pip_run = subprocess.run(
            [
                str(builder),
                "-m",
                "pip",
                "install",
                "--user",
                "--upgrade",
                "Cython",
                "setuptools",
                "wheel",
                "numpy<2",
            ],
            cwd=str(infinigen_root.resolve()),
            env=pip_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        build_env = dict(env)
        build_env["INFINIGEN_INSTALL_TERRAIN"] = "True"
        build_env["INFINIGEN_INSTALL_CUSTOMGT"] = "False"
        build_env["INFINIGEN_INSTALL_BNURBS"] = "False"
        build_run = subprocess.run(
            [str(builder), "setup.py", "build_ext", "--inplace"],
            cwd=str(infinigen_root.resolve()),
            env=build_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        ok = _has_working_marching_cubes_ext(python_bin, infinigen_root, env)
        attempt = {
            "python": builder,
            "pipExitCode": int(pip_run.returncode or 0),
            "buildExitCode": int(build_run.returncode or 0),
            "pipStdout": str(pip_run.stdout or ""),
            "pipStderr": str(pip_run.stderr or ""),
            "buildStdout": str(build_run.stdout or ""),
            "buildStderr": str(build_run.stderr or ""),
        }
        build_attempts.append(attempt)
        if ok:
            return {"ok": True, "built": True, "builderPython": builder, "attempts": build_attempts}

    return {"ok": False, "built": True, "attempts": build_attempts}


def _run_infinigen_render(
    python_bin: str,
    infinigen_root: Path,
    gin_abs: Path,
    out_render_dir: Path,
    seed: int,
    blender_path: str,
) -> dict:
    env = os.environ.copy()
    py_path = str(infinigen_root.resolve())
    # Keep Blender's interpreter isolated from this launcher env's binary wheels.
    # Mixing Blender Python (e.g. 3.12) with conda site-packages (e.g. 3.10 wheels)
    # causes crashes such as numpy C-extension import failures.
    env.pop("PYTHONHOME", None)
    # Keep Blender's --user installs scoped to this run directory.
    blender_user_base = (out_render_dir / ".blender_user_base").resolve()
    blender_user_base.mkdir(parents=True, exist_ok=True)
    env["PYTHONUSERBASE"] = str(blender_user_base)

    # Stage pure-python deps required by Blender-side scripts.
    pydeps_dir = out_render_dir / ".blender_pydeps"
    copied_deps = _materialize_blender_pydeps(pydeps_dir)
    if copied_deps:
        print(f"Prepared Blender pydeps: {', '.join(copied_deps)} @ {pydeps_dir}", flush=True)

    raw_pythonpath = str(env.get("PYTHONPATH") or "")
    inherited_paths: List[str] = []
    for chunk in raw_pythonpath.split(os.pathsep):
        s = str(chunk or "").strip()
        if not s:
            continue
        low = s.lower()
        if ("site-packages" in low) or ("dist-packages" in low):
            continue
        inherited_paths.append(s)

    # Preserve order while removing duplicates.
    dedup: List[str] = []
    seen = set()
    for p in [str(pydeps_dir.resolve()), py_path, *inherited_paths]:
        if p in seen:
            continue
        seen.add(p)
        dedup.append(p)
    env["PYTHONPATH"] = os.pathsep.join(dedup)
    if blender_path:
        env["BLENDER_EXEC"] = blender_path
    blender_abs = None
    if blender_path:
        try:
            blender_abs = Path(blender_path).expanduser().resolve()
        except Exception:
            blender_abs = None
    else:
        workspace_root = Path(__file__).resolve().parents[1]
        # Prefer Infinigen's installer-managed Blender first (typically 4.2),
        # then fallback to repo-local portable Blender 5.0.
        infinigen_blender = (workspace_root / BLENDER42_INFINIGEN_REL).resolve()
        portable_blender = (workspace_root / BLENDER5_PORTABLE_REL).resolve()
        if infinigen_blender.exists():
            blender_abs = infinigen_blender
        elif portable_blender.exists():
            blender_abs = portable_blender
        else:
            auto_blender = shutil.which("blender")
            if auto_blender:
                try:
                    blender_abs = Path(auto_blender).expanduser().resolve()
                except Exception:
                    blender_abs = None
    has_custom_blender = bool(blender_abs and blender_abs.exists())
    terrain_bootstrap = _ensure_infinigen_terrain_binaries(infinigen_root, env)
    if not terrain_bootstrap.get("ok"):
        tail_out = "\n".join(str(terrain_bootstrap.get("stdout", "")).splitlines()[-40:])
        tail_err = "\n".join(str(terrain_bootstrap.get("stderr", "")).splitlines()[-40:])
        raise RuntimeError(
            "Failed to compile Infinigen terrain libraries. "
            f"required={terrain_bootstrap.get('requiredSo')}, "
            f"exit={terrain_bootstrap.get('exitCode')}.\n"
            f"stdout_tail:\n{tail_out}\n"
            f"stderr_tail:\n{tail_err}"
        )
    blender_bootstrap = None
    if has_custom_blender:
        blender_bootstrap = _ensure_blender_python_deps(blender_abs, env)
        if blender_bootstrap.get("ok"):
            miss = blender_bootstrap.get("missingAfter") or []
            if miss:
                print(
                    "Blender dependency bootstrap incomplete; still missing:",
                    ", ".join(str(x) for x in miss),
                    flush=True,
                )
            elif blender_bootstrap.get("installed"):
                print(
                    "Installed Blender Python deps:",
                    ", ".join(str(x) for x in blender_bootstrap.get("installed") or []),
                    flush=True,
                )
        else:
            print("Blender dependency probe/bootstrap failed; continuing with best effort.", flush=True)

    ext_python = python_bin
    if blender_bootstrap and isinstance(blender_bootstrap, dict):
        py_exe = str(blender_bootstrap.get("pythonExecutable") or "").strip()
        if py_exe:
            ext_python = py_exe
    mc_bootstrap = _ensure_infinigen_marching_cubes_extension(
        ext_python, infinigen_root, env
    )
    if not mc_bootstrap.get("ok"):
        attempts = mc_bootstrap.get("attempts") or []
        last = attempts[-1] if attempts else {}
        parts: List[str] = []
        for a in attempts:
            py = str(a.get("python", ""))
            skipped = str(a.get("skipped", "")).strip()
            if skipped:
                parts.append(f"{py}:{skipped}")
            else:
                parts.append(f"{py}:pip={a.get('pipExitCode')} build={a.get('buildExitCode')}")
        attempts_summary = "; ".join(parts)
        raise RuntimeError(
            "Failed to build/load Infinigen marching-cubes extension for render runtime.\n"
            f"python={ext_python}\n"
            f"builder={last.get('python', '')}\n"
            f"pipExit={last.get('pipExitCode')} buildExit={last.get('buildExitCode')}\n"
            f"attempts={attempts_summary}\n"
            f"build_stderr_tail:\n"
            + "\n".join(str(last.get("buildStderr", "")).splitlines()[-40:])
        )
    if mc_bootstrap.get("built"):
        print(
            f"Prepared Infinigen marching-cubes extension for runtime={ext_python} using builder={mc_bootstrap.get('builderPython', ext_python)}",
            flush=True,
        )

    scene_cfg_name = "plain"
    try:
        manifest_guess = json.loads((gin_abs.parent / f"{gin_abs.stem.replace('_generated_scene', '')}_manifest_scene.json").read_text(encoding="utf-8"))
        scene_cfg_name = _pick_scene_type_from_manifest(manifest_guess)
    except Exception:
        scene_cfg_name = "plain"
    gin_bindings = _extract_gin_bindings(gin_abs.read_text(encoding="utf-8"))
    scene_cfg_abs = (
        infinigen_root
        / "infinigen_examples"
        / "configs_nature"
        / "scene_types"
        / f"{scene_cfg_name}.gin"
    )

    coarse_dir = out_render_dir / "coarse"
    fine_dir = out_render_dir / "fine"
    frames_dir = out_render_dir / "frames"
    coarse_dir.mkdir(parents=True, exist_ok=True)
    fine_dir.mkdir(parents=True, exist_ok=True)
    frames_dir.mkdir(parents=True, exist_ok=True)

    def run_task(task_args: List[str]) -> Tuple[int, List[str]]:
        direct_cmd = [python_bin, "-s", "-m", "infinigen_examples.generate_nature", *task_args]
        print("Running Infinigen task (direct):", " ".join(direct_cmd), flush=True)
        p = subprocess.run(direct_cmd, cwd=str(infinigen_root.resolve()), env=env)
        code = int(p.returncode or 0)
        if code == 0:
            return code, direct_cmd
        if has_custom_blender:
            module_script = (
                infinigen_root
                / "infinigen_examples"
                / "generate_nature.py"
            ).resolve()
            append_syspath_script = (
                infinigen_root
                / "infinigen"
                / "tools"
                / "blendscript_path_append.py"
            ).resolve()
            blender_cmd = [
                str(blender_abs),
                "-noaudio",
                "--background",
                "--python-use-system-env",
                "--python-exit-code",
                "1",
                "--python",
                str(append_syspath_script),
                "--python",
                str(module_script),
                "--",
                *task_args,
            ]
            print("Direct mode failed, retrying with custom blender path:", " ".join(blender_cmd), flush=True)
            p2 = subprocess.run(blender_cmd, cwd=str(infinigen_root.resolve()), env=env)
            return int(p2.returncode or 0), blender_cmd

        launch_cmd = [python_bin, "-s", "-m", "infinigen.launch_blender", "-m", "infinigen_examples.generate_nature", "--", *task_args]
        print("Direct mode failed, retrying with launch_blender:", " ".join(launch_cmd), flush=True)
        p2 = subprocess.run(launch_cmd, cwd=str(infinigen_root.resolve()), env=env)
        return int(p2.returncode or 0), launch_cmd

    def run_export(task_args: List[str]) -> Tuple[int, List[str]]:
        direct_cmd = [python_bin, "-s", "-m", "infinigen.tools.export", *task_args]
        print("Running Infinigen export (direct):", " ".join(direct_cmd), flush=True)
        p = subprocess.run(direct_cmd, cwd=str(infinigen_root.resolve()), env=env)
        code = int(p.returncode or 0)
        if code == 0:
            return code, direct_cmd
        if has_custom_blender:
            export_script = (infinigen_root / "infinigen" / "tools" / "export.py").resolve()
            append_syspath_script = (
                infinigen_root
                / "infinigen"
                / "tools"
                / "blendscript_path_append.py"
            ).resolve()
            blender_cmd = [
                str(blender_abs),
                "-noaudio",
                "--background",
                "--python-use-system-env",
                "--python-exit-code",
                "1",
                "--python",
                str(append_syspath_script),
                "--python",
                str(export_script),
                "--",
                *task_args,
            ]
            print("Direct export failed, retrying with custom blender path:", " ".join(blender_cmd), flush=True)
            p2 = subprocess.run(blender_cmd, cwd=str(infinigen_root.resolve()), env=env)
            return int(p2.returncode or 0), blender_cmd

        launch_cmd = [python_bin, "-s", "-m", "infinigen.launch_blender", "-m", "infinigen.tools.export", "--", *task_args]
        print("Direct export failed, retrying with launch_blender:", " ".join(launch_cmd), flush=True)
        p2 = subprocess.run(launch_cmd, cwd=str(infinigen_root.resolve()), env=env)
        return int(p2.returncode or 0), launch_cmd

    scene_params = _load_scene_gin_param_names(infinigen_root)
    terrain_params = _load_terrain_gin_param_names(infinigen_root)
    normalized_gin = _write_normalized_gin(
        gin_bindings,
        infinigen_root / "infinigen_examples" / "configs_nature" / "code2worlds_generated_bindings.gin",
        allowed_scene_params=scene_params,
        allowed_terrain_params=terrain_params,
    )
    common_cfg = ["-g", f"{scene_cfg_name}.gin", "simple.gin"]
    use_no_landlab_cfg = not _python_has_module(python_bin, "landlab", env)
    if blender_bootstrap and isinstance(blender_bootstrap, dict):
        missing_after = {
            str(x).strip()
            for x in (blender_bootstrap.get("missingAfter") or [])
            if str(x).strip()
        }
        if "landlab" in missing_after:
            use_no_landlab_cfg = True
    if use_no_landlab_cfg:
        print(
            "landlab unavailable; applying Infinigen no_landlab.gin fallback.",
            flush=True,
        )
        common_cfg.extend(["-g", "disable_assets/no_landlab.gin"])
    if normalized_gin.exists() and normalized_gin.stat().st_size > 0:
        common_cfg.extend(["-g", normalized_gin.name])
    common_overrides: List[str] = []

    c_code, c_cmd = run_task([
        "--seed", str(int(seed)),
        "--task", "coarse",
        *common_cfg,
        *common_overrides,
        "--output_folder", str(coarse_dir.resolve()),
    ])
    coarse_recovered_from_save_warning = False
    if c_code != 0:
        coarse_has_outputs = (
            (coarse_dir / "scene.blend").exists()
            and (coarse_dir / "MaskTag.json").exists()
        )
        if coarse_has_outputs:
            print(
                "Coarse task exited non-zero after writing expected outputs; continuing as recoverable.",
                flush=True,
            )
            c_code = 0
            coarse_recovered_from_save_warning = True
    if c_code != 0:
        return {
            "exitCode": c_code,
            "rawExitCode": c_code,
            "recoveredFromSaveWarning": coarse_recovered_from_save_warning,
            "failedTask": "coarse",
            "lastCommand": " ".join(c_cmd),
            "sceneConfigPath": scene_cfg_abs.as_posix(),
            "blenderBootstrap": blender_bootstrap or {},
        }

    f_code, f_cmd = run_task([
        "--seed", str(int(seed)),
        "--task", "populate", "fine_terrain",
        *common_cfg,
        *common_overrides,
        "--input_folder", str(coarse_dir.resolve()),
        "--output_folder", str(fine_dir.resolve()),
    ])
    if f_code != 0:
        return {
            "exitCode": f_code,
            "failedTask": "populate_fine_terrain",
            "lastCommand": " ".join(f_cmd),
            "sceneConfigPath": scene_cfg_abs.as_posix(),
            "blenderBootstrap": blender_bootstrap or {},
        }

    r_code, r_cmd = run_task([
        "--seed", str(int(seed)),
        "--task", "render",
        *common_cfg,
        *common_overrides,
        "--input_folder", str(fine_dir.resolve()),
        "--output_folder", str(frames_dir.resolve()),
    ])
    raw_r_code = int(r_code)
    recovered_from_segfault = False
    if r_code == -11:
        has_render_outputs = (
            (out_render_dir / "tmp" / "0001.png").exists()
            or any(frames_dir.glob("*.png"))
            or any(frames_dir.glob("*.exr"))
        )
        if has_render_outputs:
            print(
                "Render exited with SIGSEGV (-11) after writing outputs; continuing as recoverable.",
                flush=True,
            )
            r_code = 0
            recovered_from_segfault = True

    export_dir = out_render_dir / "export"
    export_dir.mkdir(parents=True, exist_ok=True)
    export_args = [
        "--input_folder",
        str(fine_dir.resolve()),
        "--output_folder",
        str(export_dir.resolve()),
        "-f",
        "fbx",
        "-r",
        "1024",
    ]
    export_exit = -1
    export_fbx = ""
    glb_out = out_render_dir / "scene.glb"
    glb_exit = -1
    glb_path = ""
    if r_code == 0:
        export_exit, export_cmd = run_export(export_args)
        if export_exit == 0:
            fbx_candidates = sorted(export_dir.rglob("*.fbx"))
            if fbx_candidates:
                export_fbx = fbx_candidates[0].as_posix()
                conv_cmd = [
                    python_bin,
                    str((Path(__file__).resolve().parents[1] / "tools" / "convert_asset.py").resolve()),
                    "to-gltf",
                    "--in",
                    export_fbx,
                    "--out",
                    str(glb_out.resolve()),
                    "--export-format",
                    "GLB",
                ]
                print("Converting exported FBX to GLB:", " ".join(conv_cmd), flush=True)
                pconv = subprocess.run(conv_cmd, cwd=str(Path(__file__).resolve().parents[1]), env=env)
                glb_exit = int(pconv.returncode or 0)
                if glb_exit == 0 and glb_out.exists():
                    glb_path = glb_out.as_posix()

    return {
        "exitCode": r_code,
        "rawExitCode": raw_r_code,
        "recoveredFromSegfault": recovered_from_segfault,
        "coarseRecoveredFromSaveWarning": coarse_recovered_from_save_warning,
        "failedTask": "" if r_code == 0 else "render",
        "lastCommand": " ".join(r_cmd),
        "sceneConfigPath": scene_cfg_abs.as_posix(),
        "sceneConfigName": scene_cfg_name,
        "overridesCount": len(gin_bindings),
        "coarseDir": coarse_dir.as_posix(),
        "fineDir": fine_dir.as_posix(),
        "framesDir": frames_dir.as_posix(),
        "exportDir": export_dir.as_posix(),
        "exportExitCode": export_exit,
        "exportFbxPath": export_fbx,
        "sceneGlbPath": glb_path,
        "sceneGlbExitCode": glb_exit,
        "blenderBootstrap": blender_bootstrap or {},
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Code2Worlds -> Infinigen world generation bridge for devtools.")
    ap.add_argument("--prompt", required=True, help="World prompt")
    ap.add_argument("--model-name", default=DEFAULT_CODE2WORLDS_MODEL)
    ap.add_argument("--cache-dir", default=DEFAULT_MODEL_CACHE_DIR)
    ap.add_argument("--cuda-device", default="1", help='GPU selector, e.g. "1" or "cuda:1"')
    ap.add_argument("--base-url", default="")
    ap.add_argument("--code2worlds-root", required=True)
    ap.add_argument("--infinigen-root", required=True)
    ap.add_argument("--out-name", default="world")
    ap.add_argument("--work-dir", required=True)
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--run-render", action="store_true")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--blender-path", default="")
    args = ap.parse_args()

    project_root = Path(__file__).resolve().parents[1]
    c2w_root = Path(args.code2worlds_root).resolve()
    infinigen_root = Path(args.infinigen_root).resolve()
    work_dir = Path(args.work_dir).resolve()
    output_dir = Path(args.output_dir).resolve()
    out_tag = _safe_name(args.out_name)

    work_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)

    if not c2w_root.exists():
        raise RuntimeError(f"Code2Worlds root not found: {c2w_root}")
    if not infinigen_root.exists():
        raise RuntimeError(f"Infinigen root not found: {infinigen_root}")

    cache_dir = _apply_model_cache_env(args.cache_dir)
    cuda_visible = _apply_cuda_env(args.cuda_device)
    if cuda_visible:
        print(f"Using CUDA_VISIBLE_DEVICES={cuda_visible}", flush=True)

    sys.path.insert(0, str(c2w_root.resolve()))
    from agent.scene_stream.planner import EnvironmentPlanner
    from agent.scene_stream.resolver import ParameterResolver
    from agent.scene_stream.realizer import SceneRealizer

    planner = EnvironmentPlanner(api_key="", base_url="", model_name=args.model_name, cache_dir=cache_dir)
    resolver = ParameterResolver(api_key="", base_url="", model_name=args.model_name, cache_dir=cache_dir)
    realizer = SceneRealizer(api_key="", base_url="", model_name=args.model_name, cache_dir=cache_dir)

    print("Planner: generating manifest...", flush=True)
    manifest_raw = planner.infer_manifest(args.prompt)
    if not manifest_raw:
        raise RuntimeError("Planner returned empty output")
    manifest = json.loads(str(manifest_raw))

    print("Resolver: generating scalar params...", flush=True)
    params = resolver.resolve_parameters(manifest, args.prompt)
    if not params:
        raise RuntimeError("Resolver returned empty output")

    print("Realizer: compiling gin...", flush=True)
    ref_gin = realizer.read_file(str(c2w_root / "library" / "gin.txt"))
    ref_code = realizer.read_file(str(c2w_root / "library" / "nature_example.py"))
    gin_text = realizer.synthesize_code(params, ref_gin, ref_code, manifest, args.prompt)
    if not gin_text:
        raise RuntimeError("Realizer returned empty gin")

    manifest_abs = work_dir / f"{out_tag}_manifest_scene.json"
    params_abs = work_dir / f"{out_tag}_scene_params.json"
    gin_abs = work_dir / f"{out_tag}_generated_scene.gin"
    with manifest_abs.open("w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    with params_abs.open("w", encoding="utf-8") as f:
        json.dump(params, f, indent=2, ensure_ascii=False)
    gin_abs.write_text(str(gin_text).strip() + "\n", encoding="utf-8")

    render_out_abs = output_dir
    render_exit_code = None
    render_raw_exit_code = None
    render_recovered_from_segfault = False
    render_failed_task = ""
    render_last_cmd = ""
    render_scene_cfg = ""
    render_frames_dir = ""
    render_fine_dir = ""
    render_coarse_dir = ""
    render_blender_bootstrap = {}
    if args.run_render:
        render_out_abs.mkdir(parents=True, exist_ok=True)
        render_info = _run_infinigen_render(
            python_bin=sys.executable,
            infinigen_root=infinigen_root,
            gin_abs=gin_abs,
            out_render_dir=render_out_abs,
            seed=args.seed,
            blender_path=args.blender_path,
        )
        render_exit_code = int(render_info.get("exitCode", -1))
        render_raw_exit_code = int(render_info.get("rawExitCode", render_exit_code))
        render_recovered_from_segfault = bool(render_info.get("recoveredFromSegfault", False))
        render_failed_task = str(render_info.get("failedTask", "") or "")
        render_last_cmd = str(render_info.get("lastCommand", "") or "")
        render_scene_cfg = str(render_info.get("sceneConfigPath", "") or "")
        render_frames_dir = str(render_info.get("framesDir", "") or "")
        render_fine_dir = str(render_info.get("fineDir", "") or "")
        render_coarse_dir = str(render_info.get("coarseDir", "") or "")
        render_export_dir = str(render_info.get("exportDir", "") or "")
        render_export_fbx = str(render_info.get("exportFbxPath", "") or "")
        render_export_exit = render_info.get("exportExitCode", None)
        scene_glb_path = str(render_info.get("sceneGlbPath", "") or "")
        scene_glb_exit = render_info.get("sceneGlbExitCode", None)
        render_blender_bootstrap = render_info.get("blenderBootstrap", {}) or {}
        if render_exit_code != 0:
            raise RuntimeError(f"Infinigen render failed at {render_failed_task or 'unknown'} (exit={render_exit_code})")
    else:
        render_export_dir = ""
        render_export_fbx = ""
        render_export_exit = None
        scene_glb_path = ""
        scene_glb_exit = None

    scene_source_url = _repo_rel(project_root, Path(scene_glb_path)) if scene_glb_path else ""
    contract_abs = output_dir / "scene_contract.json"
    contract = {
        "version": "code2worlds.contract.v1",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "prompt": args.prompt,
        "modelName": args.model_name,
        "cacheDir": cache_dir,
        "cudaVisibleDevices": cuda_visible,
        "manifestPath": _repo_rel(project_root, manifest_abs),
        "paramsPath": _repo_rel(project_root, params_abs),
        "ginPath": _repo_rel(project_root, gin_abs),
        "renderRequested": bool(args.run_render),
        "renderExitCode": render_exit_code,
        "renderRawExitCode": render_raw_exit_code,
        "renderRecoveredFromSegfault": render_recovered_from_segfault,
        "renderFailedTask": render_failed_task,
        "renderFramesPath": _repo_rel(project_root, Path(render_frames_dir)) if render_frames_dir else "",
        "renderFinePath": _repo_rel(project_root, Path(render_fine_dir)) if render_fine_dir else "",
        "renderCoarsePath": _repo_rel(project_root, Path(render_coarse_dir)) if render_coarse_dir else "",
        "exportDirPath": _repo_rel(project_root, Path(render_export_dir)) if render_export_dir else "",
        "exportFbxPath": _repo_rel(project_root, Path(render_export_fbx)) if render_export_fbx else "",
        "exportExitCode": render_export_exit,
        "sceneGlbPath": scene_source_url,
        "sceneGlbExitCode": scene_glb_exit,
        "blenderBootstrap": render_blender_bootstrap if args.run_render else {},
        "sceneSourceUrl": scene_source_url,
        "sceneLoadable": bool(scene_source_url),
    }
    contract_abs.write_text(json.dumps(contract, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    result = {
        "ok": True,
        "prompt": args.prompt,
        "modelName": args.model_name,
        "cacheDir": cache_dir,
        "cudaVisibleDevices": cuda_visible,
        "manifestPath": _repo_rel(project_root, manifest_abs),
        "paramsPath": _repo_rel(project_root, params_abs),
        "ginPath": _repo_rel(project_root, gin_abs),
        "renderRequested": bool(args.run_render),
        "renderOutPath": _repo_rel(project_root, render_out_abs) if args.run_render else "",
        "renderExitCode": render_exit_code,
        "renderRawExitCode": render_raw_exit_code,
        "renderRecoveredFromSegfault": render_recovered_from_segfault,
        "renderFailedTask": render_failed_task,
        "renderLastCommand": render_last_cmd,
        "renderSceneConfigPath": _repo_rel(project_root, Path(render_scene_cfg)) if render_scene_cfg else "",
        "renderCoarsePath": _repo_rel(project_root, Path(render_coarse_dir)) if render_coarse_dir else "",
        "renderFinePath": _repo_rel(project_root, Path(render_fine_dir)) if render_fine_dir else "",
        "renderFramesPath": _repo_rel(project_root, Path(render_frames_dir)) if render_frames_dir else "",
        "renderBlenderBootstrap": render_blender_bootstrap if args.run_render else {},
        "contractPath": _repo_rel(project_root, contract_abs),
        "sceneSourceUrl": scene_source_url,
        "sceneLoadable": bool(scene_source_url),
    }
    print("CODE2WORLDS_RESULT_JSON:" + json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"CODE2WORLDS_ERROR:{exc}", file=sys.stderr, flush=True)
        raise
