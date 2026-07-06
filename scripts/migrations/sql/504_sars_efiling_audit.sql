-- 504: SARS eFiling submission audit log + eFiling channel columns.
-- Phase 4 — SARS ISV VAT201 e-filing. Every ISV API interaction (submit,
-- status poll, status change, transport error) writes an immutable audit row.
-- NO secrets, activation keys, or credentials are ever stored here — only
-- non-sensitive request/response metadata for the compliance audit trail.

-- eFiling channel state on the submission itself.
ALTER TABLE sars_submissions ADD COLUMN IF NOT EXISTS efiling_channel TEXT;          -- 'manual' | 'isv'
ALTER TABLE sars_submissions ADD COLUMN IF NOT EXISTS efiling_correlation_id TEXT;   -- SARS-side handle used to poll status
ALTER TABLE sars_submissions ADD COLUMN IF NOT EXISTS efiling_last_status TEXT;      -- last SARS-reported status

-- Append-only audit log of ISV transport events. company_id scoped (multi-tenant).
CREATE TABLE IF NOT EXISTS sars_efiling_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  submission_id UUID NOT NULL REFERENCES sars_submissions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,            -- 'submit' | 'poll' | 'status_change' | 'error'
  efiling_status TEXT,                 -- SARS-reported status at this event, if any
  http_status INTEGER,                 -- transport HTTP status, if any
  correlation_id TEXT,                 -- SARS correlation id, if any
  detail JSONB NOT NULL DEFAULT '{}',  -- non-sensitive request/response metadata (NEVER secrets)
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID
);

CREATE INDEX IF NOT EXISTS idx_sars_efiling_events_submission ON sars_efiling_events(submission_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sars_efiling_events_company ON sars_efiling_events(company_id, created_at);
