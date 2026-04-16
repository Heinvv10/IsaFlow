-- 341_payroll_sars_codes.sql
-- Adds SARS IRP5 source codes + per-component breakdown to pay_structures & payslips.
-- Enables legally-valid IRP5 submission with correct code-per-income-component.

ALTER TABLE pay_structures
  ADD COLUMN IF NOT EXISTS basic_salary_code          TEXT NOT NULL DEFAULT '3601',
  ADD COLUMN IF NOT EXISTS travel_allowance_code      TEXT NOT NULL DEFAULT '3713',
  ADD COLUMN IF NOT EXISTS housing_allowance_code     TEXT NOT NULL DEFAULT '3802',
  ADD COLUMN IF NOT EXISTS cell_allowance_code        TEXT NOT NULL DEFAULT '3713',
  ADD COLUMN IF NOT EXISTS other_allowances_code      TEXT NOT NULL DEFAULT '3601',
  ADD COLUMN IF NOT EXISTS annual_bonus               NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS annual_bonus_code          TEXT NOT NULL DEFAULT '3605',
  ADD COLUMN IF NOT EXISTS commission                 NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commission_code            TEXT NOT NULL DEFAULT '3606';

ALTER TABLE payslips
  ADD COLUMN IF NOT EXISTS annual_bonus   NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commission     NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sars_breakdown JSONB NOT NULL DEFAULT '[]'::JSONB;

COMMENT ON COLUMN pay_structures.basic_salary_code     IS 'SARS IRP5 source code, default 3601 = basic salary';
COMMENT ON COLUMN pay_structures.travel_allowance_code IS 'SARS IRP5 source code, default 3713 = travel allowance';
COMMENT ON COLUMN payslips.sars_breakdown              IS 'Array of {code, description, amount, type} — income + deduction lines tagged with SARS codes for IRP5 generation';

CREATE INDEX IF NOT EXISTS idx_pay_structures_employee
  ON pay_structures(employee_id);
