-- Migration 313: admin_settings persistence table
-- Stores platform-wide configuration key/value pairs for the admin dashboard.

CREATE TABLE IF NOT EXISTS admin_settings (
  key        VARCHAR(255) PRIMARY KEY,
  value      JSONB        NOT NULL,
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_by VARCHAR(255) REFERENCES users(id)
);

-- Seed default values so GET always returns a complete object
INSERT INTO admin_settings (key, value) VALUES
  ('maintenance_mode',       'false'::jsonb),
  ('registration_enabled',   'true'::jsonb),
  ('default_trial_days',     '14'::jsonb),
  ('max_companies_per_user', '5'::jsonb)
ON CONFLICT (key) DO NOTHING;
