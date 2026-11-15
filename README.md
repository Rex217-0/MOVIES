# MOVIE CREATOR

**Moviecity** · proudly powered and operated by the **LJR Group**

One app, two suites. A React + TypeScript front end with an Express backend:

- **Director's Chair (Movie Robo)** — the official AI Movie Creator of Moviecity.
  A Filipino AI movie director that grounds genre
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
| `movie_statistics.csv` | 4,380 | reference catalog + ratings/budgets |
| `tmdb_movies.csv` + `tmdb_directors.csv` | 1,465 | per-title benchmarks |
| `boxoffice/*.csv` | 9 files | market intel (genres, distributors, methods, ratings) |

The reference catalog searches **14,658 titles** across four sources. Matches
are drawn round-robin across sources, so the large Netflix set cannot crowd out
the smaller ones (and the statistics rows with ratings and budgets do surface).

## What actually works

The app only reports success when a model really produced the output. There are
no hardcoded fallbacks that pretend to be AI results.

| Feature | Model | Free tier? | Notes |
| --- | --- | --- | --- |
| Text directives (`/api/pilot/command`) | `gemini-2.5-flash` | Yes | Real Gemini output |
| Image generation | **ComfyUI (local)** | **Yes** | Free on your own GPU — the preferred backend |
| Image generation / editing | `gemini-2.5-flash-image` | No | Paid fallback; `503 AI_UNAVAILABLE` without billing |
| Video generation | `gemini-omni-1.2-flash` | No | Returns `503 AI_UNAVAILABLE` unless billing is enabled |

### ComfyUI (free local image generation)

If a ComfyUI server is running, it becomes the image backend, so image
generation and LoRA sample images cost nothing. Point the app at it:

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMFYUI_URL` | `http://127.0.0.1:8188` | Where ComfyUI listens (a Tailscale IP works too) |
| `COMFYUI_CHECKPOINT` | `sd_xl_base_1.0.safetensors` | Checkpoint for the built-in workflow |
| `COMFYUI_WORKFLOW` | (built-in SDXL graph) | Path to your own workflow JSON (API format) with `__PROMPT__`, `__NEGATIVE__`, `__SEED__`, `__WIDTH__`, `__HEIGHT__`, `__CHECKPOINT__` placeholders |
| `COMFYUI_VIDEO_WORKFLOW` | (unset) | AnimateDiff/SVD workflow (API format) for local video |
| `COMFYUI_LORAS_DIR` | `<ComfyUI>/models/loras` | Where trained LoRAs are published |
| `COMFYUI_TIMEOUT_MS` | `180000` | Per-image timeout |
| `COMFYUI_DISABLE` | (unset) | Set to `1` to ignore ComfyUI and use Gemini |

The image backend order is ComfyUI → Gemini (if billed) → Pollinations (free,
no key) → unavailable. So when ComfyUI is not reachable, **images still work**
through the free Pollinations backend. Video has no free fallback: it returns an
honest `503` rather than a fake clip. `GET /api/direk/status` reports the active
`image_backend`.

Every hosted image (Pollinations, Gemini) is re-encoded to a real PNG before it
is stored or zipped: Pollinations answers with a JPEG whatever the URL asks for,
and a JPEG saved under a `.png` name is not a usable LoRA training image.

### Task routing (T1/T2/T3)

Server-2 has one AMD GPU, so every job is classified before it is dispatched and
the placement is reported in the UI and in the thought stream:

| Tier | Work | Runs on |
| --- | --- | --- |
| **T1** | chat, text generation, webhooks, the LoRA text half | local (CPU) |
| **T2** | image generation (SDXL/Pollinations), Piper TTS, small LoRA training | local GPU |
| **T3** | video rendering (AnimateDiff/SVD), large TTS (Qwen3/Fish), massive LoRA training | cloud free tier |

`GET /api/direk/routing` returns the full table. T3 work is offloaded through
`route_to_cloud()`; set `CLOUD_T3_URL` to point it at a real worker. Set
`T3_ALLOW_LOCAL=0` to make a T3 job answer with an offload notice instead of
touching the local GPU (the default is to fall back locally when no cloud worker
is configured yet).

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

### Running on Windows 11 (Server-2)

