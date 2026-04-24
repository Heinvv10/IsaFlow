-- 457_training_events.sql
-- Workplace Skills Plan (WSP) / Annual Training Report (ATR) capture.
-- SETAs require employers to submit planned + actual training annually.
-- This schema stores both sides on one row: planned_start/end/cost at
-- WSP submission time, actual_start/end/cost and status update once
-- the training completes.

CREATE TABLE IF NOT EXISTS training_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN (
    'aet', 'learnership', 'skills_programme', 'internship',
    'bursary', 'short_course', 'workshop', 'other'
  )),
  description TEXT NOT NULL,
  provider TEXT,
  nqf_level INTEGER CHECK (nqf_level IS NULL OR nqf_level BETWEEN 1 AND 10),
  planned_start DATE,
  planned_end DATE,
  actual_start DATE,
  actual_end DATE,
  cost_planned NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (cost_planned >= 0),
  cost_actual NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (cost_actual >= 0),
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'in_progress', 'completed', 'cancelled')),
  notes TEXT,
  created_by VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_training_events_company_year
  ON training_events(company_id, planned_start);

CREATE INDEX IF NOT EXISTS idx_training_events_employee
  ON training_events(employee_id);

COMMENT ON TABLE training_events IS
  'WSP (planned) / ATR (actual) training capture. A single row holds both sides — planned_* at WSP submission, actual_* + status on completion. Reports aggregate by calendar year of planned_start.';
