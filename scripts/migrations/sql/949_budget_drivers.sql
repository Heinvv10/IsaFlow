-- 949: Budget drivers, planned hires and rolling forecasts (budgets programme P4;
-- spec docs/plans/budgets/P4-drivers-forecast-spec.md §3, contract
-- docs/plans/budgets/00-shared-contract.md).
--
-- WHAT.
--   budget_month_amounts.amount_source  where a cell's figure came from: typed
--     ('manual'), computed by the row's driver ('driver'), typed over a driver
--     value ('override', which a recompute never touches) or a closed month's
--     ledger actual in a reforecast ('actual'). Existing rows are 'manual'; no
--     data is rewritten.
--   budget_driver_lines  at most ONE driver per budget row (account at one
--     grain in one version) over a month range.
--   budget_planned_hires  hires the user plans, per version; a role label,
--     never a person. Headcount = payroll actives (read-only) + these.
--   budget_rolling_forecasts  a row = "re-roll this reforecast after each
--     period close"; one per company and fiscal year.
--
-- RULES IN THE DATABASE.
--   - Tenancy: every table carries 944's forced-RLS policy verbatim, and the
--     same-company triggers / composite FKs 944 and 947 use, so no row names
--     another company's version, account, centre or unit.
--   - Locked = immutable (decision 2): 947's budget_month_amounts_refuse_locked()
--     reads only version_id and company_id, so it is attached, ENABLE ALWAYS, to
--     budget_driver_lines and budget_planned_hires. NOT to
--     budget_rolling_forecasts: it holds no budget figure, and a roll that meets
--     a locked version must record last_error = 'version locked' on its row
--     (spec §6), which the trigger would refuse.
--   - One grain per account per version (decision 4): drivers of one account in
--     one version share a grain (exclusion, as on the amounts), and a driver's
--     grain must be the grain the version's amounts already use for that
--     account (trigger; raised as 23P01 budget_month_amounts_one_grain so the
--     app maps it like the amounts' own clash).
--   - A driver's months lie inside its version's registry year.
--
-- Every function here is SECURITY INVOKER: no app_definer_reviews row (930).

-- ── budget_month_amounts.amount_source ──────────────────────────────────────

ALTER TABLE budget_month_amounts
  ADD COLUMN IF NOT EXISTS amount_source TEXT NOT NULL DEFAULT 'manual';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budget_month_amounts_amount_source_check'
                    AND conrelid = 'public.budget_month_amounts'::regclass) THEN
    ALTER TABLE budget_month_amounts ADD CONSTRAINT budget_month_amounts_amount_source_check
      CHECK (amount_source IN ('manual', 'driver', 'override', 'actual'));
  END IF;
END;
$$;

