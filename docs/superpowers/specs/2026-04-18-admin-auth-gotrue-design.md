# Admin Platform Auth on GoTrue + RLS — Design

**Date:** 2026-04-18
**Status:** Design — awaiting implementation
**Context:** Phase 3 follow-up to the Supabase cutover. Phase 2 (GoTrue + RLS) shipped 2026-04-18 and unblocked the main app. `admin.isaflow.co.za` is currently unusable because its auth path assumes the pre-cutover custom-JWT world.

## Problem

After Phase 2, `withAdmin` composes `withAuth` + `withRole('super_admin')`. The new `withAuth` requires an `active_company_id` cookie and checks `company_users.role` — both tenant-scoped concepts. This does not fit admin, which is a *platform-level* portal that must see across every tenant:

1. Admin pages should not require an active company to function.
2. "Super admin" is a property of the person, not a membership role.
3. RLS policies filter every tenant table by `auth.user_companies()`, so even a super-admin JWT cannot read other tenants' data under the current `app_user` role.
4. Admin cookies currently don't carry `Domain=.isaflow.co.za`, so logging in on `app.*` does not authenticate against `admin.*`.

## Goals

- Admin APIs and the `admin.isaflow.co.za` subdomain authenticate via a clean platform path that is orthogonal to tenant auth.
- Super admins retain the ability to use the accounting app as a normal user when they hold regular company memberships; that path must **not** inherit any RLS bypass.
- Single sign-on across `app.*` and `admin.*` subdomains.
- Minimal changes to existing admin handlers, admin services, and RLS policies.
- Fail-closed: any bug in the middleware results in `403`, never a silent privilege escalation.

## Non-goals

- Porting the portal auth (`portalAuth.ts`, `portalJwt.ts`) — separate Phase 3 item.
- Porting 2FA to GoTrue — separate Phase 3 item.
- Deleting the custom auth dead files (`jwt.ts`, `session.ts`, `password.ts`) — they are still imported by 2FA/impersonation/register flows; cleanup blocks on those migrations.
- Changing the impersonation flow.
- Introducing an audit-trail table for super-admin grants.

## Architecture

Platform admin is a distinct identity path with its own Postgres role and its own middleware; tenant auth is untouched.

### Identity model

- **Who is a super admin.** `users.role = 'super_admin'` in the Postgres `public.users` shadow table. Migration 349 retained this column; it is the single source of truth for platform-admin status.
- **How it is checked.** On every admin request, the middleware checks out a client from the **app pool**, opens a short tx, does `SET LOCAL ROLE app_user` + `SET LOCAL request.jwt.claims = <claims>`, and queries `SELECT role FROM users WHERE id = auth.uid()`. The existing `users_self_read` RLS policy permits this lookup. The tx commits (read-only), the client is released, and only then — if and only if `role = 'super_admin'` — does the middleware open its second tx on the `platform_admin` pool for the handler. This two-tx, two-pool pattern is deliberate: if the super-admin check is ever bugged or skipped, the request runs as `app_user` and RLS still applies; `BYPASSRLS` is never engaged until after the gate passes. Reading from the DB (not the JWT) also makes revocation instant — flipping a row to `'admin'` locks the person out on their next request.
- **Independence from memberships.** A super admin may also be a member of one or more companies via `company_users`. Those memberships let them use the accounting app as a normal user, under the normal `withAuth` → `app_user` path — no RLS bypass.

### Postgres identity

A new role `platform_admin` with `BYPASSRLS NOINHERIT LOGIN`:

- Owns no tables.
- Granted `SELECT, INSERT, UPDATE, DELETE` on all existing public tables, plus `USAGE, SELECT` on sequences.
- `ALTER DEFAULT PRIVILEGES` so future `CREATE TABLE` in `public` auto-grants the same set.
- `NOINHERIT` prevents accidental privilege composition from roles granted to it.
- `BYPASSRLS` is transparent to policies — no existing policy needs modification.

This mirrors the existing `migration_admin` role's shape but with a separate purpose: runtime platform-admin traffic, not schema mutation. Keeping them distinct means `pg_stat_activity` and audit logs can tell the two apart.

