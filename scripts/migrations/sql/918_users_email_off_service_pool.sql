-- Migration 918: the service pool can no longer write users.email, directly or
-- through the email-verification tokens that verify-email turns into one.
--
-- S-07b follow-up A (2026-10-23). 915 granted app_service UPDATE (email,
-- updated_at) on users for change-email and the POPIA erasure, and documented
-- the cost as a deliberate residual: injected SQL on any isaflow_service path
-- (crons, webhooks, login/reset/verify, withUserAuth routes) could rewrite any
-- user's email, and an email is privilege-bearing (createInvitation adds an
-- EXISTING users row to the inviting company when its email matches; see 902).
-- Both writers now run on the migration_admin pool from fixed, parameterised
-- statements keyed on the verified session's user id, as the invite routes
-- do, so that residual is closed here. 915's text is left as applied.
--
-- Census of users.email writers (2026-10-23), by the role each runs as:
--   migration_admin  pages/api/auth/change-email.ts (UPDATE email, updated_at)
--                    pages/api/accounting/data-subject-rights.ts erasure
--                      (UPDATE first_name, last_name, email, updated_at)
--                    verify-email -> tenantProvisioningService (INSERT ...
--                      ON CONFLICT (id) DO UPDATE SET email)
--                    pages/api/invitations/[token]/accept.ts (INSERT)
--   owner (scripts)  scripts/sandbox/reviewerSandboxIdentity.ts (INSERT)
-- No app_user, app_service or platform_admin path writes email. updated_at
-- goes too: no service-pool writer of users remains, and the BEFORE UPDATE
-- trigger update_users_updated_at sets it without a privilege of its own.
--
-- The REVOKE names the columns: app_service never held table-level UPDATE on
-- users directly (it inherits app_user's, which 902 cut to five columns).

REVOKE UPDATE (email, updated_at) ON public.users FROM app_service;

-- auth_email_verification_tokens (owner migration_admin, no RLS): 915 granted
-- app_service every command on it for emailVerificationService. A token's
-- payload email is what verify-email (migration_admin pool) provisions into
-- users.email, ON CONFLICT (id) DO UPDATE SET email included, and verify-email
-- confirms the token's GoTrue user. So a service-pool injection that inserts a
-- token with a hash it chose and any address in the payload, then follows its
-- own link, writes users.email by proxy (S-07b follow-ups breaker, round 2).
-- emailVerificationService now runs every statement on the migration_admin
-- pool; neither app pool may read the table either (the payloads carry names,
-- phone numbers and addresses).
REVOKE ALL ON public.auth_email_verification_tokens FROM app_service, app_user, PUBLIC;

-- 920 refuses the deploy if any role either app login reaches can still
-- INSERT or UPDATE users.email, or write the tokens table (a grant from another grantor, a table-level grant, or one
-- reaching a login through a role it can SET ROLE to survives the REVOKE
-- above), and scripts/check-app-login-roles.ts re-checks it on every deploy.
