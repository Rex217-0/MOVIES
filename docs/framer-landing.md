# Framer: landing page at dashboard

Ang Movie Creator ay may sariling public na landing page at live dashboard, na
nagseserb mula sa server mismo:

- `/landing`  — ang front door (hero, features, steps, tech stack)
- `/dashboard` — live status: ComfyUI, mesh workers, jobs (totoong API data)
- `/android`  — ang APK download para sa phone at tablet

## Bakit hindi direktang na-publish sa Framer

Ang workspace link (`https://framer.com/join/Rex-s-Workspace--02C63FaKZmalVJkjuRRq`)
ay may **login wall** (Google o work email). Ang Framer publish ay nangangailangan
ng pag-login sa account mo — hindi ito kayang gawin ng AI agent nang hindi
nagpapanggap bilang ikaw, at hindi rin maganda iyon. Kaya ang ginawa: isang
**handoff**, hindi isang pekeng "published" na claim.

## Paano ilagay sa Framer (2 paraan)

### A. I-embed ang live na app (pinakamabilis, laging up to date)

1. Mag-login sa Framer → buksan ang workspace.
2. Gumawa ng page (hal. "Landing").
3. Magdagdag ng **Embed** component (`Insert → Embed`).
4. Ilagay ang URL ng server mo, hal.:

   ```
   https://SERVER-2-ADDRESS/landing
   ```

   Sa Embed settings, i-set ang height (hal. 2200px) para buong page ang makita.
5. Publish.

Bentahe: isang source of truth. Kapag nag-update ang `/landing`, automatic ding
nagbabago ang Framer page. Walang doble-dobleng content.

### B. Kopyahin ang layout (kung gusto mong i-edit sa Framer)

Ang `/landing` ay isang self-contained na HTML/CSS file
(`public/landing.html`). Ang layout nito ay direktang isasalin sa Framer:

- **Header**: logo (gradient square) + nav (`Dashboard`, `Android app`, `API`)
- **Hero**: kicker pill, H1 na may gradient na salita, sub-headline, 2 CTA button
  (primary + ghost)
- **Features**: 6-card grid (Feature Film Factory, Direk, Free-first video,
  Tagalog TTS, GPU mesh, Android remote)
- **Steps**: numbered na listahan (4 na hakbang)
- **Tech stack**: tag pills
- **Footer**

Palette (para tugma sa app):

| Token   | Halaga    |
|---------|-----------|
| bg      | `#0a0d16` |
| panel   | `#121826` |
| line    | `#232c40` |
| text    | `#e8eef7` |
| dim     | `#93a1b5` |
| brand   | `#5b8cff` |
| brand 2 | `#a855f7` |

## Ang dashboard ay HINDI dapat i-duplicate sa Framer

Ang `/dashboard` ay nagbabasa ng **live** na API (`/api/direk/status`,
`/api/direk/video/backend`, `/api/direk/system-map`, `/api/direk/workers`,
`/api/direk/jobs`). Kung kokopyahin ito sa Framer bilang static, magiging
**pekeng data** agad ito. I-embed na lang (paraan A) o i-link:

```
https://SERVER-2-ADDRESS/dashboard
```

## Paalala sa deploy

- Ang mga route na `/landing` at `/dashboard` ay **public** (walang token), tulad
  ng `/android`, para bumukas bago pa magkaroon ng token.
- Ang `/dashboard` ay humihingi ng `APP_AUTH_TOKEN` sa browser at hindi
  nagpapakita ng numero kung 401 — tapat, hindi hula.
- Huwag ilagay ang IP o token sa anumang committed na file; nasa `.env` lang.
