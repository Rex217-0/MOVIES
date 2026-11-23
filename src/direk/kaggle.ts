/**
 * Kaggle grounding sources (metadata only).
 *
 * Two CC0 datasets reviewed by the Commander are folded into the reference
 * catalog so the screenplay can be grounded in more real titles:
 *
 *   kaggle/animated-tv/tv_movie_animation.csv        22,370 rows
 *   kaggle/the-movies-dataset/movies_metadata.csv     45,572 lines
 *
 * Provenance, license and the exact download are recorded in
 * `data/kaggle/SOURCES.md`. The rights review is not finished for the image
 * datasets (see `docs/datasets.md`), so nothing here reads a poster, backdrop
 * or any other image path: only the text columns named in the adapters below.
 *
 * The CSVs come from `movies_metadata.csv`, which uses the Python `dict`/`list`
 * repr for its nested cells. They are parsed by a small, explicit reader rather
 * than `JSON.parse`, and rows whose field count does not match the header are
 * skipped, because a stray newline inside `overview` splits a record across
 * lines and would otherwise shift every column.
 */

import { forEachCsvRow, pick } from './csv.ts';
import type { CatalogTitle } from './reference.ts';

export interface KaggleSource {
  /** The `source` tag written on every row it produces. */
  name: string;
  /** Path under `data/`. */
  file: string;
}

export const KAGGLE_SOURCES: KaggleSource[] = [
  { name: 'KaggleAnimation', file: 'kaggle/animated-tv/tv_movie_animation.csv' },
  { name: 'KaggleMovies', file: 'kaggle/the-movies-dataset/movies_metadata.csv' },
];

/**
 * Turn a TMDB `genres` cell ("[{'id': 16, 'name': 'Animation'}, ...]") into
 * "Animation, ...". The cell is a Python repr, not JSON, so the names are read
 * directly. Returns '' when the cell holds no genre.
 */
export function genreNames(cell: string): string {
  const names = [...cell.matchAll(/'name'\s*:\s*'([^']*)'/g)].map(m => m[1].trim());
  return names.filter(Boolean).join(', ');
}

/** A runtime cell ("81.0") as "81 min", or '' when absent or zero. */
function runtimeLabel(cell: string): string {
  const n = Number((cell || '').trim());
  return Number.isFinite(n) && n > 0 ? `${Math.round(n)} min` : '';
}

/** The release year from a "2001-05-01" date, or '' when there is no date. */
function yearOf(date: string): string {
  const m = (date || '').match(/(\d{4})/);
  return m ? m[1] : '';
}

function adaptKaggle(name: string, header: string[], row: string[]): CatalogTitle | null {
  const title = pick(header, row, 'title').trim();
  if (!title) return null;

  if (name === 'KaggleAnimation') {
    // Columns: title,desc,year,genre,certificate,runtime,rating,votes.
    // The dataset mixes movies and TV shows and has no type column, so the row
    // is labelled `Movie`, the kind the grounding searches for.
    return {
      title,
      type: 'Movie',
      listed_in: pick(header, row, 'genre').trim(),
      release_year: pick(header, row, 'year').trim(),
      duration: pick(header, row, 'runtime').trim(),
      source: name,
    };
  }

  // KaggleMovies: TMDB metadata. Only text columns are read; the poster and
  // backdrop paths are never touched.
  return {
    title,
    type: 'Movie',
    listed_in: genreNames(pick(header, row, 'genres')),
    release_year: yearOf(pick(header, row, 'release_date')),
    duration: runtimeLabel(pick(header, row, 'runtime')),
    source: name,
  };
}

/**
 * Read every Kaggle source under `dataDir`. A missing file is skipped, and a
 * row whose field count differs from the header is dropped rather than read
 * misaligned. No network, no image file, and no throw on bad data.
 */
export function loadKaggleSources(dataDir: string): CatalogTitle[] {
  const out: CatalogTitle[] = [];
  for (const src of KAGGLE_SOURCES) {
    forEachCsvRow(`${dataDir}/${src.file}`, (header, row) => {
      const title = adaptKaggle(src.name, header, row);
      if (title) out.push(title);
    });
  }
  return out;
}
