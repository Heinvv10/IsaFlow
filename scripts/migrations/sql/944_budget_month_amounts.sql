-- 944: Budgets keyed by calendar month (change-of-year-end programme,
-- Feature E; Hein's decision 2026-10-22).
--
-- WHY. accounting_budgets stored twelve amounts per account per fiscal-year
-- LABEL, keyed 'jan'..'dec', and every reader capped a year at twelve months.
-- A 14-month transition year cannot be budgeted that way, and after a change of
-- year end the months of a label are not the same months any more. An amount
-- now belongs to a calendar month ('YYYY-MM-01'); the year it counts in is
-- whichever financial year holds that month (gl/fiscalYearRegistry).
--
-- accounting_budgets stays, as the per-account, per-year header that holds the
-- user's notes; its period_amounts / annual_amount / total_amount are no
-- longer read or written by the app (left in place, not dropped: the
-- conversion below is verified, and dropping is irreversible).
--
-- CONVERSION (budget_months_from_legacy below). The conversion files each
-- stored amount in the calendar month the OLD readers placed it in; it does not
-- re-label anything by the registry. Each stored month key of a budget row is
-- read as the readers read it: the company's fiscal_periods row with that label
-- and that calendar month (every production company labels its periods
-- January-December, so FY2026 'mar' is March 2026). With no such period:
--   - a company with no periods at all was read as the March window opening in
--     the label's year (March hardcoded, as the old reader hardcoded
--     `${year}-03-01`, whatever companies.financial_year_start says): FY2026 is
--     March 2026 - February 2027, so its 'jan' is January 2027;
--   - a company whose periods are all calendar-labelled gets that month of the
--     label's year;
--   - any other company (periods made by the generator after 940, labelled by
--     registry year) gets the month inside the registry year of that label
--     (public.fiscal_year_for_label), so two labels never fall on one month.
-- Because the registry's FY2027 is March 2026 - February 2027, converted months
-- regroup under registry labels: January 2026 now counts in FY2026 and March
-- 2026 in FY2027. The notes header (accounting_budgets) therefore is copied to
-- every registry label that holds converted months of the account, so the notes
-- show wherever the months show. A row with no monthly split spreads
-- annual_amount over the twelve months, cents on the last, as the reader
-- pro-rated it. An empty string is 0 (the reader's Number('')). A monthly amount
-- in the JSON may have more than two decimals (annual_amount cannot: it is
-- NUMERIC(15,2)); it is rounded to cents, the column's precision, on both sides
-- of the verification.
-- A row naming another company's account was never shown by any reader (they
-- joined the account on the company) and is reported, not converted. Totals are
-- verified per company and account; a collision (two rows claiming one month)
-- fails the migration rather than merging silently, so the DO block is not
-- re-runnable on a table that already holds the converted months, on purpose.

CREATE TABLE IF NOT EXISTS budget_month_amounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  gl_account_id UUID NOT NULL REFERENCES gl_accounts(id) ON DELETE CASCADE,
  month DATE NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
  amount NUMERIC(15, 2) NOT NULL,
  created_by VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT budget_month_amounts_one_per_month UNIQUE (company_id, gl_account_id, month)
);

