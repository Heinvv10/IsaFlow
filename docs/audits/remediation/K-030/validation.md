# K-030 — Loan schedule cache hash ignores every financial term

**Claim (AA C):** `buildInputsHash` covers the loan id, events and rate points
only, so editing principal, rate or term returns the pre-edit amortisation to
every money path.

**Corrected trigger:** accurate as written. The one refinement is the blast
radius: the stale row is not only returned to callers of
`getOrComputeSchedule`, it is also the row GL posting selects, because
`loanGlPostingService` takes the LATEST `loan_schedule_runs` row and no new run
is ever inserted after an edit.

**Disposition: confirmed.**

## Evidence (`git show ebeac9ca:<path>`)
- `src/modules/accounting/services/loans/loanScheduleService.ts:88-91` —
  `JSON.stringify({ loan: loan.id, events, points })`. Principal, `fixed_rate`,
  `margin`, `term_months`, `start_date`, `residual`, `day_count`,
  `reprice_mode`, `skip_mode`, `lump_mode` and `recurring_skip_months` are all
  absent, yet every one of them feeds `loanRowToInputs` at lines 52-70.
- Lines 152-172: a hash hit returns the persisted `loan_schedule_rows` and never
  re-runs `amortise`.
- `src/modules/accounting/services/loans/loanService.ts:280-303` — `updateLoan`
  writes principal, start date, term, rate mode, margin, fixed rate, residual,
  day count and the three mode columns, and deletes no cached run.
- `src/modules/accounting/services/loans/loanGlPostingService.ts:163-172` — the
  interest/principal journal is built from the latest run's rows, so the stale
  schedule reaches the general ledger, not just the screen.
  `loanComplianceService.ts:259` and `loanPeriodCloseService.ts:147` read the
  same runs.
- File unchanged between 5661d6f0 and ebeac9ca.

## RED test
`tests/integration/k-030-loan-schedule-cache-hash.int.test.ts` — 1 failed / 1 total.
Computes a schedule for a real R100 000 / 60-month / 12% loan, then UPDATEs the
row to R250 000 / 84 months / 18% and asks again. Fails at the claimed reason:
the second call returns `cached: true` and the original 60-period, R100 000
schedule. Output: `docs/audits/remediation/K-030/red.log`.

## Proposed minimal fix
Hash the terms that drive the engine. In `buildInputsHash`, replace `loan.id`
with the `LoanInputs` object the engine actually consumes:
```ts
const payload = JSON.stringify({ engine: ENGINE_VERSION, loan: loanRowToInputs(loan), events, points });
```
and include `ENGINE_VERSION` so an engine change also busts the cache. Order the
event and point fields explicitly rather than spreading raw `DbRow`s, so an
`updated_at` touch does not gratuitously miss.

## Historical-data impact
Any loan edited after its first schedule computation still has only the pre-edit
run, and journals posted from it are wrong. Read-only scope query:
```sql
SELECT l.company_id, l.id, l.reference, l.updated_at, MAX(r.computed_at) AS last_run
FROM loans l JOIN loan_schedule_runs r ON r.loan_id = l.id
GROUP BY 1,2,3,4 HAVING l.updated_at > MAX(r.computed_at);
```
Cross-check those loan ids against `loan_gl_postings` to size the ledger impact.

## Risks
Fixing the hash invalidates every existing cached run, so the next read
recomputes and the figures on screen will move for affected loans. That is the
correction, but it should be communicated rather than shipped silently.
