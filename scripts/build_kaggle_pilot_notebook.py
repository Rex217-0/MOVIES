"""Build scripts/direk_kaggle_pilot.ipynb from scratch.

The notebook is generated from a plain source list so the JSON stays valid and
the content is reviewable in one place. Run: python3 scripts/build_kaggle_pilot_notebook.py
"""
import json
import pathlib

CELLS: list[tuple[str, str]] = []


def md(text: str) -> None:
    CELLS.append(("markdown", text))


def code(text: str) -> None:
    CELLS.append(("code", text))


md("""# Direk Kaggle Pilot — Qwen 2.5 3B (external cloud worker)

This notebook is the **T3 heavy batch worker** for MOVIE CREATOR. It runs on
Kaggle's GPU and serves the screenplay endpoints the app expects, behind a
Cloudflare tunnel. It is **not** part of the repo and never runs on the user's
machine.

It serves exactly what `src/services/pilotService.ts` calls:

| Method | Path | Body | Reply |
| --- | --- | --- | --- |
| GET | `/health` | — | `{ "ok": true, "model": ... }` |
| POST | `/generate_script` | `{ brief }` | `{ "script": "..." }` |
| POST | `/generate_character_bible` | `{ script }` | `{ "bible": "..." }` |
| POST | `/breakdown_scenes` | `{ script }` | `{ "scenes": [ { heading, narration, visual, mood } ] }` |

The legacy `/v1/chat/completions` (OpenAI shape) is kept too, so the same worker
can be curled by hand.

Honesty rule: if the model is not loaded, every generation route answers
**503** with a clear reason. The worker never invents a script.

## How to use

1. Kaggle → **New Notebook** → upload this file, or paste the cells.
2. Settings → Accelerator → **GPU T4 x2** (or P100). Internet → **On**.
3. Run all. The last cells print the tunnel URL and run a smoke test.
4. Copy the `https://....trycloudflare.com` URL into the app as `KAGGLE_PILOT_URL`
   and restart the app. Check `/api/direk/feature/pilot` — it should say
   `reachable: true`.
""")


code("""#@title 1. Install dependencies
import subprocess, sys

subprocess.run(
    [sys.executable, "-m", "pip", "install", "-q", "-U",
     "transformers", "accelerate", "flask", "flask-cors", "waitress", "requests"],
    check=True,
)
# cloudflared gives the public tunnel URL the app needs.
subprocess.run(
    ["wget", "-q", "-O", "cloudflared",
     "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"],
    check=True,
)
subprocess.run(["chmod", "+x", "cloudflared"], check=True)
print("Install done")""")


code("""#@title 2. Config and the Direk persona
import os

# Override on Kaggle if you want a different checkpoint. 3B fits a T4.
MODEL_ID = os.environ.get("DIREK_MODEL_ID", "Qwen/Qwen2.5-3B-Instruct")
PORT = int(os.environ.get("DIREK_PORT", "8000"))
MAX_NEW_TOKENS = int(os.environ.get("DIREK_MAX_NEW_TOKENS", "1024"))

SKILL_LIST = '''- write_script: Sumulat ng logline, synopsis, script, dialogue, scene list.
- shot_list: Gumawa ng shot list at storyboard prompts bawat eksena.
- character_bible: Gumawa ng karakter, itsura, ugali, boses (consistent sa buong pelikula).
- ai_video_prompt: Isulat ang image-to-video / text-to-video prompt bawat shot.'''

RULES = '''PATAKARAN SA SAGOT (sundin nang mahigpit):
1. Sumagot sa Filipino/Taglish, kahit English ang tanong.
2. Kung kulang ang detalye, MAGTANONG LANG muna. Huwag mag-imbento ng genre, haba, o budget.
3. Kung totoong tao ang gustong gawing bida o quote, TUMANGI nang maikli at mag-alok ng fiktional na karakter.'''

DIREK_SYSTEM = (
    "Ikaw si Direk, AI Movie Director at Creator ng boss mong si Rex.\\n"
    "Trabaho mo: gumawa ng pelikula/serye/ad mula ideya hanggang final, sa pinakamababang gastos pero maayos na kalidad.\\n\\n"
    "ASAL:\\n"
    "- Magalang, masigla, diretso. Maikling sagot. Filipino (Taglish OK).\\n"
    "- Gumamit ng pipeline: IDEYA -> SCRIPT -> KARAKTER -> SHOT LIST -> VISUAL -> EDIT -> PUBLISH.\\n"
    "- Unahin ang LIBRENG paraan. Sabihin kung may gastos ang isang hakbang.\\n"
    "- Huwag mag-imbento ng katotohanan o pangalan ng totoong tao. Walang hate, sexual content sa menor de edad, o panggagaya ng totoong artista.\\n\\n"
    "MGA SKILL MO (lokal lang, gawin mo mismo sa sagot):\\n"
    + SKILL_LIST + "\\n\\n" + RULES
)
print("Model:", MODEL_ID, "| port:", PORT)""")


