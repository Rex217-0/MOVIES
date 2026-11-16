# Kaggle data sources

Provenance for every dataset staged under `data/kaggle/`. Checked on
**2026-11-15**. Licenses were read from the Kaggle dataset page on that date;
the Commander's review governs what may be used, and the image datasets stay
blocked until their rights review finishes (see `docs/datasets.md`).

Nothing here is a credential. The Kaggle token lives only in the environment
(`KAGGLE_USERNAME`, `KAGGLE_KEY`) and is never written to the repo.

## 1. 22K Animated Movies and TV Shows — allowed (metadata only)

| Field | Value |
| --- | --- |
| Dataset | 22K Animated Movies and TV Shows |
| Ref | `kabhishm/20k-animated-movies-and-tv-shows` |
| URL | https://www.kaggle.com/datasets/kabhishm/20k-animated-movies-and-tv-shows |
| License (Kaggle page, 2026-11-15) | CC0: Public Domain |
| Checked | 2026-11-15 |
| File used | `tv_movie_animation.csv` |
| Bytes | 4,211,216 |
| sha256 | `ef95a416a4dfc6ff38d2ffa60b78495e646703271d1872126fb8dbba775cfc9b` |
| Stored at | `data/kaggle/animated-tv/tv_movie_animation.csv` |
| Header | `title,desc,year,genre,certificate,runtime,rating,votes` |
| Rows | 22,370 data rows |
| Used for | Grounding: title, genre, year, runtime |

The dataset ZIP holds this one CSV; the CSV was extracted and the ZIP was not
kept.

## 2. The Movies Dataset — allowed (metadata only)

| Field | Value |
| --- | --- |
| Dataset | The Movies Dataset |
| Ref | `rounakbanik/the-movies-dataset` |
| URL | https://www.kaggle.com/datasets/rounakbanik/the-movies-dataset |
| License (Kaggle page, 2026-11-15) | CC0: Public Domain |
| Checked | 2026-11-15 |
| File used | `movies_metadata.csv` (the full dataset is 943,755,800 bytes; only this file was fetched) |
| Bytes | 34,445,126 |
| sha256 | `37ec322786b136a24604564e55160be75f8937546f11cb1a990076971fa895fd` |
| Stored at | `data/kaggle/the-movies-dataset/movies_metadata.csv` |
| Header | `adult,belongs_to_collection,budget,genres,homepage,id,imdb_id,original_language,original_title,overview,popularity,poster_path,production_companies,production_countries,release_date,revenue,runtime,spoken_languages,status,tagline,title,video,vote_average,vote_count` |
| Records | 45,466 records; 45,387 load whole (see the malformed rows below) |
| Used for | Grounding: title, genres, release year, runtime |

Only the metadata file is used. `credits.csv`, `keywords.csv`, `links*.csv`
and `ratings*.csv` were **not** fetched, so no cast, crew, keyword or per-user
rating data enters the repo. `poster_path` and `belongs_to_collection.poster_path`
are never read: the grounding uses text columns only.

### How it was downloaded

No Kaggle CLI and no `kaggle.json` are present in this environment. The two
datasets are public, so the metadata was fetched from the public Kaggle API
without a token:

```
curl -L -o a.zip "https://www.kaggle.com/api/v1/datasets/download/kabhishm/20k-animated-movies-and-tv-shows"
curl -L -o m.zip "https://www.kaggle.com/api/v1/datasets/download/rounakbanik/the-movies-dataset/movies_metadata.csv"
```

The ZIPs were unpacked in a temp directory, the one CSV each was copied into
`data/kaggle/`, and the hashes above were checked. No ZIP is committed.

### Malformed rows in `movies_metadata.csv`

The file is quoted CSV, but six records carry a literal newline inside the
`overview` text. Splitting the file on newlines therefore yields 45,572 lines
for 45,466 records. The bundled reader parses line by line, so it produces 185
rows whose field count does not match the 24-column header; the loader drops
those 185 rows and keeps **45,387**.

The dropped rows are the 79 records whose `overview` is split (a 10-field head
plus a 1- to 16-field continuation). Examples: `Jupiter's Wife` (id 290157)
and `The Acid House` (id 12229). This is reported, not corrected: repairing it
would mean inventing a merge rule. A JSON- or Python-aware reader would recover
all 45,466; that is out of scope here.

## 3. Movie Identification Dataset [800 Movies] — blocked

| Field | Value |
| --- | --- |
| Ref | `asaniczka/movie-identification-dataset-800-movies` |
| URL | https://www.kaggle.com/datasets/asaniczka/movie-identification-dataset-800-movies |
| License (Kaggle page, 2026-11-15) | ODC Attribution License (ODC-By) |
| Checked | 2026-11-15 |
| Status | **Blocked: film-frame rights review** |

ODC-By covers the database, but the dataset is built from film frames, whose
rights the dataset author cannot grant. Not downloaded, not used, not imported.

## 4. Real to Ghibli Image Dataset – 5K — blocked

| Field | Value |
| --- | --- |
| Ref | `shubham1921/real-to-ghibli-image-dataset-5k-paired-images` |
| URL | https://www.kaggle.com/datasets/shubham1921/real-to-ghibli-image-dataset-5k-paired-images |
| License (Kaggle page, 2026-11-15) | Attribution-NonCommercial 4.0 International (CC BY-NC 4.0) |
| Checked | 2026-11-15 |
| Status | **Blocked: rights review** |

The Kaggle page now shows CC BY-NC 4.0 (NonCommercial), which forbids commercial
training use. It is also a style-transfer image set derived from third-party
art. Not downloaded, not used, not imported.
