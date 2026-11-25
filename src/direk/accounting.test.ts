/**
 * Tests for operational accounting.
 *
 * The point of this module is that it never invents a number. A price we do not
 * know is recorded as unknown, not as zero; a call that never left the machine
 * is not counted as a vendor call; and a film that made one metered call is not
 * described as having no vendor cost. Each case pins one of those rules.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addCost,
  costBasisForEngine,
  dominantCostBasis,
  emptyAccounting,
  meteredCost,
  sceneAccounting,
  sumAccounting,
  unknownCost,
  COST_BASIS_LABEL,
  COST_BASIS_NOTE,
} from './accounting.ts';
import { countExternalCall, externalCallCount, withExternalCallCounter } from './externalCalls.ts';

test('local engines carry no vendor cost, third parties are free tier, fal is metered', () => {
  assert.equal(costBasisForEngine('comfyui'), 'NO_VENDOR_CALL_COST');
  assert.equal(costBasisForEngine('motion'), 'NO_VENDOR_CALL_COST');
  assert.equal(costBasisForEngine('ffmpeg'), 'NO_VENDOR_CALL_COST');
  assert.equal(costBasisForEngine('ollama'), 'NO_VENDOR_CALL_COST');

  assert.equal(costBasisForEngine('stock'), 'THIRD_PARTY_FREE_TIER');
  assert.equal(costBasisForEngine('pollinations'), 'THIRD_PARTY_FREE_TIER');

  assert.equal(costBasisForEngine('wan'), 'VENDOR_METERED');
  assert.equal(costBasisForEngine('fal'), 'VENDOR_METERED');
});

test('an engine nobody classified is UNKNOWN, not quietly free', () => {
  assert.equal(costBasisForEngine('some-new-vendor'), 'UNKNOWN');
  assert.equal(costBasisForEngine(''), 'UNKNOWN');
  // Every basis has a label and a note, so the UI never shows a bare code.
  for (const basis of ['NO_VENDOR_CALL_COST', 'THIRD_PARTY_FREE_TIER', 'VENDOR_METERED', 'UNKNOWN'] as const) {
    assert.ok(COST_BASIS_LABEL[basis].length > 0);
    assert.ok(COST_BASIS_NOTE[basis].length > 0);
    assert.notEqual(COST_BASIS_LABEL[basis], 'FREE');
  }
});

test('a local render costs nothing to a vendor and says so', () => {
  const a = sceneAccounting({
    engine: 'comfyui',
    seconds: 60,
    durationMs: 1234.6,
    storageBytes: 4096,
    externalApiCalls: 0,
  });
  assert.equal(a.costBasis, 'NO_VENDOR_CALL_COST');
  assert.equal(a.renderDurationMs, 1235, 'duration is rounded to whole milliseconds');
  assert.equal(a.externalApiCalls, 0);
  assert.equal(a.storageBytes, 4096);
  assert.equal(a.cloudCost.amount, 0);
  assert.equal(a.cloudCost.confidence, 'none');
  assert.deepEqual(a.engines, ['comfyui']);
});

test('a metered render without a configured rate records unknown, never zero', (t) => {
  const previous = process.env.FAL_USD_PER_SECOND;
  delete process.env.FAL_USD_PER_SECOND;
  t.after(() => {
    if (previous === undefined) delete process.env.FAL_USD_PER_SECOND;
    else process.env.FAL_USD_PER_SECOND = previous;
  });

  const a = sceneAccounting({ engine: 'wan', seconds: 5, durationMs: 9000, externalApiCalls: 2 });
  assert.equal(a.costBasis, 'VENDOR_METERED');
  assert.equal(a.cloudCost.amount, null, 'an unknown price is null, not 0');
  assert.equal(a.cloudCost.confidence, 'unknown');
  assert.equal(a.externalApiCalls, 2);
});

test('a metered render with a configured rate is priced and labelled an estimate', (t) => {
  const previous = process.env.FAL_USD_PER_SECOND;
  process.env.FAL_USD_PER_SECOND = '0.05';
  t.after(() => {
    if (previous === undefined) delete process.env.FAL_USD_PER_SECOND;
    else process.env.FAL_USD_PER_SECOND = previous;
  });

  const cost = meteredCost('wan', 10);
  assert.equal(cost.amount, 0.5);
  assert.equal(cost.confidence, 'estimated', 'a rate-based price is an estimate, not a measurement');
});

test('one unknown amount makes the total unknown instead of under-reporting it', () => {
  const known = { amount: 0.25, currency: 'USD', confidence: 'measured' } as const;
  const total = addCost(known, unknownCost());
  assert.equal(total.amount, null);
  assert.equal(total.confidence, 'unknown');
});

test('known amounts add and keep the weaker confidence', () => {
  const measured = { amount: 0.25, currency: 'USD', confidence: 'measured' } as const;
  const estimated = { amount: 0.1, currency: 'USD', confidence: 'estimated' } as const;
  const total = addCost(measured, estimated);
  assert.equal(Number(total.amount?.toFixed(2)), 0.35);
  assert.equal(total.confidence, 'estimated');
});

test('the film takes the most expensive basis of its scenes', () => {
  assert.equal(
    dominantCostBasis(['NO_VENDOR_CALL_COST', 'THIRD_PARTY_FREE_TIER']),
    'THIRD_PARTY_FREE_TIER',
  );
  assert.equal(
    dominantCostBasis(['NO_VENDOR_CALL_COST', 'VENDOR_METERED', 'THIRD_PARTY_FREE_TIER']),
    'VENDOR_METERED',
    'one metered scene means the invoice exists',
  );
  assert.equal(dominantCostBasis([]), 'NO_VENDOR_CALL_COST');
});

test('summing scenes adds every counter and de-duplicates engines', () => {
  const a = sceneAccounting({ engine: 'comfyui', seconds: 10, durationMs: 1000, storageBytes: 100, externalApiCalls: 0, retryCount: 1 });
  const b = sceneAccounting({ engine: 'stock', seconds: 10, durationMs: 2000, storageBytes: 200, externalApiCalls: 3, retryCount: 0 });
  const total = sumAccounting([a, b]);

  assert.equal(total.renderDurationMs, 3000);
  assert.equal(total.storageBytes, 300);
  assert.equal(total.externalApiCalls, 3);
  assert.equal(total.retryCount, 1);
  assert.deepEqual([...total.engines].sort(), ['comfyui', 'stock']);
  assert.equal(total.costBasis, 'THIRD_PARTY_FREE_TIER');
});

test('an empty job is zeroed and does not claim a price', () => {
  const e = emptyAccounting();
  assert.equal(e.externalApiCalls, 0);
  assert.equal(e.renderDurationMs, 0);
  assert.deepEqual(e.engines, []);
});

test('the call counter measures real calls inside a scope', async () => {
  assert.equal(externalCallCount(), 0, 'nothing is counted outside a scope');

  const { result, externalApiCalls } = await withExternalCallCounter(async () => {
    countExternalCall();
    await new Promise(r => setTimeout(r, 1));
    countExternalCall();
    countExternalCall(2);
    return 'done';
  });

  assert.equal(result, 'done');
  assert.equal(externalApiCalls, 4);
  assert.equal(externalCallCount(), 0, 'the scope does not leak into the caller');
});

test('overlapping scopes never report each other\'s calls', async () => {
  const slow = withExternalCallCounter(async () => {
    countExternalCall();
    await new Promise(r => setTimeout(r, 30));
    countExternalCall();
  });
  const fast = withExternalCallCounter(async () => {
    countExternalCall();
  });

  const [a, b] = await Promise.all([slow, fast]);
  assert.equal(a.externalApiCalls, 2, 'the slow scope counted only its own calls');
  assert.equal(b.externalApiCalls, 1, 'the fast scope did not inherit the slow one');
});

test('a counted scope still propagates a thrown error', async () => {
  await assert.rejects(
    withExternalCallCounter(async () => {
      countExternalCall();
      throw new Error('vendor exploded');
    }),
    /vendor exploded/,
  );
  assert.equal(externalCallCount(), 0);
});

test('a mixed-engine scene is classified per engine, not as one unknown name', (t) => {
  const previous = process.env.FAL_USD_PER_SECOND;
  delete process.env.FAL_USD_PER_SECOND;
  t.after(() => {
    if (previous === undefined) delete process.env.FAL_USD_PER_SECOND;
    else process.env.FAL_USD_PER_SECOND = previous;
  });

  // `renderFeatureScene` joins its shot engines with '+', so a scene that used
  // both the local GPU and fal arrives as one string.
  const a = sceneAccounting({ engine: 'comfyui+wan', seconds: 4, durationMs: 5000, externalApiCalls: 1 });
  assert.deepEqual(a.engines, ['comfyui', 'wan'], 'each engine is kept on its own');
  assert.equal(a.costBasis, 'VENDOR_METERED', 'one metered shot makes the scene metered');
  assert.equal(a.cloudCost.amount, null, 'the fal price is unknown until a rate is set');

  // A mixed scene with no metered engine stays free of vendor cost.
  const b = sceneAccounting({ engine: 'comfyui+stock', seconds: 4, durationMs: 5000, externalApiCalls: 2 });
  assert.equal(b.costBasis, 'THIRD_PARTY_FREE_TIER');
  assert.equal(b.cloudCost.amount, 0);
});
