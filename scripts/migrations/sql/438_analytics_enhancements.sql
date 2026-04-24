-- Production-grade analytics features: page titles, bot filtering, entry attribution.
-- Pairs with tracker update (isa-track.js sending document.title) and query service
-- additions (entry/exit pages, events report, channel classification, OS/lang breakdowns).

ALTER TABLE analytics_events
  ADD COLUMN IF NOT EXISTS page_title TEXT;

ALTER TABLE analytics_sessions
  ADD COLUMN IF NOT EXISTS is_bot     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS entry_path TEXT;

-- Bot filtering: partial index for fast "humans only" queries. All dashboards filter
-- WHERE is_bot = false by default; admin can toggle to include crawlers.
CREATE INDEX IF NOT EXISTS idx_sessions_humans
  ON analytics_sessions (website_id, last_seen DESC)
  WHERE is_bot = false;

-- entry_path is captured at session creation (first pageview's url_path). exit_path
-- is derived at query time (DISTINCT ON session_id ORDER BY created_at DESC).

COMMENT ON COLUMN analytics_events.page_title     IS 'document.title captured at pageview. Makes UUID-heavy paths like /accounting/customer-invoices/{uuid} readable.';
COMMENT ON COLUMN analytics_sessions.is_bot       IS 'Crawler/bot detected on ingest (googlebot, bingbot, etc.). Excluded from default dashboards.';
COMMENT ON COLUMN analytics_sessions.entry_path   IS 'First url_path of the session. Denormalised on insert for Entry Pages report.';
