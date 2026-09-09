-- Explicit encrypted evidence for the active payroll employee model; no guessed legacy association.
CREATE UNIQUE INDEX IF NOT EXISTS payroll_employees_company_id_id_uq ON payroll_employees(company_id,id);
CREATE TABLE IF NOT EXISTS control_employee_beneficiary_evidence (
  company_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),employee_id uuid NOT NULL,
  document_envelope jsonb NOT NULL CHECK(jsonb_typeof(document_envelope)='object'),
  content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
  byte_length integer NOT NULL CHECK(byte_length BETWEEN 1 AND 10485760),
  mime_type text NOT NULL CHECK(mime_type IN('application/pdf','image/png','image/jpeg')),
  created_by_person_id text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,employee_id) REFERENCES payroll_employees(company_id,id)
);
CREATE INDEX IF NOT EXISTS control_employee_beneficiary_evidence_employee_idx
  ON control_employee_beneficiary_evidence(company_id,employee_id,created_at DESC,id);
ALTER TABLE control_employee_beneficiary_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_employee_beneficiary_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_employee_beneficiary_evidence;
CREATE POLICY tenant_read ON control_employee_beneficiary_evidence FOR SELECT USING(
  company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_employee_beneficiary_evidence;
CREATE POLICY tenant_create ON control_employee_beneficiary_evidence FOR INSERT WITH CHECK(
  company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies())
  AND created_by_person_id=auth.uid()::text);
REVOKE ALL ON control_employee_beneficiary_evidence FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_employee_beneficiary_evidence TO app_user;
