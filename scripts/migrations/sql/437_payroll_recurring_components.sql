-- 437_payroll_recurring_components.sql
-- Distinguish recurring (every period) vs once-off (this period only) employee
-- component assignments. VIP-style separation between standing payroll
-- transactions and per-period batch entries.
--
-- is_recurring=true (default, matches existing rows): the assignment auto-
--   applies to every payroll run while the effective_from/effective_to
--   window is open. Same as today's behaviour.
-- is_recurring=false: the assignment is for the period containing
--   effective_from only — once that period rolls over, the row is
--   effectively dead. Use case: "salary advance R5,000 this month",
--   "overtime hours April 2026", "one-off bonus".

ALTER TABLE payroll_employee_components
  ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_payroll_emp_components_once_off
  ON payroll_employee_components(employee_id, effective_from)
  WHERE is_recurring = false;

COMMENT ON COLUMN payroll_employee_components.is_recurring IS
  'true = standing instruction, applies every period within effective range. false = once-off this period only (effective_to auto-set to end of effective_from''s month at insert time).';
