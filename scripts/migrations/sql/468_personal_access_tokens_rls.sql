-- Migration 468: RLS on personal_access_tokens (PRD-10 Layer 3 review fix)
-- The auto-RLS DO-block in mig 348 ran before mig 467 created this table, so
-- RLS was never enabled. Tokens are user-bound secrets — every read must be
-- scoped to the owning user.

ALTER TABLE personal_access_tokens ENABLE ROW LEVEL SECURITY;

-- Owner-only read/write/delete. PAT mint/list/revoke endpoints all run as the
-- token's owner inside withAuth's app_user transaction, so this single policy
-- covers all flows. Bearer-authed requests do not query this table directly —
-- they go through validatePat() which runs on the privileged default pool
-- outside the RLS scope.
CREATE POLICY pat_owner ON personal_access_tokens
  FOR ALL TO app_user
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
