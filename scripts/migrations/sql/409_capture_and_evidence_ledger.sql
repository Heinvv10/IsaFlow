-- PRD-05 Phase 1 + 2: Autonomous Capture Channels + Evidence-First Ledger
--
-- Phase 1: Capture channels (email, pwa, whatsapp, imap_mirror, api) feed a
-- unified inbox. Every inbound event is a row in capture_events; the original
-- file lands in captured_documents and the VLM extraction + pipeline takes
-- over from there.
--
-- Phase 2: Every journal entry carries a cryptographic link back to the source
-- document that evidences it — hash, extraction confidence, posting agent.
-- gl_journal_entries.source_document_id already exists (from mig 200); this
-- migration adds the companion columns, the FK, and the line-level link.

-- ── Phase 1: Capture channels ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS capture_inboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'pwa', 'whatsapp', 'imap_mirror', 'api')),
  address TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  allowed_sender_domains TEXT[],
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, channel, address)
);

CREATE INDEX IF NOT EXISTS idx_capture_inboxes_company ON capture_inboxes(company_id);
CREATE INDEX IF NOT EXISTS idx_capture_inboxes_address ON capture_inboxes(address) WHERE is_active;

CREATE TABLE IF NOT EXISTS capture_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  inbox_id UUID REFERENCES capture_inboxes(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'pwa', 'whatsapp', 'imap_mirror', 'api')),
  sender TEXT,
  subject TEXT,
  raw_payload_url TEXT,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'extracting', 'extracted', 'posted', 'discarded', 'failed')),
  captured_document_id UUID REFERENCES captured_documents(id) ON DELETE SET NULL,
  error TEXT,
  posted_by TEXT,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_capture_events_company ON capture_events(company_id);
CREATE INDEX IF NOT EXISTS idx_capture_events_status ON capture_events(status);
CREATE INDEX IF NOT EXISTS idx_capture_events_received ON capture_events(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_capture_events_inbox ON capture_events(inbox_id);
CREATE INDEX IF NOT EXISTS idx_capture_events_document ON capture_events(captured_document_id) WHERE captured_document_id IS NOT NULL;

-- ── Phase 2: Evidence-first ledger ──────────────────────────────────────────

-- gl_journal_entries.source_document_id exists from migration 200 (UUID, no FK).
-- Add the companion columns for evidence provenance.
ALTER TABLE gl_journal_entries
  ADD COLUMN IF NOT EXISTS source_document_hash TEXT,
  ADD COLUMN IF NOT EXISTS extraction_confidence NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS posting_agent TEXT;

-- Pre-null orphan source_document_id values that predate captured_documents
-- existing as an enforceable reference. Equivalent to what the new
-- ON DELETE SET NULL would have done had the FK been there all along.
UPDATE gl_journal_entries
SET source_document_id = NULL
WHERE source_document_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM captured_documents cd WHERE cd.id = gl_journal_entries.source_document_id
  );

-- Retrofit the FK on source_document_id → captured_documents(id).
-- Guard with EXECUTE to make it idempotent across reruns.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_gl_je_source_document'
      AND table_name = 'gl_journal_entries'
  ) THEN
    ALTER TABLE gl_journal_entries
      ADD CONSTRAINT fk_gl_je_source_document
      FOREIGN KEY (source_document_id) REFERENCES captured_documents(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_gl_je_source_document ON gl_journal_entries(source_document_id)
  WHERE source_document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gl_je_posting_agent ON gl_journal_entries(posting_agent)
  WHERE posting_agent IS NOT NULL;

-- Line-level evidence link: when a JE line corresponds to a single line of a
-- multi-line source document (line-level VAT, cost-centre allocation, etc.).
ALTER TABLE gl_journal_lines
  ADD COLUMN IF NOT EXISTS source_document_line_id UUID;

CREATE INDEX IF NOT EXISTS idx_gl_jl_source_doc_line ON gl_journal_lines(source_document_line_id)
  WHERE source_document_line_id IS NOT NULL;

-- Backfill posting_agent on existing JEs so the invariant "every JE has a
-- posting_agent" becomes enforceable by write-path code (via CI check, not a
-- NOT NULL constraint — we want write-path failures, not migration failures,
-- when a service forgets to stamp).
UPDATE gl_journal_entries
SET posting_agent = CASE
  WHEN source IN ('auto_invoice', 'auto_payment', 'auto_grn', 'auto_credit_note', 'auto_bank_recon')
    THEN 'legacy:' || source
  ELSE 'legacy:human'
END
WHERE posting_agent IS NULL;

-- Also stamp source_document_hash where captured_documents has an extraction
-- we can hash post-hoc (skip for this migration — the hash requires reading
-- raw file bytes; the backfill job runs in a follow-up worker).

-- ── AP evidence strengthening ───────────────────────────────────────────────

-- supplier_invoices gains a first-class link to the captured document that
-- spawned it (currently linkage is only the other direction via
-- captured_documents.matched_invoice_id).
ALTER TABLE supplier_invoices
  ADD COLUMN IF NOT EXISTS source_document_id UUID,
  ADD COLUMN IF NOT EXISTS source_document_hash TEXT,
  ADD COLUMN IF NOT EXISTS extraction_confidence NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS posting_agent TEXT;

-- Same orphan pre-null pattern on supplier_invoices before FK add.
UPDATE supplier_invoices
SET source_document_id = NULL
WHERE source_document_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM captured_documents cd WHERE cd.id = supplier_invoices.source_document_id
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_supplier_inv_source_document'
      AND table_name = 'supplier_invoices'
  ) THEN
    ALTER TABLE supplier_invoices
      ADD CONSTRAINT fk_supplier_inv_source_document
      FOREIGN KEY (source_document_id) REFERENCES captured_documents(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_supplier_inv_source_document ON supplier_invoices(source_document_id)
  WHERE source_document_id IS NOT NULL;

-- Backfill supplier_invoices.source_document_id from the inverse link.
UPDATE supplier_invoices si
SET source_document_id = cd.id
FROM captured_documents cd
WHERE cd.matched_invoice_id = si.id
  AND si.source_document_id IS NULL;
