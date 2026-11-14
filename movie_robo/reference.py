"""Read-only reference catalog (Netflix titles) used to ground genre advice."""

from __future__ import annotations

import logging
from pathlib import Path

from .config import Settings

log = logging.getLogger("movie_robo.reference")

USECOLS = ["title", "type", "listed_in", "release_year", "duration"]
BUNDLED_SAMPLE = Path(__file__).resolve().parent.parent / "data" / "netflix_titles_sample.csv"


class ReferenceCatalog:
    """Searchable view over a Netflix-style titles CSV.

    The catalog never raises on a missing dataset: it degrades to an empty
    catalog and reports ``available == False`` so the API keeps working.
    """

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or Settings()
        self.path: Path | None = None
        self._df = None
        self._load()

    def _load(self) -> None:
        try:
            import pandas as pd
        except ImportError:  # pragma: no cover - pandas is a hard runtime dep
            log.warning("pandas not installed; reference catalog disabled")
            return

        candidates = [Path(self.settings.netflix_csv)]
        if BUNDLED_SAMPLE.exists():
            candidates.append(BUNDLED_SAMPLE)

        for path in candidates:
            if not path.exists():
                continue
            try:
                self._df = pd.read_csv(path, usecols=USECOLS)
                self.path = path
                log.info("Reference catalog loaded from %s (%d rows)", path, len(self._df))
                return
            except Exception as exc:
                log.warning("Could not load reference catalog %s: %s", path, exc)

        log.warning("No reference catalog found (looked at %s)", ", ".join(str(c) for c in candidates))

    @property
    def available(self) -> bool:
        return self._df is not None

    @property
    def size(self) -> int:
        return 0 if self._df is None else len(self._df)

    def search(self, genre: str | None, kind: str | None = None, n: int | None = None) -> list[dict]:
        """Return up to ``n`` titles matching ``genre`` (and optional ``kind``)."""
        if not self.available or not genre:
            return []
        limit = min(int(n or self.settings.max_reference_results), self.settings.max_reference_results)
        df = self._df
        if kind:
            df = df[df["type"].str.lower() == kind.lower()]
        df = df[df["listed_in"].fillna("").str.lower().str.contains(str(genre).lower())]
        return df.head(limit).to_dict(orient="records")
