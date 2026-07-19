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
SAFARI_BUNDLE_ID="${SAFARI_BUNDLE_ID:-com.aeroluna.homepage.safari}"

# 统一版本号自增入口：允许 SKIP_BUMP=1 跳过（如 CI 或调试场景）
if [[ "${SKIP_BUMP:-0}" != "1" ]]; then
  echo "[build] Bumping version..."
  node "$ROOT_DIR/scripts/bump-version.mjs"
  # bump-version 使用 JSON.stringify 会展开数组，需要重新格式化以保持 Biome 风格一致
  if [[ -x "$ROOT_DIR/node_modules/.bin/biome" ]]; then
    "$ROOT_DIR/node_modules/.bin/biome" format --write \
      "$ROOT_DIR/manifest.chrome.json" \
      "$ROOT_DIR/manifest.firefox.json" \
      "$ROOT_DIR/manifest.safari.json" \
      "$ROOT_DIR/package.json"
  fi
fi

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

cleanup_stale_safari_plugins() {
  # 旧版 bundle id 可能残留为独立插件条目，导致 Safari 中出现重复扩展，覆盖页失效
  local old_bundle_id="com.homepage.newtab.safari.extension"
  local old_debug_app="$SAFARI_PROJECT_DIR/build-output/Debug/$SAFARI_APP_NAME.app"

  if [[ -d "$old_debug_app" ]]; then
    echo "[build] Removing stale Safari Debug build: $old_debug_app"
    rm -rf "$old_debug_app" 2>/dev/null || true
  fi

  if pluginkit -m -p com.apple.Safari.web-extension 2>/dev/null | grep -qF "$old_bundle_id"; then
    echo "[build] Disabling stale Safari plugin: $old_bundle_id"
    pluginkit -e ignore -i "$old_bundle_id" 2>/dev/null || true
  fi
}

detect_apple_development_team() {
  if [[ -n "${SAFARI_DEVELOPMENT_TEAM:-}" ]]; then
    printf '%s\n' "$SAFARI_DEVELOPMENT_TEAM"
    return 0
  fi

  local identity tmp_file team
  identity="$(
    security find-identity -p codesigning -v 2>/dev/null \
      | sed -n 's/.*"\(Apple Development: .* ([A-Z0-9]\{10\})\)".*/\1/p' \
      | head -n 1
  )"

  if [[ -z "$identity" ]]; then
    return 0
  fi

  tmp_file="$(mktemp "${TMPDIR:-/tmp}/homepage-sign-team.XXXXXX")"
  printf '#!/bin/sh\nexit 0\n' > "$tmp_file"
  chmod +x "$tmp_file"
  if /usr/bin/codesign --force --sign "$identity" --timestamp=none "$tmp_file" >/dev/null 2>&1; then
    team="$(
      /usr/bin/codesign -dv --verbose=4 "$tmp_file" 2>&1 \
        | sed -n 's/^TeamIdentifier=//p' \
        | head -n 1
    )"
  fi
  rm -f "$tmp_file"

  printf '%s\n' "${team:-}"
}

sync_safari_project_resources() {
  local project_root="$1"
  local extension_resources_dir=""

  for candidate in \
    "$project_root/Shared (Extension)/Resources" \
    "$project_root/$SAFARI_APP_NAME Extension/Resources"; do
    if [[ -d "$candidate" ]]; then
      extension_resources_dir="$candidate"
      break
    fi
  done

  if [[ -z "$extension_resources_dir" ]]; then
    echo "[build] Safari extension resources dir not found in $project_root"
    return 0
  fi

  echo "[build] Sync Safari extension resources -> $extension_resources_dir"
  rsync -a --delete "$SAFARI_DIR/" "$extension_resources_dir/"
}

normalize_safari_project_signing() {
  local project_file="$1"
  local pbxproj_file="$project_file/project.pbxproj"
  local development_team

  if [[ ! -f "$pbxproj_file" ]]; then
    echo "[build] Skip Safari signing normalization: pbxproj not found -> $pbxproj_file"
    return 0
  fi

  development_team="$(detect_apple_development_team)"
  if [[ -z "$development_team" ]]; then
    echo "[build] Skip Safari signing normalization: no Apple Development team detected"
    return 0
  fi

  echo "[build] Normalize Safari development team -> $development_team"

  perl -0pi -e "s/\n\t\t\t\tDEVELOPMENT_TEAM = [A-Z0-9]+;//g" "$pbxproj_file"
  perl -0pi -e "s/CODE_SIGN_STYLE = Automatic;/CODE_SIGN_STYLE = Automatic;\\n\\t\\t\\t\\tDEVELOPMENT_TEAM = ${development_team};/g" "$pbxproj_file"
  perl -0pi -e "s/CODE_SIGN_IDENTITY = \"?[^\"]*\"?;/CODE_SIGN_IDENTITY = \"Apple Development\";/g" "$pbxproj_file"
}

