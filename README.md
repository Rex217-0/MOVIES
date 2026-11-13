# MOVIE CREATOR

One app, two suites. A React + TypeScript front end with an Express backend:

- **Director's Chair (Direk)** — a Filipino AI movie director. It grounds genre
  advice in a bundled catalog, gates on missing essentials (haba at mood), and
  walks a film from IDEYA → SCRIPT → KARAKTER → SHOT LIST → VISUAL → EDIT → PUBLISH.
- **VIP Battle Room (Pilot)** — the tactical cockpit that streams "pilot
  thoughts" over Server-Sent Events (SSE) and answers commander directives.

Both share the same server, the same honest-availability rules, and the same
`GEMINI_API_KEY`.

## Datasets

Grounding data lives in `data/` and is read at startup — nothing is fetched from
the network:

| File | Rows | Used by |
| --- | --- | --- |
| `netflix_titles.csv` | 8,809 | reference catalog |
| `imdb_movies.csv` | 1,000 | reference catalog |
| `filipino_movies.csv` | 469 | reference catalog |
| `tmdb_movies.csv` + `tmdb_directors.csv` | 1,465 | per-title benchmarks |
| `boxoffice/*.csv` | 9 files | market intel (genres, distributors, methods, ratings) |

The reference catalog searches **10,278 titles** across three sources.

## What actually works

The app only reports success when a model really produced the output. There are
no hardcoded fallbacks that pretend to be AI results.

| Feature | Model | Free tier? | Notes |
| --- | --- | --- | --- |
| Text directives (`/api/pilot/command`) | `gemini-2.5-flash` | Yes | Real Gemini output |
| Image generation / editing | `gemini-2.5-flash-image` | No | Returns `503 AI_UNAVAILABLE` unless billing is enabled |
| Video generation | `gemini-omni-1.2-flash` | No | Returns `503 AI_UNAVAILABLE` unless billing is enabled |

When the Gemini key is missing or a call fails, AI endpoints answer with HTTP
`503` and a body like:

```json
{
  "error": "The Gemini API key is not configured. Set GEMINI_API_KEY (free tier) to enable directive execution.",
  "code": "AI_UNAVAILABLE",
  "model": "gemini-2.5-flash",
  "detail": "Set GEMINI_API_KEY (free tier) to enable directive execution."
}
```

`GET /api/health` reports the same picture up front:

```json
{
  "ok": false,
  "gemini_key_configured": false,
  "text":  { "model": "gemini-2.5-flash",      "available": false, "free_tier": true  },
  "image": { "model": "gemini-2.5-flash-image", "available": false, "free_tier": false },
  "video": { "model": "gemini-omni-1.2-flash",  "available": false, "free_tier": false }
}
```

## Setup

```bash
npm install
cp .env.example .env      # then fill in the values
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | For AI features | Free-tier key from https://aistudio.google.com/apikey |
| `APP_AUTH_TOKEN` | In production | Bearer token that protects every `/api` route |
| `PORT` | No | Defaults to `3000` |

## Run

```bash
npm run dev     # tsx server.ts - dev server
npm run build   # vite build - front end bundle into dist/
npm start       # node server.ts - production server
npm test        # node --import tsx --test
npm run lint    # tsc --noEmit
```

Open http://localhost:3000.

## Authentication

Every `/api` route requires a bearer token when `APP_AUTH_TOKEN` is set. In
production (`NODE_ENV=production`) the server refuses to start if the token is
missing, so AI endpoints are never exposed unprotected.

The browser has no login screen. Pass the token once as a query parameter and it
is stored in `sessionStorage`:

```
http://localhost:3000/?token=YOUR_APP_AUTH_TOKEN
```

The SSE stream (`/api/pilot/thought-stream`) also accepts `?token=` because
`EventSource` cannot send headers.

## Security notes

- Auth is fail-closed in production: no token, no server.
- AI error messages never expose the API key; only the upstream error text.
- The gallery never invents a `url` for placeholder items. Preset items keep an
  empty `url` and `model: "placeholder"`, so the UI shows them as unavailable.

## The Direk endpoints

| Endpoint | Model? | Purpose |
| --- | --- | --- |
| `GET /api/direk/status` | No | Model, pipeline, genres, sources, row counts |
| `GET /api/direk/reference?genre=&n=` | No | Catalog titles for a genre |
| `GET /api/direk/market` | No | Real box-office stats |
| `GET /api/direk/benchmark?title=` | No | Per-title budget/revenue/votes (TMDB) |
| `POST /api/direk/chat` | Yes | The director. Gated before the model runs |

The gate is deterministic: with no key, an incomplete request (missing haba or
mood) still gets a real question back, and a complete request returns
`503 AI_UNAVAILABLE` rather than fabricated output.

## History

Direk started as a Python/Kaggle prototype (`notebooks/direk_kaggle_prototype.ipynb`,
built into a service at commit `e4acafb`). It has since been ported to TypeScript
under `src/direk/` and merged into this app, so the director and the cockpit ship
together.
