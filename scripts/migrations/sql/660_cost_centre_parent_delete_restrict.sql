-- 660: Stop a cost-centre delete from silently reparenting its children.
--
-- cost_centres.parent_id was created ON DELETE SET NULL (mig 450:29). The usage
-- guard counts children and refuses the delete, but that count is scoped by
-- company_id and nothing constrains a parent and its child to the same tenant,
-- so a cross-tenant child was invisible to the guard and was silently orphaned
-- to NULL. RESTRICT gives the same database backstop migration 649 gave the
-- payroll and asset FKs: deleteCostCentre maps the 23503 onto the same 400.
--
-- Rollback: re-run the ALTER with ON DELETE SET NULL.
--
-- apply-migrations.ts wraps each file in BEGIN/COMMIT, so the ACCESS EXCLUSIVE
-- lock is held across the ADD CONSTRAINT scan; fail fast rather than queue.
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  orphan_parents BIGINT;
BEGIN
  SELECT COUNT(*) INTO orphan_parents
    FROM cost_centres c
   WHERE c.parent_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM cost_centres p WHERE p.id = c.parent_id);

  IF orphan_parents > 0 THEN
    RAISE EXCEPTION
      'Migration 660: % cost_centres row(s) carry a parent_id with no cost_centres row. Clear or repoint them, then re-run.',
      orphan_parents;
  END IF;
END $$;

ALTER TABLE cost_centres
  DROP CONSTRAINT IF EXISTS cost_centres_parent_id_fkey;

ALTER TABLE cost_centres
  ADD CONSTRAINT cost_centres_parent_id_fkey
  FOREIGN KEY (parent_id) REFERENCES cost_centres(id) ON DELETE RESTRICT;
