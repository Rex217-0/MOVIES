"""The haba/mood gate: ask for missing essentials before generating."""

from __future__ import annotations

import re

# Tonal descriptors only. Genre words (horror, thriller, ...) are handled by
# `genres.find_genre`, so they must not satisfy the mood requirement here.
MOOD_WORDS = [
    "masaya", "malungkot", "nakakakaba", "mabigat", "magaan", "madilim",
    "romantic", "romantiko", "emotional", "komedya", "comedy", "inspirasyon",
    "nostalgic", "warm", "light", "dark",
    "happy", "sad", "scary", "funny", "tense", "heavy", "serious", "hopeful",
]

DURATION_RE = re.compile(r"\d+\s*(segundo|sec|second|minuto|min|minute|oras|hour)", re.I)

QUESTIONS = {
    "haba": "Bago ako gumawa: gaano katagal ang gusto mo? Halimbawa: 30 segundo, 3 minuto, o 45 minuto.",
    "mood": "Anong mood ang gusto mo? Halimbawa: masaya, malungkot, nakakakaba, o mabigat.",
}


def missing_fields(text: str) -> list[str]:
    """Return the list of essentials absent from ``text`` (``haba`` / ``mood``)."""
    lowered = (text or "").lower()
    missing: list[str] = []
    if not DURATION_RE.search(lowered):
        missing.append("haba")
    if not any(word in lowered for word in MOOD_WORDS):
        missing.append("mood")
    return missing


def gate_question(text: str) -> str | None:
    """Return the question to ask first, or ``None`` if generation may proceed."""
    missing = missing_fields(text)
    return QUESTIONS[missing[0]] if missing else None
