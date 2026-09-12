@echo off
chcp 65001 >nul
title wxauto bridge (:43123)
set "WXAUTO_BRIDGE_CONFIG=%USERPROFILE%\.dsh\wechat-companion\wxauto-bridge.json"
echo 检查 wxauto 依赖...
python -c "import wxauto" 2>nul
if errorlevel 1 (
  echo 未安装，正在 pip install wxauto ...
  python -m pip install wxauto
)
echo ============================================
echo   wxauto 通道桥   127.0.0.1:43123
echo   前提：微信3.9窗口已登录且【不要最小化】
echo   总开关在 后台-设置-通道，默认关闭
echo ============================================
python "%~dp0python\wxauto_bridge.py"
echo.
echo 桥已退出。按任意键关闭窗口。
pause >nul
