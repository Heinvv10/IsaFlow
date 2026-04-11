/**
 * Per-company sliding-window rate limiter — pure in-memory, no external deps.
 *
 * Uses a Map<companyId, number[]> where the array holds timestamp (ms) of each
 * request in the current window. Entries older than windowMs are pruned on
 * every check, so memory stays bounded without a background timer.
 *
 * NOTE: single-instance only. For multi-pod deployments replace with Redis.
 */

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number; // ms until the oldest request falls out of the window
}

// Map<key, request-timestamp[]>
const windows = new Map<string, number[]>();

// Hard cap on number of distinct keys to prevent unbounded memory growth
const MAX_KEYS = 50_000;

/**
 * Check whether `companyId` (or any arbitrary string key) is within the rate
 * limit. Call once per request; the request is counted on every call.
 *
 * @param key       - Scoping key, typically `companyId` or `companyId:endpoint`
 * @param limit     - Max requests allowed per window (default 100)
 * @param windowMs  - Sliding-window size in ms (default 60 000 = 1 minute)
 */
export function checkRateLimit(
  key: string,
  limit = 100,
  windowMs = 60_000,
): RateLimitResult {
  const now = Date.now();
  const cutoff = now - windowMs;

  // Evict oldest key when map is full to prevent runaway growth
  if (!windows.has(key) && windows.size >= MAX_KEYS) {
    const firstKey = windows.keys().next().value;
    if (firstKey !== undefined) windows.delete(firstKey);
  }

  const timestamps = (windows.get(key) ?? []).filter(t => t > cutoff);

  if (timestamps.length >= limit) {
    // Calculate when the oldest request rolls out of the window
    const oldestTs = timestamps[0] ?? now;
    const resetMs = oldestTs + windowMs - now;
    windows.set(key, timestamps);
    return { allowed: false, remaining: 0, resetMs: Math.max(0, resetMs) };
  }

  timestamps.push(now);
  windows.set(key, timestamps);

  const remaining = limit - timestamps.length;
  // Estimate reset as when the current window expires from now
  const resetMs = timestamps[0] !== undefined ? timestamps[0] + windowMs - now : windowMs;
  return { allowed: true, remaining, resetMs: Math.max(0, resetMs) };
}
