@echo off
rem 啟動「辦公室用」的 Claude Code：載入 office 頻道外掛（開發者頻道，啟動時會有一次確認畫面）。
rem 只有用這個指令開的 session 會連到 Hub；平常開的 claude 不受影響。
where claude >nul 2>nul
if errorlevel 1 (
  echo PATH 裡找不到 claude 指令。只裝了 Claude 桌面版的話，請先執行：winget install Anthropic.ClaudeCode
  exit /b 1
)
set OFFICE_SESSION=1
set OFFICE_AS=claude
claude --dangerously-load-development-channels plugin:office@office-local %*
