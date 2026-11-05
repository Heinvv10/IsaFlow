-- 957: what a payroll run line's SDL was worked out from, so the year to date can
-- carry it exactly (SDL Act s3(4); SARS SDL-GEN-01-G01 Rev 5 s6; PR #1142).
--
-- SDL is levied on SDL-applicable pay less the s11F retirement deduction PAYE 4c
-- records, over the tax year (sdlLeviableCumulative). The year to date needs, per
-- earlier line, what was levied on and whether the employer was liable at all
-- (an exempt employer, s4(b), levies nothing: sdl = 0, and its months must not
-- count as levied). payroll_run_lines stored only the levy, so these were
-- rebuilt by heuristics that misread a liable month whose deduction absorbed
-- all its pay as an exempt one. Stored, they are exact.
--
--   sdl_applicable  the line's SDL-applicable earnings (earnings flagged
--                   is_sdl_applicable), before any deduction
--   sdl_leviable    the leviable amount the line carried: the rise in max(0,
--                   liable pay to date - liable deduction to date)
--   sdl_exempt      true when the run was SDL-exempt (employer's twelve-month
--                   remuneration at or under the s4(b) threshold): sdl is nil
--
-- Writer: calculatePayrollRun (payrollRunService -> payrollRunLineWriter), the
-- only writer of payroll_run_lines. Reader: loadPayeYearToDate
-- (payrollYearToDate.ts -> payrollSdlYearToDate.ts).
--
-- Additive only: nullable columns, no default, no backfill. A line written before
-- this migration is NULL in all three and is read as it was costed: SDL on its
-- SDL-applicable pay (rebuilt from its breakdown), exempt when it stored a nil
-- levy although that pay would have carried one of a cent or more.
--
-- Rollback:
--   ALTER TABLE payroll_run_lines DROP COLUMN IF EXISTS sdl_exempt;
--   ALTER TABLE payroll_run_lines DROP COLUMN IF EXISTS sdl_leviable;
--   ALTER TABLE payroll_run_lines DROP COLUMN IF EXISTS sdl_applicable;
SET LOCAL lock_timeout = '5s';

ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS sdl_applicable NUMERIC(14,2);
ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS sdl_leviable NUMERIC(14,2);
ALTER TABLE payroll_run_lines ADD COLUMN IF NOT EXISTS sdl_exempt BOOLEAN;
