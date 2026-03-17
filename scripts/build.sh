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
  rsync -a --delete \
    --exclude '.DS_Store' \
    --exclude '__MACOSX' \
    "$SRC_DIR/" "$target_dir/"
  cp "$ROOT_DIR/$manifest_file" "$target_dir/manifest.json"
  find "$target_dir" \( -name '.DS_Store' -o -name '__MACOSX' \) -exec rm -rf {} +
}

package_target_dir() {
  local source_dir="$1"
  local output_file="$2"
  (
    cd "$source_dir"
    zip -X -r -q "$output_file" . \
      -x '*.DS_Store' \
      -x '__MACOSX/*' \
      -x '*/__MACOSX/*'
  )
}

detect_apple_development_team() {
  if [[ -n "${SAFARI_DEVELOPMENT_TEAM:-}" ]]; then
    printf '%s\n' "$SAFARI_DEVELOPMENT_TEAM"
    return 0
  fi

  security find-identity -p codesigning -v 2>/dev/null \
    | sed -n 's/.*Apple Development: .* (\([A-Z0-9]\{10\}\)).*/\1/p' \
    | head -n 1
}

sync_safari_project_resources() {
  local project_root="$1"
  local extension_resources_dir="$project_root/Shared (Extension)/Resources"

  if [[ ! -d "$extension_resources_dir" ]]; then
    echo "[build] Safari extension resources dir not found: $extension_resources_dir"
    return 0
  fi

  echo "[build] Sync Safari extension resources -> $extension_resources_dir"
  rsync -a --delete "$SAFARI_DIR/" "$extension_resources_dir/"
}

normalize_safari_project_signing() {
  local project_file="$1"
  local pbxproj_file="$project_file/project.pbxproj"
  local development_team

  if [[ "${SAFARI_ENABLE_TEAM_SIGNING:-0}" != "1" ]]; then
    return 0
  fi

  if [[ ! -f "$pbxproj_file" ]]; then
    echo "[build] Skip Safari signing normalization: pbxproj not found -> $pbxproj_file"
    return 0
  fi

  if grep -q 'DEVELOPMENT_TEAM = ' "$pbxproj_file"; then
    return 0
  fi

  development_team="$(detect_apple_development_team)"
  if [[ -z "$development_team" ]]; then
    echo "[build] Skip Safari signing normalization: no Apple Development team detected"
    return 0
  fi

  echo "[build] Normalize Safari development team -> $development_team"
  perl -0pi -e "s/CODE_SIGN_STYLE = Automatic;/CODE_SIGN_STYLE = Automatic;\\n\\t\\t\\t\\tDEVELOPMENT_TEAM = ${development_team};/g" "$pbxproj_file"
}

normalize_safari_project_bundle_ids() {
  local project_file="$1"
  local pbxproj_file="$project_file/project.pbxproj"
  local app_bundle_id

  if [[ ! -f "$pbxproj_file" ]]; then
    echo "[build] Skip Safari bundle id normalization: pbxproj not found -> $pbxproj_file"
    return 0
  fi

  app_bundle_id="$(
    grep 'PRODUCT_BUNDLE_IDENTIFIER = ' "$pbxproj_file" \
      | grep -vE '\.(Extension|extension);' \
      | head -n 1 \
      | sed -E 's/.*PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/\1/'
  )"

  if [[ -z "$app_bundle_id" ]]; then
    echo "[build] Skip Safari bundle id normalization: app bundle id not found"
    return 0
  fi

  local extension_bundle_id="${app_bundle_id}.extension"
  echo "[build] Normalize Safari extension bundle id -> $extension_bundle_id"

  perl -0pi -e "s/PRODUCT_BUNDLE_IDENTIFIER = \\Q${app_bundle_id}\\E\\.(?:Extension|extension);/PRODUCT_BUNDLE_IDENTIFIER = ${extension_bundle_id};/g" "$pbxproj_file"
}

normalize_safari_host_app_sources() {
  local project_root="$1"
  local project_file="$project_root/我的首页 Safari.xcodeproj/project.pbxproj"
  local view_controller_file="$project_root/Shared (App)/ViewController.swift"
  local view_controller_template="$ROOT_DIR/scripts/templates/safari/ViewController.swift"
  local app_bundle_id extension_bundle_id

  if [[ ! -f "$project_file" || ! -f "$view_controller_template" ]]; then
    return 0
  fi

  app_bundle_id="$(
    grep 'PRODUCT_BUNDLE_IDENTIFIER = ' "$project_file" \
      | grep -vE '\.(Extension|extension);' \
      | head -n 1 \
      | sed -E 's/.*PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/\1/'
  )"

  if [[ -z "$app_bundle_id" ]]; then
    return 0
  fi

  extension_bundle_id="${app_bundle_id}.extension"
  echo "[build] Normalize Safari host source extension id -> $extension_bundle_id"
  perl -0pe "s/__SAFARI_EXTENSION_BUNDLE_ID__/${extension_bundle_id}/g" "$view_controller_template" > "$view_controller_file"
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

  local project_file
  project_file="$(find "$SAFARI_PROJECT_DIR" -maxdepth 3 -name '*.xcodeproj' -print -quit)"
  local project_root=""

  if [[ -n "$project_file" ]]; then
    project_root="$(dirname "$project_file")"
  fi

  if [[ -n "$project_file" ]]; then
    echo "[build] Reusing existing Safari Xcode project: $project_file"
    xcrun safari-web-extension-converter "$SAFARI_DIR" \
      --rebuild-project "$project_file" \
      --copy-resources \
      --force \
      --no-open \
      --no-prompt
    normalize_safari_project_signing "$project_file"
    normalize_safari_project_bundle_ids "$project_file"
    normalize_safari_host_app_sources "$project_root"
    sync_safari_project_resources "$project_root"
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

  project_file="$(find "$SAFARI_PROJECT_DIR" -maxdepth 3 -name '*.xcodeproj' -print -quit)"
  if [[ -n "$project_file" ]]; then
    project_root="$(dirname "$project_file")"
    normalize_safari_project_signing "$project_file"
    normalize_safari_project_bundle_ids "$project_file"
    normalize_safari_host_app_sources "$project_root"
    sync_safari_project_resources "$project_root"
  fi
}

rm -f "$DIST_DIR/chrome.zip" "$DIST_DIR/firefox.zip" "$DIST_DIR/firefox.xpi" "$DIST_DIR/safari.zip"

copy_target "manifest.chrome.json" "$CHROME_DIR"
copy_target "manifest.firefox.json" "$FIREFOX_DIR"
copy_target "manifest.safari.json" "$SAFARI_DIR"

node "$ROOT_DIR/scripts/bundle-firefox.mjs"

package_target_dir "$CHROME_DIR" "$DIST_DIR/chrome.zip"
package_target_dir "$FIREFOX_DIR" "$DIST_DIR/firefox.zip"
cp "$DIST_DIR/firefox.zip" "$DIST_DIR/firefox.xpi"
package_target_dir "$SAFARI_DIR" "$DIST_DIR/safari.zip"

build_safari_project

echo "Build done: chrome/firefox/safari"
