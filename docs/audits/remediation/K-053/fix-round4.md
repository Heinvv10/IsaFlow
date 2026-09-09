# K-053 round 4 — the exclusion is dated, because the reversal is

Disposition of every finding in `review-k053-r3.md` (1 HIGH, 3 MEDIUM, 4 LOW). All eight FIXED;
none disputed.

**HIGH-1 — date-blind exclusion vs a dated reversal. FIXED.** `reverseJournalEntry` dates the
delete's reversal to the original entry date only while that period is open and otherwise to
TODAY, so for a document raised in a closed prior month the control account keeps carrying it
right up to the delete. Round 3's `deleted_at IS NULL` / undated `EXISTS` measured the two sides
of an as-at comparison on different clocks: `arSubLedgerCheck(company, { endDate })` failed by the
whole document amount for every `endDate` between the invoice and the delete. New
`src/modules/accounting/services/shared/softDeleteLedgerPresence.ts` answers the dated question by
the reversal chain's PARITY as at the date (odd number of posted entries dated `<= as-at` =
standing), which also keeps documents deleted BEFORE this change — journal still posted — on the
sub-ledger side with no historical repair. Applied at all eight sites: `getARAging`,
`getARAgingDetail`, `getAPAging`, `getAPAgingDetail`, `getARSubledger`, `getAPSubledger`,
`arSubLedgerCheck`, `apSubLedgerCheck`. `controlBalance` in `k053-soft-delete-gl-tie` gained the
`entry_date <= as-at` bound whose absence hid the defect.

**MEDIUM-1 — cancelling a soft-deleted document. FIXED.** `AND deleted_at IS NULL` on the
`FOR UPDATE` lock read in `customerInvoiceCancelService` and `supplierInvoiceWorkflowService`;
the refusal is the existing not-found error. Under mutation the cancel SUCCEEDS on a deleted
document, flipping the status and NULLing `gl_journal_entry_id`, after which an undo re-instates
the journal of a document the sub-ledger excludes as cancelled.

**MEDIUM-2 — close-readiness read the linked original, never the chain head. FIXED** by the same
parity predicate: reversing the delete's reversal by hand puts the document back on both sides.

**MEDIUM-3 — opaque 500 permanently blocking a delete. FIXED.** `chainHead`'s unexpected-chain
throw is a `SoftDeleteRefusalError` naming the entry to open; the route answers 400.

**LOW-1 — supplier ledger payment leg. FIXED** by reverting round 3's
`status NOT IN ('draft','cancelled')` filter. The payment leg lists whole `supplier_payments` rows
rather than allocations, so anything dropped from the invoice leg leaves its payment with no
matching debit. `deleted_at` is safe there (`assertInvoiceDeletable` refuses a bill with any live
allocation); a status filter is not, and is a report contract change outside K-053 besides.

**LOW-2 — statements filter invoices but not payments. Recorded under Limits below** (no code).

**LOW-3 — `softDeleteService.ts` at 294 lines. FIXED**: the per-table UPDATEs moved to
`core/softDeleteRowOps.ts`; the file is now 178 lines.

**LOW-4 — `isUserFixable` matched `'not found'` anywhere. FIXED.** Refusal vs fault is decided by
TYPE: `SoftDeleteRefusalError` (new `core/softDeleteErrors.ts`) and `ClosedFiscalPeriodError` are
400, everything else stays a 500 and reaches `log.error`. Only the missing-fiscal-period case is
still matched on text, because it is raised as a plain `Error`.

**Files.** New: `shared/softDeleteLedgerPresence.ts`, `core/softDeleteErrors.ts`,
`core/softDeleteRowOps.ts`. Changed: `arAgingService` · `apAgingService` · `arSubledgerService` ·
`apSubledgerService` · `arSubLedgerCheck` · `apSubLedgerCheck` · `softDeleteService` ·
`softDeleteJournalService` · `softDeleteInvoiceGuards` · `customerInvoiceCancelService` ·
`supplierInvoiceWorkflowService` · `pages/api/accounting/soft-delete.ts` ·
`pages/api/accounting/reports-supplier-ledger.ts` · `ar`/`ap`/`core` `.claude.md` + `AGENTS.md`.

**Tests.** New `tests/integration/k053-aging-as-at-reversal-date.int.test.ts` (5: the reversal is
dated TODAY; AR and AP still aged and still tying BEFORE it, at `-90d` and at yesterday; both
sides dropping together ON it; a hand reversal of the delete's reversal putting the document back
on both sides). Two cases added to `k053-soft-delete-undo-identity.int.test.ts` (cancel refused on
both ledgers; the route's 400-vs-500 typing, including the un-posted-reversal chain). **8 files,
35 tests**, all passing on fixture Postgres with migration 653 applied.

**Mutation proof.** Three reverts, each run and restored: the parity predicate replaced by
`deleted_at IS NULL` → 4/5 RED in the new file (and 3/5 with only the round-3 shape) · the cancel
`deleted_at` guard removed → the cancel test RED, the cancel resolving instead of refusing · the
typed `isUserFixable` replaced by round 3's substring list → the chain-refusal case RED at 500.

**Full suite.** `bunx vitest run` with the fixture env UNSET: **9,434 passed / 234 skipped, 0
failed** (828 files). Round 4 also repaired two suites round 3 left broken:
`periodCloseReadinessService.test.ts` and `mcp/w2/subledgerSnapshot.test.ts`. Round 3 built the
predicate with a NESTED tagged template, which is a call on the mocked client and silently
consumed a queued `mockResolvedValueOnce`, shifting every row after it — 25 tests failed. The
fragment is now a single `sql.unsafe`, and it carries the tenant as a PARAMETER rather than as the
correlated `<alias>.company_id`, so it scopes itself. `tsc --noEmit` and `eslint` clean.

**Migration / rollback.** No new migration; 653 is unchanged from round 3.

**Historical impact.** Unchanged and still NOT repaired: documents soft-deleted before round 3
carry a posted journal, and the parity predicate is written so they still tie without a repair.
Round 4 CHANGES no stored row — it changes only how the as-at question is asked. Sizing SQL is in
`fix-round2.md`. Anyone who ran a close checklist against a period between an invoice and its
delete since round 3 saw a false `fail`; nothing was written on that path.

**Limits.** (1) LOW-2: the AR/AP statement surfaces filter invoices but not payments, so a
document soft-deleted BEFORE round 3 — which may carry payments, since the payments guard binds
only future deletes — can still show a payment whose invoice is hidden. Not repaired.
(2) `supplierInvoiceWorkflowService.ts` is 516 lines, over the 300-line cap; round 4 adds 3 lines
to it and does not split it. (3) The purge gap and the wider consumers listed in `fix-round2.md`
remain out of scope.
