-- 951_pay_run_approval.sql
-- Every pay run now uses R-035 approval, always on. `prepared_by` is the last
-- calculator/editor and approval_plan_hash is the durable digest bridge from
-- payroll's journal-plan hash to R-035's definer writes. Existing approved or
-- paid runs are grandfathered so payroll history, EMP201 and IRP5 stay usable;
-- existing draft/calculated runs require approval before their first post.
-- Nullable columns avoid a table rewrite. No new tenant table is introduced.
--
-- Rollback (code must be rolled back first): drop the two 951 triggers/functions,
-- delete pay_run enforcement/rules, restore the three *_pre_payroll_951 functions,
-- restore the two company foreign keys without ON DELETE CASCADE, restore the
-- approval_enforcement CHECK without pay_run, then drop the five payroll run
-- header columns. Approval/audit history is intentionally retained.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.payroll_run_headers ADD COLUMN IF NOT EXISTS prepared_by pg_catalog.uuid;
ALTER TABLE public.payroll_run_headers ADD COLUMN IF NOT EXISTS approval_plan_hash pg_catalog.text;
ALTER TABLE public.payroll_run_headers ADD COLUMN IF NOT EXISTS approved_plan_hash pg_catalog.text;
ALTER TABLE public.payroll_run_headers ADD COLUMN IF NOT EXISTS approval_grandfathered_at pg_catalog.timestamptz;
ALTER TABLE public.payroll_run_headers ADD COLUMN IF NOT EXISTS approval_revision pg_catalog.uuid;

UPDATE public.payroll_run_headers
SET approval_grandfathered_at = pg_catalog.clock_timestamp()
WHERE status IN ('approved', 'paid') AND approval_grandfathered_at IS NULL;

ALTER TABLE public.approval_enforcement DROP CONSTRAINT IF EXISTS approval_enforcement_document_type_check;
ALTER TABLE public.approval_enforcement ADD CONSTRAINT approval_enforcement_document_type_check CHECK (document_type IN (
  'customer_invoice', 'supplier_invoice', 'payment', 'journal_entry', 'credit_note',
  'customer_credit_note', 'supplier_credit_note', 'supplier_payment', 'payment_batch', 'manual_journal',
  'supplier_bank_details', 'bank_rule', 'pay_run'));

-- Fixed pay-run rows leave only with their owning company. The immutability
-- trigger below recognises that cascade because the company row is already
-- gone; a direct delete while the company exists remains refused.
ALTER TABLE public.approval_rules DROP CONSTRAINT IF EXISTS approval_rules_company_id_fkey;
ALTER TABLE public.approval_rules ADD CONSTRAINT approval_rules_company_id_fkey
  FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
ALTER TABLE public.approval_enforcement DROP CONSTRAINT IF EXISTS approval_enforcement_company_id_fkey;
ALTER TABLE public.approval_enforcement ADD CONSTRAINT approval_enforcement_company_id_fkey
  FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_rules_one_pay_run
  ON public.approval_rules (company_id) WHERE document_type = 'pay_run';

INSERT INTO public.approval_rules (
  company_id, name, document_type, condition_field, condition_operator,
  condition_value, approver_role, is_active, priority
)
SELECT c.id, 'All pay runs', 'pay_run', 'total', 'any', 0, 'manager', true, 1
FROM public.companies c
ON CONFLICT (company_id) WHERE document_type = 'pay_run' DO NOTHING;

INSERT INTO public.approval_enforcement (company_id, document_type, enabled_by)
SELECT c.id, 'pay_run', 'system:payroll-approval'
FROM public.companies c
ON CONFLICT (company_id, document_type) DO NOTHING;

CREATE OR REPLACE FUNCTION public.seed_pay_run_approval()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  INSERT INTO public.approval_rules (
    company_id, name, document_type, condition_field, condition_operator,
    condition_value, approver_role, is_active, priority
  ) VALUES (NEW.id, 'All pay runs', 'pay_run', 'total', 'any', 0, 'manager', true, 1)
  ON CONFLICT (company_id) WHERE document_type = 'pay_run' DO NOTHING;
  INSERT INTO public.approval_enforcement (company_id, document_type, enabled_by)
  VALUES (NEW.id, 'pay_run', 'system:payroll-approval')
  ON CONFLICT (company_id, document_type) DO NOTHING;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.seed_pay_run_approval() FROM PUBLIC;
DROP TRIGGER IF EXISTS trg_companies_seed_pay_run_approval ON public.companies;
CREATE TRIGGER trg_companies_seed_pay_run_approval
AFTER INSERT ON public.companies FOR EACH ROW EXECUTE FUNCTION public.seed_pay_run_approval();

