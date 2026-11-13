"""Runtime configuration, read from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_MODEL_ID = "Qwen/Qwen2.5-3B-Instruct"
DEFAULT_NETFLIX_CSV = "/kaggle/input/datasets/shivamb/netflix-shows/netflix_titles.csv"

VALID_BACKENDS = ("auto", "transformers", "openai", "echo")


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


@dataclass
class Settings:
    # --- model backend ---
    backend: str = field(default_factory=lambda: os.environ.get("DIREK_BACKEND", "auto"))
    model_id: str = field(default_factory=lambda: os.environ.get("DIREK_MODEL_ID", DEFAULT_MODEL_ID))
    # OpenAI-compatible backend (vLLM, TGI, Ollama, OpenRouter, ...)
    api_base: str = field(default_factory=lambda: os.environ.get("DIREK_API_BASE", "http://127.0.0.1:8001/v1"))
    api_key: str = field(default_factory=lambda: os.environ.get("DIREK_API_KEY", ""))
    # generation defaults
    temperature: float = field(default_factory=lambda: _env_float("DIREK_TEMPERATURE", 0.5))
    top_p: float = field(default_factory=lambda: _env_float("DIREK_TOP_P", 0.9))
    max_tokens: int = field(default_factory=lambda: _env_int("DIREK_MAX_TOKENS", 512))
    request_timeout: float = field(default_factory=lambda: _env_float("DIREK_REQUEST_TIMEOUT", 300.0))

    # --- reference catalog ---
    netflix_csv: str = field(default_factory=lambda: os.environ.get("DIREK_NETFLIX_CSV", DEFAULT_NETFLIX_CSV))
    max_reference_results: int = field(default_factory=lambda: _env_int("DIREK_MAX_REFERENCE_RESULTS", 5))

    # --- server ---
    host: str = field(default_factory=lambda: os.environ.get("DIREK_HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: _env_int("DIREK_PORT", 8000))
    cors_origins: tuple[str, ...] = field(
        default_factory=lambda: tuple(
            o.strip() for o in os.environ.get("DIREK_CORS_ORIGINS", "*").split(",") if o.strip()
        )
    )

    def __post_init__(self) -> None:
        if self.backend not in VALID_BACKENDS:
            raise ValueError(f"DIREK_BACKEND must be one of {VALID_BACKENDS}, got {self.backend!r}")
        self.max_reference_results = max(1, min(self.max_reference_results, 20))
        self.netflix_csv = str(Path(self.netflix_csv).expanduser())
