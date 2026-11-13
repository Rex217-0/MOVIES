/**
 * Market intelligence for Direk: box-office statistics and per-title
 * commercial benchmarks, read from the bundled datasets.
 *
 * Everything here is real data from the CSVs; nothing is invented. When a file
 * is missing the relevant section is simply empty.
 */

import fs from 'node:fs';
import { parseCsvFile, pick, type Csv } from './csv.ts';

export interface ShareStat {
  name: string;
  movies: string;
  marketShare: string;
}

export interface Benchmark {
  title: string;
  year: string;
  budget: number;
  revenue: number;
  voteAverage: number;
  voteCount: number;
  director: string;
}

function num(value: string): number {
  const cleaned = (value || '').replace(/[^0-9.-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function readShareStats(file: string, nameCol: string): ShareStat[] {
  const csv: Csv | null = parseCsvFile(file);
  if (!csv) return [];
  return csv.rows
    .map(row => ({
      name: pick(csv.header, row, nameCol),
      movies: pick(csv.header, row, 'MOVIES'),
      marketShare: pick(csv.header, row, 'MARKET SHARE'),
    }))
    .filter(s => s.name);
}

export class MarketIntel {
  private dataDir: string;
  private tmdb: Csv | null = null;
  private directors = new Map<string, string>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.tmdb = parseCsvFile(`${dataDir}/tmdb_movies.csv`);
    const dir = parseCsvFile(`${dataDir}/tmdb_directors.csv`);
    if (dir) {
      for (const row of dir.rows) {
        const id = pick(dir.header, row, 'id');
        const name = pick(dir.header, row, 'director_name');
        if (id && name) this.directors.set(id, name);
      }
    }
  }

  get available(): boolean {
    return fs.existsSync(`${this.dataDir}/boxoffice/TopGenres.csv`);
  }

  topGenres(): ShareStat[] {
    return readShareStats(`${this.dataDir}/boxoffice/TopGenres.csv`, 'GENRES').slice(0, 5);
  }

  topDistributors(): ShareStat[] {
    return readShareStats(`${this.dataDir}/boxoffice/TopDistributors.csv`, 'DISTRIBUTORS').slice(0, 5);
  }

  productionMethods(): ShareStat[] {
    return readShareStats(`${this.dataDir}/boxoffice/TopProductionMethods.csv`, 'PRODUCTION METHODS');
  }

  ratings(): ShareStat[] {
    return readShareStats(`${this.dataDir}/boxoffice/TopGrossingRatings.csv`, 'MPAA RATINGS').slice(0, 5);
  }

  /** A compact, factual summary suitable for a system prompt or a UI panel. */
  brief(): string {
    if (!this.available) return '';
    const genres = this.topGenres();
    if (!genres.length) return '';
    const genreLine = genres.map(g => `${g.name} ${g.marketShare}`).join(', ');
    const distributors = this.topDistributors()
      .map(d => `${d.name} ${d.marketShare}`)
      .join(', ');
    const methods = this.productionMethods()
      .map(m => `${m.name} ${m.marketShare}`)
      .join(', ');
    const lines = [`Market share ng genre: ${genreLine}.`];
    if (distributors) lines.push(`Nangungunang distributor: ${distributors}.`);
    if (methods) lines.push(`Production method: ${methods}.`);
    return lines.join(' ');
  }

  /** Commercial benchmark for a title, from the TMDB dataset. */
  lookupBenchmark(title: string): Benchmark | null {
    if (!this.tmdb || !title) return null;
    const needle = title.trim().toLowerCase();
    if (!needle) return null;
    for (const row of this.tmdb.rows) {
      const t = pick(this.tmdb.header, row, 'title');
      if (t.toLowerCase() !== needle) continue;
      const directorId = pick(this.tmdb.header, row, 'director_id');
      return {
        title: t,
        year: pick(this.tmdb.header, row, 'year'),
        budget: num(pick(this.tmdb.header, row, 'budget')),
        revenue: num(pick(this.tmdb.header, row, 'revenue')),
        voteAverage: num(pick(this.tmdb.header, row, 'vote_average')),
        voteCount: num(pick(this.tmdb.header, row, 'vote_count')),
        director: this.directors.get(directorId) ?? '',
      };
    }
    return null;
  }
}
