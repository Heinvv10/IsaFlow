# `src/lib/rateLimit.ts`

## Purpose
Postgres-backed (DB-persisted) rate limiter — shares counters across all pods via the `rate_limit_counters` table (migration 331). There is no Redis dependency; all persistence is through Postgres.

## Key exports

- `checkRateLimit(key, opts) → Promise<boolean>` — returns `true` if the request is allowed; key is any string (typically IP or `companyId:endpoint`). Atomically UPSERTs the counter in Postgres by `opts.cost` (default 1) on **every** call, admitted or refused, and admits while the returned count is `<= max`. No in-process state (R-175).
- `getClientIp(req) → string` — extracts the real client IP from `X-Forwarded-For` (last value = nginx-appended, spoofing-resistant). Never use `req.socket.remoteAddress` directly.
- `checkAiRateLimit(req, companyId, name, opts?) → Promise<boolean>` — per-IP + per-company + daily quota for AI/LLM endpoints. Key prefix: `ai:`. Defaults: ipMax=20, companyMax=40, dailyMax=300 per 15-min / 24-hr window.
- `checkSendRateLimit(req, companyId, name, opts?) → Promise<boolean>` — per-IP + per-company + daily quota for email-send endpoints (M13 / WS-2b). Key prefix: `send:`. Defaults: ipMax=30, companyMax=60, dailyMax=500 per 15-min / 24-hr window. `opts.count` (default 1) weights the cost by batch size — e.g. a bulk-send of N recipients should pass `count: N` so it charges N units instead of 1 (ratelimit-cost-weighting fix).
- `withRateLimit(handler, opts) → NextApiHandler` — middleware wrapper that applies `checkRateLimit(ip, opts)` and returns 429 on breach.
- `refundRateLimit(key, units) → Promise<void>` — gives units back to the current window; floors at zero, never moves `window_start`. Same pool as the charge.
- `clearRateLimitCache()` — a no-op since R-175 (there is no cache); kept for tests that still call it.
- `RateLimitOptions` — `{ max: number; windowSecs: number; cost?: number }`.

## Dependencies
- `@/lib/rateLimitPool` — the limiter's own `pg.Pool` for the atomic UPSERT and the refund
- `@/lib/logger` — warns on 429

## Critical notes
- **Replaced the legacy `rateLimiter.ts`** (BL-21 / S-005); that file has been deleted. Always use `checkRateLimit` from this module for any rate-limiting need.
- **IP extraction gotcha** (BL-20): the FIRST entry in `X-Forwarded-For` is client-supplied and spoofable. This file correctly uses the LAST entry. Do not change this logic.
- **`rate_limit_counters` table** must exist (migration 331) — the `INSERT … ON CONFLICT` will throw without it.
- **Window reset**: uses Postgres `make_interval(secs => N)` — the window resets per key, not globally. Each key is independent.
- **No admitting cache (R-175)** — the old LRU short-circuit admitted calls it never wrote to the table, so a limit of 20 admitted ~65 per window on one process. Every call now costs one UPSERT. If that round-trip ever needs saving, a cache may only REFUSE early (a key the DB already reported over its limit, until its window ends); it must never admit.
- **The counter never joins the caller's transaction (K-103)** — charge and refund run on the limiter's own pool (`src/lib/rateLimitPool.ts`, 3 connections per process, 5 s connect timeout), so the charge commits at once, survives a request that rolls back, and holds no row lock past its own statement. Do not route them through `sql`: inside a request that joins the request transaction. Do not use the main pool either: a request already holds one of its connections, and a second from the same pool deadlocks under load until the connect timeout.
- **A limiter DB error throws** — no caller catches it, so the request fails (500). It is never admitted unchecked. Keep it that way.
- **Security**: keys should never embed user-supplied strings without sanitisation; use composite keys like `ip:endpoint` rather than raw query params.
