#!/usr/bin/env python3
"""Offline Tagalog narration with Meta's MMS VITS voice.

Reads one line of text on stdin and writes a WAV to the path given as the first
argument. The model is small and runs on the CPU far faster than real time, so a
whole film's narration costs a few seconds and needs no key and no network once
the weights are cached.

    echo "Magandang gabi" | python3 scripts/tagalog_tts.py /tmp/line.wav
"""

import os
import sys

os.environ.setdefault("HF_HOME", os.environ.get("HF_HOME", "/workspace/.hf"))

import soundfile as sf  # noqa: E402
import torch  # noqa: E402
from transformers import AutoTokenizer, VitsModel  # noqa: E402

MODEL_ID = os.environ.get("TTS_TAGALOG_MODEL", "facebook/mms-tts-tgl")


def load():
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    model = VitsModel.from_pretrained(MODEL_ID)
    model.eval()
    return tokenizer, model


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "--batch":
        # A whole film at once: read [{"text":..., "out":...}, ...] from stdin so
        # the model loads once instead of once per line.
        import json

        jobs = json.loads(sys.stdin.read())
        tokenizer, model = load()
        for job in jobs:
            with torch.no_grad():
                waveform = model(**tokenizer(job["text"], return_tensors="pt")).waveform[0]
            sf.write(job["out"], waveform.detach().numpy(), model.config.sampling_rate)
            print(job["out"], flush=True)
        return 0

    text = sys.stdin.read().strip()
    if not text:
        print("walang teksto", file=sys.stderr)
        return 2
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/tagalog.wav"
    tokenizer, model = load()
    with torch.no_grad():
        waveform = model(**tokenizer(text, return_tensors="pt")).waveform[0]
    sf.write(out, waveform.detach().numpy(), model.config.sampling_rate)
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
