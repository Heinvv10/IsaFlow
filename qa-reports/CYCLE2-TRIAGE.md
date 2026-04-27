# Cycle 2 — HTTP Walkthrough Findings

**Tenant:** `IsaDemo2 (QA fixture)` (`00000000-0000-0000-0000-0000000d4e02`)
**Target:** `http://localhost:3101` (local dev server)
**Auth user:** redacted dev-fixture admin

## Executive

Cycle 2 was supposed to fire the seven journeys over real HTTP to confirm/refute the audit's UI-layer claims. **Authentication succeeded, CSRF was issued, but `switch-company` to IsaDemo2 returned 403 "Not a member of that company"** despite the row existing in `company_users`. The underlying behaviour is more interesting than the journey results — it surfaces a **real auth/RLS interaction** worth fixing before any cycle-2 UI claims can be tested.

## What ran

| Step | Result |
|---|---|
| `POST /api/auth/login` | 200 — sb-access-token, sb-refresh-token, active_company_id (= original demo) |
| `GET /accounting` to seed CSRF cookie via middleware | Initially 307 → /onboarding (redirect doesn't issue CSRF). Workaround: locally set `ff_onboarding_done=1` cookie, then GET → CSRF cookie issued. |
| `POST /api/auth/switch-company { companyId: '...-d4e02' }` | **403 FORBIDDEN — "Not a member of that company"** |
| Same call against original demo (`...-0001`) | **200 OK** |

## The real finding — switch-company can't see IsaDemo2 row

```sql
-- As postgres (BYPASSRLS):
SELECT 1 FROM company_users
WHERE user_id = '<redacted-uuid>'
  AND company_id = '00000000-0000-0000-0000-0000000d4e02'::uuid;
-- → 1 row (membership exists)

-- As app_user (RLS active, no JWT context):
-- → 0 rows (RLS denies)
```

`switch-company.ts` runs the membership check via `sql` from `@/lib/neon`. In dev the connection is the `postgres` superuser, which would bypass RLS — yet the query returns 0 rows for IsaDemo2 but 1 row for the original demo. Two competing hypotheses:

### Hypothesis A (most likely) — `withUserAuth` does not set RLS context

`pages/api/auth/switch-company.ts` is wrapped in `withUserAuth` (NOT `withAuth`). `withUserAuth` (`src/lib/auth/withUserAuth.ts`) only verifies the JWT and attaches `req.user`. It does NOT:

- Open a transaction,
- Set `LOCAL ROLE app_user`,
- Set `request.jwt.claims` so `auth.uid()` resolves.

That setup lives in `withAuth.ts` lines ~108-112 — but **only `withAuth` does it**, not `withUserAuth`.

The downstream `sql\`...\`` call from `@/lib/neon` checks out a connection from the module-level pool. **If the connection role is `app_user` and `company_users` is FORCED RLS** (migration 348:117 or thereabouts), then policy `cu_self_or_admin` filters by `auth.uid() = user_id`. With no JWT claim ever set, `auth.uid()` returns NULL, the predicate evaluates to NULL (not true), and every row is filtered out — including IsaDemo2 *and* the original demo. So the asymmetry between the two companies is unexplained by RLS alone.

### Hypothesis B — connection-state leak

A previous request on the same pooled connection ran under `withAuth` with `SET LOCAL ROLE app_user` + JWT claim. `LOCAL` is supposed to scope to the transaction, but if any code path uses non-LOCAL `SET ROLE` or `set_config(..., false)`, those settings persist on the connection across checkouts. This would explain a *non-deterministic* asymmetry between two queries that look identical.

### Why the original demo "works" and IsaDemo2 doesn't

Most likely: the test session had previously made an authenticated request that left `request.jwt.claims` populated for the original-demo membership, the `sql` call piggybacked on it for the original-demo lookup, and a later checkout returned a fresh connection with no claims — which then failed the IsaDemo2 lookup. This is an artefact of pool state, not a stable bug.

**Both hypotheses point to the same fix:** `switch-company` should not depend on RLS context for a basic membership check. Either:

- (preferred) wrap `switch-company` in `withAuth` so it always opens a transaction with the JWT-claim setup, OR
- run the membership check in a deliberate "no-RLS" path (e.g. a dedicated function that uses the migration-admin URL or sets the role/claim explicitly).

Either way, this is **unverified** — needs reproducing before code changes.

## Other secondary findings from this cycle

1. **Login rate limiter stays sticky in dev.** Clearing `rate_limit_counters` table doesn't immediately recover login. Worth investigating: is `LRU.set` writing fresh rows from DB whose count is < max? If so it should recover. If not, there's a regression in the recovery path.

2. **`/accounting` redirects to `/onboarding` for any user without `ff_onboarding_done`.** The middleware enforces it but doesn't log the user through onboarding cleanly. Confirm whether this is intentional gating.

3. **CSRF middleware does NOT run on `/api/*` routes.** `middleware.ts` returns `NextResponse.next()` BEFORE the `issueCsrfCookie` block for any `/api/*` path. So the CSRF cookie is only issued during page navigation — and only after the user has skipped the onboarding redirect. **The redirect itself also doesn't issue CSRF** — the redirect response is created with `NextResponse.redirect` and the `issueCsrfCookie` wrapper is only applied to `NextResponse.next()`. Fix: wrap the redirect response too.

## What this means for the original audit's claims

| Audit P0 claim | What we now know |
|---|---|
| Work-item dropdown empty | Could not test over HTTP — blocked by switch-company auth issue. DB-level query (cycle 1) returns rows. |
| Staff-rate-override dropdown empty | Same — blocked. DB-level query returns 4 users. |
| Payment "Validation failed" with no field detail | **Plausibly explained** by hypothesis A: payment `INSERT` runs on a connection where RLS denies write, but the handler returns a generic 400 instead of the postgres error message. Worth direct repro. |
| Date persistence | Still untested at HTTP level — needs cycle 3 with browser. |

## Recommended next actions

1. **Reproduce the switch-company 403 reliably**, then trace `withUserAuth → sql → pg.Pool`. Confirm or refute hypothesis A by checking whether the route correctly works when wrapped in `withAuth`. Audit for any non-LOCAL `SET ROLE` or `set_config(..., false)` paths.
2. **Audit every `apiResponse.badRequest('Validation failed')` site** for missing field details. This is broadly applicable — the audit's complaint here is correct independent of the specific repro.
3. **Investigate the LRU rate-limit stickiness** in the dev environment.
4. **Fix the redirect-doesn't-issue-CSRF gap** in middleware: redirect responses should also call `issueCsrfCookie(request, redirectResponse)`.

## Reproducibility

```bash
# Once dev server is running on :3101 with the IsaDemo2 tenant present,
# and rate-limit counters are clear, set credentials in .env.local or shell:
#
#   QA_ADMIN_EMAIL=<your dev admin email>
#   QA_ADMIN_PASSWORD=<your dev admin password>
#
# (No defaults — the script fails loudly if these are unset.)

QA_BASE_URL=http://localhost:3101 \
QA_ADMIN_EMAIL=<dev admin email> \
QA_ADMIN_PASSWORD=<dev admin password> \
bunx tsx scripts/qa-http-walkthrough.ts
```
