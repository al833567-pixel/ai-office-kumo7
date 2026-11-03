#!/usr/bin/env bash
# 啟動 Office Hub（Linux／WSL／macOS）。設定可寫在專案根目錄的 hub.env（例如 HUB_HOST=127.0.0.1,100.x.y.z）。
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
[ -f hub.env ] && set -a && . ./hub.env && set +a
export HUB_HOST="${HUB_HOST:-127.0.0.1}" HUB_PORT="${HUB_PORT:-7070}"
mkdir -p data/logs
echo "[$(date -Is)] Office Hub starting on $HUB_HOST:$HUB_PORT" >> data/logs/hub.log
exec bun run src/server.ts >> data/logs/hub.log 2>&1
