-- Independent human review of local statement bytes; no external bank authenticity claim.
CREATE UNIQUE INDEX IF NOT EXISTS control_gl_accounts_company_id ON gl_accounts(company_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS control_captured_documents_company_id ON captured_documents(company_id,id);
CREATE TABLE IF NOT EXISTS control_bank_statement_attestation_intents (
 company_id uuid NOT NULL REFERENCES companies(id),id uuid NOT NULL DEFAULT gen_random_uuid(),
 requester_person_id text NOT NULL REFERENCES users(id),bank_account_id uuid NOT NULL,source_document_id uuid NOT NULL,
 expected_source_hash text NOT NULL CHECK(expected_source_hash ~ '^[a-f0-9]{64}$'),
 source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 period_start date NOT NULL,period_end date NOT NULL CHECK(period_end>=period_start),
 source_count integer NOT NULL CHECK(source_count>=0),
 opening_balance numeric(18,2) NOT NULL CHECK(opening_balance>'-Infinity'::numeric AND opening_balance<'Infinity'::numeric),
 closing_balance numeric(18,2) NOT NULL CHECK(closing_balance>'-Infinity'::numeric AND closing_balance<'Infinity'::numeric),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,id),
 FOREIGN KEY(company_id,bank_account_id) REFERENCES gl_accounts(company_id,id),
 FOREIGN KEY(company_id,source_document_id) REFERENCES captured_documents(company_id,id)
);
CREATE INDEX IF NOT EXISTS control_statement_attestation_source ON control_bank_statement_attestation_intents(company_id,bank_account_id,source_document_id,created_at,id);
ALTER TABLE control_bank_statement_attestation_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_bank_statement_attestation_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_bank_statement_attestation_intents;
CREATE POLICY tenant_read ON control_bank_statement_attestation_intents FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_bank_statement_attestation_intents;
CREATE POLICY tenant_create ON control_bank_statement_attestation_intents FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND requester_person_id=auth.uid()::text);
REVOKE ALL ON control_bank_statement_attestation_intents FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_bank_statement_attestation_intents TO app_user;
CREATE TABLE IF NOT EXISTS control_mandatory_statement_policies(
 company_id uuid PRIMARY KEY REFERENCES companies(id),id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 version bigint NOT NULL DEFAULT 1 CHECK(version=1),
 approver_role text NOT NULL DEFAULT 'admin' CHECK(approver_role='admin'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO control_mandatory_statement_policies(company_id) SELECT id FROM companies
 ON CONFLICT(company_id) DO NOTHING;
ALTER TABLE control_mandatory_statement_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_mandatory_statement_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_mandatory_statement_policies;
CREATE POLICY tenant_read ON control_mandatory_statement_policies FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
REVOKE ALL ON control_mandatory_statement_policies FROM PUBLIC,app_user;
GRANT SELECT ON control_mandatory_statement_policies TO app_user;
CREATE OR REPLACE FUNCTION control_seed_statement_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 INSERT INTO public.control_mandatory_statement_policies(company_id) VALUES(NEW.id) ON CONFLICT(company_id) DO NOTHING;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION control_seed_statement_policy() FROM PUBLIC,app_user;
DROP TRIGGER IF EXISTS control_seed_statement_policy ON companies;
CREATE TRIGGER control_seed_statement_policy AFTER INSERT ON companies
 FOR EACH ROW EXECUTE FUNCTION control_seed_statement_policy();
