# K-143 — auto-post undo counts reversals that reversed nothing

**Claim.** "A failed reversal still marks the run undone and is counted in the total."

**Disposition: confirmed, with a corrected mechanism.** The claim's headline is right; its stated
cause is wrong.

**What is NOT true.** A failed reversal is not counted in `reversed`. The catch at
`src/modules/accounting/services/bank/autoPostUndoService.ts:68-75` (origin/master) increments
`skipped`, and the run being stamped `undone_at` regardless is stated explicitly in both the file
header and the log line at line 70. That half is deliberate and documented.

**What IS true.** `reversed += 1` (line 67) sits after an `if` / `else if` pair (lines 53-62) that
both fall through when the row carries neither `matched_journal_line_id` nor `provisional_je_id`.
Nothing is reversed; only `auto_post_run_id = NULL` runs — and the row is counted as reversed.

That row shape is produced by the product: `unmatchTransaction`
(`bankTxStatusMutations.ts:99-104`) and `reverseReconciledTransaction`
(`bankAllocationService.ts:730-741`) both clear `matched_journal_line_id` and leave
`auto_post_run_id` set. A user who undoes one line by hand and then undoes the run is told the run
reversed N transactions when it reversed fewer.

**RED.** `tests/integration/k143-undo-counts-nothing-reversed.int.test.ts` — 1 failed of 1. The
setup goes through `unmatchTransaction`, asserts the stale `auto_post_run_id` survives, then calls
`undoRun`: expected `reversed: 0`, got `1`. Log: `red.log`.

**Reachability.** `pages/api/accounting/bank-auto-post.ts:91` returns `{reversed, skipped}` straight
to the operator as the count they reconcile against.

**Proposed minimal fix.** In the loop, only count a row that actually had something to reverse:
move `reversed += 1` inside the two branches, and give the fall-through case its own bucket
(`untagged`, or push it to `skipped` with reason 'nothing to reverse'). Separately, have
`unmatchTransaction` and `reverseReconciledTransaction` clear `auto_post_run_id` when they clear the
journal link, so the tag stops outliving the posting.

**Historical-data impact.** No wrong ledger rows — the miscount is a report, not a write. Read-only
census of rows carrying a stale tag today:
`SELECT COUNT(*) FROM bank_transactions
 WHERE auto_post_run_id IS NOT NULL AND matched_journal_line_id IS NULL AND provisional_je_id IS NULL;`

**Risks.** Changing the returned counts changes what the UI shows; check the auto-post panel's copy.
