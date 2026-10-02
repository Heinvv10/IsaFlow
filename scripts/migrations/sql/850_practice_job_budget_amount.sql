-- 850_practice_job_budget_amount.sql
-- Engagement Budget: the rand value approved for a practice job (engagement).
-- Time on the job is valued at hours x applied_rate and measured against it;
-- NULL means the job has no budget ("No budget"), not a budget of R0.

ALTER TABLE practice_jobs
  ADD COLUMN IF NOT EXISTS budget_amount NUMERIC(18,2)
    CONSTRAINT practice_jobs_budget_amount_check CHECK (budget_amount >= 0);
