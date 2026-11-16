# Movie Creator v1.0.1 — web app sa tablet, APK sa phone

Ito ang release ng **web app** (mabubuksan sa browser ng tablet) kasama ang
**Android APK** para sa phone. Hindi kasama rito ang anumang `.env`, token, o IP
address — ang mga iyon ay nasa iyong `.env` lang, hindi sa release.

## Bago sa bersyong ito

### Web app na maa-access sa browser ng tablet
- **`/landing`** — ang front door: hero, features, mga hakbang, tech stack.
  Mabubuksan sa browser ng tablet, phone, o desktop.
- **`/dashboard`** — live na kalagayan: ComfyUI reachability, GPU mesh workers,
  mga job. Ang bawat numero ay galing sa **totoong** API, walang fabricated data.
  Kung kailangan ng token, nagtatanong ito ng `APP_AUTH_TOKEN` at nagpapakita ng
  honest 401 — hindi nanghuhula.

### Pampublikong access (para sa tablet na malayo sa server)
- **`scripts/tunnel.ps1`** (Windows) at **`scripts/tunnel.sh`** (Linux/macOS):
  isang utos para bigyan ang app ng pampublikong HTTPS URL
  (`https://....trycloudflare.com`) gamit ang Cloudflare quick tunnel. Kaya
  maaabot ang web app at APK mula sa kahit anong network, hindi LAN lang.
  Tingnan ang `docs/public-access.md`.

### Android APK — phone **at** tablet
- Ang manifest ay may `supports-screens` (lahat ng size at density) at
  `resizeableActivity`, kaya ang WebView shell ay umaangkop sa tablet at phone.
- Ang APK sa release na ito ay **bagong build** mula sa source na ito, pirmado
  (`CN=Movie Creator, O=LJR Group, C=PH`), at kinabitan ng tablet flags.

### Tapat na video backend
- Kapag hindi maabot ang ComfyUI, ang `/api/pilot/video/generate` ay nagbabalik
  ng **503** na may **eksaktong** `COMFYUI_URL` at dahilan — walang pekeng video.
- Ang `COMFYUI_URL` ay binabasa mula sa `.env`; walang hardcoded na host sa code.

### Kaggle worker
- **`scripts/direk_kaggle_gear253b.ipynb`** — ang T3 heavy-batch worker (Qwen 2.5
  3B) na tumatakbo sa Kaggle GPU sa likod ng Cloudflare tunnel. Tumutugma sa app
  contract (`/health`, `/generate_script`, `/generate_character_bible`,
  `/breakdown_scenes`).

### Framer handoff
- **`docs/framer-landing.md`** — paano i-embed o muling buuin ang landing page sa
  Framer (login-walled ang workspace link, kaya handoff ang paraan).

## Paano gamitin sa tablet (browser)

1. Sa server (Server-2), patakbuhin ang app:
   ```
   npm run build
   NODE_ENV=production node server.ts
   ```
2. Bigyan ng pampublikong URL (opsyonal, para sa malayong tablet):
   ```
   powershell -ExecutionPolicy Bypass -File scripts\tunnel.ps1 -Port 3000
   ```
3. Buksan sa browser ng tablet:
   - `https://<iyong-URL>/landing`
   - `https://<iyong-URL>/dashboard`
4. Sa dashboard, ilagay ang `APP_AUTH_TOKEN` at i-save.

## Paano i-install ang APK sa phone

1. Buksan sa phone: `https://<iyong-URL>/android`
2. I-download ang `movie-creator.apk`.
3. Payagan ang "Install unknown apps" para sa browser, tapos i-install.
4. Buksan ang app at ilagay ang server URL + `APP_AUTH_TOKEN`.

## Seguridad (basahin bago ibukas sa internet)

- Ang tunnel ay naglalagay sa server sa internet. **I-set ang `APP_AUTH_TOKEN`**
  sa `.env` bago ito gawin — kung wala nito, bukas ang `/api` (kasama ang bayad
  na AI endpoints) sa kahit sino.
- Ang `/landing`, `/dashboard`, at `/android` ay public; ang `/api` ay hindi.
- Ang `APP_AUTH_TOKEN` at `KAGGLE_PILOT_URL` ay nasa `.env` lang — hindi kailanman
  sa git o sa release notes na ito.

## Ano ang hindi kasama

- **Hindi** binago ang dataset, ang Firebase config, o ang auth.
- **Hindi** kasama ang anumang `.env`, token, o IP address.

## Pag-verify

- Buong test suite: **360/360 pass**; lint: 0 error.
- Ang APK ay pirmado at ang tablet flags (`supports-screens`,
  `resizeableActivity`) ay nakumpirma sa manifest ng APK mismo.
