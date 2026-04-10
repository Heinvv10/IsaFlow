-- ── 254: System Account Subtypes ──────────────────────────────────────────────
-- Assign account_subtype to all system accounts so that business logic can
-- resolve them by subtype instead of hardcoded account codes.
-- This decouples GL posting from specific numbering schemes, enabling
-- customers to migrate from Sage/Xero/QuickBooks with their own codes.

-- Current Assets
UPDATE gl_accounts SET account_subtype = 'bank',        is_system_account = true  WHERE account_code = '1110' AND account_subtype IS NULL;
UPDATE gl_accounts SET account_subtype = 'receivable',  is_system_account = true  WHERE account_code = '1120' AND account_subtype IS NULL;
UPDATE gl_accounts SET account_subtype = 'vat_input',   is_system_account = true  WHERE account_code = '1140' AND account_subtype IS NULL;

-- Non-Current Assets
UPDATE gl_accounts SET account_subtype = 'accumulated_depreciation', is_system_account = true WHERE account_code = '1230' AND account_subtype IS NULL;

-- Current Liabilities
UPDATE gl_accounts SET account_subtype = 'payable',     is_system_account = true  WHERE account_code = '2110' AND account_subtype IS NULL;
UPDATE gl_accounts SET account_subtype = 'vat_output',  is_system_account = true  WHERE account_code = '2120' AND account_subtype IS NULL;

-- Equity
UPDATE gl_accounts SET account_subtype = 'retained_earnings', is_system_account = true WHERE account_code = '3200' AND account_subtype IS NULL;

-- Revenue
UPDATE gl_accounts SET account_subtype = 'default_revenue',   is_system_account = true WHERE account_code = '4100' AND account_subtype IS NULL;
UPDATE gl_accounts SET account_subtype = 'other_income'       WHERE account_code = '4300' AND account_subtype IS NULL;

-- Expenses
UPDATE gl_accounts SET account_subtype = 'default_expense',       is_system_account = true WHERE account_code = '5100' AND account_subtype IS NULL;
UPDATE gl_accounts SET account_subtype = 'admin_expense',         is_system_account = true WHERE account_code = '5600' AND account_subtype IS NULL;
UPDATE gl_accounts SET account_subtype = 'depreciation_expense',  is_system_account = true WHERE account_code = '5800' AND account_subtype IS NULL;
