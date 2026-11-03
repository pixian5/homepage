#!/usr/bin/env bash
# 安装/卸载 Safari 扩展自动注册的 launchd（系统定时服务）任务。
#
# 作用：每小时（以及每次登录/加载时）检查一次扩展登记，查不到就自动注册回来。
# 覆盖构建时注册失败、系统重启后登记丢失、Safari 更新后消失等所有场景，
# 不再需要人工发现「新标签页回落 favorites」再手动 pluginkit -a。
#   - 幂等：扩展在册时什么都不做，开销可忽略
#   - 注册失败只写日志，下个周期自动重试
#   - 不想保留时直接 uninstall
#
# 用法：
#   bash scripts/setup-safari-extension-register.sh install     # 安装并立即启用
#   bash scripts/setup-safari-extension-register.sh uninstall   # 卸载
#   bash scripts/setup-safari-extension-register.sh status      # 查看是否已加载
#   bash scripts/setup-safari-extension-register.sh run-now     # 立即检查/注册一次
#   bash scripts/setup-safari-extension-register.sh logs        # 查看最近日志

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

LABEL="com.aeroluna.homepage.safari-extension-register"
AGENT_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${AGENT_DIR}/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs"
OUT_LOG="${LOG_DIR}/homepage-extension-register.out.log"
ERR_LOG="${LOG_DIR}/homepage-extension-register.err.log"

REGISTER_SCRIPT="${SCRIPT_DIR}/safari-extension-register.sh"

usage() { sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

write_plist() {
  mkdir -p "${AGENT_DIR}" "${LOG_DIR}"
  cat > "${PLIST_PATH}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${REGISTER_SCRIPT}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>StandardOutPath</key>
  <string>${OUT_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${ERR_LOG}</string>
</dict>
</plist>
PLIST
}

case "${1:-}" in
  install)
    [[ -f "${REGISTER_SCRIPT}" ]] || { echo "缺少 ${REGISTER_SCRIPT}" >&2; exit 1; }
    write_plist
    # 卸掉旧实例再加载，保证配置最新
    launchctl unload "${PLIST_PATH}" >/dev/null 2>&1 || true
    launchctl load "${PLIST_PATH}"
    echo "[setup] 已安装并启用：${LABEL}（每小时检查，登录时也会检查）"
    echo "[setup] 立即执行一次："
    bash "${REGISTER_SCRIPT}" || true
    ;;
  uninstall)
    launchctl unload "${PLIST_PATH}" >/dev/null 2>&1 || true
    rm -f "${PLIST_PATH}"
    echo "[setup] 已卸载：${LABEL}"
    ;;
  status)
    if launchctl list 2>/dev/null | grep -q "${LABEL}"; then
      echo "[setup] 已加载：${LABEL}"
    elif [[ -f "${PLIST_PATH}" ]]; then
      echo "[setup] 未加载，但 plist 仍存在：${PLIST_PATH}"
    else
      echo "[setup] 未安装"
    fi
    ;;
  run-now)
    bash "${REGISTER_SCRIPT}"
    ;;
  logs)
    tail -n 30 "${OUT_LOG}" 2>/dev/null || echo "(暂无输出日志)"
    echo "---"
    tail -n 10 "${ERR_LOG}" 2>/dev/null || echo "(暂无错误日志)"
    ;;
  -h|--help|help) usage ;;
  *) echo "用法：bash $0 install|uninstall|status|run-now|logs" >&2; exit 1 ;;
esac
