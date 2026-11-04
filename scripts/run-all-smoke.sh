#!/bin/bash
#
# 一键全量自动化回归脚本：
#   1. npm test                    全量单元测试（node:test）
#   2. npm run check               Biome 静态语法与代码规范
#   3. node scripts/bundle-firefox.mjs   Firefox 模块拓扑打包校验
#   4. node scripts/run-browser-smoke.mjs Chrome/Firefox 真实无头浏览器冒烟
#
# 任何一步失败立即退出并返回非 0 状态码。
#
# 用法：bash scripts/run-all-smoke.sh

set -o errexit
set -o nounset
set -o pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

step() {
  echo ""
  echo "=========================================================="
  echo "[run-all-smoke] $1"
  echo "=========================================================="
}

step "1/4 全量单元测试（npm test）"
npm test

step "2/4 Biome 静态检查（npm run check）"
npm run check

step "3/4 Firefox 拓扑打包校验（bundle-firefox）"
node scripts/bundle-firefox.mjs

step "4/4 真实浏览器冒烟（Chrome + Firefox 无头）"
node scripts/run-browser-smoke.mjs

echo ""
echo "=========================================================="
echo "[run-all-smoke] 全部通过 ✓（单元测试 / Biome / Firefox 拓扑 / 双端冒烟）"
echo "=========================================================="
