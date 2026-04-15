-- BL-21: persistent rate-limit counters shared across pods.
-- Replaces the per-process LRU-only limiter (S-005).
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  key TEXT PRIMARY KEY,
  count INT NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rl_window_start ON rate_limit_counters (window_start);
