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
import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitOptions {
  max: number;
  windowSecs: number;
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

  // Short-circuit: if the LRU copy is fresh and well under the limit, skip DB.
  const cached = lru.get(key);
  if (cached && cached.count < Math.floor(max * 0.5)) {
    cached.count += 1;
    return true;
  }

  const rows = (await sql`
    INSERT INTO rate_limit_counters (key, count, window_start)
    VALUES (${key}, 1, NOW())
    ON CONFLICT (key) DO UPDATE
      SET count = CASE
        WHEN rate_limit_counters.window_start < NOW() - make_interval(secs => ${windowSecs})
          THEN 1
        ELSE rate_limit_counters.count + 1
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
    const raw = Array.isArray(forwarded) ? forwarded[0] ?? '' : forwarded;
    const ips = raw.split(',').map(s => s.trim());
    return ips[ips.length - 1] || req.socket.remoteAddress || 'unknown';
  }
  return req.socket.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------------------
// Middleware wrapper (convenience helper for simple IP-based limiting)
// ---------------------------------------------------------------------------

/**
 * Wraps an API handler with per-IP rate limiting using the Neon-backed counter.
 */
export function withRateLimit(
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void,
  opts: RateLimitOptions
) {
  return async (req: NextApiRequest, res: NextApiResponse): Promise<void> => {
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

    return handler(req, res);
  };
}
