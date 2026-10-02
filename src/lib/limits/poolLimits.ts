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

/**
 * A pool's size from the environment (R-182): a whole number from 1 to 100
 * written as plain decimal digits, else `fallback` with one warning. Unset or
 * blank is `fallback`, silently. A plain `Number(...)` turned a typo into NaN,
 * and pg treats a NaN `max` as no limit, so the pool became unbounded on a
 * Postgres that is shared and capped at 100 connections. Digits only, so
 * `0x10` and `1e1` are refused rather than read as 16 and 10.
 */
export function poolSizeFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const text = raw.trim();
  if (/^[0-9]+$/.test(text)) {
    const n = Number(text);
    if (n >= 1 && n <= LARGEST_POOL) return n;
  }
  log.warn(`${name} is not a whole number from 1 to ${LARGEST_POOL}; using the default`, {
    name, value: raw, default: fallback,
  }, 'pool');
  return fallback;
}

/** The pool's configured size. Read per call, the same way the pool itself
 *  reads it, so the semaphore and the pool can never disagree. */
export function authPoolMax(): number {
  return poolSizeFromEnv('AUTH_POOL_MAX', DEFAULT_AUTH_POOL_MAX);
}
