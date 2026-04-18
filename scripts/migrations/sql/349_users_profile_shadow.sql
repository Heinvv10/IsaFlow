-- scripts/migrations/sql/349_users_profile_shadow.sql
-- Phase 2: GoTrue owns email/password/verification; trim the shadow table.

ALTER TABLE public.users DROP COLUMN IF EXISTS password_hash;
ALTER TABLE public.users DROP COLUMN IF EXISTS email_verified;
ALTER TABLE public.users DROP COLUMN IF EXISTS password_reset_token;
ALTER TABLE public.users DROP COLUMN IF EXISTS password_reset_expires;
ALTER TABLE public.users DROP COLUMN IF EXISTS failed_login_attempts;
ALTER TABLE public.users DROP COLUMN IF EXISTS locked_until;
ALTER TABLE public.users DROP COLUMN IF EXISTS must_change_password;
ALTER TABLE public.users DROP COLUMN IF EXISTS last_login;
ALTER TABLE public.users DROP COLUMN IF EXISTS last_login_ip;
ALTER TABLE public.users DROP COLUMN IF EXISTS login_count;

-- Keep: id, email, first_name, last_name, role (app role, not auth role),
--       permissions, phone, department, profile_picture, is_active,
--       created_at, updated_at, onboarding_completed, mobile, status,
--       suspended_at, suspended_reason.
-- `email` is denormalised; we sync it in upsertUserProfile.
