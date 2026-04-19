# TOTP 2FA via GoTrue Native MFA — Design

**Date:** 2026-04-19
**Status:** Design — awaiting implementation
**Context:** Phase 3b follow-up to the Supabase cutover. The custom 2FA implementation (`src/modules/auth/services/twoFactorService.ts`, `user_2fa` + `user_trusted_devices` tables, six `/api/auth/2fa-*` endpoints) has zero enrolled users across all tenants and blocks deletion of `src/lib/auth/jwt.ts` / `session.ts` / `password.ts`. Port 2FA to GoTrue's native MFA so it remains a marketable feature while the custom code goes away.

## Problem

Current state:

- 229 LOC of custom TOTP service + 444 LOC of API routes + migration 269 tables (`user_2fa`, `user_trusted_devices`) + encrypted-secret storage.
- Features: TOTP, backup codes, trusted devices, SMS method (declared in schema, never implemented).
- Zero rows in `user_2fa` on prod at time of design — literally no one has 2FA enabled.
- Custom code imports from `password.ts` / `session.ts` which are slated for deletion once register / admin-reset / 2FA port to GoTrue. 2FA is on the critical path for that cleanup.

## Goals

- 2FA remains an advertisable feature on `app.isaflow.co.za`.
- All TOTP enrollment and verification goes through GoTrue's `/factors/*` endpoints.
- Zero IsaFlow tables store factor material. GoTrue owns `auth.mfa_factors`.
- Login flow gates AAL2 step-up in IsaFlow when any verified factor exists for the user.
- Super admin can reset a user's 2FA from the admin platform.
- Deletion of `user_2fa` + `user_trusted_devices` tables is part of this change (no data migration needed — zero rows).

## Non-goals

- Trusted-devices ("remember this browser 30 days"). Dropped. Users enter their TOTP on every login, matching Xero / QuickBooks.
- Backup codes. Dropped. A lost device requires super-admin reset via the admin panel.
- SMS method. Dropped. The `method='sms'` enum value was never implemented. TOTP only.
- Step-up MFA for sensitive operations (e.g. VAT submit, mass delete). Out of scope. 2FA is a login-time gate only.
- UI polish beyond a functional enroll/confirm/disable panel on `/accounting/my-account`.

## Architecture

IsaFlow defers entirely to GoTrue's native MFA. It acts as:

1. **A thin proxy** that forwards enroll / challenge / verify / unenroll calls to GoTrue (`gotrue-mfa.ts` client).
2. **A login-flow orchestrator** that checks AAL on the GoTrue sign-in response and gates the `sb-access-token` cookie behind a TOTP challenge when factors exist.
3. **An admin tool** that calls GoTrue's admin-level `/admin/factors/*` endpoints via the service-role key to wipe factors when a user loses their device.

No IsaFlow DB tables are involved in normal TOTP operation. Middleware is untouched — `withAuth` / `withUserAuth` already verify GoTrue JWTs, and an AAL2 token is a plain JWT with `aal: 'aal2'` in the claims.

### Identity model

GoTrue treats MFA as factors attached to the `auth.users` row. Each factor has `{id, user_id, factor_type, status, created_at, verified_at, secret, …}`. IsaFlow never reads this table directly; it goes through the HTTP API.

### AAL semantics

- `aal1` — password-only authentication. Default for users without factors.
- `aal2` — password + TOTP. After a successful challenge, GoTrue issues an access token whose claims include `aal: 'aal2'` and `amr: [{method: 'totp', timestamp: …}, {method: 'password', …}]`.
- IsaFlow's current middleware does not inspect `aal`. For Phase 3b we do not enforce AAL at middleware level — the enforcement point is the login endpoint. Any session that makes it past login has whatever AAL GoTrue issued.

## Changes by file

### New

