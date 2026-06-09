# Bureau Client Home — Design (Phase 2, Increment 3)

**Date:** 2026-06-09
**Status:** Approved
**Predecessor:** Phase 2 Increment 2 (cockpit reskin, PR #142, merged `bc088094`)
**Spec/plan siblings:** `docs/superpowers/specs/2026-06-08-ui-modernization-design.md` (§3.1 Level 2), `2026-06-08-bureau-cockpit-reskin-design.md`

## Goal

Build the **Level 2 client home** — a per-client triage surface a firm user reaches from the bureau roster. A glanceable 5-metric strip ("am I okay?") above a prioritised feed of that one client's outstanding work, each row clicking through *into* the client to act. Firm-led, theme-aware, reusing the Phase-1 primitives (`Card`/`Feed`/`ActionRow`/`Money`) and the existing cross-client aggregator scoped to a single company.

## Non-goals (YAGNI)

- **No cockpit triage list** (R/A/G client list grouping the flat work-queue) — that is the natural next increment and will *point at* the home this increment builds.
- **No direct-client landing redirect** — wiring the home as a `direct` user's login landing belongs to the parallel-shell flag increment.
- **No inline actions inside feed rows** — rows navigate into the existing deep pages; AI auto-post / one-key accept is Phase 3 (reconciliation).
- **No migration** — metrics are read-only aggregates over existing columns.
- **No new tenant surface** — reads stay inside the bureau auth boundary already established by `/api/bureau`.

## Tenant-safety invariant (load-bearing)

The new endpoint **trusts nothing from the URL**. It authenticates with `withUserAuth` (user-scoped, NOT per-company `withAuth`), re-derives the caller's entitled companies server-side from `bureau_companies` (the same join `/api/bureau` uses), and serves the requested `companyId` **only if it is in that set** — otherwise `404` with no data. Both reads (metrics + feed) are then scoped to that single verified id on the RLS-bypassing `@/lib/neon` pool. Bureau membership IS the authorization boundary, identical to the cockpit. Documented in `src/modules/bureau/services/.claude.md`.

## Components

### 1. Tenant gate — `getBureauClientForUser(userId, companyId)` (new, `bureauService.ts`)

The single, tested choke-point for "is this firm user allowed to see this client." Re-derives the caller's bureau companies from `bureau_companies` and returns the `CompanyMeta` (`{ bureau_id, bureau_name, company_id, company_name }`) for `companyId`, or `null` if it is not in the entitled set.

```
async function getBureauClientForUser(userId: string, companyId: string): Promise<CompanyMeta | null>
```

Implementation: `listBureausForUser(userId)` → `bureauIds`; then a single `SELECT … FROM bureau_companies bc JOIN bureaus b … JOIN companies c … WHERE bc.bureau_id = ANY(${bureauIds}) AND bc.company_id = ${companyId}` returning at most one row. Returns the first row mapped to `CompanyMeta`, else `null`.

### 2. Metrics — `bureauClientMetricsService.ts` (new)

`clientMetricsSnapshot(companyId)` runs 5 aggregates, **SQL shape copied verbatim from `pages/api/accounting/dashboard-stats.ts`** so the numbers match the Trial Balance / aging reports (reuse the `AR_OPEN_STATUSES` / `AP_OPEN_STATUSES` constants from `@/lib/constants/invoiceStatuses`):

| Metric | Source |
|---|---|
| `cash` | `SUM(debit − credit)` over `gl_journal_lines` for `gl_accounts.account_subtype='bank'`, posted entries |
| `ar` | `SUM(total_amount − COALESCE(amount_paid,0))` over `customer_invoices`, `status = ANY(AR_OPEN_STATUSES)` |
| `ap` | `SUM(total_amount − COALESCE(amount_paid,0))` over `supplier_invoices`, `status = ANY(AP_OPEN_STATUSES)` |
| `revenueMtd` | `SUM(credit − debit)` over `gl_journal_lines`, `account_type='revenue'`, posted, `entry_date >= monthStart` |
| `expensesMtd` | `SUM(debit − credit)` over `gl_journal_lines`, `account_type='expense'`, posted, `entry_date >= monthStart` |

A pure `shapeClientMetrics(rows)` does the `Number()` coercion and computes `profitMtd = revenueMtd − expensesMtd`; this is the unit-tested seam. The service returns:

```
interface ClientMetrics { cash: number; ar: number; ap: number; revenueMtd: number; profitMtd: number; }
```

Driver-safety: aggregates may arrive as numeric strings over some drivers (as the cockpit signals already guard); `shapeClientMetrics` calls `Number()` and coalesces null/NaN to `0`. `monthStart` is derived from the request `Date` (passed in, not `Date.now()` inside a pure fn).

### 3. API — `pages/api/bureau/client/[companyId].ts` (new)

`withUserAuth(withErrorHandler(handler))`. `GET` only (`methodNotAllowed` otherwise). Reads `companyId` from `req.query`, validates it is a non-empty string (`apiResponse.badRequest` otherwise), then:

1. `meta = await getBureauClientForUser(req.user.id, companyId)` → `apiResponse.notFound` if `null`.
2. `Promise.all([ clientMetricsSnapshot(companyId), aggregateBureauWork([companyId], new Map([[companyId, meta]]), new Date()) ])`.
3. `apiResponse.success(res, { company: { id: companyId, name: meta.company_name, bureauName: meta.bureau_name }, metrics, workItems: items })`.

Read-only; one round-trip; no active-company switch.

### 4. Page — `pages/bureau/clients/[companyId].tsx` (new, < 300 lines)

`AppLayout`. Mirrors the cockpit's loading / error states. Reads `companyId` from `router.query`, fetches `/api/bureau/client/[companyId]` via `apiFetch`, unwraps `json.data`.

- **Header:** back-link to `/bureau/clients`, client name (`h1`), bureau name subtitle.
- **Metrics strip:** 5 `Card`s (`Cash`, `AR`, `AP`, `Revenue MTD`, `Profit MTD`), value via `<Money>` with `--ff-num-font`. `grid-cols-2 md:grid-cols-3 lg:grid-cols-5`.
- **Feed:** `<Feed title="Needs you" empty="All caught up — nothing needs you.">` of `<ActionRow>`s from `workItems`. Per row: `leading` = severity badge (reuse the cockpit's `SEVERITY_BADGE` map — extract to a shared module so both pages import it rather than duplicating), `title` = `{task}` (no company name — single-client page), `subtitle` = `{detail}`, `amount` = `it.amount ?? null`, `meta` = formatted `dueAt` or `—`, `onClick` = `handleOpen(it)`.
- **`handleOpen`:** identical to the cockpit — `if (activeCompany?.id !== it.companyId) await switchCompany(it.companyId); router.push(it.href)`. This is the only place the active company switches, on the way into real work.

### 5. Roster wiring — `pages/bureau/clients.tsx` (edit)

Wrap each client row in a `next/link` `Link` to `/bureau/clients/${client.companyId}`. The link/unlink controls stay as-is (stop event propagation on those buttons so they don't trigger navigation). This is the only change to existing rendering.

### 6. Shared severity badge (small refactor)

`SEVERITY_BADGE` currently lives inline in `pages/bureau/index.tsx`. Extract to `src/components/bureau/severityBadge.ts` and import it in both the cockpit and the client home — avoids a second copy drifting. Pure presentation constant; no behavior change to the cockpit.

## Data flow

roster row click → `/bureau/clients/[id]` → `GET /api/bureau/client/[id]` → `getBureauClientForUser` gate → `Promise.all(metrics, feed)` → `{ company, metrics, workItems }` → page renders 5-Card strip + `Feed` of `ActionRow`s → ActionRow click → `switchCompany(id)` + `router.push(href)` into the deep task page.

## Error handling

- Endpoint: non-string / empty `companyId` → `badRequest`; non-member id → `notFound` (no data leak); existing `withErrorHandler` catches thrown DB errors.
- Page: existing try/catch on `apiFetch`; loading / error / not-found branches. A `404` from the endpoint renders a friendly "client not found or not in your bureau" state, not a crash.
- Metrics: `SUM` over zero rows → `null` → coalesced to `0` in `shapeClientMetrics`; `Money` never renders `NaN`.

## Testing

- **Pure unit tests** (`tests/unit/bureau/`, node env):
  - `shapeClientMetrics`: number inputs; numeric-string driver inputs; `profitMtd = revenueMtd − expensesMtd`; zero/null rows → `0` (never `NaN`).
- **type-check + lint + build** (`bun run type-check`, `bun run lint`, `bun run build`). React glue verified by the build — repo has no jsdom/RTL infra; no fabricated component tests.
- **Browser spot-check** (both themes) via the seed-a-temp-bureau technique (memory: `project_ui_modernization.md`), then fully revert the seed. Verify: roster row navigates to the home; 5 metrics render via `Money` (mono in practitioner, sans in client); feed rows themed; clicking a row switches active company and lands on the deep page; a non-member `companyId` in the URL returns the not-found state (tenant gate).

## Rollout

Single PR onto `master`, behind no flag (the bureau shell already ships; this adds a reachable surface without altering the existing nav or the cockpit's behavior). All CI gates green before merge. Production-deploy timing rules apply at merge time (human decision). Note the standalone-flat deploy gotcha from PR #143 still holds.

## File-size budget

All new files < 300 lines: metrics service ~90, endpoint ~50, page ~170, severity-badge module ~20. The roster edit is net-neutral.
