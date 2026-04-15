-- Project Accounting & Job Costing (Sprint 9)

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id),
  project_number TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  client_id UUID REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft', 'active', 'on_hold', 'completed', 'cancelled')),
  billing_method TEXT NOT NULL DEFAULT 'time_and_materials'
    CHECK (billing_method IN ('time_and_materials', 'fixed_price', 'milestone', 'retainer')),
  start_date DATE,
  end_date DATE,
  budget_amount NUMERIC(15,2) DEFAULT 0,
  budget_hours NUMERIC(10,2) DEFAULT 0,
  percent_complete NUMERIC(5,2) DEFAULT 0,
  total_revenue NUMERIC(15,2) DEFAULT 0,
  total_cost NUMERIC(15,2) DEFAULT 0,
  total_billed NUMERIC(15,2) DEFAULT 0,
  manager_id TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, project_number)
);

CREATE INDEX IF NOT EXISTS idx_projects_company ON projects(company_id);
CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

CREATE TABLE IF NOT EXISTS project_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  budget_hours NUMERIC(10,2) DEFAULT 0,
  budget_amount NUMERIC(15,2) DEFAULT 0,
  actual_hours NUMERIC(10,2) DEFAULT 0,
  actual_amount NUMERIC(15,2) DEFAULT 0,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON project_tasks(project_id);

CREATE TABLE IF NOT EXISTS project_time_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id),
  project_id UUID NOT NULL REFERENCES projects(id),
  task_id UUID REFERENCES project_tasks(id),
  employee_id UUID REFERENCES employees(id),
  entry_date DATE NOT NULL,
  hours NUMERIC(5,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  hourly_rate NUMERIC(10,2) DEFAULT 0,
  billable_amount NUMERIC(15,2) DEFAULT 0,
  description TEXT NOT NULL,
  is_billable BOOLEAN DEFAULT true,
  is_invoiced BOOLEAN DEFAULT false,
  invoice_id UUID,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_time_entries_project ON project_time_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_employee ON project_time_entries(employee_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_date ON project_time_entries(entry_date);

CREATE TABLE IF NOT EXISTS project_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  task_id UUID REFERENCES project_tasks(id),
  expense_date DATE NOT NULL,
  category TEXT,
  description TEXT NOT NULL,
  amount NUMERIC(15,2) NOT NULL,
  is_billable BOOLEAN DEFAULT true,
  is_invoiced BOOLEAN DEFAULT false,
  receipt_url TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_expenses_project ON project_expenses(project_id);
