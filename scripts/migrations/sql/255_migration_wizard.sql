-- Migration 255: Migration Wizard Session Table
-- PRD: Customer Migration Wizard — Phase 1
-- Tracks migration progress so users can resume interrupted sessions.

-- ── Migration Sessions ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS migration_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  source_system VARCHAR(50),  -- 'sage_cloud', 'sage_50', 'xero', 'quickbooks', 'pastel', 'other'
  status VARCHAR(20) DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'abandoned')),
  steps_completed JSONB DEFAULT '{}',  -- { "coa": true, "customers": true, ... }
  coa_records_imported INT DEFAULT 0,
  customers_imported INT DEFAULT 0,
  suppliers_imported INT DEFAULT 0,
  opening_balances_set BOOLEAN DEFAULT false,
  ar_invoices_imported INT DEFAULT 0,
  ap_invoices_imported INT DEFAULT 0,
  errors JSONB DEFAULT '[]',
  started_by UUID NOT NULL,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_migration_sessions_company ON migration_sessions(company_id);
CREATE INDEX IF NOT EXISTS idx_migration_sessions_status ON migration_sessions(status);

-- ── Extend gl_journal_entries source CHECK to include auto_migration ─────────

ALTER TABLE gl_journal_entries DROP CONSTRAINT IF EXISTS gl_journal_entries_source_check;
ALTER TABLE gl_journal_entries ADD CONSTRAINT gl_journal_entries_source_check CHECK (source IN (
  'manual',
  'auto_invoice',
  'auto_payment',
  'auto_grn',
  'auto_credit_note',
  'auto_bank_recon',
  'auto_supplier_invoice',
  'auto_supplier_payment',
  'auto_write_off',
  'auto_adjustment',
  'auto_vat_adjustment',
  'auto_batch_payment',
  'auto_recurring',
  'auto_purchase_order',
  'auto_depreciation',
  'auto_payroll',
  'auto_migration'
));
