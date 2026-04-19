-- scripts/migrations/sql/354_drop_custom_2fa.sql
-- Phase 3b: Remove custom 2FA tables. GoTrue's auth.mfa_factors now owns TOTP.
-- Pre-cut verification: both tables had zero rows on prod and dev.
--
-- Note: we previously considered granting SELECT on auth.mfa_factors to
-- platform_admin for the admin reset endpoint. That turned out to be the
-- wrong approach — auth.mfa_factors lives in the shared `postgres` database
-- (GoTrue's single-DB convention), not per-app, so cross-DB SQL would not
-- work. The admin reset endpoint uses GoTrue's HTTP admin API instead.
DROP INDEX IF EXISTS idx_trusted_devices_expiry;
DROP INDEX IF EXISTS idx_trusted_devices_user;
DROP INDEX IF EXISTS idx_user_2fa_user;
DROP TABLE IF EXISTS user_trusted_devices;
DROP TABLE IF EXISTS user_2fa;