-- ── budget_driver_lines ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS budget_driver_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_id UUID NOT NULL,
  -- The driven row's grain (decision 14: at most one dimension).
  gl_account_id UUID NOT NULL REFERENCES gl_accounts(id) ON DELETE CASCADE,
  cc1_id UUID,
  cc2_id UUID,
  bu_id UUID,
  kind TEXT NOT NULL CHECK (kind IN ('fixed', 'pct_of_line', 'pct_of_section', 'growth', 'per_head')),
  from_month DATE NOT NULL CHECK (EXTRACT(DAY FROM from_month) = 1),
  to_month DATE NOT NULL CHECK (EXTRACT(DAY FROM to_month) = 1),
  -- fixed: rand per month; per_head: rand per head per month.
  amount NUMERIC(15, 2),
  -- pct_of_line / pct_of_section: percent of the reference; growth: percent per month.
  pct NUMERIC(9, 4),
  -- pct_of_line: the referenced row (same version).
  -- NO ACTION, not CASCADE: deleting the referenced account must not silently delete ANOTHER
  -- account's driver (its computed cells would stay, sourced 'driver', with nothing producing them).
  ref_gl_account_id UUID REFERENCES gl_accounts(id),
  ref_cc1_id UUID,
  ref_cc2_id UUID,
  ref_bu_id UUID,
  -- pct_of_section: a band of the grid (budgets/grid/subtotals.ts BAND_ORDER) at a scope.
  ref_section TEXT CHECK (ref_section IN ('turnover', 'cost_of_sales', 'other_income', 'operating_expense', 'other_expense')),
  ref_scope TEXT CHECK (ref_scope IN ('same_grain', 'company')),
  -- growth: the month the compounding starts from: a month of the same year, before from_month
  -- (so a growth driver starts in the year's second month at the earliest; by design).
  base_month DATE CHECK (EXTRACT(DAY FROM base_month) = 1),
  -- per_head: the headcount scope; NULL = the whole company. Any kind of centre (CC1 or CC2):
  -- payroll_employees.cost_centre_id names either, and the scope matches it as payroll does.
  headcount_cost_centre_id UUID,
  -- The unit this driver's values round to (decision 5: R1, R100, R1000).
  rounding_unit SMALLINT NOT NULL DEFAULT 1 CHECK (rounding_unit IN (1, 100, 1000)),
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by VARCHAR(255),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dim_grain SMALLINT GENERATED ALWAYS AS (
    ((CASE WHEN cc1_id IS NOT NULL THEN 1 ELSE 0 END)
   + (CASE WHEN cc2_id IS NOT NULL THEN 2 ELSE 0 END)
   + (CASE WHEN bu_id IS NOT NULL THEN 4 ELSE 0 END))::smallint) STORED,
  CONSTRAINT budget_driver_lines_range CHECK (from_month <= to_month),
  CONSTRAINT budget_driver_lines_one_dimension CHECK (num_nonnulls(cc1_id, cc2_id, bu_id) <= 1),
  CONSTRAINT budget_driver_lines_ref_one_dimension CHECK (num_nonnulls(ref_cc1_id, ref_cc2_id, ref_bu_id) <= 1),
  -- Each kind carries exactly the columns it uses.
  CONSTRAINT budget_driver_lines_kind_columns CHECK (CASE kind
    WHEN 'fixed' THEN amount IS NOT NULL AND pct IS NULL AND ref_gl_account_id IS NULL
      AND ref_section IS NULL AND ref_scope IS NULL AND base_month IS NULL AND headcount_cost_centre_id IS NULL
    WHEN 'pct_of_line' THEN amount IS NULL AND pct IS NOT NULL AND ref_gl_account_id IS NOT NULL
      AND ref_section IS NULL AND ref_scope IS NULL AND base_month IS NULL AND headcount_cost_centre_id IS NULL
    WHEN 'pct_of_section' THEN amount IS NULL AND pct IS NOT NULL AND ref_gl_account_id IS NULL
      AND ref_section IS NOT NULL AND ref_scope IS NOT NULL AND base_month IS NULL AND headcount_cost_centre_id IS NULL
    WHEN 'growth' THEN amount IS NULL AND pct IS NOT NULL AND ref_gl_account_id IS NULL
      AND ref_section IS NULL AND ref_scope IS NULL AND base_month IS NOT NULL AND base_month < from_month
      AND headcount_cost_centre_id IS NULL
    WHEN 'per_head' THEN amount IS NOT NULL AND pct IS NULL AND ref_gl_account_id IS NULL
      AND ref_section IS NULL AND ref_scope IS NULL AND base_month IS NULL
    ELSE false END),
  -- A row's % of itself (the engine refuses every cycle at save; this one the table refuses too).
  CONSTRAINT budget_driver_lines_not_self CHECK (NOT (ref_gl_account_id IS NOT DISTINCT FROM gl_account_id
    AND ref_cc1_id IS NOT DISTINCT FROM cc1_id AND ref_cc2_id IS NOT DISTINCT FROM cc2_id
    AND ref_bu_id IS NOT DISTINCT FROM bu_id)),
  CONSTRAINT budget_driver_lines_ref_dims_only_for_line CHECK (
    ref_gl_account_id IS NOT NULL OR num_nonnulls(ref_cc1_id, ref_cc2_id, ref_bu_id) = 0),
  CONSTRAINT budget_driver_lines_one_per_row
    UNIQUE NULLS NOT DISTINCT (company_id, version_id, gl_account_id, cc1_id, cc2_id, bu_id),
  CONSTRAINT budget_driver_lines_version_fk
    FOREIGN KEY (company_id, version_id) REFERENCES budget_versions (company_id, id) ON DELETE CASCADE,
  CONSTRAINT budget_driver_lines_cc1_fk FOREIGN KEY (company_id, cc1_id) REFERENCES cost_centres (company_id, id),
  CONSTRAINT budget_driver_lines_cc2_fk FOREIGN KEY (company_id, cc2_id) REFERENCES cost_centres (company_id, id),
  CONSTRAINT budget_driver_lines_bu_fk FOREIGN KEY (company_id, bu_id) REFERENCES business_units (company_id, id),
  CONSTRAINT budget_driver_lines_ref_cc1_fk FOREIGN KEY (company_id, ref_cc1_id) REFERENCES cost_centres (company_id, id),
  CONSTRAINT budget_driver_lines_ref_cc2_fk FOREIGN KEY (company_id, ref_cc2_id) REFERENCES cost_centres (company_id, id),
  CONSTRAINT budget_driver_lines_ref_bu_fk FOREIGN KEY (company_id, ref_bu_id) REFERENCES business_units (company_id, id),
  CONSTRAINT budget_driver_lines_headcount_cc_fk
    FOREIGN KEY (company_id, headcount_cost_centre_id) REFERENCES cost_centres (company_id, id)
);
DO $$
BEGIN
  -- Decision 4 among drivers: one grain per account per version.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budget_driver_lines_one_grain'
                    AND conrelid = 'public.budget_driver_lines'::regclass) THEN
    ALTER TABLE budget_driver_lines ADD CONSTRAINT budget_driver_lines_one_grain
      EXCLUDE USING gist (version_id WITH =, gl_account_id WITH =, dim_grain WITH <>);
  END IF;
