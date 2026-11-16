/**
 * Usage quota (Blocker B).
 *
 * The free tier is not unlimited. One shared key with a daily cap means a single
 * user (or one big film) exhausts it and everyone else gets 429s from Google.
 * This module makes that cost visible and bounded *before* a call is made, so
 * the app fails honestly with its own message instead of surfacing a raw 429.
 *
 * It is a per-key, per-day counter. It does not replace real accounts (see the
 * plan, risk B); it is the honest floor: no silent overspend, and the UI can see
 * what is left. The clock is injectable so the behaviour is testable.
 */

export interface QuotaState {
  key: string;
  day: string;
  used: number;
  limit: number;
  remaining: number;
  /** Whether the next unit of work may proceed. */
  allowed: boolean;
}

/** The UTC day bucket, `YYYY-MM-DD`. */
export function dayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export interface QuotaOptions {
  /** Units allowed per key per day. 0 or negative means unlimited. */
  limit?: number;
}

export class Quota {
  private readonly buckets = new Map<string, { day: string; used: number }>();
  private readonly limit: number;

  constructor(options: QuotaOptions = {}) {
    this.limit = Number.isFinite(options.limit) ? Number(options.limit) : 0;
  }

  /** Current state for a key without consuming anything. */
  peek(key: string, now = Date.now()): QuotaState {
    const day = dayKey(now);
    const bucket = this.buckets.get(key);
    const used = bucket && bucket.day === day ? bucket.used : 0;
    const unlimited = this.limit <= 0;
    return {
      key,
      day,
      used,
      limit: this.limit,
      remaining: unlimited ? Number.POSITIVE_INFINITY : Math.max(0, this.limit - used),
      allowed: unlimited || used < this.limit,
    };
  }

  /**
   * Consume one unit. Returns the new state; `allowed: false` means the caller
   * must refuse the work rather than spend. A refused call does not increment.
   */
  consume(key: string, units = 1, now = Date.now()): QuotaState {
    const day = dayKey(now);
    const unlimited = this.limit <= 0;
    const bucket = this.buckets.get(key);
    const used = bucket && bucket.day === day ? bucket.used : 0;
    if (!unlimited && used + units > this.limit) {
      this.buckets.set(key, { day, used });
      return {
        key,
        day,
        used,
        limit: this.limit,
        remaining: Math.max(0, this.limit - used),
        allowed: false,
      };
    }
    const next = used + units;
    this.buckets.set(key, { day, used: next });
    return {
      key,
      day,
      used: next,
      limit: this.limit,
      remaining: unlimited ? Number.POSITIVE_INFINITY : Math.max(0, this.limit - next),
      allowed: true,
    };
  }

  /** Drop buckets from earlier days so the map cannot grow without bound. */
  prune(now = Date.now()): void {
    const day = dayKey(now);
    for (const [key, bucket] of this.buckets) {
      if (bucket.day !== day) this.buckets.delete(key);
    }
  }
}

/** The honest message a refused call gets, for the UI. */
export function quotaExceededMessage(state: QuotaState): string {
  return `Ubos na ang daily quota (${state.used}/${state.limit}) para sa ${state.day}. Subukan bukas, o i-set ang mas mataas na limit.`;
}
