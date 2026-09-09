# K-140 — one failed row must not abort the whole auto-post sweep

**Trigger.** Two people work the same statement, or an import runs while someone
allocates. `allocateTransaction` opens with `SELECT … FOR UPDATE` under
`SET LOCAL lock_timeout = '5s'`, outside its own `withTransaction`, so a
contended row raises a real Postgres error inside the request transaction.

**Before.** `sweep` wrapped each row in a bare `try/catch` with no savepoint.
The first Postgres error aborted the request transaction; the catch swallowed it
and carried on, so every later row failed 25P02 and reported a skip reason about
the abort rather than about itself. The final COMMIT was a rollback that threw
away the posts the sweep had already made, while the response still said success.

**After.** Each row runs inside `withSavepoint('auto_post_gate_line', …)`, as the
sibling rule sweep already did. A failed row rolls back alone; the rows around it
post and survive the COMMIT. `runId` is restored on rollback, because `ensureRun`
INSERTs the run row inside the savepoint and a rolled-back row would otherwise
leave the in-memory id pointing at a row that no longer exists. The
"JE posted but run-tag failed — JE orphaned" branch is removed: the savepoint now
takes the JE and the tag back together, so that state can no longer arise.

**Files.** `src/modules/accounting/services/bank/autoPostGateService.ts`.

**Tests.** `tests/integration/k140-autopost-sweep-no-savepoint.int.test.ts` — 3
passed against a real database (validator's case plus a later-row failure and a
declined row). `tests/unit/services/bank/autoPostGateService.test.ts` — 38 passed
(its `@/lib/neon` mock gained a pass-through `withSavepoint`). Mutation proof and
full-suite totals in `green.log`.

**Migration.** None. Prefix 652 was reserved for this item and is not used — it
is free again.

**Historical-data impact.** No wrong rows: an aborted transaction writes nothing.
The damage is silent non-work — sweeps reported as successful that posted nothing.
Read-only smell test (not run here):
`SELECT id, created_at, posted_count, total_amount FROM bank_auto_post_runs
 WHERE posted_count IS NULL OR posted_count = 0 ORDER BY created_at DESC;`

**Limits.** One savepoint round trip per row, at the same cardinality the rule
sweep already pays. If the ROLLBACK TO SAVEPOINT itself fails, `withSavepoint`
marks the context unusable and the next row fails naming that cause — correct,
but the sweep then skips its remaining rows.

---

# Blind review round 1 — disposition per finding

Reviewer's rulings on K-142 (not the same defect) and K-143 (fix complete) accepted;
neither was reopened. Every H/M/L below was fixed on this branch.

| # | Disposition | Where | Proof |
|---|---|---|---|
| H-1 | FIXED | `bankRulesMatchingService.ts` — the suggestion arm now `CROSS JOIN unnest`es the `toSqlPattern` output beside each rule id, so both arms run the identical escaped pattern. | `tests/integration/k141-suggestion-arm-like-metacharacters.int.test.ts` (5) |
| M-1 | FIXED | Migration **657** `uq_bank_tx_matched_line`, partial unique on `(company_id, matched_journal_line_id)`, plus a savepoint round the UPDATE so the 23505 maps onto `BankMatchTargetError('LINE_CLAIMED')` and leaves the request transaction usable. Application check kept for the clean 400. | `tests/integration/k144-concurrent-double-binding.int.test.ts` (3) — two real pool clients, interleaved |
| M-2 | FIXED | `assertMatchTargets` raises typed `BankMatchTargetError`; `autoMatchTransactions` skips `LINE_CLAIMED` into `skippedRaced` and still rethrows everything else. | `tests/unit/services/bank/autoMatchRaceHandling.test.ts` (5) |
| M-3 | FIXED | `isEmptyPeriodEnvelope` makes the guard format-aware: OFX `<BANKTRANLIST>` with no `<STMTTRN>`, QIF `!Type:` with no `^`, MT940 `:20:` with no `:61:` are empty periods, not failures. A body with no envelope is still refused. | `tests/unit/bank/k145-non-csv-parse-guard.test.ts` (10) |
| M-4 | FIXED | `bank-rules-preview.ts` builds its ILIKE with `toSqlPattern`, so the previewed count is the count the rule acts on. | `tests/unit/api/bankRulesPreviewEscapesPattern.test.ts` (5) |
| M-5 | FIXED | `autoPostUndoService.undoRun` wraps each row in `withSavepoint('auto_post_undo_line', …)`, as `sweep` now does. | `tests/integration/k140-undo-run-no-savepoint.int.test.ts` (2) |
| L-1 | FIXED | `autoPostGateService.ts` 395 → 291 lines: settings accessors + `autoPostRunSnapshot` moved to `autoPostSettingsService.ts` (127) and re-exported, so no call site moved. | existing 38-test gate suite still green |
| L-2 | FIXED | `importBankStatement` now routes through `parseStatement`, inheriting `requireTransactions`. | `tests/unit/services/bankReconciliationService.test.ts` (37) |
| L-3 | FIXED | Both bare `.rejects.toThrow()` assertions in the K-144 file pinned to `/not found/i` and `/already matched to/i`. | same file (6) |
| L-4 | FIXED | `si.deleted_at IS NULL` / `ci.deleted_at IS NULL` on both invoice candidate queries. | `tests/integration/k142-match-candidate-filters.int.test.ts` (3) |
| L-5 | FIXED | PO candidates filter `('approved','partially_received')` — the statuses the CHECK constraint actually allows. | same file |

**Migration.** 657 `657_bank_tx_matched_line_unique.sql`, applied to the fixture DB and
mutation-proved by dropping the index. It first RELEASES the losing side of any existing
double-binding (ranked reconciled → allocated → matched, then `created_at`, then id;
partitioned by `company_id` so it never compares across tenants) and rewinds `status` only
for rows that were merely `matched`. Rollback: `DROP INDEX uq_bank_tx_matched_line;` — the
released links are not restored by that and would need the impact query below.

**Historical-data impact.** Rows already double-bound before 657 lose the duplicate link.
Read-only census to run before applying (NOT run here):
`SELECT company_id, matched_journal_line_id, COUNT(*), array_agg(id), array_agg(status)
 FROM bank_transactions WHERE matched_journal_line_id IS NOT NULL
 GROUP BY company_id, matched_journal_line_id HAVING COUNT(*) > 1;`
Over-matched suggestions written by the unescaped suggestion arm are not corrected by this
branch; rows whose `suggested_category` names a rule whose `match_pattern` contains `_` or
`%` are the ones to re-examine:
`SELECT bt.id, bt.description, r.rule_name, r.match_pattern
 FROM bank_transactions bt JOIN bank_categorisation_rules r
   ON r.company_id = bt.company_id AND r.rule_name = bt.suggested_category
 WHERE bt.company_id = $1 AND r.match_pattern ~ '[_%]';`

**Limits.** The QIF envelope test uses a multi-line `!Type:`/`!Option:` body on purpose — a
one-line QIF is already exempt via the line count, so it would not exercise the new branch.
`bank-rules-preview` is proved at the bound-parameter level (mocked DB), not end to end.
