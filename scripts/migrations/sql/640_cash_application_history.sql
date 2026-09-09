-- Immutable application plans and retained positive allocation history.
CREATE UNIQUE INDEX IF NOT EXISTS control_customer_payments_company_id ON customer_payments(company_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS control_supplier_payments_company_id ON supplier_payments(company_id,id);
CREATE TABLE IF NOT EXISTS control_cash_application_intents (
 company_id uuid NOT NULL REFERENCES companies(id),id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 requester_person_id text NOT NULL REFERENCES users(id),payment_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN('customer','supplier')),accounting_date date NOT NULL,
 amount numeric(28,8) NOT NULL CHECK(amount>0 AND amount<100000000000000000000 AND amount*100=trunc(amount*100)),
 currency text NOT NULL CHECK(currency='ZAR'),
 payload jsonb NOT NULL CHECK(COALESCE(jsonb_typeof(payload)='object' AND payload->>'version'='1'
  AND payload->>'kind'=kind AND jsonb_typeof(payload->'applications')='array'
  AND jsonb_array_length(payload->'applications') BETWEEN 1 AND 100,false)),
 source_fingerprint text NOT NULL CHECK(source_fingerprint ~ '^[a-f0-9]{64}$'),
 customer_payment_id uuid GENERATED ALWAYS AS(CASE WHEN kind='customer' THEN payment_id END) STORED,
 supplier_payment_id uuid GENERATED ALWAYS AS(CASE WHEN kind='supplier' THEN payment_id END) STORED,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,id),
 FOREIGN KEY(company_id,customer_payment_id) REFERENCES customer_payments(company_id,id),
 FOREIGN KEY(company_id,supplier_payment_id) REFERENCES supplier_payments(company_id,id)
);
CREATE TABLE IF NOT EXISTS control_cash_application_reversal_intents (
 company_id uuid NOT NULL REFERENCES companies(id),id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 requester_person_id text NOT NULL REFERENCES users(id),original_intent_id uuid NOT NULL,
 reversal_date date NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,id),
 FOREIGN KEY(company_id,original_intent_id) REFERENCES control_cash_application_intents(company_id,id)
);
ALTER TABLE control_cash_application_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_cash_application_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_cash_application_intents;
CREATE POLICY tenant_read ON control_cash_application_intents FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_cash_application_intents;
CREATE POLICY tenant_create ON control_cash_application_intents FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND requester_person_id=auth.uid()::text);
REVOKE ALL ON control_cash_application_intents FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_cash_application_intents TO app_user;
ALTER TABLE control_cash_application_reversal_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_cash_application_reversal_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_read ON control_cash_application_reversal_intents;
CREATE POLICY tenant_read ON control_cash_application_reversal_intents FOR SELECT
 USING(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()));
DROP POLICY IF EXISTS tenant_create ON control_cash_application_reversal_intents;
CREATE POLICY tenant_create ON control_cash_application_reversal_intents FOR INSERT
 WITH CHECK(company_id=app.current_company_id() AND company_id IN(SELECT auth.user_companies()) AND requester_person_id=auth.uid()::text);
REVOKE ALL ON control_cash_application_reversal_intents FROM PUBLIC,app_user;
GRANT SELECT,INSERT ON control_cash_application_reversal_intents TO app_user;
ALTER TABLE customer_payment_allocations ADD COLUMN IF NOT EXISTS application_intent_id uuid REFERENCES control_cash_application_intents(id);
ALTER TABLE customer_payment_allocations ADD COLUMN IF NOT EXISTS reversed_at timestamptz;
ALTER TABLE customer_payment_allocations ADD COLUMN IF NOT EXISTS reversal_intent_id uuid REFERENCES control_cash_application_reversal_intents(id);
ALTER TABLE customer_payment_allocations DROP CONSTRAINT IF EXISTS customer_payment_allocations_payment_id_invoice_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS control_customer_payment_allocations_legacy ON customer_payment_allocations(payment_id,invoice_id) WHERE application_intent_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS control_customer_payment_allocations_intent ON customer_payment_allocations(payment_id,invoice_id,application_intent_id) WHERE application_intent_id IS NOT NULL;
CREATE OR REPLACE FUNCTION control_customer_payment_allocations_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE owned_company uuid;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.application_intent_id IS NOT NULL THEN RAISE EXCEPTION 'Controlled allocation history cannot be deleted'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.application_intent_id IS DISTINCT FROM NEW.application_intent_id THEN
   RAISE EXCEPTION 'Allocation intent cannot be reassigned';
  END IF;
  IF OLD.application_intent_id IS NOT NULL AND
   (to_jsonb(OLD)-'reversed_at'-'reversal_intent_id') IS DISTINCT FROM (to_jsonb(NEW)-'reversed_at'-'reversal_intent_id') THEN
   RAISE EXCEPTION 'Controlled allocation history is immutable';
  END IF;
  IF OLD.reversed_at IS NOT NULL AND
   (OLD.reversed_at IS DISTINCT FROM NEW.reversed_at OR OLD.reversal_intent_id IS DISTINCT FROM NEW.reversal_intent_id) THEN
   RAISE EXCEPTION 'Allocation reversal is immutable';
  END IF;
 END IF;
 IF (NEW.reversed_at IS NULL)<>(NEW.reversal_intent_id IS NULL) THEN
  RAISE EXCEPTION 'Allocation reversal requires paired lineage';
 END IF;
 IF NEW.application_intent_id IS NULL THEN
  IF NEW.reversed_at IS NOT NULL THEN RAISE EXCEPTION 'Legacy allocation cannot acquire controlled inverse'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='INSERT' AND NEW.reversed_at IS NOT NULL THEN RAISE EXCEPTION 'New allocation must be active'; END IF;
 SELECT p.company_id INTO owned_company FROM public.customer_payments p
 JOIN public.customer_invoices i ON i.company_id=p.company_id AND i.id=NEW.invoice_id
 JOIN public.control_cash_application_intents a ON a.company_id=p.company_id AND a.id=NEW.application_intent_id
  AND a.payment_id=p.id AND a.kind='customer'
 WHERE p.id=NEW.payment_id;
 IF owned_company IS NULL THEN RAISE EXCEPTION 'Allocation intent, payment and invoice must share ownership'; END IF;
 IF NEW.reversal_intent_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM public.control_cash_application_reversal_intents r
  WHERE r.company_id=owned_company AND r.id=NEW.reversal_intent_id AND r.original_intent_id=NEW.application_intent_id
 ) THEN RAISE EXCEPTION 'Allocation inverse must reference its original intent'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION control_customer_payment_allocations_history() FROM PUBLIC,app_user;
