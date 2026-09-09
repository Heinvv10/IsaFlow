# K-119 — monthly recurring invoices drift off month-end

**Claim.** Date advance uses a fixed day-of-month, so a 31st schedule walks backwards through short
months.

**Corrected trigger.** Confirmed, and there is a SECOND, compounding defect in the same three lines:
`advanceDate` is fed `String(ri.next_run_date)`, and `next_run_date` is a Postgres `date` that
node-postgres parses to a JS `Date` at LOCAL midnight. `toISOString()` then converts back through UTC,
so on a SAST (UTC+2) host every returned date is a further day early. Measured under
`TZ=Africa/Johannesburg`: a 2026-01-31 template advances to **2026-03-02**, not the 2026-03-03 the
audit predicted from the ISO-string path.

**Disposition: confirmed.**

## Evidence
- Baseline `origin/master` = `31fc2f10`. This is the ONE file among these eight where the checked-out
  worktree is behind: `git diff --stat HEAD origin/master` reports 102 insertions, 10 deletions
  (origin/master added the savepoint, the `FOR UPDATE` template lock and the approval post).
  `advanceDate` itself is byte-identical in both — origin/master `:249-257`, worktree HEAD `:158-166`
  — and the RED test asserts that equality as its first case before testing behaviour.
- `advanceDate`: `case 'monthly': d.setMonth(d.getMonth() + 1); break;` — JavaScript overflows rather
  than clamping, so 31 January + 1 month is 31 February, which is 3 March.
- Fixture schema: `recurring_invoices.next_run_date` is `date`; `src/lib/neon.ts` sets no
  `pg.types.setTypeParser`, so the value arrives as a local-midnight `Date`.
- RED: `tests/unit/services/k119-recurring-monthly-drift.test.ts` — 3 tests, 2 failed, 1 passed.
  The passing one is the origin/master-versus-disk equality check. Log: `red.log`.
  - `advanceDate('2026-01-31','monthly')` → `2026-03-03`, expected `2026-02-28`. February is skipped.
  - `advanceDate('2026-03-31','monthly')` → `2026-05-01`, expected `2026-04-30`. April is skipped.
  - The test materialises the exact `origin/master` blob via `git show` and evaluates the shipped
    function text, rather than importing the stale module.
- Timezone probe: `TZ=Africa/Johannesburg node -e ...` on `String(new Date(2026,0,31))` returns
  `2026-03-02` through `advanceDate`, and `2026-01-30` on a same-day round trip.

## Reachability
`generateInvoiceFromRecurring`, reached from the single-template run endpoint and the "Run All" path.
Any monthly template whose `next_run_date` falls on the 29th, 30th or 31st. `quarterly` overflows the
same way; `weekly` and `annually` do not.

## Proposed minimal fix
`src/modules/accounting/services/ar/recurringInvoiceService.ts`, in `advanceDate`:
1. Clamp instead of overflowing: capture the original day-of-month, `d.setDate(1)`, advance the month,
   then `d.setDate(Math.min(day, daysInMonth(d)))`.
2. Replace `String(ri.next_run_date)` at the call site and `d.toISOString().split('T')[0]` in the
   return with the file's already-imported `fmtDate`, so no value round-trips through UTC.
3. Preserve month-end intent: a template seeded on a month's last day should stay on month end rather
   than being pinned to the 28th forever. Clamping in step 1 does this only if the ANCHOR day is
   carried on the template rather than re-read from the last run — worth deciding explicitly.

## Historical-data impact
Real. Any monthly template ever run from a 29th–31st `next_run_date` has permanently migrated and
skipped a billing period; the customer was not invoiced for it. Read-only detection (NOT run against
production):
```sql
SELECT company_id, id, template_name, frequency, next_run_date, last_run_date, run_count
FROM recurring_invoices
WHERE frequency IN ('monthly','quarterly')
  AND EXTRACT(DAY FROM next_run_date) IN (1, 2, 3)
  AND run_count > 0
ORDER BY company_id, next_run_date;
```
Missed periods are recoverable only by raising the invoices by hand; the fix does not backfill.

## Risks
Step 3 is a behaviour decision, not a bug fix, and getting it wrong pins every month-end template to
the 28th. Fixing step 2 alone would shift every future run date by a day, which will look like a new
defect to anyone watching the schedule.
