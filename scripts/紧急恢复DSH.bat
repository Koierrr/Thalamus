@echo off
chcp 65001 >nul
echo 正在移除 dsh-wechat-companion（她的插件）注册...
call "%APPDATA%\DSH Desktop\runtime-commands\private\node-bin\node.cmd" "%~dp0recover.js"
pause
