-- 999w_actor_ids_text.sql (master plan wave 6, HYb: the contract step after HYa)
--
-- The actor columns (`*_by`) of the payroll, SARS and tax tables change from uuid to TEXT. users.id is varchar and a
-- user id need not be UUID-shaped (`sage-import-bot-…`, 4 of 133 dev users), so a uuid column refused such a user
-- with 22P02 the moment they prepared a run, saved an EMP201 draft or approved leave.
--
-- The list is every uuid column named `*_by` on a payroll_, sars_, tax_, uif_ or vat_ table (information_schema,
-- pasted in the PR body): the spec's 13 (wave-6 spec section 2, F19) plus vat_adjustments.{created_by, approved_by}
-- and sars_source_codes.imported_by, which the same query finds. sars_efiling_events.created_by and
-- sars_submissions.submitted_by change together: sarsEfilingRepo copies one into the other uncast (42804 otherwise).
--
-- Old colour = the HYa release (live since c8c36af2b3): it writes every one of these as an untyped parameter or a
-- uuid value (which assigns to TEXT) and compares `col::text = ${userId}`, so it runs unchanged on TEXT. No view,
-- policy, constraint, index or default depends on these columns (pg_depend, in the PR body).
--
-- One function reads a column by its type: approval_document_authors builds `ARRAY[h.prepared_by]` and returns
-- uuid[]; on TEXT the COALESCE with '{}'::uuid[] no longer resolves. The pay-run branch casts the preparer to uuid, so
-- its result is unchanged for every UUID-shaped preparer, and a non-UUID preparer fails closed (22P02: the run cannot
-- be raised or decided for approval until approval_requests' own actor columns are TEXT, logged for wave 7) instead
-- of dropping out of the author list. Not a SECURITY DEFINER: no app_definer_reviews row (930).
--
-- Rollback: code only (scripts/rollback-deploy.sh). The previous release (HYa) tolerates TEXT; the columns are not
-- turned back (a non-UUID id written after this would not cast).

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.payroll_run_headers
  ALTER COLUMN approved_by TYPE TEXT USING approved_by::text,
  ALTER COLUMN cancelled_by TYPE TEXT USING cancelled_by::text,
  ALTER COLUMN created_by TYPE TEXT USING created_by::text,
  ALTER COLUMN prepared_by TYPE TEXT USING prepared_by::text;
ALTER TABLE public.payroll_leave_requests ALTER COLUMN approved_by TYPE TEXT USING approved_by::text;
ALTER TABLE public.payroll_external_imports ALTER COLUMN created_by TYPE TEXT USING created_by::text;
-- Together (see above).
ALTER TABLE public.sars_efiling_events ALTER COLUMN created_by TYPE TEXT USING created_by::text;
ALTER TABLE public.sars_submissions ALTER COLUMN submitted_by TYPE TEXT USING submitted_by::text;
ALTER TABLE public.sars_source_codes ALTER COLUMN imported_by TYPE TEXT USING imported_by::text;
ALTER TABLE public.tax_directives
  ALTER COLUMN approved_by TYPE TEXT USING approved_by::text,
  ALTER COLUMN requested_by TYPE TEXT USING requested_by::text;
ALTER TABLE public.tax_directive_payments ALTER COLUMN created_by TYPE TEXT USING created_by::text;
ALTER TABLE public.uif_declarations ALTER COLUMN submitted_by TYPE TEXT USING submitted_by::text;
ALTER TABLE public.vat_returns ALTER COLUMN submitted_by TYPE TEXT USING submitted_by::text;
ALTER TABLE public.vat_adjustments
  ALTER COLUMN approved_by TYPE TEXT USING approved_by::text,
  ALTER COLUMN created_by TYPE TEXT USING created_by::text;

-- As 951 defines it, with the preparer cast to uuid (see above). CREATE OR REPLACE keeps its owner and grants.
CREATE OR REPLACE FUNCTION public.approval_document_authors(p_company_id uuid, p_document_type text, p_document_id uuid)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN p_document_type = 'pay_run' THEN COALESCE((
    SELECT ARRAY[h.prepared_by::pg_catalog.uuid] FROM public.payroll_run_headers h
    WHERE h.id = p_document_id AND h.company_id = p_company_id AND h.prepared_by IS NOT NULL
  ), '{}'::pg_catalog.uuid[])
  ELSE public.approval_document_authors_pre_payroll_951(p_company_id, p_document_type, p_document_id) END
$function$;

DO $$
DECLARE
  v_left text;
BEGIN
  SELECT string_agg(table_name || '.' || column_name, ', ' ORDER BY table_name, column_name) INTO v_left
  FROM information_schema.columns
  WHERE table_schema = 'public' AND data_type = 'uuid' AND column_name LIKE '%\_by'
    AND table_name ~ '^(payroll|sars|tax|uif|vat)_';
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION '999w: uuid actor columns left on the payroll, SARS and tax tables: %', v_left;
  END IF;
END $$;
