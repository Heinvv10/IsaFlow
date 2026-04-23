# Handoff — PRD-06 Phase 3 (Dispute Workflow)

**From session:** PRD-06 Phase 2 shipped (commits `601d92d`, `cbf83f4`, `6338fb5`, deployed to `app.isaflow.co.za` 2026-04-23 15:32 SAST, /api/health 200).
**Target (this session):** PRD-06 Phase 3 — Dispute Workflow (1.5 weeks, P0).

---

## Ship status — done

- **Commit `17da03e`** — Phase 3 core (16 files, +1973/−5).
- **Commit `6a00bd4`** — follow-up fix: `users.id` is `VARCHAR(255)` not UUID; mig 428 + service update paths corrected.
- Migration `428_ar_customer_invoice_disputes.sql` applied to prod 2026-04-23 16:50 SAST.
- Deployed to `app.isaflow.co.za`, service active since 16:50:07 SAST, `/api/health` = 200.
- Unit tests: **3171/3171 green** (3156 → +15 dispute).
- `bunx tsc --noEmit` clean.
- E2E against prod: **Phase 3 2/2**, PRD-05 + Phase 2 regression clean.
- Next migration number: **429**.

## Open design decisions (Hein, 2026-04-23)

1. **Timeboxing** → any unpaid invoice (`status ∈ {sent, approved, partially_paid, overdue}` AND `deleted_at IS NULL`). No N-day cutoff.
2. **Partial-line vs whole-invoice UX** → unified "Dispute" button on the portal opens a modal with an optional per-line checkbox picker. Blank selection = whole-invoice dispute (null `customer_invoice_line_id`). DDL allows both.
3. **Credit-note auto-creation** → user-choice per dispute at resolve-time. Modes: `resolve_with_credit` (auto-creates customer credit note for `disputed_amount`), `resolve_no_credit` (amount re-ages into overdue), `rejected`, `withdrawn`.

## What Phase 3 shipped

| File | Purpose |
|---|---|
| `scripts/migrations/sql/428_ar_customer_invoice_disputes.sql` | `customer_invoice_disputes` table + partial unique indexes (one OPEN per invoice/line) + `resolved_by VARCHAR(255)`. |
| `src/modules/accounting/services/ar/disputeService.ts` | `raiseDispute`, `listDisputes`, `getDispute`, `resolveDispute` (3 modes), `withdrawDispute`, `getOpenDisputeTotals`. |
| `pages/api/portal/invoice/[token]/dispute.ts` | Anonymous POST, rate-limited 10/min/IP, verifies token, enforces eligible status, logs IP + UA on the row. |
| `pages/api/accounting/ar/disputes/*` | Internal list/create, get, resolve, withdraw — all `withAuth + withWriteAccess`. |
| `src/modules/accounting/services/ar/arAgingService.ts` | Joins open-dispute totals per invoice before bucketing. |
| `src/modules/accounting/types/ap.types.ts` | `AgingBucket.disputed?`, `AgingInvoice.disputedAmount?` (optional; AP unaffected). |
| `src/modules/accounting/utils/aging.ts` | `calculateAgingBuckets` subtracts disputed portion from overdue buckets, tracks per-entity `disputed` sum. |
| `pages/accounting/disputes/index.tsx` | Dispute queue UI with status filter + resolve modal (3 modes + withdraw). |
| `src/components/accounting/navSections/sales.ts` | Nav entry under **Sales → Reports**. |
| `pages/api/portal/invoice/[token].ts` | GET now returns `items[].id` so the dispute line picker has IDs. |
| `pages/portal/invoice/[token].tsx` | "Dispute this invoice" button + `DisputeModal` with per-line checkboxes + editable amount. |
| `tests/unit/services/ar/disputeService.test.ts` | 15 tests (raise, list, get, resolve × 3 modes, withdraw, totals). |
| `tests/e2e/prd06-phase3-disputes.spec.ts` | Full flow: portal raise → internal list → duplicate 409 → resolve → re-raise → cleanup. |

