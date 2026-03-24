-- Migration 200: Accounting Module Foundation
-- PRD-060: FibreFlow Accounting Module - Phase 1
-- GL Engine, Chart of Accounts, Fiscal Periods

-- ── GL Accounts (Chart of Accounts) ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_code VARCHAR(20) UNIQUE NOT NULL,
  account_name VARCHAR(100) NOT NULL,
  account_type VARCHAR(20) NOT NULL CHECK (account_type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  account_subtype VARCHAR(50),
  parent_account_id UUID REFERENCES gl_accounts(id),
  is_active BOOLEAN DEFAULT true,
  is_system_account BOOLEAN DEFAULT false,
  description TEXT,
  normal_balance VARCHAR(10) NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  level INT DEFAULT 1,
  display_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_gl_accounts_code ON gl_accounts(account_code);
CREATE INDEX idx_gl_accounts_parent ON gl_accounts(parent_account_id);
CREATE INDEX idx_gl_accounts_type ON gl_accounts(account_type);
CREATE INDEX idx_gl_accounts_active ON gl_accounts(is_active);

-- ── Fiscal Periods ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fiscal_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_name VARCHAR(50) NOT NULL,
  period_number INT NOT NULL,
  fiscal_year INT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'closing', 'closed', 'locked')),
  closed_by UUID,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(fiscal_year, period_number)
);

CREATE INDEX idx_fiscal_periods_year ON fiscal_periods(fiscal_year);
CREATE INDEX idx_fiscal_periods_status ON fiscal_periods(status);
CREATE INDEX idx_fiscal_periods_dates ON fiscal_periods(start_date, end_date);

-- ── GL Journal Entries ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_number VARCHAR(20) UNIQUE,
  entry_date DATE NOT NULL,
  fiscal_period_id UUID REFERENCES fiscal_periods(id),
  description TEXT,
  source VARCHAR(30) DEFAULT 'manual' CHECK (source IN (
    'manual', 'auto_invoice', 'auto_payment', 'auto_grn',
    'auto_credit_note', 'auto_bank_recon'
  )),
  source_document_id UUID,
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'reversed')),
  posted_by UUID,
  posted_at TIMESTAMPTZ,
  reversed_by UUID,
  reversed_at TIMESTAMPTZ,
  reversal_of_id UUID REFERENCES gl_journal_entries(id),
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_gl_je_date ON gl_journal_entries(entry_date);
CREATE INDEX idx_gl_je_period ON gl_journal_entries(fiscal_period_id);
CREATE INDEX idx_gl_je_source ON gl_journal_entries(source);
CREATE INDEX idx_gl_je_status ON gl_journal_entries(status);
CREATE INDEX idx_gl_je_number ON gl_journal_entries(entry_number);

-- ── GL Journal Lines ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_journal_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id UUID NOT NULL REFERENCES gl_journal_entries(id) ON DELETE CASCADE,
  gl_account_id UUID NOT NULL REFERENCES gl_accounts(id),
  debit NUMERIC(15,2) DEFAULT 0 CHECK (debit >= 0),
  credit NUMERIC(15,2) DEFAULT 0 CHECK (credit >= 0),
  description TEXT,
  project_id UUID,
  cost_center_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_debit_or_credit CHECK (NOT (debit > 0 AND credit > 0))
);

CREATE INDEX idx_gl_jl_entry ON gl_journal_lines(journal_entry_id);
CREATE INDEX idx_gl_jl_account ON gl_journal_lines(gl_account_id);
CREATE INDEX idx_gl_jl_project ON gl_journal_lines(project_id) WHERE project_id IS NOT NULL;

-- ── GL Account Balances (cache) ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_account_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gl_account_id UUID NOT NULL REFERENCES gl_accounts(id),
  fiscal_period_id UUID NOT NULL REFERENCES fiscal_periods(id),
  debit_total NUMERIC(15,2) DEFAULT 0,
  credit_total NUMERIC(15,2) DEFAULT 0,
  balance NUMERIC(15,2) DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(gl_account_id, fiscal_period_id)
);

