# Build the signed Movie Creator APK on Windows (Server-2).
#
# Same pipeline as android/build.sh (javac -> d8 -> aapt2 -> zipalign ->
# apksigner), no Gradle. Run from the repo root:
#
#   powershell -ExecutionPolicy Bypass -File android\build.ps1
#
# Requirements: a JDK 17+ and the Android SDK command-line tools. If JAVA_HOME
# and ANDROID_HOME are already set in your environment, nothing else is needed.

$ErrorActionPreference = 'Stop'

if (-not $env:JAVA_HOME) { throw 'Set JAVA_HOME to a JDK (17+).' }
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { throw 'Set ANDROID_HOME to the Android SDK.' }

$here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$app   = Join-Path $here 'app'
$build = Join-Path $here 'build'
$outApk = Join-Path $here 'movie-creator.apk'
$bt    = Join-Path $sdk 'build-tools\35.0.0'
$platform = Join-Path $sdk 'platforms\android-34\android.jar'

if (-not (Test-Path $platform)) { throw "Missing $platform (sdkmanager `"platforms;android-34`")" }
if (Test-Path $build) { Remove-Item -Recurse -Force $build }
New-Item -ItemType Directory -Force -Path (Join-Path $build 'compiled'), (Join-Path $build 'gen'), (Join-Path $build 'classes'), (Join-Path $build 'dex') | Out-Null

Write-Host '[1/7] aapt2 compile resources'
& "$bt\aapt2.exe" compile --dir (Join-Path $app 'src\main\res') -o (Join-Path $build 'compiled\res.zip')
if ($LASTEXITCODE) { throw 'aapt2 compile failed' }

Write-Host '[2/7] aapt2 link'
& "$bt\aapt2.exe" link -o (Join-Path $build 'base.apk') -I $platform `
  --manifest (Join-Path $app 'src\main\AndroidManifest.xml') `
  --java (Join-Path $build 'gen') --min-sdk-version 21 --target-sdk-version 34 `
  --version-code 1 --version-name 1.0 (Join-Path $build 'compiled\res.zip')
if ($LASTEXITCODE) { throw 'aapt2 link failed' }

Write-Host '[3/7] javac'
$sources = Get-ChildItem -Recurse -Path (Join-Path $app 'src\main\java'), (Join-Path $build 'gen') -Filter *.java |
  ForEach-Object { $_.FullName }
& "$env:JAVA_HOME\bin\javac.exe" -source 8 -target 8 -nowarn -bootclasspath $platform -classpath $platform `
  -d (Join-Path $build 'classes') @sources 2>$null
if ($LASTEXITCODE) { throw 'javac failed' }

Write-Host '[4/7] d8'
$classes = Get-ChildItem -Recurse -Path (Join-Path $build 'classes') -Filter *.class | ForEach-Object { $_.FullName }
& "$bt\d8.bat" --lib $platform --min-api 21 --output (Join-Path $build 'dex') @classes
if ($LASTEXITCODE) { throw 'd8 failed' }

Write-Host '[5/7] add classes.dex'
Push-Location (Join-Path $build 'dex')
& "$bt\aapt.exe" add -f (Join-Path $build 'base.apk') classes.dex | Out-Null
Pop-Location
if ($LASTEXITCODE) { throw 'aapt add failed' }

Write-Host '[6/7] zipalign'
& "$bt\zipalign.exe" -f -p 4 (Join-Path $build 'base.apk') (Join-Path $build 'aligned.apk')
if ($LASTEXITCODE) { throw 'zipalign failed' }

Write-Host '[7/7] sign'
$ks = Join-Path $here 'moviecreator.keystore'
if (-not (Test-Path $ks)) {
  & "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -v -keystore $ks -alias moviecreator `
    -keyalg RSA -keysize 2048 -validity 10000 -storepass moviecreator -keypass moviecreator `
    -dname "CN=Movie Creator, O=LJR Group, C=PH"
  if ($LASTEXITCODE) { throw 'keytool failed' }
}
& "$bt\apksigner.bat" sign --ks $ks --ks-key-alias moviecreator `
  --ks-pass pass:moviecreator --key-pass pass:moviecreator `
  --out $outApk (Join-Path $build 'aligned.apk')
if ($LASTEXITCODE) { throw 'apksigner failed' }

Write-Host "OK -> $outApk ($((Get-Item $outApk).Length) bytes)"
