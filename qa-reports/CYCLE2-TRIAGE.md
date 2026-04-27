# Cycle 2 — HTTP Walkthrough Findings

**Tenant:** `IsaDemo2` (`00000000-0000-0000-0000-0000000d4e02`)
**Target:** `http://localhost:3101` (local dev server)
**Auth user:** `admin@isaflow.co.za` (GoTrue id `d8a83148-cca6-4951-b13a-66322e4d5dbc`)

## Executive

Cycle 2 was supposed to fire the seven journeys over real HTTP to confirm/refute the audit's UI-layer claims. **Authentication succeeded, CSRF was issued, but `switch-company` to IsaDemo2 returned 403 "Not a member of that company"** despite the row existing in `company_users`. The underlying behaviour is more interesting than the journey results — it surfaces a **real auth/RLS interaction** worth fixing before any cycle-2 UI claims can be tested.

## What ran

| Step | Result |
|---|---|
| `POST /api/auth/login` (admin@isaflow.co.za / admin123) | 200 — sb-access-token, sb-refresh-token, active_company_id (= original demo) |
| `GET /accounting` to seed CSRF cookie via middleware | Initially 307 → /onboarding (redirect doesn't issue CSRF). Workaround: locally set `ff_onboarding_done=1` cookie, then GET → CSRF cookie issued. |
| `POST /api/auth/switch-company { companyId: '...-d4e02' }` | **403 FORBIDDEN — "Not a member of that company"** |
| Same call against original demo (`...-0001`) | **200 OK** |

## The real finding — switch-company can't see IsaDemo2 row

```sql
-- As postgres (BYPASSRLS):
SELECT 1 FROM company_users
WHERE user_id = 'd8a83148-cca6-4951-b13a-66322e4d5dbc'
  AND company_id = '00000000-0000-0000-0000-0000000d4e02'::uuid;
-- → 1 row (membership exists)

-- As app_user (RLS active, no JWT context):
-- → 0 rows (RLS denies)
```

`switch-company.ts` runs the membership check via `sql` from `@/lib/neon`, which uses the `DATABASE_URL` connection (postgres superuser in dev — should bypass RLS and return the row). Yet it returns 0 rows for IsaDemo2 but 1 row for the original demo.

**Likely cause** — re-reading `withUserAuth.ts`: it does NOT set `request.jwt.claims` or `app.current_company_id` before the handler runs. Then `switch-company.ts` queries `company_users` via the shared connection pool. **If a previous request on the same connection ran under a different `app_user` role with `request.jwt.claims` set, those settings persist on the connection** until the next `RESET`.

`withAuth.ts` (the company-scoped wrapper) DOES set up RLS context inside a transaction with `SET LOCAL ROLE` — but the LOCAL only persists until commit. So that path is clean.

The leak path: a stale connection-level `SET ROLE app_user` (without `LOCAL`) or a JWT claim set with the third arg `false` rather than `true` would persist. Worth grepping for.

This same pattern would explain the audit's "Validation failed" payment behavior — if `customer-payments` POST runs into a connection that's been left in a restrictive RLS state, the row can't be inserted, but no field-level error is surfaced.

## Other secondary findings from this cycle

1. **Login rate limiter stays sticky in dev.** Clearing `rate_limit_counters` table doesn't clear the in-memory LRU on the dev server. Repeated logins during testing trip the 10-attempts-per-15-minute email limit and stay tripped until the LRU TTL (5s per `LRU_TTL_MS`) actually rolls — but in practice the cache appears to hold longer. Worth investigating: is `LRU.set` writing fresh rows from DB whose count is < max? If so it should recover. If not, there's a regression in the recovery path.

2. **`/accounting` redirects to `/onboarding` for any user without `ff_onboarding_done`.** This is the exact UX gap the audit hints at — "after creating a practice client, there is no guided next step". The middleware enforces it but doesn't log the user through onboarding cleanly. Confirm whether this is intentional gating.

3. **CSRF middleware does NOT run on `/api/*` routes.** `middleware.ts` line ~140: any `pathname.startsWith('/api/')` returns `NextResponse.next()` BEFORE the `issueCsrfCookie` block. This means the CSRF cookie is only issued during page navigation — and only after the user has skipped the onboarding redirect. Any flow that goes API → API without an interleaved page view never gets a fresh CSRF cookie. The cookie has no expiry set, so this works in practice for long-lived browser sessions, but it's a subtle gotcha.

## What this means for the original audit's claims

| Audit P0 claim | What we now know |
|---|---|
| Work-item dropdown empty | Could not test over HTTP — blocked by switch-company auth issue. DB-level query (cycle 1) returns rows. |
| Staff-rate-override dropdown empty | Same — blocked. DB-level query returns 4 users. |
| Payment "Validation failed" with no field detail | **Plausibly explained** by the same RLS-context leak hypothesised above: payment INSERT runs on a connection where RLS denies write, but the handler returns a generic 400 instead of the postgres error message. |
| Date persistence | Still untested at HTTP level — needs cycle-3 with browser. |

## Recommended next actions

1. **Reproduce the switch-company 403 reliably**, then trace `withUserAuth → sql → pg.Pool` for any persistent `SET ROLE` or `set_config(..., false)` that survives the request.
2. **Audit every `apiResponse.badRequest('Validation failed')` site** for missing field details. This is broadly applicable — the audit's complaint here is correct independent of the specific repro.
3. **Investigate the LRU rate-limit stickiness** in the dev environment. If the recovery path is broken in dev, it's likely also fragile in prod.
4. **Fix the redirect-doesn't-issue-CSRF gap** in middleware: the redirect builder should also call `issueCsrfCookie(request, redirectResponse)`. This would let `/accounting → /onboarding` issue the cookie too.

## Reproducibility

```bash
# Once dev server is running on :3101 with the IsaDemo2 tenant present,
# and rate-limit counters are clear:

QA_BASE_URL=http://localhost:3101 \
QA_ADMIN_EMAIL=admin@isaflow.co.za \
QA_ADMIN_PASSWORD=admin123 \
COMPANY_ID_ISADEMO2=00000000-0000-0000-0000-0000000d4e02 \
bunx tsx scripts/qa-http-walkthrough.ts

# Comparison: switch-company against the original demo works cleanly:
COMPANY_ID_ISADEMO2=00000000-0000-0000-0000-000000000001 \
bunx tsx scripts/qa-http-walkthrough.ts
```

## Branch state note

A parallel session on this repo committed unrelated work to `audit/p1-schema-validation-banking` mid-cycle, so the original `qa/isademo2-bookkeeping-cycle` branch I created at the start is stale. The provisioning + seed + walkthrough scripts are in `scripts/` (untracked for `qa-*.ts` due to existing gitignore rule). Reports are in `qa-reports/`. None of this work has been committed — that's a deliberate hold pending decisions about (a) which findings warrant code changes and (b) how to land them given the parallel-session contention.
