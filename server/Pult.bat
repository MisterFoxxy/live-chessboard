@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Пульт турнира
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Не установлен Node.js. Сейчас откроется сайт nodejs.org:
  echo нажмите зелёную кнопку LTS, установите, потом снова запустите пульт.
  start "" https://nodejs.org
  pause
  exit /b
)
node pult-app.js
echo.
pause
