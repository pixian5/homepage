#!/usr/bin/env bash
# 安装/卸载 Safari 扩展签名自动续期的 launchd（系统定时服务）任务。
#
# 免费 Apple ID（Apple 账户）的开发描述文件只有 7 天有效期，靠人工每周记着跑一次不现实。
# 这里注册一个每天运行两次的 LaunchAgent（用户级定时任务）：
#   - 剩余天数不足阈值（默认 3 天）才真正续签
#   - Safari 正在运行时跳过，下次再试，绝不打断正在使用的浏览器
#   - 续签失败也不动 /Applications，只写日志，等下一个时间点重试
#
# 用法：
#   bash scripts/setup-safari-signing-refresh.sh install     # 安装并立即启用
#   bash scripts/setup-safari-signing-refresh.sh uninstall   # 卸载
#   bash scripts/setup-safari-signing-refresh.sh status      # 查看是否已加载
#   bash scripts/setup-safari-signing-refresh.sh run-now     # 立即跑一次（等同手动续签，Safari 运行时会跳过）
#   bash scripts/setup-safari-signing-refresh.sh logs        # 查看最近日志

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

LABEL="com.aeroluna.homepage.safari-signing-refresh"
AGENT_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${AGENT_DIR}/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs"
OUT_LOG="${LOG_DIR}/homepage-safari-refresh.out.log"
ERR_LOG="${LOG_DIR}/homepage-safari-refresh.err.log"

REFRESH_SCRIPT="${SCRIPT_DIR}/safari-refresh-signing.sh"

write_plist() {
  mkdir -p "${AGENT_DIR}" "${LOG_DIR}"
  cat >"${PLIST_PATH}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>${REFRESH_SCRIPT}</string>
	</array>
	<key>WorkingDirectory</key>
	<string>${ROOT_DIR}</string>
	<!-- launchd 环境 PATH 很干净，必须显式带上 /usr/bin，否则找不到 python3 等命令 -->
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
	</dict>
	<!-- 每天两次机会：一次撞上 Safari 未运行的概率更高 -->
	<key>StartCalendarInterval</key>
	<array>
		<dict>
			<key>Hour</key>
			<integer>9</integer>
			<key>Minute</key>
			<integer>0</integer>
		</dict>
		<dict>
			<key>Hour</key>
			<integer>21</integer>
			<key>Minute</key>
			<integer>0</integer>
		</dict>
	</array>
	<key>StandardOutPath</key>
	<string>${OUT_LOG}</string>
	<key>StandardErrorPath</key>
	<string>${ERR_LOG}</string>
</dict>
</plist>
PLIST
  echo "[setup] Wrote ${PLIST_PATH}"
}

install_agent() {
  if [[ ! -f "${REFRESH_SCRIPT}" ]]; then
    echo "[setup] ERROR: refresh script missing: ${REFRESH_SCRIPT}" >&2
    exit 2
  fi

  write_plist

  # 先卸载可能存在的旧任务，避免重复注册
  launchctl bootout "gui/${UID}/${LABEL}" 2>/dev/null || true
  launchctl bootstrap "gui/${UID}" "${PLIST_PATH}"
  launchctl enable "gui/${UID}/${LABEL}"
  echo "[setup] Installed and enabled: ${LABEL}"
  echo "[setup] Schedule: every day 09:00 and 21:00"
  echo "[setup] Logs: ${OUT_LOG} / ${ERR_LOG}"
  echo "[setup] Test now: bash scripts/setup-safari-signing-refresh.sh run-now"
}

uninstall_agent() {
  launchctl bootout "gui/${UID}/${LABEL}" 2>/dev/null || true
  rm -f "${PLIST_PATH}" 2>/dev/null || true
  echo "[setup] Uninstalled: ${LABEL}"
}

show_status() {
  if launchctl print "gui/${UID}/${LABEL}" >/dev/null 2>&1; then
    echo "[setup] Status: loaded"
    launchctl print "gui/${UID}/${LABEL}" 2>/dev/null | grep -E "state|last exit|runs" | head -5 || true
  else
    echo "[setup] Status: not loaded"
  fi
  echo "[setup] Plist: ${PLIST_PATH} $([[ -f "${PLIST_PATH}" ]] && echo '(exists)' || echo '(missing)')"
}

run_now() {
  echo "[setup] Running refresh now..."
  launchctl kickstart -p "gui/${UID}/${LABEL}" 2>/dev/null || bash "${REFRESH_SCRIPT}"
}

show_logs() {
  for log in "${OUT_LOG}" "${ERR_LOG}"; do
    echo "=== ${log} ==="
    if [[ -f "${log}" ]]; then
      tail -n 20 "${log}"
    else
      echo "(no log yet)"
    fi
  done
}

case "${1:-install}" in
  install) install_agent ;;
  uninstall) uninstall_agent ;;
  status) show_status ;;
  run-now) run_now ;;
  logs) show_logs ;;
  *)
    echo "Usage: $0 {install|uninstall|status|run-now|logs}" >&2
    exit 2
    ;;
esac
