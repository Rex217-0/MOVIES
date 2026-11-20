# Deploying the Movie Creator server

The APK is the app UI. It does not render video on the phone. Rendering runs on
this Node server, and the app reaches it through the **Server Setup** screen
(the value is stored as `window.__MOVIE_CREATOR_API_BASE__`). Until a server
exists, a fresh install can browse but cannot render.

## What the server needs

| Variable | Required | Purpose |
| --- | --- | --- |
| `APP_AUTH_TOKEN` | yes in production | Protects every `/api` route. The server refuses to start without it when `NODE_ENV=production`. |
| `GEMINI_API_KEY` | no | Enables Gemini script writing. Without it the free motion engine still renders a real MP4. |
| `PREFERRED_RENDER_ENGINE` | no | `hybrid` (default), `motion` (free, still image + ffmpeg), `fal` (paid cloud). |
| `PORT` | no | Defaults to 3000. |

Generate a token with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## Docker (any host)

```bash
APP_AUTH_TOKEN=$(openssl rand -hex 32) docker compose up -d --build
curl http://localhost:3000/healthz     # {"ok":true,...}
```

## Render

1. Push this repository, then **New > Blueprint** and pick the repo.
2. `render.yaml` is detected. Set `APP_AUTH_TOKEN` (and `GEMINI_API_KEY` if you have one) when prompted.
3. Wait for the health check on `/healthz` to pass. Copy the service URL.

## Fly.io

```bash
fly launch --no-deploy          # accepts fly.toml
fly secrets set APP_AUTH_TOKEN=<your token>
fly deploy
```

The config uses 1 GB of memory. 512 MB is not enough for ffmpeg renders.

## Connecting the APK

Open the app, go to **Server Setup**, and paste the URL (no trailing slash),
for example `https://movie-creator.onrender.com`. Then send the same
`APP_AUTH_TOKEN` when the app asks for it.

CORS already allows the Android shell origin `https://app.local`, so no extra
configuration is needed for the APK. A browser on another origin must be added
to `ALLOWED_ORIGINS` (comma separated).

## Verifying a deployment

```bash
curl https://<your-host>/healthz
curl -X POST https://<your-host>/api/pilot/video/generate \
  -H "Authorization: Bearer $APP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"ocean waves at sunset","aspect_ratio":"16:9","duration":5}' \
  -o out.json -w "%{http_code}\n"
```

A `200` returns `item.url` as a base64 `data:video/mp4`. A `401` means the token
is wrong; a `429` means the rate limit or the daily AI quota was hit.
