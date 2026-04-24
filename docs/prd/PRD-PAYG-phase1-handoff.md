# PAYG Flows — Phase 1 Handoff

**Date shipped to dev:** 2026-04-24
**Status:** Local dev green (mig 437 applied, 74 unit tests, `tsc --noEmit` clean).
**Spec:** `docs/superpowers/specs/2026-04-19-payg-flows-pricing-design.md`
**Plan:**  `docs/superpowers/plans/2026-04-24-payg-flows-implementation.md`

---

## What got built

### Migration 437 — applied to local dev ✓
- `payg` row in `plans` (`monthly_price_cents = 0`, `display_order = 0`)
- `companies.payg_eligible boolean` + `companies.annual_turnover_cents bigint`
- `flow_bundles` — seeded with Micro (100/R10), Small (500/R50), Medium (1500/R150), Large (2500/R250)
- `flow_wallet` — per-PAYG-company row
- `flow_ledger` — append-only audit log (trigger blocks UPDATE / DELETE)
- `flow_purchases` — payment records (v1: admin-recorded only)
- RLS policies on all four new tables, mirroring the tenant-isolation pattern from mig 348

### Services
- `src/modules/billing/services/flowOperationCatalog.ts` — 15 operations across 4 tiers
- `src/modules/billing/services/flowWalletService.ts` — atomic purchase / deduct / refund / admin-adjust / auto-topup / nudge / monthly-reset (420 LOC, 30 unit tests)
- `src/modules/onboarding/services/paygEligibilityService.ts` — volume / turnover / admin-flag gates (8 unit tests)

### Metering middleware
- `src/lib/billing/withFlowMeter.ts` — debits BEFORE handler, refunds on throw or 4xx/5xx, fires nudge recalc on success (9 unit tests)
- `src/lib/apiResponse.ts` + `.types.ts` — new `paymentRequired()` helper + `PAYMENT_REQUIRED` error code → HTTP 402

### Customer API — `/api/billing/flows/*`
- `GET wallet` — balance + nudge + month usage
- `GET bundles` — active bundles
- `POST purchase` — v1 admin-recorded purchase (csrf-gated)
- `PATCH auto-topup` — toggle + bundle selection
- `GET ledger` — cursor-paginated ledger

### Admin API — `/api/admin/billing/*`
- `GET payg/companies` — tenants on PAYG with month spend + nudge
- `GET payg/[companyId]/wallet` — wallet + ledger drill-through
- `POST payg/[companyId]/adjust` — signed credit/debit with audit log
- `POST payg/[companyId]/eligibility` — toggle `companies.payg_eligible`
- `GET|POST flow-bundles` — CRUD
- `GET|PATCH|DELETE flow-bundles/[id]` — soft-delete on DELETE

### Admin UI
- `pages/admin/billing/payg.tsx` — companies list with nudge pills + inline adjust
- `pages/admin/billing/flow-bundles.tsx` — bundle CRUD grid
- `pages/admin/billing/index.tsx` — added "PAYG Tenants" and "Flow Bundles" quick-link tiles

### Tenant UI
- `src/components/billing/FlowWalletWidget.tsx` — dashboard widget (hidden for non-PAYG via 403)
- `src/components/billing/TopUpModal.tsx` — bundle grid + purchase
- `src/components/billing/UpgradeNudgeBanner.tsx` — yellow/orange/red banners per spec §6
- `pages/accounting/settings/billing/flows.tsx` — full wallet page with ledger

### Wrapped metered handlers (4 of 12 — phase-1 scope)
One per tier:

| Operation | File | Tier |
|---|---|---|
| `bank.import` | `pages/api/accounting/bank-transactions-import.ts` | 1 Flow / basic |
| `invoice.create` | `pages/api/accounting/customer-invoices-create.ts` | 3 Flows / standard |
| `report.tb` | `pages/api/accounting/reports-trial-balance.ts` | 10 Flows / advanced |
| `afs.generate` | `pages/api/accounting/afs/generate-pack.ts` | 50 Flows / premium |

### Cron
- `pages/api/cron/reset-flow-month.ts` — monthly reset endpoint (CRON_SECRET-gated)
- `scripts/isaflow-flow-month-reset.{service,timer}` — systemd units, fires 1st of each month @ 00:05 SAST

### E2E
- `tests/e2e/payg-flows.spec.ts` — buy → burn → verify ledger smoke test (skips when active company is not on PAYG)

---

## What's left before prod

### Deferred to Phase 2
1. **Wrap the remaining 8 metered handlers** — supplier bills, payments, journals, P&L, BS, AR/AP aging, VAT return, year-end close. Each one needs compose-order review (withFlowMeter must sit inside withWriteAccess so viewers don't get charged for a 403).
2. **Stitch payment gateway integration** — v1 is admin-recorded only; `triggerAutoTopup` returns `no_payment_method` until Stitch is wired in. Spec §10 lists this as a v2 concern.
3. **Compare-plans page** — `/accounting/settings/billing/compare` linked from the nudge banner but not yet implemented. Thin read-only page showing Flows month-to-date vs Starter flat fee.
4. **Signup PAYG option** — spec §3 mentions self-declared turnover on signup. Waitlist replaced public signup (`0e2ae93`), so this hook point has moved. Needs a small addition to the waitlist→onboarding handoff.

### Deploy runbook (run when ready)
1. `bun run test:unit` — expect 74+ new tests passing alongside existing suite
2. `bunx tsc --noEmit` — clean modulo one pre-existing `pages/bureau/index.tsx` error unrelated to this work
3. After 17:00 SAST (business-hours gate) and with Hein's approval:
   - `bash scripts/deploy.sh` — migration 437 applies as step 2 of the deploy script
4. Install systemd units on velo:
   ```bash
   sudo cp scripts/isaflow-flow-month-reset.{service,timer} /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now isaflow-flow-month-reset.timer
   systemctl list-timers | grep flow-month-reset
   ```
5. Onboard pilot company:
   - Admin UI → select test company → move to `payg` plan → flag `payg_eligible=true`
   - Admin UI → Billing > PAYG Tenants → Adjust +100 Flows (reason: "pilot seed")
   - Sign in as pilot tenant → `/accounting/settings/billing/flows` → verify balance 100
   - Create an invoice → verify ledger shows `-3 invoice.create` debit + balance 97
6. Spot-check cross-tenant isolation:
   ```sql
   SELECT DISTINCT company_id FROM flow_ledger WHERE created_at > now() - INTERVAL '1 day';
   ```
   Should return only the pilot company.

### Open design questions (from the plan doc)
1. **Gateway timing.** Confirmed: v1 admin-recorded only.
2. **Plan-switch pro-rating** — Starter → PAYG mid-month. Proposal: honour Starter invoice in full, PAYG begins next cycle.
3. **Multi-step refund policy** — `afs.generate` partial failure. Proposal: full refund on any terminal failure; no partial refunds in v1.
4. **Nudge after topup** — yes, nudge reflects usage not balance, by design.

Proposals in #2 and #3 are live in the code as implemented; flag if you want them changed before prod.

---

## Git state
- Branch: master
- All new files untracked; modified files are the 4 metered handlers + apiResponse + admin billing index
- No commits yet — ready for a single `feat(payg): phase 1 — wallet, metering, admin + tenant surfaces` commit once reviewed
