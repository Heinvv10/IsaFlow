-- 374_practice_seed_categories.sql
-- Default SA accounting firm job categories (reference table, non-tenant)

CREATE TABLE IF NOT EXISTS practice_default_categories (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  sort_order   INT NOT NULL DEFAULT 0,
  reporting_tag TEXT
);

INSERT INTO practice_default_categories (name, sort_order, reporting_tag) VALUES
  ('Accounting',           1,  'accounting'),
  ('Payroll',              2,  'payroll'),
  ('SARS',                 3,  'sars'),
  ('Financial Statements', 4,  'afs'),
  ('CIPC',                 5,  'cipc'),
  ('Tax Advisory',         6,  'tax'),
  ('Audit Support',        7,  'audit'),
  ('Admin',                8,  'admin'),
  ('Meeting',              9,  'admin')
ON CONFLICT DO NOTHING;