ALTER TABLE budget_month_amounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_month_amounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON budget_month_amounts;
-- The active company AND membership (migration 897's form): a member of two
-- companies working in A cannot read or write B's rows through app_user.
CREATE POLICY tenant_isolation ON budget_month_amounts FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
GRANT SELECT, INSERT, UPDATE, DELETE ON budget_month_amounts TO app_user;

DROP TRIGGER IF EXISTS trg_budget_month_amounts_updated_at ON budget_month_amounts;
CREATE TRIGGER trg_budget_month_amounts_updated_at BEFORE UPDATE ON budget_month_amounts
  FOR EACH ROW EXECUTE FUNCTION accounting_updated_at();

-- An account of another company cannot carry this company's budget.
CREATE OR REPLACE FUNCTION public.budget_month_amounts_same_company()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM gl_accounts ga WHERE ga.id = NEW.gl_account_id AND ga.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'budget account % does not belong to company %', NEW.gl_account_id, NEW.company_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_budget_month_amounts_same_company ON budget_month_amounts;
CREATE TRIGGER trg_budget_month_amounts_same_company BEFORE INSERT OR UPDATE OF company_id, gl_account_id ON budget_month_amounts
  FOR EACH ROW EXECUTE FUNCTION public.budget_month_amounts_same_company();

-- ── Conversion ───────────────────────────────────────────────────────────────

-- One conversion, callable per company so it is tested on old-shape rows
-- (tests/integration/budgets-legacy-conversion.int.test.ts) and run for all of
-- them here; the month rules are in the header above. A value that is not a number, or a period_amounts that is
-- not an object, stops the migration naming the budget row.
CREATE OR REPLACE FUNCTION public.budget_months_from_legacy(p_company uuid DEFAULT NULL)
RETURNS int
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  b record; k text; idx int; raw text; val numeric; month_date date;
  keys text[] := ARRAY['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  monthly numeric; inserted int; converted int := 0; win_start date; reg_label int;
BEGIN
  FOR b IN
    SELECT id, company_id, gl_account_id, fiscal_year, COALESCE(period_amounts, '{}'::jsonb) AS pa,
           COALESCE(annual_amount, 0) AS annual, created_by, notes
      FROM accounting_budgets ab
     WHERE gl_account_id IS NOT NULL AND company_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM gl_accounts ga WHERE ga.id = ab.gl_account_id AND ga.company_id = ab.company_id)
       AND (p_company IS NULL OR company_id = p_company)
     ORDER BY company_id, gl_account_id, fiscal_year
  LOOP
    IF jsonb_typeof(b.pa) <> 'object' THEN
      RAISE EXCEPTION 'budget_months_from_legacy: budget % has period_amounts that is not an object (%)', b.id, jsonb_typeof(b.pa);
    END IF;
    FOR idx IN 1..12 LOOP
      k := keys[idx];
      IF (SELECT COUNT(*) FROM jsonb_object_keys(b.pa)) > 0 THEN
        raw := COALESCE(b.pa ->> k, b.pa ->> (idx - 1)::text);
        CONTINUE WHEN raw IS NULL;
        IF btrim(raw) = '' THEN raw := '0'; END IF;
        IF raw !~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' THEN
          RAISE EXCEPTION 'budget_months_from_legacy: budget % month % is not a number (%)', b.id, k, raw;
        END IF;
        val := round(raw::numeric, 2);
      ELSE
        CONTINUE WHEN b.annual = 0;
        monthly := round(b.annual / 12, 2);
        val := CASE WHEN idx = 12 THEN b.annual - monthly * 11 ELSE monthly END;
      END IF;
      SELECT fp.start_date INTO month_date FROM fiscal_periods fp
       WHERE fp.company_id = b.company_id AND fp.fiscal_year = b.fiscal_year
         AND EXTRACT(MONTH FROM fp.start_date)::int = idx AND EXTRACT(DAY FROM fp.start_date) = 1
       ORDER BY fp.start_date LIMIT 1;
      IF month_date IS NULL THEN
        IF NOT EXISTS (SELECT 1 FROM fiscal_periods fp2 WHERE fp2.company_id = b.company_id) THEN
          month_date := make_date(CASE WHEN idx >= 3 THEN b.fiscal_year ELSE b.fiscal_year + 1 END, idx, 1);
        ELSIF NOT EXISTS (SELECT 1 FROM fiscal_periods fp3 WHERE fp3.company_id = b.company_id
                             AND fp3.fiscal_year <> EXTRACT(YEAR FROM fp3.start_date)::int) THEN
          month_date := make_date(b.fiscal_year, idx, 1);
        ELSE
          SELECT fy.start_date INTO win_start
            FROM public.fiscal_year_for_label(b.company_id, b.fiscal_year) fy;
          IF win_start IS NULL THEN
            month_date := make_date(b.fiscal_year, idx, 1);  -- a label no year carries: calendar placement
          ELSE
            -- The first such month on or after the window's start: inside the window when it holds one,
            -- else (a short year) the next such month, so the amount is kept, never dropped.
            month_date := make_date(EXTRACT(YEAR FROM win_start)::int + CASE WHEN idx < EXTRACT(MONTH FROM win_start)::int THEN 1 ELSE 0 END, idx, 1);
          END IF;
        END IF;
      END IF;
      INSERT INTO budget_month_amounts (company_id, gl_account_id, month, amount, created_by)
      VALUES (b.company_id, b.gl_account_id, month_date, val, b.created_by)
      ON CONFLICT (company_id, gl_account_id, month) DO NOTHING;
      GET DIAGNOSTICS inserted = ROW_COUNT;
      IF inserted = 0 THEN
        RAISE EXCEPTION 'budget_months_from_legacy: budget % (FY%) and another budget both claim % for account %',
          b.id, b.fiscal_year, month_date, b.gl_account_id;
      END IF;
      converted := converted + 1;
      -- The notes header follows the months into the registry year that now holds them.
      SELECT fy.fiscal_year INTO reg_label FROM public.fiscal_year_for_date(b.company_id, month_date) fy;
      IF reg_label IS NOT NULL AND reg_label <> b.fiscal_year THEN
        INSERT INTO accounting_budgets (company_id, budget_name, fiscal_year, gl_account_id, notes, created_by)
        VALUES (b.company_id, 'FY' || reg_label || ' Budget', reg_label, b.gl_account_id, b.notes, b.created_by)
        ON CONFLICT (company_id, gl_account_id, fiscal_year) WHERE gl_account_id IS NOT NULL DO NOTHING;
      END IF;
      month_date := NULL; win_start := NULL; reg_label := NULL;
    END LOOP;
  END LOOP;
  RETURN converted;
END;
$$;

-- Company/account totals that differ between the old rows and the months.
CREATE OR REPLACE FUNCTION public.budget_months_legacy_mismatches(p_company uuid DEFAULT NULL)
RETURNS int
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH src AS (
    SELECT b.company_id, b.gl_account_id,
           SUM(CASE WHEN (SELECT COUNT(*) FROM jsonb_object_keys(COALESCE(b.period_amounts, '{}'::jsonb))) > 0
                    THEN (SELECT COALESCE(SUM(round(COALESCE(NULLIF(btrim(COALESCE(b.period_amounts ->> m.k, b.period_amounts ->> (m.n - 1)::text)), ''), '0')::numeric, 2)), 0)
                            FROM unnest(ARRAY['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'])
                                 WITH ORDINALITY AS m(k, n))
                    ELSE COALESCE(b.annual_amount, 0) END) AS total
      FROM accounting_budgets b JOIN gl_accounts ga ON ga.id = b.gl_account_id AND ga.company_id = b.company_id
     WHERE jsonb_typeof(COALESCE(b.period_amounts, '{}'::jsonb)) = 'object'
       AND (p_company IS NULL OR b.company_id = p_company)
     GROUP BY 1, 2
  ), dst AS (
    SELECT company_id, gl_account_id, SUM(amount) AS total FROM budget_month_amounts
     WHERE p_company IS NULL OR company_id = p_company GROUP BY 1, 2
  )
  SELECT COUNT(*)::int FROM src FULL JOIN dst USING (company_id, gl_account_id)
   WHERE COALESCE(src.total, 0) <> COALESCE(dst.total, 0)
$$;

REVOKE ALL ON FUNCTION public.budget_months_from_legacy(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_months_legacy_mismatches(uuid) FROM PUBLIC;

DO $$
DECLARE
  orphaned int; foreign_acct int; converted int; bad int;
BEGIN
  -- Rows no reader ever showed (no account, or no company): reported, not converted.
  SELECT COUNT(*) INTO orphaned FROM accounting_budgets WHERE gl_account_id IS NULL OR company_id IS NULL;
  IF orphaned > 0 THEN
    RAISE NOTICE '944: % accounting_budgets row(s) have no account or company; no report ever read them, so they are not converted', orphaned;
  END IF;
  SELECT COUNT(*) INTO foreign_acct FROM accounting_budgets ab
   WHERE ab.gl_account_id IS NOT NULL AND ab.company_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM gl_accounts ga WHERE ga.id = ab.gl_account_id AND ga.company_id = ab.company_id);
  IF foreign_acct > 0 THEN
    RAISE NOTICE '944: % accounting_budgets row(s) name an account of another company; no report ever read them, so they are not converted', foreign_acct;
  END IF;
  converted := public.budget_months_from_legacy(NULL);
  RAISE NOTICE '944: converted % budget months', converted;
  bad := public.budget_months_legacy_mismatches(NULL);
  IF bad > 0 THEN
    RAISE EXCEPTION '944 verification failed: % company/account budget totals differ after conversion', bad;
  END IF;
END;
$$;

COMMENT ON COLUMN accounting_budgets.period_amounts IS
  'Superseded by budget_month_amounts (migration 944); no longer read or written by the app.';
COMMENT ON COLUMN accounting_budgets.annual_amount IS
  'Superseded by budget_month_amounts (migration 944); no longer read or written by the app.';
COMMENT ON COLUMN accounting_budgets.total_amount IS
  'Superseded by budget_month_amounts (migration 944); no longer read or written by the app.';
