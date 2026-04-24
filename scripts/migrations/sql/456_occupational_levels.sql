-- 456_occupational_levels.sql
-- Employment Equity Act occupational-level master. The EEA1 form
-- requires employers to bucket every employee into one of 6 standard
-- levels; the EEA2 annual return then cross-tabulates these with
-- race/gender/disability.
--
-- display_order preserves the statutory top-down ordering regardless
-- of code/name edits.

CREATE TABLE IF NOT EXISTS occupational_levels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  display_order INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO occupational_levels (code, name, display_order) VALUES
  ('top_management',     'Top management',                         1),
  ('senior_management',  'Senior management',                      2),
  ('prof_qualified',     'Professionally qualified & specialist',  3),
  ('skilled_technical',  'Skilled technical & academically qualified', 4),
  ('semi_skilled',       'Semi-skilled & discretionary decision-making', 5),
  ('unskilled',          'Unskilled & defined decision-making',    6),
  ('unspecified',        'Unspecified',                            99)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE payroll_employees
  ADD COLUMN IF NOT EXISTS occupational_level_id UUID REFERENCES occupational_levels(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_foreign_national BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_payroll_employees_occ_level
  ON payroll_employees(occupational_level_id);

COMMENT ON TABLE occupational_levels IS
  'Employment Equity Act statutory occupational levels (EEA1 categorisation). Seeded globally — not per-company — because the 6 levels are fixed by legislation.';
