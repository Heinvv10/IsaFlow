# K-046 + R-027 fix — the year-end close can run at all, and survives a contra balance

**Trigger.** Two defects, both on `closeFiscalYear`.
R-027: `postClosingJournal` writes `source = 'year_end'`, which
`gl_journal_entries_source_check` never listed, so EVERY close of EVERY company aborted with
23514 at the header INSERT. K-046: `buildPreview` copied the SIGNED net balance straight into
`debit` (revenue) or `credit` (expense), so a P&L account carrying a contra balance produced
`debit: -500` and `gl_journal_lines_debit_check` rejected it with 23514.

**Before / after.** Before: no company could close a year; after admitting the source, any
tenant with one contra P&L account still could not. After: the close posts a balanced journal,
the side of each closing line comes from the SIGN of the net balance, retained earnings takes
the year's result, and every period in the year locks.

**The guard the constraint was providing.** Migration 509 excluded `'year_end'` on purpose:
this path INSERTs at `status='posted'` without `validateJournalEntry`, and `trg_gl_je_balanced`
is BEFORE UPDATE only, so nothing checked the result. Converting to
`createJournalEntry`/`postJournalEntry` is not available — the close requires every period
CLOSED and `postJournalEntry` refuses a period that is not OPEN. So `postClosingJournal` now
runs `validateJournalEntry` over the preview lines itself, before the transaction opens.
`'opening_balance'` and `'bank_transfer'` stay excluded on the original 509 grounds.

**Files.**
- `src/modules/accounting/services/gl/yearEndJournalBuilder.ts` — side from sign, both directions.
- `src/modules/accounting/services/gl/yearEndJournalPoster.ts` — NEW. The write, the period lock, `validateJournalEntry` before either, and the dormant/already-closed branch. Split out of `yearEndCloseService.ts` to stay under 300 lines.
- `src/modules/accounting/services/gl/yearEndCloseService.ts` — delegates the write; `CloseYearResult` gains `periodsLocked` and `alreadyClosed`, and `closingEntry` is nullable.
- `pages/api/accounting/year-end.ts` — `no_fiscal_period` and `period_range_mismatch` cases, plus a `never` default so the switch stays exhaustive over `CloseYearError`.
- `src/lib/mcp/tools/writeFiscalPeriods.ts` — `year_end_close` reports a null journal id for a dormant year instead of throwing on it.
- `src/modules/accounting/services/gl/.claude.md` + `AGENTS.md` — module rule + recent-changes entry.
- `src/modules/accounting/types/gl.types.ts` — `'year_end'` added to `GL_ENTRY_SOURCES`.
- `tests/unit/services/glEntrySourceConstraint.test.ts` — `year_end` off the dead list, pinned to the new guard.
- `scripts/migrations/sql/627_gl_je_source_year_end.sql` — new.

**Tests.** `tests/integration/k-046-year-end-contra-balance-negative-debit.int.test.ts` (3, the
validator's RED file) and `tests/integration/k-046-year-end-close-adjacent.int.test.ts` (6:
contra revenue end-to-end with balance/retained-earnings/lock assertions, second tenant
untouched, re-run reports the existing journal, contra EXPENSE mirror, BREAK-EVEN year, DORMANT
year) — 9 passed on real Postgres. `tests/unit/services/glEntrySourceConstraint.test.ts` (6),
`tests/unit/services/yearEndClosePostingGuard.test.ts` (3, NEW — behavioural cover for the
guard the source-text pin only greps) and `tests/unit/services/gl/yearEndInsertColumnsDb.test.ts`
(3) — 12 passed. Full unit suite 9438 passed, 0 failed. Four mutations each go RED; see
`green.log`.

