-- PRD-05 Phase 6 follow-up: opt-in gating for the daily chase cron.
--
-- Auto-sending chase emails to real suppliers is risky (PRD §9). Gate it
-- behind explicit opt-in at both levels:
--   1. Company-level: chase_auto_send_enabled must be true for the company.
--   2. Supplier-level: chase_opted_out lets the user mute auto-chase per
--      supplier even when the company-level flag is on.
--   3. Grace period: chase_grace_days is the minimum age of a pending alert
--      before the cron auto-chases it.
--
-- Until a company flips chase_auto_send_enabled=true, the cron only runs the
-- detect-gaps scan — alerts appear in the UI but nothing goes out the wire.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS chase_auto_send_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS chase_grace_days        INTEGER NOT NULL DEFAULT 3
    CHECK (chase_grace_days BETWEEN 0 AND 30);

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS chase_opted_out BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_companies_chase_auto
  ON companies(id) WHERE chase_auto_send_enabled = TRUE;
