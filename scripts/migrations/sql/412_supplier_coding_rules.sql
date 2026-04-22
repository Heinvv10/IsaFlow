-- PRD-05 Phase 3: Supplier coding rules + learning loop + duplicate detection.
--
-- Once a supplier has been coded consistently to the same GL account + VAT
-- treatment N times, the system promotes it to auto-publish. The capture
-- inbox becomes a review queue for anomalies instead of a data-entry funnel.

-- ── Per-supplier default coding + auto-publish toggles ──────────────────────

CREATE TABLE IF NOT EXISTS supplier_coding_rules (
  id                          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id                 UUID         NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  default_gl_account_id       UUID         REFERENCES gl_accounts(id),
  default_vat_code            VARCHAR(20),          -- e.g. 'STD_RATE', 'ZERO_RATED', 'EXEMPT'
  default_cost_centre_id      UUID,
  default_project_id          UUID,
  auto_publish                BOOLEAN      NOT NULL DEFAULT FALSE,
  auto_publish_max_amount     NUMERIC(18,2),        -- cap (null = no cap)
  auto_publish_min_confidence NUMERIC(5,4) NOT NULL DEFAULT 0.9500,
  require_po_match            BOOLEAN      NOT NULL DEFAULT FALSE,
  learned_sample_count        INTEGER      NOT NULL DEFAULT 0,
  learned_from_last_correction_at TIMESTAMPTZ,
  updated_by                  UUID,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, supplier_id)
);

CREATE INDEX IF NOT EXISTS idx_supplier_coding_rules_company  ON supplier_coding_rules(company_id);
CREATE INDEX IF NOT EXISTS idx_supplier_coding_rules_supplier ON supplier_coding_rules(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_coding_rules_auto     ON supplier_coding_rules(company_id) WHERE auto_publish = TRUE;

-- ── Rolling history of how each supplier's invoices were coded ──────────────
--
-- Feeds both the learning loop (after N consistent postings, promote the rule
-- to auto_publish) and the drift-detection alert (if the coding suddenly
-- changes from a pattern, flag for review).

CREATE TABLE IF NOT EXISTS supplier_coding_history (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id          UUID         NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  supplier_invoice_id  UUID         REFERENCES supplier_invoices(id) ON DELETE SET NULL,
  gl_account_id        UUID,
  vat_code             VARCHAR(20),
  cost_centre_id       UUID,
  project_id           UUID,
  posted_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  posted_by            TEXT         NOT NULL   -- 'human:<uid>' | 'ai:...' | 'rule:<id>'
);

CREATE INDEX IF NOT EXISTS idx_supplier_coding_history_supplier_posted
  ON supplier_coding_history(company_id, supplier_id, posted_at DESC);

-- ── Duplicate-detection fingerprint on supplier_invoices ────────────────────
--
-- A natural-key hash of (vat_number, invoice_number, total_amount) catches the
-- same invoice being forwarded twice from email + uploaded via PWA. The
-- pipeline checks this before creating a new supplier_invoices row; on hit it
-- routes to manual review instead of silently duplicating.

ALTER TABLE supplier_invoices
  ADD COLUMN IF NOT EXISTS duplicate_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_supplier_invoices_duplicate_fp
  ON supplier_invoices(company_id, duplicate_fingerprint)
  WHERE duplicate_fingerprint IS NOT NULL;

-- Backfill for existing rows so the duplicate check is retroactively accurate.
UPDATE supplier_invoices si
SET duplicate_fingerprint = lower(
  coalesce(s.vat_number, 'no-vat') || '|' ||
  coalesce(si.invoice_number, 'no-inv') || '|' ||
  coalesce(si.total_amount::text, '0')
)
FROM suppliers s
WHERE s.id = si.supplier_id
  AND si.duplicate_fingerprint IS NULL;
