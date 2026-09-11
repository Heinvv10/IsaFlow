-- The schema's default privileges gave platform_admin (BYPASSRLS) INSERT, UPDATE
-- and DELETE on control_operation_approvals and control_operation_decisions,
-- with no trigger on either (627 revoked only app_user). A decision row is the
-- proof of an independent approval: one written on the platform path naming a
-- real tenant owner would pass the execution recheck and post.
--
-- What the platform-import path actually does, as platform_admin: request
-- (INSERT an approval), read the approval and its decisions, lock the approval
-- FOR UPDATE, and consume it (UPDATE status, consumed_at, consumed_effect_id).
-- Decisions are written only from a tenant member's cookie session (app_user).
REVOKE UPDATE,DELETE,TRUNCATE ON control_operation_approvals FROM platform_admin;
GRANT SELECT,INSERT ON control_operation_approvals TO platform_admin;
GRANT UPDATE(status,consumed_at,consumed_effect_id) ON control_operation_approvals TO platform_admin;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON control_operation_decisions FROM platform_admin;
GRANT SELECT ON control_operation_decisions TO platform_admin;
