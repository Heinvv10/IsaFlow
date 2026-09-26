# K-079 — fix

**Status: decided, not yet built (2026-09-26).** Hein chose A1 + B1:
- `etiUsed = max(0, min(eti, paye))`; DR 5200 = gross + employerUif + sdl − etiUsed; CR 2140 = paye − etiUsed (= EMP201 `payePayable`).
- ETI beyond PAYE is not booked. Planned: an `eti_beyond_paye` advisory, and EMP201 carry-forward as a new register item.
- Keep net presentation. Correct the stale defect text in `src/lib/mcp/contracts/figures.ts:291` and `src/lib/mcp/tools/writePayroll.ts:106`, and the payroll `.claude.md` formula.
- Next: RED integration test via `pages/api/payroll/runs/[id]/approve.ts` (approvePayrollRun → postPayrollRunJournal), with fixture style from `tests/integration/k022-*.int.test.ts`. Then rewrite `tests/unit/services/payroll/payrollJournalBuilder.test.ts:132-153`.

## Why the one-line fix is not enough

Validation proposed crediting `2140` at `paye − eti`. That balances only while ETI ≤ PAYE. ETI goes
to low-wage employees, who mostly owe little or no PAYE, so ETI > PAYE is the ordinary case, not
an edge:

| Run | paye | eti | 2140 credit under `paye − eti` | EMP201 `payePayable` |
|---|---|---|---|---|
| typical | 20 000 | 500 | 19 500 | 19 500 |
| low-wage staff | 300 | 2 500 | **−2 200** (a debit) | 0 |

`emp201Service.ts:171-173` floors the payable at zero ("SARS caps the claim at the PAYE withheld
for the month"). It carries no excess forward. Under the one-line fix, the second run leaves
R2 200 debit in 2140 that no EMP201 payment ever clears. `payroll_run_headers` is
`UNIQUE (company_id, period_year, period_month)`, so one run is one EMP201 period and the two
figures can be tied exactly.

## The repo disagrees with itself on presentation

- `payrollJournalBuilder.ts:121` (and the line descriptions in `payrollJournalParts.ts:93` and
  `payrollJournalSplitBuilder.ts:97`) reduce the labour DEBIT by ETI. That is net presentation:
  the grant is deducted from the expense it relates to.
- `src/lib/mcp/contracts/figures.ts:291` (`payroll.employmentcost.v1`) calls ETI "an offset
  against PAYE remitted rather than a reduction in cost". The existing finding test
  (`payrollJournalBuilder.test.ts:137-140`) says "the correct treatment reduces CR 2140, not
  DR 5200". That is gross presentation: full cost in 5200, with ETI credited somewhere else.
- No chart-of-accounts seed has an ETI income or receivable account.

IAS 20.29 permits either. Both are accounting decisions, not code decisions.

## Options

**A. ETI beyond PAYE**
1. *(recommended)* Book only the ETI used against this run's PAYE: `etiUsed = min(eti, paye)`.
   DR 5200 is reduced by `etiUsed` and CR 2140 = `paye − etiUsed` = EMP201 `payePayable`. The
   excess is not booked, which matches EMP201, which also does not carry it forward. EMP201
   carry-forward becomes its own register item.
2. Book the full ETI, so 2140 goes into debit when ETI > PAYE: a claim on SARS carried forward.
   2140 then stops reconciling to EMP201 until EMP201 carries the excess forward.
3. Block posting when ETI > PAYE. This fails closed, but the ordinary ETI run cannot post.

**B. Presentation**
1. *(recommended)* Keep net presentation (DR 5200 reduced by the ETI booked). No new account and
   no migration. `figures.ts` is corrected to match.
2. Gross presentation: DR 5200 at full cost, CR a new "ETI income" account. This needs a
   migration seeding the account for every tenant, plus a missing-account blocker for tenants
   without it.

## Census (read-only; for Hein to run on prod — never run by the agent)

```sql
-- Approved runs stranded without a journal because of ETI (expect 0; the ETI engine returns 0 today, K-080).
SELECT company_id, id, period_year, period_month, total_paye, total_eti
FROM payroll_run_headers
WHERE status = 'approved' AND journal_entry_id IS NULL AND COALESCE(total_eti, 0) > 0.005
ORDER BY company_id, period_year, period_month;

-- Any run where ETI exceeds PAYE (decides how much option A matters today).
SELECT company_id, COUNT(*) AS runs, SUM(total_eti - total_paye) AS eti_beyond_paye
FROM payroll_run_headers
WHERE COALESCE(total_eti, 0) > COALESCE(total_paye, 0) + 0.005
GROUP BY company_id;
```
