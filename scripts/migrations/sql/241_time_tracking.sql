-- Time tracking for billable hours and project time management

CREATE TABLE IF NOT EXISTS time_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  user_id UUID NOT NULL,
  project_name TEXT,
  task_description TEXT NOT NULL,
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  hours NUMERIC(6,2) NOT NULL CHECK (hours > 0),
  rate NUMERIC(12,2),
  billable BOOLEAN NOT NULL DEFAULT true,
  invoiced BOOLEAN NOT NULL DEFAULT false,
  invoice_id UUID,
  customer_id UUID,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','invoiced')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_time_entries_company ON time_entries(company_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_user ON time_entries(company_id, user_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_date ON time_entries(company_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_time_entries_customer ON time_entries(company_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_status ON time_entries(company_id, status);
