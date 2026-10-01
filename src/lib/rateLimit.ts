/**
 * Neon-backed rate limiter.
 *
 * BL-21 (S-005): replaces the single-process LRU-only limiter with an atomic
 * UPSERT on rate_limit_counters so all pods share the same counter.
 *
 * R-175: every call does that UPSERT. There is no in-process copy of a counter.
 * The old LRU short-circuit admitted calls it never wrote to the table, so a
 * limit of 20 admitted about 65 calls per window on one process. Do not add a
 * cache that can ADMIT a call. The one cache here only REFUSES: a key the
 * database has just reported over its limit is refused from memory for a few
 * seconds, so a flood on that key costs no database writes.
 *
 * K-103: the counter is written on the limiter's own pool (`@/lib/rateLimitPool`),
 * never on the request's transaction. The charge commits at once, survives a
 * request that rolls back, and holds no row lock past its own statement. Do not
 * route these statements through `sql`: inside a request it joins the request.
 */

import { LRUCache } from 'lru-cache';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { als } from '@/lib/als';
import { getRateLimitPool } from '@/lib/rateLimitPool';
import { log } from '@/lib/logger';

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
 * shared across all pods. Every call charges it, admitted or not, and the
 * charge is committed before this returns, whatever the caller's transaction
 * later does.
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
      (EXTRACT(EPOCH FROM (window_start + make_interval(secs => $3) - NOW())) * 1000)::int AS remaining_ms`,
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

// ---------------------------------------------------------------------------
// Usage quotas (see `@/lib/rateLimitQuota`)
// ---------------------------------------------------------------------------

export const aiDailyKey = (name: string, companyId: string): string => `ai:${name}:co:${companyId}:day`;
export const sendDailyKey = (name: string, companyId: string): string => `send:${name}:co:${companyId}:day`;

/**
 * Records that this request spent `units` of a usage quota, so the request's
 * owner can give them back if the request fails. Only `withAuth` keeps the
 * list; anywhere else this does nothing and the charge simply stands.
 */
function noteQuotaCharge(key: string, units: number): void {
  als.getStore()?.quotaCharges?.push({ key, units });
}

// ---------------------------------------------------------------------------
// IP extraction (BL-20 — do NOT remove; used by register, forgot-password, etc.)
// ---------------------------------------------------------------------------

export function getClientIp(req: NextApiRequest): string {
  // In production behind nginx/Cloudflare, use the last proxy-added IP.
  // x-forwarded-for format: client, proxy1, proxy2
  // The FIRST entry is client-supplied and therefore spoofable.
  // The LAST entry is appended by the closest trusted proxy (nginx/Cloudflare)
  // and cannot be forged by the client.
  // In a Cloudflare + nginx setup, the real IP is the second-to-last entry;
  // using the last (nginx-appended) is still safe for rate limiting purposes.
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // If the header appears multiple times Node gives an array; the LAST one is
    // appended by the closest trusted proxy (H8: the old code took forwarded[0],
    // the client-supplied/spoofable header).
    const raw = Array.isArray(forwarded) ? forwarded[forwarded.length - 1] ?? '' : forwarded;
    const ips = raw.split(',').map(s => s.trim()).filter(Boolean);
    return ips[ips.length - 1] || req.socket.remoteAddress || 'unknown';
  }
  return req.socket.remoteAddress || 'unknown';
}

/**
 * Per-IP + per-company + daily-quota limiting for expensive AI/LLM endpoints
 * (pentest H3: an authenticated tenant could otherwise burn the inference budget
 * with unbounded calls). Returns true when ALLOWED, false when it should be 429'd.
 */
export async function checkAiRateLimit(
  req: NextApiRequest,
  companyId: string,
  name: string,
  opts: { ipMax?: number; companyMax?: number; dailyMax?: number } = {},
): Promise<boolean> {
  const ip = getClientIp(req);
  const ipMax = opts.ipMax ?? 20;
  const companyMax = opts.companyMax ?? 40;
  const dailyMax = opts.dailyMax ?? 300;
  const allowed =
    (await checkRateLimit(`ai:${name}:ip:${ip}`, { max: ipMax, windowSecs: 900 })) &&
    (await checkRateLimit(`ai:${name}:co:${companyId}`, { max: companyMax, windowSecs: 900 })) &&
    (await checkRateLimit(aiDailyKey(name, companyId), { max: dailyMax, windowSecs: 86_400 }));
  // The daily bucket is a budget for AI calls actually made, not an abuse
  // limit: a request that fails gives its unit back. The 15-minute buckets
  // stay charged, and they are what bounds a loop of failing requests.
  if (allowed) noteQuotaCharge(aiDailyKey(name, companyId), 1);
  return allowed;
}

/**
 * Per-IP + per-company + daily-quota limiting for email-send endpoints.
 * Prevents bulk-send abuse (M13). Returns true when ALLOWED, false when 429'd.
 */
export async function checkSendRateLimit(
  req: NextApiRequest,
  companyId: string,
  name: string,
  opts: { ipMax?: number; companyMax?: number; dailyMax?: number; count?: number } = {},
): Promise<boolean> {
  const ip = getClientIp(req);
  const ipMax = opts.ipMax ?? 30;
  const companyMax = opts.companyMax ?? 60;
  const dailyMax = opts.dailyMax ?? 500;
  // `count` is EMAIL VOLUME (recipients in this call). It weights the per-company
  // and per-day buckets, which are volume budgets. The per-IP bucket is a
  // request-RATE limiter (abuse from one source) — one API call is one request
  // regardless of recipient count, so it is always charged 1. Charging the IP
  // bucket per-recipient would wrongly block a single legitimate large batch.
  const volumeCost = opts.count ?? 1;
  const allowed =
    (await checkRateLimit(`send:${name}:ip:${ip}`, { max: ipMax, windowSecs: 900, cost: 1 })) &&
    (await checkRateLimit(`send:${name}:co:${companyId}`, { max: companyMax, windowSecs: 900, cost: volumeCost })) &&
    (await checkRateLimit(sendDailyKey(name, companyId), { max: dailyMax, windowSecs: 86_400, cost: volumeCost }));
  // As for AI: the daily bucket bounds emails actually sent.
  if (allowed) noteQuotaCharge(sendDailyKey(name, companyId), clampCost(volumeCost));
  return allowed;
}

/**
 * Per-company throttle for expensive report/export/PDF endpoints (pentest
 * MEDIUM: heavy report/export/PDF routes — PDF rendering, large SQL
 * aggregations — were gated only by auth, with no request-frequency limit,
 * letting a scripted authenticated client drive sustained CPU/memory as a
 * same-tenant resource-exhaustion DoS). Generous window so normal interactive
 * use (clicking "export" a few times while reviewing a report) never trips
 * it. Returns true when ALLOWED, false when it should be 429'd.
 */
export async function checkReportRateLimit(
  companyId: string,
  name: string,
  opts: { max?: number; windowSecs?: number } = {},
): Promise<boolean> {
  const max = opts.max ?? 25;
  const windowSecs = opts.windowSecs ?? 900;
  return checkRateLimit(`report:${name}:co:${companyId}`, { max, windowSecs });
}

// ---------------------------------------------------------------------------
// Middleware wrapper (convenience helper for simple IP-based limiting)
// ---------------------------------------------------------------------------

/**
 * Wraps an API handler with per-IP rate limiting using the Neon-backed counter.
 *
 * `scope` namespaces the counter key per route and is REQUIRED. Without it every
 * wrapped route shared one bucket keyed on the bare IP, so each route applied its
 * own `max` to a counter fed by all of them: a handful of logins exhausted the
 * signup allowance, a password reset consumed the login allowance, and so on.
 * Keep the scope stable — changing it resets that route's live counters.
 */
export function withRateLimit(
  handler: NextApiHandler,
  opts: RateLimitOptions,
  scope: string
): NextApiHandler {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const ip = getClientIp(req);
    const allowed = await checkRateLimit(`${scope}:ip:${ip}`, opts);

    if (!allowed) {
      log.warn('Rate limit exceeded', { ip, scope, max: opts.max, windowSecs: opts.windowSecs }, 'rateLimit');
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' },
      });
      return;
    }

    await handler(req, res);
  };
}