DROP TRIGGER IF EXISTS control_allocation_history ON customer_payment_allocations;
CREATE TRIGGER control_allocation_history BEFORE INSERT OR UPDATE OR DELETE ON customer_payment_allocations
 FOR EACH ROW EXECUTE FUNCTION control_customer_payment_allocations_history();
ALTER TABLE payment_allocations ADD COLUMN IF NOT EXISTS application_intent_id uuid REFERENCES control_cash_application_intents(id);
ALTER TABLE payment_allocations ADD COLUMN IF NOT EXISTS reversed_at timestamptz;
ALTER TABLE payment_allocations ADD COLUMN IF NOT EXISTS reversal_intent_id uuid REFERENCES control_cash_application_reversal_intents(id);
ALTER TABLE payment_allocations DROP CONSTRAINT IF EXISTS payment_allocations_payment_id_invoice_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS control_payment_allocations_legacy ON payment_allocations(payment_id,invoice_id) WHERE application_intent_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS control_payment_allocations_intent ON payment_allocations(payment_id,invoice_id,application_intent_id) WHERE application_intent_id IS NOT NULL;
CREATE OR REPLACE FUNCTION control_payment_allocations_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE owned_company uuid;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.application_intent_id IS NOT NULL THEN RAISE EXCEPTION 'Controlled allocation history cannot be deleted'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.application_intent_id IS DISTINCT FROM NEW.application_intent_id THEN
   RAISE EXCEPTION 'Allocation intent cannot be reassigned';
  END IF;
  IF OLD.application_intent_id IS NOT NULL AND
   (to_jsonb(OLD)-'reversed_at'-'reversal_intent_id') IS DISTINCT FROM (to_jsonb(NEW)-'reversed_at'-'reversal_intent_id') THEN
   RAISE EXCEPTION 'Controlled allocation history is immutable';
  END IF;
  IF OLD.reversed_at IS NOT NULL AND
   (OLD.reversed_at IS DISTINCT FROM NEW.reversed_at OR OLD.reversal_intent_id IS DISTINCT FROM NEW.reversal_intent_id) THEN
   RAISE EXCEPTION 'Allocation reversal is immutable';
  END IF;
 END IF;
 IF (NEW.reversed_at IS NULL)<>(NEW.reversal_intent_id IS NULL) THEN
  RAISE EXCEPTION 'Allocation reversal requires paired lineage';
 END IF;
 IF NEW.application_intent_id IS NULL THEN
  IF NEW.reversed_at IS NOT NULL THEN RAISE EXCEPTION 'Legacy allocation cannot acquire controlled inverse'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='INSERT' AND NEW.reversed_at IS NOT NULL THEN RAISE EXCEPTION 'New allocation must be active'; END IF;
 SELECT p.company_id INTO owned_company FROM public.supplier_payments p
 JOIN public.supplier_invoices i ON i.company_id=p.company_id AND i.id=NEW.invoice_id
 JOIN public.control_cash_application_intents a ON a.company_id=p.company_id AND a.id=NEW.application_intent_id
  AND a.payment_id=p.id AND a.kind='supplier'
 WHERE p.id=NEW.payment_id;
 IF owned_company IS NULL THEN RAISE EXCEPTION 'Allocation intent, payment and invoice must share ownership'; END IF;
 IF NEW.reversal_intent_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM public.control_cash_application_reversal_intents r
  WHERE r.company_id=owned_company AND r.id=NEW.reversal_intent_id AND r.original_intent_id=NEW.application_intent_id
 ) THEN RAISE EXCEPTION 'Allocation inverse must reference its original intent'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION control_payment_allocations_history() FROM PUBLIC,app_user;
DROP TRIGGER IF EXISTS control_allocation_history ON payment_allocations;
CREATE TRIGGER control_allocation_history BEFORE INSERT OR UPDATE OR DELETE ON payment_allocations
 FOR EACH ROW EXECUTE FUNCTION control_payment_allocations_history();
