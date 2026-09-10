# K-051 fix — a merge may not turn its target into a header account

**Trigger.** `mergeAccounts(company, source, target)` where the target is an asset, liability or
equity account at `level < 3` and the source has direct children (they are reparented onto the
target), or where the target is already such an account with children and the source brings
something to move.

**Before.** `assertMergeable` never read `level`. The merge reparented the children, the target
acquired children, and `balanceSheetService.ts:120-128` / `trendRowsService.ts:174-175` — which
select an account only when `level >= 3 OR it has no children` — stopped returning it. Total assets
in the fixture went from R1,500 to R0 while the trial balance was unchanged.

**After.** `assertTargetStaysOnTheReports` throws `AccountMergeError('target_becomes_header')`
before anything is written, and runs AFTER the cycle check so a descendant target still reports
`target_is_descendant_of_source`. Three cases stay admitted, each with a test: level 3+ targets
(the reports select them regardless of children); revenue and expense targets (the income statement
applies no level filter, so nothing disappears); and a source with neither children nor journal
lines, which contributes nothing to move — the same refinement `accountParentRules` makes.

**Files.**
- `src/modules/accounting/services/gl/isReportVisibleLeaf.ts` (new; shared with K-052; owns
  `BALANCE_SHEET_LEAF_LEVEL`, moved here out of `accountParentRules.ts`, and
  `LEAF_RULE_ACCOUNT_TYPES`)
- `src/modules/accounting/services/gl/accountMergeGuards.ts` (guard + `target_becomes_header` code)
- `src/modules/accounting/services/gl/accountMergeService.ts` (comment only: why the existing row
  lock already closes the concurrent-chart-edit window)
- `src/modules/accounting/services/gl/accountParentRules.ts` (the THIRD guard: same type
  scoping, and its refusal no longer names the balance sheet for an expense parent)

**Tests.** `tests/integration/k051-account-merge-into-header-hides-balance.int.test.ts` — 12 tests,
real disposable Postgres. The refusal with the balance sheet unchanged and the child unmoved; an
already-header target refused when the source carries lines; the same target admitted from an empty
source; a R300 balance merged into a leaf target and asserted ON the target's own balance-sheet
line; a level-3 target that HAS children admitted; a level-2 expense header admitted; a descendant
target reported as a cycle; another tenant's child ignored; and a two-connection proof that
`FOR UPDATE` on the target blocks both a child INSERT and a reparent UPDATE with `55P03`. Two
more close mutations the earlier round left alive: a Sage level-1 CHILDLESS target taking a
source that carries R120, and `assertParentUsable` admitting a posted level-2 expense parent
while still refusing the asset one. Round 4 adds the parent-lock race: one connection holds
`FOR UPDATE` on an empty level-2 asset parent and posts its first line, a second connection's
`assertParentUsable` is proven to be still BLOCKED when the first commits (a 150 ms race against
the pending promise, not a sleep-and-hope), and it then refuses on the settled row.

**Migration.** None.

**Concurrency — THE MERGE PATH ONLY.** The blind review asked for a post-write re-read of the
guard. In `mergeAccounts` it is unreachable: `gl_accounts_parent_account_id_fkey` references
`gl_accounts(id)`, so a concurrent `createAccount` or `reclassifyAccount` naming the target as
parent takes FOR KEY SHARE on the target row, which conflicts with the merge's FOR UPDATE. It
waits, lands after the merge, and `assertParentUsable` then refuses it because the target carries
posted lines. Proved, not assumed. This does NOT carry to the reclassification, which locks the
journal lines and not the account — see K-052's fix.md; that path takes its own FOR UPDATE.

**`assertParentUsable` now locks its parent too, and that is what makes the paragraph above true.**
Ordering a transaction is not deciding it: `createAccount` formed its verdict before its INSERT
took FOR KEY SHARE and never re-read, so the blocked INSERT resumed and committed a child onto an
account that had acquired posted lines while it waited — the header this guard exists to refuse,
reproduced with two clients. The `FOR UPDATE` is taken BEFORE the posted-lines read, under the same
level/type narrowing (an expense chart edit still takes no lock), so the second transaction reads
the settled row. It requires a request transaction; every production caller of `createAccount` and
`reclassifyAccount` — the POST route, the row editor and the two MCP tools — runs inside one.

