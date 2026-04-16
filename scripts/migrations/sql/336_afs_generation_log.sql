-- 336_afs_generation_log.sql
-- Async job queue for AFS generation. Each row = one enqueued generation request.

CREATE TABLE IF NOT EXISTS afs_generation_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID NOT NULL REFERENCES afs_documents(id) ON DELETE CASCADE,
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  requested_by  TEXT REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_afs_generation_log_document_id
  ON afs_generation_log(document_id);

CREATE INDEX IF NOT EXISTS idx_afs_generation_log_status
  ON afs_generation_log(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_afs_generation_log_company_id
  ON afs_generation_log(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_afs_generation_log_company_document
  ON afs_generation_log(company_id, document_id);
