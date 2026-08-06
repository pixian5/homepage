#!/usr/bin/env bash
set -Eeuo pipefail

# 在 Ubuntu/systemd 服务器上创建 Homepage 同步服务。
# 该脚本只复制 Node 标准库服务，不复制客户端构建产物、Token 或同步数据。

INSTALL_DIR="/opt/homepage-sync"
DATA_DIR="/var/lib/homepage-sync"
ENV_FILE="/etc/homepage-sync/homepage-sync.env"
SERVICE_NAME="homepage-sync"
SERVICE_USER="homepage-sync"
PORT="8787"
TOKEN="${SYNC_TOKEN:-qqq77777}"
DRY_RUN=0
NO_START=0

usage() {
  cat <<'EOF'
用法：sudo scripts/setup-sync-server.sh [选项]

选项：
  --token TOKEN       设置 Bearer Token；默认 qqq77777，也可使用 SYNC_TOKEN 环境变量
  --port PORT         Node 内部端口，默认 8787
  --install-dir DIR  服务代码目录，默认 /opt/homepage-sync
  --data-dir DIR     JSON 数据目录，默认 /var/lib/homepage-sync
  --no-start          只创建文件，不启动或启用 systemd 服务
  --dry-run           只打印计划，不修改系统
  -h, --help          显示帮助

示例：
  sudo scripts/setup-sync-server.sh
  sudo scripts/setup-sync-server.sh --token 'your-secret' --port 8787
  SYNC_TOKEN='your-secret' sudo -E scripts/setup-sync-server.sh --no-start
EOF
}

die() {
  printf '[setup-sync-server] 错误：%s\n' "$*" >&2
  exit 1
}

run() {
  if ((DRY_RUN)); then
    printf '+ '
    printf '%q ' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

while (($#)); do
  case "$1" in
    --token)
      (($# >= 2)) || die "--token 缺少参数"
      TOKEN="$2"
      shift 2
      ;;
    --port)
      (($# >= 2)) || die "--port 缺少参数"
      PORT="$2"
      shift 2
      ;;
    --install-dir)
      (($# >= 2)) || die "--install-dir 缺少参数"
      INSTALL_DIR="$2"
      shift 2
      ;;
    --data-dir)
      (($# >= 2)) || die "--data-dir 缺少参数"
      DATA_DIR="$2"
      shift 2
      ;;
    --no-start)
      NO_START=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "未知参数：$1"
      ;;
  esac
done

[[ "$PORT" =~ ^[0-9]+$ ]] || die "端口必须是数字"
((PORT >= 1 && PORT <= 65535)) || die "端口范围必须是 1-65535"
[[ "$INSTALL_DIR" = /* && "$DATA_DIR" = /* ]] || die "目录必须使用绝对路径"

if ((DRY_RUN)); then
  printf '[setup-sync-server] dry-run：系统=%s，代码=%s，数据=%s，端口=%s，Token=%s\n' \
    "$(uname -s)" "$INSTALL_DIR" "$DATA_DIR" "$PORT" "$([[ -n "$TOKEN" ]] && printf '已提供' || printf '将生成')"
else
  [[ "$(uname -s)" == "Linux" ]] || die "安装模式只支持 Linux/systemd；本机请使用 --dry-run"
  [[ "$(id -u)" -eq 0 ]] || die "安装模式需要 root，请使用 sudo"
  command -v node >/dev/null 2>&1 || die "未找到 node，请先安装 Node.js 18 或更高版本"
  command -v systemctl >/dev/null 2>&1 || die "未找到 systemctl，该主机不是 systemd 环境"
  NODE_BIN="$(command -v node)"
fi

if [[ -z "$TOKEN" && -f "$ENV_FILE" ]]; then
  TOKEN="$(sed -n 's/^TOKEN=//p' "$ENV_FILE" | head -n 1)"
fi

GENERATED_TOKEN=0

SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
STATE_FILE="${DATA_DIR}/homepage-sync-state.json"

if ((DRY_RUN)); then
  printf '[setup-sync-server] 将创建：%s、%s、%s、%s\n' "$INSTALL_DIR" "$DATA_DIR" "$ENV_FILE" "$SERVICE_FILE"
  printf '[setup-sync-server] 将运行：HOST=127.0.0.1 PORT=%s DATA_FILE=%s node %s/sync-server.mjs\n' "$PORT" "$STATE_FILE" "$INSTALL_DIR"
  exit 0
fi

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "${SCRIPT_ROOT}/scripts/sync-server.mjs" ]] || die "找不到 scripts/sync-server.mjs"

install -d -m 0755 "$INSTALL_DIR"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$DATA_DIR"
chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
install -o root -g root -m 0644 "${SCRIPT_ROOT}/scripts/sync-server.mjs" "${INSTALL_DIR}/sync-server.mjs"

install -d -m 0755 "$(dirname "$ENV_FILE")"
[[ -n "$TOKEN" ]] || die "Token 不能为空；请使用 --token 或 SYNC_TOKEN"
[[ "$TOKEN" =~ ^[A-Za-z0-9._~:-]+$ ]] || die "Token 只能包含字母、数字、点、下划线、短横线、波浪线或冒号"
{
  printf 'HOST=127.0.0.1\n'
  printf 'PORT=%s\n' "$PORT"
  printf 'TOKEN=%s\n' "$TOKEN"
  printf 'DATA_FILE=%s\n' "$STATE_FILE"
} > "$ENV_FILE"
chown root:root "$ENV_FILE"
chmod 0600 "$ENV_FILE"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Homepage HTTP Sync Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $INSTALL_DIR/sync-server.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$SERVICE_FILE"

systemctl daemon-reload
if ((NO_START == 0)); then
  systemctl enable --now "$SERVICE_NAME.service"
  systemctl is-active --quiet "$SERVICE_NAME.service" || die "服务启动失败，请查看：journalctl -u ${SERVICE_NAME}.service"
  systemctl --no-pager --full status "$SERVICE_NAME.service"
else
  printf '[setup-sync-server] 已创建服务，但未启动：systemctl enable --now %s.service\n' "$SERVICE_NAME"
fi

printf '\n[setup-sync-server] 完成\n'
printf '健康检查：curl http://127.0.0.1:%s/health\n' "$PORT"
printf '反向代理后，扩展 URL 应填写 HTTPS 公网地址。\n'
printf 'Token 已写入：%s（权限 600），当前 Token：%s\n' "$ENV_FILE" "$TOKEN"
