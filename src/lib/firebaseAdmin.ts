/**
 * Firebase Admin bootstrap.
 *
 * Credentials are read from the environment only, never from a file in the repo.
 * Two shapes are accepted:
 *   1. `FIREBASE_SERVICE_ACCOUNT` — the whole service-account JSON on one line.
 *      A value pasted from a terminal or a hosting dashboard usually has its
 *      newlines escaped as a literal `\n`, which makes the PEM unparseable, so
 *      those are unescaped here.
 *   2. `FIREBASE_PROJECT_ID` + `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`.
 *
 * When neither is present, `adminReady()` is false and callers fall back to the
 * local SQLite store. Nothing throws at import time: a missing credential is a
 * normal state on an offline box, not a startup failure.
 */

import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { sanitizeError } from './secrets.ts';

export type FirebaseState = 'active' | 'standby';

interface Credentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

/** A PEM that survived a round-trip through an env var. */
function normalizePrivateKey(key: string): string {
  // Order matters: a doubly-escaped key is rare but appears when JSON is pasted
  // into a shell. Unescape the literal backslash-n pairs, then fix CRLF.
  return key.replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim();
}

/**
 * A downloaded service-account file uses snake_case (`project_id`,
 * `client_email`, `private_key`). Reading only camelCase rejected every real
 * key Google issues, which silently dropped the app onto the ephemeral SQLite
 * store and erased the conversation on each restart. Both spellings are
 * accepted so either a pasted file or a hand-built object works.
 */
function fromServiceAccountJson(raw: string): Credentials | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pick = (...names: string[]): string => {
      for (const name of names) {
        const value = parsed[name];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
      return '';
    };
    const projectId = pick('project_id', 'projectId');
    const clientEmail = pick('client_email', 'clientEmail');
    const privateKey = pick('private_key', 'privateKey');
    if (!projectId || !clientEmail || !privateKey) return null;
    return { projectId, clientEmail, privateKey: normalizePrivateKey(privateKey) };
  } catch {
    return null;
  }
}

function fromSplitEnv(): Credentials | null {
  const projectId = (process.env.FIREBASE_PROJECT_ID || '').trim();
  const clientEmail = (process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').trim();
  if (!projectId || !clientEmail || !privateKey) return null;
  return { projectId, clientEmail, privateKey: normalizePrivateKey(privateKey) };
}

function resolveCredentials(): Credentials | null {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (raw) {
    const fromJson = fromServiceAccountJson(raw);
    if (fromJson) return fromJson;
    // A malformed JSON blob must not silently fall through to the split vars:
    // that would hide the operator's real mistake.
    console.warn('[FIREBASE] FIREBASE_SERVICE_ACCOUNT is set but is not valid service-account JSON.');
    return null;
  }
  return fromSplitEnv();
}

let app: App | null = null;
let firestore: Firestore | null = null;
let initialized = false;
let lastError: string | null = null;

/**
 * Initialise once. Safe to call on every request: after the first attempt the
 * result is cached, including a failure, so a bad credential is not retried on
 * every chat turn.
 */
export function initFirebaseAdmin(): Firestore | null {
  if (initialized) return firestore;
  initialized = true;

  const credentials = resolveCredentials();
  if (!credentials) {
    lastError = null;
    return null;
  }

  try {
    // Reuse an app another module may already have created.
    const existing = getApps();
    app = existing.length > 0 ? existing[0]! : initializeApp({
      credential: cert({
        projectId: credentials.projectId,
        clientEmail: credentials.clientEmail,
        privateKey: credentials.privateKey,
      }),
    });
    firestore = getFirestore(app);
    lastError = null;
    return firestore;
  } catch (error: any) {
    lastError = sanitizeError(error);
    console.error(`[FIREBASE] Hindi ma-initialize ang Admin SDK: ${lastError}`);
    app = null;
    firestore = null;
    return null;
  }
}

/** True when Firestore is usable right now. */
export function adminReady(): boolean {
  return initFirebaseAdmin() !== null;
}

/** `active` when Firestore is usable, `standby` when the SQLite fallback is in play. */
export function firebaseState(): FirebaseState {
  return adminReady() ? 'active' : 'standby';
}

/** Why initialisation failed, scrubbed. Null when it never failed. */
export function firebaseLastError(): string | null {
  return lastError;
}

/** The project the Admin SDK is pointed at, for status output. Never the key. */
export function firebaseProjectId(): string | null {
  return resolveCredentials()?.projectId ?? null;
}

/** Test seam: forget the cached attempt so the next call re-reads the env. */
export function resetFirebaseAdmin(): void {
  initialized = false;
  app = null;
  firestore = null;
  lastError = null;
}