normalize_safari_project_bundle_ids() {
  local project_file="$1"
  local pbxproj_file="$project_file/project.pbxproj"
  local app_bundle_id extension_bundle_id

  if [[ ! -f "$pbxproj_file" ]]; then
    echo "[build] Skip Safari bundle id normalization: pbxproj not found -> $pbxproj_file"
    return 0
  fi

  app_bundle_id="$(
    grep 'PRODUCT_BUNDLE_IDENTIFIER = ' "$pbxproj_file" \
      | grep -vE '\.(Extension|extension);' \
      | head -n 1 \
      | sed -E 's/.*PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;/\1/'
  )"
  extension_bundle_id="$(
    grep 'PRODUCT_BUNDLE_IDENTIFIER = ' "$pbxproj_file" \
      | grep -E '\.(Extension|extension);' \
      | head -n 1 \
      | sed -E 's/.*PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;/\1/'
  )"

  if [[ -z "$app_bundle_id" || -z "$extension_bundle_id" ]]; then
    echo "[build] Skip Safari bundle id normalization: app or extension bundle id not found"
    return 0
  fi

  local target_app_bundle_id="$SAFARI_BUNDLE_ID"
  local target_extension_bundle_id="${SAFARI_BUNDLE_ID}.extension"
  echo "[build] Normalize Safari bundle ids -> app: $target_app_bundle_id, extension: $target_extension_bundle_id"

  perl -0pi -e "s/PRODUCT_BUNDLE_IDENTIFIER = \"\\Q${app_bundle_id}\\E\";/PRODUCT_BUNDLE_IDENTIFIER = \"$target_app_bundle_id\";/g" "$pbxproj_file"
  perl -0pi -e "s/PRODUCT_BUNDLE_IDENTIFIER = \\Q${app_bundle_id}\\E;/PRODUCT_BUNDLE_IDENTIFIER = ${target_app_bundle_id};/g" "$pbxproj_file"
  perl -0pi -e "s/PRODUCT_BUNDLE_IDENTIFIER = \"\\Q${extension_bundle_id}\\E\";/PRODUCT_BUNDLE_IDENTIFIER = \"$target_extension_bundle_id\";/g" "$pbxproj_file"
  perl -0pi -e "s/PRODUCT_BUNDLE_IDENTIFIER = \\Q${extension_bundle_id}\\E;/PRODUCT_BUNDLE_IDENTIFIER = ${target_extension_bundle_id};/g" "$pbxproj_file"
}

normalize_safari_host_app_sources() {
  local project_root="$1"
  local project_file="$project_root/$SAFARI_APP_NAME.xcodeproj/project.pbxproj"
  local view_controller_template="$ROOT_DIR/scripts/templates/safari/ViewController.swift"
  local view_controller_file="$project_root/Shared (App)/ViewController.swift"
  local app_bundle_id

  if [[ ! -f "$project_file" || ! -f "$view_controller_template" || ! -f "$view_controller_file" ]]; then
    return 0
  fi

  app_bundle_id="$(
    grep 'PRODUCT_BUNDLE_IDENTIFIER = ' "$project_file" \
      | grep -vE '\.(Extension|extension);' \
      | head -n 1 \
      | sed -E 's/.*PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;/\1/'
  )"

  if [[ -z "$app_bundle_id" ]]; then
    return 0
  fi

  local target_extension_bundle_id="${SAFARI_BUNDLE_ID}.extension"
  echo "[build] Normalize Safari host source extension id -> $target_extension_bundle_id"
  perl -0pe "s/__SAFARI_EXTENSION_BUNDLE_ID__/$target_extension_bundle_id/g" "$view_controller_template" > "$view_controller_file"
}

