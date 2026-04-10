-- ============================================================================
-- Migration 283: Auto-VAT defaults for GL accounts
-- Sets intelligent default_vat_code based on SA tax law so that bank
-- transaction allocations auto-populate the correct VAT treatment.
-- IMPORTANT: Specific overrides run BEFORE broad type-based updates.
-- ============================================================================

-- ── Specific account overrides first (these take priority) ──

-- Bank charges: exempt from VAT (financial services, s2 VAT Act)
UPDATE gl_accounts SET default_vat_code = 'exempt'
WHERE account_code = '5700';

-- Insurance: exempt (short-term insurance, s2 VAT Act)
UPDATE gl_accounts SET default_vat_code = 'exempt'
WHERE account_code = '5650';

-- Salaries & wages: not a supply, no VAT
UPDATE gl_accounts SET default_vat_code = 'none'
WHERE account_code = '5200';

-- Medical aid contributions: not a supply, no VAT
UPDATE gl_accounts SET default_vat_code = 'none'
WHERE account_code = '5210';

-- Interest / other income: exempt from VAT (s12(a) VAT Act)
UPDATE gl_accounts SET default_vat_code = 'exempt'
WHERE account_code IN ('4300', '4310');

-- Depreciation: non-cash, no VAT
UPDATE gl_accounts SET default_vat_code = 'none'
WHERE account_subtype = 'depreciation_expense';

-- ── Broad type-based updates (only touch accounts not yet set) ──

-- Revenue accounts: most SA revenue is standard-rated
UPDATE gl_accounts SET default_vat_code = 'standard'
WHERE account_type = 'revenue'
  AND account_subtype IN ('default_revenue', 'revenue')
  AND (default_vat_code IS NULL OR default_vat_code = 'none');

-- Interest / other income: exempt (catch subtype-based)
UPDATE gl_accounts SET default_vat_code = 'exempt'
WHERE account_type = 'revenue'
  AND account_subtype = 'other_income'
  AND (default_vat_code IS NULL OR default_vat_code = 'none');

-- Expense accounts: most expenses carry claimable input VAT
UPDATE gl_accounts SET default_vat_code = 'standard'
WHERE account_type = 'expense'
  AND account_subtype IN ('operating_expense', 'admin_expense', 'default_expense', 'cost_of_sales')
  AND (default_vat_code IS NULL OR default_vat_code = 'none');

-- Balance sheet accounts: no VAT by default
UPDATE gl_accounts SET default_vat_code = 'none'
WHERE account_type IN ('asset', 'liability', 'equity')
  AND (default_vat_code IS NULL);