**Round-2 review dispositions (2 MEDIUM, 4 LOW — all fixed).** MEDIUM-1: the year-end PAGE
hardcoded "Closing journal created" for every 200 and discarded the service's message; it renders
`data.message` now, covered by `tests/unit/components/yearEndCloseMessage.test.tsx` (4).
MEDIUM-2 = **K-113, closed in this branch** — see `docs/audits/remediation/K-113/fix.md`.
LOW-1: the inactive-account exemption is now pinned by tenant E, which closes a WITHDRAWN revenue
account and asserts the line is posted; mutation MU-F (adding `is_active = true` to the revenue
query) turns it red. LOW-2: the already-closed lookup reads the header in any status and branches
on it — posted means closed, reversed/draft is the new typed refusal `closing_journal_not_posted`
(a plain `AND status='posted'` would have sent that case to the INSERT and a raw 23505, because
`uq_gl_je_company_entry_number` has no status predicate). LOW-3: `periodsLocked` is a COUNT read
back from the lock UPDATE's `RETURNING`, agreed against the table in the tests.

**LOW-4 — migration prefix race.** 627 is free on `origin/master` (`53539623`, highest is 626),
but several remediation branches are in flight and 624/625 are unclaimed, so the number can be
taken between now and the merge. **Re-check `git ls-tree origin/master scripts/migrations/sql/`
at CI time and renumber only if 627 has actually been claimed** — the file, the fix docs and the
`.claude.md` entry all name 627, so do not renumber speculatively.

**Migration / rollback.** 627 drops and re-adds `gl_journal_entries_source_check` with the live
list plus `'year_end'`; idempotent, no data change. Rollback = re-apply 509 — safe only while
no closing journal has been written, since afterwards the constraint would reject existing rows.

**Historical data.** No wrong rows exist: every close failed inside `withTransaction` and rolled
back, so no `source='year_end'` row and no negative debit was ever committed. The damage is the
ABSENCE of closing journals — retained earnings is a computed residual and periods that should
be locked are not. Read-only query listing companies with a closed fiscal year and no closing
journal (NOT run against production):

```sql
SELECT fp.company_id, fp.fiscal_year,
       count(*) FILTER (WHERE fp.status = 'locked') AS locked_periods,
       count(*) AS periods
FROM fiscal_periods fp
WHERE fp.status IN ('closed', 'locked')
  AND NOT EXISTS (
    SELECT 1 FROM gl_journal_entries je
    WHERE je.company_id = fp.company_id
      AND je.source = 'year_end'
      AND je.entry_number = 'YE-' || fp.fiscal_year::text
  )
GROUP BY fp.company_id, fp.fiscal_year
ORDER BY fp.company_id, fp.fiscal_year;
```

**Review follow-up (blind review of `3222d0a6` + `c16abdde`).** HIGH-1 fixed: a BREAK-EVEN year
appended a `debit: 0, credit: 0` retained-earnings line that `validateJournalEntry` refuses, and
a DORMANT year produced an empty journal — neither could close. The retained line is now omitted
when the rounded result is zero, and a year with no lines at all locks its periods and writes no
journal. MEDIUM-1 answered as a stated exemption, not a change: the close deliberately does not
apply `assertNoInactiveAccountLines`, because closing a withdrawn account is how its balance is
zeroed and refusing would strand the tenant forever; the equity side needs no exemption because
`systemAccountResolver` caches only `is_active = true` accounts. The reason is written into the
poster, the module doc and the constraint test's rationale. MEDIUM-2 fixed in the route.
LOW-1 fixed: 627 is `NOT VALID` (the new list is a strict superset of the enforced old one, so
the ACCESS EXCLUSIVE scan buys nothing). LOW-2: 627 re-checked against `origin/master`
(`53539623`) and still free. LOW-3 fixed by the new behavioural unit test. LOW-4 fixed.
LOW-5: `origin/master` merged into the branch before the final gate run.

**Round-3 review dispositions (0 HIGH, 2 MEDIUM, 5 LOW — all 7 fixed, none disputed).**

- **M-1 — a closed year that gained P&L was reported as fully closed.** `CloseYearResult` gains
  `unclosedNetIncome`, and `alreadyClosedResult` appends a WARNING naming the amount, saying it is
  in neither the closing journal nor retained earnings and that no re-run can sweep it up. The MCP
  tool returns it as `unclosed_net_income`; the page renders the banner RED, not as a green tick.
