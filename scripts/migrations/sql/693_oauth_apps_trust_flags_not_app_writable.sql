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
-- COLUMN PRIVILEGES ALONE DO NOT CLOSE THIS. A table's OWNER is never checked
-- against them, and the pool connects as `postgres`, which owns oauth_apps.
-- The routes that run as app_user are the ones that issue
-- `SET LOCAL ROLE app_user` (withAuth, bearerPipeline, withPlatformAdmin,
-- withExtensionToken, withInviteToken) — and the public, unauthenticated DCR
-- endpoint is NOT one of them: pages/api/oauth/register.ts is
-- `withErrorHandler(handler)` with no auth wrapper, so registerOauthApp's
-- INSERT runs as the owner. Verified: as the pool role, an INSERT naming both
-- flags TRUE succeeds and reads back true.
--
-- So the grants below are defence in depth for app_user, and the TRIGGER at
-- the bottom is what actually binds the property, because a BEFORE trigger
-- fires for every role including the owner.

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

-- ── The actual binding: a trigger, because it fires for the owner too ───────
-- RAISE rather than silently coercing the flags back. A silent coercion means
-- a future writer believes it set a flag, reads back false, and the mismatch
-- surfaces somewhere else entirely — the dormant-defect shape. A loud refusal
-- is a failing test on the branch that introduces it.
--
-- The escape hatch is deliberate and explicit: nothing in the application may
-- mark an app verified, but a human must be able to. `SET LOCAL
-- isaflow.allow_trust_flag_write = 'on'` inside the transaction that does it
-- makes that act visible in the statement log rather than indistinguishable
-- from an ordinary UPDATE.
--
-- Not absolute, and not claimed to be: a superuser can set
-- `session_replication_role = 'replica'` and skip every trigger. That is a
-- deliberate act by someone who already owns the database, which is a
-- different threat model from "a route grew a column in its INSERT list".
CREATE OR REPLACE FUNCTION oauth_apps_guard_trust_flags()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF coalesce(current_setting('isaflow.allow_trust_flag_write', true), '') = 'on' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A fresh row may only arrive untrusted. Both columns DEFAULT FALSE, so a
    -- writer that does not name them is unaffected.
    IF NEW.is_verified OR NEW.is_first_party THEN
      RAISE EXCEPTION
        'oauth_apps: is_verified/is_first_party may not be set by the application'
        USING HINT = 'These decide whether an app may brand the consent screen. '
                     'To change one deliberately, SET LOCAL isaflow.allow_trust_flag_write = ''on'' '
                     'in the same transaction.';
    END IF;
  ELSIF NEW.is_verified IS DISTINCT FROM OLD.is_verified
     OR NEW.is_first_party IS DISTINCT FROM OLD.is_first_party THEN
    -- IS DISTINCT FROM, not <>: these are NOT NULL today, but a nullable
    -- future column would make <> return NULL and skip the guard.
    RAISE EXCEPTION
      'oauth_apps: is_verified/is_first_party may not be changed by the application'
      USING HINT = 'SET LOCAL isaflow.allow_trust_flag_write = ''on'' in the same transaction.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS oauth_apps_guard_trust_flags_trg ON oauth_apps;
CREATE TRIGGER oauth_apps_guard_trust_flags_trg
  BEFORE INSERT OR UPDATE ON oauth_apps
  FOR EACH ROW EXECUTE FUNCTION oauth_apps_guard_trust_flags();

-- ── Post-condition: a REVOKE that granted nothing back still exits 0 ────────
-- Applying this file as a role that did not issue the original grants is a
-- silent no-op (a role may only revoke what it granted; these came from the
-- owner). The runner uses DATABASE_URL, which is the owner — but the failure
-- mode is invisible, the integration test is skipped in CI, and deploy.sh runs
-- this against production. So assert the outcome here, where it fails loudly
-- at apply time.
DO $$
BEGIN
  IF has_column_privilege('app_user', 'oauth_apps', 'is_verified', 'UPDATE')
     OR has_column_privilege('app_user', 'oauth_apps', 'is_first_party', 'UPDATE')
     OR has_column_privilege('app_user', 'oauth_apps', 'is_verified', 'INSERT')
     OR has_column_privilege('app_user', 'oauth_apps', 'is_first_party', 'INSERT') THEN
    RAISE EXCEPTION 'migration 693 did not take: app_user can still write a trust flag. '
                    'Re-apply as the owner of oauth_apps (a role can only revoke grants it issued).';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'oauth_apps'::regclass
      AND tgname = 'oauth_apps_guard_trust_flags_trg'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'migration 693 did not take: the trust-flag trigger is missing.';
  END IF;

  -- The writes the application legitimately makes must still work.
  IF NOT has_column_privilege('app_user', 'oauth_apps', 'revoked_at', 'UPDATE')
     OR NOT has_column_privilege('app_user', 'oauth_apps', 'client_id', 'INSERT') THEN
    RAISE EXCEPTION 'migration 693 over-revoked: app_user can no longer perform a legitimate write.';
  END IF;
END;
$$;
