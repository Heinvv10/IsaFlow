-- 943: The record of a change of financial year end (change-of-year-end
-- programme, Features B and G).
--
-- One row per change: who applied it, when and why, the CIPC/SARS
-- confirmations, the transition year it made (fiscal_years.kind =
-- 'transition'), and a snapshot of the years and periods it re-grouped so the
-- change can be undone exactly (gl/financialYearEndChangeUndo.ts) until a
-- period beyond the original year end is closed.
--
-- Companies Act 71 of 2008 s27(4): a company may change its financial year end
-- (a) not more than once during any financial year, (b) to a date later than
-- the date the notice is filed, and (c) so that no financial year ends more
-- than 15 months after the end of the preceding one. (c) is fiscal_years'
-- 15-month CHECK (940); (a) is the service's check plus the unique index
-- below, which also serialises two concurrent applies on one year; (b) is the
-- service's.
--
-- Rows are written by the service only. A member cannot rewrite history: the
-- only UPDATE allowed is marking an unreversed change reversed. The actor checks
-- run whenever a request user is present (auth.uid(), set by withAuth for every
-- app_user session); a session with no request user is a superuser/operator
-- context (migrations, fixtures), which RLS and grants already confine.

CREATE TABLE IF NOT EXISTS fiscal_year_end_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- The transition year this change made (NULL only if a later change ever
  -- removed it; the dates below keep the record readable).
  fiscal_year_id UUID,
  from_start_month INT NOT NULL CHECK (from_start_month BETWEEN 1 AND 12),
  to_start_month INT NOT NULL CHECK (to_start_month BETWEEN 1 AND 12),
  transition_start DATE NOT NULL,
  from_end_date DATE NOT NULL,
  to_end_date DATE NOT NULL,
  months INT NOT NULL CHECK (months BETWEEN 1 AND 15),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 2000),
  cipc_filed_confirmed BOOLEAN NOT NULL CHECK (cipc_filed_confirmed),
  sars_notified_confirmed BOOLEAN NOT NULL CHECK (sars_notified_confirmed),
  -- The years (from the transition year on) and their periods before the change.
  -- Built by the database at INSERT (fiscal_year_end_changes_build), never taken
  -- from the caller, so a forged record cannot steer an undo.
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  applied_by UUID NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reversed_by UUID,
  reversed_at TIMESTAMPTZ,
  reversal_reason TEXT,
  CONSTRAINT fiscal_year_end_changes_reversal_whole
    CHECK ((reversed_by IS NULL) = (reversed_at IS NULL)),
  CONSTRAINT fiscal_year_end_changes_dates CHECK (to_end_date <> from_end_date AND to_end_date > transition_start)
);

ALTER TABLE fiscal_year_end_changes DROP CONSTRAINT IF EXISTS fiscal_year_end_changes_year_fkey;
ALTER TABLE fiscal_year_end_changes ADD CONSTRAINT fiscal_year_end_changes_year_fkey
  FOREIGN KEY (company_id, fiscal_year_id) REFERENCES fiscal_years (company_id, id) ON DELETE SET NULL (fiscal_year_id);

CREATE INDEX IF NOT EXISTS idx_fiscal_year_end_changes_company ON fiscal_year_end_changes (company_id, applied_at DESC);
-- s27(4)(a), and the serialiser for two applies racing on one year.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_year_end_changes_live_year
  ON fiscal_year_end_changes (fiscal_year_id) WHERE reversed_at IS NULL;

ALTER TABLE fiscal_years DROP CONSTRAINT IF EXISTS fiscal_years_change_id_fkey;
ALTER TABLE fiscal_years ADD CONSTRAINT fiscal_years_change_id_fkey
  FOREIGN KEY (change_id) REFERENCES fiscal_year_end_changes(id) DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE fiscal_year_end_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_year_end_changes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON fiscal_year_end_changes;
