# Build reference — MOVIE CREATOR (Movie Robo + Pilot Suite)

A measured snapshot of how the app is put together. Every number here was taken
from the code at the commit named below, not estimated.

| | |
| --- | --- |
| **App** | MOVIE CREATOR — Movie Robo + Pilot Suite |
| **Brand** | Moviecity, powered and operated by the LJR Group |
| **Repository** | `Rex217-0/MOVIES` |
| **Branch / commit** | `main` @ `2815cca` |
| **Target host** | Server-2 — Windows 11, Ryzen 7 7800X3D, 64 GB, Radeon RX 9070 (16 GB) |

---

## 1. Stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js 24 (engines `>=22`), `"type": "module"` |
| Language | TypeScript 7.0.2, target ES2022 |
| Front end | React 19.0.1, Tailwind CSS 4.3.3, lucide-react, motion, Vite 8.3.0 |
| Back end | Express 4.21.2, `tsx` as the dev runner |
| AI text | `@google/genai` 3.2.0 (Gemini) and a local Ollama |
| AI video | `@fal-ai/client` 1.11.0 (Wan 2.2) |
| Media | `@ffmpeg-installer/ffmpeg` (ffmpeg ships with the app) |
| Data | `firebase` 12.6.0 (client) and `firebase-admin` 12.7.0 (server) |
| Speech | Python (transformers / torch / soundfile), Fish Audio, Piper |
| Store | SQLite (`factory.db`) |

## 2. Size

| Measure | Value |
| --- | --- |
| TS/TSX files under `src/` | 80 |
| Lines under `src/` | 17,052 |
| `server.ts` | 2,023 lines |
| Total lines (src + server) | 19,075 |
| Test files | 23 (238 tests) |

Largest modules: `server.ts` (2,023), `src/direk/movie.ts` (1,058), `src/api.ts`
(663), `src/direk/factory.ts` (502), `src/services/pilotService.ts` (452),
`src/direk/render.ts` (450).

## 3. Build and run

```bash
npm install     # about 505 MB in node_modules
npm run dev     # tsx server.ts — dev server (Vite middleware + HMR)
npm run build   # vite build — front-end bundle into dist/
npm start       # node server.ts — production server
npm test        # node --import tsx --test
npm run lint    # tsc --noEmit
```

The front end builds into `dist/`:

```
dist/index.html                  902 B
dist/assets/index-*.js      ~355 KB  (about 100 KB gzipped)
dist/assets/index-*.css      ~40 KB
dist/ total                  ~400 KB
```

A build takes about 300 ms; `tsc --noEmit` is clean and the suite is 238/238.

**Serving.** In development the server mounts Vite middleware. In production it
serves `dist/` with `express.static` plus an SPA fallback (`server.ts` around
line 2002). It listens on `PORT` (default `3000`) on `0.0.0.0`.

## 4. Front end — nine tabs (`src/App.tsx`)

| Tab | Component |
| --- | --- |
| Movie Maker | `MovieMakerWithFirebase` |
| Movie Robo | `DirectorsChair` |
| LoRA Studio | `LoraStudio` |
| Battle Room | `VipBattleRoom` |
| Radar | `TacticalRadarMap` |
| Video | `VideoReconSuite` |
| Image | `ImageMatrixSuite` |
| Staging Vault | `StagingVault` |
| Vault | `RenderVault` |

## 5. Back end — routes (`server.ts`)

**Pilot (Battle Room)** — `/api/pilot/command`, `/status`, `/history`,
`/thought-stream` (SSE), `/protocols`, `/protocol/toggle`, `/image/generate`,
`/image/edit`, `/video/generate`, `/media/gallery`

**Direk (Movie Robo)** — `/api/direk/status`, `/chat`, `/reference`, `/market`,
`/benchmark`, `/routing`, `/settings`, `/setup`, `/connectors`,
`/connectors/run`, `/assets`, `/assets/review`, `/assets/:name/download`,
`/drive/status`, `/drive/auth`, `/drive/callback`

**Movie / speech** — `/api/direk/movie`, `/api/direk/movie/status`

**Feature Film Factory** — `/api/direk/feature/create`, `/start`, `/pause`,
`/rerender`, `/assemble`, `/stitch`, `/status`, `/pilot`

**LoRA** — `/api/direk/lora/plan`, `/lora/dataset`, `/lora/list`,
`/api/direk/train/status`, `/train/start`, `/train/cancel`, `/train/stream`

