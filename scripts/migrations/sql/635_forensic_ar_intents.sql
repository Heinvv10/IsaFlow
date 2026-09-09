-- Unknown legacy currency is intentionally not inferred by migration.
ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS currency_code text
 CHECK(currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$');
ALTER TABLE credit_notes ADD COLUMN IF NOT EXISTS currency_code text
 CHECK(currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$');
ALTER TABLE recurring_invoices ADD COLUMN IF NOT EXISTS currency_code text
 CHECK(currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$');
CREATE UNIQUE INDEX IF NOT EXISTS idx_control_customer_invoices_company_id ON customer_invoices(company_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_control_credit_notes_company_id ON credit_notes(company_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_control_recurring_invoices_company_id ON recurring_invoices(company_id,id);
CREATE TABLE IF NOT EXISTS control_credit_note_applications (
 company_id uuid NOT NULL REFERENCES companies(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 credit_note_id uuid NOT NULL, customer_invoice_id uuid NOT NULL,
 requester_person_id text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(company_id,id),
 FOREIGN KEY(company_id,credit_note_id) REFERENCES credit_notes(company_id,id),
 FOREIGN KEY(company_id,customer_invoice_id) REFERENCES customer_invoices(company_id,id)
);
CREATE TABLE IF NOT EXISTS control_recurring_invoice_runs (
 company_id uuid NOT NULL REFERENCES companies(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 template_id uuid NOT NULL, scheduled_date date NOT NULL, invoice_id uuid NOT NULL,
 requester_person_id text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(company_id,id),
 UNIQUE(company_id,template_id,scheduled_date), UNIQUE(company_id,invoice_id),
 FOREIGN KEY(company_id,template_id) REFERENCES recurring_invoices(company_id,id),
 FOREIGN KEY(company_id,invoice_id) REFERENCES customer_invoices(company_id,id)
);
ALTER TABLE control_credit_note_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_credit_note_applications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_credit_note_applications;
CREATE POLICY tenant_read ON control_credit_note_applications FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_credit_note_applications;
CREATE POLICY tenant_create ON control_credit_note_applications FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies())
 AND requester_person_id=auth.uid()::text);
REVOKE ALL ON control_credit_note_applications FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_credit_note_applications TO app_user;
ALTER TABLE control_recurring_invoice_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_recurring_invoice_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_recurring_invoice_runs;
CREATE POLICY tenant_read ON control_recurring_invoice_runs FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_recurring_invoice_runs;
CREATE POLICY tenant_create ON control_recurring_invoice_runs FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies())
 AND requester_person_id=auth.uid()::text);
REVOKE ALL ON control_recurring_invoice_runs FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_recurring_invoice_runs TO app_user;
