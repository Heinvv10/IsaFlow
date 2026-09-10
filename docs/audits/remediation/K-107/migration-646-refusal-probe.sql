-- Proof that migration 646 refuses on ORDINARY duplicate supplier bills, not
-- just the RSINV- rows this defect minted. Run against a disposable fixture:
--   psql "$DATABASE_URL" -f docs/audits/remediation/K-107/migration-646-refusal-probe.sql
-- It rolls back, so it leaves nothing behind. Expected: the migration aborts
-- naming both duplicate groups (INV-9001 and MANUAL-77), neither of which the
-- old RSINV-only probe would have found.
BEGIN;
DROP INDEX IF EXISTS uq_supplier_invoices_supplier_number;
SET LOCAL session_replication_role = replica;  -- skip FK checks for the probe rows
INSERT INTO supplier_invoices (id, company_id, supplier_id, invoice_number, invoice_date, subtotal, total_amount, created_by)
VALUES
 (gen_random_uuid(),'11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','INV-9001',CURRENT_DATE,10,10,'33333333-3333-3333-3333-333333333333'),
 (gen_random_uuid(),'11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','INV-9001',CURRENT_DATE,10,10,'33333333-3333-3333-3333-333333333333'),
 (gen_random_uuid(),'11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','MANUAL-77',CURRENT_DATE,10,10,'33333333-3333-3333-3333-333333333333'),
 (gen_random_uuid(),'11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','MANUAL-77',CURRENT_DATE,10,10,'33333333-3333-3333-3333-333333333333');
\i scripts/migrations/sql/646_supplier_invoice_number_unique.sql
ROLLBACK;
