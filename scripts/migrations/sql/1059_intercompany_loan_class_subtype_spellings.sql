-- Intercompany: the loan class reads account_subtype by its spelling, not by one exact string (#1880 prod evidence 2026-11-26).
--
-- Production carries singular/plural pairs of the same subtype (current_liability 52 / current_liabilities 7, long_term_liability 76 /
-- long_term_liabilities 3) and 346 NULLs; no case or whitespace variants. 1027's intercompany_is_loan_class compared exact singular strings, so
-- a company whose loan account was spelled `current_liabilities` or `long_term_liabilities` could not be set up as a loan side (fail-closed,
-- never a wrong posting). It now accepts the plural of each class already allowed. Case and spacing need no handling here: trigger
-- trg_gl_accounts_normalise_subtype (674) trims, lower-cases and underscores every written subtype (the SQL twin of canonicalSubtype), which
-- is why production has no such variants; an earlier draft of this migration re-normalised in the function, which was dead code (and wrong for
-- padded values: replace-then-trim). Nothing else widens: NULL stays refused (the CASE is NULL, the COALESCE makes it false),
-- `current_asset(s)`, `fixed_asset(s)`, `receivable`, bank and cash are still not loan classes, and the system-account and seven-bank-table
-- exclusions are unchanged. The money side (CASH_SUBTYPES / 1031 H4) already lists every bank/cash spelling.
--
-- Rollback: re-apply the CREATE OR REPLACE from 1027 section 0 (the one function, same signature, same grants).

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.intercompany_is_loan_class(p_account uuid, p_company uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT ga.is_system_account = false
       AND CASE ga.account_type
             WHEN 'asset' THEN ga.account_subtype IN ('other_current_asset', 'other_current_assets', 'other')
             WHEN 'liability' THEN ga.account_subtype IN ('current_liability', 'current_liabilities', 'other_current_liability', 'other_current_liabilities', 'long_term_liability', 'long_term_liabilities', 'other')
             ELSE false END
       AND NOT EXISTS (SELECT 1 FROM public.bank_transactions bt WHERE bt.bank_account_id = ga.id AND bt.company_id = ga.company_id)
       -- (round 3, A) nor one any bank table of ITS OWN company names: a registered bank account, a bank feed, a statement import, an import
       -- batch, a reconciliation, a transfer-link log (each of these columns is the GL account the bank side posts to). Scoped to the
       -- account's company like the statement-line test: a row of another company naming this id re-classes nothing (final batch, M2)
       AND NOT EXISTS (SELECT 1 FROM public.bank_accounts b WHERE b.gl_account_id = ga.id AND b.company_id = ga.company_id)
       AND NOT EXISTS (SELECT 1 FROM public.bank_feed_connections f WHERE f.bank_account_id = ga.id AND f.company_id = ga.company_id)
       AND NOT EXISTS (SELECT 1 FROM public.bank_statement_imports i WHERE i.bank_account_id = ga.id AND i.company_id = ga.company_id)
       AND NOT EXISTS (SELECT 1 FROM public.bank_import_batches ib WHERE ib.bank_account_id = ga.id AND ib.company_id = ga.company_id)
       AND NOT EXISTS (SELECT 1 FROM public.bank_reconciliations r WHERE r.bank_account_id = ga.id AND r.company_id = ga.company_id)
       AND NOT EXISTS (SELECT 1 FROM public.bank_transfer_link_log tl WHERE tl.bank_account_id = ga.id AND tl.company_id = ga.company_id)
      FROM public.gl_accounts ga
     WHERE ga.id = p_account AND ga.company_id = p_company), false)
$$;
REVOKE ALL ON FUNCTION public.intercompany_is_loan_class(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.intercompany_is_loan_class(uuid, uuid) TO app_user, migration_admin;
