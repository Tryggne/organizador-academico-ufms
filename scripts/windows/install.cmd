@echo off
setlocal
cd /d "%~dp0..\.."
where node >nul 2>&1
if errorlevel 1 exit /b 10
call npm install
if errorlevel 1 exit /b 11
call npm run install-browser
if errorlevel 1 exit /b 12
if not exist "..\Atividades" mkdir "..\Atividades"
exit /b 0
