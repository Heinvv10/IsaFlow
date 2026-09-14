-- Immutable allocation plans. Approval/execution binds current sources separately.
CREATE UNIQUE INDEX IF NOT EXISTS control_bank_transactions_company_id ON bank_transactions(company_id,id);
CREATE TABLE IF NOT EXISTS control_bank_allocation_intents (
 company_id uuid NOT NULL REFERENCES companies(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 requester_person_id text NOT NULL REFERENCES users(id),
 bank_transaction_id uuid NOT NULL, accounting_date date NOT NULL,
 amount numeric(28,8) NOT NULL CHECK(amount>0 AND amount<100000000000000000000 AND amount*100=trunc(amount*100)),
 currency text NOT NULL CHECK(currency='ZAR'),
 payload jsonb NOT NULL CHECK(COALESCE(jsonb_typeof(payload)='object' AND payload->>'version'='1'
  AND payload->>'kind' IN('account','split','customer','supplier'),false)),
 source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(company_id,id),
 UNIQUE(company_id,id,bank_transaction_id),
 FOREIGN KEY(company_id,bank_transaction_id) REFERENCES bank_transactions(company_id,id)
);
CREATE TABLE IF NOT EXISTS control_bank_allocation_reversal_intents (
 company_id uuid NOT NULL REFERENCES companies(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 requester_person_id text NOT NULL REFERENCES users(id),
 original_intent_id uuid NOT NULL, bank_transaction_id uuid NOT NULL,
 reversal_date date NOT NULL, reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(company_id,id),
 FOREIGN KEY(company_id,original_intent_id,bank_transaction_id)
  REFERENCES control_bank_allocation_intents(company_id,id,bank_transaction_id)
);
ALTER TABLE control_bank_allocation_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_bank_allocation_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_bank_allocation_intents;
CREATE POLICY tenant_read ON control_bank_allocation_intents FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_bank_allocation_intents;
CREATE POLICY tenant_create ON control_bank_allocation_intents FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies())
 AND requester_person_id=auth.uid()::text);
REVOKE ALL ON control_bank_allocation_intents FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_bank_allocation_intents TO app_user;
ALTER TABLE control_bank_allocation_reversal_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_bank_allocation_reversal_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_bank_allocation_reversal_intents;
CREATE POLICY tenant_read ON control_bank_allocation_reversal_intents FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_bank_allocation_reversal_intents;
CREATE POLICY tenant_create ON control_bank_allocation_reversal_intents FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies())
 AND requester_person_id=auth.uid()::text);
REVOKE ALL ON control_bank_allocation_reversal_intents FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_bank_allocation_reversal_intents TO app_user;
