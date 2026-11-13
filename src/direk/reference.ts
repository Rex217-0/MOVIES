/**
 * Read-only reference catalog used to ground Direk's genre advice.
 * Ported from direk/reference.py and extended to read several datasets:
 * Netflix titles, an IMDb movie dataset, and a Filipino movies dataset.
 *
 * The catalog never throws on a missing dataset: a source that cannot be read
 * is skipped and `available` reflects whatever loaded.
 */

import fs from 'node:fs';
import { catalogTerms } from './genres.ts';
import { parseCsvFile, pick, cleanListCell } from './csv.ts';

export interface CatalogTitle {
  title: string;
  type: string;
  listed_in: string;
  release_year: string;
  duration: string;
  director?: string;
  cast?: string;
  source: string;
}

interface Source {
  name: string;
  file: string;
}

const SOURCES: Source[] = [
  { name: 'Netflix', file: 'netflix_titles.csv' },
  { name: 'IMDb', file: 'imdb_movies.csv' },
  { name: 'Filipino', file: 'filipino_movies.csv' },
];

export class ReferenceCatalog {
  private rows: CatalogTitle[] = [];
  private haystacks: string[] = [];
  readonly maxResults: number;

  constructor(dataDir: string, maxResults = 5) {
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
        listed_in: pick(header, row, 'Genre'),
        release_year: pick(header, row, 'Year'),
        duration: minutes ? `${minutes} min` : '',
        director: pick(header, row, 'Director'),
        cast: pick(header, row, 'Actors'),
        source: name,
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

  get size(): number {
    return this.rows.length;
  }

  /** Count of rows per source, for the status endpoint. */
  sources(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of this.rows) out[row.source] = (out[row.source] ?? 0) + 1;
    return out;
  }

  /** Return up to `n` titles matching `genre` (and optional `kind`). */
  search(genre: string | null, kind?: string | null, n?: number): CatalogTitle[] {
    if (!this.available || !genre) return [];
    const limit = Math.min(n ?? this.maxResults, this.maxResults);
    const terms = (catalogTerms(genre) || []).map(t => t.toLowerCase());
    if (!terms.length) return [];

    const kindLc = kind ? kind.toLowerCase() : null;
    const out: CatalogTitle[] = [];
    for (let i = 0; i < this.rows.length; i++) {
      const hay = this.haystacks[i];
      if (!terms.some(t => hay.includes(t))) continue;
      const row = this.rows[i];
      if (kindLc && row.type.toLowerCase() !== kindLc) continue;
      out.push(row);
      if (out.length >= limit) break;
    }
    return out;
  }
}
