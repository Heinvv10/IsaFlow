/**
 * Rate-limit core: the shared counter, the refuse-only cache and the refund.
 *
 * BL-21 (S-005): the counter lives in `rate_limit_counters`, written by an
 * atomic UPSERT so every process shares it.
 *
 * R-175: nothing in memory may ADMIT a call. The old LRU short-circuit admitted
 * calls it never wrote to the table, so a limit of 20 admitted about 65 calls
 * per window on one process. Every call that can be admitted does the UPSERT.
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

/** key -> the count the database reported when it refused the key. */
const refused = new LRUCache<string, number>({ max: 10_000 });

/** Forgets every remembered refusal. For tests, and safe anywhere: it can only cause a database call. */
export function clearRateLimitCache(): void {
  refused.clear();
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Returns true if the request is allowed, false if it is rate-limited.
 *
 * The counter is persisted in `rate_limit_counters` (migration 331) so it is
 * shared across all pods. A call that reaches the database charges it, admitted
 * or not, and the charge is committed before this returns, whatever the
 * caller's transaction later does. A key that was refused in the last few
 * seconds is refused again from memory, without a charge.
 */
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

export async function checkRateLimit(key: string, opts: RateLimitOptions): Promise<boolean> {
  const { max, windowSecs } = opts;
  const cost = clampCost(opts.cost);

  // Refuse-only: the remembered count can turn a call away, never let one in.
  // A caller with a higher `max` on the same key is not bound by it.
  const refusedAt = refused.get(key);
  if (refusedAt !== undefined && refusedAt > max) return false;

  const asked = Date.now();
  const { rows } = await getRateLimitPool().query<{ count: number; remaining_ms: number }>(
    `INSERT INTO rate_limit_counters (key, count, window_start)
    VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE
      SET count = CASE
        WHEN rate_limit_counters.window_start < NOW() - make_interval(secs => $3)
          THEN $2
        ELSE rate_limit_counters.count + $2
      END,
      window_start = CASE
        WHEN rate_limit_counters.window_start < NOW() - make_interval(secs => $3)
          THEN NOW()
        ELSE rate_limit_counters.window_start
      END
    RETURNING count,
      -- float8, not int: a 30-day window is 2.6e9 ms and overflows int4.
      (EXTRACT(EPOCH FROM (window_start + make_interval(secs => $3) - NOW())) * 1000)::float8 AS remaining_ms`,
    [key, cost, windowSecs],
  );

  const { count, remaining_ms } = rows[0]!;
  if (count <= max) return true;
  // Measured from before the round-trip, so the refusal never outlives the window.
  const ttl = Math.min(REFUSAL_TTL_MS, remaining_ms - (Date.now() - asked));
  if (ttl >= 1) refused.set(key, count, { ttl });
  return false;
}

/**
 * Give `units` back to `key`'s current window.
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
 */
export async function refundRateLimit(key: string, units: number): Promise<void> {
  const cost = clampCost(units);
  await getRateLimitPool().query(
    `UPDATE rate_limit_counters
    SET count = GREATEST(count - $2, 0)
    WHERE key = $1`,
    [key, cost],
  );
  // The remembered refusal is now stale in the strict direction; drop it so the
  // next call asks the database.
  refused.delete(key);
}
