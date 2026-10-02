/**
 * Rate-limit core: the shared counter, the refuse-only cache and the refund.
 *
 * BL-21 (S-005): the counter lives in `rate_limit_counters`, written by an
 * atomic UPSERT so every process shares it.
 *
 * R-175: nothing in memory may ADMIT a call. The old LRU short-circuit admitted
 * calls it never wrote to the table, so a limit of 20 admitted about 65 calls
 * per window on one process. Every call that can be admitted does the UPSERT,
 * and the UPSERT charges only when the call fits.
 * The one cache here only REFUSES: a key the database has just reported over
 * its limit is refused from memory for a few seconds, so a flood on that key
 * costs no database writes.
 *
 * K-103: the counter is written on the limiter's own pool (`@/lib/rateLimitPool`),
 * never on the request's transaction. The charge commits at once, survives a
 * request that rolls back, and holds no row lock past its own statement. Do not
 * route these statements through `sql`: inside a request it joins the request.
 *
 * Import from `@/lib/rateLimit`, which re-exports everything here.
 */

import { LRUCache } from 'lru-cache';
import { getRateLimitPool } from '@/lib/rateLimitPool';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitOptions {
  max: number;
  windowSecs: number;
  /**
   * Units to charge this call against the counter (default 1). Used to
   * weight rate-limit cost by batch size — e.g. a bulk-email call sending
   * N recipients should consume N units, not 1, so batching can't be used
   * to bypass the effective ceiling implied by `max`.
   */
  cost?: number;
}

// ---------------------------------------------------------------------------
// Refuse-only cache
// ---------------------------------------------------------------------------

/**
 * How long a refusal is remembered, at most. It is also never remembered past
 * the end of the key's window. Short on purpose: a refund made by another
 * process, the nightly cleanup, or an operator deleting a counter row is not
 * seen by this process, and must take effect within seconds, not at the end of
 * a window that can be a day long.
 */
export const REFUSAL_TTL_MS = 5_000;

/** key -> the count the database held when it last reported the key FULL (no unit left). */
const refused = new LRUCache<string, number>({ max: 10_000 });

