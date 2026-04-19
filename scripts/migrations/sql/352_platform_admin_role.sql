-- scripts/migrations/sql/352_platform_admin_role.sql
-- Phase 3: Platform-admin Postgres role for admin.isaflow.co.za runtime.
-- BYPASSRLS lets admin APIs read/write across all tenants without the
-- tenant_isolation policies blocking. Role is distinct from migration_admin
-- so runtime admin traffic is distinguishable in pg_stat_activity.
-- Password placeholder is rotated post-apply via ALTER ROLE — see Task 2.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_admin') THEN
    CREATE ROLE platform_admin
      WITH LOGIN BYPASSRLS NOINHERIT
      PASSWORD 'CHANGEME_SET_VIA_OPS';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public, auth, app TO platform_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO platform_admin;

-- Audit-log triggers that call auth.uid() / auth.user_companies() must be
-- executable under the platform_admin role even though BYPASSRLS skips the
-- policies themselves.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO platform_admin;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO platform_admin;

-- Future tables/sequences inherit the grants automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platform_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO platform_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth
  GRANT EXECUTE ON FUNCTIONS TO platform_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT EXECUTE ON FUNCTIONS TO platform_admin;
