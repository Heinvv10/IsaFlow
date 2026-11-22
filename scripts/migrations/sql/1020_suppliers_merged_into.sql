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
-- is 15). Added NOT VALID here; 1020b validates it and builds the index (see below).
--
-- TWO FILES (#1699 review). The runner applies each file in its own transaction (scripts/lib/migrationFiles.applyOne:
-- BEGIN, the file, its schema_migrations row, COMMIT), so the locks of one end at its COMMIT. This file holds ACCESS
-- EXCLUSIVE on suppliers only for the catalog change (ADD COLUMN, nullable, no default, no rewrite) and SHARE ROW EXCLUSIVE
-- for ADD CONSTRAINT ... NOT VALID (no scan: it checks new writes only). 1020b takes the scans: VALIDATE CONSTRAINT
-- (SHARE UPDATE EXCLUSIVE, writes continue) and CREATE INDEX (SHARE: blocks writes to suppliers for the build; the
-- column is NULL on every row and the index is partial, so it holds nothing; CONCURRENTLY cannot run inside the
-- runner's transaction). The new code DOES read and write merged_into_id (the merge records it, the Sage match follows
-- it), so the deploy applies both files before the new colour takes traffic: the deploy runs pending migrations first,
-- in order, so 1020b has validated the constraint before any code that uses the column runs. Old code never touches the
-- column. Between the two files an unvalidated (NOT VALID) FK still checks every new write, so a merge recorded then
-- is already held to the same-company survivor; only rows that existed before the constraint are unchecked, and there
-- are none (the column is new and NULL).
--
-- lock_timeout: a held lock on suppliers fails the file after 5 s and nothing is recorded: rerun it. Every step is
-- skipped when already done.
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