- **M-2 — a squatted entry number restored the raw 23505.** `findClosingJournal` no longer filters
  `source`, matching `uq_gl_je_company_entry_number`, which has no predicate on source or status.
  A non-`year_end` row is the new typed refusal `closing_entry_number_taken`, naming the row and
  its source; route → 409, MCP → a "do not retry" tool error. Renumbering it unblocks the year.
- **L-1 — concurrent closes.** The header INSERT's 23505 is caught, the winner re-read, and the
  loser answers `alreadyClosed` instead of 500 — but ONLY when the winner is a POSTED `year_end`
  row; anything else rethrows. Writing that test exposed a second bug in M-1's own fix: the
  residual cannot be inferred from the `netIncome` the close read on the way in, because a caller
  that raced a close read the P&L BEFORE the winner wrote, and reporting that as money left
  outside equity raises the alarm on a year that is correctly closed. It applied to the ordinary
  already-closed path too, not only the race branch. `alreadyClosedResult` therefore RE-READS the
  P&L (`reloadNetIncome`) once the closing journal is known to exist; `netIncome` still reports
  what this call read.
- **L-2 — `periods_locked` meant two things.** The MCP tool now reports what THIS call locked
  (0 on an already-closed re-run) and the year's current count separately as
  `periods_locked_in_year`. The wrong comment is corrected.
- **L-3 — untyped MCP fixture.** The literal is replaced by typed `dryRun()` / `live()` builders,
  plus cases for the already-closed dry run, the dormant live result, the re-run counts and both
  refusal branches.
- **L-4 — a dormant year refused for want of a period.** `getFiscalPeriodIdForDate` is called only
  when `preview.lines.length > 0`. Unreachable in practice (the entry date IS a period's own
  `end_date`), so it is proved by unit test — the mock must not be called — not by outcome.
- **L-5 — an idempotent no-op was billed.** `withFlowMeter` gains `markFlowNoOp(req)`: a handler
  that answers 2xx having written nothing gets the debit refunded. The year-end route calls it on
  `alreadyClosed`, so an MCP timeout-retry loop is not billed per attempt.

**Round-3 files (in addition to the above).** `src/lib/mcp/tools/yearEndCloseRefusal.ts` (NEW —
the `year_end_close` refusal sentences, split out to keep `writeFiscalPeriods.ts` under 300
lines); `src/lib/billing/withFlowMeter.ts`; `pages/accounting/year-end/index.tsx`;
`src/modules/accounting/services/gl/yearEndJournalBuilder.ts` (`loadPLBalances` moved here so
`yearEndCloseService.ts` stays under 300 lines, plus `reloadNetIncome`).

**Round-3 tests.** NEW `tests/integration/k-046-year-end-entry-number-taken.int.test.ts` (4, real
Postgres: the squatter refusal, the identical dry-run refusal, renumbering unblocks the year with
a balanced journal tying to the year's result, and two `Promise.all` closes leaving ONE journal
with the loser raising no false residual). `k113-year-end-close-rerun.int.test.ts` extended to
assert the residual against the ledger. Unit: `yearEndClosePostingGuard.test.ts` +5,
`fiscalPeriodTools.test.ts` +5, `withFlowMeter.test.ts` +1, `yearEndCloseMessage.test.tsx` +1.
Eight mutations — one per finding — each go RED; see `green.log`.

**Migration prefix (unchanged, deliberately).** 627 collides with an unmerged local branch that
also claims it. Renaming is a MERGE-TIME action and must move three coupled references together:
this file, the `.claude.md`/`AGENTS.md` recent-changes entries, and — behaviourally —
`tests/unit/services/glEntrySourceConstraint.test.ts`, which resolves the owning migration by
HIGHEST numeric prefix among files mentioning `gl_journal_entries_source_check`. Renumbering it
BELOW another migration that redefines that constraint makes the test pin a stale list and pass.

