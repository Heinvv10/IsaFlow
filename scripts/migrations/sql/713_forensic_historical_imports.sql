-- Exact historical import groups; no reusable period exemption or caller-role claims.
CREATE TABLE IF NOT EXISTS control_historical_import_sources (
 company_id uuid NOT NULL REFERENCES companies(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 requester_person_id text NOT NULL REFERENCES users(id),
 payload_envelope jsonb NOT NULL CHECK(jsonb_typeof(payload_envelope)='object'),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 normalized_hash text NOT NULL CHECK(normalized_hash ~ '^[a-f0-9]{64}$'),
 mime_type text NOT NULL CHECK(mime_type IN('application/json','text/csv','application/pdf','application/xml','text/xml')),
 byte_length integer NOT NULL CHECK(byte_length BETWEEN 1 AND 5242880),
 record_count integer NOT NULL CHECK(record_count BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(company_id,id)
);
CREATE TABLE IF NOT EXISTS control_historical_imports (
 company_id uuid NOT NULL REFERENCES companies(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 requester_person_id text NOT NULL REFERENCES users(id), source_id uuid NOT NULL,
 requester_auth_method text NOT NULL CHECK(requester_auth_method IN('cookie','pat','oauth')),
 requester_grant_id uuid, requester_granted_scopes text[],
 source_system text NOT NULL CHECK(source_system IN('sage','xero','quickbooks','pastel','csv')),
 source_key text NOT NULL CHECK(length(btrim(source_key)) BETWEEN 1 AND 500),
 kind text NOT NULL CHECK(kind IN('gl','opening_balance','customer_invoice','supplier_invoice')),
 mode text NOT NULL CHECK(mode IN('post_journal','attach_subledger')),
 accounting_date date NOT NULL, currency text NOT NULL CHECK(currency='ZAR'),
 amount numeric(28,8) NOT NULL CHECK(amount>=0 AND amount<100000000000000000000 AND amount*100=trunc(amount*100)),
 payload_envelope jsonb NOT NULL CHECK(jsonb_typeof(payload_envelope)='object'),
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(company_id,id),
 UNIQUE(company_id,source_system,source_key,kind),
 FOREIGN KEY(company_id,source_id) REFERENCES control_historical_import_sources(company_id,id),
 CHECK(mode='post_journal' OR kind IN('customer_invoice','supplier_invoice')),
 CHECK((requester_auth_method='cookie' AND requester_grant_id IS NULL AND requester_granted_scopes IS NULL)
  OR(requester_auth_method IN('pat','oauth') AND requester_grant_id IS NOT NULL AND requester_granted_scopes IS NOT NULL))
);
ALTER TABLE control_historical_import_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_historical_import_sources FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_historical_import_sources;
CREATE POLICY tenant_read ON control_historical_import_sources FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_historical_import_sources;
CREATE POLICY tenant_create ON control_historical_import_sources FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies())
 AND requester_person_id=auth.uid()::text);
REVOKE ALL ON control_historical_import_sources FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_historical_import_sources TO app_user;
ALTER TABLE control_historical_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_historical_imports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_historical_imports;
CREATE POLICY tenant_read ON control_historical_imports FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_historical_imports;
CREATE POLICY tenant_create ON control_historical_imports FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies())
 AND requester_person_id=auth.uid()::text);
REVOKE ALL ON control_historical_imports FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_historical_imports TO app_user;
CREATE TABLE IF NOT EXISTS control_mandatory_import_policies(
 company_id uuid PRIMARY KEY REFERENCES companies(id),id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 version bigint NOT NULL DEFAULT 1 CHECK(version=1),
 approver_role text NOT NULL DEFAULT 'admin' CHECK(approver_role='admin'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO control_mandatory_import_policies(company_id) SELECT id FROM companies
 ON CONFLICT(company_id) DO NOTHING;
ALTER TABLE control_mandatory_import_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_mandatory_import_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_mandatory_import_policies;
CREATE POLICY tenant_read ON control_mandatory_import_policies FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
REVOKE ALL ON control_mandatory_import_policies FROM PUBLIC,app_user;
GRANT SELECT ON control_mandatory_import_policies TO app_user;
CREATE OR REPLACE FUNCTION control_seed_import_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 INSERT INTO public.control_mandatory_import_policies(company_id) VALUES(NEW.id) ON CONFLICT(company_id) DO NOTHING;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION control_seed_import_policy() FROM PUBLIC,app_user;
DROP TRIGGER IF EXISTS control_seed_import_policy ON companies;
CREATE TRIGGER control_seed_import_policy AFTER INSERT ON companies
 FOR EACH ROW EXECUTE FUNCTION control_seed_import_policy();

INSERT INTO permission_modules(module_key,module_name,description,display_order)
VALUES('imports','Historical imports','Evidence-backed independently approved historical accounting imports',210)
ON CONFLICT(module_key) DO NOTHING;
