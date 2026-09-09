# K-020 fix — reconciled balance recomputed live

**Trigger.** A user posts a bank reconciliation adjustment (`createAdjustmentEntry`, the
only call site of `updateReconciledBalance`) on a reconciliation that already holds
matched bank rows.

**Before.** `reconciled_balance = gl_balance + SUM(bank_transactions.amount)` over
matched/reconciled rows, where `gl_balance` is the frozen snapshot written at
`startReconciliation`. Matching only stamps a bank row against an already-posted GL
line, so its amount was counted twice; the adjustment journal posted moments earlier
never entered the frozen column at all. Validator fixture: expected 1050, stored 2000,
`difference` -950 instead of 0.

**After.** `gl_balance` and `reconciled_balance` are both recomputed from posted
`gl_journal_lines` on the reconciliation's own `bank_account_id`, dated on or before
`statement_date`, scoped to `company_id`. The `SUM(amount)` term is gone.
`difference` is a generated column (`statement_balance - reconciled_balance`,
migration 203) so the required contract holds unchanged.

**Files.** `src/modules/accounting/services/bank/bankReconciliationService.ts`
(`updateReconciledBalance`, 262-283). No API, type or UI change: the reconciliation
page reads `glBalance`, `reconciledBalance` and `difference` and carries no copy
describing the old formula.

**Tests.** `tests/integration/k020-reconciled-balance-double-count.int.test.ts` (1) —
the validator's RED case. `tests/integration/k020-reconciled-balance-recompute.int.test.ts`
(3) — tenant isolation of a foreign line on the same `gl_account_id`, draft entries
excluded, entry dated after `statement_date` excluded and one dated exactly on it
included, matching a transaction does not move the balance, and a wrong `company_id`
updates nothing. 4 passed against the real fixture database. Full unit suite with
`DATABASE_URL` unset: 9320 passed, 234 skipped across 820 files, no regressions.

**Mutation check.** Reverting the production change turns 3 of the 4 red
(2000 vs 1050; 800 vs 400 twice). See `green.log`.

**Migration / rollback.** None. Behaviour-only change; revert the commit to roll back.

**Historical-data impact.** Stored balances are wrong wherever this ran. Read-only:
```sql
SELECT br.id, br.company_id, br.bank_account_id, br.statement_date,
       br.gl_balance, br.reconciled_balance, br.difference, br.status
FROM bank_reconciliations br
WHERE br.reconciled_balance <> br.gl_balance;
```
Rows are corrected on the next adjustment; in-progress reconciliations move back
towards a closeable `difference`. Completed ones keep the wrong stored figure until
someone reopens them — no backfill is included here.

**Limits.** Whether unpresented items should be added back to `reconciled_balance` is
an accounting decision left unchanged. No concurrency claim is made: the helper remains
one atomic UPDATE, as before.

---

## Review round — all 7 findings addressed (0 HIGH, 3 MEDIUM, 4 LOW)

**M1 — two tiles showing one number.** `reconciled_balance` is the posted GL balance
as at `statement_date` by construction, so the reconciliation page rendered "GL Balance"
and "Reconciled Balance" as identical figures. The pair is collapsed into one tile,
"GL Balance (as at statement date)", and the grid drops to three columns. The API,
types and both MCP tools are unchanged, so no contract moves. Whether
`reconciled_balance` should carry an outstanding-items term remains the accounting
decision deferred under Limits; the consequence for `completeReconciliation` is that a
genuine timing difference still has to be cleared by a journal.

**M2 — adjustment on a completed reconciliation.** `createAdjustmentEntry` now throws
when `recon.status === 'completed'`, matching the shape `completeReconciliation` uses.
Without it the recompute would rewrite the `gl_balance` of a signed-off audit artefact.

**M3 — unvalidated `bankAccountId`.** The recompute correlates on the reconciliation's
own `bank_account_id`, so an adjustment posted to a different account returned 200 with
a journal id and moved nothing. It is now refused before any journal is created.

**L4 / L5 — duplicated, twice-evaluated balance SQL.** Extracted `bankGlBalanceAsAt`,
a composable `sql` fragment that both `startReconciliation` and `updateReconciledBalance`
build on, so the snapshot and the recompute cannot drift. The recompute wraps it in a
derived table and selects the column twice, so the aggregate is written once. Tradeoff:
the snapshot call site now issues three `sql` calls (two expression fragments plus the
SELECT), which required queueing three mocks in
`tests/unit/services/bl80-83-tenant-isolation.test.ts`.

**L6 — not in the CI gate.** Both files are `tests/integration/*.int.test.ts` under
`vitest.integration.config.ts`, which needs `DATABASE_URL`. `bun run ci` does not supply
it, so `scripts/ci/run-ci.sh` does not execute them. Run them manually with the fixture
env: `bun run test:integration -- tests/integration/k020-*.int.test.ts`. This fix has no
guard on master until an integration job runs with a database.

**L7 — unevidenced mutation check.** `green.log` now carries the captured failure output
from the reverted-service run, not prose.

**Tests added.** Two cases in `k020-reconciled-balance-recompute.int.test.ts` for M2 and
M3, each asserting the throw AND that no journal entry was created and the balances did
not move. 6 integration tests pass; 5 of the 6 go red when the service is reverted.
