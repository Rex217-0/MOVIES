# Cloudflare quick tunnel para sa Movie Creator
#
# Layunin: bigyan ang app ng pampublikong HTTPS URL (hal. https://xxxx.trycloudflare.com)
# para maabot ang web app at APK mula sa kahit anong network (mobile data), hindi
# LAN lang. Walang account na kailangan — "quick tunnel" ito.
#
# Tandaan: ang quick tunnel URL ay hindi permanente. Bagong URL sa bawat start,
# at ang tunnel ay kailangang patuloy na tumatakbo. Para sa permanenteng URL,
# gumawa ng *named* tunnel sa Cloudflare Zero Trust (dashboard).
#
# Safety: ang APP_AUTH_TOKEN ang nagpoprotekta sa /api. Kapag may tunnel, ang
# server ay nasa internet na — siguraduhing naka-set ang APP_AUTH_TOKEN sa .env,
# o magiging bukas ang (bayad na) AI endpoints sa kahit sino.

param(
  [int]$Port = 3000,
  [string]$Dir = "tools"
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$toolsDir = Join-Path $root $Dir
New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
$exe = Join-Path $toolsDir "cloudflared.exe"

if (-not (Test-Path $exe)) {
  Write-Host "Nagda-download ng cloudflared.exe ..."
  Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $exe
}

$log = Join-Path $toolsDir "tunnel.log"
if (Test-Path $log) { Remove-Item $log -Force }

Write-Host "Binubuksan ang tunnel papuntang http://127.0.0.1:$Port ..."
$proc = Start-Process -FilePath $exe `
  -ArgumentList @("tunnel", "--url", "http://127.0.0.1:$Port", "--no-autoupdate", "--logfile", $log) `
  -PassThru -WindowStyle Hidden

$url = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path $log) {
    $m = Select-String -Path $log -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" | Select-Object -First 1
    if ($m) { $url = $m.Matches[0].Value; break }
  }
}

if (-not $url) {
  Write-Host "Walang tunnel URL pagkalipas ng 60s. Tingnan ang $log" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "PUBLIC URL : $url" -ForegroundColor Green
Write-Host "Landing    : $url/landing"
Write-Host "Dashboard  : $url/dashboard"
Write-Host "Android APK: $url/android"
Write-Host ""
Write-Host "Buksan ang mga ito sa tablet at phone (kahit mobile data)."
Write-Host "Patayin ang tunnel: Stop-Process -Id $($proc.Id)"
Write-Host ""
Write-Host "PAALALA: i-set ang APP_AUTH_TOKEN sa .env bago ibukas sa internet."
