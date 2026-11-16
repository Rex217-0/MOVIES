# Kaggle Pilot (Qwen 2.5 3B)

The T3 heavy batch worker that writes the screenplay. It is a **Qwen 2.5 3B
Instruct** model served by a small Flask app, run on Kaggle's free GPU and
reached over a Cloudflare tunnel. The app's only bridge to it is
`src/services/pilotService.ts`.

The notebook is `scripts/direk_kaggle_pilot.ipynb`. The notebook **source** lives
in this repo; the notebook **runs** on Kaggle, never on the user's machine.

## Why it exists

`pilotService.ts` tries the Kaggle worker first (T3, heavy batch), then falls back
to a local Ollama (T1, real time). When neither answers, the call fails with an
honest `503 PILOT_UNAVAILABLE` — the app never invents a script.

## The contract

The notebook serves exactly what `pilotService.ts` calls:

| Method | Path | Body | Reply |
| --- | --- | --- | --- |
| GET | `/health` | — | `{ "ok": true, "model": "Qwen/Qwen2.5-3B-Instruct" }` |
| POST | `/generate_script` | `{ brief }` | `{ "script": "..." }` |
| POST | `/generate_character_bible` | `{ script }` | `{ "bible": "..." }` |
| POST | `/breakdown_scenes` | `{ script }` | `{ "scenes": [ { heading, narration, visual, mood } ] }` |

`/v1/models` and the OpenAI-shaped `/v1/chat/completions` are also served, so the
worker can be curled by hand. `src/services/kagglePilotNotebook.test.ts` checks
that the notebook keeps serving these routes.

When the model is not loaded, every generation route answers **503** with a
reason. Nothing is fabricated.

## Run it on Kaggle

1. Kaggle → New Notebook → upload `scripts/direk_kaggle_pilot.ipynb` (or paste
   the cells).
2. Settings → Accelerator → **GPU T4 x2** (or P100). Internet → **On**.
3. Run all. Cell 6 prints `KAGGLE_PILOT_URL = https://<...>.trycloudflare.com`.
4. Cell 7 smoke-tests every endpoint the app calls.

Then set the URL in the app and restart:

```
KAGGLE_PILOT_URL="https://<...>.trycloudflare.com"
# KAGGLE_PILOT_TOKEN=""          # only if you put a token in front of the tunnel
# KAGGLE_PILOT_TIMEOUT_MS="120000"
```

Check `GET /api/direk/feature/pilot` — it should answer `reachable: true` and
`preferred: "kaggle"`. The tunnel URL changes each Kaggle session, so update
`KAGGLE_PILOT_URL` every time you restart the notebook.

## Verify the contract without a GPU

`scripts/kaggle_pilot_stub_server.py` runs the **real** notebook code (persona,
helpers, Flask routes) on CPU with `torch`/`transformers` stubbed, so the HTTP
contract can be checked locally:

```bash
pip install flask flask-cors waitress requests
DIREK_PORT=8077 python3 scripts/kaggle_pilot_stub_server.py 8077 &

KAGGLE_PILOT_URL=http://127.0.0.1:8077 OLLAMA_DISABLE=1 \
  node --import tsx -e "import { writeScreenplay } from './src/services/pilotService.ts';
    console.log(await writeScreenplay('pelikula tungkol sa mangingisda'));"
```

`writeScreenplay` should return `source: 'kaggle'` with a script, a bible and a
scene list. This is how the notebook is checked against `pilotService.ts` — the
stub replaces only the model, never the routes.

## Editing the notebook

`scripts/direk_kaggle_pilot.ipynb` is generated so its Python stays readable and
diffable. Edit the cells in `scripts/build_kaggle_pilot_notebook.py`, then:

```bash
python3 scripts/build_kaggle_pilot_notebook.py
```

## Notes

- Model: `Qwen/Qwen2.5-3B-Instruct`. Override with `DIREK_MODEL_ID` on Kaggle.
- The persona is Filipino/Taglish and refuses to put a real person's words in
  their mouth, matching the app's honesty rules.
- The notebook holds no secret. It reads none from the environment except the
  optional `DIREK_*` knobs.
