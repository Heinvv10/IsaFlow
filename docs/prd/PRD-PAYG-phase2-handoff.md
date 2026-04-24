# PAYG Flows — Phase 2 Handoff

**Date:** 2026-04-24
**Status:** Local dev green — mig 444 + 445 applied, 3326 unit tests pass, `tsc --noEmit` clean.
**Previous:** `docs/prd/PRD-PAYG-phase1-handoff.md`
**Spec:** `docs/superpowers/specs/2026-04-19-payg-flows-pricing-design.md`

---

## What shipped (all four deferred items from phase 1)

### 1. Wrapped the remaining metered handlers (8 codes, 9 files)

| Operation | Route | Tier |
|---|---|---|
| `supplier.bill.create` | `pages/api/accounting/supplier-invoices.ts` | 3 Flows |
| `payment.record` | `pages/api/accounting/customer-payments.ts` | 3 Flows |
| `payment.record` | `pages/api/accounting/supplier-payments.ts` | 3 Flows |
| `journal.create` | `pages/api/accounting/journal-entries.ts` | 3 Flows |
| `report.pnl` | `pages/api/accounting/reports-income-statement.ts` | 10 Flows |
| `report.bs` | `pages/api/accounting/reports-balance-sheet.ts` | 10 Flows |
| `report.age` | `pages/api/accounting/reports-ar-aging.ts` | 10 Flows |
| `report.age` | `pages/api/accounting/reports-ap-aging.ts` | 10 Flows |
| `vat.return` | `pages/api/accounting/reports-vat-return.ts` | 10 Flows |
| `yearend.close` | `pages/api/accounting/year-end.ts` | 10 Flows |

Mixed-method handlers (GET + POST) were refactored with a mux pattern so
`withFlowMeter` wraps only the mutating POST branch; GET still passes
through `withWriteAccess` untouched (reads are free).

New test: `tests/unit/lib/billing/meter-wrap-registry.test.ts` — static
assertion that every wired operation code appears in the expected route
file. Catches accidental unwraps in future refactors.

### 2. Compare-plans page

- `pages/accounting/settings/billing/compare.tsx` — side-by-side PAYG
  month-to-date + projection vs target subscription plan
- `pages/api/billing/plans.ts` — new tenant-facing read-only plan catalog
  (reuses admin `listPlans`; no new queries)
- Nudge banner CTA at `/accounting/settings/billing/compare?against=starter`
  now lands on a real page (was 404)

### 3. Waitlist → onboarding PAYG hook

- Migration 444 — `waitlist_signups.annual_turnover_cents BIGINT NULL`
- `src/components/landing/WaitlistForm.tsx` — optional turnover input for
  direct (non-bureau) signups with live PAYG hint when under R1M
- `pages/api/waitlist.ts` — accepts `annualTurnover` (whole rand) or
  `annualTurnoverCents` (raw cents); notification email surfaces PAYG
  eligibility hint
- `src/modules/onboarding/services/waitlistPromotionService.ts` — pure
  `buildCompanySeed(signup)` that produces the
  `{ name, annualTurnoverCents, paygEligible, suggestedPlanCode }` payload
  for whoever builds the promotion path. Never auto-suggests PAYG for
  bureau signups.
- Tests: `tests/unit/services/onboarding/waitlistPromotionService.test.ts`
  — 6 assertions covering the threshold, null turnover, bureau carve-out,
  and name fallbacks

### 4. Stitch gateway integration for Flow top-ups

- Migration 445 — extends `stitch_payment_requests.purpose` to allow
  `'flow_bundle'`, adds `flow_purchase_id UUID` FK with matching CHECK
- `flowWalletService` gained three new exports:
  - `startBundlePurchase(companyId, bundleId, opts)` — pending row, no
    wallet mutation
  - `completeBundlePurchase(purchaseId)` — idempotent credit + ledger
    (webhook re-deliveries land on already-succeeded rows and no-op)
  - `failBundlePurchase(purchaseId, reason)` — pending → failed (idempotent)
  - `getPurchaseStatus(companyId, purchaseId)` — read for the return page
  - Existing `purchaseBundle` kept as a start+complete wrapper for the
    admin-recorded path and synchronous auto-topup
- `pages/api/billing/flows/purchase.ts` — two modes:
  - Stitch configured → creates pending row + payment-link + persists a
    `stitch_payment_requests` row with `purpose='flow_bundle'`; returns
    `{ checkoutUrl, purchaseId, mode: 'stitch_payment_link' }`
  - Stitch missing → falls back to admin-recorded (dev / pilot)
- `pages/api/webhooks/stitch.ts` — handles `payment.paid` for the new
  purpose (calls `completeBundlePurchase`) and adds
  `payment.failed` / `payment.cancelled` / `payment.expired` branches
  that fail the pending row
- `pages/api/billing/flows/purchase-status.ts` — GET endpoint polled by
  the return landing
- `pages/accounting/settings/billing/flows/return.tsx` — post-Stitch
  landing: polls every 2s for up to 60s, then shows success / failure /
  timeout
