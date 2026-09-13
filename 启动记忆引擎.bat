@echo off
rem 她的记忆不出门：进程级关掉所有已知遥测（只写 config 不够）
set PYTHONUNBUFFERED=1
set MEM0_TELEMETRY=False
set ANONYMIZED_TELEMETRY=False
set CHROMA_TELEMETRY=False
set DO_NOT_TRACK=1
set HF_HUB_DISABLE_TELEMETRY=1
set SCARF_NO_ANALYTICS=true

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
