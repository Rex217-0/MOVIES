"""The Movie Robo service: gate + references + model + action parsing."""

from __future__ import annotations

import logging

from .config import Settings
from .gate import gate_question
from .genres import find_genre
from .model import ModelBackend, build_backend
from .movie_robo_persona import build_system_prompt
from .reference import ReferenceCatalog
from .skills import extract_action

log = logging.getLogger("movie_robo.service")


class MovieRoboService:
    def __init__(
        self,
        settings: Settings | None = None,
        backend: ModelBackend | None = None,
        catalog: ReferenceCatalog | None = None,
    ) -> None:
        self.settings = settings or Settings()
        self.catalog = catalog if catalog is not None else ReferenceCatalog(self.settings)
        self._backend = backend
        self._backend_error: str | None = None

    @property
    def backend(self) -> ModelBackend:
        if self._backend is None:
            try:
                self._backend = build_backend(self.settings)
            except Exception as exc:
                self._backend_error = str(exc)
                from .model import EchoBackend

                log.error("Backend unavailable (%s); falling back to echo", exc)
                self._backend = EchoBackend()
        return self._backend

    def health(self) -> dict:
        return {
            "ok": True,
            "model": self.settings.model_id,
            "backend": self.backend.name,
            "backend_error": self._backend_error,
            "persona": "Movie Robo",
            "reference_available": self.catalog.available,
            "reference_rows": self.catalog.size,
        }

    def chat(
        self,
        messages: list[dict],
        *,
        temperature: float | None = None,
        top_p: float | None = None,
        max_tokens: int | None = None,
    ) -> dict:
        incoming = [m for m in messages if m.get("role") != "system"]
        last_user = next(
            (m.get("content", "") for m in reversed(incoming) if m.get("role") == "user"), ""
        )
        genre = find_genre(last_user)

        # --- haba/mood gate (only when a catalog genre is in play) ---
        if genre:
            question = gate_question(last_user)
            if question:
                return self._completion(
                    question,
                    genre=genre,
                    gate=self._gate_field(last_user),
                )

        references = self.catalog.search(genre, kind="Movie") if genre else []
        system_prompt = build_system_prompt(references, genre)
        payload = [{"role": "system", "content": system_prompt}, *incoming]

        raw = self.backend.generate(
            payload,
            temperature=self.settings.temperature if temperature is None else float(temperature),
            top_p=self.settings.top_p if top_p is None else float(top_p),
            max_tokens=self.settings.max_tokens if max_tokens is None else int(max_tokens),
        )
        reply, action, action_error = extract_action(raw)
        return self._completion(reply, genre=genre, action=action, action_error=action_error)

    def _gate_field(self, text: str) -> str | None:
        from .gate import missing_fields

        missing = missing_fields(text)
        return missing[0] if missing else None

    def _completion(
        self,
        content: str,
        *,
        genre: str | None,
        action: dict | None = None,
        action_error: str | None = None,
        gate: str | None = None,
    ) -> dict:
        return {
            "object": "chat.completion",
            "model": self.settings.model_id,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": "stop",
                }
            ],
            "action": action,
            "action_error": action_error,
            "reference_genre": genre,
            "gate": gate,
        }