**Other** — `/api/direk/factory/db`, `/api/health`, `/renders/:name`

Every `/api` route requires a bearer token when `APP_AUTH_TOKEN` is set, and the
server refuses to start in production without it.

## 6. The engine (`src/direk/`)

| Module | Role |
| --- | --- |
| `persona.ts` | System prompt (Movie Robo), `BRAND` / `OPERATOR`, house rules |
| `service.ts` | `DirekService` — chat plus the gate before the model runs |
| `gate.ts` | Deterministic gate: a request needs haba and mood |
| `genres.ts`, `reference.ts`, `market.ts`, `grounding.ts` | Grounding in the bundled catalog |
| `movie.ts` | Pipeline IDEYA → SCRIPT → KARAKTER → SHOT LIST → VISUAL → EDIT → PUBLISH, and the narration chain |
| `render.ts`, `renderStore.ts`, `assets.ts` | Rendering and the Staging Vault sidecars |
| `comfyui.ts` | Local ComfyUI for image and video |
| `fal.ts` | Wan 2.2 video and OpenCut editing |
| `factory.ts`, `factoryDb.ts`, `featureFilm.ts` | 18-scene Feature Film Factory and its SQLite store |
| `lora.ts`, `loraPlan.ts`, `trainer.ts` | LoRA dataset and kohya_ss training |
| `connectors.ts` | The free local connectors (ffmpeg) |
| `taskRouter.ts` | T1 / T2 / T3 routing |
| `llm.ts` | Gemini and Ollama fallback |
| `platform.ts` | Windows and POSIX differences |
| `gdrive.ts`, `zip.ts`, `seo.ts`, `csv.ts`, `imagine.ts` | Drive, ZIP, SEO, CSV, image helpers |

## 7. Grounding data (`data/`)

| File | Rows |
| --- | --- |
| `netflix_titles.csv` | 8,809 |
| `movie_statistics.csv` | 4,380 |
| `tmdb_directors.csv` | 2,349 |
| `tmdb_movies.csv` | 1,465 |
| `imdb_movies.csv` | 999 |
| `filipino_movies.csv` | 469 |
| `boxoffice/*.csv` | 9 files |

The catalog searches about 14,658 titles and is read at startup. Nothing is
fetched from the network.

## 8. Integrations

| Backend | Default | Needs |
| --- | --- | --- |
| Gemini (text) | `gemini-3-flash-preview`, then `gemini-flash-latest`, `gemini-3.8-flash`, `gemini-2.5-flash` | `GEMINI_API_KEY` (free tier) |
| Ollama (text) | `http://127.0.0.1:11434`, `qwen2.5:7b` | a local install, no key |
| ComfyUI (image and video) | `http://127.0.0.1:8188` | a local GPU |
| Pollinations (image) | free | nothing |
| fal.ai Wan 2.2 (video) | `fal-ai/wan/v2.2-a14b/text-to-video` | `FAL_KEY` |
| kohya_ss (LoRA, local) | `TRAIN_BACKEND=local` | `KOHYA_DIR` and `KOHYA_BASE_MODEL` |
| Colab (LoRA, remote) | `TRAIN_BACKEND=colab` | `COLAB_DRIVE_ROOT` or `COLAB_DRIVE_FOLDER_ID`, and the notebook run by hand |
| Fish Audio (speech) | — | `FISH_AUDIO_API_KEY` (a reference id is optional) |
| MMS VITS Tagalog (speech) | `facebook/mms-tts-tgl` | Python with transformers, torch, soundfile |
| Piper (speech) | — | `TTS_PIPER_VOICE` (a `.onnx` file; English only) |
| Google Drive | — | an OAuth client id and secret |
| Kaggle Pilot (T3 script) | empty | `KAGGLE_PILOT_URL` (a Cloudflare tunnel) |

## 9. Task routing (T1 / T2 / T3)

| Tier | Work | Runs on |
| --- | --- | --- |
| T1 | chat, text, webhooks, the LoRA text half | local CPU |
| T2 | image generation (SDXL / Pollinations), Piper TTS, small LoRA training | local GPU |
| T3 | video rendering (local ComfyUI), large TTS, massive LoRA training | local GPU or cloud |

`GET /api/direk/routing` returns the full table. `T3_ALLOW_LOCAL=0` keeps a
non-video T3 job off the local GPU.

## 10. Environment variables