**Historical-data impact.** Merges already performed into a level <= 2 asset/liability/equity
target have removed that account's balance from the balance sheet and the trend report. No debit or
credit is wrong, so the remedy is a chart edit (give the target a leaf child, or raise its level),
not a ledger correction. Read-only census, not run against production:

```sql
SELECT m.id, m.company_id, m.target_account_id, ga.account_code, ga.level, m.created_at
FROM gl_account_merges m
JOIN gl_accounts ga ON ga.id = m.target_account_id AND ga.company_id = m.company_id
WHERE ga.level < 3
  AND ga.account_type IN ('asset','liability','equity')
  AND EXISTS (SELECT 1 FROM gl_accounts c
               WHERE c.parent_account_id = ga.id AND c.company_id = ga.company_id);
```

**Limits.** The guard mirrors the reports' predicate as it stands today; a report that changes its
own selection rule must change this helper with it. Accounts already sitting under a header are not
repaired by this change.

## Round-4 dispositions (blind re-review `2cc28c2f`)

| Finding | Disposition |
|---|---|
| MED-1 — the target lock was taken on the PREVIEW path both files say it must not be | **Fixed.** `GuardInput.lockCandidateLines` is required and decides the account lock as well as the line lock, so a preview holds nothing; `planFromArgs`'s pre-write catch now also translates `GL_ACCOUNT_LOCK_TIMEOUT`, which would otherwise reach the agent as GENERIC_FAILURE. Three new DB tests without a request transaction (preview admits, preview still refuses a header, expense target admits on the write path) and two new unit tests on the catch. Removing the flag from the condition fails 2 tests; removing the type narrowing fails 1; narrowing the catch back fails 1. |
| MED-2 — the lock was one-sided, so the window was ordered, not closed | **Fixed.** `assertParentUsable` takes the mirror `FOR UPDATE` on the parent before its posted-lines read. The reviewer's interleaving is now the new K-051 test, and it goes red with the lock removed. |
| LOW-1 — the mock's `accountType` is not load-bearing while the comment says it is | **Fixed.** The comment in `reclassificationLockSequence.test.ts` now names `level` as the load-bearing field and says the type is realism at level 3. |
| LOW-2 — the concurrency test leaks its transaction when it fails | **Fixed.** The race test has the same `catch { ROLLBACK }` as the file's `admit()` helper. Re-run under the reviewer's own mutation (lock the SOURCE): the test fails in 6 ms, `afterAll` does not block, and the fixture DB is left with zero `K05*` rows and zero idle-in-transaction connections. |
| LOW-3a — the type narrowing that keeps expense targets lock-free was unproven | **Fixed** by the write-path expense test above. |
| LOW-3b — `company_id` on `assertParentUsable`'s posted-lines read is unproven | **Dispute OVERTURNED in round 5 — see below.** The premise was wrong in both halves: nothing prevented the row, and `POST /api/accounting/journal-entries` wrote it. |


## Round-5 dispositions (blind re-review `0d0f4897`)

| Finding | Disposition |
|---|---|
| MED-1 — a caught `GL_ACCOUNT_LOCK_TIMEOUT` leaves the transaction ABORTED, so the registry's `RELEASE SAVEPOINT` raises 25P02 and the agent gets GENERIC_FAILURE anyway | **Fixed.** Both locks now run in their own `withSavepoint` — the target account (`planGuards.ts`) and the candidate lines (`plan.ts`, which had the same latent shape). A caught SQL error does not un-poison a transaction; only a savepoint rollback does. `k052-reclassification-lock-savepoint.int.test.ts` proves it end-to-end: a second connection genuinely holds the target for the full 5s `lock_timeout`, the REAL write tool runs inside `withSavepoint(savepointNameFor('post_reclassification_batch'), ...)` exactly as `registry.call` does, and the caller receives the typed refusal naming the account while a later query on the same transaction still succeeds. Reverting the wrap makes it fail with `current transaction is aborted`. |
| LOW-1 (was LOW-3b) — the `company_id` scope is right and nothing proves it | **Fixed, and the cross-tenant write behind it is closed.** The reviewer's live path is real: `createJournalEntry` stamped `company_id` from the session and `gl_account_id` from the request body with no ownership check. Two defences now: `accountsBelongToCompany` at the service every journal creation goes through (the same check `create_draft_journal` always had), and **migration 664**, a composite FK `(gl_account_id, company_id) -> gl_accounts(id, company_id)`, NOT VALID so it enforces every future write without scanning history. The scope test the reviewer asked for is the fourth case in `k051-cross-company-journal-line.int.test.ts`: the pre-664 row is built with `session_replication_role='replica'` in a rolled-back transaction, `assertParentUsable` admits, and the balance sheet agrees at R0. Both mutations (drop the ownership check; drop the `company_id` scope) go red. |
| LOW-2 — the catch tests drive the tool that cannot reach the catch | **Fixed.** Both moved to `post_reclassification_batch`, plus a third for `RECLASS_LINE_LOCKED`, all asserting `postReclassBatch` was never called. |
| LOW-3 — the K-051 test file is 408 lines | **Fixed.** Split: the verdicts stay (261 lines), the two-connection tests move to `k051-account-merge-header-concurrency.int.test.ts` (209) with their own fixture. `OPENING_ASSETS` drops 2475 -> 2285 accordingly. |
| LOW-4 — the comments overstate `validateLeafAccount` | **Fixed.** Both comments now say it runs on the expense-claim posting route and nowhere else, and that these guards are the control rather than a second line of one. |
| LOW-5 — the target lock is taken before the cheap refusals | **Fixed.** The header block moved BELOW the period, VAT-subtype and VAT-lock refusals, so a request that was never going to proceed holds nothing. |

