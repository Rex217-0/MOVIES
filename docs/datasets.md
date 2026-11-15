# Datasets

Status of every dataset that feeds the grounding catalog. Provenance, hashes and
headers are in `data/kaggle/SOURCES.md`. Last checked **2026-11-15**.

| # | Dataset | License (Kaggle page) | Status | Used for |
| --- | --- | --- | --- | --- |
| 1 | 22K Animated Movies and TV Shows (`kabhishm/20k-animated-movies-and-tv-shows`) | CC0 | **Allowed** — metadata only | Grounding: title, genre, year, runtime |
| 2 | The Movies Dataset (`rounakbanik/the-movies-dataset`) | CC0 | **Allowed** — metadata only | Grounding: title, genres, year, runtime |
| 3 | Movie Identification Dataset [800 Movies] (`asaniczka/movie-identification-dataset-800-movies`) | ODC-By | **Blocked: rights review** | — |
| 4 | Real to Ghibli Image Dataset – 5K (`shubham1921/real-to-ghibli-image-dataset-5k-paired-images`) | CC BY-NC 4.0 | **Blocked: rights review** | — |

## Why 3 and 4 are blocked

- **3 — Movie Identification Dataset [800 Movies]:** ODC-By covers the database,
  but the set is built from film frames. The frames' rights are not the dataset
  author's to grant, so a rights review is needed before any use. It is not
  downloaded, not imported, and no code path touches it.
- **4 — Real to Ghibli Image Dataset – 5K:** the Kaggle page shows
  **CC BY-NC 4.0**, which forbids commercial use, and the images are a
  style-transfer set derived from third-party art. It is not downloaded, not
  imported, and no code path touches it.

Both stay out of the repo and out of the tests until the Commander's rights
review clears them.

## What the allowed datasets may and may not do

Allowed:

- Read the two metadata CSVs to ground the screenplay (titles, genres, year,
  runtime).
- Tag every catalog row with its source so the output shows where a title came
  from.

Not allowed yet:

- No download, repackage or upload of film frames or images for LoRA.
- No download of posters or backdrops from TMDB or any other source.
- No model training on these datasets.

## What is in the repo

| Path | Rows | Notes |
| --- | --- | --- |
| `data/kaggle/animated-tv/tv_movie_animation.csv` | 22,370 | dataset 1, all rows load |
| `data/kaggle/the-movies-dataset/movies_metadata.csv` | 45,466 records | dataset 2; 45,387 load whole, 79 split records are skipped |
| `data/kaggle/SOURCES.md` | — | provenance, licenses, hashes, headers |

No image, video, poster, backdrop or archive is stored. The catalog reads text
columns only; the loader never opens an image path.
