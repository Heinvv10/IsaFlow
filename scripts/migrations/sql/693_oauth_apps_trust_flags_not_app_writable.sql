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
-- The trigger is ENABLE ALWAYS, and that is load-bearing rather than tidy.
-- `session_replication_role = 'replica'` skips every ordinary ('O') trigger,
-- and setting it does NOT require superuser: on this cluster `postgres` has
-- rolsuper = f and still set it, then flipped is_first_party to true with the
-- trigger installed. That role is exactly the pool role the anonymous DCR
-- endpoint runs as, so the bypass sat on the path this guard exists for.
-- Verified both ways on dev: as 'O' the replica-mode UPDATE returned UPDATE 1
-- and read back true; as 'A' the identical sequence raises. `app_user` cannot
-- set the parameter at all ("permission denied to set parameter").
--
-- Still not absolute, and not claimed to be: anyone who can execute arbitrary
-- SQL as the owner can DROP the trigger. The property this defends is "a route
-- grew a column in its INSERT list", not "an attacker already has psql".
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
DROP TRIGGER IF EXISTS oauth_apps_guard_trust_flags_after_trg ON oauth_apps;
CREATE TRIGGER oauth_apps_guard_trust_flags_trg
  BEFORE INSERT OR UPDATE ON oauth_apps
  FOR EACH ROW EXECUTE FUNCTION oauth_apps_guard_trust_flags();

-- ALWAYS, not the 'O' a bare CREATE TRIGGER gives — see above. Note that a
-- later `ALTER TABLE ... ENABLE TRIGGER` silently downgrades this back to 'O'
-- and re-opens the bypass, which is why the post-condition asserts the MODE
-- and not merely the trigger's existence.
ALTER TABLE oauth_apps ENABLE ALWAYS TRIGGER oauth_apps_guard_trust_flags_trg;

-- ── The BEFORE trigger alone is a convention, not a guard ───────────────────
-- BEFORE row triggers fire in NAME order and each one's returned NEW feeds the
-- next, so a trigger sorting after `oauth_apps_guard_...` can set a flag on a
-- row this guard already approved. The row the guard checked is then not the
-- row that lands. Reproduced on dev: with a `zz_later` BEFORE INSERT trigger
-- doing `NEW.is_verified := TRUE`, an INSERT naming NO flag stored
-- is_verified = t and raised nothing.
--
-- An AFTER row trigger sees the row as actually stored and cannot be
-- pre-empted, because AFTER triggers cannot modify NEW. So the AFTER one is
-- what binds; the BEFORE one is kept because it fails earlier and its error
-- names the offending statement more usefully. Same function: the checks are
-- identical and an AFTER trigger's return value is ignored.
CREATE TRIGGER oauth_apps_guard_trust_flags_after_trg
  AFTER INSERT OR UPDATE ON oauth_apps
  FOR EACH ROW EXECUTE FUNCTION oauth_apps_guard_trust_flags();

ALTER TABLE oauth_apps ENABLE ALWAYS TRIGGER oauth_apps_guard_trust_flags_after_trg;

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

  -- BOTH triggers, BOTH ALWAYS. 'A' = ALWAYS; an existence-only check passes
  -- on a trigger downgraded to 'O', which is green while the replica-mode
  -- bypass is wide open. And the AFTER one is the one that survives a
  -- later-sorting BEFORE trigger, so its absence is not cosmetic.
  IF (
    SELECT count(*) FROM pg_trigger
    WHERE tgrelid = 'oauth_apps'::regclass
      AND tgname IN ('oauth_apps_guard_trust_flags_trg',
                     'oauth_apps_guard_trust_flags_after_trg')
      AND NOT tgisinternal
      AND tgenabled = 'A'
  ) <> 2 THEN
    RAISE EXCEPTION 'migration 693 did not take: a trust-flag trigger is missing '
                    'or is not ENABLE ALWAYS (session_replication_role would skip it, '
                    'and without the AFTER trigger a later-sorting BEFORE trigger can '
                    'rewrite a row this guard approved).';
  END IF;

  -- The writes the application legitimately makes must still work.
  IF NOT has_column_privilege('app_user', 'oauth_apps', 'revoked_at', 'UPDATE')
     OR NOT has_column_privilege('app_user', 'oauth_apps', 'client_id', 'INSERT') THEN
    RAISE EXCEPTION 'migration 693 over-revoked: app_user can no longer perform a legitimate write.';
  END IF;
END;
$$;
