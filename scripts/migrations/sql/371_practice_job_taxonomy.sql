-- 371_practice_job_taxonomy.sql
-- Two-level job code taxonomy: Category → Work Item

CREATE TABLE IF NOT EXISTS practice_job_categories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL,
  name          TEXT NOT NULL,
  sort_order    INT NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  reporting_tag TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pjc_company ON practice_job_categories(company_id, sort_order);

CREATE TABLE IF NOT EXISTS practice_work_items (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID NOT NULL,
  category_id           UUID NOT NULL REFERENCES practice_job_categories(id),
  name                  TEXT NOT NULL,
  sort_order            INT NOT NULL DEFAULT 0,
  is_active             BOOLEAN NOT NULL DEFAULT true,
  default_billable      BOOLEAN NOT NULL DEFAULT true,
  default_rate_override NUMERIC(12,2),
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pwi_category ON practice_work_items(company_id, category_id);
