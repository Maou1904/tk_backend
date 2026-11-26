$ErrorActionPreference = 'Stop'
$backendDir = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $backendDir 'pids\gas-ai'
Set-Content -LiteralPath (Join-Path $runtimeDir 'stop') -Value 'stop'
Write-Output 'Requested gas AI worker stop; the shop will switch to rules'
