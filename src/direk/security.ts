/**
 * Edge hardening (Blocker E).
 *
 * The app is meant to sit behind HTTPS on a public host and be reached by a
 * phone on a mobile network. That makes three things mandatory that the original
 * server did not have: security headers, a CORS allow-list (so a random site
 * cannot call the billable API with a stolen token), and rate limiting (so one
 * client cannot exhaust the shared free tier or hammer a worker).
 *
 * It also removes the long-lived token from the URL: the SSE thought stream
 * cannot send headers, so instead of `?token=<the real token>` the browser first
 * asks for a short-lived, single-purpose ticket and puts *that* in the URL. A
 * ticket that leaks from a log or history expires in a minute and cannot be used
 * for any other route.
 *
 * Everything here is pure and injectable so it is unit-testable without a real
 * socket.
 */

import crypto from 'node:crypto';

/** Response headers that are safe for this app. */
export function securityHeaders(): Record<string, string> {
  return {
    // Never let a browser guess a content type for a served render or asset.
    'X-Content-Type-Options': 'nosniff',
    // The UI is only ever framed by itself.
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-XSS-Protection': '0',
    // The app is a remote for a private box; no powerful browser features.
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    // HSTS only makes sense over TLS; harmless on http and correct behind a proxy.
    'Strict-Transport-Security': 'max-age=15552000; includeSubDomains',
  };
}

export interface CorsDecision {
  /** Whether the origin may call the API. */
  allowed: boolean;
  /** Headers to echo back, if allowed. */
  headers: Record<string, string>;
}

/**
 * The origins that serve this very app. A browser sends an `Origin` header for
 * `type="module"` scripts and for `fetch`, so the app's own host is a
 * cross-origin caller of itself as far as the guard can tell. Without these a
 * strict allow-list 403s `/assets/*` and the page renders blank.
 *
 * Only the request's own Host is echoed, so a foreign origin cannot smuggle
 * itself in by sending a crafted `Origin`.
 */
export function selfOrigins(host: string | undefined): string[] {
  if (!host) return [];
  const bare = host.replace(/:\d+$/, '');
  return [`https://${host}`, `http://${host}`, `https://${bare}`, `http://${bare}`];
}

/**
 * Decide whether a browser origin may call the API. A same-origin call (no
 * Origin header) is always fine. A cross-origin call must be in the allow-list.
 * `*` in the list allows any origin (only sane for a local/LAN deployment).
 */
export function corsDecision(origin: string | undefined, allowedOrigins: string[]): CorsDecision {
  if (!origin) return { allowed: true, headers: {} };
  const allowed =
    allowedOrigins.includes('*') || allowedOrigins.includes(origin);
  if (!allowed) return { allowed: false, headers: {} };
  return {
    allowed: true,
    headers: {
      'Access-Control-Allow-Origin': allowedOrigins.includes('*') ? '*' : origin,
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    },
  };
}

export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in the current window. */
  remaining: number;
  /** Seconds until the window resets. */
  retryAfter: number;
}

/**
 * A fixed-window rate limiter, keyed per client. A fixed window is deliberate:
 * it is simple, cheap, and good enough to stop one client exhausting a shared
 * quota. The clock is injectable so the behaviour is testable.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  check(key: string, now = Date.now()): RateLimitResult {
    const existing = this.windows.get(key);
    if (!existing || now >= existing.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, remaining: this.limit - 1, retryAfter: 0 };
    }
    if (existing.count >= this.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      };
    }
    existing.count += 1;
    return { allowed: true, remaining: this.limit - existing.count, retryAfter: 0 };
  }

  /** Drop expired windows so the map cannot grow without bound. */
  prune(now = Date.now()): void {
    for (const [key, win] of this.windows) {
      if (now >= win.resetAt) this.windows.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Stream tickets: keep the long-lived token out of the URL.
// ---------------------------------------------------------------------------

export interface Ticket {
  value: string;
  expiresAt: number;
}

/**
 * Issue a short-lived ticket bound to one purpose. The value is an HMAC over
 * `purpose:expiry`, so it cannot be forged without the secret and cannot be
 * replayed after it expires. It is useless for any other route.
 */
export function issueTicket(secret: string, purpose: string, ttlMs = 60_000, now = Date.now()): Ticket {
  const expiresAt = now + ttlMs;
  const value = crypto
    .createHmac('sha256', secret)
    .update(`${purpose}:${expiresAt}`)
    .digest('base64url');
  return { value, expiresAt };
}

/** Verify a ticket: right purpose, right signature, not expired. */
export function verifyTicket(
  secret: string,
  purpose: string,
  value: string,
  expiresAt: number,
  now = Date.now(),
): boolean {
  if (!value || !Number.isFinite(expiresAt) || now > expiresAt) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${purpose}:${expiresAt}`)
    .digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(value));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** A compact ticket string for a URL: `value.expiresAt`. */
export function ticketToParam(ticket: Ticket): string {
  return `${ticket.value}.${ticket.expiresAt}`;
}

/** Parse `value.expiresAt`; null when malformed. */
export function paramToTicket(param: string): { value: string; expiresAt: number } | null {
  const idx = String(param || '').lastIndexOf('.');
  if (idx <= 0) return null;
  const value = param.slice(0, idx);
  const expiresAt = Number(param.slice(idx + 1));
  if (!value || !Number.isFinite(expiresAt)) return null;
  return { value, expiresAt };
}