### Runtime middleware: `withPlatformAdmin`

New file: `src/lib/auth/withPlatformAdmin.ts`. Responsibilities per request:

1. Parse `sb-access-token` cookie. Missing → `401 UNAUTHORIZED`.
2. `verifyToken(token)` via GoTrue JWKS (same call `withUserAuth` uses). Invalid/expired → `401 INVALID_TOKEN`, clear auth cookies.
3. **Super-admin gate (app pool, as `app_user`).** Check out a client from the app pool. `BEGIN`; `SET LOCAL ROLE app_user`; `SET LOCAL request.jwt.claims = <claims>`; `SELECT role FROM users WHERE id = auth.uid()` (allowed by the `users_self_read` RLS policy); `COMMIT`; release. If `role !== 'super_admin'` → `403 NOT_SUPER_ADMIN`. DB error → propagate so `withErrorHandler` returns `500` (fail-closed — the handler never runs).
4. **Handler tx (platform_admin pool).** Only after the gate passes: check out a client from the `platform_admin` pool. `BEGIN`; `SET LOCAL request.jwt.claims = <claims>` so audit-log triggers that call `auth.uid()` still record the actor. Do **not** set `app.current_company_id`.
5. Bind the client via `als.run({ client, userId, claims }, handler)` so every `sql\`…\`` in admin services/handlers routes through it.
6. On completion: `COMMIT`, release the client. On throw: `ROLLBACK`, rethrow for `withErrorHandler`.

### Session: cookie-domain sharing

`src/lib/auth/cookies.ts` reads a new env `COOKIE_DOMAIN`. If set, `Domain=<value>` is appended to `Set-Cookie` for `sb-access-token`, `sb-refresh-token`, and `active_company_id`. Prod gets `COOKIE_DOMAIN=.isaflow.co.za`; dev leaves it unset so host-scoped continues to work for localhost.

Threat model: sharing cookies across subdomains does not weaken admin — the `users.role` gate is the actual defense. A valid tenant-user JWT reaching `admin.*` simply gets `403`.

**Transition.** Existing sessions have host-scoped cookies. When `COOKIE_DOMAIN` turns on, new logins set domain-scoped cookies. During the transition, `clearAuthCookies` emits clears for *both* scopings to avoid stale host-scoped cookies shadowing the new ones.

### `withAdmin` shape

`src/modules/admin/middleware/withAdmin.ts` keeps its external contract. Internally:

```
withAdmin = withErrorHandler(
  rateLimit(                       // existing: 120 req/min per IP
    csrfHeaderCheck(               // existing: X-Admin-Request: true
      withPlatformAdmin(handler)   // new: replaces withAuth + withRole
    )
  )
)
```

All 40 admin route files continue to `export default withAdmin(handler)` — no per-route changes.

## Changes by file

### New

- `scripts/migrations/sql/352_platform_admin_role.sql` — creates role and grants; idempotent.
- `src/lib/auth/withPlatformAdmin.ts` — the new middleware.
- `tests/unit/auth/withPlatformAdmin.test.ts` — unit tests.
- `tests/unit/auth/cookies.test.ts` — augmented for `COOKIE_DOMAIN`.
- `tests/integration/admin/admin-rls-bypass.int.test.ts` — proves `BYPASSRLS` engages.
- `tests/integration/admin/admin-forbidden-for-tenant-user.int.test.ts` — proves the role gate.
- `tests/e2e/admin/admin-login-shared-cookie.spec.ts`, `admin-dashboard-loads.spec.ts`, `admin-non-super-admin-blocked.spec.ts`.

### Modified

- `src/lib/auth/cookies.ts` — `COOKIE_DOMAIN` support; dual-scope clears.
- `src/modules/admin/middleware/withAdmin.ts` — swap inner middleware.
- `src/lib/auth/index.ts` — export `withPlatformAdmin` and `PlatformAdminRequest` type.
- `.env.example` — add `PLATFORM_ADMIN_DATABASE_URL`, `COOKIE_DOMAIN`.
- `/home/velo/isaflow/.env.local` (prod; not in repo) — same additions.

### Not modified (by design)

