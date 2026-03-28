-- SARS eFiling Integration Migration
-- Tables for tracking SARS submissions and compliance deadlines

CREATE TABLE IF NOT EXISTS sars_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_type TEXT NOT NULL, -- 'VAT201', 'EMP201', 'EMP501', 'IRP5'
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', -- draft, generated, submitted, accepted, rejected
  form_data JSONB NOT NULL DEFAULT '{}',
  submission_reference TEXT,
  submitted_at TIMESTAMPTZ,
  submitted_by UUID,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sars_compliance_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL, -- 'VAT201_DUE', 'EMP201_DUE', 'EMP501_DUE', 'PROVISIONAL_TAX'
  due_date DATE NOT NULL,
  description TEXT NOT NULL,
  status TEXT DEFAULT 'pending', -- pending, completed, overdue
  submission_id UUID REFERENCES sars_submissions(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_sars_submissions_form_type ON sars_submissions(form_type);
CREATE INDEX IF NOT EXISTS idx_sars_submissions_status ON sars_submissions(status);
CREATE INDEX IF NOT EXISTS idx_sars_submissions_period ON sars_submissions(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_sars_compliance_events_due_date ON sars_compliance_events(due_date);
CREATE INDEX IF NOT EXISTS idx_sars_compliance_events_status ON sars_compliance_events(status);