The target host is Windows 11 (Ryzen 7 7800X3D, 64 GB, Radeon RX 9070, Ollama on
`http://127.0.0.1:11434`). The app runs there unchanged; the platform differences
it already handles are:

- **Ollama** — `LOCAL_OLLAMA_URL` defaults to `http://127.0.0.1:11434`, so a local
  Ollama is the T1 Pilot fallback and the free text backend with no key. `ollama
  pull qwen2.5:7b` once and the factory can write a screenplay offline.
- **Python** — `TTS_PYTHON` / `KOHYA_PYTHON` default to `python` on Windows and
  `python3` on POSIX (`src/direk/platform.ts`). Override either to point at a
  specific interpreter or virtualenv.
- **Paths in ffmpeg** — filtergraph values escape `:` and `\` (`filterPath`), and
  the concat demuxer gets forward-slash paths (`concatListPath`), because
  `C:\...\clip.mp4` otherwise fails with "Impossible to open".
- **Signals** — the trainer stops child processes with `SIGTERM` on Windows
  instead of `SIGKILL`.

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

## Narration (the film's voice)

A film's narration comes from the first voice that answers, in this order:

1. **Fish Audio** — best Tagalog, and can clone a voice. Needs `FISH_AUDIO_API_KEY`.
2. **Offline Tagalog voice** (Meta MMS VITS) — free, CPU, real Tagalog, no quota.
   On by default when `scripts/tagalog_tts.py` is present **and** the interpreter in
   `TTS_PYTHON` has `transformers`, `torch` and `soundfile` installed; without them
   the voice is skipped and the reason is logged.
3. **Gemini cloud voice** — good quality, but the free tier caps it per day.
4. **Piper** — an English backup voice (there is no Tagalog Piper voice upstream).
   Point `TTS_PIPER_VOICE` at a `.onnx` file.

When none of them answers, the shot carries the line as a burned-in **caption**
instead of failing the render. Set `TTS_ORDER=fish,piper` to force a strict
Fish → Piper chain (anything not listed is skipped), or `TTS_DISABLE=1` to turn
the cloud voice off. `GET /api/direk/movie/status` reports `narration_order`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `FISH_AUDIO_API_KEY` | (unset) | Enables the Fish Audio Tagalog voice (only this is required) |
| `FISH_AUDIO_REFERENCE_ID` | (unset) | Optional cloned voice id; without it Fish uses its default voice |
| `FISH_AUDIO_MODEL` | provider default | Fish Audio model id |
| `TTS_ORDER` | `fish,tagalog,gemini,piper` | Comma-separated voice priority |
| `TTS_PIPER_BIN` | `piper` | Piper executable |
| `TTS_PIPER_VOICE` | (unset) | Piper `.onnx` voice file |
| `TTS_TAGALOG_MODEL` | `tagalog` | `tagalog` \| `filipino`, or a full model id |
| `TTS_PYTHON` | `python3` (`python` on Windows) | Interpreter with `transformers`, `torch`, `soundfile` |

## Staging Vault (render review)

The **Staging Vault** tab lists every render the app really produced, read from
`GET /api/direk/assets`. Each video, image and audio asset starts as `pending`
and carries two actions:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/direk/assets` | Every asset, newest first, with its review status |
| `POST /api/direk/assets/review` | `{ id, action: "approve" \| "reject" \| "pending" }` |
| `GET /api/direk/assets/:name/download` | Download one asset |

The decision is written back to the asset's sidecar (`<name>.asset.json`), so it
survives a restart. An asset saved before the vault existed counts as `pending`.

## LoRA training sets

Direk turns a brief into a LoRA training set for image or video models. The
**LoRA Studio** tab (or the API) produces the text half that is usually wrong:
one caption per sample, a kohya_ss config, and dataset metadata.

```
POST /api/direk/lora/plan      preview the plan + file list (no model needed)
POST /api/direk/lora/dataset   download the whole set as a .zip
```

The plan is deterministic and grounded: it draws visual references from the
catalog, sizes the shot count from the runtime, and folds the character bible
into every caption so the look stays consistent.

