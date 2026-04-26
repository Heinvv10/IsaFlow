# PRD-10 — Session UX & Programmatic Authentication

**Status:** Draft
**Author:** Claude (Opus 4.7) on behalf of Hein van Vuuren
**Date:** 2026-04-26
**Last updated:** 2026-04-26

---

## 1. Problem

Two distinct authentication problems are colliding in ISAFlow today:

### Problem A — Accountants get logged out during a normal work day

ISAFlow uses Supabase Auth with the default access-token TTL of 1 hour. Supabase's JS SDK supports silent refresh-token rotation, but it only fires when the SPA makes a request near token expiry. An accountant who:

- Opens ISAFlow at 09:00, sets up their reports
- Steps away for a 1-hour client call
- Comes back at 10:30 and clicks "Run trial balance"

…gets a **401, hard logout, redirect to login, and loses their working state**. This happened repeatedly during the Velocity Fibre migration on 2026-04-25. It is the single most user-hostile behaviour on the platform.

Real-world reference: Xero, QuickBooks Online, Sage Cloud, and Sage VIP all keep the user signed in for the entire work day (and across days, with "Keep me signed in"). An ISAFlow user expects the same and is jarred when ISAFlow does not match.

### Problem B — Programmatic / integration access requires Chrome cookie scraping

Scripts run by accountants, agencies, automation tools, or AI assistants (the migration scripts in `docs/velocity-fibre/phase3/` are the immediate example) currently have only one way to authenticate to the ISAFlow API: scrape the user's Chrome cookies via `pycookiecheat`. That:

- Hard-couples the script to the user's browser session lifetime
- Inherits the same 1-hour expiry pain
- Cannot run from CI, cron, a headless server, or another developer's machine
- Has no audit trail (every call looks like the human user)
- Has no scoped permissions (any leaked cookie has full account access)
- Is not how any third-party (Hubdoc, Spotlight, A2X, Make, Zapier) integrates with comparable platforms

Both problems share the same root cause — Supabase's auth lifecycle is not exposed to ISAFlow users in a way that matches industry norms.

## 2. Goals & non-goals

### Goals

1. **Accountants stay logged in for the duration of an active work day** with no manual action.
2. **"Keep me signed in"** option extends the session across days/weeks (Xero parity).
3. **Re-auth only on:** explicit logout, password change, suspicious activity (new IP/device with 2FA), or genuine inactivity beyond a tunable threshold.
4. **Programmatic access** uses standard OAuth 2.0 patterns — no cookie scraping, no PAT pasting for end users.
5. **Third-party integrations** (Hubdoc-equivalents, agencies, AI assistants) authorise once via a consent screen, then operate via refresh-token rotation indefinitely.
6. **All access is auditable** — every API call traceable to a user + a session/token.
7. **Granular revocation** — user can revoke any active session or integration without affecting others.

### Non-goals

