-- 962: Where a bill's or invoice's due date came from, and a history of every change to it (payment-terms programme
-- PR 2; Hein, 2026-11-05: due_date is the single source of truth, derived from terms at capture and by "Re-apply
-- terms" (PR 3), hand-editable on an approved bill, date only, audited).
--
--   1. due_date_source on supplier_invoices and customer_invoices:
--        terms     the contact's terms (or the company default) gave it;
--        manual    a person or API caller chose it (a date typed on capture or edited later, or a bill's own "net30");
--        document  the source document gave it (a scanned bill's printed due date or terms, an imported row's date);
--        legacy    written before this migration, or by code that does not name a source.
--      Re-apply (PR 3) overwrites terms and legacy dates on open documents and lists manual and document ones unticked.
--      NOT NULL DEFAULT 'legacy': a constant default is stored in the catalogue (no rewrite), every existing row reads
--      'legacy', and the old colour, which names no source, keeps inserting (it gets 'legacy', which is the truth: the
--      old code cannot say where its date came from). The old colour's draft edits leave the source as it was.
--
--   2. The history is 888's entity_changes, not a new table: the same capture (SECURITY DEFINER, unchanged, so 930's
--      definer registry is too), the same append-only guards, actor, channel and RLS. Two entity types,
--      supplier_invoice and customer_invoice, readable by any member (as the invoices are). The projection keeps only
--      invoice_number, due_date and due_date_source for them: an invoice row carries a credential (customer_invoices.
--      portal_token) and amounts a due-date history has no business copying. The capture fires only on an UPDATE that
--      moves due_date or due_date_source (WHEN clause; creation is not a change), whoever writes: the edit route, a
--      draft edit, Re-apply, a script. ENABLE ALWAYS, as 888's.
--
-- Expand-only and safe beside the old code: it never names the column; its due-date updates are now recorded (the
-- capture is the table's). Rollback of code alone leaves a defaulted column and a trigger: harmless.
--
-- Locks: entity_changes first (the CHECK and the policy, ACCESS EXCLUSIVE to COMMIT, NOT VALID so no scan), then each
-- invoice table (ADD COLUMN with a constant default, no rewrite; its CHECK is validated by one scan under the same lock).
-- A request that writes an invoice and then a tracked contact can deadlock with this order; lock_timeout ends the
-- migration first, which has then changed nothing (apply-migrations.ts runs the file in one transaction): re-run it.
-- Deploy after hours.

SET LOCAL lock_timeout = '5s';

-- ── 2a. The entity types (a strict superset of 961's list: NOT VALID, as 961) ──
ALTER TABLE entity_changes DROP CONSTRAINT IF EXISTS entity_changes_entity_type_check;
ALTER TABLE entity_changes ADD CONSTRAINT entity_changes_entity_type_check CHECK (entity_type IN (
  'supplier', 'customer', 'gl_account', 'payroll_employee', 'company_user', 'company_invitation',
  'company_user_permission', 'company', 'approval_rule', 'approval_enforcement', 'payroll_bank_detail',
  'company_setting', 'supplier_invoice', 'customer_invoice')) NOT VALID;

-- ── 2b. Who reads them: any member, as for suppliers and customers (952's policy otherwise unchanged) ──
DROP POLICY IF EXISTS entity_changes_read ON entity_changes;
CREATE POLICY entity_changes_read ON entity_changes
  FOR SELECT TO app_user
  USING (
    company_id = app.current_company_id()
    AND company_id IN (SELECT auth.user_companies())
    AND CASE
      WHEN entity_type IN ('supplier', 'customer', 'gl_account', 'supplier_invoice', 'customer_invoice') THEN true
      WHEN entity_type = 'payroll_employee'
        THEN COALESCE(public.company_member_actor_role(company_id) IN ('owner', 'admin', 'manager'), false)
      WHEN entity_type = 'payroll_bank_detail'
        THEN COALESCE(public.company_member_actor_role(company_id) IN ('owner', 'admin', 'manager'), false)
      ELSE COALESCE(public.company_member_actor_role(company_id) IN ('owner', 'admin'), false)
    END);

-- ── 2c. What is recorded of an invoice: 888's projection plus one allow-list arm ──
CREATE OR REPLACE FUNCTION public.entity_change_projection(p_type pg_catalog.text, p_row pg_catalog.jsonb)
RETURNS pg_catalog.jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE p_type
    WHEN 'company' THEN
      (SELECT COALESCE(pg_catalog.jsonb_object_agg(e.key, e.value), '{}'::pg_catalog.jsonb)
       FROM pg_catalog.jsonb_each(p_row) e
       WHERE e.key = ANY (ARRAY[
         'name', 'registered_name', 'trading_name', 'entity_type', 'registration_number', 'vat_number', 'tax_number',
         'tax_office', 'vat_period', 'vat_period_alignment', 'vat_system_type', 'paye_reference_number',
         'sdl_reference_number', 'uif_reference_number', 'tax_practitioner_reg_number', 'tax_practitioner_name',
         'financial_year_start', 'lockdown_enabled', 'lockdown_date', 'default_currency', 'functional_currency',
         'fx_documents_enabled', 'bank_name', 'bank_account_number', 'bank_branch_code', 'bank_account_type',
         'netcash_enabled', 'status', 'is_active', 'idle_timeout_minutes',
         -- Where customers are told to pay, and the addresses and mail that carry it
         -- (breaker #696 R1): a changed "pay into" line is as material as the account.
         'portal_payment_instructions', 'portal_allow_payments', 'portal_welcome_message', 'email', 'billing_email',
         'phone', 'mobile', 'fax', 'website', 'email_always_cc', 'email_use_for_communication', 'email_use_service_from',
         -- The address printed on every invoice and credit note (pdfShared.getCompanyDetailsFromCompany) and the
         -- registered / physical ones (breaker #696 r2 #3).
         'address_line1', 'address_line2', 'city', 'province', 'postal_code', 'country',
         'physical_address_line1', 'physical_address_line2', 'physical_city', 'physical_province', 'physical_postal_code',
         'registered_address',
         'invoice_email_subject', 'invoice_email_body', 'invoice_email_signature',
         'quote_email_subject', 'quote_email_body', 'quote_email_signature',
         'statement_email_subject', 'statement_email_body', 'statement_email_signature',
         'credit_note_email_subject', 'credit_note_email_body', 'credit_note_email_signature',
         'sales_order_email_subject', 'sales_order_email_body', 'sales_order_email_signature',
         'recurring_invoice_email_subject', 'recurring_invoice_email_body', 'recurring_invoice_email_signature',
         'chase_auto_send_enabled', 'whatsapp_chase_enabled', 'client_query_whatsapp',
         'share_anonymised_signals']::pg_catalog.text[]))
      || pg_catalog.jsonb_build_object(
           'netcash_service_key', public.entity_change_secret_digest(p_row ->> 'netcash_service_key'),
           'netcash_payouts_key', public.entity_change_secret_digest(p_row ->> 'netcash_payouts_key'))
    -- 962: an invoice's due-date history (the capture fires only when the due date or its source moves).
    WHEN 'supplier_invoice' THEN
      pg_catalog.jsonb_build_object('invoice_number', p_row -> 'invoice_number', 'due_date', p_row -> 'due_date',
                                    'due_date_source', p_row -> 'due_date_source')
    WHEN 'customer_invoice' THEN
      pg_catalog.jsonb_build_object('invoice_number', p_row -> 'invoice_number', 'due_date', p_row -> 'due_date',
                                    'due_date_source', p_row -> 'due_date_source')
    ELSE p_row - ARRAY['id', 'created_at', 'updated_at']::pg_catalog.text[] - CASE p_type
      -- Who set the current bank details (867): derived; this history says who.
      WHEN 'supplier' THEN ARRAY['bank_details_setters']::pg_catalog.text[]
      -- A member's own default company: their preference, not an access change.
      WHEN 'company_user' THEN ARRAY['is_default']::pg_catalog.text[]
      -- Mail delivery state. The token (a credential) is replaced by its digest
      -- below; gotrue_user_id is the account acceptance sets a password on, so it
      -- is recorded (breaker #696 R6).
      WHEN 'company_invitation' THEN ARRAY['token', 'email_sent_at', 'email_error']::pg_catalog.text[]
      ELSE ARRAY[]::pg_catalog.text[] END
      || CASE WHEN p_type = 'company_invitation'
           THEN pg_catalog.jsonb_build_object('token', public.entity_change_secret_digest(p_row ->> 'token'))
           ELSE '{}'::pg_catalog.jsonb END
  END
$$;
REVOKE ALL ON FUNCTION public.entity_change_projection(pg_catalog.text, pg_catalog.jsonb) FROM PUBLIC;

-- ── 1. The source column ──────────────────────────────────────────────────
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS due_date_source TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS due_date_source TEXT NOT NULL DEFAULT 'legacy';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                 WHERE conrelid = 'public.supplier_invoices'::pg_catalog.regclass AND conname = 'supplier_invoices_due_date_source_check') THEN
    ALTER TABLE public.supplier_invoices ADD CONSTRAINT supplier_invoices_due_date_source_check
      CHECK (due_date_source IN ('terms', 'manual', 'document', 'legacy'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                 WHERE conrelid = 'public.customer_invoices'::pg_catalog.regclass AND conname = 'customer_invoices_due_date_source_check') THEN
    ALTER TABLE public.customer_invoices ADD CONSTRAINT customer_invoices_due_date_source_check
      CHECK (due_date_source IN ('terms', 'manual', 'document', 'legacy'));
  END IF;
END $$;

-- ── 2d. The captures ──────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS entity_change_capture_due_date ON supplier_invoices;
CREATE TRIGGER entity_change_capture_due_date AFTER UPDATE OF due_date, due_date_source ON supplier_invoices
  FOR EACH ROW WHEN (OLD.due_date IS DISTINCT FROM NEW.due_date OR OLD.due_date_source IS DISTINCT FROM NEW.due_date_source)
  EXECUTE FUNCTION public.entity_change_capture('supplier_invoice');
ALTER TABLE supplier_invoices ENABLE ALWAYS TRIGGER entity_change_capture_due_date;

DROP TRIGGER IF EXISTS entity_change_capture_due_date ON customer_invoices;
CREATE TRIGGER entity_change_capture_due_date AFTER UPDATE OF due_date, due_date_source ON customer_invoices
  FOR EACH ROW WHEN (OLD.due_date IS DISTINCT FROM NEW.due_date OR OLD.due_date_source IS DISTINCT FROM NEW.due_date_source)
  EXECUTE FUNCTION public.entity_change_capture('customer_invoice');
ALTER TABLE customer_invoices ENABLE ALWAYS TRIGGER entity_change_capture_due_date;
