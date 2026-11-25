import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GpuLeaseStore, GpuBusyError, acquireGpu, withGpu, GPU_RESOURCE } from './gpuLease.ts';

function tmpStore(): GpuLeaseStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpulease-'));
  return new GpuLeaseStore(path.join(dir, 'factory.db'));
}

const silent = { waitMs: 0, pollMs: 5 };

test('the first claim takes the GPU', () => {
  const store = tmpStore();
  const lease = store.tryClaim('render 1');
  assert.ok(lease);
  assert.equal(lease.holder, 'render 1');
  assert.equal(store.current()?.holder, 'render 1');
  store.close();
});

test('a second claim is refused while the first is live', () => {
  const store = tmpStore();
  assert.ok(store.tryClaim('film scene 1'));
  // This is the whole point of the module: a SwarmUI request cannot start while
  // a movie scene owns the device.
  assert.equal(store.tryClaim('SwarmUI image'), undefined);
  assert.equal(store.current()?.holder, 'film scene 1');
  store.close();
});

test('an expired lease can be taken over, so a dead process does not wedge the GPU', () => {
  const store = tmpStore();
  let now = 1_000;
  const dead = store.tryClaim('crashed render', { ttlMs: 10, now: () => now });
  assert.ok(dead);

  // A moment before expiry the GPU is still owned.
  now = 1_009;
  assert.equal(store.tryClaim('next render', { ttlMs: 10, now: () => now }), undefined);

  // At expiry the next caller wins without any cleanup step running.
  now = 1_010;
  const next = store.tryClaim('next render', { ttlMs: 10, now: () => now });
  assert.ok(next, 'an expired lease must be reclaimable');
  assert.equal(store.current({ now: () => now })?.holder, 'next render');
  store.close();
});

test('a late release cannot free the lease that replaced it', () => {
  const store = tmpStore();
  let now = 1_000;
  const stale = store.tryClaim('slow render', { ttlMs: 10, now: () => now })!;
  now = 2_000;
  const fresh = store.tryClaim('new render', { ttlMs: 10_000, now: () => now })!;

  // The dead holder finishing late must not unlock the live holder's device.
  assert.equal(store.release(stale, { now: () => now }), false);
  assert.equal(store.current({ now: () => now })?.holder, 'new render');
  assert.equal(store.release(fresh, { now: () => now }), true);
  assert.equal(store.current({ now: () => now }), undefined);
  store.close();
});

test('renew extends the lease and a taken-over lease cannot be renewed', () => {
  const store = tmpStore();
  let now = 1_000;
  const lease = store.tryClaim('long render', { ttlMs: 10, now: () => now })!;
  assert.equal(store.renew(lease, { ttlMs: 100, now: () => now }), true);

  now = 1_500;
  assert.equal(store.renew(lease, { ttlMs: 100, now: () => now }), false);
  store.close();
});

test('acquireGpu waits for a busy holder instead of failing', async () => {
  const store = tmpStore();
  store.tryClaim('film scene 2', { ttlMs: 40 });

  // The waiting caller must get the GPU once the holder lets go, not a failure.
  const lease = await acquireGpu(store, { holder: 'SwarmUI image', waitMs: 2_000, pollMs: 10 });
  assert.ok(lease);
  assert.equal(store.current()?.holder, 'SwarmUI image');
  store.close();
});

test('acquireGpu fails with GpuBusyError when the wait runs out, naming the holder', async () => {
  const store = tmpStore();
  store.tryClaim('film scene 5', { ttlMs: 60_000 });
  await assert.rejects(
    () => acquireGpu(store, { holder: 'image', ...silent }),
    (err: unknown) => {
      assert.ok(err instanceof GpuBusyError);
      assert.equal(err.holder, 'film scene 5');
      assert.match(err.message, /film scene 5/);
      return true;
    },
  );
  store.close();
});

test('withGpu frees the GPU even when the work throws', async () => {
  const store = tmpStore();
  await assert.rejects(
    () => withGpu(store, { holder: 'broken render', ...silent }, async () => {
      throw new Error('render blew up');
    }),
    /render blew up/,
  );
  // A failed render must not leave the device locked for everyone else.
  assert.equal(store.current(), undefined);
  assert.ok(store.tryClaim('next'), 'the GPU is usable again after a failure');
  store.close();
});

test('withGpu returns the work result and frees the GPU', async () => {
  const store = tmpStore();
  const out = await withGpu(store, { holder: 'render', ...silent }, async () => 'frames');
  assert.equal(out, 'frames');
  assert.equal(store.current(), undefined);
  store.close();
});

test('the lease survives a new store handle on the same file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpulease2-'));
  const file = path.join(dir, 'factory.db');
  const first = new GpuLeaseStore(file);
  assert.ok(first.tryClaim('render that keeps running', { ttlMs: 60_000 }));
  first.close();

  // A second process opening the same database sees the live lease. That is why
  // this is a row and not an in-process mutex.
  const second = new GpuLeaseStore(file);
  const holder = second.current();
  assert.equal(holder?.holder, 'render that keeps running');
  assert.equal(holder?.expired, false);
  second.close();
});

test('two stores on one file cannot both claim the GPU', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpulease3-'));
  const file = path.join(dir, 'factory.db');
  const a = new GpuLeaseStore(file);
  const b = new GpuLeaseStore(file);

  const first = a.tryClaim('process A', { ttlMs: 60_000 });
  assert.ok(first);
  assert.equal(b.tryClaim('process B', { ttlMs: 60_000 }), undefined);
  assert.equal(b.current()?.holder, 'process A');
  a.close();
  b.close();
});

test('the resource name is the single shared GPU', () => {
  assert.equal(GPU_RESOURCE, 'local-gpu');
});
