-- 646: one bill per supplier document number (K-107)
--
-- The recurring-transaction runner built its AP number from the template name
-- and the CALENDAR MONTH, so a daily or weekly supplier template minted an
-- identical bill on every run — same invoice_number, same duplicate_fingerprint
-- — inflating accounts payable and input VAT. The customer side failed loudly
-- on uq_customer_invoices_company_number; AP had nothing to fail on.
--
-- The uniqueness domain is (company_id, supplier_id, invoice_number), NOT
-- (company_id, invoice_number): invoice_number is the SUPPLIER's own document
-- number, and two unrelated suppliers issuing "INV-001" is ordinary. Partial on
-- deleted_at IS NULL so a soft-deleted capture does not block re-entering the
-- bill, and on a non-blank number so legacy imports that left it empty are not
-- collapsed into one row.
--
-- FAIL-CLOSED, AND LOUDLY. The pre-flight below uses EXACTLY the index
-- predicate and grouping, so it cannot report all-clear on a database the index
-- will then refuse. Duplicates from ANY origin count — manual capture, Sage
-- sync, PO conversion, import — not just the RSINV- rows this defect minted.
-- On a hit the migration aborts with the offending groups named, instead of
-- leaving the operator to decode a CREATE INDEX "Key ... is duplicated" detail
-- that shows only the first collision.

DO $$
DECLARE
  dup_groups INTEGER;
  dup_rows   BIGINT;
  dup_list   TEXT;
BEGIN
  IF to_regclass('public.uq_supplier_invoices_supplier_number') IS NOT NULL THEN
    RAISE NOTICE '646: uq_supplier_invoices_supplier_number already present — nothing to do.';
    RETURN;
  END IF;

  CREATE TEMP TABLE tmp_646_dups ON COMMIT DROP AS
    SELECT company_id, supplier_id, invoice_number, count(*) AS n
      FROM supplier_invoices
     WHERE deleted_at IS NULL AND invoice_number <> ''
     GROUP BY company_id, supplier_id, invoice_number
    HAVING count(*) > 1;

  SELECT count(*), COALESCE(sum(n), 0) INTO dup_groups, dup_rows FROM tmp_646_dups;

  IF dup_groups > 0 THEN
    SELECT string_agg(
             format('company=%s supplier=%s invoice_number=%L (%s bills)',
                    company_id, supplier_id, invoice_number, n),
             E'\n  ' ORDER BY n DESC, invoice_number)
      INTO dup_list
      FROM (SELECT * FROM tmp_646_dups ORDER BY n DESC, invoice_number LIMIT 20) t;

    RAISE EXCEPTION
      'Migration 646 refused: % duplicate (company_id, supplier_id, invoice_number) group(s) covering % bills.%  First % shown:%  %',
      dup_groups, dup_rows, E'\n', least(dup_groups, 20), E'\n  ', dup_list
      USING HINT =
        'These are duplicate supplier bills. Soft-delete or renumber the extras '
        'so each (company_id, supplier_id, invoice_number) appears once among rows '
        'with deleted_at IS NULL and invoice_number <> '''', then re-run. '
        'See docs/audits/remediation/K-107/fix.md for the probe query.';
  END IF;

  CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_invoices_supplier_number
    ON supplier_invoices (company_id, supplier_id, invoice_number)
    WHERE deleted_at IS NULL AND invoice_number <> '';
END $$;
