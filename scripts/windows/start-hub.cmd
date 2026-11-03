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
rem Use a full path: with NoDefaultCurrentDirectoryInExePath=1 (e.g. Claude Code terminals)
rem a bare "call hub.env.cmd" is not found in the current directory.
if exist "%CD%\hub.env.cmd" call "%CD%\hub.env.cmd"
if "%HUB_HOST%"=="" set HUB_HOST=127.0.0.1
if "%HUB_PORT%"=="" set HUB_PORT=7070
if not exist data\logs mkdir data\logs
rem If something already listens on the port (another Hub), say so and stop.
netstat -ano -p tcp | findstr /r /c:":%HUB_PORT% .*LISTENING" >nul && (
  echo [office] Port %HUB_PORT% is already in use - the Hub is probably running already.
  exit /b 0
)
title AI Office Hub
echo [office] Office Hub on %HUB_HOST%:%HUB_PORT% - log: %CD%\data\logs\hub.log
echo [office] Close this window to stop the Hub.
echo [%date% %time%] Office Hub starting on %HUB_HOST%:%HUB_PORT% >> data\logs\hub.log
bun run src\server.ts >> data\logs\hub.log 2>&1