**Limits.** REVERSAL/RE-OPEN of a closed year is still refused, not supported: a `year_end`
header in any non-posted status returns `closing_journal_not_posted` and a person must delete or
renumber it. Nothing stops a posted journal landing in a locked period — there is no DB trigger
refusing it — so `unclosedNetIncome` reports that state but cannot prevent or repair it. A LIVE
re-run no longer fails and no longer
masquerades as a dormant year: the poster looks the year's journal up by entry number and
returns it with `alreadyClosed: true`. No second journal is written; the adjacent test pins that. Once the close actually writes, running it LOCKS every period in the year — run
`dryRun` per company and read the preview before any live close.


## Round 5 — the eight findings of `review-k046-r4.md` (0 HIGH / 1 MEDIUM / 7 LOW)

- **MEDIUM-1 FIXED — the dry run of an already-closed year offered to post its residual.** The
  preview of a closed year is non-empty in exactly one case: P&L that landed in the year AFTER the
  close. The live call refuses to write it (the entry number is taken), but the tool returned it
  under `would_post` — a complete balanced journal, on the read an agent is told to make before
  authorising the irreversible half. `CloseYearDryRunResult` now carries `unclosedNetIncome`
  (RE-READ, for the same reason `alreadyClosedResult` re-reads), and `year_end_close` emits
  `would_post: null` plus `unclosed_net_income` when `already_closed`.
- **LOW-1 FIXED** — the `.claude.md`/`AGENTS.md` clause claiming the loser's residual "is passed as
  `0` explicitly" is gone; it described an implementation that does not exist and that a reader
  restoring it would use to kill the residual warning on the ordinary already-closed path.
- **LOW-2 FIXED** — `loadPLBalances` / `reloadNetIncome` take `Date | string`, and `yearRange` is a
  named `FiscalYearRange` rather than `Record<string, unknown>`, so passing the wrong object no
  longer compiles into a silently wrong residual.
