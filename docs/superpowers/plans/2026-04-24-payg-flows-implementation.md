# PAYG Flows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Pay-As-You-Go "Flows" micro-pricing per spec `docs/superpowers/specs/2026-04-19-payg-flows-pricing-design.md`. Deliver the `payg` plan row, the Flow Wallet subsystem (wallet / ledger / bundles / purchases), the `withFlowMeter` HOF, admin + tenant UIs, and the upgrade-nudge loop. Payment gateway is out of scope (v1 uses admin-recorded payments; Stitch integration is a v2 concern — see `src/modules/billing/services/stitchClient.ts`).

**Architecture:** Approach C from the spec — PAYG is a first-class `plans` row (`code='payg'`, `monthly_price_cents=0`). Economic logic is isolated in `src/modules/billing/services/flowWalletService.ts`. A `withFlowMeter(operationCode, flowCost)` HOF composes **inside** `withAuth` on metered routes, atomically debits the wallet in a `SELECT FOR UPDATE` transaction, writes a `flow_ledger` row, and returns `402 Payment Required` when the balance is insufficient. A monthly cron resets `month_flows_used` and a post-debit hook recomputes `nudge_level`.

**Tech Stack:** Next.js 14 Pages Router, TypeScript strict, Supabase (self-hosted Postgres on velo stack), Vitest unit tests, Playwright E2E, bun. Uses existing `sql` tagged template from `@/lib/neon`, `apiResponse.*` helpers, `log` from `@/lib/logger`, and the GoTrue `withAuth`/`withPlatformAdmin` middleware.

**Spec:** `docs/superpowers/specs/2026-04-19-payg-flows-pricing-design.md`

---

## File Structure

**New — migration:**

| Path | Purpose |
|---|---|
| `scripts/migrations/sql/437_payg_flow_wallet.sql` | `plans` row for `payg` + `flow_wallet` / `flow_bundles` / `flow_ledger` / `flow_purchases` tables + RLS + seed bundles |

**New — services:**

| Path | Purpose |
|---|---|
| `src/modules/billing/services/flowWalletService.ts` | `getWallet`, `purchaseBundle`, `deductFlows`, `triggerAutoTopup`, `recalculateNudge`, `resetMonthlyCounter` |
| `src/modules/billing/services/flowOperationCatalog.ts` | Central map `{ operationCode → flowCost, category }` — single source of truth for metering |
| `src/lib/billing/withFlowMeter.ts` | HOF middleware: `withFlowMeter(operationCode, flowCost)(handler)` |
| `tests/unit/services/billing/flowWalletService.test.ts` | Atomic debit, refund, nudge thresholds, zero-balance 402, auto-topup success/failure |
| `tests/unit/lib/billing/withFlowMeter.test.ts` | Non-PAYG passthrough, 402 on empty wallet, ledger write on debit, refund on handler throw |

**New — customer API:**

| Path | Purpose |
|---|---|
| `pages/api/billing/flows/wallet.ts` | `GET` current balance + nudge + month usage |
| `pages/api/billing/flows/bundles.ts` | `GET` active bundles (public-plan listing) |
| `pages/api/billing/flows/purchase.ts` | `POST { bundleId }` — records purchase + credits wallet (v1: admin-recorded, no gateway) |
| `pages/api/billing/flows/auto-topup.ts` | `PATCH { enabled, bundleId }` |
| `pages/api/billing/flows/ledger.ts` | `GET` paginated ledger entries for current company |

**New — admin API:**

| Path | Purpose |
|---|---|
| `pages/api/admin/billing/payg/companies.ts` | `GET` all PAYG companies with balance, month spend, nudge |
| `pages/api/admin/billing/payg/[companyId]/wallet.ts` | `GET` wallet detail + ledger history |
| `pages/api/admin/billing/payg/[companyId]/adjust.ts` | `POST { flows, reason }` — manual credit/debit |
| `pages/api/admin/billing/payg/[companyId]/eligibility.ts` | `POST { eligible, reason }` — toggle PAYG eligibility flag |
| `pages/api/admin/billing/flow-bundles.ts` | `GET` / `POST` bundles CRUD |
| `pages/api/admin/billing/flow-bundles/[id].ts` | `GET` / `PATCH` / `DELETE` single bundle |

