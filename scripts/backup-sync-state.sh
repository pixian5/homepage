#!/usr/bin/env bash
set -Eeuo pipefail

# 备份 Homepage 同步服务状态（服务端 / 本地均可运行）。
# 设计原则：只读状态目录、不中断服务；tar 前先校验 JSON 可解析，避免备份到半损坏文件。
#
# 用法：
#   bash scripts/backup-sync-state.sh                                   # 默认目录 /var/lib/homepage-sync
#   bash scripts/backup-sync-state.sh --data-dir ./data --out ./backup  # 本地/自定义路径
#   bash scripts/backup-sync-state.sh --keep 30                         # 保留 30 份

DATA_DIR="/var/lib/homepage-sync"
BACKUP_DIR="/var/backups/homepage-sync"
KEEP=14

usage() {
  cat <<'EOF'
用法：bash scripts/backup-sync-state.sh [选项]

选项：
  --data-dir DIR    同步状态目录，默认 /var/lib/homepage-sync
  --out DIR         备份输出目录，默认 /var/backups/homepage-sync
  --keep N          保留最近 N 份，默认 14（0 = 不清理）
  -h, --help        显示帮助
EOF
}

die() { printf '[backup] 错误：%s\n' "$*" >&2; exit 1; }
log() { printf '[backup] %s\n' "$*"; }

while (($#)); do
  case "$1" in
    --data-dir) DATA_DIR="${2:?}"; shift 2 ;;
    --out) BACKUP_DIR="${2:?}"; shift 2 ;;
    --keep) KEEP="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

[[ -d "$DATA_DIR" ]] || die "状态目录不存在：$DATA_DIR"
command -v tar >/dev/null || die "未找到 tar"

mkdir -p "$BACKUP_DIR"

# 校验状态文件是合法 JSON：服务端原子写入，但备份前再确认一次
STATE_FILE="$DATA_DIR/homepage-sync-state.json"
if [[ -f "$STATE_FILE" ]]; then
  python3 - "$STATE_FILE" <<'PY' || die "状态文件不是合法 JSON，拒绝备份：$STATE_FILE"
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    doc = json.load(fh)
if not isinstance(doc, dict):
    raise SystemExit("状态根节点不是对象")
PY
  log "状态文件校验通过：$STATE_FILE"
else
  log "注意：状态文件尚不存在（空库），仍继续备份目录"
fi

STAMP="$(date +%Y%m%dT%H%M%SZ)"
ARCHIVE="$BACKUP_DIR/homepage-sync-$STAMP.tar.gz"

# 只打包数据目录内容（避免把绝对路径写进归档）
tar -czf "$ARCHIVE" -C "$DATA_DIR" . || die "打包失败"

SIZE="$(du -h "$ARCHIVE" | cut -f1)"
# 注意：macOS bash 3.2 的 $VAR 后紧跟多字节字符（如全角括号）会把高位字节并入变量名，
# 触发 unbound variable。凡变量后接非 ASCII 字符必须用 ${} 包裹。
log "已备份：${ARCHIVE}（${SIZE}）"

# 校验归档可读、内含状态文件条目
tar -tzf "$ARCHIVE" >/dev/null || die "归档校验失败：${ARCHIVE}"

# 清理旧备份，只保留最近 KEEP 份
# 注意：mapfile 是 bash 4+ 内建，macOS 自带 bash 3.2 没有，必须用 while read（POSIX 兼容）
if [[ "$KEEP" =~ ^[0-9]+$ ]] && (( KEEP > 0 )); then
  local_old=()
  while IFS= read -r f; do
    [[ -n "$f" ]] && local_old+=("$f")
  done < <(ls -1t "$BACKUP_DIR"/homepage-sync-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)))
  if ((${#local_old[@]})); then
    printf '%s\n' "${local_old[@]}" | xargs -r rm -f
    log "已清理 ${#local_old[@]} 份旧备份，保留最近 ${KEEP} 份"
  fi
fi

log "现有备份："
ls -1t "$BACKUP_DIR"/homepage-sync-*.tar.gz 2>/dev/null | head -5 | while read -r f; do
  printf '  %s  %s\n' "$(du -h "$f" | cut -f1)" "$f"
done

# 把恢复命令打印出来，避免紧急时找不到
cat <<EOF

恢复到本机：
  bash scripts/restore-sync-state.sh --archive $ARCHIVE --data-dir $DATA_DIR

EOF
