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
// Change a value here and the semaphore's ceilings move with it. These numbers
// are not restated anywhere else.

import { log } from '@/lib/logger';

export const AUTH_POOL_CONNECTION_TIMEOUT_MS = 15_000;
export const AUTH_POOL_IDLE_TIMEOUT_MS = 30_000;
export const DEFAULT_AUTH_POOL_MAX = 20;

const LARGEST_POOL = 100;
/** What pg-pool 3.13 made of an unusable `max` (`max = max || poolSize || 10`):
 *  NaN and 0 became 10. An invalid value never gives more than this. */
const INVALID_VALUE_CEILING = 10;
const warned = new Set<string>();

/**
 * A pool's size from the environment (R-182): a whole number from 1 to 100
 * written as plain decimal digits is used as given. Unset or blank is
 * `fallback`, silently.
 *
 * Anything else is refused with ONE warning per (name, value). It gives
 * `min(fallback, 10, ceil(Number(text)))` when `Number(text)` is a finite
 * positive number, else `min(fallback, 10)`. So no spelling that the old plain
 * `Number(...)` read as a usable size (`5.0`, `+5`, `0x5`, `2.5`, `1e1`) gives
 * a pool with more connections than pg-pool allowed for it (it opened up to
 * ceil(max)); NaN and 0 give 10, which is what pg-pool made of them. Negative
 * and Infinity values, which were broken before, also give `min(fallback, 10)`.
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
 * AUTH_POOL_MAX advice: its default of 20 is 80 connections per process and 100
 * would be 400, so with max_connections 100 shared with dev, CI and Supabase,
 * set it no higher than the default and lower it (10 gives 40) if connections
 * run short (docs/audits/remediation/R-182/fix.md).
 */
export function poolSizeFromEnv(name: string, fallback: number, category = 'pool'): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const text = raw.trim();
  const digitsOnly = /^[0-9]+$/.test(text);
  if (digitsOnly) {
    const n = Number(text);
    if (n >= 1 && n <= LARGEST_POOL) return n;
  }
  const asNumber = Number(text);
  const honoured = Number.isFinite(asNumber) && asNumber > 0 ? Math.ceil(asNumber) : Infinity;
  const used = Math.min(fallback, INVALID_VALUE_CEILING, honoured);
  const key = `${name}=${text}`;
  if (!warned.has(key)) {
    warned.add(key);
    log.warn(`${name} is not a whole number from 1 to ${LARGEST_POOL}; using ${used}`, {
      name, length: raw.length, digitsOnly, default: fallback, using: used,
    }, category);
  }
  return used;
}

/** The pool's configured size. Read per call, the same way the pool itself
 *  reads it, so the semaphore and the pool can never disagree. */
export function authPoolMax(): number {
  return poolSizeFromEnv('AUTH_POOL_MAX', DEFAULT_AUTH_POOL_MAX);
}
