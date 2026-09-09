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
-- FAIL-CLOSED: this index will not build if duplicates already exist. Run the
-- probe in docs/audits/remediation/K-107/fix.md first and clean them.

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_invoices_supplier_number
  ON supplier_invoices (company_id, supplier_id, invoice_number)
  WHERE deleted_at IS NULL AND invoice_number <> '';
