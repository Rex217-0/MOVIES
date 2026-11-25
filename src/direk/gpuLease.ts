/**
 * One lease for the whole local GPU.
 *
 * The Movie Creator drives two different local engines — its own ComfyUI on
 * `:8188` and SwarmUI on `:7801` (which runs its own ComfyUI backend on `:7820`).
 * Both saturate the same VRAM, so a SwarmUI image started in the middle of a
 * movie render can push the render out of memory. Nothing in the process used to
 * stop that: each route talked to its own engine and neither knew about the
 * other.
 *
 * This module is the single place that says "the local GPU is busy". The claim is
 * a row in SQLite, not an in-process flag, because the row is the only thing that
 * still exists after a crash: a lease left behind by a dead process can be seen,
 * aged out, and taken over. An in-memory mutex would vanish with the crash and
 * leak the lock forever.
 *
 * Guarantees:
 *   - `claim()` is atomic. Two callers racing for the same GPU cannot both win;
 *     the `UPDATE ... WHERE status = 'free'` decides, not the read before it.
 *   - A lease carries an expiry. A holder that dies stops renewing, and the next
 *     claimant takes over the expired row instead of waiting forever.
 *   - Ownership is checked on release. A later holder cannot be unlocked by an
 *     earlier one finishing late.
 */


import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Where the ledger lives. Shares `factory.db` so there is one file to back up. */
export function gpuLeaseDbPath(): string {
  return process.env.DIREK_FACTORY_DB || path.join(process.cwd(), 'factory.db');
}

/**
 * How long a lease stays valid without a renewal. Long enough for one heavy
 * render step, short enough that a dead process is noticed. A single image can
 * take minutes on CPU, so this is deliberately generous; the point is that it is
 * finite, not that it is short.
 */