fix_safari_extension_info_plist() {
  local project_root="$1"
  local ext_info_plist=""

  for candidate in \
    "$project_root/macOS (Extension)/Info.plist" \
    "$project_root/$SAFARI_APP_NAME Extension/Info.plist"; do
    if [[ -f "$candidate" ]]; then
      ext_info_plist="$candidate"
      break
    fi
  done

  if [[ -z "$ext_info_plist" ]]; then
    echo "[build] Extension Info.plist not found in $project_root"
    return 0
  fi

  echo "[build] Fixing Safari extension Info.plist -> $ext_info_plist"

  EXT_INFO_PLIST="$ext_info_plist" python3 -c "
import plistlib, os

path = os.environ['EXT_INFO_PLIST']
with open(path, 'rb') as f:
    data = plistlib.load(f)

if 'SFSafariWebsiteAccess' not in data:
    data['SFSafariWebsiteAccess'] = {
        'Level': 'All',
        'Allowed Domains': []
    }
    print('Added SFSafariWebsiteAccess with Level: All')

with open(path, 'wb') as f:
    plistlib.dump(data, f)

print('Extension Info.plist updated successfully')
"
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
  project_file="$(find "$SAFARI_PROJECT_DIR" -maxdepth 3 -name '*.xcodeproj' -print -quit 2>/dev/null || true)"
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
    fix_safari_extension_info_plist "$project_root"
  else
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

    project_file="$(find "$SAFARI_PROJECT_DIR" -maxdepth 3 -name '*.xcodeproj' -print -quit 2>/dev/null || true)"
    if [[ -n "$project_file" ]]; then
      project_root="$(dirname "$project_file")"
      normalize_safari_project_signing "$project_file"
      normalize_safari_project_bundle_ids "$project_file"
      normalize_safari_host_app_sources "$project_root"
      sync_safari_project_resources "$project_root"
      fix_safari_extension_info_plist "$project_root"
    fi
  fi

  if [[ -z "$project_file" ]]; then
    echo "[build] Safari project not found, skip building"
    return 0
  fi

  # SAFARI_SKIP_APP_BUILD=1：仅生成工程与 safari.zip，跳过 Release 构建。
  # 由 build-macos.command 接管宿主 App 的构建/签名/安装，避免重复 xcodebuild。
  if [[ "${SAFARI_SKIP_APP_BUILD:-0}" == "1" ]]; then
    echo "[build] SAFARI_SKIP_APP_BUILD=1, skip Safari app xcodebuild (deferred to caller)"
    return 0
  fi

  local build_dir="${SAFARI_PROJECT_DIR}/build-output"
  local dev_team safari_scheme
  dev_team="$(detect_apple_development_team)"

  safari_scheme="${SAFARI_APP_NAME} (macOS)"
  if ! xcodebuild -list -project "$project_file" 2>/dev/null | grep -qF "$safari_scheme"; then
    safari_scheme="${SAFARI_APP_NAME}"
  fi

  echo "[build] Building Safari app with xcodebuild (scheme: $safari_scheme)..."
  if [[ -n "$dev_team" ]]; then
    echo "[build] Using development team: $dev_team"
    xcodebuild -project "$project_file" \
      -scheme "$safari_scheme" \
      -configuration Release \
      -sdk macosx \
      -destination 'platform=macOS' \
      -derivedDataPath "${SAFARI_PROJECT_DIR}/build-derived" \
      SYMROOT="${build_dir}" \
      ONLY_ACTIVE_ARCH=YES \
      DEVELOPMENT_TEAM="$dev_team" \
      CODE_SIGN_STYLE=Automatic \
      build
  else
    echo "[build] No development team found, building with adhoc signing..."
    xcodebuild -project "$project_file" \
      -scheme "$safari_scheme" \
      -configuration Release \
      -sdk macosx \
      -destination 'platform=macOS' \
      -derivedDataPath "${SAFARI_PROJECT_DIR}/build-derived" \
      SYMROOT="${build_dir}" \
      ONLY_ACTIVE_ARCH=YES \
      CODE_SIGN_IDENTITY="-" \
      build
  fi

  rm -rf "${SAFARI_PROJECT_DIR}/build-derived"
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

install_safari_app() {
  local app_name="$SAFARI_APP_NAME"
  local source_app
  local dest_app="/Applications/${app_name}.app"

  source_app="$(find "$SAFARI_PROJECT_DIR" -maxdepth 5 -name "${app_name}.app" -type d -print -quit 2>/dev/null || true)"
  if [[ -z "$source_app" ]]; then
    echo "[install] Safari app not found in build output"
    return 0
  fi

  echo "[install] Found Safari app: $source_app"
  echo "[install] Installing to: $dest_app"

  pkill -f "${app_name}" 2>/dev/null || true
  sleep 1

  if [[ -d "$dest_app" ]]; then
    echo "[install] Removing old app..."
    rm -rf "$dest_app" 2>/dev/null || true
    sleep 1
  fi

  echo "[install] Copying app..."
  ditto "$source_app" "$dest_app"

  if [[ ! -d "$dest_app" ]]; then
    echo "[install] ERROR: ditto failed, trying sudo..."
    sudo rm -rf "$dest_app" 2>/dev/null || true
    sudo ditto "$source_app" "$dest_app"
  fi

  if [[ ! -d "$dest_app" ]]; then
    echo "[install] ERROR: Failed to install to /Applications"
    echo "[install] Please manually copy $source_app to /Applications"
    return 1
  fi

  echo "[install] App copied successfully"
  echo "[install] Launching app to register extension..."
  open "$dest_app"

  sleep 3

  # Xcode 构建时会将 build-output 里的 .app 注册到 LaunchServices，
  # 安装到 /Applications 后如果不注销源路径，Safari 扩展列表会出现重复条目。
  echo "[install] Unregistering build-output app from LaunchServices..."
  /System/Library/Frameworks/CoreServices.framework/Versions/Current/Frameworks/LaunchServices.framework/Versions/Current/Support/lsregister -u "$source_app" 2>/dev/null || true

  echo "[install] Install completed"
}

cleanup_stale_safari_plugins
build_safari_project
# SAFARI_SKIP_APP_BUILD=1：宿主 App 构建与安装由调用方（build-macos.command）接管，
# 跳过 install_safari_app，避免重复 xcodebuild 与 LaunchServices 重复注册。
if [[ "${SAFARI_SKIP_APP_BUILD:-0}" != "1" ]]; then
  install_safari_app
fi

echo "Build done: chrome/firefox/safari"