- Admin services (`src/modules/admin/services/*`) — ALS routing handles pool selection transparently.
- Admin API routes (40 files) — no per-route change.
- RLS policies — `BYPASSRLS` is transparent.
- `withAuth`, `withUserAuth`, `withRole` — tenant path is unchanged.

### Deleted

- None. `withRole('super_admin')` stays in the codebase as a tenant-level option in case any future path wants it; zero cost to keep.

### Request type

```ts
export interface PlatformAdminRequest extends NextApiRequest {
  user: { id: string; email?: string; claims: Record<string, unknown> };
  // Note: no companyId, no companyRole — admin is global
}
```

Existing admin handlers typed as `AuthenticatedNextApiRequest` (from `withUserAuth`) already match this shape — no handler signature changes required.

## Data flow

### Login (shared-cookie behavior)

1. User POSTs to `/api/auth/login` on either subdomain.
2. `signIn()` returns GoTrue tokens. `setAuthCookies` emits `Set-Cookie` with `Domain=.isaflow.co.za` (prod).
3. Browser stores cookies against the parent domain; subsequent requests to either subdomain include them.
4. Response redirect: `/` for admin host, `/accounting` for app host (existing `useAdminPrefix` logic).

### Admin API call (`GET /api/admin/companies`)

1. `withAdmin` → rate-limit → CSRF-header gate → `withPlatformAdmin`.
2. `withPlatformAdmin` verifies `sb-access-token` via GoTrue.
3. `users.role` lookup: short tx on the **app pool** as `app_user`, reading via the `users_self_read` policy. Commit + release. Non-super-admin → `403 NOT_SUPER_ADMIN` (cookies are not cleared here — the person is a legitimate user, just not a platform admin).
4. New tx on the **`platform_admin` pool**. `BEGIN`. `SET LOCAL request.jwt.claims = <claims>`. No company GUC.
5. ALS run; handler executes; `sql\`…\`` binds to admin client. RLS bypassed transparently via `BYPASSRLS`.
6. `COMMIT` and release on success; `ROLLBACK` + rethrow on error.

### Regular user hits `admin.isaflow.co.za`

1. Shared cookies make GoTrue verify succeed.
2. `users.role` returns `'admin'` or `'manager'` or similar.
3. `403 NOT_SUPER_ADMIN`. Admin layout catches this and redirects to `app.isaflow.co.za`.

### Super admin uses the accounting app

- Routes on `app.isaflow.co.za` go through `withAuth` → `app_user` role → RLS applies. `BYPASSRLS` is **not** engaged here — only `withPlatformAdmin` engages it. A super admin acting as a regular user sees only the companies they're members of. Clean separation.

### Impersonation (unchanged)

- Existing `impersonate-exchange` flow issues a short-lived JWT and lands the admin on `app.isaflow.co.za` as a tenant user via `withAuth`. Orthogonal to this design.

## Migration & rollout

### Migration 352

```sql
-- 352_platform_admin_role.sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_admin') THEN
    EXECUTE format(
      'CREATE ROLE platform_admin WITH LOGIN BYPASSRLS NOINHERIT PASSWORD %L',
      current_setting('app.platform_admin_password')
    );
  END IF;
END $$;

GRANT USAGE ON SCHEMA public, auth TO platform_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO platform_admin;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platform_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO platform_admin;
```

Password is passed via `SET app.platform_admin_password = '<value>'` at apply-time by the migration runner — never hard-coded in the file. Rotation: `ALTER ROLE platform_admin PASSWORD '<new>'` + update env + rolling restart.

### Env changes

Prod `/home/velo/isaflow/.env.local`:

- `PLATFORM_ADMIN_DATABASE_URL=postgresql://platform_admin:<pw>@localhost:5437/isaflow?sslmode=disable`
- `COOKIE_DOMAIN=.isaflow.co.za`

Backup the existing env first (same pattern as prior cutovers: `.env.backup-pre-phase3-<timestamp>`).

### Deploy order (single PR, one deploy)

1. Merge code with migration 352, new middleware, `cookies.ts` change.
2. `bash scripts/deploy-local.sh dev` — verify admin login + admin API calls on dev.
3. On prod: run migration 352 via the migration runner (picks up naturally after 351).
4. Set the two new env vars.
5. Deploy via `deploy.sh`.
6. Smoke-test `admin.isaflow.co.za`.

