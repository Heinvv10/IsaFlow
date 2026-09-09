-- 625 — make supplier_invoices.duplicate_fingerprint enforce uniqueness PER SUPPLIER
--
-- The migration wizard's AP step INSERTs with ON CONFLICT DO NOTHING and writes
-- computeFingerprint() into duplicate_fingerprint, intending a re-run of the
-- same source file to be a no-op. It never was: supplier_invoices carried
-- exactly one unique index, the primary key on id, and
-- idx_supplier_invoices_duplicate_fp (migration 412) is NOT unique. A
-- target-less ON CONFLICT DO NOTHING therefore matched nothing, and
-- re-submitting a file after a partial failure — the obvious user action, since
-- the response reports skipped rows — inserted every bill a second time and
-- posted a second AP control credit for each. customer_invoices was protected
-- all along by uq_customer_invoices_company_number; supplier_invoices had
-- nothing.
--
-- KEYED ON supplier_id, not on (company_id, fingerprint) alone. computeFingerprint
-- substitutes the literal 'no-vat' when a supplier has no VAT number, so the key
-- collapses to 'no-vat|<invoice number>|<total>' for every VAT-less supplier in
-- a tenant. Without supplier_id in the key, two different VAT-less suppliers
-- billing the same invoice number for the same amount would collide — a false
-- duplicate, and one the wizard would report as "already imported" against the
-- wrong supplier. supplier_id is NOT NULL on this table, and
-- captureDeduplicationService.findDuplicate already scopes its exact-match probe
-- by supplier_id, so per-supplier is the identity the rest of the system
-- already means by "duplicate".
--
-- Five paths besides the wizard stamp this column on INSERT
-- (supplierInvoiceService, capture publish, the AI invoice pipeline, the Sage
-- import and recurring transactions). Scoping to the supplier keeps this
-- constraint to what all of them already treat as a duplicate.
--
-- PARTIAL on two predicates, both reproduced verbatim by the ON CONFLICT clause
-- in migrationApService.ts so the arbiter can be inferred:
--   duplicate_fingerprint IS NOT NULL — nearly every row IsaFlow originated has
--                                       no fingerprint, and those must not
--                                       collide with each other.
--   deleted_at IS NULL               — a soft-deleted bill must not block the
--                                       re-import of a corrected one.
--
-- idx_supplier_invoices_duplicate_fp (412) is deliberately KEPT. It looks
-- redundant, but findDuplicate's probe carries no deleted_at predicate, so the
-- planner cannot use a partial index restricted to deleted_at IS NULL for it.
--
-- DEPLOY NOTE: CREATE UNIQUE INDEX (not CONCURRENTLY — that cannot run inside a
-- migration transaction) holds a lock that blocks writes to supplier_invoices
-- for the duration of the build. On a large tenant, run this out of hours.

-- A pre-existing duplicate would make CREATE UNIQUE INDEX fail with an opaque
-- message mid-deploy, and deploy.sh runs migrations before the rsync. Fail with
-- an actionable one instead, naming the tenants to look at.
DO $$
DECLARE offenders TEXT;
BEGIN
  SELECT string_agg(DISTINCT company_id::TEXT, ', ') INTO offenders FROM (
    SELECT company_id, supplier_id, duplicate_fingerprint
      FROM supplier_invoices
     WHERE duplicate_fingerprint IS NOT NULL
       AND deleted_at IS NULL
     GROUP BY company_id, supplier_id, duplicate_fingerprint
    HAVING COUNT(*) > 1
  ) d;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'supplier_invoices already holds live duplicate (supplier_id, duplicate_fingerprint) rows in company_id(s): %. Resolve them before this index can be created.',
      offenders;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_invoices_supplier_fingerprint
  ON supplier_invoices (company_id, supplier_id, duplicate_fingerprint)
  WHERE duplicate_fingerprint IS NOT NULL AND deleted_at IS NULL;
