# K-053 — aging and the AR/AP figures vs soft-deleted documents

**Trigger.** Soft-delete now reverses the document's approval journal. `reverseJournalEntry`
dates that reversal to TODAY whenever the document's own period is closed, so the control
account carries the document up to the delete and only then nets to zero. Any surface that
answers "is this document still in the ledger?" on a different clock — undated, or not at
all — disagrees with the GL at every as-at date in between.

**Before / after.** Before: the AR/AP figure surfaces either dropped a deleted document at
every date (`deleted_at IS NULL`) or carried it for ever (no predicate at all). After: each
asks `documentInLedgerAsAtFragment` at its OWN as-at date — the parity of the document's
reversal chain dated on or before that date — so it agrees with the control account, with
`arAgingService`/`apAgingService`, and with the close checklist, in both directions.

**Files.** 28 production files; see `fix-round7.md` for the census and the per-surface table,
`fix-round2.md`…`fix-round6.md` for the earlier rounds. Round 8 adds
`reconciliation/unappliedCashService.ts` and `reports/vatReconciliationService.ts`. Round 10
adds `reports/transactionReportingService.ts`, `pages/api/accounting/reports/sales-by-item.ts`
and the new `reconciliation/orphanReversalPairs.ts`.

**Tests.** `tests/integration/k053*.int.test.ts` — 17 files / 81 tests, real PostgreSQL
(round 10: +1 in `k053-figure-surfaces-tie-to-gl`, +1 in `k053-unapplied-cash-delete-reversal`,
which now performs a real delete/undo round trip).
New in round 8: `k053-unapplied-cash-delete-reversal` (H-1), `k053-afs-notes-tie-to-gl`,
`k053-group-and-integrity-tie-to-gl`, `k053-statement-recon-variance` (M-2) and
`k053-aging-route-vs-service-rewind` (LOW), plus four assertions added to
`k053-figure-surfaces-tie-to-gl`.
Mutation proof, re-run from scratch in round 10 over EVERY file that carries a soft-delete
predicate: the 36 fragment carriers (round 8's 34, plus `transactionReportingService` and
`sales-by-item`), the two files that carry the `soft_delete_journal_reversals` predicate
instead (`unappliedCashService`, `vatReconciliationService` — round 8 left both out of its
figure; the round-9 reviewer mutated them and both went RED), and `orphanReversalPairs`
(helper made the identity). Each was mutated by file copy, the whole k053 set run, and the
file restored from the copy: **39 files, 37 RED, 2 GREEN**. The round-8 figure
on the same basis is **34 RED / 2 GREEN over 36 files**. The two GREEN are still
`pages/api/portal/chat.ts` and `ar/portalService.ts` (R-055, see the per-file table below).
The five files this round depends on were each re-run on their own after the sweep, because
the sweep ran at load ~50: every one fails on an assertion off by exactly the deleted
document's value (R1,150 / R1,000), not on a timeout. Log:
`<scratchpad>/agents/fix-k053h/sweep.txt`.
Full unit suite with `DATABASE_URL` unset, plus tsc, eslint and `bun run ci`: recorded in
`fix-round8.md`.

**Migration / rollback.** Migration 653 (`soft_delete_journal_reversals`) from round 2;
no new migration in round 8 or round 10. Rollback is a revert of the branch; no data is written by these
changes, which are all read-side predicates.

**Historical data.** No repair is needed and none is possible: the predicate answers
correctly for every population, including documents deleted before this change whose journal
was never reversed (parity 1, kept, exactly as the GL keeps them). Read-only impact SQL —
how many soft-deleted documents have a standing (never-reversed) approval journal, i.e. how
many the fixed surfaces will now KEEP that the undated predicate was dropping:

```sql
SELECT count(*) FROM customer_invoices ci
WHERE ci.deleted_at IS NOT NULL AND ci.gl_journal_entry_id IS NOT NULL
  AND (SELECT count(*) FROM gl_journal_entries je
       WHERE je.company_id = ci.company_id AND je.status = 'posted'
         AND (je.id = ci.gl_journal_entry_id OR je.reversal_of_id = ci.gl_journal_entry_id)) % 2 = 1;
```

## Disposition of the round-6 review

- **HIGH-1 — census scoped to the wrong population.** FIXED. The census was redone from the
  tables (137 readers of `customer_invoices`/`supplier_invoices`), not from the predicate;
  24 queries across 17 files were fixed, including both `reports-ar-aging` and
  `reports-ap-aging` legs and the three statement surfaces the reviewer named. Every
  exclusion is named with its reason in `fix-round7.md`. The reviewer's reproduction (R1,150
  AR / R2,300 AP against a zero GL) is now a passing assertion in both directions.
