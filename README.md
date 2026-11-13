# Pilot's VIP Battle Room

A tactical neural-link cockpit: a React + TypeScript front end with an Express
backend that streams "pilot thoughts" over Server-Sent Events (SSE) and answers
commander directives with Gemini.

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

## Earlier work: the "Direk" movie-director app

Before this cockpit, the repository held a different app: **Direk**, a Filipino
AI movie-director assistant (Python, OpenAI-compatible `POST /v1/chat/completions`,
with a genre gate and a Netflix-style reference catalog). It was built from
`notebooks/direk_kaggle_prototype.ipynb` and lives in git history at commit
`e4acafb`.

That Python service and this Node/React cockpit are two different apps. This
branch does not restore Direk, because that is an architecture decision, not a
bug fix. If the movie-director assistant is the real goal, say so and it can be
restored or merged as a separate service.
