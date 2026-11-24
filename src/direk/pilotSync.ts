/**
 * Accepting the Kaggle worker's URL at runtime.
 *
 * The quick Cloudflare tunnel hands out a new hostname on every Kaggle run, so
 * the URL cannot live only in a deploy-time environment variable. This module
 * validates a URL the notebook reports and saves it, so the operator does not
 * have to redeploy for each session.
 *
 * Validation is strict on purpose: the app will POST screenplays to whatever
 * this URL points at, so a value that reaches an internal address would turn
 * the app into a request proxy for the private network. Only a public HTTPS
 * hostname is accepted.
 */

import net from 'node:net';
import type { Firestore } from 'firebase-admin/firestore';
import { adminReady, initFirebaseAdmin } from '../lib/firebaseAdmin.ts';
import { readSettings, writeSettings, type DirekSettings } from './settings.ts';

/** The longest URL we will store. A tunnel hostname is far shorter. */
const MAX_URL_LENGTH = 2000;

export type PilotUrlCheck =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/** Why a host may not be used, or null when it is acceptable. */
function isForbiddenHost(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return 'localhost';
  if (host.endsWith('.internal') || host.endsWith('.local')) return 'an internal name';

  const family = net.isIP(host);
  if (family === 0) return null;

  if (family === 6) {
    if (host === '::1' || host === '::') return 'loopback';
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return 'private';
    if (/^fe[89ab][0-9a-f]:/.test(host)) return 'link-local';
    // An IPv4-mapped address is judged by its IPv4 part.
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isForbiddenHost(mapped[1]) : null;
  }

  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    return 'not an IP address';
  }
  const [a, b] = parts;
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 169 && b === 254) return 'link-local';
  // 100.64.0.0/10 is CGNAT, which is what Tailscale hands out. It is not
  // reported as private, so it needs its own check.
  if (a === 100 && b >= 64 && b <= 127) return 'CGNAT/Tailscale';
  if (a === 0) return 'unspecified';
  if (a >= 224) return 'multicast or reserved';
  return null;
}

/**
 * Validate a reported tunnel URL. Returns the cleaned URL (origin only, no
 * trailing slash) or the reason it was refused.
 */
export function checkPilotUrl(raw: unknown): PilotUrlCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'URL must be a string.' };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'URL is empty.' };
  if (trimmed.length > MAX_URL_LENGTH) return { ok: false, reason: 'URL is too long.' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'Not a valid URL.' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: `Only https is accepted, not ${parsed.protocol.replace(':', '')}.` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'A URL must not carry credentials.' };
  }

  const forbidden = isForbiddenHost(parsed.hostname);
  if (forbidden) {
    return { ok: false, reason: `The host is ${forbidden}; a public hostname is required.` };
  }

  // Keep only the origin. A path or query on the tunnel base would be pasted
  // onto every endpoint call and silently break the contract.
  return { ok: true, url: parsed.origin };
}

/**
 * Where the last reported URL is kept when Firestore is available.
 *
 * A single document, not a collection: there is one worker, and the notebook
 * overwrites it on each run. `reported_at` lets the UI say how stale it is.
 */
const PILOT_DOC = { collection: 'direk_pilot', document: 'kaggle' } as const;

/** The Firestore handle, or null when credentials are absent. */
function firestore(): Firestore | null {
  if (!adminReady()) return null;
  try {
    return initFirebaseAdmin();
  } catch {
    return null;
  }
}

/**
 * Save a validated pilot URL and apply it to the running process, so the next
 * screenplay call uses it without a restart.
 *
 * The URL is written to both stores on purpose. Firestore is the one that
 * survives a restart, which is what makes this work on a host without a
 * persistent disk. The settings file stays as the offline path (and the one
 * unit tests can drive), so a local Server-2 box behaves exactly as before.
 */
export async function savePilotUrl(url: string): Promise<DirekSettings> {
  const merged: DirekSettings = { ...readSettings(), kaggle_pilot_url: url };
  writeSettings(merged);
  process.env.KAGGLE_PILOT_URL = url;

  const db = firestore();
  if (db) {
    // A failed write must not fail the request: the URL is already applied to
    // the live process, so the worker still works for this session. The caller
    // learns about it through `durable`.
    try {
      await db
        .collection(PILOT_DOC.collection)
        .doc(PILOT_DOC.document)
        .set({ url, reported_at: new Date().toISOString() });
    } catch {
      /* reported through durablePilotUrl() */
    }
  }
  return merged;
}

/** Whether the pilot URL survives a restart on this host. */
export function pilotUrlDurable(): boolean {
  return adminReady();
}

/**
 * Read the saved URL back on startup.
 *
 * The container filesystem is wiped on every deploy and spin-down, so a URL
 * that only ever lived in `direk.config.json` is gone by the time the app comes
 * back. Reading it from Firestore here is what lets the notebook sync once and
 * keep working across restarts.
 *
 * A real environment variable always wins: an operator who pinned
 * `KAGGLE_PILOT_URL` must not be overridden by an older saved value.
 */
export async function restorePilotUrl(): Promise<string | null> {
  if ((process.env.KAGGLE_PILOT_URL || '').trim()) return null;
  const db = firestore();
  if (!db) return null;

  try {
    const snap = await db.collection(PILOT_DOC.collection).doc(PILOT_DOC.document).get();
    const raw = snap.exists ? (snap.data()?.url as unknown) : null;
    // Re-validate on the way out: a stored value is not automatically trusted,
    // and an old entry may predate a tightened check.
    const check = checkPilotUrl(raw);
    if (!check.ok) return null;
    process.env.KAGGLE_PILOT_URL = check.url;
    const merged: DirekSettings = { ...readSettings(), kaggle_pilot_url: check.url };
    writeSettings(merged);
    return check.url;
  } catch {
    return null;
  }
}
