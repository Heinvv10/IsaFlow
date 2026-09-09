-- Compensation changes retain immutable approved source plans; all execution stays in shared services.
CREATE TABLE IF NOT EXISTS control_payroll_compensation_intents (
 company_id uuid NOT NULL REFERENCES companies(id),id uuid NOT NULL DEFAULT gen_random_uuid(),
 requester_person_id text NOT NULL REFERENCES users(id),effective_date date NOT NULL,
 amount numeric(28,8) NOT NULL CHECK(amount>=0 AND amount<100000000000000000000),
 currency text NOT NULL CHECK(currency='ZAR'),
 payload jsonb NOT NULL CHECK(COALESCE(jsonb_typeof(payload)='object'
  AND payload->>'version'='1' AND jsonb_typeof(payload->'source')='object'
  AND payload->'source'->>'kind' IN('manual','package','batch')
  AND jsonb_typeof(payload->'actions')='array'
  AND jsonb_array_length(payload->'actions') BETWEEN 1 AND 1000,false)),
 source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,id)
);
CREATE INDEX IF NOT EXISTS control_compensation_requester ON control_payroll_compensation_intents(company_id,requester_person_id,created_at,id);
ALTER TABLE control_payroll_compensation_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_payroll_compensation_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_payroll_compensation_intents;
CREATE POLICY tenant_read ON control_payroll_compensation_intents FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_payroll_compensation_intents;
CREATE POLICY tenant_create ON control_payroll_compensation_intents FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND requester_person_id=auth.uid()::text);
REVOKE ALL ON control_payroll_compensation_intents FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_payroll_compensation_intents TO app_user;
CREATE TABLE IF NOT EXISTS control_mandatory_compensation_policies (
 company_id uuid PRIMARY KEY REFERENCES companies(id),id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 version bigint NOT NULL DEFAULT 1 CHECK(version=1),
 approver_role text NOT NULL DEFAULT 'admin' CHECK(approver_role='admin'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO control_mandatory_compensation_policies(company_id) SELECT id FROM companies
 ON CONFLICT(company_id) DO NOTHING;
ALTER TABLE control_mandatory_compensation_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_mandatory_compensation_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_mandatory_compensation_policies;
CREATE POLICY tenant_read ON control_mandatory_compensation_policies FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
REVOKE ALL ON control_mandatory_compensation_policies FROM PUBLIC,app_user;
GRANT SELECT ON control_mandatory_compensation_policies TO app_user;
CREATE OR REPLACE FUNCTION control_seed_compensation_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 INSERT INTO public.control_mandatory_compensation_policies(company_id) VALUES(NEW.id) ON CONFLICT(company_id) DO NOTHING;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION control_seed_compensation_policy() FROM PUBLIC,app_user;
DROP TRIGGER IF EXISTS control_seed_compensation_policy ON companies;
CREATE TRIGGER control_seed_compensation_policy AFTER INSERT ON companies
 FOR EACH ROW EXECUTE FUNCTION control_seed_compensation_policy();
