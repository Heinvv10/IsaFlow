-- 999p: drop the per-month unique on payroll_run_headers (wave 6 FQx, a contract step).
--
-- WHAT. UNIQUE (company_id, period_year, period_month) (migration 382) allowed one run per company-month. Weekly,
-- fortnightly and off-cycle runs need several in a month. What stays unique is 999a's
-- payroll_run_headers_regular_period_key: one REGULAR run per (company, pay frequency, period start), so a monthly
-- company still gets exactly one regular run a month.
--
-- WHY NOW. Every reader that assumed one run per company-month was converted to run-keyed reads by FQb1 (#1507) and
-- FQb2 (#1549), proven with two runs in one month (tests/integration/w6-fqb1-*.int.test.ts, w6-fqb2-run-keyed), and
-- classified in tests/unit/guards/payrollRunReaderCensus.json. Queued only once both are LIVE on prod, so this
-- ships in a later release than the code that tolerates it (spec rule 13, contract steps).
--
-- OLD COLOUR (the FQb release, which runs against this schema while the deploy switches colours, and which is the
-- rollback target):
--   insert  createPayrollRun (payrollRunHeaders.ts) writes pay_frequency 'monthly', run_kind 'regular' and the period
--           dates, with ON CONFLICT on the regular-period key, not on this constraint: a second regular run of the
--           month is still DO NOTHING -> PayrollRunDuplicateError. Its catch for this constraint's 23505 no longer
--           fires (nothing raises it); it is dead code, not a wrong answer.
--   update  nothing writes period_year / period_month after insert; no update names this constraint.
--   read    no reader names the constraint. The only rows it used to refuse (a second run of a month that is not
--           regular monthly) have no creation path in that release, and payrollRunKindGuard (999a, FQa) refuses to
--           calculate, approve, post or file a weekly, fortnightly or off-cycle run (RUN_KIND_UNSUPPORTED).
--
-- LOCKS. One ALTER TABLE: ACCESS EXCLUSIVE on payroll_run_headers for the catalogue change and the index drop (no
-- table scan). Waiting for the lock is bounded by lock_timeout.
--
-- Rollback (down SQL; only while no company-month holds two runs, which this schema now allows):
--   ALTER TABLE public.payroll_run_headers
--     ADD CONSTRAINT payroll_run_headers_company_id_period_year_period_month_key
--     UNIQUE (company_id, period_year, period_month);

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.payroll_run_headers
  DROP CONSTRAINT IF EXISTS payroll_run_headers_company_id_period_year_period_month_key;
