# K-136 — approveBatch and cancelBatch report success when nothing changed

**Claim.** Neither checks the affected-row count, so a no-op returns success.

**Corrected trigger.** `approveBatch` (`batchPaymentService.ts:113-120`) and
`cancelBatch` (`:185-193`) each run two UPDATEs guarded by `AND status = 'draft'`,
return `Promise<void>`, and never read the affected-row count.
`pages/api/accounting/batch-payments-action.ts:31-41` answers
`apiResponse.success(res, { status: 'approved' })` / `{ status: 'cancelled' }` purely on
the call not throwing. Four no-ops are therefore reported as done:

- cancelling a PROCESSED batch — the EFT has gone out and the DR AP / CR Bank journal
  is posted, and the operator is told the batch is cancelled;
- approving a batch that is already cancelled;
- an id belonging to another tenant;
- an id that does not exist.

The first is the material one: an operator who believes a processed batch was cancelled
will raise the payment again.

**Disposition: confirmed.**

**Evidence.**
- `git show origin/master:src/modules/accounting/services/ap/batchPaymentService.ts:113-120,185-193`
  and `pages/api/accounting/batch-payments-action.ts:29-42`.
- Executed RED test, 4 of 4 failing: every call resolves and the batch keeps its status.
- Contrast in the same file: `processBatch` (`:122-125`) reads the batch first and
  throws `Batch must be approved first`. The two siblings were never given that check.

**Reachability.** `POST /api/accounting/batch-payments-action` with
`{ action: 'approve' | 'cancel', id }`. `withAuth` + `withCsrf` + `withWriteAccess`, no
further guard.

**RED test.** `tests/integration/k136-batch-approve-cancel-no-op.int.test.ts`
(4 tests, 4 failed) — output in `red.log`.

**Proposed minimal fix.** In both functions, capture the header UPDATE's returned rows
(`… AND status = 'draft' RETURNING id`) and throw when it is empty, naming the batch's
actual status — the shape `processBatch` already uses. Four lines across the two
functions. Reading the batch first with `getBatchById` and refusing on status would read
better still and gives the operator the real reason.

**Historical-data impact.** Not reconstructible from the data: a no-op leaves no trace,
and the batch simply still holds its old status. What can be surveyed is how much
exposure exists. Read-only impact query (NOT run — production out of scope):

```sql
SELECT company_id, status, COUNT(*), SUM(total_amount)
FROM supplier_payment_batches GROUP BY 1, 2 ORDER BY 1, 2;
```

Any `processed` batch a tenant believes was cancelled is a candidate for a duplicate
payment; the payment file and the bank statement decide it, not this table.

**Risks.** None. Callers currently cannot distinguish success from a no-op, so nothing
depends on the silent path.
