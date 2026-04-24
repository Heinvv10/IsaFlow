-- Migration 447: waitlist signup promotion tracking.
--
-- When a pre-launch waitlist lead is promoted to a real tenant, we stamp
-- `promoted_at` + `promoted_company_id` on the signup row so the admin UI
-- can separate pending leads from already-onboarded ones, and the audit
-- trail has a clean pointer from lead → company.

ALTER TABLE waitlist_signups
  ADD COLUMN IF NOT EXISTS promoted_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS promoted_company_id UUID REFERENCES companies(id) ON DELETE SET NULL;

-- Pending leads first (promoted_at IS NULL), newest first.
CREATE INDEX IF NOT EXISTS idx_waitlist_signups_pending
  ON waitlist_signups (created_at DESC)
  WHERE promoted_at IS NULL;

COMMENT ON COLUMN waitlist_signups.promoted_at IS
  'Timestamp when an admin promoted this lead into a real companies row. NULL = still pending.';
COMMENT ON COLUMN waitlist_signups.promoted_company_id IS
  'FK to the companies row created when this lead was promoted. NULL while pending.';
