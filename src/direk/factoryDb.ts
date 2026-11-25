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
 *
 * Firestore alignment: the hosted database (see `src/firebase.ts`) keeps a
 * `MovieJobs` document per film and a `SceneJobs` document per scene. So the
 * local tables carry the same canonical columns, with the same names, and the
 * extra engine columns (progress, routing, timings) ride alongside:
 *
 *   MovieJobs  id, title, genre, rating, format, status, created_at
 *   SceneJobs  id, movie_id, scene_number [1-18], status, video_path
 *
 * `movieDoc(id)` and `sceneDocs(id)` return exactly those shapes, so a switch to
 * Firestore moves the data across without a field rename.
 */


import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MovieConcept, SceneStatus } from '../featureFilm.ts';
import type { TaskRoute } from './taskRouter.ts';
import type { FeatureJobView, SceneState, FeatureStatus } from './factory.ts';

/**
 * The one private vault this build serves. Every row in `movie_jobs` and
 * `scene_jobs` is stamped with it, and every read is scoped to it, so a shared
 * database can never leak another org's films into this one.
 */
export const ORG_ID = 'LJRgroupORG';

/** Where the database lives. `DIREK_FACTORY_DB` overrides it (used by tests). */
export function factoryDbPath(): string {
  return process.env.DIREK_FACTORY_DB || path.join(process.cwd(), 'factory.db');
}

interface MovieRow {
  id: string;
  org_id: string;
  title: string;
  genre: string;
  rating: string;
  format: string;
  created_at: number;
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
  script: string | null;
  bible: string | null;
  quality_tier: string;
  blocked: number;
  started_at: number;
  ended_at: number | null;
}

interface SceneRow {
  id: string;
  org_id: string;
  movie_id: string;
  scene_number: number;
  video_path: string | null;
  idx: number;
  act: number;
  heading: string;
  beat: string;
  narration: string;
  visual: string;
  mood: string;
  status: string;
  stage: string;
  percent: number;
  seconds: number;
  asset_id: string | null;
  asset_name: string | null;
  media_class: string | null;
  blocked_reason: string | null;
  shot_plan: string | null;
  error: string | null;
  route: string;
  started_at: number | null;
  ended_at: number | null;
}

/**
 * The canonical `MovieJobs` columns the hosted Firestore keeps, in order. The
 * local `movie_jobs` table carries these first, then the engine columns.
 * `org_id` is the private-vault scope (`ORG_ID`).
 */
export interface MovieDoc {
  id: string;
  org_id: string;
  title: string;
  genre: string;
  rating: string;
  format: string;
  status: string;
  created_at: number;
}

/** The canonical `SceneJobs` columns the hosted Firestore keeps. */
export interface SceneDoc {
  id: string;
  org_id: string;
  movie_id: string;
  scene_number: number;
  status: string;
  video_path: string | null;
}

