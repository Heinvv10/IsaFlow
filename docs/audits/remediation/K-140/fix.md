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

**Migration.** 657 `657_bank_tx_matched_line_unique.sql` — see the round-2 table below for
its corrected dedupe pass. Rollback: `DROP INDEX uq_bank_tx_matched_line;`.

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


---

# Blind review round 2 — disposition per finding

The reviewer independently VERIFIED H-1 (both LIKE arms byte-identical across `_`, `%`,
backslash and all-`%`), the 23505 name check, and the savepoint's connection recovery; those
were not redone. Every finding below was fixed on this branch.

| # | Disposition | Where | Proof |
|---|---|---|---|
| H-A | FIXED | Migration 657's dedupe pass. The rank is swapped so `allocated` (the one status meaning an allocation posted a journal for THIS row — `bankTxStatusMutations.ts:29-36`) outranks `reconciled`, so the owner keeps the line. And a loser whose status is not `'matched'` is no longer released at all: a `DO` block RAISEs, naming every such `company/line/tx/status`, so the migration fails loudly and a human unwinds one side. The UPDATE is now predicated `AND bt.status = 'matched'` as well, so no row can end carrying a status that claims an allocation it no longer has. | `tests/integration/k144-migration-657-dedupe.int.test.ts` (8) — runs the real migration file against planted shapes inside a rolled-back transaction: allocated+matched and reconciled+matched release the matched loser to `imported`; allocated+reconciled, two allocated, two reconciled and allocated+excluded all RAISE; the refusal names the reconciled borrower and not the allocated owner; a single binding is untouched and the index still builds |
| M-A | FIXED | 657 makes two racers block on the INDEX where they never contended before, and that wait is bounded by `lockBankTransactionForUpdate`'s 5s `lock_timeout` — so a slow peer hands the UPDATE a raw `55P03`, not a 23505. `matchTransaction`'s inner catch now maps `55P03` to `BankMatchTargetError('LINE_CLAIMED')` (a `lock_timeout` on THIS statement can only mean the line is claimed), and `BankTransactionLockTimeoutError` joins `autoMatchTransactions`' `raced` set. | `tests/integration/k144-match-line-lock-timeout.int.test.ts` (1) — a real peer holding past 5s; `autoMatchRaceHandling.test.ts` (6) |
| M-B | FIXED | `green.log`'s round-2 NOTE corrected: round **2**'s working tree broke those three files, not round 1's; round 1's timeout attribution stands. | `green.log` |
| L-A | FIXED | `rulePattern()` (`bankRulesSuggestionPass.ts`) is the one place a rule row becomes a pattern, for both arms, and reads `String(rule.match_type ?? 'exact')` — matching the old SQL's NULL fall-through instead of widening it to `contains` via `String(null) === 'null'`. | `k141-suggestion-arm-like-metacharacters.int.test.ts` (7) — two new NULL cases |
| L-B | FIXED | `bankRulesMatchingService.ts` 331 → 268: the suggestion arm moved to `bankRulesSuggestionPass.ts` (98). No call site moved. | `bunx tsc --noEmit` clean; the seven rule-related unit suites green |
| L-C | FIXED | Both `/not found/i` assertions pinned to `Journal line <id> not found`, which `lockForStatusWrite`'s `Bank transaction <id> not found` can no longer satisfy. | `k144-match-unvalidated-journal-line.int.test.ts` (5) |
| L-D | FIXED, with a correction to the finding | `isEmptyPeriodEnvelope`'s QIF arm also requires no `^D`/`^T` record lines. Measured: a WELL-FORMED QIF missing only its final `^` already parses correctly (the parser flushes the trailing record), so that specific case was never silently zeroed. The reachable hazard is a file carrying record lines the parser could NOT read and no `^` at all — that was exempted as an empty period and imported as zero rows. | `k145-non-csv-parse-guard.test.ts` (11) |
| L-E | FIXED (documented) | The `CREATE UNIQUE INDEX` stays non-`CONCURRENTLY` — the release pass must share its transaction, and `CONCURRENTLY` cannot run in a transaction block — but the trade is now stated in the file: ACCESS EXCLUSIVE on `bank_transactions` for the build, so 657 is a maintenance-window deploy. | migration header |
| L-F | FIXED | `bank/.claude.md` gains the auto-post family (`autoPostGateService`, `autoPostSettingsService`, `autoPostUndoService`), `bankRulesSuggestionPass` / `bankRulesMatchingHelpers`, the real `applyRules(companyId, bankAccountId, userId, ruleIds?)` signature and `rulePattern`'s NULL rule. Mirror regenerated. | `bun run agent-docs:check` — OK: 74 mirrors match |

**Migration choice.** 657 was CORRECTED in place rather than followed by 661. It is unpushed,
unmerged and has never run anywhere but this fixture DB, so no deployed checksum exists to
conflict with; and a follow-up cannot undo a one-shot destructive UPDATE that 657 would have
already performed. Prefix 661 stays free.

**Historical-data impact (revised).** 657 no longer writes anything unless a loser is
`status='matched'`; every other double-binding stops the deploy with the rows named. Run the
census below first — if it returns zero rows, 657 is a pure index build:
`SELECT company_id, matched_journal_line_id, COUNT(*), array_agg(id), array_agg(status)
 FROM bank_transactions WHERE matched_journal_line_id IS NOT NULL
 GROUP BY company_id, matched_journal_line_id HAVING COUNT(*) > 1;`
