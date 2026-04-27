-- Migration 476: Seed default chart-of-accounts + fiscal periods for every
-- new tenant on company creation, and backfill existing tenants that are
-- missing the seed.
--
-- Background: create_company_with_owner (mig 459 SECURITY DEFINER) inserts
-- the companies + company_users rows but seeds nothing else. New tenants
-- start with an empty GL — every workbench / portfolio / AFS feature is
-- broken for them on day 1. Existing dev shows 20 of 23 tenants missing
-- parent CoA codes (mig 471 RAISE NOTICE flagged this).
--
-- This migration adds three idempotent SECURITY DEFINER helper functions
-- and wires them into create_company_with_owner so every company creation
-- after this migration gets the standard taxonomy. The backfill block at
-- the end runs the same helpers for every existing tenant.
--
-- Idempotent: every INSERT uses NOT EXISTS / ON CONFLICT DO NOTHING.
-- Re-running this whole migration is a no-op for tenants already seeded.

-- ── Helper 1: Default Chart of Accounts (32 accounts, 3 levels) ─────────────
--
-- Mirrors the original mig-200 single-tenant seed plus payroll/loan
-- additions from mig 347 and mig 471 (2140-2175, 2210-2215, 5810).
CREATE OR REPLACE FUNCTION public.seed_company_chart_of_accounts(p_company_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Level 1: Top categories
  INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level, display_order, is_system_account, is_active)
  VALUES
    (p_company_id, '1000', 'Assets',      'asset',     'debit',  1, 100, true, true),
    (p_company_id, '2000', 'Liabilities', 'liability', 'credit', 1, 200, true, true),
    (p_company_id, '3000', 'Equity',      'equity',    'credit', 1, 300, true, true),
    (p_company_id, '4000', 'Revenue',     'revenue',   'credit', 1, 400, true, true),
    (p_company_id, '5000', 'Expenses',    'expense',   'debit',  1, 500, true, true)
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
    ('2215', 'Current Portion of LT Debt',              'liability', 'current_liability',        'credit', 219, true,  '2100'),
    -- Non-Current Liabilities
    ('2210', 'Long-term Loans',                         'liability', NULL,                       'credit', 221, false, '2200'),
    -- Equity
    ('3100', 'Share Capital',                           'equity',    'equity',                   'credit', 310, true,  '3000'),
    ('3200', 'Retained Earnings',                       'equity',    'retained_earnings',        'credit', 320, true,  '3000'),
    -- Revenue
    ('4100', 'Sales Revenue',                           'revenue',   'default_revenue',          'credit', 410, true,  '4000'),
    ('4200', 'Service Revenue',                         'revenue',   'revenue',                  'credit', 420, false, '4000'),
    ('4300', 'Other Income',                            'revenue',   'other_income',             'credit', 430, false, '4000'),
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

REVOKE ALL ON FUNCTION public.seed_company_chart_of_accounts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_company_chart_of_accounts(uuid) TO app_user, migration_admin;

