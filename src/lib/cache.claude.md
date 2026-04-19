# `src/lib/cache.ts`

## Purpose
In-process LRU cache (single Next.js server, no Redis dependency) with hit/miss statistics and tenant-scoped invalidation.

## Key exports

- `cache` — singleton `AppCache` instance
  - `cache.get<T>(key) → T | undefined`
  - `cache.set<T>(key, value, ttl?) → void` — TTL in ms; omit to use the default (5 min)
  - `cache.invalidate(key) → void` — remove one key
  - `cache.invalidatePrefix(prefix) → void` — remove all keys starting with `prefix`
  - `cache.invalidateCompany(companyId) → void` — removes all keys for a tenant (`${companyId}:*`)
  - `cache.stats() → { size, hitCount, missCount, hitRate }` — for monitoring/admin endpoints
  - `cache.clear() → void`

- `cacheThrough<T>(key, fetcher, ttl?) → Promise<T>` — read-through helper: returns cached value if present, otherwise calls `fetcher()`, caches the result, and returns it.

## Dependencies
- `lru-cache` — `LRUCache` (max 10 000 entries, 5-min default TTL, `allowStale: false`)
- `@/lib/logger` — logs invalidation events

## Critical notes
- **Tenant isolation**: all keys produced by `cache-keys.ts` are prefixed with `companyId`. `invalidateCompany(companyId)` is the correct way to flush a tenant's data after writes — missing this call after mutations is a stale-data bug.
- **Single-process**: data is not shared across Next.js pods. In a multi-pod deployment, a write on pod A invalidates pod A's cache only. Use a distributed cache (Redis) for cross-pod consistency.
- **`allowStale: false`**: expired entries are never returned even briefly — there is no stale-while-revalidate window.
- **`cacheThrough` is not atomic**: two concurrent requests for the same uncached key will both invoke `fetcher()`. This is acceptable (idempotent reads) but will generate duplicate DB queries under burst load.
- **TTL override in `set`**: passing `ttl: 0` sets an entry with an immediately-expired TTL (effectively not cached). Pass `undefined` to use the 5-min default.
