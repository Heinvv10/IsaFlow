/**
 * In-memory rate limiter using LRU cache with TTL
 *
 * NOTE: This is a single-instance in-memory store. For multi-instance deployments
 * (horizontal scaling), replace the LRUCache backing with a Redis store so rate
 * limit counters are shared across all pods.
 */

import { LRUCache } from 'lru-cache';
import type { NextApiRequest, NextApiResponse } from 'next';
import { log } from '@/lib/logger';

interface RateLimitOptions {
  windowMs?: number;    // time window in ms (default 15 min)
  maxRequests?: number; // max requests per window (default 5)
}

// Each cache entry tracks hit count within the TTL window
const caches = new Map<string, LRUCache<string, number>>();

function getCache(windowMs: number): LRUCache<string, number> {
  const key = String(windowMs);
  if (!caches.has(key)) {
    caches.set(key, new LRUCache<string, number>({
      max: 10_000,
      ttl: windowMs,
    }));
  }
  return caches.get(key)!;
}

/**
 * Returns true if the key is rate limited, false if the request is allowed.
 */
export function checkRateLimit(key: string, opts?: RateLimitOptions): boolean {
  const windowMs = opts?.windowMs ?? 15 * 60 * 1000;
  const maxRequests = opts?.maxRequests ?? 5;

  const cache = getCache(windowMs);
  const current = cache.get(key) ?? 0;

  if (current >= maxRequests) {
    return true; // rate limited
  }

  cache.set(key, current + 1);
  return false;
}

function getClientIp(req: NextApiRequest): string {
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

/**
 * Middleware wrapper that applies rate limiting per IP before the handler runs.
 */
export function withRateLimit(
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void,
  opts?: RateLimitOptions
) {
  return async (req: NextApiRequest, res: NextApiResponse): Promise<void> => {
    const ip = getClientIp(req);
    const limited = checkRateLimit(ip, opts);

    if (limited) {
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
