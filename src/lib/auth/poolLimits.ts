// src/lib/auth/poolLimits.ts
//
// The auth pool's size and acquire timeout, as plain numbers with no runtime
// behind them. Deliberately its OWN module rather than exports on
// authPool.ts: src/lib/pdf/renderSemaphore.ts derives its ceilings from these,
// and importing them from authPool.ts would pull `pg` (and the pgTypes
// side-effect import) into the PDF library's module graph for two constants.
//
// ── Coupled with src/lib/pdf/renderSemaphore.ts ──────────────────────────────
// A pack PDF render holds one auth-pool connection for its whole duration AND
// the headless browser re-enters the API for the report, taking a second. The
// render semaphore therefore derives BOTH of its ceilings from this file:
//   - its queue wait must expire before a caller's connection acquire does,
//     or a request refused for capacity has already failed on the pool;
//   - its concurrency ceiling is a fraction of the pool size, so renders and
//     their inbound fetches cannot take every connection.
// Change a value here and the semaphore's ceilings move with it. These numbers
// are not restated anywhere else.

export const AUTH_POOL_CONNECTION_TIMEOUT_MS = 15_000;
export const AUTH_POOL_IDLE_TIMEOUT_MS = 30_000;
export const DEFAULT_AUTH_POOL_MAX = 20;

/** The pool's configured size. Read per call, the same way the pool itself
 *  reads it, so the semaphore and the pool can never disagree. */
export function authPoolMax(): number {
  return Number(process.env.AUTH_POOL_MAX ?? DEFAULT_AUTH_POOL_MAX);
}
