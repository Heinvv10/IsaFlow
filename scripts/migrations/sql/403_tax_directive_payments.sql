-- Migration 403: Tax Directive Payments
-- Links a SARS tax directive to an actual lump-sum disbursement and its GL journal.

CREATE TABLE IF NOT EXISTS tax_directive_payments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID NOT NULL REFERENCES companies(id),
  tax_directive_id   UUID NOT NULL REFERENCES tax_directives(id),
  payment_date       DATE NOT NULL,
  gross_amount       NUMERIC(15,2) NOT NULL,
  paye_amount        NUMERIC(15,2) NOT NULL,
  net_amount         NUMERIC(15,2) NOT NULL,
  bank_account_id    UUID,
  journal_entry_id   UUID REFERENCES gl_journal_entries(id),
  created_by         UUID,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, tax_directive_id)   -- one payment per directive
);

CREATE INDEX IF NOT EXISTS idx_tax_directive_payments_company
  ON tax_directive_payments (company_id, tax_directive_id);
