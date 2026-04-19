-- scripts/migrations/sql/354_drop_custom_2fa.sql
-- Phase 3b: Remove custom 2FA tables. GoTrue's auth.mfa_factors now owns TOTP.
-- Pre-cut verification: both tables had zero rows on prod and dev.
DROP INDEX IF EXISTS idx_trusted_devices_expiry;
DROP INDEX IF EXISTS idx_trusted_devices_user;
DROP INDEX IF EXISTS idx_user_2fa_user;
DROP TABLE IF EXISTS user_trusted_devices;
DROP TABLE IF EXISTS user_2fa;

-- platform_admin needs to read auth.mfa_factors for the admin reset flow.
-- Guard: only grant when GoTrue has already created the table.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'auth' AND table_name = 'mfa_factors'
  ) THEN
    EXECUTE 'GRANT SELECT ON TABLE auth.mfa_factors TO platform_admin';
  END IF;
END
$$;
