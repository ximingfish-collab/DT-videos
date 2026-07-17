@echo off
chcp 65001 >nul
cd /d "%~dp0"
node table_editor.js
if errorlevel 1 (
  echo.
  echo 启动失败，请查看上方的具体错误信息。
  pause
)