END;
$$;
CREATE INDEX IF NOT EXISTS idx_budget_driver_lines_version ON budget_driver_lines (company_id, version_id);
-- The masters' delete checks look drivers up by these.
CREATE INDEX IF NOT EXISTS idx_bdl_cc1 ON budget_driver_lines (cc1_id) WHERE cc1_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bdl_cc2 ON budget_driver_lines (cc2_id) WHERE cc2_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bdl_bu ON budget_driver_lines (bu_id) WHERE bu_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bdl_headcount_cc ON budget_driver_lines (headcount_cost_centre_id)
  WHERE headcount_cost_centre_id IS NOT NULL;

-- Accounts of the company only (gl_accounts has no (company_id, id) key to
-- point a composite FK at); months inside the version's registry year; the
-- grain the version's amounts already use for the account.
CREATE OR REPLACE FUNCTION public.budget_driver_lines_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  fy int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM gl_accounts ga WHERE ga.id = NEW.gl_account_id AND ga.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'budget driver account % does not belong to company %', NEW.gl_account_id, NEW.company_id USING ERRCODE = '23514';
  END IF;
  IF NEW.ref_gl_account_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM gl_accounts ga WHERE ga.id = NEW.ref_gl_account_id AND ga.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'budget driver reference account % does not belong to company %', NEW.ref_gl_account_id, NEW.company_id
      USING ERRCODE = '23514';
  END IF;
  -- The referenced row's CC1/CC2 must be of that kind (947's kinds trigger reads only cc1_id/cc2_id).
  IF NEW.ref_cc1_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM cost_centres cc WHERE cc.id = NEW.ref_cc1_id AND cc.company_id = NEW.company_id AND cc.cc_type = 'cc1') THEN
    RAISE EXCEPTION 'budget driver ref_cc1_id % is not a CC1 cost centre of company %', NEW.ref_cc1_id, NEW.company_id USING ERRCODE = '23514';
  END IF;
  IF NEW.ref_cc2_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM cost_centres cc WHERE cc.id = NEW.ref_cc2_id AND cc.company_id = NEW.company_id AND cc.cc_type = 'cc2') THEN
    RAISE EXCEPTION 'budget driver ref_cc2_id % is not a CC2 cost centre of company %', NEW.ref_cc2_id, NEW.company_id USING ERRCODE = '23514';
  END IF;
  SELECT v.fiscal_year INTO fy FROM budget_versions v WHERE v.id = NEW.version_id AND v.company_id = NEW.company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'budget version % not found for company %', NEW.version_id, NEW.company_id USING ERRCODE = '23503';
  END IF;
  -- fiscal_year_for_date, not 947's budget_month_registry_label: app_user may execute only the
  -- former, and this trigger runs as the session (a month the registry cannot place is outside).
  IF (SELECT y.fiscal_year FROM public.fiscal_year_for_date(NEW.company_id, NEW.from_month) y) IS DISTINCT FROM fy
     OR (SELECT y.fiscal_year FROM public.fiscal_year_for_date(NEW.company_id, NEW.to_month) y) IS DISTINCT FROM fy
     OR (NEW.base_month IS NOT NULL
         AND (SELECT y.fiscal_year FROM public.fiscal_year_for_date(NEW.company_id, NEW.base_month) y) IS DISTINCT FROM fy) THEN
    RAISE EXCEPTION 'budget driver months lie outside financial year % of version %', fy, NEW.version_id USING ERRCODE = '23514';
  END IF;
  -- NEW.dim_grain is not computed yet in a BEFORE trigger (generated columns come after): the
  -- same expression, from NEW's ids.
  IF EXISTS (SELECT 1 FROM budget_month_amounts a
              WHERE a.company_id = NEW.company_id AND a.version_id = NEW.version_id
                AND a.gl_account_id = NEW.gl_account_id
                AND a.dim_grain <> ((CASE WHEN NEW.cc1_id IS NOT NULL THEN 1 ELSE 0 END)
                                  + (CASE WHEN NEW.cc2_id IS NOT NULL THEN 2 ELSE 0 END)
                                  + (CASE WHEN NEW.bu_id IS NOT NULL THEN 4 ELSE 0 END))) THEN
    RAISE EXCEPTION 'budget account % is budgeted at another level in version %', NEW.gl_account_id, NEW.version_id
      USING ERRCODE = '23P01', CONSTRAINT = 'budget_month_amounts_one_grain';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_budget_driver_lines_check ON budget_driver_lines;
