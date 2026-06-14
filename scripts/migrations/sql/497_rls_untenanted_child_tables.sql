-- scripts/migrations/sql/497_rls_untenanted_child_tables.sql
-- Pentest M12 (agent2): four tables lacked RLS. None of them carries a
-- company_id column of its own, so they are scoped via a PARENT JOIN to the
-- owning tenant — mirroring the tenant_isolation semantics from
-- 348_rls_and_auth_helpers.sql:
--   USING      (read/visibility): parent.company_id ∈ caller's company memberships
--   WITH CHECK (write):           parent.company_id = the active company GUC
--
-- Parent-join (rather than add-column+backfill) was chosen because:
--   * it needs no schema/data migration and no application-code change;
--   * a row is visible iff its parent entity is — exactly the invariant the
--     app already enforces in code (e.g. documentStorageService.verifyEntityOwnership,
--     paymentGatewayPortalService's company_id-scoped INSERT);
--   * the explicit `parent.company_id` predicate makes scoping correct even
--     when the parent itself is not (yet) under RLS (e.g. payroll_batches).
--
-- The runtime pool role is BYPASSRLS, so only `app_user` (set by withAuth via
-- SET LOCAL ROLE) is subject to these policies. Non-withAuth paths — e.g. the
-- unauthenticated customer-portal payment flow (pages/api/portal/payments/...,
-- withErrorHandler only) and cron jobs — run as the BYPASSRLS pool role and
-- are unaffected.
--
-- Helpers auth.uid() and app.current_company_id() are defined in migration 348.

-- ───────────────────────── bank_transaction_attachments ─────────────────────
-- Parent: bank_transactions (has company_id + RLS).
ALTER TABLE public.bank_transaction_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_transaction_attachments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_via_parent ON public.bank_transaction_attachments;
CREATE POLICY tenant_isolation_via_parent ON public.bank_transaction_attachments
  FOR ALL TO app_user
  USING (EXISTS (
    SELECT 1 FROM public.bank_transactions bt
    WHERE bt.id = bank_transaction_attachments.bank_transaction_id
      AND bt.company_id IN (
        SELECT company_id FROM public.company_users WHERE user_id = auth.uid()
      )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.bank_transactions bt
    WHERE bt.id = bank_transaction_attachments.bank_transaction_id
      AND bt.company_id = app.current_company_id()
  ));

-- ───────────────────────────── payroll_batch_lines ──────────────────────────
-- Parent: payroll_batches (has company_id but is NOT itself under RLS).
--
-- For the other three tables the WITH CHECK relies on `parent.company_id =
-- app.current_company_id()` and gets a SECOND barrier for free: their parents
-- are under FORCE RLS, so the EXISTS subquery only sees the caller's own rows
-- and a forged active-company GUC cannot satisfy it. payroll_batches has no RLS,
-- so that second barrier is absent — `app.current_company_id()` (a GUC, set by
-- withAuth only after a membership check) would be the ONLY guard on writes.
-- To keep the DB layer fail-closed independently of the app gate, the WITH CHECK
-- below ALSO requires the caller to be a member of the batch's company. USING
-- (reads) is already membership-scoped.
ALTER TABLE public.payroll_batch_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_batch_lines FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_via_parent ON public.payroll_batch_lines;
CREATE POLICY tenant_isolation_via_parent ON public.payroll_batch_lines
  FOR ALL TO app_user
  USING (EXISTS (
    SELECT 1 FROM public.payroll_batches b
    WHERE b.id = payroll_batch_lines.batch_id
      AND b.company_id IN (
        SELECT company_id FROM public.company_users WHERE user_id = auth.uid()
      )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.payroll_batches b
    WHERE b.id = payroll_batch_lines.batch_id
      AND b.company_id = app.current_company_id()
      AND b.company_id IN (
        SELECT company_id FROM public.company_users WHERE user_id = auth.uid()
      )
  ));

-- ───────────────────────────── portal_payment_links ─────────────────────────
-- Parent: customer_invoices via invoice_id (has company_id + RLS). The portal
-- service only ever creates a link for an invoice it has already scoped by
-- company_id, so the WITH CHECK below always holds for legitimate writes.
ALTER TABLE public.portal_payment_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_payment_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_via_parent ON public.portal_payment_links;
CREATE POLICY tenant_isolation_via_parent ON public.portal_payment_links
  FOR ALL TO app_user
  USING (EXISTS (
    SELECT 1 FROM public.customer_invoices ci
    WHERE ci.id = portal_payment_links.invoice_id
      AND ci.company_id IN (
        SELECT company_id FROM public.company_users WHERE user_id = auth.uid()
      )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.customer_invoices ci
    WHERE ci.id = portal_payment_links.invoice_id
      AND ci.company_id = app.current_company_id()
  ));

-- ───────────────────────────── procurement_documents ────────────────────────
-- Polymorphic parent (entity_type + entity_id). Each branch joins to the parent
-- table that owns that entity type. This mirrors verifyEntityOwnership() in
-- documentStorageService.ts. The only INSERT path (uploadDocument) writes the
-- five VALID_ENTITY_TYPES, all of which have a company_id parent; purchase_order
-- is also covered for completeness. NOTE: goods_receipt_notes has no company_id
-- column, so goods_receipt_note-typed rows (not creatable via the current
-- upload path) are intentionally NOT visible to app_user — they remain
-- reachable only via the BYPASSRLS pool role. This is fail-closed.
ALTER TABLE public.procurement_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.procurement_documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_via_parent ON public.procurement_documents;
CREATE POLICY tenant_isolation_via_parent ON public.procurement_documents
  FOR ALL TO app_user
  USING (
    (entity_type = 'supplier_invoice' AND EXISTS (
      SELECT 1 FROM public.sage_supplier_invoices p
      WHERE p.id = procurement_documents.entity_id
        AND p.company_id IN (SELECT company_id FROM public.company_users WHERE user_id = auth.uid())))
    OR (entity_type = 'customer_invoice' AND EXISTS (
      SELECT 1 FROM public.customer_invoices p
      WHERE p.id = procurement_documents.entity_id
        AND p.company_id IN (SELECT company_id FROM public.company_users WHERE user_id = auth.uid())))
    OR (entity_type = 'supplier_payment' AND EXISTS (
      SELECT 1 FROM public.supplier_payments p
      WHERE p.id = procurement_documents.entity_id
        AND p.company_id IN (SELECT company_id FROM public.company_users WHERE user_id = auth.uid())))
    OR (entity_type = 'customer_payment' AND EXISTS (
      SELECT 1 FROM public.customer_payments p
      WHERE p.id = procurement_documents.entity_id
        AND p.company_id IN (SELECT company_id FROM public.company_users WHERE user_id = auth.uid())))
    OR (entity_type = 'credit_note' AND EXISTS (
      SELECT 1 FROM public.credit_notes p
      WHERE p.id = procurement_documents.entity_id
        AND p.company_id IN (SELECT company_id FROM public.company_users WHERE user_id = auth.uid())))
    OR (entity_type = 'purchase_order' AND EXISTS (
      SELECT 1 FROM public.purchase_orders p
      WHERE p.id = procurement_documents.entity_id
        AND p.company_id IN (SELECT company_id FROM public.company_users WHERE user_id = auth.uid())))
  )
  WITH CHECK (
    (entity_type = 'supplier_invoice' AND EXISTS (
      SELECT 1 FROM public.sage_supplier_invoices p
      WHERE p.id = procurement_documents.entity_id AND p.company_id = app.current_company_id()))
    OR (entity_type = 'customer_invoice' AND EXISTS (
      SELECT 1 FROM public.customer_invoices p
      WHERE p.id = procurement_documents.entity_id AND p.company_id = app.current_company_id()))
    OR (entity_type = 'supplier_payment' AND EXISTS (
      SELECT 1 FROM public.supplier_payments p
      WHERE p.id = procurement_documents.entity_id AND p.company_id = app.current_company_id()))
    OR (entity_type = 'customer_payment' AND EXISTS (
      SELECT 1 FROM public.customer_payments p
      WHERE p.id = procurement_documents.entity_id AND p.company_id = app.current_company_id()))
    OR (entity_type = 'credit_note' AND EXISTS (
      SELECT 1 FROM public.credit_notes p
      WHERE p.id = procurement_documents.entity_id AND p.company_id = app.current_company_id()))
    OR (entity_type = 'purchase_order' AND EXISTS (
      SELECT 1 FROM public.purchase_orders p
      WHERE p.id = procurement_documents.entity_id AND p.company_id = app.current_company_id()))
  );
