# K-079 — fix

**Trigger.** `buildPayrollJournalPlan` debited 5200 at `gross + employerUif + sdl − eti` but credited
2140 at the full `paye`, so every run claiming ETI was short on the debit side by exactly the ETI.
The plan raised `unbalanced` and `postPayrollRunJournal` threw. The approve route answered that
throw with a 400, and withAuth COMMITs a 4xx, so the `status = 'approved'` write it had already
made stuck: the run was approved with `journal_entry_id` NULL.

## Accounting decision (Hein, 2026-09-26)

The one-line fix from validation (`2140 = paye − eti`) balances only while ETI ≤ PAYE. ETI goes to
low-wage staff who mostly owe little or no PAYE, so ETI > PAYE is the ordinary ETI case:

| Run | paye | eti | 2140 under `paye − eti` | EMP201 `payePayable` |
|---|---|---|---|---|
| typical | 20 000 | 500 | 19 500 | 19 500 |
| low-wage staff | 300 | 2 500 | **−2 200** (a debit no EMP201 payment clears) | 0 |

`emp201Service.ts` floors PAYE payable at zero and carries no ETI forward. The repo also
contradicted itself on presentation: the builder netted ETI off labour, while
`figures.ts` (`payroll.employmentcost.v1`) and the old finding test said ETI is "an offset against
PAYE remitted rather than a reduction in cost". IAS 20.29 permits either. No chart of accounts has
an ETI income or receivable account.

Hein chose:
- **Cap at PAYE.** `etiUsed = min(eti, paye)`. DR 5200 and CR 2140 both fall by `etiUsed`, so CR
  2140 equals EMP201's `payePayable` exactly (`payroll_run_headers` is
  `UNIQUE (company_id, period_year, period_month)`, so one run is one EMP201 period). ETI beyond
  PAYE is not booked.
- **Net presentation.** ETI stays deducted from labour cost. There is no new account and no
  migration.

## Before / after

- **Builder** (`payrollJournalBuilder.ts`):
  - `etiUsed = round2(min(eti, paye))`;
  - labour debit `gross + employerUif + sdl − etiUsed`; 2140 credit `paye − etiUsed`;
  - `totals.etiUsed` reported alongside `totals.eti`;
  - ETI beyond PAYE raises an `eti_beyond_paye` **advisory** (not a blocker: Hein chose to cap, so
    the run posts).
- **Zero lines are dropped.** `validateJournalLine` rejects a line with neither debit nor credit.
  When ETI absorbs all of PAYE, 2140 is 0, so the decided treatment would still fail to post
  without this. The same rule fixes the SDL-exempt run (`sdl = 0` made a zero 2160 line that
  refused every such journal), which was not registered.
- **Refusals come before the first write** (`payrollApprovalService.ts`):
  - `approvePayrollRun` throws `PayrollApprovalRefusedError` for a missing run, a
    non-approvable status, and every plan blocker except `run_not_approved`
    (`findApprovalBlocker`), all before `UPDATE … status = 'approved'`.
  - `already_posted` is deliberately NOT excluded. An approvable-status run carrying a journal is
    unreachable (reversal clears the link), so refusing it fails closed.
- **Route** (`pages/api/payroll/runs/[id]/approve.ts`) answers only `PayrollApprovalRefusedError` as a 400
  and rethrows everything else, so a failure after the status write (e.g. a closed fiscal period,
  which is not a plan blocker) is a 500 and withAuth rolls the approval back.
- **Stranded runs recover in-app.** A run already stranded at `approved` with no journal is
  re-approvable (`alreadyApprovedButUnposted`, unchanged), and now posts.
- **MCP:**
  - `approve_pay_run` asks `findApprovalBlocker` before its dry-run branch, so preview and live
    refuse the same run (dry-run parity), and the live refusal is a `toolError` while nothing is
    written.
  - `post_payroll_journal`'s preview reports `employment_cost.eti_used`.
  - The tool description and `figures.ts` no longer describe the defect.
