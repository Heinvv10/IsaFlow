# K-113 fix — a re-run of a year-end close no longer reads as a year that never traded

**Trigger.** `closeFiscalYear` had no already-closed check. The first close LOCKS every period,
which disarms the only period guard (`status = 'open'`), and it flattens the P&L, so the
aggregates' `HAVING … != 0` drops every account. The second dry run therefore returned
`netIncome: 0` with an empty journal — identical to a company that never traded — and the second
live call collided on `uq_gl_je_company_entry_number` as a raw 23505 / HTTP 500.

**Why it is closed here rather than left to its own branch.** K-046 removed what little signal
existed. Before it, a closed year's preview carried a `3200  0.00 / 0.00` retained-earnings line;
dropping that line (correctly — `validateJournalEntry` refuses it) replaced the signal with an
empty array. The live path was given a compensating lookup in the poster; the dry run, which is
the read that precedes the irreversible act, was not.

**Before / after.** `findClosingJournal` is now read in `closeFiscalYear` BEFORE the `if (dryRun)`
return and before the write. Dry run: `alreadyClosed` + `existingEntry` (MCP: `already_closed`,
`existing_entry_number`, `would_lock_every_period_in_year: false`). Live: an idempotent success
carrying the existing journal, `alreadyClosed: true`, and a message naming it. Nothing is written
and no period is locked. The hoist also covers the re-run the poster's lookup could never see —
P&L movement landing in a closed year makes the preview NON-EMPTY, so it used to run straight at
the INSERT and raise 23505.

**Divergence from the validator's proposal.** It proposed `error: 'already_closed'`. Delivered as
a SUCCESS with a flag instead: the live trigger the validation itself names is an MCP retry after
a timeout, and a retry that lands on "already done, here it is" is what makes the operation
idempotent. The reporting defect — a closed year indistinguishable from a dormant one — is carried
by the flag and the journal in both paths, which is what the finding is about. A REVERSED or DRAFT
`year_end` header is a different state and does get a refusal: `closing_journal_not_posted`.

**Files.** `src/modules/accounting/services/gl/yearEndCloseService.ts`,
`yearEndJournalPoster.ts` (`findClosingJournal`), `pages/api/accounting/year-end.ts` (409),
`src/lib/mcp/tools/writeFiscalPeriods.ts`, `pages/accounting/year-end/index.tsx`.

**Tests.** `tests/integration/k113-year-end-close-rerun.int.test.ts` — 3 on real Postgres: the dry
run reports `alreadyClosed` where a dormant control tenant with the identical `netIncome` and
identical empty preview reports `false`; the live re-run answers in its own vocabulary; a re-run
after post-close P&L movement does the same instead of 23505. Mutation MU-B (dry run blind again)
turns it red.

**Migration / rollback.** None.

**Historical data.** No wrong rows — `uq_gl_je_company_entry_number` prevented every double post.
What was wrong is operator belief: any year where a close was retried produced a "ready, R0.00"
preview. Read-only check (NOT run against production):

```sql
SELECT company_id, entry_number, COUNT(*) FROM gl_journal_entries
WHERE source = 'year_end' GROUP BY 1, 2 HAVING COUNT(*) > 1;  -- expected: zero rows
```

**Limits.** A year whose closing journal was reversed still cannot be re-closed by this service:
the entry number is unique per company with no status predicate, so a person must delete or
renumber that header first. The refusal says exactly that and names the row.
