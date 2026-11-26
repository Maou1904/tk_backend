$ErrorActionPreference = 'Stop'
$nodePath = (Get-Command node.exe).Source
$workerScript = Join-Path $PSScriptRoot 'gas-voice-worker.cjs'
$startupDir = [Environment]::GetFolderPath('Startup')
$launcher = Join-Path $startupDir 'Tingkum Gas AI.vbs'
# Launch Node directly: no administrator account, saved password or policy change.
$commandLine = '"{0}" "{1}"' -f $nodePath,$workerScript
$vbs = 'CreateObject("WScript.Shell").Run "{0}", 0, False' -f $commandLine.Replace('"','""')
Set-Content -LiteralPath $launcher -Value $vbs -Encoding Unicode
Write-Output 'Installed gas AI autostart for this Windows user'
