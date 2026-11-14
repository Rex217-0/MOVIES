"""Entry point: ``python -m movie_robo``."""

from __future__ import annotations

import uvicorn

from .config import Settings


def main() -> None:
    settings = Settings()
    uvicorn.run(
        "movie_robo.api:app",
        host=settings.host,
        port=settings.port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
