# Bureau Cockpit — Accounting Signals (Phase 2, Increment 1)

**Date:** 2026-06-08
**Status:** Approved (design) — ready for implementation planning
**Parent:** `docs/superpowers/specs/2026-06-08-ui-modernization-design.md` (§3.1 practice cockpit, §4 Phase 2)

---

## 1. Context (what already exists)

The UI-modernization spec posed cross-tenant aggregation for the practice cockpit as an unsolved blocker. It is **not** unsolved — a working cockpit already ships:

- **`pages/bureau/index.tsx`** — accountants land here on login; a cross-client, severity-ranked work queue. Click an item → switch active company → deep-link to the right page. Direct (single-tenant) users are redirected away. Bureau + severity filters and a stats strip exist.
- **`bureaus` / `bureau_companies` / `bureau_users` + `users.account_type`** (migration 436) — the firm→clients grouping with `/bureau` route gating.
- **`pages/api/bureau/index.ts`** — the aggregator. Authenticates with `withUserAuth` (user-scoped, no active company), derives the managed company set from `bureau_companies`, and aggregates across all of them with single `company_id = ANY(${companyIds})` queries on the non-RLS `@/lib/neon` pool. Builds the ranked `WorkItem[]` + stats.
- **`src/modules/bureau/services/bureauService.ts`** — bureau/company/user membership CRUD (not tenant-scoped; bureau tables sit outside per-company RLS).

### The sanctioned access pattern

`@/lib/neon`'s `sql` pool runs as the connection-string role and does **not** `SET LOCAL ROLE app_user`, so it bypasses RLS. Tenant isolation therefore rests entirely on the explicit `company_id = ANY(${companyIds})` filter, where `companyIds` is derived **only** from the calling user's `bureau_companies`. Bureau membership is the authorization boundary in place of per-company RLS. This is intentional and safe-by-construction — provided every query keeps that filter and the company set is never widened beyond bureau-derived IDs.

## 2. Problem

The aggregator pulls only **payroll** signals (pay runs, IRP5 readiness, tax-directive renewals, leave approvals). The accounting signals the parent spec leads with — **unreconciled bank transactions, bills to approve, VAT due, month-end close progress** — are absent. A bookkeeping firm's core daily work is invisible on the cockpit.

## 3. Goal & scope

Extend the existing `/bureau` aggregator with four accounting signals so a firm sees actionable accounting work across all client companies, merged into the existing ranked queue and stats strip.

**In scope:** the four signals; extraction of the aggregator into a service; the tenant-safety invariant; unit tests for pure logic.

**Out of scope (YAGNI / later increments):** reskin onto Phase 1 token primitives (`Card`/`Money`/`ActionRow`/`Feed`); Level 2 "needs you" client feed; Library demotion of the 12 modules; feature flag / parallel shell. No data-model changes beyond what the two ⚠️ signals require (§5).

## 4. Architecture

`pages/api/bureau/index.ts` is already ~240 lines (auth + company resolution + 4 payroll queries + item-shaping). Adding four more signals inline would exceed the 300-line limit and tangle concerns.

- **New: `src/modules/bureau/services/bureauWorkAggregatorService.ts`** — one self-contained `async` function per signal, each with the shape:

  ```ts
  // companyIds is bureau-derived and is the ONLY company input.
  // Every query MUST filter company_id = ANY(${companyIds}).
  async function <signal>(companyIds: string[], companyMeta: Map<string, CompanyMeta>, now: Date): Promise<WorkItem[]>
  ```

  The existing payroll queries move here too, one function each, so the handler holds zero SQL.

- **Handler becomes thin:** `withUserAuth` → `listBureausForUser` → derive `companyIds` from `bureau_companies` → `Promise.all([...signalFns])` → flatten → existing severity sort → respond with `{ bureaus, workItems, stats, companyCount }` plus the new month-end stat.

- **Tenant-safety invariant (load-bearing):** the handler is the single place that derives `companyIds`. Signal functions receive it as their only company parameter and cannot widen it. Documented as the module rule in `src/modules/bureau/services/.claude.md`. Reviewers reject any signal query lacking `company_id = ANY(${companyIds})`.

### Reused types