**Exit criteria (from PRD §7.2 Phase 3) — met:**
customer disputes a line via portal; AR aging immediately excludes it from "overdue" (moves to `disputed` bucket); resolving either re-ages (no-credit / rejected) or auto-creates a credit note.

## Architectural notes (carry forward)

- **Only one OPEN dispute per (invoice, line)** — enforced by two partial unique indexes (whole-invoice + line-level). Resolved rows stay as history; re-raise inserts a fresh row.
- **Unique-violation (23505) surface** — `raiseDispute` catches `code=23505` and rethrows as `"There is already an open dispute …"`; both portal and internal endpoint map that to **409** with `code: DISPUTE_EXISTS`.
- **Credit note linkage is an id, not an FK** — `customer_invoice_disputes.credit_note_id` is a plain UUID with a comment, not `REFERENCES credit_notes(id)`. Keeps migration order flexible; the service sets it transactionally.
- **Aging contract change** — when the tenant has open disputes, AR aging `total` is now "outstanding *excluding* disputed." `disputed` carries the disputed sum separately. Callers that want the legacy all-in total should compute `total + disputed`. AP aging is unchanged (no `disputedAmount` populated).
- **Portal UX** — dispute modal defaults `disputedAmount` to the sum of selected lines (or the full balance). User can override. Server still validates `disputedAmount <= outstanding + 0.01`.
- **Session mapping** — `raised_by` for portal disputes = `customer:<sha256(token)>`, matching `customer_invoice_views.session_token`. Never stores the raw token.
- **IP + UA log-only** — captured on the dispute row for future fraud-score; never used to reject a dispute.

## What's next

1. **Phase 4 — Receipt Auto-Match** (1.5 weeks, `P1`). PRD §4.4 + §7.2 Phase 4. Next mig = **429**. DDL extends `bank_match_candidates` with `portal_view_boost`, `payment_reference_exact`, `payment_reference_partial` + a reference↔invoice index. Scoped service: `receiptMatchService` (exact-reference > partial-reference + portal-view > amount + date). Exit: incoming payment with an INV-* reference auto-allocates without human intervention on a demo company.
2. **Dispute-queue UX polish** — current queue is functional but minimal (no per-customer filter, no search, no date range). Sage/Xero parity will want these. Defer until bookkeeper feedback; not blocking.
3. **Portal "My disputes" view** — out of Phase 3 scope. Portal currently shows a one-shot "Dispute received" toast after submit; no way for the customer to see status later. Phase 7 (payment rail) is the natural time to add portal-side dispute tracking.
4. **Auto-refresh prod E2E session** (carried over from Phase 2 handoff) — still manual; wire `prod-auth-refresh.spec.ts` into `playwright-prod.config.ts` as a `globalSetup` before Phase 4.

## Open questions (Hein to resolve before Phase 4)

1. **Payment reference parser** — Phase 4 needs a robust extractor for `INV-*` patterns in bank transaction references. Do we trust Sage's existing `transaction_reference` normalisation, or roll our own for cross-import consistency (incl. PDF statements)?
2. **Portal-view boost window** — PRD §4.4 says "+0.1 if viewed in last 30d". Is 30 days the right default, or do we want per-company tuning?
3. **Partial-reference threshold** — what counts as a partial hit (substring match, Levenshtein ≤ 2, trigram similarity)? Cheapest + most robust is trigram + threshold 0.4.

## Git state

- **Uncommitted:** clean
- **Unpushed:** none (`17da03e`, `6a00bd4` both on `origin/master`)
- **Stashes:** 6 pre-existing (unchanged this session)

## Where to resume

Read this file, then `docs/prd/PRD-06-ar-evidence-capture.md` §4.4 + §7.2 "Phase 4". First code task: `scripts/migrations/sql/429_ar_bank_match_candidates_ar_signals.sql`. Entry command for the next session:

```
continue PRD-06 Phase 4 — receipt auto-match.
Start by reading docs/prd/PRD-06-phase3-handoff.md, then
docs/prd/PRD-06-ar-evidence-capture.md §4.4 + §7.2 Phase 4.
Next migration number is 429.
```
