/**
 * Count outbound third-party calls, per async scope.
 *
 * The accounting ledger claims a number for `externalApiCalls`, so that number
 * has to be measured rather than estimated. A module-level counter would be
 * wrong as soon as two renders overlap: each would report the other's calls.
 * `AsyncLocalStorage` keeps one counter per render, and anything the render
 * awaits — including a retry loop or an HTTP/2 stream — writes into its own.
 *
 * A call that never leaves the machine (the local ComfyUI on loopback) is not
 * counted. No vendor sees it, so it is not an external call.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

interface Counter {
  count: number;
}

const store = new AsyncLocalStorage<Counter>();

/** Record one outbound call. A no-op outside a counted scope. */
export function countExternalCall(times = 1): void {
  const counter = store.getStore();
  if (counter) counter.count += times;
}

/** Run `fn` and report how many external calls it made. */
export async function withExternalCallCounter<T>(fn: () => Promise<T>): Promise<{ result: T; externalApiCalls: number }> {
  const counter: Counter = { count: 0 };
  const result = await store.run(counter, fn);
  return { result, externalApiCalls: counter.count };
}

/** The current scope's count, or 0 when nothing is being counted. */
export function externalCallCount(): number {
  return store.getStore()?.count ?? 0;
}
