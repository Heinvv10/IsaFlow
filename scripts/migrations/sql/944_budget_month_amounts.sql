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
--     (public.fiscal_year_for_label), so two labels never fall on one month. A key
--     for a month that year does not have (a short year) was never read by any
--     old reader, so it is SKIPPED (counted and reported, left out of the
--     verification), not pushed into the next year's months.
-- Because the registry's FY2027 is March 2026 - February 2027, converted months
-- regroup under registry labels: January 2026 now counts in FY2026 and March
-- 2026 in FY2027. The notes header (accounting_budgets) therefore follows the
-- months: it is copied to every registry label that holds converted months of
-- the account, so the notes show wherever the months show; and a header none of
-- whose months land under its own label MOVES to a label that holds them (when
-- that label has no header yet), leaving no empty year with notes.
-- A month the registry cannot place (no free label in a hole between stored
-- years; any other registry error stops the migration) is still filed by the old
-- readers' placement; its header stays put. The headers are moved and copied
-- AFTER the verification (budget_headers_follow_months), because the
-- verification reads each row under its own label. Headers are processed from
-- the latest label down, so a header can move into the label a later row has
-- just left. Both steps are one-shot: run on rows already converted or moved
-- they would collide or misplace. A row with no monthly split spreads
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

-- The calendar month the OLD readers filed month key `p_idx` (1 = jan) of a budget row labelled
-- `p_label` under (the rules are in the header above), or NULL when no reader ever read that key:
-- the company's periods carry the label but have no period for that month (a short year). The
-- converter, the verification and the skipped count all use this one function.
CREATE OR REPLACE FUNCTION public.budget_legacy_month(p_company uuid, p_label int, p_idx int)
RETURNS date
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  d date; win_start date; win_end date;
BEGIN
  SELECT fp.start_date INTO d FROM fiscal_periods fp
   WHERE fp.company_id = p_company AND fp.fiscal_year = p_label
     AND EXTRACT(MONTH FROM fp.start_date)::int = p_idx AND EXTRACT(DAY FROM fp.start_date) = 1
   ORDER BY fp.start_date LIMIT 1;
  IF d IS NOT NULL THEN RETURN d; END IF;
  IF NOT EXISTS (SELECT 1 FROM fiscal_periods fp2 WHERE fp2.company_id = p_company) THEN
    RETURN make_date(CASE WHEN p_idx >= 3 THEN p_label ELSE p_label + 1 END, p_idx, 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fiscal_periods fp3 WHERE fp3.company_id = p_company
                    AND fp3.fiscal_year <> EXTRACT(YEAR FROM fp3.start_date)::int) THEN
    RETURN make_date(p_label, p_idx, 1);
  END IF;
  -- Registry-labelled periods. The registry refuses some shapes (no free label in a hole between
  -- stored years): placed as no year carries it.
  BEGIN
    SELECT fy.start_date, fy.end_date INTO win_start, win_end FROM public.fiscal_year_for_label(p_company, p_label) fy;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'fiscal_year_template: no free label%' THEN RAISE; END IF;
    win_start := NULL;
  END;
  IF win_start IS NULL THEN RETURN make_date(p_label, p_idx, 1); END IF;  -- a label no year carries: calendar placement
  -- The month inside the label's window; a key for a month the year does not have (a short year) was never read.
  d := make_date(EXTRACT(YEAR FROM win_start)::int + CASE WHEN p_idx < EXTRACT(MONTH FROM win_start)::int THEN 1 ELSE 0 END, p_idx, 1);
  RETURN CASE WHEN d <= win_end THEN d END;
END;
$$;

