-- PRD-05 Phase 7: Bank & supplier statement PDF reconciliation.
--
-- Bank statement: upload PDF → VLM extracts rows → system dedupes against
-- existing bank_transactions → user reviews + commits new rows.
-- Supplier statement: upload PDF → VLM extracts statement lines → system
-- matches each line to supplier_invoices → reports variance (missing in
-- IsaFlow, missing in statement, amount diff).

-- ── Bank statement imports ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bank_statement_imports (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_account_id      UUID         NOT NULL REFERENCES gl_accounts(id),
  source_document_id   UUID         NOT NULL REFERENCES captured_documents(id) ON DELETE CASCADE,
  period_start         DATE,
  period_end           DATE,
  opening_balance      NUMERIC(18,2),
  closing_balance      NUMERIC(18,2),
  row_count            INTEGER      NOT NULL DEFAULT 0,
  imported_count       INTEGER      NOT NULL DEFAULT 0,
  duplicate_count      INTEGER      NOT NULL DEFAULT 0,
  status               TEXT         NOT NULL DEFAULT 'extracted'
    CHECK (status IN ('extracted', 'reviewing', 'committed', 'rolled_back')),
  extraction_summary   JSONB        NOT NULL DEFAULT '{}'::jsonb,  -- { rows: [...], warnings: [...] }
  committed_at         TIMESTAMPTZ,
  committed_by         UUID,
  created_by           UUID,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_stmt_imports_company ON bank_statement_imports(company_id);
CREATE INDEX IF NOT EXISTS idx_bank_stmt_imports_status  ON bank_statement_imports(company_id, status);
CREATE INDEX IF NOT EXISTS idx_bank_stmt_imports_account ON bank_statement_imports(bank_account_id);

-- ── Supplier statement reconciliations ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS supplier_statement_reconciliations (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id          UUID         NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  source_document_id   UUID         NOT NULL REFERENCES captured_documents(id) ON DELETE CASCADE,
  statement_date       DATE         NOT NULL,
  period_start         DATE,
  period_end           DATE,
  supplier_balance     NUMERIC(18,2) NOT NULL,   -- "you owe us" per statement
  isaflow_balance      NUMERIC(18,2) NOT NULL,   -- supplier ledger total at statement_date
  variance             NUMERIC(18,2) NOT NULL,   -- supplier_balance - isaflow_balance
  status               TEXT         NOT NULL DEFAULT 'unreconciled'
    CHECK (status IN ('unreconciled', 'reconciled', 'disputed', 'archived')),
  missing_in_isaflow_count   INTEGER NOT NULL DEFAULT 0,
  missing_in_statement_count INTEGER NOT NULL DEFAULT 0,
  amount_diff_count          INTEGER NOT NULL DEFAULT 0,
  notes                TEXT,
  reconciled_at        TIMESTAMPTZ,
  reconciled_by        UUID,
  created_by           UUID,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_supplier_recon_company   ON supplier_statement_reconciliations(company_id);
CREATE INDEX IF NOT EXISTS idx_supplier_recon_supplier  ON supplier_statement_reconciliations(supplier_id, statement_date DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_recon_status    ON supplier_statement_reconciliations(company_id, status);

CREATE TABLE IF NOT EXISTS supplier_statement_lines (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id    UUID         NOT NULL REFERENCES supplier_statement_reconciliations(id) ON DELETE CASCADE,
  line_date            DATE,
  reference            TEXT,
  description          TEXT,
  debit                NUMERIC(18,2) NOT NULL DEFAULT 0,
  credit               NUMERIC(18,2) NOT NULL DEFAULT 0,
  running_balance      NUMERIC(18,2),
  matched_supplier_invoice_id UUID REFERENCES supplier_invoices(id) ON DELETE SET NULL,
  match_confidence     NUMERIC(5,4),
  mismatch_reason      TEXT
    CHECK (mismatch_reason IN ('missing_in_isaflow', 'missing_in_statement', 'amount_diff', 'date_diff') OR mismatch_reason IS NULL),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_supplier_stmt_lines_recon ON supplier_statement_lines(reconciliation_id);
CREATE INDEX IF NOT EXISTS idx_supplier_stmt_lines_match ON supplier_statement_lines(matched_supplier_invoice_id)
  WHERE matched_supplier_invoice_id IS NOT NULL;
