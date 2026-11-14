"""Model backends.

The heavy local stack (torch + transformers) is imported lazily so the service
starts instantly and can run against a remote OpenAI-compatible server instead.
"""

from __future__ import annotations

import logging
from typing import Protocol

from .config import Settings

log = logging.getLogger("movie_robo.model")


class ModelBackend(Protocol):
    name: str

    def generate(
        self,
        messages: list[dict],
        *,
        temperature: float,
        top_p: float,
        max_tokens: int,
    ) -> str: ...


class EchoBackend:
    """Deterministic, dependency-free backend used for tests and demos.

    It answers the persona's gate questions when essentials are missing and
    otherwise produces a short script-shaped reply, so the whole pipeline
    (gate, references, actions) can be exercised without a GPU.
    """

    name = "echo"

    def generate(self, messages, *, temperature, top_p, max_tokens) -> str:
        last = next((m["content"] for m in reversed(messages) if m.get("role") == "user"), "")
        if not last:
            return "Sabihin mo lang ang ideya mo at sisimulan natin."
        return (
            f"Echo backend: natanggap ko ang '{last[:80]}'. "
            "Ikabit ang MOVIE_ROBO_BACKEND=transformers o MOVIE_ROBO_BACKEND=openai para sa tunay na sagot."
        )


class OpenAIBackend:
    """Talks to any OpenAI-compatible /chat/completions endpoint."""

    name = "openai"

    def __init__(self, settings: Settings) -> None:
        import httpx

        self.settings = settings
        self._client = httpx.Client(
            base_url=settings.api_base.rstrip("/"),
            timeout=settings.request_timeout,
            headers={"Authorization": f"Bearer {settings.api_key}"} if settings.api_key else {},
        )

    def generate(self, messages, *, temperature, top_p, max_tokens) -> str:
        payload = {
            "model": self.settings.model_id,
            "messages": messages,
            "temperature": temperature,
            "top_p": top_p,
            "max_tokens": max_tokens,
        }
        resp = self._client.post("/chat/completions", json=payload)
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]


class TransformersBackend:
    """Runs the model locally with transformers (the original notebook path)."""

    name = "transformers"

    def __init__(self, settings: Settings) -> None:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self.settings = settings
        self.torch = torch
        self.tokenizer = AutoTokenizer.from_pretrained(settings.model_id)
        self.model = AutoModelForCausalLM.from_pretrained(
            settings.model_id, dtype=torch.float16, device_map="auto"
        )
        self.model.eval()
        log.info("Loaded %s on %d GPU(s)", settings.model_id, torch.cuda.device_count())

    def generate(self, messages, *, temperature, top_p, max_tokens) -> str:
        torch = self.torch
        text = self.tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        inputs = self.tokenizer(text, return_tensors="pt").to(self.model.device)
        with torch.no_grad():
            out = self.model.generate(
                **inputs,
                max_new_tokens=max_tokens,
                do_sample=temperature > 0,
                temperature=temperature if temperature > 0 else None,
                top_p=top_p,
            )
        new_tokens = out[0][inputs["input_ids"].shape[1]:]
        return self.tokenizer.decode(new_tokens, skip_special_tokens=True)


def build_backend(settings: Settings) -> ModelBackend:
    """Resolve ``settings.backend`` into a concrete backend.

    ``auto`` prefers the local transformers stack when it is importable, and
    otherwise falls back to an OpenAI-compatible server, then to ``echo``.
    """
    backend = settings.backend

    if backend == "echo":
        return EchoBackend()

    if backend == "openai":
        return OpenAIBackend(settings)

    if backend == "transformers":
        return TransformersBackend(settings)

    # auto
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401
    except ImportError:
        log.info("transformers/torch not available; using OpenAI-compatible backend")
        return OpenAIBackend(settings)

    try:
        return TransformersBackend(settings)
    except Exception as exc:
        log.warning("Local model load failed (%s); using OpenAI-compatible backend", exc)
        return OpenAIBackend(settings)
