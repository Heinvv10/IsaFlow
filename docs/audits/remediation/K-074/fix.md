# K-074 fix — bank-match-confirm: generated column write, and a committing 400

**Trigger.** Two defects in `pages/api/accounting/bank-match-confirm.ts`. (1) The supplier-invoice
branch assigned `balance`, which migration 201 declares
`GENERATED ALWAYS AS (total_amount - amount_paid) STORED`; Postgres refuses that with SQLSTATE
428C9 before looking at any row, so the branch could never reach its own subledger write. (2) The
catch-all answered every failure with `apiResponse.badRequest`. `withAuth` decides COMMIT vs
ROLLBACK on `statusCode >= 500`, and every throw reachable there happens at or after
`allocateTransaction` — which has already posted a journal, touched `bank_transactions` and may
have written a payment document. A 400 committed that half-finished match.

**Before / after.** Before: the supplier branch failed every time, and a post-write throw in any
branch committed a GL post with the document unpaid. After: the UPDATE omits `balance` (the
generated column follows `amount_paid`) and the catch-all returns `apiResponse.internalError`, so
`withAuth` rolls back. Pre-write refusals are plain `return`s and keep their 4xx.

**Files.** `pages/api/accounting/bank-match-confirm.ts`;
`tests/integration/k074-bank-match-confirm-supplier-balance.int.test.ts` (5 tests) — drives the real
handler against the production schema inside a request transaction, committing only below 500 the
way `withAuth` does. Covers full settlement, partial settlement with the generated balance checked,
a throw after the GL post answering 500 and NOT committing, a bill in another tenant refused 404
and untouched, and a money-IN line refused 400 before any write.

**Tests.** 5 integration tests on the real PostgreSQL fixture, full unit suite 9439 passed.
Mutation proof in `green.log`: re-adding `balance` turns 2 red, restoring the 400 turns 1 red.

**Migration / rollback.** None. Rollback is a straight revert of the route change.

**Historical-data impact.** None from the supplier branch: `balance` has been generated since the
table was created, so that write always aborted its own transaction and no partial row exists — the
absence is the evidence. The customer-invoice and purchase-order branches did succeed and carried
the ordering defect alone, which needs a non-SQL throw after the first write. I can give no
detection SQL for those: `bank_transactions` has no column linking a line to the document it
settled (`matched_journal_line_id` is a journal line, not the invoice), so a half-match is only
visible as an AR/AP subledger-versus-control-account difference, which is the existing
aging-vs-control reconciliation, not a query specific to this defect.

**Limits.** The 500 is deliberate — it makes the failure visible to `withAuth` and to error
tracking. Any caller that treated the old 400 message as user-facing validation now sees a 500.