-- ── Helper 2: Fiscal Periods for current + next calendar year ───────────────
--
-- Idempotent: ON CONFLICT (company_id, fiscal_year, period_number) DO NOTHING.
CREATE OR REPLACE FUNCTION public.seed_company_fiscal_periods(p_company_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  cur_year integer := EXTRACT(year FROM CURRENT_DATE)::integer;
  yr integer;
  m  integer;
BEGIN
  -- fiscal_periods has no unique index on (company_id, fiscal_year,
  -- period_number) yet, so we can't use ON CONFLICT — gate on NOT EXISTS.
  FOR yr IN cur_year..(cur_year + 1) LOOP
    FOR m IN 1..12 LOOP
      INSERT INTO fiscal_periods (
        company_id, period_name, period_number, fiscal_year, start_date, end_date, status
      )
      SELECT
        p_company_id,
        TO_CHAR(MAKE_DATE(yr, m, 1), 'FMMonth YYYY'),
        m,
        yr,
        MAKE_DATE(yr, m, 1),
        (MAKE_DATE(yr, m, 1) + INTERVAL '1 month' - INTERVAL '1 day')::date,
        'open'
      WHERE NOT EXISTS (
        SELECT 1 FROM fiscal_periods
        WHERE company_id = p_company_id
          AND fiscal_year = yr
          AND period_number = m
      );
    END LOOP;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_company_fiscal_periods(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_company_fiscal_periods(uuid) TO app_user, migration_admin;

-- ── Helper 3: Umbrella seeder (call all sub-seeders) ────────────────────────
CREATE OR REPLACE FUNCTION public.seed_company_default_taxonomy(p_company_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.seed_company_chart_of_accounts(p_company_id);
  PERFORM public.seed_company_fiscal_periods(p_company_id);
  -- afs_statement_lines is seeded separately by mig 472/474 (one canonical
  -- catalogue is upserted across every tenant in those migrations). The
  -- next time the AFS engine touches this company it will be present.
END;
$$;

REVOKE ALL ON FUNCTION public.seed_company_default_taxonomy(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_company_default_taxonomy(uuid) TO app_user, migration_admin;

-- ── Wire the umbrella into create_company_with_owner ────────────────────────
--
-- Re-creates the function from mig 459 with one extra line: a PERFORM call
-- to seed_company_default_taxonomy after the company + company_users rows
-- are inserted. Everything else is verbatim from mig 459.
CREATE OR REPLACE FUNCTION public.create_company_with_owner(payload jsonb)
  RETURNS public.companies
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  caller_id        text := auth.uid();
  is_first_company boolean;
  new_row          public.companies;
BEGIN
  IF caller_id IS NULL OR caller_id = '' THEN
    RAISE EXCEPTION 'create_company_with_owner: not authenticated';
  END IF;

  IF COALESCE(payload->>'name', '') = '' THEN
    RAISE EXCEPTION 'create_company_with_owner: name is required';
  END IF;

  INSERT INTO public.companies (
    name, registered_name, trading_name, registration_number, vat_number, tax_number,
    email, phone, website,
    address_line1, address_line2, city, province, postal_code, country,
    logo_data,
    bank_name, bank_account_number, bank_branch_code, bank_account_type,
    financial_year_start, vat_period, vat_period_alignment, default_currency
  ) VALUES (
    payload->>'name',
    payload->>'name',
    payload->>'tradingName',
    payload->>'registrationNumber',
    payload->>'vatNumber',
    payload->>'taxNumber',
    payload->>'email',
    payload->>'phone',
    payload->>'website',
    payload->>'addressLine1',
    payload->>'addressLine2',
    payload->>'city',
    payload->>'province',
    payload->>'postalCode',
    COALESCE(payload->>'country', 'South Africa'),
    payload->>'logoData',
    payload->>'bankName',
    payload->>'bankAccountNumber',
    payload->>'bankBranchCode',
    COALESCE(payload->>'bankAccountType', 'current'),
    COALESCE((payload->>'financialYearStart')::int, 3),
    COALESCE(payload->>'vatPeriod', 'bi-monthly'),
    COALESCE(payload->>'vatPeriodAlignment', 'odd'),
    COALESCE(payload->>'defaultCurrency', 'ZAR')
  ) RETURNING * INTO new_row;

  SELECT NOT EXISTS (
    SELECT 1 FROM public.company_users WHERE user_id = caller_id
  ) INTO is_first_company;

  INSERT INTO public.company_users (company_id, user_id, role, is_default)
  VALUES (new_row.id, caller_id, 'owner', is_first_company);

  -- New: seed the default taxonomy so every workbench/portfolio/AFS feature
  -- has the GL accounts and fiscal periods it expects on day 1.
  PERFORM public.seed_company_default_taxonomy(new_row.id);

  RETURN new_row;
END;
$$;

REVOKE ALL ON FUNCTION public.create_company_with_owner(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_company_with_owner(jsonb) TO app_user, migration_admin;

-- ── Backfill existing tenants ───────────────────────────────────────────────
--
-- Run the seeder for EVERY existing company. The function is idempotent
-- (NOT EXISTS / ON CONFLICT DO NOTHING in every insert), so tenants that
-- are already fully seeded are unchanged. Catches both empty-CoA tenants
-- AND tenants with partial seeds (e.g. CoA seeded but fiscal_periods
-- never created).
DO $$
DECLARE
  c_id uuid;
  total_count int := 0;
BEGIN
  FOR c_id IN SELECT id FROM companies LOOP
    PERFORM public.seed_company_default_taxonomy(c_id);
    total_count := total_count + 1;
  END LOOP;

  RAISE NOTICE 'mig 476: ran default-taxonomy seeder against % tenant(s) (idempotent)', total_count;
END $$;