| Path | Purpose |
|---|---|
| `src/lib/auth/gotrue-mfa.ts` | Thin HTTP client for GoTrue `/factors/*` + `/admin/factors/*`. ~120 LOC. Exports `listFactors`, `enrollTotp`, `challengeFactor`, `verifyFactor`, `unenrollFactor`, `adminUnenrollFactor`, plus typed error classes. |
| `pages/api/auth/2fa-enroll.ts` | `POST`. Replaces `2fa-setup.ts`. Returns `{factor_id, qr_code, secret}`. ~40 LOC. |
| `pages/api/auth/2fa-confirm.ts` | `POST {factor_id, code}`. Replaces `2fa-verify-setup.ts`. Calls challenge + verify. ~35 LOC. |
| `pages/api/auth/2fa-challenge.ts` | `POST {factor_id, code, pending_token}`. New login-gate endpoint; called by client after login returns `requires_2fa: true`. Sets `sb-access-token` cookie on success. ~55 LOC. |
| `pages/api/admin/users/[id]/reset-2fa.ts` | Super-admin endpoint. Lists factors, unenrolls all. ~30 LOC. |
| `scripts/migrations/sql/354_drop_custom_2fa.sql` | Drops `user_2fa`, `user_trusted_devices`, and the 3 indexes from migration 269. |
| `tests/unit/auth/gotrue-mfa.test.ts` | Mocked-fetch unit tests for the client. |
| `tests/integration/2fa-enroll-flow.int.test.ts` | End-to-end enroll against dev GoTrue. |
| `tests/integration/2fa-login-gate.int.test.ts` | Confirms `requires_2fa: true` response path. |
| `tests/integration/2fa-disable-flow.int.test.ts` | Enroll → disable → confirm single-step login. |
| `tests/integration/admin-reset-2fa.int.test.ts` | Super-admin reset path. |

### Modified

| Path | Change |
|---|---|
| `pages/api/auth/login.ts` | After successful GoTrue sign-in, call `listFactors(access_token)`. If any verified factor exists, return `{requires_2fa: true, factor_id, pending_token}` instead of setting `sb-access-token`. |
| `pages/api/auth/2fa-disable.ts` | Rewrite to use GoTrue's `challenge + verify + DELETE /factors/:id`. ~25 LOC (was 58). |
| `pages/login.tsx` | Handle `requires_2fa` response — show a TOTP code input, call `/api/auth/2fa-challenge`. |
| `pages/accounting/my-account.tsx` | Trim 2FA section to enroll / confirm / disable panel. |

### Deleted

| Path | Reason |
|---|---|
| `src/modules/auth/services/twoFactorService.ts` | All TOTP logic now in GoTrue. 229 LOC removed. |
| `pages/api/auth/2fa-setup.ts` | Replaced by `2fa-enroll.ts`. |
| `pages/api/auth/2fa-verify-setup.ts` | Replaced by `2fa-confirm.ts`. |
| `pages/api/auth/2fa-verify.ts` | Replaced by `2fa-challenge.ts`. |
| `pages/api/auth/2fa-status.ts` | Trimmed and kept. New body: `GET` returns `{enabled: boolean, factor_id: string \| null}` derived from `listFactors` called with the caller's `sb-access-token`. ~15 LOC. Retained (rather than inlined into the page's `getServerSideProps`) so the client can re-query after enroll/disable without a full reload. |
| `pages/api/auth/2fa-trusted-devices.ts` | Trusted devices feature dropped. |
| `src/components/accounting/my-account/TwoFactor*` (trusted-device + backup-code panels) | Audit the component tree during implementation; trim to the enroll + disable panel. |

### Packages

Remove `otpauth` and `qrcode` from runtime `dependencies` if no other consumer. `otpauth` may stay as a `devDependencies` entry so the integration tests can sign valid codes locally.

### Request/response types

```ts
// Client → POST /api/auth/login response (extended)
interface LoginResponse {
  success: true;
  user?: { id: string; email: string };
  activeCompanyId?: string | null;
  // Present only when MFA is required:
  requires_2fa?: true;
  factor_id?: string;
  pending_token?: string;
}

// Client → POST /api/auth/2fa-challenge request
interface TwoFactorChallengeRequest {
  factor_id: string;
  code: string; // 6-digit TOTP
  pending_token: string;
}

// Server → POST /api/auth/2fa-challenge response
interface TwoFactorChallengeResponse {
  success: true;
  user: { id: string; email: string };
  activeCompanyId: string | null;
}
```

## Data flow

### Enroll TOTP (logged-in user)

1. User navigates to `/accounting/my-account/2fa` and clicks "Enable 2FA".
2. Client `POST /api/auth/2fa-enroll` (no body).
3. Server reads `sb-access-token` from cookie, calls `POST {GOTRUE_URL}/factors` with `{factor_type: 'totp', issuer: 'IsaFlow', friendly_name: <user_email>}` as bearer-authenticated user.
4. GoTrue creates an unverified factor and returns `{id, totp: {qr_code, secret, uri}}`.
5. Server forwards `{factor_id, qr_code, secret}` to client.
6. UI renders QR + manual secret. User scans with authenticator.
7. User enters 6-digit code. Client `POST /api/auth/2fa-confirm {factor_id, code}`.
8. Server calls `POST {GOTRUE_URL}/factors/{factor_id}/challenge` → `{challenge_id}` → `POST {GOTRUE_URL}/factors/{factor_id}/verify {challenge_id, code}`.
9. GoTrue flips factor to `verified=true` and returns an AAL2 access token.
10. Server replaces `sb-access-token` cookie with the AAL2 token. Returns `{success: true}`.
11. UI shows "2FA enabled".

