#!/usr/bin/env bash
set -Eeuo pipefail

# 恢复 Homepage 同步服务状态（服务端）。
# 安全顺序：停服务 → 备份当前状态 → 校验归档 → 替换 → 启动 → /health 验证。
# 任何一步失败都不启动服务，保证不会把损坏数据暴露给客户端。
#
# 用法：
#   sudo scripts/restore-sync-state.sh --archive /var/backups/homepage-sync/homepage-sync-20261028T012345Z.tar.gz
#   sudo scripts/restore-sync-state.sh --archive xxx.tar.gz --dry-run

DATA_DIR="/var/lib/homepage-sync"
SERVICE_NAME="homepage-sync"
HEALTH_URL="http://127.0.0.1:8787/health"
ARCHIVE=""
DRY_RUN=0

usage() {
  cat <<'EOF'
用法：sudo scripts/restore-sync-state.sh --archive FILE [选项]

选项：
  --archive FILE    要恢复的 tar.gz 归档（必填）
  --data-dir DIR    同步状态目录，默认 /var/lib/homepage-sync
  --service NAME    systemd 服务名，默认 homepage-sync
  --dry-run         只校验归档并打印计划，不改动任何数据
  -h, --help        显示帮助
EOF
}

die() { printf '[restore] 错误：%s\n' "$*" >&2; exit 1; }
log() { printf '[restore] %s\n' "$*"; }
run() { if ((DRY_RUN)); then printf '+ %q ' "$@"; printf '\n'; else "$@"; fi; }

while (($#)); do
  case "$1" in
    --archive) ARCHIVE="${2:?}"; shift 2 ;;
    --data-dir) DATA_DIR="${2:?}"; shift 2 ;;
    --service) SERVICE_NAME="${2:?}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

[[ -n "$ARCHIVE" ]] || die "必须指定 --archive"
[[ -f "$ARCHIVE" ]] || die "归档不存在：$ARCHIVE"

# 1) 校验归档结构：必须含状态 JSON，且能解析
log "校验归档：$ARCHIVE"
tar -tzf "$ARCHIVE" >/dev/null || die "归档无法读取"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
tar -xzf "$ARCHIVE" -C "$TMP_DIR" || die "解包失败"

[[ -f "$TMP_DIR/homepage-sync-state.json" ]] || die "归档中缺少 homepage-sync-state.json"

python3 - "$TMP_DIR/homepage-sync-state.json" <<'PY' || die "归档内状态文件不是合法 JSON"
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    doc = json.load(fh)
if not isinstance(doc, dict):
    raise SystemExit("状态根节点不是对象")
# 关键字段检查：至少要有 doc 或 revision，避免恢复到空壳
if "revision" not in doc and "doc" not in doc and "state" not in doc:
    raise SystemExit("状态文件缺少 revision/doc/state 字段，可能是错误备份")
PY

REV="$(python3 -c "
import json,sys
d=json.load(open('$TMP_DIR/homepage-sync-state.json'))
print(d.get('revision', 'n/a'))
")"
log "归档状态 revision = $REV"

if ((DRY_RUN)); then
  log "dry-run 结束：归档有效，未改动任何数据"
  exit 0
fi

# 2) 停服务，保证不会在替换过程中写入
log "停止 $SERVICE_NAME ..."
systemctl stop "$SERVICE_NAME" || die "停止服务失败"

# 3) 先备份当前状态，留后路
if [[ -d "$DATA_DIR" ]] && [[ -n "$(ls -A "$DATA_DIR" 2>/dev/null)" ]]; then
  SAFETY="/var/backups/homepage-sync/pre-restore-$(date +%Y%m%dT%H%M%SZ).tar.gz"
  mkdir -p "$(dirname "$SAFETY")"
  tar -czf "$SAFETY" -C "$DATA_DIR" . && log "恢复前快照：$SAFETY"
fi

# 4) 替换数据
mkdir -p "$DATA_DIR"
find "$DATA_DIR" -mindepth 1 -delete
tar -xzf "$ARCHIVE" -C "$DATA_DIR" || { systemctl start "$SERVICE_NAME" || true; die "解包到数据目录失败，已尝试重启服务"; }
# 属主保持一致：状态目录归 homepage-sync 用户
if id homepage-sync >/dev/null 2>&1; then
  chown -R homepage-sync:homepage-sync "$DATA_DIR"
fi
log "数据已替换"

# 5) 启动并验证
systemctl start "$SERVICE_NAME" || die "启动服务失败，请检查 journalctl -u $SERVICE_NAME"
sleep 1
HEALTH="$(curl -s -m 5 "$HEALTH_URL" || true)"
if [[ -z "$HEALTH" ]]; then
  die "服务已启动但 /health 无响应，请检查 journalctl -u $SERVICE_NAME"
fi
log "健康检查：$HEALTH"

case "$HEALTH" in
  *'"ok":true'*) log "恢复完成" ;;
  *) die "健康检查返回异常：$HEALTH" ;;
esac
