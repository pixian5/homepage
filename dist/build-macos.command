#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
SRC_DIR="${ROOT_DIR}/src"
CHROME_DIR="${DIST_DIR}/chrome"
FIREFOX_DIR="${DIST_DIR}/firefox"

echo "[build] ROOT_DIR=${ROOT_DIR}"

rm -rf "${CHROME_DIR}" "${FIREFOX_DIR}"
rm -f "${DIST_DIR}/chrome.zip" "${DIST_DIR}/firefox.zip"

mkdir -p "${CHROME_DIR}" "${FIREFOX_DIR}"
cp -R "${SRC_DIR}/." "${CHROME_DIR}/"
cp -R "${SRC_DIR}/." "${FIREFOX_DIR}/"

cp "${ROOT_DIR}/manifest.chrome.json" "${CHROME_DIR}/manifest.json"
cp "${ROOT_DIR}/manifest.firefox.json" "${FIREFOX_DIR}/manifest.json"

(
  cd "${ROOT_DIR}"
  node "${ROOT_DIR}/scripts/bundle-firefox.mjs"
)

ditto -c -k --sequesterRsrc --keepParent "${CHROME_DIR}" "${DIST_DIR}/chrome.zip"
ditto -c -k --sequesterRsrc --keepParent "${FIREFOX_DIR}" "${DIST_DIR}/firefox.zip"

echo "[build] done: ${DIST_DIR}/chrome.zip"
echo "[build] done: ${DIST_DIR}/firefox.zip"

if [[ "${NO_PAUSE:-0}" != "1" ]]; then
  read -r -p "Build finished. Press Enter to close..."
fi
