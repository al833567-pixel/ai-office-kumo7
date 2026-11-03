#!/usr/bin/env bash
# office-node（Linux／WSL／macOS）：回報 Claude session 狀態、接執行者（Hermes、Codex…）。
# 設定檔：~/.office/config.json（範例 node/config.linux.example.json）
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
mkdir -p data/logs
exec bun node/office.ts run >> data/logs/office-node.log 2>&1