-- Every stored month of every legacy budget row (an annual-only row spread over twelve), with the
-- month it is filed under (NULL: skipped, see budget_legacy_month). Cents-rounded.
CREATE OR REPLACE FUNCTION public.budget_legacy_month_values(p_company uuid DEFAULT NULL, p_budget uuid DEFAULT NULL)
RETURNS TABLE (budget_id uuid, company_id uuid, gl_account_id uuid, idx int, val numeric, month date)
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT b.id, b.company_id, b.gl_account_id, m.n::int, v.val,
         public.budget_legacy_month(b.company_id, b.fiscal_year, m.n::int)
    FROM accounting_budgets b
    JOIN gl_accounts ga ON ga.id = b.gl_account_id AND ga.company_id = b.company_id
    CROSS JOIN unnest(ARRAY['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']) WITH ORDINALITY AS m(k, n)
    CROSS JOIN LATERAL (SELECT CASE
        WHEN jsonb_typeof(COALESCE(b.period_amounts, '{}'::jsonb)) <> 'object' THEN NULL
        WHEN COALESCE(b.period_amounts, '{}'::jsonb) <> '{}'::jsonb THEN
          CASE WHEN COALESCE(b.period_amounts ->> m.k, b.period_amounts ->> (m.n - 1)::text) IS NULL THEN NULL
               ELSE round(COALESCE(NULLIF(btrim(COALESCE(b.period_amounts ->> m.k, b.period_amounts ->> (m.n - 1)::text)), ''), '0')::numeric, 2) END
        WHEN COALESCE(b.annual_amount, 0) = 0 THEN NULL
        WHEN m.n = 12 THEN b.annual_amount - round(b.annual_amount / 12, 2) * 11
        ELSE round(b.annual_amount / 12, 2)
      END AS val) v
   WHERE v.val IS NOT NULL AND (p_company IS NULL OR b.company_id = p_company) AND (p_budget IS NULL OR b.id = p_budget)
$$;

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
  monthly numeric; inserted int; converted int := 0;
BEGIN
  FOR b IN
    SELECT id, company_id, gl_account_id, fiscal_year, COALESCE(period_amounts, '{}'::jsonb) AS pa,
           COALESCE(annual_amount, 0) AS annual, created_by
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
      month_date := public.budget_legacy_month(b.company_id, b.fiscal_year, idx);
      CONTINUE WHEN month_date IS NULL;  -- a key no reader ever read (see budget_legacy_month)
      INSERT INTO budget_month_amounts (company_id, gl_account_id, month, amount, created_by)
      VALUES (b.company_id, b.gl_account_id, month_date, val, b.created_by)
      ON CONFLICT (company_id, gl_account_id, month) DO NOTHING;
      GET DIAGNOSTICS inserted = ROW_COUNT;
      IF inserted = 0 THEN
        RAISE EXCEPTION 'budget_months_from_legacy: budget % (FY%) and another budget both claim % for account %',
          b.id, b.fiscal_year, month_date, b.gl_account_id;
      END IF;
      converted := converted + 1;
      month_date := NULL;
    END LOOP;
  END LOOP;
  RETURN converted;
END;
$$;

-- The notes header follows the months into the registry years that now hold them. When none of a
-- row's converted months is under its own label its header MOVES to a label that holds them (no
-- empty year carrying notes), unless that label has a header already; every other label gets a
-- copy. Rows are taken from the latest label down, so a header can move into the label a later
-- row has just vacated. Run it AFTER budget_months_legacy_mismatches: the verification reads each
-- row under its own label. One-shot, like the converter.
CREATE OR REPLACE FUNCTION public.budget_headers_follow_months(p_company uuid DEFAULT NULL)
RETURNS int
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  b record; d date; reg_label int; lab int[]; target int; lbl int; touched int := 0; d_ins int;
BEGIN
  FOR b IN
    SELECT id, company_id, gl_account_id, fiscal_year, notes, created_by
      FROM accounting_budgets ab
     WHERE gl_account_id IS NOT NULL AND company_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM gl_accounts ga WHERE ga.id = ab.gl_account_id AND ga.company_id = ab.company_id)
       AND (p_company IS NULL OR company_id = p_company)
     ORDER BY company_id, gl_account_id, fiscal_year DESC
  LOOP
    lab := '{}';
    FOR d IN SELECT v.month FROM public.budget_legacy_month_values(b.company_id, b.id) v WHERE v.month IS NOT NULL ORDER BY v.month LOOP
      -- The registry year that now holds the month (a hole between stored years leaves the notes where they are).
      BEGIN
        SELECT fy.fiscal_year INTO reg_label FROM public.fiscal_year_for_date(b.company_id, d) fy;
      EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE 'fiscal_year_template: no free label%' THEN RAISE; END IF;
        reg_label := NULL;
      END;
      IF reg_label IS NOT NULL AND NOT (reg_label = ANY(lab)) THEN lab := lab || reg_label; END IF;
      reg_label := NULL;
    END LOOP;
    CONTINUE WHEN cardinality(lab) = 0;
    IF NOT (b.fiscal_year = ANY(lab)) THEN
      target := lab[1];
      IF NOT EXISTS (SELECT 1 FROM accounting_budgets h WHERE h.company_id = b.company_id
                       AND h.gl_account_id = b.gl_account_id AND h.fiscal_year = target) THEN
        UPDATE accounting_budgets SET fiscal_year = target, budget_name = 'FY' || target || ' Budget' WHERE id = b.id;
        touched := touched + 1;
      END IF;
    END IF;
    FOREACH lbl IN ARRAY lab LOOP
      CONTINUE WHEN lbl = b.fiscal_year;
      INSERT INTO accounting_budgets (company_id, budget_name, fiscal_year, gl_account_id, notes, created_by)
      VALUES (b.company_id, 'FY' || lbl || ' Budget', lbl, b.gl_account_id, b.notes, b.created_by)
      ON CONFLICT (company_id, gl_account_id, fiscal_year) WHERE gl_account_id IS NOT NULL DO NOTHING;
      GET DIAGNOSTICS d_ins = ROW_COUNT;
      touched := touched + d_ins;
    END LOOP;
  END LOOP;
  RETURN touched;
