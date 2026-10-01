# `src/lib/rateLimit.ts`

## Purpose
Postgres-backed (DB-persisted) rate limiter — shares counters across all pods via the `rate_limit_counters` table (migration 331). There is no Redis dependency; all persistence is through Postgres.

## Key exports

- `checkRateLimit(key, opts) → Promise<boolean>` — returns `true` if the request is allowed; key is any string (typically IP or `companyId:endpoint`). Atomically UPSERTs the counter in Postgres by `opts.cost` (default 1) on **every** call, admitted or refused, and admits while the returned count is `<= max`. No in-process state (R-175).
- `getClientIp(req) → string` — extracts the real client IP from `X-Forwarded-For` (last value = nginx-appended, spoofing-resistant). Never use `req.socket.remoteAddress` directly.
- `checkAiRateLimit(req, companyId, name, opts?) → Promise<boolean>` — per-IP + per-company + daily quota for AI/LLM endpoints. Key prefix: `ai:`. Defaults: ipMax=20, companyMax=40, dailyMax=300 per 15-min / 24-hr window.
- `checkSendRateLimit(req, companyId, name, opts?) → Promise<boolean>` — per-IP + per-company + daily quota for email-send endpoints (M13 / WS-2b). Key prefix: `send:`. Defaults: ipMax=30, companyMax=60, dailyMax=500 per 15-min / 24-hr window. `opts.count` (default 1) weights the cost by batch size — e.g. a bulk-send of N recipients should pass `count: N` so it charges N units instead of 1 (ratelimit-cost-weighting fix).
- `withRateLimit(handler, opts) → NextApiHandler` — middleware wrapper that applies `checkRateLimit(ip, opts)` and returns 429 on breach.
- `refundRateLimit(key, units) → Promise<void>` — gives units back to the current window; floors at zero, never moves `window_start`.
- `clearRateLimitCache()` — a no-op since R-175 (there is no cache); kept for tests that still call it.
- `RateLimitOptions` — `{ max: number; windowSecs: number; cost?: number }`.

## Dependencies
- `@/lib/neon` — `sql` for the atomic UPSERT
- `@/lib/logger` — warns on 429

## Critical notes
- **Replaced the legacy `rateLimiter.ts`** (BL-21 / S-005); that file has been deleted. Always use `checkRateLimit` from this module for any rate-limiting need.
- **IP extraction gotcha** (BL-20): the FIRST entry in `X-Forwarded-For` is client-supplied and spoofable. This file correctly uses the LAST entry. Do not change this logic.
- **`rate_limit_counters` table** must exist (migration 331) — the `INSERT … ON CONFLICT` will throw without it.
- **Window reset**: uses Postgres `make_interval(secs => N)` — the window resets per key, not globally. Each key is independent.
- **No admitting cache (R-175)** — the old LRU short-circuit admitted calls it never wrote to the table, so a limit of 20 admitted ~65 per window on one process. Every call now costs one UPSERT. If that round-trip ever needs saving, a cache may only REFUSE early (a key the DB already reported over its limit, until its window ends); it must never admit.
- **The UPSERT joins the caller's transaction** — `sql` routes onto an in-flight `withAuth` transaction, so there the charge is rolled back with the request (≥500) and the key's row lock is held until COMMIT. A caller that needs the charge to survive, or must not hold the lock, wraps the call in `als.exit` (see `pages/api/invitations/[token]/accept.ts`).
- **Security**: keys should never embed user-supplied strings without sanitisation; use composite keys like `ip:endpoint` rather than raw query params.