- **LOW-1 — dunning comments state a false invariant.** FIXED. Both comments no longer appeal
  to aging; `dunningCronService` carries the full reasoning, `dunningService` points at it.
  The behaviour is unchanged and still deliberately undated.
- **LOW-2 — the opening-balance line can misstate its own date.** FIXED as documented: the
  cost is now stated at the constant in `customerLedgerService`, including what an honest
  fix would cost (a dated "document removed" contra row) and why that is not this item.
- **LOW-3 — incomplete over-cap disclosure.** FIXED, and the list is now measured rather than
  recalled. Every file this branch touches that exceeds 300 lines, production and test:
  `gl/journalEntryPostingService.ts` (359), `ap/supplierInvoiceWorkflowService.ts` (516),
  `ar/dunningService.ts` (357), `pages/accounting/customers/[customerId].tsx` (359),
  `src/lib/mcp/contracts/figures.ts` (357); tests `gl/periodCloseReadinessService.test.ts`
  (867), `afs/noteGenerators/notes1to10.test.ts` (369), `notes11to20.test.ts` (329),
  `cashFlowForecastService.test.ts` (369), `dashboardStatsService.test.ts` (327), and three
  k053 integration files (402/417/447). None of them grew: every change in them is a
  one-line predicate, mock key or comment. ONE file did grow past the cap —
  `reports/disclosureNoteGenerators.ts`, 300 → 301 — and the extra line is the import the
  fix needs; splitting a file already exactly at the cap is an adjacent refactor.
  `ar/debtorsManagerService.ts` (300) and `reports/consolidatedReportingService.ts` (299)
  were brought back under it by shortening the comments this round added.
- **LOW-4 — one unreproduced parallel-run failure.** Not reproduced here either: the k053
  integration set was run repeatedly, serial and parallel, on a shared fixture database and
  passed 12/12 (59 tests) both ways. Recorded, not scored.


## Disposition of the round-7 review

- **MEDIUM-2 — "reconciles every fixed surface" was not true.** FIXED, and the claim is
  corrected above. The reviewer's mutation showed 10 of 15 round-7 files could be reverted
  to the no-predicate form with all 59 tests still green. Round 8 re-ran that mutation over
  ALL 34 predicate-carrying files and closed every one that could be closed. Per file:

  | File | Reconciled by | Result |
  |---|---|---|
  | `reports/cashFlowForecastDataService.ts` | figure-surfaces (payable leg) | RED |
  | `reports/kpiChartsService.ts` | figure-surfaces (ageing chart) | RED |
  | `pages/.../reports/sales-by-customer.ts` | figure-surfaces (range report) | RED |
  | `pages/.../reports/purchases-by-supplier.ts` | figure-surfaces (range report) | RED |
  | `capture/supplierStatementReconDb.ts` | figure-surfaces (loader) | RED |
  | `afs/noteGenerators/notes6to10.ts` | afs-notes (note 10) | RED |
  | `afs/noteGenerators/notes16to20.ts` | afs-notes (note 16) | RED |
  | `reports/disclosureNoteGenerators.ts` | afs-notes (notes 3 and 4) | RED |
  | `reports/consolidatedReportingService.ts` | group-and-integrity (group dashboard) | RED |
  | `gl/integrityChecks/documentChecks.ts` | group-and-integrity (both checks) | RED |
  | `capture/supplierStatementReconService.ts` | statement-recon-variance | RED |
  | `pages/api/portal/chat.ts` | **not reconcilable** | GREEN |
  | `ar/portalService.ts` | **not reconcilable** | GREEN |

  The AFS and disclosure notes take no as-at parameter — their date is a FISCAL YEAR END
  resolved from `companies.financial_year_start` — so their fixture moves that column to
  put one year end before the delete's reversal and one on or after it. The integrity
  checks needed document shapes no other k053 fixture carries (a null due date; a posted
  invoice whose journal recognises no revenue). The statement-reconciliation variance sits
  behind a VLM extraction over stored PDF bytes: those two boundaries are mocked and
  nothing else is.

  **The two that cannot be reconciled, per file.** `pages/api/portal/chat.ts` and
  `ar/portalService.ts` both raise 42703 before the predicate is ever evaluated. Measured,
  not argued: driving `chat.ts` with a valid portal session on the fixture returns 500 with
  `column "amount" does not exist` — its fifth query reads `SELECT amount, payment_date FROM
  customer_payments`, and that table has `total_amount` and no `customer_id` either. The
  same line is on `master` (`git show master:pages/api/portal/chat.ts`, line 54), so this
  predates the branch and is not a soft-delete question. It is registered as R-055 and is
  deliberately NOT touched here. Until R-055 is fixed no test can reach either surface's
  figures, and this branch's claim does not cover them.

