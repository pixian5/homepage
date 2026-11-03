#!/usr/bin/env bash
# Safari 扩展登记自愈：查不到扩展时自动执行 pluginkit -a 注册回来。
#
# 背景：构建脚本装完 .app 会注册扩展，但 Safari 运行中注册可能延迟生效，
# 系统重启/Safari 更新后 pluginkit 数据也可能丢失（26.7.5 复核实测发生过），
# 表现为「新标签页回落 favorites://、设置里查不到扩展」。
# 本脚本幂等：已在册则直接成功，供 launchd 定时任务与构建脚本共用。
#
# 用法：
#   bash scripts/safari-extension-register.sh          # 检查并按需注册（幂等）
#   bash scripts/safari-extension-register.sh --check  # 只检查不注册（退出码 0=在册 3=丢失）

set -uo pipefail

APP_PATH="${SAFARI_APP_PATH:-/Applications/我的首页 Safari.app}"
APPEX_PATH="${APP_PATH}/Contents/PlugIns/我的首页 Safari Extension.appex"
EXT_ID="com.aeroluna.homepage.safari.extension"

log() { printf '[ext-register] %s\n' "$*"; }

is_registered() {
  pluginkit -m -p com.apple.Safari.web-extension 2>/dev/null | grep -q "${EXT_ID}"
}

case "${1:-}" in
  --check)
    if is_registered; then
      log "扩展在册：${EXT_ID}"
      exit 0
    fi
    log "扩展未登记：${EXT_ID}"
    exit 3
    ;;
esac

if is_registered; then
  log "扩展在册，无需注册"
  exit 0
fi

if [[ ! -d "${APPEX_PATH}" ]]; then
  log "错误：找不到 ${APPEX_PATH}，请先运行构建安装应用" >&2
  exit 1
fi

log "扩展未登记，执行注册：pluginkit -a"
pluginkit -a "${APPEX_PATH}" 2>/dev/null || true

# Safari 运行中注册可能延迟生效，轮询最多 10 秒（构建场景里 5 秒偶有不够）
for _ in $(seq 1 40); do
  if is_registered; then
    log "注册成功：${EXT_ID} 已在册"
    exit 0
  fi
  sleep 0.25
done

log "警告：注册后仍未查到扩展（Safari 运行中可能延迟生效，稍后会自动重试）" >&2
exit 2
