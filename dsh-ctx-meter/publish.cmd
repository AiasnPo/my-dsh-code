@echo off
rem dsh-ctx-meter publisher wrapper.
rem Bypasses the machine's execution policy (scripts are blocked by default here).
rem Usage:  publish.cmd -User <your-github-username>  [-Repo name] [-NoPush]
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\publish.ps1" %*
set RC=%ERRORLEVEL%
endlocal & exit /b %RC%
