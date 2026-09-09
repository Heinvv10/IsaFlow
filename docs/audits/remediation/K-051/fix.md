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
