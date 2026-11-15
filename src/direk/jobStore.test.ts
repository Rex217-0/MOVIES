import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from './jobStore.ts';

function tmpStore(): JobStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobstore-'));
  return new JobStore(path.join(dir, 'factory.db'));
}

test('a saved job is readable back with its full view', () => {
  const store = tmpStore();
  store.save({ id: 'MOV-1', status: 'running', percent: 10, stage: 'Simula', startedAt: 1000, brief: 'x' });
  const rec = store.get('MOV-1');
  assert.ok(rec);
  assert.equal(rec!.status, 'running');
  assert.equal(rec!.percent, 10);
  assert.equal(rec!.data.brief, 'x');
  store.close();
});

test('saving the same id updates in place instead of duplicating', () => {
  const store = tmpStore();
  store.save({ id: 'MOV-1', status: 'running', percent: 10, startedAt: 1000 });
  store.save({ id: 'MOV-1', status: 'done', percent: 100, startedAt: 1000, endedAt: 2000 });
  assert.equal(store.list().length, 1);
  assert.equal(store.get('MOV-1')!.status, 'done');
  assert.equal(store.get('MOV-1')!.percent, 100);
  store.close();
});

test('state survives reopening the database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobstore-'));
  const file = path.join(dir, 'factory.db');
  const first = new JobStore(file);
  first.save({ id: 'MOV-1', status: 'done', percent: 100, startedAt: 1000, title: 'Pelikula' });
  first.close();
  const second = new JobStore(file);
  assert.equal(second.get('MOV-1')!.data.title, 'Pelikula');
  second.close();
});

test('markInterrupted flips a running job to an honest error at startup', () => {
  const store = tmpStore();
  store.save({ id: 'RUN', status: 'running', percent: 40, startedAt: 1000 });
  store.save({ id: 'DONE', status: 'done', percent: 100, startedAt: 1000 });
  const flipped = store.markInterrupted();
  assert.equal(flipped, 1);
  assert.equal(store.get('RUN')!.status, 'error');
  assert.match(String(store.get('RUN')!.data.error), /Nag-restart/);
  assert.equal(store.get('DONE')!.status, 'done', 'a finished job is untouched');
  store.close();
});

test('list returns newest first and respects the limit', () => {
  const store = tmpStore();
  store.save({ id: 'A', status: 'done', startedAt: 1000 });
  store.save({ id: 'B', status: 'done', startedAt: 2000 });
  store.save({ id: 'C', status: 'done', startedAt: 3000 });
  const list = store.list(2);
  assert.deepEqual(list.map(j => j.id), ['C', 'B']);
  store.close();
});
