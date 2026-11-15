/**
 * Request correlation via AsyncLocalStorage.
 *
 * `runWithRequestContext` is called once per API request inside
 * `withErrorHandler`. Everything executed inside the callback — including
 * deeply nested async code — can read the requestId via `getRequestId()`.
 *
 * Outside a context (background jobs, tests), `getRequestId()` returns
 * `undefined` so callers can omit the field gracefully.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { ulid } from 'ulid';

interface RequestContextStore {
  requestId: string;
}

// `async_hooks` is a Node-only core module. Next.js polyfills it to an empty
// object in the browser bundle, which would make `new AsyncLocalStorage()`
// throw `AsyncLocalStorage is not a constructor` at module load and crash the
// app before hydration. Guard so the browser gets a no-op.
const storage: AsyncLocalStorage<RequestContextStore> | null =
  typeof AsyncLocalStorage === 'function'
    ? new AsyncLocalStorage<RequestContextStore>()
    : null;

export function runWithRequestContext<T>(
  requestId: string,
  fn: () => Promise<T> | T
): Promise<T> | T {
  if (!storage) return fn();
  return storage.run({ requestId }, fn);
}

export function getRequestId(): string | undefined {
  return storage?.getStore()?.requestId;
}

export function generateRequestId(): string {
  return ulid();
}

/**
 * Marks everything run inside `fn` as a DRY RUN: the writes will be rolled back (`core/rolledBackSavepoint`), so the
 * log lines they emit ("Reversed journal entry", "Cancelled credit note") describe nothing that happened. The logger
 * tags them `dryRun: true` and prefixes the message, so a journal reader does not take a preview for a posting.
 */
const dryRunStorage: AsyncLocalStorage<true> | null =
  typeof AsyncLocalStorage === 'function' ? new AsyncLocalStorage<true>() : null;

export function runAsDryRun<T>(fn: () => Promise<T> | T): Promise<T> | T {
  if (!dryRunStorage) return fn();
  return dryRunStorage.run(true, fn);
}

export function isDryRun(): boolean {
  return dryRunStorage?.getStore() === true;
}
