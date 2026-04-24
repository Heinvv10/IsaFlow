-- Privacy-friendly web analytics (Umami-style schema adapted for ISAFlow multi-tenant).
--
-- Three tables: websites (trackable properties), sessions (visitor fingerprints with
-- daily-rotating salt so hashes aren't reversible across days), and events (pageviews +
-- custom events, 180-day retention).
--
-- company_id on analytics_websites is nullable so platform-level traffic (marketing site,
-- admin platform) can be tracked too. Tenant portal traffic uses per-company rows.

CREATE TABLE IF NOT EXISTS analytics_websites (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID REFERENCES companies(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  tracking_id    TEXT NOT NULL UNIQUE,
  domain         TEXT,
  category       TEXT NOT NULL CHECK (category IN ('marketing','app','admin','portal')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_analytics_websites_company  ON analytics_websites(company_id);
CREATE INDEX IF NOT EXISTS idx_analytics_websites_tracking ON analytics_websites(tracking_id);

CREATE TABLE IF NOT EXISTS analytics_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  website_id     UUID NOT NULL REFERENCES analytics_websites(id) ON DELETE CASCADE,
  session_hash   TEXT NOT NULL,
  visitor_hash   TEXT NOT NULL,
  user_id        VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  country        CHAR(2),
  region         TEXT,
  city           TEXT,
  device         TEXT,
  browser        TEXT,
  os             TEXT,
  screen         TEXT,
  lang           TEXT,
  first_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_hash_website ON analytics_sessions(website_id, session_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_website_time       ON analytics_sessions(website_id, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_visitor            ON analytics_sessions(visitor_hash);

CREATE TABLE IF NOT EXISTS analytics_events (
  id              BIGSERIAL PRIMARY KEY,
  website_id      UUID NOT NULL REFERENCES analytics_websites(id) ON DELETE CASCADE,
  session_id      UUID NOT NULL REFERENCES analytics_sessions(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL DEFAULT 'pageview',
  url_path        TEXT NOT NULL,
  url_query       TEXT,
  referrer_domain TEXT,
  referrer_path   TEXT,
  event_name      TEXT,
  event_data      JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_website_time ON analytics_events(website_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_session      ON analytics_events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_path         ON analytics_events(website_id, url_path, created_at DESC);

-- Platform-level seeds (company_id NULL). Tenant portal sites are created on demand by
-- the registration helper when a company first receives portal traffic.
INSERT INTO analytics_websites (tracking_id, name, domain, category)
VALUES
  ('isa_mkt_001',   'Marketing Site',  'isaflow.co.za',       'marketing'),
  ('isa_app_001',   'App',             'app.isaflow.co.za',   'app'),
  ('isa_admin_001', 'Admin Platform',  'admin.isaflow.co.za', 'admin')
ON CONFLICT (tracking_id) DO NOTHING;

COMMENT ON TABLE analytics_websites IS 'Registered trackable properties. company_id=NULL for platform (marketing/admin); non-NULL for tenant portal sites.';
COMMENT ON TABLE analytics_sessions IS 'Visitor sessions — daily rotating salt hash of IP+UA. Privacy-friendly, no cookies, no PII.';
COMMENT ON TABLE analytics_events  IS 'Pageviews and custom events. Retention 180d — trimmed by nightly cron.';
