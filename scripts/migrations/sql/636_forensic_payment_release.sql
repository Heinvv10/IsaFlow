-- Durable release preparation, one-payment reservations and monotonic dispatch evidence.
CREATE UNIQUE INDEX IF NOT EXISTS control_supplier_payments_company_id ON supplier_payments(company_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS control_supplier_batches_company_id ON supplier_payment_batches(company_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS control_suppliers_company_id ON suppliers(company_id,id);
CREATE TABLE IF NOT EXISTS control_payment_preparations(
 company_id uuid NOT NULL REFERENCES companies(id),id uuid NOT NULL DEFAULT gen_random_uuid(),
 payment_id uuid NOT NULL,supplier_id uuid NOT NULL,beneficiary_version_id uuid NOT NULL,
 beneficiary_version bigint NOT NULL CHECK(beneficiary_version>0),beneficiary_fingerprint text NOT NULL CHECK(beneficiary_fingerprint ~ '^[a-f0-9]{64}$'),payment_fingerprint text NOT NULL CHECK(payment_fingerprint ~ '^[a-f0-9]{64}$'),
 amount numeric(28,8) NOT NULL CHECK(amount>0 AND amount<100000000000000000000 AND amount*100=trunc(amount*100)),currency text NOT NULL CHECK(currency='ZAR'),
 prepared_by_person_id text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,id),UNIQUE(company_id,id,payment_id),UNIQUE(company_id,payment_id,payment_fingerprint,beneficiary_version_id),
 FOREIGN KEY(company_id,payment_id) REFERENCES supplier_payments(company_id,id),
 FOREIGN KEY(company_id,supplier_id) REFERENCES suppliers(company_id,id),
 FOREIGN KEY(company_id,beneficiary_version_id) REFERENCES control_beneficiary_versions(company_id,id)
);
CREATE TABLE IF NOT EXISTS control_payment_release_intents(
 company_id uuid NOT NULL REFERENCES companies(id),id uuid NOT NULL DEFAULT gen_random_uuid(),batch_id uuid NOT NULL,
 channel text NOT NULL CHECK(channel IN('netcash','eft')),bank_format text,
 requester_person_id text NOT NULL REFERENCES users(id),requester_auth_method text NOT NULL CHECK(requester_auth_method IN('cookie','pat','oauth')),
 requester_grant_id uuid,requester_granted_scopes text[],payload_envelope jsonb NOT NULL CHECK(jsonb_typeof(payload_envelope)='object'),payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 amount numeric(28,8) NOT NULL CHECK(amount>0 AND amount<100000000000000000000 AND amount*100=trunc(amount*100)),currency text NOT NULL CHECK(currency='ZAR'),accounting_date date NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,id),
 FOREIGN KEY(company_id,batch_id) REFERENCES supplier_payment_batches(company_id,id),
 CHECK((channel='netcash' AND bank_format IS NULL) OR(channel='eft' AND bank_format IN('standard_bank','fnb','absa','nedbank','capitec'))),
 CHECK((requester_auth_method='cookie' AND requester_grant_id IS NULL AND requester_granted_scopes IS NULL) OR(requester_auth_method IN('pat','oauth') AND requester_grant_id IS NOT NULL AND requester_granted_scopes IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS control_payment_release_items(
 company_id uuid NOT NULL,intent_id uuid NOT NULL,payment_id uuid NOT NULL,preparation_id uuid NOT NULL,
 PRIMARY KEY(company_id,intent_id,payment_id),
 FOREIGN KEY(company_id,intent_id) REFERENCES control_payment_release_intents(company_id,id),
 FOREIGN KEY(company_id,payment_id) REFERENCES supplier_payments(company_id,id),
 FOREIGN KEY(company_id,preparation_id,payment_id) REFERENCES control_payment_preparations(company_id,id,payment_id)
);
CREATE TABLE IF NOT EXISTS control_payment_release_outbox(
 company_id uuid NOT NULL,intent_id uuid NOT NULL,approval_id uuid NOT NULL,provider_reference text NOT NULL CHECK(length(provider_reference) BETWEEN 1 AND 128),
 state text NOT NULL DEFAULT 'ready' CHECK(state IN('ready','attempting','accepted','unknown','failed','exported')),
 attempt_id uuid,attempted_at timestamptz,finished_at timestamptz,provider_batch_reference text CHECK(length(provider_batch_reference)<=128),outcome_code text CHECK(outcome_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,intent_id),UNIQUE(company_id,provider_reference),
 FOREIGN KEY(company_id,intent_id) REFERENCES control_payment_release_intents(company_id,id),
 FOREIGN KEY(company_id,approval_id) REFERENCES control_operation_approvals(company_id,id)
);
CREATE TABLE IF NOT EXISTS control_payment_release_reservations(
 company_id uuid NOT NULL,payment_id uuid NOT NULL,intent_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,payment_id),
 FOREIGN KEY(company_id,payment_id) REFERENCES supplier_payments(company_id,id),
 FOREIGN KEY(company_id,intent_id,payment_id) REFERENCES control_payment_release_items(company_id,intent_id,payment_id)
);
ALTER TABLE control_payment_preparations ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_payment_preparations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_payment_preparations;
CREATE POLICY tenant_read ON control_payment_preparations FOR SELECT USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_payment_preparations;
CREATE POLICY tenant_create ON control_payment_preparations FOR INSERT WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND prepared_by_person_id=auth.uid()::text);
REVOKE ALL ON control_payment_preparations FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_payment_preparations TO app_user;
ALTER TABLE control_payment_release_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_payment_release_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_payment_release_intents;
CREATE POLICY tenant_read ON control_payment_release_intents FOR SELECT USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_payment_release_intents;
CREATE POLICY tenant_create ON control_payment_release_intents FOR INSERT WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND requester_person_id=auth.uid()::text);
REVOKE ALL ON control_payment_release_intents FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_payment_release_intents TO app_user;
ALTER TABLE control_payment_release_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_payment_release_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_payment_release_items;
CREATE POLICY tenant_read ON control_payment_release_items FOR SELECT USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_payment_release_items;
CREATE POLICY tenant_create ON control_payment_release_items FOR INSERT WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND EXISTS(SELECT 1 FROM control_payment_release_intents i WHERE i.company_id=control_payment_release_items.company_id AND i.id=control_payment_release_items.intent_id AND i.requester_person_id=auth.uid()::text));
REVOKE ALL ON control_payment_release_items FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_payment_release_items TO app_user;
ALTER TABLE control_payment_release_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_payment_release_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_payment_release_outbox;
CREATE POLICY tenant_read ON control_payment_release_outbox FOR SELECT USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_payment_release_outbox;
CREATE POLICY tenant_create ON control_payment_release_outbox FOR INSERT WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND EXISTS(SELECT 1 FROM control_payment_release_intents i WHERE i.company_id=control_payment_release_outbox.company_id AND i.id=control_payment_release_outbox.intent_id AND i.requester_person_id=auth.uid()::text));
REVOKE ALL ON control_payment_release_outbox FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_payment_release_outbox TO app_user;
DROP POLICY IF EXISTS tenant_dispatch ON control_payment_release_outbox;
CREATE POLICY tenant_dispatch ON control_payment_release_outbox FOR UPDATE USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND EXISTS(SELECT 1 FROM control_payment_release_intents i WHERE i.company_id=control_payment_release_outbox.company_id AND i.id=control_payment_release_outbox.intent_id AND i.requester_person_id=auth.uid()::text)) WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND EXISTS(SELECT 1 FROM control_payment_release_intents i WHERE i.company_id=control_payment_release_outbox.company_id AND i.id=control_payment_release_outbox.intent_id AND i.requester_person_id=auth.uid()::text));
GRANT UPDATE(state,attempt_id,attempted_at,finished_at,provider_batch_reference,outcome_code) ON control_payment_release_outbox TO app_user;
ALTER TABLE control_payment_release_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_payment_release_reservations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_payment_release_reservations;
CREATE POLICY tenant_read ON control_payment_release_reservations FOR SELECT USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_payment_release_reservations;
CREATE POLICY tenant_create ON control_payment_release_reservations FOR INSERT WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND EXISTS(SELECT 1 FROM control_payment_release_intents i WHERE i.company_id=control_payment_release_reservations.company_id AND i.id=control_payment_release_reservations.intent_id AND i.requester_person_id=auth.uid()::text));
REVOKE ALL ON control_payment_release_reservations FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_payment_release_reservations TO app_user;
-- A direct update cannot turn an uncertain or completed attempt into a fresh release.
CREATE OR REPLACE FUNCTION control_release_state_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'ready' OR NEW.attempt_id IS NOT NULL OR NEW.attempted_at IS NOT NULL OR NEW.finished_at IS NOT NULL
   OR NEW.provider_batch_reference IS NOT NULL OR NEW.outcome_code IS NOT NULL THEN
   RAISE EXCEPTION 'Release must start ready' USING ERRCODE='23514';
  END IF;
 ELSE
  IF NOT ((OLD.state='ready' AND NEW.state='attempting')
   OR (OLD.state='attempting' AND NEW.state IN('accepted','unknown','failed','exported'))) THEN
   RAISE EXCEPTION 'Release transition refused' USING ERRCODE='23514';
  END IF;
  IF NEW.attempt_id IS NULL OR NEW.attempted_at IS NULL
   OR (OLD.state='attempting' AND (NEW.attempt_id IS DISTINCT FROM OLD.attempt_id OR NEW.attempted_at IS DISTINCT FROM OLD.attempted_at))
   OR (NEW.state='attempting' AND NEW.finished_at IS NOT NULL)
   OR (NEW.state<>'attempting' AND NEW.finished_at IS NULL) THEN
   RAISE EXCEPTION 'Release attempt evidence missing or changed' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS control_release_state_transition ON control_payment_release_outbox;
