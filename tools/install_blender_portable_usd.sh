#!/usr/bin/env bash
set -euo pipefail

#
# Install a portable Blender build (side-by-side).
#
# Why: some distros package Blender without OpenUSD/USD import. A portable upstream
# Blender build typically includes USD import/export, which you can then point
# DevTools at via the "blenderPath" fields (without touching your system blender).
#
# Usage:
#   tools/install_blender_portable_usd.sh --version 5.0.0 --dest tools/third_party/blender-5.0
#
# Or provide an explicit URL:
#   tools/install_blender_portable_usd.sh --url "https://download.blender.org/release/Blender5.0/blender-5.0.0-linux-x64.tar.xz" --dest tools/third_party/blender-5.0
#

VERSION=""
URL=""
DEST="tools/third_party/blender-usd"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      VERSION="${2:-}"; shift 2;;
    --url)
      URL="${2:-}"; shift 2;;
    --dest)
      DEST="${2:-}"; shift 2;;
    -h|--help)
      sed -n '1,120p' "$0"
      exit 0;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2;;
  esac
done

if [[ -z "$URL" ]]; then
  if [[ -z "$VERSION" ]]; then
    echo "Missing --version (e.g. 5.0.0) or --url" >&2
    exit 2
  fi
  # Best-effort: Blender's release download URL layout is stable, but the exact
  # filename may differ for some versions/architectures. If this 404s, pass --url.
  URL="https://download.blender.org/release/Blender5.0/blender-${VERSION}-linux-x64.tar.xz"
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_ABS="${ROOT_DIR}/${DEST}"

mkdir -p "${DEST_ABS}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

ARCHIVE="${TMP_DIR}/blender.tar.xz"

echo "Downloading:"
echo "  ${URL}"
echo "To:"
echo "  ${ARCHIVE}"

if command -v curl >/dev/null 2>&1; then
  curl -L --fail --retry 3 -o "${ARCHIVE}" "${URL}"
elif command -v wget >/dev/null 2>&1; then
  wget -O "${ARCHIVE}" "${URL}"
else
  echo "Need curl or wget to download." >&2
  exit 2
fi

echo "Extracting to:"
echo "  ${DEST_ABS}"

tar -xJf "${ARCHIVE}" -C "${DEST_ABS}"

BLENDER_BIN="$(find "${DEST_ABS}" -maxdepth 3 -type f -name blender -print -quit || true)"
if [[ -z "${BLENDER_BIN}" ]]; then
  echo "Install finished, but couldn't find a 'blender' binary under ${DEST_ABS}" >&2
  echo "List the extracted folder and point DevTools at the blender binary inside it." >&2
  exit 2
fi

echo ""
echo "Portable Blender installed:"
echo "  ${BLENDER_BIN}"
echo ""
echo "Verify USD import support:"
echo "  \"${BLENDER_BIN}\" --background --factory-startup --python-expr \"import bpy; print('usd_import:', hasattr(bpy.ops.wm, 'usd_import'))\""
echo ""
echo "DevTools:"
echo "  Open devtools.html → Model / Rig / Anim → set blenderPath to:"
echo "    ${BLENDER_BIN}"

