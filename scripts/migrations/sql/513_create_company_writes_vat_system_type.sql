-- 513: create_company_with_owner writes vat_system_type.
--
-- Verbatim from mig 476 with one change: the INSERT now sets vat_system_type,
-- derived from vatPeriod when the caller does not supply it. Without this the
-- onboarding wizard's "Not registered for VAT" choice wrote vat_period='none'
-- while vat_system_type kept its 'invoice' default (mig 245) — a disagreement
-- the AFS Note 1 generators read directly, producing "VAT is accounted for on
-- the invoice basis as registered with SARS" for a company that is not a VAT
-- vendor. Mig 512 backfills the rows that already exist.

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
    financial_year_start, vat_period, vat_period_alignment, vat_system_type, default_currency
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
    -- A company created as "not registered for VAT" sends vatPeriod='none';
    -- keep vat_system_type in step so the two columns never disagree, because
    -- the AFS accounting-policy notes read vat_system_type.
    COALESCE(
      payload->>'vatSystemType',
      CASE WHEN LOWER(TRIM(COALESCE(payload->>'vatPeriod', ''))) = 'none'
           THEN 'none' ELSE 'invoice' END
    ),
    COALESCE(payload->>'defaultCurrency', 'ZAR')
  ) RETURNING * INTO new_row;

  SELECT NOT EXISTS (
    SELECT 1 FROM public.company_users WHERE user_id = caller_id
  ) INTO is_first_company;

  INSERT INTO public.company_users (company_id, user_id, role, is_default)
  VALUES (new_row.id, caller_id, 'owner', is_first_company);

  -- New: seed the default taxonomy so every workbench/portfolio/AFS feature
  -- has the GL accounts and fiscal periods it expects on day 1.
  PERFORM public.seed_company_default_taxonomy(new_row.id);

  RETURN new_row;
END;
$$;

REVOKE ALL ON FUNCTION public.create_company_with_owner(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_company_with_owner(jsonb) TO app_user, migration_admin;
