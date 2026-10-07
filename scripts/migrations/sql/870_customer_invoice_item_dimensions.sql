-- 870_customer_invoice_item_dimensions.sql
-- A customer invoice line may name its own revenue account, project (job / production) and cost
-- centre, so revenue posts by line and Project Profitability sees it (Hein, 2026-10-07).
--
-- customer_invoice_items already had gl_account_id (written by quote conversion and recurring
-- transactions, never read by posting, no FK). This adds project_id and cost_center_id beside it,
-- nullable, and puts all three under a foreign key. The posting rules live in
-- src/modules/accounting/services/ar/invoiceRevenueLines.ts; a line naming none of the three posts
-- to default_revenue untagged, exactly as before, so no existing invoice changes.
--
-- The FKs are single-column: they prove the row exists, NOT that it is the invoice's company (the
-- line has no company_id). Tenancy is the application's check (ar/invoiceLineCodingGuard.ts), at
-- write time and again at posting. What the FKs buy is that a delete cannot strand a line:
--   - cost_centres: deleteCostCentre already maps 23503 onto its counted "in use" message, and
--     costCentreUsageGuard now counts these lines, so the operator gets the count, not a 500;
--   - gl_accounts: the import rollback (migrationRollbackService) retains an account on 23503;
--   - projects: nothing deletes a project today.
--
-- gl_account_id is an OLD column, so its FK is added NOT VALID (enforced for every new or changed
-- row at once) and validated only when no line names a missing account. Census, read-only, run on
-- prod before this merges (expected 0):
--
--   SELECT COUNT(*) FROM customer_invoice_items cii
--   WHERE cii.gl_account_id IS NOT NULL
--     AND NOT EXISTS (SELECT 1 FROM gl_accounts a WHERE a.id = cii.gl_account_id);
--
-- Where it is not 0 the FK stays NOT VALID and a NOTICE names the count. No data is changed here.
--
-- NOT in the approval digest (approval_document_digest) yet: migration 869 (PR #660) redefines
-- that whole function, so the line project and cost centre join the digest in a follow-up after
-- #660 merges. Until then an edit to only a line's project or cost centre does not stale an approval.
--
-- Locks: ADD COLUMN takes ACCESS EXCLUSIVE on customer_invoice_items for a catalogue-only change
-- (nullable, no default); each ADD CONSTRAINT takes SHARE ROW EXCLUSIVE on both tables; VALIDATE
-- takes SHARE UPDATE EXCLUSIVE and scans the lines. Bounded below; either firing rolls the file back.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE customer_invoice_items ADD COLUMN IF NOT EXISTS project_id UUID;
ALTER TABLE customer_invoice_items ADD COLUMN IF NOT EXISTS cost_center_id UUID;

CREATE INDEX IF NOT EXISTS idx_cii_project_id
  ON customer_invoice_items (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cii_cost_center_id
  ON customer_invoice_items (cost_center_id) WHERE cost_center_id IS NOT NULL;

DO $$
DECLARE
  orphans BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'customer_invoice_items_project_id_fkey'
                   AND conrelid = 'customer_invoice_items'::regclass) THEN
    ALTER TABLE customer_invoice_items
      ADD CONSTRAINT customer_invoice_items_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES projects(id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'customer_invoice_items_cost_center_id_fkey'
                   AND conrelid = 'customer_invoice_items'::regclass) THEN
    ALTER TABLE customer_invoice_items
      ADD CONSTRAINT customer_invoice_items_cost_center_id_fkey
      FOREIGN KEY (cost_center_id) REFERENCES cost_centres(id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'customer_invoice_items_gl_account_id_fkey'
                   AND conrelid = 'customer_invoice_items'::regclass) THEN
    ALTER TABLE customer_invoice_items
      ADD CONSTRAINT customer_invoice_items_gl_account_id_fkey
      FOREIGN KEY (gl_account_id) REFERENCES gl_accounts(id) NOT VALID;
  END IF;

  SELECT COUNT(*) INTO orphans FROM customer_invoice_items cii
  WHERE cii.gl_account_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM gl_accounts a WHERE a.id = cii.gl_account_id);
  IF orphans = 0 THEN
    ALTER TABLE customer_invoice_items VALIDATE CONSTRAINT customer_invoice_items_gl_account_id_fkey;
  ELSE
    RAISE NOTICE '870: % customer_invoice_items name a missing gl_account_id; FK left NOT VALID', orphans;
  END IF;
END $$;
