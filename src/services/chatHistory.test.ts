import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendTurn,
  loadHistory,
  loadContextMessages,
  historyStore,
  historyStatus,
  closeChatHistoryDb,
  HISTORY_LIMIT,
} from './chatHistory.ts';

/**
 * These tests exercise the real SQLite path, which is what runs on an offline
 * box and in the sandbox. No Firebase credentials are present here, so the
 * fallback is the code under test — not a mock of it.
 */

function freshDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-history-'));
  const file = path.join(dir, 'factory.db');
  closeChatHistoryDb();
  process.env.DIREK_FACTORY_DB = file;
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  delete process.env.FIREBASE_PROJECT_ID;
  delete process.env.FIREBASE_CLIENT_EMAIL;
  delete process.env.FIREBASE_PRIVATE_KEY;
  return file;
}

test('appendTurn writes a real row pair into factory.db', async () => {
  const file = freshDb();
  const result = await appendTurn('thread-a', 'kumusta', 'mabuti naman');

  assert.equal(result.persisted, true);
  assert.equal(result.store, 'sqlite');
  assert.equal(result.threadId, 'thread-a');
  assert.ok(fs.existsSync(file), 'factory.db should exist on disk');
  closeChatHistoryDb();
});

test('loadHistory returns turns oldest first', async () => {
  freshDb();
  await appendTurn('t1', 'una', 'sagot-una');
  await new Promise(r => setTimeout(r, 2));
  await appendTurn('t1', 'pangalawa', 'sagot-pangalawa');

  const turns = await loadHistory('t1');
  assert.equal(turns.length, 4);
  assert.equal(turns[0]!.role, 'user');
  assert.equal(turns[0]!.content, 'una');
  assert.equal(turns[1]!.content, 'sagot-una');
  assert.equal(turns[3]!.content, 'sagot-pangalawa');
  closeChatHistoryDb();
});

test('threads do not leak into each other', async () => {
  freshDb();
  await appendTurn('alpha', 'a-user', 'a-assistant');
  await appendTurn('beta', 'b-user', 'b-assistant');

  const alpha = await loadHistory('alpha');
  const beta = await loadHistory('beta');
  assert.equal(alpha.length, 2);
  assert.equal(beta.length, 2);
  assert.ok(alpha.every(t => t.threadId === 'alpha'));
  assert.ok(beta.every(t => t.threadId === 'beta'));
  closeChatHistoryDb();
});

test('loadContextMessages caps at the limit and keeps reading order', async () => {
  freshDb();
  for (let i = 0; i < 15; i += 1) {
    await appendTurn('cap', `user-${i}`, `assistant-${i}`);
    await new Promise(r => setTimeout(r, 1));
  }

  const context = await loadContextMessages('cap', 20);
  assert.equal(context.length, 20, '20 messages is the cap for 10 turns');
  // The newest message must be last, the oldest kept must be first.
  assert.equal(context[context.length - 1]!.content, 'assistant-14');

  const narrow = await loadContextMessages('cap', 4);
  assert.equal(narrow.length, 4);
  assert.equal(narrow[3]!.content, 'assistant-14');
  closeChatHistoryDb();
});

test('an unknown thread returns an empty list, not an error', async () => {
  freshDb();
  assert.deepEqual(await loadHistory('wala'), []);
  assert.deepEqual(await loadContextMessages('wala'), []);
  closeChatHistoryDb();
});

test('a blank thread id falls back to the default thread', async () => {
  freshDb();
  const result = await appendTurn('', 'hi', 'hello');
  assert.equal(result.threadId, 'default');
  const turns = await loadHistory('');
  assert.equal(turns.length, 2);
  closeChatHistoryDb();
});

test('the store reports sqlite when Firebase is not configured', () => {
  freshDb();
  assert.equal(historyStore(), 'sqlite');
  const status = historyStatus();
  assert.equal(status.firebase, 'standby');
  assert.equal(status.limit, HISTORY_LIMIT);
  assert.ok(status.db_file.endsWith('factory.db'));
  closeChatHistoryDb();
});
