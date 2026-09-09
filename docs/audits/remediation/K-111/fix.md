# K-111 fix — merge and time-entry actions report the real row count

**Trigger.** `src/lib/neon.ts` resolves every tagged-template query to `res.rows`. An `UPDATE` without `RETURNING` therefore resolves to `[]`. `duplicateMergeService.ts` cast each result to a hand-written `type SqlResult = { rowCount?: number }` and summed `Number(rX.rowCount ?? 0)`, which is always 0. `timeTrackingService.ts` and `timeTrackingReportService.ts` expressed the same mistake as `Array.isArray(result) ? result.length : 0` on the same empty array.

**Before.** A merge that moved three supplier invoices reported `reassignedTransactions: 0`; `submitEntries`, `approveEntries` and `markAsInvoiced` always returned 0. The writes themselves landed — only the operator's feedback was wrong.
**After.** Every affected `UPDATE` carries `RETURNING id` and the count is `rows.length`. The `SqlResult` type and all eleven `as unknown as SqlResult` casts are deleted so the mistake cannot be re-made.

**Files.** `src/modules/accounting/services/core/duplicateMergeService.ts`, `src/modules/accounting/services/core/timeTrackingService.ts`, `src/modules/accounting/services/reports/timeTrackingReportService.ts`.

**Tests.** `tests/integration/k111-merge-and-timesheet-row-counts.int.test.ts` (2) and `tests/integration/k111-row-count-adjacent.int.test.ts` (5): empty duplicate reports 0, counts are tenant-scoped and leave a second tenant's rows alone, a repeated merge is refused, the count follows the status predicate rather than the length of the id list, and `markAsInvoiced` counts only approved billable entries. Mutation proof in `green.log`.

**Migration.** None.

**Historical-data impact.** None. No stored value is wrong; the defect was in reported feedback only. Operational residue: an operator who read "0 transactions reassigned" may have repeated a merge (idempotent) or reversed one manually, which would have moved live documents to the wrong supplier. No read-only impact SQL can distinguish that from a legitimate reassignment.

**Limits.** A repo-wide sweep for the defect class found one further live instance and it is fixed here: `bankTransactionQueryService.bulkAcceptTransactions` read `.count` off an UPDATE with no `RETURNING` and fell back to `ids.length`, reporting success for every id the operator sent including rows the `status IN ('imported','allocated')` predicate skipped. That is worse than the K-111 defect it neighbours, which under-reported to zero. Tests: `tests/integration/k111-bulk-accept-row-count.int.test.ts` (3). That completeness claim was **false** and is corrected in the round-3 dispositions below: `trialService.bulkExtendTrials` carried the same defect and is fixed here.

## Review round 2 dispositions (blind review of a9e8c3e7)

- **MEDIUM-4 (live over-reporting instance left in the sweep).** Fixed. `bulkAcceptTransactions` now carries `RETURNING id` and counts `result.length`, matching `deleteTransactions` twenty lines above. Three real-DB tests cover the status predicate, tenant scoping and the empty-list short circuit.
- **LOW-4 (no module doc entry).** Fixed. Entries added to `core/`, `reports/` and `bank/` `.claude.md`; mirrors regenerated.

## Review round 3 dispositions (blind review of 7bf60293c)

- **MEDIUM-2 (the sweep missed `trialService.bulkExtendTrials`).** Confirmed and fixed. It read `.count` off a tagged template (always undefined) and fell back to `companyIds.length`, over an UPDATE filtered by `status IS DISTINCT FROM 'deleted'` — a platform admin extending a list containing deleted companies was told every one moved. Now `RETURNING id` + `rows.length`; the log line reports `requested` and `extended` separately. Tests: `tests/integration/k111-trial-extension-row-count.int.test.ts` (3) — the predicate, a nonexistent id, and a deleted-only list that must move nothing. Mutation-proven by restoring `companyIds.length` (3 fail). The false completeness claim in Limits above is corrected.
- **LOW-7 (the toast cannot express a partial result).** Fixed. `handleBulkAccept` now raises a warning toast, `N of M transaction(s) marked as reviewed` with `M-N were already reviewed or no longer eligible`, and keeps the plain success only when every selected row moved. Tests: `tests/unit/components/bankTxBulkAcceptToast.test.ts` (3), including the nothing-moved case.
- **LOW-6 (`bulk_accept` id-list validation).** Disputed with measurement — see the K-110 fix.md round-3 dispositions. The zod schema already refuses it as 422 before the switch; two tests pin that.
