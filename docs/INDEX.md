# Index ng documentation

Saan mahahanap ang ano. Bawat dokumento ay may isang tanong na sinasagot —
walang duplicate sa listahan.

**Saan ang build ng app?** → [§ Build outputs](#build-outputs), sa ibaba.

---

## Kung bago ka pa lang

| Dokumento | Sinasagot |
|---|---|
| [`../README.md`](../README.md) | Ano ang app, ano ang gumagana, paano patakbuhin |
| [`BUILD.md`](BUILD.md) | Paano ito binuo — stack, numbers, deploy sa Server-2 |
| [`DEPLOY.md`](DEPLOY.md) | Paano i-deploy ang server |

---

## Kalagayan at katotohanan ng sistema

| Dokumento | Sinasagot |
|---|---|
| [`AUDIT.md`](AUDIT.md) | Ano ang **aktwal** na tumakbo — tests, build, render, 2026-11-22 |
| [`FULL-AUDIT.md`](FULL-AUDIT.md) | Buong audit laban sa `feat/blockers-a-i` @ `96739ae` |
| [`no-cost-audit.md`](no-cost-audit.md) | Aling output path ang libre, alin ang bayad |
| [`CLOUD_PROGRESS.md`](CLOUD_PROGRESS.md) | Ano ang tapos sa Firebase/Google Cloud |

---

## Kung saan tumatakbo ang trabaho

| Dokumento | Sinasagot |
|---|---|
| [`working-area.md`](working-area.md) | **Sino ang gumagawa ng ano** — Render vs Server-2 vs Colab, env vars, ports |
| [`worker-mesh.md`](worker-mesh.md) | Ang worker registry at placement logic |
| [`public-access.md`](public-access.md) | Paano maabot ang server mula sa labas |
| [`kaggle-pilot.md`](kaggle-pilot.md) | Ang Kaggle worker at ang `pilotService` contract |

---

## LoRA training

| Dokumento | Sinasagot |
|---|---|
| [`lora-colab.md`](lora-colab.md) | Ang **protocol** ng Colab training — `job.json`, `status.json`, `manifest.json` |
| [`lora-trainer-readback.md`](lora-trainer-readback.md) | Paano binabasa pabalik ang resulta ng trainer |
| [`colab-check.md`](colab-check.md) | Pagsusuri ng isang hand-built notebook laban sa protocol (2026-11-22) |
| [`datasets.md`](datasets.md) | Ang mga dataset |

**Ang tamang notebook ay `../scripts/colab_lora_train.ipynb`.** Nagsusulat iyon ng
`status.json` at `manifest.json` na may sha256 — ang hinihintay ng app.
Ang `lora_arsenal_train.ipynb` at `direk_kaggle_gear253b.ipynb` ay hiwalay na variants.

---

## Android

| Dokumento | Sinasagot |
|---|---|
| [`android-app.md`](android-app.md) | Ang installable APK — remote lang ang phone |
| [`android-remote-v2-plan.md`](android-remote-v2-plan.md) | **Proposal pa lang** — wala pang built |

---

## Setup ng cloud at integrations

| Dokumento | Sinasagot |
|---|---|
| [`firebase-setup.md`](firebase-setup.md) | Firebase |
| [`google-drive-oauth-setup.md`](google-drive-oauth-setup.md) | Google Drive OAuth |
| [`framer-landing.md`](framer-landing.md) | Ang Framer landing page |

---

## Agent handoff

| Dokumento | Sinasagot |
|---|---|
| [`manus-handoff.md`](manus-handoff.md) | Ano ang **aktwal** na env vars at endpoints para sa external agent |
| [`manus-orders.md`](manus-orders.md) | Ang utos na ipapasa kay Manus |
| [`release-v1.0.1.md`](release-v1.0.1.md) | Ang v1.0.1 release |

---

## Build outputs

Tatlong bagay ang "build" sa repo na ito. Iba-iba ang lokasyon.

| Artifact | Utos | Saan napupunta | Naka-commit? |
|---|---|---|---|
| **Web UI** | `npm run build` | `dist/` (376 kB JS + 43 kB CSS) | ❌ gitignored |
| **APK** | `bash android/build.sh` | `android/movie-creator.apk` (153 kB) | ✅ **oo, sinadya** |
| **Server** | wala — `node server.ts` | — | — |

### Bakit gitignored ang `dist/`

Ang Docker build mismo ang gumagawa nito (`Dockerfile`: `npm run build && npm prune --omit=dev`).
Kaya walang stale na UI na naka-commit. Ang Render ay `runtime: docker`,
`plan: free`, `region: singapore` (`render.yaml`).

**Patunay na tama ang build:** ang live na `index-8Qw21d_E.js` ay may
sha256 `5c2bf93b…` — kapareho ng lokal na build, byte-for-byte.

### Bakit NAKA-COMMIT ang APK

Para gumana ang `/android` download sa **kahit anong** deploy, kahit walang
Android SDK sa makina. Sabi ng `BUILD.md:269` mismo: *"committed on purpose so
`/android` serves a download on any deploy."*

⚠️ **Dapat tugma ang `.dockerignore`.** Noong 2026-11-22, naka-list ang
`android/movie-creator.apk` sa `.dockerignore`, kaya **404** ang download sa live
kahit naka-commit ang file. Inalis ang linyang iyon (commit `43c156b`).
**Kung babaguhin mo ang `.dockerignore`, i-check na hindi mo naalis ang APK.**

### Server-2 (Windows 11)

Walang Git doon. Manual o zip ang deploy — **hindi** `git pull`.

---

## Ang pinakamabilis na paraan para mag-verify

```bash
npm run lint      # tsc --noEmit
npm test          # 402 tests
npm run build     # vite → dist/
```

Live: `curl https://movies-627p.onrender.com/healthz` → `{"ok":true,"uptime_s":N}`
