@echo off
rem 啟動「辦公室用」的 Claude Code：載入 office 頻道外掛（開發者頻道，啟動時會有一次確認畫面）。
rem 只有用這個指令開的 session 會連到 Hub；平常開的 claude 不受影響。
rem （echo 用英文：cmd 預設以系統編碼讀檔，中文會變亂碼）
where claude >nul 2>nul
if errorlevel 1 (
  echo [office-claude] 'claude' is not on PATH. If you only have the Claude desktop app, run: winget install Anthropic.ClaudeCode
  exit /b 1
)
set OFFICE_SESSION=1
set OFFICE_AS=claude
claude --dangerously-load-development-channels plugin:office@office-local %*
