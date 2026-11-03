@echo off
set OFFICE_SESSION=1
set OFFICE_AS=claude
claude --dangerously-load-development-channels plugin:office@office-local %*