**Migration.** `664_gl_journal_lines_account_company_fk.sql` — composite FK, NOT VALID, `IF NOT EXISTS` guarded, applied to the fixture DB and proved to refuse the pair. Rollback: `ALTER TABLE gl_journal_lines DROP CONSTRAINT gl_journal_lines_account_company_fk`.

**Historical-data impact of 664.** NOT VALID leaves existing rows untouched, so nothing breaks on deploy. Census first; `VALIDATE CONSTRAINT` (SHARE UPDATE EXCLUSIVE only) is a separate decision once it returns zero. Read-only, NOT run against production:

```sql
SELECT jl.company_id AS line_company, ga.company_id AS account_company,
       COUNT(*) AS lines, SUM(jl.debit + jl.credit) AS gross
FROM gl_journal_lines jl
JOIN gl_accounts ga ON ga.id = jl.gl_account_id
WHERE ga.company_id <> jl.company_id
GROUP BY 1, 2 ORDER BY gross DESC;
```

Such a row is a cross-tenant ledger line: the other company's account carries a balance it did not post, and this company's trial balance names an account it does not own. `balanceSheetService` filters all three of `jl.company_id`, `ga.company_id` and `je.company_id`, so neither balance sheet shows it — the trial balance and any single-filter report are where it surfaces.

**Blast radius of 664 — four fixtures outside this item.** Four integration tests deliberately build the cross-company row to prove some OTHER guard ignores it (`k019-import-autolink`, `k019-transfer-relink`, `opening-balances-postgres`, `k020-reconciled-balance-recompute`). They are still correct — 664 is NOT VALID, so those rows survive in production — but the fixture can no longer be written normally. Each now goes through `tests/integration/helpers/preConstraintRow.ts`, which suppresses the FK trigger for one transaction. No production code was changed for them. The whole integration suite was swept afterwards: zero `gl_journal_lines_account_company_fk` violations.

## Round-6 dispositions (blind re-review `31ae8c7da`, 0 HIGH / 3 MEDIUM / 5 LOW)

