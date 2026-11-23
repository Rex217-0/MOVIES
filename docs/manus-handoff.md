# Handoff: connecting Manus to this repository

Manus does not connect to an agent directly. There is no agent-to-agent channel.
What connects the two is **this repository plus the environment contract below**.
Any agent that clones `Rex217-0/MOVIES` reads `AGENTS.md` first; this document is
the detail behind it.

Everything marked "verified" was checked against the code in this repository or
against a live endpoint. Anything unverified is labelled as such. Do not restate
an unverified item as fact.

## 1. What is actually wired

| Piece | Env var | Default | State |
|---|---|---|---|
| Kaggle worker | `KAGGLE_PILOT_URL` | unset | Bridge built and verified (`src/services/pilotService.ts`) |
| Kaggle worker auth | `KAGGLE_PILOT_TOKEN` | unset | Optional bearer token |
| Kaggle worker timeout | `KAGGLE_PILOT_TIMEOUT_MS` | `120000` | Verified |
| Local fallback LLM | `LOCAL_OLLAMA_URL` | `http://127.0.0.1:11434` | Verified |
| Local fallback model | `OLLAMA_MODEL` | `qwen2.5:7b` | Verified (`src/direk/llm.ts:30`) |
| ComfyUI | `COMFYUI_URL` | `http://127.0.0.1:8188` | Verified (`src/direk/systemMap.ts:357`) |
| ComfyUI LoRA folder | `COMFYUI_LORAS_DIR` | `<cwd>/comfy_loras` | Verified (`src/direk/comfyui.ts:62`) |

Script generation is dual-pilot: Kaggle first, local Ollama on timeout or when
Kaggle is unset. It never invents a script; it fails with `PILOT_UNAVAILABLE`.

## 2. Corrections to the popular plan

These four items circulate in the planning notes. Three are wrong and one is
already built.

**"Update `OPENHANDS_URL` so OpenHands auto-audits `api.ts`."**
There is no such feature. `OPENHANDS_URL` is read in exactly one place,
`src/direk/systemMap.ts:144`, and is used only to probe `GET <url>/health` for
the radar map. `OPENHANDS_API_KEY` is reported as a boolean in node metadata and
is never sent anywhere. Setting these will turn one radar node green and change
nothing else. Verified by reading the file; there is no agent-task endpoint.

**"Download the `.safetensors` to `C:\Users\sofia\AppData\Local\Comfy-Desktop\...`."**
Do not hardcode that path. `publishLora()` (`src/direk/comfyui.ts:70`) already
copies a finished `.safetensors` into the folder ComfyUI scans, and the folder
comes from `COMFYUI_LORAS_DIR`. Set that variable to the Comfy Desktop loras
directory once and the copy works without a path in the code. What is genuinely
missing is the Colab -> local transfer; `src/direk/colabTrainer.ts` reads training
outputs from Drive and verifies them against a manifest.

**"Run `main.py --allow-origin http://localhost:3000`."**
`--allow-origin` is not a ComfyUI argument. ComfyUI takes `--listen` and
`--enable-cors-header`. Not verified against a running instance here, so treat
the exact flag set as unconfirmed until someone runs `python main.py --help`.

**"Ollama is dead because of a model mismatch."**
This one is real and cheap to fix. The default model is `qwen2.5:7b` and
`src/direk/llm.ts` deliberately refuses to treat `qwen2.5:3b` as a match. If the
3B model is the one present, set `OLLAMA_MODEL=qwen2.5:3b` rather than pulling
7B.

## 3. What Manus should do

1. Clone the repository and read `AGENTS.md` and this file before editing.
2. Never claim a live deployment or a working tunnel without a real status code.
   The app's own `/healthz` is the liveness probe; `/health` on the app falls
   through to the SPA and returns HTML with status 200, so it proves nothing.
3. Set `COMFYUI_LORAS_DIR` and `OLLAMA_MODEL` locally instead of editing code.
4. Treat `KAGGLE_PILOT_URL` as ephemeral unless the tunnel is a named Cloudflare
   tunnel. A quick tunnel issues a new hostname on every Kaggle run.
5. Do not commit secrets. No tokens, no keys, no tunnel credentials.

## 4. Sharing access

If Manus is to run against this deployment, it needs its own credentials. Do not
pass a personal token through chat: it lands in a log and cannot be recalled.
Issue a scoped token, keep it in the platform's secret store, and rotate it when
the work is done.
