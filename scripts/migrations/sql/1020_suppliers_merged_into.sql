-- 1020: suppliers.merged_into_id, the survivor a merged-away supplier was merged into (#1655 review M1).
--
-- A supplier merge (duplicateMergeService.mergeSuppliers) moves the duplicate's payments, bills and
-- purchase orders onto the primary and soft-deletes the duplicate, and recorded nothing else. The Sage
-- import matches only live suppliers (sagePartyMatch, #1693), so a re-sync of the merged-away Sage
-- supplier re-created it as a new live row and its new Sage bills landed there, splitting AP from the
-- survivor. With this column the merge records its survivor and the Sage match follows a deleted,
-- merged supplier to it. Merges made before this migration stay unlinked (nothing recorded where their
-- documents went); a re-sync re-creates those as before. Customers are NOT covered: re-creating a
-- merged-away customer is Hein's K-061 decision 4 (2026-09-26).
--
-- FOREIGN KEY (merged_into_id, company_id) -> suppliers (id, company_id): the survivor is a supplier of
-- the SAME company (suppliers_id_company_uq). ON DELETE SET NULL (merged_into_id): a survivor that is
-- hard-deleted (softDeleteService purge) clears the link and leaves company_id alone; PG15+ (production
-- is 15). Added NOT VALID, then validated: the column is new and NULL on every row, so the validation
-- scan finds nothing to refuse.
--
-- LOCKS. ADD COLUMN (nullable, no default) is a catalog change: ACCESS EXCLUSIVE on suppliers for a
-- moment, no rewrite. ADD CONSTRAINT ... NOT VALID takes SHARE ROW EXCLUSIVE; VALIDATE takes SHARE
-- UPDATE EXCLUSIVE and scans. apply-migrations.ts runs the file in one transaction; if lock_timeout trips
-- the file rolls back and nothing is recorded: rerun it. Every step is skipped when already done.
--
-- Rollback: ALTER TABLE suppliers DROP CONSTRAINT IF EXISTS suppliers_merged_into_fkey;
--           DROP INDEX IF EXISTS idx_suppliers_merged_into; ALTER TABLE suppliers DROP COLUMN IF EXISTS merged_into_id;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS merged_into_id uuid;

COMMENT ON COLUMN public.suppliers.merged_into_id IS
  'Set by a supplier merge on the merged-away (soft-deleted) row: the supplier it was merged into. NULL otherwise.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'suppliers_merged_into_fkey' AND conrelid = 'public.suppliers'::regclass
  ) THEN
    ALTER TABLE public.suppliers ADD CONSTRAINT suppliers_merged_into_fkey
      FOREIGN KEY (merged_into_id, company_id) REFERENCES public.suppliers (id, company_id)
      ON DELETE SET NULL (merged_into_id) NOT VALID;
  END IF;
END $$;

ALTER TABLE public.suppliers VALIDATE CONSTRAINT suppliers_merged_into_fkey;

-- The ON DELETE SET NULL lookup a survivor's delete makes.
CREATE INDEX IF NOT EXISTS idx_suppliers_merged_into ON public.suppliers (merged_into_id)
  WHERE merged_into_id IS NOT NULL;
