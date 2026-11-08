-- 968: payslip finality stamped at approval (master plan wave 5, FS; closes the
-- wave-4 PS "known limit").
--
-- Until now a payslip was FINAL only while the R-035 guard (assertPayRunApproved)
-- still cleared the run against TODAY's enforcement and rules, so a run approved
-- while pay-run enforcement was off turned DRAFT when enforcement was switched on.
-- Approval already runs that guard before its UPDATE, so every approved/paid run
-- cleared it at approval (or was grandfathered by 951). This records that fact once.
--
-- payslips_final_at: set by the approve UPDATE (payrollApprovalService), cleared
--   by reopen (payrollRunReopen). NULL = DRAFT. Readers: payslipFinal,
--   payslipHistory, payslipYearToDate.
-- payslips_final_by: the approver's user id (TEXT: users.id is character varying),
--   or 'system:migration' for rows stamped by the backfill below.
--
-- Backfill: every approved/paid run, whichever way it cleared. A calculated,
-- draft or cancelled run is never stamped. Deterministic, one UPDATE:
--   COALESCE(approved_at, approval_grandfathered_at, updated_at).

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.payroll_run_headers ADD COLUMN IF NOT EXISTS payslips_final_at pg_catalog.timestamptz;
ALTER TABLE public.payroll_run_headers ADD COLUMN IF NOT EXISTS payslips_final_by pg_catalog.text;

UPDATE public.payroll_run_headers
   SET payslips_final_at = COALESCE(approved_at, approval_grandfathered_at, updated_at),
       payslips_final_by = 'system:migration'
 WHERE status IN ('approved', 'paid')
   AND payslips_final_at IS NULL;