- **LOW-3 FIXED** — `CloseYearResult.periodsLocked` → `periodsLockedInYear`, named for the meaning
  it actually has. The MCP tool still derives `periods_locked` (this call's work) from
  `alreadyClosed`; the REST route returns the result verbatim and no longer hands a consumer a
  field with two meanings.
- **LOW-4 FIXED** — deterministic cover for the residual re-read: a test drives
  `alreadyClosedResult` with a `netIncome` the ledger cannot produce (999999) and asserts the
  residual comes back as the ledger's 150. The mutation that reuses the caller's number now fails
  on a fixed assertion instead of on a scheduling artefact.
- **LOW-5 FIXED** — a squatter taking the number BETWEEN the lookup and the INSERT returns the same
  typed refusal the lookup returns (`classifyClosingJournal` is now shared by both) instead of
  rethrowing a raw 23505 → HTTP 500. A non-posted `year_end` winner returns
  `closing_journal_not_posted`; nothing holding the number at all still rethrows, because then the
  conflict is not the one the branch explains.
- **LOW-6 FIXED** — `X-Flow-Balance-After` is re-stated from `refundFlows`' `balanceAfter` in the
  refund branch, so a refunded no-op 2xx no longer advertises the charge it reversed. A FAILED
  refund leaves the debit balance standing, which is the true one.
- **LOW-7 FIXED** — "Seven mutations" corrected to eight, matching the commit message and
  `green.log`.

**Round-5 files.** `yearEndCloseService.ts`, `yearEndCloseTypes.ts` (NEW — the result/error shapes,
split out so the service stays inside the 300-line cap once the dry run gained its residual; the
service re-exports every name, so no importer changes), `yearEndJournalPoster.ts`,
`yearEndJournalBuilder.ts`, `writeFiscalPeriods.ts`, `withFlowMeter.ts`, `gl/.claude.md` + mirror.

**Round-5 tests.** NEW `tests/integration/k-046-year-end-squatter-race.int.test.ts` (1, real
Postgres and the real unique index; the lookup/INSERT window is opened deterministically by
blinding the FIRST `findClosingJournal` only). `k-046-year-end-entry-number-taken.int.test.ts` +2
(the deterministic residual re-read, and dry-run/live agreement on a closed year carrying R150).
Unit: `yearEndClosePostingGuard.test.ts` +2, `fiscalPeriodTools.test.ts` +1,
`withFlowMeter.test.ts` +2. Four round-5 mutations, each RED — see `green.log`.

## Round 6 — the four findings of `review-k046-r5.md` (0 HIGH / 1 MEDIUM / 3 LOW)

- **MEDIUM-1 FIXED, and the round-5 LOW-6 claim WITHDRAWN.** The refund branch runs after the
  handler, so on a real `ServerResponse` the headers are already sent: both `setHeader` calls
  threw `ERR_HTTP_HEADERS_SENT` *inside* the try whose catch logs `'flow refund failed after
  handler error'`, so a SUCCESSFUL refund emitted a false ERROR on every PAYG already-closed
  re-run — the very retry loop `markFlowNoOp` exists to make cheap. `refundFlows` now stands alone
  in the try (only genuine rejections reach the catch) and the header re-statement is guarded by
  `!res.headersSent`. The honest statement is therefore: **a client that has already been answered
  keeps the pre-refund balance**; the wallet is still correct and the next request reads the true
  figure. The round-5 claim that "a refunded no-op 2xx no longer advertises the charge it reversed"
  did not hold in production and is retracted. The mock `res` now models `headersSent` (and
  `json`/`end` set it), which is what made the dead assertion detectable.
- **LOW-1 FIXED** — `yearEndCloseRefusal` is a `switch (result.error)` with `year_not_found` as a
  named case and a `default` holding `const unhandled: never = result`, mirroring the REST route.
  A `CloseYearError` member added later now fails typecheck instead of reaching an unattended agent
  as the flatly false "Fiscal year N has no periods".
- **LOW-2 FIXED** — `netIncome` on the already-closed branches comes from the same post-lookup
  re-read that produces `unclosedNetIncome`, on the live path (`alreadyClosedResult` no longer
  takes it as a parameter) and on the dry run. A correctly closed year now reports
  `net_income: 0` beside `already_closed: true` instead of the racing caller's stale figure. The
  race test's loser assertion is consequently PINNED at 0 rather than `[0, 700]`.
- **LOW-3 FIXED at the service, not the tool** — `CloseYearDryRunResult` is a discriminated union
  on `alreadyClosed`: the closed branch is `preview: null` + `residualPreview`, the open branch
  `preview` + `existingEntry: null`. `writeFiscalPeriods` derives `would_post` from
  `result.preview === null`, so the null is structural. This also exposed the shape the finding
  predicted: `fiscalPeriodTools.test.ts` was proving `would_post: null` against a mock the service
  can no longer produce; its already-closed fixtures are now a typed `closedDryRun()` builder that
  points at the real-service integration cover.

**Round-6 files.** `withFlowMeter.ts`, `yearEndCloseRefusal.ts`, `writeFiscalPeriods.ts`,
`yearEndCloseService.ts`, `yearEndCloseTypes.ts`, `yearEndJournalPoster.ts`, `gl/.claude.md` +
mirror. No migration; 627 unchanged (see the prefix note above — a rename is a merge-time action
and must move this file, the `.claude.md`/`AGENTS.md` entries and
`tests/unit/services/glEntrySourceConstraint.test.ts`, which resolves the owning migration by
HIGHEST numeric prefix, together).

**Round-6 tests.** `withFlowMeter.test.ts` +1 (a handler that actually flushes: refund called,
NO error logged, balance header left at the debit). `k-046-year-end-entry-number-taken.int.test.ts`
— the residual re-read is now proved by MOVING the ledger between two calls on the same entry
(150 → 190 → restored) rather than by a 999999 sentinel the new signature cannot carry, plus
`preview === null` / `residualPreview` on the dry run. `k113-year-end-close-rerun.int.test.ts`
pins `preview === null`. `fiscalPeriodTools.test.ts` fixtures rebuilt on the union.
