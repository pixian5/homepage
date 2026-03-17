#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
SRC_DIR="$ROOT_DIR/src"
CHROME_DIR="$DIST_DIR/chrome"
FIREFOX_DIR="$DIST_DIR/firefox"
SAFARI_DIR="$DIST_DIR/safari"
SAFARI_PROJECT_DIR="$DIST_DIR/safari-app"
SAFARI_APP_NAME="${SAFARI_APP_NAME:-我的首页 Safari}"
SAFARI_BUNDLE_ID="${SAFARI_BUNDLE_ID:-com.homepage.newtab.safari}"

copy_target() {
  local manifest_file="$1"
  local target_dir="$2"
  mkdir -p "$target_dir"
  rsync -a --delete "$SRC_DIR/" "$target_dir/"
  cp "$ROOT_DIR/$manifest_file" "$target_dir/manifest.json"
}

build_safari_project() {
  if ! command -v xcrun >/dev/null 2>&1; then
    echo "[build] xcrun not found, skip Safari app project generation"
    return 0
  fi
  if ! xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
    echo "[build] safari-web-extension-converter not found, skip Safari app project generation"
    return 0
  fi

  rm -rf "$SAFARI_PROJECT_DIR"
  xcrun safari-web-extension-converter "$SAFARI_DIR" \
    --project-location "$SAFARI_PROJECT_DIR" \
    --app-name "$SAFARI_APP_NAME" \
    --bundle-identifier "$SAFARI_BUNDLE_ID" \
    --swift \
    --macos-only \
    --copy-resources \
    --force \
    --no-open \
    --no-prompt

  local project_file
  project_file="$(find "$SAFARI_PROJECT_DIR" -maxdepth 3 -name '*.xcodeproj' -print -quit)"
  if [[ -n "$project_file" && -f "$project_file/project.pbxproj" ]]; then
    perl -0pi -e "s/PRODUCT_BUNDLE_IDENTIFIER = [^;]*\\.Extension;/PRODUCT_BUNDLE_IDENTIFIER = ${SAFARI_BUNDLE_ID}.Extension;/g; s/PRODUCT_BUNDLE_IDENTIFIER = \\\"[^\\\"]+\\\";/PRODUCT_BUNDLE_IDENTIFIER = ${SAFARI_BUNDLE_ID};/g" "$project_file/project.pbxproj"
  fi
}

rm -f "$DIST_DIR/chrome.zip" "$DIST_DIR/firefox.zip" "$DIST_DIR/firefox.xpi" "$DIST_DIR/safari.zip"

copy_target "manifest.chrome.json" "$CHROME_DIR"
copy_target "manifest.firefox.json" "$FIREFOX_DIR"
copy_target "manifest.safari.json" "$SAFARI_DIR"

node "$ROOT_DIR/scripts/bundle-firefox.mjs"

(
  cd "$DIST_DIR"
  zip -r -q chrome.zip chrome
  zip -r -q firefox.zip firefox
  cp firefox.zip firefox.xpi
  zip -r -q safari.zip safari
)

build_safari_project

echo "Build done: chrome/firefox/safari"
