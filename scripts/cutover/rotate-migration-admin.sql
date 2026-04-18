-- scripts/cutover/rotate-migration-admin.sql
-- Run as postgres superuser. Password passed via \set.
-- Usage: MIGRATION_ADMIN_PASSWORD='...' psql "$DATABASE_URL" -f scripts/cutover/rotate-migration-admin.sql
\set admin_pw `echo $MIGRATION_ADMIN_PASSWORD`
ALTER ROLE migration_admin WITH PASSWORD :'admin_pw';
