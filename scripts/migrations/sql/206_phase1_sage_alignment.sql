-- Migration 206: Phase 1 Sage Alignment
-- Adds tables for: recurring invoices, write-offs, adjustments,
-- batch payments, recurring journals, VAT adjustments

-- ── Recurring Customer Invoices ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS recurring_invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_name   TEXT NOT NULL,
  client_id       UUID NOT NULL REFERENCES customers(id),
  project_id      UUID,
  frequency       TEXT NOT NULL CHECK (frequency IN ('weekly','monthly','quarterly','annually')),
  next_run_date   DATE NOT NULL,
  end_date        DATE,
  last_run_date   DATE,
  run_count       INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','cancelled')),
  description     TEXT,
  line_items      JSONB NOT NULL DEFAULT '[]',
  subtotal        NUMERIC(15,2) NOT NULL DEFAULT 0,
  tax_rate        NUMERIC(5,2) NOT NULL DEFAULT 15.00,
  tax_amount      NUMERIC(15,2) NOT NULL DEFAULT 0,
  total_amount    NUMERIC(15,2) NOT NULL DEFAULT 0,
  payment_terms   TEXT DEFAULT '30 days',
  created_by      UUID NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recurring_invoices_client ON recurring_invoices(client_id);
CREATE INDEX IF NOT EXISTS idx_recurring_invoices_status ON recurring_invoices(status);
CREATE INDEX IF NOT EXISTS idx_recurring_invoices_next_run ON recurring_invoices(next_run_date) WHERE status = 'active';

-- ── Customer Write-Offs ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS customer_write_offs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  write_off_number    TEXT NOT NULL UNIQUE,
  client_id           UUID NOT NULL REFERENCES customers(id),
  invoice_id          UUID NOT NULL REFERENCES customer_invoices(id),
  amount              NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  reason              TEXT NOT NULL,
  write_off_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','cancelled')),
  gl_journal_entry_id UUID REFERENCES gl_journal_entries(id),
  approved_by         UUID,
  approved_at         TIMESTAMPTZ,
  created_by          UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_write_offs_client ON customer_write_offs(client_id);
CREATE INDEX IF NOT EXISTS idx_write_offs_invoice ON customer_write_offs(invoice_id);
CREATE INDEX IF NOT EXISTS idx_write_offs_status ON customer_write_offs(status);

-- Auto-generate write-off numbers: WO-YYYY-NNNNN
CREATE OR REPLACE FUNCTION generate_write_off_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
  yr TEXT;
