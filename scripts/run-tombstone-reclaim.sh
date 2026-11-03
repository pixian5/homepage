#!/bin/bash
#
# 生产墓碑回收常态化脚本（P1 收尾）
#
# 用法：
#   SERVER_URL=http://127.0.0.1:8787 TOKEN=共享密钥 bash scripts/run-tombstone-reclaim.sh [--dry-run|--force]
#
# 行为：
#   1. GET  /health           → 可达性 + 墓碑/设备/可回收计数
#   2. GET  /v1/sync/devices  → 每台设备的确认进度（谁卡住了回收一目了然）
#   3. POST /v1/sync/reclaim {dryRun:true} → 候选墓碑详情与当前 epoch
#   4. --force 且存在候选 → POST {dryRun:false, confirm:"RECLAIM"} 真正执行回收并递增 epoch
#
# 退出码：0 成功（含无候选）｜1 用法错误｜2 服务器不可达｜3 鉴权失败｜4 回收请求/执行失败
#
# 兼容性：macOS 自带 bash 3.2；不依赖 jq，JSON 解析用 node（与同步服务同栈）。
# 注意：有意不使用 `set -u`（bash 3.2 空数组展开会误报 unbound variable），错误路径手动处理。

SERVER_URL="${SERVER_URL:-http://127.0.0.1:8787}"
TOKEN="${TOKEN:-}"
MODE="dry"

for arg in "$@"; do
  case "$arg" in
    --dry-run) MODE="dry" ;;
    --force) MODE="force" ;;
    -h|--help)
      sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "错误：未知参数 ${arg}（仅支持 --dry-run / --force）" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# HTTP 封装：响应体写入全局 BODY，HTTP 状态码写入全局 STATUS（不经命令替换，
# 否则子 shell 里的赋值传不回父进程——首版脚本踩过的坑）；连接级失败返回 2
# ---------------------------------------------------------------------------
http_get() {
  http_request "GET" "$1" ""
}

http_post() {
  http_request "POST" "$1" "$2"
}

http_request() {
  local method="$1" url="$2" payload="$3" tmp
  tmp="$(mktemp)"
  if [ -n "$TOKEN" ]; then
    STATUS="$(curl -sS -m 30 -o "$tmp" -w "%{http_code}" -X "$method" \
      -H "Content-Type: application/json" -H "Authorization: Bearer ${TOKEN}" \
      -d @- "$url" <<PAYLOAD
$payload
PAYLOAD
)" || { rm -f "$tmp"; return 2; }
  else
    STATUS="$(curl -sS -m 30 -o "$tmp" -w "%{http_code}" -X "$method" \
      -H "Content-Type: application/json" \
      -d @- "$url" <<PAYLOAD
$payload
PAYLOAD
)" || { rm -f "$tmp"; return 2; }
  fi
  BODY="$(cat "$tmp")"
  rm -f "$tmp"
}

# 从 stdin 的 JSON 中取一个字段/表达式值（表达式里的 o 是解析后的对象）
json_value() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      try {
        const o = JSON.parse(s);
        const v = (function (o) { return (
'"$1"'
        ); })(o);
        process.stdout.write(v === undefined || v === null ? "" : String(v));
      } catch (e) {
        process.exit(1);
      }
    });
  '
}

die_http() {
  local code="$1" what="$2"
  if [ "$STATUS" = "401" ] || [ "$STATUS" = "403" ]; then
    echo "错误：${what} 鉴权失败（HTTP ${STATUS}），请检查 TOKEN 是否为服务端启动时的主管理 Token" >&2
    exit 3
  fi
  echo "错误：${what} 失败（HTTP ${STATUS}）" >&2
  exit "$code"
}

echo "[tombstone-reclaim] 服务器: ${SERVER_URL}  模式: $([ "$MODE" = "force" ] && echo '执行(--force)' || echo '演练(--dry-run)')"

