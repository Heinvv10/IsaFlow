# K-047 — depreciation journals post with a NULL fiscal period

**Claim.** `assetDepreciationPosting.ts:112` INSERTs `gl_journal_entries` directly, omitting
`fiscal_period_id`, `posted_at` and `posted_by`, making the journal invisible to period reports.

**Corrected trigger.** Migration 501 resolves the covering period on INSERT, so only an
uncovered date could produce an invisible journal.

**Disposition: false-positive on the headline; confirmed on the posting metadata.**

## Evidence (baseline origin/master `0f16391e`)

- `git show origin/master:scripts/migrations/sql/501_je_fiscal_period_autoresolve.sql` —
  `trg_gl_je_fiscal_period` BEFORE INSERT fills a NULL `fiscal_period_id` from the covering period.
- Direct psql against the fixture schema, mimicking the INSERT verbatim: a covered
  `entry_date` came back `fp_null = f`; an uncovered one `fp_null = t`; both
  `posted_at`/`posted_by` NULL.
- The uncovered case is unreachable from the live path.
  `depreciationRunPlan.ts:135-176` (`resolvePeriod`) returns a `no_period` blocker and the run
  refuses before anything is written; `period_closed` is a separate refusal.
- The legacy swallowing wrapper `postAssetDepreciationToGL` (which defaults the period to today)
  has **zero call sites**: `grep -rn 'postAssetDepreciationToGL\b' src/ pages/ tests/` returns only
  the definition and the re-export in `glCrossModuleHooks.ts:18`.
- `fix/audit-k027` tip `c9a490f3` changes this file (39+/19-) but touches neither the column list
  nor the period handling, so the finding stands or falls the same way on both.

## Reachability

Live path only: route/MCP tool → `depreciationRunService` → `postDualDepreciationToLedger` →
`postAssetDepreciationToGLThrows`. Guarded for period existence and period status.

## RED test

`tests/integration/k047-depreciation-journal-posted-metadata.int.test.ts` — 1 passed, 1 failed.
The passing test disconfirms the headline (period resolved). The failing one pins the residual:
`posted_at` and `posted_by` are NULL on a row written at `status='posted'`.

## Proposed minimal fix (low severity)

In `assetDepreciationPosting.ts`, add `posted_at, posted_by` to the INSERT column list and pass
`NOW()` and the resolved user uuid (`resolveUserUuid(userId)`, as `journalEntryPostingService.ts:122`
does). No other change: the period is already resolved by trigger and guarded by the run plan.

## Historical-data impact

Every `auto_depreciation` journal ever written carries NULL `posted_at`/`posted_by`. The audit
trail (`auditTrailLedgerService.ts:189`, `pages/api/accounting/journal-entries-audit.ts:44`) shows
them as unposted-by-nobody. No figure is wrong; the SARS audit trail is incomplete.
Read-only census (run on a non-production copy first):

```sql
SELECT company_id, COUNT(*) AS rows, MIN(entry_date), MAX(entry_date)
FROM gl_journal_entries
WHERE source = 'auto_depreciation' AND status = 'posted' AND posted_at IS NULL
GROUP BY company_id;
```

A backfill would set `posted_at = created_at`, `posted_by = created_by`. Human-gated.

## Risks

Backfilling `posted_at` invents a posting timestamp. Setting it equal to `created_at` is honest for
this path, because the INSERT posts in the same statement that creates.
