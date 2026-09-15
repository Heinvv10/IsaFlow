-- Cluster roles the fixture schema depends on. Hand-written, not dumped: pg_dumpall --roles-only
-- emits the source cluster's SCRAM password hashes, which must never enter the repository.
-- fixture-up.sh sets throwaway loopback-only passwords after running this.
--
-- Attributes mirror the live cluster (checked against the forensic fixture 2026-09-14):
--   app_user        NOLOGIN, no BYPASSRLS  — tests SET LOCAL ROLE to it; every tenant_isolation
--                   policy is FOR ALL TO app_user, so BYPASSRLS here would void the whole suite.
--   migration_admin LOGIN, BYPASSRLS       — owns 238 objects in the dump, including 12 SECURITY
--                   DEFINER functions. Must exist before schema.sql restores.
--   platform_admin  LOGIN, BYPASSRLS       — the admin-plane role the control guards fence off.
CREATE ROLE app_user;
ALTER ROLE app_user WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;

CREATE ROLE migration_admin;
ALTER ROLE migration_admin WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION BYPASSRLS;

CREATE ROLE platform_admin;
ALTER ROLE platform_admin WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION BYPASSRLS;

-- No role memberships: the source cluster has none (pg_auth_members is empty for these three).
-- 348_rls_and_auth_helpers.sql does "GRANT app_user TO postgres", but the live cluster does not
-- carry it and the tests do not need it — postgres is superuser, so SET LOCAL ROLE app_user works
-- without membership. Granting it here would make the fixture differ from the thing it models.
