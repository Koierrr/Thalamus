@echo off
chcp 65001 >nul
title Her Memory Engine (mem0 sidecar :43122)
set "MEMORY_SERVICE_CONFIG=%USERPROFILE%\.dsh\wechat-companion\memory-service.json"
echo ============================================
echo   她的记忆引擎 mem0 sidecar   127.0.0.1:43122
echo   向量: faiss(本地)   嵌入: bge-m3(本地 Ollama)
echo   提炼: 云端便宜模型（后台-设置-记忆 里配置）
echo   请保持本窗口开着；关窗口 = 停记忆引擎
echo ============================================
python "%~dp0python\memory_service.py"
echo.
echo 引擎已退出。按任意键关闭窗口。
pause >nul
