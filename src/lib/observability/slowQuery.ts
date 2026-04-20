/**
 * Slow-query timing.
 *
 * History & constraints:
 *
 *   1. An earlier implementation wrapped `sql` in an `async` function that
 *      `await`ed the underlying call. That turned the lazy query object
 *      (which exposes `.text` / `.values` for `sql.transaction([...])`
 *      batching) into a plain `Promise`, breaking every batched-INSERT
 *      call site — including `journalEntryCrudService` → all GL posting
 *      flows. So we must NOT await here.
 *
 *   2. A cheap "shadow `.then` on the instance" approach fails on native
 *      Promises: V8's fast path for `await <native Promise>` bypasses
 *      the `.then` property lookup entirely, so instance-level shadowing
 *      never fires. Custom thenables (like `LazyQuery` in `lib/neon.ts`)
 *      would hit it, but the wrapper has to work for both shapes.
 *
 * Current implementation uses a `Proxy`:
 *   - All property reads (`text`, `values`, `catch`, `finally`, anything
 *     else) forward unchanged via `Reflect.get` — so `sql.transaction([q])`
 *     still reads `q.text` / `q.values` directly, batched INSERTs unaffected.
 *   - The `.then` trap installs a timing hook that logs `slow_query` to the
 *     structured logger when the resolution exceeds `thresholdMs`.
 *   - Proxies are not ordinary Promise objects, so `await proxied` always
 *     goes through `[[Get]]("then")` — no fast-path bypass.
 */

import { log } from '@/lib/logger';

const PREVIEW_MAX_LEN = 120;

export function previewSqlTemplate(strings: TemplateStringsArray): string {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < strings.length - 1) out += '?';
    if (out.length >= PREVIEW_MAX_LEN) break;
  }
  return out.slice(0, PREVIEW_MAX_LEN);
}

type ThenFn = (
  onFulfilled?: ((value: unknown) => unknown) | null,
  onRejected?: ((reason: unknown) => unknown) | null,
) => unknown;

function isThenable(value: unknown): value is object & { then: ThenFn } {
  return (
    value != null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function wrapThenable<T extends object>(
  target: T,
  start: number,
  thresholdMs: number,
  strings: TemplateStringsArray,
): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === 'then') {
        const originalThen = Reflect.get(t, 'then', receiver);
        if (typeof originalThen !== 'function') return originalThen;
        // Bind to the underlying target — native Promise.prototype.then
        // relies on internal slots that exist only on the real object,
        // not on the Proxy.
        const boundThen = (originalThen as ThenFn).bind(t);
        return (
          onFulfilled?: ((v: unknown) => unknown) | null,
          onRejected?: ((e: unknown) => unknown) | null,
        ) => {
          const timedFulfilled = (v: unknown) => {
            const durationMs = performance.now() - start;
            if (durationMs >= thresholdMs) {
              log.warn(
                'slow_query',
                {
                  event: 'slow_query',
                  sql: previewSqlTemplate(strings),
                  durationMs,
                },
                'slowQuery',
              );
            }
            return onFulfilled ? onFulfilled(v) : v;
          };
          return boundThen(timedFulfilled, onRejected);
        };
      }
      return Reflect.get(t, prop, receiver);
    },
  });
}

export function withSlowQueryTiming<T>(sqlFn: T, thresholdMs: number): T {
  if (typeof sqlFn !== 'function') return sqlFn;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped: any = function (
    this: unknown,
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) {
    const start = performance.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (sqlFn as any).apply(this, [strings, ...values]);
    if (!isThenable(result)) return result;
    return wrapThenable(result, start, thresholdMs, strings);
  };

  // Preserve attached helpers (sql.transaction, sql.unsafe, sql.query, …)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const key of Object.keys(sqlFn as any)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapped[key] = (sqlFn as any)[key];
  }

  return wrapped as T;
}
