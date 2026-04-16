-- 337_management_pack_configs.sql
-- Per-company configuration for automated monthly management pack generation.

CREATE TABLE IF NOT EXISTS management_pack_configs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  enabled          BOOLEAN NOT NULL DEFAULT FALSE,
  generation_day   INTEGER NOT NULL DEFAULT 5 CHECK (generation_day BETWEEN 1 AND 28),
  delivery_day     INTEGER NOT NULL DEFAULT 10 CHECK (delivery_day BETWEEN 1 AND 28),
  review_required  BOOLEAN NOT NULL DEFAULT TRUE,
  sections_enabled JSONB NOT NULL DEFAULT '{}'::JSONB,
  recipients       JSONB NOT NULL DEFAULT '[]'::JSONB,
  pack_style       TEXT NOT NULL DEFAULT 'detailed'
                     CHECK (pack_style IN ('executive', 'detailed', 'board')),
  comparison_mode  TEXT NOT NULL DEFAULT 'prior_month'
                     CHECK (comparison_mode IN ('prior_month', 'prior_year', 'budget', 'all_three')),
  currency_display TEXT NOT NULL DEFAULT 'full'
                     CHECK (currency_display IN ('full', 'thousands', 'millions')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_management_pack_configs_company_id
  ON management_pack_configs(company_id);

CREATE INDEX IF NOT EXISTS idx_management_pack_configs_enabled
  ON management_pack_configs(enabled) WHERE enabled = TRUE;
