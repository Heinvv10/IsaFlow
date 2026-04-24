-- 435_sars_source_codes.sql
-- Year-effective SARS IRP5/IT3(a) source code master + release tracking.
-- Replaces hardcoded SARS_SOURCE_CODES map in src/modules/accounting/services/reports/irp5Service.ts.
-- Platform-wide reference data (NOT company-scoped) — same model as tax_tables.
-- Source: SARS PAYE-AE-06-G06 Guide for Codes Applicable to Employees Tax Certificates (annual)
--         + SARS PAYE Employer Reconciliation BRS (in-year change log).

CREATE TABLE IF NOT EXISTS sars_source_codes (
  code                  TEXT NOT NULL,
  effective_year        INT  NOT NULL,
  category              TEXT NOT NULL CHECK (category IN
                          ('income','allowance','fringe','employer','deduction','lump_sum')),
  description           TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN
                          ('active','conditional','deprecated')),
  foreign_code          TEXT,
  code_pair             TEXT,
  applicability_note    TEXT,
  rationalisation_note  TEXT,
  source_document       TEXT,
  source_url            TEXT,
  official_excerpt      TEXT,
  brs_version           TEXT,
  imported_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  imported_by           UUID,
  PRIMARY KEY (code, effective_year)
);

CREATE INDEX IF NOT EXISTS idx_sars_codes_year
  ON sars_source_codes(effective_year);

CREATE INDEX IF NOT EXISTS idx_sars_codes_year_status
  ON sars_source_codes(effective_year, status)
  WHERE status = 'active' OR status = 'conditional';

CREATE INDEX IF NOT EXISTS idx_sars_codes_year_category
  ON sars_source_codes(effective_year, category);

COMMENT ON TABLE sars_source_codes IS
  'Year-effective SARS IRP5/IT3(a) source codes. Updated annually after SARS PAYE-AE-06-G06 release.';
COMMENT ON COLUMN sars_source_codes.effective_year IS
  'SA year of assessment (e.g. 2026 = tax year 1 March 2025 – 28 Feb 2026).';
COMMENT ON COLUMN sars_source_codes.category IS
  'income|allowance|fringe|employer|deduction|lump_sum — drives component_type validation.';
COMMENT ON COLUMN sars_source_codes.code_pair IS
  'Local/foreign code pair (e.g. 3601/3651). Foreign code applies for foreign-services income.';

CREATE TABLE IF NOT EXISTS sars_code_releases (
  effective_year  INT PRIMARY KEY,
  brs_version     TEXT NOT NULL,
  released_at     TIMESTAMPTZ NOT NULL,
  notes           TEXT,
  is_current      BOOLEAN NOT NULL DEFAULT false
);

-- Only one release can be marked current at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sars_releases_current
  ON sars_code_releases(is_current) WHERE is_current = true;

COMMENT ON TABLE sars_code_releases IS
  'Tracks which SARS code release per tax year is loaded. is_current=true points at the active set.';
