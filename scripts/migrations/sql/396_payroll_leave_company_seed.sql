-- 396_payroll_leave_company_seed.sql
-- Add company_id to payroll_leave_balances and payroll_leave_requests (missing from 383),
-- enable RLS, and seed default BCEA leave types for existing companies with employees.

-- payroll_leave_balances: add company_id derived from employee
ALTER TABLE payroll_leave_balances
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE CASCADE;

-- Back-fill from employee table
UPDATE payroll_leave_balances plb
SET    company_id = pe.company_id
FROM   payroll_employees pe
WHERE  pe.id = plb.employee_id
  AND  plb.company_id IS NULL;

-- Now enforce NOT NULL (safe after back-fill)
ALTER TABLE payroll_leave_balances
  ALTER COLUMN company_id SET NOT NULL;

-- payroll_leave_requests: add company_id derived from employee
ALTER TABLE payroll_leave_requests
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE CASCADE;

UPDATE payroll_leave_requests plr
SET    company_id = pe.company_id
FROM   payroll_employees pe
WHERE  pe.id = plr.employee_id
  AND  plr.company_id IS NULL;

ALTER TABLE payroll_leave_requests
  ALTER COLUMN company_id SET NOT NULL;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_plb_company_employee ON payroll_leave_balances (company_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_plr_company_employee ON payroll_leave_requests (company_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_plt_company           ON payroll_leave_types    (company_id);

-- RLS
ALTER TABLE payroll_leave_types     ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_leave_balances  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_leave_requests  ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'payroll_leave_types' AND policyname = 'plt_company_iso'
  ) THEN
    CREATE POLICY plt_company_iso ON payroll_leave_types
      USING (company_id = (SELECT (current_setting('request.jwt.claims', true)::jsonb->>'company_id')::uuid));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'payroll_leave_balances' AND policyname = 'plb_company_iso'
  ) THEN
    CREATE POLICY plb_company_iso ON payroll_leave_balances
      USING (company_id = (SELECT (current_setting('request.jwt.claims', true)::jsonb->>'company_id')::uuid));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'payroll_leave_requests' AND policyname = 'plr_company_iso'
  ) THEN
    CREATE POLICY plr_company_iso ON payroll_leave_requests
      USING (company_id = (SELECT (current_setting('request.jwt.claims', true)::jsonb->>'company_id')::uuid));
  END IF;
END $$;

-- Seed default BCEA leave types for every company that has at least one payroll employee.
-- Uses ON CONFLICT DO NOTHING so re-running is safe.
INSERT INTO payroll_leave_types (company_id, name, bcea_type, accrual_rule, accrual_days, max_carry_over, is_paid)
SELECT DISTINCT
  pe.company_id,
  defaults.name,
  defaults.bcea_type,
  defaults.accrual_rule,
  defaults.accrual_days,
  defaults.max_carry_over,
  defaults.is_paid
FROM payroll_employees pe
CROSS JOIN (
  VALUES
    ('Annual Leave',             'annual',              'monthly', 1.25, 15.00, TRUE),
    ('Sick Leave',               'sick',                'cycle_30_per_36', 0, NULL, TRUE),
    ('Family Responsibility',    'family_responsibility','none',   3.00, NULL,  TRUE),
    ('Maternity Leave',          'maternity',           'none',  120.00, NULL,  TRUE),
    ('Unpaid Leave',             'unpaid',              'none',   0.00, NULL,  FALSE)
) AS defaults(name, bcea_type, accrual_rule, accrual_days, max_carry_over, is_paid)
WHERE NOT EXISTS (
  SELECT 1
  FROM   payroll_leave_types plt
  WHERE  plt.company_id = pe.company_id
    AND  plt.name       = defaults.name
);
