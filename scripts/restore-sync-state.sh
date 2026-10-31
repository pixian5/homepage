#!/usr/bin/env bash
set -Eeuo pipefail

# 恢复 Homepage 同步服务状态（服务端）。
# 安全顺序：临时解包校验 → 停服务 → 可逆替换 → 启动 → /health 验证。
# 启动或健康检查失败时自动恢复替换前目录，避免恢复操作扩大故障。
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

# 1) 在独立临时目录校验归档，正式数据目录此时完全不变
log "校验归档：$ARCHIVE"
tar -tzf "$ARCHIVE" >/dev/null || die "归档无法读取"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/homepage-restore.XXXXXX")"
RESTORE_ACTIVE=0

# 拒绝绝对路径和 .. 路径，避免把归档内容写出临时目录。
if tar -tzf "$ARCHIVE" | awk '
  /^\// || /^-|\.\.(\/|$)|(^|\/)\.\.(\/|$)/ { bad=1; print; }
  END { exit bad ? 1 : 0 }
'; then
  :
else
  die "归档包含不安全路径"
fi

tar -xzf "$ARCHIVE" -C "$TMP_DIR" || die "解包失败"

[[ -f "$TMP_DIR/homepage-sync-state.json" ]] || die "归档中缺少 homepage-sync-state.json"

REV="$(
  node --input-type=module - "$TMP_DIR/homepage-sync-state.json" <<'NODE'
import { readFile } from "node:fs/promises";
import process from "node:process";

const file = process.argv[2];
const parsed = JSON.parse(await readFile(file, "utf8"));
if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("状态根节点不是对象");
if (!Number.isSafeInteger(parsed.revision) || parsed.revision < 0) throw new Error("revision 无效");
const doc = parsed.doc;
if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("缺少 doc");
if (doc.revision !== parsed.revision) throw new Error("revision 与 doc.revision 不一致");
if (doc.schema !== "homepage.sync.doc.v1" || doc.schemaVersion !== 1) throw new Error("同步文档 schema 无效");
if (typeof doc.contentHash !== "string") throw new Error("缺少 contentHash");
const clone = { ...doc, contentHash: "" };
const text = JSON.stringify(clone);
let hash = 2166136261;
for (let index = 0; index < text.length; index += 1) {
  hash ^= text.charCodeAt(index);
  hash = Math.imul(hash, 16777619);
}
const expected = (hash >>> 0).toString(16).padStart(8, "0");
if (doc.contentHash !== expected) throw new Error("contentHash 不匹配");
console.log(parsed.revision);
NODE
)" || die "归档内状态无效（JSON/schema/revision/contentHash 校验失败）"
log "归档状态 revision = $REV"

if ((DRY_RUN)); then
  log "dry-run 结束：归档有效，未改动任何数据"
  exit 0
fi

# 2) 停服务，保证不会在替换过程中写入
log "停止 $SERVICE_NAME ..."
systemctl stop "$SERVICE_NAME" || die "停止服务失败"

# 3) 用同一父目录改名实现可逆切换，不先删除现有数据。
STAMP="$(date +%Y%m%dT%H%M%S)-$$"
DATA_PARENT="$(dirname "$DATA_DIR")"
DATA_NAME="$(basename "$DATA_DIR")"
BACKUP_DIR="${DATA_PARENT}/.${DATA_NAME}.pre-restore-${STAMP}"
CANDIDATE_DIR="${DATA_PARENT}/.${DATA_NAME}.restore-${STAMP}"
rollback() {
  set +e
  if ((RESTORE_ACTIVE)); then
    systemctl stop "$SERVICE_NAME" >/dev/null 2>&1
    rm -rf "$DATA_DIR"
    if [[ -d "$BACKUP_DIR" ]]; then
      mv "$BACKUP_DIR" "$DATA_DIR"
    fi
    systemctl start "$SERVICE_NAME" >/dev/null 2>&1
    RESTORE_ACTIVE=0
    log "恢复失败，已回滚到恢复前数据目录：$DATA_DIR"
  fi
}

trap 'if ((RESTORE_ACTIVE)); then rollback; fi; [[ -z "${TMP_DIR:-}" ]] || rm -rf "$TMP_DIR"' EXIT

mkdir -p "$DATA_PARENT"
rm -rf "$CANDIDATE_DIR"
mv "$TMP_DIR" "$CANDIDATE_DIR" || { systemctl start "$SERVICE_NAME" || true; die "准备恢复目录失败"; }
TMP_DIR=""
if [[ -d "$DATA_DIR" ]]; then
  mv "$DATA_DIR" "$BACKUP_DIR" || { rm -rf "$CANDIDATE_DIR"; systemctl start "$SERVICE_NAME" || true; die "保留恢复前数据失败"; }
fi
mv "$CANDIDATE_DIR" "$DATA_DIR" || {
  [[ -d "$BACKUP_DIR" ]] && mv "$BACKUP_DIR" "$DATA_DIR"
  systemctl start "$SERVICE_NAME" || true
  die "切换恢复目录失败"
}
RESTORE_ACTIVE=1

# 属主保持一致：状态目录归 homepage-sync 用户
if id homepage-sync >/dev/null 2>&1; then
  chown -R homepage-sync:homepage-sync "$DATA_DIR" || { rollback; die "设置状态目录属主失败"; }
fi
log "数据已切换，恢复前目录保留为：$BACKUP_DIR"

# 4) 启动并验证；失败时自动恢复旧目录
if ! systemctl start "$SERVICE_NAME"; then
  rollback
  die "启动服务失败，已回滚"
fi
sleep 1
HEALTH="$(curl -s -m 5 "$HEALTH_URL" || true)"
if [[ -z "$HEALTH" || "$HEALTH" != *'"ok":true'* ]]; then
  rollback
  die "健康检查失败，已回滚：${HEALTH:-无响应}"
fi
log "健康检查：$HEALTH"

# 成功后保留恢复前目录，便于人工核查和二次回滚；由运维定期清理。
RESTORE_ACTIVE=0
log "恢复完成，恢复前目录仍保留：$BACKUP_DIR"
