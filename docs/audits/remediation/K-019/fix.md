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
3. Both rank every candidate pair from both sides and keep the `tx_rank = line_rank`
   diagonal, then narrow it per line and per transaction. N rows contending for N free
   lines settle in ONE statement; the diagonal alone is not a matching, so both narrowing
   stages are load-bearing. `runLinkPasses` repeats for the leftovers of a partial
   overlap. Termination is proved in its doc comment: the pair minimising
   (date_distance, new_tx_id, target_je_line_id) is always rank 1 on both axes, so every
   non-empty candidate set links at least one row and the set strictly shrinks.
4. `source_allocs` gained `ORDER BY bt_src.id, jl_mine.id` — a `DISTINCT ON` without one
   takes an arbitrary row in heap order.
5. The import pass joins `gl_journal_lines` INNER, so no row is allocated without a line.
6. The relink now writes `transfer_journal_entry_id`; the duplicate-transfer guard in
   `bankAllocationService` selects on it, so relinked rows were invisible to that guard.
7. Both run inside one savepoint, and return `{ linked, failed }`. That signal now
   reaches consumers rather than stopping at the contract: a failed pass adds an entry to
   the import result's `errors[]`, and the bank transactions page reads the relink
   response and shows a non-blocking notice.

**Files.** `bankTransferLinkService.ts` (the import batch pass moved here from
`bankImportService.ts`, which kept a second copy of the same defective SQL),
`bankTransferLinkPasses.ts` (new — the shared savepoint and repeat loop, split out to
keep both files under 300 lines), `bankImportService.ts`,
`pages/api/accounting/bank-relink-transfers.ts`,
`pages/accounting/bank-transactions/index.tsx`.

**Tests.** 19 passed against the real fixture DB across
`tests/integration/k019-transfer-relink-double-bind.int.test.ts` (10) and
`tests/integration/k019-import-autolink-double-bind.int.test.ts` (9), plus
`tests/unit/services/bank/bankImportService.bulk.test.ts` (9). Fifteen mutations, one per
production behaviour, each go RED; see `green.log`, which also records that two of them
survived at first and what closed them. Full unit suite green at 9322 passed with the
test timeout raised; at the default 10s it is flaky on this box and this branch trips
more of it than origin/master — measured interleaved, and detailed in `green.log`. RED on
origin/master in `red.log`.

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
can, which is why it was fixed rather than deleted. The rank diagonal is a greedy pairing,
not a maximum matching: a partial overlap can still need a second pass, which is what the
loop is for. Because the relink now writes `transfer_journal_entry_id`, rows it links
become eligible SOURCES for a later import pass, where before they were invisible to it;
the anti-join makes that safe, and it is the correct widening, but it is a behaviour
change. This branch is measurably slower under heavy parallel load, enough to trip more
10s test timeouts; no assertion fails.