CREATE TRIGGER trg_budget_driver_lines_check BEFORE INSERT OR UPDATE ON budget_driver_lines
  FOR EACH ROW EXECUTE FUNCTION public.budget_driver_lines_check();
ALTER TABLE budget_driver_lines ENABLE ALWAYS TRIGGER trg_budget_driver_lines_check;

-- CC1/CC2 kinds on the row's grain: 947's amounts check reads only NEW.company_id, cc1_id, cc2_id.
DROP TRIGGER IF EXISTS trg_budget_driver_lines_dimension_kinds ON budget_driver_lines;
CREATE TRIGGER trg_budget_driver_lines_dimension_kinds
  BEFORE INSERT OR UPDATE OF company_id, cc1_id, cc2_id ON budget_driver_lines
  FOR EACH ROW EXECUTE FUNCTION public.budget_month_amounts_dimension_kinds();
ALTER TABLE budget_driver_lines ENABLE ALWAYS TRIGGER trg_budget_driver_lines_dimension_kinds;

DROP TRIGGER IF EXISTS trg_budget_driver_lines_refuse_locked ON budget_driver_lines;
CREATE TRIGGER trg_budget_driver_lines_refuse_locked
  BEFORE INSERT OR UPDATE OR DELETE ON budget_driver_lines
  FOR EACH ROW EXECUTE FUNCTION public.budget_month_amounts_refuse_locked();
ALTER TABLE budget_driver_lines ENABLE ALWAYS TRIGGER trg_budget_driver_lines_refuse_locked;

DROP TRIGGER IF EXISTS trg_budget_driver_lines_updated_at ON budget_driver_lines;
CREATE TRIGGER trg_budget_driver_lines_updated_at BEFORE UPDATE ON budget_driver_lines
  FOR EACH ROW EXECUTE FUNCTION accounting_updated_at();

-- ── budget_planned_hires ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS budget_planned_hires (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version_id UUID NOT NULL,
  -- A role ("Sales rep"), never a person's name (decision 7).
  label TEXT NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120),
  -- Any kind of centre, as per_head's scope (payroll names either).
  cost_centre_id UUID,
  start_month DATE NOT NULL CHECK (EXTRACT(DAY FROM start_month) = 1),
  end_month DATE CHECK (EXTRACT(DAY FROM end_month) = 1),
  fte NUMERIC(6, 2) NOT NULL DEFAULT 1 CHECK (fte > 0),
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT budget_planned_hires_range CHECK (end_month IS NULL OR start_month <= end_month),
  CONSTRAINT budget_planned_hires_version_fk
    FOREIGN KEY (company_id, version_id) REFERENCES budget_versions (company_id, id) ON DELETE CASCADE,
  CONSTRAINT budget_planned_hires_cc_fk FOREIGN KEY (company_id, cost_centre_id) REFERENCES cost_centres (company_id, id)
);
CREATE INDEX IF NOT EXISTS idx_budget_planned_hires_version ON budget_planned_hires (company_id, version_id);
CREATE INDEX IF NOT EXISTS idx_bph_cc ON budget_planned_hires (cost_centre_id) WHERE cost_centre_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_budget_planned_hires_refuse_locked ON budget_planned_hires;
CREATE TRIGGER trg_budget_planned_hires_refuse_locked
  BEFORE INSERT OR UPDATE OR DELETE ON budget_planned_hires
  FOR EACH ROW EXECUTE FUNCTION public.budget_month_amounts_refuse_locked();
