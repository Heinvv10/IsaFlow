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

-- Tenant isolation backstop — same pattern as every post-348 per-company
-- table (e.g. 441/442). Mig 348's bulk-RLS loop only covered tables that
-- existed at the time it ran.
ALTER TABLE company_compliance_obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_compliance_obligations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON company_compliance_obligations;
CREATE POLICY tenant_isolation ON company_compliance_obligations
  FOR ALL
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON company_compliance_obligations TO app_user;
