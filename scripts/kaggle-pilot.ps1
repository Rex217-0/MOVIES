# Kaggle Pilot — ayusin ang koneksyon ng app sa Kaggle worker
#
# Ang app ay KLIYENTE: siya ang tumatawag sa Kaggle. Kaya ang Kaggle notebook
# ang kailangang magbigay ng pampublikong URL, at iyon ang isusulat natin sa
# KAGGLE_PILOT_URL ng app.
#
#   .\scripts\kaggle-pilot.ps1 -Url https://xxxx-yyyy.trycloudflare.com
#   .\scripts\kaggle-pilot.ps1 -Url https://xxxx.trycloudflare.com -Persist
#   .\scripts\kaggle-pilot.ps1 -Status
#   .\scripts\kaggle-pilot.ps1 -Stub            # subukan na walang GPU

param(
  [string]$Url = "",
  [string]$AppUrl = "http://127.0.0.1:3000",
  [switch]$Persist,
  [switch]$Status,
  [switch]$Stub,
  [int]$StubPort = 8077
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$envFile = Join-Path $root ".env"

function Set-EnvValue([string]$path, [string]$key, [string]$value) {
  $lines = @()
  if (Test-Path $path) { $lines = @(Get-Content $path) }
  $found = $false
  $out = foreach ($line in $lines) {
    if ($line -match "^\s*$([regex]::Escape($key))\s*=") {
      $found = $true
      "$key=`"$value`""
    } else { $line }
  }
  if (-not $found) { $out = @($out) + "$key=`"$value`"" }
  Set-Content -Path $path -Value $out -Encoding UTF8
}

function Show-Status {
  Write-Host "App: $AppUrl" -ForegroundColor Cyan
  try {
    $r = Invoke-RestMethod -Uri "$AppUrl/api/direk/feature/pilot" -TimeoutSec 15
    Write-Host "  configured : $($r.configured)"
    Write-Host "  reachable  : $($r.reachable)" -ForegroundColor $(if ($r.reachable) { "Green" } else { "Red" })
    Write-Host "  url        : $($r.url)"
    Write-Host "  detail     : $($r.detail)"
    Write-Host "  preferred  : $($r.preferred)" -ForegroundColor $(if ($r.preferred -eq "kaggle") { "Green" } else { "Yellow" })
    Write-Host "  local      : $($r.local.detail)"
  } catch {
    Write-Host "  Hindi maabot ang app sa $AppUrl" -ForegroundColor Red
    Write-Host "  Patakbuhin muna: npm start"
  }
}

if ($Stub) {
  Write-Host "Sinusubukan ang contract nang walang GPU (port $StubPort) ..." -ForegroundColor Cyan
  $py = (Get-Command python -ErrorAction SilentlyContinue)
  if (-not $py) { Write-Host "Kailangan ang Python sa PATH." -ForegroundColor Red; exit 1 }
  Start-Process -FilePath $py.Source `
    -ArgumentList @("scripts/kaggle_pilot_stub_server.py", "$StubPort") `
    -WorkingDirectory $root -WindowStyle Hidden
  Start-Sleep -Seconds 6
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$StubPort/health" -TimeoutSec 10
    Write-Host "  /health -> ok=$($h.ok) model=$($h.model) persona=$($h.persona)" -ForegroundColor Green
  } catch {
    Write-Host "  Walang sagot sa port $StubPort. Tingnan kung naka-install: pip install flask flask-cors waitress requests" -ForegroundColor Red
    exit 1
  }
  Write-Host ""
  Write-Host "Ngayon subukan ang app laban sa stub:" -ForegroundColor Cyan
  Write-Host "  `$env:KAGGLE_PILOT_URL='http://127.0.0.1:$StubPort'; npm start"
  exit 0
}

if ($Status -or -not $Url) {
  Show-Status
  exit 0
}

$Url = $Url.TrimEnd("/")
if ($Url -notmatch "^https?://") {
  Write-Host "Mukhang walang scheme ang URL. Halimbawa: https://abcd-efgh.trycloudflare.com" -ForegroundColor Red
  exit 1
}

Write-Host "Sinusuri ang worker sa $Url ..." -ForegroundColor Cyan
try {
  $h = Invoke-RestMethod -Uri "$Url/health" -TimeoutSec 20
  Write-Host "  /health -> ok=$($h.ok) model=$($h.model)" -ForegroundColor Green
} catch {
  Write-Host "  Walang sagot ang $Url/health" -ForegroundColor Red
  Write-Host "  Karaniwang dahilan: patay na ang notebook, o nagbago ang tunnel URL." -ForegroundColor Yellow
  Write-Host "  Bagong URL kada Kaggle session — kopyahin muli mula sa cell 6." -ForegroundColor Yellow
  exit 1
}

if ($Persist) {
  Set-EnvValue $envFile "KAGGLE_PILOT_URL" $Url
  Write-Host "  Naisulat sa .env: KAGGLE_PILOT_URL" -ForegroundColor Green
  Write-Host ""
  Write-Host "I-restart ang app para mabasa ito:" -ForegroundColor Cyan
  Write-Host "  Get-Process node -ErrorAction SilentlyContinue | Where-Object { `$_.Path -like '*node*' } | Stop-Process"
  Write-Host "  npm start"
} else {
  Write-Host ""
  Write-Host "Para gamitin ngayon sa terminal na ito:" -ForegroundColor Cyan
  Write-Host "  `$env:KAGGLE_PILOT_URL='$Url'"
  Write-Host "  npm start"
  Write-Host ""
  Write-Host "Para permanente sa .env: patakbuhin muli na may -Persist" -ForegroundColor Yellow
}
