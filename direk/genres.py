"""Keyword -> genre mapping used for catalog lookups."""

from __future__ import annotations

GENRE_MAP: dict[str, str] = {
    "action": "action",
    "aksyon": "action",
    "drama": "drama",
    "horror": "horror",
    "katatakutan": "horror",
    "sci-fi": "sci-fi",
    "sci fi": "sci-fi",
    "science fiction": "sci-fi",
    "romance": "romantic",
    "romantic": "romantic",
    "romantiko": "romantic",
    "love story": "romantic",
    "comedy": "comedy",
    "komedya": "comedy",
    "thriller": "thriller",
    "documentary": "documentary",
    "dokumentaryo": "documentary",
    "animation": "animation",
    "anime": "anime",
}


def find_genre(text: str) -> str | None:
    """Return the first catalog genre mentioned in ``text``, or ``None``.

    Longer keywords are checked first so that "love story" wins over "story".
    """
    lowered = (text or "").lower()
    for word in sorted(GENRE_MAP, key=len, reverse=True):
        if word in lowered:
            return GENRE_MAP[word]
    return None
