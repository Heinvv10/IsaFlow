-- 970: Taxable fringe-benefit inputs per employee (wave 5, PR FB).
--
-- A company vehicle (code 3802) and a travel allowance (code 3701) are taxed by
-- how much of their value is remuneration, and that depends on facts about the
-- employee, not on the pay component: the vehicle's determined value, whether a
-- maintenance plan was included in its purchase price, and whether the employer
-- is satisfied that at least 80% of its use will be for business.
--
--   Vehicle (Seventh Schedule para 7; PAYE-GEN-01-G21 (2027) Rev 1 p. 5 / PDF page 5):
--     3.5% of the determined value a month, 3.25% with a maintenance plan.
--   Both kinds (G21 p. 5 for travel; BRS V25.3.0 code 4582 p. 105 for 3802):
--     80% of the amount is remuneration for PAYE, or 20% where the employer is
--     satisfied that at least 80% of the use is business.
--
-- A third kind, medical_gross_up, is the explicit opt-in for the gross-up pattern some companies use for medical aid:
-- a 3810 earning paid in cash beside a 4005 deduction that takes the premium back. The default is the employer /
-- employee split (3810 is the employer's share, a non-cash benefit deemed paid by the employee; 4005 is the employee's
-- own share); the two cannot be told apart from the amounts, so the gross-up is never inferred.
--
-- BACKFILL (no figure change on deploy): before this migration every 3810 earning was paid and taxed as cash, whether
-- or not the company also deducted the premium as 4005. The new default (the split: 3810 non-cash and deemed) would move
-- the net pay and the deemed fees of such a setup, so EVERY employee who has ever had a 3810 earning assignment gets a
-- medical_gross_up row, created_by 'migration:970'. There is no window: an approved run can be reopened and recomputed, so
-- no month is final, and a long-ended row changes nothing unless that month is recomputed, which is exactly when it is
-- needed. The row starts on the first day of the month of the earliest assignment (a hire on 11-20 stays cash for all of
-- November) and is open-ended while any assignment is open-ended, else ends on the month end of the last to end (a leaver
-- ending 11-30 stays cash in November). Existing 3810 users keep today's cash behaviour until a company ends the opt-in;
-- a 3810 assigned after the row ends defaults to the split. Deterministic and idempotent (never a second row, so a
-- re-run adds nothing); company-matched (the component and the employee must belong to one company). Superseded (cut)
-- assignments are deliberately included: the conservative reading is that the employee had a cash 3810, so their months stay cash.
-- Only an earning coded 3810 (after the trim) counts, never a deduction. It runs before row security is enabled below and as a role that bypasses it
-- (postgres, as the deploy does).
--
-- One row per period of use. A row is never deleted (a finalised payslip was
-- costed from it): it is ended with effective_to. Overlapping rows of one kind
-- for one employee are refused by the service under the company payroll lock and,
-- where the btree_gist extension is already installed (never created here), by an
-- EXCLUDE constraint as well; the partial unique index guarantees a single OPEN row
-- per kind either way.
-- employee_id is the payroll_employees id and is tied to company_id by a composite
-- foreign key, so a row can never name another company's employee; created_by is a
-- users.id (TEXT).

SET LOCAL lock_timeout = '5s';

-- The composite foreign key below needs a unique target (id is already unique, so this adds no restriction).
CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_employees_id_company ON payroll_employees (id, company_id);

CREATE TABLE IF NOT EXISTS payroll_employee_fringe_benefits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('company_vehicle', 'travel_allowance', 'medical_gross_up')),
  determined_value NUMERIC(14, 2) CHECK (determined_value IS NULL OR determined_value > 0),
  maintenance_plan BOOLEAN NOT NULL DEFAULT FALSE,
  business_use_at_least_80 BOOLEAN NOT NULL DEFAULT FALSE,
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payroll_fringe_employee_company_fk FOREIGN KEY (employee_id, company_id)
    REFERENCES payroll_employees (id, company_id) ON DELETE CASCADE,
  CONSTRAINT payroll_fringe_dates_ordered CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- A vehicle benefit is a percentage of a value: no value, no benefit. The other kinds have no determined value.
  CONSTRAINT payroll_fringe_kind_shape CHECK (
    (kind = 'company_vehicle' AND determined_value IS NOT NULL)
    OR (kind IN ('travel_allowance', 'medical_gross_up') AND determined_value IS NULL AND maintenance_plan = FALSE)
  )
);

CREATE INDEX IF NOT EXISTS idx_payroll_fringe_employee
  ON payroll_employee_fringe_benefits (company_id, employee_id, kind, effective_from);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_fringe_one_open_per_kind
  ON payroll_employee_fringe_benefits (employee_id, kind) WHERE effective_to IS NULL;

-- No two rows of one kind may overlap for an employee (whole days, both ends inclusive). Only where btree_gist exists.
-- NAMED LIMIT: a database without btree_gist has only the service's company payroll lock as the overlap guard (migrations
-- 502 and 644 already create the extension, so production should have it; this migration never creates it).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_fringe_no_overlap'
                       AND conrelid = 'payroll_employee_fringe_benefits'::regclass) THEN
    ALTER TABLE payroll_employee_fringe_benefits ADD CONSTRAINT payroll_fringe_no_overlap
      EXCLUDE USING gist (employee_id WITH =, kind WITH =, daterange(effective_from, effective_to, '[]') WITH &&);
  END IF;
END
$$;

INSERT INTO payroll_employee_fringe_benefits (company_id, employee_id, kind, business_use_at_least_80, effective_from, effective_to, created_by)
SELECT e.company_id, e.id, 'medical_gross_up', FALSE,
       date_trunc('month', MIN(pec.effective_from))::date,
       -- Open-ended while any qualifying assignment is open; else the month end of the last one to end.
       CASE WHEN bool_or(pec.effective_to IS NULL) THEN NULL
            ELSE (date_trunc('month', MAX(pec.effective_to)) + INTERVAL '1 month - 1 day')::date END,
       'migration:970'
  FROM payroll_employee_components pec
  JOIN payroll_components c ON c.id = pec.component_id AND c.component_type = 'earning'
                           AND BTRIM(c.sars_source_code, E' \t\r\n') = '3810'
  JOIN payroll_employees e ON e.id = pec.employee_id AND e.company_id = c.company_id
 WHERE (pec.effective_to IS NULL OR pec.effective_to >= pec.effective_from)
   AND NOT EXISTS (SELECT 1 FROM payroll_employee_fringe_benefits f WHERE f.employee_id = e.id AND f.kind = 'medical_gross_up')
 GROUP BY e.company_id, e.id;

ALTER TABLE payroll_employee_fringe_benefits ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_employee_fringe_benefits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON payroll_employee_fringe_benefits;
-- The active company AND membership (migration 897's form).
CREATE POLICY tenant_isolation ON payroll_employee_fringe_benefits FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
-- No DELETE, and an UPDATE only ends a row: a fringe row is ended, never removed or rewritten.
REVOKE ALL ON payroll_employee_fringe_benefits FROM app_user;
GRANT SELECT, INSERT ON payroll_employee_fringe_benefits TO app_user;
GRANT UPDATE (effective_to, updated_at) ON payroll_employee_fringe_benefits TO app_user;

DROP TRIGGER IF EXISTS trg_payroll_fringe_updated_at ON payroll_employee_fringe_benefits;
CREATE TRIGGER trg_payroll_fringe_updated_at BEFORE UPDATE ON payroll_employee_fringe_benefits
  FOR EACH ROW EXECUTE FUNCTION accounting_updated_at();
