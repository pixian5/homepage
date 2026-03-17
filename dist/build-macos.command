#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
SRC_DIR="${ROOT_DIR}/src"
SAFARI_PROJECT_DIR="${DIST_DIR}/safari-app"
SAFARI_BUILD_DIR="${SAFARI_PROJECT_DIR}/build"
SAFARI_APP_NAME="${SAFARI_APP_NAME:-我的首页 Safari}"
SAFARI_XCODE_CONFIGURATION="${SAFARI_XCODE_CONFIGURATION:-Release}"

detect_apple_development_identity() {
  security find-identity -p codesigning -v 2>/dev/null \
    | sed -n 's/.*"\(Apple Development: .* ([A-Z0-9]\{10\})\)".*/\1/p' \
    | head -n 1
}

post_sign_safari_app() {
  local app_path="$1"
  local configuration="$2"
  local identity app_xcent appex_xcent appex_path

  identity="$(detect_apple_development_identity)"
  if [[ -z "${identity}" ]]; then
    echo "[build] Skip post-sign: no Apple Development identity found"
    return 0
  fi

  appex_path="${app_path}/Contents/PlugIns/${SAFARI_APP_NAME} Extension.appex"
  app_xcent="${SAFARI_BUILD_DIR}/Build/Intermediates.noindex/我的首页 Safari.build/${configuration}/我的首页 Safari (macOS).build/${SAFARI_APP_NAME}.app.xcent"
  appex_xcent="${SAFARI_BUILD_DIR}/Build/Intermediates.noindex/我的首页 Safari.build/${configuration}/我的首页 Safari Extension (macOS).build/${SAFARI_APP_NAME} Extension.appex.xcent"

  if [[ ! -d "${appex_path}" || ! -f "${app_xcent}" || ! -f "${appex_xcent}" ]]; then
    echo "[build] Skip post-sign: signing inputs missing"
    return 0
  fi

  echo "[build] Post-sign Safari app with Apple Development identity: ${identity}"
  /usr/bin/codesign --force --sign "${identity}" --entitlements "${appex_xcent}" --timestamp=none --options runtime "${appex_path}"
  /usr/bin/codesign --force --sign "${identity}" --entitlements "${app_xcent}" --timestamp=none --options runtime "${app_path}"
  /usr/bin/codesign --verify --verbose=2 "${appex_path}"
  /usr/bin/codesign --verify --verbose=2 "${app_path}"
}

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
  SCHEME_NAME="$(
    xcodebuild -list -project "${PROJECT_FILE}" 2>/dev/null \
      | sed -n '/Schemes:/,$p' \
      | sed '1d' \
      | sed 's/^[[:space:]]*//' \
      | grep '(macOS)' \
      | head -n 1
  )"
  if [[ -z "${SCHEME_NAME}" ]]; then
    SCHEME_NAME="${SAFARI_APP_NAME}"
  fi

  APP_PROCESS_NAME="${SAFARI_APP_NAME}"
  pkill -x "${APP_PROCESS_NAME}" >/dev/null 2>&1 || true
  pkill -f "${APP_PROCESS_NAME}.app" >/dev/null 2>&1 || true
  rm -rf "${SAFARI_BUILD_DIR}"

  XCODEBUILD_ARGS=(
    -project "${PROJECT_FILE}"
    -scheme "${SCHEME_NAME}"
    -configuration "${SAFARI_XCODE_CONFIGURATION}"
    -derivedDataPath "${SAFARI_BUILD_DIR}"
  )

  if [[ "${SAFARI_ENABLE_TEAM_SIGNING:-0}" == "1" ]]; then
    XCODEBUILD_ARGS+=(-allowProvisioningUpdates)
  fi

  xcodebuild "${XCODEBUILD_ARGS[@]}" build

  APP_PATH="${SAFARI_BUILD_DIR}/Build/Products/${SAFARI_XCODE_CONFIGURATION}/${SAFARI_APP_NAME}.app"
  if [[ -d "${APP_PATH}" ]]; then
    post_sign_safari_app "${APP_PATH}" "${SAFARI_XCODE_CONFIGURATION}"
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
