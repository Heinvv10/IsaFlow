/**
 * `async_hooks` for a browser bundle. `@/lib/logger` reads a request-context
 * store that only exists on the server; in the page it is always empty.
 */
export class AsyncLocalStorage<T> {
  run<R>(_store: T, fn: (...args: unknown[]) => R, ...args: unknown[]): R { return fn(...args); }
  getStore(): T | undefined { return undefined; }
}
