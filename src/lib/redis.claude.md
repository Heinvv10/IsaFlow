# `src/lib/redis.ts`

## Purpose
Singleton `ioredis` client factory that returns `null` when `REDIS_URL` is unset, enabling graceful degradation to in-memory fallbacks.

## Key exports

- `getRedisClient() → Redis | null` — returns the shared client or `null` if `REDIS_URL` is not configured. Lazy-connects on first call.

## Dependencies
- `ioredis` — Redis client
- `@/lib/logger` — logs connection errors as warnings

## Critical notes
- **Optional by design**: `REDIS_URL` is not in `validateEnv`'s required list. All callers must handle the `null` case and fall back to the in-process `cache.ts` / `rateLimiter.ts`.
- **`lazyConnect: true`**: no TCP connection is made at import time. The connection is established on first command. If the server is unreachable, commands fail with an error (not a hang).
- **`enableOfflineQueue: false`**: commands issued while disconnected throw immediately rather than queueing. This prevents stalled requests when Redis is temporarily unavailable.
- **`maxRetriesPerRequest: 1`**: limits retry storms; combined with `connectTimeout: 2000` this means a Redis failure adds at most ~2 s latency before a command errors.
- **Singleton**: `client` is module-level. Calling `getRedisClient()` multiple times returns the same instance. Do not call `client.quit()` from application code.
- **Error handling**: connection errors are logged as warnings, not thrown — the caller receives an error on the failing command.