### Rollback

- `git revert` the merge commit, redeploy. Previous `withAdmin` composition returns.
- Migration rollback: `DROP ROLE platform_admin` after `REVOKE ALL`. Leaving the role in place with no users is harmless, so rollback-of-migration is optional.
- `COOKIE_DOMAIN` unset via env → cookies revert to host-scoped on next issuance; existing domain-scoped cookies expire naturally or on the next `clearAuthCookies` call.

### Risks

- **`BYPASSRLS` blast radius.** A middleware bug that skips the `users.role` query would hand any authenticated user full DB access. Mitigations: (a) unit test covers the 403 path explicitly; (b) `withPlatformAdmin` fails-closed on DB errors in the role query (no pass-through); (c) the `platform_admin` pool is only opened after the gate, so the gate cannot be bypassed by design.
- **Cookie-domain transition.** A browser holding both host-scoped and domain-scoped versions of `sb-access-token` will send one — which one is browser-dependent. Mitigation: `clearAuthCookies` emits dual-scope clears during the transition so a single logout resolves any ambiguity.
- **Role-gate freshness.** Reading `users.role` on every request means one extra SQL round-trip per admin call. Acceptable: admin traffic is low-volume, and the `users` table is tiny + cached.

## Testing

### Unit (`tests/unit/auth/`)

- `withPlatformAdmin.test.ts`:
  1. Missing `sb-access-token` → `401`.
  2. Invalid/expired token → `401` + cookies cleared.
  3. Valid token but `users.role !== 'super_admin'` → `403 NOT_SUPER_ADMIN`.
  4. Valid super-admin → handler invoked; `req.user.id`, `req.user.claims` populated.
  5. DB error in role-lookup → 500 (fail-closed).
  6. ALS: inside the handler, a test-only probe confirms `sql` is routing through the admin-pool client (not the app pool).
- `cookies.test.ts` additions:
  1. `COOKIE_DOMAIN` unset → no `Domain=`.
  2. `COOKIE_DOMAIN=.isaflow.co.za` → `Domain=.isaflow.co.za` appended.
  3. `clearAuthCookies` emits both host-scoped and domain-scoped clears.

### Integration (`tests/integration/admin/`, dev Supabase)

- `admin-rls-bypass.int.test.ts` — super-admin login; admin endpoint returns `SELECT count(*) FROM customer_invoices`; asserts count > any single-tenant view. Proves `BYPASSRLS` engages.
- `admin-forbidden-for-tenant-user.int.test.ts` — regular-user login; hit `/api/admin/companies`; asserts 403.

### E2E (`tests/e2e/admin/`, Playwright)

- `admin-login-shared-cookie.spec.ts` — log in on `app.*`, navigate to `admin.*`, confirm dashboard loads without re-auth.
- `admin-dashboard-loads.spec.ts` — super_admin lands on `/admin` and sees stats.
- `admin-non-super-admin-blocked.spec.ts` — regular user hits `/admin/companies`, gets 403 or is redirected.

### Manual smoke on prod post-deploy

- Log in as super admin on `admin.isaflow.co.za`. Check dashboard, companies list, billing subscriptions, audit log.
- Log out; log in on `app.isaflow.co.za`; confirm the accounting app loads normally (no accidental RLS bypass).
- `SELECT usename, count(*) FROM pg_stat_activity GROUP BY usename` on prod — confirm both `postgres` and `platform_admin` appear.

### Test-data requirements

- Dev Supabase: seeded super-admin (`admin@isaflow.co.za`, `users.role='super_admin'`) and non-super-admin (`test@example.com`, `users.role='viewer'`). At least 2 companies with non-trivial data in each.

## Open questions

None — all resolved in brainstorming:

- Super admin is platform-level (Option C in discussion).
- RLS bypass via dedicated `platform_admin` BYPASSRLS role.
- Identity stored in `users.role`; read from DB per request.
- Cookies shared via `Domain=.isaflow.co.za`.
- Dedicated `platform_admin` pool; queries bind via ALS.