The existing `WorkItem` interface is reused verbatim (`bureauId`, `bureauName`, `companyId`, `companyName`, `task`, `detail`, `dueAt`, `href`, `severity: 'overdue'|'due_soon'|'info'`), so the three item-emitting signals (unreconciled txns, bills, VAT) merge into the current list, sort, and stats with **no client-side change**. The month-end stat is the one client-visible addition: `stats` gains a `monthEnd: { closed: number; total: number }` field that `pages/bureau/index.tsx` renders in the stats strip.

## 5. The four signals

| Signal | Source table | "Actionable" definition | `href` target | Confidence |
|---|---|---|---|---|
| Unreconciled txns | `bank_transactions` | `status NOT IN ('reconciled','excluded')`, `COUNT(*) … GROUP BY company_id`. Severity `info` (no per-txn due date). | bank reconciliation page | High — composite index `(company_id, status, created_at)` exists |
| Bills to approve | `supplier_invoices` | `status = 'pending_approval'`, count per company; severity from earliest `due_date` (overdue / ≤7d / info). | AP bills list | High — `idx_si_status` exists |
| VAT due | VAT201 model (table to confirm — §6) | period ended, return not filed, SARS due date within 30 days. Severity: `overdue` if past due, `due_soon` if ≤7 days, else `info`. | VAT201 page | Source table confirmed in planning |
| Month-end progress | `fiscal_periods` / `periodCloseReadinessService` | per-company: current period `status <> 'closed'`. **Stat only this increment** — contributes the "X/N closed" figure to the stats strip, emits **no** `WorkItem` (so no `href`/severity). Per-company close state confirmed in planning (§6). | n/a (stat) | Per-company close model confirmed in planning |

Unreconciled-txn "unreconciled" is defined as `status NOT IN ('reconciled','excluded')` — i.e. anything still needing attention (`imported`/`provisional`/`allocated`/`matched`). If planning finds `matched` should be excluded (already auto-matched, awaiting batch reconcile), that narrowing is a one-line change with no architectural impact.

## 6. Open items to resolve at the top of planning (lookups, not design-shaping)

1. **VAT201 period/return table name** and its filing-status + due-date columns. The VAT201 data model exists (migrations 210, 265b) but the exact table didn't surface by name. Mirror the existing EMP201 deadline convention (end of month following period) if no explicit due date column exists.
2. **Per-company month-end close state.** `fiscal_periods` (migration 200) shows `status IN ('open','closing','closed','locked')` and `end_date` but no `company_id` in its original definition (UNIQUE is `(fiscal_year, period_number)`). Confirm whether `company_id` was added later, whether `fiscal_periods` is per-company or a shared calendar, and where per-company close status actually lives (likely `periodCloseReadinessService` or a `*_period_*` table). The month-end stat depends on this.

Neither affects §4 architecture — both are source-query details inside their signal function.

## 7. Error handling & performance

- **Graceful degradation:** each signal function is wrapped so a failure logs via `@/lib/logger` and returns `[]` for that signal rather than 500-ing the whole cockpit. No empty catch blocks — log with context (`{ signal, companyCount }`) and comment why.
- **One round trip per signal** regardless of client count: every signal is a single grouped aggregate against a `company_id`-indexed table. `Promise.all` runs payroll + accounting signals concurrently, as today.
- No new N+1: the cockpit never loops per company in SQL.

## 8. Testing

- **Pure logic** (severity derivation from due dates, period/deadline math, item shaping, the month-end "X/N" reduction) → Vitest unit tests in `tests/unit/`, `environment: 'node'` style. No RTL (the repo has no React/jsdom test infra; do not fabricate component tests).
- **SQL** follows the shipped payroll-signal precedent; integration is covered by the existing manual/e2e path, consistent with how the current aggregator shipped.
- Add a focused test asserting each signal function only ever emits `WorkItem`s whose `companyId ∈ companyIds` (guards the tenant-safety invariant at the unit level).

## 9. Success criteria

- A firm user on `/bureau` sees unreconciled-txn, bills-to-approve, and VAT-due items interleaved with payroll items in the existing severity-ranked queue, each deep-linking into the correct client.
- The stats strip gains a month-end "X/N closed" figure.
- `pages/api/bureau/index.ts` is under 300 lines and contains no SQL; all signal queries live in `bureauWorkAggregatorService.ts`.
- Every signal query filters `company_id = ANY(${companyIds})`; a unit test proves no signal emits an item outside the bureau-derived company set.
- No change to the existing payroll signals' output.
