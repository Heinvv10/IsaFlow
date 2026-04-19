-- 385_time_entries_job_link.sql
-- Optional link from a time entry to the job it was billed under.

ALTER TABLE time_entries
  ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES practice_jobs(id);

CREATE INDEX IF NOT EXISTS idx_te_job ON time_entries(company_id, job_id)
  WHERE job_id IS NOT NULL;
