# Phase 3c: User Impersonation + Password Reset on GoTrue — Design

**Date:** 2026-04-19
**Status:** Design — awaiting implementation
**Context:** Final cleanup pass of the Phase 3 Supabase cutover. Ports the last two remaining custom-auth dependencies (user impersonation, admin-initiated password reset) to GoTrue, then deletes `src/lib/auth/jwt.ts`, `session.ts`, and `password.ts`.

## Problem

Three files — `jwt.ts` (115 LOC), `session.ts` (170 LOC), `password.ts` (146 LOC) — survived Phases 3a and 3b as transitional scaffolding. As of 2026-04-19, only three places still import them:

- `src/modules/admin/services/userImpersonationService.ts` uses `signToken` from `jwt.ts` to mint a custom JWT for "super-admin logs in as user X".
- `pages/api/auth/user-impersonate-exchange.ts` + `pages/impersonate.tsx` use `verifyToken` to consume that JWT.
- `src/modules/admin/services/adminUserActionsService.ts` uses `generateResetToken` from `password.ts` to build an admin-triggered password-reset link.

`session.ts` has no direct importers, but the impersonation flow writes to the `user_sessions` table via raw SQL — that indirect coupling is what keeps `session.ts` alive in the codebase.

Porting these three call sites removes all of Phase 2's transitional auth code. The codebase then has one authentication story: GoTrue + Postgres RLS + the `withAuth` / `withUserAuth` / `withPlatformAdmin` middleware from Phase 3a.

## Goals

- User impersonation ("super-admin logs in as user X") keeps working, on GoTrue primitives.
- Admin-triggered password reset keeps working, on GoTrue primitives.
- `jwt.ts`, `session.ts`, `password.ts` deleted. `src/lib/auth/index.ts` drops its transitional re-exports of `hashPassword`, `checkPasswordStrength`, `generateResetToken`.
- Admin sees an obvious "Impersonating X" banner while in the target session, with a clear "Return to my session" path that does not require re-login.
- Audit trail of impersonation start/end written to `admin_audit_log`.

## Non-goals

- Drop the `user_sessions` table. Kept for now; follow-up cleanup once confirmed dead. Nothing writes to it after this change.
- Port the AR customer portal (`/api/portal/*`) or the AFS stakeholder portal (`/api/accounting/portal/*`). Both have zero rows in prod; porting is deferred until a customer needs them.
- Encrypt the stashed admin tokens at rest. Plaintext + 1-hour TTL is acceptable given `platform_admin`-only read access; revisit if a customer has an at-rest-encryption requirement.
- Step-up MFA before impersonation. Admin has already passed login-time MFA if they enrolled; a super-admin *starting* an impersonation is the security boundary, not a second challenge inside it.

## Architecture

Three coordinated changes:

### 1. User impersonation — GoTrue magic-link + server-side stash

Super-admin clicks "Login as X" on the admin panel. `POST /api/admin/users/:id/impersonate` runs inside `withAdmin` (existing rate limit + CSRF gate + `withPlatformAdmin`):

1. Validates target user — must exist, be active, and not have `role = 'super_admin'` (existing guards preserved).
2. Reads the admin's current `sb-access-token` + `sb-refresh-token` from the request cookies.
3. `INSERT`s a row into a new `admin_impersonation_stash` table: `(stash_id, admin_user_id, admin_access_token, admin_refresh_token, target_user_id, created_at, expires_at = now() + 1h)`.
4. Calls GoTrue `POST /admin/generate_link` with `{type: 'magiclink', email: target.email}`. GoTrue returns `{action_link, hashed_token, verification_type, ...}`. The raw single-use token is the `token=` query-string parameter inside `action_link`.
5. Completes the verify server-side: `POST /verify {type: 'magiclink', token}` → GoTrue returns `{access_token, refresh_token, expires_in}` for the target user.
6. Writes an `admin_audit_log` row with `action = 'impersonation_start'`, actor = admin, target = user, `metadata = {stash_id, target_email}`.
7. Sets cookies on the response:
   - `sb-access-token` = target's access_token (standard flags + `Domain=.isaflow.co.za` in prod)
   - `sb-refresh-token` = target's refresh_token
   - `active_company_id` = target's default company
   - `sb-admin-stash` = stash_id, `HttpOnly`, `Max-Age=3600`
   - `is_impersonating` = `1`, **not** HttpOnly (client reads this), `Max-Age=3600`
8. Responds `200 {success: true, data: {redirect: '/accounting'}}`.

