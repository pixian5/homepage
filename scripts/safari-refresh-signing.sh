#!/usr/bin/env bash
# Safari 扩展签名快速续签。
#
# 背景：免费 Apple ID（Apple 账户）由 Xcode（苹果开发工具）自动管理的开发描述文件
# 有效期只有 7 天，到期后 Safari 扩展会静默失效。本脚本只刷新签名与描述文件，
# 不做完整构建，因此具备以下特点：
#   - 不递增版本号（续签不是发布新版本）
#   - 不重新生成 Xcode 工程、不重跑 Safari converter（转换器）
#   - 保留 xcodebuild 缓存目录，走增量构建
#   - 不重配新标签页选择：签名身份（团队标识 + Bundle ID）没变，原有选择依然有效
#   - Safari 运行时直接退出，绝不打扰正在使用的浏览器
#
# 用法：
#   bash scripts/safari-refresh-signing.sh                # 仅在剩余不足阈值时续签
#   bash scripts/safari-refresh-signing.sh --force        # 无条件续签
#   bash scripts/safari-refresh-signing.sh --dry-run      # 只构建不安装，用于验证
#   SAFARI_REFRESH_THRESHOLD_DAYS=1 bash scripts/safari-refresh-signing.sh

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

SAFARI_APP_NAME="${SAFARI_APP_NAME:-我的首页 Safari}"
SAFARI_PROJECT_DIR="${ROOT_DIR}/dist/safari-app"
SAFARI_BUILD_DIR="${SAFARI_PROJECT_DIR}/build"
SAFARI_XCODE_CONFIGURATION="${SAFARI_XCODE_CONFIGURATION:-Release}"
SAFARI_APP_GROUP_ID="${SAFARI_APP_GROUP_ID:-group.com.aeroluna.homepage.safari}"
SAFARI_REFRESH_THRESHOLD_DAYS="${SAFARI_REFRESH_THRESHOLD_DAYS:-3}"

# 引入公共签名函数（post_sign_safari_app / verify_stable_storage_entitlements）
# shellcheck source=lib/safari-signing.sh
source "${SCRIPT_DIR}/lib/safari-signing.sh"

FORCE=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "[refresh] ERROR: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

APPS_DIR_APP="/Applications/${SAFARI_APP_NAME}.app"
# 阈值必须传给检测脚本，否则它会用自己默认的 3 天，bash 侧设置的环境变量就失效了
STATUS_CMD=(python3 "${SCRIPT_DIR}/safari-signing-status.py" --app-path "${APPS_DIR_APP}"
            --threshold "${SAFARI_REFRESH_THRESHOLD_DAYS}" --json)

echo "[refresh] Reading current signing status..."
CURRENT_STATUS="$("${STATUS_CMD[@]}" || true)"
if [[ -z "${CURRENT_STATUS}" ]]; then
  echo "[refresh] ERROR: unable to read signing status for ${APPS_DIR_APP}" >&2
  exit 2
fi

DAYS_LEFT="$(printf '%s' "${CURRENT_STATUS}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("profile",{}).get("days_remaining"))')"
NEEDS_REFRESH="$(printf '%s' "${CURRENT_STATUS}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("needs_refresh"))')"
# 用描述文件 UUID（唯一标识）判断是否真的换了一份新的，
# 比"剩余天数是否增加"更可靠：连续两天续签时天数都是 7.0，但 UUID 必然不同。
OLD_UUID="$(printf '%s' "${CURRENT_STATUS}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("profile",{}).get("uuid",""))')"

echo "[refresh] Profile days remaining: ${DAYS_LEFT} (threshold ${SAFARI_REFRESH_THRESHOLD_DAYS})"
if [[ "${FORCE}" != "1" && "${NEEDS_REFRESH}" != "True" ]]; then
  echo "[refresh] No refresh needed, exit"
  exit 0
fi

PROJECT_FILE="$(find "${SAFARI_PROJECT_DIR}" -maxdepth 3 -name '*.xcodeproj' -print -quit)"
if [[ -z "${PROJECT_FILE}" ]]; then
  echo "[refresh] ERROR: Xcode project not found under ${SAFARI_PROJECT_DIR}" >&2
  echo "[refresh] Run scripts/build-macos.command once to generate it" >&2
  exit 2
fi

SCHEME_NAME="$(
  xcodebuild -list -project "${PROJECT_FILE}" 2>/dev/null \
    | sed -n '/Schemes:/,$p' | sed '1d' | sed 's/^[[:space:]]*//' \
    | grep '(macOS)' | head -n 1
)"
if [[ -z "${SCHEME_NAME}" ]]; then
  SCHEME_NAME="${SAFARI_APP_NAME}"
fi

# 真实安装路径下，Safari 运行期间替换 .app 会把内存里的旧扩展状态写回，制造幽灵条目。
# 演练模式不碰 /Applications，所以不受此限制。这里先拦一次，免得白跑一遍构建。
if [[ "${DRY_RUN}" != "1" ]] && pgrep -x Safari >/dev/null 2>&1; then
  echo "[refresh] Safari is running; skip to avoid disturbing the user. Try again later." >&2
  exit 3
