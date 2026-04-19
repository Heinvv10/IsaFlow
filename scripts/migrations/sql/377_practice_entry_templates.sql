-- 377_practice_entry_templates.sql
-- Per-user saved time-entry templates (favourites) for rapid capture.

CREATE TABLE IF NOT EXISTS practice_entry_templates (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID NOT NULL REFERENCES companies(id),
  user_id              UUID NOT NULL,
  name                 TEXT NOT NULL,
  practice_client_id   UUID REFERENCES practice_clients(id),
  job_category_id      UUID REFERENCES practice_job_categories(id),
  work_item_id         UUID REFERENCES practice_work_items(id),
  default_hours        NUMERIC(6,2),
  task_description     TEXT,
  notes                TEXT,
  billable             BOOLEAN NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pet_company_user
  ON practice_entry_templates(company_id, user_id);
