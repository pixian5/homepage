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
SAFARI_STORAGE_BACKUP_ROOT="${ROOT_DIR}/.test-backups/safari-storage"

quit_safari_for_storage_update() {
  if pgrep -x Safari >/dev/null 2>&1; then
    echo "[build] Quitting Safari before storage snapshot..."
    osascript -e 'tell application "Safari" to quit' 2>/dev/null || true
    for _ in {1..20}; do
      if ! pgrep -x Safari >/dev/null 2>&1; then
        break
      fi
      sleep 0.5
    done
  fi
  if pgrep -x Safari >/dev/null 2>&1; then
    echo "[build] ERROR: Safari is still running; refusing to update without a safe snapshot" >&2
    exit 1
  fi
}

# 签名相关公共函数抽出到 lib，供完整构建与快速续签（safari-refresh-signing.sh）共用。
# shellcheck source=lib/safari-signing.sh
source "${SCRIPT_DIR}/lib/safari-signing.sh"

echo "[build] ROOT_DIR=${ROOT_DIR}"

# 必须在 converter/xcodebuild 注册新扩展、替换 App 之前停止 Safari 并保存一致性快照。
quit_safari_for_storage_update
SAFARI_STORAGE_SNAPSHOT="$({
  python3 "${ROOT_DIR}/scripts/safari-storage-guard.py" snapshot \
    --output-root "${SAFARI_STORAGE_BACKUP_ROOT}"
} | python3 -c 'import json,sys; print(json.load(sys.stdin)["snapshot"])')"
echo "[build] Safari storage snapshot: ${SAFARI_STORAGE_SNAPSHOT}"

if [[ -f "${ROOT_DIR}/logo.png" ]]; then
  echo "[build] Found logo.png, generating extension icons..."
  for size in 16 32 48 128; do
    sips -z "${size}" "${size}" "${ROOT_DIR}/logo.png" --out "${SRC_DIR}/assets/icon-${size}.png" >/dev/null
  done
fi

# 版本号自增与三端 zip 打包统一交给 build.sh：避免本脚本再 bump 一次导致版本连升两档。
# SAFARI_SKIP_APP_BUILD=1 让 build.sh 只生成 Safari Xcode 工程与 safari.zip，
# 宿主 App 的 Release 构建 / 开发签名 / 安装由本脚本接管，避免 Safari 被构建两次。
SAFARI_SKIP_APP_BUILD=1 bash "${ROOT_DIR}/scripts/build.sh"

