-- BL-05 + BL-06: Normalize VAT and retained_earnings account_subtype values.
--
-- BEFORE:
--   DEMO  (00000000-0000-0000-0000-000000000001):
--     1140 VAT Input        → account_subtype = 'other_current_asset'  (wrong)
--     2120 VAT Output       → account_subtype = 'tax'                  (wrong)
--     3200 Retained Earnings→ account_subtype = 'retained_earnings'    (correct, no-op)
--   Brightsphere (d27bac33-cdc0-4e58-bf6b-709c1597d41c):
--     SYS10 VAT Provision   → account_subtype = 'current_liabilities'  (not vat_output)
--     SYS11 Retained Income → account_subtype = 'equity'               (wrong)
--     No vat_input account exists at all.
--
-- NOTE: The column storing the display name is `account_name`, not `name`.

-- BL-05: Fix VAT Output subtype for DEMO (account_subtype = 'tax').
UPDATE gl_accounts
SET account_subtype = 'vat_output'
WHERE is_system_account = true
  AND (account_name ILIKE '%VAT Output%' OR account_code IN ('2120'))
  AND account_subtype IN ('tax', 'other_current_liability');

-- BL-05: Fix VAT Input subtype for DEMO (account_subtype = 'other_current_asset').
UPDATE gl_accounts
SET account_subtype = 'vat_input'
WHERE is_system_account = true
  AND (account_name ILIKE '%VAT Input%' OR account_code IN ('1140'))
  AND account_subtype IN ('other_current_asset', 'tax');

-- BL-06: Fix retained_earnings subtype for Brightsphere SYS11 and any other equity
--        system accounts named "Retained*" / "Retained Income*".
UPDATE gl_accounts
SET account_subtype = 'retained_earnings'
WHERE is_system_account = true
  AND account_type = 'equity'
  AND (account_name ILIKE '%retained%')
  AND account_subtype IS DISTINCT FROM 'retained_earnings';

-- BL-05: Seed missing VAT Input system account for companies that have none.
--        Brightsphere has no account with account_subtype = 'vat_input' at all.
--        normal_balance is NOT NULL; assets use 'debit'.
INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_system_account, is_active)
SELECT c.id, '1140', 'VAT Input', 'asset', 'vat_input', 'debit', true, true
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM gl_accounts ga
  WHERE ga.company_id = c.id AND ga.account_subtype = 'vat_input'
)
ON CONFLICT DO NOTHING;

-- BL-05: Seed missing VAT Output system account for companies that have none.
--        Brightsphere has no account with account_subtype = 'vat_output' at all.
--        normal_balance is NOT NULL; liabilities use 'credit'.
INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_system_account, is_active)
SELECT c.id, '2120', 'VAT Output', 'liability', 'vat_output', 'credit', true, true
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM gl_accounts ga
  WHERE ga.company_id = c.id AND ga.account_subtype = 'vat_output'
)
ON CONFLICT DO NOTHING;