fi

# 实测：不清缓存，Xcode 会复用仍未过期的旧 profile，续签后剩余天数不变。
purge_safari_profile_cache

echo "[refresh] Building (incremental) to refresh provisioning profile..."
XCODEBUILD_ARGS=(
  -project "${PROJECT_FILE}"
  -scheme "${SCHEME_NAME}"
  -configuration "${SAFARI_XCODE_CONFIGURATION}"
  -derivedDataPath "${SAFARI_BUILD_DIR}"
)
if [[ "${SAFARI_ENABLE_TEAM_SIGNING:-1}" == "1" ]]; then
  XCODEBUILD_ARGS+=(-allowProvisioningUpdates)
fi
xcodebuild "${XCODEBUILD_ARGS[@]}" build

APP_PATH="${SAFARI_BUILD_DIR}/Build/Products/${SAFARI_XCODE_CONFIGURATION}/${SAFARI_APP_NAME}.app"
if [[ ! -d "${APP_PATH}" ]]; then
  echo "[refresh] ERROR: built app not found: ${APP_PATH}" >&2
  exit 2
fi

post_sign_safari_app "${APP_PATH}" "${SAFARI_XCODE_CONFIGURATION}"
verify_stable_storage_entitlements "${APP_PATH}"

NEW_STATUS="$(python3 "${SCRIPT_DIR}/safari-signing-status.py" --app-path "${APP_PATH}" --json 2>/dev/null || true)"
NEW_DAYS="$(printf '%s' "${NEW_STATUS}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("profile",{}).get("days_remaining"))' 2>/dev/null || echo '')"
NEW_UUID="$(printf '%s' "${NEW_STATUS}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("profile",{}).get("uuid",""))' 2>/dev/null || echo '')"
echo "[refresh] Rebuilt app profile: days=${NEW_DAYS} uuid=${NEW_UUID}"

# 续签的核心目的就是拿到一份新签发的描述文件。
# UUID 没变说明 Xcode 复用了旧 profile，装上去也是白装，直接失败由人工介入。
if ! python3 - "${OLD_UUID}" "${NEW_UUID}" "${NEW_DAYS}" <<'PY'
import sys

old_uuid, new_uuid, days_raw = sys.argv[1], sys.argv[2], sys.argv[3]

if not new_uuid:
    print("[refresh] ERROR: rebuilt app has no readable provisioning profile")
    sys.exit(1)

if old_uuid and new_uuid == old_uuid:
    print(
        "[refresh] ERROR: profile was not renewed (uuid unchanged: %s). "
        "Check Xcode account login, network, and cached profiles." % new_uuid
    )
    sys.exit(1)

try:
    days = float(days_raw)
except (TypeError, ValueError):
    print("[refresh] ERROR: cannot read remaining days from rebuilt profile (%s)" % days_raw)
    sys.exit(1)

# 新签发的开发描述文件应接近 7 天；低于 6 天说明拿到的不是全新的一份
if days < 6:
    print("[refresh] ERROR: rebuilt profile only has %.2f days left, expected ~7" % days)
    sys.exit(1)

print("[refresh] Profile renewed: uuid=%s, %.2f days remaining" % (new_uuid, days))
PY
then
  echo "[refresh] Aborting; /Applications left untouched" >&2
  exit 1
fi

# 演练模式只构建不安装，不触碰 /Applications，因此不必等 Safari 退出
if [[ "${DRY_RUN}" == "1" ]]; then
  echo "[refresh] --dry-run: built and signed, NOT installed to /Applications"
  echo "[refresh] built app: ${APP_PATH}"
  exit 0
fi

# Safari 运行期间替换 .app，会把内存里的旧扩展状态写回，制造幽灵条目。
if pgrep -x Safari >/dev/null 2>&1; then
  echo "[refresh] Safari is running; skip to avoid disturbing the user. Try again later." >&2
  exit 3
fi

echo "[refresh] Installing to ${APPS_DIR_APP}..."
rm -rf "${APPS_DIR_APP}"
cp -R "${APP_PATH}" "${APPS_DIR_APP}"

# 注销构建产物路径，避免 Safari 扩展列表出现两个同名条目
lsregister_bin=/System/Library/Frameworks/CoreServices.framework/Versions/Current/Frameworks/LaunchServices.framework/Versions/Current/Support/lsregister
"${lsregister_bin}" -u "${APP_PATH}" 2>/dev/null || true

# 光注销不够，Safari 仍会从构建目录加载那份旧扩展，直接删掉源产物
prune_safari_build_products "${SAFARI_XCODE_CONFIGURATION:-Release}"

echo "[refresh] Verifying installed app..."
"${STATUS_CMD[@]}" >/dev/null || true
python3 "${SCRIPT_DIR}/safari-signing-status.py" --app-path "${APPS_DIR_APP}"

echo "[refresh] done. Safari 扩展身份未变，无需重新勾选；若列表异常再到设置里确认一次。"
