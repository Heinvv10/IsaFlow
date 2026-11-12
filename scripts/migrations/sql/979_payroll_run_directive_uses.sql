-- 979: The regular-pay directives (IRP3(b) fixed percentage, IRP3(c) fixed amount) each approved payroll run was taxed
-- by, recorded at approval (wave 5 DR, #1266 round 3 M1).
--
-- A run's lines are rewritten by every recalculation (payrollRunLineWriter), so a reopened run's lines are not a record
-- of what it declared: change the employee's tax status or drop them from the run, recalculate, and the line no longer
-- names the directive. This table is that record. One row per (run, employee, directive), written by the approval in
-- the same transaction as the run's status change (payrollRunDirectiveUses.recordRegularDirectiveUses), and never
-- deleted: a reopen does not touch it. The directive guards (cancel 409, expiry before a use 400, delete 409) and the
-- recalculation guard of an ever-approved run read it.
--
-- BACKFILL (deterministic, idempotent): every directive a line of a run approved or paid now names
-- (PAYE_OUTSIDE_TABLES, treatment 'directive'), for directives of the run's own company. Regular-pay directives are new
-- in this wave, so production is expected to backfill no row. It runs before row security is enabled, as a role that
-- bypasses it (postgres, as the deploy does).
--
-- Rows are inserted by app_user (the approving request) and never updated or deleted by it: SELECT and INSERT only.
--
-- Also tax_directives.approvers_at_create (#1266 round 3 L-a, four eyes): the user ids of the company's owner / admin /
-- manager members other than the creator, as the creator could see them when the directive was captured. The creator
-- may not approve while any of them is still an active account, so demoting the other approver just before approving
-- does not open self-approval. NULL on a row captured before this migration (judged on today's members only).

SET LOCAL lock_timeout = '5s';

ALTER TABLE tax_directives ADD COLUMN IF NOT EXISTS approvers_at_create TEXT[];

CREATE TABLE IF NOT EXISTS payroll_run_directive_uses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES payroll_run_headers(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL,
  directive_id UUID NOT NULL REFERENCES tax_directives(id),
  period_year INTEGER NOT NULL,
  period_month INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  -- The run's pay date, else the period's last day: the day the directive was judged in force on.
  judge_date DATE NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_run_directive_uses ON payroll_run_directive_uses (run_id, employee_id, directive_id);
CREATE INDEX IF NOT EXISTS idx_payroll_run_directive_uses_directive ON payroll_run_directive_uses (company_id, directive_id);

INSERT INTO payroll_run_directive_uses (company_id, run_id, employee_id, directive_id, period_year, period_month, judge_date)
SELECT DISTINCT h.company_id, l.run_id, l.employee_id, d.id, h.period_year, h.period_month,
       COALESCE(h.run_date, (make_date(h.period_year, h.period_month, 1) + INTERVAL '1 month - 1 day')::date)
FROM payroll_run_lines l
JOIN payroll_run_headers h ON h.id = l.run_id
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l.validation_results) = 'array' THEN l.validation_results ELSE '[]'::jsonb END) v
JOIN tax_directives d ON d.id::text = v->'directive'->>'id' AND d.company_id = h.company_id
WHERE h.status IN ('approved', 'paid')
  AND v->>'code' = 'PAYE_OUTSIDE_TABLES' AND v->>'treatment' = 'directive'
ON CONFLICT (run_id, employee_id, directive_id) DO NOTHING;

ALTER TABLE payroll_run_directive_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_run_directive_uses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON payroll_run_directive_uses;
CREATE POLICY tenant_isolation ON payroll_run_directive_uses FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
REVOKE ALL ON payroll_run_directive_uses FROM app_user;
GRANT SELECT, INSERT ON payroll_run_directive_uses TO app_user;
