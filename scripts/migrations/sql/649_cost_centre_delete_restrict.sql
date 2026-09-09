-- 649: Stop a cost-centre delete from silently unassigning payroll employees.
--
-- payroll_employees.cost_centre_id was created ON DELETE SET NULL (mig 450) and
-- assets.cost_centre_id with no action clause (mig 361). Deleting a cost centre
-- that only payroll or asset records referenced therefore succeeded and nulled
-- every assignment with no warning and no history row. Both FKs become RESTRICT
-- so the database refuses the delete; deleteCostCentre reports the counts first.
--
-- Rollback: re-run the ALTERs with ON DELETE SET NULL / no action clause.
--
-- apply-migrations.ts wraps each file in BEGIN/COMMIT, so the DROP CONSTRAINT
-- ACCESS EXCLUSIVE lock on both tables is held across the ADD CONSTRAINT scan.
-- lock_timeout makes the deploy fail fast rather than queue every query on
-- payroll_employees and assets behind a pending lock request.
SET LOCAL lock_timeout = '5s';

ALTER TABLE payroll_employees
  DROP CONSTRAINT IF EXISTS payroll_employees_cost_centre_id_fkey;

ALTER TABLE payroll_employees
  ADD CONSTRAINT payroll_employees_cost_centre_id_fkey
  FOREIGN KEY (cost_centre_id) REFERENCES cost_centres(id) ON DELETE RESTRICT;

ALTER TABLE assets
  DROP CONSTRAINT IF EXISTS assets_cost_centre_id_fkey;

ALTER TABLE assets
  ADD CONSTRAINT assets_cost_centre_id_fkey
  FOREIGN KEY (cost_centre_id) REFERENCES cost_centres(id) ON DELETE RESTRICT;