code("""#@title 3. Load the model (GPU)
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM

tok = AutoTokenizer.from_pretrained(MODEL_ID)

# `dtype` is the current kwarg; `torch_dtype` is the older name. Try both so the
# cell works across transformers versions.
try:
    model = AutoModelForCausalLM.from_pretrained(MODEL_ID, dtype=torch.float16, device_map="auto")
except TypeError:
    model = AutoModelForCausalLM.from_pretrained(MODEL_ID, torch_dtype=torch.float16, device_map="auto")

model.eval()
MODEL_READY = True
print("Model loaded. GPUs:", torch.cuda.device_count(), "| device:", next(model.parameters()).device)""")


code("""#@title 4. Generation helpers
import json
import re


def _generate(system: str, user: str, *, temperature: float = 0.6,
              top_p: float = 0.9, max_new_tokens: int = MAX_NEW_TOKENS) -> str:
    \"\"\"One chat turn on the local model. Raises on a real failure.\"\"\"
    if not MODEL_READY:
        raise RuntimeError("Hindi pa naka-load ang model.")
    msgs = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    text = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
    inputs = tok(text, return_tensors="pt").to(model.device)
    with torch.no_grad():
        out = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=temperature > 0,
            temperature=temperature if temperature > 0 else None,
            top_p=top_p,
        )
    return tok.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True).strip()


def write_script(brief: str) -> str:
    user = (
        "Brief ng boss ko:\\n" + brief + "\\n\\n"
        "Isulat ang BUONG screenplay: pamagat, logline, at bawat eksena "
        "(heading, visual, narration/voice-over). Detalyado pero diretsong Filipino."
    )
    return _generate(DIREK_SYSTEM, user, temperature=0.7)


def write_bible(script: str) -> str:
    user = (
        "Ito ang screenplay:\\n\\n" + script + "\\n\\n"
        "Isulat ang character bible: pangalan, itsura, ugali, boses ng bawat karakter."
    )
    return _generate(DIREK_SYSTEM, user, temperature=0.6)


SCENE_SYSTEM = (
    "Magbalik lamang ng JSON na may 18 eksena. Walang ibang teksto, walang markdown.\\n"
    'Format: {"scenes":[{"heading":"","narration":"","visual":"","mood":""}]}'
)


def _scenes_from_text(text: str) -> list[dict]:
    \"\"\"Pull the scenes array out of the reply, tolerating a JSON fence.\"\"\"
    fence = re.search(r"```(?:json)?\\s*(.*?)```", text, re.S)
    payload = fence.group(1) if fence else text
    start, end = payload.find("{"), payload.rfind("}")
    if start == -1 or end == -1:
        return []
    try:
        data = json.loads(payload[start:end + 1])
    except Exception:
        return []
    raw = data.get("scenes") if isinstance(data, dict) else None
    if not isinstance(raw, list):
        return []
    scenes = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        heading = str(item.get("heading", "") or "").strip()
        narration = str(item.get("narration", "") or "").strip()
        visual = str(item.get("visual", "") or "").strip()
        mood = str(item.get("mood", "") or "").strip()
        if heading or narration or visual:
            scenes.append({"heading": heading, "narration": narration, "visual": visual, "mood": mood})
    return scenes


def break_down_scenes(script: str) -> list[dict]:
    user = "Hatiin sa 18 eksena ang screenplay na ito:\\n\\n" + script
    text = _generate(SCENE_SYSTEM, user, temperature=0.3)
    scenes = _scenes_from_text(text)
    if not scenes:
        # One retry with a blunter instruction; if it still fails the route 503s.
        text = _generate(SCENE_SYSTEM, user + "\\n\\nJSON lamang.", temperature=0.1)
        scenes = _scenes_from_text(text)
    return scenes


print("Handa ang helpers: write_script, write_bible, break_down_scenes")""")


