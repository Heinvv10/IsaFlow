-- migration: 687_platform_admin_approval_writes.sql
-- detect: SELECT NOT has_table_privilege('platform_admin','public.control_operation_approvals','DELETE') OR NOT has_table_privilege('platform_admin','public.control_operation_decisions','INSERT')
-- Undo the Sage branch's 687 (privileges only — no objects, hence the detect query). 688/689 change no table
-- privileges, so restoring the schema default (arwd) here is what the integration head carries.
REVOKE UPDATE (status, consumed_at, consumed_effect_id) ON control_operation_approvals FROM platform_admin;
GRANT INSERT, UPDATE, DELETE ON control_operation_approvals, control_operation_decisions TO platform_admin;
