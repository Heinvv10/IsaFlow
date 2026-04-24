-- PR-5 (L16): stash admin tokens encrypted at rest.
--
-- The columns stay TEXT — encryptToken() from src/lib/encryption.ts returns a
-- colon-separated hex string (iv:tag:ciphertext), which is already text-safe
-- and stays queryable. The only change this migration makes is to purge any
-- plaintext rows left over from the pre-encryption code path. The table has a
-- 1-hour TTL on each row (expires_at) and is only populated during an active
-- admin impersonation session, so in practice this DELETE affects at most a
-- handful of in-flight stashes and simply forces those admins to start a new
-- impersonation instead of using "Return to my session".
--
-- Idempotent: running twice deletes the same zero rows.
DELETE FROM admin_impersonation_stash;

COMMENT ON COLUMN admin_impersonation_stash.admin_access_token  IS
  'AES-256-GCM ciphertext (iv:tag:cipher hex). Encrypted via src/lib/encryption.ts::encryptToken.';
COMMENT ON COLUMN admin_impersonation_stash.admin_refresh_token IS
  'AES-256-GCM ciphertext (iv:tag:cipher hex). Encrypted via src/lib/encryption.ts::encryptToken.';
