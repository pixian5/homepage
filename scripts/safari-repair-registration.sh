#!/usr/bin/env bash
# Safari 扩展「消失」自愈脚本
#
# 症状：Safari 设置里看不到「我的首页」，新标签页变回默认页；
#      `pluginkit -m` 查不到 com.aeroluna.homepage.safari.extension；
#      Safari 的 Extensions.plist 里该条目 RemovedDate 有值。
#
# 原因：App 包本身完好（签名有效、无描述文件），但**系统注册表里没有它**。
#      App 被替换、LaunchServices 数据库刷新、或 Safari 主动移除，都会造成这种「包在、注册没了」的状态。
#
# 本脚本做的事（全部幂等，可反复执行）：
#   1. 校验 /Applications 里的 App 与内嵌 appex 是否存在、签名是否有效；
#   2. 刷新 LaunchServices 记录（lsregister -f）；
#   3. 重新注册 appex（pluginkit -a）并显式启用（pluginkit -e use）；
#   4. 打印结果与后续操作提示。
#
# 用法：
#   bash scripts/safari-repair-registration.sh            # 修复
#   bash scripts/safari-repair-registration.sh --dry-run  # 只检查，不修改
#   bash scripts/safari-repair-registration.sh --quiet    # 静默（供定时任务调用）
#
# 退出码：0 已恢复；1 需要人工处理（包损坏/签名无效）；2 环境错误。

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

APP_NAME="${SAFARI_APP_NAME:-我的首页 Safari}"
APP="/Applications/${APP_NAME}.app"
EXT_ID="com.aeroluna.homepage.safari.extension"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

DRY_RUN=0
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --quiet) QUIET=1 ;;
    -h|--help)
      sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "[repair] ERROR: 未知参数 $arg" >&2; exit 2 ;;
  esac
done

say() { [[ "${QUIET}" == "1" ]] || echo "$@"; }
run() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    say "[dry-run] $*"
  else
    "$@"
  fi
}

# --- 1. 前置校验 ---------------------------------------------------------
if [[ ! -d "${APP}" ]]; then
  echo "[repair] 错误：找不到 ${APP}" >&2
  exit 2
fi

# 找出内嵌 appex（名字可能随 App 名变化，用通配更稳）
APPEX="$(find "${APP}/Contents/PlugIns" -maxdepth 1 -name "*.appex" -print -quit 2>/dev/null || true)"
if [[ -z "${APPEX}" ]]; then
  echo "[repair] 错误：${APP} 里没有 .appex，需要重新构建安装" >&2
  exit 1
fi

if ! codesign -v "${APP}" 2>/dev/null; then
  echo "[repair] 错误：App 签名无效，需要重新签名（bash scripts/build-macos.command）" >&2
  exit 1
fi

say "[repair] App   : ${APP}"
say "[repair] appex : ${APPEX}"

# --- 2. 判断当前是否已注册 ----------------------------------------------
# 注意：不能写成 `pluginkit ... | grep -q`，grep 提前退出会让 pluginkit 收到 SIGPIPE，
# 在 set -o pipefail 下整条管道失败，误判成「未注册」。
BEFORE="$(pluginkit -m -A -v 2>/dev/null | grep "${EXT_ID}" || true)"
if [[ -n "${BEFORE}" ]]; then
  say "[repair] 已注册，无需修复"
else
  say "[repair] 未注册，开始修复"
fi

# --- 3. 刷新 LaunchServices + 注册 --------------------------------------
run "$LSREGISTER" -f "${APP}" >/dev/null 2>&1 || true
run pluginkit -a "${APPEX}"
run pluginkit -e use -i "${EXT_ID}" >/dev/null 2>&1 || true

# --- 4. 复查 -------------------------------------------------------------
if [[ "${DRY_RUN}" == "1" ]]; then
  say "[dry-run] 跳过复查"
  exit 0
fi

LINE="$(pluginkit -m -A -v 2>/dev/null | grep "${EXT_ID}" | head -1 || true)"
if [[ -z "${LINE}" ]]; then
  echo "[repair] 失败：注册后 pluginkit 仍查不到 ${EXT_ID}" >&2
  exit 1
fi

say "[repair] 已注册：${LINE}"
say "[repair] 下一步：打开 Safari → 设置 → 扩展，确认「我的首页」已勾选；"
say "[repair] 若新标签页没变回来，在扩展设置里重新选择「覆盖新标签页」。"
exit 0
