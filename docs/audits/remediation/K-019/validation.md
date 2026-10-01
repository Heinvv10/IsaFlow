# K-019 — Transfer relink binds two bank lines to one GL movement

**Claim.** `relinkTransferCounterparts` does not exclude already-consumed source journal lines, so two incoming bank lines are allocated against the same GL movement.

**Corrected trigger.** Two imported transactions on the target bank account, same amount, dates within the +/-2 day window, match the *same* `source_allocs` row. Same root cause as the audit's "already consumed" wording: there is no anti-join against `bank_transactions.matched_journal_line_id`.

**Disposition: confirmed.**

## Evidence
- `git show ebeac9ca:src/modules/accounting/services/bank/bankTransferLinkService.ts`, lines 58-77: `best_matches` uses `DISTINCT ON (bt_new.id)`, de-duplicating per *new* transaction only. Nothing de-duplicates per `sa.target_je_line_id`, and `source_allocs` (34-57) has no predicate excluding a `jl_mine` already referenced by a bank transaction.
- File unchanged between 5661d6f0 and ebeac9ca.
- RED `tests/integration/k019-transfer-relink-double-bind.int.test.ts` (1 failed): one -5000 source allocation on bank A, two imported +5000 rows on bank B. Service returns `count: 2`, both rows go `allocated` with the identical `matched_journal_line_id`; `distinct.size === claimed.length` fails 1 vs 2. Log: `red.log`.

## Reachability
`pages/api/accounting/bank-relink-transfers.ts:26` (user-triggered re-link) and `src/modules/accounting/services/bank/bankImportService.ts:277` (after every statement import).

## Proposed minimal fix
1. Add to `source_allocs`: `NOT EXISTS (SELECT 1 FROM bank_transactions bt_used WHERE bt_used.company_id = $company AND bt_used.matched_journal_line_id = jl_mine.id)`.
2. Add a CTE after `best_matches` keeping one winner per `target_je_line_id` (`DISTINCT ON (target_je_line_id) ... ORDER BY target_je_line_id, date distance, new_tx_id`), and drive the UPDATE from it.
3. Give the swallowing `catch` (103-106) a savepoint: the `bankImportService` caller runs inside the request transaction, so a swallowed error leaves it poisoned (25P02).

## Historical-data impact
```sql
SELECT company_id, matched_journal_line_id, COUNT(*) AS claims, array_agg(id) AS bank_transaction_ids
FROM bank_transactions
WHERE matched_journal_line_id IS NOT NULL AND allocation_type = 'transfer'
GROUP BY company_id, matched_journal_line_id HAVING COUNT(*) > 1;
```
Each duplicate group is one bank line marked allocated with no GL movement of its own: the bank account reconciles short by that amount and the second transfer was never posted.

## Risks
Fix 2 changes which transaction wins when two are equally close. The ordering must tie-break on `new_tx_id` or the re-link stops being repeatable.