- **HIGH-1 — the delete's reversal became a phantom reconciling item.** FIXED in
  `reconciliation/unappliedCashService.ts`. Mechanism 2 reports every posted control
  movement no sub-ledger document references; the invoice deliberately keeps pointing at the
  ORIGINAL entry so the undo can find it, so the delete's reversal passed every `NOT EXISTS`
  and stood as a permanent orphan for the document's full gross value on BOTH reconcilers.
  The pair already nets to zero in the decomposition — `unpostedDocumentService` counts the
  deleted document AND its original journal, and the control account has moved by the same
  amount the sub-ledger dropped — so counting the reversal re-opened a gap both sides had
  closed. The fix reads `soft_delete_journal_reversals` (migration 653) via
  `idx_sdjr_reversal_entry`, which existed for exactly this query and had no reader.
  `unpostedDocumentService` is unchanged; that revert stands. Both directions are proved in
  `k053-unapplied-cash-delete-reversal.int.test.ts`, whose fixture carries the reversal AND
  a bare journal crediting the debtor with no document behind it: the bare journal is still
  reported, the reversal never is.

- **MEDIUM-1 — the VAT reconciliation.** FIXED in `reports/vatReconciliationService.ts`
  (three queries: the monthly GL leg, the monthly VAT-only leg, the multi-year summary). The
  invoice leg is deliberately undated — it keeps a deleted invoice in the month it was
  raised, which is what the document-based VAT201 did when that period was FILED — so
  counting the reversal on the GL leg compared a GL that had dropped the document against an
  invoice population and a `vat_return` that had not. Reproduced before the fix as
  `revenueVariance: 1000`, `effectiveVatRate: -15` and a "Revenue variance of R1 000,00"
  warning, with the reversal's −R150 output VAT reaching no VAT201 period; the revenue arm
  takes `ABS(credit - debit)`, so the reversal read as MORE revenue, not less. Asserted in
  `k053-figure-surfaces-tie-to-gl`.

- **LOW — the ageing routes' route-vs-service equality was decorative.** FIXED by seeding
  what the fixture lacked, in `k053-aging-route-vs-service-rewind.int.test.ts`: a document
  raised AFTER the as-at date and a payment settled after it, on both sides. The K-053 claim
  survives — route and service each carry the deleted document at the earlier date and each
  drop it at today, by exactly its own balance. The reviewer was right that the equality
  itself does not hold: `arAgingService`/`apAgingService` bound by `invoice_date <= as-at`
  and rewind `amount_paid` (`shared/agingRewind`), and neither route does either, so at an
  earlier as-at date the routes report `LATE - PAID` more than the services (R500 − R800 =
  −R300 on this fixture) on AR and on AP alike, and zero at today — which is why no earlier
  fixture could see it. That is a pre-existing defect in the two routes, not a soft-delete
  question; it is measured and named here as R-059 rather than silently fixed inside a
  soft-delete branch.

## Disposition of the round-9 review

