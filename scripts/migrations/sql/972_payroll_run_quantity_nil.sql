-- 972_payroll_run_quantity_nil.sql
-- Wave 5 HD: an hourly or daily employee's run may record an explicit nil (0 hours or 0 days worked), stored as a
-- quantity of 0 with amount 0 so it counts as ENTERED, unlike a missing quantity, which blocks approval. 967 forbade
-- quantity 0 (quantity > 0); this relaxes it to quantity >= 0. Nothing existing can violate the looser rule.
-- The unnamed inline CHECK of 967 is payroll_employee_components_quantity_check (Postgres' own naming); IF EXISTS makes
-- a re-run idempotent.
--
-- Rollback (code first): UPDATE payroll_employee_components SET quantity = NULL, quantity_unit = NULL WHERE quantity = 0
-- (or delete those once-off rows), then re-add CHECK (quantity > 0).

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.payroll_employee_components DROP CONSTRAINT IF EXISTS payroll_employee_components_quantity_check;
ALTER TABLE public.payroll_employee_components ADD CONSTRAINT payroll_employee_components_quantity_check
  CHECK (quantity >= 0);
