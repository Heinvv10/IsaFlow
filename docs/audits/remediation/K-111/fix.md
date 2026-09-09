# K-111 fix — merge and time-entry actions report the real row count

**Trigger.** `src/lib/neon.ts` resolves every tagged-template query to `res.rows`. An `UPDATE` without `RETURNING` therefore resolves to `[]`. `duplicateMergeService.ts` cast each result to a hand-written `type SqlResult = { rowCount?: number }` and summed `Number(rX.rowCount ?? 0)`, which is always 0. `timeTrackingService.ts` and `timeTrackingReportService.ts` expressed the same mistake as `Array.isArray(result) ? result.length : 0` on the same empty array.

**Before.** A merge that moved three supplier invoices reported `reassignedTransactions: 0`; `submitEntries`, `approveEntries` and `markAsInvoiced` always returned 0. The writes themselves landed — only the operator's feedback was wrong.
**After.** Every affected `UPDATE` carries `RETURNING id` and the count is `rows.length`. The `SqlResult` type and all eleven `as unknown as SqlResult` casts are deleted so the mistake cannot be re-made.

**Files.** `src/modules/accounting/services/core/duplicateMergeService.ts`, `src/modules/accounting/services/core/timeTrackingService.ts`, `src/modules/accounting/services/reports/timeTrackingReportService.ts`.

**Tests.** `tests/integration/k111-merge-and-timesheet-row-counts.int.test.ts` (2) and `tests/integration/k111-row-count-adjacent.int.test.ts` (5): empty duplicate reports 0, counts are tenant-scoped and leave a second tenant's rows alone, a repeated merge is refused, the count follows the status predicate rather than the length of the id list, and `markAsInvoiced` counts only approved billable entries. Mutation proof in `green.log`.

**Migration.** None.

**Historical-data impact.** None. No stored value is wrong; the defect was in reported feedback only. Operational residue: an operator who read "0 transactions reassigned" may have repeated a merge (idempotent) or reversed one manually, which would have moved live documents to the wrong supplier. No read-only impact SQL can distinguish that from a legitimate reassignment.

**Limits.** Other services that read a count off a bare `UPDATE` were not swept; only the three named here were changed. `bankTransactionQueryService.ts:208` already carries a comment documenting the same hazard.
