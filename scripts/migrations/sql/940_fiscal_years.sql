-- 940: Financial years as stored records (change-of-year-end programme,
-- Feature A; Hein's decisions 2026-10-22/23).
--
-- WHY. A financial year was never stored: it was `GROUP BY fiscal_year` over
-- fiscal_periods, and every report re-derived its dates from the CURRENT
-- companies.financial_year_start. Change that month and every historical year
-- re-cuts in every report. From here a year is a row with its own dates; the
-- readers take a year's range from it (gl/fiscalYearRegistry.ts), so a year
-- keeps its dates after a change of year end.
--
-- WHICH DATES THE EXISTING YEARS GET (Hein, 2026-10-23, gate G1/G3). Every
-- real company declares financial_year_start = 3 while its periods are
-- labelled January-December. Reports have always used the DECLARED March year
-- (TB year-to-date, AFS, prior year), and the AFS are signed for it. So the
-- years are built from the declared month, not from the period labels, and
-- each period is linked to the year that holds its dates. Reports stay
-- identical. Period rows keep their dates, labels and numbers; only the new
-- fiscal_year_id column is set. A period that fits no declared year (a single
-- January-December "period", which only test fixtures write) gets a year cut
-- from its own label group instead, exactly as the periods describe it.
--
-- ONE TEMPLATE. fiscal_year_template() is the only place a year's range is
-- derived when no row holds a date yet: chained 12 months on from the nearest
-- stored year (so a transition year's new year end carries forward), else the
-- declared month. The app's resolver and generator call it; nothing in
-- TypeScript re-derives it.
--
-- INVARIANTS (enforced here, not by convention):
--   * a year is 1 day to 15 months long (Companies Act 71 of 2008, s27(4)) and
--     a company's years never overlap;
--   * every period lies inside its year, of the same company (deferred, so a
--     change of year end can move a year's edges and its periods in one
--     transaction);
--   * a closed or locked period cannot be moved, re-dated or relabelled, and
--     nothing is added to a closed or locked year; a closed or locked year
--     cannot be re-dated or relabelled;
--   * a year's status is never written, only derived from its periods
--     (enforced by trigger on every INSERT/UPDATE): locked/closed only when every day
--     of the year is covered by periods that all are, closing while any period
--     is closing, otherwise open.
--
-- Legacy writers (136 integration fixtures INSERT fiscal_periods directly)
-- keep working: a period inserted without fiscal_year_id is linked by
-- fiscal_periods_link_year(), which creates the template year when none holds
-- it.

-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fiscal_years (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- The label: named for the calendar year the year ENDS in (FY2027 = Mar 2026
  -- - Feb 2027), as gl/fiscalYearCalendar.ts always has.
  fiscal_year INT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closing', 'closed', 'locked')),
  kind VARCHAR(20) NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal', 'transition')),
  -- The change of year end that made this a transition year (Feature B's table).
  change_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fiscal_years_company_label_key UNIQUE (company_id, fiscal_year),
  CONSTRAINT fiscal_years_dates_ordered CHECK (end_date > start_date),
  CONSTRAINT fiscal_years_at_most_15_months CHECK (end_date < (start_date + INTERVAL '15 months')::date),
  CONSTRAINT fiscal_years_no_overlap
    EXCLUDE USING gist (company_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
);

CREATE INDEX IF NOT EXISTS idx_fiscal_years_company_end ON fiscal_years (company_id, end_date);

ALTER TABLE fiscal_years ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_years FORCE ROW LEVEL SECURITY;
-- The same tenant policy fiscal_periods carries (migration 220 lineage).
DROP POLICY IF EXISTS tenant_isolation ON fiscal_years;
CREATE POLICY tenant_isolation ON fiscal_years TO app_user
  USING (company_id IN (SELECT cu.company_id FROM company_users cu WHERE cu.user_id = auth.uid()))
  WITH CHECK (company_id = app.current_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal_years TO app_user;

DROP TRIGGER IF EXISTS trg_fiscal_years_updated_at ON fiscal_years;
CREATE TRIGGER trg_fiscal_years_updated_at BEFORE UPDATE ON fiscal_years
  FOR EACH ROW EXECUTE FUNCTION accounting_updated_at();

ALTER TABLE fiscal_periods ADD COLUMN IF NOT EXISTS fiscal_year_id UUID REFERENCES fiscal_years(id);
CREATE INDEX IF NOT EXISTS idx_fiscal_periods_fiscal_year_id ON fiscal_periods (fiscal_year_id);

-- ── The template: a year's range where no row holds the date yet ─────────────

CREATE OR REPLACE FUNCTION public.fiscal_year_template(p_company uuid, p_date date)
RETURNS TABLE (fiscal_year int, start_date date, end_date date)
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  prev_label int; prev_end date; next_label int; next_start date;
  s date; e date; lbl int; m int; steps int := 0;
BEGIN
  SELECT fy.fiscal_year, fy.end_date INTO prev_label, prev_end
    FROM fiscal_years fy WHERE fy.company_id = p_company AND fy.end_date < p_date
   ORDER BY fy.end_date DESC LIMIT 1;
  SELECT fy.fiscal_year, fy.start_date INTO next_label, next_start
    FROM fiscal_years fy WHERE fy.company_id = p_company AND fy.start_date > p_date
   ORDER BY fy.start_date LIMIT 1;

  IF prev_end IS NOT NULL THEN
    -- Twelve-month steps on from the last stored year: after a transition the
    -- new year end carries forward. A label is the year the range ends in, and
    -- never repeats: a short year ending in the same calendar year as the one
    -- before pushes later labels up by one (documented in the gl .claude.md).
    s := prev_end + 1; lbl := prev_label;
    LOOP
      e := (s + INTERVAL '12 months')::date - 1;
      lbl := GREATEST(lbl + 1, EXTRACT(YEAR FROM e)::int);
      EXIT WHEN p_date <= e;
      s := e + 1; steps := steps + 1;
      IF steps > 500 THEN RAISE EXCEPTION 'fiscal_year_template: % is too far from the stored years', p_date; END IF;
    END LOOP;
    IF next_start IS NOT NULL AND e >= next_start THEN
      e := next_start - 1;  -- the gap before the next stored year is shorter than a year
    END IF;
    IF next_label IS NOT NULL AND lbl >= next_label THEN
      RAISE EXCEPTION 'fiscal_year_template: no free label for the year holding % (between FY% and FY%)', p_date, prev_label, next_label;
    END IF;
  ELSIF next_start IS NOT NULL THEN
    e := next_start - 1; lbl := next_label;
    LOOP
      s := (e + 1 - INTERVAL '12 months')::date;
      lbl := LEAST(lbl - 1, EXTRACT(YEAR FROM e)::int);
      EXIT WHEN p_date >= s;
      e := s - 1; steps := steps + 1;
      IF steps > 500 THEN RAISE EXCEPTION 'fiscal_year_template: % is too far from the stored years', p_date; END IF;
    END LOOP;
  ELSE
    -- No stored year: the declared month, NULL/0/out of range read as March
    -- (fiscalYearCalendar.normaliseStartMonth).
    SELECT CASE WHEN c.financial_year_start BETWEEN 1 AND 12 THEN c.financial_year_start ELSE 3 END
      INTO m FROM companies c WHERE c.id = p_company;
    IF m IS NULL THEN RAISE EXCEPTION 'fiscal_year_template: company % not found', p_company; END IF;
    IF EXTRACT(MONTH FROM p_date)::int >= m THEN
      s := make_date(EXTRACT(YEAR FROM p_date)::int, m, 1);
    ELSE
      s := make_date(EXTRACT(YEAR FROM p_date)::int - 1, m, 1);
    END IF;
    e := (s + INTERVAL '12 months')::date - 1;
    lbl := EXTRACT(YEAR FROM e)::int;
  END IF;

  fiscal_year := lbl; start_date := s; end_date := e;
  RETURN NEXT;
END;
$$;

-- The year holding a date: the stored row, else the template (id NULL, stored false).
CREATE OR REPLACE FUNCTION public.fiscal_year_for_date(p_company uuid, p_date date)
RETURNS TABLE (id uuid, fiscal_year int, start_date date, end_date date, status varchar,
               kind varchar, stored boolean)
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RETURN QUERY
    SELECT fy.id, fy.fiscal_year, fy.start_date, fy.end_date, fy.status, fy.kind, true
      FROM fiscal_years fy
     WHERE fy.company_id = p_company AND p_date BETWEEN fy.start_date AND fy.end_date;
  IF NOT FOUND THEN
    RETURN QUERY
      SELECT NULL::uuid, t.fiscal_year, t.start_date, t.end_date, 'open'::varchar, 'normal'::varchar, false
        FROM public.fiscal_year_template(p_company, p_date) t;
  END IF;
END;
$$;

-- The year with a label: the stored row, else the template year that carries
-- it (none when the template skips that label).
CREATE OR REPLACE FUNCTION public.fiscal_year_for_label(p_company uuid, p_label int)
RETURNS TABLE (id uuid, fiscal_year int, start_date date, end_date date, status varchar,
               kind varchar, stored boolean)
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  prev_label int; prev_end date; next_label int; next_start date; m int;
  probe date; t record; steps int := 0;
BEGIN
  RETURN QUERY
    SELECT fy.id, fy.fiscal_year, fy.start_date, fy.end_date, fy.status, fy.kind, true
      FROM fiscal_years fy WHERE fy.company_id = p_company AND fy.fiscal_year = p_label;
  IF FOUND THEN RETURN; END IF;

  SELECT fy.fiscal_year, fy.end_date INTO prev_label, prev_end FROM fiscal_years fy
   WHERE fy.company_id = p_company AND fy.fiscal_year < p_label ORDER BY fy.fiscal_year DESC LIMIT 1;
  SELECT fy.fiscal_year, fy.start_date INTO next_label, next_start FROM fiscal_years fy
   WHERE fy.company_id = p_company AND fy.fiscal_year > p_label ORDER BY fy.fiscal_year LIMIT 1;

  IF prev_end IS NULL AND next_start IS NULL THEN
    SELECT CASE WHEN c.financial_year_start BETWEEN 1 AND 12 THEN c.financial_year_start ELSE 3 END
      INTO m FROM companies c WHERE c.id = p_company;
    IF m IS NULL THEN RETURN; END IF;
    -- The year ending in calendar year p_label: its last day is the day before
    -- the start month of p_label (a January start ends 31 December p_label).
    IF m = 1 THEN probe := make_date(p_label, 12, 31);
    ELSE probe := make_date(p_label, m, 1) - 1;
    END IF;
  ELSIF prev_end IS NOT NULL THEN
    probe := prev_end + 1;
  ELSE
    probe := next_start - 1;
  END IF;

  -- Walk year by year from the nearest stored neighbour, through the template.
  LOOP
    SELECT * INTO t FROM public.fiscal_year_template(p_company, probe);
    EXIT WHEN t.fiscal_year = p_label;
    IF prev_end IS NOT NULL OR (prev_end IS NULL AND next_start IS NULL) THEN
      EXIT WHEN t.fiscal_year > p_label;
      probe := t.end_date + 1;
    ELSE
      EXIT WHEN t.fiscal_year < p_label;
      probe := t.start_date - 1;
    END IF;
    steps := steps + 1;
    IF steps > 500 THEN RETURN; END IF;
  END LOOP;
  IF t.fiscal_year = p_label THEN
    RETURN QUERY SELECT NULL::uuid, t.fiscal_year, t.start_date, t.end_date, 'open'::varchar, 'normal'::varchar, false;
  END IF;
END;
$$;

-- ── Linking a period to its year ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fiscal_year_link_period(
  p_company uuid, p_label int, p_start date, p_end date
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  y uuid; t record; lo date; hi date;
BEGIN
  -- 1. A stored year that holds the whole period.
  SELECT fy.id INTO y FROM fiscal_years fy
   WHERE fy.company_id = p_company AND fy.start_date <= p_start AND fy.end_date >= p_end;
  IF y IS NOT NULL THEN RETURN y; END IF;

  -- 2. The template year, when it holds the whole period and nothing is in its way.
  SELECT * INTO t FROM public.fiscal_year_template(p_company, p_start);
  IF t.start_date <= p_start AND t.end_date >= p_end THEN
    INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date)
    VALUES (p_company, t.fiscal_year, t.start_date, t.end_date)
    ON CONFLICT DO NOTHING
    RETURNING id INTO y;
    IF y IS NOT NULL THEN RETURN y; END IF;
    SELECT fy.id INTO y FROM fiscal_years fy  -- a concurrent writer created it
     WHERE fy.company_id = p_company AND fy.start_date <= p_start AND fy.end_date >= p_end;
    IF y IS NOT NULL THEN RETURN y; END IF;
  END IF;

  -- 3. The period fits no template year (a whole-year "period" of a fixture):
  --    the year is its label group, as the periods describe it.
  SELECT fy.id, LEAST(fy.start_date, p_start), GREATEST(fy.end_date, p_end) INTO y, lo, hi
    FROM fiscal_years fy WHERE fy.company_id = p_company AND fy.fiscal_year = p_label;
  IF y IS NOT NULL THEN
    UPDATE fiscal_years SET start_date = lo, end_date = hi WHERE id = y;
    RETURN y;
  END IF;
  INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date)
  VALUES (p_company, p_label, p_start, p_end)
  RETURNING id INTO y;
  RETURN y;
END;
$$;

-- ── Status follows the periods ───────────────────────────────────────────────

-- p_start/p_end: the year's range as it will be (a BEFORE UPDATE passes NEW's).
CREATE OR REPLACE FUNCTION public.fiscal_year_derived_status(p_year uuid, p_start date, p_end date)
RETURNS varchar
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN COUNT(fp.id) = 0 THEN 'open'
    WHEN bool_or(fp.status = 'closing') THEN 'closing'
    WHEN bool_and(fp.status IN ('closed', 'locked'))
         AND SUM(fp.end_date - fp.start_date + 1) = (p_end - p_start + 1)
      THEN CASE WHEN bool_and(fp.status = 'locked') THEN 'locked' ELSE 'closed' END
    ELSE 'open'
  END
  FROM fiscal_periods fp WHERE fp.fiscal_year_id = p_year
$$;

CREATE OR REPLACE FUNCTION public.fiscal_year_derived_status(p_year uuid)
RETURNS varchar
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.fiscal_year_derived_status(fy.id, fy.start_date, fy.end_date) FROM fiscal_years fy WHERE fy.id = p_year
$$;

-- A new year has no periods yet: it is open, whatever the INSERT says.
CREATE OR REPLACE FUNCTION public.fiscal_years_insert_open()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  NEW.status := 'open';
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fiscal_years_sync_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  y uuid;
BEGIN
  FOR y IN
    SELECT DISTINCT u FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.fiscal_year_id END,
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.fiscal_year_id END]) AS u
    WHERE u IS NOT NULL
  LOOP
    UPDATE fiscal_years SET status = public.fiscal_year_derived_status(y)
     WHERE id = y AND status IS DISTINCT FROM public.fiscal_year_derived_status(y);
  END LOOP;
  RETURN NULL;
END;
$$;

-- ── Period triggers ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fiscal_periods_link_year()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.fiscal_year_id IS NULL THEN
    NEW.fiscal_year_id := public.fiscal_year_link_period(NEW.company_id, NEW.fiscal_year, NEW.start_date, NEW.end_date);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fiscal_periods_guard_closed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  year_status varchar;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IN ('closed', 'locked') AND (
       NEW.start_date IS DISTINCT FROM OLD.start_date OR NEW.end_date IS DISTINCT FROM OLD.end_date
    OR NEW.fiscal_year IS DISTINCT FROM OLD.fiscal_year OR NEW.period_number IS DISTINCT FROM OLD.period_number
    OR NEW.company_id IS DISTINCT FROM OLD.company_id
    OR (OLD.fiscal_year_id IS NOT NULL AND NEW.fiscal_year_id IS DISTINCT FROM OLD.fiscal_year_id)) THEN
    RAISE EXCEPTION 'fiscal period % (%) is %: it cannot be moved, re-dated or relabelled',
      OLD.id, OLD.period_name, OLD.status USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' OR NEW.fiscal_year_id IS DISTINCT FROM OLD.fiscal_year_id THEN
    SELECT fy.status INTO year_status FROM fiscal_years fy WHERE fy.id = NEW.fiscal_year_id;
    IF year_status IN ('closed', 'locked') THEN
      RAISE EXCEPTION 'fiscal year % is %: no period can be added to it', NEW.fiscal_year_id, year_status
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Deferred: a change of year end moves a year's edge and its periods in one transaction.
CREATE OR REPLACE FUNCTION public.fiscal_periods_check_inside_year()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  bad record;
BEGIN
  SELECT fp.id, fp.period_name, fp.start_date, fp.end_date, fy.fiscal_year, fy.start_date AS ys, fy.end_date AS ye,
         fy.company_id AS ycompany, fp.company_id AS pcompany
    INTO bad
    FROM fiscal_periods fp JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
   WHERE fp.id = NEW.id
     AND (fy.company_id <> fp.company_id OR fp.start_date < fy.start_date OR fp.end_date > fy.end_date);
  IF FOUND THEN
    RAISE EXCEPTION 'fiscal period % (% to %) lies outside its fiscal year FY% (% to %)%',
      bad.period_name, bad.start_date, bad.end_date, bad.fiscal_year, bad.ys, bad.ye,
      CASE WHEN bad.ycompany <> bad.pcompany THEN ', of another company' ELSE '' END
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.fiscal_years_check_holds_periods()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  bad record;
BEGIN
  SELECT fp.period_name, fp.start_date, fp.end_date INTO bad
    FROM fiscal_periods fp JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
   WHERE fy.id = NEW.id AND (fp.start_date < fy.start_date OR fp.end_date > fy.end_date)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'fiscal year FY% (% to %) no longer holds its period % (% to %)',
      NEW.fiscal_year, NEW.start_date, NEW.end_date, bad.period_name, bad.start_date, bad.end_date
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.fiscal_years_guard_closed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.status IN ('closed', 'locked') AND (
       NEW.start_date IS DISTINCT FROM OLD.start_date OR NEW.end_date IS DISTINCT FROM OLD.end_date
    OR NEW.fiscal_year IS DISTINCT FROM OLD.fiscal_year OR NEW.company_id IS DISTINCT FROM OLD.company_id
    OR NEW.kind IS DISTINCT FROM OLD.kind) THEN
    RAISE EXCEPTION 'fiscal year FY% is %: it cannot be re-dated or relabelled', OLD.fiscal_year, OLD.status
      USING ERRCODE = '55000';
  END IF;
  -- Status is never written, only derived (an app_user UPDATE of status alone
  -- cannot mark a year closed): from the periods, with the new coverage.
  NEW.status := public.fiscal_year_derived_status(NEW.id, NEW.start_date, NEW.end_date);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fiscal_years_guard_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.status IN ('closed', 'locked') THEN
    -- A company being deleted takes its years with it (ON DELETE CASCADE).
    IF EXISTS (SELECT 1 FROM companies c WHERE c.id = OLD.company_id) THEN
      RAISE EXCEPTION 'fiscal year FY% is %: it cannot be deleted', OLD.fiscal_year, OLD.status
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN OLD;
END;
$$;

-- ── Backfill: every existing period, oldest first per company ────────────────
-- Runs BEFORE the period guards exist: linking a closed period is its first
-- fiscal_year_id, which the guard allows anyway (OLD NULL), but the year's
-- status is derived once at the end instead of per row.

DO $$
DECLARE
  p record;
  linked int := 0;
BEGIN
  FOR p IN
    SELECT id, company_id, fiscal_year, start_date, end_date FROM fiscal_periods
     WHERE fiscal_year_id IS NULL
     ORDER BY company_id, start_date, end_date
  LOOP
    UPDATE fiscal_periods
       SET fiscal_year_id = public.fiscal_year_link_period(p.company_id, p.fiscal_year, p.start_date, p.end_date)
     WHERE id = p.id;
    linked := linked + 1;
  END LOOP;
  UPDATE fiscal_years fy SET status = public.fiscal_year_derived_status(fy.id)
   WHERE fy.status IS DISTINCT FROM public.fiscal_year_derived_status(fy.id);
  RAISE NOTICE '940: linked % fiscal periods to % fiscal years', linked, (SELECT COUNT(*) FROM fiscal_years);
END;
$$;

-- Verification: refuse to finish on a backfill that does not hold.
DO $$
DECLARE
  unlinked int; outside int; too_long int; companies_without int; status_wrong int;
BEGIN
  SELECT COUNT(*) INTO unlinked FROM fiscal_periods WHERE fiscal_year_id IS NULL;
  SELECT COUNT(*) INTO outside FROM fiscal_periods fp JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
   WHERE fy.company_id <> fp.company_id OR fp.start_date < fy.start_date OR fp.end_date > fy.end_date;
  SELECT COUNT(*) INTO too_long FROM fiscal_years WHERE end_date >= (start_date + INTERVAL '15 months')::date;
  SELECT COUNT(DISTINCT fp.company_id) INTO companies_without FROM fiscal_periods fp
   WHERE NOT EXISTS (SELECT 1 FROM fiscal_years fy WHERE fy.company_id = fp.company_id);
  SELECT COUNT(*) INTO status_wrong FROM fiscal_years fy WHERE fy.status <> public.fiscal_year_derived_status(fy.id);
  IF unlinked + outside + too_long + companies_without + status_wrong > 0 THEN
    RAISE EXCEPTION '940 backfill verification failed: unlinked=% outside=% too_long=% companies_without=% status_wrong=%',
      unlinked, outside, too_long, companies_without, status_wrong;
  END IF;
END;
$$;

ALTER TABLE fiscal_periods ALTER COLUMN fiscal_year_id SET NOT NULL;

-- ── Triggers (after the backfill) ────────────────────────────────────────────
-- BEFORE triggers fire in name order: link, then guard.

DROP TRIGGER IF EXISTS trg_fiscal_periods_a_link_year ON fiscal_periods;
CREATE TRIGGER trg_fiscal_periods_a_link_year BEFORE INSERT ON fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION public.fiscal_periods_link_year();

DROP TRIGGER IF EXISTS trg_fiscal_periods_b_guard_closed ON fiscal_periods;
CREATE TRIGGER trg_fiscal_periods_b_guard_closed BEFORE INSERT OR UPDATE ON fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION public.fiscal_periods_guard_closed();

DROP TRIGGER IF EXISTS trg_fiscal_periods_inside_year ON fiscal_periods;
CREATE CONSTRAINT TRIGGER trg_fiscal_periods_inside_year
  AFTER INSERT OR UPDATE OF start_date, end_date, fiscal_year_id, company_id ON fiscal_periods
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fiscal_periods_check_inside_year();

DROP TRIGGER IF EXISTS trg_fiscal_periods_sync_year_status ON fiscal_periods;
CREATE TRIGGER trg_fiscal_periods_sync_year_status
  AFTER INSERT OR DELETE OR UPDATE OF status, fiscal_year_id, start_date, end_date ON fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION public.fiscal_years_sync_status();

DROP TRIGGER IF EXISTS trg_fiscal_years_guard_closed ON fiscal_years;
CREATE TRIGGER trg_fiscal_years_guard_closed BEFORE UPDATE ON fiscal_years
  FOR EACH ROW EXECUTE FUNCTION public.fiscal_years_guard_closed();

DROP TRIGGER IF EXISTS trg_fiscal_years_insert_open ON fiscal_years;
CREATE TRIGGER trg_fiscal_years_insert_open BEFORE INSERT ON fiscal_years
  FOR EACH ROW EXECUTE FUNCTION public.fiscal_years_insert_open();

DROP TRIGGER IF EXISTS trg_fiscal_years_guard_delete ON fiscal_years;
CREATE TRIGGER trg_fiscal_years_guard_delete BEFORE DELETE ON fiscal_years
  FOR EACH ROW EXECUTE FUNCTION public.fiscal_years_guard_delete();

DROP TRIGGER IF EXISTS trg_fiscal_years_holds_periods ON fiscal_years;
CREATE CONSTRAINT TRIGGER trg_fiscal_years_holds_periods
  AFTER UPDATE OF start_date, end_date ON fiscal_years
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fiscal_years_check_holds_periods();

REVOKE ALL ON FUNCTION public.fiscal_year_template(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fiscal_year_for_date(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fiscal_year_for_label(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fiscal_year_link_period(uuid, int, date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fiscal_year_derived_status(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fiscal_year_derived_status(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fiscal_year_template(uuid, date) TO app_user;
GRANT EXECUTE ON FUNCTION public.fiscal_year_for_date(uuid, date) TO app_user;
GRANT EXECUTE ON FUNCTION public.fiscal_year_for_label(uuid, int) TO app_user;
GRANT EXECUTE ON FUNCTION public.fiscal_year_link_period(uuid, int, date, date) TO app_user;
GRANT EXECUTE ON FUNCTION public.fiscal_year_derived_status(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION public.fiscal_year_derived_status(uuid, date, date) TO app_user;
