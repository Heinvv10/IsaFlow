-- Migration 400: VAT Returns Submissions Table
-- Records each VAT201 submission to SARS, linking the clearing journal entry.

CREATE TABLE IF NOT EXISTS vat_returns (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID        NOT NULL REFERENCES companies(id),
  period_start      DATE        NOT NULL,
  period_end        DATE        NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'submitted',
  total_output_tax  NUMERIC(15,2) NOT NULL,
  total_input_tax   NUMERIC(15,2) NOT NULL,
  net_vat           NUMERIC(15,2) NOT NULL,
  sars_reference    VARCHAR(100),
  submitted_at      TIMESTAMPTZ DEFAULT NOW(),
  submitted_by      UUID,
  journal_entry_id  UUID REFERENCES gl_journal_entries(id),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_vat_returns_company_period
  ON vat_returns(company_id, period_start DESC);
