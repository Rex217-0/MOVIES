/**
 * The process-wide handle on the one local GPU.
 *
 * Every route that starts local work on the GPU goes through `runOnLocalGpu`, so
 * there is exactly one place that decides who gets to touch the device. The store
 * is created lazily: importing this module must not open a database, because the
 * server module is imported by tests that never render anything.
 */


import { GpuLeaseStore, withGpu, type GpuLease, type ClaimOptions } from './gpuLease.ts';

let store: GpuLeaseStore | undefined;

/** The shared store, opened on first use. */
export function gpuStore(): GpuLeaseStore {
  if (!store) store = new GpuLeaseStore();
  return store;
}

/** Replace the store (tests point it at a temporary database). */
export function setGpuStore(next: GpuLeaseStore | undefined): void {
  store = next;
}

/**
 * How long a request waits for a busy GPU before giving up.
 *
 * Waiting is the default because the honest answer for a queued image is "it ran
 * later", not "it failed". It is still finite: a caller must never hang forever
 * behind a stuck render.
 */
export function gpuWaitMs(): number {
  const raw = Number(process.env.DIREK_GPU_WAIT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 15 * 60 * 1000;
}

/**
 * Run one piece of local GPU work, waiting its turn.
 *
 * The lease is released in a `finally`, so a render that throws still frees the
 * device. `holder` is what the next caller is told when it has to wait, so the
 * message names the thing that is actually blocking it.
 */
export function runOnLocalGpu<T>(
  holder: string,
  work: (lease: GpuLease) => Promise<T>,
  opts: { waitMs?: number } = {},
): Promise<T> {
  const claim: ClaimOptions = { holder, waitMs: opts.waitMs ?? gpuWaitMs() };
  return withGpu(gpuStore(), claim, work);
}
