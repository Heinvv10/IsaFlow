-- 379_practice_tasks.sql
-- Sub-items under a job, standalone internal tasks, recurring-rule support.

CREATE TABLE IF NOT EXISTS practice_tasks (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID NOT NULL REFERENCES companies(id),
  job_id               UUID REFERENCES practice_jobs(id),
  parent_task_id       UUID REFERENCES practice_tasks(id),
  title                TEXT NOT NULL,
  description          TEXT,
  assigned_to          UUID,
  due_date             DATE,
  priority             TEXT NOT NULL DEFAULT 'normal'
                         CHECK (priority IN ('low','normal','high','urgent')),
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','in_progress','done','cancelled')),
  recurring_rule       TEXT
                         CHECK (recurring_rule IS NULL
                                OR recurring_rule IN ('weekly','monthly','quarterly','yearly')),
  completed_at         TIMESTAMPTZ,
  created_by           UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pt_company_job ON practice_tasks(company_id, job_id);
CREATE INDEX IF NOT EXISTS idx_pt_company_assigned ON practice_tasks(company_id, assigned_to);
CREATE INDEX IF NOT EXISTS idx_pt_company_status_due ON practice_tasks(company_id, status, due_date);
CREATE INDEX IF NOT EXISTS idx_pt_parent ON practice_tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;