# 1. 健康检查 -----------------------------------------------------------------
http_get "${SERVER_URL}/health" || { echo "错误：服务器不可达 ${SERVER_URL}" >&2; exit 2; }
[ "$STATUS" = "200" ] || die_http 2 "健康检查"
HEALTH="$BODY"
echo "[health] revision=$(printf '%s' "$HEALTH" | json_value 'o.revision') epoch=$(printf '%s' "$HEALTH" | json_value 'o.epoch') 设备=$(printf '%s' "$HEALTH" | json_value 'o.deviceCount') 墓碑=$(printf '%s' "$HEALTH" | json_value 'o.tombstoneCount') 可回收=$(printf '%s' "$HEALTH" | json_value 'o.reclaimCandidatesCount')"

# 2. 设备确认进度（谁还没确认到最新版本，回收就在等谁）------------------------
http_get "${SERVER_URL}/v1/sync/devices" || { echo "错误：服务器不可达" >&2; exit 2; }
if [ "$STATUS" = "200" ]; then
  echo "[devices] 确认进度："
  printf '%s' "$BODY" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      const o = JSON.parse(s);
      const devices = Array.isArray(o.devices) ? o.devices : [];
      if (!devices.length) { console.log("  （设备表为空：还没有任何设备推送过数据）"); }
      for (const d of devices) {
        const state = Number(d.retiredAt) > 0 ? "已退役" : "活跃";
        const id = String(d.deviceId || "").slice(0, 10);
        console.log(`  ${id}  epoch=${d.lastConfirmedEpoch} revision=${d.lastConfirmedRevision}  [${state}] ${d.deviceName || ""}`);
      }
    });
  ' || true
else
  # 设备表拉取失败不阻断回收本身（例如未配置 TOKEN 的开放模式服务），仅提示
  echo "[devices] 拉取失败（HTTP ${STATUS}），跳过设备进度展示" >&2
fi

# 3. 演练：查看候选墓碑 -------------------------------------------------------
http_post "${SERVER_URL}/v1/sync/reclaim" '{"dryRun":true}' || { echo "错误：服务器不可达" >&2; exit 2; }
[ "$STATUS" = "200" ] || die_http 4 "回收演练"
DRY="$BODY"
CANDIDATES="$(printf '%s' "$DRY" | json_value '(Array.isArray(o.candidates)?o.candidates:[]).join("\n")')"
CANDIDATE_COUNT="$(printf '%s' "$DRY" | json_value 'o.candidateCount')"
EPOCH="$(printf '%s' "$DRY" | json_value 'o.epoch')"
REVISION="$(printf '%s' "$DRY" | json_value 'o.revision')"

echo "[dry-run] revision=${REVISION} epoch=${EPOCH} 候选墓碑=${CANDIDATE_COUNT}"
if [ -n "$CANDIDATES" ]; then
  printf '%s\n' "$CANDIDATES" | sed 's/^/  候选: /'
fi

if [ "$MODE" != "force" ]; then
  echo "[dry-run] 演练完成（未执行任何回收；加 --force 真正执行）"
  exit 0
fi

if [ "${CANDIDATE_COUNT:-0}" = "0" ]; then
  echo "[force] 无可回收候选，无需执行"
  exit 0
fi

# 4. 执行回收：递增 epoch、清除候选墓碑 --------------------------------------
http_post "${SERVER_URL}/v1/sync/reclaim" '{"dryRun":false,"confirm":"RECLAIM"}' || { echo "错误：服务器不可达" >&2; exit 2; }
[ "$STATUS" = "200" ] || die_http 4 "回收执行"
FORCE="$BODY"
RECLAIMED="$(printf '%s' "$FORCE" | json_value '(Array.isArray(o.reclaimed)?o.reclaimed:[]).length')"
NEW_EPOCH="$(printf '%s' "$FORCE" | json_value 'o.epoch')"
NEW_REVISION="$(printf '%s' "$FORCE" | json_value 'o.revision')"

echo "[force] 已回收 ${RECLAIMED} 条墓碑：revision ${REVISION}→${NEW_REVISION}，epoch ${EPOCH}→${NEW_EPOCH}"
echo "[force] 提醒：所有设备将在下次同步时重新确认新基线（确认进度清零属正常现象）"
exit 0
