-- Migration 466: Company-level idle-session timeout (PRD-10 Layer 1)
-- Browser session is bounced after this many minutes of zero activity.
-- Default 480 (8h) matches Sage/Xero parity for accountants.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS idle_timeout_minutes INTEGER NOT NULL DEFAULT 480;
