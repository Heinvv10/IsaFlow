# firm→cockpit landing — design

**Date:** 2026-06-10
**Branch:** `feat/firm-cockpit-landing` (off `origin/master` @ 803e908c)
**Roadmap:** UI-modernization Phase 3 carry-over; mirrors the direct-client `/home` redirect from PR #147.

## Problem

After login, the post-auth resolver `resolveDefaultLanding` sends **firm users** (a
bureau member who also has companies) to `/accounting` — the single-company
dashboard. But the firm-facing cockpit at `/bureau` (cross-client work-owed feed
+ triage board, built in PR #145) already exists, and its own docstring claims
*"Lands accountants here on login."* The routing was never pointed at it. Firm
users should land on the cockpit, not the single-company dashboard.

## Decision

**Option A — point landing at the existing `/bureau` cockpit.** No new page. The
`/bureau` page is already the cross-client cockpit and is reachable from nav; we
only change which path the resolver returns for firm users.

Rejected: **Option B — a net-new dedicated cockpit page.** YAGNI. It would
duplicate the triage board and work feed that `/bureau` already renders. If the
firm view later feels thin, KPI/practice-summary cards are added *to `/bureau`*,
not as a separate surface.

## Scope (4 files, no migration, no new page, no nav change)

1. **`src/lib/auth/resolveLanding.ts`** — the `isBureauMember` branch returns
   `/bureau` instead of `/accounting`. Update the file docstring
   (`Bureau member → /bureau`). The function stays pure (two-boolean input).

2. **`tests/unit/auth/resolveLanding.test.ts`** — the firm-user case asserts
   `/bureau`; rename its label. The other three cases (no-companies→`/onboarding`
   ×2, direct-client→`/home`) are unchanged.

3. **`pages/login.tsx`** — reconcile the two stale comments that still say
   firm→`/accounting` (the redirect-doc block and the transient-failure fallback
   note). **No behavior change** to the transient-failure path: on a landing-API
   hiccup the redirect still falls through to `returnTo`/`defaultRedirect`
   (acceptable degradation — the firm user's data is still reachable and the next
   login resolves correctly).

4. **`pages/bureau/index.tsx`** — its docstring already says "Lands accountants
   here on login," so it becomes accurate. Confirm (no logic change expected) that
   its existing guard still redirects non-firm (direct, single-tenant) users away
   from `/bureau`, so the page is never shown to a user without a bureau.

## Data flow (unchanged)

`/api/auth/landing` (`withUserAuth`) → `getUserCompanies(user.id)` +
`listBureausForUser(user.id)` → `resolveDefaultLanding({ hasCompanies,
isBureauMember })`. Only the returned **string** changes. No new I/O, no new query.

## Testing & verification

- **Unit (TDD RED→GREEN):** flip the resolver test assertion to `/bureau` first,
  watch it fail, then change the resolver. `bun run test:unit` green; `type-check`
  + `lint` clean.
- **Local browser (`isaflow_dev`):** transiently seed a bureau in `isaflow_dev` —
  one `bureaus` row, `bureau_users(role='owner')` for `hein@isaflow.co.za`, and
  `bureau_companies` linking the Demo company (`00000000-…-0001`) — run the dev
  server, log in, confirm the landing is `/bureau` and the cockpit renders. **Then
  delete the 3 seed rows** so `isaflow_dev` returns to baseline.
- **Prod (after deploy):** repeat the transient seed on prod `isaflow` Demo,
  browser-verify `app.isaflow.co.za` lands a firm user on `/bureau`, **then delete
  the seed rows.** Never leave the seed in prod.

## Risk

Near-zero. Prod currently has **0 `bureau_users`**, so the change is **dormant** in
normal operation — every real login still resolves as a direct client → `/home`.
The change affects only the post-login redirect string for firm users, is fully
covered by a unit test, and is reverted-seed-verified end to end.
