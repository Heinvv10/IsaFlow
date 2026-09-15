# K-046 — year-end close crashes on any contra balance

**Claim.** Signed balances are written straight into debit/credit with no absolute value or
side swap, violating the non-negative CHECK.

**Corrected trigger.** True, and it is not the first failure the close hits.
`yearEndCloseService.ts:145` measures revenue as `credit - debit` and `:160` measures expense
as `debit - credit`. `yearEndJournalBuilder.ts:70-77` copies that signed number into `debit`
(revenue) or `credit` (expense) with no `Math.abs` and no side swap, while
`gl_journal_lines_debit_check` and `gl_journal_lines_credit_check` both require `>= 0`. The
`HAVING ... != 0` filters keep contra rows in, so a revenue account with a net debit balance
produces `debit: -500`. Separately and FIRST: `postClosingJournal` writes `source = 'year_end'`
(`yearEndCloseService.ts:234`), which `gl_journal_entries_source_check` does not list, so
every close of every company aborts at the header insert before any line is attempted. Both
are inside `withTransaction`, so nothing partial is written.

**Disposition: confirmed** (plus one blocking defect found in passing, above).

**Evidence.** Baseline `origin/master` = `0f16391e`; both files unchanged since `5661d6f0`.
RED test against the disposable fixture:
`tests/integration/k-046-year-end-contra-balance-negative-debit.int.test.ts` — 3 tests,
3 failed.
1. The dry-run preview returns the revenue line as `{ accountCode: '4000', debit: -500,
   credit: 0 }`.
2. Writing that exact preview line raises PostgreSQL `23514` on
   `gl_journal_lines_debit_check`.
3. The live `closeFiscalYear` rejects earlier with `23514` on
   `gl_journal_entries_source_check`, failing row `... year_end ...`.
Log: `docs/audits/remediation/K-046/red.log`.

**Reachability.** `closeFiscalYear` is the year-end close for every tenant, reached from the
year-end route and over MCP. Test 3 shows the close is currently impossible for ANY company;
test 2 shows that fixing the source alone still fails for any tenant with a contra P&L
balance.

**Proposed minimal fix.** Two lines, two files.
1. `yearEndJournalBuilder.ts:70-77`: derive the side from the sign —
   revenue `bal >= 0 ? { debit: bal, credit: 0 } : { debit: 0, credit: -bal }`, expense the
   mirror. `netIncome` and the totals need no change; the journal still balances.
2. Add `'year_end'` to `gl_journal_entries_source_check` in a new migration (next unused
   3-digit prefix, `DROP CONSTRAINT IF EXISTS` then re-add, following
   `scripts/migrations/sql/422_je_source_expense_claim.sql`).

**Historical impact.** No wrong rows anywhere: every close failed and rolled back. The impact
is the absence of closing journals — retained earnings is a computed residual and fiscal
periods that should be locked are not. Read-only impact query (not run here):
```sql
SELECT company_id, fiscal_year, count(*) FILTER (WHERE status <> 'locked') AS unlocked
FROM fiscal_periods GROUP BY company_id, fiscal_year HAVING count(*) FILTER (WHERE status <> 'locked') > 0;
```

**Risks.** Once both are fixed the close will actually write for the first time, and it LOCKS
every period in the year. Run `dryRun` per company and have the preview read before any live
close. The existing `ambiguous_retained_earnings` and `period_range_mismatch` guards stay.
