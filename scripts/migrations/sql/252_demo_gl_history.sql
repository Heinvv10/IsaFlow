-- 252: Historical GL journal entries, payments, and account balances
-- Posts the seeded invoices to the GL so trial balance, income statement,
-- balance sheet, and cash flow reports show real numbers.
-- Uses DO blocks to resolve GL account and fiscal period UUIDs dynamically.

DO $$
DECLARE
  v_company_id UUID := '00000000-0000-0000-0000-000000000001';
  v_admin_id UUID := 'a0000000-0000-0000-0000-000000000001';
  -- GL Accounts
  v_bank UUID;
  v_ar UUID;
  v_vat_input UUID;
  v_vat_output UUID;
  v_ap UUID;
  v_revenue UUID;
  v_maint_revenue UUID;
  v_materials UUID;
  v_labour UUID;
  v_subcontractor UUID;
  v_fuel UUID;
  v_admin_exp UUID;
  v_bank_charges UUID;
  v_equipment UUID;
  -- Fiscal Periods
  v_jan_fp UUID;
  v_feb_fp UUID;
  v_mar_fp UUID;
  -- Journal Entry IDs
  v_je_id UUID;
BEGIN
  -- Resolve GL account IDs
  SELECT id INTO v_bank FROM gl_accounts WHERE account_code='1110' AND company_id=v_company_id;
  SELECT id INTO v_ar FROM gl_accounts WHERE account_code='1120' AND company_id=v_company_id;
  SELECT id INTO v_vat_input FROM gl_accounts WHERE account_code='1140' AND company_id=v_company_id;
  SELECT id INTO v_vat_output FROM gl_accounts WHERE account_code='2120' AND company_id=v_company_id;
  SELECT id INTO v_ap FROM gl_accounts WHERE account_code='2110' AND company_id=v_company_id;
  SELECT id INTO v_revenue FROM gl_accounts WHERE account_code='4100' AND company_id=v_company_id;
  SELECT id INTO v_maint_revenue FROM gl_accounts WHERE account_code='4200' AND company_id=v_company_id;
  SELECT id INTO v_materials FROM gl_accounts WHERE account_code='5100' AND company_id=v_company_id;
  SELECT id INTO v_labour FROM gl_accounts WHERE account_code='5200' AND company_id=v_company_id;
  SELECT id INTO v_subcontractor FROM gl_accounts WHERE account_code='5300' AND company_id=v_company_id;
  SELECT id INTO v_fuel FROM gl_accounts WHERE account_code='5400' AND company_id=v_company_id;
  SELECT id INTO v_admin_exp FROM gl_accounts WHERE account_code='5600' AND company_id=v_company_id;
  SELECT id INTO v_bank_charges FROM gl_accounts WHERE account_code='5700' AND company_id=v_company_id;
  SELECT id INTO v_equipment FROM gl_accounts WHERE account_code='5500' AND company_id=v_company_id;

  -- Resolve fiscal period IDs
  SELECT id INTO v_jan_fp FROM fiscal_periods WHERE period_name='January 2026' AND company_id=v_company_id;
  SELECT id INTO v_feb_fp FROM fiscal_periods WHERE period_name='February 2026' AND company_id=v_company_id;
  SELECT id INTO v_mar_fp FROM fiscal_periods WHERE period_name='March 2026' AND company_id=v_company_id;

  IF v_bank IS NULL OR v_jan_fp IS NULL THEN
    RAISE NOTICE 'GL accounts or fiscal periods not found, skipping GL history seed';
    RETURN;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════
  -- JANUARY 2026 — Paid invoices + customer payments
  -- ═══════════════════════════════════════════════════════════════════════

  -- JE: Sage licence invoice approved (R20,000 incl VAT)
  v_je_id := 'ae000000-0000-0000-0001-000000000001';
  INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, fiscal_period_id, description, source, status, created_by, posted_by, posted_at)
  VALUES (v_je_id, v_company_id, 'JE-2026-00001', '2026-01-15', v_jan_fp, 'Supplier Invoice: SGE-LIC-2026-Q1 - Sage SA', 'auto_supplier_invoice', 'posted', v_admin_id, v_admin_id, '2026-01-15')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description) VALUES
  (gen_random_uuid(), v_je_id, v_admin_exp, 17391.30, 0, 'Sage licence Q1 2026'),
  (gen_random_uuid(), v_je_id, v_vat_input, 2608.70, 0, 'VAT Input'),
  (gen_random_uuid(), v_je_id, v_ap, 0, 20000.00, 'AP - Sage SA')
  ON CONFLICT (id) DO NOTHING;

  -- JE: Sage payment (R20,000)
  v_je_id := 'ae000000-0000-0000-0001-000000000002';
  INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, fiscal_period_id, description, source, status, created_by, posted_by, posted_at)
  VALUES (v_je_id, v_company_id, 'JE-2026-00002', '2026-01-20', v_jan_fp, 'Payment: Sage SA - Licence Q1', 'auto_supplier_payment', 'posted', v_admin_id, v_admin_id, '2026-01-20')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description) VALUES
  (gen_random_uuid(), v_je_id, v_ap, 20000.00, 0, 'AP clearance - Sage SA'),
  (gen_random_uuid(), v_je_id, v_bank, 0, 20000.00, 'Bank payment - Sage SA')
  ON CONFLICT (id) DO NOTHING;

  -- JE: Customer invoice INV-00009 approved (Herotel R40,000)
  v_je_id := 'ae000000-0000-0000-0001-000000000003';
  INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, fiscal_period_id, description, source, status, created_by, posted_by, posted_at)
  VALUES (v_je_id, v_company_id, 'JE-2026-00003', '2026-01-15', v_jan_fp, 'Customer Invoice: INV-00009 - Herotel', 'auto_invoice', 'posted', v_admin_id, v_admin_id, '2026-01-15')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description) VALUES
  (gen_random_uuid(), v_je_id, v_ar, 40000.00, 0, 'AR - Herotel'),
  (gen_random_uuid(), v_je_id, v_revenue, 0, 34782.61, 'Revenue - Rural connectivity'),
  (gen_random_uuid(), v_je_id, v_vat_output, 0, 5217.39, 'VAT Output')
  ON CONFLICT (id) DO NOTHING;

  -- JE: Herotel payment received (R40,000)
  v_je_id := 'ae000000-0000-0000-0001-000000000004';
  INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, fiscal_period_id, description, source, status, created_by, posted_by, posted_at)
  VALUES (v_je_id, v_company_id, 'JE-2026-00004', '2026-01-25', v_jan_fp, 'Payment received: Herotel - INV-00009', 'auto_payment', 'posted', v_admin_id, v_admin_id, '2026-01-25')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description) VALUES
  (gen_random_uuid(), v_je_id, v_bank, 40000.00, 0, 'Bank receipt - Herotel'),
  (gen_random_uuid(), v_je_id, v_ar, 0, 40000.00, 'AR clearance - Herotel')
  ON CONFLICT (id) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════
  -- FEBRUARY 2026 — More activity
  -- ═══════════════════════════════════════════════════════════════════════

  -- JE: Telkom Jan invoice (R5,000)
  v_je_id := 'ae000000-0000-0000-0002-000000000001';
  INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, fiscal_period_id, description, source, status, created_by, posted_by, posted_at)
  VALUES (v_je_id, v_company_id, 'JE-2026-00005', '2026-01-31', v_feb_fp, 'Supplier Invoice: TLK-2026-1100 - Telkom', 'auto_supplier_invoice', 'posted', v_admin_id, v_admin_id, '2026-02-01')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description) VALUES
  (gen_random_uuid(), v_je_id, v_admin_exp, 4347.83, 0, 'Telecoms Jan 2026'),
  (gen_random_uuid(), v_je_id, v_vat_input, 652.17, 0, 'VAT Input'),
  (gen_random_uuid(), v_je_id, v_ap, 0, 5000.00, 'AP - Telkom SA')
  ON CONFLICT (id) DO NOTHING;

  -- JE: Telkom payment (R5,000)
  v_je_id := 'ae000000-0000-0000-0002-000000000002';
  INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, fiscal_period_id, description, source, status, created_by, posted_by, posted_at)
  VALUES (v_je_id, v_company_id, 'JE-2026-00006', '2026-02-03', v_feb_fp, 'Payment: Telkom SA - Jan telecoms', 'auto_supplier_payment', 'posted', v_admin_id, v_admin_id, '2026-02-03')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description) VALUES
  (gen_random_uuid(), v_je_id, v_ap, 5000.00, 0, 'AP clearance - Telkom'),
  (gen_random_uuid(), v_je_id, v_bank, 0, 5000.00, 'Bank payment - Telkom')
  ON CONFLICT (id) DO NOTHING;

  -- JE: Bidvest cleaning Feb (R8,000)
  v_je_id := 'ae000000-0000-0000-0002-000000000003';
  INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, fiscal_period_id, description, source, status, created_by, posted_by, posted_at)
  VALUES (v_je_id, v_company_id, 'JE-2026-00007', '2026-02-01', v_feb_fp, 'Supplier Invoice: BDV-CLN-2026-02 - Bidvest Cleaning', 'auto_supplier_invoice', 'posted', v_admin_id, v_admin_id, '2026-02-01')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description) VALUES
  (gen_random_uuid(), v_je_id, v_admin_exp, 6956.52, 0, 'Cleaning services Feb'),
  (gen_random_uuid(), v_je_id, v_vat_input, 1043.48, 0, 'VAT Input'),
  (gen_random_uuid(), v_je_id, v_ap, 0, 8000.00, 'AP - Bidvest')
  ON CONFLICT (id) DO NOTHING;

  -- JE: Bidvest payment (R8,000)
  v_je_id := 'ae000000-0000-0000-0002-000000000004';
  INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, fiscal_period_id, description, source, status, created_by, posted_by, posted_at)
  VALUES (v_je_id, v_company_id, 'JE-2026-00008', '2026-02-05', v_feb_fp, 'Payment: Bidvest Cleaning - Feb', 'auto_supplier_payment', 'posted', v_admin_id, v_admin_id, '2026-02-05')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description) VALUES
  (gen_random_uuid(), v_je_id, v_ap, 8000.00, 0, 'AP clearance - Bidvest'),
  (gen_random_uuid(), v_je_id, v_bank, 0, 8000.00, 'Bank payment - Bidvest')
  ON CONFLICT (id) DO NOTHING;

  -- JE: Customer invoices (DFA R50K, LinkAfrica R25K, VelocityFibre R200K)
  v_je_id := 'ae000000-0000-0000-0002-000000000005';
  INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, fiscal_period_id, description, source, status, created_by, posted_by, posted_at)
  VALUES (v_je_id, v_company_id, 'JE-2026-00009', '2026-01-31', v_feb_fp, 'Customer Invoice: INV-00007 - DFA', 'auto_invoice', 'posted', v_admin_id, v_admin_id, '2026-02-01')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description) VALUES
  (gen_random_uuid(), v_je_id, v_ar, 50000.00, 0, 'AR - DFA'),
  (gen_random_uuid(), v_je_id, v_revenue, 0, 43478.26, 'Fibre splicing January'),
  (gen_random_uuid(), v_je_id, v_vat_output, 0, 6521.74, 'VAT Output')
  ON CONFLICT (id) DO NOTHING;

  v_je_id := 'ae000000-0000-0000-0002-000000000006';
  INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, fiscal_period_id, description, source, status, created_by, posted_by, posted_at)
  VALUES (v_je_id, v_company_id, 'JE-2026-00010', '2026-02-01', v_feb_fp, 'Customer Invoice: INV-00008 - LinkAfrica', 'auto_invoice', 'posted', v_admin_id, v_admin_id, '2026-02-01')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description) VALUES
  (gen_random_uuid(), v_je_id, v_ar, 25000.00, 0, 'AR - LinkAfrica'),
  (gen_random_uuid(), v_je_id, v_maint_revenue, 0, 21739.13, 'Network maintenance Feb'),
  (gen_random_uuid(), v_je_id, v_vat_output, 0, 3260.87, 'VAT Output')
  ON CONFLICT (id) DO NOTHING;

  v_je_id := 'ae000000-0000-0000-0002-000000000007';
  INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, fiscal_period_id, description, source, status, created_by, posted_by, posted_at)
  VALUES (v_je_id, v_company_id, 'JE-2026-00011', '2026-02-15', v_feb_fp, 'Customer Invoice: INV-00006 - VelocityFibre', 'auto_invoice', 'posted', v_admin_id, v_admin_id, '2026-02-15')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description) VALUES
  (gen_random_uuid(), v_je_id, v_ar, 200000.00, 0, 'AR - VelocityFibre'),
  (gen_random_uuid(), v_je_id, v_revenue, 0, 173913.04, 'FTTH installations Feb batch'),
  (gen_random_uuid(), v_je_id, v_vat_output, 0, 26086.96, 'VAT Output')
  ON CONFLICT (id) DO NOTHING;

  -- JE: Customer payments received in Feb
  v_je_id := 'ae000000-0000-0000-0002-000000000008';
  INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, fiscal_period_id, description, source, status, created_by, posted_by, posted_at)
  VALUES (v_je_id, v_company_id, 'JE-2026-00012', '2026-02-20', v_feb_fp, 'Payments received: DFA R50K, LinkAfrica R25K', 'auto_payment', 'posted', v_admin_id, v_admin_id, '2026-02-20')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description) VALUES
  (gen_random_uuid(), v_je_id, v_bank, 75000.00, 0, 'Bank receipts - DFA + LinkAfrica'),
  (gen_random_uuid(), v_je_id, v_ar, 0, 75000.00, 'AR clearance - DFA + LinkAfrica')
  ON CONFLICT (id) DO NOTHING;

  -- JE: VelocityFibre partial payment (R100K of R200K)
  v_je_id := 'ae000000-0000-0000-0002-000000000009';
  INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, fiscal_period_id, description, source, status, created_by, posted_by, posted_at)
  VALUES (v_je_id, v_company_id, 'JE-2026-00013', '2026-02-25', v_feb_fp, 'Payment received: VelocityFibre partial R100K', 'auto_payment', 'posted', v_admin_id, v_admin_id, '2026-02-25')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description) VALUES
  (gen_random_uuid(), v_je_id, v_bank, 100000.00, 0, 'Bank receipt - VelocityFibre partial'),
  (gen_random_uuid(), v_je_id, v_ar, 0, 100000.00, 'AR partial - VelocityFibre')
  ON CONFLICT (id) DO NOTHING;

  -- Makro partial payment (R15K of R25K)
  v_je_id := 'ae000000-0000-0000-0002-000000000010';
  INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, fiscal_period_id, description, source, status, created_by, posted_by, posted_at)
  VALUES (v_je_id, v_company_id, 'JE-2026-00014', '2026-02-15', v_feb_fp, 'Supplier Invoice: MKR-2026-0389 Equipment', 'auto_supplier_invoice', 'posted', v_admin_id, v_admin_id, '2026-02-15')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description) VALUES
  (gen_random_uuid(), v_je_id, v_equipment, 21739.13, 0, 'Equipment purchase - Makro'),
  (gen_random_uuid(), v_je_id, v_vat_input, 3260.87, 0, 'VAT Input'),
  (gen_random_uuid(), v_je_id, v_ap, 0, 25000.00, 'AP - Makro')
  ON CONFLICT (id) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════
  -- MARCH 2026 — Current period activity
  -- ═══════════════════════════════════════════════════════════════════════

  -- JE: Fuel invoice (R14,000)
  v_je_id := 'ae000000-0000-0000-0003-000000000001';
  INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, fiscal_period_id, description, source, status, created_by, posted_by, posted_at)
  VALUES (v_je_id, v_company_id, 'JE-2026-00015', '2026-03-01', v_mar_fp, 'Supplier Invoice: ENG-F-567890 - Engen Fuel', 'auto_supplier_invoice', 'posted', v_admin_id, v_admin_id, '2026-03-01')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description) VALUES
  (gen_random_uuid(), v_je_id, v_fuel, 12173.91, 0, 'Fuel - company vehicles March'),
  (gen_random_uuid(), v_je_id, v_vat_input, 1826.09, 0, 'VAT Input'),
  (gen_random_uuid(), v_je_id, v_ap, 0, 14000.00, 'AP - Engen')
  ON CONFLICT (id) DO NOTHING;

  -- JE: Vodacom (R7,500)
  v_je_id := 'ae000000-0000-0000-0003-000000000002';
  INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, fiscal_period_id, description, source, status, created_by, posted_by, posted_at)
  VALUES (v_je_id, v_company_id, 'JE-2026-00016', '2026-03-01', v_mar_fp, 'Supplier Invoice: VOD-BUS-2026-034 - Vodacom', 'auto_supplier_invoice', 'posted', v_admin_id, v_admin_id, '2026-03-01')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description) VALUES
  (gen_random_uuid(), v_je_id, v_admin_exp, 6521.74, 0, 'Mobile data March'),
  (gen_random_uuid(), v_je_id, v_vat_input, 978.26, 0, 'VAT Input'),
  (gen_random_uuid(), v_je_id, v_ap, 0, 7500.00, 'AP - Vodacom')
  ON CONFLICT (id) DO NOTHING;

  -- JE: Karabina dev (R40,000)
  v_je_id := 'ae000000-0000-0000-0003-000000000003';
  INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, fiscal_period_id, description, source, status, created_by, posted_by, posted_at)
  VALUES (v_je_id, v_company_id, 'JE-2026-00017', '2026-03-15', v_mar_fp, 'Supplier Invoice: KRB-DEV-2026-03 - Karabina', 'auto_supplier_invoice', 'posted', v_admin_id, v_admin_id, '2026-03-15')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description) VALUES
  (gen_random_uuid(), v_je_id, v_subcontractor, 34782.61, 0, 'Software development March'),
  (gen_random_uuid(), v_je_id, v_vat_input, 5217.39, 0, 'VAT Input'),
  (gen_random_uuid(), v_je_id, v_ap, 0, 40000.00, 'AP - Karabina')
  ON CONFLICT (id) DO NOTHING;

  -- JE: Salary payment (R85,000)
  v_je_id := 'ae000000-0000-0000-0003-000000000004';
  INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, fiscal_period_id, description, source, status, created_by, posted_by, posted_at)
  VALUES (v_je_id, v_company_id, 'JE-2026-00018', '2026-03-25', v_mar_fp, 'Salary payment March 2026', 'manual', 'posted', v_admin_id, v_admin_id, '2026-03-25')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description) VALUES
  (gen_random_uuid(), v_je_id, v_labour, 85000.00, 0, 'Gross salaries March 2026'),
  (gen_random_uuid(), v_je_id, v_bank, 0, 85000.00, 'Bank payment - salaries')
  ON CONFLICT (id) DO NOTHING;

  -- JE: Bank charges (R475)
  v_je_id := 'ae000000-0000-0000-0003-000000000005';
  INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, fiscal_period_id, description, source, status, created_by, posted_by, posted_at)
  VALUES (v_je_id, v_company_id, 'JE-2026-00019', '2026-03-31', v_mar_fp, 'Bank charges March 2026', 'manual', 'posted', v_admin_id, v_admin_id, '2026-03-31')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description) VALUES
  (gen_random_uuid(), v_je_id, v_bank_charges, 475.00, 0, 'Bank charges + SWIFT fee March'),
  (gen_random_uuid(), v_je_id, v_bank, 0, 475.00, 'Bank charges deducted')
  ON CONFLICT (id) DO NOTHING;

  -- JE: Customer invoice INV-00004 Vumatel (R150,000)
  v_je_id := 'ae000000-0000-0000-0003-000000000006';
  INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, fiscal_period_id, description, source, status, created_by, posted_by, posted_at)
  VALUES (v_je_id, v_company_id, 'JE-2026-00020', '2026-03-01', v_mar_fp, 'Customer Invoice: INV-00004 - Vumatel', 'auto_invoice', 'posted', v_admin_id, v_admin_id, '2026-03-01')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description) VALUES
  (gen_random_uuid(), v_je_id, v_ar, 150000.00, 0, 'AR - Vumatel'),
  (gen_random_uuid(), v_je_id, v_revenue, 0, 130434.78, 'Aerial fibre deployment Randburg'),
  (gen_random_uuid(), v_je_id, v_vat_output, 0, 19565.22, 'VAT Output')
  ON CONFLICT (id) DO NOTHING;

  -- JE: Customer invoice INV-00002 Metrofibre (R100,000)
  v_je_id := 'ae000000-0000-0000-0003-000000000007';
  INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, fiscal_period_id, description, source, status, created_by, posted_by, posted_at)
  VALUES (v_je_id, v_company_id, 'JE-2026-00021', '2026-03-15', v_mar_fp, 'Customer Invoice: INV-00002 - Metrofibre', 'auto_invoice', 'posted', v_admin_id, v_admin_id, '2026-03-15')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description) VALUES
  (gen_random_uuid(), v_je_id, v_ar, 100000.00, 0, 'AR - Metrofibre'),
  (gen_random_uuid(), v_je_id, v_revenue, 0, 86956.52, 'Fibre backbone Phase 2'),
  (gen_random_uuid(), v_je_id, v_vat_output, 0, 13043.48, 'VAT Output')
  ON CONFLICT (id) DO NOTHING;

  -- JE: March customer payments received (bank transactions)
  v_je_id := 'ae000000-0000-0000-0003-000000000008';
  INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, fiscal_period_id, description, source, status, created_by, posted_by, posted_at)
  VALUES (v_je_id, v_company_id, 'JE-2026-00022', '2026-03-15', v_mar_fp, 'Customer payments Mar 5-15: DFA R50K, Metrofibre R60K, Frogfoot R30K', 'auto_payment', 'posted', v_admin_id, v_admin_id, '2026-03-15')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description) VALUES
  (gen_random_uuid(), v_je_id, v_bank, 140000.00, 0, 'Bank receipts - DFA+Metrofibre+Frogfoot'),
  (gen_random_uuid(), v_je_id, v_ar, 0, 140000.00, 'AR clearance - multiple customers')
  ON CONFLICT (id) DO NOTHING;

  -- JE: More March customer payments (VelocityFibre R100K, Herotel R40K, LinkAfrica R25K)
  v_je_id := 'ae000000-0000-0000-0003-000000000009';
  INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, fiscal_period_id, description, source, status, created_by, posted_by, posted_at)
  VALUES (v_je_id, v_company_id, 'JE-2026-00023', '2026-03-22', v_mar_fp, 'Customer payments Mar 10-22: VelocityFibre R100K, Herotel R40K, LinkAfrica R25K', 'auto_payment', 'posted', v_admin_id, v_admin_id, '2026-03-22')
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description) VALUES
  (gen_random_uuid(), v_je_id, v_bank, 165000.00, 0, 'Bank receipts - VF+Herotel+LinkAfrica'),
  (gen_random_uuid(), v_je_id, v_ar, 0, 165000.00, 'AR clearance - multiple customers')
  ON CONFLICT (id) DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════
  -- SUPPLIER PAYMENTS (link to invoices)
  -- ═══════════════════════════════════════════════════════════════════════
  INSERT INTO supplier_payments (id, company_id, payment_number, supplier_id, payment_date, total_amount, payment_method, reference, status, created_by) VALUES
  ('5a000000-0000-0000-0000-000000000001', v_company_id, 'SP-2026-00001', 'd1000000-0000-0000-0000-000000000008', '2026-01-20', 20000.00, 'eft', 'SGE-LIC-Q1', 'processed', v_admin_id),
  ('5a000000-0000-0000-0000-000000000002', v_company_id, 'SP-2026-00002', 'd1000000-0000-0000-0000-000000000003', '2026-02-03', 5000.00, 'eft', 'TLK-JAN', 'processed', v_admin_id),
  ('5a000000-0000-0000-0000-000000000003', v_company_id, 'SP-2026-00003', 'd1000000-0000-0000-0000-000000000010', '2026-02-05', 8000.00, 'eft', 'BDV-FEB', 'processed', v_admin_id),
  ('5a000000-0000-0000-0000-000000000004', v_company_id, 'SP-2026-00004', 'd1000000-0000-0000-0000-000000000001', '2026-02-15', 15000.00, 'eft', 'MKR-PARTIAL', 'processed', v_admin_id)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO payment_allocations (id, payment_id, invoice_id, amount_allocated) VALUES
  (gen_random_uuid(), '5a000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000010', 20000.00),
  (gen_random_uuid(), '5a000000-0000-0000-0000-000000000002', 'e1000000-0000-0000-0000-000000000008', 5000.00),
  (gen_random_uuid(), '5a000000-0000-0000-0000-000000000003', 'e1000000-0000-0000-0000-000000000009', 8000.00),
  (gen_random_uuid(), '5a000000-0000-0000-0000-000000000004', 'e1000000-0000-0000-0000-000000000007', 15000.00)
  ON CONFLICT DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════
  -- CUSTOMER PAYMENTS
  -- ═══════════════════════════════════════════════════════════════════════
  INSERT INTO customer_payments (id, company_id, payment_number, client_id, payment_date, total_amount, payment_method, bank_reference, status, created_by) VALUES
  ('ca000000-0000-0000-0000-000000000001', v_company_id, 'CP-2026-00001', 'c1000000-0000-0000-0000-000000000008', '2026-01-25', 40000.00, 'eft', 'HT-PAY-JAN', 'confirmed', v_admin_id),
  ('ca000000-0000-0000-0000-000000000002', v_company_id, 'CP-2026-00002', 'c1000000-0000-0000-0000-000000000006', '2026-02-20', 50000.00, 'eft', 'DFA-PAY-FEB', 'confirmed', v_admin_id),
  ('ca000000-0000-0000-0000-000000000003', v_company_id, 'CP-2026-00003', 'c1000000-0000-0000-0000-000000000007', '2026-02-20', 25000.00, 'eft', 'LA-PAY-FEB', 'confirmed', v_admin_id),
  ('ca000000-0000-0000-0000-000000000004', v_company_id, 'CP-2026-00004', 'c1000000-0000-0000-0000-000000000001', '2026-02-25', 100000.00, 'eft', 'VF-PAY-FEB', 'confirmed', v_admin_id)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO customer_payment_allocations (id, payment_id, invoice_id, amount_allocated) VALUES
  (gen_random_uuid(), 'ca000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000009', 40000.00),
  (gen_random_uuid(), 'ca000000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000007', 50000.00),
  (gen_random_uuid(), 'ca000000-0000-0000-0000-000000000003', 'f1000000-0000-0000-0000-000000000008', 25000.00),
  (gen_random_uuid(), 'ca000000-0000-0000-0000-000000000004', 'f1000000-0000-0000-0000-000000000006', 100000.00)
  ON CONFLICT DO NOTHING;

  -- ═══════════════════════════════════════════════════════════════════════
  -- GL ACCOUNT BALANCES — aggregate per period for trial balance/reports
  -- ═══════════════════════════════════════════════════════════════════════

  -- January 2026
  INSERT INTO gl_account_balances (id, gl_account_id, fiscal_period_id, debit_total, credit_total, balance) VALUES
  (gen_random_uuid(), v_bank, v_jan_fp, 40000.00, 20000.00, 20000.00),
  (gen_random_uuid(), v_ar, v_jan_fp, 40000.00, 40000.00, 0),
  (gen_random_uuid(), v_vat_input, v_jan_fp, 2608.70, 0, 2608.70),
  (gen_random_uuid(), v_vat_output, v_jan_fp, 0, 5217.39, -5217.39),
  (gen_random_uuid(), v_ap, v_jan_fp, 20000.00, 20000.00, 0),
  (gen_random_uuid(), v_revenue, v_jan_fp, 0, 34782.61, -34782.61),
  (gen_random_uuid(), v_admin_exp, v_jan_fp, 17391.30, 0, 17391.30)
  ON CONFLICT DO NOTHING;

  -- February 2026
  INSERT INTO gl_account_balances (id, gl_account_id, fiscal_period_id, debit_total, credit_total, balance) VALUES
  (gen_random_uuid(), v_bank, v_feb_fp, 175000.00, 13000.00, 162000.00),
  (gen_random_uuid(), v_ar, v_feb_fp, 275000.00, 175000.00, 100000.00),
  (gen_random_uuid(), v_vat_input, v_feb_fp, 4956.52, 0, 4956.52),
  (gen_random_uuid(), v_vat_output, v_feb_fp, 0, 35869.57, -35869.57),
  (gen_random_uuid(), v_ap, v_feb_fp, 13000.00, 33000.00, -20000.00),
  (gen_random_uuid(), v_revenue, v_feb_fp, 0, 217391.30, -217391.30),
  (gen_random_uuid(), v_maint_revenue, v_feb_fp, 0, 21739.13, -21739.13),
  (gen_random_uuid(), v_admin_exp, v_feb_fp, 11304.35, 0, 11304.35),
  (gen_random_uuid(), v_equipment, v_feb_fp, 21739.13, 0, 21739.13)
  ON CONFLICT DO NOTHING;

  -- March 2026
  INSERT INTO gl_account_balances (id, gl_account_id, fiscal_period_id, debit_total, credit_total, balance) VALUES
  (gen_random_uuid(), v_bank, v_mar_fp, 305000.00, 85475.00, 219525.00),
  (gen_random_uuid(), v_ar, v_mar_fp, 250000.00, 305000.00, -55000.00),
  (gen_random_uuid(), v_vat_input, v_mar_fp, 8021.74, 0, 8021.74),
  (gen_random_uuid(), v_vat_output, v_mar_fp, 0, 32608.70, -32608.70),
  (gen_random_uuid(), v_ap, v_mar_fp, 0, 61500.00, -61500.00),
  (gen_random_uuid(), v_revenue, v_mar_fp, 0, 217391.30, -217391.30),
  (gen_random_uuid(), v_fuel, v_mar_fp, 12173.91, 0, 12173.91),
  (gen_random_uuid(), v_admin_exp, v_mar_fp, 6521.74, 0, 6521.74),
  (gen_random_uuid(), v_subcontractor, v_mar_fp, 34782.61, 0, 34782.61),
  (gen_random_uuid(), v_labour, v_mar_fp, 85000.00, 0, 85000.00),
  (gen_random_uuid(), v_bank_charges, v_mar_fp, 475.00, 0, 475.00)
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'GL history seed completed: 23 journal entries, 4 supplier payments, 4 customer payments, 27 account balances';
END $$;