BEGIN
  yr := TO_CHAR(CURRENT_DATE, 'YYYY');
  SELECT COALESCE(MAX(CAST(SUBSTRING(write_off_number FROM 9) AS INTEGER)), 0) + 1
    INTO next_num
    FROM customer_write_offs
    WHERE write_off_number LIKE 'WO-' || yr || '-%';
  NEW.write_off_number := 'WO-' || yr || '-' || LPAD(next_num::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wo_number ON customer_write_offs;
CREATE TRIGGER trg_wo_number
  BEFORE INSERT ON customer_write_offs
  FOR EACH ROW
  WHEN (NEW.write_off_number IS NULL OR NEW.write_off_number = '')
  EXECUTE FUNCTION generate_write_off_number();

-- ── Adjustments (Customer & Supplier) ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS accounting_adjustments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  adjustment_number   TEXT NOT NULL UNIQUE,
  entity_type         TEXT NOT NULL CHECK (entity_type IN ('customer','supplier')),
  entity_id           UUID NOT NULL,
  adjustment_type     TEXT NOT NULL CHECK (adjustment_type IN ('debit','credit')),
  amount              NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  reason              TEXT NOT NULL,
  adjustment_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','cancelled')),
  gl_journal_entry_id UUID REFERENCES gl_journal_entries(id),
  approved_by         UUID,
  approved_at         TIMESTAMPTZ,
  created_by          UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_adjustments_entity ON accounting_adjustments(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_adjustments_status ON accounting_adjustments(status);

-- Auto-generate adjustment numbers: ADJ-YYYY-NNNNN
CREATE OR REPLACE FUNCTION generate_adjustment_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
  yr TEXT;
BEGIN
  yr := TO_CHAR(CURRENT_DATE, 'YYYY');
  SELECT COALESCE(MAX(CAST(SUBSTRING(adjustment_number FROM 10) AS INTEGER)), 0) + 1
    INTO next_num
    FROM accounting_adjustments
    WHERE adjustment_number LIKE 'ADJ-' || yr || '-%';
  NEW.adjustment_number := 'ADJ-' || yr || '-' || LPAD(next_num::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_adj_number ON accounting_adjustments;
CREATE TRIGGER trg_adj_number
  BEFORE INSERT ON accounting_adjustments
  FOR EACH ROW
  WHEN (NEW.adjustment_number IS NULL OR NEW.adjustment_number = '')
  EXECUTE FUNCTION generate_adjustment_number();

-- ── Supplier Payment Batches ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS supplier_payment_batches (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_number        TEXT NOT NULL UNIQUE,
  batch_date          DATE NOT NULL DEFAULT CURRENT_DATE,
  total_amount        NUMERIC(15,2) NOT NULL DEFAULT 0,
  payment_count       INTEGER NOT NULL DEFAULT 0,
  payment_method      TEXT NOT NULL DEFAULT 'eft' CHECK (payment_method IN ('eft','cheque','cash','card')),
  bank_account_id     UUID REFERENCES gl_accounts(id),
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','processed','cancelled')),
  gl_journal_entry_id UUID REFERENCES gl_journal_entries(id),
  notes               TEXT,
  processed_by        UUID,
  processed_at        TIMESTAMPTZ,
  created_by          UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_batch_status ON supplier_payment_batches(status);

-- Auto-generate batch numbers: BAT-YYYY-NNNNN
CREATE OR REPLACE FUNCTION generate_batch_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
  yr TEXT;
BEGIN
  yr := TO_CHAR(CURRENT_DATE, 'YYYY');
  SELECT COALESCE(MAX(CAST(SUBSTRING(batch_number FROM 10) AS INTEGER)), 0) + 1
    INTO next_num
    FROM supplier_payment_batches
    WHERE batch_number LIKE 'BAT-' || yr || '-%';
  NEW.batch_number := 'BAT-' || yr || '-' || LPAD(next_num::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bat_number ON supplier_payment_batches;
CREATE TRIGGER trg_bat_number
  BEFORE INSERT ON supplier_payment_batches
  FOR EACH ROW
  WHEN (NEW.batch_number IS NULL OR NEW.batch_number = '')
  EXECUTE FUNCTION generate_batch_number();

-- ── Recurring Journal Entries ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS recurring_journals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_name   TEXT NOT NULL,
  description     TEXT,
  frequency       TEXT NOT NULL CHECK (frequency IN ('weekly','monthly','quarterly','annually')),
  next_run_date   DATE NOT NULL,
  end_date        DATE,
  last_run_date   DATE,
  run_count       INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','cancelled')),
  lines           JSONB NOT NULL DEFAULT '[]',
  total_amount    NUMERIC(15,2) NOT NULL DEFAULT 0,
  created_by      UUID NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recurring_journals_status ON recurring_journals(status);
CREATE INDEX IF NOT EXISTS idx_recurring_journals_next_run ON recurring_journals(next_run_date) WHERE status = 'active';

-- ── VAT Adjustments ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vat_adjustments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  adjustment_number   TEXT NOT NULL UNIQUE,
  adjustment_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  vat_period          TEXT,
  adjustment_type     TEXT NOT NULL CHECK (adjustment_type IN ('input','output')),
  amount              NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  reason              TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','cancelled')),
  gl_journal_entry_id UUID REFERENCES gl_journal_entries(id),
  approved_by         UUID,
  approved_at         TIMESTAMPTZ,
  created_by          UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vat_adj_status ON vat_adjustments(status);

-- Auto-generate VAT adjustment numbers: VA-YYYY-NNNNN
CREATE OR REPLACE FUNCTION generate_vat_adjustment_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
  yr TEXT;
BEGIN
  yr := TO_CHAR(CURRENT_DATE, 'YYYY');
  SELECT COALESCE(MAX(CAST(SUBSTRING(adjustment_number FROM 9) AS INTEGER)), 0) + 1
    INTO next_num
    FROM vat_adjustments
    WHERE adjustment_number LIKE 'VA-' || yr || '-%';
  NEW.adjustment_number := 'VA-' || yr || '-' || LPAD(next_num::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_va_number ON vat_adjustments;
CREATE TRIGGER trg_va_number
  BEFORE INSERT ON vat_adjustments
  FOR EACH ROW
  WHEN (NEW.adjustment_number IS NULL OR NEW.adjustment_number = '')
  EXECUTE FUNCTION generate_vat_adjustment_number();

-- ── Add GL source types for new auto-posting ────────────────────────────────

-- Update gl_journal_entries source check to include new types
ALTER TABLE gl_journal_entries
  DROP CONSTRAINT IF EXISTS gl_journal_entries_source_check;

ALTER TABLE gl_journal_entries
  ADD CONSTRAINT gl_journal_entries_source_check
  CHECK (source IN (
    'manual', 'auto_invoice', 'auto_payment', 'auto_grn',
    'auto_credit_note', 'auto_bank_recon', 'auto_supplier_invoice',
    'auto_supplier_payment', 'auto_write_off', 'auto_adjustment',
    'auto_vat_adjustment', 'auto_batch_payment', 'auto_recurring'
  ));

-- ── Updated-at triggers ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION accounting_phase1_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_recurring_invoices_updated ON recurring_invoices;
CREATE TRIGGER trg_recurring_invoices_updated BEFORE UPDATE ON recurring_invoices
  FOR EACH ROW EXECUTE FUNCTION accounting_phase1_updated_at();

DROP TRIGGER IF EXISTS trg_write_offs_updated ON customer_write_offs;
CREATE TRIGGER trg_write_offs_updated BEFORE UPDATE ON customer_write_offs
  FOR EACH ROW EXECUTE FUNCTION accounting_phase1_updated_at();

DROP TRIGGER IF EXISTS trg_adjustments_updated ON accounting_adjustments;
CREATE TRIGGER trg_adjustments_updated BEFORE UPDATE ON accounting_adjustments
  FOR EACH ROW EXECUTE FUNCTION accounting_phase1_updated_at();

DROP TRIGGER IF EXISTS trg_batches_updated ON supplier_payment_batches;
CREATE TRIGGER trg_batches_updated BEFORE UPDATE ON supplier_payment_batches
  FOR EACH ROW EXECUTE FUNCTION accounting_phase1_updated_at();

DROP TRIGGER IF EXISTS trg_recurring_journals_updated ON recurring_journals;
CREATE TRIGGER trg_recurring_journals_updated BEFORE UPDATE ON recurring_journals
  FOR EACH ROW EXECUTE FUNCTION accounting_phase1_updated_at();

DROP TRIGGER IF EXISTS trg_vat_adj_updated ON vat_adjustments;
CREATE TRIGGER trg_vat_adj_updated BEFORE UPDATE ON vat_adjustments
  FOR EACH ROW EXECUTE FUNCTION accounting_phase1_updated_at();
