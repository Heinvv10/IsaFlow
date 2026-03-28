-- 251: Demo seed data for testing VLM, invoicing, payments, bank reconciliation
-- Seeds the default company (00000000-0000-0000-0000-000000000001) with realistic SA data.
-- All inserts use ON CONFLICT DO NOTHING to be safely re-runnable.

-- ═══════════════════════════════════════════════════════════════════════════
-- Admin user: ensure admin@isaflow.co.za exists (E2E tests use this)
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO users (id, email, password_hash, first_name, last_name, role, permissions, is_active)
VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'admin@isaflow.co.za',
  -- bcrypt hash for 'admin123' (cost 12)
  '$2a$12$LJ3m4ys0qPbXFiRQGMDzFuTkfLQb7RqpM5xR1hTKqfCHxzWYWcGpq',
  'Admin', 'User', 'super_admin', '["*"]'::jsonb, true
) ON CONFLICT (email) DO NOTHING;

-- Link admin to default company
INSERT INTO company_users (company_id, user_id, role, is_default)
VALUES ('00000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'owner', true)
ON CONFLICT DO NOTHING;

-- Also link the original admin
INSERT INTO company_users (company_id, user_id, role, is_default)
SELECT '00000000-0000-0000-0000-000000000001', id, 'owner', true
FROM users WHERE email = 'admin@accounting.local'
ON CONFLICT DO NOTHING;

-- Update company details for realistic demo
UPDATE companies SET
  name = 'ISAFlow Demo (Pty) Ltd',
  trading_name = 'ISAFlow Demo',
  registration_number = 'K2024/567890',
  vat_number = '4123456789',
  tax_number = '9876543210',
  country = 'South Africa',
  financial_year_start = 3,
  vat_period = 'bi-monthly'
WHERE id = '00000000-0000-0000-0000-000000000001';

-- ═══════════════════════════════════════════════════════════════════════════
-- SUPPLIERS (10)
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO suppliers (id, company_id, name, email, phone, vat_number, registration_number, address, contact_person, payment_terms, bank_name, bank_account_number, bank_branch_code, bank_account_type) VALUES
('d1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Makro SA (Pty) Ltd', 'accounts@makro.co.za', '011-123-4567', '4100000001', 'K2020/100001', '123 Makro Drive, Woodmead, 2191', 'Johan van der Merwe', 30, 'ABSA', '4012345678', '632005', 'cheque'),
('d1000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Builders Warehouse', 'finance@builders.co.za', '012-345-6789', '4100000002', 'K2019/200002', '45 Hardware Lane, Centurion, 0157', 'Pieter Botha', 30, 'FNB', '6234567890', '250655', 'cheque'),
('d1000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'Telkom SA SOC Ltd', 'billing@telkom.co.za', '010-210-1000', '4100000003', 'K2001/300003', 'Telkom Towers, Centurion, 0157', 'Sipho Ndlovu', 30, 'Nedbank', '1098765432', '198765', 'cheque'),
('d1000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'Engen Petroleum', 'accounts@engen.co.za', '021-403-4000', '4100000004', 'K2015/400004', '1 Engen Court, Foreshore, 8001', 'Thandi Zulu', 14, 'Standard Bank', '0312345678', '051001', 'cheque'),
('d1000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 'Office National', 'invoices@officenational.co.za', '011-555-1234', '4100000005', 'K2018/500005', '78 Stationery Road, Sandton, 2196', 'Lerato Mokoena', 30, 'Capitec', '1345678901', '470010', 'savings'),
('d1000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', 'Vodacom Business', 'business@vodacom.co.za', '082-111-1234', '4100000006', 'K2010/600006', '082 Vodacom World, Midrand, 1685', 'Kabelo Mabena', 30, 'ABSA', '4056789012', '632005', 'cheque'),
('d1000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000001', 'City of Johannesburg', 'revenue@joburg.org.za', '011-375-5555', NULL, NULL, 'Metro Centre, Braamfontein, 2001', NULL, 0, NULL, NULL, NULL, NULL),
('d1000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000001', 'Sage SA (Pty) Ltd', 'accounts@sage.co.za', '011-304-3333', '4100000008', 'K2005/800008', '150 Rivonia Road, Sandton, 2196', 'Anel Pretorius', 30, 'FNB', '6287654321', '250655', 'cheque'),
('d1000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000001', 'Karabina Technologies', 'invoicing@karabina.com', '011-234-5678', '4100000009', 'K2017/900009', '22 IT Park, Bryanston, 2021', 'David Kim', 30, 'Standard Bank', '0398765432', '051001', 'cheque'),
('d1000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', 'Bidvest Cleaning', 'finance@bidvest.com', '011-876-5432', '4100000010', 'K2012/100010', '10 Bidvest Way, Johannesburg, 2001', 'Nomsa Dlamini', 30, 'Nedbank', '1076543210', '198765', 'cheque')
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- CUSTOMERS (8)
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO customers (id, company_id, name, email, phone, vat_number, registration_number, billing_address, contact_person, payment_terms) VALUES
('c1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'VelocityFibre (Pty) Ltd', 'accounts@velocityfibre.co.za', '011-222-3333', '4200000001', 'K2022/200001', '100 Fibre Street, Midrand, 1685', 'Hein du Plessis', 30),
('c1000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Metrofibre Networx', 'billing@metrofibre.co.za', '010-100-2000', '4200000002', 'K2016/200002', '200 Network Drive, Rosebank, 2196', 'André Barnard', 30),
('c1000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'Frogfoot Networks', 'finance@frogfoot.com', '021-300-4000', '4200000003', 'K2014/200003', '55 Frog Lane, Cape Town, 8001', 'Michelle September', 30),
('c1000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'Vumatel Holdings', 'ap@vumatel.co.za', '010-200-5000', '4200000004', 'K2015/200004', '77 Vuma Road, Randburg, 2194', 'Tshepiso Molefi', 30),
('c1000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 'Openserve (SOC)', 'invoices@openserve.co.za', '012-311-1111', '4200000005', 'K2008/200005', 'Telkom Towers, Centurion, 0157', 'Mpho Kgaile', 45),
('c1000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', 'DFA (Dark Fibre Africa)', 'accounts@dfafrica.co.za', '010-300-6000', '4200000006', 'K2013/200006', '88 DFA Park, Sandton, 2196', 'Riaan van Niekerk', 30),
('c1000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000001', 'LinkAfrica Telecoms', 'finance@linkafrica.co.za', '031-400-7000', '4200000007', 'K2019/200007', '12 Link Road, Durban, 4001', 'Zanele Msimang', 30),
('c1000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000001', 'Herotel (Pty) Ltd', 'billing@herotel.com', '023-500-8000', '4200000008', 'K2017/200008', '5 Hero Way, Stellenbosch, 7600', 'Jan Booysen', 30)
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- SUPPLIER INVOICES (15) — mix of statuses
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO supplier_invoices (id, company_id, invoice_number, supplier_id, invoice_date, due_date, subtotal, tax_rate, tax_amount, total_amount, amount_paid, payment_terms, status, reference, notes, created_by) VALUES
-- Draft invoices
('e1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'MKR-2026-0451', 'd1000000-0000-0000-0000-000000000001', '2026-03-05', '2026-04-04', 8695.65, 15.00, 1304.35, 10000.00, 0, 'net30', 'draft', 'PO-2026-001', 'Office supplies bulk order', 'a0000000-0000-0000-0000-000000000001'),
('e1000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'BW-INV-88234', 'd1000000-0000-0000-0000-000000000002', '2026-03-08', '2026-04-07', 15652.17, 15.00, 2347.83, 18000.00, 0, 'net30', 'draft', NULL, 'Building materials for Midrand depot', 'a0000000-0000-0000-0000-000000000001'),
-- Approved (awaiting payment)
('e1000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'TLK-2026-1234', 'd1000000-0000-0000-0000-000000000003', '2026-02-28', '2026-03-30', 4347.83, 15.00, 652.17, 5000.00, 0, 'net30', 'approved', NULL, 'Monthly telecoms Feb 2026', 'a0000000-0000-0000-0000-000000000001'),
('e1000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'ENG-F-567890', 'd1000000-0000-0000-0000-000000000004', '2026-03-01', '2026-03-15', 12173.91, 15.00, 1826.09, 14000.00, 0, 'net14', 'approved', NULL, 'Fuel - company vehicles March', 'a0000000-0000-0000-0000-000000000001'),
('e1000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 'ON-2026-7891', 'd1000000-0000-0000-0000-000000000005', '2026-03-10', '2026-04-09', 3478.26, 15.00, 521.74, 4000.00, 0, 'net30', 'approved', 'PO-2026-005', 'Stationery and printer cartridges', 'a0000000-0000-0000-0000-000000000001'),
('e1000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', 'VOD-BUS-2026-034', 'd1000000-0000-0000-0000-000000000006', '2026-03-01', '2026-03-31', 6521.74, 15.00, 978.26, 7500.00, 0, 'net30', 'approved', NULL, 'Mobile data March 2026', 'a0000000-0000-0000-0000-000000000001'),
-- Partially paid
('e1000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000001', 'MKR-2026-0389', 'd1000000-0000-0000-0000-000000000001', '2026-02-10', '2026-03-12', 21739.13, 15.00, 3260.87, 25000.00, 15000.00, 'net30', 'partially_paid', 'PO-2026-003', 'Equipment purchase', 'a0000000-0000-0000-0000-000000000001'),
-- Fully paid
('e1000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000001', 'TLK-2026-1100', 'd1000000-0000-0000-0000-000000000003', '2026-01-31', '2026-03-02', 4347.83, 15.00, 652.17, 5000.00, 5000.00, 'net30', 'paid', NULL, 'Monthly telecoms Jan 2026', 'a0000000-0000-0000-0000-000000000001'),
('e1000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000001', 'BDV-CLN-2026-02', 'd1000000-0000-0000-0000-000000000010', '2026-02-01', '2026-03-03', 6956.52, 15.00, 1043.48, 8000.00, 8000.00, 'net30', 'paid', NULL, 'Cleaning services Feb 2026', 'a0000000-0000-0000-0000-000000000001'),
('e1000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', 'SGE-LIC-2026-Q1', 'd1000000-0000-0000-0000-000000000008', '2026-01-15', '2026-02-14', 17391.30, 15.00, 2608.70, 20000.00, 20000.00, 'net30', 'paid', NULL, 'Sage licence Q1 2026', 'a0000000-0000-0000-0000-000000000001'),
-- More approved
('e1000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 'KRB-DEV-2026-03', 'd1000000-0000-0000-0000-000000000009', '2026-03-15', '2026-04-14', 34782.61, 15.00, 5217.39, 40000.00, 0, 'net30', 'approved', NULL, 'Software development March', 'a0000000-0000-0000-0000-000000000001'),
('e1000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000001', 'COJ-RATES-2026-03', 'd1000000-0000-0000-0000-000000000007', '2026-03-01', '2026-03-31', 3500.00, 0.00, 0.00, 3500.00, 0, 'immediate', 'approved', NULL, 'Municipal rates March 2026 (VAT exempt)', 'a0000000-0000-0000-0000-000000000001'),
('e1000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000001', 'ENG-F-567999', 'd1000000-0000-0000-0000-000000000004', '2026-03-15', '2026-03-29', 8695.65, 15.00, 1304.35, 10000.00, 0, 'net14', 'approved', NULL, 'Fuel - company vehicles mid-March', 'a0000000-0000-0000-0000-000000000001'),
('e1000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-000000000001', 'BDV-CLN-2026-03', 'd1000000-0000-0000-0000-000000000010', '2026-03-01', '2026-03-31', 6956.52, 15.00, 1043.48, 8000.00, 0, 'net30', 'approved', NULL, 'Cleaning services March 2026', 'a0000000-0000-0000-0000-000000000001'),
('e1000000-0000-0000-0000-000000000015', '00000000-0000-0000-0000-000000000001', 'MKR-2026-0520', 'd1000000-0000-0000-0000-000000000001', '2026-03-20', '2026-04-19', 4347.83, 15.00, 652.17, 5000.00, 0, 'net30', 'draft', NULL, 'Kitchen supplies', 'a0000000-0000-0000-0000-000000000001')

ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- CUSTOMER INVOICES (12) — mix of statuses
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO customer_invoices (id, company_id, invoice_number, customer_id, client_id, invoice_date, due_date, subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, notes, created_by) VALUES
-- Draft
('f1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'INV-00001', 'c1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', '2026-03-25', '2026-04-24', 43478.26, 15.00, 6521.74, 50000.00, 0, 'draft', 'FTTH installations March batch 1', 'a0000000-0000-0000-0000-000000000001'),
-- Approved
('f1000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'INV-00002', 'c1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000002', '2026-03-15', '2026-04-14', 86956.52, 15.00, 13043.48, 100000.00, 0, 'approved', 'Fibre backbone installation Phase 2', 'a0000000-0000-0000-0000-000000000001'),
('f1000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'INV-00003', 'c1000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000003', '2026-03-10', '2026-04-09', 26086.96, 15.00, 3913.04, 30000.00, 0, 'approved', 'CPE equipment supply', 'a0000000-0000-0000-0000-000000000001'),
-- Sent
('f1000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'INV-00004', 'c1000000-0000-0000-0000-000000000004', 'c1000000-0000-0000-0000-000000000004', '2026-03-01', '2026-03-31', 130434.78, 15.00, 19565.22, 150000.00, 0, 'sent', 'Aerial fibre deployment Randburg', 'a0000000-0000-0000-0000-000000000001'),
('f1000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 'INV-00005', 'c1000000-0000-0000-0000-000000000005', 'c1000000-0000-0000-0000-000000000005', '2026-02-28', '2026-04-14', 65217.39, 15.00, 9782.61, 75000.00, 0, 'sent', 'Duct installation Pretoria', 'a0000000-0000-0000-0000-000000000001'),
-- Partially paid
('f1000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', 'INV-00006', 'c1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', '2026-02-15', '2026-03-17', 173913.04, 15.00, 26086.96, 200000.00, 100000.00, 'partially_paid', 'FTTH installations February batch', 'a0000000-0000-0000-0000-000000000001'),
-- Paid
('f1000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000001', 'INV-00007', 'c1000000-0000-0000-0000-000000000006', 'c1000000-0000-0000-0000-000000000006', '2026-01-31', '2026-03-02', 43478.26, 15.00, 6521.74, 50000.00, 50000.00, 'paid', 'Fibre splicing January', 'a0000000-0000-0000-0000-000000000001'),
('f1000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000001', 'INV-00008', 'c1000000-0000-0000-0000-000000000007', 'c1000000-0000-0000-0000-000000000007', '2026-02-01', '2026-03-03', 21739.13, 15.00, 3260.87, 25000.00, 25000.00, 'paid', 'Network maintenance Feb', 'a0000000-0000-0000-0000-000000000001'),
('f1000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000001', 'INV-00009', 'c1000000-0000-0000-0000-000000000008', 'c1000000-0000-0000-0000-000000000008', '2026-01-15', '2026-02-14', 34782.61, 15.00, 5217.39, 40000.00, 40000.00, 'paid', 'Rural connectivity project Jan', 'a0000000-0000-0000-0000-000000000001'),
-- Overdue
('f1000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', 'INV-00010', 'c1000000-0000-0000-0000-000000000004', 'c1000000-0000-0000-0000-000000000004', '2026-01-20', '2026-02-19', 86956.52, 15.00, 13043.48, 100000.00, 0, 'overdue', 'Aerial deployment Phase 1', 'a0000000-0000-0000-0000-000000000001'),
('f1000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 'INV-00011', 'c1000000-0000-0000-0000-000000000005', 'c1000000-0000-0000-0000-000000000005', '2026-02-01', '2026-03-03', 43478.26, 15.00, 6521.74, 50000.00, 0, 'overdue', 'Equipment supply and install', 'a0000000-0000-0000-0000-000000000001'),
('f1000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000001', 'INV-00012', 'c1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000002', '2026-03-20', '2026-04-19', 52173.91, 15.00, 7826.09, 60000.00, 0, 'approved', 'Backbone maintenance Q1', 'a0000000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- BANK TRANSACTIONS (20) — for reconciliation testing
-- ═══════════════════════════════════════════════════════════════════════════

-- First get the bank GL account ID
DO $$
DECLARE
  v_bank_account_id UUID;
BEGIN
  SELECT id INTO v_bank_account_id FROM gl_accounts
  WHERE account_code = '1110' AND company_id = '00000000-0000-0000-0000-000000000001'
  LIMIT 1;

  IF v_bank_account_id IS NULL THEN
    RAISE NOTICE 'Bank account 1110 not found, skipping bank transactions';
    RETURN;
  END IF;

  INSERT INTO bank_transactions (id, company_id, bank_account_id, transaction_date, amount, description, reference, status, import_batch_id) VALUES
  -- Incoming payments from customers
  ('b1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', v_bank_account_id, '2026-03-05', 50000.00, 'EFT REC DFA FIBRE AFRICA', 'DFA-PAY-0305', 'imported', 'ba7c0000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', v_bank_account_id, '2026-03-08', 25000.00, 'EFT REC LINKAFRICA TELECOMS', 'LA-PAY-0308', 'imported', 'ba7c0000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', v_bank_account_id, '2026-03-10', 100000.00, 'EFT REC VELOCITYFIBRE PTY', 'VF-PAY-0310', 'imported', 'ba7c0000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', v_bank_account_id, '2026-03-12', 40000.00, 'EFT REC HEROTEL', 'HT-PAY-0312', 'imported', 'ba7c0000-0000-0000-0000-000000000001'),
  -- Outgoing payments to suppliers
  ('b1000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', v_bank_account_id, '2026-03-03', -5000.00, 'EFT PMT TELKOM SA TLK-2026-1100', 'SP-2026-001', 'imported', 'ba7c0000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', v_bank_account_id, '2026-03-04', -8000.00, 'EFT PMT BIDVEST CLEANING', 'SP-2026-002', 'imported', 'ba7c0000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000001', v_bank_account_id, '2026-03-05', -20000.00, 'EFT PMT SAGE SA LIC Q1', 'SP-2026-003', 'imported', 'ba7c0000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000001', v_bank_account_id, '2026-03-10', -15000.00, 'EFT PMT MAKRO SA MKR-2026-0389', 'SP-2026-004', 'imported', 'ba7c0000-0000-0000-0000-000000000001'),
  -- Recurring expenses
  ('b1000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000001', v_bank_account_id, '2026-03-01', -3500.00, 'DD COJ RATES AND TAXES MAR', NULL, 'imported', 'ba7c0000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', v_bank_account_id, '2026-03-01', -2850.00, 'DD SANLAM INSURANCE PREMIUM', NULL, 'imported', 'ba7c0000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', v_bank_account_id, '2026-03-25', -85000.00, 'SALARY PAYMENT MAR 2026', 'PAYROLL-MAR-2026', 'imported', 'ba7c0000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000001', v_bank_account_id, '2026-03-28', -12500.00, 'SARS EMP201 FEB 2026', 'SARS-EMP201-FEB', 'imported', 'ba7c0000-0000-0000-0000-000000000001'),
  -- POS and card payments
  ('b1000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000001', v_bank_account_id, '2026-03-07', -456.50, 'POS PURCHASE WOOLWORTHS SANDTON', NULL, 'imported', 'ba7c0000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-000000000001', v_bank_account_id, '2026-03-14', -1250.00, 'POS PURCHASE TAKEALOT.COM', NULL, 'imported', 'ba7c0000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000015', '00000000-0000-0000-0000-000000000001', v_bank_account_id, '2026-03-20', -789.00, 'POS PURCHASE UBER EATS*TEAM LUNCH', NULL, 'imported', 'ba7c0000-0000-0000-0000-000000000001'),
  -- Bank charges
  ('b1000000-0000-0000-0000-000000000016', '00000000-0000-0000-0000-000000000001', v_bank_account_id, '2026-03-31', -350.00, 'BANK CHARGES MAR 2026', NULL, 'imported', 'ba7c0000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000017', '00000000-0000-0000-0000-000000000001', v_bank_account_id, '2026-03-31', -125.00, 'SWIFT FEE INTERNATIONAL', NULL, 'imported', 'ba7c0000-0000-0000-0000-000000000001'),
  -- Interest
  ('b1000000-0000-0000-0000-000000000018', '00000000-0000-0000-0000-000000000001', v_bank_account_id, '2026-03-31', 1250.00, 'CREDIT INTEREST MAR 2026', NULL, 'imported', 'ba7c0000-0000-0000-0000-000000000001'),
  -- More customer payments
  ('b1000000-0000-0000-0000-000000000019', '00000000-0000-0000-0000-000000000001', v_bank_account_id, '2026-03-15', 60000.00, 'EFT REC METROFIBRE NETWORX', 'MF-PAY-0315', 'imported', 'ba7c0000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000001', v_bank_account_id, '2026-03-22', 30000.00, 'EFT REC FROGFOOT NETWORKS', 'FF-PAY-0322', 'imported', 'ba7c0000-0000-0000-0000-000000000001')
  ON CONFLICT (id) DO NOTHING;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PRODUCTS (6) — for inventory testing
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO products (id, company_id, code, name, description, product_type, unit, cost_price, selling_price, tax_rate, current_stock, reorder_level, reorder_quantity, is_active, created_by) VALUES
('01000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'FBR-SM-01', 'Single Mode Fibre Cable (per km)', 'G.652D single mode fibre optic cable', 'inventory', 'km', 4500.00, 7500.00, 15.00, 120, 20, 50, true, 'a0000000-0000-0000-0000-000000000001'),
('01000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'ONT-HW-01', 'Huawei ONT HG8245H5', 'Residential GPON ONT unit', 'inventory', 'each', 850.00, 1500.00, 15.00, 350, 50, 200, true, 'a0000000-0000-0000-0000-000000000001'),
('01000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'SPL-1X8', 'PLC Splitter 1x8', '1x8 PLC fibre optic splitter', 'inventory', 'each', 120.00, 250.00, 15.00, 500, 100, 300, true, 'a0000000-0000-0000-0000-000000000001'),
('01000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'INST-FTTH', 'FTTH Installation Service', 'Standard FTTH home installation', 'service', 'each', 0, 2500.00, 15.00, 0, 0, 0, true, 'a0000000-0000-0000-0000-000000000001'),
('01000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 'DUCT-50', 'HDPE Duct 50mm (per m)', '50mm HDPE micro-duct for underground', 'inventory', 'm', 35.00, 65.00, 15.00, 5000, 500, 2000, true, 'a0000000-0000-0000-0000-000000000001'),
('01000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', 'FAT-16', 'Fibre Access Terminal 16-port', '16-port outdoor FAT enclosure', 'inventory', 'each', 1200.00, 2200.00, 15.00, 80, 15, 50, true, 'a0000000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- FIXED ASSETS (4) — for depreciation testing
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO assets (id, company_id, asset_number, name, category, sars_category, purchase_date, purchase_price, salvage_value, useful_life_years, depreciation_method, sars_rate, status, location, serial_number, created_by) VALUES
('a1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'AST-001', 'Dell PowerEdge R750 Server', 'Computers & Equipment', 'Computers', '2026-01-15', 85000.00, 5000.00, 3, 'straight_line', 33.33, 'available', 'Midrand Data Centre', 'SN-DELL-R750-001', 'a0000000-0000-0000-0000-000000000001'),
('a1000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'AST-002', 'Toyota Hilux 2.4 GD-6', 'Motor Vehicles', 'Motor Vehicles', '2025-06-01', 450000.00, 100000.00, 5, 'straight_line', 20.00, 'assigned', 'Field Operations', 'VIN-HILUX-2024-002', 'a0000000-0000-0000-0000-000000000001'),
('a1000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'AST-003', 'OTDR Fibre Tester EXFO FTB-730C', 'Test Equipment', 'Electronic Equipment', '2025-09-01', 125000.00, 10000.00, 4, 'straight_line', 25.00, 'available', 'Lab - Midrand', 'SN-EXFO-FTB-003', 'a0000000-0000-0000-0000-000000000001'),
('a1000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'AST-004', 'Office Furniture Set (Boardroom)', 'Furniture & Fittings', 'Office Furniture', '2025-03-01', 35000.00, 3000.00, 6, 'straight_line', 16.67, 'available', 'Head Office Boardroom', NULL, 'a0000000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- EMPLOYEES (4) — for payroll/EMP201 testing
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO employees (id, company_id, employee_number, first_name, last_name, id_number, department, position, employment_type, start_date, status) VALUES
('e0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'EMP-001', 'Sipho', 'Nkosi', '9001015800081', 'Operations', 'Field Technician', 'permanent', '2025-01-15', 'active'),
('e0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'EMP-002', 'Lerato', 'Molefe', '9205205100086', 'Finance', 'Accountant', 'permanent', '2025-03-01', 'active'),
('e0000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'EMP-003', 'Johan', 'van Wyk', '8803145200083', 'Operations', 'Project Manager', 'permanent', '2025-06-01', 'active'),
('e0000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'EMP-004', 'Thandi', 'Mabaso', '9507280200089', 'Admin', 'Office Administrator', 'permanent', '2025-09-01', 'active')
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- APPROVAL RULES (3) — for workflow testing
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO approval_rules (id, company_id, document_type, description, operator, threshold_amount, approver_role, priority, is_active) VALUES
('a0000001-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'supplier_invoice', 'Supplier invoices over R50,000 require approval', 'greater_than', 50000, 'admin', 1, true),
('a0000001-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'payment', 'Payments over R100,000 require approval', 'greater_than', 100000, 'admin', 1, true),
('a0000001-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'journal_entry', 'All journal entries require approval', 'any', 0, 'accountant', 2, true)
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- BANK CATEGORISATION RULES (5) — for smart categorization testing
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_bank_charges_id UUID;
  v_fuel_id UUID;
  v_telecom_id UUID;
  v_office_id UUID;
  v_insurance_id UUID;
BEGIN
  SELECT id INTO v_bank_charges_id FROM gl_accounts WHERE account_code = '5700' AND company_id = '00000000-0000-0000-0000-000000000001' LIMIT 1;
  SELECT id INTO v_fuel_id FROM gl_accounts WHERE account_code = '5400' AND company_id = '00000000-0000-0000-0000-000000000001' LIMIT 1;
  SELECT id INTO v_telecom_id FROM gl_accounts WHERE account_code = '5600' AND company_id = '00000000-0000-0000-0000-000000000001' LIMIT 1;
  SELECT id INTO v_office_id FROM gl_accounts WHERE account_code = '5100' AND company_id = '00000000-0000-0000-0000-000000000001' LIMIT 1;

  IF v_bank_charges_id IS NOT NULL THEN
    INSERT INTO bank_categorisation_rules (id, company_id, name, description_pattern, gl_account_id, vat_code, priority) VALUES
    ('bc000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Bank Charges', 'BANK CHARGES|SWIFT FEE|SERVICE FEE', v_bank_charges_id, 'exempt', 1),
    ('bc000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Fuel - Engen', 'ENGEN|FUEL|PETROL|DIESEL', v_fuel_id, 'standard', 2),
    ('bc000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'Telecoms', 'TELKOM|VODACOM|MTN|CELL C', v_telecom_id, 'standard', 3),
    ('bc000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'Office Supplies', 'WOOLWORTHS|TAKEALOT|OFFICE|STATIONERY', v_office_id, 'standard', 4),
    ('bc000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 'Insurance', 'SANLAM|INSURANCE|PREMIUM', v_telecom_id, 'exempt', 5)
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;
