/**
 * Read-only reference catalog used to ground Direk's genre advice.
 * Ported from direk/reference.py and extended to read several datasets:
 * Netflix titles, an IMDb movie dataset, a Filipino movies dataset, and a
 * movie-statistics dataset (ratings, runtime, budget, gross). Two reviewed
 * Kaggle metadata datasets are added on top (see `kaggle.ts`).
 *
 * The catalog never throws on a missing dataset: a source that cannot be read
 * is skipped and `available` reflects whatever loaded. New sources are appended
 * with their own `source` tag; no existing row is overwritten.
 */

import fs from 'node:fs';
import { catalogTerms } from './genres.ts';
import { parseCsvFile, pick, cleanListCell } from './csv.ts';
import { loadKaggleSources } from './kaggle.ts';

export interface CatalogTitle {
  title: string;
  type: string;
  listed_in: string;
  release_year: string;
  duration: string;
  director?: string;
  cast?: string;
  source: string;
  /** Real commercial figures, present for the statistics dataset. */
  rating?: number;
  budget?: number;
  worldwide_gross?: number;
}

interface Source {
  name: string;
  file: string;
}

const SOURCES: Source[] = [
  { name: 'Netflix', file: 'netflix_titles.csv' },
  { name: 'IMDb', file: 'imdb_movies.csv' },
  { name: 'Filipino', file: 'filipino_movies.csv' },
  { name: 'Statistics', file: 'movie_statistics.csv' },
];

export class ReferenceCatalog {
  private rows: CatalogTitle[] = [];
  private haystacks: string[] = [];
  private dataDir: string;
  private kaggleLoaded = false;
  readonly maxResults: number;

  constructor(dataDir: string, maxResults = 5) {
    this.dataDir = dataDir;
    this.maxResults = Math.max(1, Math.min(maxResults, 20));
    for (const source of SOURCES) {
      const file = `${dataDir}/${source.file}`;
      if (!fs.existsSync(file)) continue;
      try {
        this.rows.push(...this.loadSource(source, file));
      } catch {
        // Skip a source that cannot be read; the others still work.
      }
    }
    this.haystacks = this.rows.map(r => r.listed_in.toLowerCase());
  }

  /**
   * Read the reviewed Kaggle metadata on first use, not at construction.
   *
   * The two files are large (68k rows, ~2.4s), and the server builds this
   * catalog at startup while `/api/health` must answer immediately. Loading
   * them lazily keeps the startup cheap and pays the cost only when a search,
   * a size or a source count actually needs them. The rows are appended, so an
   * existing title is never replaced, and each keeps its own source tag.
   */
  private ensureKaggle(): void {
    if (this.kaggleLoaded) return;
    this.kaggleLoaded = true;
    for (const row of loadKaggleSources(this.dataDir)) {
      this.rows.push(row);
      this.haystacks.push(row.listed_in.toLowerCase());
    }
  }

  private loadSource(source: Source, file: string): CatalogTitle[] {
    const csv = parseCsvFile(file);
    if (!csv) return [];
    return csv.rows.map(row => this.adapt(source.name, csv.header, row));
  }

