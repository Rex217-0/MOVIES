# No-cost audit

This is the no-cost audit of every output path in MOVIE CREATOR. The law is
simple: **every output must run for free**, and a paid cloud service may run only
when a deployment explicitly opts in with `ALLOW_PAID_CLOUD=1`. The app never
spends money silently.

Status: enforced in code, with tests. `npm test` is 258 passing.

## The switch

| `ALLOW_PAID_CLOUD` | Effect |
| --- | --- |
| unset, `0`, `false`, `no`, `off` | **Free only (the default).** Paid engines are skipped and the reason is reported instead of spending. |
| `1`, `true`, `yes`, `on` | Paid cloud services may run. |

The policy lives in one place, `src/direk/costPolicy.ts`
(`paidCloudAllowed()`, `paidReady()`). A paid engine is usable only when it is
**both** configured **and** opted in, so a leftover key cannot spend on its own.

## Every output path

| # | Output | Backend, in order | Cost | Gate |
| --- | --- | --- | --- | --- |
| 1 | Video clip | local ComfyUI → Wan 2.2 on fal.ai | free → paid | Wan needs `ALLOW_PAID_CLOUD=1` |
| 2 | Video edit (OpenCut) | OpenCut on fal.ai | paid | skipped unless `ALLOW_PAID_CLOUD=1` |
| 3 | Narration (voice) | Tagalog (bundled) → Gemini TTS → Piper → Fish Audio | free → free tier → free → free (`s2.1-pro-free`) | Fish is free on its default model; a billed model needs `ALLOW_PAID_CLOUD=1` |
| 4 | Images / posters | local ComfyUI → Gemini → Pollinations | free → paid → free | Gemini needs `ALLOW_PAID_CLOUD=1`; Pollinations is the free default |
| 5 | Screenplay / text | Kaggle pilot → local Ollama → Gemini text | free → free → free tier | Gemini text needs a key; free tier, not billed |
| 6 | Music bed | bundled asset | free | — |
| 7 | Connectors (edit, clips, SEO, thumbnails) | ffmpeg + asset store | free | — |
| 8 | Storage / hosting | local asset store, Google Drive (optional) | free | — |

### 1. Video clip — `src/direk/videoRenderService.ts`

`PREFERRED_RENDER_ENGINE` picks the primary engine, and it now defaults to
`comfyui` (the local Server-2 GPU). `fal` is the paid cloud path and still needs
`ALLOW_PAID_CLOUD=1`.

```
free path     local ComfyUI  (COMFYUI_VIDEO_WORKFLOW + Server-2 GPU)
paid fallback Wan 2.2 on fal.ai   → needs FAL_KEY AND ALLOW_PAID_CLOUD=1
neither       honest 503 AI_UNAVAILABLE (never a placeholder clip)
```

When the paid path is blocked the error names the switch, for example:
`... at Naka-off ang bayad na cloud (no-cost policy). I-set ang ALLOW_PAID_CLOUD=1
para payagan.`

### 2. Video edit — `src/direk/videoRenderService.ts`, `src/direk/fal.ts`

OpenCut is a paid fal.ai pass. It is skipped unless `ALLOW_PAID_CLOUD=1`; a
skipped or failed edit keeps the raw clip instead of throwing it away. The paid
calls themselves (`generateVideoWithWan`, `editWithOpenCut`) also refuse to run
without the opt-in, so a direct call cannot spend either.

### 3. Narration — `src/direk/movie.ts`

The default order is free-first:

```
tagalog (bundled, offline)  →  gemini (free tier)  →  piper (local)  →  fish (paid)
```

Fish Audio is free on its default model (`s2.1-pro-free`), so it stays in the
ready list with a key alone. If `FISH_AUDIO_MODEL` names a billed model it is
dropped unless
`ALLOW_PAID_CLOUD=1`. The Gemini voice (`gemini-2.5-flash-preview-tts`) is on the
**free tier** per Google's pricing page, so it is not gated. When no voice is
ready the shot carries a burned-in caption instead. `TTS_ORDER` can still pin an
exact chain for a deployment that knows what it is doing.

### 4. Images — `src/direk/imagine.ts`, `src/config.ts`

```
local ComfyUI  →  Gemini image (paid, off the free tier)  →  Pollinations (free, no key)
```

`IMAGE_MODEL_FREE = false`, so Gemini is skipped even with a key. Pollinations
needs no key and no GPU, so it is the free default. Nothing paid runs.

### 5. Text — `src/direk/llm.ts`, `src/services/pilotService.ts`

The screenplay path prefers the Kaggle pilot, then the local Ollama. The Gemini
text models are on the **free tier** (`src/config.ts`), so text stays free even
when a key is present; the free path never needs the key at all.

### 6-8. Free by construction

Music is a bundled asset. Connectors are local ffmpeg jobs and the local asset
store; the paid services the skill registry names (Cloudinary, Picsart, OpusClip,
Descript, HeyGen, vidIQ) are **never called**. Storage is the local asset store
plus an optional free Google Drive upload.

## What was changed in this pass

| File | Change |
| --- | --- |
| `src/direk/costPolicy.ts` | New. One switch, `ALLOW_PAID_CLOUD`; `paidCloudAllowed()` and `paidReady()`. |
| `src/direk/videoRenderService.ts` | Default engine is `comfyui` (free-first). Wan and OpenCut gated by the policy; blocked calls fail with a named reason. |
| `src/direk/fal.ts` | `generateVideoWithWan` and `editWithOpenCut` refuse to run without the opt-in. |
| `src/direk/movie.ts` | Narration order is free-first; Fish defaults to the free model, and a billed model is gated by the policy. |
| `.env.example` | Documents the policy and the new default. |

## How to verify

```bash
npm test          # 258 passing, including the no-cost guard tests
npm run lint      # clean
npm run build     # clean
```

The guard tests live in `src/direk/costPolicy.test.ts`,
`src/direk/videoRenderService.test.ts` (the paid Wan path is blocked unless the
deployment opts in; the editing pass is skipped by the policy) and
`src/direk/movie.test.ts` (the paid Fish voice stays off without the opt-in).

## Known limits (honest)

- The **local free video path needs a working ComfyUI** with a user-supplied
  `COMFYUI_VIDEO_WORKFLOW`. Without it, free video cannot render and the API
  answers 503. The Server-2 GPU is a Radeon RX 9070 (16 GB); the app's default
  Wan 2.2 A14B endpoint will not fit locally, so a quantized WAN workflow is
  needed for local video.
- Google Drive upload needs an OAuth client; it is optional and free.
- "Free" here means no money is spent by the app. Network, electricity and your
  own hardware are out of scope.
