-- 648: narrow the invite-token session's read of `companies` from the whole row
-- to the one column the endpoint needs.
--
-- Migration 643 fixed R-030 by adding companies_invite_token_read, a ROW policy.
-- A row policy grants the whole row, and `companies` has 163 columns — among
-- them netcash_service_key, netcash_payouts_key, bank_account_number,
-- bank_branch_code and the SARS contact details. Nothing in an invite-token
-- session selects those today, but the RLS boundary is the control, and as
-- written it said an anonymous invitation-link holder may read a tenant's
-- payment-gateway keys and bank account number. Any query later added to that
-- session would have inherited the grant silently.
--
-- Replace it with a SECURITY DEFINER function returning `name` and nothing
-- else, on exactly the terms the policy granted: the invitation named by the
-- session's own app.invite_token GUC, not accepted, not expired. Outside an
-- invite-token session the GUC is unset, nullif makes the comparison NULL, and
-- the function returns NULL. With the join gone from
-- pages/api/invitations/[token]/index.ts, `companies` needs no invite policy at
-- all, so the row grant is dropped.

CREATE OR REPLACE FUNCTION public.invite_token_company_name()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
-- Pinned: a SECURITY DEFINER body must not resolve names through a caller's
-- search_path.
SET search_path = public, pg_catalog
AS $$
  SELECT c.name
  FROM public.company_invitations ci
  JOIN public.companies c ON c.id = ci.company_id
  WHERE ci.token = nullif(current_setting('app.invite_token', true), '')
    AND ci.accepted_at IS NULL
    AND ci.expires_at > now()
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.invite_token_company_name() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.invite_token_company_name() TO app_user;

-- The whole-row grant 643 added is no longer needed by any query.
DROP POLICY IF EXISTS companies_invite_token_read ON public.companies;
