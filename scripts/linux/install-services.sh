#!/usr/bin/env bash
# 註冊 systemd 使用者服務：開機（或登入）自動啟動，掛掉 10 秒後重啟。
#   bash scripts/linux/install-services.sh --hub --node   # Hub 那台
#   bash scripts/linux/install-services.sh --node         # 其他 agent 機器
#   bash scripts/linux/install-services.sh --uninstall
# WSL 需先在 /etc/wsl.conf 開啟 [boot] systemd=true 並 wsl --shutdown。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
want_hub=0; want_node=0; uninstall=0
for a in "$@"; do case "$a" in --hub) want_hub=1;; --node) want_node=1;; --uninstall) uninstall=1;; *) echo "未知參數 $a"; exit 1;; esac; done
if [ $uninstall = 1 ]; then
  for s in office-hub office-node; do systemctl --user disable --now "$s" 2>/dev/null || true; rm -f "$UNIT_DIR/$s.service"; done
  systemctl --user daemon-reload; echo "已移除 office-hub、office-node 服務"; exit 0
fi
[ $want_hub = 0 ] && [ $want_node = 0 ] && { echo "請指定 --hub 及／或 --node"; exit 1; }
unit() { cat > "$UNIT_DIR/$1.service" <<UNIT
[Unit]
Description=$2
After=network-online.target

[Service]
WorkingDirectory=$ROOT
ExecStart=/usr/bin/env bash $ROOT/scripts/linux/$3
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
UNIT
}
[ $want_hub = 1 ] && unit office-hub "AI Office Hub" start-hub.sh
[ $want_node = 1 ] && unit office-node "AI Office node" start-office-node.sh
systemctl --user daemon-reload
[ $want_hub = 1 ] && systemctl --user enable --now office-hub
[ $want_node = 1 ] && systemctl --user enable --now office-node
loginctl enable-linger "$USER" 2>/dev/null || echo "（提示：執行 sudo loginctl enable-linger $USER，沒登入時服務也會常駐）"
echo "完成。狀態：systemctl --user status office-hub office-node；日誌：$ROOT/data/logs/"
