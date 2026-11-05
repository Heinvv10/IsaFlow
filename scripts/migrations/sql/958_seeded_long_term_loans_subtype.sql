-- Migration 958: the seeded "Long-term Loans" (2210) carries the long_term_liability subtype
-- 2026-11-05 | fix/coa-long-term-loans-subtype (Hein approved, 2026-11-05)
--
-- WHY. seed_company_chart_of_accounts has seeded 2210 Long-term Loans with NO subtype since mig 200/476. A liability with
-- no subtype defaults to CURRENT on the balance sheet (accountSubtypes.isCurrentSubtype) and lands in OPERATING on both
-- cash flow statements, so a loan drawdown read as operating cash. Dev: 60 of 64 charts. Production (read-only count,
-- 2026-11-05): 18 accounts in 18 companies, all named "Long-term Loans" with a NULL subtype, none with a journal line.
-- One other 2210 carries `other` and is NOT touched, as no user-set subtype is.
--
-- 1. The seeder: this is 701's body byte for byte except the 2210 row's subtype (new companies are right from creation).
-- 2. Existing companies: the NULL-subtype 2210 rows named exactly "Long-term Loans", on a liability account. Idempotent:
--    a re-run finds nothing with a NULL subtype. Triggers on gl_accounts (normalise subtype, updated_at, entity change
--    capture) all fire as for any edit; there is no re-type or parent guard on this table.
-- 3. 930's definer registry: this changes one reviewed SECURITY DEFINER function, so its row's hash is updated here.
--
-- Runs as the deploy (owner) role, not a superuser: it only UPDATEs and redefines a function that role owns.

