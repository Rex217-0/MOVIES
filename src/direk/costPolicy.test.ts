import test from 'node:test';
import assert from 'node:assert/strict';
import { paidCloudAllowed, paidReady, PAID_BLOCKED_DETAIL } from './costPolicy.ts';

async function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('paid cloud is off unless a deployment explicitly opts in', async () => {
  for (const value of [undefined, '', '0', 'false', 'no', 'off', 'nonsense']) {
    await withEnv({ ALLOW_PAID_CLOUD: value }, () => {
      assert.equal(paidCloudAllowed(), false, `ALLOW_PAID_CLOUD=${value} must stay free-only`);
    });
  }
  for (const value of ['1', 'true', 'yes', 'on', 'TRUE', ' 1 ']) {
    await withEnv({ ALLOW_PAID_CLOUD: value }, () => {
      assert.equal(paidCloudAllowed(), true, `ALLOW_PAID_CLOUD=${value} must opt in`);
    });
  }
});

test('paidReady needs both a configured service and the opt-in', async () => {
  await withEnv({ ALLOW_PAID_CLOUD: undefined }, () => {
    assert.equal(paidReady(true), false, 'configured but not opted in is not ready');
    assert.equal(paidReady(false), false);
  });
  await withEnv({ ALLOW_PAID_CLOUD: '1' }, () => {
    assert.equal(paidReady(true), true, 'configured and opted in is ready');
    assert.equal(paidReady(false), false, 'opted in but unconfigured is not ready');
  });
});

test('the blocked message names the switch that opens it', () => {
  assert.match(PAID_BLOCKED_DETAIL, /ALLOW_PAID_CLOUD/);
});