The client navigates to `/accounting`. Next request routes through `withAuth` normally — the JWT in `sb-access-token` is a standard GoTrue token, RLS applies under the target user's identity.

`AppLayout` checks the `is_impersonating` cookie client-side and renders `<ImpersonationBanner />` — an orange bar with "Impersonating <target email>" and a "Return to my session" button.

### 2. End impersonation

"Return to my session" issues `POST /api/auth/end-impersonation`. No middleware on this endpoint — it serves whoever currently holds the cookies:

1. Reads `sb-admin-stash` from cookie. Missing → 400 `NOT_IMPERSONATING`.
2. `SELECT ... FROM admin_impersonation_stash WHERE stash_id = $1`. Missing or `expires_at < now()` → clear all session cookies + return 401 `STASH_EXPIRED` (admin has to log in again).
3. Restores `sb-access-token` / `sb-refresh-token` cookies to the admin's stashed tokens. Clears `sb-admin-stash` + `is_impersonating` (dual-scope clears — host-scoped *and* `Domain=.isaflow.co.za` — per Phase 3a's transition pattern).
4. Sets `active_company_id` to the admin's default company.
5. Writes `admin_audit_log` row with `action = 'impersonation_end'`, actor = admin, target = stash.target_user_id.
6. `DELETE FROM admin_impersonation_stash WHERE stash_id = $1`.
7. Responds `200 {success: true, data: {redirect: '/admin'}}`.

### 3. Admin password reset — `generateLink({type: 'recovery'})`

`src/modules/admin/services/adminUserActionsService.ts` method `initiateAdminPasswordReset(userId)` rewritten:

1. Validates target (existing).
2. Fetches target's current GoTrue email via admin API (in case it was changed).
3. Calls `generateLink({type: 'recovery', email})`. GoTrue returns `{action_link, ...}`.
4. Writes `admin_audit_log` entry `action = 'password_reset_initiated'`.
5. Returns `{reset_link: action_link}` so the admin UI can display or copy-paste-to-email.

No DB writes to `password_reset_tokens`. No `generateResetToken()` call.

### 4. File deletion

After the above land and a grep verifies nothing references the deletable modules, in one commit:

- Delete `src/lib/auth/jwt.ts`.
- Delete `src/lib/auth/session.ts`.
- Delete `src/lib/auth/password.ts`.
- Delete `pages/api/auth/user-impersonate-exchange.ts`.
- Delete `pages/impersonate.tsx`.
- Remove the three `export { hashPassword, checkPasswordStrength, generateResetToken } from './password'` lines from `src/lib/auth/index.ts`.

`user_sessions` table stays. Drop in a follow-up once confirmed unused in application logs for a week.

## Changes by file

### New

| Path | Purpose |
|---|---|
| `scripts/migrations/sql/355_admin_impersonation_stash.sql` | Table + index + grant |
| `src/lib/auth/gotrue-admin-link.ts` | `generateLink(type, email)`, `verifyMagicLink(token)`, `GotrueAdminLinkError` |
| `pages/api/auth/end-impersonation.ts` | Restore cookies + delete stash + audit log |
| `src/components/layout/ImpersonationBanner.tsx` | Orange bar + "Return" button |
| `tests/unit/auth/gotrue-admin-link.test.ts` | 5 cases: magiclink / recovery / verify / error / missing env |
| `tests/integration/impersonation-flow.int.test.ts` | Full start→end round-trip against dev GoTrue + dev Postgres |
| `tests/integration/admin-password-reset.int.test.ts` | Reset link shape + audit log assertion |

### Modified

| Path | Change |
|---|---|
| `pages/api/admin/users/[id]/impersonate.ts` | Rewritten on new flow; returns `{redirect: '/accounting'}` instead of a raw token |
| `src/modules/admin/services/userImpersonationService.ts` | Trimmed to stash + audit-log helpers (~120 LOC, down from 157). Loses all JWT-signing, gains `stashAdminTokens` and `restoreAdminTokens`. |
| `src/modules/admin/services/adminUserActionsService.ts` | `initiateAdminPasswordReset` swapped to GoTrue `generateLink({type: 'recovery'})` |
| `src/lib/auth/index.ts` | Drop the transitional `export { hashPassword, checkPasswordStrength, generateResetToken }` block |
| `src/components/layout/AppLayout.tsx` | Render `<ImpersonationBanner />` conditional on `is_impersonating` cookie |

### Deleted

