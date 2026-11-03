@echo off
rem Windows 端 office-node：只放 claude_token，負責回報「辦公室用的 Claude session 有沒有在跑」。
rem 設定檔：%USERPROFILE%\.office\config.json（範例 node\config.windows-A.example.json）
setlocal
cd /d "%~dp0..\.."
if not exist data\logs mkdir data\logs
bun node\office.ts run >> data\logs\office-node.log 2>&1