- `etiEngine.ts` is untouched (K-080 is Hein's SARS-table decision). With K-080 fixed, runs with
  ETI > PAYE become common; they post, with the advisory.

## Files

- `src/modules/accounting/services/payroll/payrollJournalBuilder.ts`
- `src/modules/accounting/services/payroll/payrollApprovalService.ts`
- `pages/api/payroll/runs/[id]/approve.ts`
- `src/lib/mcp/tools/writePayrollRun.ts`, `src/lib/mcp/tools/writePayroll.ts`, `src/lib/mcp/contracts/figures.ts`
- `src/modules/accounting/services/payroll/.claude.md`, `src/lib/mcp/.claude.md` (+ `AGENTS.md` mirrors)

## Tests

- `tests/integration/k079-payroll-eti-journal.int.test.ts`: 7 cases through the real route
  (withAuth, app_user, RLS, withCsrf, withWriteAccess), nothing mocked:
  - ETI < PAYE: balanced, posted, 2140 = 19 500, run linked;
  - ETI > PAYE: balanced, no 2140 line, labour reduced by 300 only;
  - ETI = 0: unchanged;
  - another tenant's run: 4xx, untouched, no journal in that tenant;
  - cancelled run: 400, untouched;
  - closed period (a post-write failure): 5xx, run still `calculated`;
  - missing 2175: 400, run still `calculated`.
- `tests/unit/services/payroll/payrollJournalBuilder.test.ts`: the old "ETI unbalances the journal"
  finding test (which asserted the defect) is rewritten as five cases: ETI below, above and equal
  to PAYE; no ETI; SDL-exempt.
- `tests/unit/mcp/payRunLifecycle.test.ts`: `approve_pay_run` refuses a blocked run, live and dry run.
- `tests/unit/mcp/payrollTools.test.ts`: `eti_used` in the preview.
- Evidence:
  - `red.log` (validation, unit) and `red.int.log`: 3/5 integration cases RED on `origin/master`
    code — ETI < PAYE, ETI > PAYE, and the run marked approved on refusal.
  - `green.log`.
  - `mutations.log`: 18/18 mutants RED, covering every changed code line, including the original
    defect (`2140 = paye`) and the old catch-all 400 in the route.

## Migration / rollback

None. Rollback is reverting the PR.

## Historical-data impact

None to correct. Nothing wrong was ever posted: every ETI run failed to post at all. Possible
residue: runs stranded `approved` with no journal (by ETI or by any other blocker, e.g. a missing
2175 or a zero SDL line). They post normally when re-approved after deploy.

Read-only census for Hein to run on prod. The agent never ran it.

```sql
-- 1. Runs stranded approved without a journal, any cause (K-079 expects the ETI ones to be 0: the ETI engine returns 0 today, K-080).
SELECT company_id, id, period_year, period_month, total_paye, total_eti, total_sdl, updated_at
FROM payroll_run_headers
WHERE status = 'approved' AND journal_entry_id IS NULL
ORDER BY company_id, period_year, period_month;

-- 2. The K-079 subset: stranded with ETI.
SELECT company_id, id, period_year, period_month, total_paye, total_eti
FROM payroll_run_headers
WHERE status = 'approved' AND journal_entry_id IS NULL AND COALESCE(total_eti, 0) > 0.005;

-- 3. How much ETI > PAYE exists today (the part the cap leaves unbooked).
SELECT company_id, COUNT(*) AS runs, SUM(total_eti - total_paye) AS eti_beyond_paye
FROM payroll_run_headers
WHERE COALESCE(total_eti, 0) > COALESCE(total_paye, 0) + 0.005
GROUP BY company_id;
```

## Follow-ups (not in this fix)

- EMP201 does not carry unused ETI forward to later months (SARS allows it). New register item.
- K-080: the ETI engine returns 0 below the wage floor; needs Hein's SARS-table decision.
- K-171 (candidate): the owner cash panel treats excess ETI as spendable cash.
