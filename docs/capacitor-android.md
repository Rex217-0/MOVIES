# Android app (Capacitor)

The primary Android app. It is the same React web app, packaged with
[Capacitor](https://capacitorjs.com) so it installs and launches like a native
app. The heavy work (rendering, LoRA, ffmpeg) still runs on Server-2; the phone
is the client.

There is **no fake data and no mock**: if the server is not reachable the app
shows the real error, exactly like the web app. See
[Honesty rule](#honesty-rule).

## Two Android projects, on purpose

| Path | What it is | Status |
| --- | --- | --- |
| `android/` | Capacitor + Gradle project (this doc) | **primary** |
| `android-legacy/` | Old no-Gradle WebView shell, ~21 KB | still builds; what `/android` serves today |

The legacy shell was moved out of `android/` so Capacitor could own that path.
Its build is unchanged: `bash android-legacy/build.sh` (see
[docs/android-app.md](android-app.md)). The `/android` download page and its
tests still point at `android-legacy/movie-creator.apk`.

## Why the app needs a server address at build time

The browser build is served by the app itself, so its `/api/...` calls are
relative and hit the same origin — no configuration. The Capacitor app loads the
web app from `https://localhost` inside the WebView, where a relative `/api/...`
call would hit the WebView, not Server-2. So the app needs the server address
from somewhere.

**You no longer have to rebuild to change it.** Set it at runtime, either way:

- In the app: **Setup → Server address → Server URL**, then SAVE. Kept in
  `localStorage`, so it survives restarts.
- On first load: open the app with `?server=http://192.168.1.10:3000` in the URL.

The runtime value wins. If it is empty, the build-time `VITE_API_BASE_URL` baked
into the bundle is used:

```ts
// src/api.ts
apiUrl('/api/health', 'http://192.168.1.10:3000') // -> http://192.168.1.10:3000/api/health
apiUrl('/api/health', '')                          // -> /api/health  (browser build)
```

Every request goes through this one helper (`apiFetch`, `thoughtStreamUrl`,
`trainStreamUrl`, `assetDownloadUrl`). No server address is hardcoded anywhere in
the repo, and nothing about it is committed.

## Build the APK

Needs a JDK 17+ and the Android SDK. Install them once with the same script the
legacy build uses:

```bash
bash scripts/setup-android-sdk.sh
```

Then, from the repo root:

```bash
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64   # or your JDK
export ANDROID_HOME=/opt/android-sdk
echo "sdk.dir=$ANDROID_HOME" > android/local.properties

# 1. Build the web app with the server address baked in.
VITE_API_BASE_URL="http://192.168.1.10:3000" npm run build

# 2. Copy dist/ into the Android project and refresh plugins.
npx cap sync android

# 3. Build the APK.
cd android && ./gradlew assembleDebug        # -> app/build/outputs/apk/debug/app-debug.apk
```

`npm run android:apk` runs steps 1–3 with `VITE_API_BASE_URL` from your shell.

The debug APK is signed with the Android debug key, so it installs but is not
for release. For a release build, add a `signingConfigs` block in
`android/app/build.gradle` with a real keystore and run `./gradlew assembleRelease`.

Verify what you built:

```bash
$ANDROID_HOME/build-tools/35.0.0/aapt2 dump badging \
  android/app/build/outputs/apk/debug/app-debug.apk | grep -E 'package|application-label'
# package: name='com.ljrgroup.moviecity' versionCode='1' versionName='1.0'
# application-label:'Movie Creator'
```

## The server must allow the app's origin

The Capacitor WebView sends `Origin: https://localhost` on every request, and the
server enforces CORS on all routes. Add that origin, or every `/api` call returns
`403`:

```bash
ALLOWED_ORIGINS="https://localhost"   # comma-separated; add your web origin too
APP_AUTH_TOKEN="<your token>"         # required in production
```

The app attaches `APP_AUTH_TOKEN` as a bearer token; you enter it in the app once
(it is kept in the WebView's local storage).

## Firebase — package name must match, or `google-services.json` breaks the build

The app's application id is **`com.ljrgroup.moviecity`** (set in
`capacitor.config.ts`). A `google-services.json` whose client `package_name` does
not match makes the Gradle `processDebugGoogleServices` task **fail** with
`No matching client found for package name`.

A `google-services.json` for this project must therefore contain:

```json
"android_client_info": { "package_name": "com.ljrgroup.moviecity" }
```

If you registered a different package (for example `com.ljrSengine.com`) in the
Firebase console, either:

1. add an Android app with package `com.ljrgroup.moviecity` in the Firebase
   console and use that `google-services.json`, or
2. change `appId` in `capacitor.config.ts` to the registered package and re-run
   `npx cap sync android`.

Then apply the Google Services Gradle plugin:

```gradle
// android/build.gradle
classpath 'com.google.gms:google-services:4.4.2'
// android/app/build.gradle (at the bottom)
apply plugin: 'com.google.gms.google-services'
```

Never commit `google-services.json` with real keys if you do not mean to; the
file contains an API key. It is git-ignored here.

## Honesty rule

The app contains no fake data and no mock backend. If the server address is
wrong, or the server is down, or CORS rejects the origin, the app shows the real
failure — the same rule the rest of the project follows. The AI endpoints report
`503 AI_UNAVAILABLE` when no model is configured, rather than inventing output.

## Layout

```
capacitor.config.ts              appId com.ljrgroup.moviecity, appName Movie Creator, webDir dist
android/                         Capacitor + Gradle project (generated)
  app/src/main/AndroidManifest.xml            cleartext + network security config
  app/src/main/res/xml/network_security_config.xml
  app/src/main/assets/public/                 the built web app (dist/), git-ignored
```
