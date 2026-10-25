-- Migration 933: payroll_employees.medical_aid_main_member defaults to FALSE.
--
-- D1 (master plan, wave 0). Migration 380 declared the column DEFAULT TRUE
-- (342 had said FALSE, but 380's CREATE TABLE IF NOT EXISTS is the one that
-- built the table). A medical-aid main member earns a monthly medical tax
-- credit in PAYE, so any row inserted without an explicit value was
-- under-deducted: an employee with no medical aid kept a credit they are not
-- entitled to. The application stopped relying on the default in D1 PR 1
-- (the create form, POST /api/payroll/employees and the MCP create_employee
-- tool now write an explicit value, true only when asked); this closes the
-- last gap, for inserts that leave the column out (scripts, future code).
--
-- DEFAULT only. NO data change: existing rows keep whatever they hold. Those
-- already flagged as main members with no medical-aid deduction are surfaced
-- read-only by GET /api/payroll/employees/medical-aid-review for a human to
-- review; nothing here backfills or "fixes" them.
--
-- Idempotent: SET DEFAULT on a column that already has it is a no-op.

ALTER TABLE payroll_employees ALTER COLUMN medical_aid_main_member SET DEFAULT FALSE;
