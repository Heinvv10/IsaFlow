/**
 * Migration 210: VAT201 Data Model Enhancement
 *
 * Adds vat_type classification to journal lines and supplier invoice items
 * to support proper SARS VAT201 return reporting.
 *
 * SA VAT types:
 *   standard       — 15% standard rate supplies/purchases
 *   zero_rated     — 0% zero-rated supplies (domestic)
 *   exempt         — Exempt supplies (no VAT, not recoverable)
 *   capital_goods  — Standard-rated capital goods (separate VAT201 box)
 *   export         — Zero-rated exports from RSA
 *   imported       — Imported goods/services (reverse charge for services)
 *   reverse_charge — Domestic reverse charge (DRC VAT)
 *   bad_debt       — Bad debt VAT recovery
 *   no_vat         — No VAT applicable (not a taxable supply)
 */

-- 1. Add vat_type to gl_journal_lines
ALTER TABLE gl_journal_lines
  ADD COLUMN IF NOT EXISTS vat_type TEXT;

-- 2. Add vat_classification to supplier_invoice_items
ALTER TABLE supplier_invoice_items
  ADD COLUMN IF NOT EXISTS vat_classification TEXT;

-- 3. Add adjustment_category to vat_adjustments
ALTER TABLE vat_adjustments
  ADD COLUMN IF NOT EXISTS adjustment_category TEXT
    DEFAULT 'other'
    CHECK (adjustment_category IN ('bad_debt', 'import', 'prior_period', 'change_in_use', 'other'));

-- 4. Default existing VAT journal lines based on GL account
-- Lines to VAT Output (2120) → standard
UPDATE gl_journal_lines jl
SET vat_type = 'standard'
WHERE vat_type IS NULL
  AND gl_account_id IN (
    SELECT id FROM gl_accounts WHERE account_code = '2120'
  );

-- Lines to VAT Input (1140) → standard
UPDATE gl_journal_lines jl
SET vat_type = 'standard'
WHERE vat_type IS NULL
  AND gl_account_id IN (
    SELECT id FROM gl_accounts WHERE account_code = '1140'
  );

-- 5. Default existing supplier invoice items based on tax_rate
UPDATE supplier_invoice_items
SET vat_classification = CASE
  WHEN tax_rate > 0 THEN 'standard'
  ELSE 'zero_rated'
END
WHERE vat_classification IS NULL;

-- 6. Index for VAT reporting queries
CREATE INDEX IF NOT EXISTS idx_journal_lines_vat_type
  ON gl_journal_lines (vat_type)
  WHERE vat_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_journal_lines_vat_reporting
  ON gl_journal_lines (gl_account_id, vat_type)
  WHERE vat_type IS NOT NULL;
