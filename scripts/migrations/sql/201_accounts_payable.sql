-- Migration 201: Accounts Payable
-- PRD-060: FibreFlow Accounting Module - Phase 2
-- Supplier Invoices, Payments, 3-Way Matching, Auto-GL Posting

-- ── Extend GL Journal Entry Source Types ─────────────────────────────────────

ALTER TABLE gl_journal_entries DROP CONSTRAINT IF EXISTS gl_journal_entries_source_check;
ALTER TABLE gl_journal_entries ADD CONSTRAINT gl_journal_entries_source_check
  CHECK (source IN (
    'manual', 'auto_invoice', 'auto_payment', 'auto_grn',
    'auto_credit_note', 'auto_bank_recon',
    'auto_supplier_invoice', 'auto_supplier_payment'
  ));

-- ── Supplier Invoices ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS supplier_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number VARCHAR(50) NOT NULL,
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  purchase_order_id UUID,
  grn_id UUID,
  invoice_date DATE NOT NULL,
  due_date DATE,
  received_date DATE DEFAULT CURRENT_DATE,
  subtotal NUMERIC(15,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(5,2) DEFAULT 15.00,
  tax_amount NUMERIC(15,2) DEFAULT 0,
  total_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(15,2) DEFAULT 0,
  balance NUMERIC(15,2) GENERATED ALWAYS AS (total_amount - amount_paid) STORED,
  payment_terms VARCHAR(50),
  currency VARCHAR(3) DEFAULT 'ZAR',
  reference VARCHAR(255),
  status VARCHAR(30) DEFAULT 'draft' CHECK (status IN (
    'draft', 'pending_approval', 'approved', 'partially_paid', 'paid', 'disputed', 'cancelled'
  )),
  match_status VARCHAR(30) DEFAULT 'unmatched' CHECK (match_status IN (
    'unmatched', 'po_matched', 'grn_matched', 'fully_matched'
  )),
  project_id UUID,
  cost_center_id UUID,
  gl_journal_entry_id UUID REFERENCES gl_journal_entries(id),
  sage_invoice_id VARCHAR(100),
  notes TEXT,
  created_by UUID NOT NULL,
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_si_supplier ON supplier_invoices(supplier_id);
CREATE INDEX idx_si_po ON supplier_invoices(purchase_order_id) WHERE purchase_order_id IS NOT NULL;
CREATE INDEX idx_si_status ON supplier_invoices(status);
CREATE INDEX idx_si_match ON supplier_invoices(match_status);
CREATE INDEX idx_si_due_date ON supplier_invoices(due_date) WHERE due_date IS NOT NULL;
CREATE INDEX idx_si_date ON supplier_invoices(invoice_date);

-- ── Supplier Invoice Items ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS supplier_invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_invoice_id UUID NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
  po_item_id UUID,
  description TEXT NOT NULL,
  quantity NUMERIC(12,4) NOT NULL DEFAULT 1,
  unit_price NUMERIC(15,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(5,2) DEFAULT 15.00,
  tax_amount NUMERIC(15,2) DEFAULT 0,
  line_total NUMERIC(15,2) NOT NULL DEFAULT 0,
  gl_account_id UUID REFERENCES gl_accounts(id),
  project_id UUID,
  cost_center_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sii_invoice ON supplier_invoice_items(supplier_invoice_id);
CREATE INDEX idx_sii_po_item ON supplier_invoice_items(po_item_id) WHERE po_item_id IS NOT NULL;

-- ── Supplier Payments ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS supplier_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_number VARCHAR(30),
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  payment_date DATE NOT NULL,
  total_amount NUMERIC(15,2) NOT NULL,
  payment_method VARCHAR(20) DEFAULT 'eft' CHECK (payment_method IN ('eft', 'cheque', 'cash', 'card')),
  bank_account_id UUID REFERENCES gl_accounts(id),
  reference VARCHAR(255),
  description TEXT,
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN (
    'draft', 'approved', 'processed', 'reconciled', 'cancelled'
  )),
  gl_journal_entry_id UUID REFERENCES gl_journal_entries(id),
  batch_id UUID,
  created_by UUID NOT NULL,
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sp_supplier ON supplier_payments(supplier_id);
CREATE INDEX idx_sp_status ON supplier_payments(status);
CREATE INDEX idx_sp_date ON supplier_payments(payment_date);
CREATE INDEX idx_sp_batch ON supplier_payments(batch_id) WHERE batch_id IS NOT NULL;

-- ── Payment Allocations ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES supplier_payments(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES supplier_invoices(id),
  amount_allocated NUMERIC(15,2) NOT NULL CHECK (amount_allocated > 0),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(payment_id, invoice_id)
);

CREATE INDEX idx_pa_payment ON payment_allocations(payment_id);
CREATE INDEX idx_pa_invoice ON payment_allocations(invoice_id);

-- ── Triggers ──────────────────────────────────────────────────────────────────

-- Auto-generate payment number (SP-YYYY-NNNNN)
CREATE OR REPLACE FUNCTION generate_supplier_payment_number()
RETURNS TRIGGER AS $$
DECLARE
  pay_year INT;
  next_seq INT;
BEGIN
  pay_year := EXTRACT(YEAR FROM NEW.payment_date);
  SELECT COALESCE(MAX(
    CAST(SPLIT_PART(payment_number, '-', 3) AS INT)
  ), 0) + 1 INTO next_seq
  FROM supplier_payments
  WHERE payment_number LIKE 'SP-' || pay_year || '-%';

  NEW.payment_number := 'SP-' || pay_year || '-' || LPAD(next_seq::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sp_payment_number
  BEFORE INSERT ON supplier_payments
  FOR EACH ROW
  WHEN (NEW.payment_number IS NULL)
  EXECUTE FUNCTION generate_supplier_payment_number();

-- Auto-update updated_at timestamps
CREATE TRIGGER trg_supplier_invoices_updated_at BEFORE UPDATE ON supplier_invoices
  FOR EACH ROW EXECUTE FUNCTION accounting_updated_at();
CREATE TRIGGER trg_supplier_payments_updated_at BEFORE UPDATE ON supplier_payments
  FOR EACH ROW EXECUTE FUNCTION accounting_updated_at();
