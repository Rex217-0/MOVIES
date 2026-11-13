from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Plain `pytest` does not add the repo root to sys.path (only `python -m pytest`
# does), so make the package importable however the suite is invoked.
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from direk.config import Settings  # noqa: E402
from direk.reference import BUNDLED_SAMPLE  # noqa: E402
from direk.service import DirekService  # noqa: E402


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