ALTER TABLE budget_planned_hires ENABLE ALWAYS TRIGGER trg_budget_planned_hires_refuse_locked;

DROP TRIGGER IF EXISTS trg_budget_planned_hires_updated_at ON budget_planned_hires;
CREATE TRIGGER trg_budget_planned_hires_updated_at BEFORE UPDATE ON budget_planned_hires
  FOR EACH ROW EXECUTE FUNCTION accounting_updated_at();

-- ── budget_rolling_forecasts ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS budget_rolling_forecasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year INTEGER NOT NULL,
  version_id UUID NOT NULL,
  rolled_through_month DATE CHECK (EXTRACT(DAY FROM rolled_through_month) = 1),
  last_rolled_at TIMESTAMPTZ,
  last_error TEXT CHECK (length(last_error) <= 500),
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT budget_rolling_forecasts_one_per_year UNIQUE (company_id, fiscal_year),
  CONSTRAINT budget_rolling_forecasts_one_per_version UNIQUE (version_id),
  CONSTRAINT budget_rolling_forecasts_version_fk
    FOREIGN KEY (company_id, version_id) REFERENCES budget_versions (company_id, id) ON DELETE CASCADE
);

-- A rolling row names a reforecast version of the same company and year.
CREATE OR REPLACE FUNCTION public.budget_rolling_forecasts_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM budget_versions v
                  WHERE v.id = NEW.version_id AND v.company_id = NEW.company_id
                    AND v.fiscal_year = NEW.fiscal_year AND v.kind = 'reforecast') THEN
    RAISE EXCEPTION 'rolling forecast % must name a reforecast version of company % and year %',
      NEW.version_id, NEW.company_id, NEW.fiscal_year USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_budget_rolling_forecasts_check ON budget_rolling_forecasts;
CREATE TRIGGER trg_budget_rolling_forecasts_check
  BEFORE INSERT OR UPDATE OF company_id, fiscal_year, version_id ON budget_rolling_forecasts
  FOR EACH ROW EXECUTE FUNCTION public.budget_rolling_forecasts_check();
ALTER TABLE budget_rolling_forecasts ENABLE ALWAYS TRIGGER trg_budget_rolling_forecasts_check;

DROP TRIGGER IF EXISTS trg_budget_rolling_forecasts_updated_at ON budget_rolling_forecasts;
CREATE TRIGGER trg_budget_rolling_forecasts_updated_at BEFORE UPDATE ON budget_rolling_forecasts
  FOR EACH ROW EXECUTE FUNCTION accounting_updated_at();

-- ── Decision 4 the other way: an amount at another grain than the account's driver ──
-- budget_driver_lines_check refuses a driver at another grain than the version's amounts; this
-- refuses an amount at another grain than the version's driver for that account (a driver whose
-- range does not cover the month typed, or one just saved). Neither check locks: the services
-- serialise every writer of a version on its row first (lockVersionForWrite / gridSave's CAS,
-- an UPDATE), so two app writers of one version never race here.
CREATE INDEX IF NOT EXISTS idx_budget_driver_lines_account ON budget_driver_lines (version_id, gl_account_id);
CREATE OR REPLACE FUNCTION public.budget_month_amounts_driver_grain()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM budget_driver_lines d
              WHERE d.version_id = NEW.version_id AND d.gl_account_id = NEW.gl_account_id
                AND d.company_id = NEW.company_id
                AND d.dim_grain <> ((CASE WHEN NEW.cc1_id IS NOT NULL THEN 1 ELSE 0 END)
                                  + (CASE WHEN NEW.cc2_id IS NOT NULL THEN 2 ELSE 0 END)
                                  + (CASE WHEN NEW.bu_id IS NOT NULL THEN 4 ELSE 0 END))) THEN
    RAISE EXCEPTION 'budget account % has a driver at another level in version %', NEW.gl_account_id, NEW.version_id
      USING ERRCODE = '23P01', CONSTRAINT = 'budget_month_amounts_one_grain';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_budget_month_amounts_driver_grain ON budget_month_amounts;