END;
$$;

-- Company/account totals that differ between the old rows and the months (keys no reader read are not in the source).
CREATE OR REPLACE FUNCTION public.budget_months_legacy_mismatches(p_company uuid DEFAULT NULL)
RETURNS int
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH src AS (
    SELECT company_id, gl_account_id, SUM(val) AS total
      FROM public.budget_legacy_month_values(p_company) WHERE month IS NOT NULL GROUP BY 1, 2
  ), dst AS (
    SELECT company_id, gl_account_id, SUM(amount) AS total FROM budget_month_amounts
     WHERE p_company IS NULL OR company_id = p_company GROUP BY 1, 2
  )
  SELECT COUNT(*)::int FROM src FULL JOIN dst USING (company_id, gl_account_id)
   WHERE COALESCE(src.total, 0) <> COALESCE(dst.total, 0)
$$;

-- Stored legacy months no reader ever read (a short year's keys for months it does not have): not converted.
CREATE OR REPLACE FUNCTION public.budget_months_legacy_skipped(p_company uuid DEFAULT NULL)
RETURNS int
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COUNT(*)::int FROM public.budget_legacy_month_values(p_company) WHERE month IS NULL
$$;

REVOKE ALL ON FUNCTION public.budget_months_from_legacy(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_months_legacy_mismatches(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_months_legacy_skipped(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_legacy_month(uuid, int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_legacy_month_values(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.budget_headers_follow_months(uuid) FROM PUBLIC;

DO $$
DECLARE
  orphaned int; foreign_acct int; converted int; bad int; skipped int;
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
  skipped := public.budget_months_legacy_skipped(NULL);
  IF skipped > 0 THEN
    RAISE NOTICE '944: % stored month(s) are for months their financial year does not have (a short year); no reader ever read them, so they are not converted', skipped;
  END IF;
  bad := public.budget_months_legacy_mismatches(NULL);
  IF bad > 0 THEN
    RAISE EXCEPTION '944 verification failed: % company/account budget totals differ after conversion', bad;
  END IF;
  -- After the verification, which reads each row under its own label.
  RAISE NOTICE '944: % budget header(s) moved or copied to the registry year of their months', public.budget_headers_follow_months(NULL);
END;
$$;

COMMENT ON COLUMN accounting_budgets.period_amounts IS
  'Superseded by budget_month_amounts (migration 944); no longer read or written by the app.';
COMMENT ON COLUMN accounting_budgets.annual_amount IS
  'Superseded by budget_month_amounts (migration 944); no longer read or written by the app.';
COMMENT ON COLUMN accounting_budgets.total_amount IS
  'Superseded by budget_month_amounts (migration 944); no longer read or written by the app.';
