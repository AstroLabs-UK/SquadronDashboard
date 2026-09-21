@echo off
REM Emergency stop - does not need sqndash.ps1
echo Stopping all node.exe processes...
taskkill /F /IM node.exe 2>nul
echo Done. Start again with: sqndash --start
