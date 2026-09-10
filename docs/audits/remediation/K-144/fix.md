# K-144 — a matched journal line must belong to the caller company

**Trigger.** Either route that reaches `matchTransaction` with a caller-supplied
`journalLineId`: `pages/api/accounting/bank-transactions-action.ts` (Zod-checked
as a UUID only) and the `journal_line` arm of
`pages/api/accounting/bank-match-confirm.ts`.

**Before.** `matchTransaction` wrote `matched_journal_line_id` straight from its
argument. `lockForStatusWrite` checks only the bank row. The FK to
`gl_journal_lines(id)` is not a tenant check — referential integrity is not
subject to row-level security — so a line from another company was accepted and
the row left `matched` against a line no query in this company can resolve. A
non-existent id surfaced as a raw FK violation, which also poisons the request
transaction instead of returning a clean 400. And one line could be bound to two
bank transactions, double-counting it in the reconciled balance.

**After.** `assertMatchTargets` runs after the lock and before the UPDATE: the
journal line must exist in the caller's company, no other bank transaction in
that company may already hold it, and a supplied `reconciliationId` must be the
caller's too. Each failure throws a message the API returns as a 400.
The `bank_transfer` arm of `bank-match-confirm.ts` already did the line lookup
company-scoped; this brings the `journal_line` arm level with it.

**Files.** `src/modules/accounting/services/bank/bankTxStatusMutations.ts`.

**Tests.** `tests/integration/k144-match-unvalidated-journal-line.int.test.ts` — 5
passed against a real database (cross-tenant line, non-existent line, double
binding, cross-tenant reconciliation, and an idempotent re-match of the line a
row already holds). `tests/unit/services/bankTxStatusMutationsLock.test.ts` — 20
passed, 2 of them new. `tests/unit/services/bankReconciliationService.test.ts` —
36 passed. Mutation proof in `green.log`.

**Migration.** None. A unique index on `matched_journal_line_id` would enforce
the double-binding rule in the database, but that is a schema policy call and the
validator asked for it to be raised with K-019/K-020 rather than decided here.

**Historical-data impact.** Rows may exist. Read-only census, as superuser (RLS
would hide exactly the rows sought) — NOT run here:
`SELECT bt.id, bt.company_id, jl.company_id AS line_company FROM bank_transactions bt
 JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id
 WHERE jl.company_id <> bt.company_id;`
and for double binding:
`SELECT matched_journal_line_id, COUNT(*) FROM bank_transactions
 WHERE matched_journal_line_id IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1;`
Either hit corrupts the reconciled balance for that account.

**Limits.** Two indexed reads per match. Without the unique index, two concurrent
requests can still both pass the claimed-check and bind the same line; the row
lock covers the same bank transaction, not the same journal line.
