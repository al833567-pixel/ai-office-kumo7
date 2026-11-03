@echo off
rem 啟動 Office Hub。預設只聽本機 127.0.0.1:7070。
rem 要讓 B 機連進來：先登入 Tailscale，再把 HUB_HOST 設成這台的 Tailscale IP（tailscale ip -4）。
rem 也可以把設定寫在專案根目錄的 hub.env.cmd（例如：set HUB_HOST=100.x.y.z），這支腳本會自動載入。
setlocal
cd /d "%~dp0..\.."
if exist hub.env.cmd call hub.env.cmd
if "%HUB_HOST%"=="" set HUB_HOST=127.0.0.1
if "%HUB_PORT%"=="" set HUB_PORT=7070
if not exist data\logs mkdir data\logs
echo [%date% %time%] Office Hub starting on %HUB_HOST%:%HUB_PORT% >> data\logs\hub.log
bun run src\server.ts >> data\logs\hub.log 2>&1