**New — cron:**

| Path | Purpose |
|---|---|
| `pages/api/cron/reset-flow-month.ts` | Monthly reset of `month_flows_used` + `month_reset_at` across all PAYG companies |
| `scripts/isaflow-flow-month-reset.service` | systemd unit for cron fire |
| `scripts/isaflow-flow-month-reset.timer` | systemd timer, fires 00:05 SAST on the 1st |

**New — UI:**

| Path | Purpose |
|---|---|
| `pages/accounting/settings/billing/flows.tsx` | Tenant wallet page: balance, bundle selector, auto-topup toggle, ledger history |
| `src/components/billing/FlowWalletWidget.tsx` | Dashboard widget — balance + nudge banner + quick "Top up" |
| `src/components/billing/TopUpModal.tsx` | Triggered by 402 or manual — bundle grid + purchase confirm |
| `src/components/billing/UpgradeNudgeBanner.tsx` | Yellow / orange / red banner with "Compare plans" CTA |
| `pages/admin/billing/payg.tsx` | Admin PAYG tab (companies list, filters, nudge level, month spend) |
| `pages/admin/billing/flow-bundles.tsx` | Admin CRUD for bundles |
| `src/components/admin/billing/WalletLedgerTable.tsx` | Ledger viewer on admin company-detail page |

**New — onboarding hook:**

| Path | Purpose |
|---|---|
| `src/modules/onboarding/services/paygEligibilityService.ts` | `isEligible(companyId)` — checks rolling 3-month tx count, signup turnover, admin flag |

**Modified:**

| Path | Change |
|---|---|
| `src/components/accounting/navSections/*` (settings section) | Add "Flows" nav item under Billing (PAYG plan only) |
| `pages/accounting/dashboard.tsx` | Mount `FlowWalletWidget` when company is on PAYG |
| `src/components/layout/accountingNavConfig.ts` | Register `/accounting/settings/billing/flows` |
| `pages/admin/billing/index.tsx` | Add "PAYG" sub-tab alongside Plans/Subscriptions/Invoices |
| `pages/admin/billing/plans.tsx` | Surface the new `payg` plan row (read-only — it is special) |
| `pages/signup.tsx` *(or the post-waitlist replacement)* | Offer PAYG as a fourth tier for declared turnover < R1M |
| `src/lib/apiResponse.ts` | Add `paymentRequired()` helper → `402 { error: 'insufficient_flows', balance, required }` |
| ~12 metered handlers | Wrap with `withFlowMeter(...)` — see Task 7 for the initial list |

**Deleted:** none.

---

## Task 1: Migration 437 — flow wallet schema + payg plan row

**Goal:** Add the four `flow_*` tables, the `payg` plan row, the `companies.payg_eligible` column, RLS policies, and seed the four starter bundles.

**Files:**
- `scripts/migrations/sql/437_payg_flow_wallet.sql` *(new)*

**Steps:**

