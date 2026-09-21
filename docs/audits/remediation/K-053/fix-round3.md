# K-053 round 3 — review findings on 017d0d08

Blind re-review of 017d0d08 (`scratchpad/review-k053-r2.md`): 2 HIGH, 3 MEDIUM, 3 LOW. All eight fixed.

**HIGH-1 — the undo posted a journal the delete never asked for.** Round 2 inferred what to re-instate from the reversal chain, so it could not tell a head this delete killed from one a user reversed on the GL screen (`journal-entries-action.ts` leaves the invoice pointing at the reversed original, where cancel NULLs the link); the undo then re-instated revenue and VAT output somebody had deliberately reversed, dated back into a closed period. The reversal id is now RECORDED (`soft_delete_journal_reversals`, migration **653**) and `reinstateInvoiceJournal` reverses that row's entry or nothing. The reviewer's probe is a test.

Fixing that exposed a second defect of my own: reading the linked entry's `reversed_at` to decide whether to reverse is wrong after one round trip, because the original stays marked reversed while the chain nets back to standing — a second delete would then leave the journal in the ledger. The DELETE direction therefore keeps the chain-parity read (standing at odd depth) and the UNDO direction uses the recorded row. Both directions are tested.

**HIGH-2 — the close-readiness tie flipped pass→fail.** `arSubLedgerCheck`/`apSubLedgerCheck` gained a predicate keeping a soft-deleted document exactly while its journal is still standing. The plain `deleted_at IS NULL` the finding proposed serves only the post-change population: **measured**, it passes the two new-era tests and FAILS the historical one, because a document deleted before this change kept its journal posted and the GL still carries it. This predicate passes all three and needs no historical data repair, which is why it was chosen over the literal instruction.

**MEDIUM-1 — half the cancel guard.** `assertInvoiceDeletable` now refuses on live payment allocations as well as `amount_paid`, both sides, using cancel's own subquery.

**MEDIUM-2 — silent skip.** An unexpected chain shape (zero or two un-reversed heads) and a link this company cannot reach both throw. A draft journal and an already-reversed chain are genuine no-ops and are logged.

**MEDIUM-3 — 500 on the undo.** Both catches in `soft-delete.ts` now share one `isUserFixable` predicate, so a period closed between the delete and the undo answers 400.

**LOW-1** `FOR UPDATE` on the entry actually being reversed, as both cancel paths do. **LOW-2** dated `core/.claude.md` entry, mirrors regenerated. **LOW-3** the three stale three-argument `softDelete` calls in `p21InputValidation.test.ts` pass `USER_ID`.

**Files.** `core/softDeleteJournalService.ts` (rewritten) · new `core/softDeleteInvoiceGuards.ts` (the row lock and refusals, split out for the 300-line cap) · `gl/closeReadinessChecks/{ar,ap}SubLedgerCheck.ts` · `pages/api/accounting/soft-delete.ts` · `core/.claude.md` + mirror · migration 653 · `tests/unit/services/p21InputValidation.test.ts`.

**Tests.** New `tests/integration/k053-soft-delete-undo-identity.int.test.ts` (8), `k053-close-readiness-tie.int.test.ts` (3) and `k053-dunning-cron-soft-deleted.int.test.ts` (1). With the four earlier files: **7 files, 28 tests**, all passing on fixture Postgres with migration 653 applied.

The cron test closes the gap rounds 2 and 3 left open. `sendDunning` is stubbed with `vi.mock`, so nothing is sent and no `dunning_sends` row is written, and the assertion is on the invoice ids the cron handed the sender rather than on the summary counters — the counters are global to the run, the ids are ours. The stub populating the array is itself the proof that the mock is in force.

**Mutation proof.** Seven reverts, each run and restored: round-2 chain inference on the undo → the manual-reversal identity test RED · close-readiness predicate removed → 3/3 RED · replaced by plain `deleted_at IS NULL` → 1/3 RED (the historical case) · allocation guard disabled → 2 RED · silent skip restored → 1 RED · undo 400 mapping removed → 1 RED (plus 1 cascade) · `FOR UPDATE` removed → the lock test RED · `deleted_at IS NULL` removed from `dunningCronService` → the cron test RED, the deleted invoice reaching the sender.

**Migration / rollback.** 653, applied to the fixture DB after dropping the table so the apply is proven from nothing. It was first written as 645, which collides with K-081's `645_loan_reclass_postings.sql` on an unmerged branch; renamed per the register. Additive: a new table, no column or constraint on an existing one. Rollback is `DROP TABLE soft_delete_journal_reversals` plus reverting the commit; the table is empty except while documents sit soft-deleted.

**Historical impact.** Unchanged from round 2 and NOT repaired here: documents soft-deleted before this change still carry a posted journal, so the GL sits over the subledger by that amount. The close-readiness predicate is written so those rows still tie, which is why no repair is required for the check to be correct. The read-only sizing query is in `fix-round2.md`.

**Limits.** The purge gap and the wider consumers listed in `fix-round2.md` remain out of scope.