export function gpuLeaseTtlMs(): number {
  const raw = Number(process.env.DIREK_GPU_LEASE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60 * 1000;
}

/** Thrown when the GPU is held by someone else. Carries who, so the UI can say so. */
export class GpuBusyError extends Error {
  readonly holder: string;
  readonly expiresAt: number;

  constructor(holder: string, expiresAt: number) {
    super(`Bisib ang local GPU: ginagamit ito ng "${holder}" hanggang ${new Date(expiresAt).toLocaleTimeString()}.`);
    this.name = 'GpuBusyError';
    this.holder = holder;
    this.expiresAt = expiresAt;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gpu_leases (
  resource TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  status TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  renewed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

export interface GpuLease {
  /** Unique per claim, so a late release cannot free a newer lease. */
  token: string;
  resource: string;
  holder: string;
  expiresAt: number;
}

export interface ClaimOptions {
  /** What is asking for the GPU, e.g. `scene 4 — Pelikula`. Shown to the loser. */
  holder: string;
  /** How long to wait for a busy GPU before giving up. 0 means fail fast. */
  waitMs?: number;
  ttlMs?: number;
  now?: () => number;
  /** Poll interval while waiting. Small in tests so they stay fast. */
  pollMs?: number;
}

/** The single resource name. One local GPU, one name, no per-model variants. */
export const GPU_RESOURCE = 'local-gpu';

export class GpuLeaseStore {
  private db: DatabaseSync;

  constructor(file: string = gpuLeaseDbPath()) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    // A lease is only meaningful for seconds; wait instead of failing outright
    // when two writers touch the file at once.
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  private now(opts?: { now?: () => number }): number {
    return (opts?.now ?? Date.now)();
  }

  /**
   * Try once to take the GPU. Returns a lease, or `undefined` when someone else
   * holds a lease that has not expired.
   *
   * The claim and the expiry check are one statement. Reading the row first and
   * updating it after would leave a window where two callers both saw `free`.
   */
  tryClaim(holder: string, opts: { ttlMs?: number; now?: () => number; token?: string } = {}): GpuLease | undefined {
    const at = this.now(opts);
    const ttl = opts.ttlMs ?? gpuLeaseTtlMs();
    const expiresAt = at + ttl;
    const token = opts.token ?? `${process.pid}-${at}-${Math.random().toString(36).slice(2, 10)}`;

    // Seed the row once. `INSERT OR IGNORE` never overwrites a live lease.
    this.db
      .prepare(
        `INSERT OR IGNORE INTO gpu_leases (resource, holder, status, acquired_at, renewed_at, expires_at)
         VALUES (?, '', 'free', ?, ?, ?)`,
      )
      .run(GPU_RESOURCE, at, at, at);

    // Claim, expiry check, and token stamp are ONE statement. A second statement
    // that only added the token would leave a window where the row is held but
    // unidentifiable, and a crash in that window leaks the lock.
    const taken = this.db
      .prepare(
        `UPDATE gpu_leases
            SET status = 'held', holder = ?, acquired_at = ?, renewed_at = ?, expires_at = ?
          WHERE resource = ?
            AND (status = 'free' OR expires_at <= ?)
          RETURNING holder, expires_at`,
      )
      .all(`${holder}#${token}`, at, at, expiresAt, GPU_RESOURCE, at) as { holder: string; expires_at: number }[];

    if (taken.length === 0) return undefined;
    return { token, resource: GPU_RESOURCE, holder, expiresAt };
  }

  /** Who holds the GPU right now, or `undefined` when it is free. */
  current(opts: { now?: () => number } = {}): { holder: string; expiresAt: number; expired: boolean } | undefined {
    const at = this.now(opts);
    const row = this.db
      .prepare(`SELECT holder, status, expires_at FROM gpu_leases WHERE resource = ?`)
      .get(GPU_RESOURCE) as { holder: string; status: string; expires_at: number } | undefined;
    if (!row || row.status !== 'held') return undefined;
    return {
      holder: row.holder.replace(/#.*$/, ''),
      expiresAt: row.expires_at,
      expired: row.expires_at <= at,
    };
  }

  /**
   * Extend a lease this caller still owns. Returns false when it was taken over
   * or has already expired: an expired row is no longer this caller's to extend,
   * because another caller is free to claim it in the same instant.
   */
  renew(lease: GpuLease, opts: { ttlMs?: number; now?: () => number } = {}): boolean {
    const at = this.now(opts);
    const ttl = opts.ttlMs ?? gpuLeaseTtlMs();
    const row = this.db
      .prepare(
        `UPDATE gpu_leases SET renewed_at = ?, expires_at = ?
          WHERE resource = ? AND status = 'held' AND holder = ? AND expires_at > ?
          RETURNING expires_at`,
      )
      .all(at, at + ttl, GPU_RESOURCE, `${lease.holder}#${lease.token}`, at) as { expires_at: number }[];
    if (row.length === 0) return false;
    lease.expiresAt = row[0].expires_at;
    return true;
  }

  /** Free the GPU, but only if this lease is still the one on the row. */
  release(lease: GpuLease, opts: { now?: () => number } = {}): boolean {
    const at = this.now(opts);
    const freed = this.db
      .prepare(
        `UPDATE gpu_leases SET status = 'free', holder = '', renewed_at = ?, expires_at = ?
          WHERE resource = ? AND status = 'held' AND holder = ?
          RETURNING holder`,
      )
      .all(at, at, GPU_RESOURCE, `${lease.holder}#${lease.token}`) as { holder: string }[];
    return freed.length > 0;
  }

  /**
   * Free a GPU held by a process that is gone.
   *
   * The lease is deliberately long (30 min) because a real render can take that
   * long, so a crash leaves the row `held` and every later render waits for a
   * holder that will never release it. A boot is proof that no earlier process
   * of ours is still rendering, so the row is freed here.
   *
   * `alive` is injected so a test can decide, and the real caller passes a PID
   * check. A lease held by a live process is left alone.
   */
  recoverAbandoned(opts: { alive?: (holder: string) => boolean; now?: () => number } = {}): string | undefined {
    const at = this.now(opts);
    const row = this.db
      .prepare(`SELECT holder, status FROM gpu_leases WHERE resource = ?`)
      .get(GPU_RESOURCE) as { holder: string; status: string } | undefined;
    if (!row || row.status !== 'held' || !row.holder) return undefined;
    if (opts.alive?.(row.holder)) return undefined;
    const freed = this.db
      .prepare(
        `UPDATE gpu_leases SET status = 'free', holder = '', renewed_at = ?, expires_at = ?
          WHERE resource = ? AND status = 'held' AND holder = ?
          RETURNING holder`,
      )
      .all(at, at, GPU_RESOURCE, row.holder) as { holder: string }[];
    return freed.length > 0 ? row.holder : undefined;
  }

  close(): void {
    this.db.close();
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Take the GPU, waiting up to `waitMs` for a busy holder to finish.
 *
 * Waiting is the default because the honest failure for a queued image is "it
 * ran a bit later", not "it failed". A caller that would rather fail than wait
 * passes `waitMs: 0`.
 */
export async function acquireGpu(store: GpuLeaseStore, opts: ClaimOptions): Promise<GpuLease> {
  const waitMs = Math.max(0, opts.waitMs ?? 0);
  const pollMs = Math.max(5, opts.pollMs ?? 200);
  const deadline = Date.now() + waitMs;

  for (;;) {
    const lease = store.tryClaim(opts.holder, { ttlMs: opts.ttlMs, now: opts.now });
    if (lease) return lease;
    const holder = store.current({ now: opts.now });
    if (Date.now() >= deadline) {
      throw new GpuBusyError(holder?.holder ?? 'hindi kilala', holder?.expiresAt ?? Date.now());
    }
    await sleep(pollMs);
  }
}

/**
 * Run `work` while holding the GPU, then free it even when `work` throws.
 *
 * This is the wrapper every local generator goes through, so the lease cannot be
 * forgotten on an error path.
 */
export async function withGpu<T>(
  store: GpuLeaseStore,
  opts: ClaimOptions,
  work: (lease: GpuLease) => Promise<T>,
): Promise<T> {
  const lease = await acquireGpu(store, opts);
  // Renew halfway through the TTL so a long render does not expire mid-flight and
  // hand the GPU to a second caller.
  const ttl = opts.ttlMs ?? gpuLeaseTtlMs();
  const timer = setInterval(() => {
    store.renew(lease, { ttlMs: ttl, now: opts.now });
  }, Math.max(1000, Math.floor(ttl / 2)));
  timer.unref?.();
  try {
    return await work(lease);
  } finally {
    clearInterval(timer);
    store.release(lease, { now: opts.now });
  }
}
