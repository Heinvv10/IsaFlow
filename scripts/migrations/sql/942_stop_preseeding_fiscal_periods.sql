-- 942: Companies are no longer pre-seeded with fiscal periods
-- (change-of-year-end programme, Feature I).
--
-- create_company_with_owner's taxonomy seeder wrote January-December of the
-- current and next calendar year (seed_company_fiscal_periods, migration 476)
-- before the user had chosen a financial year, and onboarding then had to
-- delete them again (#777). Years are now generated on demand from the
-- company's template by one code path (gl/fiscalYearGenerator.ts:
-- fiscal_year_ensure + fiscal_periods_generate below): when onboarding
-- completes, and when a posting lands in a year that does not exist yet.

CREATE OR REPLACE FUNCTION public.seed_company_default_taxonomy(p_company_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.seed_company_chart_of_accounts(p_company_id);
  PERFORM public.seed_company_afs_statement_lines(p_company_id);
END;
$$;

REVOKE ALL ON FUNCTION public.seed_company_default_taxonomy(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.seed_company_default_taxonomy(uuid) FROM app_user;
GRANT EXECUTE ON FUNCTION public.seed_company_default_taxonomy(uuid) TO migration_admin;

DROP FUNCTION IF EXISTS public.seed_company_fiscal_periods(uuid);

-- 930's definer registry: this migration changes one reviewed definer and drops
-- another, so it records both (app_pool_reach_violations refuses otherwise).
UPDATE public.app_definer_reviews
   SET writes = 'gl_accounts and afs_statement_lines of the given company, through its two seeders (no fiscal periods since 942); called by create_company_with_owner',
       body_md5 = public.app_definer_hash('public.seed_company_default_taxonomy(uuid)'::regprocedure)
 WHERE signature = 'seed_company_default_taxonomy(uuid)';
DELETE FROM public.app_definer_reviews WHERE signature = 'seed_company_fiscal_periods(uuid)';

-- ── The generator ────────────────────────────────────────────────────────────

-- The year holding p_date, created from the template when no row holds it.
-- Two first postings into the same new year: ON CONFLICT DO NOTHING (no
-- target, so the overlap EXCLUDE is an arbiter too) lets one insert win and
-- the other read the winner's row.
CREATE OR REPLACE FUNCTION public.fiscal_year_ensure(p_company uuid, p_date date)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  y uuid; t record;
BEGIN
  SELECT fy.id INTO y FROM fiscal_years fy
   WHERE fy.company_id = p_company AND p_date BETWEEN fy.start_date AND fy.end_date;
  IF y IS NOT NULL THEN RETURN y; END IF;
  SELECT * INTO t FROM public.fiscal_year_template(p_company, p_date);
  INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date, assumed_start)
  VALUES (p_company, t.fiscal_year, t.start_date, t.end_date, t.assumed)
  ON CONFLICT DO NOTHING
  RETURNING id INTO y;
  IF y IS NULL THEN
    SELECT fy.id INTO y FROM fiscal_years fy
     WHERE fy.company_id = p_company AND p_date BETWEEN fy.start_date AND fy.end_date;
  END IF;
  IF y IS NULL THEN
    RAISE EXCEPTION 'fiscal_year_ensure: could not create the fiscal year holding % for company %', p_date, p_company;
  END IF;
  RETURN y;
END;
$$;

-- Fill every calendar month of a year that no period covers yet. Returns how
-- many periods it created.
--
-- Labels: a new period continues the labelling its nearest existing period
-- uses. Normally that is the year's own label, numbered by position in the
-- year (a 14-month transition year numbers 1-14). A company whose periods
-- carry legacy January-December labels while its year is the declared March
-- year (every company onboarded before #777) keeps getting them, so its new
-- rows look exactly as they always have and cannot collide with its old ones.
--
-- A year that already holds a closed or locked period is not filled: a new
-- open month beside closed ones would let a journal be back-dated into books
-- already closed. p_beside_closed is for a change of year end only, which
-- extends the transition year with months after its old end.
CREATE OR REPLACE FUNCTION public.fiscal_periods_generate(p_year uuid, p_beside_closed boolean DEFAULT false)
RETURNS int
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  y record; d date; d_end date; near record; layout_month int; lbl int; num int; made int := 0; n int;
BEGIN
  -- Lock the year first: a period closed concurrently (whose status sync locks
  -- the same row) is then seen before a month is added beside it.
  SELECT * INTO y FROM fiscal_years WHERE id = p_year FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fiscal_periods_generate: no fiscal year %', p_year; END IF;
  IF y.status IN ('closed', 'locked') THEN RETURN 0; END IF;
  IF NOT p_beside_closed AND EXISTS (
    SELECT 1 FROM fiscal_periods fp WHERE fp.fiscal_year_id = p_year AND fp.status IN ('closed', 'locked')) THEN
    RETURN 0;
  END IF;

  d := date_trunc('month', y.start_date)::date;
  WHILE d <= y.end_date LOOP
    d_end := (d + INTERVAL '1 month')::date - 1;
    IF d >= y.start_date AND d_end <= y.end_date AND NOT EXISTS (
      SELECT 1 FROM fiscal_periods fp
       WHERE fp.company_id = y.company_id AND fp.start_date <= d_end AND fp.end_date >= d) THEN

      SELECT fp.fiscal_year, fp.period_number, fp.start_date, fy.fiscal_year AS year_label,
             (EXTRACT(YEAR FROM fp.start_date)::int * 12 + EXTRACT(MONTH FROM fp.start_date)::int)
           - (EXTRACT(YEAR FROM fy.start_date)::int * 12 + EXTRACT(MONTH FROM fy.start_date)::int) + 1 AS position
        INTO near
        FROM fiscal_periods fp JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
       WHERE fp.company_id = y.company_id
       ORDER BY abs(fp.start_date - d), fp.start_date
       LIMIT 1;

      IF FOUND AND (near.fiscal_year <> near.year_label OR near.period_number <> near.position) THEN
        -- Legacy labels: a 12-month layout whose period 1 starts in layout_month.
        layout_month := ((EXTRACT(MONTH FROM near.start_date)::int - near.period_number) % 12 + 12) % 12 + 1;
        num := ((EXTRACT(MONTH FROM d)::int - layout_month) % 12 + 12) % 12 + 1;
        IF layout_month = 1 THEN lbl := EXTRACT(YEAR FROM d)::int;
        ELSIF EXTRACT(MONTH FROM d)::int >= layout_month THEN lbl := EXTRACT(YEAR FROM d)::int + 1;
        ELSE lbl := EXTRACT(YEAR FROM d)::int;
        END IF;
      ELSE
        lbl := y.fiscal_year;
        num := (EXTRACT(YEAR FROM d)::int * 12 + EXTRACT(MONTH FROM d)::int)
             - (EXTRACT(YEAR FROM y.start_date)::int * 12 + EXTRACT(MONTH FROM y.start_date)::int) + 1;
      END IF;

      INSERT INTO fiscal_periods (company_id, fiscal_year_id, period_name, period_number, fiscal_year, start_date, end_date)
      VALUES (y.company_id, y.id, to_char(d, 'FMMonth YYYY'), num, lbl, d, d_end)
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS n = ROW_COUNT;
      made := made + n;
    END IF;
    d := (d + INTERVAL '1 month')::date;
  END LOOP;
  RETURN made;
END;
$$;

-- SECURITY INVOKER, so EXECUTE stays with PUBLIC (see 940).
