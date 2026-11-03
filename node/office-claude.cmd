@echo off
rem Start the "office" Claude Code session: loads the office channel plugin
rem (development channel; a confirmation screen appears once at startup).
rem Only sessions started with this command connect to the Hub; plain `claude` is unaffected.
rem   office-claude              main Claude on this machine (config in %USERPROFILE%\.claude\channels\office)
rem   office-claude claude_c     another Claude on this machine (run office setup-claude --as claude_c first)
rem   Other arguments are passed to claude unchanged.
rem NOTE: keep this file pure ASCII (cmd.exe reads it in the system code page).
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
