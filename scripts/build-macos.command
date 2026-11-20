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

# 不发退出命令，即使是显式安装也不替用户决定丢弃窗口。只认本次命令的参数。
if [[ $# == 0 ]]; then
  echo "[build] 仅打包扩展；不安装、不启动、不退出任何浏览器。"
  exec bash "${SCRIPT_DIR}/build.sh"
fi
if [[ $# != 1 || "$1" != "--install" ]]; then
  echo "用法：$0 [--install]（仅在自行退出 Safari 后显式安装）" >&2
  exit 2
fi

require_safari_stopped() {
  local rc
  if pgrep -x Safari >/dev/null; then
    echo "[install] Safari 正在运行，已停止安装；所有窗口保持原样。" >&2
    return 3
  else
    rc=$?
    if [[ $rc != 1 ]]; then
      echo "[install] 无法确认 Safari 是否已退出，不继续安装。" >&2
      return 3
    fi
  fi
}

# 签名相关公共函数抽出到 lib，供完整构建与快速续签（safari-refresh-signing.sh）共用。
# shellcheck source=lib/safari-signing.sh
source "${SCRIPT_DIR}/lib/safari-signing.sh"

echo "[build] ROOT_DIR=${ROOT_DIR}"

# 仅当 Safari 已由用户退出时，才读取快照、生成工程并安装。
require_safari_stopped
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
# --safari-project-only 让 build.sh 只生成 Safari Xcode 工程与扩展包，
# 宿主 App 的 Release 构建 / 开发签名 / 安装由本脚本接管，避免 Safari 被构建两次。
bash "${ROOT_DIR}/scripts/build.sh" --safari-project-only

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
    require_safari_stopped
    migrate_safari_app_group_storage

    # 复制到应用程序目录
    APPS_DIR_APP="/Applications/${SAFARI_APP_NAME}.app"
    echo "[build] Copying to ${APPS_DIR_APP}..."
    require_safari_stopped
    rm -rf "${APPS_DIR_APP}"
    cp -R "${APP_PATH}" "${APPS_DIR_APP}"

    require_safari_stopped
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
    # 注册逻辑抽到 safari-extension-register.sh（幂等：在册直接成功）；
    # 构建失败不影响产物——每小时 launchd 自愈任务（setup-safari-extension-register.sh）会兜底补注册。
    echo "[build] Registering Safari extension with pluginkit..."
    if bash "${SCRIPT_DIR}/safari-extension-register.sh"; then
      echo "[build] Safari extension registered"
    else
      echo "[build] WARNING: 本次注册未确认，launchd 自愈任务将在一小时内自动重试" >&2
      echo "[build]           也可立即执行：bash ${SCRIPT_DIR}/safari-extension-register.sh" >&2
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

if [[ "${NO_PAUSE:-0}" != "1" ]]; then
  read -r -p "Build finished. Press Enter to close..."
fi
