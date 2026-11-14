# Movie Robo — AI Movie Creator

**Moviecity** · proudly powered and operated by the **LJR Group**

Gawing ganap na app ang prototype: isang **OpenAI-compatible API** na may
persona ni **Movie Robo**, ang opisyal na AI Movie Creator ng Moviecity.
Sinusundan nito ang pipeline:

```
IDEYA -> SCRIPT -> KARAKTER -> SHOT LIST -> VISUAL -> EDIT -> PUBLISH
```

Mula sa Kaggle notebook (`notebooks/direk_kaggle_prototype.ipynb`) na may Qwen2.5-3B,
naging modular na serbisyo na pwedeng patakbuhin kahit walang GPU.

## Ano ang kaya nitong gawin

| Feature | Detalye |
| --- | --- |
| **OpenAI-compatible chat** | `POST /v1/chat/completions` — gamitin ang sarili mong UI o OpenAI SDK client |
| **Movie Robo persona** | Filipino/Taglish, may house rules (tumanggi sa quote ng totoong tao) |
| **Genre detection** | Tagalog + English keywords → catalog genre (`romance` → `romantic`) |
| **Reference catalog** | Hinahanap sa Netflix-style CSV at isinasama sa system prompt |
| **Haba/mood gate** | Kung kulang ang haba o mood, magtatanong muna si Movie Robo bago magsulat |
| **Skill actions** | Sinusuportahan ang ` ```action ` JSON block; local skills vs API connectors |
| **Web UI** | Simpleng chat UI sa `/` para sa mabilis na testing |
| **Backends** | `transformers` (lokal, GPU), `openai` (vLLM/TGI/Ollama/OpenRouter), `echo` (test) |

## Mabilis na simula

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Walang GPU? Gumamit ng OpenAI-compatible server:
export MOVIE_ROBO_BACKEND=openai
export MOVIE_ROBO_API_BASE=http://127.0.0.1:8001/v1   # vLLM / TGI / Ollama / OpenRouter
export MOVIE_ROBO_API_KEY=sk-...                      # kung kailangan

python -m movie_robo
# UI:   http://localhost:8000/
# Docs: http://localhost:8000/docs
```

Kung may GPU at gusto mong lokal na model (tulad ng notebook):

```bash
pip install -r requirements-gpu.txt
export MOVIE_ROBO_BACKEND=transformers
export MOVIE_ROBO_MODEL_ID=Qwen/Qwen2.5-3B-Instruct
python -m movie_robo
```

## Docker

```bash
docker compose up --build
```

Naglulunsad ito ng API (`:8000`) at isang vLLM model server (`:8001`).
Kung hosted API ang gagamitin, alisin ang `model` service at itutok ang
`MOVIE_ROBO_API_BASE` sa provider.

## Environment variables

Ang lahat ng `MOVIE_ROBO_*` ay may backward-compatible fallback sa lumang
`DIREK_*`, kaya hindi masisira ang lumang deployment.

| Variable | Default | Gamit |
| --- | --- | --- |
| `MOVIE_ROBO_BACKEND` | `auto` | `auto`, `transformers`, `openai`, `echo` |
| `MOVIE_ROBO_MODEL_ID` | `Qwen/Qwen2.5-3B-Instruct` | Model name/id |
| `MOVIE_ROBO_API_BASE` | `http://127.0.0.1:8001/v1` | OpenAI-compatible endpoint |
| `MOVIE_ROBO_API_KEY` | *(walang laman)* | Bearer token para sa `openai` backend |
| `MOVIE_ROBO_TEMPERATURE` | `0.5` | Default temperature |
| `MOVIE_ROBO_TOP_P` | `0.9` | Default top-p |
| `MOVIE_ROBO_MAX_TOKENS` | `512` | Default max new tokens |
| `MOVIE_ROBO_REQUEST_TIMEOUT` | `300` | Timeout (segundo) sa model server |
| `MOVIE_ROBO_NETFLIX_CSV` | `/kaggle/input/.../netflix_titles.csv` | Reference catalog path |
| `MOVIE_ROBO_MAX_REFERENCE_RESULTS` | `5` | Bilang ng reference rows (max 20) |
| `MOVIE_ROBO_HOST` / `MOVIE_ROBO_PORT` | `0.0.0.0` / `8000` | Server bind |
| `MOVIE_ROBO_CORS_ORIGINS` | `*` | Comma-separated allowed origins |

## API

```bash
curl -s localhost:8000/health | jq

curl -s localhost:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Gumawa ka ng horror na kwento sa probinsya."}]}' | jq
```

Sagot na may gate (kulang ang haba at mood):

```json
{
  "choices": [{"message": {"role": "assistant", "content": "Bago ako gumawa: gaano katagal ang gusto mo? ..."}}],
  "gate": "haba",
  "reference_genre": "horror"
}
```

Kumpletong prompt (`3 minuto, nakakakaba`) → tuloy sa generation, at kung may
` ```action ` block ang model, lumalabas ito sa `action` field:

```json
{
  "action": {
    "skill": "poster_design",
    "connector": "Orshot",
    "args": {},
    "needs_confirm": false,
    "status": "not_connected"
  }
}
```

Endpoints:

- `GET /health` — status, backend, catalog rows
- `GET /v1/models` — OpenAI-style model list
- `GET /v1/skills` — skill registry (local vs API connector)
- `POST /v1/chat/completions` — chat (OpenAI-compatible payload)
- `GET /` — web UI

## Reference catalog

May kasamang maliit na sample (`data/netflix_titles_sample.csv`) para gumana agad.
Para sa buong dataset:

```bash
python scripts/fetch_netflix.py
export MOVIE_ROBO_NETFLIX_CSV=data/netflix_titles.csv
```

Kung wala ang CSV, hindi mag-crash ang app — `reference_available: false` lang.

## Tests

```bash
pip install -r requirements-dev.txt
pytest          # 39 tests, walang GPU o network
```

## Estruktura

```
movie_robo/
  api.py                 FastAPI app + routes
  service.py             gate + references + model + action parsing
  model.py               backends: transformers / openai / echo
  movie_robo_persona.py  system prompt, house rules, skills
  gate.py                haba/mood gate
  genres.py              keyword -> genre
  reference.py           Netflix CSV catalog
  skills.py              skill registry + ```action``` parser
  config.py              env-driven settings
static/index.html        web UI
tests/                   pytest suite
notebooks/               orihinal na Kaggle prototype
data/                    sample catalog
scripts/                 dataset helper
```

## Mga limitasyon

- Ang `action` field ay **deskripsyon lang** — hindi pa nakakabit ang
  Cloudinary, Descript, OpusClip, atbp. Kailangan ng credentials at connector code.
- Ang haba/mood gate ay simpleng keyword matching, hindi model-based.
- Ang sample catalog ay maliit; mas mahusay ang resulta kapag buong CSV ang naka-load.

## Origin

Orihinal na prototype: Kaggle notebook na may Qwen2.5-3B-Instruct, Flask, at
Cloudflare quick tunnel. Nasa `notebooks/` pa rin ito para sa reference.

