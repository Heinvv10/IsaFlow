-- Migration 308: Background Job Queue
-- Persistent queue for async processing: emails, PDFs, webhooks, bank feeds

CREATE TABLE IF NOT EXISTS background_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id), -- NULL for system jobs
  job_type VARCHAR(100) NOT NULL,           -- 'send_email', 'generate_pdf', 'send_webhook', 'process_bank_feed'
  payload JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, running, completed, failed
  priority INT NOT NULL DEFAULT 5,               -- 1=highest, 10=lowest
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  scheduled_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  result JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS background_jobs_pending_idx
  ON background_jobs(status, scheduled_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS background_jobs_company_created_idx
  ON background_jobs(company_id, created_at DESC);
