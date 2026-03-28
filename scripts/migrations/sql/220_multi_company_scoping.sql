-- ============================================================================
-- 220: Multi-Company Data Scoping
-- Adds company_id to all accounting tables for data isolation.
-- Backwards-compatible: nullable → backfill → NOT NULL
-- ============================================================================

-- Default company UUID (seeded in multi-entity.sql)
-- '00000000-0000-0000-0000-000000000001'

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────────
-- STEP 1: Add company_id columns (nullable initially)
-- ──────────────────────────────────────────────────────────────────────────────

-- GL
ALTER TABLE gl_accounts ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
ALTER TABLE fiscal_periods ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
ALTER TABLE gl_journal_entries ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);

-- AR
ALTER TABLE customers ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
ALTER TABLE credit_notes ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
ALTER TABLE customer_write_offs ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
ALTER TABLE recurring_invoices ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);

-- AP
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
ALTER TABLE supplier_payment_batches ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);

-- Banking
ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
ALTER TABLE bank_reconciliations ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
ALTER TABLE bank_categorisation_rules ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
ALTER TABLE categorization_patterns ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);

-- Other
ALTER TABLE cost_centres ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
ALTER TABLE currencies ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
ALTER TABLE accounting_budgets ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
ALTER TABLE accounting_adjustments ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
ALTER TABLE vat_adjustments ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
ALTER TABLE recurring_journals ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);

-- Company branding
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_data TEXT;


-- ──────────────────────────────────────────────────────────────────────────────
-- STEP 2: Backfill existing data to default company
-- ──────────────────────────────────────────────────────────────────────────────

UPDATE gl_accounts SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE fiscal_periods SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE gl_journal_entries SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE customers SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE customer_invoices SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE customer_payments SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE credit_notes SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE customer_write_offs SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE recurring_invoices SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE suppliers SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE supplier_invoices SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE supplier_payments SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE supplier_payment_batches SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE bank_transactions SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE bank_reconciliations SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE bank_categorisation_rules SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE categorization_patterns SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE cost_centres SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE currencies SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE accounting_budgets SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE accounting_adjustments SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE vat_adjustments SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;
UPDATE recurring_journals SET company_id = '00000000-0000-0000-0000-000000000001' WHERE company_id IS NULL;


-- ──────────────────────────────────────────────────────────────────────────────
-- STEP 3: Set NOT NULL constraints
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE gl_accounts ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE fiscal_periods ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE gl_journal_entries ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE customers ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE customer_invoices ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE customer_payments ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE credit_notes ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE customer_write_offs ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE recurring_invoices ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE suppliers ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE supplier_invoices ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE supplier_payments ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE supplier_payment_batches ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE bank_transactions ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE bank_reconciliations ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE bank_categorisation_rules ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE categorization_patterns ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE cost_centres ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE currencies ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE accounting_budgets ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE accounting_adjustments ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE vat_adjustments ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE recurring_journals ALTER COLUMN company_id SET NOT NULL;


