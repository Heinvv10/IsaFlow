-- Hein, 2026-09-11: a tenant 'owner' as well as an 'admin' may approve a
-- historical import. Additive: approver_role stays 'admin' (its CHECK is
-- untouched), and the allowance is its own column, so code that predates this
-- migration reads the policy exactly as before. On for every company, existing
-- and new (the seed trigger inserts company_id only, so the default applies).
ALTER TABLE control_mandatory_import_policies
 ADD COLUMN IF NOT EXISTS owner_may_approve boolean NOT NULL DEFAULT true;
-- A mandatory policy is approval authority; the schema's default privileges left
-- platform_admin able to rewrite or delete every one of them (their migrations
-- revoked only app_user) — an UPDATE of id voids open approvals, a DELETE blocks
-- the operation. The seed triggers are SECURITY DEFINER and need neither.
REVOKE UPDATE,DELETE,TRUNCATE ON control_mandatory_import_policies,control_mandatory_release_policies,
 control_mandatory_compensation_policies,control_mandatory_statement_policies,control_mandatory_match_override_policies
 FROM platform_admin;