- **MEDIUM-1 — `reports/transactionReportingService.ts` reported a balance with no
  soft-delete filter at all.** FIXED. `getCustomerReport` and `getSupplierReport` now carry
  `documentInLedgerAsAtFragment` at `periodEnd` on the invoice join, exactly as
  `sales-by-customer` / `purchases-by-supplier` do over the same columns and range. This
  reaches all four routes (`reports-customer`, `reports-supplier`, `customer-report-export`,
  `supplier-report-export`) because each calls the service. Asserted in
  `k053-figure-surfaces-tie-to-gl` ("the transaction reports and sales-by-item…"): the summed
  `balance` equals the control account at `AS_AT_BEFORE` (document carried) and at `TODAY`
  (document dropped), on AR and AP.

  **The classification gap, counted.** The round-7 census grep returns 137 files. 36 carry
  the fragment (after dropping the generated `.claude.md`/`AGENTS.md` mirrors); 21 more are
  named in round 7's exclusion bullets. That leaves **82 files the census walked and put in
  neither list.** Every one was re-checked this round, ranked by `SUM(`/`COUNT(` density:
  - 2 were in fact fixed in round 8 by the `soft_delete_journal_reversals` predicate rather
    than the fragment (`unappliedCashService`, `vatReconciliationService`) — the census table
    simply predates them.
  - 1 was the MEDIUM-1 defect (`transactionReportingService`) and 1 the LOW-1 divergence
    (`sales-by-item`); both fixed here.
  - The other 78 report no AR/AP figure that has to tie to a control account. The ones with
    any aggregation: `admin/analyticsService`, `workbench/monthEndWorkbenchService`,
    `dashboard/workbenchService`, `setup-guide`, `landing-stats` (row counts / draft counts);
    `reports/vatExceptionsService` (exception lists; its VAT leg reads the LINKED entry);
    `core/archiveQueryService`, `ar/customerPaymentService`, `ap/supplierPaymentService`,
    `ar/creditNoteService`, `ar/customerInvoiceReadService`, `ar/customerInvoiceCancelService`,
    `core/softDeleteInvoiceGuards` (single-document reads, lists, or guards);
    `core/masterDeleteGuards` (open-count guard, already `deleted_at IS NULL`);
    `gl/controlAccountService` (journal-id probe for account discovery);
    `ar/recurringInvoiceService`, `practice/practiceWipService` (`MAX` for numbering);
    `customer-duplicates`, `supplier-duplicates` (per-contact counts as a merge hint);
    `dashboard-todos` (a top-10 overdue to-do list — a workflow queue, which round 7 already
    rules out; it has no soft-delete filter at all, recorded here, not this item);
    `reports/vat201Service`, `reports/vatReturnService` (the document-based VAT return,
    deliberately undated so a deleted invoice stays in the period it was filed in — the
    same rule `vatReconciliationService`'s invoice leg follows). The remaining files carry
    no aggregation and act on one document.

- **MEDIUM-2 — the undo defeated the orphan guard.** FIXED in
  `reconciliation/unappliedCashService.ts` via a new
  `reconciliation/orphanReversalPairs.ts` (the service was at 291 lines). The undo DELETEs the
  sdjr row and posts R2 reversing R, so after a round trip neither R nor R2 is claimed by a
  document or an sdjr row. Rather than change the undo's bookkeeping — which could not repair
  the round trips that already happened, their rows being gone — mechanism 2 now selects
  `reversal_of_id` and drops any candidate reversed by ANOTHER candidate for exactly the
  opposite control movement (to the cent). Both directions are in
  `k053-unapplied-cash-delete-reversal`, which now performs a real `undoDelete`:
  - after the undo, the sdjr row is gone and three unclaimed reversals exist (R, R2 and a
    hand-built pair), yet `withoutPaymentRecord` is exactly `[orphanEntry]`;
  - a bare journal reversed by hand LATER is still reported at an as-at date that sees only
    its first leg (`[pairEntry, orphanEntry]`, total R1,200), and drops out only once both
    legs are dated (`[orphanEntry]`, total R500);
  - a manual reversal of a LIVE document's journal has no partner among the candidates (the
    original is claimed by the document), so it is still reported; a pair that does not
    cancel to the cent is left alone.

  **Not fixed here, registered as R-063.** `reports/vatReconciliationService.ts` reads the
  same sdjr table and so, after an undo, counts both R and R2 again. Its VAT arms are signed
  and the pair nets within a month; they fall in different months only if R's period closes
  between the delete and the undo (reasoned from `resolveReversalDate`, not measured). The
  revenue arm's `ABS(credit - debit)` makes the pair ADD instead of cancel — that is R-056,
  which K-091 is replacing in the same file. Applying the pair rule there means restructuring
  those queries while K-091 edits lines 81-83 and 320-322, so it is left to R-063 rather than
  turned into a semantic conflict on a money figure.

- **LOW-1 — `sales-by-item` disagreed with `sales-by-customer`.** FIXED: the same fragment at
  `to`. The fixture now carries `customer_invoice_items` for both AR documents (without them
  the report returned nothing and its predicate would have been decorative); the item total
  is `SUB + LEG_SUB` at `AS_AT_BEFORE` and `LEG_SUB` at `TODAY`.

- **The mutation-sweep figure.** Corrected to include the two sdjr-predicate files round 8
  left out, and re-run from scratch over the round-10 tree — see below.