```
dataset/direk_ang_huling_tala_001.txt   direk_ang_huling_tala, sariwang mukha, ...
dataset/README.md
kohya_config.toml
dataset_info.json
```

Each caption leads with the trigger token, then the character's fixed look, then
the shot description — the order LoRA trainers expect. The trigger must match
`^[a-z][a-z0-9_]{2,39}$`; the API rejects anything else.

## First run: the SETUP panel

The app needs to know where ComfyUI and kohya are. Open **SETUP** in the header,
type the paths, press SAVE. The app writes `direk.config.json` and uses it from
then on — no environment variables to edit, and the paths survive a restart.

The panel also shows a live check: whether ComfyUI is reachable, which
checkpoints and LoRAs it can see, and whether training is ready. Environment
variables still work and always win over the file.

| Setting | Meaning |
| --- | --- |
| ComfyUI URL | Where ComfyUI listens (`http://127.0.0.1:8188`, or a LAN IP) |
| Checkpoint | Model for the built-in workflow |
| LoRAs folder | ComfyUI's `models/loras`; trained LoRAs are copied here |
| kohya folder | kohya_ss / sd-scripts checkout (has `train_network.py`) |
| Base model | Base model path or HuggingFace id for training |
| Python | Interpreter for training |
| Output folder | Where runs and checkpoints are written |

## Using a trained LoRA

After a training run finishes, its `.safetensors` is copied into the LoRAs
folder automatically. From then on it appears in the **LoRA Studio** and
**Image Matrix** pickers; choose it (and a strength) and the next images are
generated in that style. The workflow gains a `LoraLoader` node wired between
the checkpoint and the sampler.

## The AI text model (free)

Direk chat and the Battle Room directives need a text model. There are two free
ways, and the app picks one automatically:

- **Gemini** — set `GEMINI_API_KEY` (the free tier is enough). Get a key at
  https://aistudio.google.com/apikey. This is the preferred path.
- **Ollama** — fully local and offline, no account and no key. Install Ollama
  from https://ollama.com, then `ollama pull qwen2.5:7b`. Used automatically
  when no Gemini key is set.

With neither, the AI endpoints return an honest `503 AI_UNAVAILABLE` — nothing
is fabricated. `GET /api/health` reports which backend is live. Both paths and
their settings are shown in the app's SETUP panel.

Image and video generation are not on the Gemini free tier (they need billing),
so the app leaves them unavailable and points image work at ComfyUI instead.

## Video generation (free, via ComfyUI)

Video is not on the Gemini free tier, so the app renders video locally instead.
Point `COMFYUI_VIDEO_WORKFLOW` at an AnimateDiff or SVD workflow exported in
API format; the app fills `__PROMPT__`, `__NEGATIVE__`, `__SEED__`, `__WIDTH__`,
`__HEIGHT__` and `__FRAMES__`. When ComfyUI is reachable and a video workflow is
set, `/api/pilot/video/generate` renders there and saves the result into the
Render Vault. Without it, the endpoint honestly returns `503` and tells you to
run ComfyUI rather than returning a stock clip.

## Feature Film Factory (18 scenes → one 90-minute film)

One brief in, an 18-scene feature out. Each scene is a full five minutes and is
rendered **alone** through the same ComfyUI path as the single-shot video above,
so a bad scene can be re-rendered without touching the rest. Scenes come out at
a fixed size, frame rate and audio layout, so the approved ones join with
`ffmpeg -c copy` into the finished film.

```
POST /api/direk/feature/create    brief -> an 18-scene concept (no render)
POST /api/direk/feature/start     ask the Pilot for the script, then render 18 scenes
POST /api/direk/feature/pause     stop the batch; finished scenes are kept
POST /api/direk/feature/rerender  re-render one scene by index
POST /api/direk/feature/assemble  stitch the approved scenes into one film
GET  /api/direk/feature/status    job, scene list, tiers, progress, Dual-Pilot status
GET  /api/direk/feature/pilot     the Dual-Pilot status (Kaggle + local Ollama)
POST /api/direk/feature/pilot     fetch the script + bible + 18-scene breakdown
```

A scene needs a real video backend: ComfyUI reachable and `COMFYUI_VIDEO_WORKFLOW`
set. When it is not, `start` answers `503 AI_UNAVAILABLE` up front and a scene
that fails mid-batch is marked **failed** — the factory never writes a
placeholder clip to pretend a scene rendered.

