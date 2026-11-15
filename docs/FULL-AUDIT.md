# MOVIES — Full Ultimate Audit

Complete build audit of **MOVIE CREATOR** (`Rex217-0/MOVIES`), branch
`feat/blockers-a-i`, against the working tree at commit `96739ae`.

Everything below was measured on this machine. Claims that could not be
reproduced are marked **NOT VERIFIED**. Nothing here is estimated.

- Honesty rule: no fake data, no mock in a production path. If a feature cannot
  run, the app must say so, never invent a result.
- Cost rule: free-first. Paid cloud is allowed only with an approved budget of
  about 25 centavos (PHP) per 1 minute of video.

---

## 1. Scorecard

| Area | State | Evidence |
| --- | --- | --- |
| TypeScript compile | PASS | `npm run lint` (`tsc --noEmit`) exit 0 |
| Unit / integration tests | PASS | **292 / 292**, run twice, no flake |
| Production build | PASS | `vite build` 725 ms, 355 KB JS (100 KB gzip) |
| Server boot | PASS | `node server.ts` on Node 24 (native TS), `/api/health` 200 |
| End-to-end movie (no keys) | PASS | 1-min film in **45 s**, real 60 s 1280×720 H.264 + AAC MP4, 2.29 MB |
| Grounding data | PASS | Real Netflix / IMDb / Filipino CSVs + box-office stats |
| Security primitives | PASS | Timing-safe token compare, rate limiter, stream tickets, CORS |
| Firestore rules | PASS (after fix) | Vault read now admin-only |
| Default engine vs cost rule | **FIXED** | Was `fal` (paid); now `comfyui` (free chain) |
| Feature Film Factory UI | **FAIL** | Backend + view complete, **no UI tab** |
| Mesh retry / re-queue (item #4) | **FAIL** | Single attempt, no retry, not wired to render |
| Paid-cost guard | **FAIL** | No `ALLOW_PAID_CLOUD`, no per-minute budget check |
| Free path for feature scenes | PASS | Already flows through the free `renderVideo` chain |

---

## 2. What the build actually is

| Layer | Size |
| --- | --- |
| `server.ts` (Express) | 2,285 lines, **58 routes** |
| `src/direk/*.ts` (engine) | 34 modules, 11,218 lines |
| `src/components/*.tsx` (UI) | 13 views, 4,326 lines |
| Tests | 27 files, 292 tests |

Stack: Node ≥ 22 (ESM, `"type":"module"`) + Express + React 19 + Vite 8 +
TypeScript 7 + Gemini/Ollama + ffmpeg + ComfyUI + fal.ai.

### Views mounted in the app (`src/App.tsx`)

`movie` (Movie Maker) · `direk` (Movie Robo) · `lora` (LoRA Studio) ·
`cockpit` (Battle Room) · `radar` · `video` · `image` · `staging` · `vault`.

**Orphaned:** `src/components/FeatureFilmFactory.tsx` is complete and compiles,
but no tab imports it. Its backend is fully wired (`/api/direk/feature/*`,
18 scenes, SQLite store). The feature film product is unreachable from the UI.

---

## 3. Live verification (real, not mocked)

Environment: no keys at all — `GEMINI_API_KEY=''`, `OLLAMA_DISABLE=1`,
`COMFYUI_DISABLE=1`, `FAL_KEY=''`, `PREFERRED_RENDER_ENGINE=motion`.

### 3.1 Honest boot with nothing configured

```json
GET /api/health
{"ok":false,"gemini_key_configured":false,
 "text":{"backend":"none","available":false},
 "ollama":{"reachable":false,"error":"Ollama is disabled (OLLAMA_DISABLE=1)"}}
```

The app reports `ok:false` instead of pretending. Correct.

### 3.2 A real movie, made for free

```bash
POST /api/direk/movie  {"brief":"Isang mangingisda...","minutes":1,"mood":"tense"}
→ 202 {"status":"accepted","job":"MOV-..."}
```

Progress: Script → Titulo → Shots → Credits → Pagsasama → Musika → **done 100**
in **45 seconds**.

Output file, probed with the bundled ffmpeg:

```
Duration: 00:01:00.00
Video: h264 (High) 1280x720, 30 fps
Audio: aac (LC) 44100 Hz, stereo
bytes: 2291927
```

Real container, real duration, real audio track. The narration note is honest:
`"Walang boses — nakasulat ang kuwento sa video at may musika."`

### 3.3 Grounding reads real data

```js
groundMovie('Isang horror sa gubat', ...)
genre: horror
references: Dark Skies (2013, Netflix), Split (2016, IMDb),
            Shake, Rattle & Roll X (2008, Filipino)
market: "Market share ng genre: Adventure 27.14%, Action 20.75% ..."
```

Backed by `data/netflix_titles.csv` (3.4 MB), `imdb_movies.csv`,
`filipino_movies.csv`, `movie_statistics.csv`, `tmdb_*.csv`, `boxoffice/`.

### 3.4 Feature factory backend responds

```bash
POST /api/direk/feature/create → job FILM-... status idle, total 18 scenes
```

Each scene carries a real route decision (`tier T3`, `placement local`) and a
300 s budget → 18 × 300 s = **5,400 s (90 min)**. Backend is real; only the UI
is missing.

---

## 4. Honesty audit — real vs stub

Searched every production file for `TODO`, `FIXME`, `fake`, `mock`, `dummy`,
`placeholder`, `stub`, `not implemented`.

| Pattern found | Verdict |
| --- | --- |
| `placeholder=` / `placeholder-*` | CSS and HTML input hints. Not fake data. |
| `setFalClientForTests` | Test seam, referenced only in `fal.ts`. No prod caller. |
| `src/testing/comfyuiMock.ts` | Test-only ComfyUI stand-in, imported only by tests. |
| `fallbackScript()` in `movie.ts` | **Labeled** built-in beat sheet used only when no text model. Documented, not disguised as AI. |
| `verify.ts` | Rejects too-small / wrong-signature / bad-duration bytes. Never passes an unchecked output. |

**Conclusion:** no fabricated result is presented as real. The generation path
either produces a verified file or returns an explicit error
(`503 AI_UNAVAILABLE`).

---

## 5. Gap analysis, with severity

### P0 — nothing blocks a basic working app

The Movie Maker tab works end to end for free. This is the shipped product.

### P1 — blocks the "truly working, very functional" goal

1. **Default engine is paid.** ~~`preferredRenderEngine()` defaults to `fal`~~
   **FIXED**: it now defaults to `comfyui`, the free local-first chain, so a
   fresh install never reaches a paid call by accident. Only an explicit `fal`
   opts into cloud-first. Live-verified: with no `PREFERRED_RENDER_ENGINE` and no
   keys, the free motion engine rendered the clip.
   *(`videoRenderService.ts:56`, tests in `videoRenderService.test.ts`)*

2. **No paid-cost guard.** There is no `ALLOW_PAID_CLOUD` switch and no
   per-minute budget check. Paid cloud can be spent with no approval gate. The
   "25 centavos per 1 min" rule is not enforced anywhere. *(PR #21 holds the
   policy but conflicts with this branch.)*

3. **Feature Film Factory has no UI.** `FeatureFilmFactory.tsx` is orphaned.
   Add the tab and the whole 18-scene product becomes reachable.

4. **Feature scenes already have a free path.** *(Corrected from an earlier
   claim.)* `renderFeatureScene` calls `renderVideo()`, which runs the same
   ComfyUI → free motion → Wan chain. With the free-first default, a feature
   scene renders for free even with ComfyUI off. The only gap is the gate:
   `renderFeatureScene` throws when `videoRenderReady()` is false, which is
   correct (no fabrication).

5. **Mesh is not wired and has no retry.** `dispatchToMesh` tries one worker
   and stops. `dispatchJob` is never called from the render path. There is no
   re-queue, no backoff, no dead-letter. This is item #4 and it is not started.

### P2 — degrades reliability and operations

6. **`npm start` runs the Vite dev middleware.** The production start command
   spins up HMR (`Port 24678 is already in use` when two instances run). Serve
   `dist/` statically instead of the dev server in production.

7. **15 engine modules have no unit test:** `csv`, `fal`, `gate`, `gdrive`,
   `genres`, `imagine`, `loraPlan`, `market`, `persona`, `pipeline`, `platform`,
   `reference`, `service`, `skills`, `zip`. The riskiest are `fal` (the paid
   path) and `gdrive`.

8. **Gallery presets.** `GET /api/pilot/media/gallery` returns items with empty
   `url` (`"Initial Recon"`). Confirm these are honest placeholders, or filter
   them out of a "ready" list.

### P3 — forward compatibility

9. **`vite.config.ts` uses `__dirname`**, which Vite warns will break under the
   native config loader. Use `import.meta.dirname`.

10. **Cloud live checks still open** — Firebase Anonymous auth, Firestore
    creation, rules deployment, Drive OAuth redirect. See
    `docs/CLOUD_PROGRESS.md`.

---

## 6. Roadmap to a truly working app

Ordered so each step is independently shippable and testable.

| # | Task | Fixes | Effort |
| --- | --- | --- | --- |
| 1 | ~~Default engine to `comfyui`~~ **DONE** | P1-1 | S |
| 2 | Add `ALLOW_PAID_CLOUD` + per-minute budget guard on every paid call | P1-2 | M |
| 3 | Mount `FeatureFilmFactory` as a tab | P1-3 | S |
| 4 | ~~Route feature scenes through the free chain~~ **ALREADY DONE** | P1-4 | — |
| 5 | Durable retry queue: multi-worker, backoff, dead-letter, wire into render | P1-5 | L |
| 6 | Production `start` serves `dist/` (no dev HMR) | P2-6 | S |
| 7 | Tests for `fal` and `gdrive` at minimum | P2-7 | M |
| 8 | Resolve PR #21 ↔ #23 conflict, merge the no-cost policy | P1-2 | M |
| 9 | Replace `__dirname` in `vite.config.ts` | P3-9 | S |
| 10 | Complete the live Firebase / Drive console checks | P3-10 | — |

---

## 7. Bottom line

The build is **not a prototype**. The engine is real: it grounds scripts in real
datasets, renders verified MP4s, refuses to fabricate, and does the Movie Maker
end to end at zero cost in under a minute.

To become the "truly working, very functional app" you want, three things
matter most, in order: **enforce the paid-cost gate**, **expose the Feature Film
Factory**, and **add the durable retry queue (item #4)**. The free-first engine
default is already fixed in this audit.

Audited by OpenHands on 2026-11-13, on real runs, not on assumptions.

---

## 8. Changes made during this audit

- `src/direk/videoRenderService.ts` — default engine is now `comfyui` (free
  chain); `fal` is opt-in. Header comment updated.
- `src/direk/videoRenderService.test.ts` — new test locks the free default;
  cloud-path (Wan + OpenCut) tests pinned to `PREFERRED_RENDER_ENGINE=fal`;
  no-backend tests disable every engine.
- `src/direk/movie.test.ts`, `src/server.deployment.test.ts`,
  `src/server.honesty.test.ts` — no-backend tests now switch the free engines
  off, so they still assert the honest 503 and no cloud offload.
- `.env.example`, `README.md` — document the free-first default.
- `docs/FULL-AUDIT.md` — this report.

Result: **293 / 293 tests pass**, `tsc --noEmit` exit 0, `vite build` exit 0.
