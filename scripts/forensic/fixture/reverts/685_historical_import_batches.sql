-- migration: 685_historical_import_batches.sql
-- detect: SELECT to_regclass('public.control_historical_import_batches') IS NOT NULL OR NOT has_table_privilege('platform_admin','public.control_historical_imports','DELETE')
-- Undo the Sage branch's 685. control_approval_authorities (which 685 replaces) is restored by schema-match.ts
-- from the commit's own latest definition, so it is not repeated here.
DROP TABLE IF EXISTS control_historical_import_batch_members, control_historical_import_batches;
DROP FUNCTION IF EXISTS control_historical_import_batch_member_guard();
DROP FUNCTION IF EXISTS control_historical_import_batch_complete();
-- 685 revoked UPDATE,DELETE,TRUNCATE from platform_admin; the schema default (before 685) is arwd.
GRANT UPDATE, DELETE ON control_historical_imports, control_historical_import_sources TO platform_admin;