-- ──────────────────────────────────────────────────────────────────────────────
-- STEP 4: Add indexes for query performance
-- ──────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_gl_accounts_company ON gl_accounts(company_id);
CREATE INDEX IF NOT EXISTS idx_fiscal_periods_company ON fiscal_periods(company_id);
CREATE INDEX IF NOT EXISTS idx_gl_journal_entries_company ON gl_journal_entries(company_id);
CREATE INDEX IF NOT EXISTS idx_customers_company ON customers(company_id);
CREATE INDEX IF NOT EXISTS idx_customer_invoices_company ON customer_invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_customer_payments_company ON customer_payments(company_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_company ON credit_notes(company_id);
CREATE INDEX IF NOT EXISTS idx_customer_write_offs_company ON customer_write_offs(company_id);
CREATE INDEX IF NOT EXISTS idx_recurring_invoices_company ON recurring_invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_company ON suppliers(company_id);
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_company ON supplier_invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_company ON supplier_payments(company_id);
CREATE INDEX IF NOT EXISTS idx_supplier_payment_batches_company ON supplier_payment_batches(company_id);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_company ON bank_transactions(company_id);
CREATE INDEX IF NOT EXISTS idx_bank_reconciliations_company ON bank_reconciliations(company_id);
CREATE INDEX IF NOT EXISTS idx_bank_categorisation_rules_company ON bank_categorisation_rules(company_id);
CREATE INDEX IF NOT EXISTS idx_categorization_patterns_company ON categorization_patterns(company_id);
CREATE INDEX IF NOT EXISTS idx_cost_centres_company ON cost_centres(company_id);
CREATE INDEX IF NOT EXISTS idx_currencies_company ON currencies(company_id);
CREATE INDEX IF NOT EXISTS idx_accounting_budgets_company ON accounting_budgets(company_id);
CREATE INDEX IF NOT EXISTS idx_accounting_adjustments_company ON accounting_adjustments(company_id);
CREATE INDEX IF NOT EXISTS idx_vat_adjustments_company ON vat_adjustments(company_id);
CREATE INDEX IF NOT EXISTS idx_recurring_journals_company ON recurring_journals(company_id);


-- ──────────────────────────────────────────────────────────────────────────────
-- STEP 5: Re-scope UNIQUE constraints to include company_id
-- ──────────────────────────────────────────────────────────────────────────────

-- gl_accounts: account_code unique per company
ALTER TABLE gl_accounts DROP CONSTRAINT IF EXISTS gl_accounts_account_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_gl_accounts_company_code ON gl_accounts(company_id, account_code);

-- fiscal_periods: year+period unique per company
ALTER TABLE fiscal_periods DROP CONSTRAINT IF EXISTS fiscal_periods_fiscal_year_period_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_periods_company_year_period ON fiscal_periods(company_id, fiscal_year, period_number);

-- gl_journal_entries: entry_number unique per company
ALTER TABLE gl_journal_entries DROP CONSTRAINT IF EXISTS gl_journal_entries_entry_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_gl_je_company_entry_number ON gl_journal_entries(company_id, entry_number);

-- customer_invoices: invoice_number unique per company
ALTER TABLE customer_invoices DROP CONSTRAINT IF EXISTS customer_invoices_invoice_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_invoices_company_number ON customer_invoices(company_id, invoice_number);

-- cost_centres: code unique per company
ALTER TABLE cost_centres DROP CONSTRAINT IF EXISTS cost_centres_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cost_centres_company_code ON cost_centres(company_id, code);

-- currencies: code unique per company
ALTER TABLE currencies DROP CONSTRAINT IF EXISTS currencies_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_currencies_company_code ON currencies(company_id, code);

-- customer_write_offs: write_off_number unique per company
ALTER TABLE customer_write_offs DROP CONSTRAINT IF EXISTS customer_write_offs_write_off_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_write_offs_company_number ON customer_write_offs(company_id, write_off_number);

-- accounting_adjustments: adjustment_number unique per company
ALTER TABLE accounting_adjustments DROP CONSTRAINT IF EXISTS accounting_adjustments_adjustment_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_adjustments_company_number ON accounting_adjustments(company_id, adjustment_number);

-- supplier_payment_batches: batch_number unique per company
ALTER TABLE supplier_payment_batches DROP CONSTRAINT IF EXISTS supplier_payment_batches_batch_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_batches_company_number ON supplier_payment_batches(company_id, batch_number);

-- vat_adjustments: adjustment_number unique per company
ALTER TABLE vat_adjustments DROP CONSTRAINT IF EXISTS vat_adjustments_adjustment_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vat_adj_company_number ON vat_adjustments(company_id, adjustment_number);


-- ──────────────────────────────────────────────────────────────────────────────
-- STEP 6: Update auto-number trigger functions to scope by company
-- ──────────────────────────────────────────────────────────────────────────────

-- Journal entry numbers: JE-YYYY-NNNNN per company
CREATE OR REPLACE FUNCTION generate_journal_entry_number()
RETURNS TRIGGER AS $$
DECLARE
  entry_year INT;
  next_seq INT;
BEGIN
  IF NEW.entry_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  entry_year := EXTRACT(YEAR FROM COALESCE(NEW.entry_date, CURRENT_DATE));
  SELECT COALESCE(MAX(
    CAST(NULLIF(SPLIT_PART(entry_number, '-', 3), '') AS INT)
  ), 0) + 1 INTO next_seq
  FROM gl_journal_entries
  WHERE company_id = NEW.company_id
    AND entry_number LIKE 'JE-' || entry_year || '-%';
  NEW.entry_number := 'JE-' || entry_year || '-' || LPAD(next_seq::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Customer payment numbers: CP-YYYY-NNNNN per company
CREATE OR REPLACE FUNCTION generate_customer_payment_number()
RETURNS TRIGGER AS $$
DECLARE
  pay_year INT;
  next_seq INT;
BEGIN
  IF NEW.payment_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  pay_year := EXTRACT(YEAR FROM COALESCE(NEW.payment_date, CURRENT_DATE));
  SELECT COALESCE(MAX(
    CAST(NULLIF(SPLIT_PART(payment_number, '-', 3), '') AS INT)
  ), 0) + 1 INTO next_seq
  FROM customer_payments
  WHERE company_id = NEW.company_id
    AND payment_number LIKE 'CP-' || pay_year || '-%';
  NEW.payment_number := 'CP-' || pay_year || '-' || LPAD(next_seq::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Supplier payment numbers: SP-YYYY-NNNNN per company
CREATE OR REPLACE FUNCTION generate_supplier_payment_number()
RETURNS TRIGGER AS $$
DECLARE
  pay_year INT;
  next_seq INT;
BEGIN
  IF NEW.payment_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  pay_year := EXTRACT(YEAR FROM COALESCE(NEW.payment_date, CURRENT_DATE));
  SELECT COALESCE(MAX(
    CAST(NULLIF(SPLIT_PART(payment_number, '-', 3), '') AS INT)
  ), 0) + 1 INTO next_seq
  FROM supplier_payments
  WHERE company_id = NEW.company_id
    AND payment_number LIKE 'SP-' || pay_year || '-%';
  NEW.payment_number := 'SP-' || pay_year || '-' || LPAD(next_seq::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Credit note numbers: CN-YYYY-NNNNN per company
CREATE OR REPLACE FUNCTION generate_credit_note_number()
RETURNS TRIGGER AS $$
DECLARE
  cn_year INT;
  next_seq INT;
BEGIN
  IF NEW.credit_note_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  cn_year := EXTRACT(YEAR FROM COALESCE(NEW.credit_date, CURRENT_DATE));
  SELECT COALESCE(MAX(
    CAST(NULLIF(SPLIT_PART(credit_note_number, '-', 3), '') AS INT)
  ), 0) + 1 INTO next_seq
  FROM credit_notes
  WHERE company_id = NEW.company_id
    AND credit_note_number LIKE 'CN-' || cn_year || '-%';
  NEW.credit_note_number := 'CN-' || cn_year || '-' || LPAD(next_seq::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Write-off numbers: WO-YYYY-NNNNN per company
CREATE OR REPLACE FUNCTION generate_write_off_number()
RETURNS TRIGGER AS $$
DECLARE
  wo_year INT;
  next_seq INT;
BEGIN
  IF NEW.write_off_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  wo_year := EXTRACT(YEAR FROM CURRENT_DATE);
  SELECT COALESCE(MAX(
    CAST(NULLIF(SPLIT_PART(write_off_number, '-', 3), '') AS INT)
  ), 0) + 1 INTO next_seq
  FROM customer_write_offs
  WHERE company_id = NEW.company_id
    AND write_off_number LIKE 'WO-' || wo_year || '-%';
  NEW.write_off_number := 'WO-' || wo_year || '-' || LPAD(next_seq::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Adjustment numbers: ADJ-YYYY-NNNNN per company
CREATE OR REPLACE FUNCTION generate_adjustment_number()
RETURNS TRIGGER AS $$
DECLARE
  adj_year INT;
  next_seq INT;
BEGIN
  IF NEW.adjustment_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  adj_year := EXTRACT(YEAR FROM CURRENT_DATE);
  SELECT COALESCE(MAX(
    CAST(NULLIF(SPLIT_PART(adjustment_number, '-', 3), '') AS INT)
  ), 0) + 1 INTO next_seq
  FROM accounting_adjustments
  WHERE company_id = NEW.company_id
    AND adjustment_number LIKE 'ADJ-' || adj_year || '-%';
  NEW.adjustment_number := 'ADJ-' || adj_year || '-' || LPAD(next_seq::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Batch payment numbers: BAT-YYYY-NNNNN per company
CREATE OR REPLACE FUNCTION generate_batch_number()
RETURNS TRIGGER AS $$
DECLARE
  bat_year INT;
  next_seq INT;
BEGIN
  IF NEW.batch_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  bat_year := EXTRACT(YEAR FROM CURRENT_DATE);
  SELECT COALESCE(MAX(
    CAST(NULLIF(SPLIT_PART(batch_number, '-', 3), '') AS INT)
  ), 0) + 1 INTO next_seq
  FROM supplier_payment_batches
  WHERE company_id = NEW.company_id
    AND batch_number LIKE 'BAT-' || bat_year || '-%';
  NEW.batch_number := 'BAT-' || bat_year || '-' || LPAD(next_seq::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- VAT adjustment numbers: VA-YYYY-NNNNN per company
CREATE OR REPLACE FUNCTION generate_vat_adjustment_number()
RETURNS TRIGGER AS $$
DECLARE
  va_year INT;
  next_seq INT;
BEGIN
  IF NEW.adjustment_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  va_year := EXTRACT(YEAR FROM CURRENT_DATE);
  SELECT COALESCE(MAX(
    CAST(NULLIF(SPLIT_PART(adjustment_number, '-', 3), '') AS INT)
  ), 0) + 1 INTO next_seq
  FROM vat_adjustments
  WHERE company_id = NEW.company_id
    AND adjustment_number LIKE 'VA-' || va_year || '-%';
  NEW.adjustment_number := 'VA-' || va_year || '-' || LPAD(next_seq::TEXT, 5, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ──────────────────────────────────────────────────────────────────────────────
-- STEP 7: Ensure all existing users are linked to default company
-- ──────────────────────────────────────────────────────────────────────────────

INSERT INTO company_users (company_id, user_id, role, is_default)
SELECT '00000000-0000-0000-0000-000000000001', id, 'admin', true
FROM users
WHERE NOT EXISTS (
  SELECT 1 FROM company_users
  WHERE user_id = users.id
    AND company_id = '00000000-0000-0000-0000-000000000001'
)
ON CONFLICT DO NOTHING;


COMMIT;