### Login with 2FA enabled

1. User POSTs email + password to `/api/auth/login`.
2. Server calls `POST {GOTRUE_URL}/token?grant_type=password`.
3. GoTrue returns `{access_token, refresh_token, user, …}`. Access token claims include `aal: 'aal1'`.
4. Server calls `GET {GOTRUE_URL}/factors` with the new access token.
5. If no verified factor: set `sb-access-token` + `sb-refresh-token` + `active_company_id` cookies as today, respond `{success: true, user, activeCompanyId}`.
6. If ≥ 1 verified factor: do NOT set cookies. Respond `{success: true, requires_2fa: true, factor_id, pending_token: <aal1_access_token>}`.
7. Client shows TOTP prompt.
8. User enters code. Client `POST /api/auth/2fa-challenge {factor_id, code, pending_token}`.
9. Server calls `POST {GOTRUE_URL}/factors/{factor_id}/challenge` + `/verify`, using `pending_token` as bearer.
10. GoTrue returns an AAL2 access token + refresh token.
11. Server sets `sb-access-token` (AAL2), `sb-refresh-token`, `active_company_id` (reuses the same membership lookup as the no-MFA path).
12. Server responds `{success: true, user, activeCompanyId}`. Client navigates to dashboard.

### Login without 2FA

Unchanged. One round-trip, cookies set, done.

### Disable 2FA

1. User clicks "Disable" on `/accounting/my-account/2fa`, enters current TOTP code.
2. Client `POST /api/auth/2fa-disable {factor_id, code}`.
3. Server calls GoTrue challenge + verify (to confirm possession).
4. On success, server calls `DELETE {GOTRUE_URL}/factors/{factor_id}`.
5. GoTrue removes the factor. The AAL2 token in the cookie is now over-privileged for a user with no factor. On the next `/token?grant_type=refresh_token` call, GoTrue issues an AAL1 token. No explicit server-side cookie swap required — acceptable short-term elevation.

### Super-admin reset

1. Admin navigates to a user row on `admin.isaflow.co.za/users/:id` and clicks "Reset 2FA".
2. Admin UI `POST /api/admin/users/:id/reset-2fa`.
3. Server (wrapped by `withAdmin` → `withPlatformAdmin`) calls `GET {GOTRUE_URL}/admin/factors?user_id=:id` using `SUPABASE_SERVICE_ROLE_KEY` as bearer.
4. Server iterates the returned factors, calling `DELETE {GOTRUE_URL}/admin/factors/{factor_id}` for each.
5. Server logs to `admin_audit_log`. Responds `{success: true, factors_removed: N}`.
6. User's next login skips the 2FA prompt.

## Migration & rollout

### Migration 354

```sql
-- 354_drop_custom_2fa.sql
-- Phase 3b: Remove custom 2FA tables. GoTrue's auth.mfa_factors now owns TOTP.
-- Pre-cutover verification: SELECT COUNT(*) FROM user_2fa UNION ALL
--                            SELECT COUNT(*) FROM user_trusted_devices
-- both returned 0 on prod at design time.
DROP INDEX IF EXISTS idx_trusted_devices_expiry;
DROP INDEX IF EXISTS idx_trusted_devices_user;
DROP INDEX IF EXISTS idx_user_2fa_user;
DROP TABLE IF EXISTS user_trusted_devices;
DROP TABLE IF EXISTS user_2fa;
```

