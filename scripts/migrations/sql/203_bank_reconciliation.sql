-- Migration 203: Bank Reconciliation
-- PRD-060: FibreFlow Accounting Module - Phase 4
-- Bank transactions, reconciliation sessions, auto-matching

-- ── Bank Reconciliations ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bank_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id UUID NOT NULL REFERENCES gl_accounts(id),
  statement_date DATE NOT NULL,
  statement_balance NUMERIC(15,2) NOT NULL DEFAULT 0,
  gl_balance NUMERIC(15,2) NOT NULL DEFAULT 0,
  reconciled_balance NUMERIC(15,2) NOT NULL DEFAULT 0,
  difference NUMERIC(15,2) GENERATED ALWAYS AS (statement_balance - reconciled_balance) STORED,
  status VARCHAR(20) DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  started_by UUID NOT NULL,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_by UUID,
  completed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_br_account ON bank_reconciliations(bank_account_id);
CREATE INDEX idx_br_status ON bank_reconciliations(status);
CREATE INDEX idx_br_date ON bank_reconciliations(statement_date);

-- ── Bank Transactions ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bank_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id UUID NOT NULL REFERENCES gl_accounts(id),
  transaction_date DATE NOT NULL,
  value_date DATE,
  amount NUMERIC(15,2) NOT NULL,
  description TEXT,
  reference VARCHAR(255),
  bank_reference VARCHAR(255),
  status VARCHAR(20) DEFAULT 'imported' CHECK (status IN (
    'imported', 'matched', 'reconciled', 'excluded'
  )),
  matched_journal_line_id UUID REFERENCES gl_journal_lines(id),
  reconciliation_id UUID REFERENCES bank_reconciliations(id),
  import_batch_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bt_account ON bank_transactions(bank_account_id);
CREATE INDEX idx_bt_date ON bank_transactions(transaction_date);
CREATE INDEX idx_bt_status ON bank_transactions(status);
CREATE INDEX idx_bt_reference ON bank_transactions(reference) WHERE reference IS NOT NULL;
CREATE INDEX idx_bt_batch ON bank_transactions(import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX idx_bt_recon ON bank_transactions(reconciliation_id) WHERE reconciliation_id IS NOT NULL;

-- ── Triggers ──────────────────────────────────────────────────────────────────

CREATE TRIGGER trg_bank_reconciliations_updated_at BEFORE UPDATE ON bank_reconciliations
  FOR EACH ROW EXECUTE FUNCTION accounting_updated_at();
CREATE TRIGGER trg_bank_transactions_updated_at BEFORE UPDATE ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION accounting_updated_at();
