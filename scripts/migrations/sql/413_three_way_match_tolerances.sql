-- PRD-05 Phase 4: Native 3/4-way match — tolerance config + per-line variance cache.
--
-- The 3-way match pure util (src/modules/accounting/utils/threeWayMatch.ts) and
-- the service wrapper (supplierInvoiceWorkflowService.performThreeWayMatch) both
-- exist but aren't wired into the capture or auto-publish flow. This migration
-- adds:
--   1. Tolerance config per supplier (qty + price %) on supplier_coding_rules.
--   2. Per-line variance cache on supplier_invoice_items so the UI can render
--      the mismatch diff without recomputing from scratch.
--   3. payment_matched flag on supplier_invoices for the 4-way gate — bank
--      allocation flips it true when the full invoice total is paid.

-- ── Per-supplier tolerances ─────────────────────────────────────────────────

ALTER TABLE supplier_coding_rules
  ADD COLUMN IF NOT EXISTS qty_tolerance_pct   NUMERIC(5,2) NOT NULL DEFAULT 2.00,
  ADD COLUMN IF NOT EXISTS price_tolerance_pct NUMERIC(5,2) NOT NULL DEFAULT 2.00;

-- ── Per-line variance cache ─────────────────────────────────────────────────

ALTER TABLE supplier_invoice_items
  ADD COLUMN IF NOT EXISTS line_match_status  TEXT
    CHECK (line_match_status IN ('unmatched', 'po_matched', 'grn_matched', 'fully_matched')),
  ADD COLUMN IF NOT EXISTS qty_variance_pct   NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS price_variance_pct NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS match_computed_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sii_line_match_status
  ON supplier_invoice_items(line_match_status)
  WHERE line_match_status IS NOT NULL;

-- ── 4-way match: payment leg ────────────────────────────────────────────────

ALTER TABLE supplier_invoices
  ADD COLUMN IF NOT EXISTS payment_matched BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS payment_matched_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_supplier_invoices_payment_matched
  ON supplier_invoices(company_id, payment_matched)
  WHERE payment_matched = TRUE;
