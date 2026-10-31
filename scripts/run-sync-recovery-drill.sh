#!/usr/bin/env bash
set -Eeuo pipefail

# 在临时目录演练备份校验、可逆替换和启动失败回滚，不触碰生产服务或数据。
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/homepage-recovery-drill.XXXXXX")"
trap 'if [[ -n "${HEALTH_PID:-}" ]]; then kill "$HEALTH_PID" >/dev/null 2>&1 || true; fi; rm -rf "$WORK_DIR"' EXIT

DATA_DIR="$WORK_DIR/data"
SOURCE_DIR="$WORK_DIR/source"
mkdir -p "$DATA_DIR" "$SOURCE_DIR"

node --input-type=module - "$SOURCE_DIR/homepage-sync-state.json" <<'NODE'
import { writeFile } from "node:fs/promises";
const file = process.argv[2];
const doc = {
  schema: "homepage.sync.doc.v1",
  schemaVersion: 1,
  docId: "recovery-drill",
  revision: 3,
  deviceId: "drill-device",
  writtenAt: 1,
  settings: {},
  groups: [],
  nodes: [],
  placements: [],
  contentHash: "",
};
const clone = { ...doc, contentHash: "" };
let hash = 2166136261;
for (const char of JSON.stringify(clone)) {
  hash ^= char.charCodeAt(0);
  hash = Math.imul(hash, 16777619);
}
doc.contentHash = (hash >>> 0).toString(16).padStart(8, "0");
await writeFile(
  file,
  JSON.stringify({ revision: 3, etag: "drill", updatedAt: 1, epoch: 1, devices: {}, deletions: {}, doc }),
);
NODE

tar -czf "$WORK_DIR/state.tar.gz" -C "$SOURCE_DIR" .
printf '%s\n' '{"revision":1,"marker":"original"}' > "$DATA_DIR/homepage-sync-state.json"

cat > "$WORK_DIR/systemctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "start" && "${FAIL_START:-0}" == "1" ]]; then
  exit 1
fi
exit 0
SH
chmod +x "$WORK_DIR/systemctl"

PORT_FILE="$WORK_DIR/health-port"
PORT_FILE="$PORT_FILE" node --input-type=module <<'NODE' &
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"ok":true}');
}).listen(0, "127.0.0.1", function () {
  writeFile(process.env.PORT_FILE, String(this.address().port));
});
NODE
HEALTH_PID=$!
HEALTH_PORT=""
for _ in {1..50}; do
  [[ -f "$PORT_FILE" ]] && HEALTH_PORT="$(cat "$PORT_FILE")"
  [[ -n "$HEALTH_PORT" ]] && break
  sleep 0.1
done
[[ -n "$HEALTH_PORT" ]] || { echo "恢复演练健康服务未启动" >&2; exit 1; }

export SYSTEMCTL_BIN="$WORK_DIR/systemctl"
export HEALTH_URL="http://127.0.0.1:${HEALTH_PORT}/health"
bash "$ROOT_DIR/scripts/restore-sync-state.sh" \
  --archive "$WORK_DIR/state.tar.gz" \
  --data-dir "$DATA_DIR" \
  --service homepage-sync
grep -q '"revision":3' "$DATA_DIR/homepage-sync-state.json"

set +e
FAIL_START=1 bash "$ROOT_DIR/scripts/restore-sync-state.sh" \
  --archive "$WORK_DIR/state.tar.gz" \
  --data-dir "$DATA_DIR" \
  --service homepage-sync >/dev/null 2>&1
RESULT=$?
set -e
[[ "$RESULT" -ne 0 ]] || { echo "启动失败演练未失败" >&2; exit 1; }
grep -q '"revision":3' "$DATA_DIR/homepage-sync-state.json"

printf '[drill] backup validation, restore, and startup rollback passed\n'
