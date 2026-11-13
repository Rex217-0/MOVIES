from __future__ import annotations

from pathlib import Path

import pytest

from direk.config import Settings
from direk.reference import BUNDLED_SAMPLE
from direk.service import DirekService


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        backend="echo",
        model_id="test/model",
        netflix_csv=str(BUNDLED_SAMPLE),
        max_reference_results=5,
    )


@pytest.fixture
def service(settings: Settings) -> DirekService:
    return DirekService(settings)
