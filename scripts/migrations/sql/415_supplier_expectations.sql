-- PRD-05 Phase 6: Supplier expectation engine + missing-invoice chase.
--
-- The system learns each supplier's billing cadence (monthly / quarterly /
-- annual / irregular) from supplier_invoices history. A daily job compares
-- the expected-by date against what's been received; gaps become alerts that
-- can auto-email the supplier to chase the missing invoice.

-- ── Per-supplier cadence & expected amount ──────────────────────────────────

CREATE TABLE IF NOT EXISTS supplier_expectations (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id              UUID         NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  cadence                  TEXT         NOT NULL
    CHECK (cadence IN ('monthly', 'quarterly', 'annual', 'irregular')),
  expected_day_of_month    INTEGER      CHECK (expected_day_of_month BETWEEN 1 AND 31),
  expected_amount          NUMERIC(18,2),
  amount_stddev            NUMERIC(18,2),
  last_invoice_date        DATE,
  last_invoice_amount      NUMERIC(18,2),
  sample_size              INTEGER      NOT NULL DEFAULT 0,
  status                   TEXT         NOT NULL DEFAULT 'learning'
    CHECK (status IN ('learning', 'locked', 'paused')),
  last_recomputed_at       TIMESTAMPTZ,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, supplier_id)
);

CREATE INDEX IF NOT EXISTS idx_supplier_expectations_company  ON supplier_expectations(company_id);
CREATE INDEX IF NOT EXISTS idx_supplier_expectations_cadence  ON supplier_expectations(cadence) WHERE status = 'locked';
CREATE INDEX IF NOT EXISTS idx_supplier_expectations_active   ON supplier_expectations(company_id, status) WHERE status != 'paused';

-- ── Daily gap detection: expected vs received ───────────────────────────────

CREATE TABLE IF NOT EXISTS expected_invoice_alerts (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id              UUID         NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  expectation_id           UUID         REFERENCES supplier_expectations(id) ON DELETE SET NULL,
  expected_by              DATE         NOT NULL,
  expected_amount          NUMERIC(18,2),
  status                   TEXT         NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'chased', 'resolved', 'dismissed')),
  chased_at                TIMESTAMPTZ,
  chase_method             TEXT
    CHECK (chase_method IN ('email', 'whatsapp') OR chase_method IS NULL),
  chase_to_address         TEXT,
  resolved_invoice_id      UUID         REFERENCES supplier_invoices(id) ON DELETE SET NULL,
  resolved_at              TIMESTAMPTZ,
  dismissed_reason         TEXT,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, supplier_id, expected_by)
);

CREATE INDEX IF NOT EXISTS idx_expected_invoice_alerts_company_status
  ON expected_invoice_alerts(company_id, status);
CREATE INDEX IF NOT EXISTS idx_expected_invoice_alerts_supplier
  ON expected_invoice_alerts(supplier_id, expected_by DESC);
CREATE INDEX IF NOT EXISTS idx_expected_invoice_alerts_pending
  ON expected_invoice_alerts(company_id, expected_by)
  WHERE status = 'pending';
