from movie_robo.config import Settings
from movie_robo.reference import BUNDLED_SAMPLE, ReferenceCatalog


def test_bundled_sample_is_loaded(settings: Settings):
    catalog = ReferenceCatalog(settings)
    assert catalog.available is True
    assert catalog.path == BUNDLED_SAMPLE
    assert catalog.size > 0


def test_search_filters_by_genre_and_kind(settings: Settings):
    catalog = ReferenceCatalog(settings)
    rows = catalog.search("horror", kind="Movie")
    assert rows, "expected horror movies in the sample catalog"
    assert all("horror" in r["listed_in"].lower() for r in rows)
    assert all(r["type"] == "Movie" for r in rows)


def test_search_respects_limit(settings: Settings):
    catalog = ReferenceCatalog(settings)
    rows = catalog.search("drama", n=1)
    assert len(rows) == 1


def test_missing_dataset_degrades_gracefully():
    settings = Settings(netflix_csv="/does/not/exist.csv")
    catalog = ReferenceCatalog(settings)
    # Falls back to the bundled sample rather than crashing.
    assert catalog.available is True
    assert catalog.search("horror")


def test_unknown_genre_returns_empty(settings: Settings):
    catalog = ReferenceCatalog(settings)
    assert catalog.search("nonsense-genre") == []
