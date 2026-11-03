#!/bin/bash
#
# 墓碑回收常态化 launchd 安装脚本（P1 收尾）
#
# 把 scripts/run-tombstone-reclaim.sh 注册为当前用户的 LaunchAgent 定时作业：
# 每天 HOUR:MIN 自动执行（默认 03:30）；默认 --dry-run，可指定 --force。
# 服务器地址与 Token 从环境变量读取，或写入 env 文件持久化。
#
# 用法：
#   bash scripts/setup-tombstone-reclaim.sh install [--force] [--hour 03:30] [--url URL] [--token TOKEN]
#   bash scripts/setup-tombstone-reclaim.sh uninstall
#   bash scripts/setup-tombstone-reclaim.sh status
#
# 退出码：0 成功 ｜ 1 用法错误 ｜ 2 未安装（status/uninstall 时）
#
# 兼容 macOS 自带 bash 3.2；不依赖 jq / launchctl 之外的任何外部工具。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RECLAIM_SCRIPT="${SCRIPT_DIR}/run-tombstone-reclaim.sh"
LABEL="com.homepage.tombstone-reclaim"
# 可注入的 launchctl 路径（测试用假实现替换，避免真实注册用户会话作业）
LAUNCHCTL_BIN="${LAUNCHCTL_BIN:-launchctl}"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST="${PLIST_DIR}/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs/homepage"
ENV_FILE="${PLIST_DIR}/${LABEL}.env"

ACTION="${1:-}"
shift 2>/dev/null

MODE_ARGS="--dry-run"
RUN_HOUR="03:30"
RUN_URL="${SERVER_URL:-http://127.0.0.1:8787}"
RUN_TOKEN="${TOKEN:-}"

usage() {
  sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force) MODE_ARGS="--force" ;;
    --dry-run) MODE_ARGS="--dry-run" ;;
    --hour)
      RUN_HOUR="$2"
      shift
      ;;
    --url)
      RUN_URL="$2"
      shift
      ;;
    --token)
      RUN_TOKEN="$2"
      shift
      ;;
    *)
      echo "错误：未知参数 ${1}（支持 --force / --dry-run / --hour HH:MM / --url URL / --token TOKEN）" >&2
      exit 1
      ;;
  esac
  shift
done

# 校验时间格式 HH:MM（bash 3.2 兼容，不用正则的 \d）
case "$RUN_HOUR" in
  [0-2][0-9]:[0-5][0-9] | [0-9]:[0-5][0-9]) : ;;
  *)
    echo "错误：--hour 需要 HH:MM 格式（收到 ${RUN_HOUR}）" >&2
    exit 1
    ;;
esac
HOUR_PART="${RUN_HOUR%%:*}"
if [ "$HOUR_PART" -gt 23 ] 2>/dev/null; then
  echo "错误：小时必须在 0-23（收到 ${RUN_HOUR}）" >&2
  exit 1
fi
MINUTE_PART="${RUN_HOUR#*:}"

escape_xml() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'
}

uninstall_job() {
  if [ ! -f "$PLIST" ]; then
    echo "[uninstall] 未安装（${PLIST} 不存在）"
    return 2
  fi
  "$LAUNCHCTL_BIN" unload "$PLIST" >/dev/null 2>&1
  rm -f "$PLIST" "$ENV_FILE"
  echo "[uninstall] 已卸载 ${LABEL}（plist 与 env 文件已删除）"
  return 0
}

case "$ACTION" in
  install)
    if [ ! -f "$RECLAIM_SCRIPT" ]; then
      echo "错误：找不到回收脚本 ${RECLAIM_SCRIPT}" >&2
      exit 1
    fi
    mkdir -p "$PLIST_DIR" "$LOG_DIR"
    # 服务器地址与 Token 写入 env 文件（Token 不进 plist，避免被 launchd print 泄露）
    cat > "$ENV_FILE" <<ENV
SERVER_URL=$(escape_xml "$RUN_URL")
TOKEN=$(escape_xml "$RUN_TOKEN")
ENV
    chmod 600 "$ENV_FILE"

    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${RECLAIM_SCRIPT}</string>
    <string>${MODE_ARGS}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${HOUR_PART#0}</integer>
    <key>Minute</key>
    <integer>${MINUTE_PART#0}</integer>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SERVER_URL</key>
    <string>$(escape_xml "$RUN_URL")</string>
    <key>TOKEN</key>
    <string>$(escape_xml "$RUN_TOKEN")</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/tombstone-reclaim.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/tombstone-reclaim.log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
PLIST

    # 先卸旧再载新，保证幂等安装
    "$LAUNCHCTL_BIN" unload "$PLIST" >/dev/null 2>&1
    if ! "$LAUNCHCTL_BIN" load "$PLIST" 2>/dev/null; then
      echo "错误：launchctl load 失败，请检查 plist：${PLIST}" >&2
      exit 1
    fi
    echo "[install] 已安装 ${LABEL}：每天 ${RUN_HOUR} 执行 ${MODE_ARGS}"
    echo "[install] 服务器: ${RUN_URL}  日志: ${LOG_DIR}/tombstone-reclaim.log"
    exit 0
    ;;
  uninstall)
    uninstall_job
    exit $?
    ;;
  status)
    if [ ! -f "$PLIST" ]; then
      echo "[status] 未安装（${PLIST} 不存在）"
      exit 2
    fi
    echo "[status] plist: ${PLIST}"
    grep -A1 "StartCalendarInterval\|<string>${RECLAIM_SCRIPT}\|<string>--" "$PLIST" | grep -E "Hour|Minute|<integer>|run-tombstone|--" || true
    if "$LAUNCHCTL_BIN" list 2>/dev/null | grep -q "$LABEL"; then
      echo "[status] launchd: 已加载"
    else
      echo "[status] launchd: 未加载（可执行: launchctl load ${PLIST}）"
    fi
    exit 0
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    echo "错误：未知动作「${ACTION}」（支持 install / uninstall / status）" >&2
    usage
    exit 1
    ;;
esac
