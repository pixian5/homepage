#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
SRC_DIR="${ROOT_DIR}/src"
SAFARI_PROJECT_DIR="${DIST_DIR}/safari-app"
SAFARI_BUILD_DIR="${SAFARI_PROJECT_DIR}/build"
SAFARI_APP_NAME="${SAFARI_APP_NAME:-我的首页 Safari}"

echo "[build] ROOT_DIR=${ROOT_DIR}"

if [[ -f "${ROOT_DIR}/logo.png" ]]; then
  echo "[build] Found logo.png, generating extension icons..."
  for size in 16 32 48 128; do
    sips -z "${size}" "${size}" "${ROOT_DIR}/logo.png" --out "${SRC_DIR}/assets/icon-${size}.png" >/dev/null
  done
fi

node "${ROOT_DIR}/scripts/bump-version.mjs"
bash "${ROOT_DIR}/scripts/build.sh"

PROJECT_FILE="$(find "${SAFARI_PROJECT_DIR}" -maxdepth 3 -name '*.xcodeproj' -print -quit)"
if [[ -n "${PROJECT_FILE}" ]]; then
  APP_PROCESS_NAME="${SAFARI_APP_NAME}"
  pkill -x "${APP_PROCESS_NAME}" >/dev/null 2>&1 || true
  pkill -f "${APP_PROCESS_NAME}.app" >/dev/null 2>&1 || true
  rm -rf "${SAFARI_BUILD_DIR}"

  xcodebuild \
    -project "${PROJECT_FILE}" \
    -scheme "${SAFARI_APP_NAME}" \
    -configuration Debug \
    -derivedDataPath "${SAFARI_BUILD_DIR}" \
    build

  APP_PATH="${SAFARI_BUILD_DIR}/Build/Products/Debug/${SAFARI_APP_NAME}.app"
  if [[ -d "${APP_PATH}" ]]; then
    open "${APP_PATH}"
    echo "[build] launched: ${APP_PATH}"
  fi
fi

echo "[build] done: ${DIST_DIR}/chrome.zip"
echo "[build] done: ${DIST_DIR}/firefox.zip"
echo "[build] done: ${DIST_DIR}/safari.zip"
if [[ -d "${SAFARI_PROJECT_DIR}" ]]; then
  echo "[build] done: ${SAFARI_PROJECT_DIR}"
fi

if [[ "${NO_PAUSE:-0}" != "1" ]]; then
  read -r -p "Build finished. Press Enter to close..."
fi
