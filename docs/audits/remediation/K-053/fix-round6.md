# K-053 round 6 — closing the census, and the undo window that never expires

Answers `review-k053-r5.md` (1 HIGH · 1 MEDIUM · 5 LOW) on `510749e1c`.

## HIGH-1 — the AR customer ledger (FIXED)

`customerLedgerService.ts` is the AR mirror of `reports-supplier-ledger`: it takes
`dateFrom`/`dateTo`, it is the document the customer is asked to pay, and both its legs still
asked the UNDATED question. After round 5 it therefore disagreed with the emailed statement
round 5 had just fixed, and it was the leg that disagreed with the GL — R1,150 vs R0 at every
as-at date between the invoice and its delete (reproduced, then mutation-proved, below).

Both legs now take `documentInLedgerAsAtFragment('ci', asAtStr, companyId)` with
`asAtStr = dateTo ?? today`. The OPENING leg is dated to `dateTo`, not to `dateFrom`: this
statement lists documents and never the GL reversal the delete posts, so a delete falling
INSIDE the window produces no row — dating the opening to `dateFrom` would carry the invoice
into an opening balance nothing in the window then removes, and the closing figure would stop
tying to the control account. Reasoning is in the code, at the constant.

## The census, completed

Every `deleted_at` site in `src/` + `pages/` (131 lines / 50 files), classified by whether the
surface can be asked "was this document in the ledger as at date X".

| Disposition | Sites |
|---|---|
| **DATED** — takes an as-at date, uses the fragment | `arAgingService` ×2 · `apAgingService` ×2 · `arSubledgerService` · `apSubledgerService` · `arSubLedgerCheck` · `apSubLedgerCheck` · `statementEmailService` · `supplierStatementService` · `supplierStatementBalancesService` ×2 · `customer-statement.ts` ×2 · `reports-supplier-ledger.ts` · **`customerLedgerService` ×2 (this round)** |
| **UNDATED, correct** — asks as at NOW, takes no date parameter | `dunningService:148` (invoice id, no date) · `dunningCronService:117` (`due_date < CURRENT_DATE`) · `smart-reminder.ts:30` (`due_date < CURRENT_DATE`) · `supplierAutoAllocate:119,128` (allocating money now) · `missingInvoiceChaseService:152` · `expectationEngineService:164,237` · `customerInvoiceCancelService:99` · `supplierInvoiceWorkflowService:301` |
| **UNDATED, correct** — single document or list screen, not a balance that must foot | `customerInvoiceReadService:97,130` · `customerInvoicesAdjacent:44` · `portalTokenService:43,83` · `portal/invoice/[token]:91` · `disputeService:122` · `supplierInvoiceQueryService:89,145` · `supplierInvoiceWhereBuilder:47,95` |
| **NOT a document** — master data, tenancy, or the soft-delete machinery itself | `customers`/`suppliers`/`items`/`companies`/`company_relationships` lookups (`contactDirectoryService` ×10, `duplicateMergeService` ×6, `itemService` ×4, `duplicateDetectionService` ×3, `unappliedReceiptService` ×3, `unappliedPaymentService` ×3, `masterDeleteGuards` ×2, `globalSearchService` ×2, `creditNoteLinkService` ×2, `consolidationService` ×2, `companyRelationshipService` ×6, `customer-duplicates`/`supplier-duplicates` ×4, `customers.ts`, `customers-bulk` ×2, `customer-merge`, `supplier-merge`, `suppliers-list`, `supplier-statements/index`, `time-entries-invoice`, `customerWriteService`, `supplierWriteService`, `practice*` ×3, `reports-supplier-ledger:72`) · `softDeleteRowOps`/`softDeleteService`/`softDeleteJournalService`/`softDeleteInvoiceGuards`/`softDeleteLedgerPresence` |

**The class test.** `k053-statements-as-at-reversal-date.int.test.ts` now asserts the AR customer
ledger, the emailed statement, the on-screen statement and the GL control account all answer the
same figure at three as-at dates — before the reversal (R1,150), on it (R0) and after it (R0) —
plus the opening-leg case (a delete inside the window) and the unbounded `dateTo` case.

## MEDIUM-1 — the `unsafe` mocks (FIXED)

New `tests/unit/helpers/sqlFragmentMock.ts`. `mockUnsafe` returns a `MockSqlFragment` and
`recordSqlCall` splices it into the recorded SQL with its `$N` renumbered and its values appended,
exactly as `buildQuery` does — so the recorded statement is what Postgres would have been sent,
and `expect(q.sql).toContain('si.deleted_at IS NULL')` is now a real assertion (added; goes RED
under the old `(t) => t`). Awaiting a fragment rejects with the mistake named, which is the
hazard `softDeleteLedgerPresence`'s header documents and `(t) => t` could not catch. Applied to
the four suites this branch touched that exercise the fragment.

