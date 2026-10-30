#!/usr/bin/env bash
set -Eeuo pipefail

# 把 Homepage 同步服务装成 macOS 用户级自启（LaunchAgent）。
#
# 行为：登录时自动启动；进程退出（崩溃或被 kill）后 launchd 自动重拉；
# 日志写到 ~/Library/Logs/homepage-sync/，不污染仓库。
#
# 用法：
#   bash scripts/setup-sync-server-macos.sh install [--dry-run]
#   bash scripts/setup-sync-server-macos.sh status
#   bash scripts/setup-sync-server-macos.sh restart
#   bash scripts/setup-sync-server-macos.sh logs
#   bash scripts/setup-sync-server-macos.sh uninstall
#
# 可用环境变量覆盖：
#   SYNC_PORT=8787          监听端口
#   SYNC_HOST=127.0.0.1     监听地址（默认仅回环，局域网访问设为 0.0.0.0）
#   NODE_BIN=/path/to/node  指定 node，默认取当前 PATH 里的 node
#   SYNC_TOKEN=...          服务端令牌；不设则保持当前「无令牌」行为

LABEL="com.aeroluna.homepage.sync-server"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SERVER_JS="${PROJECT_ROOT}/scripts/sync-server.mjs"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs/homepage-sync"
LOG_OUT="${LOG_DIR}/server.log"
LOG_ERR="${LOG_DIR}/server.err.log"
PORT="${SYNC_PORT:-8787}"
HOST="${SYNC_HOST:-127.0.0.1}"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"

DRY_RUN=0
[[ "${2:-}" == "--dry-run" ]] && DRY_RUN=1

info() { printf '[sync-server] %s\n' "$*"; }
die() { printf '[sync-server] 错误：%s\n' "$*" >&2; exit 1; }

run() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

