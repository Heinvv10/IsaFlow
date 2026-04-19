-- 373_time_entries_enhance.sql
-- Extend time_entries with practice billing and workflow columns

ALTER TABLE time_entries
  ADD COLUMN IF NOT EXISTS practice_client_id UUID REFERENCES practice_clients(id),
  ADD COLUMN IF NOT EXISTS job_category_id    UUID REFERENCES practice_job_categories(id),
  ADD COLUMN IF NOT EXISTS work_item_id       UUID REFERENCES practice_work_items(id),
  ADD COLUMN IF NOT EXISTS applied_rate       NUMERIC(18,4),
  ADD COLUMN IF NOT EXISTS line_total         NUMERIC(18,2),
  ADD COLUMN IF NOT EXISTS origin             TEXT NOT NULL DEFAULT 'manual'
                             CHECK (origin IN ('manual','assisted','recurring')),
  ADD COLUMN IF NOT EXISTS approved_by        UUID,
  ADD COLUMN IF NOT EXISTS approved_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS billed_at          TIMESTAMPTZ;

-- Widen status CHECK to include practice statuses
ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS time_entries_status_check;
ALTER TABLE time_entries
  ADD CONSTRAINT time_entries_status_check
    CHECK (status IN ('draft','submitted','approved','billed','not_billable','leave','invoiced'));

CREATE INDEX IF NOT EXISTS idx_te_practice_client ON time_entries(company_id, practice_client_id);
CREATE INDEX IF NOT EXISTS idx_te_work_item       ON time_entries(company_id, work_item_id);
CREATE INDEX IF NOT EXISTS idx_te_approved        ON time_entries(company_id, status, approved_at);
