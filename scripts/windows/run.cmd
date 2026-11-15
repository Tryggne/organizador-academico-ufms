@echo off
setlocal
cd /d "%~dp0..\.."
where node >nul 2>&1
if errorlevel 1 exit /b 10
if not exist "node_modules\playwright\package.json" exit /b 11
node scripts\organizer-server.cjs %*