| Finding | Disposition |
|---|---|
| MED-1 — the commit pushes `journalEntryCrudService.ts` to 320 lines, past the 300 ceiling | **Fixed.** The check and its comment move to `src/modules/accounting/services/gl/journalLineOwnership.ts`; the call site is one line. The file is back to exactly 300 — which it was at the merge base, so the two `journalEntryMeta` imports (value + type) are folded into one line to pay for the call. |
| MED-2 — `project_id`, `cost_center_id` and `bu_id` on the same INSERT are caller-supplied, carry NO foreign key, and were unvalidated | **Fixed.** `assertJournalLinesOwned` now checks all three against `projects` / `cost_centres` / `business_units`, each `company_id`-scoped, before anything is written. Refusal wording names the dimension. Three tests in `k051-cross-company-journal-line.int.test.ts`: a foreign cost centre is refused and writes nothing, a foreign project is refused, and this company's OWN cost centre still posts (the guard fails in both directions). Mutation: dropping the cost-centre check makes the first go red. |
| MED-3 — no test goes red if `withSavepoint` is removed from the LINE lock in `plan.ts` | **Fixed.** A third case in `k052-reclassification-lock-savepoint.int.test.ts` contends the seeded `gl_journal_lines` row from a second connection, with a childless LEVEL-3 asset target so `isSubjectToLeafRule` is false and the account lock is skipped — the line lock is the only one contended. Asserts `isError`, `'retry'` in the text, and `SELECT 1` still returning on the runner transaction. Mutation: unwrapping `plan.ts:145` fails it with `current transaction is aborted` at `RELEASE SAVEPOINT`. |
| LOW-1 — `preConstraintRow` suppresses every user trigger, not just the FK, and its comment says otherwise | **Fixed.** The doc comment now names `trg_gl_jl_balance_update` -> `update_account_balances()` as also suppressed, and tells the next caller to assert on `gl_journal_lines` or re-run the balance maintenance itself. |
| LOW-2 — the four rerouted fixtures now need a superuser | **Fixed as a diagnosis, not a skip.** `session_replication_role` is SUSET-context; the helper catches `42501` and rethrows naming the requirement and the disposable fixture DB, instead of a bare `permission denied to set parameter`. Not gated behind a `rolsuper` probe on purpose: silently skipping these four would drop the only coverage that another tenant's pre-664 line is ignored, and the failure is loud either way. |
| LOW-3 — 664 depends on 489's unique index without creating it | **Fixed.** `CREATE UNIQUE INDEX IF NOT EXISTS gl_accounts_id_company_uq ON gl_accounts (id, company_id);` prepended to the ALTER. Re-applied to the fixture DB: `NOTICE: relation already exists, skipping`, then the DO block, both idempotent. |
| LOW-4 — stale test filename in a comment | **Fixed.** `reclassificationSavepoint.int.test.ts` -> `k052-reclassification-lock-savepoint.int.test.ts`. |
| LOW-5 — K-052's census omits the `account_type` filter the shipped guard applies | **Fixed** in `docs/audits/remediation/K-052/validation.md`: `AND ga.account_type IN ('asset','liability','equity')`, matching `isSubjectToLeafRule` and K-051's own census. |

**Limit on the MED-2 fix.** It validates the three dimensions the LINE carries. `sageImportService` passes `slt.ff_project_id` through as `projectId`; that column does not exist on `sage_ledger_transactions` in this schema, so the path is unreachable today — but an import that resurrects it must map to a `projects` row of the same company or the journal is now refused. No historical-data impact: the check is on the write path only, existing rows are untouched, and the dimensions carry no constraint to validate against.

## Round-7 dispositions (blind re-review `3db6a07e7`, 0 HIGH / 1 MEDIUM / 3 LOW)

| Finding | Disposition |
|---|---|
| MEDIUM-1 — the new dimension guard also fires on `reclassification/journals.ts`'s copy-forward of a HISTORICAL dimension, so one legacy cross-company tag unwinds the whole batch | **Fixed by scoping the guard to what it is for.** The check is an assertion about what a CALLER claims on a new line, and a copy-forward is not a claim. `plan.ts` now resolves the three dimensions once per batch through `ownedDimensions` and drops (nulls) any the company does not own — `reclassification/dimensions.ts` — before `buildReclassJournals` sees them. Nothing else changes: every other `createJournalEntry` caller is still refused. Rejected the alternative of leaving the refusal in place: it strands exactly the rows K-051 created, and aborts a 400-journal batch for one tag. Rejected quarantining the whole line: the amount still has to move. **What dropping costs is nothing this company reports** — an id it does not own matches no dimension filter it can run, so the original was already outside every one of its dimension reports, and both legs lose the tag together so the contra and the re-application net to zero in the untagged bucket. It is not silent: `log.warn` per line, and a `foreign_dimension_dropped` warning on the plan, which the PREVIEW carries too (same code path, so dry-run parity holds). |
| LOW-1 — the `business_units` arm has no test | **Fixed.** Two cases in `k051-cross-company-journal-line.int.test.ts`: a foreign `buId` is refused and writes nothing, an own `buId` posts. Mutation: deleting the `business unit` line from `assertJournalLinesOwned` turns the first red. |
| LOW-2 — up to four serialized round trips per journal on a looping path | **Partly addressed, accepted for the rest.** The reclassification path now pays three dimension SELECTs for the WHOLE batch instead of up to three per journal. The per-journal `accountsBelongToCompany` SELECT stays: hoisting it out of `createJournalEntry` would take the guard off the other 38 call sites, which is the defect this item exists for. |
| LOW-3 — the 300-line ceiling is met by cosmetic packing | **Accepted, no action** (the reviewer requested none). `journalEntryCrudService.ts` is at 300 and the next line added to it forces a further split. Noted here so that split is a decision rather than a surprise. |

