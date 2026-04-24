-- UTM campaign attribution for web analytics.
-- Captures utm_source/medium/campaign/term/content from the URL query string on
-- first hit of a session. First-touch wins (preserve original values on update)
-- so later pageviews in the same session don't overwrite attribution.

ALTER TABLE analytics_sessions
  ADD COLUMN IF NOT EXISTS utm_source   TEXT,
  ADD COLUMN IF NOT EXISTS utm_medium   TEXT,
  ADD COLUMN IF NOT EXISTS utm_campaign TEXT,
  ADD COLUMN IF NOT EXISTS utm_term     TEXT,
  ADD COLUMN IF NOT EXISTS utm_content  TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_utm_source
  ON analytics_sessions (website_id, utm_source)
  WHERE utm_source IS NOT NULL;

COMMENT ON COLUMN analytics_sessions.utm_source IS 'First-touch attribution from ?utm_source=. Preserved across later pageviews in same session.';
