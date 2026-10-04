// src/lib/limits/poolLimits.ts
//
// The auth pool's size and acquire timeout, plus the one validated reader every
// pool size comes through (R-182). No `pg` behind it. Deliberately its OWN
// module rather than exports on authPool.ts: src/lib/pdf/renderSemaphore.ts
// derives its ceilings from these, and importing them from authPool.ts would
// pull `pg` (and the pgTypes side-effect import) into the PDF library's module
// graph for two constants.
//
// It sits under lib/limits/ rather than lib/auth/ because both sides read it.
// While it lived in lib/auth/, `lib/auth` imported `lib/pdf` (withAuth's print
// fallback) and `lib/pdf` imported `lib/auth` (this file) — a directory-level
// cycle carried by two constants that belong to neither owner. A neutral
// directory removes it without moving any behaviour.
//
// ── Coupled with src/lib/pdf/renderSemaphore.ts ──────────────────────────────
// A pack PDF render holds one auth-pool connection for its whole duration AND
// the headless browser re-enters the API for the report, taking a second. The
// render semaphore therefore derives BOTH of its ceilings from this file:
//   - its queue wait must expire before a caller's connection acquire does,
//     or a request refused for capacity has already failed on the pool;
//   - its concurrency ceiling is a fraction of the pool size, so renders and
//     their inbound fetches cannot take every connection.
// Change a value here and the semaphore's ceilings move with it: it derives
// them from these and restates none of them.

import { log } from '@/lib/logger';

export const AUTH_POOL_CONNECTION_TIMEOUT_MS = 15_000;
export const AUTH_POOL_IDLE_TIMEOUT_MS = 30_000;
export const DEFAULT_AUTH_POOL_MAX = 10;
/** The floor that makes ONE pack PDF render possible, not a safe size. A render
 *  holds one withAuth connection and the headless browser re-enters the API for
 *  a second, from these same pools; with a pool of 1 the second waits out the
 *  acquire timeout. A pool of 2 can still be taken by a concurrent request. */
export const MIN_AUTH_POOL_MAX = 2;
/** The floor for the main pool (PG_POOL_MAX): `withTransaction` outside a
 *  request holds one connection, and a bare `sql` in its callback takes a second
 *  from the same pool. With a pool of 1 that waits out the connect timeout. */
export const MIN_PG_POOL_MAX = 2;

const LARGEST_POOL = 100;
/** What pg-pool 3.13 made of an unusable `max` (`max = max || poolSize || 10`):
 *  NaN and 0 became 10. A value with no usable size (NaN, 0, negative,
 *  Infinity) gives no more than this. */
const INVALID_VALUE_CEILING = 10;
const warned = new Set<string>();

/**
 * A pool's size from the environment (R-182): a whole number from `minimum`
 * (default 1) to 100, written as plain decimal digits, is used as given. Unset
 * or blank is `fallback`, silently.
 *
 * Anything else is refused with ONE warning per (name, value). It gives
 * `min(fallback, ceil(Number(text)))` when `Number(text)` is a finite positive
 * number, else `min(fallback, 10)`; and never below `minimum`. So a spelling
 * the old plain `Number(...)` read as a usable size (`5.0`, `+5`, `0x5`, `2.5`,
 * `1e1`) gives the size it meant (rounded up, as pg-pool opened up to
 * ceil(max)) and never more than the default: for AUTH_POOL_MAX (default 10)
 * `10.0`, `+10` and `1e1` mean the default and give 10, and `15.0` or `50.0`
 * give the default, not their own size. NaN and 0 give
 * 10, which is what pg-pool made of them. Negative and Infinity values, which
 * were broken before, also give `min(fallback, 10)`.
 *
 * `minimum` is itself held to `min(minimum, fallback, 10)`, so a floor can never
 * make a refused value give a pool bigger than the default or 10.
 *
 * The floors are 2 for AUTH_POOL_MAX (MIN_AUTH_POOL_MAX) and PG_POOL_MAX
 * (MIN_PG_POOL_MAX). A floor of 2 is what makes one PDF render, or one nested
 * `sql` inside `withTransaction`, possible at all. It is not a safe size: a
 * pool of 2 can still be taken by a concurrent request.
 *
 * Why not a plain `Number(...)`: pg-pool turns NaN and 0 into 10 on its own, so
 * those were never unbounded. The dangers were a huge or Infinity value (a pool
 * with no real limit) and a negative one (truthy, so the pool is always "full"
 * and every acquire waits out its timeout).
 *
 * The warning logs the variable's name, the value's length and whether it was
 * digits only, never its text: a pool variable can hold a pasted DSN.
 *
 * The cap is PER VARIABLE, not per process. AUTH_POOL_MAX sizes four pools
 * (authPool, withExtensionToken, bearerPipeline, the platform-admin app pool).
 * AUTH_POOL_MAX advice: its default of 10 is 40 connections per process (it was
 * 20, so 80, until R-188) and 100 would be 400, so with max_connections 100
 * shared with dev, CI and Supabase, set it no higher than the default. A plain
 * whole number above the default is still honoured as given (up to 100)
 * (docs/audits/remediation/R-182/fix.md, docs/audits/remediation/R-188/fix.md).
 */
export function poolSizeFromEnv(name: string, fallback: number, category = 'pool', minimum = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const floor = Math.min(minimum, fallback, INVALID_VALUE_CEILING);
  const text = raw.trim();
  const digitsOnly = /^[0-9]+$/.test(text);
  if (digitsOnly) {
    const n = Number(text);
    if (n >= floor && n <= LARGEST_POOL) return n;
  }
  const asNumber = Number(text);
  const honoured = Number.isFinite(asNumber) && asNumber > 0 ? Math.ceil(asNumber) : Infinity;
  const unusable = Math.min(fallback, INVALID_VALUE_CEILING);
  const used = Math.max(floor, Number.isFinite(honoured) ? Math.min(fallback, honoured) : unusable);
  const key = `${name}=${text}`;
  if (!warned.has(key)) {
    warned.add(key);
    log.warn(`${name} is not a whole number from ${floor} to ${LARGEST_POOL}; using ${used}`, {
      name, length: raw.length, digitsOnly, default: fallback, using: used,
    }, category);
  }
  return used;
}

/** The pool's configured size. Read per call, the same way the pool itself
 *  reads it, so the semaphore and the pool can never disagree. */
export function authPoolMax(): number {
  return poolSizeFromEnv('AUTH_POOL_MAX', DEFAULT_AUTH_POOL_MAX, 'pool', MIN_AUTH_POOL_MAX);
}
