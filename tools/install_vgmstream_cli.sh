#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${ROOT_DIR}/tools/bin"
VGMSTREAM_DIR="${BIN_DIR}/vgmstream"
VGMSTREAM_TGZ="${VGMSTREAM_DIR}/vgmstream-linux-cli.tar.gz"

mkdir -p "${VGMSTREAM_DIR}"

URL="https://github.com/vgmstream/vgmstream-releases/releases/download/nightly/vgmstream-linux-cli.tar.gz"
echo "Downloading vgmstream-cli nightly."
echo "  url: ${URL}"
echo "  out: ${VGMSTREAM_TGZ}"

if command -v curl >/dev/null 2>&1; then
  curl -L --fail --retry 3 --retry-delay 1 -o "${VGMSTREAM_TGZ}.tmp" "${URL}"
  mv "${VGMSTREAM_TGZ}.tmp" "${VGMSTREAM_TGZ}"
elif command -v wget >/dev/null 2>&1; then
  wget -O "${VGMSTREAM_TGZ}" "${URL}"
else
  echo "Missing curl or wget." >&2
  exit 2
fi

echo "Extracting."
tar -xzf "${VGMSTREAM_TGZ}" -C "${VGMSTREAM_DIR}"

CLI_PATH=""
if [[ -f "${VGMSTREAM_DIR}/vgmstream-cli" ]]; then
  CLI_PATH="${VGMSTREAM_DIR}/vgmstream-cli"
elif [[ -f "${VGMSTREAM_DIR}/vgmstream_cli" ]]; then
  CLI_PATH="${VGMSTREAM_DIR}/vgmstream_cli"
elif [[ -f "${VGMSTREAM_DIR}/bin/vgmstream-cli" ]]; then
  CLI_PATH="${VGMSTREAM_DIR}/bin/vgmstream-cli"
elif [[ -f "${VGMSTREAM_DIR}/bin/vgmstream_cli" ]]; then
  CLI_PATH="${VGMSTREAM_DIR}/bin/vgmstream_cli"
fi

if [[ -z "${CLI_PATH}" ]]; then
  echo "Could not find vgmstream-cli after extract." >&2
  echo "Contents:" >&2
  ls -la "${VGMSTREAM_DIR}" >&2 || true
  exit 3
fi

chmod +x "${CLI_PATH}"
mkdir -p "${BIN_DIR}"
ln -sf "${CLI_PATH}" "${BIN_DIR}/vgmstream-cli"

echo "Installed:"
"${BIN_DIR}/vgmstream-cli" -h >/dev/null 2>&1 || true
echo "  ${BIN_DIR}/vgmstream-cli"