### The Dual-Pilot: Kaggle (T3) and the local Ollama (T1)

The screenplay is written by a **Dual-Pilot**. The heavy batch worker is the
**Kaggle Pilot**: a Qwen 2.5 3B notebook that runs on Kaggle's GPU. It is an
**external cloud worker** — it is not part of this repository and not on this
machine. The app reaches it over the internet through a Cloudflare tunnel whose
public URL is set in `KAGGLE_PILOT_URL` (`src/services/pilotService.ts` is the
only bridge).

When Kaggle is unset or times out, the factory falls back to the **local Ollama**
instance (T1, real time) at `LOCAL_OLLAMA_URL`, so a batch still gets a real
screenplay on a machine with no tunnel. `START BATCH` stores the script in SQLite
(`movie_jobs.script`), then renders every scene for real. When a Pilot is
expected (Kaggle configured, or a reachable local model) but fails, the call
answers an honest `503 PILOT_UNAVAILABLE` and **nothing is fabricated**. With no
Pilot at all, the built-in 18-beat breakdown is used so the app still works
offline.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DIREK_SCENE_SECONDS` | `300` | Seconds per scene. Lower it for tests/demos; production keeps 300 so the film is 90 minutes |
| `KAGGLE_PILOT_URL` | _(empty)_ | Cloudflare tunnel URL of the Kaggle Notebook. Empty = no Kaggle Pilot |
| `KAGGLE_PILOT_TOKEN` | _(empty)_ | Optional bearer token for the tunnel |
| `KAGGLE_PILOT_TIMEOUT_MS` | `120000` | Per-call timeout for the Pilot |
| `KAGGLE_PILOT_SCRIPT_PATH` | `/generate_script` | Screenplay endpoint |
| `KAGGLE_PILOT_BIBLE_PATH` | `/generate_character_bible` | Character-bible endpoint |
| `KAGGLE_PILOT_SCENES_PATH` | `/breakdown_scenes` | 18-scene breakdown endpoint |
| `LOCAL_OLLAMA_URL` | `http://127.0.0.1:11434` | Local Ollama used as the T1 Pilot fallback (`OLLAMA_URL` is accepted as an alias) |
| `OLLAMA_MODEL` | `qwen2.5:7b` | Model the local Pilot uses |

### The database mirrors Firestore

`factory.db` (local SQLite) keeps two tables whose canonical columns match the
hosted Firestore documents field for field, so a migration is a copy, not a
rename. `FactoryDb.movieDoc(id)` and `FactoryDb.sceneDocs(id)` return exactly
these shapes:

| `MovieJobs` | `SceneJobs` |
| --- | --- |
| `id`, `title`, `genre`, `rating`, `format`, `status`, `created_at` | `id`, `movie_id`, `scene_number` (1-18), `status`, `video_path` |

Engine-only columns (progress, routing, timings, the stored script) ride
alongside. A `factory.db` written before this alignment is migrated and
backfilled on open, so no existing render is lost.

## Veo-style prompts

Google Veo's prompt guide builds a prompt from subject, action, camera, lighting
and style. The app borrows that structure: `buildVeoStylePrompt` adds a camera
move, dramatic lighting and a film look to an image or video prompt, but only
the parts the user left out, so their own wording always wins. This lifts the
output of both ComfyUI and Gemini toward Veo-grade results.

## Free connectors (no cloud account)

The skill registry used to list paid services — Cloudinary, Picsart, OpusClip,
Descript, HeyGen, vidIQ, Tracy, Tella, Orshot, Google Drive — and only hand back
an "action" object. Nothing ran. Now every one of them maps to a **local job**
that produces a real file, and the app runs it for you.

