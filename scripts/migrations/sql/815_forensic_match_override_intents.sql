-- Match overrides annotate independently approved risk acceptance; numeric comparisons remain unchanged.
CREATE UNIQUE INDEX IF NOT EXISTS control_supplier_invoices_company_id ON supplier_invoices(company_id,id);
CREATE TABLE IF NOT EXISTS control_invoice_match_override_intents (
 company_id uuid NOT NULL REFERENCES companies(id),id uuid NOT NULL DEFAULT gen_random_uuid(),
 requester_person_id text NOT NULL REFERENCES users(id),invoice_id uuid NOT NULL,
 expected_match_fingerprint text NOT NULL CHECK(expected_match_fingerprint ~ '^[a-f0-9]{64}$'),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 evidence_refs jsonb NOT NULL CHECK(jsonb_typeof(evidence_refs)='array' AND jsonb_array_length(evidence_refs) BETWEEN 1 AND 20),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,id),
 FOREIGN KEY(company_id,invoice_id) REFERENCES supplier_invoices(company_id,id)
);
CREATE INDEX IF NOT EXISTS control_match_override_invoice ON control_invoice_match_override_intents(company_id,invoice_id,created_at,id);
ALTER TABLE control_invoice_match_override_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_invoice_match_override_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_invoice_match_override_intents;
CREATE POLICY tenant_read ON control_invoice_match_override_intents FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_invoice_match_override_intents;
CREATE POLICY tenant_create ON control_invoice_match_override_intents FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND requester_person_id=auth.uid()::text);
REVOKE ALL ON control_invoice_match_override_intents FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_invoice_match_override_intents TO app_user;
CREATE TABLE IF NOT EXISTS control_mandatory_match_override_policies(
 company_id uuid PRIMARY KEY REFERENCES companies(id),id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 version bigint NOT NULL DEFAULT 1 CHECK(version=1),
 approver_role text NOT NULL DEFAULT 'admin' CHECK(approver_role='admin'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO control_mandatory_match_override_policies(company_id) SELECT id FROM companies
 ON CONFLICT(company_id) DO NOTHING;
ALTER TABLE control_mandatory_match_override_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_mandatory_match_override_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_mandatory_match_override_policies;
CREATE POLICY tenant_read ON control_mandatory_match_override_policies FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
REVOKE ALL ON control_mandatory_match_override_policies FROM PUBLIC,app_user;
GRANT SELECT ON control_mandatory_match_override_policies TO app_user;
CREATE OR REPLACE FUNCTION control_seed_match_override_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 INSERT INTO public.control_mandatory_match_override_policies(company_id) VALUES(NEW.id) ON CONFLICT(company_id) DO NOTHING;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION control_seed_match_override_policy() FROM PUBLIC,app_user;
DROP TRIGGER IF EXISTS control_seed_match_override_policy ON companies;
CREATE TRIGGER control_seed_match_override_policy AFTER INSERT ON companies
 FOR EACH ROW EXECUTE FUNCTION control_seed_match_override_policy();