CREATE TRIGGER control_release_state_transition BEFORE INSERT OR UPDATE ON control_payment_release_outbox
 FOR EACH ROW EXECUTE FUNCTION control_release_state_transition();
INSERT INTO permission_modules(module_key,module_name,description,display_order)
VALUES('release','Payment release','Authorize and dispatch independently approved payment releases',209)
ON CONFLICT(module_key) DO NOTHING;

-- A real immutable policy identity exists even when the tenant configured no optional rules.
CREATE TABLE IF NOT EXISTS control_mandatory_release_policies(
 company_id uuid PRIMARY KEY REFERENCES companies(id),id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 version bigint NOT NULL DEFAULT 1 CHECK(version=1),
 approver_role text NOT NULL DEFAULT 'admin' CHECK(approver_role='admin'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO control_mandatory_release_policies(company_id) SELECT id FROM companies
 ON CONFLICT(company_id) DO NOTHING;
ALTER TABLE control_mandatory_release_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_mandatory_release_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_mandatory_release_policies;
CREATE POLICY tenant_read ON control_mandatory_release_policies FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
REVOKE ALL ON control_mandatory_release_policies FROM PUBLIC,app_user;
GRANT SELECT ON control_mandatory_release_policies TO app_user;
CREATE OR REPLACE FUNCTION control_seed_release_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 INSERT INTO public.control_mandatory_release_policies(company_id) VALUES(NEW.id) ON CONFLICT(company_id) DO NOTHING;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION control_seed_release_policy() FROM PUBLIC,app_user;
DROP TRIGGER IF EXISTS control_seed_release_policy ON companies;
CREATE TRIGGER control_seed_release_policy AFTER INSERT ON companies
 FOR EACH ROW EXECUTE FUNCTION control_seed_release_policy();