| Path | Reason |
|---|---|
| `src/lib/auth/jwt.ts` | No remaining consumers after port |
| `src/lib/auth/session.ts` | No remaining consumers |
| `src/lib/auth/password.ts` | No remaining consumers |
| `pages/api/auth/user-impersonate-exchange.ts` | Exchange handshake no longer needed — admin endpoint does everything inline |
| `pages/impersonate.tsx` | Same |

### Types

```ts
// POST /api/admin/users/:id/impersonate — response
interface ImpersonationStartResponse {
  success: true;
  data: { redirect: string }; // "/accounting"
}

// POST /api/auth/end-impersonation — response
interface ImpersonationEndResponse {
  success: true;
  data: { redirect: string }; // "/admin"
}

// GoTrue generate_link result shape (from gotrue-admin-link.ts)
interface GenerateLinkResult {
  action_link: string;
  token: string;        // extracted from action_link's ?token= query param
  hashed_token: string; // opaque — not used by us, kept for completeness
  verification_type: 'magiclink' | 'recovery' | 'invite' | 'signup';
}
```

## Data flow

### Start impersonation (full)

1. Super-admin clicks "Login as" on `/admin/users/:id`. Client issues `POST /api/admin/users/:id/impersonate` with `x-admin-request: true` header.
2. Request passes `withAdmin` → `rateLimit` → `withPlatformAdmin`. `req.user.id` = admin.
3. Handler reads admin's `sb-access-token` + `sb-refresh-token` from `req.cookies`.
4. Fetches target user row via `sql` (admin pool, BYPASSRLS). Rejects if:
   - Not found → 404 `NOT_FOUND`.
   - `is_active = false` → 400 `INACTIVE`.
   - `role = 'super_admin'` → 403 `CANNOT_IMPERSONATE_SUPER_ADMIN`.