CREATE INDEX idx_gl_ab_account ON gl_account_balances(gl_account_id);
CREATE INDEX idx_gl_ab_period ON gl_account_balances(fiscal_period_id);

-- ── Triggers ────────────────────────────────────────────────────────────────

-- Auto-generate entry_number on INSERT
CREATE OR REPLACE FUNCTION generate_journal_entry_number()
RETURNS TRIGGER AS $$
DECLARE
  entry_year INT;
  next_seq INT;
BEGIN
  entry_year := EXTRACT(YEAR FROM NEW.entry_date);
  SELECT COALESCE(MAX(
    CAST(SPLIT_PART(entry_number, '-', 3) AS INT)
  ), 0) + 1 INTO next_seq
  FROM gl_journal_entries
  WHERE entry_number LIKE 'JE-' || entry_year || '-%';

  NEW.entry_number := 'JE-' || entry_year || '-' || LPAD(next_seq::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_gl_je_entry_number
  BEFORE INSERT ON gl_journal_entries
  FOR EACH ROW
  WHEN (NEW.entry_number IS NULL)
  EXECUTE FUNCTION generate_journal_entry_number();

-- Enforce balanced entries on post
CREATE OR REPLACE FUNCTION enforce_balanced_entry()
RETURNS TRIGGER AS $$
DECLARE
  total_debit NUMERIC(15,2);
  total_credit NUMERIC(15,2);
BEGIN
  IF NEW.status = 'posted' AND (OLD.status IS NULL OR OLD.status = 'draft') THEN
    SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO total_debit, total_credit
    FROM gl_journal_lines
    WHERE journal_entry_id = NEW.id;

    IF total_debit != total_credit THEN
      RAISE EXCEPTION 'Journal entry is not balanced: debit=% credit=%', total_debit, total_credit;
    END IF;

    IF total_debit = 0 AND total_credit = 0 THEN
      RAISE EXCEPTION 'Journal entry has no lines';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_gl_je_balanced
  BEFORE UPDATE ON gl_journal_entries
  FOR EACH ROW
  EXECUTE FUNCTION enforce_balanced_entry();

-- Update account balances when journal lines change (only for posted entries)
CREATE OR REPLACE FUNCTION update_account_balances()
RETURNS TRIGGER AS $$
DECLARE
  entry_status VARCHAR(20);
  period_id UUID;
BEGIN
  -- Get the entry status and period
  SELECT status, fiscal_period_id INTO entry_status, period_id
  FROM gl_journal_entries
  WHERE id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

  IF entry_status != 'posted' OR period_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Recalculate balance for the affected account+period
  INSERT INTO gl_account_balances (gl_account_id, fiscal_period_id, debit_total, credit_total, balance)
  SELECT
    COALESCE(NEW.gl_account_id, OLD.gl_account_id),
    period_id,
    COALESCE(SUM(jl.debit), 0),
    COALESCE(SUM(jl.credit), 0),
    COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0)
  FROM gl_journal_lines jl
  JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
  WHERE jl.gl_account_id = COALESCE(NEW.gl_account_id, OLD.gl_account_id)
    AND je.fiscal_period_id = period_id
    AND je.status = 'posted'
  ON CONFLICT (gl_account_id, fiscal_period_id)
  DO UPDATE SET
    debit_total = EXCLUDED.debit_total,
    credit_total = EXCLUDED.credit_total,
    balance = EXCLUDED.balance,
    updated_at = NOW();

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_gl_jl_balance_update
  AFTER INSERT OR UPDATE OR DELETE ON gl_journal_lines
  FOR EACH ROW
  EXECUTE FUNCTION update_account_balances();

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION accounting_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_gl_accounts_updated_at BEFORE UPDATE ON gl_accounts
  FOR EACH ROW EXECUTE FUNCTION accounting_updated_at();
