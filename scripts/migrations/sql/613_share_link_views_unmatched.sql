-- scripts/migrations/sql/613_share_link_views_unmatched.sql
-- WS3: a hit on a token that matches NO link is audited too.
--
-- The public share route promises one neutral outcome for unknown, expired and
-- revoked links: same page, same 404, same props. It was not one outcome in
-- the database. A token that matched a dead row wrote a share_link_views row;
-- a token that matched nothing wrote none — so the two answers took
-- measurably different amounts of work, and a caller walking tokens could tell
-- "this link was withdrawn" from "this link never existed" by timing the
-- response. That is the oracle the neutral page exists to close.
--
-- The fix is to audit the unmatched hit as well, which needs a row that names
-- no link and no company, because there is no link and therefore no company to
-- name. Inventing one would be a fabrication in an audit table and would file
-- a stranger's probe under a tenant that had nothing to do with it.
--
-- The RLS policies on this table are unchanged and still correct: they read
-- `company_id IN (SELECT auth.user_companies())`, and a NULL company_id is in
-- no tenant's set, so an unmatched-probe row is invisible to every company.
-- It belongs to the platform, not to a customer. The public route writes it on
-- the pool connection, which bypasses RLS.
--
-- No DML. Existing rows all matched a link by construction and keep their ids.

ALTER TABLE share_link_views ALTER COLUMN share_link_id DROP NOT NULL;
ALTER TABLE share_link_views ALTER COLUMN company_id DROP NOT NULL;

-- 610 wrote this CHECK with three outcomes. Recreate it with the fourth rather
-- than adding a second constraint, so there is one statement of the legal set.
ALTER TABLE share_link_views DROP CONSTRAINT IF EXISTS share_link_views_outcome_chk;
ALTER TABLE share_link_views
  ADD CONSTRAINT share_link_views_outcome_chk
  CHECK (outcome IN ('ok', 'expired', 'revoked', 'not_found'));

-- A row naming no link may only be a not_found probe. Anything else with a
-- NULL link id is a bug that would otherwise sit in the audit trail unnoticed.
ALTER TABLE share_link_views DROP CONSTRAINT IF EXISTS share_link_views_identity_chk;
ALTER TABLE share_link_views
  ADD CONSTRAINT share_link_views_identity_chk
  CHECK (
    (share_link_id IS NOT NULL AND company_id IS NOT NULL)
    OR (share_link_id IS NULL AND company_id IS NULL AND outcome = 'not_found')
  );

COMMENT ON COLUMN share_link_views.share_link_id IS
  'The link that was presented. NULL only for an outcome of not_found, where the token matched no row at all.';
