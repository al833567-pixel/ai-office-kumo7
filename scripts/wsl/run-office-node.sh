#!/usr/bin/env bash
# WSL 端 office-node（Hermes 接線）。設定檔：~/.office/config.json（範例 node/config.wsl.example.json，只放 hermes_token）。
# 可由 Windows 工作排程器透過 wsl.exe 啟動（scripts/windows/install-tasks.ps1 -WslHermes），或用 systemd（scripts/wsl/office-node.service）。
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
mkdir -p "$HOME/.office"
exec bun node/office.ts run >> "$HOME/.office/office-node.log" 2>&1
