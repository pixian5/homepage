#!/bin/bash
#
# 清扫端到端（E2E）测试残留（幂等，可反复执行）：
#   1. 结束孤儿测试进程——父进程已死、被系统收养（PPID=1）的无头浏览器/同步服务，
#      命令行带本仓库测试的临时目录特征串
#   2. 删除系统临时目录里各 E2E 脚本遗留的 profile / site 目录
#
# 背景：2026-11-04 事故——某次 PWA 端到端测试泄漏 7 个无头 Chromium 孤儿进程，
# 每个都在 macOS 菜单栏挂一个放大镜图标（Chromium 的全局搜索状态项）。
#
# 安全设计：
#   - 只杀 PPID=1 的孤儿进程；正在运行的测试其浏览器父进程（node）还活着，不会被误杀
#   - 进程匹配只认本仓库测试临时目录前缀（homepage-pwa-e2e. / homepage-smoke- 等），
#     不按浏览器二进制名杀，避免误伤日常使用的浏览器
#   - 兼容 macOS 自带 bash 3.2（不用 mapfile / 关联数组 / ${var,,}）
#
# 用法：bash scripts/cleanup-e2e-leftovers.sh

set -o nounset
set -o pipefail

TMP_BASE="${TMPDIR:-/tmp}"

KILLED=0
REMOVED=0

# ---- 1. 孤儿测试进程 ----
# 先做进程快照再过滤：ps 执行时本脚本的 awk 管道尚未启动，
# 避免把管道自身的命令行（含特征串）误当成目标进程。
PS_SNAP="$(ps -axo pid=,ppid=,command= 2>/dev/null || true)"
# 特征串 = 本仓库各 E2E 脚本 mkdtemp 的临时目录前缀（命令行 --user-data-dir/--profile 会携带）。
ORPHANS="$(printf '%s\n' "$PS_SNAP" | awk '
  $2 == 1 && $0 ~ /homepage-(pwa-e2e\.|browser-sync-e2e\.|smoke-|firefox-persist-|firefox-sync-)/ { print $1 }
')"

if [ -n "$ORPHANS" ]; then
  for pid in $ORPHANS; do
    # 先 SIGTERM 温和结束，残留再 SIGKILL 强制结束。
    if kill "$pid" 2>/dev/null; then
      echo "[cleanup-e2e] 已结束孤儿测试进程 PID=$pid"
      KILLED=$((KILLED + 1))
    fi
  done
  # 等待 2 秒让 SIGTERM 生效，再对仍存活者补刀。
  sleep 2
  for pid in $ORPHANS; do
    if kill -0 "$pid" 2>/dev/null; then
      if kill -9 "$pid" 2>/dev/null; then
        echo "[cleanup-e2e] 强制结束顽固孤儿进程 PID=$pid"
      fi
    fi
  done
fi

# ---- 2. 临时目录残留 ----
# 覆盖仓库内全部 E2E 脚本的 mkdtemp 前缀 + 历史泄漏的 pwa-e2e 前缀。
for pattern in \
  "homepage-pwa-e2e.*" \
  "homepage-browser-sync-e2e.*" \
  "homepage-smoke-*" \
  "homepage-firefox-persist-*" \
  "homepage-firefox-sync-flows-*" \
  "homepage-firefox-sync-errors-*" \
  "homepage-firefox-sync-ui-*"; do
  for dir in "$TMP_BASE"/$pattern; do
    # glob 无匹配时会是字面量路径，-d 守卫跳过。
    [ -d "$dir" ] || continue
    if rm -rf "$dir"; then
      echo "[cleanup-e2e] 已删除临时目录 $dir"
      REMOVED=$((REMOVED + 1))
    fi
  done
done

echo "[cleanup-e2e] 清扫完成：孤儿进程 $KILLED 个，临时目录 $REMOVED 个（无输出项即无残留）"
exit 0
