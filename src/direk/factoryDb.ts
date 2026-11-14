/**
 * Local SQLite store for the Feature Film Factory: `factory.db`.
 *
 * Two tables carry the whole batch:
 *   - `movie_jobs`  one row per film (concept, status, progress, the stitched film)
 *   - `scene_jobs`  one row per scene (18 per film), keyed by (movie_id, idx)
 *
 * This is the local stand-in for a hosted database. The storage calls are
 * deliberately small and self-contained so they can be swapped for a managed
 * backend later without touching the batch engine. It uses the built-in
 * `node:sqlite`, so there is no extra dependency to install.
 */

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MovieConcept, SceneStatus } from '../featureFilm.ts';
import type { TaskRoute } from './taskRouter.ts';
import type { FeatureJobView, SceneState, FeatureStatus } from './factory.ts';

/** Where the database lives. `DIREK_FACTORY_DB` overrides it (used by tests). */
export function factoryDbPath(): string {
  return process.env.DIREK_FACTORY_DB || path.join(process.cwd(), 'factory.db');
}

interface MovieRow {
  id: string;
  concept: string;
  status: string;
  percent: number;
  rendered: number;
  failed: number;
  approved: number;
  rejected: number;
  total: number;
  total_seconds: number;
  current_scene: number;
  rendered_seconds: number;
  film: string | null;
  error: string | null;
  started_at: number;
  ended_at: number | null;
}

