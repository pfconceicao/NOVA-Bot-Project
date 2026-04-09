$ErrorActionPreference = "Continue"

$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$tempDir = Join-Path $env:TEMP "nova-bot-logs"
if (-not (Test-Path $tempDir)) {
  New-Item -ItemType Directory -Path $tempDir | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logFile = Join-Path $tempDir "server-$timestamp.log"

Write-Host ""
Write-Host "========================================"
Write-Host "NOVA.Bot com log temporário ativo"
Write-Host "Log temporário: $logFile"
Write-Host "O ficheiro será eliminado quando o servidor terminar."
Write-Host "========================================"
Write-Host ""

try {
  node .\nova-bot-server.js 2>&1 | Tee-Object -FilePath $logFile
}
finally {
  if (Test-Path $logFile) {
    Remove-Item $logFile -Force -ErrorAction SilentlyContinue
    Write-Host "Log temporário removido."
  }
}