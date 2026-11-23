# Android app (installable APK)

> This is the **legacy** no-Gradle shell (`android-legacy/`). The primary Android
> app is now the Capacitor project in `android/` (see `docs/capacitor-android.md`).
> This one still builds and is still what `/android` serves today; it stays for
> anyone who wants a tiny WebView APK with no Gradle.

The phone is a **remote**. The heavy work (rendering, LoRA, ffmpeg) still runs on
Server-2 or wherever the web app is deployed. This APK is a thin, native shell
around that web app: it stores the server address and the auth token, then loads
the app full-screen in a WebView.

There is no fake data anywhere in it. If the server is not reachable, the phone
shows the real browser error — the same honesty rule as the rest of the project.

## What it is

- Package `im.moviecreator.app`, label "Movie Creator", minSdk 21 (Android 5+),
  targetSdk 34.
- One Activity (`MainActivity`): a setup screen on first launch, then the app.
- Permissions: `INTERNET`, `ACCESS_NETWORK_STATE` — nothing else.
- Cleartext HTTP is allowed because Server-2 is reached by LAN IP over plain
  HTTP. If you put it behind HTTPS, tighten
  `android-legacy/app/src/main/res/xml/network_security_config.xml` back to
  `cleartextTrafficPermitted="false"`.

## Build it (on Server-2)

The build has **no Gradle** — one Activity with no libraries means the whole
thing is `javac -> d8 -> aapt2 -> zipalign -> apksigner`. You need only a JDK
and the Android SDK command-line tools.

```bash
# 1. JDK 17+ and the Android SDK command-line tools
#    https://developer.android.com/studio#command-line-tools-only
export JAVA_HOME=/path/to/jdk
export ANDROID_HOME=/path/to/android-sdk
sdkmanager "platforms;android-34" "build-tools;35.0.0"

# 2. Build the signed APK
bash android-legacy/build.sh   # (Windows: powershell -ExecutionPolicy Bypass -File android-legacy\build.ps1)
# -> android-legacy/movie-creator.apk
```

`build.sh` generates `android-legacy/moviecreator.keystore` on first run
(passphrase `moviecreator`, alias `moviecreator`). **Keep that keystore**: Android
refuses to update an app whose signature changed. It is git-ignored, so back it up
yourself.

## Install on the phone

1. Start the web app on Server-2 (it already binds `0.0.0.0`):
   ```bash
   NODE_ENV=production PORT=3000 APP_AUTH_TOKEN=<token> node server.ts
   ```
2. Find Server-2's LAN IP (`ipconfig` on Windows).
3. On the phone, open `http://<SERVER-IP>:3000/android` and tap the download
   button. (The page and the APK are public on purpose: the phone has no token
   yet. They expose nothing but the app itself.)
4. Allow "Install unknown apps" for the browser when prompted, then install.
5. Open **Movie Creator** and enter:
   - server address, e.g. `http://192.168.1.10:3000`
   - the `APP_AUTH_TOKEN`, if the server has one
6. Tap **Kumonekta**. The app loads. Tap **Palitan ang server** (or the hardware
   menu key) to change the address later.

Phone and server must be on the same Wi-Fi/LAN. For access from outside the
home, put the server behind a tunnel or reverse proxy with HTTPS — do not expose
plain HTTP to the internet.

## Layout

```
android-legacy/
  build.sh                 build + sign, no Gradle
  app/src/main/
    AndroidManifest.xml
    java/im/moviecreator/app/MainActivity.java
    res/values/{strings,styles}.xml
    res/xml/network_security_config.xml
    res/mipmap-*/ic_launcher.png
```

## Why not a PWA instead?

The repo also ships a PWA (`public/manifest.webmanifest`, `public/sw.js`). A PWA
is the lighter option and needs no build — but a service worker only runs on a
secure origin, so over plain-HTTP LAN it is skipped, and iOS/Android "install"
is inconsistent. The APK is the option that reliably installs and launches like a
real app. Use whichever fits; both point at the same server.