interface SceneRow {
  movie_id: string;
  idx: number;
  act: number;
  heading: string;
  beat: string;
  narration: string;
  visual: string;
  mood: string;
  status: string;
  percent: number;
  seconds: number;
  asset_id: string | null;
  asset_name: string | null;
  error: string | null;
  route: string;
  started_at: number | null;
  ended_at: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS movie_jobs (
  id TEXT PRIMARY KEY,
  concept TEXT NOT NULL,
  status TEXT NOT NULL,
  percent INTEGER NOT NULL DEFAULT 0,
  rendered INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  approved INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 18,
  total_seconds INTEGER NOT NULL DEFAULT 5400,
  current_scene INTEGER NOT NULL DEFAULT 0,
  rendered_seconds INTEGER NOT NULL DEFAULT 0,
  film TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS scene_jobs (
  movie_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  act INTEGER NOT NULL,
  heading TEXT NOT NULL,
  beat TEXT NOT NULL,
  narration TEXT NOT NULL,
  visual TEXT NOT NULL,
  mood TEXT NOT NULL,
  status TEXT NOT NULL,
  percent INTEGER NOT NULL DEFAULT 0,
  seconds INTEGER NOT NULL DEFAULT 300,
  asset_id TEXT,
  asset_name TEXT,
  error TEXT,
  route TEXT NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  PRIMARY KEY (movie_id, idx)
);
CREATE INDEX IF NOT EXISTS scene_jobs_movie ON scene_jobs (movie_id);
`;

export class FactoryDb {
  private db: DatabaseSync;

  constructor(file: string = factoryDbPath()) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  /** Write one film and all of its scenes, replacing whatever was there. */
  save(job: FeatureJobView): void {
    this.db
      .prepare(
        `INSERT INTO movie_jobs
           (id, concept, status, percent, rendered, failed, approved, rejected, total,
            total_seconds, current_scene, rendered_seconds, film, error, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           concept=excluded.concept, status=excluded.status, percent=excluded.percent,
           rendered=excluded.rendered, failed=excluded.failed, approved=excluded.approved,
           rejected=excluded.rejected, total=excluded.total, total_seconds=excluded.total_seconds,
           current_scene=excluded.current_scene, rendered_seconds=excluded.rendered_seconds,
           film=excluded.film, error=excluded.error, started_at=excluded.started_at,
           ended_at=excluded.ended_at`,
      )
      .run(
        job.id,
        JSON.stringify(job.concept),
        job.status,
        job.percent,
        job.rendered,
        job.failed,
        job.approved,
        job.rejected,
        job.total,
        job.totalSeconds,
        job.currentScene,
        job.renderedSeconds,
        job.film ? JSON.stringify(job.film) : null,
        job.error ?? null,
        job.startedAt,
        job.endedAt ?? null,
      );

    const scene = this.db.prepare(
      `INSERT INTO scene_jobs
         (movie_id, idx, act, heading, beat, narration, visual, mood, status, percent,
          seconds, asset_id, asset_name, error, route, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(movie_id, idx) DO UPDATE SET
         act=excluded.act, heading=excluded.heading, beat=excluded.beat,
         narration=excluded.narration, visual=excluded.visual, mood=excluded.mood,
         status=excluded.status, percent=excluded.percent, seconds=excluded.seconds,
         asset_id=excluded.asset_id, asset_name=excluded.asset_name, error=excluded.error,
         route=excluded.route, started_at=excluded.started_at, ended_at=excluded.ended_at`,
    );
    for (const s of job.scenes) {
      scene.run(
        job.id, s.index, s.act, s.heading, s.beat, s.narration, s.visual, s.mood,
        s.status, s.percent, s.seconds, s.assetId ?? null, s.assetName ?? null,
        s.error ?? null, JSON.stringify(s.route), s.startedAt ?? null, s.endedAt ?? null,
      );
    }
  }

  /** Rebuild a job view from the database, or undefined when it is not stored. */
  load(id: string): FeatureJobView | undefined {
    const movie = this.db.prepare('SELECT * FROM movie_jobs WHERE id = ?').get(id) as unknown as MovieRow | undefined;
    if (!movie) return undefined;
    const sceneRows = this.db
      .prepare('SELECT * FROM scene_jobs WHERE movie_id = ? ORDER BY idx')
      .all(id) as unknown as SceneRow[];

    const scenes: SceneState[] = sceneRows.map(row => ({
      index: row.idx,
      act: row.act,
      heading: row.heading,
      beat: row.beat,
      narration: row.narration,
      visual: row.visual,
      mood: row.mood as SceneState['mood'],
      status: row.status as SceneStatus,
      percent: row.percent,
      seconds: row.seconds,
      assetId: row.asset_id ?? undefined,
      assetName: row.asset_name ?? undefined,
      error: row.error ?? undefined,
      route: JSON.parse(row.route) as TaskRoute,
      startedAt: row.started_at ?? undefined,
      endedAt: row.ended_at ?? undefined,
    }));

    const job: FeatureJobView = {
      id: movie.id,
      concept: JSON.parse(movie.concept) as MovieConcept,
      status: movie.status as FeatureStatus,
      percent: movie.percent,
      rendered: movie.rendered,
      failed: movie.failed,
      approved: movie.approved,
      rejected: movie.rejected,
      total: movie.total,
      totalSeconds: movie.total_seconds,
      currentScene: movie.current_scene,
      renderedSeconds: movie.rendered_seconds,
      scenes,
      startedAt: movie.started_at,
    };
    if (movie.film) job.film = JSON.parse(movie.film);
    if (movie.error) job.error = movie.error;
    if (movie.ended_at) job.endedAt = movie.ended_at;
    return job;
  }

  /** The newest stored films, for a restart-safe listing. */
  list(limit = 12): FeatureJobView[] {
    const rows = this.db
      .prepare('SELECT id FROM movie_jobs ORDER BY started_at DESC LIMIT ?')
      .all(limit) as { id: string }[];
    return rows.map(r => this.load(r.id)).filter((j): j is FeatureJobView => Boolean(j));
  }

  count(): number {
    const row = this.db.prepare('SELECT count(*) AS n FROM movie_jobs').get() as { n: number };
    return row.n;
  }

  sceneCount(movieId: string): number {
    const row = this.db.prepare('SELECT count(*) AS n FROM scene_jobs WHERE movie_id = ?').get(movieId) as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