CREATE OR REPLACE FUNCTION public.seed_company_chart_of_accounts(p_company_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Level 1: Top categories
  -- CHANGED (609): 4000/5000 carry a subtype. The income statement bands on
  -- account_subtype and the TypeScript templates were fixed in the same PR;
  -- this function is the path company registration actually takes.
  INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, level, display_order, is_system_account, is_active)
  VALUES
    (p_company_id, '1000', 'Assets',      'asset',     NULL,                'debit',  1, 100, true, true),
    (p_company_id, '2000', 'Liabilities', 'liability', NULL,                'credit', 1, 200, true, true),
    (p_company_id, '3000', 'Equity',      'equity',    NULL,                'credit', 1, 300, true, true),
    (p_company_id, '4000', 'Revenue',     'revenue',   'revenue',           'credit', 1, 400, true, true),
    (p_company_id, '5000', 'Expenses',    'expense',   'operating_expense', 'debit',  1, 500, true, true)
  ON CONFLICT DO NOTHING;

  -- Level 2: Sub-categories (parent_account_id resolved per-company)
  INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, display_order, is_system_account, parent_account_id, is_active)
  SELECT p_company_id, v.code, v.name, v.type, v.balance, 2, v.ord, true,
         (SELECT id FROM gl_accounts WHERE company_id = p_company_id AND account_code = v.parent),
         true
  FROM (VALUES
    ('1100', 'Current Assets',          'asset',     'debit',  110, '1000'),
    ('1200', 'Non-Current Assets',      'asset',     'debit',  120, '1000'),
    ('2100', 'Current Liabilities',     'liability', 'credit', 210, '2000'),
    ('2200', 'Non-Current Liabilities', 'liability', 'credit', 220, '2000')
  ) AS v(code, name, type, balance, ord, parent)
  WHERE NOT EXISTS (
    SELECT 1 FROM gl_accounts WHERE company_id = p_company_id AND account_code = v.code
  );

  -- Level 3: Detail accounts
  INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, level, display_order, is_system_account, parent_account_id, is_active)
  SELECT p_company_id, v.code, v.name, v.type, v.subtype, v.balance, 3, v.ord, v.system,
         (SELECT id FROM gl_accounts WHERE company_id = p_company_id AND account_code = v.parent),
         true
  FROM (VALUES
    -- Current Assets
    ('1110', 'Bank - Primary',                          'asset',     'bank',                     'debit',  111, true,  '1100'),
    ('1120', 'Accounts Receivable',                     'asset',     'receivable',               'debit',  112, true,  '1100'),
    ('1130', 'Petty Cash',                              'asset',     'cash',                     'debit',  113, false, '1100'),
    ('1140', 'VAT Input',                               'asset',     'vat_input',                'debit',  114, true,  '1100'),
    -- NEW (701). The clearing account a late input-VAT claim parks the tax on
    -- between the original (in the locked VAT period) and its companion (in
    -- the next open one). Nets to zero once both are posted.
    ('1145', 'Input VAT - late claims',                 'asset',     'vat_input_late_claim',     'debit',  115, true,  '1100'),
    -- Non-Current Assets
    ('1210', 'Equipment',                               'asset',     'fixed_asset',              'debit',  121, false, '1200'),
    ('1220', 'Vehicles',                                'asset',     'fixed_asset',              'debit',  122, false, '1200'),
    ('1230', 'Accumulated Depreciation',                'asset',     'accumulated_depreciation', 'credit', 123, true,  '1200'),
    -- Current Liabilities
    ('2110', 'Accounts Payable',                        'liability', 'payable',                  'credit', 211, true,  '2100'),
    ('2120', 'VAT Output',                              'liability', 'vat_output',               'credit', 212, true,  '2100'),
    ('2130', 'Accrued Expenses',                        'liability', NULL,                       'credit', 213, false, '2100'),
    ('2140', 'PAYE Payable',                            'liability', 'payroll_liability',        'credit', 214, true,  '2100'),
    ('2150', 'UIF Payable',                             'liability', 'payroll_liability',        'credit', 215, true,  '2100'),
    ('2160', 'SDL Payable',                             'liability', 'payroll_liability',        'credit', 216, true,  '2100'),
    ('2170', 'Net Salaries Payable',                    'liability', 'payroll_liability',        'credit', 217, true,  '2100'),
    ('2175', 'Other Employee Deductions Payable',       'liability', 'payroll_liability',        'credit', 218, true,  '2100'),
    -- 2215 lives under 2100 (Current Liabilities) per mig 471 — code prefix
    -- "22xx" is the LT-loans family, but the current PORTION is a current
    -- liability, hence the parent here.
    ('2215', 'Current Portion of LT Debt',              'liability', 'current_liability',        'credit', 219, true,  '2100'),
    -- Non-Current Liabilities
    -- CHANGED (958): carries long_term_liability. With no subtype the balance sheet counts a loan as CURRENT and both
    -- cash flow methods show its drawdowns and repayments as OPERATING; 60 of 64 dev charts had it that way.
    ('2210', 'Long-term Loans',                         'liability', 'long_term_liability',      'credit', 221, false, '2200'),
    -- Equity
    ('3100', 'Share Capital',                           'equity',    'equity',                   'credit', 310, true,  '3000'),
    ('3200', 'Retained Earnings',                       'equity',    'retained_earnings',        'credit', 320, true,  '3000'),
    -- NEW (605). The clearing account an opening trial balance is posted
    -- against; it nets to zero once the opening TB is complete. Absent from
    -- 476 entirely, so `set_opening_balance` had no contra to resolve on 12 of
    -- 13 companies. Code 3300 follows Weszak Beleggings, the one tenant that
    -- already had this account and named it exactly this — the migration is a
    -- no-op there.
    ('3300', 'Opening Balance Equity',                  'equity',    'opening_balance_equity',   'credit', 330, true,  '3000'),
    -- Revenue. NOTE: 4100/4200 deliberately renamed from mig 200's
    -- "Activation Revenue" / "Maintenance Revenue" (which were
    -- fibre-industry-specific) to generic SaaS-friendly defaults.
    -- Tenants who customised these labels are unaffected (NOT EXISTS guard).
    ('4100', 'Sales Revenue',                           'revenue',   'default_revenue',          'credit', 410, true,  '4000'),
    ('4200', 'Service Revenue',                         'revenue',   'revenue',                  'credit', 420, false, '4000'),
    -- CHANGED (605): is_system_account false -> true. The account, its type and
    -- its subtype are unchanged; only the flag the resolver filters on moves.
    -- `items/adjustmentService` resolves other_income for a positive stock
    -- adjustment and threw on 12 of 13 companies because of this one boolean.
    ('4300', 'Other Income',                            'revenue',   'other_income',             'credit', 430, true,  '4000'),
    -- NEW (605). Profit or loss on disposal of a fixed asset. Placed on the
    -- REVENUE side, which is the usual SA presentation — "profit/(loss) on
    -- disposal of fixed assets" sits under other income and a loss shows as a
    -- debit against it. `glAccountSubtypes.ts` permits this subtype on both
    -- revenue and expense and `postAssetDisposalToGL` debits for a loss and
    -- credits for a gain, so either side balances; revenue is the presentation
    -- choice, not an arithmetic one. Code 4410 rather than the tidier 4400
    -- because Weszak already holds 4400 as "Rental Income" — one uniform code
    -- across every tenant beats a code that varies by tenant, because a role
    -- whose code differs per company is a role someone eventually resolves by
    -- code.
    ('4410', 'Profit / Loss on Disposal of Assets',     'revenue',   'disposal_profit_loss',     'credit', 440, true,  '4000'),
    -- Expenses
    ('5100', 'Materials & Supplies',                    'expense',   'default_expense',          'debit',  510, true,  '5000'),
    ('5200', 'Labour Costs',                            'expense',   'operating_expense',        'debit',  520, false, '5000'),
    ('5300', 'Subcontractor Costs',                     'expense',   'operating_expense',        'debit',  530, false, '5000'),
    ('5400', 'Transport & Fuel',                        'expense',   'operating_expense',        'debit',  540, false, '5000'),
    ('5500', 'Equipment Costs',                         'expense',   'operating_expense',        'debit',  550, false, '5000'),
    ('5600', 'Administrative Expenses',                 'expense',   'admin_expense',            'debit',  560, true,  '5000'),
    ('5700', 'Bank Charges',                            'expense',   'operating_expense',        'debit',  570, false, '5000'),
    ('5800', 'Depreciation Expense',                    'expense',   'depreciation_expense',     'debit',  580, true,  '5000'),
    ('5810', 'Interest Expense',                        'expense',   'finance_cost',             'debit',  581, true,  '5000')
  ) AS v(code, name, type, subtype, balance, ord, system, parent)
  WHERE NOT EXISTS (
    SELECT 1 FROM gl_accounts WHERE company_id = p_company_id AND account_code = v.code
  );
END;
$$;

-- Grants restated exactly as 701 left them.
REVOKE ALL ON FUNCTION public.seed_company_chart_of_accounts(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.seed_company_chart_of_accounts(uuid) FROM app_user;
GRANT EXECUTE ON FUNCTION public.seed_company_chart_of_accounts(uuid) TO migration_admin;

-- 2. Existing companies.
UPDATE public.gl_accounts
   SET account_subtype = 'long_term_liability'
 WHERE account_code = '2210'
   AND account_type = 'liability'
   AND account_name = 'Long-term Loans'
   AND account_subtype IS NULL;

-- 3. 930's registry (app_pool_reach_violations refuses a changed definer without it).
DO $$
DECLARE
  n int;
BEGIN
  UPDATE public.app_definer_reviews
     SET body_md5 = public.app_definer_hash('public.seed_company_chart_of_accounts(uuid)'::regprocedure)
   WHERE signature = 'seed_company_chart_of_accounts(uuid)';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION '958: seed_company_chart_of_accounts(uuid) has no row in app_definer_reviews to update (930 registers it)';
  END IF;
END
$$;
