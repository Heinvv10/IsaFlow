-- Migration 267: Audit Trail
-- Creates the audit_log table for comprehensive field-level change history

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id VARCHAR(255) NOT NULL REFERENCES users(id),
  user_email VARCHAR(255),
  action VARCHAR(20) NOT NULL CHECK (action IN (
    'create', 'update', 'delete', 'post', 'reverse', 'approve', 'reject', 'login', 'export'
  )),
  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID NOT NULL,
  entity_ref VARCHAR(100),
  changes JSONB,
  ip_address VARCHAR(45),
  user_agent TEXT,
  session_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_audit_log_company ON audit_log(company_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_date ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_company_date ON audit_log(company_id, created_at DESC);

-- GIN index for JSONB changes queries
CREATE INDEX IF NOT EXISTS idx_audit_log_changes ON audit_log USING GIN (changes);
