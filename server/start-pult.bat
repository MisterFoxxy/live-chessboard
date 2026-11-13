@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Пульт турнира: сервер + бесплатный адрес Cloudflare. Окна не закрывать, пока идёт тур.
start "Pult server" cmd /k node server.js
timeout /t 2 >nul
echo.
echo Адрес пульта появится ниже в рамке: https://....trycloudflare.com
echo.
cloudflared tunnel --protocol http2 --url http://localhost:8080
pause