5. Calls GoTrue `GET /admin/users/:targetId` to confirm the current email (belt-and-braces in case IsaFlow's `users.email` drifted from GoTrue's).
6. `INSERT INTO admin_impersonation_stash ... RETURNING stash_id`.
7. `generateLink({type: 'magiclink', email: target.email})` → `{action_link, token, ...}`.
8. `verifyMagicLink(token)` → `{access_token, refresh_token, expires_in}`.
9. `INSERT INTO admin_audit_log ...` for `impersonation_start`.
10. Pick target's default company via existing `SELECT company_id FROM company_users WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC LIMIT 1`.
11. Set cookies: `sb-access-token`, `sb-refresh-token`, `active_company_id` (target's), `sb-admin-stash`, `is_impersonating`.
12. Respond `200 {data: {redirect: '/accounting'}}`.

### End impersonation (full)

1. Client `POST /api/auth/end-impersonation` from the banner button.
2. Handler reads `sb-admin-stash` cookie. Absent → 400.
3. `SELECT ... FROM admin_impersonation_stash WHERE stash_id = $1 AND expires_at > now()`.
   - Absent/expired → `clearAuthCookies(res)` (dual-scope) + `clearImpersonationCookies(res)` + 401 `STASH_EXPIRED`.
4. Set `sb-access-token` / `sb-refresh-token` cookies to stash's `admin_access_token` / `admin_refresh_token`. Set `active_company_id` to the admin's default company.
5. Clear `sb-admin-stash` + `is_impersonating` via dual-scope `Max-Age=0`.
6. `INSERT INTO admin_audit_log ...` for `impersonation_end`.
7. `DELETE FROM admin_impersonation_stash WHERE stash_id = $1`.
8. Respond `200 {data: {redirect: '/admin'}}`.

### Admin password reset

1. Super-admin clicks "Reset password" on `/admin/users/:id`.
2. `POST /api/admin/users/:id/reset-password` (existing route; internal wiring changes).
3. Service validates target, calls `generateLink({type: 'recovery', email})`, writes audit log, returns `{reset_link}`.
4. Admin UI shows a dialog with a "Copy link" button.
5. Admin emails/messages the link to the user (out of band).
6. User clicks link → lands on GoTrue-hosted password form → new password → returns to `/login` on IsaFlow.

## Migration & rollout

### Migration 355

```sql
-- 355_admin_impersonation_stash.sql
-- Phase 3c: Server-side stash of the admin's tokens during impersonation, so
-- "Return to my session" can restore them without a re-login.
CREATE TABLE IF NOT EXISTS admin_impersonation_stash (
  stash_id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id        text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  admin_access_token   text        NOT NULL,
  admin_refresh_token  text        NOT NULL,
  target_user_id       text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_impersonation_stash_expires
  ON admin_impersonation_stash(expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE admin_impersonation_stash TO platform_admin;
```

Applied as `supabase_admin` on dev then prod (same pattern as 352/353/354).

### Rollout

1. Merge PR to master.
2. Apply 355 on prod as `supabase_admin`; record in `schema_migrations`.
3. `bash scripts/deploy.sh` — after-hours only.
4. Manual prod smoke:
   - Log in as super_admin on `admin.isaflow.co.za`.
   - "Login as" a non-super_admin. Confirm redirect + banner + target's data.
   - "Return to my session" → admin menu restored.
   - `psql -c "SELECT COUNT(*) FROM admin_impersonation_stash"` → 0 after return.
   - Check `admin_audit_log` for the two rows.
5. Smoke password reset: "Reset password" → reset_link shown → copy-paste into incognito → new-password form loads from GoTrue → set password → confirm login works.
6. Tag rollback anchor `v-pre-phase3c-impersonation` before the merge.

### Rollback

- `git revert` the merge, redeploy. Migration stays (empty table is harmless).
- If needed later: `DROP TABLE admin_impersonation_stash` via a reverse migration.

### Risks

- **Stashed token leak.** 1-hour plaintext window. Grant is restricted to `platform_admin`. Acceptable trade-off vs encryption complexity; revisit if compliance requires.
- **Admin refresh_token rotation mid-stash.** GoTrue does not rotate refresh tokens without an explicit refresh call, which the stashed admin session cannot make while cookies point elsewhere. Edge is theoretical.
- **Orphan stashes.** Closed-browser case. TTL cleans them at 1h. Follow-up cron (out of scope) if rows accumulate.
- **Banner can be hidden via DevTools.** Not a security concern — banner is UX, audit log is the source of truth.

## Testing

### Unit (`tests/unit/auth/`)

- `gotrue-admin-link.test.ts` — 5 cases:
  1. `generateLink('magiclink', email)` posts to `/admin/generate_link` with service-role bearer, returns `{action_link, token}` where `token` is parsed from `action_link`'s `?token=` param.
  2. `generateLink('recovery', email)` same path, different `type`.
  3. `verifyMagicLink(token)` posts to `/verify` with `{type: 'magiclink', token}`, returns `{access_token, refresh_token, expires_in}`.
  4. GoTrue 4xx surfaces as `GotrueAdminLinkError` with `.status`.
  5. Missing `GOTRUE_URL` / `SUPABASE_SERVICE_ROLE_KEY` throws at call time (not at module load).

### Integration (`tests/integration/`, dev GoTrue + dev Postgres)

- `impersonation-flow.int.test.ts` — 6 assertions in one test:
  1. Seed admin (`role='super_admin'`) + target (`role='viewer'` + one company membership).
  2. Login as admin via `signIn()`. Call `POST /api/admin/users/:targetId/impersonate` handler. Assert `sb-access-token` decodes to `sub = target.id`, `is_impersonating` cookie set, `sb-admin-stash` set, `admin_impersonation_stash` has 1 row, `admin_audit_log` has `impersonation_start`.
  3. Call a `withAuth`-gated endpoint (e.g. `/api/auth/me`) with the new cookies. Assert response identifies target, not admin.
  4. Call `POST /api/auth/end-impersonation` handler with `sb-admin-stash` cookie. Assert response is 200 + redirect `/admin`, `sb-access-token` cookie restored to admin's, impersonation cookies cleared, stash row deleted, `admin_audit_log` has `impersonation_end`.
  5. Call the same `withAuth`-gated endpoint. Assert response identifies admin.
  6. Cleanup: `adminDeleteUser` both users.

- `admin-password-reset.int.test.ts` — ~40 LOC:
  1. Seed super_admin + target.
  2. Call `adminUserActionsService.initiateAdminPasswordReset(targetId)`.
  3. Assert return value `reset_link` matches `^https?://.*/auth/v1/verify\?.*type=recovery`.
  4. Assert `admin_audit_log` has `password_reset_initiated`.
  5. Cleanup.

### E2E

None new. Server-side flow with one trivial UI component (banner) — integration + manual smoke is enough.

### Manual smoke

Per Rollout section.

### Test data

Throwaway GoTrue users seeded per test. No fixtures needed.

## Open questions

None — resolved in brainstorming:

- Banner lives in-tab with a "Return" button (Option B in discussion).
- Admin tokens stashed plaintext in DB, 1h TTL, grants restricted to `platform_admin`.
- `user_sessions` table kept for now; drop in follow-up.
- Step-up MFA before impersonation is explicitly out of scope.
- AR + AFS portals are out of scope (zero users).