PROJECT_FILE="$(find "${SAFARI_PROJECT_DIR}" -maxdepth 3 -name '*.xcodeproj' -print -quit)"
PROJECT_ROOT="$(dirname "${PROJECT_FILE}")"
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

  # 方案 B：工程签名与描述文件全部关闭，只编译出未签名产物，随后用脚本手工签名。
  # 这样不依赖 Xcode 账户登录，产物也不内嵌任何会过期的 profile。
  xcodebuild \
    -project "${PROJECT_FILE}" \
    -scheme "${SCHEME_NAME}" \
    -configuration "${SAFARI_XCODE_CONFIGURATION}" \
    -derivedDataPath "${SAFARI_BUILD_DIR}" \
    CODE_SIGNING_ALLOWED=NO \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGN_IDENTITY="" \
    build

  APP_PATH="${SAFARI_BUILD_DIR}/Build/Products/${SAFARI_XCODE_CONFIGURATION}/${SAFARI_APP_NAME}.app"
  if [[ -d "${APP_PATH}" ]]; then
    APPEX_PATH="${APP_PATH}/Contents/PlugIns/${SAFARI_APP_NAME} Extension.appex"
    APPEX_ICON="${APPEX_PATH}/Contents/Resources/ExtensionIcon.icns"
    if [[ ! -s "${APPEX_ICON}" ]]; then
      echo "[build] ERROR: Safari extension icon missing from built appex: ${APPEX_ICON}" >&2
      exit 1
    fi
    post_sign_safari_app "${APP_PATH}" "${PROJECT_ROOT}"
    verify_shared_storage_entitlements "${APP_PATH}"

    # 首次切换存储路径：把旧 App Group 文件复制到共享目录（不覆盖、不删除）
    migrate_safari_app_group_storage

    # 复制到应用程序目录
    APPS_DIR_APP="/Applications/${SAFARI_APP_NAME}.app"
    echo "[build] Copying to ${APPS_DIR_APP}..."
    rm -rf "${APPS_DIR_APP}"
    cp -R "${APP_PATH}" "${APPS_DIR_APP}"

    node "${ROOT_DIR}/scripts/clean-safari-homepage-registrations.mjs"

    python3 "${ROOT_DIR}/scripts/safari-storage-guard.py" verify \
      --snapshot "${SAFARI_STORAGE_SNAPSHOT}" \
      --restore-on-regression

    # Safari 26 将“可用作新窗口和标签页面”和实际选中状态分开保存。
    # 每次更新都重新指向当前签名身份，并立即校验，避免出现扩展已启用但 Cmd+T 仍为空白页。
    python3 "${ROOT_DIR}/scripts/safari-newtab-selection.py" configure \
      --app-path "${APPS_DIR_APP}"

    # Safari 正在运行时重装 app，pluginkit 可能不会登记新扩展，
    # 表现为“扩展突然没了、新标签页回落 favorites://”。
    # 这里显式注册并校验；Safari 运行中注册可能延迟生效，所以只告警不失败。
    echo "[build] Registering Safari extension with pluginkit..."
    pluginkit -a "${APPS_DIR_APP}/Contents/PlugIns/${SAFARI_APP_NAME} Extension.appex" 2>/dev/null || true
    for _ in $(seq 1 20); do
      pluginkit -m -p com.apple.Safari.web-extension 2>/dev/null \
        | grep -q "com.aeroluna.homepage.safari.extension" && break
      sleep 0.25
    done
    if pluginkit -m -p com.apple.Safari.web-extension 2>/dev/null \
      | grep -q "com.aeroluna.homepage.safari.extension"; then
      echo "[build] Safari extension registered"
    else
      echo "[build] WARNING: Safari extension is not registered yet." >&2
      echo "[build]           Quit Safari, then run:" >&2
      echo "[build]           pluginkit -a \"${APPS_DIR_APP}/Contents/PlugIns/${SAFARI_APP_NAME} Extension.appex\"" >&2
    fi

    # Xcode 构建时会将 build-output 里的 .app 注册到 LaunchServices，
    # 安装到 /Applications 后如果不注销源路径，Safari 扩展列表会出现重复条目。
    echo "[build] Unregistering build-output app from LaunchServices..."
    /System/Library/Frameworks/CoreServices.framework/Versions/Current/Frameworks/LaunchServices.framework/Versions/Current/Support/lsregister -u "${APP_PATH}" 2>/dev/null || true

    # 实测：只注销不够，Safari 仍会从构建目录加载那份旧扩展，
    # 结果是列表里两个「我的首页」且实际跑的不是正式版。直接删掉源产物。
    prune_safari_build_products "${SAFARI_XCODE_CONFIGURATION}"

    if [[ "${SAFARI_LAUNCH_AFTER_BUILD:-0}" == "1" ]]; then
      open "${APPS_DIR_APP}"
      echo "[build] launched: ${APPS_DIR_APP}"
    else
      echo "[build] installed without foreground launch"
    fi
  fi
fi

echo "[build] done: ${DIST_DIR}/chrome.zip"
echo "[build] done: ${DIST_DIR}/firefox.zip"
echo "[build] done: ${DIST_DIR}/safari.zip"
if [[ -d "${SAFARI_PROJECT_DIR}" ]]; then
  echo "[build] done: ${SAFARI_PROJECT_DIR}"
fi

# 同步构建入口与其依赖的 lib 到 dist：dist/run-build.command 需要能独立运行。
# 26.1.8 曾只同步 .command 而漏掉 lib/，导致 dist 入口 source lib/safari-signing.sh 失败、构建直接退出。
# 从 dist 入口启动时 SCRIPT_DIR 就是 dist，cp 源与目标为同一文件会报错退出，用 -ef 跳过。
if [[ -d "${DIST_DIR}" && -f "${SCRIPT_DIR}/lib/safari-signing.sh" ]]; then
  mkdir -p "${DIST_DIR}/lib"
  for src in "${SCRIPT_DIR}/build-macos.command" "${SCRIPT_DIR}/run-build.command" "${SCRIPT_DIR}/lib/"*.sh; do
    rel="${src#"${SCRIPT_DIR}/"}"
    dst="${DIST_DIR}/${rel}"
    if [[ "${src}" -ef "${dst}" ]]; then
      continue
    fi
    cp "${src}" "${dst}"
  done
  echo "[build] synced build entry + lib to ${DIST_DIR}"
fi

if [[ "${NO_PAUSE:-0}" != "1" ]]; then
  read -r -p "Build finished. Press Enter to close..."
fi
