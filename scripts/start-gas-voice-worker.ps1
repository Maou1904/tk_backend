$ErrorActionPreference = 'Stop'
$backendDir = Split-Path -Parent $PSScriptRoot
$workerScript = Join-Path $PSScriptRoot 'gas-voice-worker.cjs'
$runtimeDir = Join-Path $backendDir 'pids\gas-ai'
if (-not (Test-Path -LiteralPath (Join-Path $runtimeDir 'worker-private.pem'))) { throw 'Run node scripts/setup-gas-voice-worker.cjs first' }
$stopFlag = Join-Path $runtimeDir 'stop'
if (Test-Path -LiteralPath $stopFlag) { Remove-Item -LiteralPath $stopFlag }
$workerProcess = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @(('"{0}"' -f $workerScript)) -WorkingDirectory $backendDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDir 'stdout.log') -RedirectStandardError (Join-Path $runtimeDir 'stderr.log')
Write-Output ('Started gas AI worker, process {0}' -f $workerProcess.Id)
