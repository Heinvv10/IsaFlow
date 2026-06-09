# Direct-Client Landing Redirect — Design

**Date:** 2026-06-09
**Status:** Approved
**Predecessor:** Phase 2 Increment 3 (bureau client home, PR #144, merged `75622f33`)
**Spec/plan siblings:** `docs/superpowers/specs/2026-06-08-ui-modernization-design.md` (§3.1 Level 2), `2026-06-09-bureau-client-home-design.md`

## Goal

Wire the spec's **"direct clients skip Level 1 and land on their own Level 2 home"** (§3.1). A direct (non-bureau) client logs in and lands on a calm, per-business home at `/home` — the same metric strip + "needs-you" feed the firm sees for a client, but authorized by company ownership rather than bureau membership. Firm-user and onboarding routing are untouched.

This increment was explicitly deferred by the Phase-2.3 spec ("No direct-client landing redirect — wiring the home as a `direct` user's login landing belongs to the parallel-shell flag increment"). The parallel-shell flag was subsequently dropped as YAGNI (no live users → no rollout risk to hedge), so this increment inherits the direct-client landing on its own.

## Non-goals (YAGNI)

- **No firm→cockpit landing.** Firm users keep landing on `/accounting` (reaching the cockpit via the Portfolio tab as today). Wiring firm users to `/bureau` is its own concern with its own multi-bureau / empty-state questions.
- **No Warm client theme or simplified direct-only shell.** The home renders under the user's current theme inside the standard `AppLayout`. The Warm theme + branded portal is Phase 5.
- **No company picker for multi-company direct clients.** They land on their default/active company; the existing company switcher changes it and the home re-fetches.
- **No interception of non-login entry points.** Bookmarking `/accounting` still works; the redirect is a login-time convenience, not a hard gate.
- **No inline feed actions.** Rows navigate into existing deep pages; one-key accept / AI auto-post is Phase 3 (reconciliation).
- **No migration, no new service logic, no data-model change.** Read-only; reuses the Phase-2.3 metrics + work-aggregator services and the Phase-1 UI primitives.

## Identity model (load-bearing)

There is no "direct vs bureau" flag in the client today; the distinction is derived server-side from two existing tables:

- `company_users` — the universal user↔company link (`role`, `is_default`). Every user, firm or not, reaches their companies through this. `getUserCompanies(userId)` reads it.
- `bureau_users` / `bureau_companies` — the firm/practice layer. `listBureausForUser(userId)` reads bureau membership.

**Definition:** a user is a **direct client** iff `listBureausForUser(userId)` is empty AND `getUserCompanies(userId)` is non-empty. A **firm user** has ≥1 bureau. A user with no companies is an onboarding case (unchanged).

## Components

### 1. Landing resolver — `resolveDefaultLanding(...)` (new, pure)

The single tested choke-point for "where does this user land by default." Pure, no I/O — takes booleans, returns a path. Lives in a small module (e.g. `src/lib/auth/resolveLanding.ts`).

```ts
function resolveDefaultLanding(input: { hasCompanies: boolean; isBureauMember: boolean }): string {
  if (!input.hasCompanies) return '/onboarding';
  if (input.isBureauMember) return '/accounting';
  return '/home';
}
```

Truth table (the unit test):

| hasCompanies | isBureauMember | → default |
|---|---|---|
| false | (any) | `/onboarding` |
| true | true | `/accounting` |
| true | false | `/home` |

### 2. Landing endpoint — `GET /api/auth/landing` (new)

`withUserAuth(withErrorHandler(handler))`, `GET` only. Computes `hasCompanies = (await getUserCompanies(userId)).length > 0` and `isBureauMember = (await listBureausForUser(userId)).length > 0`, then returns `apiResponse.success(res, { defaultTarget: resolveDefaultLanding({ hasCompanies, isBureauMember }) })`. No URL input is trusted; the user id comes from the authenticated session only.

### 3. Login wiring — `pages/login.tsx#postLoginRedirect`

Replace the current `?action=user-companies` fetch with a call to `/api/auth/landing`, preserving today's precedence exactly:

```ts
const postLoginRedirect = async (): Promise<string> => {
  if (isAdminHost) return returnTo;                       // unchanged admin-host behaviour
  try {
    const res = await fetch('/api/auth/landing', { credentials: 'include' });
    if (res.ok) {
      const body = (await res.json()) as { data?: { defaultTarget?: string } };
      const target = body.data?.defaultTarget;
      if (target === '/onboarding') return '/onboarding'; // always force onboarding
      if (returnTo && returnTo !== '/accounting') return returnTo; // explicit deep-link wins
      if (target) return target;                          // '/home' (direct) or '/accounting' (firm)
    }
  } catch {
    // Non-fatal — fall through to the configured returnTo
  }
  return returnTo;
};
```

Both the no-2FA path and the post-TOTP path already funnel through `postLoginRedirect`, so this one change covers both. The full-page `window.location.assign(target)` navigation is unchanged (it remounts `AuthContext`/`CompanyContext` against the new session cookies).

### 4. Home payload — `GET /api/home` (new)

`withAuth(withErrorHandler(handler))`, `GET` only. **`withAuth` is the ownership gate**: it validates the caller's `company_users` membership for the active company, sets `req.companyId`, and returns `400 NO_ACTIVE_COMPANY` when none is selected — identical to every `/api/accounting/*` route. No URL-supplied company id, no custom gate.

```ts
const companyId = req.companyId;
const [metrics, work] = await Promise.all([
  clientMetricsSnapshot(companyId),
  aggregateBureauWork(
    [companyId],
    new Map([[companyId, { bureau_id: '', bureau_name: '', company_id: companyId, company_name: '' }]]),
    new Date(),
  ),
]);
return apiResponse.success(res, { metrics, workItems: work.items });
```

`aggregateBureauWork`'s SQL is purely `company_id = ANY(${companyIds})` — no bureau filter — and the `CompanyMeta` map is used only to label output `WorkItem`s. The direct home shows a single company, so empty bureau/company-name labels are unused. The company name for the page header comes from `CompanyContext`, not this payload.

### 5. Home page — `pages/home.tsx` (new)

`AppLayout` shell. Reads `activeCompany` from `useCompany()`; gates its `apiFetch('/api/home')` on `activeCompany` being ready and shows a loader while `companiesLoading` (mirrors `pages/accounting/index.tsx`, which avoids the `NO_ACTIVE_COMPANY` race on first full-page login navigation). Header label = `activeCompany.companyName`. Renders `<ClientHomeView metrics={data.metrics} workItems={data.workItems} />` plus its own error state (its own copy — not the bureau page's "not in your bureau"). No "back to clients" chrome (a direct client has no roster).

### 6. Shared body — `<ClientHomeView>` (new, `src/components/bureau/ClientHomeView.tsx`)

The metric strip (`Card` + `Money`) + "needs-you" `<Feed>` of `ActionRow`s with `SEVERITY_BADGE`, currently built inline in `pages/bureau/clients/[companyId].tsx`. Extracted verbatim into a presentational component taking `{ metrics, workItems }`. The bureau page is refactored to render `<ClientHomeView>` (keeping its own header, back-link, and error/loading chrome). Pure presentational move — no auth or data-flow change to the bureau page.

## Tenant-safety invariant

`/api/home` reads only the caller's own active company, gated by `withAuth`'s `company_users` membership check + the RLS `app.current_company_id` GUC — the same boundary protecting all accounting routes. No companyId is read from the URL. The bureau endpoint's separate `bureau_companies` gate is untouched: each route keeps exactly one authorization model.

## Testing

- **Unit:** `resolveDefaultLanding` truth table (3 rows above). The metric/feed shaping is already covered by `shapeClientMetrics` + the aggregator's existing pure tests, which `<ClientHomeView>` consumes unchanged.
- **Type-check / lint / build:** the React glue (`pages/home.tsx`, `<ClientHomeView>`, the bureau-page refactor) is covered by `bun run type-check` + `bun run build`, consistent with the nav/bureau work (no React/jsdom test infra in this repo — do not fabricate component tests).
- **Browser verify (prod-shaped):** (a) log in as a direct user (no bureau, ≥1 company) → lands on `/home`, metric strip + needs-you feed render for their company; (b) log in as a firm user → still `/accounting`; (c) a no-company user → still `/onboarding`; (d) `/bureau/clients/[id]` renders byte-identically after the extract.

## Success criteria

- A direct client lands, on login, on a calm `/home` answering "am I okay?" for their business — without ever touching the firm cockpit.
- Firm-user and onboarding login routing are provably unchanged.
- The Level-2 body is authored once and shared between the firm and direct surfaces.
- No cross-tenant read is possible from `/home`; each endpoint retains a single authorization model.

## Open questions for planning

- Exact file location for `resolveDefaultLanding` (`src/lib/auth/resolveLanding.ts` proposed) and whether the landing endpoint belongs under `pages/api/auth/`.
- Whether `<ClientHomeView>` lives under `src/components/bureau/` (its origin) or a more neutral `src/components/clientHome/` now that two surfaces consume it. (Lean: keep at origin to minimise churn; revisit if a third consumer appears.)
- The `/home` page's empty-state copy and whether a brand-new direct client (company with no transactions yet) needs a distinct "let's get started" feed message vs. the generic "All caught up."
