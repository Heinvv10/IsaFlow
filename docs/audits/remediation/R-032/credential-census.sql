-- R-032: candidate credentials minted during a platform-admin "Login as".
--
-- READ-ONLY. For Hein to run by hand (psql, a read-only role). Do not run from
-- CI or a script against production without that decision.
--
-- Before the R-032 fix, a Login-as session could mint bearer credentials as
-- the target. impersonation_sessions (migration 709) is new, so a credential
-- minted then is NOT PROVABLY attributable to the admin: this lists
-- CANDIDATES — credentials whose creator is an impersonated user and whose
-- created_at falls inside an impersonation window of that user.
--
-- Window: admin_audit_log 'impersonation_start' for the target, ending at the
-- matching 'impersonation_end' (same stash_id) or, if none, start + 1 hour (the
-- stash TTL). CAVEAT: end-impersonation did not revoke the target's GoTrue
-- session, so an admin could keep acting beyond the window; widen
-- :window_slack if that matters (default 0).
--
--   psql "$DB" -v window_slack="'0 minutes'" -f credential-census.sql

\set ON_ERROR_STOP on
\if :{?window_slack}
\else
  \set window_slack '''0 minutes'''
\endif

WITH starts AS (
  SELECT s.admin_user_id, s.target_id AS target_user_id, s.created_at AS started_at,
         s.details ->> 'stash_id' AS stash_id
  FROM admin_audit_log s
  WHERE s.action = 'impersonation_start' AND s.target_type = 'user'
),
windows AS (
  SELECT st.admin_user_id, st.target_user_id, st.started_at,
         COALESCE(
           (SELECT min(e.created_at) FROM admin_audit_log e
             WHERE e.action = 'impersonation_end'
               AND e.target_id = st.target_user_id
               AND e.details ->> 'stash_id' = st.stash_id
               AND e.created_at >= st.started_at),
           st.started_at + interval '1 hour'
         ) + :window_slack::interval AS ended_at
  FROM starts st
),
candidates AS (
  SELECT 'personal_access_token' AS kind, p.id::text AS credential_id, p.user_id::text AS owner,
         p.company_id::text AS company_id, p.created_at, (p.revoked_at IS NULL) AS still_live
    FROM personal_access_tokens p
  UNION ALL
  SELECT 'oauth_authorisation', a.id::text, a.user_id::text, a.company_id::text, a.created_at, (a.revoked_at IS NULL)
    FROM oauth_authorisations a
  UNION ALL
  SELECT 'oauth_app', o.id::text, o.owner_user_id::text, NULL, o.created_at, (o.revoked_at IS NULL)
    FROM oauth_apps o WHERE o.owner_user_id IS NOT NULL
  UNION ALL
  SELECT 'capture_api_key', k.id::text, k.created_by::text, k.company_id::text, k.created_at,
         (k.revoked_at IS NULL AND COALESCE(k.is_active, true))
    FROM capture_api_keys k WHERE k.created_by IS NOT NULL
  UNION ALL
  SELECT 'extension_pairing', b.id::text, b.created_by::text, b.company_id::text, b.created_at, COALESCE(b.is_active, true)
    FROM bank_feed_connections b WHERE b.created_by IS NOT NULL
)
SELECT c.kind, c.credential_id, c.owner AS target_user_id, c.company_id, c.created_at, c.still_live,
       w.admin_user_id, w.started_at AS window_start, w.ended_at AS window_end
FROM candidates c
JOIN windows w
  ON w.target_user_id = c.owner
 AND c.created_at BETWEEN w.started_at AND w.ended_at
ORDER BY c.still_live DESC, c.created_at;
