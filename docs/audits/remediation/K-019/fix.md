# K-019 — fix: transfer relink bound two bank lines to one GL movement

**Trigger.** Two `imported` rows on the target bank account with the same amount and
dates inside the ±2 day window match the same `source_allocs` row. `best_matches`
de-duplicated with `DISTINCT ON (bt_new.id)` — per new transaction only — and
`source_allocs` had no anti-join against `bank_transactions.matched_journal_line_id`.

**Before.** Both rows went `allocated` with the identical `matched_journal_line_id`.
One bank line carried no GL movement of its own, so the bank reconciled short by that
amount and the second transfer was never posted. A re-link pass could also re-claim a
line an earlier pass had already bound.

**After.**
1. `source_allocs` excludes any `jl_mine` a bank transaction in this company already
   references (`NOT EXISTS`, company-scoped).
2. A `winners` CTE — `DISTINCT ON (target_je_line_id) ... ORDER BY target_je_line_id,
   date_distance ASC, new_tx_id` — keeps at most one bank line per GL movement, and
   the UPDATE is driven from it. The `new_tx_id` tie-break keeps the pass repeatable.
3. The swallowing `catch` no longer poisons the caller's transaction: the query runs
   inside `withSavepoint('relink_transfer_counterparts', …)`. The import path calls
   this inside the request transaction, where a swallowed error left 25P02.

**Files.** `src/modules/accounting/services/bank/bankTransferLinkService.ts` (only).

**Tests.** `tests/integration/k019-transfer-relink-double-bind.int.test.ts` — 4 passed
against the real fixture DB: unique bind + runner-up untouched, no cross-tenant line
chosen (second company with identical amounts/dates), idempotent second pass, and a
failed relink leaving the request transaction usable. Mutation check: dropping the
`winners` CTE fails 2, dropping the anti-join fails 1, dropping the savepoint fails 1
(`green.log`). RED on origin/master in `red.log`. Full unit suite with the fixture
env unset: 9318 passed, 234 skipped, 2 failed — both 10s timeouts under full-suite
load that fail identically with this file checked out from origin/master, and both
pass in isolation. No mocked fixture elsewhere broke on the new SQL aliases.

**Migration.** None. **Rollback.** Revert the commit; no schema or data change.

**Historical impact.** Existing double-bound rows are not repaired. Read-only:
```sql
SELECT company_id, matched_journal_line_id, COUNT(*) AS claims, array_agg(id) AS bank_transaction_ids
FROM bank_transactions
WHERE matched_journal_line_id IS NOT NULL AND allocation_type = 'transfer'
GROUP BY company_id, matched_journal_line_id HAVING COUNT(*) > 1;
```
Each group is one bank line marked allocated with no GL movement behind it. Not run
against production by this change.

**Limits.** A runner-up beaten on a line is not re-assigned to its second-best line in
the same pass; the next pass picks it up, since the winner's line is then excluded.
