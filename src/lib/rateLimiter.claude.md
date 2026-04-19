# `src/lib/rateLimiter.ts`

## Purpose
Pure in-memory, single-process sliding-window rate limiter — no DB or external deps; intended for per-company or per-endpoint limiting within a single Next.js server process.

## Key exports

- `checkRateLimit(key, limit?, windowMs?) → RateLimitResult` — counts the current call; returns `{ allowed, remaining, resetMs }`. Default: 100 req / 60 000 ms.
- `RateLimitResult` — `{ allowed: boolean; remaining: number; resetMs: number }`.

## Behaviour
Maintains `Map<key, timestamp[]>`. On each call: prunes timestamps older than the window, checks count vs limit, appends current timestamp. `resetMs` is the ms until the oldest timestamp falls out of the window.

## Dependencies
None — pure TypeScript, no imports.

## Critical notes
- **Single-instance only**: state lives in the module-level `Map`. In a multi-pod deployment, each pod has independent counters — use `rateLimit.ts` (Neon-backed) instead.
- **Memory cap**: `MAX_KEYS = 50_000`. When the map is full, the oldest key (insertion order) is evicted to make room. This is a best-effort safety valve, not an LRU.
- **`limit` and `windowMs` are not validated** — callers are responsible for sensible values.
- **No middleware wrapper**: unlike `rateLimit.ts`, this file only exports the core check function. Wrap it manually in route handlers.
- **Test isolation**: because `windows` is module-level, tests that import `rateLimiter` share state across test cases unless the module is re-imported fresh.