code("""#@title 5. The Flask worker (the app's contract)
from flask import Flask, request, jsonify
from flask_cors import CORS
from waitress import serve
import threading, time

app = Flask(__name__)
CORS(app)


def _last_user(messages: list) -> str:
    return next((m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), "")


def _unavailable(reason: str):
    # An honest 503: the app turns this into PILOT_UNAVAILABLE, never a fake script.
    return jsonify({"error": reason, "code": "AI_UNAVAILABLE", "model": MODEL_ID}), 503


@app.get("/health")
def health():
    return jsonify({"ok": True, "model": MODEL_ID, "persona": "Direk", "model_ready": MODEL_READY})


@app.get("/v1/models")
def models():
    return jsonify({"object": "list", "data": [{"id": MODEL_ID, "object": "model"}]})


@app.post("/generate_script")
def generate_script():
    if not MODEL_READY:
        return _unavailable("Hindi pa naka-load ang model.")
    brief = str((request.get_json(force=True) or {}).get("brief", "")).strip()
    if not brief:
        return jsonify({"error": "Walang brief."}), 400
    try:
        return jsonify({"script": write_script(brief), "model": MODEL_ID})
    except Exception as exc:
        return _unavailable(f"Nabigo ang script generation: {exc}")


@app.post("/generate_character_bible")
def generate_character_bible():
    if not MODEL_READY:
        return _unavailable("Hindi pa naka-load ang model.")
    script = str((request.get_json(force=True) or {}).get("script", "")).strip()
    if not script:
        return jsonify({"error": "Walang script."}), 400
    try:
        return jsonify({"bible": write_bible(script), "model": MODEL_ID})
    except Exception as exc:
        return _unavailable(f"Nabigo ang character bible: {exc}")


@app.post("/breakdown_scenes")
def breakdown_scenes():
    if not MODEL_READY:
        return _unavailable("Hindi pa naka-load ang model.")
    script = str((request.get_json(force=True) or {}).get("script", "")).strip()
    if not script:
        return jsonify({"error": "Walang script."}), 400
    try:
        scenes = break_down_scenes(script)
    except Exception as exc:
        return _unavailable(f"Nabigo ang scene breakdown: {exc}")
    if not scenes:
        return _unavailable("Walang valid na eksena sa sagot ng model.")
    return jsonify({"scenes": scenes, "model": MODEL_ID})


@app.post("/v1/chat/completions")
def chat():
    if not MODEL_READY:
        return _unavailable("Hindi pa naka-load ang model.")
    d = request.get_json(force=True) or {}
    msgs = [m for m in d.get("messages", []) if m.get("role") != "system"]
    try:
        reply = _generate(
            DIREK_SYSTEM,
            _last_user(msgs),
            temperature=float(d.get("temperature", 0.5)),
            top_p=float(d.get("top_p", 0.9)),
            max_new_tokens=int(d.get("max_tokens", 512)),
        )
    except Exception as exc:
        return _unavailable(f"Nabigo ang chat: {exc}")
    return jsonify({
        "object": "chat.completion",
        "model": MODEL_ID,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": reply}, "finish_reason": "stop"}],
    })


threading.Thread(
    target=serve, args=(app,),
    kwargs={"host": "0.0.0.0", "port": PORT, "threads": 4},
    daemon=True,
).start()
time.sleep(2)
print(f"Direk worker running on port {PORT}")""")


code("""#@title 6. Open the Cloudflare tunnel (prints KAGGLE_PILOT_URL)
import subprocess, re, time

url = None
log = open("/kaggle/working/cf.log", "w")
proc = subprocess.Popen(
    ["./cloudflared", "tunnel", "--url", f"http://127.0.0.1:{PORT}"],
    stdout=log, stderr=subprocess.STDOUT,
)
for _ in range(90):
    time.sleep(1)
    with open("/kaggle/working/cf.log") as f:
        m = re.search(r"https://[a-z0-9-]+\\.trycloudflare\\.com", f.read())
    if m:
        url = m.group(0)
        break

print("KAGGLE_PILOT_URL =", url)""")


code("""#@title 7. Smoke test every endpoint the app calls
import requests

assert url, "Walang tunnel URL. Patakbuhin muna ang tunnel cell."

print("health:", requests.get(url + "/health", timeout=30).json())

r = requests.post(url + "/generate_script",
                  json={"brief": "Maikling pelikula tungkol sa mangingisda sa Batangas, 3 minuto, mabigat."},
                  timeout=600)
script = r.json().get("script", "")
print("script chars:", len(script))
print(script[:400])

r = requests.post(url + "/generate_character_bible", json={"script": script}, timeout=600)
print("bible chars:", len(r.json().get("bible", "")))

r = requests.post(url + "/breakdown_scenes", json={"script": script}, timeout=600)
scenes = r.json().get("scenes", [])
print("scenes:", len(scenes))
if scenes:
    print("first:", scenes[0])""")


def build(path: pathlib.Path) -> None:
    nb = {
        "cells": [
            {
                "cell_type": kind,
                "metadata": {},
                **({"source": [line + "\n" for line in text.split("\n")[:-1]] + [text.split("\n")[-1]]}
                   if text else {"source": []}),
                **({"outputs": [], "execution_count": None} if kind == "code" else {}),
            }
            for kind, text in CELLS
        ],
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    path.write_text(json.dumps(nb, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {path} ({len(nb['cells'])} cells)")


if __name__ == "__main__":
    build(pathlib.Path(__file__).resolve().parents[1] / "scripts" / "direk_kaggle_pilot.ipynb")