- Replacing Supabase Auth as the underlying identity provider (we extend it, we don't rebuild it).
- Introducing per-call hardware MFA or FIDO2 (separate PRD).
- IP allowlisting per user (separate enterprise feature).
- Federated SSO (SAML, Okta, Google Workspace) — call out as a follow-up but not in this PRD.

## 3. Success metrics

- **0 unintended logouts** during a 9-hour active work day in user testing.
- **<2% of API errors are auth-related** in production (down from current high count of 401s in Bugsink).
- **100% of new third-party integrations** use OAuth instead of cookie scraping or copy-pasted tokens (measured by integration registrations vs PAT creations).
- **Time-to-first-API-call for a new integration developer < 10 minutes** following the docs.
- **Token revocation latency < 1 second** end-to-end.

## 4. User personas

| Persona | Authentication mode | Frequency |
|---|---|---|
| **Hein (CCO, daily user)** | Browser session, "Keep me signed in" | Daily, 8+ hours/day |
| **Carla (accountant, daily user)** | Browser session | Daily, 6+ hours/day |
| **Auditor (read-only)** | Browser session, time-limited access via shared role | Periodic, weeks at a time |
| **Agency users** | Browser session per client tenant | Daily, multiple tenants |
| **Hubdoc-equivalent / capture vendor** | OAuth integration | Continuous, headless |
| **AI assistant (Claude, agency tooling)** | OAuth integration with `offline_access` | Continuous, headless |
| **Internal ops scripts (cron, CI)** | OAuth client-credentials | Scheduled |
| **Power-user developer** | PAT (advanced opt-in) | Ad hoc |

## 5. Solution overview

A three-layer solution. Each layer is independent and shippable on its own.

### Layer 1 — Browser session UX (the accountant fix)

Use Supabase's existing access + refresh tokens correctly:

- **Background heartbeat** — SPA fires a no-op `GET /api/auth/heartbeat` every 50 minutes while a tab is open. The Supabase client refreshes the access token transparently on that call.
- **Refresh-on-401 retry interceptor** — every `apiFetch` call wraps a single retry: on 401, call `supabase.auth.refreshSession()`, then re-execute the original request. If refresh fails, *then* logout.
- **"Keep me signed in" checkbox** at the login form — sets the refresh-token cookie expiry from session (closes with the browser) to 30 days rolling.
- **Idle timeout** — configurable per company, default 8 hours of zero activity (no clicks, no requests). After timeout, refresh fails and the user is bounced to login.
- **Tab-level coordination** — if the user has 5 ISAFlow tabs open, only one heartbeat runs (BroadcastChannel); refresh state is shared so all tabs stay in sync.

### Layer 2 — OAuth 2.0 for integrations (the third-party fix)

Standard OAuth 2.0 authorisation-code flow with PKCE:

- **App registration** — partners (or internal tools, or Claude) register an OAuth app at `app.isaflow.co.za/developer/oauth-apps`. They get a `client_id` and `client_secret`.
- **Consent flow** — user clicks "Connect to [App Name]". They land on an ISAFlow-hosted consent screen showing:
  - The app's logo + name + verified status
  - The exact scopes being requested (e.g., "Read your invoices", "Create supplier payments")
  - The company they're connecting (defaults to active, can switch)
  - Buttons: **Authorise** / **Cancel**
- **Token exchange** — on Authorise, the app receives an access token (1h) + refresh token (long-lived, rolling). Standard OAuth flow, no surprises.
- **Connected apps page** — user sees all OAuth integrations connected to their account. Each shows: app name, scopes, last_used_at, last_used_ip. Each can be revoked with one click.
- **Scopes** (initial set):
  - `read:*`, `read:invoices`, `read:bank-tx`, `read:reports`
  - `write:invoices`, `write:bank-tx`, `write:journals`
  - `offline_access` (required for refresh tokens to be issued)

### Layer 3 — Personal Access Tokens (for power users)

Optional. Not exposed to accountants. For developers building one-off scripts who don't want to set up an OAuth app:

- **Generate at** `app.isaflow.co.za/developer/personal-tokens`
- **Format**: `pat_<32 char base62>`. Hash stored, plaintext shown once.
- **Scoping**: same scope vocabulary as OAuth.
- **Per-company**: each PAT is locked to one tenant.
- **Revocable** instantly. Auto-expires at 90 days unless extended.

## 6. Technical design

### 6.1 Session UX (Layer 1)

#### Front-end changes

```ts
// src/lib/auth/sessionRefresh.ts (new)
export function startSessionHeartbeat(supabase) {
  // Multi-tab coordination
  const ch = new BroadcastChannel('isaflow_auth');
  let isLeader = false;
  ch.onmessage = (e) => { if (e.data === 'leader-claim') isLeader = false; };
  ch.postMessage('leader-claim');
  setTimeout(() => { isLeader = true; }, 100);

  setInterval(async () => {
    if (!isLeader || document.hidden) return;
    try {
      await fetch('/api/auth/heartbeat', { credentials: 'include' });
    } catch { /* swallow — refresh interceptor handles it */ }
  }, 50 * 60 * 1000); // 50 min
}

// src/lib/apiFetch.ts (modify)
export async function apiFetch(url, init = {}) {
  const res = await fetch(url, { ...init, credentials: 'include' });
  if (res.status !== 401) return res;

  // Try refresh, then retry once
  const { data, error } = await supabase.auth.refreshSession();
  if (error || !data.session) {
    window.location.href = '/login?reason=session-expired';
    return res;
  }
  return fetch(url, { ...init, credentials: 'include' });
}
```

#### Back-end changes

- New endpoint `GET /api/auth/heartbeat` — returns `{ ok: true, expiresAt: ISO }`. Triggers Supabase's middleware-level token refresh as a side effect of `withAuth`.
- `withAuth` middleware already exists; no changes needed for Layer 1.

#### Login form

Add a checkbox: `<input type="checkbox" name="rememberMe" />`. On submit, pass to Supabase: `supabase.auth.signInWithPassword({ ..., options: { persistSession: rememberMe } })`. When unchecked, the refresh-token cookie is set with `Max-Age` = session (deleted on browser close). When checked, `Max-Age = 30 * 24 * 3600`.

### 6.2 OAuth (Layer 2)

#### Database (new tables)

```sql
CREATE TABLE oauth_apps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  description     TEXT,
  logo_url        TEXT,
  homepage_url    TEXT,
  redirect_uris   TEXT[] NOT NULL,                    -- whitelisted callback URLs
  client_id       TEXT NOT NULL UNIQUE,                -- public, e.g. "client_jK7n…"
  client_secret_hash TEXT NOT NULL,                    -- SHA-256 of secret
  owner_user_id   UUID NOT NULL REFERENCES users(id),
  is_verified     BOOLEAN NOT NULL DEFAULT false,      -- ISAFlow-vetted partner
  is_first_party  BOOLEAN NOT NULL DEFAULT false,      -- internal apps skip consent screen
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE oauth_authorisations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  oauth_app_id    UUID NOT NULL REFERENCES oauth_apps(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id),
  company_id      UUID NOT NULL REFERENCES companies(id),
  scopes          TEXT[] NOT NULL,
  refresh_token_hash TEXT NOT NULL,                    -- SHA-256
  refresh_token_expires_at TIMESTAMPTZ NOT NULL,
  last_used_at    TIMESTAMPTZ,
  last_used_ip    INET,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (oauth_app_id, user_id, company_id)
);

CREATE INDEX idx_oauth_auth_refresh ON oauth_authorisations(refresh_token_hash) WHERE revoked_at IS NULL;
```

#### Endpoints

```
POST   /api/oauth/authorize          — render consent screen (HTML)
POST   /api/oauth/consent            — record user authorisation, redirect with code
POST   /api/oauth/token              — exchange code → access+refresh, OR refresh → access
DELETE /api/oauth/authorisations/:id — revoke a specific authorisation
GET    /api/oauth/connected-apps     — list user's authorised apps (for the UI)
```

#### Token format

- Access token: signed JWT (Supabase-style), TTL 1h, claims include `app_id`, `user_id`, `company_id`, `scopes[]`.
- Refresh token: opaque random 32-byte base62 string; hash stored. Rotated on each use (single-use refresh tokens prevent replay).

#### Auth middleware (extend `withAuth`)

```ts
const auth = req.headers.authorization;
if (auth?.startsWith('Bearer ')) {
  const token = auth.slice(7);
  // 1. Try OAuth JWT verify
  // 2. Fall back to PAT lookup
  // 3. Fall back to existing cookie/Supabase session
}
```

#### Scope enforcement

```ts
withAuth(withScope('write:bank-tx', allocateHandler))
```

When the call is via OAuth/PAT, `withScope` checks `req.scopes`. When the call is via cookie session, scopes default to `*` (the user has full UI access; we don't restrict their own session).

### 6.3 PATs (Layer 3)

Same database table as OAuth authorisations, with `oauth_app_id = NULL` and an additional `name` field. Same hash, scope, revocation, expiry semantics. Hidden behind `app.isaflow.co.za/developer/personal-tokens` — not visible to non-developer users.

## 7. UX flows

### 7.1 Daily accountant flow (Layer 1 in action)

1. **Monday 08:55** — Carla opens app.isaflow.co.za, types email + password, ticks "Keep me signed in", clicks Sign In.
2. **08:55 → 17:30** — Carla works through 4 client books. Steps away for lunch, school pickup, two phone calls. Never sees a login screen.
3. **17:30** — closes laptop.
4. **Tuesday 08:50** — opens laptop, navigates to app.isaflow.co.za, **lands directly on her dashboard** (refresh token still valid). No login required.
5. **Following Friday** — laptop hasn't been touched since Tuesday afternoon (3+ days idle). Refresh token still has 27 days of life left → still no login required.
6. **In a week's time** — Carla opens her phone (new device). On phone, she signs in fresh, gets a 2FA challenge to confirm. From then on, her phone is also persistent.

### 7.2 Authorising an integration (Layer 2 in action)

1. **Hein** wants to connect Hubdoc to ISAFlow for receipt capture.
2. In Hubdoc he clicks "Connect ISAFlow". Hubdoc redirects him to `app.isaflow.co.za/oauth/authorize?client_id=hubdoc&...`.
3. **He sees** the ISAFlow consent screen with Hubdoc's logo, name, "Verified Partner" badge, and the exact scopes:
   > Hubdoc would like to:
   > • Read your supplier invoices
   > • Create new supplier invoices
   > • Read your bank transactions
   > • [✓] Stay connected (refresh access)
   > Connecting to: **Velocity Fibre (Pty) Ltd** [change]
   > [Authorise]   [Cancel]
4. He clicks **Authorise**. Hubdoc receives the auth code, exchanges it for tokens, stores them.
5. **From then on**, Hubdoc syncs receipts continuously. Hein never thinks about it again.
6. **6 months later** Hein decides to switch to Dext. He goes to `app.isaflow.co.za/settings/connected-apps`, clicks **Revoke** on Hubdoc. Done.

### 7.3 Setting up automation script (Layer 3 in action)

1. **Hein** writes a Python script to push month-end journals from a custom spreadsheet.
2. He goes to `app.isaflow.co.za/developer/personal-tokens`, clicks **New Token**, names it "Month-end automation", picks scopes `write:journals`, `read:reports`, sets expiry 90 days, clicks **Create**.
3. He copies the `pat_…` token once, pastes it into his script's env var.
4. **For 90 days**, the script runs without any browser involvement. He gets an email reminder at 75 days to rotate.

## 8. Migration plan

| Phase | What | Effort | Owner |
|---|---|---|---|
| **1A** | Background heartbeat + refresh-on-401 interceptor | 1 day | Front-end |
| **1B** | "Keep me signed in" checkbox + 30-day refresh persistence | 1 day | Front-end |
| **1C** | Idle-timeout config in company settings (default 8h) | 0.5 day | Full-stack |
| **2A** | Database migrations for `oauth_apps`, `oauth_authorisations` | 0.5 day | DB |
| **2B** | OAuth endpoints (`/authorize`, `/consent`, `/token`, `/connected-apps`) | 3 days | Back-end |
| **2C** | Consent screen UX | 1 day | Front-end |
| **2D** | Connected apps settings page | 1 day | Front-end |
| **2E** | `withAuth` extension for Bearer tokens + scope enforcement | 1 day | Back-end |
| **2F** | Documentation site for integration developers | 2 days | Docs |
| **3A** | PAT pages (developer/personal-tokens), reuse Layer 2 infra | 0.5 day | Front-end |

**Total: ~12 days for full Layer 1+2+3.**

Layer 1 alone (the accountant fix) ships in **~2.5 days** and unblocks the most painful problem.

## 9. Test plan

### Layer 1
- Active user, 9 hours of intermittent activity → 0 logouts.
- Idle 9 hours → forced logout with friendly "you've been idle" message.
- "Keep me signed in" checked → close browser, reopen 5 days later → no login.
- "Keep me signed in" unchecked → close browser, reopen 5 minutes later → login required.
- Multi-tab — single heartbeat fires across all tabs (verified via network tab).
- Server-side: refresh-token rotation does not invalidate parallel tabs.

### Layer 2
- Register OAuth app, walk through consent flow → tokens issued.
- Use access token, get 200 with correct scope.
- Use access token without required scope → 403.
- Use access token after revocation → 401 within 1 second.
- Refresh token rotation — old refresh token invalid after one use.
- Replay old refresh token → all current authorisations for that user×app revoked (replay defence).

### Layer 3
- PAT created, scope-bound, revocable.
- PAT works in CI (no browser).
- Expired PAT → 401 with "expired" message.

## 10. Edge cases & security

- **Lost refresh token** — user can sign out from `/settings/sessions` (lists all active refresh-token sessions, can kill any).
- **Stolen access token** — JWT stays valid until expiry (≤1h). Mitigation: short access TTL + revocation list in middleware (`token_revocations` table) for emergency.
- **Suspicious activity** — refresh from a new IP triggers a 2FA challenge before the new access token is issued (optional, configurable per company).
- **Replay of single-use refresh token** — server detects, revokes the entire `oauth_authorisations` row, requires user to re-authorise. Hein gets an email alert.
- **OAuth consent farming** — rate-limit consent screen by IP and by `client_id`.
- **Scope creep over time** — if an app updates its required scopes, the user must re-authorise (consent screen shown again).
- **Tenant isolation** — every authorisation is `(user_id, company_id, app_id)`-tuple. A user with access to 3 companies has 3 separate authorisation rows for the same app. Switching company in the UI does NOT change which token is active for an OAuth integration.
- **Audit log entries** for: authorisation grant, revocation, scope change, suspicious refresh.

## 11. Open questions

1. **Default idle timeout** — 8 hours? 4 hours for first-party (web banking parity)? Configurable per company?
2. **2FA on new device for refresh** — opt-in per user, or mandatory?
3. **Should "Keep me signed in" be the default checked state?** Most other SaaS default to unchecked. Sage Cloud defaults to checked.
4. **Verified partner badge** — what's the vetting process to mark `is_verified=true`? Internal review? Code-of-conduct sign-off?
5. **Per-app rate limits** — different tier from per-user rate limits, or unified?

## 12. Out of scope (for follow-up PRDs)

- Federated SSO (SAML, Okta, Google Workspace, Microsoft Entra)
- IP allowlisting per user / per token
- WebAuthn / passkey support
- Service-account identities (vs user-bound tokens)
- Audit-log export to SIEM
- Per-token rate limits with billing tie-in (PRD-PAYG cross-reference)

## 13. Acceptance criteria

This PRD is "done" when:
- An accountant can complete a full work day in ISAFlow with zero involuntary logouts.
- A third-party developer can register an OAuth app, complete consent flow, and make their first authenticated API call within 10 minutes following the published docs.
- A power user can mint, use, and revoke a PAT entirely from the UI.
- All three flows have passing E2E tests in `tests/e2e/auth/`.
- Bugsink shows <2% of all API errors are auth-related.
- The "Keep me signed in" experience matches Xero / Sage Cloud parity in user testing.

---

**Cross-references:**
- `pages/api/auth/` — existing auth handlers
- `src/lib/auth/captureApiKeyAuth.ts` — pattern reference for Bearer token verification
- `src/lib/auth/withCsrf.ts` — must be exempted on `/api/oauth/token` (OAuth uses Bearer, not CSRF)
- `docs/competitive-analysis-quickbooks-online-za.md` — auth UX parity reference
- `docs/sage-accounting-za-feature-analysis.md` — Sage Cloud session pattern reference
