# K-019 — fix: transfer linking bound two bank lines to one GL movement

**Trigger.** Two `imported` rows on one bank account with the same amount and dates
inside the ±2 day window matched the same source allocation. Both link passes
de-duplicated per NEW transaction only (`DISTINCT ON (bt_new.id)` / `DISTINCT ON (n.id)`)
and neither excluded a journal line a bank transaction already claimed.

**Before.** Both rows went `allocated` carrying the identical `matched_journal_line_id`.
One bank line had no GL movement of its own: the account reconciles short by that amount
and the second transfer was never posted. The import path could also mark a row
`allocated` with a NULL line (a `LEFT JOIN`), and either pass could abort the request
transaction (25P02) through a catch with no savepoint.

**After.** One invariant, enforced in both passes: a GL movement is the counterpart of
exactly one bank line.
1. Both exclude a line already referenced by `matched_journal_line_id` (company-scoped
   `NOT EXISTS`).
2. Both add a `winners` CTE keeping one bank line per journal line, and drive the UPDATE
   from it. Ties break on the new transaction id, so a pass is repeatable.
3. Both repeat until a pass links nothing (`runLinkPasses`, cap 100), so a runner-up
   beaten on one line still gets its own free line in the same call.
4. `source_allocs` gained `ORDER BY bt_src.id, jl_mine.id` — a `DISTINCT ON` without one
   takes an arbitrary row in heap order.
5. The import pass joins `gl_journal_lines` INNER, so no row is allocated without a line.
6. The relink now writes `transfer_journal_entry_id`; the duplicate-transfer guard in
   `bankAllocationService` selects on it, so relinked rows were invisible to that guard.
7. Both run inside one savepoint, and return `{ linked, failed }` so a swallowed error is
   no longer indistinguishable from "nothing to link".

**Files.** `src/modules/accounting/services/bank/bankTransferLinkService.ts` (the import
batch pass moved here from `bankImportService.ts`, which kept a second copy of the same
defective SQL), `src/modules/accounting/services/bank/bankImportService.ts`,
`pages/api/accounting/bank-relink-transfers.ts`.

**Tests.** 13 passed against the real fixture DB across
`tests/integration/k019-transfer-relink-double-bind.int.test.ts` (8) and
`tests/integration/k019-import-autolink-double-bind.int.test.ts` (5), plus
`tests/unit/services/bank/bankImportService.bulk.test.ts` (7). Eleven mutations, one per
production change, each go RED; see `green.log`. Full unit suite green twice: 9320
passed. RED on origin/master in `red.log`.

**Migration.** None. **Rollback.** Revert the commit; no schema or data change.

**Historical impact.** Existing double-bound rows are not repaired. Read-only:
```sql
SELECT company_id, matched_journal_line_id, COUNT(*) AS claims, array_agg(id) AS bank_transaction_ids
FROM bank_transactions
WHERE matched_journal_line_id IS NOT NULL AND allocation_type = 'transfer'
GROUP BY company_id, matched_journal_line_id HAVING COUNT(*) > 1;
```
Rows allocated with no line at all (the old `LEFT JOIN`):
```sql
SELECT company_id, COUNT(*) FROM bank_transactions
WHERE status = 'allocated' AND allocation_type = 'transfer'
  AND matched_journal_line_id IS NULL GROUP BY company_id;
```
Neither was run against production.

**Limits.** The relink pass cannot source from a legacy row that carries
`transfer_journal_entry_id` but a NULL `matched_journal_line_id`; the import pass still
can, which is why it was fixed rather than deleted. The UI's relink call discards the
response, so `failed` reaches the API contract but no toast yet.