## LOWs

- **LOW-1 (file sizes) — DISCLOSED, not split.** Over 300 lines and untouched in size direction by
  this round: `supplierInvoiceWorkflowService.ts` 516 · `journalEntryPostingService.ts` 359 ·
  `dunningService.ts` 357. All three predate the branch; splitting a posting service inside a
  ledger-correctness commit is the riskier change. `customerLedgerService.ts` is 267 after this
  round. Follow-up: move `ReversalPeriodError`/`ClosedFiscalPeriodError` to `gl/journalErrors.ts`.
- **LOW-2 (soft-deleted CUSTOMER) — FIXED.** `statementEmailService` and `customer-statement.ts`
  now filter `deleted_at IS NULL` on the customer lookup, as `customerLedgerService` already did.
  A statement is no longer drawn or emailed for a removed contact; the route 404s. Test + mutation.
- **LOW-3 (email vs screen) — PARTLY FIXED.** `customer-statement.ts` now uses
  `COALESCE(ci.client_id, ci.customer_id)` on both its detail and totals legs, which the root
  `CLAUDE.md` requires and which the emailed statement already did; `client_id` alone dropped from
  the screen invoices the email billed. The remaining two differences are report-contract changes
  and stay OUT of scope: the route takes credit notes at `status='approved'`/`total_amount` where
  the email takes `approved`+`applied` at `applied_amount`, and the route has no opening balance.
  Worth its own item — "the emailed statement agrees with the screen" is still not true in general.
- **LOW-4 (purge error handling) — FIXED.** The invoice arms are now ONE statement
  (`purgeInvoices`): a data-modifying CTE deletes the document and a second arm deletes its
  `soft_delete_journal_reversals` row, so the pair is atomic without a savepoint and neither
  stranding nor a caught-error `25P02` is reachable. Pairing stays `(company_id, entity_id)`;
  mutating it to `entity_id` alone takes the cascade test RED.
- **LOW-5 (the undo window) — FIXED.** The UI said 5 minutes, the API said `expiresIn: 30`, and
  nothing purges. The confirm now reads "The record is hidden rather than erased, and can be
  restored"; the API returns `expiresIn: null` and its header says why. No consumer read the field.

## The purge itself — RULED, deliberately still uncalled

`purgeExpiredDeletes` keeps its correct cascade and keeps having no caller. Hard-deleting a
soft-deleted invoice destroys the only row `documentInLedgerAsAtFragment` can evaluate, so every
past as-at date between the document and its delete loses it from the sub-ledger side while the
GL control account keeps carrying it — a permanent, unrepairable break of the tie this branch
exists to close, including in closed periods. A five-minute purge is not a tuning problem, it is
incompatible with the design. The reasoning is recorded in the function's own header, where the
next person to wire a caller will read it; any future retention job should purge master data only,
never `customer_invoices` / `supplier_invoices`.

## Gates

Integration `tests/integration/k053*`: **11 files / 51 tests** (was 47). Full unit suite with the
fixture env UNSET: **793 files / 9,440 passed, 234 skipped**. `bunx tsc --noEmit` clean; `bunx
eslint` clean over the changed `src/`+`pages/` files. No migration this round (653 stands).

**Mutation proofs.** (1) Reverting both `customerLedgerService` legs to
`deleted_at IS NULL OR deleted_at > NOW()` → 2 tests RED, `ledger vs GL @ <date>: expected +0 to
be close to 1150`. (2) Restoring `unsafe: (t) => t` → the new fidelity assertion RED. (3) Dropping
`deleted_at IS NULL` from the statement customer lookup → the deleted-customer test RED. (4)
Pairing the purge cascade on `entity_id` alone → the cascade test RED. All four restored.

**Historical impact.** No data is written. The customer-ledger change makes an existing report
answer differently: a customer ledger drawn to a date BEFORE a soft-delete now shows the invoice
(and a larger closing balance) where it previously showed nothing. That is the GL-agreeing answer.
The `COALESCE` change widens the on-screen statement to invoices carrying only `customer_id`.
Read-only impact query, NOT run here:

```sql
SELECT company_id, count(*) AS invoices, sum(total_amount) AS value
FROM customer_invoices
WHERE deleted_at IS NOT NULL
  AND status IN ('approved','sent','partially_paid','overdue','paid')
GROUP BY company_id ORDER BY value DESC;

-- invoices the on-screen statement was dropping for want of COALESCE
SELECT company_id, count(*) FROM customer_invoices
WHERE client_id IS NULL AND customer_id IS NOT NULL GROUP BY company_id;
```
