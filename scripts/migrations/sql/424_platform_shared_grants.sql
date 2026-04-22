-- 424_platform_shared_grants.sql
-- Grant app_user read/write on platform_shared so the fraud scan can
-- upsert templates, record observations, and query signals. The schema
-- is deliberately non-tenant-scoped (no RLS) because it holds only
-- anonymised / public data — the safety comes from the service layer,
-- not from Postgres.

GRANT USAGE ON SCHEMA platform_shared TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA platform_shared TO app_user;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA platform_shared TO app_user;

ALTER DEFAULT PRIVILEGES IN SCHEMA platform_shared
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform_shared
  GRANT USAGE ON SEQUENCES TO app_user;