CREATE TRIGGER trg_fiscal_periods_updated_at BEFORE UPDATE ON fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION accounting_updated_at();
CREATE TRIGGER trg_gl_je_updated_at BEFORE UPDATE ON gl_journal_entries
  FOR EACH ROW EXECUTE FUNCTION accounting_updated_at();

-- ── Trial Balance Function ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_trial_balance(p_fiscal_period_id UUID)
RETURNS TABLE (
  account_code VARCHAR(20),
  account_name VARCHAR(100),
  account_type VARCHAR(20),
  normal_balance VARCHAR(10),
  debit_balance NUMERIC(15,2),
  credit_balance NUMERIC(15,2)
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    a.account_code,
    a.account_name,
    a.account_type,
    a.normal_balance,
    COALESCE(b.debit_total, 0) AS debit_balance,
    COALESCE(b.credit_total, 0) AS credit_balance
  FROM gl_accounts a
  LEFT JOIN gl_account_balances b ON b.gl_account_id = a.id AND b.fiscal_period_id = p_fiscal_period_id
  WHERE a.is_active = true
    AND (b.debit_total > 0 OR b.credit_total > 0)
  ORDER BY a.account_code;
END;
$$ LANGUAGE plpgsql;

-- ── Seed Data: Chart of Accounts ────────────────────────────────────────────

-- Level 1: Top categories
INSERT INTO gl_accounts (account_code, account_name, account_type, normal_balance, level, display_order, is_system_account) VALUES
  ('1000', 'Assets', 'asset', 'debit', 1, 100, true),
  ('2000', 'Liabilities', 'liability', 'credit', 1, 200, true),
  ('3000', 'Equity', 'equity', 'credit', 1, 300, true),
  ('4000', 'Revenue', 'revenue', 'credit', 1, 400, true),
  ('5000', 'Expenses', 'expense', 'debit', 1, 500, true)
ON CONFLICT (account_code) DO NOTHING;

-- Level 2: Sub-categories
INSERT INTO gl_accounts (account_code, account_name, account_type, normal_balance, level, display_order, is_system_account, parent_account_id) VALUES
  ('1100', 'Current Assets', 'asset', 'debit', 2, 110, true, (SELECT id FROM gl_accounts WHERE account_code = '1000')),
  ('1200', 'Non-Current Assets', 'asset', 'debit', 2, 120, true, (SELECT id FROM gl_accounts WHERE account_code = '1000')),
  ('2100', 'Current Liabilities', 'liability', 'credit', 2, 210, true, (SELECT id FROM gl_accounts WHERE account_code = '2000')),
  ('2200', 'Non-Current Liabilities', 'liability', 'credit', 2, 220, true, (SELECT id FROM gl_accounts WHERE account_code = '2000'))
ON CONFLICT (account_code) DO NOTHING;

-- Level 3: Detail accounts
INSERT INTO gl_accounts (account_code, account_name, account_type, normal_balance, level, display_order, is_system_account, parent_account_id) VALUES
  -- Current Assets
  ('1110', 'Bank - Primary', 'asset', 'debit', 3, 111, true, (SELECT id FROM gl_accounts WHERE account_code = '1100')),
  ('1120', 'Accounts Receivable', 'asset', 'debit', 3, 112, true, (SELECT id FROM gl_accounts WHERE account_code = '1100')),
  ('1130', 'Petty Cash', 'asset', 'debit', 3, 113, false, (SELECT id FROM gl_accounts WHERE account_code = '1100')),
  ('1140', 'VAT Input', 'asset', 'debit', 3, 114, true, (SELECT id FROM gl_accounts WHERE account_code = '1100')),
  -- Non-Current Assets
  ('1210', 'Equipment', 'asset', 'debit', 3, 121, false, (SELECT id FROM gl_accounts WHERE account_code = '1200')),
  ('1220', 'Vehicles', 'asset', 'debit', 3, 122, false, (SELECT id FROM gl_accounts WHERE account_code = '1200')),
  ('1230', 'Accumulated Depreciation', 'asset', 'credit', 3, 123, false, (SELECT id FROM gl_accounts WHERE account_code = '1200')),
  -- Current Liabilities
  ('2110', 'Accounts Payable', 'liability', 'credit', 3, 211, true, (SELECT id FROM gl_accounts WHERE account_code = '2100')),
  ('2120', 'VAT Output', 'liability', 'credit', 3, 212, true, (SELECT id FROM gl_accounts WHERE account_code = '2100')),
  ('2130', 'Accrued Expenses', 'liability', 'credit', 3, 213, false, (SELECT id FROM gl_accounts WHERE account_code = '2100')),
  -- Non-Current Liabilities
  ('2210', 'Long-term Loans', 'liability', 'credit', 3, 221, false, (SELECT id FROM gl_accounts WHERE account_code = '2200')),
  -- Equity
  ('3100', 'Share Capital', 'equity', 'credit', 3, 310, true, (SELECT id FROM gl_accounts WHERE account_code = '3000')),
  ('3200', 'Retained Earnings', 'equity', 'credit', 3, 320, true, (SELECT id FROM gl_accounts WHERE account_code = '3000')),
  -- Revenue
  ('4100', 'Activation Revenue', 'revenue', 'credit', 3, 410, false, (SELECT id FROM gl_accounts WHERE account_code = '4000')),
  ('4200', 'Maintenance Revenue', 'revenue', 'credit', 3, 420, false, (SELECT id FROM gl_accounts WHERE account_code = '4000')),
  ('4300', 'Other Income', 'revenue', 'credit', 3, 430, false, (SELECT id FROM gl_accounts WHERE account_code = '4000')),
  -- Expenses
  ('5100', 'Materials & Supplies', 'expense', 'debit', 3, 510, false, (SELECT id FROM gl_accounts WHERE account_code = '5000')),
  ('5200', 'Labour Costs', 'expense', 'debit', 3, 520, false, (SELECT id FROM gl_accounts WHERE account_code = '5000')),
  ('5300', 'Subcontractor Costs', 'expense', 'debit', 3, 530, false, (SELECT id FROM gl_accounts WHERE account_code = '5000')),
  ('5400', 'Transport & Fuel', 'expense', 'debit', 3, 540, false, (SELECT id FROM gl_accounts WHERE account_code = '5000')),
  ('5500', 'Equipment Costs', 'expense', 'debit', 3, 550, false, (SELECT id FROM gl_accounts WHERE account_code = '5000')),
  ('5600', 'Administrative Expenses', 'expense', 'debit', 3, 560, false, (SELECT id FROM gl_accounts WHERE account_code = '5000')),
  ('5700', 'Bank Charges', 'expense', 'debit', 3, 570, false, (SELECT id FROM gl_accounts WHERE account_code = '5000'))
ON CONFLICT (account_code) DO NOTHING;

-- ── Seed Data: Fiscal Year 2026 ────────────────────────────────────────────

INSERT INTO fiscal_periods (period_name, period_number, fiscal_year, start_date, end_date) VALUES
  ('January 2026',   1,  2026, '2026-01-01', '2026-01-31'),
  ('February 2026',  2,  2026, '2026-02-01', '2026-02-28'),
  ('March 2026',     3,  2026, '2026-03-01', '2026-03-31'),
  ('April 2026',     4,  2026, '2026-04-01', '2026-04-30'),
  ('May 2026',       5,  2026, '2026-05-01', '2026-05-31'),
  ('June 2026',      6,  2026, '2026-06-01', '2026-06-30'),
  ('July 2026',      7,  2026, '2026-07-01', '2026-07-31'),
  ('August 2026',    8,  2026, '2026-08-01', '2026-08-31'),
  ('September 2026', 9,  2026, '2026-09-01', '2026-09-30'),
  ('October 2026',   10, 2026, '2026-10-01', '2026-10-31'),
  ('November 2026',  11, 2026, '2026-11-01', '2026-11-30'),
  ('December 2026',  12, 2026, '2026-12-01', '2026-12-31')
ON CONFLICT (fiscal_year, period_number) DO NOTHING;
