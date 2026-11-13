-- 986: a supplier's reused invoice number is two bills when they are two source documents
--      (brief step 3, 13 Nov 2026).
--
-- WHY. Migration 646 made (company_id, supplier_id, invoice_number) unique among live bills (K-107:
-- the recurring runner minted the same bill on every run). It also refuses a REAL case: a supplier
-- that reused its own number on a different document. On the Velocity Fibre rebuild such pairs
-- (e.g. Sage SIV5490, "INV0663" again in October) had to be suffixed by hand ("INV0663 (Oct)"), so the
-- IsaFlow number no longer matched the supplier's paperwork.
--
-- WHAT. The same index name, with the bill's source identity (migration 530's external_system +
-- external_ref) added to the key:
--   * two bills with NO external_ref and the same number: still refused (K-107 unchanged; every
--     REST, capture, PO and recurring path writes no external_ref);
--   * two bills with the same number and DIFFERENT source refs: allowed;
--   * the same source ref twice: still refused here as well (the MCP create also takes a lock and
--     returns the existing bill before it inserts).
-- A bill WITH a ref may share its number with one WITHOUT: the MCP create returns a live bill with the
-- same ref first, but a hand-keyed copy of a loaded bill is not caught by this index. Accepted: that
-- is the duplicate_fingerprint / integrity checks' job.
--
-- SAFE ON EXISTING DATA. The new key is strictly finer than 646's, so every set of rows 646 accepted
-- is accepted here: CREATE UNIQUE INDEX cannot fail on data the old index held. The name is kept
-- because recurringTransactionInvoices.ts matches its 23505 on it.
--
-- Rollback (down SQL), only while no two live bills share (supplier, number) with different refs:
--   DROP INDEX IF EXISTS uq_supplier_invoices_supplier_number;
--   CREATE UNIQUE INDEX uq_supplier_invoices_supplier_number
--     ON supplier_invoices (company_id, supplier_id, invoice_number)
--     WHERE deleted_at IS NULL AND invoice_number <> '';

SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS uq_supplier_invoices_supplier_number;

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_invoices_supplier_number
  ON supplier_invoices (
    company_id, supplier_id, invoice_number,
    (COALESCE(external_system, '')), (COALESCE(external_ref, ''))
  )
  WHERE deleted_at IS NULL AND invoice_number <> '';
