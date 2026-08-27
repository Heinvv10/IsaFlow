-- 516: auth.set_default_company — let a user change their OWN default company
-- under RLS.
--
-- company_users only has cu_admin_write (owner/admin). setDefaultCompany used
-- to run through withTransaction on a second superuser connection, which
-- bypassed RLS entirely; PR #264 makes withTransaction reuse the request
-- transaction (SET LOCAL ROLE app_user), so the UPDATE silently matched 0 rows
-- for manager/storeman/technician/viewer. A self-UPDATE policy would also let
-- a user edit their own `role`, so this is a SECURITY DEFINER function that
-- touches is_default only.
CREATE OR REPLACE FUNCTION auth.set_default_company(p_user_id UUID, p_company_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_caller TEXT := auth.uid()::TEXT;   -- auth.uid() is TEXT; compare as text so a forged sub fails cleanly (42501, not 22P02)
  v_updated INTEGER;
BEGIN
  -- Inside a request the caller may only change their own default. When
  -- auth.uid() is NULL (no JWT claims: cron/scripts) trusted server code may
  -- act for any user. NOTE: withPlatformAdmin DOES set claims, so a platform
  -- admin acting on behalf of a user hits 42501 by design — route such
  -- flows through an explicit admin path, not this function.
  IF v_caller IS NOT NULL AND v_caller <> p_user_id::TEXT THEN
    RAISE EXCEPTION 'set_default_company: caller % may not change default for %', v_caller, p_user_id
      USING ERRCODE = '42501';
  END IF;

  -- Membership first, so a non-member call writes nothing.
  IF NOT EXISTS (SELECT 1 FROM company_users WHERE user_id = p_user_id::TEXT AND company_id = p_company_id) THEN
    RAISE EXCEPTION 'set_default_company: user % is not a member of company %', p_user_id, p_company_id
      USING ERRCODE = 'P0002';
  END IF;

  -- company_users.user_id is TEXT, company_id is UUID: cast on the parameter side.
  UPDATE company_users
     SET is_default = (company_id = p_company_id)
   WHERE user_id = p_user_id::TEXT
     AND (is_default IS DISTINCT FROM (company_id = p_company_id));
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION auth.set_default_company(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.set_default_company(UUID, UUID) TO app_user;
