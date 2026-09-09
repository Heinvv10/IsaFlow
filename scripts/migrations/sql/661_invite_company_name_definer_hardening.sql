-- 661: harden the SECURITY DEFINER function migration 648 added.
-- (Renumbered from 655 so the owner fix below could be corrected without a
--  checksum conflict on databases that already ran it under the old number.)
--
-- Two defects in 648, neither of them a live hole on this schema, both of them
-- the kind that only stays safe by accident:
--
-- 1. `SET search_path = public, pg_catalog` puts a writable schema AHEAD of the
--    catalog. The body qualifies its tables but not now(), current_setting() or
--    its operators, so any role holding CREATE on schema `public` could shadow
--    one of those and have it run with the function's rights. app_user does not
--    hold that privilege (PostgreSQL 16 revokes it from PUBLIC), but
--    migration_admin does, so as written it is a migration_admin -> owner step.
--
-- 2. DATABASE_URL is the `postgres` role in .env.local and .env.production and
--    scripts/migrations/apply-migrations.ts connects with it, so 648 created the
--    function OWNED BY A SUPERUSER. SECURITY DEFINER runs as the owner.
--
-- Re-create it with the catalog pinned first and hand it to migration_admin,
-- which has rolbypassrls -- the one privilege the body actually needs, since it
-- reads company_invitations and companies through FORCE RLS.
--
-- Idempotent: CREATE OR REPLACE, and the owner change is a no-op on re-run.
-- Editing 648 in place was not an option: apply-migrations.ts refuses on a
-- checksum mismatch rather than skipping, so every database that already ran
-- 648 would fail db:migrate outright.

CREATE OR REPLACE FUNCTION public.invite_token_company_name()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
-- pg_catalog FIRST: a SECURITY DEFINER body must not resolve any name --
-- function, operator or type -- through a schema a lesser role can write to.
SET search_path = pg_catalog, public
AS $$
  SELECT c.name
  FROM public.company_invitations ci
  JOIN public.companies c ON c.id = ci.company_id
  WHERE ci.token = nullif(current_setting('app.invite_token', true), '')
    AND ci.accepted_at IS NULL
    AND ci.expires_at > now()
  LIMIT 1
$$;

-- Unconditional, and deliberately so. This ALTER is the one statement that
-- carries the security property: without it CREATE OR REPLACE above has just
-- (re-)created the function owned by whatever DATABASE_URL connects as, which
-- is the superuser `postgres` in .env.local and .env.production -- the exact
-- defect this migration exists to close. Guarding it on the role's existence
-- made the hardening silently absent, with a success report, on any database
-- lacking the role. migration_admin is created by 348_rls_and_auth_helpers.sql
-- and granted to unconditionally there, so a database that reaches this point
-- without it is broken and must fail loudly.
ALTER FUNCTION public.invite_token_company_name() OWNER TO migration_admin;

-- CREATE OR REPLACE keeps the existing ACL, but re-state it so the grant does
-- not depend on 648 having run first on a database restored from elsewhere.
REVOKE ALL ON FUNCTION public.invite_token_company_name() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.invite_token_company_name() TO app_user;
