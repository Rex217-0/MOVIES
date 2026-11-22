<#
  server2-check.ps1 - Verify the ComfyUI video backend on Server-2 (Windows 11 + WSL Ubuntu + RX 9070).

  Runs four checks, in order, and writes everything to docs/evidence/server2-check.txt:
    A. GET {ComfyUrl}/system_stats            -> must be HTTP 200 (ComfyUI is up)
    B. GET {ComfyUrl}/object_info/<loader>    -> the three Wan 2.2 model names must appear
    C. the three model files on disk in WSL   -> must exist at the exact expected byte size
    D. GET {AppUrl}/api/direk/video/backend   -> ready: true and engine: "comfyui"

  This script never fabricates a result: every line is the real output of a real
  command. If a check fails, it says so and the process exits non-zero.

  Usage (from the repo root, in PowerShell on Server-2):
    powershell -ExecutionPolicy Bypass -File .\scripts\server2-check.ps1
    powershell -ExecutionPolicy Bypass -File .\scripts\server2-check.ps1 -ComfyUrl http://127.0.0.1:8188 -AppUrl http://127.0.0.1:3000
#>
[CmdletBinding()]
param(
  [string]$ComfyUrl   = 'http://127.0.0.1:8188',
  [string]$AppUrl     = 'http://127.0.0.1:3000',
  [string]$ModelsRoot = '~/isa_movie/ComfyUI/models',
  [string]$OutFile    = (Join-Path $PSScriptRoot '..\docs\evidence\server2-check.txt')
)

$ErrorActionPreference = 'Continue'
$log = New-Object System.Collections.Generic.List[string]
function Log([string]$s) { $log.Add($s); Write-Host $s }

# The exact sizes published by Hugging Face for the Wan 2.2 TI2V 5B repack.
# A file that is a few KB is a bad link or a truncated download, not a model.
$expected = [ordered]@{
  'diffusion_models/wan2.2_ti2v_5B_fp16.safetensors'          = 9999658848
  'text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors'      = 6735906897
  'vae/wan2.2_vae.safetensors'                                = 1409400960
}

$loaders = [ordered]@{
  'UNETLoader' = 'wan2.2_ti2v_5B_fp16.safetensors'
  'CLIPLoader' = 'umt5_xxl_fp8_e4m3fn_scaled.safetensors'
  'VAELoader'  = 'wan2.2_vae.safetensors'
}

$failures = 0
Log "=== server2-check: $(Get-Date -Format o) ==="
Log "ComfyUrl   : $ComfyUrl"
Log "AppUrl     : $AppUrl"
Log "ModelsRoot : $ModelsRoot (in WSL)"
Log ''

# --- A. ComfyUI is up -------------------------------------------------------
Log '--- A. GET /system_stats (must be HTTP 200) ---'
try {
  $sys = Invoke-RestMethod -Uri "$ComfyUrl/system_stats" -TimeoutSec 10
  Log ("HTTP 200. comfyui_version={0} python={1} pytorch={2}" -f $sys.system.comfyui_version, $sys.system.python_version, $sys.system.pytorch_version)
  foreach ($d in $sys.devices) {
    Log ("device: name={0} type={1} vram_total={2}" -f $d.name, $d.type, $d.vram_total)
    if ($d.type -ne 'cuda') { Log "WARNING: device type is '$($d.type)', not 'cuda'. ROCm reports as cuda; 'cpu' means no GPU."; $failures++ }
  }
} catch {
  Log "FAIL: /system_stats unreachable: $($_.Exception.Message)"
  $failures++
}
Log ''

# --- B. object_info lists the three models ----------------------------------
Log '--- B. GET /object_info/<loader> (model names must appear) ---'
foreach ($loader in $loaders.Keys) {
  $want = $loaders[$loader]
  try {
    $info = Invoke-RestMethod -Uri "$ComfyUrl/object_info/$loader" -TimeoutSec 10
    $field = if ($loader -eq 'UNETLoader') { 'unet_name' } elseif ($loader -eq 'CLIPLoader') { 'clip_name' } else { 'vae_name' }
    $choices = @($info.$loader.input.required.$field[0])
    if ($choices -contains $want) {
      Log "OK   $loader.$field contains '$want'"
    } else {
      Log "FAIL $loader.$field does NOT contain '$want' (found: $($choices -join ', '))"
      $failures++
    }
  } catch {
    Log "FAIL $loader unreachable: $($_.Exception.Message)"
    $failures++
  }
}
Log ''

# --- C. model files on disk, exact size -------------------------------------
Log '--- C. model files on disk in WSL (exact byte size) ---'
foreach ($rel in $expected.Keys) {
  $want = $expected[$rel]
  $path = "$ModelsRoot/$rel"
  $actual = (& wsl bash -lc "stat -c '%s' $path 2>/dev/null").Trim()
  if (-not $actual) {
    Log "FAIL $path not found"
    $failures++
  } elseif ([int64]$actual -eq $want) {
    Log "OK   $path = $actual bytes"
  } else {
    $kb = [math]::Round(([int64]$actual / 1KB), 1)
    Log "FAIL $path = $actual bytes (expected $want; that is $kb KB - a bad link or a truncated download)"
    $failures++
  }
}
Log ''

# --- D. the app reports the backend ready -----------------------------------
Log '--- D. GET /api/direk/video/backend (ready: true, engine: comfyui) ---'
try {
  $backend = Invoke-RestMethod -Uri "$AppUrl/api/direk/video/backend" -TimeoutSec 15
  Log ("ready={0} engine={1} problem={2} reachable={3} workflow_exists={4}" -f `
    $backend.ready, $backend.engine, $backend.comfyui.problem, $backend.comfyui.reachable, $backend.comfyui.workflow_exists)
  if ($backend.ready -ne $true -or $backend.engine -ne 'comfyui') { Log 'FAIL: backend is not ready/comfyui'; $failures++ }
} catch {
  Log "FAIL: app backend unreachable at $AppUrl (is the app running?): $($_.Exception.Message)"
  $failures++
}
Log ''

# --- summary -----------------------------------------------------------------
if ($failures -eq 0) {
  Log 'RESULT: PASS - all checks OK. The next step is a real render (POST /api/pilot/video/generate).'
} else {
  Log "RESULT: FAIL - $failures check(s) failed. Fix them before rendering."
}

$dir = Split-Path -Parent $OutFile
if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
Set-Content -Path $OutFile -Value ($log -join "`n") -Encoding UTF8
Write-Host ''
Write-Host "Wrote $OutFile"

exit $(if ($failures -eq 0) { 0 } else { 1 })
