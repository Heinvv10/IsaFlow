# Handoff — PRD-06 Phase 4 (Receipt Auto-Match)

**From session:** PRD-06 Phase 3 shipped + deployed (commit `020968c`, `/api/health` 200 on 2026-04-23 16:50 SAST).
**Target (this session):** PRD-06 Phase 4 — Receipt Auto-Match (1.5 weeks, P1).

---

## Ship status — code complete, not yet pushed / deployed

- **Commit `0c2b0fa`** — Phase 4 (10 files, +1324/−2). **Local only — not yet pushed to `origin/master`.**
- Migration `430_ar_receipt_match_signals.sql` — written, **not yet applied to prod** (runs automatically on `bash scripts/deploy.sh`).
- Unit tests: **3200/3200 green** (3171 Phase 3 baseline → +13 Phase 4 + 16 from a parallel Stitch agent).
- `bunx tsc --noEmit`: clean.
- E2E spec: written, not yet executed against prod.
- Next migration number: **431** (429 is reserved by the parallel Stitch agent, 430 = this Phase 4).

## Pending actions (Hein to run)

1. `git push origin master` — push `0c2b0fa`.
2. `bash scripts/deploy.sh` — migrates the prod DB (pg_trgm extension + trigram index) then deploys. Outside the 08:00–17:00 SAST business-hours gate before running.
3. `bunx playwright test tests/e2e/prd06-phase4-receipt-match.spec.ts --config=playwright-prod.config.ts` — verify the shortlist endpoint against prod data.

## Parallel agent note — Stitch

Another agent is building Stitch Money integration on migration **429** (subscription mandates + portal invoice pay-in). That work is entirely uncommitted at the time of this handoff (20+ untracked files including `.env.example` / `pages/admin/billing/index.tsx` / `pages/portal/pay/[token].tsx`). **Phase 4 intentionally does not touch any of those files.** `git status` after `0c2b0fa`:

```
 M .env.example                         (Stitch — untouched)
 M pages/admin/billing/index.tsx        (Stitch — untouched)
 M pages/portal/pay/[token].tsx         (Stitch — untouched)
?? pages/accounting/payments/stitch/…   (Stitch — untouched)
?? pages/api/…/stitch/…                 (Stitch — untouched)
?? scripts/migrations/sql/429_stitch_payments.sql  (Stitch — untouched)
?? src/modules/billing/services/…       (Stitch — untouched)
?? tests/unit/services/billing/…        (Stitch — untouched)
```

When merging the two streams, Stitch keeps mig 429 and Phase 4 keeps mig 430 — numeric ordering is preserved.

## Open design decision taken — `bank_match_candidates` is NOT a table

PRD §4.4 originally proposed extending a `bank_match_candidates` TABLE with `portal_view_boost`, `payment_reference_exact`, `payment_reference_partial`. In this codebase `bank_match_candidates` is an **in-memory type** (see `src/modules/accounting/types/bank-match.types.ts`) produced per-request by `bankMatchCandidatesService`, not a persisted table. Phase 4 therefore:

- Adds the signals to the `MatchCandidate` TypeScript type via a new optional `signals: ReceiptMatchSignals` field.
- Keeps the on-disk change to migration 430 minimal: just `pg_trgm` + the trigram GIN index on `customer_invoices.invoice_number`.

## What Phase 4 shipped

| File | Purpose |
|---|---|
| `scripts/migrations/sql/430_ar_receipt_match_signals.sql` | `CREATE EXTENSION pg_trgm` + partial trigram GIN index `idx_customer_invoices_invoice_number_trgm` on open invoices. |
| `src/modules/accounting/types/bank-match.types.ts` | New `ReceiptMatchSignals` type + optional `MatchCandidate.signals` for AR-specific score breakdown. |
| `src/modules/accounting/services/ar/receiptMatchService.ts` | `getReceiptMatchCandidates` (top-5 scored shortlist) + `confirmReceiptMatch` (posts GL + allocates invoice). |
| `src/modules/accounting/services/bank/bankMatchCandidatesService.ts` | `getMatchCandidates` delegates to `receiptMatchService` for receipts; falls back to legacy customer-invoice fetcher only when the scored list is empty. Non-AR paths unchanged. |
| `pages/api/accounting/ar/receipt-match/[bankTxId].ts` | `GET` top-5 scored candidates + bank-tx shape. `withAuth + withWriteAccess + withErrorHandler`. |
| `pages/api/accounting/ar/receipt-match/confirm.ts` | `POST { bankTxId, customerInvoiceId, amount }` → allocation + invoice bump. |
| `pages/accounting/ar/receipt-match/index.tsx` | Queue UI — unmatched receipts, confidence bar, score-breakdown chips, one-click Confirm, "X more candidates" details. |
| `src/components/accounting/navSections/sales.ts` | **Sales → Transactions → Receipt Auto-Match** nav entry. |
| `tests/unit/services/ar/receiptMatchService.test.ts` | 13 unit tests (scoring, guards, confirm flow, withTransaction shared-mock pattern). |
| `tests/e2e/prd06-phase4-receipt-match.spec.ts` | 3 e2e: shortlist shape, non-receipt 400 guard, confirm-body validation. |

