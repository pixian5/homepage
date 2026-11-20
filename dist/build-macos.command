#!/usr/bin/env bash
set -euo pipefail

# 始终使用仓库内同一套安全策略，不在 dist 保留可能过期的安装逻辑。
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "${ROOT_DIR}/scripts/build-macos.command" "$@"
