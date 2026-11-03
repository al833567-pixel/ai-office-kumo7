@echo off
rem Start the Office Hub. Default: listen on 127.0.0.1:7070 only.
rem To let other machines connect: log in to Tailscale, then set HUB_HOST to this
rem machine's Tailscale IP (tailscale ip -4). Several addresses can be comma-separated.
rem Settings can live in hub.env.cmd at the project root (e.g. set HUB_HOST=127.0.0.1,100.x.y.z);
rem this script loads it automatically.
rem NOTE: keep this file pure ASCII. cmd.exe reads .cmd files in the system code page,
rem so non-ASCII comments can break lines and get executed as commands.
setlocal
cd /d "%~dp0..\.."
if exist hub.env.cmd call hub.env.cmd
if "%HUB_HOST%"=="" set HUB_HOST=127.0.0.1
if "%HUB_PORT%"=="" set HUB_PORT=7070
if not exist data\logs mkdir data\logs
rem Watchdog runs this every 5 minutes; if the Hub is already listening, do nothing.
netstat -ano -p tcp | findstr /r /c:":%HUB_PORT% .*LISTENING" >nul && exit /b 0
echo [%date% %time%] Office Hub starting on %HUB_HOST%:%HUB_PORT% >> data\logs\hub.log
bun run src\server.ts >> data\logs\hub.log 2>&1