/** A scene row's stable id, e.g. `FILM-123-S07`. */
export function sceneId(movieId: string, sceneNumber: number): string {
  return `${movieId}-S${String(sceneNumber).padStart(2, '0')}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS movie_jobs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT '${ORG_ID}',
  title TEXT NOT NULL DEFAULT '',
  genre TEXT NOT NULL DEFAULT '',
  rating TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
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
  script TEXT,
  bible TEXT,
  quality_tier TEXT NOT NULL DEFAULT 'CANARY',
  blocked INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS scene_jobs (
  id TEXT NOT NULL DEFAULT '',
  org_id TEXT NOT NULL DEFAULT '${ORG_ID}',
  movie_id TEXT NOT NULL,
  scene_number INTEGER NOT NULL DEFAULT 0,
  video_path TEXT,
  idx INTEGER NOT NULL,
  act INTEGER NOT NULL,
  heading TEXT NOT NULL,
  beat TEXT NOT NULL,
  narration TEXT NOT NULL,
  visual TEXT NOT NULL,
  mood TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'scripting',
  percent INTEGER NOT NULL DEFAULT 0,
  seconds INTEGER NOT NULL DEFAULT 300,
  asset_id TEXT,
  asset_name TEXT,
  media_class TEXT,
  blocked_reason TEXT,
  shot_plan TEXT,
  error TEXT,
  route TEXT NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  PRIMARY KEY (movie_id, idx)
);
CREATE INDEX IF NOT EXISTS scene_jobs_movie ON scene_jobs (movie_id);

-- The authoritative batch queue. One row per film that asked to run, so the
-- order the work will actually happen in is a fact on disk rather than the order
-- of a JS promise chain. A claim is a lease: the holder and the expiry are what
-- let a row belonging to a dead process be seen and taken over.
CREATE TABLE IF NOT EXISTS movie_leases (
  movie_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT '${ORG_ID}',
  holder TEXT NOT NULL,
  status TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  started_at INTEGER,
  renewed_at INTEGER,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS movie_leases_queue ON movie_leases (status, enqueued_at);
`;

/**
 * Bring an existing `factory.db` up to the Firestore-aligned shape. `CREATE
 * TABLE IF NOT EXISTS` never adds columns to a table that already exists, so a
 * database written before this change would be missing them; add each one that
 * is absent. Values are backfilled from the engine columns.
 */
function migrate(db: DatabaseSync): void {
  const columns = (table: string): Set<string> =>
    new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name));

  const movieCols = columns('movie_jobs');
  const addMovie: [string, string][] = [
    ['org_id', `TEXT NOT NULL DEFAULT '${ORG_ID}'`],
    ['title', "TEXT NOT NULL DEFAULT ''"],
    ['genre', "TEXT NOT NULL DEFAULT ''"],
    ['rating', "TEXT NOT NULL DEFAULT ''"],
    ['format', "TEXT NOT NULL DEFAULT ''"],
    ['created_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['script', 'TEXT'],
    ['bible', 'TEXT'],
    ['quality_tier', "TEXT NOT NULL DEFAULT 'CANARY'"],
    ['blocked', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [name, type] of addMovie) {
    if (!movieCols.has(name)) db.exec(`ALTER TABLE movie_jobs ADD COLUMN ${name} ${type}`);
  }
  // Backfill the canonical columns from the stored concept and start time.
  db.exec(`
    UPDATE movie_jobs SET
      title = COALESCE(NULLIF(title, ''), json_extract(concept, '$.title'), ''),
      genre = COALESCE(NULLIF(genre, ''), json_extract(concept, '$.genre'), ''),
      rating = COALESCE(NULLIF(rating, ''), json_extract(concept, '$.rating'), ''),
      format = COALESCE(NULLIF(format, ''), json_extract(concept, '$.format'), ''),
      created_at = CASE WHEN created_at = 0 THEN started_at ELSE created_at END
    WHERE title = '' OR genre = '' OR rating = '' OR format = '' OR created_at = 0
  `);

  const sceneCols = columns('scene_jobs');
  const addScene: [string, string][] = [
    ['id', "TEXT NOT NULL DEFAULT ''"],
    ['org_id', `TEXT NOT NULL DEFAULT '${ORG_ID}'`],
    ['scene_number', 'INTEGER NOT NULL DEFAULT 0'],
    ['video_path', 'TEXT'],
    ['stage', "TEXT NOT NULL DEFAULT 'scripting'"],
    ['media_class', 'TEXT'],
    ['blocked_reason', 'TEXT'],
    ['shot_plan', 'TEXT'],
    // A scene being rendered is leased, not just labelled 'rendering'. Without an
    // owner and an expiry, a crash mid-scene leaves a row that looks busy forever
    // and the batch can never finish it.
    ['lease_holder', 'TEXT'],
    ['lease_expires_at', 'INTEGER'],
    ['attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [name, type] of addScene) {
    if (!sceneCols.has(name)) db.exec(`ALTER TABLE scene_jobs ADD COLUMN ${name} ${type}`);
  }
  db.exec(`
    UPDATE scene_jobs SET
      scene_number = CASE WHEN scene_number = 0 THEN idx ELSE scene_number END,
      id = CASE WHEN id = '' THEN movie_id || '-S' || substr('0' || idx, -2) ELSE id END,
      video_path = COALESCE(video_path, asset_name)
    WHERE scene_number = 0 OR id = '' OR video_path IS NULL
  `);

  // Indexed only after `org_id` exists on both tables.
  db.exec(`
    CREATE INDEX IF NOT EXISTS movie_jobs_org ON movie_jobs (org_id);
    CREATE INDEX IF NOT EXISTS scene_jobs_org ON scene_jobs (org_id);
  `);
}

export class FactoryDb {
  private db: DatabaseSync;

  constructor(file: string = factoryDbPath()) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    migrate(this.db);
  }

  /** Write one film and all of its scenes, replacing whatever was there. */
  save(job: FeatureJobView): void {
    const created = job.startedAt;
    this.db
      .prepare(
        `INSERT INTO movie_jobs
           (id, org_id, title, genre, rating, format, created_at, concept, status, percent, rendered,
            failed, approved, rejected, total, total_seconds, current_scene, rendered_seconds,
            film, error, script, bible, quality_tier, blocked, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           org_id=excluded.org_id,
           title=excluded.title, genre=excluded.genre, rating=excluded.rating,
           format=excluded.format, created_at=excluded.created_at, concept=excluded.concept,
           status=excluded.status, percent=excluded.percent, rendered=excluded.rendered,
           failed=excluded.failed, approved=excluded.approved, rejected=excluded.rejected,
           total=excluded.total, total_seconds=excluded.total_seconds,
           current_scene=excluded.current_scene, rendered_seconds=excluded.rendered_seconds,
           film=excluded.film, error=excluded.error, script=excluded.script, bible=excluded.bible,
           quality_tier=excluded.quality_tier, blocked=excluded.blocked,
           started_at=excluded.started_at, ended_at=excluded.ended_at`,
      )
      .run(
        job.id,
        ORG_ID,
        job.concept.title,
        job.concept.genre,
        job.concept.rating,
        job.concept.format,
        created,
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
        job.script ?? null,
        job.bible ?? null,
        job.qualityTier,
        job.blocked,
        job.startedAt,
        job.endedAt ?? null,
      );

    const scene = this.db.prepare(
      `INSERT INTO scene_jobs
         (id, org_id, movie_id, scene_number, video_path, idx, act, heading, beat, narration, visual,
          mood, status, stage, percent, seconds, asset_id, asset_name, media_class, blocked_reason,
          shot_plan, error, route, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(movie_id, idx) DO UPDATE SET
         org_id=excluded.org_id,
         id=excluded.id, scene_number=excluded.scene_number, video_path=excluded.video_path,
         act=excluded.act, heading=excluded.heading, beat=excluded.beat,
         narration=excluded.narration, visual=excluded.visual, mood=excluded.mood,
         status=excluded.status, stage=excluded.stage, percent=excluded.percent, seconds=excluded.seconds,
         asset_id=excluded.asset_id, asset_name=excluded.asset_name,
         media_class=excluded.media_class, blocked_reason=excluded.blocked_reason,
         shot_plan=excluded.shot_plan,
         error=excluded.error, route=excluded.route,
         started_at=excluded.started_at, ended_at=excluded.ended_at`,
    );
    for (const s of job.scenes) {
      scene.run(
        sceneId(job.id, s.index), ORG_ID, job.id, s.index, s.assetName ?? null, s.index, s.act, s.heading,
        s.beat, s.narration, s.visual, s.mood, s.status, s.stage, s.percent, s.seconds,
        s.assetId ?? null, s.assetName ?? null, s.mediaClass ?? null, s.blockedReason ?? null,
        s.shots ? JSON.stringify(s.shots) : null, s.error ?? null, JSON.stringify(s.route), s.startedAt ?? null, s.endedAt ?? null,
      );
    }
  }

  /** Rebuild a job view from the database, or undefined when it is not stored. */
  load(id: string): FeatureJobView | undefined {
    const movie = this.db
      .prepare('SELECT * FROM movie_jobs WHERE id = ? AND org_id = ?')
      .get(id, ORG_ID) as unknown as MovieRow | undefined;
    if (!movie) return undefined;
    const sceneRows = this.db
      .prepare('SELECT * FROM scene_jobs WHERE movie_id = ? AND org_id = ? ORDER BY idx')
      .all(id, ORG_ID) as unknown as SceneRow[];

    const scenes: SceneState[] = sceneRows.map(row => ({
      index: row.idx,
      act: row.act,
      heading: row.heading,
      beat: row.beat,
      narration: row.narration,
      visual: row.visual,
      mood: row.mood as SceneState['mood'],
      status: row.status as SceneStatus,
      stage: row.stage as SceneState['stage'],
      percent: row.percent,
      seconds: row.seconds,
      assetId: row.asset_id ?? undefined,
      assetName: row.asset_name ?? undefined,
      mediaClass: (row.media_class as SceneState['mediaClass']) ?? undefined,
      blockedReason: row.blocked_reason ?? undefined,
      shots: row.shot_plan ? (JSON.parse(row.shot_plan) as SceneState['shots']) : undefined,
      error: row.error ?? undefined,
      route: JSON.parse(row.route) as TaskRoute,
      startedAt: row.started_at ?? undefined,
      endedAt: row.ended_at ?? undefined,
    }));

    const job: FeatureJobView = {
      id: movie.id,
      orgId: movie.org_id,
      concept: JSON.parse(movie.concept) as MovieConcept,
      qualityTier: (movie.quality_tier as FeatureJobView['qualityTier']) || 'CANARY',
      status: movie.status as FeatureStatus,
      percent: movie.percent,
      rendered: movie.rendered,
      failed: movie.failed,
      blocked: movie.blocked ?? 0,
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
    if (movie.script) job.script = movie.script;
    if (movie.bible) job.bible = movie.bible;
    if (movie.ended_at) job.endedAt = movie.ended_at;
    return job;
  }

  /** The newest stored films, for a restart-safe listing. */
  list(limit = 12): FeatureJobView[] {
    const rows = this.db
      .prepare('SELECT id FROM movie_jobs WHERE org_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(ORG_ID, limit) as { id: string }[];
    return rows.map(r => this.load(r.id)).filter((j): j is FeatureJobView => Boolean(j));
  }

  /**
   * One film in the canonical `MovieJobs` shape the hosted Firestore uses. This
   * is the row a Firestore migration writes to `MovieJobs/<id>`.
   */
  movieDoc(id: string): MovieDoc | undefined {
    const row = this.db
      .prepare('SELECT * FROM movie_jobs WHERE id = ? AND org_id = ?')
      .get(id, ORG_ID) as unknown as MovieRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      org_id: row.org_id,
      title: row.title,
      genre: row.genre,
      rating: row.rating,
      format: row.format,
      status: row.status,
      created_at: row.created_at,
    };
  }

  /**
   * One film's scenes in the canonical `SceneJobs` shape, ordered by scene
   * number (1-18). Each entry is a document for `SceneJobs/<id>`.
   */
  sceneDocs(movieId: string): SceneDoc[] {
    const rows = this.db
      .prepare('SELECT * FROM scene_jobs WHERE movie_id = ? AND org_id = ? ORDER BY scene_number')
      .all(movieId, ORG_ID) as unknown as SceneRow[];
    return rows.map(row => ({
      id: row.id,
      org_id: row.org_id,
      movie_id: row.movie_id,
      scene_number: row.scene_number,
      status: row.status,
      video_path: row.video_path,
    }));
  }

  count(): number {
    const row = this.db.prepare('SELECT count(*) AS n FROM movie_jobs WHERE org_id = ?').get(ORG_ID) as { n: number };
    return row.n;
  }

  // -------------------------------------------------------------------------
  // Batch queue and leases.
  // -------------------------------------------------------------------------

  /**
   * Put a film in the queue, or leave it where it is when it is already there.
   *
   * `INSERT OR IGNORE` is what makes enqueueing idempotent: pressing START twice
   * cannot create a second queue entry, so the film cannot be run twice at once.
   * A film that already finished is re-queued deliberately, with `requeue`.
   */
  enqueue(movieId: string, opts: { now?: number; holder?: string; requeue?: boolean } = {}): void {
    const at = opts.now ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO movie_leases
           (movie_id, org_id, holder, status, enqueued_at, started_at, renewed_at, expires_at)
         VALUES (?, ?, ?, 'queued', ?, NULL, NULL, NULL)
         ON CONFLICT(movie_id) DO NOTHING`,
      )
      .run(movieId, ORG_ID, opts.holder ?? '', at);
    if (opts.requeue) {
      this.db
        .prepare(
          `UPDATE movie_leases
              SET status = 'queued', enqueued_at = ?, started_at = NULL, renewed_at = NULL, expires_at = NULL
            WHERE movie_id = ? AND status IN ('done', 'failed', 'cancelled')`,
        )
        .run(at, movieId);
    }
  }

  /**
   * Claim the next film to run, as one atomic step.
   *
   * The `UPDATE ... WHERE movie_id = (SELECT ...)` form is the whole point: the
   * row that is chosen and the row that is claimed are decided by the same
   * statement, so two processes calling this at the same moment cannot both be
   * handed the same film.
   */
  claimNext(
    holder: string,
    opts: { now?: number; ttlMs?: number } = {},
  ): { movieId: string; startedAt: number; expiresAt: number } | undefined {
    const at = opts.now ?? Date.now();
    const expiresAt = at + (opts.ttlMs ?? 30 * 60 * 1000);
    const rows = this.db
      .prepare(
        `UPDATE movie_leases
            SET status = 'running', holder = ?, started_at = ?, renewed_at = ?, expires_at = ?
          WHERE movie_id = (
                  SELECT movie_id FROM movie_leases
                   WHERE org_id = ?
                     AND (status = 'queued'
                          OR (status = 'running' AND (expires_at IS NULL OR expires_at <= ?)))
                   ORDER BY enqueued_at
                   LIMIT 1
                )
            AND status IN ('queued', 'running')
          RETURNING movie_id, started_at`,
      )
      .all(holder, at, at, expiresAt, ORG_ID, at) as { movie_id: string; started_at: number }[];
    if (rows.length === 0) return undefined;
    return { movieId: rows[0].movie_id, startedAt: rows[0].started_at, expiresAt };
  }

  /** Extend a lease this holder still owns. False means it was taken over. */
  renewLease(movieId: string, holder: string, opts: { now?: number; ttlMs?: number } = {}): boolean {
    const at = opts.now ?? Date.now();
    const rows = this.db
      .prepare(
        `UPDATE movie_leases SET renewed_at = ?, expires_at = ?
          WHERE movie_id = ? AND holder = ? AND status = 'running'
          RETURNING movie_id`,
      )
      .all(at, at + (opts.ttlMs ?? 30 * 60 * 1000), movieId, holder) as { movie_id: string }[];
    return rows.length > 0;
  }

  /** Record a terminal state, but only if this holder still owns the row. */
  finish(movieId: string, holder: string, status: 'done' | 'failed' | 'cancelled'): boolean {
    const rows = this.db
      .prepare(
        `UPDATE movie_leases SET status = ?, holder = '', expires_at = NULL
          WHERE movie_id = ? AND holder = ? AND status = 'running'
          RETURNING movie_id`,
      )
      .all(status, movieId, holder) as { movie_id: string }[];
    return rows.length > 0;
  }

  /** Ask a running film to stop. It keeps its completed scenes. */
  requestCancel(movieId: string): boolean {
    const rows = this.db
      .prepare(
        `UPDATE movie_leases SET status = 'cancelled', expires_at = NULL
          WHERE movie_id = ? AND status IN ('queued', 'running')
          RETURNING movie_id`,
      )
      .all(movieId) as { movie_id: string }[];
    return rows.length > 0;
  }

  /** True when a stop was asked for, so the running batch can notice. */
  isCancelled(movieId: string): boolean {
    const row = this.db
      .prepare(`SELECT status FROM movie_leases WHERE movie_id = ? AND org_id = ?`)
      .get(movieId, ORG_ID) as { status: string } | undefined;
    return row?.status === 'cancelled';
  }

  /** Every row in the queue, oldest first, for the UI to show honestly. */
  queue(): { movieId: string; status: string; holder: string; enqueuedAt: number; expiresAt: number | null }[] {
    const rows = this.db
      .prepare(
        `SELECT movie_id, status, holder, enqueued_at, expires_at FROM movie_leases
          WHERE org_id = ? ORDER BY enqueued_at`,
      )
      .all(ORG_ID) as { movie_id: string; status: string; holder: string; enqueued_at: number; expires_at: number | null }[];
    return rows.map(r => ({
      movieId: r.movie_id,
      status: r.status,
      holder: r.holder.replace(/#.*$/, ''),
      enqueuedAt: r.enqueued_at,
      expiresAt: r.expires_at,
    }));
  }

  /**
   * Turn a running film that nobody owns any more back into a queued one, and
   * release its stranded scene. Called on boot, so a crash costs one scene, not
   * the whole film.
   *
   * Returns the ids that were recovered.
   */
  recoverAbandoned(opts: { now?: number } = {}): string[] {
    const at = opts.now ?? Date.now();
    const stale = this.db
      .prepare(
        `SELECT movie_id, holder FROM movie_leases
          WHERE org_id = ? AND status = 'running' AND (expires_at IS NULL OR expires_at <= ?)`,
      )
      .all(ORG_ID, at) as { movie_id: string; holder: string }[];
    if (stale.length === 0) return [];

    for (const row of stale) {
      this.db
        .prepare(
          `UPDATE movie_leases
              SET status = 'queued', holder = '', started_at = NULL, renewed_at = NULL, expires_at = NULL
            WHERE movie_id = ? AND status = 'running'`,
        )
        .run(row.movie_id);
      // A scene left mid-render is not done. Put it back to pending so the batch
      // renders it again, and clear the lease that the dead owner never freed.
      this.db
        .prepare(
          `UPDATE scene_jobs
              SET status = 'pending', stage = 'scripting', percent = 0,
                  lease_holder = NULL, lease_expires_at = NULL, started_at = NULL, ended_at = NULL
            WHERE movie_id = ? AND org_id = ? AND status = 'rendering'`,
        )
        .run(row.movie_id, ORG_ID);
      // The film itself is no longer running; leaving it 'running' would show a
      // progress bar that never moves.
      this.db
        .prepare(
          `UPDATE movie_jobs SET status = 'paused'
            WHERE id = ? AND org_id = ? AND status = 'running'`,
        )
        .run(row.movie_id, ORG_ID);
    }
    return stale.map(r => r.movie_id);
  }

  /**
   * Claim one scene for this holder. Returns false when another holder already
   * owns it, so a scene is never rendered twice for the same attempt.
   */
  claimScene(movieId: string, idx: number, holder: string, opts: { now?: number; ttlMs?: number } = {}): boolean {
    const at = opts.now ?? Date.now();
    const rows = this.db
      .prepare(
        `UPDATE scene_jobs
            SET lease_holder = ?, lease_expires_at = ?, attempts = attempts + 1, started_at = ?
          WHERE movie_id = ? AND org_id = ? AND idx = ?
            AND (lease_holder IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
          RETURNING idx`,
      )
      .all(holder, at + (opts.ttlMs ?? 30 * 60 * 1000), at, movieId, ORG_ID, idx, at) as { idx: number }[];
    return rows.length > 0;
  }

  /** Give a scene back so it can be retried by this or another holder. */
  releaseScene(movieId: string, idx: number): void {
    this.db
      .prepare(
        `UPDATE scene_jobs SET lease_holder = NULL, lease_expires_at = NULL
          WHERE movie_id = ? AND org_id = ? AND idx = ?`,
      )
      .run(movieId, ORG_ID, idx);
  }

  /** The scenes that still need work, in film order: completed ones are skipped. */
  pendingScenes(movieId: string): number[] {
    const rows = this.db
      .prepare(
        `SELECT idx FROM scene_jobs
          WHERE movie_id = ? AND org_id = ?
            AND status NOT IN ('rendered', 'approved', 'rejected', 'failed', 'blocked')
          ORDER BY idx`,
      )
      .all(movieId, ORG_ID) as { idx: number }[];
    return rows.map(r => r.idx);
  }

  sceneCount(movieId: string): number {
    const row = this.db
      .prepare('SELECT count(*) AS n FROM scene_jobs WHERE movie_id = ? AND org_id = ?')
      .get(movieId, ORG_ID) as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