**Both directions, proved on the disposable fixture DB.** `k051-reclassification-foreign-dimension.int.test.ts` seeds a posted source line tagged to another company's project, cost centre AND business unit, plus a second line tagged to this company's own cost centre. The batch posts; the foreign-tagged pair carries NULL on all three columns on both legs and nets to zero; the own cost centre is carried forward unchanged; the journals balance to R1,400 debit = R1,400 credit; the source account nets to zero; the original posted line is untouched. Mutations: pass `movable` instead of `carried.lines` and the batch dies with "name a project outside this company" (the reported defect, reproduced); make the keep-predicate drop everything and the own-cost-centre assertion goes red.

**Unrelated, not touched:** `plan.ts` declares `export interface ReclassPlan` twice with identical members (pre-existing at the merge base; TypeScript merges them silently).

## Round-8 dispositions (blind re-review `f48b2b663`, 1 HIGH / 0 MEDIUM / 3 LOW)

| Finding | Disposition |
|---|---|
| HIGH-1 — `reverseJournalEntry` is the SECOND copy-forward path and still aborted on a legacy foreign dimension, so such an entry could never be reversed | **Fixed, and the whole class enumerated (below).** `journalEntryPostingService` no longer maps the historical lines itself: `gl/reversalLines.ts` builds the contra, resolving the three dimensions once per entry through `ownedDimensions` and dropping what this company does not own — per line, per dimension. **The round-8 wording of this row, of the commit message and of the `reversalLines.ts` comment was WRONG about what that costs** ("both legs lose the tag and net to zero in the untagged bucket"): that holds for the reclassification path, where both legs are newly written, and NOT for a reversal, which writes only the contra and leaves the original tagged. Corrected in round 9 — see MEDIUM-1 below and **Limits**. `log.warn` per line, and the count rides back on the returned entry (`foreignDimensionDroppedLines`), which the REST action route already passes straight through and the MCP tool renders as a `foreign_dimension_dropped` warning in the LIVE response and in the DRY RUN, computed the same way. The account arm stays refusing on this path: a line needs an account, so there is nothing to drop, and migration 664's composite FK refuses the mirrored row regardless — that failure is the FK's, not the guard's. |
| LOW-1 — "there is no read-side disclosure" is contradicted by an unscoped join | **Fixed both ways.** The claim in `journalLineOwnership.ts` now names `projectProfitabilityService` and `ar/invoicePdfBuilder` as the exception, and both `LEFT JOIN projects` clauses are scoped (`AND p.company_id = jl.company_id` / `ci.company_id`), so a foreign tag keeps its bucket but no longer renders another company's project NAME. |
| LOW-2 — "already outside every one of its dimension reports" is not quite true for the one report that enumerates raw ids | **Fixed.** `reclassification/dimensions.ts` now says "no dimension report it can meaningfully run" and states what `getProjectProfitability` actually does with a foreign id, before and after a drop. |
| LOW-3 — duplicate `export interface ReclassPlan` | **Left, as the reviewer ruled.** Pre-existing at the merge base; a separate cleanup. |

**The copy-forward census — enumerated from the WRITERS of `gl_journal_lines` and the readers of `project_id` / `cost_center_id` / `bu_id`, not by grepping for the guard.**

