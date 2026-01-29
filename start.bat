@echo off
setlocal

chcp 65001 >nul
cd /d "%~dp0"

set "PORT=3000"
set "QWEN_MODEL_PATH=models\Qwen3-1.7B"
set "QWEN_CACHE_PATH=data\qwen_cache.jsonl"
set "HF_HOME=.hf"

echo [FuzzyWord] 启动服务中...
echo [FuzzyWord] PORT=%PORT%
echo [FuzzyWord] QWEN_MODEL_PATH=%QWEN_MODEL_PATH%
echo [FuzzyWord] QWEN_CACHE_PATH=%QWEN_CACHE_PATH%
echo [FuzzyWord] HF_HOME=%HF_HOME%
echo.

start "FuzzyWord Server" cmd /k "cd /d \"%~dp0\" && set PORT=%PORT% && set QWEN_MODEL_PATH=%QWEN_MODEL_PATH% && set QWEN_CACHE_PATH=%QWEN_CACHE_PATH% && set HF_HOME=%HF_HOME% && node server.js"

timeout /t 1 >nul
start "" "http://localhost:%PORT%"

echo [FuzzyWord] 已打开浏览器。如需停止服务，请关闭“FuzzyWord Server”窗口。
endlocal
