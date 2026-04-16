-- 345_compliance_alerts.sql
-- Stores AFS-specific compliance alerts (PIS threshold crossings, filing deadlines).
-- Existing statutory document alerts come from statutoryDocService — these are separate.

CREATE TABLE IF NOT EXISTS compliance_alerts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  alert_type    TEXT NOT NULL,
  message       TEXT NOT NULL,
  detail        TEXT,
  fired_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  dismissed_at  TIMESTAMPTZ,
  dismissed_by  UUID REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_compliance_alerts_company_id
  ON compliance_alerts (company_id);

CREATE INDEX IF NOT EXISTS idx_compliance_alerts_undismissed
  ON compliance_alerts (company_id, dismissed_at)
  WHERE dismissed_at IS NULL;

-- Prevent duplicate un-dismissed alerts of the same type per company
CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_alerts_active
  ON compliance_alerts (company_id, alert_type)
  WHERE dismissed_at IS NULL;
