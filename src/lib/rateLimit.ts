/**
 * Neon-backed rate limiter with in-memory LRU short-circuit.
 *
 * BL-21 (S-005): replaces the single-process LRU-only limiter with an atomic
 * UPSERT on rate_limit_counters so all pods share the same counter.
 *
 * Short-circuit: if the LRU entry is <5 s old AND the cached count is below
 * 50% of the limit, skip the DB round-trip and increment locally. This keeps
 * the common-case overhead negligible while still persisting state across pods
 * once the key approaches the limit.
 */

import { LRUCache } from 'lru-cache';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
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
// LRU short-circuit cache
// ---------------------------------------------------------------------------

const LRU_TTL_MS = 5_000;

const lru = new LRUCache<string, { count: number; windowStart: number }>({
  max: 10_000,
  ttl: LRU_TTL_MS,
});

/** Clears the in-process LRU cache. Exposed for test use only. */
export function clearRateLimitCache(): void {
  lru.clear();
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Returns true if the request is allowed, false if it is rate-limited.
 *
 * The counter is persisted in `rate_limit_counters` (migration 331) so it is
 * shared across all pods. A 5-second LRU short-circuit avoids the DB round-
 * trip for low-pressure keys.
 */
export async function checkRateLimit(key: string, opts: RateLimitOptions): Promise<boolean> {
  const { max, windowSecs } = opts;
  const cost = opts.cost ?? 1;

  // Short-circuit: if the LRU copy is fresh, well under the limit, AND this
  // call's cost keeps it under the limit, skip the DB round-trip. A call
  // whose cost alone could push the counter over `max` (e.g. a large batch)
  // must NOT be admitted by the fast path — it always falls through to the
  // authoritative DB upsert below.
  const cached = lru.get(key);
  if (cached && cached.count < Math.floor(max * 0.5) && cached.count + cost <= max) {
    cached.count += cost;
    return true;
  }

  const rows = (await sql`
    INSERT INTO rate_limit_counters (key, count, window_start)
    VALUES (${key}, ${cost}, NOW())
    ON CONFLICT (key) DO UPDATE
      SET count = CASE
        WHEN rate_limit_counters.window_start < NOW() - make_interval(secs => ${windowSecs})
          THEN ${cost}
        ELSE rate_limit_counters.count + ${cost}
      END,
      window_start = CASE
        WHEN rate_limit_counters.window_start < NOW() - make_interval(secs => ${windowSecs})
          THEN NOW()
        ELSE rate_limit_counters.window_start
      END
    RETURNING count, window_start
  `) as { count: number; window_start: Date }[];

  const row = rows[0]!;
  lru.set(key, { count: row.count, windowStart: new Date(row.window_start).getTime() });
  return row.count <= max;
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
  return (
    (await checkRateLimit(`ai:${name}:ip:${ip}`, { max: ipMax, windowSecs: 900 })) &&
    (await checkRateLimit(`ai:${name}:co:${companyId}`, { max: companyMax, windowSecs: 900 })) &&
    (await checkRateLimit(`ai:${name}:co:${companyId}:day`, { max: dailyMax, windowSecs: 86_400 }))
  );
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
  const cost = opts.count ?? 1;
  return (
    (await checkRateLimit(`send:${name}:ip:${ip}`, { max: ipMax, windowSecs: 900, cost })) &&
    (await checkRateLimit(`send:${name}:co:${companyId}`, { max: companyMax, windowSecs: 900, cost })) &&
    (await checkRateLimit(`send:${name}:co:${companyId}:day`, { max: dailyMax, windowSecs: 86_400, cost }))
  );
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
 */
export function withRateLimit(
  handler: NextApiHandler,
  opts: RateLimitOptions
): NextApiHandler {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const ip = getClientIp(req);
    const allowed = await checkRateLimit(ip, opts);

    if (!allowed) {
      log.warn('Rate limit exceeded', { ip }, 'rateLimit');
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' },
      });
      return;
    }

    await handler(req, res);
  };
}