/** Forgets every remembered refusal. For tests, and safe anywhere: it can only cause a database call. */
export function clearRateLimitCache(): void {
  refused.clear();
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Clamp a rate-limit `cost` to a positive integer. A shared primitive must never
 * let a caller pass a negative / zero / NaN / Infinity / fractional cost that
 * would decrement or corrupt the shared counter. Note `Math.max(1, NaN)` is NaN,
 * so the finite guard is required — do not simplify to `Math.max(1, trunc)`.
 */
export function clampCost(cost: number | undefined): number {
  const t = Math.trunc(cost ?? 1);
  return Number.isFinite(t) && t > 0 ? t : 1;
}

/** The largest `max` the counter column and the statement's integer arithmetic can hold. */
const MAX_LIMIT = 1_000_000_000;

/**
 * `max` is bound as a SQL integer. A fractional one is floored: a limit of 2.5
 * admits 2, the safe reading. NaN, Infinity, a negative or a value the column
 * cannot hold is a programming error, and says so here rather than as a
 * PostgreSQL error on every request.
 */
function clampMax(max: number): number {
  const m = Math.floor(max);
  if (!Number.isFinite(m) || m < 0 || m > MAX_LIMIT) {
    throw new RangeError(`rate limit max must be a number from 0 to ${MAX_LIMIT}, got ${String(max)}`);
  }
  return m;
}

/** `windowStart` names the window that was charged; a refund quotes it (see refundRateLimit). */
export interface RateLimitCharge { admitted: boolean; windowStart: string | null }

const REFUSED: RateLimitCharge = { admitted: false, windowStart: null };

// The time left is float8, not int: a 30-day window is 2.6e9 ms and overflows
// int4. window_start travels as text: a JS Date drops the microseconds a
// refund has to match.
const left = (col: string) => `(EXTRACT(EPOCH FROM (${col} + make_interval(secs => $3) - NOW())) * 1000)::float8`;
const expired = 'rate_limit_counters.window_start < NOW() - make_interval(secs => $3)';

/**
 * Charges `cost` units to `key` if, and only if, they fit under `max`.
 *
 * The counter is persisted in `rate_limit_counters` (migration 331) so it is
 * shared across all pods. One atomic statement decides and charges: a call
 * that fits is added and admitted; a call that does not fit changes nothing
 * and is refused. So the count never passes `max`, and a refused 100-unit call
 * does not use up room a 1-unit call could still have. An admitted charge is
 * committed before this returns, whatever the caller's transaction later does.
 * A key the database reported full in the last few seconds is refused again
 * from memory.
 */
export async function chargeRateLimit(key: string, opts: RateLimitOptions): Promise<RateLimitCharge> {
  const { windowSecs } = opts;
  const max = clampMax(opts.max);
  const cost = clampCost(opts.cost);
  // More than the whole allowance can never fit, in any window.
  if (cost > max) return REFUSED;

  // Refuse-only: the remembered count can turn a call away, never let one in.
  // Only a FULL key is remembered, so nothing the database would admit is
  // refused here because someone else's larger call did not fit.
  const fullAt = refused.get(key);
  if (fullAt !== undefined && fullAt >= max) return REFUSED;

  const asked = Date.now();
  const { rows } = await getRateLimitPool().query<{ admitted: boolean; count: number; window_start: string; remaining_ms: number }>(
    `WITH charged AS (
      INSERT INTO rate_limit_counters (key, count, window_start)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE
        SET count = CASE
          WHEN ${expired}
            THEN $2
          ELSE rate_limit_counters.count + $2
        END,
        window_start = CASE
          WHEN ${expired}
            THEN NOW()
          ELSE rate_limit_counters.window_start
        END
        WHERE ${expired}
           OR rate_limit_counters.count + $2 <= $4
      RETURNING count, window_start
    )
    SELECT true AS admitted, count, window_start::text, ${left('window_start')} AS remaining_ms FROM charged
    UNION ALL
    SELECT false, c.count, c.window_start::text, ${left('c.window_start')} FROM rate_limit_counters c
    WHERE c.key = $1 AND NOT EXISTS (SELECT 1 FROM charged)`,
    [key, cost, windowSecs, max],
  );

  // No row at all: the key was created by someone else after this statement's
  // snapshot and the charge did not fit. Refused, with nothing to remember.
  const row = rows[0];
  if (!row) return REFUSED;
  if (row.admitted) return { admitted: true, windowStart: row.window_start };
  // Remember it only if no unit is left. A refused 100-unit call at 9,950 of
  // 10,000 says nothing about a 1-unit call.
  //
  // The refused row above is read from this statement's snapshot, which can be
  // stale in EITHER direction: a refund that committed while the upsert waited
  // for the row lock is not in it, so it can read "full" when it is not. Before
  // remembering, re-read the latest committed count in a statement of its own.
  if (row.count < max) return REFUSED;
  const { rows: latest } = await getRateLimitPool().query<{ count: number; window_start: string; remaining_ms: number }>(
    `SELECT count, window_start::text,
      (EXTRACT(EPOCH FROM (window_start + make_interval(secs => $2) - NOW())) * 1000)::float8 AS remaining_ms
    FROM rate_limit_counters WHERE key = $1`,
    [key, windowSecs],
  );
  const now = latest[0];
  // Measured from before the round-trips, so the refusal never outlives the window.
  const ttl = now ? Math.min(REFUSAL_TTL_MS, now.remaining_ms - (Date.now() - asked)) : 0;
  if (now && now.count >= max && ttl >= 1) refused.set(key, now.count, { ttl });
  return REFUSED;
}

/**
 * True when `key` was reported full in the last few seconds for a limit of
 * `max` or less. Memory only: it never admits, it can only save a call that
 * would be refused anyway.
 */
export function isKnownFull(key: string, max: number): boolean {
  const fullAt = refused.get(key);
  return fullAt !== undefined && fullAt >= max;
}

/** Returns true if the request is allowed, false if it is rate-limited. See chargeRateLimit. */
export async function checkRateLimit(key: string, opts: RateLimitOptions): Promise<boolean> {
  return (await chargeRateLimit(key, opts)).admitted;
}

/**
 * Give `units` back to `key`.
 *
 * Only for a caller that has charged up front and then reached an outcome the
 * cap was never meant to bound — e.g. the invite-accept endpoint charges before
 * it touches GoTrue so that password guesses are counted even when the request
 * dies, then refunds the deterministic non-guess verdicts it can only discover
 * AFTER a successful sign-in. Never refund an outcome a caller could reach
 * without authenticating: that turns the counter into a free-attempt loop.
 *
 * Floors at zero and leaves `window_start` alone, so a refund can never extend
 * a window or drive the shared counter negative. Absent keys are a no-op.
 *
 * Pass the `windowStart` the charge returned and the refund lands only in that
 * window: if the window has rolled over since, the units belong to a count that
 * no longer exists, and taking them off the new window would hand out room
 * nobody paid for.
 */
export async function refundRateLimit(key: string, units: number, windowStart: string | null = null): Promise<void> {
  const cost = clampCost(units);
  await getRateLimitPool().query(
    `UPDATE rate_limit_counters
    SET count = GREATEST(count - $2, 0)
    WHERE key = $1
      AND ($3::timestamptz IS NULL OR window_start = $3::timestamptz)`,
    [key, cost, windowStart],
  );
  // The remembered refusal is now stale in the strict direction; drop it so the
  // next call asks the database.
  refused.delete(key);
}
