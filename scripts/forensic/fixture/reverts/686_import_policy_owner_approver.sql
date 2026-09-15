-- migration: 686_import_policy_owner_approver.sql
-- detect: SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='control_mandatory_import_policies' AND column_name='owner_may_approve') OR NOT has_table_privilege('platform_admin','public.control_mandatory_import_policies','DELETE')
-- Undo the Sage branch's 686. Any function it replaced is restored by schema-match.ts from the commit.
ALTER TABLE control_mandatory_import_policies DROP COLUMN IF EXISTS owner_may_approve;
-- 686 revoked UPDATE,DELETE,TRUNCATE from platform_admin on every mandatory policy table; default is arwd.
GRANT UPDATE, DELETE ON control_mandatory_import_policies, control_mandatory_release_policies,
  control_mandatory_compensation_policies, control_mandatory_statement_policies, control_mandatory_match_override_policies TO platform_admin;
