-- Leave Management (Sprint 5)

CREATE TABLE IF NOT EXISTS leave_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  days_per_year NUMERIC(5,2) DEFAULT 0,
  days_per_cycle NUMERIC(5,2) DEFAULT 0,
  cycle_years INTEGER DEFAULT 1,
  is_paid BOOLEAN DEFAULT true,
  requires_document BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO leave_types (code, name, days_per_year, days_per_cycle, cycle_years, is_paid, requires_document) VALUES
  ('annual', 'Annual Leave', 15, 15, 1, true, false),
  ('sick', 'Sick Leave', 10, 30, 3, true, true),
  ('family_responsibility', 'Family Responsibility Leave', 3, 3, 1, true, true),
  ('maternity', 'Maternity Leave', 0, 120, 1, false, true),
  ('unpaid', 'Unpaid Leave', 0, 0, 1, false, false),
  ('study', 'Study Leave', 0, 0, 1, true, true)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS leave_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id UUID NOT NULL REFERENCES leave_types(id),
  leave_type_code TEXT NOT NULL,
  year INTEGER NOT NULL,
  opening_balance NUMERIC(5,2) DEFAULT 0,
  accrued NUMERIC(5,2) DEFAULT 0,
  taken NUMERIC(5,2) DEFAULT 0,
  adjustment NUMERIC(5,2) DEFAULT 0,
  closing_balance NUMERIC(5,2) DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(employee_id, leave_type_code, year)
);

CREATE INDEX IF NOT EXISTS idx_leave_bal_employee ON leave_balances(employee_id);
CREATE INDEX IF NOT EXISTS idx_leave_bal_year ON leave_balances(year);

CREATE TABLE IF NOT EXISTS leave_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id),
  employee_id UUID NOT NULL REFERENCES employees(id),
  leave_type_id UUID NOT NULL REFERENCES leave_types(id),
  leave_type_code TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  days NUMERIC(5,2) NOT NULL CHECK (days > 0),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  rejection_reason TEXT,
  supporting_document TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leave_app_employee ON leave_applications(employee_id);
CREATE INDEX IF NOT EXISTS idx_leave_app_status ON leave_applications(status);
CREATE INDEX IF NOT EXISTS idx_leave_app_dates ON leave_applications(start_date, end_date);