CREATE OR REPLACE FUNCTION public.refuse_pay_run_approval_disable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.document_type = 'pay_run'
       AND NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = OLD.company_id) THEN
      RETURN OLD;
    END IF;
    IF OLD.document_type = 'pay_run' THEN
      RAISE EXCEPTION 'Pay-run approval is always on and its fixed rule cannot be changed'
        USING ERRCODE = 'RA035';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.document_type = 'pay_run' OR NEW.document_type = 'pay_run' THEN
    RAISE EXCEPTION 'Pay-run approval is always on and its fixed rule cannot be changed'
      USING ERRCODE = 'RA035';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_pay_run_rule_immutable ON public.approval_rules;
CREATE TRIGGER trg_pay_run_rule_immutable
BEFORE UPDATE OR DELETE ON public.approval_rules
FOR EACH ROW EXECUTE FUNCTION public.refuse_pay_run_approval_disable();
DROP TRIGGER IF EXISTS trg_pay_run_enforcement_immutable ON public.approval_enforcement;
CREATE TRIGGER trg_pay_run_enforcement_immutable
BEFORE UPDATE OR DELETE ON public.approval_enforcement
FOR EACH ROW EXECUTE FUNCTION public.refuse_pay_run_approval_disable();

DO $$
BEGIN
  IF pg_catalog.to_regprocedure('public.approval_document_digest_pre_payroll_951(uuid,text,uuid)') IS NULL THEN
    ALTER FUNCTION public.approval_document_digest(pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid)
      RENAME TO approval_document_digest_pre_payroll_951;
  END IF;
  IF pg_catalog.to_regprocedure('public.approval_document_authors_pre_payroll_951(uuid,text,uuid)') IS NULL THEN
    ALTER FUNCTION public.approval_document_authors(pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid)
      RENAME TO approval_document_authors_pre_payroll_951;
  END IF;
  IF pg_catalog.to_regprocedure('public.approval_request_document_facts_pre_payroll_951(uuid,text,uuid)') IS NULL THEN
    ALTER FUNCTION public.approval_request_document_facts(pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid)
      RENAME TO approval_request_document_facts_pre_payroll_951;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.approval_document_digest(
  p_company_id pg_catalog.uuid, p_document_type pg_catalog.text, p_document_id pg_catalog.uuid
) RETURNS pg_catalog.text
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE WHEN p_document_type = 'pay_run' THEN (
    SELECT h.approval_plan_hash FROM public.payroll_run_headers h
    WHERE h.id = p_document_id AND h.company_id = p_company_id
  ) ELSE public.approval_document_digest_pre_payroll_951(p_company_id, p_document_type, p_document_id) END
$$;

CREATE OR REPLACE FUNCTION public.approval_document_authors(
  p_company_id pg_catalog.uuid, p_document_type pg_catalog.text, p_document_id pg_catalog.uuid
) RETURNS pg_catalog.uuid[]
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE WHEN p_document_type = 'pay_run' THEN COALESCE((
    SELECT ARRAY[h.prepared_by] FROM public.payroll_run_headers h
    WHERE h.id = p_document_id AND h.company_id = p_company_id AND h.prepared_by IS NOT NULL
  ), '{}'::pg_catalog.uuid[])
  ELSE public.approval_document_authors_pre_payroll_951(p_company_id, p_document_type, p_document_id) END
$$;

CREATE OR REPLACE FUNCTION public.approval_request_document_facts(
  p_company_id pg_catalog.uuid, p_document_type pg_catalog.text, p_document_id pg_catalog.uuid
) RETURNS TABLE (amount pg_catalog.numeric, reference pg_catalog.text, digest pg_catalog.text)
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_document_type = 'pay_run' THEN
    RETURN QUERY SELECT h.total_gross,
      pg_catalog.lpad(h.period_month::pg_catalog.text, 2, '0') || '/' || h.period_year::pg_catalog.text,
      h.approval_plan_hash
    FROM public.payroll_run_headers h
    WHERE h.id = p_document_id AND h.company_id = p_company_id
      AND h.prepared_by IS NOT NULL AND h.approval_plan_hash IS NOT NULL;
  ELSE
    RETURN QUERY SELECT f.amount, f.reference, f.digest
    FROM public.approval_request_document_facts_pre_payroll_951(
      p_company_id, p_document_type, p_document_id
    ) f;
  END IF;
END
$$;

-- These helpers are reached only through the reviewed SECURITY DEFINER writers.
REVOKE ALL ON FUNCTION public.approval_document_authors(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approval_document_authors(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) TO app_user;
REVOKE ALL ON FUNCTION public.approval_request_document_facts(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approval_document_authors_pre_payroll_951(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approval_document_authors_pre_payroll_951(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) TO app_user;
REVOKE ALL ON FUNCTION public.approval_request_document_facts_pre_payroll_951(
  pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid) FROM PUBLIC;
