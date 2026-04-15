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

const storage = new AsyncLocalStorage<RequestContextStore>();

export function runWithRequestContext<T>(
  requestId: string,
  fn: () => Promise<T> | T
): Promise<T> | T {
  return storage.run({ requestId }, fn);
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function generateRequestId(): string {
  return ulid();
}
