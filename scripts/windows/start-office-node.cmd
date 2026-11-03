@echo off
rem Start office-node on Windows: runs the workers (Hermes etc.), heartbeats,
rem and reports the Claude session state.
rem Config: %USERPROFILE%\.office\config.json (see node\config.windows-A.example.json)
rem NOTE: keep this file pure ASCII (cmd.exe reads it in the system code page).
setlocal
cd /d "%~dp0..\.."
if not exist data\logs mkdir data\logs
echo [%date% %time%] office-node starting >> data\logs\office-node.log
bun node\office.ts run >> data\logs\office-node.log 2>&1
