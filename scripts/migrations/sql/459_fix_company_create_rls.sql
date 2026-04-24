-- scripts/migrations/sql/459_fix_company_create_rls.sql
-- Fix: onboarding POST /api/accounting/companies 500s with
--   "new row violates row-level security policy for table companies"
-- since mig 351. Same root cause blocks the sibling INSERT into company_users.
--
-- Mig 351 installed:
--   CREATE POLICY companies_owner_write ON companies FOR ALL TO app_user
--     USING      (id IN (SELECT auth.user_admin_companies()))
--     WITH CHECK (id = app.current_company_id());
-- FOR ALL means the WITH CHECK also runs on INSERT. A newly-minted company's
-- gen_random_uuid() id can never equal the caller's currently-active company
-- id, so the INSERT is always rejected. Same logic-bug on cu_self_or_admin:
--   WITH CHECK (company_id = app.current_company_id())
-- blocks the owner row for the freshly-created company.
--
-- A permissive INSERT policy here would be a privilege-escalation hole —
-- any authenticated user could self-attach as admin to an arbitrary
-- company_id. Instead, follow the existing SECURITY DEFINER helper pattern
-- (auth.user_companies() etc. from mig 351): expose a function that
-- atomically creates the company + owner row while bypassing RLS, and
-- keep the raw INSERT blocked for app_user.

-- ──────────────────────────── Tighten policies ────────────────────────────
DROP POLICY IF EXISTS companies_owner_write ON public.companies;

-- No INSERT / DELETE policy for app_user — company creation goes through
-- public.create_company_with_owner() below; deletion is not a user action.
CREATE POLICY companies_admin_update ON public.companies FOR UPDATE TO app_user
  USING      (id IN (SELECT auth.user_admin_companies()))
  WITH CHECK (id IN (SELECT auth.user_admin_companies()));

DROP POLICY IF EXISTS cu_self_or_admin ON public.company_users;

CREATE POLICY cu_select ON public.company_users FOR SELECT TO app_user
  USING (
    user_id = auth.uid()
    OR company_id IN (SELECT auth.user_admin_companies())
  );

-- INSERT/UPDATE/DELETE restricted to admins of the target company. Owners
-- of a *new* company are attached by create_company_with_owner() which
-- bypasses RLS via SECURITY DEFINER.
CREATE POLICY cu_admin_write ON public.company_users FOR ALL TO app_user
  USING      (company_id IN (SELECT auth.user_admin_companies()))
  WITH CHECK (company_id IN (SELECT auth.user_admin_companies()));

-- ─────────────────── SECURITY DEFINER creation helper ────────────────────
CREATE OR REPLACE FUNCTION public.create_company_with_owner(payload jsonb)
  RETURNS public.companies
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  caller_id        text := auth.uid();
  is_first_company boolean;
  new_row          public.companies;
BEGIN
  IF caller_id IS NULL OR caller_id = '' THEN
    RAISE EXCEPTION 'create_company_with_owner: not authenticated';
  END IF;

  IF COALESCE(payload->>'name', '') = '' THEN
    RAISE EXCEPTION 'create_company_with_owner: name is required';
  END IF;

  INSERT INTO public.companies (
    name, registered_name, trading_name, registration_number, vat_number, tax_number,
    email, phone, website,
    address_line1, address_line2, city, province, postal_code, country,
    logo_data,
    bank_name, bank_account_number, bank_branch_code, bank_account_type,
    financial_year_start, vat_period, vat_period_alignment, default_currency
  ) VALUES (
    payload->>'name',
    payload->>'name',
    payload->>'tradingName',
    payload->>'registrationNumber',
    payload->>'vatNumber',
    payload->>'taxNumber',
    payload->>'email',
    payload->>'phone',
    payload->>'website',
    payload->>'addressLine1',
    payload->>'addressLine2',
    payload->>'city',
    payload->>'province',
    payload->>'postalCode',
    COALESCE(payload->>'country', 'South Africa'),
    payload->>'logoData',
    payload->>'bankName',
    payload->>'bankAccountNumber',
    payload->>'bankBranchCode',
    COALESCE(payload->>'bankAccountType', 'current'),
    COALESCE((payload->>'financialYearStart')::int, 3),
    COALESCE(payload->>'vatPeriod', 'bi-monthly'),
    COALESCE(payload->>'vatPeriodAlignment', 'odd'),
    COALESCE(payload->>'defaultCurrency', 'ZAR')
  ) RETURNING * INTO new_row;

  SELECT NOT EXISTS (
    SELECT 1 FROM public.company_users WHERE user_id = caller_id
  ) INTO is_first_company;

  INSERT INTO public.company_users (company_id, user_id, role, is_default)
  VALUES (new_row.id, caller_id, 'owner', is_first_company);

  RETURN new_row;
END;
$$;

REVOKE ALL ON FUNCTION public.create_company_with_owner(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_company_with_owner(jsonb) TO app_user, migration_admin;