resolve_node() {
  if [[ -n "${NODE_BIN:-}" ]]; then
    [[ -x "${NODE_BIN}" ]] || die "指定的 NODE_BIN 不可执行：${NODE_BIN}"
    printf '%s' "${NODE_BIN}"
    return
  fi
  # 优先选「用户自己装的、不会被工具链回收」的 node：
  # 先 Homebrew 标准位置，再 nvm 里版本号最大的一个，最后才退回 PATH。
  local candidate=""
  for p in /opt/homebrew/bin/node /usr/local/bin/node; do
    [[ -x "${p}" ]] && { candidate="${p}"; break; }
  done
  if [[ -z "${candidate}" ]]; then
    local best=""
    for p in "${HOME}"/.nvm/versions/node/*/bin/node; do
      [[ -x "${p}" ]] || continue
      if [[ -z "${best}" ]] || [[ "$(printf '%s\n%s\n' "${best}" "${p}" | sort -V | tail -1)" == "${p}" ]]; then
        best="${p}"
      fi
    done
    candidate="${best}"
  fi
  [[ -n "${candidate}" ]] || candidate="$(command -v node || true)"
  [[ -n "${candidate}" ]] || die "找不到 node，请用 NODE_BIN=/path/to/node 指定"
  # 解析成真实路径，避免 launchd 里指向会变的软链
  python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "${candidate}"
}

render_plist() {
  local node_bin="$1"
  local env_block=""
  env_block+="        <key>HOST</key><string>${HOST}</string>"$'\n'
  env_block+="        <key>PORT</key><string>${PORT}</string>"$'\n'
  if [[ -n "${SYNC_TOKEN:-}" ]]; then
    env_block+="        <key>TOKEN</key><string>${SYNC_TOKEN}</string>"$'\n'
  fi

  cat <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${node_bin}</string>
        <string>${SERVER_JS}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_ROOT}</string>
    <key>EnvironmentVariables</key>
    <dict>
${env_block}    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${LOG_OUT}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_ERR}</string>
</dict>
</plist>
PLIST_EOF
}

is_loaded() {
  launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1
}

ports_busy() {
  lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1
}

health_ok() {
  curl -fsS -m 3 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1
}

cmd_install() {
  [[ -f "${SERVER_JS}" ]] || die "找不到 ${SERVER_JS}"
  local node_bin
  node_bin="$(resolve_node)"
  info "node    : ${node_bin} ($("${node_bin}" -v))"
  info "项目    : ${PROJECT_ROOT}"
  info "监听    : ${HOST}:${PORT}"
  info "plist   : ${PLIST}"
  info "日志    : ${LOG_DIR}"

  if ports_busy && ! is_loaded; then
    info "警告：${PORT} 端口已被其它进程占用，安装后会启动失败"
    lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN | sed -n '1,3p'
  fi

  if [[ "${DRY_RUN}" == "1" ]]; then
    info "dry-run：以下 plist 不会被写入，也不会加载"
    render_plist "${node_bin}"
    return 0
  fi

  mkdir -p "${LOG_DIR}" "$(dirname "${PLIST}")"
  render_plist "${node_bin}" > "${PLIST}"
  plutil -lint "${PLIST}" >/dev/null || die "plist 格式非法"

  if is_loaded; then
    launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
  fi
  launchctl bootstrap "${DOMAIN}" "${PLIST}"
  launchctl enable "${DOMAIN}/${LABEL}" 2>/dev/null || true
  launchctl kickstart -k "${DOMAIN}/${LABEL}"

  for _ in $(seq 1 30); do
    if health_ok; then
      info "已启动，/health 正常"
      cmd_status
      return 0
    fi
    sleep 0.5
  done
  die "启动后 10 秒内 /health 不通，请执行 logs 查看 ${LOG_ERR}"
}

cmd_status() {
  local node_bin=""
  if [[ -f "${PLIST}" ]]; then
    node_bin="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "${PLIST}" 2>/dev/null || true)"
  fi
  echo "标签    : ${LABEL}"
  echo "plist   : $([[ -f "${PLIST}" ]] && echo "${PLIST}" || echo '缺失')"
  echo "已加载  : $(is_loaded && echo 是 || echo 否)"
  if [[ -n "${node_bin}" ]]; then
    echo "node    : ${node_bin} $([[ -x "${node_bin}" ]] && echo "($("${node_bin}" -v))" || echo '（不存在！需重新 install）')"
  fi
  local pid
  # 注意：BSD awk 不支持 \s，必须用字符类
  pid="$(launchctl print "${DOMAIN}/${LABEL}" 2>/dev/null | awk -F'= ' '/^[ \t]*pid = /{print $2; exit}')"
  echo "PID     : ${pid:-无}"
  echo "端口    : $(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $1" "$9}')"
  echo "健康检查: $(health_ok && echo "200 正常" || echo '不通')"
  if [[ -n "${pid}" ]]; then
    ps -o rss=,%cpu=,etime= -p "${pid}" 2>/dev/null | awk '{printf "内存    : %.1f MB  CPU %s%%  运行 %s\n", $1/1024, $2, $3}'
  fi
  echo "日志    : ${LOG_OUT}"
  echo "          ${LOG_ERR}"
}

cmd_restart() {
  is_loaded || die "服务未加载，先执行 install"
  launchctl kickstart -k "${DOMAIN}/${LABEL}"
  info "已重启"
  sleep 1
  cmd_status
}

cmd_logs() {
  mkdir -p "${LOG_DIR}"
  info "Ctrl-C 退出"
  tail -n 50 -f "${LOG_OUT}" "${LOG_ERR}"
}

cmd_uninstall() {
  if is_loaded; then
    launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
    info "已停止并移除自启"
  else
    info "服务未加载"
  fi
  [[ -f "${PLIST}" ]] && rm -f "${PLIST}" && info "已删除 ${PLIST}"
  info "日志保留在 ${LOG_DIR}（需要可自行删除）"
}

case "${1:-}" in
  install)   cmd_install ;;
  status)    cmd_status ;;
  restart)   cmd_restart ;;
  logs)      cmd_logs ;;
  uninstall) cmd_uninstall ;;
  *)
    sed -n '6,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
