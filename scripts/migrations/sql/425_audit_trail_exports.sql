-- 425_audit_trail_exports.sql
-- PRD-05 Phase 12: Audit-trail-as-a-product.
--
-- Bundles a period's GL + source documents into a single signed PDF pack
-- that auditors can review without touching the live IsaFlow UI. Each
-- export is immutable once generated; re-running produces a new row so
-- the history is preserved.
--
-- Auditor portal access is gated by audit_portal_sessions — time-limited,
-- read-only, scoped to a single company + period + export bundle.

CREATE TABLE IF NOT EXISTS audit_trail_exports (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_start          DATE NOT NULL,
  period_end            DATE NOT NULL,
  fiscal_period_id      UUID,                                -- soft link when export covers a single period
  status                TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','building','ready','failed')),
  include_source_docs   BOOLEAN NOT NULL DEFAULT TRUE,
  je_count              INT NOT NULL DEFAULT 0,
  line_count            INT NOT NULL DEFAULT 0,
  document_count        INT NOT NULL DEFAULT 0,
  total_debits          NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_credits         NUMERIC(18,2) NOT NULL DEFAULT 0,
  pdf_storage_bucket    TEXT,
  pdf_storage_path      TEXT,
  pdf_sha256            TEXT,                                -- integrity seal
  error                 TEXT,
  requested_by          TEXT,                                -- users.id TEXT
  requested_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  built_at              TIMESTAMPTZ,
  expires_at            TIMESTAMPTZ,                         -- null = never expires
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_exports_company
  ON audit_trail_exports(company_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_exports_status
  ON audit_trail_exports(status) WHERE status IN ('queued', 'building');

-- Portal sessions — one per invited auditor. Stores a bcrypt-hashed access
-- token; the bare token is returned exactly once when the session is created.
CREATE TABLE IF NOT EXISTS audit_portal_sessions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  export_id             UUID NOT NULL REFERENCES audit_trail_exports(id) ON DELETE CASCADE,
  auditor_email         TEXT NOT NULL,
  token_hash            TEXT NOT NULL,                       -- bcrypt of the access token
  issued_by             TEXT,
  issued_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at            TIMESTAMPTZ NOT NULL,                -- hard cutoff
  revoked_at            TIMESTAMPTZ,
  last_used_at          TIMESTAMPTZ,
  use_count             INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_audit_sessions_export
  ON audit_portal_sessions(export_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_audit_sessions_active
  ON audit_portal_sessions(expires_at) WHERE revoked_at IS NULL;
