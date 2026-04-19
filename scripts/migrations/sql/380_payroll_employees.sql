-- 380_payroll_employees.sql
-- SA-compliant employee master for payroll (separate from accounting 'employees' table).
-- Includes ID, tax, UIF, equity fields required for IRP5/EMP201.

CREATE TABLE IF NOT EXISTS payroll_employees (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_number       VARCHAR(20) NOT NULL,
  first_name            VARCHAR(100) NOT NULL,
  last_name             VARCHAR(100) NOT NULL,
  id_number             VARCHAR(13),
  passport_number       VARCHAR(30),
  tax_number            VARCHAR(20),
  tax_directive_number  VARCHAR(30),
  employment_type       VARCHAR(20) NOT NULL DEFAULT 'permanent'
    CHECK (employment_type IN ('permanent', 'contract', 'casual', 'director')),
  start_date            DATE NOT NULL,
  end_date              DATE,
  uif_number            VARCHAR(30),
  uif_excluded          BOOLEAN NOT NULL DEFAULT FALSE,
  equity_race           VARCHAR(30)
    CHECK (equity_race IS NULL OR equity_race IN ('african', 'coloured', 'indian', 'white', 'foreign')),
  equity_gender         VARCHAR(10)
    CHECK (equity_gender IS NULL OR equity_gender IN ('male', 'female')),
  equity_disability     BOOLEAN NOT NULL DEFAULT FALSE,
  date_of_birth         DATE,
  department            VARCHAR(100),
  cost_centre           VARCHAR(100),
  status                VARCHAR(10) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'terminated')),
  medical_aid_main_member      BOOLEAN NOT NULL DEFAULT TRUE,
  medical_aid_dependants_count INT NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, employee_number)
);

CREATE INDEX IF NOT EXISTS idx_payroll_employees_company
  ON payroll_employees (company_id);
CREATE INDEX IF NOT EXISTS idx_payroll_employees_tax
  ON payroll_employees (company_id, tax_number);
CREATE INDEX IF NOT EXISTS idx_payroll_employees_status
  ON payroll_employees (company_id, status);

CREATE TABLE IF NOT EXISTS payroll_bank_details (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  bank_name       VARCHAR(100) NOT NULL,
  account_number  VARCHAR(30) NOT NULL,
  account_type    VARCHAR(20) NOT NULL DEFAULT 'cheque'
    CHECK (account_type IN ('cheque', 'savings', 'transmission')),
  branch_code     VARCHAR(10) NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payroll_bank_details_employee
  ON payroll_bank_details (employee_id);
