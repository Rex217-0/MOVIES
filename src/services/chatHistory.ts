/**
 * Chat history for Director's Chair.
 *
 * One API, two stores:
 *   - Firestore when Firebase Admin credentials are present.
 *     `direk_chat_history/{threadId}/turns/{turnId}`
 *   - `factory.db` (`node:sqlite`) otherwise, in `direk_chat_turns`.
 *
 * Both paths answer the same three calls, so the route layer never branches on
 * which store is live. The SQLite path is what runs on an offline Server-2 box
 * and in unit tests, and it is a real store, not a stub.
 *
 * Two deliberate constraints keep Firestore free-tier friendly:
 *   - No `onSnapshot` listeners. The page asks once on load, and every write
 *     already returns what was written.
 *   - Only single-field ordering (`createdAt desc`), which needs no composite
 *     index. Adding a `where` next to that order would need one.
 */

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { adminReady, initFirebaseAdmin, firebaseState, firebaseLastError } from '../lib/firebaseAdmin.ts';
import { sanitizeError } from '../lib/secrets.ts';

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface StoredTurn {
  turnId: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface AppendResult {
  threadId: string;
  turnId: string;
  persisted: boolean;
  store: 'firestore' | 'sqlite';
}

/** How many turns the UI restores and how much context the router receives. */
export const HISTORY_LIMIT = 20;

function dbFile(): string {
  return (process.env.DIREK_FACTORY_DB || '').trim() || path.join(process.cwd(), 'factory.db');
}

let sqlite: DatabaseSync | null = null;

/**
 * The local store. Opened once per process and kept open, the same way
 * `FactoryDb` holds its handle.
 */
function localDb(): DatabaseSync {
  if (sqlite) return sqlite;
  const file = dbFile();
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS direk_chat_turns (
      turn_id    TEXT PRIMARY KEY,
      thread_id  TEXT NOT NULL,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_direk_chat_turns_thread
      ON direk_chat_turns (thread_id, created_at DESC);
  `);
  sqlite = db;
  return db;
}

/** Test seam: close the handle so a fresh temp directory can be used. */
export function closeChatHistoryDb(): void {
  if (sqlite) {
    try {
      sqlite.close();
    } catch {
      // Closing a handle twice is not an error worth surfacing.
    }
  }
  sqlite = null;
}

/** Which store `appendTurn` would use right now. */
export function historyStore(): 'firestore' | 'sqlite' {
  return adminReady() ? 'firestore' : 'sqlite';
}

export function historyStatus(): {
  store: 'firestore' | 'sqlite';
  firebase: 'active' | 'standby';
  /**
   * True only for a store that survives a redeploy. The free Render plan has no
   * persistent disk, so SQLite lives in the container layer and is discarded on
   * every restart — a conversation kept there is lost without any error.
   */
  durable: boolean;
  firebase_error: string | null;
  limit: number;
  db_file: string;
} {
  const store = historyStore();
  return {
    store,
    firebase: firebaseState(),
    durable: store === 'firestore',
    firebase_error: firebaseLastError(),
    limit: HISTORY_LIMIT,
    db_file: dbFile(),
  };
}

/**
 * A strictly increasing timestamp for every stored row.
 *
 * The user message and the assistant reply are written in the same millisecond,
 * so an equal `createdAt` would leave their order to the store's tiebreaker —
 * and Firestore and SQLite do not agree on one. Bumping by a millisecond per
 * write makes `createdAt desc` a total order, which is what lets both stores use
 * single-field ordering and still return a conversation in reading order.
 */
let lastStamp = 0;
function nextStamp(): string {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return new Date(lastStamp).toISOString();
}

function newTurnId(): string {
  // A Firestore document id cannot contain a slash, and this keeps both stores
  // on the same shape.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function threadRef(threadId: string) {
  return initFirebaseAdmin()!.collection('direk_chat_history').doc(threadId);
}

/**
 * Save one exchange as a single atomic write.
 *
 * A turn is the user message plus the assistant reply, so a half-saved
 * conversation cannot happen: either both documents and the thread metadata
 * land, or none do.
 */
export async function appendTurn(
  threadId: string,
  userMessage: string,
  assistantMessage: string,
): Promise<AppendResult> {
  const thread = (threadId || '').trim() || 'default';
  const turnId = newTurnId();

  const rows: StoredTurn[] = [
    { turnId: `${turnId}-u`, threadId: thread, role: 'user', content: userMessage, createdAt: nextStamp() },
    { turnId: `${turnId}-a`, threadId: thread, role: 'assistant', content: assistantMessage, createdAt: nextStamp() },
  ];
  const createdAt = rows[1]!.createdAt;

  if (adminReady()) {
    const db = initFirebaseAdmin()!;
    try {
      const batch = db.batch();
      for (const row of rows) {
        batch.set(threadRef(thread).collection('turns').doc(row.turnId), {
          role: row.role,
          content: row.content,
          createdAt: row.createdAt,
        });
      }
      batch.set(
        threadRef(thread),
        { threadId: thread, updatedAt: createdAt, lastTurnId: turnId, turnCount: rows.length },
        { merge: true },
      );
      await batch.commit();
      return { threadId: thread, turnId, persisted: true, store: 'firestore' };
    } catch (error: any) {
      // A Firestore outage must not lose the conversation. Fall through to the
      // local store rather than failing the request that already has a reply.
      console.error(`[CHAT HISTORY] Firestore write failed, using SQLite: ${sanitizeError(error)}`);
    }
  }

  const db = localDb();
  const insert = db.prepare(
    'INSERT OR REPLACE INTO direk_chat_turns (turn_id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      insert.run(row.turnId, row.threadId, row.role, row.content, row.createdAt);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { threadId: thread, turnId, persisted: true, store: 'sqlite' };
}

/**
 * Delete every turn in one thread. Only ever called from an explicit user
 * action — nothing in the server loop clears a conversation on its own.
 */
export async function clearThread(threadId: string): Promise<{ deleted: number; store: 'firestore' | 'sqlite' }> {
  const thread = (threadId || '').trim() || 'default';

  if (adminReady()) {
    try {
      const ref = threadRef(thread);
      let deleted = 0;
      // Batched: Firestore caps a single commit at 500 writes.
      for (;;) {
        const snap = await ref.collection('turns').limit(400).get();
        if (snap.empty) break;
        const batch = ref.firestore.batch();
        for (const doc of snap.docs) batch.delete(doc.ref);
        await batch.commit();
        deleted += snap.size;
      }
      await ref.delete().catch(() => {});
      return { deleted, store: 'firestore' };
    } catch (error: any) {
      console.error(`[CHAT HISTORY] Firestore clear failed, using SQLite: ${sanitizeError(error)}`);
    }
  }

  const result = localDb()
    .prepare('DELETE FROM direk_chat_turns WHERE thread_id = ?')
    .run(thread);
  return { deleted: Number(result.changes ?? 0), store: 'sqlite' };
}

/**
 * The newest `limit` turns for a thread, oldest first.
 *
 * Ordering is `createdAt desc` to get the newest slice, then reversed so the
 * caller receives a conversation in reading order.
 */
export async function loadHistory(threadId: string, limit: number = HISTORY_LIMIT): Promise<StoredTurn[]> {
  const thread = (threadId || '').trim() || 'default';
  const take = Math.min(Math.max(Number(limit) || HISTORY_LIMIT, 1), 200);

  if (adminReady()) {
    try {
      const snap = await threadRef(thread)
        .collection('turns')
        .orderBy('createdAt', 'desc')
        .limit(take)
        .get();
      return snap.docs
        .map((doc) => {
          const data = doc.data() as any;
          return {
            turnId: doc.id,
            threadId: thread,
            role: data.role === 'assistant' ? 'assistant' : 'user',
            content: String(data.content ?? ''),
            createdAt: String(data.createdAt ?? ''),
          } as StoredTurn;
        })
        .reverse();
    } catch (error: any) {
      console.error(`[CHAT HISTORY] Firestore read failed, using SQLite: ${sanitizeError(error)}`);
    }
  }

  const rows = localDb()
    .prepare(
      'SELECT turn_id, thread_id, role, content, created_at FROM direk_chat_turns WHERE thread_id = ? ORDER BY created_at DESC, turn_id DESC LIMIT ?',
    )
    .all(thread, take) as any[];

  return rows
    .map((row): StoredTurn => ({
      turnId: String(row.turn_id),
      threadId: String(row.thread_id),
      role: row.role === 'assistant' ? 'assistant' : 'user',
      content: String(row.content),
      createdAt: String(row.created_at),
    }))
    .reverse();
}

/**
 * The last `limit` messages to hand the router as context.
 *
 * This is the whole point of storing turns: the model sees recent history
 * without the caller resending an unbounded transcript.
 */
export async function loadContextMessages(
  threadId: string,
  limit: number = HISTORY_LIMIT,
): Promise<HistoryTurn[]> {
  const turns = await loadHistory(threadId, limit);
  return turns.map((turn) => ({ role: turn.role, content: turn.content }));
}
