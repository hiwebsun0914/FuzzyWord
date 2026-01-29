param(
  [int]$Port = 3000
)

Set-Location $PSScriptRoot

$env:PORT = "$Port"
$env:QWEN_MODEL_PATH = "models\\Qwen3-1.7B"
$env:QWEN_CACHE_PATH = "data\\qwen_cache.jsonl"
$env:HF_HOME = ".hf"

Write-Host "[FuzzyWord] PORT=$env:PORT"
Write-Host "[FuzzyWord] QWEN_MODEL_PATH=$env:QWEN_MODEL_PATH"
Write-Host "[FuzzyWord] QWEN_CACHE_PATH=$env:QWEN_CACHE_PATH"
Write-Host "[FuzzyWord] HF_HOME=$env:HF_HOME"

Start-Process "http://localhost:$env:PORT"
node .\server.js