- [ ] Prepend `-- Migration 437: PAYG Flow Wallet` header and wrap everything in a single transaction.
- [ ] `INSERT INTO plans (code, name, description, monthly_price_cents, annual_price_cents, currency, limits, display_order) VALUES ('payg', 'Pay-As-You-Go', 'Prepaid Flows — pay only for what you use. Designed for micro enterprises.', 0, 0, 'ZAR', '{"max_users": 1, "max_companies": 1}', 0) ON CONFLICT (code) DO NOTHING;`
- [ ] `ALTER TABLE companies ADD COLUMN IF NOT EXISTS payg_eligible BOOLEAN NOT NULL DEFAULT false;`
- [ ] `CREATE TABLE IF NOT EXISTS flow_bundles (...)` per spec §5 — seed `Micro (100, 1000)`, `Small (500, 5000)`, `Medium (1500, 15000)`, `Large (2500, 25000)` with `display_order` 1/2/3/4.
- [ ] `CREATE TABLE IF NOT EXISTS flow_wallet (...)` per spec §5. Add `CHECK (balance_flows >= 0)` and `CHECK (nudge_level IN ('none','yellow','orange','red'))`.
- [ ] `CREATE TABLE IF NOT EXISTS flow_ledger (...)` per spec §5. Add `CHECK (type IN ('purchase','debit','refund','admin_adjustment'))`. Index `(company_id, created_at DESC)`.
- [ ] `CREATE TABLE IF NOT EXISTS flow_purchases (...)` per spec §5. Index `(company_id, created_at DESC)`.
- [ ] Enable RLS on `flow_wallet`, `flow_ledger`, `flow_purchases`: `USING (company_id = current_setting('request.jwt.claims', true)::jsonb->>'company_id')::uuid` plus a matching `WITH CHECK`. `flow_bundles` is global — RLS enabled with `USING (true)` read-only for app_user; admin bypass via BYPASSRLS role.
- [ ] Grant `SELECT, INSERT, UPDATE` on the four tables to `app_user` (we only UPDATE `flow_wallet`; `flow_ledger` is append-only — add a trigger that RAISES on UPDATE/DELETE).
- [ ] Verify: apply to local dev via `scripts/apply-migrations.ts` and run `\d+ flow_wallet` — confirm constraints, RLS, and indexes exist.

**Success:** migration applies cleanly on a fresh DB **and** against a prod-shaped DB with the `IF NOT EXISTS` clauses making it idempotent.

---

## Task 2: Operation catalog + eligibility service

**Goal:** Lock down the single source of truth for "what does this operation cost" and "who qualifies for PAYG", independent of the wallet itself.

**Files:**
- `src/modules/billing/services/flowOperationCatalog.ts` *(new)*
- `src/modules/onboarding/services/paygEligibilityService.ts` *(new)*
- `tests/unit/services/billing/flowOperationCatalog.test.ts` *(new)*
- `tests/unit/services/onboarding/paygEligibilityService.test.ts` *(new)*

**Steps:**