See `.env.example` for the annotated list. The groups are:

- **Required** — `GEMINI_API_KEY`, and `APP_AUTH_TOKEN` in production.
- **AI text** — `OLLAMA_URL`, `OLLAMA_MODEL`, `LOCAL_OLLAMA_URL`.
- **ComfyUI** — `COMFYUI_URL`, `COMFYUI_CHECKPOINT`, `COMFYUI_WORKFLOW`,
  `COMFYUI_VIDEO_WORKFLOW`, `COMFYUI_LORAS_DIR`, `COMFYUI_TIMEOUT_MS`.
- **kohya** — `KOHYA_DIR`, `KOHYA_BASE_MODEL`, `KOHYA_PYTHON`, `KOHYA_ACCELERATE`,
  `KOHYA_OUTPUT_DIR`.
- **Colab training** — `TRAIN_BACKEND` (`local` or `colab`), `COLAB_DRIVE_ROOT`,
  `COLAB_DRIVE_FOLDER_ID`, `COLAB_POLL_MS`.
- **Routing** — `T3_ALLOW_LOCAL`, `CLOUD_T3_URL`.
- **fal.ai** — `FAL_KEY`, `WAN_VIDEO_ENDPOINT`, `OPENCUT_ENDPOINT`.
- **Speech** — `FISH_AUDIO_API_KEY`, `FISH_AUDIO_REFERENCE_ID`, `TTS_ORDER`,
  `TTS_TAGALOG_MODEL`, `TTS_PYTHON`, `TTS_PIPER_BIN`, `TTS_PIPER_VOICE`,
  `TTS_DISABLE`.
- **Media / storage** — `FFMPEG_PATH`, `DIREK_ASSETS_DIR`, `GDRIVE_CLIENT_ID`,
  `GDRIVE_CLIENT_SECRET`.
- **Kaggle Pilot** — `KAGGLE_PILOT_URL`, `KAGGLE_PILOT_TOKEN`,
  `KAGGLE_PILOT_TIMEOUT_MS`, `KAGGLE_PILOT_SCRIPT_PATH` and the bible and scene
  paths.
- **Firebase** — `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`,
  `FIREBASE_PRIVATE_KEY`, `FIREBASE_STORAGE_BUCKET`.
- **Factory** — `DIREK_SCENE_SECONDS` (default `300`, so the film is 90 minutes).

## 11. Tests

256 tests across 24 files. The largest are `movie.test.ts` (27),
`trainBackend.test.ts` (17), `taskRouter.test.ts` (17),
`pilotService.test.ts` (17), `server.deployment.test.ts` (16),
`direk.test.ts` (14), `rules.test.ts` (14), `factory.test.ts` (13),
`comfyui.test.ts` (11), `lora.test.ts` (11), `featureFilm.test.ts` (11) and
`assets.test.ts` (10).

## 12. Honesty rules

- When video or a render is unavailable, the API answers `503 AI_UNAVAILABLE`.
  It never returns a placeholder clip.
- A scene that fails mid-batch is marked `failed`; nothing is fabricated.
- AI error messages never expose the API key.
- The gallery never invents a `url`; preset items keep an empty `url`.
- `GET /api/health` reports the real availability up front.

## 13. Deploy on Server-2 (Windows 11)

There is no Dockerfile on `main`; the app runs directly on Node.

```bash
npm install
cp .env.example .env     # then fill in the values
npm run build
npm start                # node server.ts
```

For the free offline Tagalog voice, install the Python packages into the
interpreter named by `TTS_PYTHON`:

```bash
python -m pip install -r scripts/requirements-tts.txt
```

Platform differences the app already handles on Windows: `TTS_PYTHON` and
`KOHYA_PYTHON` default to `python` (POSIX uses `python3`); ffmpeg filtergraph
paths escape `:` and `\`; the concat demuxer gets forward-slash paths; and the
trainer stops child processes with `SIGTERM` instead of `SIGKILL`.

## 14. What is verified and what is not

Measured directly: line counts, test results, bundle size, route list, dataset
row counts and dependency versions. Verified live: the offline Tagalog voice
(real 16 kHz speech, peak amplitude 14,560/32,767) once transformers, torch and
soundfile are installed.

Not yet exercised end to end in this environment: a full video render against a
real ComfyUI or fal.ai endpoint (no GPU or tunnel was available), and live
Gemini calls (no valid key was available).
