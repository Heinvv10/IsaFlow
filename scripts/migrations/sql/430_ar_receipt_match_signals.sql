-- PRD-06 Phase 4: Receipt → Invoice Auto-Match
--
-- Adds the infrastructure receiptMatchService needs to score incoming
-- customer receipts against open customer_invoices:
--
--   1. pg_trgm extension — fuzzy reference matching (partial INV-* hits).
--   2. Trigram GIN index on customer_invoices.invoice_number — supports
--      `similarity(invoice_number, extracted_ref) > 0.4` lookups without
--      scanning every open invoice. Filtered to open statuses so the
--      index stays small on long-lived tenants.
--
-- Note: the PRD's §4.4 originally proposed a real bank_match_candidates
-- TABLE with portal_view_boost / payment_reference_exact / _partial
-- columns. In this codebase bank_match_candidates is an in-memory type
-- (see src/modules/accounting/types/bank-match.types.ts) produced per
-- request by bankMatchCandidatesService, not a persisted table. We carry
-- those signals on the MatchCandidate type instead; no table changes
-- are needed for the scored shortlist. The existing UNIQUE index
-- uq_customer_invoices_company_number (mig 220) already serves exact
-- invoice_number lookups.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Partial trigram index: only open customer invoices are match candidates.
-- Keeps the index an order of magnitude smaller than an all-rows variant.
CREATE INDEX IF NOT EXISTS idx_customer_invoices_invoice_number_trgm
  ON customer_invoices USING gin (invoice_number gin_trgm_ops)
  WHERE status IN ('approved', 'sent', 'partially_paid', 'overdue');

COMMENT ON INDEX idx_customer_invoices_invoice_number_trgm IS
  'PRD-06 Phase 4 — trigram lookup for fuzzy invoice_number matching in receiptMatchService (threshold 0.4).';
