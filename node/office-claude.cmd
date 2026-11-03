@echo off
rem 啟動「辦公室用」的 Claude Code：載入 office 頻道外掛（開發者頻道，啟動時會有一次確認畫面）。
rem 只有用這個指令開的 session 會連到 Hub；平常開的 claude 不受影響。
rem   office-claude              這台的主要 Claude（設定在 %USERPROFILE%\.claude\channels\office）
rem   office-claude claude_c     同一台的另一個 Claude（先執行 office setup-claude --as claude_c）
rem   其餘參數會原樣傳給 claude
rem （echo 用英文：cmd 預設以系統編碼讀檔，中文會變亂碼）
setlocal
where claude >nul 2>nul
if errorlevel 1 (
  echo [office-claude] 'claude' is not on PATH. If you only have the Claude desktop app, run: winget install Anthropic.ClaudeCode
  exit /b 1
)
set "ARG1=%~1"
if defined ARG1 if not "%ARG1:~0,1%"=="-" (
  set "OFFICE_STATE_DIR=%USERPROFILE%\.claude\channels\office-%ARG1%"
  set "OFFICE_AS=%ARG1%"
  shift
)
if defined OFFICE_STATE_DIR if not exist "%OFFICE_STATE_DIR%\.env" (
  echo [office-claude] %OFFICE_STATE_DIR%\.env not found. Run: office setup-claude --as %ARG1%
  exit /b 1
)
set "REST="
:collect
if "%~1"=="" goto run
set REST=%REST% %1
shift
goto collect
:run
set OFFICE_SESSION=1
if not defined OFFICE_AS set OFFICE_AS=claude
claude --dangerously-load-development-channels plugin:office@office-local%REST%
