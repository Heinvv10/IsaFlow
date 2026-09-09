-- 625 — make supplier_invoices.duplicate_fingerprint actually enforce uniqueness
--
-- The migration wizard's AP step INSERTs with ON CONFLICT DO NOTHING and writes
-- computeFingerprint() into duplicate_fingerprint, intending a re-run of the
-- same source file to be a no-op. It never was: supplier_invoices carried
-- exactly one unique index, the primary key on id, and
-- idx_supplier_invoices_duplicate_fp is NOT unique. A target-less
-- ON CONFLICT DO NOTHING therefore matched nothing, and re-submitting a file
-- after a partial failure — the obvious user action, since the response reports
-- skipped rows — inserted every bill a second time and posted a second AP
-- control credit for each. customer_invoices was protected all along by
-- uq_customer_invoices_company_number; supplier_invoices had nothing.
--
-- PARTIAL on two predicates, both of which the ON CONFLICT clause in
-- migrationApService.ts reproduces exactly so the arbiter can be inferred:
--   duplicate_fingerprint IS NOT NULL — nearly every row IsaFlow originated has
--                                       no fingerprint, and those must not
--                                       collide with each other.
--   deleted_at IS NULL               — a soft-deleted bill must not block the
--                                       re-import of a corrected one.

-- A pre-existing duplicate would make CREATE UNIQUE INDEX fail with an opaque
-- message mid-deploy. Fail with an actionable one instead.
DO $$
DECLARE dup_groups INT;
BEGIN
  SELECT COUNT(*) INTO dup_groups FROM (
    SELECT company_id, duplicate_fingerprint
      FROM supplier_invoices
     WHERE duplicate_fingerprint IS NOT NULL
       AND deleted_at IS NULL
     GROUP BY company_id, duplicate_fingerprint
    HAVING COUNT(*) > 1
  ) d;
  IF dup_groups > 0 THEN
    RAISE EXCEPTION
      'supplier_invoices already holds % (company_id, duplicate_fingerprint) group(s) with more than one live row. Resolve them before this index can be created.',
      dup_groups;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_invoices_company_fingerprint
  ON supplier_invoices (company_id, duplicate_fingerprint)
  WHERE duplicate_fingerprint IS NOT NULL AND deleted_at IS NULL;