| Skill | Was | Now (free, local) |
| --- | --- | --- |
| `image_assets` | Cloudinary | asset store in `assets/` |
| `media_edit` | Picsart | ffmpeg color grade |
| `poster_design` | Orshot | ffmpeg poster / thumbnail |
| `video_edit` | Descript | ffmpeg trim |
| `short_clips` | OpusClip | ffmpeg cut + 9:16 |
| `auto_producer` | AI Producer | ffmpeg produced short + cover |
| `motion_video` | HeyGen | ffmpeg ken-burns from stills |
| `screen_demo` | Tella | ffmpeg burned-in caption |
| `growth_seo` | vidIQ | local SEO pack |
| `audience_research` | Tracy | local SEO pack |
| `cloud_storage` | Google Drive | Drive API v3, or a local ZIP |
| `delete_asset` | Cloudinary/Drive | local delete |
| `publish_post` | OpusClip/vidIQ/Tella | 9:16 cut + poster + metadata |

The only requirement is ffmpeg, which ships with the app through
`@ffmpeg-installer/ffmpeg`, so there is nothing to install by hand. Set
`FFMPEG_PATH` to use your own build instead.

### How it runs

When you ask for something that needs a file ("gawin mo na ang poster"), Direk
writes its normal answer and then appends one action block:

```action
{"skill": "poster_design", "args": {"title": "Alat ng Dagat", "background": "a weathered Filipino fisherman at sunset, 35mm film"}}
```

The server runs the matching connector and returns the result with the reply, so
the UI can show the file and a download button. `publish_post` still asks for
confirmation first.

`source`, `background` and `images` accept an asset name, a URL, or a **prompt**.
A prompt is generated into an image first (ComfyUI when it is running, else the
Gemini image model), so a poster request that only carries a description still
works.

### Google Drive

`cloud_storage` really uploads when Drive is set up. The Drive API is free; you
only need an OAuth client:

1. Google Cloud Console -> enable **Google Drive API**.
2. Create an OAuth client (Web application) and add the redirect URI from
   `GET /api/direk/drive/status`.
3. Set `GDRIVE_CLIENT_ID` and `GDRIVE_CLIENT_SECRET`, then open
   `/api/direk/drive/auth` and consent.

The scope is `drive.file`, so the app only sees the files it creates. Without
this setup, `cloud_storage` falls back to a local ZIP so the skill still produces
something.

### Endpoints

- `GET  /api/direk/connectors` — readiness and the full catalog.
- `POST /api/direk/connectors/run` — run one connector by skill name.
- `GET  /api/direk/assets` — every saved render.
- `GET  /api/direk/assets/:name/download` — download one.
- `GET  /api/direk/drive/status` / `/auth` / `/callback` — Drive setup.

## LoRA auto-training (kohya_ss)

Direk can train the set it just generated, without leaving the app. The
**LoRA Studio** tab has a TRAIN button; the API is:

```
GET  /api/direk/train/status    is a trainer installed? what is the current job?
POST /api/direk/train/start     generate images, write the dataset, start training
POST /api/direk/train/cancel    stop the running job
GET  /api/direk/train/stream    live training log (SSE)
```

Training runs locally, so it needs kohya_ss / sd-scripts on the machine that
runs the app. Nothing is faked: with no trainer installed the status endpoint
says so and TRAIN stays disabled.

| Variable | Default | Purpose |
| --- | --- | --- |
| `KOHYA_DIR` | (unset) | Path to kohya_ss / sd-scripts (must contain `train_network.py`). Enables training |
| `KOHYA_BASE_MODEL` | (unset) | Base model path or HuggingFace id. Required |
| `KOHYA_PYTHON` | `python3` | Interpreter |
| `KOHYA_ACCELERATE` | (unset) | `1` to launch via `accelerate launch` |
| `KOHYA_OUTPUT_DIR` | `<cwd>/lora_runs` | Where runs and checkpoints are written |
| `KOHYA_RUNS_ROOT` | `<cwd>/lora_runs` | Where each run's dataset + config are written |
| `KOHYA_TIMEOUT_MS` | `21600000` (6 h) | Hard cap on a run |

Each run writes a self-contained folder: `dataset/` (images + captions side by
side), `kohya_config.toml` with absolute paths, the live log, and the trained
`.safetensors` when it finishes.

## History

Direk started as a Python/Kaggle prototype (`notebooks/direk_kaggle_prototype.ipynb`,
built into a service at commit `e4acafb`). It has since been ported to TypeScript
under `src/direk/` and merged into this app, so the director and the cockpit ship
together.
