-- Migration 307: Tax Directives (SARS Lump Sum)
-- Stores SARS tax directives for lump sum, retirement, severance, and death payments

CREATE TABLE IF NOT EXISTS tax_directives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  employee_id UUID,
  employee_name VARCHAR(255) NOT NULL,
  employee_tax_number VARCHAR(20),
  directive_number VARCHAR(50),
  directive_type VARCHAR(50) NOT NULL, -- 'lump_sum', 'retirement', 'severance', 'death'
  amount NUMERIC(15,2) NOT NULL,
  tax_rate NUMERIC(5,4),              -- e.g. 0.1800 = 18%
  tax_amount NUMERIC(15,2),
  effective_date DATE NOT NULL,
  expiry_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, approved, expired, cancelled
  sars_reference VARCHAR(100),
  notes TEXT,
  requested_by UUID,
  approved_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tax_directives_company_id_idx ON tax_directives(company_id);
CREATE INDEX IF NOT EXISTS tax_directives_company_status_idx ON tax_directives(company_id, status);