- `src/components/billing/TopUpModal.tsx` — redirects to `checkoutUrl`
  when the API returns Stitch mode; otherwise refreshes the wallet view
  as before

---

## Test inventory

| Area | Before | Added | After |
|---|---|---|---|
| withFlowMeter middleware | 9 | 0 | 9 |
| Meter wrap registry (static) | 0 | 14 | 14 |
| flowWalletService | 30 | 11 | 41 |
| waitlistPromotionService | 0 | 6 | 6 |
| Total | 3297 | +29 | 3326 (3 skipped) |

`bunx tsc --noEmit` clean. `bunx vitest run` 3326 passed / 3 skipped.

---

## Deploy runbook

**Before deploy**
- `bun run test:unit` — should be 3326 pass / 3 skip
- `bunx tsc --noEmit` — clean
- E2E smoke: `tests/e2e/payg-flows.spec.ts` still green (needs a PAYG
  company; skipped otherwise)

**After 17:00 SAST with Hein's approval**

1. `bash scripts/deploy.sh`
   - Applies migrations 444 (waitlist turnover) and 445 (flow-bundle Stitch wiring)
2. Stitch merchant dashboard → Webhooks → ensure
   `https://app.isaflow.co.za/api/webhooks/stitch` subscribes to
   `payment.paid`, `payment.settled`, `payment.failed`, `payment.cancelled`,
   `payment.expired`. Secret env var `STITCH_WEBHOOK_SECRET` already set.
3. Ensure `NEXT_PUBLIC_APP_URL=https://app.isaflow.co.za` is set on the
   server (used by the return-URL builder). Already in prod env.
4. Pilot run:
   - Admin → select test PAYG company → Billing → verify flows page
   - Tenant → `/accounting/settings/billing/flows` → Top up → pick Micro
   - Expect redirect to Stitch checkout → complete a R10 sandbox payment
   - Return lands on `/accounting/settings/billing/flows/return?ref=<id>`
   - After ~2s the page should flip to "Payment confirmed"
   - Re-open wallet — balance increased by 100, ledger shows `purchase`
     row
5. Cross-tenant isolation spot-check (same as phase 1):
   ```sql
   SELECT DISTINCT company_id FROM flow_ledger
    WHERE created_at > now() - INTERVAL '1 day';
   ```

---

## Follow-ups (out of Phase 2 scope)

1. **Auto top-up via Stitch** — currently auto-topup still fails with
   `no_payment_method` because Stitch Express recurring/mandate access
   isn't provisioned on our tenant. Once `client_recurringpaymentconsentrequest`
   is enabled, wire `triggerAutoTopup` to charge via the stored mandate
   (existing stub at `stitchClient.debitFromMandate`).
2. **bank.allocate, compliance.export, audit.export** — three catalog
   entries still in `WIRED.*: null` in the wrap-registry test. Wrap when
   those routes are added or audited.
3. **Promotion path implementation** — `waitlistPromotionService.buildCompanySeed`
   is ready; the admin tool that actually calls it and inserts into
   `companies` when a waitlist lead is approved still needs building.
4. **Reconciliation cron** — currently no job sweeps `flow_purchases`
   rows stuck in `pending` (e.g. if the webhook is never delivered for
   an abandoned checkout). Add a daily sweep that calls Stitch
   `getPaymentStatus` for pending rows >24h old and transitions them.

---

## Git state

Untracked (Phase 2 additions):
- `scripts/migrations/sql/444_waitlist_turnover.sql`
- `scripts/migrations/sql/445_flow_stitch_payments.sql`
- `pages/api/billing/plans.ts`
- `pages/api/billing/flows/purchase-status.ts`
- `pages/accounting/settings/billing/compare.tsx`
- `pages/accounting/settings/billing/flows/return.tsx`
- `src/modules/onboarding/services/waitlistPromotionService.ts`
- `tests/unit/lib/billing/meter-wrap-registry.test.ts`
- `tests/unit/services/onboarding/waitlistPromotionService.test.ts`
- `docs/prd/PRD-PAYG-phase2-handoff.md` (this file)

Modified (Phase 2):
- `pages/api/billing/flows/purchase.ts` (Stitch mode)
- `pages/api/webhooks/stitch.ts` (flow_bundle + failure branches)
- `pages/api/waitlist.ts` (turnover capture)
- `pages/api/accounting/supplier-invoices.ts`, `customer-payments.ts`,
  `supplier-payments.ts`, `journal-entries.ts`,
  `reports-income-statement.ts`, `reports-balance-sheet.ts`,
  `reports-ar-aging.ts`, `reports-ap-aging.ts`,
  `reports-vat-return.ts`, `year-end.ts` (metering wraps)
- `src/components/landing/WaitlistForm.tsx` (turnover input)
- `src/components/billing/TopUpModal.tsx` (Stitch redirect)
- `src/modules/billing/services/flowWalletService.ts` (two-phase purchase)
- `tests/unit/services/billing/flowWalletService.test.ts` (purchase tests)

Ready for a single `feat(payg): phase 2 — metering coverage, Stitch
top-ups, compare page, signup turnover` commit once reviewed.
