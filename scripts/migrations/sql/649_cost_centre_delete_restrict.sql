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

-- An orphan cost_centre_id (a value with no cost_centres row) is the only thing
-- that can make the ADD CONSTRAINT below fail. The raw FK error names one key
-- and no counts, so report the scale of the problem before the ALTERs run.
DO $$
DECLARE
  orphan_employees BIGINT;
  orphan_assets    BIGINT;
BEGIN
  SELECT COUNT(*) INTO orphan_employees
    FROM payroll_employees pe
   WHERE pe.cost_centre_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM cost_centres cc WHERE cc.id = pe.cost_centre_id);

  SELECT COUNT(*) INTO orphan_assets
    FROM assets a
   WHERE a.cost_centre_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM cost_centres cc WHERE cc.id = a.cost_centre_id);

  IF orphan_employees > 0 OR orphan_assets > 0 THEN
    RAISE EXCEPTION
      'Migration 649: % payroll_employees and % assets row(s) carry a cost_centre_id with no cost_centres row. Clear or repoint them, then re-run.',
      orphan_employees, orphan_assets;
  END IF;
END $$;

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
