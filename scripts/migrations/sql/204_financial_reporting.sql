-- Migration 204: Financial Reporting Setup
-- PRD-060: FibreFlow Accounting Module - Phase 5
-- Account subtype classification for Income Statement / Balance Sheet

-- ── Classify account subtypes for reporting ──────────────────────────────────

-- Assets
UPDATE gl_accounts SET account_subtype = 'bank' WHERE account_code = '1110';
UPDATE gl_accounts SET account_subtype = 'receivable' WHERE account_code = '1120';
UPDATE gl_accounts SET account_subtype = 'other_current_asset' WHERE account_code IN ('1130', '1140');
UPDATE gl_accounts SET account_subtype = 'fixed_asset' WHERE account_code IN ('1210', '1220');
UPDATE gl_accounts SET account_subtype = 'accumulated_depreciation' WHERE account_code = '1230';

-- Liabilities
UPDATE gl_accounts SET account_subtype = 'payable' WHERE account_code = '2110';
UPDATE gl_accounts SET account_subtype = 'tax' WHERE account_code = '2120';
UPDATE gl_accounts SET account_subtype = 'other_current_liability' WHERE account_code = '2130';
UPDATE gl_accounts SET account_subtype = 'other' WHERE account_code = '2210';

-- Equity
UPDATE gl_accounts SET account_subtype = 'equity' WHERE account_code = '3100';
UPDATE gl_accounts SET account_subtype = 'retained_earnings' WHERE account_code = '3200';

-- Revenue
UPDATE gl_accounts SET account_subtype = 'revenue' WHERE account_code IN ('4100', '4200', '4300');

-- Expenses: classify cost of sales vs operating
UPDATE gl_accounts SET account_subtype = 'cost_of_sales' WHERE account_code IN ('5100', '5200', '5300');
UPDATE gl_accounts SET account_subtype = 'operating_expense' WHERE account_code IN ('5400', '5500', '5600', '5700');
