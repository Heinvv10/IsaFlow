# K-143 — undo must not count a row it did not reverse

**Trigger.** A user undoes one auto-posted line by hand and then undoes the whole
run. `unmatchTransaction` and `reverseReconciledTransaction` both clear
`matched_journal_line_id` and leave `auto_post_run_id` set, so the run still sees
a row with nothing left to reverse.

**Before.** `reversed += 1` sat after an `if` / `else if` pair that both fall
through for such a row. All that happened was `auto_post_run_id = NULL`, and the
row was still counted as reversed — the number the operator reconciles against.
(The audit's stated cause was wrong: a FAILED reversal is already counted as
`skipped`, which the code and its log line say explicitly.)

**After.** `reversed` is incremented only in the two branches that actually
reverse something. A row with nothing to reverse increments a new `alreadyUndone`
count and is logged; its stale tag is still cleared, so a re-run does not report
the same phantom row twice.

**Files.** `src/modules/accounting/services/bank/autoPostUndoService.ts`.

**Tests.** `tests/integration/k143-undo-counts-nothing-reversed.int.test.ts` — 3
passed against a real database. `tests/unit/services/bank/autoPostUndoService.test.ts`
— 3 passed. Mutation proof in `green.log`.

**Migration.** None.

**Historical-data impact.** No wrong ledger rows — the miscount is a report, not
a write. Read-only census of rows carrying a stale tag today (not run here):
`SELECT COUNT(*) FROM bank_transactions
 WHERE auto_post_run_id IS NOT NULL AND matched_journal_line_id IS NULL
   AND provisional_je_id IS NULL;`

**Limits.** `UndoResult` gains a field, so `pages/api/accounting/bank-auto-post.ts`
now returns `alreadyUndone` alongside `reversed` and `skipped`. No UI reads it
(grep for `reversed` across pages/ and src/components/ finds no consumer of this
route's shape). The deeper correction the validator raised separately — having
`unmatchTransaction` and `reverseReconciledTransaction` clear `auto_post_run_id`
when they clear the journal link, so the tag stops outliving the posting — is NOT
done here: the validator's own RED test asserts that the stale tag survives, and
changing it is a behaviour call beyond this miscount.
