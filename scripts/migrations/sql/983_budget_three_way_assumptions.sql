-- 983: Three-way budget assumptions (budgets programme P6; spec
-- docs/plans/budgets/P6-three-way-spec.md §4, §6 and §13 items 17-19, contract
-- docs/plans/budgets/00-shared-contract.md).
--
-- WHAT.
--   budget_three_way_assumptions  one validated assumptions document per budget
--     version (working capital days, VAT, payroll tax, income tax, capex, loans,
--     equity, minimum cash). An original/reforecast holds the full document; a
--     scenario holds { overrides } merged over its base by the service. No
--     computed figure is ever stored here, and nothing here reaches the GL.
--   feature_flags 'budgets_three_way'  dark flag (is_global = false): enabled
--     per company by a platform admin (945 made the flag tables read-only to
--     the app roles). Off for everyone until Hein signs off on Demo.
--
-- RULES IN THE DATABASE.
--   - Tenancy: 944's forced-RLS policy verbatim; the version is the same
--     company's by composite FK (947's form), and deleting the version deletes
--     its assumptions.
--   - Locked = immutable (decision 2): 947's budget_month_amounts_refuse_locked()
--     reads only version_id and company_id, so it is attached, ENABLE ALWAYS,
--     exactly as 949 attaches it to budget_driver_lines (raises BV001).
--   - Column privileges: id and every stamp take their defaults or the
--     triggers' values (a writable stamp gets forged). updated_at is the
--     document's concurrency token: the clock sets it on every write, and
--     app_user cannot write it. updated_by is the session user (auth.uid()),
--     by 954's budget_controls_stamp_actor().
--   - The service pool reaches the table through the mirror policies
--     app_service_sync_policies() (915) creates; called at the end so the file is
--     whole on its own.
--
-- Every function here is SECURITY INVOKER: no app_definer_reviews row (930).

CREATE TABLE IF NOT EXISTS budget_three_way_assumptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_id UUID NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  -- Validated by the service (zod, assumptionsSchema.ts); the table only refuses a non-object.
  doc JSONB NOT NULL CHECK (jsonb_typeof(doc) = 'object'),
  updated_by VARCHAR(255),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT budget_three_way_assumptions_version_fk
    FOREIGN KEY (company_id, version_id) REFERENCES budget_versions (company_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS budget_three_way_assumptions_version_uq
  ON budget_three_way_assumptions (company_id, version_id);

-- Locked versions refuse every write (BV001), as on the amounts and the drivers.
DROP TRIGGER IF EXISTS trg_budget_three_way_assumptions_refuse_locked ON budget_three_way_assumptions;
CREATE TRIGGER trg_budget_three_way_assumptions_refuse_locked
  BEFORE INSERT OR UPDATE OR DELETE ON budget_three_way_assumptions
  FOR EACH ROW EXECUTE FUNCTION public.budget_month_amounts_refuse_locked();
ALTER TABLE budget_three_way_assumptions ENABLE ALWAYS TRIGGER trg_budget_three_way_assumptions_refuse_locked;

-- Time stamps are the clock's: created_at kept on update, updated_at always now.
CREATE OR REPLACE FUNCTION public.budget_three_way_assumptions_stamp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := clock_timestamp();
  ELSE
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_budget_three_way_assumptions_stamp ON budget_three_way_assumptions;
CREATE TRIGGER trg_budget_three_way_assumptions_stamp BEFORE INSERT OR UPDATE ON budget_three_way_assumptions
  FOR EACH ROW EXECUTE FUNCTION public.budget_three_way_assumptions_stamp();
ALTER TABLE budget_three_way_assumptions ENABLE ALWAYS TRIGGER trg_budget_three_way_assumptions_stamp;

-- Actor stamp: the session user on insert and update (954's function).
DROP TRIGGER IF EXISTS trg_budget_three_way_assumptions_stamp_actor ON budget_three_way_assumptions;
CREATE TRIGGER trg_budget_three_way_assumptions_stamp_actor BEFORE INSERT OR UPDATE ON budget_three_way_assumptions
  FOR EACH ROW EXECUTE FUNCTION public.budget_controls_stamp_actor('updated_by', 'updated_by');
ALTER TABLE budget_three_way_assumptions ENABLE ALWAYS TRIGGER trg_budget_three_way_assumptions_stamp_actor;

REVOKE ALL ON FUNCTION public.budget_three_way_assumptions_stamp() FROM PUBLIC;

-- ── Tenancy: 944's policy, verbatim ─────────────────────────────────────────

ALTER TABLE budget_three_way_assumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_three_way_assumptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON budget_three_way_assumptions;
CREATE POLICY tenant_isolation ON budget_three_way_assumptions FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
-- 348's default privileges gave app_user every command: take back all but SELECT, then grant per column.
REVOKE INSERT, UPDATE, DELETE ON budget_three_way_assumptions FROM app_user;
GRANT SELECT ON budget_three_way_assumptions TO app_user;
-- INSERT: never id or a stamp. UPDATE: only the document (version, company and stamps are fixed).
GRANT INSERT (company_id, version_id, schema_version, doc) ON budget_three_way_assumptions TO app_user;
GRANT UPDATE (schema_version, doc) ON budget_three_way_assumptions TO app_user;
GRANT DELETE ON budget_three_way_assumptions TO app_user;

-- ── Feature flag (dark: override-only enablement, as 506's mcp_connector) ───

INSERT INTO feature_flags (code, name, description, is_global)
VALUES (
  'budgets_three_way',
  'Budgets: balance sheet & cash',
  'Three-way budget (budgeted balance sheet and cash flow) and scenarios. Dark; enabled per company by override for Demo review.',
  false
)
ON CONFLICT (code) DO NOTHING;

SELECT public.app_service_sync_policies();
