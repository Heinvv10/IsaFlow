-- 999u: employee self-service portal logins (wave 6 SS). Schema only; nothing here invites or signs anyone in.
--
-- WHAT.
--   employee_portal_access  one login per (company, employee), modelled on portal_access (937/977): a separate
--     login with its own session cookie and no GoTrue membership. status invited -> active (the employee chose a
--     password through the emailed link) -> revoked (a person at the employer ended it). The invite link carries a
--     random token; only its sha256 is stored (invite_token_hash), and it lapses at invite_expires_at.
--     session_version is signed into the portal cookie; revoking bumps it, so every outstanding session ends.
--     A leaver's access is not a column: it is judged from payroll_employees.end_date on every login and request
--     (read-only until the end of the next tax year, §0a.14).
--   payroll_company_settings.employee_portal_enabled  created by 999a (off); app_user may now INSERT and UPDATE that
--     one column. Invites and login also need the platform switch payroll_employee_portal (999a, off), checked first
--     (rule 20, grill F7).
--
-- PRIVILEGES (937's rule for credential tables: only privileges hold against forged claims). app_user (and so
--   app_service and both logins) may SELECT every column but password_hash and invite_token_hash, and write
--   nothing: every write (invite, accept, revoke) runs on migration_admin from fixed statements keyed on ids the
--   TypeScript layer verified, as the AR portal login does. FORCE RLS with the active-company tenant_isolation
--   policy (977's form) and app_service's mirrors (the portal's session check reads through them, by id).
--   No SECURITY DEFINER function, so no app_definer_reviews row.
--
-- OLD COLOUR (the release before this one, running against this schema while the deploy switches colours):
--   nothing old reads or writes employee_portal_access or the new column grant. Additive.
--
-- LOCKS. A new table; one GRANT on payroll_company_settings (brief). Bounded by lock_timeout.
--
-- Rollback (down SQL; roll the code back first, to a release that never reads these):
--   DROP TABLE IF EXISTS public.employee_portal_access;
--   REVOKE INSERT (employee_portal_enabled), UPDATE (employee_portal_enabled) ON public.payroll_company_settings FROM app_user;
--   SELECT public.app_service_sync_policies();

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.employee_portal_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.payroll_employees(id) ON DELETE CASCADE,
  email TEXT NOT NULL CHECK (char_length(email) <= 254 AND email ~ '^[^@\s,;<>"()\[\]\\[:cntrl:]]+@[^@\s,;<>"()\[\]\\[:cntrl:]]+\.[^@\s,;<>"()\[\]\\[:cntrl:]]+$'),
  password_hash TEXT,
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'revoked')),
  invite_token_hash TEXT CHECK (invite_token_hash ~ '^[0-9a-f]{64}$'),
  invite_expires_at TIMESTAMPTZ,
  invited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  invited_by TEXT NOT NULL,
  activated_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT,
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, employee_id),
  CHECK (status <> 'active' OR (password_hash IS NOT NULL AND activated_at IS NOT NULL)),
  CHECK (status <> 'invited' OR (invite_token_hash IS NOT NULL AND invite_expires_at IS NOT NULL)),
  CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS employee_portal_access_invite_token_key
  ON public.employee_portal_access (invite_token_hash) WHERE invite_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS employee_portal_access_email_idx
  ON public.employee_portal_access (lower(email)) WHERE status = 'active';

COMMENT ON TABLE public.employee_portal_access IS
  'Wave 6 SS (999u): an employee''s self-service portal login. Written on migration_admin only; app roles read all but the secrets.';

ALTER TABLE public.employee_portal_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_portal_access FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.employee_portal_access;
CREATE POLICY tenant_isolation ON public.employee_portal_access FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));

REVOKE ALL ON public.employee_portal_access FROM app_user, PUBLIC;
DO $$
BEGIN
  IF pg_catalog.to_regrole('app_service') IS NOT NULL THEN
    REVOKE ALL ON public.employee_portal_access FROM app_service;
  END IF;
END $$;
GRANT SELECT (id, company_id, employee_id, email, status, invite_expires_at, invited_at, invited_by, activated_at,
              last_login_at, revoked_at, revoked_by, session_version, created_at, updated_at)
  ON public.employee_portal_access TO app_user;

-- The writes run on migration_admin (BYPASSRLS): refuse, before the code switch, a database where it could not.
DO $$
DECLARE
  p text;
BEGIN
  IF pg_catalog.to_regrole('migration_admin') IS NULL THEN RETURN; END IF;
  GRANT SELECT, INSERT, UPDATE ON public.employee_portal_access TO migration_admin;
  FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE'] LOOP
    IF NOT pg_catalog.has_table_privilege('migration_admin', 'public.employee_portal_access', p) THEN
      RAISE EXCEPTION '999u: migration_admin cannot % employee_portal_access, which the SS code writes on it', p;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'migration_admin' AND NOT rolbypassrls) THEN
    RAISE EXCEPTION '999u: migration_admin must bypass row security, which the SS code relies on';
  END IF;
END $$;

-- ── The company switch (999a made the column; app_user may now set it) ───
GRANT INSERT (employee_portal_enabled) ON public.payroll_company_settings TO app_user;
GRANT UPDATE (employee_portal_enabled) ON public.payroll_company_settings TO app_user;

SELECT public.app_service_sync_policies();

-- No app role may write the table or read its secrets (checked after the mirrors exist).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname IN ('app_user', 'app_service') LOOP
    IF pg_catalog.has_any_column_privilege(r.rolname, 'public.employee_portal_access', 'INSERT')
       OR pg_catalog.has_any_column_privilege(r.rolname, 'public.employee_portal_access', 'UPDATE')
       OR pg_catalog.has_table_privilege(r.rolname, 'public.employee_portal_access', 'DELETE')
       OR pg_catalog.has_column_privilege(r.rolname, 'public.employee_portal_access', 'password_hash', 'SELECT')
       OR pg_catalog.has_column_privilege(r.rolname, 'public.employee_portal_access', 'invite_token_hash', 'SELECT') THEN
      RAISE EXCEPTION '999u: % can write employee_portal_access or read its secrets', r.rolname;
    END IF;
  END LOOP;
END $$;