  private adapt(name: string, header: string[], row: string[]): CatalogTitle {
    if (name === 'Netflix') {
      return {
        title: pick(header, row, 'title'),
        type: pick(header, row, 'type'),
        listed_in: pick(header, row, 'listed_in'),
        release_year: pick(header, row, 'release_year'),
        duration: pick(header, row, 'duration'),
        director: pick(header, row, 'director'),
        cast: pick(header, row, 'cast'),
        source: name,
      };
    }
    if (name === 'IMDb') {
      const minutes = pick(header, row, 'Runtime (Minutes)');
      return {
        title: pick(header, row, 'Title'),
        type: 'Movie',
        listed_in: cleanListCell(pick(header, row, 'Genre')),
        release_year: pick(header, row, 'Year'),
        duration: minutes ? `${minutes} min` : '',
        director: pick(header, row, 'Director'),
        cast: pick(header, row, 'Actors'),
        source: name,
      };
    }
    if (name === 'Statistics') {
      const runtime = pick(header, row, 'runtime_minutes');
      const rating = Number(pick(header, row, 'movie_averageRating'));
      const budget = Number(pick(header, row, 'Production budget $'));
      const gross = Number(pick(header, row, 'Worldwide gross $'));
      const director = pick(header, row, 'director_name');
      return {
        title: pick(header, row, 'movie_title'),
        type: 'Movie',
        listed_in: cleanListCell(pick(header, row, 'genres')),
        release_year: (pick(header, row, 'production_date') || '').slice(0, 4),
        duration: runtime && runtime !== 'NaN' ? `${runtime} min` : '',
        director: director && director !== '-' ? director : '',
        cast: '',
        source: name,
        rating: Number.isFinite(rating) ? rating : undefined,
        budget: Number.isFinite(budget) ? budget : undefined,
        worldwide_gross: Number.isFinite(gross) ? gross : undefined,
      };
    }
    // Filipino movies dataset (Python-list style cells).
    return {
      title: pick(header, row, 'Title'),
      type: 'Movie',
      listed_in: cleanListCell(pick(header, row, 'Genre')),
      release_year: pick(header, row, 'Year'),
      duration: '',
      director: cleanListCell(pick(header, row, 'Director')),
      cast: cleanListCell(pick(header, row, 'Cast')),
      source: name,
    };
  }

  get available(): boolean {
    return this.rows.length > 0;
  }

  /** Whether the large Kaggle files have been read into memory yet. */
  get kaggleReady(): boolean {
    return this.kaggleLoaded;
  }

  /** Rows held right now, without triggering the Kaggle load. For status probes. */
  get loadedSize(): number {
    return this.rows.length;
  }

  get size(): number {
    this.ensureKaggle();
    return this.rows.length;
  }

  /** Count of rows per source, for the status endpoint. */
  sources(): Record<string, number> {
    this.ensureKaggle();
    return this.loadedSources();
  }

  /** Source counts without loading the Kaggle files. For status probes. */
  loadedSources(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of this.rows) out[row.source] = (out[row.source] ?? 0) + 1;
    return out;
  }

  /**
   * Return up to `n` titles matching `genre` (and optional `kind`).
   *
   * Matches are drawn round-robin across sources, so one large dataset cannot
   * crowd out the others. That keeps the grounding balanced and lets the
   * statistics source (with ratings and budgets) actually surface.
   */
  search(genre: string | null, kind?: string | null, n?: number): CatalogTitle[] {
    if (!this.available || !genre) return [];
    this.ensureKaggle();
    const limit = Math.min(n ?? this.maxResults, this.maxResults);
    const terms = (catalogTerms(genre) || []).map(t => t.toLowerCase());
    if (!terms.length) return [];

    const kindLc = kind ? kind.toLowerCase() : null;
    const buckets = new Map<string, CatalogTitle[]>();
    const order: string[] = [];
    for (let i = 0; i < this.rows.length; i++) {
      if (!terms.some(t => this.haystacks[i].includes(t))) continue;
      const row = this.rows[i];
      if (kindLc && row.type.toLowerCase() !== kindLc) continue;
      let bucket = buckets.get(row.source);
      if (!bucket) {
        bucket = [];
        buckets.set(row.source, bucket);
        order.push(row.source);
      }
      bucket.push(row);
    }

    const out: CatalogTitle[] = [];
    for (let round = 0; out.length < limit; round++) {
      let added = false;
      for (const source of order) {
        const bucket = buckets.get(source)!;
        if (round < bucket.length) {
          out.push(bucket[round]);
          added = true;
          if (out.length >= limit) break;
        }
      }
      if (!added) break;
    }
    return out;
  }
}
