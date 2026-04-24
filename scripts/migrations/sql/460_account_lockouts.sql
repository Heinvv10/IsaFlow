-- PR-3 (M24): hard lockout after N consecutive failed login attempts.
-- Keyed on (email, ip) composite to defuse the lockout-amplification DoS
-- (an attacker at one IP cannot lock the real user out from their own IP).
CREATE TABLE IF NOT EXISTS account_lockouts (
  email           TEXT        NOT NULL,
  ip              TEXT        NOT NULL,
  failed_count    INTEGER     NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  last_failed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (email, ip)
);

CREATE INDEX IF NOT EXISTS idx_account_lockouts_locked_until
  ON account_lockouts (locked_until)
  WHERE locked_until IS NOT NULL;