- [ ] In `flowOperationCatalog.ts` export a typed `const FLOW_OPERATIONS = { 'bank.import': { cost: 1, category: 'basic' }, 'bank.allocate': { cost: 1, category: 'basic' }, 'invoice.create': { cost: 3, category: 'standard' }, 'supplier.bill.create': { cost: 3, category: 'standard' }, 'payment.record': { cost: 3, category: 'standard' }, 'journal.create': { cost: 3, category: 'standard' }, 'report.tb': { cost: 10, category: 'advanced' }, 'report.pnl': { cost: 10, category: 'advanced' }, 'report.bs': { cost: 10, category: 'advanced' }, 'report.age': { cost: 10, category: 'advanced' }, 'vat.return': { cost: 10, category: 'advanced' }, 'yearend.close': { cost: 10, category: 'advanced' }, 'afs.generate': { cost: 50, category: 'premium' }, 'compliance.export': { cost: 50, category: 'premium' }, 'audit.export': { cost: 50, category: 'premium' } } as const;` plus a `FlowOperationCode` type derived from `keyof typeof FLOW_OPERATIONS`.
- [ ] Add a `getFlowCost(code: FlowOperationCode): number` helper — centralises the lookup so callers never hard-code costs.
- [ ] In `paygEligibilityService.ts` export `isEligible(companyId)` that returns `{ eligible: boolean, reason: 'volume' | 'turnover' | 'admin' | 'ineligible' }`. Volume check: `SELECT COUNT(*) FROM journal_entries WHERE company_id = $1 AND created_at > NOW() - INTERVAL '3 months'` ÷ 3 < 200. Turnover: read `companies.annual_turnover_cents` if set (spec §3 — we'll store the signup declaration there). Admin: read `companies.payg_eligible`.
- [ ] Tests cover each gate individually and the composite OR.

**Success:** catalog is the only file in the repo defining Flow costs; eligibility service returns correct reason per input shape.

---

## Task 3: Flow Wallet Service

**Goal:** All wallet mutations go through a single service with atomic semantics and ledger parity.

**Files:**
- `src/modules/billing/services/flowWalletService.ts` *(new)*
- `tests/unit/services/billing/flowWalletService.test.ts` *(new)*

**Steps:**

- [ ] `getWallet(companyId)` — returns `{ balance, nudgeLevel, monthFlowsUsed, autoTopupEnabled, autoTopupBundleId } | null`. Returns null when no wallet row yet (new PAYG company) — callers treat null as balance 0.
- [ ] `ensureWallet(companyId)` — `INSERT ... ON CONFLICT (company_id) DO NOTHING RETURNING *`. Called lazily on first debit / purchase.
- [ ] `purchaseBundle(companyId, bundleId, { paymentMethod, autoTriggered })` — in a transaction: lock wallet `SELECT ... FOR UPDATE`, insert `flow_purchases` row (`status='succeeded'` for v1 admin-recorded path), UPDATE `flow_wallet.balance_flows = balance_flows + bundle.flows`, insert `flow_ledger` row `{ type: 'purchase', flows: +N, balance_after }`. Return updated wallet.
- [ ] `deductFlows(companyId, flowCost, operationCode, referenceId)` — in a transaction: `SELECT balance_flows FROM flow_wallet WHERE company_id = $1 FOR UPDATE`. If insufficient → throw `InsufficientFlowsError` (new typed error class). Else UPDATE balance, UPDATE `month_flows_used = month_flows_used + flowCost`, insert `flow_ledger` row `{ type: 'debit', flows: -flowCost, balance_after }`. Return `balance_after`.
- [ ] `refundFlows(companyId, flowCost, operationCode, referenceId)` — mirror of debit with positive flows, `type: 'refund'`. Used when the wrapped handler throws **after** the debit.
- [ ] `adminAdjust(companyId, flows, reason)` — platform-admin-only path. Records `type: 'admin_adjustment'`.
- [ ] `triggerAutoTopup(companyId)` — read wallet, if `auto_topup_enabled && payment_method_token` call `purchaseBundle(companyId, auto_topup_bundle_id, { autoTriggered: true })`. v1 returns failure if no payment token (gateway is out of scope).
- [ ] `recalculateNudge(companyId)` — compute new level from `month_flows_used` per spec §6 thresholds, UPDATE wallet if changed. Call at end of every debit.
- [ ] `resetMonthlyCounter()` — `UPDATE flow_wallet SET month_flows_used = 0, month_reset_at = NOW(), nudge_level = 'none'`. Called by cron.
- [ ] All functions take a `client?: SqlClient` optional tx handle so they compose inside outer transactions (e.g. inside metering middleware).
- [ ] Tests: atomic debit correctness under simulated concurrent calls, ledger parity (every balance change has exactly one ledger row with matching `balance_after`), nudge threshold edges (1 799, 1 800, 2 399, 2 400, 2 899, 2 900), zero-balance debit throws, refund restores balance.

**Success:** every debit/credit writes exactly one ledger row; `balance_after` in the latest ledger row always equals `flow_wallet.balance_flows`; nudge recalculated post-debit.

---

## Task 4: `withFlowMeter` middleware

**Goal:** One HOF that wraps any metered handler and enforces the debit-or-reject contract.

**Files:**
- `src/lib/billing/withFlowMeter.ts` *(new)*
- `src/lib/apiResponse.ts` *(modify — add `paymentRequired`)*
- `tests/unit/lib/billing/withFlowMeter.test.ts` *(new)*

**Steps:**

- [ ] Add `paymentRequired(res, { balance, required })` helper to `apiResponse.ts` returning `res.status(402).json({ error: 'insufficient_flows', balance, required })`.
- [ ] Export `withFlowMeter(operationCode: FlowOperationCode, flowCost: number)` that returns `(handler) => async (req, res) => { ... }`.
- [ ] Middleware body: read `req.companyPlan` (populated by `withAuth`) — if not `'payg'`, call `handler(req, res)` unchanged (plans-other-than-PAYG pay via subscription, never metered).
- [ ] If PAYG: open a tx, `SELECT ... FOR UPDATE` the wallet, check balance. If `< flowCost` → try `triggerAutoTopup` inside the same tx; on success re-check balance; on failure `return apiResponse.paymentRequired(res, { balance, required: flowCost })`.
- [ ] If sufficient: call `deductFlows` inside the tx, capture `balance_after`, commit. Then invoke the handler. If the handler **throws** or responds with 4xx/5xx after the debit, call `refundFlows` (new tx) with the same `operationCode` so we never charge for a failed operation.
- [ ] Attach `res.setHeader('X-Flow-Balance-Before', balance)` and `'X-Flow-Balance-After', balanceAfter)` for client-side telemetry.
- [ ] After successful handler response, call `recalculateNudge(companyId)` (fire-and-forget with `.catch(log.error)`).
- [ ] Tests: non-PAYG passthrough, 402 on empty wallet with auto-topup disabled, 402 when auto-topup fails, successful debit + ledger row, refund on handler throw (ledger shows matching `debit` + `refund` pair), nudge recalc invoked.

**Success:** wrapping a route adds two lines and gets atomicity, refund, nudge recalc, and 402 semantics for free.

---

## Task 5: Customer-facing API endpoints

**Files:** five endpoints under `pages/api/billing/flows/*` *(new)*.

**Steps per endpoint:**

- [ ] All handlers composed with `withAuth(withErrorHandler(handler))` — tenant-scoped, no metering on the wallet endpoints themselves.
- [ ] `GET wallet.ts` → `flowWalletService.getWallet(companyId)` → `apiResponse.success({ balance, nudgeLevel, monthFlowsUsed, autoTopup: { enabled, bundleId } })`.
- [ ] `GET bundles.ts` → `SELECT * FROM flow_bundles WHERE is_active = true ORDER BY display_order` → `apiResponse.success({ bundles })`.
- [ ] `POST purchase.ts` → body `{ bundleId }` → `flowWalletService.purchaseBundle(...)` with `paymentMethod: 'admin_recorded'` → success.
- [ ] `PATCH auto-topup.ts` → body `{ enabled, bundleId? }` → UPDATE `flow_wallet` → success.
- [ ] `GET ledger.ts` → paginated (`?limit=50&cursor=...`) → `apiResponse.success({ entries, nextCursor })`.
- [ ] Each endpoint rejects non-PAYG companies with 403 (`apiResponse.forbidden('PAYG endpoints are only available on the Pay-As-You-Go plan')`).
- [ ] Add integration tests under `tests/integration/api/billing-flows.int.test.ts`.

**Success:** tenant can view balance, buy a bundle, enable auto-topup, and scroll ledger history end-to-end against dev DB.

---

## Task 6: Admin API + UI

**Files:**
- Admin APIs listed in File Structure — composed with `withPlatformAdmin(withErrorHandler(handler))`.
- `pages/admin/billing/payg.tsx`, `pages/admin/billing/flow-bundles.tsx`, `src/components/admin/billing/WalletLedgerTable.tsx` *(new UIs)*.
- `pages/admin/billing/index.tsx` *(modify — add PAYG sub-tab)*.

**Steps:**

- [ ] `GET /api/admin/billing/payg/companies` — joins `companies` × `flow_wallet` × this month's ledger sum for `month_spend_cents`. Filters: `?nudgeLevel=red`, `?autoTopup=enabled`, `?search=...`.
- [ ] `GET /api/admin/billing/payg/[companyId]/wallet` — full wallet + paginated ledger.
- [ ] `POST /api/admin/billing/payg/[companyId]/adjust` — calls `flowWalletService.adminAdjust(companyId, flows, reason)`. Body validates `flows` is signed int ≠ 0 and `reason` is non-empty.
- [ ] `POST /api/admin/billing/payg/[companyId]/eligibility` — UPDATE `companies.payg_eligible`.
- [ ] `/api/admin/billing/flow-bundles` CRUD — `is_active=false` is preferred over DELETE (foreign keys from `flow_purchases`).
- [ ] `pages/admin/billing/payg.tsx` — table of companies with colour-coded nudge pills, month spend vs R299 Starter comparison, inline "Adjust" button opening a modal.
- [ ] `pages/admin/billing/flow-bundles.tsx` — editable bundle grid.
- [ ] `WalletLedgerTable.tsx` — reusable component, plugged into admin company-detail page as a new "Wallet" tab when `company.plan_code = 'payg'`.
- [ ] Add PAYG to the sub-nav in `pages/admin/billing/index.tsx`.

**Success:** admin can see every PAYG company at a glance, drill into a ledger, adjust balances, and toggle eligibility.

---

## Task 7: Wrap metered handlers

**Goal:** Apply `withFlowMeter` to the handlers catalogued in Task 2. Start conservative — wrap the 12 below, watch telemetry, expand in a follow-up.

**Initial list (maps to `flowOperationCatalog.ts`):**

| Operation code | Route |
|---|---|
| `bank.import` | `pages/api/bank/import.ts` (or equivalent) |
| `bank.allocate` | `pages/api/bank/allocate.ts` |
| `invoice.create` | `pages/api/accounting/customer-invoices/index.ts` (POST) |
| `supplier.bill.create` | `pages/api/accounting/supplier-invoices/index.ts` (POST) |
| `payment.record` | `pages/api/accounting/payments/index.ts` (POST) |
| `journal.create` | `pages/api/accounting/journal-entries/index.ts` (POST) |
| `report.tb` | `pages/api/accounting/reports/trial-balance.ts` |
| `report.pnl` | `pages/api/accounting/reports/profit-loss.ts` |
| `report.bs` | `pages/api/accounting/reports/balance-sheet.ts` |
| `report.age` | `pages/api/accounting/reports/aged-analysis.ts` |
| `vat.return` | `pages/api/accounting/reports/vat-return.ts` |
| `afs.generate` | `pages/api/accounting/afs/generate.ts` |

**Steps:**

- [ ] Confirm each route's exact path via grep (file names may differ — use the operation intent, not the path guess).
- [ ] Wrap: `export default withAuth(withErrorHandler(withFlowMeter('invoice.create', getFlowCost('invoice.create'))(handler)))`.
- [ ] For each wrapped route, add one Vitest unit test that mocks the wallet and asserts the handler is called for non-PAYG companies without a debit.
- [ ] Add a smoke test at `tests/integration/api/flow-metering-smoke.int.test.ts` that: (1) creates a PAYG company with 10 Flows, (2) calls `invoice.create` (cost 3) — asserts 200 + balance 7, (3) calls again 3× — asserts balance 1, (4) 4th call returns 402.

**Success:** every wrapped route charges correctly; non-PAYG tenants see zero behaviour change.

---

## Task 8: Dashboard widget, wallet page, top-up modal, nudge banner

**Files:**
- `src/components/billing/FlowWalletWidget.tsx`, `TopUpModal.tsx`, `UpgradeNudgeBanner.tsx` *(new)*
- `pages/accounting/settings/billing/flows.tsx` *(new)*
- `pages/accounting/dashboard.tsx` *(modify)*
- `src/components/layout/accountingNavConfig.ts` *(modify — add Flows nav item, PAYG-only)*

**Steps:**

- [ ] `FlowWalletWidget` reads `/api/billing/flows/wallet` via `apiFetch`. Renders balance in large text, nudge pill, "Top up" button opening `TopUpModal`. Hidden when plan ≠ `'payg'`.
- [ ] `TopUpModal` loads `/api/billing/flows/bundles`, renders a 4-card grid (Micro/Small/Medium/Large), confirms → POST `/api/billing/flows/purchase`. Also the 402-interceptor target: a global `apiFetch` hook catches 402 responses and opens the modal automatically.
- [ ] `UpgradeNudgeBanner` takes the nudge level and renders the spec §6 copy + a "Compare plans" CTA linking to a new `/accounting/settings/billing/compare?against=starter` route (a thin page with side-by-side cost maths for this month). Compare route is a lightweight read-only page; no new APIs needed — reuses wallet + plans data.
- [ ] `pages/accounting/settings/billing/flows.tsx` — full wallet page: ledger table (paginated), bundle selector, auto-topup toggle + bundle picker, payment method placeholder (v1 shows "admin-recorded only").
- [ ] Mount the widget on the dashboard above the existing KPI cards when `plan === 'payg'`.
- [ ] Register nav item.

**Success:** a PAYG tenant sees their balance on every dashboard load, can top up in three clicks, and gets a clear upgrade nudge when they cross R180/month.

---

## Task 9: Monthly reset cron + 402 E2E

**Files:**
- `pages/api/cron/reset-flow-month.ts` *(new)*
- `scripts/isaflow-flow-month-reset.service` *(new)*
- `scripts/isaflow-flow-month-reset.timer` *(new)*
- `tests/e2e/payg-flows.spec.ts` *(new)*

**Steps:**

- [ ] Cron handler: gated by `CRON_SECRET` header, calls `flowWalletService.resetMonthlyCounter()`, returns `{ success, companiesReset }`.
- [ ] systemd timer fires `OnCalendar=*-*-01 00:05:00` SAST.
- [ ] E2E covers: buy bundle → create 3 invoices → assert balance + ledger + banner levels → exhaust balance → assert 402 → top-up modal appears → purchase → resume.

**Success:** cron fires in staging on first-of-month; E2E runs green locally and against `app.isaflow.co.za` after deploy.

---

## Task 10: Deploy + enable for pilot company

**Files:** none — runbook only.

**Steps:**

- [ ] `bun run test:unit` + `bunx tsc --noEmit` green.
- [ ] Full regression: `tests/e2e/payg-flows.spec.ts` + existing PRD-05 / PRD-06 smoke suites.
- [ ] Deploy after 17:00 SAST via `scripts/deploy.sh` — migration 437 applies as part of the script.
- [ ] Install the systemd timer on velo (`/etc/systemd/system/isaflow-flow-month-reset.{service,timer}` → `systemctl daemon-reload && systemctl enable --now isaflow-flow-month-reset.timer`).
- [ ] Admin-flag one internal test company as `payg_eligible = true`, move it to the `payg` plan, seed 100 Flows via admin adjust, run through the full tenant flow once.
- [ ] Write handoff `docs/prd/PRD-PAYG-phase1-handoff.md` — shipped scope, metered routes, next-up routes to wrap, Stitch gateway as v2.

**Success:** one live PAYG company billing correctly against the ledger; no cross-tenant leakage in a spot-check (`SELECT DISTINCT company_id FROM flow_ledger WHERE created_at > NOW() - INTERVAL '1 day'` returns only the pilot).

---

## Open questions (flag before Task 1 if unresolved)

1. **Payment gateway timing.** Spec §10 marks gateway out of scope for v1. Confirm v1 ships admin-recorded only and Stitch integration comes later as its own plan.
2. **Plan switching semantics.** When a Starter customer opts down to PAYG mid-month, do we pro-rate the Starter invoice or honour it in full? Spec is silent — propose: honour in full, PAYG starts next cycle.
3. **Refund policy on multi-step operations.** `afs.generate` (50 Flows) is expensive — if it partially succeeds and then fails, do we refund full or partial? Propose: full refund on any terminal failure; no partial refunds in v1.
4. **Nudge thresholds after top-up.** If a user tops up mid-month, do they see a yellow banner because `month_flows_used` is already high? Propose: yes — the nudge reflects usage, not balance, by design.

Resolve 1-3 in review before starting Task 1; #4 can ship as-proposed.
