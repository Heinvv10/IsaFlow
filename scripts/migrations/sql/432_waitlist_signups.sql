-- Pre-launch waitlist signups.
--
-- While we are marketing but not yet taking paying customers, every
-- "Start free trial" / "Create account" CTA on the public site routes
-- into a lead-capture form instead of the real register endpoint. Those
-- leads land here so we can contact people when we're ready to onboard.
--
-- Deliberately plain: no company_id (tenant doesn't exist yet), no FK
-- to users (these aren't user accounts). `email` is lower-cased and
-- uniquely indexed so we can no-op on re-submission.

CREATE TABLE IF NOT EXISTS waitlist_signups (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT,
  email          TEXT NOT NULL,
  company_name   TEXT,
  phone          TEXT,
  ip             TEXT,
  user_agent     TEXT,
  notified_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_waitlist_signups_email
  ON waitlist_signups (lower(email));

CREATE INDEX IF NOT EXISTS idx_waitlist_signups_created_at
  ON waitlist_signups (created_at DESC);

COMMENT ON TABLE waitlist_signups IS
  'Pre-launch lead capture — public /api/waitlist endpoint inserts here. Not tied to a company_id or user; promoted to a real account after launch.';
