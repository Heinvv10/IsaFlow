-- 1012: Intercompany mirror posting, P3 (pre-cutover pairing). Plan: docs/plans/2026-11-17-intercompany-mirror-posting.md.
--
-- WHAT. The pairing screen links documents that were open BEFORE a connection's cut-over date (company A's open customer invoice
-- is company B's open supplier invoice). Each company reads only its own documents; the counterparty's side comes through two
-- reviewed SECURITY DEFINER functions that hand over what pairing needs and nothing else. No table, column or grant changes: the
-- links, their slots and their guards are 1000 and 1002.
--
--   intercompany_pairing_partner_documents(p_connection, p_partner_type)
--       The PARTNER's open documents dated before the cut-over: 'customer_invoice' = the partner's customer invoices for the
--       customer it linked on its side of this connection, 'supplier_invoice' = its bills from the supplier it linked. Per document:
--       type, id, number, date, total, open amount, currency, and the link on THIS connection that holds it (NULL if none). The id is
--       what a pairing names; no customer or supplier name, no line, no payment, no other date or column leaves.
--       Left out: drafts, pending approval, cancelled, deleted, settled documents, anything dated on or after the cut-over, any
--       document the partner did not link on this connection, and any document a link of ANOTHER connection holds (the slots of
--       1002), so a document that is paired elsewhere is not offered twice.
--   intercompany_pairing_partner_loan_balance(p_connection)
--       The partner's loan account (the one it set on its side) as net debit (debits less credits of POSTED journals dated before
--       the cut-over, the year-end closing journal left out as every report does: G-01), one number; NULL when it cannot be given. The page sets it against the caller's own balance.
--
-- WHO MAY ASK (both functions; for any other caller the answer is empty / NULL, so neither is a way to probe another company's books):
--   - a signed-in user (auth.uid()) holding a write role in the session company (intercompany_user_can_write reads company_users by
--     auth.uid(), so it also proves membership: the session company GUC alone proves nothing; a viewer reads only, as in 1000 / 1002);
--   - the session company is one of the connection's two companies, the connection is ACTIVE, and it has a cut-over date.
--   The partner is the OTHER company of the connection; the party and the loan account are read from the partner's own side row,
--   which the sides guard (1002) keeps to the partner's own customer, supplier and accounts.
--
-- DEFINER, registered in app_definer_reviews (930); owner migration_admin (BYPASSRLS); pinned search_path, pg_temp last; EXECUTE for
-- app_user and app_service only. Both only read.
-- OLD COLOUR: nothing in the previous release calls them. LOCKS: two new functions, no table is touched.
--
-- Rollback (code first):
--   DROP FUNCTION IF EXISTS public.intercompany_pairing_partner_documents(uuid, text), public.intercompany_pairing_partner_loan_balance(uuid);
--   DELETE FROM app_definer_reviews WHERE signature IN ('intercompany_pairing_partner_documents(uuid,text)', 'intercompany_pairing_partner_loan_balance(uuid)');

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- The caller's context, shared by both functions: the connection when the caller may ask about it, else no row. Not a function
-- of its own (a second definer would be a second thing to review), so each body repeats the CTE.

CREATE OR REPLACE FUNCTION public.intercompany_pairing_partner_documents(p_connection uuid, p_partner_type text)
RETURNS TABLE (doc_type text, doc_id uuid, doc_number text, doc_date date, total_amount numeric, open_amount numeric,
               currency_code text, link_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH ctx AS (
    SELECT c.id AS connection_id, c.cutover_date,
           CASE WHEN c.company_low_id = app.current_company_id() THEN c.company_high_id ELSE c.company_low_id END AS partner_id
      FROM public.intercompany_connections c
     WHERE c.id = p_connection AND c.status = 'active' AND c.cutover_date IS NOT NULL
       AND app.current_company_id() IN (c.company_low_id, c.company_high_id)
       AND public.intercompany_user_can_write(app.current_company_id())
  ), party AS (
    SELECT x.connection_id, x.cutover_date, x.partner_id, s.customer_id, s.supplier_id
      FROM ctx x
      JOIN public.intercompany_connection_sides s ON s.connection_id = x.connection_id AND s.company_id = x.partner_id
  )
  SELECT 'customer_invoice'::text, ci.id, ci.invoice_number::text, ci.invoice_date, ci.total_amount,
         ci.total_amount - COALESCE(ci.amount_paid, 0), ci.currency_code::text, held.link_id
    FROM party p
    JOIN public.customer_invoices ci
      ON ci.company_id = p.partner_id AND COALESCE(ci.client_id, ci.customer_id) = p.customer_id
    LEFT JOIN LATERAL (
      SELECT sl.link_id, l.connection_id
        FROM public.intercompany_document_slots sl
        JOIN public.intercompany_document_links l ON l.id = sl.link_id
       WHERE sl.company_id = ci.company_id AND sl.doc_type = 'customer_invoice' AND sl.doc_id = ci.id
    ) held ON true
   WHERE p_partner_type = 'customer_invoice'
     AND COALESCE(ci.status, '') NOT IN ('draft', 'pending_approval', 'cancelled') AND ci.deleted_at IS NULL
     AND ci.invoice_date < p.cutover_date AND ci.total_amount - COALESCE(ci.amount_paid, 0) > 0
     AND (held.link_id IS NULL OR held.connection_id = p.connection_id)
  UNION ALL
  SELECT 'supplier_invoice'::text, si.id, si.invoice_number::text, si.invoice_date, si.total_amount,
         si.total_amount - COALESCE(si.amount_paid, 0), si.currency_code::text, held.link_id
    FROM party p
    JOIN public.supplier_invoices si ON si.company_id = p.partner_id AND si.supplier_id = p.supplier_id
    LEFT JOIN LATERAL (
      SELECT sl.link_id, l.connection_id
        FROM public.intercompany_document_slots sl
        JOIN public.intercompany_document_links l ON l.id = sl.link_id
       WHERE sl.company_id = si.company_id AND sl.doc_type = 'supplier_invoice' AND sl.doc_id = si.id
    ) held ON true
   WHERE p_partner_type = 'supplier_invoice'
     AND COALESCE(si.status, '') NOT IN ('draft', 'pending_approval', 'cancelled') AND si.deleted_at IS NULL
     AND si.invoice_date < p.cutover_date AND si.total_amount - COALESCE(si.amount_paid, 0) > 0
     AND (held.link_id IS NULL OR held.connection_id = p.connection_id)
$$;
ALTER FUNCTION public.intercompany_pairing_partner_documents(uuid, text) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_pairing_partner_documents(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_pairing_partner_documents(uuid, text) TO app_user, app_service;

CREATE OR REPLACE FUNCTION public.intercompany_pairing_partner_loan_balance(p_connection uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT (SELECT COALESCE(SUM(jl.debit - jl.credit), 0)
            FROM public.gl_journal_entries je
            JOIN public.gl_journal_lines jl ON jl.journal_entry_id = je.id AND jl.company_id = p.partner_id
           WHERE je.company_id = p.partner_id AND je.status = 'posted' AND je.source IS DISTINCT FROM 'year_end' AND je.entry_date < p.cutover_date
             AND jl.gl_account_id = p.loan_account_id)
    FROM (
      SELECT c.cutover_date, s.company_id AS partner_id, s.loan_account_id
        FROM public.intercompany_connections c
        JOIN public.intercompany_connection_sides s ON s.connection_id = c.id
         AND s.company_id = CASE WHEN c.company_low_id = app.current_company_id() THEN c.company_high_id ELSE c.company_low_id END
       WHERE c.id = p_connection AND c.status = 'active' AND c.cutover_date IS NOT NULL
         AND app.current_company_id() IN (c.company_low_id, c.company_high_id)
         AND public.intercompany_user_can_write(app.current_company_id())
         AND s.loan_account_id IS NOT NULL
    ) p
$$;
ALTER FUNCTION public.intercompany_pairing_partner_loan_balance(uuid) OWNER TO migration_admin;
REVOKE ALL ON FUNCTION public.intercompany_pairing_partner_loan_balance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_pairing_partner_loan_balance(uuid) TO app_user, app_service;

-- ── The definer registry (930) ──────────────────────────────────────────────────────────────

INSERT INTO public.app_definer_reviews (signature, writes, body_md5)
SELECT v.signature, v.writes, public.app_definer_hash(v.fn::regprocedure)
  FROM (VALUES
    ('intercompany_pairing_partner_documents(uuid,text)', 'public.intercompany_pairing_partner_documents(uuid, text)',
     'nothing (read of intercompany_connections, intercompany_connection_sides, intercompany_document_slots, intercompany_document_links, customer_invoices, supplier_invoices: the partner''s open, pre-cut-over documents of the party it linked on an active connection, as number / date / total / open amount; empty unless the caller is a signed-in writer of the session company, which is a party to the connection)'),
    ('intercompany_pairing_partner_loan_balance(uuid)', 'public.intercompany_pairing_partner_loan_balance(uuid)',
     'nothing (read of intercompany_connections, intercompany_connection_sides, gl_journal_entries, gl_journal_lines: the net debit of the partner''s loan account over posted journals dated before the cut-over, one number; NULL unless the caller is a signed-in writer of the session company, which is a party to an active connection)')
  ) AS v(signature, fn, writes)
ON CONFLICT (signature) DO UPDATE SET writes = EXCLUDED.writes, body_md5 = EXCLUDED.body_md5;

DO $$
BEGIN
  IF pg_catalog.has_function_privilege('public', 'public.intercompany_pairing_partner_documents(uuid, text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.intercompany_pairing_partner_loan_balance(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '1012: PUBLIC can execute an intercompany pairing definer function';
  END IF;
END $$;
