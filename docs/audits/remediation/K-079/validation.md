# K-079 — the payroll journal is unbalanced by exactly the ETI

**Claim.** The labour debit subtracts ETI but PAYE is credited in full, so any run with ETI never
posts while approval has already flipped the run.

**Corrected trigger.** `buildPayrollJournalPlan` sets
`labourDebit = gross + employerUif + sdl − eti` but credits `2140` at the full `paye`. Summing
the credits, with `otherDeductions = gross − paye − employeeUif − net`:

```
paye + uif + sdl + net + otherDeductions = gross + employerUif + sdl
debits                                   = gross + employerUif + sdl − eti
```

so debits fall short by exactly the ETI. The builder raises its own `unbalanced` blocker and
`payrollJournalPostingService` throws on the first blocker it finds. Posting is refused; the run
stays `approved` with `journal_entry_id` null. No wrong journal is written — the failure mode is
that the run cannot post at all, and there is no in-app route past it.

ETI is an offset against the PAYE remitted to SARS. The PAYE withheld from employees is still owed;
part of it is settled by the incentive rather than by cash. The reduction therefore belongs on the
2140 credit, matching the reduced labour debit that is already there.

**Disposition: confirmed.**

**Evidence** (`git show origin/master:<path>`; unchanged since 5661d6f0):
- `src/modules/accounting/services/payroll/payrollJournalBuilder.ts:121` the labour debit,
  `:195` the full PAYE credit, `:213-218` the blocker.
- `src/modules/accounting/services/payroll/payrollJournalPostingService.ts:64-68` throws on it.
- `tests/unit/services/payroll/payrollJournalBuilder.test.ts:132-153` — the repo already carries a
  test that documents this as a known finding and asserts the CURRENT broken behaviour. That test
  must be rewritten as part of the fix; it is not evidence that the behaviour is intended.

**Reachability.** Every pay run whose `total_eti` exceeds R0.01, through
`post_payroll_journal` and the payroll UI alike. The comment in the existing test says production
runs all carry `total_eti = 0.00`, which is consistent with K-080 (the ETI engine returns zero for
the low-wage employees who would qualify) and with the note in `etiEngine.ts:95` that every
`payroll_employees` row has a null `date_of_birth`. Production was not queried to confirm this.

**Proposed minimal fix.** One line: credit `2140` at `paye − eti` instead of `paye`. The labour
debit already carries the matching reduction, so the journal balances and the ETI never touches an
account of its own. Then rewrite the existing finding test to assert balance instead of imbalance.

**Historical-data impact.** None to correct. Nothing wrong was posted, because nothing posted at
all. What may exist is approved runs with no journal:

```sql
SELECT company_id, id, period_year, period_month, total_eti
FROM payroll_run_headers
WHERE status = 'approved' AND journal_entry_id IS NULL AND COALESCE(total_eti, 0) > 0.005;
```

NOT run against production. Once fixed, those runs post normally.

**Risks.** K-080 must land with or before this one. Fixing the engine without fixing the builder
turns a silently under-claimed incentive into a hard posting failure for every run.
