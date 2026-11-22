-- 1020b: validate suppliers_merged_into_fkey and index suppliers.merged_into_id (#1655 review; the scans of 1020).
--
-- 1020 added the column and the foreign key NOT VALID. This file does the two steps that read the table, in a
-- transaction of its own, so the ACCESS EXCLUSIVE lock of 1020's ADD COLUMN is long released:
--   - VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE (reads and writes continue) and scans; the column is new and
--     NULL on every row, so it finds nothing to refuse;
--   - CREATE INDEX takes SHARE on suppliers (writes wait for the build; the index is partial on a column that is NULL
--     everywhere, so it is empty). CONCURRENTLY is not possible: the runner wraps each file in BEGIN/COMMIT.
-- lock_timeout 5 s: a held lock fails the file and nothing is recorded; rerun it. Both steps are skipped when done.
--
-- Rollback: DROP INDEX IF EXISTS idx_suppliers_merged_into;
--           (the constraint stays; 1020's rollback drops it with the column)
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.suppliers VALIDATE CONSTRAINT suppliers_merged_into_fkey;

-- The ON DELETE SET NULL lookup a survivor's delete makes.
CREATE INDEX IF NOT EXISTS idx_suppliers_merged_into ON public.suppliers (merged_into_id)
  WHERE merged_into_id IS NOT NULL;
