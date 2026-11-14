"""Download the full Netflix titles catalog for richer reference results.

The repo ships a small sample (data/netflix_titles_sample.csv). Point
MOVIE_ROBO_NETFLIX_CSV at the downloaded file to use the full dataset.

Usage:
    python scripts/fetch_netflix.py            # -> data/netflix_titles.csv
    python scripts/fetch_netflix.py --out /path/to/netflix_titles.csv
"""

from __future__ import annotations

import argparse
import sys
import urllib.request
from pathlib import Path

DEFAULT_URL = "https://raw.githubusercontent.com/plotly/datasets/master/netflix_titles.csv"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--out", default="data/netflix_titles.csv")
    args = parser.parse_args()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {args.url} -> {out}")
    try:
        urllib.request.urlretrieve(args.url, out)
    except Exception as exc:  # noqa: BLE001
        print(f"Download failed: {exc}", file=sys.stderr)
        return 1
    print(f"Saved {out} ({out.stat().st_size} bytes)")
    print("Set MOVIE_ROBO_NETFLIX_CSV to this path to use it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
