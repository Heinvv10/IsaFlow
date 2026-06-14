# `src/lib/rateLimit.ts`

## Purpose
Postgres-backed (DB-persisted) rate limiter with a 5-second LRU short-circuit — shares counters across all pods via the `rate_limit_counters` table (migration 331). There is no Redis dependency; all persistence is through Postgres.

## Key exports

- `checkRateLimit(key, opts) → Promise<boolean>` — returns `true` if the request is allowed; key is any string (typically IP or `companyId:endpoint`). Atomically UPSERTs the counter in Postgres; LRU short-circuits the DB call when the key is under 50% of the limit and the cache entry is < 5 s old.
- `getClientIp(req) → string` — extracts the real client IP from `X-Forwarded-For` (last value = nginx-appended, spoofing-resistant). Never use `req.socket.remoteAddress` directly.
- `checkAiRateLimit(req, companyId, name, opts?) → Promise<boolean>` — per-IP + per-company + daily quota for AI/LLM endpoints. Key prefix: `ai:`. Defaults: ipMax=20, companyMax=40, dailyMax=300 per 15-min / 24-hr window.
- `checkSendRateLimit(req, companyId, name, opts?) → Promise<boolean>` — per-IP + per-company + daily quota for email-send endpoints (M13 / WS-2b). Key prefix: `send:`. Defaults: ipMax=30, companyMax=60, dailyMax=500 per 15-min / 24-hr window.
- `withRateLimit(handler, opts) → NextApiHandler` — middleware wrapper that applies `checkRateLimit(ip, opts)` and returns 429 on breach.
- `clearRateLimitCache()` — clears the LRU; **test use only**.
- `RateLimitOptions` — `{ max: number; windowSecs: number }`.

## Dependencies
- `lru-cache` — in-process LRU short-circuit (10 000 key cap, 5 s TTL)
- `@/lib/neon` — `sql` for the atomic UPSERT
- `@/lib/logger` — warns on 429

## Critical notes
- **Replaced the legacy `rateLimiter.ts`** (BL-21 / S-005); that file has been deleted. Always use `checkRateLimit` from this module for any rate-limiting need.
- **IP extraction gotcha** (BL-20): the FIRST entry in `X-Forwarded-For` is client-supplied and spoofable. This file correctly uses the LAST entry. Do not change this logic.
- **`rate_limit_counters` table** must exist (migration 331) — the `INSERT … ON CONFLICT` will throw without it.
- **Window reset**: uses Postgres `make_interval(secs => N)` — the window resets per key, not globally. Each key is independent.
- **LRU short-circuit only fires below 50% of the limit** — above that threshold every request hits the DB to ensure accurate enforcement near the limit.
- **Security**: keys should never embed user-supplied strings without sanitisation; use composite keys like `ip:endpoint` rather than raw query params.
