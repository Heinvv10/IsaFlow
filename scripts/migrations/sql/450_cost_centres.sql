-- 450_cost_centres.sql
-- Normalized cost centres. payroll_employees had a free-text `cost_centre`
-- column (mig 380) which worked for single-employee payslip display but
-- made cross-employee reporting impossible (typos, case differences etc.
-- fragmented the list). This migration introduces a proper master table,
-- adds a FK on payroll_employees, and back-fills from the existing text.
--
-- The text column is left in place as a historical record; going forward
-- the FK is authoritative. UI writes to both until the free-text field
-- is removed in a later migration.

-- Note: cost_centres was created earlier by migration 211 with a different
-- shape (code UNIQUE globally, no company_id). Phase 4 of VIP parity
-- evolved it in-place via ALTER. This migration completes that evolution
-- idempotently: add any missing columns + the (company_id, code) unique
-- constraint required by the backfill ON CONFLICT target below.

CREATE TABLE IF NOT EXISTS cost_centres (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(20) NOT NULL,
  name VARCHAR(255) NOT NULL,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE cost_centres
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES cost_centres(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS created_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL;

-- Ensure the (company_id, code) unique constraint exists — the backfill
-- ON CONFLICT clause below targets exactly this pair. The legacy schema
-- from mig 211 only had `code` globally UNIQUE, which doesn't match.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cost_centres_company_id_code_key'
      AND conrelid = 'public.cost_centres'::regclass
  ) THEN
    -- Drop the legacy global UNIQUE on code if it exists — it blocks
    -- multi-tenant operation and is superseded by (company_id, code).
    ALTER TABLE cost_centres DROP CONSTRAINT IF EXISTS cost_centres_code_key;
    ALTER TABLE cost_centres
      ADD CONSTRAINT cost_centres_company_id_code_key UNIQUE (company_id, code);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_cost_centres_company_active
  ON cost_centres(company_id, is_active);

ALTER TABLE payroll_employees
  ADD COLUMN IF NOT EXISTS cost_centre_id UUID REFERENCES cost_centres(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_employees_cost_centre
  ON payroll_employees(cost_centre_id);

-- Backfill: for every (company_id, non-empty cost_centre) pair found on
-- payroll_employees, insert one master row using the text as both code
-- and name, then point the employee at it. Idempotent via the UNIQUE
-- (company_id, code) constraint.
INSERT INTO cost_centres (company_id, code, name)
SELECT DISTINCT company_id, TRIM(cost_centre), TRIM(cost_centre)
  FROM payroll_employees
 WHERE cost_centre IS NOT NULL
   AND TRIM(cost_centre) <> ''
ON CONFLICT (company_id, code) DO NOTHING;

UPDATE payroll_employees e
   SET cost_centre_id = cc.id
  FROM cost_centres cc
 WHERE cc.company_id = e.company_id
   AND cc.code = TRIM(e.cost_centre)
   AND e.cost_centre_id IS NULL
   AND e.cost_centre IS NOT NULL
   AND TRIM(e.cost_centre) <> '';

COMMENT ON TABLE cost_centres IS
  'Normalized cost centre master. Replaces free-text payroll_employees.cost_centre — the text column is retained for audit but all new reporting should join via cost_centre_id.';