CREATE TRIGGER trg_budget_month_amounts_driver_grain
  BEFORE INSERT OR UPDATE OF company_id, version_id, gl_account_id, cc1_id, cc2_id, bu_id ON budget_month_amounts
  FOR EACH ROW EXECUTE FUNCTION public.budget_month_amounts_driver_grain();
ALTER TABLE budget_month_amounts ENABLE ALWAYS TRIGGER trg_budget_month_amounts_driver_grain;

-- ── A centre a driver uses keeps its kind (947's guard covers the amounts only) ──
CREATE OR REPLACE FUNCTION public.cost_centres_keep_driver_kind()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- Under RLS a session sees only the active company's drivers; 947's guard (same trigger
  -- point) already refuses a change from another company, so this one only needs the lookup.
  IF EXISTS (SELECT 1 FROM budget_driver_lines d
              WHERE d.company_id = OLD.company_id
                AND OLD.id IN (d.cc1_id, d.cc2_id, d.ref_cc1_id, d.ref_cc2_id)) THEN
    RAISE EXCEPTION 'cost centre % is used by a budget driver; its kind (cc_type) cannot change', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_cost_centres_keep_driver_kind ON cost_centres;
CREATE TRIGGER trg_cost_centres_keep_driver_kind BEFORE UPDATE OF cc_type ON cost_centres
  FOR EACH ROW WHEN (OLD.cc_type IS DISTINCT FROM NEW.cc_type) EXECUTE FUNCTION public.cost_centres_keep_driver_kind();
ALTER TABLE cost_centres ENABLE ALWAYS TRIGGER trg_cost_centres_keep_driver_kind;

-- ── Tenancy: 944's policy, verbatim, on each new table ──────────────────────

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['budget_driver_lines', 'budget_planned_hires', 'budget_rolling_forecasts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO app_user '
      'USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies())) '
      'WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))', t);
    EXECUTE format('GRANT SELECT, DELETE ON %I TO app_user', t);
    EXECUTE format('REVOKE INSERT, UPDATE ON %I FROM app_user', t);
  END LOOP;
END;
$$;
-- INSERT per column: id and the timestamps take their defaults (a writable stamp gets forged);
-- created_by is the session's user, written by the services.
GRANT INSERT (company_id, version_id, gl_account_id, cc1_id, cc2_id, bu_id, kind, from_month, to_month, amount, pct,
  ref_gl_account_id, ref_cc1_id, ref_cc2_id, ref_bu_id, ref_section, ref_scope, base_month,
  headcount_cost_centre_id, rounding_unit, created_by, updated_by) ON budget_driver_lines TO app_user;
GRANT INSERT (company_id, version_id, label, cost_centre_id, start_month, end_month, fte, created_by)
  ON budget_planned_hires TO app_user;
GRANT INSERT (company_id, fiscal_year, version_id, rolled_through_month, last_rolled_at, last_error, created_by)
  ON budget_rolling_forecasts TO app_user;
-- UPDATE per column: never id, company_id or the creation stamps.
GRANT UPDATE (version_id, gl_account_id, cc1_id, cc2_id, bu_id, kind, from_month, to_month, amount, pct,
  ref_gl_account_id, ref_cc1_id, ref_cc2_id, ref_bu_id, ref_section, ref_scope, base_month,
  headcount_cost_centre_id, rounding_unit, updated_by, updated_at) ON budget_driver_lines TO app_user;
GRANT UPDATE (version_id, label, cost_centre_id, start_month, end_month, fte, updated_at) ON budget_planned_hires TO app_user;
GRANT UPDATE (rolled_through_month, last_rolled_at, last_error, updated_at) ON budget_rolling_forecasts TO app_user;

REVOKE ALL ON FUNCTION public.budget_driver_lines_check() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_rolling_forecasts_check() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_month_amounts_driver_grain() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cost_centres_keep_driver_kind() FROM PUBLIC;
