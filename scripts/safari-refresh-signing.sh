#!/usr/bin/env bash
# Safari 签名体检 / 重建入口（2026-10-24 方案 B：无描述文件、无 7 天续期）
#
# 背景：macOS 27 上带 App Sandbox / App Group 的 bundle 没有内嵌描述文件会被
# launchd/AMFI 直接 SIGKILL。方案 B 改为「宿主不沙箱 + 扩展限定目录」的普通文件，
# 两端都不再需要 provisioning profile，因此不再存在 7 天续期这件事。
#
# 本脚本现在的职责只剩两件：
#   1. 体检：签名是否有效、是否仍是 adhoc、是否还残留旧描述文件；
#   2. 需要时调用完整构建重建（会退出 Safari、替换 /Applications）。
#
# 用法：
#   bash scripts/safari-refresh-signing.sh              # 只体检，必要时重建
#   bash scripts/safari-refresh-signing.sh --dry-run    # 只体检，不重建
#   bash scripts/safari-refresh-signing.sh --force      # 无条件重建
#
# 退出码：0 正常；1 需要人工处理；2 环境/参数错误；3 Safari 运行中跳过。

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

SAFARI_APP_NAME="${SAFARI_APP_NAME:-我的首页 Safari}"
APPS_DIR_APP="/Applications/${SAFARI_APP_NAME}.app"

FORCE=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "[refresh] ERROR: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [[ ! -d "${APPS_DIR_APP}" ]]; then
  echo "[refresh] ERROR: installed app not found: ${APPS_DIR_APP}" >&2
  exit 2
fi

STATUS_JSON="$(python3 "${SCRIPT_DIR}/safari-signing-status.py" --app-path "${APPS_DIR_APP}" --json 2>/dev/null || true)"
if [[ -z "${STATUS_JSON}" ]]; then
  echo "[refresh] ERROR: unable to read signing status for ${APPS_DIR_APP}" >&2
  exit 2
fi

read_field() {
  printf '%s' "${STATUS_JSON}" | python3 -c '
import json,sys
data = json.load(sys.stdin)
path = sys.argv[1].split(".")
value = data
for key in path:
    if not isinstance(value, dict):
        value = None
        break
    value = value.get(key)
print("" if value is None else value)
' "$1"
}

VERIFIED="$(read_field verified)"
ADHOC="$(read_field adhoc)"
PROFILE_PRESENT="$(read_field profile.present)"
PROFILE_DAYS="$(read_field profile.days_remaining)"

echo "[refresh] verified=${VERIFIED} adhoc=${ADHOC} profile_present=${PROFILE_PRESENT} profile_days=${PROFILE_DAYS}"

NEED_REBUILD=0
if [[ "${FORCE}" == "1" ]]; then
  NEED_REBUILD=1
elif [[ "${VERIFIED}" != "True" || "${ADHOC}" == "True" ]]; then
  NEED_REBUILD=1
elif [[ "${PROFILE_PRESENT}" == "True" ]]; then
  # 旧版安装件仍带 7 天描述文件，建议一次性重建到方案 B
  NEED_REBUILD=1
fi

if [[ "${NEED_REBUILD}" != "1" ]]; then
  echo "[refresh] Signature valid and no embedded profile: nothing to renew"
  exit 0
fi

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "[refresh] --dry-run: rebuild needed but not performed"
  exit 0
fi

if pgrep -x Safari >/dev/null 2>&1; then
  echo "[refresh] Safari is running; skip to avoid disturbing the user" >&2
  exit 3
fi

echo "[refresh] Rebuilding and reinstalling app (no version bump)..."
SKIP_BUMP=1 NO_PAUSE=1 SAFARI_LAUNCH_AFTER_BUILD=0 bash "${ROOT_DIR}/scripts/build-macos.command"

echo "[refresh] Verifying installed app..."
python3 "${SCRIPT_DIR}/safari-signing-status.py" --app-path "${APPS_DIR_APP}"
