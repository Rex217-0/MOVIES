import test from 'node:test';
import assert from 'node:assert/strict';
import { Quota, dayKey, quotaExceededMessage } from './quota.ts';

const DAY1 = Date.UTC(2026, 0, 2, 12, 0, 0);
const DAY2 = Date.UTC(2026, 0, 3, 1, 0, 0);

test('a quota counts units and refuses past the limit without overspending', () => {
  const q = new Quota({ limit: 3 });
  assert.equal(q.consume('k', 1, DAY1).allowed, true);
  assert.equal(q.consume('k', 1, DAY1).allowed, true);
  assert.equal(q.consume('k', 1, DAY1).allowed, true);
  const refused = q.consume('k', 1, DAY1);
  assert.equal(refused.allowed, false);
  assert.equal(refused.used, 3, 'a refused call does not increment');
  assert.equal(refused.remaining, 0);
});

test('a quota resets on a new day and keys are independent', () => {
  const q = new Quota({ limit: 1 });
  assert.equal(q.consume('a', 1, DAY1).allowed, true);
  assert.equal(q.consume('a', 1, DAY1).allowed, false);
  assert.equal(q.consume('b', 1, DAY1).allowed, true, 'another key has its own bucket');
  assert.equal(q.consume('a', 1, DAY2).allowed, true, 'a new day resets the bucket');
});

test('limit 0 means unlimited', () => {
  const q = new Quota({ limit: 0 });
  for (let i = 0; i < 100; i++) assert.equal(q.consume('k', 1, DAY1).allowed, true);
  assert.equal(q.peek('k', DAY1).remaining, Number.POSITIVE_INFINITY);
});

test('peek never consumes', () => {
  const q = new Quota({ limit: 2 });
  assert.equal(q.peek('k', DAY1).used, 0);
  assert.equal(q.peek('k', DAY1).used, 0);
  q.consume('k', 1, DAY1);
  assert.equal(q.peek('k', DAY1).used, 1);
});

test('prune drops old days and the message is honest', () => {
  const q = new Quota({ limit: 1 });
  q.consume('a', 1, DAY1);
  q.prune(DAY2);
  assert.equal(q.peek('a', DAY2).used, 0);
  const state = q.consume('b', 2, DAY2);
  assert.equal(state.allowed, false);
  assert.match(quotaExceededMessage(state), /Ubos na ang daily quota/);
});

test('dayKey is the UTC day', () => {
  assert.equal(dayKey(Date.UTC(2026, 5, 7, 23, 59)), '2026-06-07');
});