-- The active company AND membership (migration 897's form): a member of two
-- companies working in A cannot read or write B's rows through app_user.
CREATE POLICY tenant_isolation ON fiscal_year_end_changes FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
GRANT SELECT, INSERT, UPDATE ON fiscal_year_end_changes TO app_user;

-- The requesting user (auth.uid()) is an owner or admin of the company.
CREATE OR REPLACE FUNCTION public.fiscal_year_end_change_actor_ok(p_company uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM company_users cu
                  WHERE cu.company_id = p_company AND cu.user_id::text = auth.uid()::text
                    AND cu.role IN ('owner', 'admin'))
$$;

CREATE OR REPLACE FUNCTION public.fiscal_year_end_changes_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM companies c WHERE c.id = OLD.company_id) THEN
      RAISE EXCEPTION 'a change of financial year end is a permanent record and cannot be deleted' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  -- The FK's ON DELETE SET NULL (fiscal_year_id) is the one other change allowed.
  IF NEW.fiscal_year_id IS NULL AND OLD.fiscal_year_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM fiscal_years fy WHERE fy.id = OLD.fiscal_year_id)
     AND (to_jsonb(NEW) - 'fiscal_year_id') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'fiscal_year_id') THEN
    RETURN NEW;
  END IF;
  IF OLD.reversed_at IS NOT NULL
     OR NEW.reversed_at IS NULL
     OR (to_jsonb(NEW) - ARRAY['reversed_by', 'reversed_at', 'reversal_reason'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['reversed_by', 'reversed_at', 'reversal_reason']) THEN
    RAISE EXCEPTION 'a change of financial year end can only be marked reversed, once' USING ERRCODE = '55000';
  END IF;
  -- Marked reversed only by an owner/admin, and only once the transition year
  -- really ends where it did before the change (the undo has restored it).
  IF auth.uid() IS NOT NULL AND NOT public.fiscal_year_end_change_actor_ok(OLD.company_id) THEN
    RAISE EXCEPTION 'only an owner or admin may undo a change of financial year end' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fiscal_years fy WHERE fy.id = OLD.fiscal_year_id AND fy.end_date = OLD.from_end_date) THEN
    RAISE EXCEPTION 'a change of financial year end is marked reversed only after the year end is restored' USING ERRCODE = '23514';
  END IF;
  -- Reversed by the requester, now, for a stated reason.
  IF auth.uid() IS NOT NULL AND NEW.reversed_by::text IS DISTINCT FROM auth.uid()::text THEN
    RAISE EXCEPTION 'a change of financial year end is recorded as undone by the requesting user' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(COALESCE(NEW.reversal_reason, ''))) NOT BETWEEN 10 AND 2000 THEN
    RAISE EXCEPTION 'undoing a change of financial year end needs a reason (10-2000 characters)' USING ERRCODE = '23514';
  END IF;
  NEW.reversed_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fiscal_year_end_changes_guard ON fiscal_year_end_changes;
CREATE TRIGGER trg_fiscal_year_end_changes_guard BEFORE UPDATE OR DELETE ON fiscal_year_end_changes
  FOR EACH ROW EXECUTE FUNCTION public.fiscal_year_end_changes_guard();

-- At INSERT: the snapshot is read from the live tables (the years from the
-- transition year on, and their periods), the applier is the request's user
-- when there is one, and the transition year must be the company's open year
-- starting on transition_start.
CREATE OR REPLACE FUNCTION public.fiscal_year_end_changes_build()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  y record;
BEGIN
  IF auth.uid() IS NOT NULL AND NEW.applied_by::text IS DISTINCT FROM auth.uid()::text THEN
    RAISE EXCEPTION 'a change of financial year end is recorded as applied by the requesting user' USING ERRCODE = '42501';
  END IF;
  IF auth.uid() IS NOT NULL AND NOT public.fiscal_year_end_change_actor_ok(NEW.company_id) THEN
    RAISE EXCEPTION 'only an owner or admin may record a change of financial year end' USING ERRCODE = '42501';
  END IF;
  -- Born live and now: never backdated, never already reversed.
  IF NEW.reversed_at IS NOT NULL OR NEW.reversed_by IS NOT NULL OR NEW.reversal_reason IS NOT NULL THEN
    RAISE EXCEPTION 'a change of financial year end is recorded live; it is reversed by undoing it' USING ERRCODE = '23514';
  END IF;
  NEW.applied_at := now();
  SELECT fy.id, fy.start_date, fy.status INTO y FROM fiscal_years fy
   WHERE fy.id = NEW.fiscal_year_id AND fy.company_id = NEW.company_id;
  IF NOT FOUND OR y.start_date <> NEW.transition_start OR y.status <> 'open'
     OR (SELECT fy.end_date FROM fiscal_years fy WHERE fy.id = NEW.fiscal_year_id) <> NEW.from_end_date THEN
    RAISE EXCEPTION 'a change of financial year end must name the company''s open transition year starting %', NEW.transition_start
      USING ERRCODE = '23514';
  END IF;
  NEW.snapshot := jsonb_build_object(
    'years', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', fy.id, 'fiscal_year', fy.fiscal_year, 'start_date', fy.start_date::text, 'end_date', fy.end_date::text,
        'kind', fy.kind, 'change_id', fy.change_id, 'created_at', fy.created_at, 'updated_at', fy.updated_at) ORDER BY fy.start_date)
      FROM fiscal_years fy WHERE fy.company_id = NEW.company_id AND fy.start_date >= NEW.transition_start), '[]'::jsonb),
    'periods', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', fp.id, 'fiscal_year_id', fp.fiscal_year_id, 'fiscal_year', fp.fiscal_year,
        'period_number', fp.period_number, 'period_name', fp.period_name) ORDER BY fp.start_date)
      FROM fiscal_periods fp JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
     WHERE fp.company_id = NEW.company_id AND fy.start_date >= NEW.transition_start), '[]'::jsonb));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fiscal_year_end_changes_build ON fiscal_year_end_changes;
CREATE TRIGGER trg_fiscal_year_end_changes_build BEFORE INSERT ON fiscal_year_end_changes
  FOR EACH ROW EXECUTE FUNCTION public.fiscal_year_end_changes_build();
ALTER TABLE fiscal_year_end_changes ENABLE ALWAYS TRIGGER trg_fiscal_year_end_changes_build;
ALTER TABLE fiscal_year_end_changes ENABLE ALWAYS TRIGGER trg_fiscal_year_end_changes_guard;
