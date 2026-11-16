# Pampublikong access: tablet at phone kahit malayo

Kapag LAN lang, kailangang parehong Wi-Fi ang tablet/phone at ang server. Kapag
gusto mong maabot ang app mula sa kahit anong network (mobile data, ibang
bahay), bigyan ito ng pampublikong HTTPS URL gamit ang **Cloudflare quick
tunnel**. Walang account, walang bayad.

## Isang utos

Windows (Server-2), PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\tunnel.ps1 -Port 3000
```

Linux/macOS:

```bash
PORT=3000 bash scripts/tunnel.sh
```

Ipi-print nito ang URL, halimbawa:

```
PUBLIC URL : https://vinyl-questionnaire-seeking-adjustment.trycloudflare.com
Landing    : https://....trycloudflare.com/landing
Dashboard  : https://....trycloudflare.com/dashboard
Android APK: https://....trycloudflare.com/android
```

Buksan ang mga ito sa tablet at phone — gagana kahit mobile data. I-download ang
APK mula sa `/android` sa phone, at ilagay sa app ang **pampublikong URL** (hindi
ang LAN IP) bilang server address.

## Bago magbukas sa internet (mahalaga)

Ang tunnel ay naglalagay sa server sa internet. Kaya:

1. **I-set ang `APP_AUTH_TOKEN`** sa `.env`. Kung wala nito, bukas ang lahat ng
   `/api` (kasama ang bayad na AI endpoints) sa kahit sino.
2. Ilagay sa `APP_AUTH_TOKEN` ang isang mahaba, random na halaga. Hindi ito
   inilalagay sa git — nasa `.env` lang.
3. Ang `/landing`, `/dashboard`, at `/android` ay public; ang `/api` ay hindi.

## Ano ang hindi kaya ng quick tunnel

- **Hindi permanente ang URL.** Bagong URL sa bawat start. Kung kailangan ng
  permanenteng pangalan (hal. `movies.rex.ph`), gumawa ng **named tunnel** sa
  Cloudflare Zero Trust dashboard at i-map sa isang hostname.
- **Kailangang patuloy na tumatakbo** ang `cloudflared` at ang server. Kapag
  isinara ang terminal o napatay ang PC, nawawala ang access.
- Ang account-less na tunnel ay walang uptime guarantee (sabi mismo ng
  Cloudflare). Sapat ito para sa test at demo; para sa produksyon, named tunnel.

## Kumbinasyon sa Kaggle worker

Dalawang magkaibang bagay ang dalawang tunnel:

| Tunnel | Ano ang inilalabas | Para saan |
|---|---|---|
| `scripts/tunnel.ps1` | ang **app** (Server-2:3000) | maabot ng tablet/phone |
| Kaggle cell 6 | ang **Kaggle worker** (:8000) | `KAGGLE_PILOT_URL` ng app |

Puwede silang sabay. Ang app ay may sariling public URL, at ang app ay may
`KAGGLE_PILOT_URL` na nakaturo sa Kaggle tunnel.

## Napatunayan

Sinubukan nang totoo sa isang Linux na sandbox: `bash scripts/tunnel.sh` ay
nagbukas ng `https://....trycloudflare.com` at ang pampublikong URL ay sumagot
ng **HTTP 200** sa `/landing` (7089 bytes) at `/dashboard`. Ang script na ito ang
gumamit ng parehong paraan.
