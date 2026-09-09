# K-021 — A failed bank reversal commits the subledger unwind

**Claim.** The unwind runs before the journal reversal; a closed-period throw becomes a 400, which withAuth commits, leaving the cash journal and the allocation in place.

**Corrected trigger.** The *original* entry's period being closed does not throw — `resolveReversalDate` falls back to today (`journalEntryPostingService.ts:205`). The reachable trigger is the period covering **today** being closed or locked; `postJournalEntry` then raises `ClosedFiscalPeriodError` after the unwind has already written.

**Disposition: confirmed.**

## Evidence
- `bankAllocationService.ts:642-648` (at ebeac9ca): `unwindBankAllocationApplication` runs, then `reverseJournalEntry`, whose failure is re-thrown as `Cannot reverse: ...`.
- `pages/api/accounting/bank-transactions-action.ts:178-182` catches every error from the `reverse` case and answers `apiResponse.badRequest` — 400.
- `src/lib/auth/withAuth.ts:224-226`: `handlerFailed = res.statusCode >= 500`, then `ROLLBACK` or `COMMIT`. A 400 commits.
- The unwind is not read-only: `bankAllocationUnwind.ts:135-151` reduces `amount_paid`; 161-169 DELETEs the allocation rows and cancels the payment document.
- Files unchanged between 5661d6f0 and ebeac9ca.
- RED `tests/integration/k021-failed-reversal-commits-unwind.int.test.ts` (1 failed) drives the real route through `withAuth`. HTTP 400, no reversal journal, bank line still `allocated` — and committed: `amount_paid` 1000 to 0, invoice `paid` to `approved`, payment `reconciled` to `cancelled`, allocation rows 1 to 0. Log: `red.log`.

## Reachability
`bank-transactions-action.ts:174` (the Reverse button). Also `writeBankAllocate`, `writeBankReverseBatch`, `writeBankReverseRange`, and `paymentVoidService`. The MCP callers pass an explicit `reversalDate`, for which `resolveReversalDate` throws on a closed target period — still after the unwind.

## Proposed minimal fix
Wrap the whole `if (tx.matched_journal_line_id)` block (631-650) in `withSavepoint` from `@/lib/neon` (line 410) so any throw rolls the unwind back before propagating. Separately, resolve the effective reversal date and assert its period is open *before* line 642, using the already-exported `resolveReversalDate` (its docblock at 188-195 says it exists for exactly this). Both are needed: the savepoint covers every post-unwind throw, the pre-flight turns a corrupting 400 into an honest refusal.

## Historical-data impact
```sql
SELECT cp.company_id, cp.id AS payment_id, cp.gl_journal_entry_id, cp.total_amount
FROM customer_payments cp
JOIN gl_journal_entries je ON je.id = cp.gl_journal_entry_id AND je.company_id = cp.company_id
LEFT JOIN gl_journal_entries rev ON rev.reversal_of_id = je.id AND rev.company_id = je.company_id
WHERE cp.status = 'cancelled' AND rev.id IS NULL AND je.reversed_at IS NULL;
```
Repeat for `supplier_payments`. Each hit means cash is still debited to bank and credited off AR in the GL while the invoice reads unpaid: subledger and control account diverge by that amount, and the allocation rows that would explain it were deleted.

## Risks
Callers that already treat a throw as "nothing happened" (`autoPostUndoService`, the MCP batch tools) become correct rather than more fragile. The pre-flight changes the error message on a closed current period.
