# K-049 — recurring-journal route returns 400 after the journal is written

**Claim.** Any throw becomes a 400, which withAuth commits, so the already-written journal survives
the apparent failure.

**Disposition: confirmed.**

## Evidence (baseline origin/master `0f16391e`)

- `pages/api/accounting/recurring-journals-action.ts:46` — one `try/catch` around the whole switch
  ending in `apiResponse.badRequestFromError(res, err, 'Action failed')`.
- `src/lib/auth/withAuth.ts:224-226` — `const handlerFailed = res.statusCode >= 500;` then
  `client.query(handlerFailed ? 'ROLLBACK' : 'COMMIT')`. A 400 COMMITs.
- `recurringJournalService.ts:88-95` — `createJournalEntry` (INSERT header + lines) runs first,
  `postJournalEntry` second. `postJournalEntry` throws `ClosedFiscalPeriodError`
  (`journalEntryPostingService.ts:94`) when the covering period is not open.

## Reachability

Any `generate` on a template whose covering period is closed. The captured log line in `red.log`
shows the exact chain: `postJournalEntry` → `generateJournalFromRecurring` → handler →
`API Response: POST ... - 400`.

## RED test

`tests/integration/k049-recurring-journal-400-commits-draft.int.test.ts` — 1 failed
(`expected [ { …(2) } ] to have a length of +0 but got 1`). The route answered 400 and a
`source='auto_recurring'` journal entry, read back on a separate pool connection, survived.

## Proposed minimal fix

Two independent changes, both small:

1. In the route, stop mapping every error to 400. Map the known request faults
   (`not found`, `not active`, closed period) explicitly and rethrow the rest so `withErrorHandler`
   answers 500 and withAuth rolls back.
2. In `generateJournalFromRecurring`, run the closed-period check BEFORE `createJournalEntry`
   (the depreciation run already does this in `depreciationRunPlan.resolvePeriod`), so the refusal
   lands before any write.

Fix 2 alone closes this instance; fix 1 closes the class for the other three actions.

## Historical-data impact

Orphan DRAFT journals with `source='auto_recurring'` and no matching `reclassification`/posting.
Read-only census:

```sql
SELECT company_id, id, entry_number, entry_date, created_at
FROM gl_journal_entries
WHERE source = 'auto_recurring' AND status = 'draft'
ORDER BY company_id, entry_date;
```

Drafts do not reach the trial balance, so no reported figure is wrong. They are clutter that a
later bulk-post could turn into real postings.

## Risks

Turning the closed-period case into a 500 makes it a logged incident rather than a user error. Fix 2
(pre-check, refuse with 400 before writing) avoids that and is the one to prefer.
