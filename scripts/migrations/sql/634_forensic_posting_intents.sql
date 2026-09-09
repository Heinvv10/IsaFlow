-- Immutable prospective facts; execution receipts remain in control_operation_effects.
CREATE UNIQUE INDEX IF NOT EXISTS idx_control_gl_accounts_company_id ON gl_accounts(company_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_control_assets_company_id ON assets(company_id,id);
CREATE TABLE IF NOT EXISTS control_bank_transfer_intents (
 company_id uuid NOT NULL REFERENCES companies(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 requester_person_id text NOT NULL REFERENCES users(id),
 from_gl_account_id uuid NOT NULL, to_gl_account_id uuid NOT NULL,
 amount numeric(28,8) NOT NULL CHECK(amount>0 AND amount<100000000000000000000),
 accounting_date date NOT NULL, reference text NOT NULL DEFAULT '' CHECK(length(reference)<=500),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(company_id,id),
 CHECK(from_gl_account_id<>to_gl_account_id),
 FOREIGN KEY(company_id,from_gl_account_id) REFERENCES gl_accounts(company_id,id),
 FOREIGN KEY(company_id,to_gl_account_id) REFERENCES gl_accounts(company_id,id)
);
CREATE TABLE IF NOT EXISTS control_asset_depreciation_intents (
 company_id uuid NOT NULL REFERENCES companies(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 requester_person_id text NOT NULL REFERENCES users(id), asset_id uuid NOT NULL,
 period_date date NOT NULL,
 period_key text GENERATED ALWAYS AS
  (EXTRACT(YEAR FROM period_date)::integer::text || lpad(EXTRACT(MONTH FROM period_date)::integer::text,2,'0')) STORED,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(company_id,id),
 UNIQUE(company_id,asset_id,period_key),
 FOREIGN KEY(company_id,asset_id) REFERENCES assets(company_id,id)
);
ALTER TABLE control_bank_transfer_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_bank_transfer_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_bank_transfer_intents;
CREATE POLICY tenant_read ON control_bank_transfer_intents FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_bank_transfer_intents;
CREATE POLICY tenant_create ON control_bank_transfer_intents FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies())
 AND requester_person_id=auth.uid()::text);
REVOKE ALL ON control_bank_transfer_intents FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_bank_transfer_intents TO app_user;
ALTER TABLE control_asset_depreciation_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_asset_depreciation_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_asset_depreciation_intents;
CREATE POLICY tenant_read ON control_asset_depreciation_intents FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_asset_depreciation_intents;
CREATE POLICY tenant_create ON control_asset_depreciation_intents FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies())
 AND requester_person_id=auth.uid()::text);
REVOKE ALL ON control_asset_depreciation_intents FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_asset_depreciation_intents TO app_user;
