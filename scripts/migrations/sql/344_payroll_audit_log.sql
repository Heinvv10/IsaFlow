-- 344_payroll_audit_log.sql
-- Audit trail for all payroll mutations (employee, pay_structure, payroll_run).
-- SARS + internal governance requirement — must be tamper-evident and chronological.

CREATE TABLE IF NOT EXISTS payroll_audit_log (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entity_type  TEXT        NOT NULL CHECK (entity_type IN ('employee','pay_structure','payroll_run')),
  entity_id    UUID        NOT NULL,
  action       TEXT        NOT NULL CHECK (action IN ('create','update','delete','complete','reverse')),
  changed_by   TEXT        REFERENCES users(id),
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  old_values   JSONB,
  new_values   JSONB,
  notes        TEXT
);

CREATE INDEX IF NOT EXISTS idx_payroll_audit_company
  ON payroll_audit_log(company_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_payroll_audit_entity
  ON payroll_audit_log(entity_type, entity_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_payroll_audit_user
  ON payroll_audit_log(changed_by, changed_at DESC);