## Scoring model (receiptMatchService)

```
exact reference (invoice_number verbatim hit in description/ref)  +40
partial reference (trigram similarity ≥ 0.4)                      +20
portal-view boost (any view in last 30 days)                      +10
amount delta (scoreAmount — 0/<0.01/<1/<10/<100/<1000)           0–50
date delta (scoreDate — same-day through >60d)                   0–30
description overlap (scoreDescription word overlap)              0–20
-----------------------------------------------------------------------
max ≈ 170; ≥100 = high-confidence auto-match lane
```

Exact-ref and partial-ref are **mutually exclusive** (exact wins). Trigram similarity lookup is SQL-indexed via `idx_customer_invoices_invoice_number_trgm`. Candidate pool capped at 50 invoices (`ORDER BY |balance - tx_amount| ASC LIMIT 50`), narrowed by extracted customer-name match when the bank description carries one. Top-5 returned.

## Architectural notes (carry forward)

- **Circular import (benign):** `receiptMatchService` imports helpers from `bankMatchCandidatesService` (score* functions, extract* helpers, `fetchBankTransaction`), and `bankMatchCandidatesService` imports `getReceiptMatchCandidates` back. All symbols are functions initialised at module-eval time, so TS handles it fine. Don't convert either to top-level constants without checking.
- **`confirmReceiptMatch` wraps `bankAllocationService.allocateTransaction`** (allocType='customer') — not duplicating the GL posting. Then it inserts the `customer_payment_allocations` row and bumps `customer_invoices.amount_paid` / status atomically via `withTransaction`. `allocateTransaction` itself already created the `customer_payments` row in 'confirmed' status with the journal id.
- **Outstanding-balance guard** is in `confirmReceiptMatch`: rejects `amount > (total_amount - amount_paid) + 0.01`. Matches the behaviour of `customerPaymentService.createCustomerPayment`.
- **UI Confirm button** sends `amount = min(tx.amount, candidate.amount)` — so a receipt that exceeds the invoice only pays down the invoice, leaving the rest of the bank tx for a split allocation (out of Phase 4 scope).
- **Bank-tx status flip** is handled by `allocateTransaction` (sets status='allocated'). The receipt disappears from the Phase 4 queue on next page load.
- **Legacy fallback path:** if `getReceiptMatchCandidates` returns zero (no open invoices pass amount/date/ref/portal-view filters), `getMatchCandidates` falls back to `fetchCustomerInvoiceCandidates`. Keeps existing bank-rec UX functional for receipts that have no modern signal.

## Open questions (Hein to resolve before Phase 5)

1. **Auto-match threshold** — current UI shows every top candidate. Should we auto-allocate without user action when `score ≥ 120` and the second candidate is `< score − 30`? PRD exit criteria says "≥95% auto-match," which implies zero-click for the high-confidence lane.
2. **Split receipts** — if a single bank tx pays two invoices (combo sum), Phase 4 doesn't handle it; the legacy `findInvoiceCombos` in `bankMatchCandidatesService` does but is bypassed in the scored path. Worth wiring back into the shortlist for Phase 5+.
3. **Partial payments** — current UI locks the Confirm amount to `min(tx, balance)`. Do we want a "custom amount" modal so operators can split one tx across two invoices manually? Current answer: no (Phase 7 pay-rail will cover this).

## Git state

- **Uncommitted:** 3 Stitch files (`.env.example`, `pages/admin/billing/index.tsx`, `pages/portal/pay/[token].tsx`) + 20+ untracked Stitch files — **all owned by the parallel Stitch agent, do not touch.**
- **Unpushed:** `0c2b0fa` (this commit) on local `master` only.
- **Stashes:** 6 pre-existing (unchanged this session).

## Where to resume

1. Hein pushes + deploys (see "Pending actions" above).
2. Run the E2E spec against prod.
3. If the Stitch agent's 429 has landed by then, rebase cleanly — no file overlap expected.
4. Next code task — **Phase 5 (Dunning Engine)** (PRD §7.2 Phase 5, 2 weeks, P1). Migrations start at **431**. Needs `dunning_templates`, `dunning_sends`, daily cron for template ladder, response-inbox webhook.

Entry command for the next session:

```
continue PRD-06 Phase 5 — dunning engine.
Start by reading docs/prd/PRD-06-phase4-handoff.md, then
docs/prd/PRD-06-ar-evidence-capture.md §4.6 + §7.2 Phase 5.
Next migration number is 431.
```
