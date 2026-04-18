# Phase 2 — GoTrue Auth + Postgres RLS

**Date:** 2026-04-18
**Status:** Draft — awaiting user approval before handoff to writing-plans
**Phase:** 2 of the Neon → self-hosted Supabase cutover (Phase 1 shipped 2026-04-18 09:37 SAST)
**Pre-launch with zero real users** — this is the cheapest window we'll ever have to do this.

## Problem

IsaFlow's custom auth has accumulated 47 IDORs across its history. That's not a code-review problem, it's an architectural one: tenant isolation lives in the application layer (`WHERE company_id = ${companyId}` in every query), so a single forgotten filter leaks data across tenants. Phase 1 moved the database to self-hosted Supabase Postgres. Phase 2 closes the loop:

1. Replace the custom auth stack with GoTrue (Supabase's auth service), which brings MFA/OAuth/email flows and a standard JWT model.
2. Enforce tenant isolation at the database layer via Postgres Row-Level Security (RLS), keyed off JWT claims set through per-request session GUCs.
3. Port the invite and registration flows to the new auth primitives.

The goal is to make the 47-IDOR class of bug **structurally impossible**. If a future handler forgets to filter by `company_id`, RLS still rejects cross-tenant rows at the database.

## Goals

- GoTrue is the source of truth for user credentials, passwords, sessions, recovery, and email confirmation.
- Every query against a `company_id`-scoped table runs under a session with RLS policies enforcing `company_id ∈ (caller's memberships)`.
- Existing API handlers (395 of them) stay unchanged — `sql\`...\`` continues to work — via AsyncLocalStorage-bound transactional context.
- Invite flow, register flow, password reset, and company switching all work end-to-end on the new stack.
- Zero usable path from an authenticated user into another tenant's data at any layer (app filter still present as belt-and-braces; RLS is primary).

## Non-goals (explicit Phase 3)

- Customer portal auth (`portalAuth.ts`, `portalJwt.ts`) — stays on the separate custom path.
- OAuth providers (Google, Microsoft) — GoTrue supports them; not needed for launch.
- Migrating TOTP MFA to GoTrue's — our implementation has trusted-devices + backup codes; keep custom for now.
- Supavisor transaction pooling (port 6543) — stays on direct `:5437` until per-tenant Supavisor config lands.
- Removing app-layer `WHERE company_id` filters — deferred forever or until a dedicated cleanup sprint.
- Row-level read policies more granular than tenant isolation.

## Decisions locked in during brainstorm

| Question | Decision |
|---|---|
| Cutover strategy | **Big-bang on a feature branch**, then ship. Pre-launch, zero users, no dual-path code. |
| Tx plumbing | **AsyncLocalStorage-bound `sql`** — zero handler churn across 395 API files. |
| User identity | **Keep `isaflow` as its own DB + JWT-trust.** `company_members.user_id uuid` with no FK (cross-DB). Phase 1 architecture preserved. |
| App-layer filters | **Keep as belt-and-braces.** RLS primary, `WHERE company_id = ?` secondary. |
| Portal scope | **Main app only this phase.** Portal stays on custom portal-JWT. |
| Invite flow | **Admin-create + our-own-email.** Bypasses the SMTP-for-invites gate; uses our branded mailer. |
| SMTP timing | **Wired up in Phase 2** for password reset and email-change flows. |
| RLS rollout | **All 117 `company_id` tables in one migration.** DO-block over `information_schema`. |

## § 1. Architecture

Three cooperating pieces replace the custom auth stack:

```
Browser
  - sb-access-token   (httpOnly, ~1h, HS256 JWT signed by shared JWT_SECRET)
  - sb-refresh-token  (httpOnly, ~30d)
  - active_company_id (httpOnly, set on login/switch)
  - CSRF token        (readable; existing pattern unchanged)

Next.js API route
  handler = withAuth(withErrorHandler(handler))
    1. Verify JWT with jose + shared JWT_SECRET
    2. Load active company membership (belt-and-braces: stale cookie check)
    3. Pool.connect() → BEGIN → SET LOCAL ROLE app_user
    4. set_config('request.jwt.claims', <json>, true)
    5. set_config('app.current_company_id', <uuid>, true)
    6. ALS.run({client, userId, companyId, claims}, () => handler(req, res))
    7. COMMIT (or ROLLBACK on throw) → client.release()

src/lib/neon.ts
  export const sql: tagged-template identical to today
    - if ALS.getStore() has a client → run on that client (RLS-scoped)
    - else → fall back to pool.query (scripts, cron, migrations)

isaflow DB @ velo:5437
  - RLS on all 117 company_id tables
  - Policy: company_id ∈ (SELECT company_id FROM company_members WHERE user_id = auth.uid())
  - WITH CHECK: company_id = app.current_company_id()
  - auth.uid() reads request.jwt.claims → sub
  - app_user role, FORCE ROW LEVEL SECURITY (superuser cannot bypass)

GoTrue @ velo:8300/auth/v1/*  (in shared postgres DB)
  - /auth/v1/token (login, refresh)
  - /auth/v1/admin/* (service-role; used for admin-create invites)
  - /auth/v1/recover (password reset via SMTP)
```

**Key invariant.** Every request runs as `app_user` (non-superuser) inside a tx with GUCs set. No code path lets a request reach Postgres without those GUCs — if ALS lookup fails, the query connection is the pool fallback which still runs as `app_user` with no claims. RLS then returns zero rows rather than leaking data (safe-fail, not leak-fail).

## § 2. Database layer

One new migration (`348_rls_and_auth_helpers.sql`) with `IF NOT EXISTS` everywhere.

### Roles

```sql
CREATE ROLE app_user NOLOGIN;
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;

GRANT app_user TO postgres;  -- so SET LOCAL ROLE works from the pool connection

CREATE ROLE migration_admin WITH LOGIN BYPASSRLS PASSWORD '<in /home/velo/supabase/.env>';
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO migration_admin;
```

### Helper schemas + functions

```sql
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub'
$$;

CREATE OR REPLACE FUNCTION app.current_company_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.current_company_id', true), '')::uuid
$$;
```

### RLS rollout across all 117 `company_id` tables

```sql
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb USING (table_schema, table_name)
    WHERE c.column_name = 'company_id'
      AND c.table_schema = 'public'
      AND tb.table_type = 'BASE TABLE'
      AND c.table_name NOT IN ('companies')  -- handled separately below
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      DROP POLICY IF EXISTS tenant_isolation ON public.%1$I;
      CREATE POLICY tenant_isolation ON public.%1$I
        FOR ALL TO app_user
        USING (company_id IN (
          SELECT company_id FROM company_members
           WHERE user_id = auth.uid()
        ))
        WITH CHECK (company_id = app.current_company_id());
    $p$, t);
  END LOOP;
END $$;
```

### Special-case policies

```sql
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
CREATE POLICY companies_member_read ON companies FOR SELECT TO app_user
  USING (id IN (SELECT company_id FROM company_members WHERE user_id = auth.uid()));
CREATE POLICY companies_owner_write ON companies FOR ALL TO app_user
  USING (id IN (SELECT company_id FROM company_members
                 WHERE user_id = auth.uid() AND role IN ('owner','admin')))
  WITH CHECK (id = app.current_company_id());

ALTER TABLE company_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_members FORCE ROW LEVEL SECURITY;
CREATE POLICY cm_self_or_admin ON company_members FOR ALL TO app_user
  USING (user_id = auth.uid() OR company_id IN (
    SELECT company_id FROM company_members
     WHERE user_id = auth.uid() AND role IN ('owner','admin')
  ))
  WITH CHECK (company_id = app.current_company_id());
```

### `company_invitations` anonymous-token policy

```sql
CREATE POLICY invites_by_token ON company_invitations FOR SELECT
  USING (token = nullif(current_setting('app.invite_token', true), ''));
```

Used by the anonymous `withInviteToken` middleware during invite acceptance.

### Migration 349 — trim `users` to profile shadow

```sql
ALTER TABLE users DROP COLUMN IF EXISTS password_hash;
ALTER TABLE users DROP COLUMN IF EXISTS email_verified;
ALTER TABLE users DROP COLUMN IF EXISTS password_reset_token;
ALTER TABLE users DROP COLUMN IF EXISTS password_reset_expires;
-- Keep: id (uuid = auth.users.id, no FK, cross-DB), email, display_name,
--       avatar_url, timezone, locale, created_at, updated_at
```

Profile sync: backend upserts to both sides in a single service (`upsertUserProfile`). No trigger (cross-DB). GoTrue webhooks are Phase 3 polish.

### Migration 350 — invitations gets GoTrue user binding

```sql
ALTER TABLE company_invitations ADD COLUMN IF NOT EXISTS gotrue_user_id uuid;
ALTER TABLE company_invitations ADD COLUMN IF NOT EXISTS accepted_at timestamptz;
```

## § 3. Auth layer

### Deletions (~1,400 LOC)

| File | Fate |
|---|---|
| `src/lib/auth/jwt.ts` | Deleted. GoTrue signs; `jose` verifies. |
| `src/lib/auth/password.ts` | Deleted. GoTrue owns hashing. |
| `src/lib/auth/session.ts` | Rewritten (smaller). |
| `src/lib/auth/sessionHelpers.ts` | Rewritten. |
| `src/lib/auth/middleware.ts` | Rewritten → `withAuth.ts`. |
| `src/lib/auth/withCompany.ts` | Folded into `withAuth`. |
| `src/lib/auth/app-router.ts` | Rewritten for App-router. |

### Kept as-is

`csrf.ts`, `withCsrf.ts`, `permissionService.ts`, `withModulePermission.ts`, `withWriteAccess.ts`, `portalAuth.ts`, `portalJwt.ts`, `types.ts`.

### New files

| File | Purpose |
|---|---|
| `src/lib/auth/gotrue.ts` | Typed GoTrue client: `verifyToken`, `signIn`, `refresh`, `adminCreateUser`, `adminGenerateLink`, `adminDeleteUser`, `recoverPassword`. |
| `src/lib/auth/withAuth.ts` | Page-router middleware (see §4). |
| `src/lib/auth/withInviteToken.ts` | Anonymous invite-accept middleware. |
| `src/lib/auth/cookies.ts` | Cookie set/clear helpers with consistent flags. |
| `src/lib/als.ts` | `AsyncLocalStorage<RequestContext>` singleton. |

### API-route rewrites (17 endpoints under `pages/api/auth/`)

| Endpoint | New behavior |
|---|---|
| `POST /api/auth/login` | `/auth/v1/token?grant_type=password`. Set access+refresh cookies. Set `active_company_id` to first (or last-used) membership. |
| `POST /api/auth/register` | `/auth/v1/admin/users` with `email_confirm:true`. Create company + membership + profile shadow in one bootstrap tx. |
| `POST /api/auth/logout` | `/auth/v1/logout`. Clear cookies. |
| `GET /api/auth/me` | Decode JWT → query `company_members` + profile shadow → return UI shape. |
| `POST /api/auth/forgot-password` | `/auth/v1/recover` (GoTrue SMTP). |
| `POST /api/auth/do-reset-password` | `/auth/v1/user` with recovery session. |
| `POST /api/auth/change-password` | Re-auth then `/auth/v1/user`. |
| `2fa-*` | **Unchanged** — keep custom TOTP (trusted devices, backup codes). |
| `impersonate-exchange`, `user-impersonate-exchange` | Admin API mints a scoped token for the target user; trail in `audit_trail`. |
| `preferences`, `profile` | Read/write the profile shadow only. |

### JWT shape (standard GoTrue; we add no custom claims)

```json
{
  "aud": "authenticated",
  "role": "authenticated",
  "sub": "<user-uuid>",
  "email": "alice@acme.co.za",
  "exp": 1748000000,
  "iat": 1747996400,
  "app_metadata": {},
  "user_metadata": { "display_name": "Alice" }
}
```

**Company is cookie-scoped**, not JWT-claim-scoped. Users switch companies without re-issuing tokens. `withAuth` validates membership per request.

## § 4. Request middleware + ALS-bound sql

### `src/lib/als.ts`

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';

export interface RequestContext {
  client: PoolClient;
  userId: string;
  companyId: string;
  claims: Record<string, unknown>;
}

export const als = new AsyncLocalStorage<RequestContext>();

export function requireCtx(): RequestContext {
  const ctx = als.getStore();
  if (!ctx) throw new Error('als: no request context — handler called outside withAuth?');
  return ctx;
}
```

### `src/lib/neon.ts` — ALS-aware sql (rewrite keeping API identical)

- Tagged-template signature unchanged: `sql\`SELECT * FROM foo WHERE id=${id}\``.
- If `als.getStore()` returns a context → query runs on `ctx.client` (inside the request tx, RLS-scoped).
- Else → falls through to pool (scripts, cron, migrations).
- `sql.transaction(fn)` nests via SAVEPOINT when already in a request tx; opens a fresh tx on the pool otherwise.

### `src/lib/auth/withAuth.ts`

```ts
import type { NextApiHandler } from 'next';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { verifyToken } from './gotrue';
import { parseCookies, clearAuthCookies } from './cookies';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });

export function withAuth(handler: NextApiHandler): NextApiHandler {
  return async (req, res) => {
    const { 'sb-access-token': accessToken, active_company_id } = parseCookies(req);
    if (!accessToken) return res.status(401).json({ error: 'unauthenticated' });

    let claims: { sub: string; [k: string]: unknown };
    try { claims = await verifyToken(accessToken); }
    catch { clearAuthCookies(res); return res.status(401).json({ error: 'invalid_token' }); }

    if (!active_company_id) return res.status(400).json({ error: 'no_active_company' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [active_company_id]);

      const { rows } = await client.query(
        `SELECT 1 FROM company_members WHERE user_id = $1 AND company_id = $2`,
        [claims.sub, active_company_id]
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        clearAuthCookies(res);
        return res.status(403).json({ error: 'not_a_member' });
      }

      await als.run(
        { client, userId: claims.sub, companyId: active_company_id, claims },
        async () => { await handler(req, res); }
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
}
```

### Codemod for all handlers

```bash
rg -l 'withCompany\(withErrorHandler' pages/api | xargs sed -i \
  's/withCompany(withErrorHandler(handler as any))/withAuth(withErrorHandler(handler))/'
```

Post-codemod: `bunx tsc --noEmit` must pass. Remaining `withCompany` references get flagged by grep.

### Pool-isolation regression test

`tests/integration/rls-pool-isolation.test.ts` — pool size 1, 20 interleaved requests alternating two users, each asserts its own `current_setting('app.current_company_id')`. Zero cross-talk = pass.

### Observable failure modes

| Failure | Result |
|---|---|
| `sql` called outside withAuth | Pool fallback; runs as `app_user` with no claims → RLS returns empty. Safe. |
| Handler throws mid-request | `ROLLBACK` in finally. Connection released. |
| Stale `active_company_id` cookie | Membership check fails → 403 + cookie cleared. |
| Token expired | `verifyToken` throws → 401. Frontend refresh path retries. |
| Company switch | `/api/auth/switch-company` validates membership + rotates cookie. |

## § 5. Invite + register flows

### Endpoints

| Endpoint | Middleware | Purpose |
|---|---|---|
| `POST /api/invitations` | withAuth | Create invitation + GoTrue admin-create user + send our email |
| `GET /api/invitations/[token]` | withInviteToken | Return invite metadata for /accept-invite page |
| `POST /api/invitations/[token]/accept` | withInviteToken | Set password, sign in, insert `company_members`, redirect |
| `DELETE /api/invitations/[id]` | withAuth | Revoke pending invite |
| `GET /api/invitations` | withAuth | List pending invites for a company |

### Create-invite flow

1. `INSERT INTO company_invitations` with 32-byte hex token, 7-day expiry.
2. `POST /auth/v1/admin/users` with `email_confirm:true`, `user_metadata={invite_id}`. On 422 "already exists", reuse the existing `auth.users.id` (multi-company case).
3. Stash `gotrue_user_id` on the invitation row.
4. Send branded email via our existing mailer with `https://app.isaflow.co.za/accept-invite?token=…`.

Idempotency: retries are safe. GoTrue 422 → reuse. Email-send failure → user re-issues, token rotates, GoTrue user is reused. No orphan cleanup needed — a GoTrue user without a matching `company_members` row can't log in (password never set → grant_type=password fails).

### Accept-invite flow (anonymous, via withInviteToken)

1. Look up invitation by token (policy `invites_by_token` allows this SELECT without a JWT).
2. `PUT /auth/v1/admin/users/{gotrue_user_id}` with the chosen password.
3. `POST /auth/v1/token?grant_type=password` to get tokens.
4. `INSERT INTO company_members (user_id, company_id, role) ON CONFLICT DO NOTHING`.
5. `INSERT INTO users … ON CONFLICT DO UPDATE` — profile shadow.
6. `UPDATE company_invitations SET accepted_at = now()`.
7. Set cookies, redirect to `/dashboard`.

### Self-signup (no invite)

`POST /api/auth/register { email, password, company_name }` runs in a bootstrap tx as `migration_admin` (BYPASSRLS, because RLS would refuse the first `company_members` insert via `USING` clause before the row exists). Creates GoTrue user, company, owner membership, profile shadow, seeds default chart-of-accounts. Rate-limited + CAPTCHA guarded (existing).

## § 6. SMTP

Added to `/home/velo/supabase/.env`:

```bash
GOTRUE_SMTP_HOST=smtp.postmarkapp.com
GOTRUE_SMTP_PORT=587
GOTRUE_SMTP_USER=<postmark server token>
GOTRUE_SMTP_PASS=<postmark server token>
GOTRUE_SMTP_ADMIN_EMAIL=noreply@isaflow.co.za
GOTRUE_SMTP_SENDER_NAME=IsaFlow
GOTRUE_MAILER_URLPATHS_RECOVERY=/auth/reset-password
GOTRUE_MAILER_URLPATHS_CONFIRMATION=/auth/confirm
GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE=/auth/confirm-email-change
GOTRUE_MAILER_AUTOCONFIRM=false
GOTRUE_SITE_URL=https://app.isaflow.co.za
GOTRUE_URI_ALLOW_LIST=https://app.isaflow.co.za,https://dev.isaflow.co.za
```

Reload: `docker compose up -d supabase-auth`. One-time verify: `/auth/v1/recover` with a test email delivers.

### Mailer split

| Flow | Mailer |
|---|---|
| Invite | Ours — branded templates, observability, existing Postmark setup |
| Password reset | GoTrue — only GoTrue generates recovery tokens |
| Email change confirm | GoTrue — GoTrue-owned token |
| Email verification on signup | N/A — `email_confirm:true` via admin-create |
| Invoice/statement/notifications | Ours — unchanged |

## § 7. Testing strategy

### Unit (Vitest)

- `gotrue.test.ts` — JWT verify, token-shape, error paths (mocked fetch).
- `als.test.ts` — context isolation across sibling async ops; nested inheritance.
- `neon.test.ts` — tagged-template binding, savepoint-nested transactions.

### Integration (Vitest + real `isaflow_dev` DB)

- `rls-pool-isolation.test.ts` — the 20-request interleaved test from the spike.
- `rls-policy-coverage.test.ts` — programmatic: every `company_id` table has `rowsecurity=true`, `forcerowsecurity=true`, and at least one policy for `app_user`.
- `rls-tenant-read-isolation.test.ts` — two tenants seeded across every table; each asserts it cannot read the other's rows.
- `rls-tenant-write-isolation.test.ts` — `INSERT` with wrong `company_id` rejected by `WITH CHECK`.

### E2E (Playwright)

- `auth.spec.ts` — login, logout, expiry → refresh → retry, switch company.
- `invite.spec.ts` — admin creates invite → email captured → accept → new user in dashboard.
- `password-reset.spec.ts` — forgot → email link → new password → login.
- `cross-tenant-smoke.spec.ts` — authenticated API calls with another tenant's IDs return 404/empty, never 200 with data.

### CI gate

```
1. bunx tsc --noEmit
2. bun run test:unit
3. bun run test:integration   (DATABASE_URL=isaflow_dev; applies 348–350 to a reset DB)
4. bun run test:e2e:smoke
```

## § 8. Observability

- Sentry scope: every request gets `gotrue_user_id` + `active_company_id` tags (extends BL-53 Sentry integration).
- New metric: `auth.withAuth.duration_ms` p50/p99. Spike measured 2–4 ms overhead; alert on regression.
- Audit log (`audit_trail`, BL-267) entries: login, logout, password change, invite create, invite accept, company switch.

## § 9. Cutover plan

Single feature branch `phase2/gotrue-rls`.

**Stage 1 — foundation** (~1 day)
1. Migration 348 — roles, helpers, RLS + policies (all 117 tables).
2. Migration 349 — trim `users` to profile shadow.
3. Migration 350 — invitations gets `gotrue_user_id`, `accepted_at`.
4. `src/lib/als.ts` — new.
5. `src/lib/neon.ts` — rewrite ALS-aware.
6. `rls-pool-isolation.test.ts` green.

**Stage 2 — auth swap** (~2 days)
7. `gotrue.ts`, `cookies.ts`, `withAuth.ts`.
8. Codemod all handlers to `withAuth`.
9. Rewrite 17 `pages/api/auth/*` endpoints.
10. Delete `jwt.ts`, `password.ts`, old `middleware.ts`, old `session.ts`, `withCompany.ts`.
11. `bunx tsc --noEmit` green.

**Stage 3 — invite + register** (~1 day)
12. Rewrite `pages/api/invitations/*`.
13. Rewrite `pages/api/auth/register.ts`.
14. `withInviteToken` middleware.

**Stage 4 — tests + SMTP** (~1–2 days)
15. RLS policy-coverage test.
16. Tenant read/write isolation tests.
17. SMTP env + GoTrue reload + recovery email verified.
18. E2E suites: auth, invite, password-reset, cross-tenant-smoke.

**Stage 5 — scripts + observability** (~1 day)
19. Convert admin scripts to connect as `migration_admin`.
20. Sentry tags + duration metric.
21. Rollback script + dev-DB rollback rehearsal.

**Stage 6 — prod cutover** (~2 hours window, after hours)
22. Tag `v-pre-phase2` on master.
23. Merge `phase2/gotrue-rls` → master; deploy via existing `deploy.sh`.
24. Run migrations 348–350 on prod `isaflow` DB.
25. Smoke test: register new user, invite second user, observe isolation.
26. Re-create Brightsphere test account through the new flow.

## § 10. Rollback plan

**Pre-merge in dev:** `git checkout master` — no prod impact.

**Post-merge in prod:**
1. `git checkout v-pre-phase2` + `deploy.sh` → restores custom-auth app.
2. `psql … -f scripts/rollback/phase2-disable-rls.sql` — drops policies, disables RLS, drops helpers. Tested against dev as part of Stage 5.
3. GoTrue users created in prod stay in shared `postgres` DB (harmless; no main-app path without the new auth).

The rollback script is written, tested, and committed as part of the Phase 2 PR.

## § 11. Success criteria

- All 117 `company_id` tables: `rowsecurity=true` and `forcerowsecurity=true` on prod.
- Custom auth files deleted (visible in `git log`).
- `rls-pool-isolation` passes with pool size 1 across 20 interleaved requests.
- `cross-tenant-smoke` E2E: no authenticated API call returns another tenant's data.
- `/api/invitations` flow end-to-end in dev: create → email → accept → membership.
- Password reset end-to-end in dev via SMTP.
- Prod smoke post-cutover: register, invite, isolation holds.
- Sentry: zero auth-middleware error spikes in first 24h post-cutover.

## § 12. Risks

| Risk | Mitigation |
|---|---|
| `set_config(..., true)` leaks across pool connections | `rls-pool-isolation` gate; merge blocked if it fails |
| Missed RLS policy on a table | `rls-policy-coverage` iterates `information_schema` — can't miss |
| Background jobs bypass RLS silently | Pool fallback still runs as `app_user`; jobs must opt-in to `migration_admin` |
| Token theft → cross-tenant access | httpOnly cookies, 1h access token, refresh rotation |
| SMTP outage breaks password reset | Postmark delivery monitor; admin-API fallback |
| Codemod miss | `bunx tsc --noEmit` + grep for remaining `withCompany` |

## Open questions (nothing blocking — flag if you disagree)

- **Refresh-token rotation cadence:** GoTrue default is single-use (rotate on every refresh). We'll use that. If it causes issues with parallel tabs, we switch to reuse-window.
- **Active-company cookie lifetime:** tied to refresh token (30d). If a user returns 29 days later they still land on last-used company. Acceptable.
- **Role shape inside `company_members`:** using existing `role` enum (`owner`, `admin`, `member`, …). RLS admin-write policies key off `role IN ('owner','admin')`. Matches today's app-layer checks.
