# v2 plan — a downloadable Android remote over a distributed GPU mesh

Status: proposal. Nothing here is built yet. This document records what the
current code actually does, what will break when the app becomes an installable
Android remote, and the order to fix it.

The goal (founder's words): an installable app on an Android phone that acts as a
**thin remote**. The heavy work runs on GPUs of other machines that are connected
and support the app, and the phone shows a real output — a real movie, never a
placeholder.

## 1. What the code does today (verified)

- One **Node/Express monolith** (`server.ts`, ~2000 lines) serves the built React
  UI and every `/api` route from one process. One process, one port (default
  `3000`, bound to `0.0.0.0`).
- Auth is a **single shared bearer token** (`APP_AUTH_TOKEN`), sent as a header,
  or as `?token=` for the SSE thought stream. There are no user accounts; the
  browser keeps the token in `sessionStorage` (`src/api.ts`).
- State is **in-process memory plus a local SQLite file** (`factory.db`, via
  `node:sqlite`), scoped to one hard-coded vault `ORG_ID = 'LJRgroupORG'`.
  Firestore exists but only as a schema-aligned mirror; the engine reads SQLite.
- **Jobs run in the background** and are polled: `POST /api/direk/movie` answers
  `202` with an id, then progress comes over the SSE `thought-stream`. Nothing is
  durable across a restart.
- The **T3 "cloud offload" is a placeholder**. `route_to_cloud()` always returns
  `ok: false`; it never calls `CLOUD_T3_URL`. So "use other GPUs" is a stub, not a
  working feature.
- Video renders on **one** local ComfyUI box. There is no queue, no worker
  registry, and no notion of more than one GPU.
- There is **no PWA**: no web manifest, no service worker, no offline shell.
- No Dockerfile, no CI, no deploy config. There is **no CORS, rate limiting or
  Helmet**; `/api` is one middleware for the whole app.

## 2. What breaks when this becomes an Android remote (ranked)

Each item says the symptom, then the real fix.

### Blocker A — there is no compute pool, and the one that exists is a stub
The core promise ("heavy tasks use the GPUs of connected machines") is not built.
`route_to_cloud()` is a no-op, and a render targets a single `COMFYUI_URL`.
**Fix:** a real worker protocol. A job queue, a worker registry (each worker
advertises capabilities: GPU, VRAM, models, ComfyUI/LoRA/TTS), heartbeats, and a
scheduler that places each scene on a free worker. This is the biggest piece of v2
and should come first, because everything else assumes it.

### Blocker B — the free tier dies under multi-user load
One shared `GEMINI_API_KEY` with a daily free-tier cap, and one shared
`APP_AUTH_TOKEN`. More than one person, or one big film, exhausts the quota and
everyone sees 429s. **Fix:** per-user keys or a paid key with a budget, per-user
accounts (replace the single token), and quota accounting that fails honestly.

### Blocker C — the movie output is a silent download, not a phone-friendly file
The stitched film is served from `GET /renders/:name` with `res.sendFile` and
**no `Content-Disposition`**, so a phone shows a random tab instead of saving the
film. A long film is also large. **Fix:** an explicit download endpoint with a
proper filename, and a share/save flow for Android.

### Blocker D — long renders do not survive an app switch
Android suspends background tabs and kills sockets. A movie render takes minutes
and depends on a live SSE connection; if the phone sleeps, the connection drops
and the UI loses progress (the server keeps running, but the app cannot tell).
**Fix:** make progress **resumable** — persist job state (it is already in
SQLite) and let the app re-attach on resume by polling job state, not by holding
one fragile stream open.

### Blocker E — the phone cannot reach the server, and the server is not safe to expose
The server binds `0.0.0.0` and accepts `?token=` in the URL, which leaks into
logs and browser history. There is no TLS, no rate limiting and no CORS. Over a
mobile network the phone needs a **public HTTPS URL**; exposing the raw Express
port is not safe. **Fix:** put the API behind HTTPS with a real reverse proxy,
move the stream token out of the URL, add rate limiting and CORS, and keep the
ComfyUI/worker links on a private network (VPN or tunnel) — never public.

### High F — the distribution channel is not ready for an APK
Firebase Hosting serves the **web app**, not an APK. Installing a native app on
Android means Play Store review (if published) or sideloading (a manual,
"unknown sources" flow). The web app must first become a **PWA** (manifest +
service worker + icons) so it can be "installed" and used offline-first. A
wrapped APK (Bubblewrap/Capacitor) is a later step. **Fix:** add the PWA layer,
then decide native vs. PWA-install.

### Medium G — the phone itself can be a weak node
A phone can contribute CPU and a little GPU (NNAPI) but cannot run ComfyUI/SDXL.
So the phone must be a **remote first**, and a worker only as an optional,
clearly-labelled low-tier contributor. **Fix:** keep the phone as a client; do not
promise phone-side heavy rendering.

### Medium H — "other GPUs" must mean *other people's machines*
The design ("GPUs of connected machines that support the app") is a **volunteer
compute** model. That means trust and abuse are part of the design: a node could
lie about its output, read the prompts, or be attacked by a malicious job. **Fix:**
signed jobs, output verification (duration/resolution/ffprobe checks, hashes),
worker sandboxing, and a consent/opt-in story for contributors.

### Medium I — durability and the free-tier dependence
Jobs live in memory; a restart loses a running batch. And "free" today rests on
Google's free tier and one volunteer GPU. At scale the free tier is not a
business model. **Fix:** persist every job transition, and make the worker pool
the primary capacity (not one box), with honest limits.

### Lower — the small stuff
No PWA icons or screenshots; no CI; the frontend is a single heavy bundle; no
observability (metrics, structured logs) to see worker health.

## 3. Proposed build order

1. **Worker protocol + scheduler** (Blocker A). Define a worker API (register,
   heartbeat, pull job, post result), a durable job queue, and placement by
   capability. Make `route_to_cloud` real; retire the placeholder.
2. **Durable job state + resumable progress** (Blocker D, I). Every transition in
   SQLite; the app re-attaches on resume.
3. **Accounts + quota + keys** (Blocker B). Replace the single token; per-user
   keys or a budgeted key; honest 429s.
4. **HTTPS edge + hardening** (Blocker E). Reverse proxy, TLS, rate limit, CORS,
   token out of the URL.
5. **PWA layer** (High F). Manifest, service worker, icons, offline shell; then a
   TWA/APK wrapper.
6. **Movie download + share** (Blocker C). A named download endpoint and an
   Android save/share flow.
7. **Trust for volunteer nodes** (Medium H). Signed jobs, output verification,
   sandboxing, contributor consent.
8. **Observability + CI** (Lower).

## 4. Honest limits to state up front

- **Phone as remote only.** The phone shows and controls; it does not render
  movies itself.
- **Volunteer GPU supply is the real constraint.** "Other GPUs" only exist if
  people run the worker. The app cannot conjure capacity.
- **Free tier is not unlimited.** It is fine for one person experimenting, not
  for many users at once.
- **A movie takes minutes, not seconds**, even on a good GPU. The UX must expect
  that and survive the phone sleeping.

_This plan was written by an AI agent (OpenHands) on behalf of Rex._