Applied as `supabase_admin` on both dev and prod (lesson from Phase 3a — `migration_admin` lacks ownership to drop tables it didn't create).

### GoTrue config prerequisite

Check `/home/velo/supabase/.env` for `GOTRUE_MFA_ENABLED=true`. Default in older GoTrue versions is `false`. If missing or false:

1. Add `GOTRUE_MFA_ENABLED=true` to `/home/velo/supabase/.env`.
2. `docker compose restart auth` (or the equivalent for the velo supabase stack).
3. Smoke-test `curl -X POST {GOTRUE_URL}/factors -H 'Authorization: Bearer <user_access_token>'` — should not return 404.

### Env changes

None on IsaFlow. `GOTRUE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already present in both `.env.local` (dev) and `/home/velo/isaflow/.env.local` (prod).

### Deploy order

1. Merge the PR to master.
2. Confirm `GOTRUE_MFA_ENABLED=true` on prod; restart auth container if needed.
3. Run `DATABASE_URL='<prod_supabase_admin_url>' bun scripts/apply-migrations.ts` — applies 354 as `supabase_admin`.
4. `scripts/deploy.sh` from master, after-hours only (same gate as Phase 3a).
5. Smoke test on prod per the testing section.

### Rollback

- Code: `git revert` the merge commit, redeploy.
- Migration: add migration 355 that recreates the two tables empty. Zero rows at cutover means no data loss on either the drop or the recreate.
- GoTrue factors created between enable and rollback: leave them. They're unused if the IsaFlow code no longer talks to `/factors`.

### Risks

- **AAL step-up not enforced at middleware.** Phase 3b does not gate admin or sensitive routes at AAL2. A user with MFA enabled who somehow gets an AAL1 token can still reach the full app. Acceptable for "forward-looking basic UX" — AAL2 enforcement is a future enhancement if a customer asks.
- **`pending_token` in client memory.** Short-lived GoTrue access token (~60s default) held in React state while user enters their code. Never persisted. No meaningful attack surface.
- **Factor-enrollment race.** User enrolls on device A, then tries to enroll on device B before confirming A. GoTrue allows multiple unverified factors per user; only verified ones count. UI rides on GoTrue's behavior — no extra protection needed.
- **GoTrue MFA endpoint availability.** If GoTrue is unreachable during login, `listFactors` fails. Mitigation: on `listFactors` failure, treat as "no factors" and proceed to sign the user in — i.e., fail-open on enumeration. (Alternative: fail-closed = 500 and user can't log in. Fail-open keeps the platform usable when GoTrue is partial; fail-closed is safer. Decision: fail-closed. Return 503 with a clear error message. Operational alert beats a silent 2FA bypass.)

## Testing

### Unit (`tests/unit/auth/`)

- `gotrue-mfa.test.ts`:
  1. `enrollTotp` sends `POST /factors` with correct body + bearer → parses `{factor_id, qr_code, secret}` from GoTrue response shape.
  2. `verifyFactor` calls `/factors/:id/challenge` then `/verify` in order; returns AAL2 access token.
  3. `unenrollFactor` sends `DELETE /factors/:id`.
  4. `adminUnenrollFactor` uses service-role bearer, targets `/admin/factors/:id`.
  5. GoTrue 4xx responses surface as typed errors (not swallowed, not mapped to 500).

### Integration (`tests/integration/`, dev GoTrue)

- `2fa-enroll-flow.int.test.ts` — full enroll: seed user → login → call `/factors` → read secret → generate valid code via `otpauth` (dev-only) → challenge + verify → assert AAL2 token.
- `2fa-login-gate.int.test.ts` — user with verified factor hits `/api/auth/login`; asserts `requires_2fa: true` + no cookie set; then `/api/auth/2fa-challenge` with valid code; asserts `sb-access-token` cookie set with AAL2 claims.
- `2fa-disable-flow.int.test.ts` — enroll → disable → next login returns single-step (no `requires_2fa`).
- `admin-reset-2fa.int.test.ts` — super-admin calls `POST /api/admin/users/:id/reset-2fa` for a user with an enrolled factor; asserts all factors removed; user's next login is single-step.

### E2E

None new. The UI is a 3-click flow with low regression risk. Integration tests cover the server contract. Manual smoke covers the UI.

### Manual smoke on dev

1. Enroll dev user → scan QR → confirm → UI shows enabled.
2. Log out, log back in → 2FA prompt → valid code logs in → invalid code shows error.
3. Disable → log out, log back in → no prompt.
4. Super-admin resets another dev user → that user logs in single-step.

### Manual smoke on prod (Hein only, after deploy)

1. Enroll super-admin on prod.
2. Full enable → logout → login-with-code → disable cycle.
3. Any anomaly → rollback per Section 4.

### Test data

- Dev GoTrue users reseeded via the existing e2e setup. Integration tests can seed throwaway users per test.
- Dev GoTrue config: `GOTRUE_MFA_ENABLED=true`.
- Shared `otpauth` used only for generating test codes in integration tests. Stays as a `devDependencies` entry.

## Open questions

None — resolved during brainstorming:

- Feature scope: drop trusted-devices, backup codes, SMS; trigger on every login (Option B — forward-looking basic UX).
- Middleware AAL enforcement: out of scope for Phase 3b (future enhancement).
- `/api/auth/2fa-status`: kept as a thin 15-LOC wrapper around `listFactors`.
- `listFactors` failure during login: fail-closed (503) rather than fail-open, to avoid silent 2FA bypass.
