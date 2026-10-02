// src/lib/limits/poolLimits.ts
//
// The auth pool's size and acquire timeout, plus the one validated reader every
// pool size comes through (R-182). No `pg` behind it. Deliberately its OWN
// module rather than exports on authPool.ts: src/lib/pdf/renderSemaphore.ts
// derives its ceilings from these, and importing them from authPool.ts would pull `pg` (and the pgTypes
// side-effect import) into the PDF library's module graph for two constants.
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
 *  NaN and 0 became 10. An invalid value falls back to no more than this, so a
 *  typo never makes a pool bigger than it was before this reader existed. */
const INVALID_VALUE_CEILING = 10;
const LOGGED_VALUE_LENGTH = 40;
const warned = new Set<string>();

/**
 * A pool's size from the environment (R-182): a whole number from 1 to 100
 * written as plain decimal digits. Unset or blank is `fallback`, silently.
 * Anything else is refused with ONE warning per (name, value) and gives
 * `min(fallback, 10)`, which is what pg-pool already made of NaN and 0.
 *
 * Why not a plain `Number(...)`: pg-pool turns NaN and 0 into 10 on its own, so
 * those were never unbounded. The dangers were a huge or Infinity value (a pool
 * with no real limit) and a negative one (truthy, so the pool is always "full"
 * and every acquire waits out its timeout). Digits only, so `0x10`, `1e1`,
 * `10.0` and `+5` are refused rather than read as 16, 10, 10 and 5.
 *
 * The cap is PER VARIABLE, not per process. AUTH_POOL_MAX sizes four pools
 * (authPool, withExtensionToken, bearerPipeline, the platform-admin app pool),
 * so 100 would be 400 connections in one process, against a Postgres whose
 * max_connections is 100 and is shared with dev, CI and Supabase. Set it to 10
 * or less per pool unless the connection budget has been re-measured
 * (docs/audits/remediation/R-182/fix.md).
 */
export function poolSizeFromEnv(name: string, fallback: number, category = 'pool'): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const text = raw.trim();
  if (/^[0-9]+$/.test(text)) {
    const n = Number(text);
    if (n >= 1 && n <= LARGEST_POOL) return n;
  }
  const used = Math.min(fallback, INVALID_VALUE_CEILING);
  const value = raw.length > LOGGED_VALUE_LENGTH ? `${raw.slice(0, LOGGED_VALUE_LENGTH)}...` : raw;
  const key = `${name}=${value}`;
  if (!warned.has(key)) {
    warned.add(key);
    log.warn(`${name} is not a whole number from 1 to ${LARGEST_POOL}; using ${used}`, {
      name, value, default: fallback, using: used,
    }, category);
  }
  return used;
}

/** The pool's configured size. Read per call, the same way the pool itself
 *  reads it, so the semaphore and the pool can never disagree. */
export function authPoolMax(): number {
  return poolSizeFromEnv('AUTH_POOL_MAX', DEFAULT_AUTH_POOL_MAX);
}
