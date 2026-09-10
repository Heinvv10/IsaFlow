# K-113 — re-running a year-end close previews a false zero, then 500s

**Claim.** No already-closed guard; the preview shows a zero retained-earnings line and the live call
collides on the fixed entry number.

**Corrected trigger.** Both halves confirmed. The audit's "the `status = 'open'` check at :101 still
passes" is right for the reason stated: the first close set every period to `locked`, and the guard
only looks for `open`.

**Disposition: confirmed.**

## Evidence
- Baseline `origin/master` = `31fc2f10`; `git diff HEAD origin/master` is empty for
  `yearEndCloseService.ts` and `yearEndJournalBuilder.ts`.
- `yearEndCloseService.ts:99-114` — the only period guard, `status = 'open'`.
- `:143-171` — revenue/expense aggregates carry `HAVING … != 0`, so accounts the first close zeroed
  drop out entirely; `:173-175` then computes `netIncome` 0.
- `yearEndJournalBuilder.ts:87` — `entryNumber: \`YE-${yearLabel}\``, fixed, with no existence check.
- `:249-252` — the close LOCKS every period in the year, which is what disarms the guard next time.
- Fixture schema: `uq_gl_je_company_entry_number ON gl_journal_entries (company_id, entry_number)`.
- RED: `tests/integration/k113-year-end-close-rerun.int.test.ts` — 2 tests, 2 failed. Log: `red.log`.
  - Half one: second dry run returns `{ dryRun: true, netIncome: 0, preview }` — no `error` field.
  - Half two: live second call throws
    `23505 duplicate key value violates unique constraint "uq_gl_je_company_entry_number"`.
  - The first close in the same test posts correctly at `netIncome` 600, so the fixture is not
    failing for an unrelated reason.

## Reachability
Both the UI year-end route and the MCP close tool. An MCP retry after a timeout is the likely live
trigger, and the dry run is the screen a user reads before authorising the second attempt.

## Proposed minimal fix
`src/modules/accounting/services/gl/yearEndCloseService.ts`, immediately after the open-periods guard:
1. `SELECT id, entry_date FROM gl_journal_entries WHERE company_id = … AND entry_number = 'YE-'||year AND status <> 'cancelled'`.
2. Return a new `{ error: 'already_closed'; closingEntryId; entryDate }` member of `CloseYearError`
   when a row exists — before the aggregates run, so the dry run refuses too.
3. Surface it at the route and MCP boundary as a 409, not a 500.

## Historical-data impact
No wrong rows: the unique index prevented every double post. What is wrong is operator belief — any
year where a close was retried produced a "ready, R0.00" preview. Read-only check:
```sql
SELECT company_id, entry_number, COUNT(*) FROM gl_journal_entries
WHERE source = 'year_end' GROUP BY 1, 2 HAVING COUNT(*) > 1;  -- expected: zero rows
```
NOT run against production.

## Risks
A company that genuinely re-opens a year and re-closes it needs a documented route (cancel or reverse
the existing YE journal first). The guard must key on a non-cancelled entry so that route stays open.
