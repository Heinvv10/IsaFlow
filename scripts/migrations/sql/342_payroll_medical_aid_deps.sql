-- 342_payroll_medical_aid_deps.sql
-- Adds medical aid dependant tracking (for medical tax credits)
-- + travel allowance logbook flag (determines taxable %).

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS medical_aid_main_member BOOLEAN       NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS medical_aid_dependants  INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS travel_logbook_kept     BOOLEAN       NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS travel_taxable_pct      NUMERIC(5,2)  NOT NULL DEFAULT 80.00;

ALTER TABLE payslips
  ADD COLUMN IF NOT EXISTS medical_aid_credit NUMERIC(10,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN employees.medical_aid_dependants IS 'Number of dependants (excluding main member) for medical tax credit calculation';
COMMENT ON COLUMN employees.travel_taxable_pct     IS 'Taxable portion of travel allowance — 80% default, 20% if logbook kept (SARS rule)';
COMMENT ON COLUMN payslips.medical_aid_credit      IS 'Monthly medical aid tax credit applied against PAYE';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employees_medical_deps_non_negative'
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_medical_deps_non_negative
      CHECK (medical_aid_dependants >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employees_travel_pct_range'
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_travel_pct_range
      CHECK (travel_taxable_pct >= 0 AND travel_taxable_pct <= 100);
  END IF;
END $$;
