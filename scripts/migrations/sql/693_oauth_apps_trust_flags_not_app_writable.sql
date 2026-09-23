-- Migration 693: the oauth_apps trust flags are not writable by the app role.
--
-- `is_verified` and `is_first_party` decide whether an OAuth app may put its
-- own description, logo and homepage link on the consent and revoke screens,
-- and whether it wears a "Verified" badge there. Nothing in the application
-- sets either one — they are set by hand — so no code path needs to write them.
--
-- The database did not say so. Migration 348 grants app_user table-level
-- INSERT/UPDATE on every table in `public`, and the RLS policy on oauth_apps
-- (mig 469) is `FOR ALL ... USING (owner_user_id = auth.uid())`, which scopes
-- writes to the owner's own ROW while saying nothing about which COLUMNS.
-- A registrant therefore owns a row on which the trust flags are writable.
-- Not exploitable today, because the only UPDATE the code issues is
-- `SET revoked_at = NOW()` and the INSERT column list omits both flags — but
-- the first route that spreads request-body fields into a write turns the gate
-- off silently, and consentAppView would honour the forged flag.
--
-- A COLUMN-LEVEL REVOKE ALONE WOULD BE A NO-OP HERE. Postgres keeps the
-- table-level privilege when you revoke a column-level one, so
-- `REVOKE UPDATE (is_verified) ...` against mig 348's table-wide grant changes
-- nothing. The revoke has to be at table level, then the legitimate columns
-- granted back explicitly. Same reason a REVOKE of a privilege held via PUBLIC
-- does nothing.
--
-- Fails closed by construction: a future writer that names a column absent
-- from these lists gets "permission denied for table oauth_apps", which is a
-- loud test failure, not a silent privilege escalation.

-- ── UPDATE: revokeOauthApp only ever sets revoked_at (src/lib/auth/oauth.ts) ──
REVOKE UPDATE ON oauth_apps FROM app_user;
GRANT UPDATE (revoked_at) ON oauth_apps TO app_user;

-- ── INSERT: exactly the columns registerOauthApp names ──────────────────────
-- id, created_at and updated_at are omitted deliberately: they are supplied by
-- column DEFAULTs, and a column the writer never names needs no privilege.
REVOKE INSERT ON oauth_apps FROM app_user;
GRANT INSERT (
  name, description, logo_url, homepage_url, redirect_uris,
  client_id, client_secret_hash, client_secret_prefix, owner_user_id,
  is_dynamic, token_endpoint_auth_method
) ON oauth_apps TO app_user;

-- SELECT and DELETE are unchanged: reads are already row-scoped by the RLS
-- policy, and pruneStaleDynamicApps deletes whole rows it owns.
