"""FastAPI application exposing the Direk API and the demo web UI."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import __version__
from .config import Settings
from .service import DirekService

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(default_factory=list)
    temperature: float | None = None
    top_p: float | None = None
    max_tokens: int | None = None


def create_app(settings: Settings | None = None, service: DirekService | None = None) -> FastAPI:
    settings = settings or Settings()
    service = service or DirekService(settings)

    app = FastAPI(
        title="Direk — AI Movie Director",
        version=__version__,
        description=(
            "OpenAI-compatible chat API with the Direk persona: script, shot list, "
            "character bible at AI video prompts, may genre reference mula sa catalog."
        ),
    )
    app.state.service = service

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_credentials=False,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    @app.get("/health")
    def health() -> dict:
        return service.health()

    @app.get("/v1/models")
    def models() -> dict:
        return {"object": "list", "data": [{"id": settings.model_id, "object": "model"}]}

    @app.get("/v1/skills")
    def skills() -> dict:
        from .skills import SKILLS

        return {"object": "list", "data": SKILLS}

    @app.post("/v1/chat/completions")
    def chat(req: ChatRequest) -> dict:
        if not req.messages:
            raise HTTPException(status_code=400, detail="messages must not be empty")
        try:
            return service.chat(
                [m.model_dump() for m in req.messages],
                temperature=req.temperature,
                top_p=req.top_p,
                max_tokens=req.max_tokens,
            )
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"generation failed: {exc}") from exc

    @app.get("/")
    def index() -> FileResponse:
        index_file = STATIC_DIR / "index.html"
        if not index_file.exists():
            raise HTTPException(status_code=404, detail="UI not bundled")
        return FileResponse(index_file)

    return app


app = create_app()
