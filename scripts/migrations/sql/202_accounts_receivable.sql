-- Migration 202: Accounts Receivable Enhancements
-- PRD-060: FibreFlow Accounting Module - Phase 3
-- Customer Payments, Credit Notes, AR-GL Integration

-- ── Add GL link to customer_invoices ──────────────────────────────────────────

ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS gl_journal_entry_id UUID REFERENCES gl_journal_entries(id);

-- ── Customer Payments ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS customer_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_number VARCHAR(30),
  client_id UUID NOT NULL REFERENCES customers(id),
  payment_date DATE NOT NULL,
  total_amount NUMERIC(15,2) NOT NULL,
  payment_method VARCHAR(20) DEFAULT 'eft' CHECK (payment_method IN ('eft', 'cheque', 'cash', 'card')),
  bank_reference VARCHAR(255),
  bank_account_id UUID REFERENCES gl_accounts(id),
  description TEXT,
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN (
    'draft', 'confirmed', 'reconciled', 'cancelled'
  )),
  gl_journal_entry_id UUID REFERENCES gl_journal_entries(id),
  project_id UUID,
  created_by UUID NOT NULL,
  confirmed_by UUID,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_cp_client ON customer_payments(client_id);
CREATE INDEX idx_cp_status ON customer_payments(status);
CREATE INDEX idx_cp_date ON customer_payments(payment_date);
CREATE INDEX idx_cp_project ON customer_payments(project_id) WHERE project_id IS NOT NULL;

-- ── Customer Payment Allocations ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS customer_payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES customer_payments(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES customer_invoices(id),
  amount_allocated NUMERIC(15,2) NOT NULL CHECK (amount_allocated > 0),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(payment_id, invoice_id)
);

CREATE INDEX idx_cpa_payment ON customer_payment_allocations(payment_id);
CREATE INDEX idx_cpa_invoice ON customer_payment_allocations(invoice_id);

-- ── Credit Notes (Customer & Supplier) ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS credit_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_number VARCHAR(30),
  type VARCHAR(20) NOT NULL CHECK (type IN ('customer', 'supplier')),
  -- Customer credit note refs
  client_id UUID REFERENCES customers(id),
  customer_invoice_id UUID REFERENCES customer_invoices(id),
  -- Supplier credit note refs
  supplier_id UUID REFERENCES suppliers(id),
  supplier_invoice_id UUID REFERENCES supplier_invoices(id),
  -- Details
  credit_date DATE NOT NULL,
  reason TEXT,
  subtotal NUMERIC(15,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(5,2) DEFAULT 15.00,
  tax_amount NUMERIC(15,2) DEFAULT 0,
  total_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'applied', 'cancelled')),
  gl_journal_entry_id UUID REFERENCES gl_journal_entries(id),
  project_id UUID,
  created_by UUID NOT NULL,
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_cn_type ON credit_notes(type);
CREATE INDEX idx_cn_status ON credit_notes(status);
CREATE INDEX idx_cn_client ON credit_notes(client_id) WHERE client_id IS NOT NULL;
CREATE INDEX idx_cn_supplier ON credit_notes(supplier_id) WHERE supplier_id IS NOT NULL;

-- ── Triggers ──────────────────────────────────────────────────────────────────

-- Auto-generate customer payment number (CP-YYYY-NNNNN)
CREATE OR REPLACE FUNCTION generate_customer_payment_number()
RETURNS TRIGGER AS $$
DECLARE
  pay_year INT;
  next_seq INT;
BEGIN
  pay_year := EXTRACT(YEAR FROM NEW.payment_date);
  SELECT COALESCE(MAX(
    CAST(SPLIT_PART(payment_number, '-', 3) AS INT)
  ), 0) + 1 INTO next_seq
  FROM customer_payments
  WHERE payment_number LIKE 'CP-' || pay_year || '-%';

  NEW.payment_number := 'CP-' || pay_year || '-' || LPAD(next_seq::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cp_payment_number
  BEFORE INSERT ON customer_payments
  FOR EACH ROW
  WHEN (NEW.payment_number IS NULL)
  EXECUTE FUNCTION generate_customer_payment_number();

-- Auto-generate credit note number (CN-YYYY-NNNNN)
CREATE OR REPLACE FUNCTION generate_credit_note_number()
RETURNS TRIGGER AS $$
DECLARE
  cn_year INT;
  next_seq INT;
BEGIN
  cn_year := EXTRACT(YEAR FROM NEW.credit_date);
  SELECT COALESCE(MAX(
    CAST(SPLIT_PART(credit_note_number, '-', 3) AS INT)
  ), 0) + 1 INTO next_seq
  FROM credit_notes
  WHERE credit_note_number LIKE 'CN-' || cn_year || '-%';

  NEW.credit_note_number := 'CN-' || cn_year || '-' || LPAD(next_seq::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cn_number
  BEFORE INSERT ON credit_notes
  FOR EACH ROW
  WHEN (NEW.credit_note_number IS NULL)
  EXECUTE FUNCTION generate_credit_note_number();

-- Auto-update timestamps
CREATE TRIGGER trg_customer_payments_updated_at BEFORE UPDATE ON customer_payments
  FOR EACH ROW EXECUTE FUNCTION accounting_updated_at();
CREATE TRIGGER trg_credit_notes_updated_at BEFORE UPDATE ON credit_notes
  FOR EACH ROW EXECUTE FUNCTION accounting_updated_at();
