-- Migration 394: Origination fee + VAT type on loans
--
-- PRD-03 §10 compliance: loan interest is VAT exempt but origination
-- fees are taxable. The current loan model had no fee field — this
-- migration adds it along with the VAT classification.
--
-- vat_type values:
--   'standard' — 15% VAT (SA default)
--   'zero'     — zero-rated
--   'exempt'   — VAT-exempt (e.g. inter-company admin fees)

ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS origination_fee numeric(18,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS origination_fee_vat_type text DEFAULT 'standard'
    CHECK (origination_fee_vat_type IN ('standard', 'zero', 'exempt'));

COMMENT ON COLUMN loans.origination_fee IS
  'Upfront origination / administration fee charged at loan start (ZAR, excl VAT)';
COMMENT ON COLUMN loans.origination_fee_vat_type IS
  'VAT treatment: standard (15%), zero, or exempt. Interest itself is always VAT-exempt.';
