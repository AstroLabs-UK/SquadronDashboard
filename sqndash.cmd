@echo off
REM Windows entry point for Squadron Dashboard (calls sqndash.ps1)
setlocal
set "SCRIPT_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%sqndash.ps1" %*
exit /b %ERRORLEVEL%
