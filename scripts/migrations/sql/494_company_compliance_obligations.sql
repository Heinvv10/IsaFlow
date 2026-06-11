-- 494: per-company statutory obligation config for the compliance calendar
-- (Dotbiz roadmap Workstream E). Opt-in: companies without a row generate no
-- calendar work items. The VAT cycle itself stays on companies.vat_period /
-- companies.vat_period_alignment (single source of truth) — vat_enabled here
-- only switches the calendar signal on or off for the company.

CREATE TABLE IF NOT EXISTS company_compliance_obligations (
  company_id UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  vat_enabled BOOLEAN NOT NULL DEFAULT false,
  emp201_enabled BOOLEAN NOT NULL DEFAULT false,
  emp501_enabled BOOLEAN NOT NULL DEFAULT false,
  provisional_tax_enabled BOOLEAN NOT NULL DEFAULT false,
  cipc_enabled BOOLEAN NOT NULL DEFAULT false,
  -- financial year-end month (1-12); SA default February
  year_end_month SMALLINT NOT NULL DEFAULT 2
    CHECK (year_end_month BETWEEN 1 AND 12),
  -- company registration anniversary month driving the CIPC annual return
  cipc_anniversary_month SMALLINT
    CHECK (cipc_anniversary_month BETWEEN 1 AND 12),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