| Path | Where the dimension comes from | Disposition |
|---|---|---|
| `reclassification/plan.ts` -> `journals.ts` | a posted `gl_journal_lines` row | copy-forward — drop-and-warn (round 7) |
| `journalEntryPostingService#reverseJournalEntry` (and its 12 call sites: invoice/credit-note cancel, payment void, bank allocation undo, provisional dismiss, payroll, the REST action route, the MCP tool; `creditNoteApproveService` imports it and never calls it — a pre-existing dead import, mentioned not deleted) | a posted `gl_journal_lines` row, via `mapLineRow` | copy-forward — **drop-and-warn (this round)** |
| `core/archiveExecutionService` | `gl_journal_lines` | reads them into `archive_gl_journal_lines`; writes no journal line, no guard involved |
| `gl/yearEndCloseService`, `pages/api/accounting/bank-transfers`, `gl/assetDepreciationPosting` | nothing — their INSERTs name no dimension column | not a copy-forward |
| `gl/recurringJournalService`, `core/recurringTransactionService` | a template, which carries no dimension | not a copy-forward |
| `pages/api/accounting/journal-entries` (POST), MCP `create_draft_journal`, `glImportExecuteService` (resolves a cost-centre CODE against this company's own `cost_centres`), the migration/Sage importers | the request body or an import file | caller-claim — guard applies, unchanged |
| `capture/provisionalPostingService` (predicts from `supplier_coding_history`), `ap/supplierInvoiceWorkflowService` and `expense/expenseClaimService` (from the document being posted) | a NON-journal-line table | caller-claim — guard applies. A foreign tag there refuses the posting, which is recoverable: the source row is editable and the document can be posted after correcting it. No `gl_journal_lines` value reaches these paths |
| `gl/accountMergeService#repointMovableLines` — the only production `UPDATE gl_journal_lines` | an existing posted line | sets `gl_account_id` and `updated_at` only, leaving all three dimension columns as they are — not a copy-forward |
| `pages/api/.../journal-entries` UPDATE | there is none — journal ENTRIES have no update path | n/a |

**Files (this round).** `src/modules/accounting/services/gl/reversalLines.ts` (new, 79 lines) · `journalEntryPostingService.ts` (uses it; returns `ReversalEntry`) · `journalLineOwnership.ts` (`ownedOrNull`, shared by both copy-forward paths; boundary comment) · `reclassification/dimensions.ts` (uses `ownedOrNull`) · `src/lib/mcp/tools/writeJournalReverse.ts` (warning, dry run + live) · `reports/projectProfitabilityService.ts`, `ar/invoicePdfBuilder.ts` (scoped joins).

**Tests.** `tests/integration/k051-reversal-foreign-dimension.int.test.ts` — 4 tests, real disposable Postgres: the foreign-tagged entry reverses (contra untagged on all three columns, debits = credits, the pair nets to zero on the account, the original keeps `status='posted'` with `reversed_at` set, and the posted line is untouched); an OWN cost centre is carried forward with `foreignDimensionDroppedLines === 0`; a CALLER naming another company's project on a new line is still refused with nothing written; and the MCP dry run emits the same `foreign_dimension_dropped` warning while writing nothing. `tests/unit/services/gl/journalEntryReversal.test.ts` — one new case (an unowned `buId` is dropped, not refused) and the existing business-unit case now primes the ownership SELECT. Mutations: copy the dimensions raw -> 2 integration tests red (the live one with the reported defect verbatim); make `droppedLineCount` never increment -> the same 2 red; copy raw -> the new unit case red. Full unit suite with `DATABASE_URL` unset: **9439 passed / 234 skipped, 0 failed**. All 7 K-051/K-052 integration files: 42 passed. `k021-reversal-atomicity`: 6 passed.

**Migration.** None this round (664 unchanged).

**Historical-data impact.** No existing row changes. Reversals that were REFUSED between this branch's first commit and this fix were never written, so there is nothing to repair; from here they post with the foreign tag left off the contra only. Census of the entries that were affected (read-only, NOT run against production):

```sql
SELECT je.company_id, je.id, je.entry_number, COUNT(*) AS foreign_tagged_lines
FROM gl_journal_entries je
JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id AND jl.company_id = je.company_id
WHERE je.status = 'posted' AND je.reversed_at IS NULL
  AND (
    (jl.project_id     IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects p       WHERE p.id  = jl.project_id     AND p.company_id  = jl.company_id))
 OR (jl.cost_center_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cost_centres c   WHERE c.id  = jl.cost_center_id AND c.company_id  = jl.company_id))
 OR (jl.bu_id          IS NOT NULL AND NOT EXISTS (SELECT 1 FROM business_units b WHERE b.id  = jl.bu_id          AND b.company_id  = jl.company_id))
  )
GROUP BY 1, 2, 3 ORDER BY 4 DESC;
```

**Limits.** The REST reversal surfaces the drop as a field on the response and a `log.warn`; there is no UI element rendering it yet. The two scoped report joins remove a NAME disclosure, not the bucket: a foreign `project_id` still forms an unnamed row in `getProjectProfitability`, which is the pre-existing behaviour for any id `projects` does not match.

## Round-9 dispositions (blind re-review `2eff04c92`, 0 HIGH / 1 MEDIUM / 6 LOW)

| Finding | Disposition |
|---|---|
| MEDIUM-1 — the justification for the drop is FALSE on the reversal path, and `getProjectProfitability` keeps an unreversed figure | **Statement corrected, residual declared.** The reviewer is right: "both legs lose the tag and net to zero in the untagged bucket" describes the RECLASSIFICATION path, where the contra and the re-application are both newly written. A reversal writes only the CONTRA and leaves the original posted line tagged (this file's own test asserts that), so the pair sits in two buckets and does not net. `reversalLines.ts` now says exactly that, per path, and names the one report where it shows: `getProjectProfitability` groups by raw `jl.project_id` and excludes untagged lines, so the original keeps its unnamed foreign bucket at the full amount and the contra falls into no bucket at all. The tag is NOT carried — `assertJournalLinesOwned` refuses it and 664's composite FK refuses the row — so this is a residual, now in **Limits**, and the round-8 row above is corrected in place. |
| LOW-1 — a dry run logs a mutation it did not perform | **Fixed.** `buildReversalLines(companyId, lines, { preview: true })` from the MCP preview path; the warn then reads "Reversal preview: … would be dropped (nothing written)". `tests/unit/services/gl/reversalLines.test.ts` — 3 tests (preview wording, write wording, nothing logged when everything is owned). Mutation: collapse the ternary to the write message and the preview test goes red. |
| LOW-2 — two census imprecisions | **Fixed.** "13 callers" -> 12 call sites, with `creditNoteApproveService`'s dead import named; `accountMergeService#repointMovableLines` added as its own census row with the reason it is outside the class. |
| LOW-3 — the account arm leaves a population with no stated remedy | **Fixed** — one line under **Limits**. |
| LOW-4 — the module doc declares the old return type | **Fixed.** `gl/.claude.md` now shows `reverseJournalEntry(..., opts?: { postingAgent?, reversalDate? }): Promise<ReversalEntry>` and lists `reversalLines.ts` and `reversalDate.ts`; `bun run agent-docs:generate` re-run, `agent-docs:check` green (74 mirrors). |
| LOW-5 — the commit grows an already-oversized file | **Fixed, not accepted.** `resolveReversalDate` + `isCalendarDate` move to `gl/reversalDate.ts` (new) and `ReversalEntry` to `reversalLines.ts`; both are re-exported from `journalEntryPostingService`, so no import anywhere moved. That file is now **256** lines (was 351, and 343 at the merge base). |
| LOW-6 — the LIVE MCP `warnings` field is never asserted | **Fixed.** A fifth case in `k051-reversal-foreign-dimension.int.test.ts` runs the tool for real: `wroteNothing` falsy, `foreign_dimension_dropped` in the LIVE payload, and the written contra's three dimension columns NULL. Mutation: delete `warnings:` from the live response object and it goes red. |

**Round-9 gate.** `k051-reversal-foreign-dimension` 5 passed; all 6 K-051/K-052 files plus `k021-reversal-atomicity` and `k021-failed-reversal-commits-unwind`: 38 passed. Full unit suite with `DATABASE_URL` unset: **9442 passed / 234 skipped / 0 failed**. `bunx tsc --noEmit` clean; `bunx eslint` clean over the four changed `src` files. No migration this round (664 unchanged).

**Limits (round 9, added).**
- **A reversal does not take a foreign project bucket to zero.** Only the contra drops the tag; the original keeps it. `getProjectProfitability` therefore still shows the original's amount in an unnamed bucket after the entry is reversed, with no offsetting line in that report. Trial balance, balance sheet and income statement are unaffected — none reads a dimension unless the user supplies a filter, and a filter can never name an id this company does not own. The remedy is a data fix on the posted line (repoint or clear `project_id`), not a ledger correction: no debit or credit is wrong.
- **An entry whose line names another company's GL ACCOUNT is still un-reversible.** The account cannot be dropped (a line needs one) and 664's composite FK would refuse the mirrored row anyway. Remedy: repoint that line to an account this company owns first — the census SQL above finds them — and the reversal then succeeds.

