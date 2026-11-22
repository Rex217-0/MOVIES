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
  [string]$Dir = "tools",
  # Ang ComfyUI (8188) ay WALANG authentication. Ang quick tunnel ay pampublikong
  # URL, kaya kahit sino na makahula o makakita ng URL ay makakapagpatakbo ng
  # prompt sa GPU mo. Kailangan ng tahasang pagpayag bago ito buksan.
  [switch]$IAcceptExposure
)

$ErrorActionPreference = "Stop"

if ($Port -eq 8188 -and -not $IAcceptExposure) {
  Write-Host ""
  Write-Host "HINDI BINUKASAN. Ang port 8188 ay ComfyUI, at wala itong authentication." -ForegroundColor Yellow
  Write-Host "Ang quick tunnel ay pampublikong URL: kahit sino na makakuha nito ay"
  Write-Host "makakapagpatakbo ng prompt sa GPU mo, walang limitasyon."
  Write-Host ""
  Write-Host "Mas ligtas: patakbuhin ang app SA Server-2 mismo (COMFYUI_URL=http://127.0.0.1:8188),"
  Write-Host "tapos i-tunnel ang port 3000 lang. Ganito ang default:"
  Write-Host "    powershell -ExecutionPolicy Bypass -File .\scripts\tunnel.ps1"
  Write-Host ""
  Write-Host "Kung talagang kailangan ng Render na maabot ang ComfyUI, ulitin kasama ang:"
  Write-Host "    powershell -ExecutionPolicy Bypass -File .\scripts\tunnel.ps1 -Port 8188 -IAcceptExposure"
  Write-Host ""
  exit 1
}
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$toolsDir = Join-Path $root $Dir
New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
$exe = Join-Path $toolsDir "cloudflared.exe"

if (-not (Test-Path $exe)) {
  Write-Host "Nagda-download ng cloudflared.exe ..."
  Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $exe
}

# Ang log ay per-port. Kung pareho ang pangalan, mabubura ng pangalawang
# tunnel (hal. 8188 para sa ComfyUI) ang log ng una (3000), at mawawala ang
# URL na kailangan mong i-paste sa Render.
$log = Join-Path $toolsDir "tunnel-$Port.log"
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
