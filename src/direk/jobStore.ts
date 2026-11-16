/**
 * Durable job store (Blockers D and I).
 *
 * Movie jobs used to live only in a `Map` in memory: a restart lost every
 * running job, and a phone that slept could not re-attach to a job whose SSE
 * stream had dropped. This store keeps one row per job in SQLite so state
 * survives a restart and the app can re-attach by polling instead of holding one
 * fragile stream open.
 *
 * It uses the built-in `node:sqlite`, so there is no extra dependency. The whole
 * job view is stored as JSON in one column: the shape is the app's own
 * (`MovieJob`), it changes often, and nothing queries into it. That keeps this
 * store small and honest about what it is — a durable record, not a schema.
 */

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'movie',
  status TEXT NOT NULL,
  percent INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_updated ON jobs (updated_at DESC);
`;

/** Where the store lives. `DIREK_JOBS_DB` overrides it (used by tests). */
export function jobsDbPath(): string {
  return process.env.DIREK_JOBS_DB || path.join(process.cwd(), 'factory.db');
}

export interface JobRecord {
  id: string;
  kind: string;
  status: string;
  percent: number;
  stage: string;
  created_at: number;
  updated_at: number;
  ended_at?: number | null;
  data: Record<string, unknown>;
}

export class JobStore {
  private db: DatabaseSync;

  constructor(file: string = jobsDbPath()) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  /** Insert or update one job from its full view object. */
  save(job: { id: string; status: string; percent?: number; stage?: string; startedAt?: number; endedAt?: number } & Record<string, unknown>, kind = 'movie'): void {
    const now = Date.now();
    const createdAt = typeof job.startedAt === 'number' ? job.startedAt : now;
    const endedAt = typeof job.endedAt === 'number' ? job.endedAt : null;
    this.db
      .prepare(
        `INSERT INTO jobs (id, kind, status, percent, stage, created_at, updated_at, ended_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           percent = excluded.percent,
           stage = excluded.stage,
           updated_at = excluded.updated_at,
           ended_at = excluded.ended_at,
           data = excluded.data`,
      )
      .run(
        job.id,
        kind,
        String(job.status ?? 'running'),
        Math.max(0, Math.floor(Number(job.percent) || 0)),
        String(job.stage ?? ''),
        createdAt,
        now,
        endedAt,
        JSON.stringify(job),
      );
  }

  /** One job by id, or null. */
  get(id: string): JobRecord | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as any;
    return row ? rowToRecord(row) : null;
  }

  /** The newest `limit` jobs, newest first. */
  list(limit = 30, kind = 'movie'): JobRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM jobs WHERE kind = ? ORDER BY created_at DESC LIMIT ?')
      .all(kind, Math.max(1, Math.floor(limit))) as any[];
    return rows.map(rowToRecord);
  }

  /**
   * Mark any job still 'running' as interrupted. Called once at startup: a job
   * cannot have survived the process that was running it, so leaving it
   * 'running' would be a lie.
   */
  markInterrupted(): number {
    const stale = this.db
      .prepare("SELECT id FROM jobs WHERE status = 'running'")
      .all() as { id: string }[];
    const stmt = this.db.prepare('SELECT data FROM jobs WHERE id = ?');
    for (const { id } of stale) {
      const row = stmt.get(id) as any;
      if (!row) continue;
      const data = JSON.parse(row.data) as Record<string, unknown>;
      data.status = 'error';
      data.error = 'Nag-restart ang server habang tumatakbo; kailangan ulitin ang job.';
      data.endedAt = Date.now();
      this.save(data as any);
    }
    return stale.length;
  }

  close(): void {
    this.db.close();
  }
}

function rowToRecord(row: any): JobRecord {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(row.data) as Record<string, unknown>;
  } catch {
    data = {};
  }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    percent: row.percent,
    stage: row.stage,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ended_at: row.ended_at ?? null,
    data,
  };
}
